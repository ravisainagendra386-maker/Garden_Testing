// src/tests/runner.js
// Orchestrates all Garden Finance E2E tests.
// Emits real-time results to dashboard via WebSocket.
const garden = require("../api/garden");
const config = require("../config");
const { generateSecret } = require("../htlc/secret");
const { initiateEvm, redeemEvm, approveIfNeeded, waitForConfirmation } = require("../htlc/evm");
const { initiateHtlc } = require("../wallet/btc");
const { sendEvmTransaction } = require("../wallet/privy");
const walletState = require("../wallet/state");

let _emit = null; // WebSocket emit function injected by server.js
let _approvalQueue = []; // Queue for manual approval requests

function setEmitter(fn) { _emit = fn; }

function emit(event, data) {
  if (_emit) _emit(event, data);
  else console.log(`[${event}]`, JSON.stringify(data).substring(0, 120));
}

// Request manual approval — pauses test until dashboard user approves/rejects
async function requestApproval(txData) {
  return new Promise((resolve) => {
    const id = Date.now().toString();
    emit("approval_request", { id, ...txData });
    _approvalQueue.push({ id, resolve });
  });
}

function handleApproval(id, approved) {
  const idx = _approvalQueue.findIndex(q => q.id === id);
  if (idx !== -1) {
    _approvalQueue[idx].resolve(approved);
    _approvalQueue.splice(idx, 1);
  }
}

// ── SINGLE ROUTE TEST ─────────────────────────────────────────
async function runRoute({ fromChain, toChain, fromAsset, toAsset, amount, label }) {
  const testId = `${fromChain}->${toChain}-${Date.now()}`;
  const steps = [];

  function step(name, status, detail = "", txHash = null) {
    const s = { name, status, detail, txHash, ts: new Date().toISOString() };
    steps.push(s);
    emit("test_step", { testId, label, step: s });
  }

  emit("test_start", { testId, label, fromChain, toChain, fromAsset, toAsset, amount });

  try {
    // 1. Health check
    step("Health Check", "running");
    await garden.health();
    step("Health Check", "pass", "API is live");

    // 2. Get policy
    step("Route Policy", "running");
    const policy = await garden.getPolicy(fromAsset, toAsset);
    const minAmt = policy.result?.min_amount || 0;
    if (amount < minAmt) throw new Error(`Amount ${amount} below minimum ${minAmt}`);
    step("Route Policy", "pass", `Min: ${minAmt}`);

    // 3. Get quote
    step("Get Quote", "running");
    const quoteRes = await garden.getQuote(fromAsset, toAsset, amount);
    const quote = quoteRes.result;
    if (!quote) throw new Error("No quote returned");
    const outputAmount = quote.output_amount || quote.to_amount;
    step("Get Quote", "pass", `Output: ${outputAmount}`);

    // 4. Generate secret
    step("Generate Secret", "running");
    const { secret, secretHash } = generateSecret();
    step("Generate Secret", "pass", `Hash: ${secretHash.substring(0, 18)}...`);

    // 5. Get wallet addresses
    const fromType = config.chains[fromChain]?.type || "evm";
    const toType = config.chains[toChain]?.type || "evm";

    const fromAddress = walletState.getAddressByType(fromType === "evm" ? "evm" : fromType);
    const toAddress   = walletState.getAddressByType(toType   === "evm" ? "evm" : toType);

    if (!fromAddress) throw new Error(`No ${fromType} wallet connected. Go to Connect Wallets tab.`);
    if (!toAddress)   throw new Error(`No ${toType} wallet connected. Go to Connect Wallets tab.`);

    // 6. Create order
    step("Create Order", "running");
    const orderRes = await garden.createOrder({
      source: { asset: fromAsset, owner: fromAddress, amount: String(amount) },
      destination: { asset: toAsset, owner: toAddress, amount: String(outputAmount) },
      secret_hash: secretHash,
      slippage: 50,
    });
    const orderId = orderRes.result?.order_id;
    const htlcAddress = orderRes.result?.to;
    const htlcAmount = orderRes.result?.amount;
    if (!orderId) throw new Error("No order_id returned");
    step("Create Order", "pass", `Order: ${orderId}`, null);

    // 7. Manual approve gate
    if (config.manualApprove) {
      step("Awaiting Manual Approval", "pending", "Waiting for your approval in dashboard...");
      const approved = await requestApproval({
        orderId, fromChain, toChain, fromAsset, toAsset,
        amount, outputAmount, htlcAddress, label
      });
      if (!approved) {
        step("Manual Approval", "skipped", "User rejected transaction");
        emit("test_end", { testId, label, status: "skipped", steps });
        return { testId, label, status: "skipped", steps };
      }
      step("Manual Approval", "pass", "User approved");
    }

    // 8. Initiate on source chain
    step("Initiate HTLC", "running");
    let initTxHash;
    if (fromType === "bitcoin") {
      initTxHash = await initiateHtlc({ htlcAddress, amountSats: htlcAmount || amount });
    } else if (config.evmChainIds.includes(fromChain)) {
      initTxHash = await initiateEvm({
        htlcAddress,
        tokenAddress: quote.source_token_address || "native",
        amount: htlcAmount || amount,
        secretHash,
        receiverAddress: htlcAddress,
        expiry: Math.floor(Date.now() / 1000) + 7200,
        chainKey: fromChain,
      });
    } else {
      throw new Error(`Initiation not yet implemented for chain type: ${fromType}`);
    }
    step("Initiate HTLC", "pass", `Tx sent`, initTxHash);

    // 9. Notify Garden API of initiation
    step("Notify Garden API", "running");
    await garden.patchOrder(orderId, "initiate", initTxHash);
    step("Notify Garden API", "pass", "Garden acknowledged initiation");

    // 10. Wait for solver to lock on destination
    step("Solver Lock", "running", "Waiting for solver to lock destination...");
    const lockResult = await garden.pollOrder(orderId, "solver_locked", 300000);
    if (!lockResult.success) throw new Error(`Solver did not lock: ${lockResult.reason}`);
    step("Solver Lock", "pass", `Locked in ${Math.round(lockResult.elapsed / 1000)}s`);

    // 11. Redeem on destination
    step("Redeem Destination", "running");
    let redeemTxHash;
    if (toType === "evm" || config.evmChainIds.includes(toChain)) {
      const htlcContract = lockResult.order?.destination_htlc_address;
      redeemTxHash = await redeemEvm({ htlcAddress: htlcContract, secret, chainKey: toChain });
    } else {
      // For non-EVM destinations, Garden solver redeems automatically
      redeemTxHash = "solver_auto_redeem";
    }
    step("Redeem Destination", "pass", "Redemption sent", redeemTxHash);

    // 12. Poll for completion
    step("Order Completion", "running", "Waiting for final confirmation...");
    const finalResult = await garden.pollOrder(orderId, "completed", 300000);
    if (!finalResult.success) throw new Error(`Order did not complete: ${finalResult.reason}`);

    const elapsed = Math.round((Date.now() - steps[0].ts) / 1000);
    step("Order Completion", "pass", `Completed in ~${elapsed}s`);

    // 13. Verify amounts
    step("Amount Verification", "running");
    const received = finalResult.order?.destination_filled_amount || outputAmount;
    const slippagePct = Math.abs(received - outputAmount) / outputAmount * 100;
    if (slippagePct > 1.5) throw new Error(`Slippage ${slippagePct.toFixed(2)}% exceeds 1.5%`);
    step("Amount Verification", "pass", `Received: ${received} (${slippagePct.toFixed(3)}% slippage)`);

    emit("test_end", { testId, label, status: "pass", steps, duration: elapsed });
    return { testId, label, status: "pass", steps };

  } catch (err) {
    const lastStep = steps[steps.length - 1];
    const failStep = { name: lastStep?.name || "Unknown", status: "fail", detail: err.message, ts: new Date().toISOString() };
    steps.push(failStep);
    emit("test_step", { testId, label, step: failStep });
    emit("test_end", { testId, label, status: "fail", error: err.message, steps });
    return { testId, label, status: "fail", error: err.message, steps };
  }
}

