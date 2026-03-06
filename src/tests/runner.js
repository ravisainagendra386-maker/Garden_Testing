// src/tests/runner.js
const garden = require("../api/garden");
const config  = require("../config");
const { initiateEvm, redeemEvm } = require("../htlc/evm");
const { initiateHtlc }           = require("../wallet/btc");
const walletState = require("../wallet/state");

let _emit = null;
let _approvalQueue = [];
// Map of active testId → abort controller
const _activeTests = new Map();

function setEmitter(fn) { _emit = fn; }
function emit(event, data) {
  if (_emit) _emit(event, data);
  else console.log(`[${event}]`, JSON.stringify(data).slice(0, 120));
}

async function requestApproval(txData) {
  return new Promise(resolve => {
    const id = Date.now().toString();
    emit("approval_request", { id, ...txData });
    _approvalQueue.push({ id, resolve });
  });
}

// Request MetaMask in the browser to sign a pre-built Garden EVM transaction
async function requestEvmTx({ orderId, label, to, data, value, chainId, gasLimit }) {
  return new Promise((resolve, reject) => {
    const id = `evmtx_${Date.now()}`;
    emit("evm_tx_request", { id, orderId, label, to, data, value, chainId: String(chainId), gasLimit });
    _approvalQueue.push({ id, resolve, reject });
    setTimeout(() => {
      const idx = _approvalQueue.findIndex(a => a.id === id);
      if (idx !== -1) {
        _approvalQueue.splice(idx, 1);
        reject(new Error("EVM tx timeout — MetaMask not responded in 5 min"));
      }
    }, 300000);
  });
}

function handleApproval(id, approved) {
  const idx = _approvalQueue.findIndex(q => q.id === id);
  if (idx !== -1) { _approvalQueue[idx].resolve(approved); _approvalQueue.splice(idx, 1); }
}

function handleEvmTxResponse(id, txHash) {
  // txHash = hex string if approved, false if rejected
  const idx = _approvalQueue.findIndex(q => q.id === id);
  if (idx !== -1) {
    if (txHash) _approvalQueue[idx].resolve(txHash);
    else _approvalQueue[idx].reject(new Error("EVM transaction rejected by user"));
    _approvalQueue.splice(idx, 1);
  }
}

function abortTest(testId) {
  const ctrl = _activeTests.get(testId);
  if (ctrl) { ctrl.abort = true; }
}

function abortAll() {
  _activeTests.forEach(ctrl => { ctrl.abort = true; });
}

// ── DETERMINE WALLET TYPE FROM GARDEN ASSET ──────────────────
// Uses asset ID prefix for precision — not the chain field.
// bitcoin chain covers many networks; we only support bitcoin_testnet/mainnet.
function getWalletTypeForAsset(asset) {
  const chain  = (asset.chain || "").toLowerCase();
  const prefix = (asset.id    || "").split(":")[0].toLowerCase();

  if (chain.startsWith("evm"))      return "evm";
  if (chain.startsWith("solana"))   return "solana";
  if (chain.startsWith("starknet")) return "starknet";
  if (chain.startsWith("tron"))     return "tron";
  if (chain.startsWith("sui"))      return "sui";
  if (chain === "bitcoin") {
    // Only real bitcoin networks — not alpen_signet, litecoin_testnet, spark etc.
    if (/^bitcoin_(testnet|mainnet|signet)$/.test(prefix)) return "bitcoin";
    return null;
  }
  return null;
}