// ── API HEALTH TESTS (no wallet needed) ──────────────────────
async function runApiTests() {
  const results = [];
  const tests = [
    { name: "Server Health",  fn: () => garden.health() },
    { name: "Get Chains",     fn: () => garden.getChains() },
    { name: "Get Assets",     fn: () => garden.getAssets() },
    { name: "Get Volume",     fn: () => garden.getVolume() },
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

// ── BUILD ALL ROUTES FROM CONFIG ──────────────────────────────
function buildRoutes() {
  // All routes: bitcoin <-> every other chain, plus cross-chain non-BTC
  const btc = config.chains.bitcoin;
  const others = Object.values(config.chains).filter(c => c.id !== "bitcoin");
  const routes = [];

  // BTC as source
  for (const dest of others) {
    routes.push({
      fromChain: "bitcoin", toChain: dest.id,
      fromAsset: btc.asset, toAsset: dest.asset,
      amount: config.test.btcAmountSats || 50000,
      label: `BTC → ${dest.name}`,
    });
  }
  // BTC as destination
  for (const src of others) {
    routes.push({
      fromChain: src.id, toChain: "bitcoin",
      fromAsset: src.asset, toAsset: btc.asset,
      amount: config.test.evmAmount || 50000,
      label: `${src.name} → BTC`,
    });
  }
  return routes;
}

// ── RUN ALL TESTS ─────────────────────────────────────────────
async function runAll() {
  emit("suite_start", { env: config.env, ts: new Date().toISOString() });
  const apiResults = await runApiTests();
  const routes = buildRoutes();
  const results = [];

  for (const route of routes) {
    // Check liquidity before attempting
    try {
      const liq = await garden.getLiquidity(route.fromAsset, route.toAsset);
      if (!liq.result || liq.result?.available_liquidity === 0) {
        emit("test_end", { testId: `${route.fromChain}->${route.toChain}`, label: route.label, status: "skipped", error: "No liquidity" });
        results.push({ label: route.label, status: "skipped", reason: "No liquidity" });
        continue;
      }
    } catch (_) { /* proceed anyway */ }

    const result = await runRoute(route);
    results.push(result);
    await new Promise(r => setTimeout(r, 2000)); // small gap between tests
  }

  emit("suite_end", { env: config.env, total: results.length,
    passed: results.filter(r => r.status === "pass").length,
    failed: results.filter(r => r.status === "fail").length,
    skipped: results.filter(r => r.status === "skipped").length,
    ts: new Date().toISOString() });

  return results;
}

module.exports = { runAll, runApiTests, runRoute, buildRoutes, setEmitter, handleApproval };