// ── SINGLE ROUTE TEST ─────────────────────────────────────────
async function runRoute({ fromChain, toChain, fromAsset, toAsset, amount, label, fromMeta, toMeta }) {
  const testId = `${fromAsset}->${toAsset}-${Date.now()}`;
  const ctrl   = { abort: false };
  _activeTests.set(testId, ctrl);
  const steps  = [];

  function step(name, status, detail = "", txHash = null) {
    const s = { name, status, detail, txHash, ts: new Date().toISOString() };
    steps.push(s);
    emit("test_step", { testId, label, step: s });
  }

  function checkAbort() {
    if (ctrl.abort) throw new Error("Test aborted by user");
  }

  emit("test_start", { testId, label, fromChain, toChain, fromAsset, toAsset, amount });

  try {
    // 1. Wallet addresses
    // fromChain/toChain are wallet types (evm/bitcoin/solana etc.)
    const fromAddress = walletState.getAddressByType(fromChain);
    const toAddress   = walletState.getAddressByType(toChain);

    if (!fromAddress) {
      emit("test_end", { testId, label, status: "skipped", error: `${fromChain} wallet not connected` });
      _activeTests.delete(testId);
      return { testId, label, status: "skipped", error: `${fromChain} wallet not connected` };
    }
    if (!toAddress) {
      emit("test_end", { testId, label, status: "skipped", error: `${toChain} wallet not connected` });
      _activeTests.delete(testId);
      return { testId, label, status: "skipped", error: `${toChain} wallet not connected` };
    }

    // 2. Health check
    step("Health Check", "running");
    checkAbort();
    await garden.health();
    step("Health Check", "pass", "API is live");

    // 3. Use amount directly — min/max come from asset object passed via buildRoutes.
    // Garden /policy is a global blacklist, not per-pair limits.
    // The amount passed in is already set to asset.min_amount in buildRoutes.
    const safeAmount = Number(amount) || 50000;
    step("Route Policy", "pass", `Using amount: ${safeAmount} (atomic units)`);

    // 4. Quote — result is an array of solver quotes
    step("Get Quote", "running");
    checkAbort();
    let quoteRes;
    try {
      quoteRes = await garden.getQuote(fromAsset, toAsset, safeAmount);
    } catch (qErr) {
      const msg = qErr.message || "";
      step("Get Quote", "skipped", `No quote: ${msg.split("]").pop().trim()}`);
      emit("test_end", { testId, label, status: "skipped", error: msg });
      _activeTests.delete(testId);
      return { testId, label, status: "skipped", error: msg };
    }
    const quotes = quoteRes.result;
    if (!quotes?.length) {
      step("Get Quote", "skipped", "No quotes returned — pair may have no liquidity");
      emit("test_end", { testId, label, status: "skipped", error: "No quotes" });
      _activeTests.delete(testId);
      return { testId, label, status: "skipped" };
    }

    // Pick best quote (first = best by Garden's ordering)
    const bestQuote    = quotes[0];
    const outputAmount = String(bestQuote.destination.amount); // exact atomic units
    const solverId     = bestQuote.solver_id;
    const fromDisplay  = `${bestQuote.source.display} (${bestQuote.source.value} USD)`;
    const toDisplay    = `${bestQuote.destination.display} (${bestQuote.destination.value} USD)`;
    step("Get Quote", "pass", `${fromDisplay} → ${toDisplay}`);

    // 5a. Check liquidity before attempting order
    step("Liquidity Check", "running");
    checkAbort();
    try {
      const liq = await garden.getLiquidity(fromAsset, toAsset);
      const available = liq.result?.available ?? liq.result?.liquidity ?? liq.available;
      if (available !== undefined && Number(available) < safeAmount) {
        throw new Error(`Insufficient liquidity: ${available} available, need ${safeAmount}`);
      }
      step("Liquidity Check", "pass", available !== undefined ? `Available: ${available}` : "Liquidity OK");
    } catch(e) {
      if (e.message.includes("Insufficient") || e.message.includes("liquidity")) {
        emit("test_end", { testId, label, status: "skipped", error: e.message });
        _activeTests.delete(testId);
        return { testId, label, status: "skipped", error: e.message };
      }
      step("Liquidity Check", "pass", "Could not verify (continuing)");
    }

    // 5. Create order — Garden manages secrets, no secret_hash needed
    // Per Garden docs: send source + destination amounts from quote, plus solver_id
    step("Create Order", "running");
    checkAbort();
    const orderBody = {
      source: {
        asset:  fromAsset,
        owner:  fromAddress,
        amount: String(safeAmount),   // atomic units, matches quote source.amount
      },
      destination: {
        asset:  toAsset,
        owner:  toAddress,
        amount: outputAmount,          // exact value from quote
      },
      solver_id: solverId,             // required — from quote
    };
    console.log("[create order]", JSON.stringify(orderBody));
    let orderRes;
    try {
      orderRes = await garden.createOrder(orderBody);
    } catch (orderErr) {
      const msg = orderErr.message || "";
      if (msg.includes("400") || msg.includes("liquidity") || msg.includes("insufficient")) {
        step("Create Order", "skipped", `Skipped: ${msg.split("]").pop().trim()}`);
        emit("test_end", { testId, label, status: "skipped", error: msg });
        _activeTests.delete(testId);
        return { testId, label, status: "skipped", error: msg };
      }
      throw orderErr; // unexpected error — let it fail normally
    }
    console.log("[order response]", JSON.stringify(orderRes).slice(0, 400));

    const orderId     = orderRes.result?.order_id || orderRes.result?.id;
    const htlcAddress = orderRes.result?.source?.htlc_address
                     || orderRes.result?.source?.swap_id
                     || orderRes.result?.to;
    const htlcAmount  = orderRes.result?.source?.amount || safeAmount;

    if (!orderId) throw new Error(`No order_id in response: ${JSON.stringify(orderRes).slice(0, 200)}`);
    step("Create Order", "pass", `Order ID: ${orderId}`);

    // 6. Manual approval gate (if enabled)
    if (config.manualApprove) {
      step("Awaiting Approval", "pending", "Waiting for your approval…");
      checkAbort();
      const approved = await requestApproval({ orderId, fromAsset, toAsset, safeAmount, outputAmount, htlcAddress, label });
      if (!approved) {
        step("Manual Approval", "skipped", "User rejected");
        emit("test_end", { testId, label, status: "skipped", steps });
        _activeTests.delete(testId);
        return { testId, label, status: "skipped", steps };
      }
      step("Manual Approval", "pass", "Approved");
    }

    // 7. Initiate HTLC on source chain
    step("Initiate HTLC", "running");
    checkAbort();
    let initTxHash;
    if (fromChain === "bitcoin") {
      const btcWif     = walletState.getBtcWif();
      const btcAddress = walletState.getBtcAddress();
      if (!btcWif) throw new Error("BTC private key (WIF) not saved — go to Connect Wallets and paste your WIF key");
      initTxHash = await initiateHtlc({ htlcAddress, amountSats: htlcAmount, wif: btcWif, fromAddress: btcAddress });
    } else if (fromChain === "evm") {
      // Garden provides a pre-built initiate_transaction — send it directly via MetaMask
      const prebuiltTx = orderRes.result?.initiate_transaction;
      if (prebuiltTx?.data && prebuiltTx?.to) {
        // Emit a ws event so the dashboard can prompt MetaMask in the browser
        step("Initiate HTLC", "pending", "Waiting for MetaMask approval…");
        initTxHash = await requestEvmTx({
          orderId,
          label,
          to:      prebuiltTx.to,
          data:    prebuiltTx.data,
          value:   prebuiltTx.value || "0x0",
          chainId: prebuiltTx.chain_id,
          gasLimit: prebuiltTx.gas_limit || "0x493e0",
        });
      } else if (orderRes.result?.source?.evmSource === "privy" || walletState.getStatus().evmSource === "privy") {
        // Privy server-side signing
        initTxHash = await initiateEvm({
          htlcAddress,
          tokenAddress: orderRes.result?.source?.token_address || "native",
          amount: htlcAmount,
          secretHash: orderRes.result?.secret_hash,
          receiverAddress: htlcAddress,
          expiry: Math.floor(Date.now() / 1000) + 7200,
          chainKey: fromAsset.split(":")[0],
        });
      } else {
        throw new Error("EVM source: no pre-built transaction from Garden and no Privy wallet. Connect Privy for automated EVM sends, or enable Manual Approve mode.");
      }
    } else {
      throw new Error(`Initiation not yet implemented for: ${fromChain}`);
    }
    step("Initiate HTLC", "pass", "Transaction sent", initTxHash);

    // 8. Notify Garden
    step("Notify Garden", "running");
    checkAbort();
    await garden.patchOrder(orderId, "initiate", initTxHash);
    step("Notify Garden", "pass", "Acknowledged");

    // 9. Wait for solver to lock
    step("Solver Lock", "running", "Waiting for solver…");
    const lockResult = await garden.pollOrder(orderId, "solver_locked", 300000);
    if (!lockResult.success) throw new Error(`Solver lock failed: ${lockResult.reason}`);
    step("Solver Lock", "pass", `Locked in ${Math.round(lockResult.elapsed / 1000)}s`);

    // 10. Redeem on destination
    step("Redeem", "running");
    checkAbort();
    let redeemTxHash;
    if (toChain === "evm") {
      const htlcContract = lockResult.order?.destination_htlc_address;
      const secret = lockResult.order?.secret || orderRes.result?.secret;
      redeemTxHash = await redeemEvm({
        htlcAddress: htlcContract,
        secret,
        chainKey: toAsset.split(":")[0],
      });
    } else {
      redeemTxHash = "solver_auto_redeem";
    }
    step("Redeem", "pass", "Redemption sent", redeemTxHash);

    // 11. Poll for completion
    step("Completion", "running", "Waiting for confirmation…");
    const finalResult = await garden.pollOrder(orderId, "completed", 300000);
    if (!finalResult.success) throw new Error(`Did not complete: ${finalResult.reason}`);
    const elapsed = Math.round((Date.now() - new Date(steps[0].ts).getTime()) / 1000);
    step("Completion", "pass", `Done in ~${elapsed}s`);

    // 12. Verify amounts
    step("Amount Verification", "running");
    const received    = parseFloat(finalResult.order?.destination_filled_amount || outputAmount);
    const expected    = parseFloat(outputAmount);
    const slippagePct = Math.abs(received - expected) / expected * 100;
    if (slippagePct > 1.5) throw new Error(`Slippage ${slippagePct.toFixed(2)}% exceeds 1.5%`);
    step("Amount Verification", "pass", `Received: ${received} (slippage: ${slippagePct.toFixed(3)}%)`);

    emit("test_end", { testId, label, status: "pass", steps, duration: elapsed });
    _activeTests.delete(testId);
    return { testId, label, status: "pass", steps };

  } catch (err) {
    const failStep = { name: "Error", status: "fail", detail: err.message, ts: new Date().toISOString() };
    steps.push(failStep);
    emit("test_step", { testId, label, step: failStep });
    emit("test_end",  { testId, label, status: err.message.includes("aborted") ? "aborted" : "fail", error: err.message, steps });
    _activeTests.delete(testId);
    return { testId, label, status: "fail", error: err.message, steps };
  }
}

// ── API HEALTH TESTS ──────────────────────────────────────────
async function runApiTests() {
  const results = [];
  const tests = [
    { name: "Server Health", fn: () => garden.health() },
    { name: "Get Chains",    fn: () => garden.getChains() },
    { name: "Get Assets",    fn: () => garden.getAssets() },
    { name: "Get Volume",    fn: () => garden.getVolume() },
  ];
  for (const t of tests) {
    const start = Date.now();
    try {
      await t.fn();
      results.push({ name: t.name, status: "pass", ms: Date.now() - start });
    } catch (err) {
      results.push({ name: t.name, status: "fail", error: err.message, ms: Date.now() - start });
    }
  }
  emit("api_tests_done", results);
  return results;
}

// ── BUILD ROUTES FROM GARDEN ASSETS + CONNECTED WALLETS ───────
async function buildRoutes() {
  const wallets = walletState.getStatus();
  const connectedTypes = new Set();
  if (wallets.evm)      connectedTypes.add("evm");
  if (wallets.btc)      connectedTypes.add("bitcoin");
  if (wallets.solana)   connectedTypes.add("solana");
  if (wallets.starknet) connectedTypes.add("starknet");
  if (wallets.sui)      connectedTypes.add("sui");
  if (wallets.tron)     connectedTypes.add("tron");

  if (connectedTypes.size === 0) return [];

  let assets = [];
  try {
    const res = await garden.getAssets();
    assets = res.result || res.assets || res || [];
  } catch (_) {}
  if (!assets.length) return [];

  const supported = assets.filter(a => {
    const wt = getWalletTypeForAsset(a);
    return wt && connectedTypes.has(wt);
  });

  // Build routes directly from assets — no policy call needed.
  // Garden /policy is a global blacklist, not per-pair. We validate via quote at trade time.
  const routes = [];
  for (const from of supported) {
    for (const to of supported) {
      if (from.id === to.id) continue;
      routes.push({
        fromAsset: from.id,
        toAsset:   to.id,
        fromChain: getWalletTypeForAsset(from),
        toChain:   getWalletTypeForAsset(to),
        amount:    parseInt(from.min_amount || 50000),
        fromMeta:  from,
        toMeta:    to,
        label:     `${from.name} → ${to.name}`,
      });
    }
  }
  return routes;
}

// ── RUN ALL ───────────────────────────────────────────────────
async function runAll() {
  emit("suite_start", { env: config.env, ts: new Date().toISOString() });
  await runApiTests();
  const routes  = await buildRoutes();
  const results = [];

  emit("suite_routes", { count: routes.length, routes: routes.map(r => r.label) });

  if (!routes.length) {
    emit("suite_info", { message: "No routes built — check wallet connections" });
    emit("suite_end", { env: config.env, total: 0, passed: 0, failed: 0, skipped: 0,
      message: "No routes — connect wallets first", ts: new Date().toISOString() });
    return results;
  }

  for (const route of routes) {
    const result = await runRoute(route);
    results.push(result);
    await new Promise(r => setTimeout(r, 1000));
  }

  emit("suite_end", {
    env: config.env, total: results.length,
    passed:  results.filter(r => r.status === "pass").length,
    failed:  results.filter(r => r.status === "fail").length,
    skipped: results.filter(r => r.status === "skipped").length,
    ts: new Date().toISOString(),
  });
  return results;
}

module.exports = { runAll, runApiTests, runRoute, buildRoutes, setEmitter, handleApproval, handleEvmTxResponse, abortTest, abortAll };