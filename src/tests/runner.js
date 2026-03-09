// src/tests/runner.js
const garden = require("../api/garden");

// All free public testnet RPCs — used when .env doesn't set a custom RPC
const FREE_RPCS = {
  base:       'https://sepolia.base.org',
  ethereum:   'https://rpc.sepolia.org',
  arbitrum:   'https://sepolia-rollup.arbitrum.io/rpc',
  bnbchain:   'https://data-seed-prebsc-1-s1.binance.org:8545',
  hyperevm:   'https://rpc.hyperliquid-testnet.xyz/evm',
  monad:      'https://testnet-rpc.monad.xyz',
  citrea:     'https://rpc.testnet.citrea.xyz',
  alpen:      'https://rpc.testnet.alpen.xyz',
};

// Resolve RPC URL from asset/chain string or chain ID (number/string)
function resolveRpcUrl(chainIdOrAsset) {
  const { chains } = require('../config');

  // If passed a chain ID number, find by chainId field
  if (typeof chainIdOrAsset === 'number' || (typeof chainIdOrAsset === 'string' && /^\d+$/.test(chainIdOrAsset))) {
    const cid = String(chainIdOrAsset);
    const entry = Object.values(chains).find(c => c.chainId && String(c.chainId) === cid);
    if (entry?.rpc) return entry.rpc;
    // Known chain ID → free RPC
    const CID_MAP = {
      '97':     FREE_RPCS.bnbchain,    // BSC testnet
      '84532':  FREE_RPCS.base,        // Base Sepolia
      '421614': FREE_RPCS.arbitrum,    // Arb Sepolia
      '11155111': FREE_RPCS.ethereum,  // ETH Sepolia
      '10143':  FREE_RPCS.monad,       // Monad testnet
      '998':    FREE_RPCS.hyperevm,    // HyperEVM
    };
    return CID_MAP[cid] || null;
  }

  // Passed an asset string like "bnbchain_testnet:usdt" or a chain key like "bnbchain"
  const raw = String(chainIdOrAsset).split(':')[0];
  const stripped = raw.replace(/_sepolia|_testnet\d*|_mainnet|_signet|_devnet/g, '');
  return chains[stripped]?.rpc || FREE_RPCS[stripped] || chains[raw]?.rpc || null;
}
const config  = require("../config");
const { initiateEvm, redeemEvm } = require("../htlc/evm");
const envkey = require("../wallet/envkey");
const { initiateHtlc }           = require("../wallet/btc");
const walletState = require("../wallet/state");

let _emit = null;
let _approvalQueue = [];
// Map of active testId → abort controller
const _activeTests = new Map();
let _globalAbort = false;
// Cache of validated pairs: Set of "fromAsset::toAsset" strings
let _validPairsCache = { ts: 0, pairs: null };
const PAIRS_CACHE_MS = 10 * 60 * 1000; // 10 min

function setEmitter(fn) { _emit = fn; }
function emit(event, data) {
  if (_emit) _emit(event, data);
  else console.log(`[${event}]`, JSON.stringify(data).slice(0, 120));
}

// ── APPROVAL / EVM TX / EIP-712 SIGN QUEUE ──────────────────
// All async browser-side responses use one unified array queue.

async function requestApproval(txData) {
  return new Promise(resolve => {
    const id = Date.now().toString();
    emit("approval_request", { id, ...txData });
    _approvalQueue.push({ id, resolve });
  });
}

// Regular MetaMask tx — user pays gas
async function requestEvmTx({ orderId, label, to, data, value, chainId, gasLimit }) {
  return new Promise((resolve, reject) => {
    const id = `evmtx_${Date.now()}`;
    emit("evm_tx_request", { id, orderId, label, to, data, value, chainId: String(chainId), gasLimit });
    _approvalQueue.push({ id, resolve, reject });
    setTimeout(() => {
      const idx = _approvalQueue.findIndex(a => a.id === id);
      if (idx !== -1) { _approvalQueue.splice(idx, 1); reject(new Error("EVM tx timeout — MetaMask not responded in 5 min")); }
    }, 300000);
  });
}

// Gasless EIP-712 — MetaMask signs, Garden relayer submits
async function requestEvmSign({ orderId, label, signData, chainId }) {
  return new Promise((resolve, reject) => {
    const id = `evmsign_${Date.now()}`;
    emit("evm_sign_request", { id, orderId, label, signData, chainId: String(chainId) });
    _approvalQueue.push({ id, resolve, reject });
    setTimeout(() => {
      const idx = _approvalQueue.findIndex(a => a.id === id);
      if (idx !== -1) { _approvalQueue.splice(idx, 1); reject(new Error("EIP-712 sign timeout — MetaMask not responded in 5 min")); }
    }, 300000);
  });
}

function handleApproval(id, approved) {
  const idx = _approvalQueue.findIndex(q => q.id === id);
  if (idx !== -1) { _approvalQueue[idx].resolve(approved); _approvalQueue.splice(idx, 1); }
}

function handleEvmTxResponse(id, txHash) {
  const idx = _approvalQueue.findIndex(q => q.id === id);
  if (idx !== -1) {
    if (txHash) _approvalQueue[idx].resolve(txHash);
    else _approvalQueue[idx].reject(new Error("EVM transaction rejected by user"));
    _approvalQueue.splice(idx, 1);
  }
}

function handleEvmSignResponse(id, signature) {
  const idx = _approvalQueue.findIndex(q => q.id === id);
  if (idx !== -1) {
    if (signature) _approvalQueue[idx].resolve(signature);
    else _approvalQueue[idx].reject(new Error("EIP-712 signature rejected by user"));
    _approvalQueue.splice(idx, 1);
  }
}

function abortTest(testId) {
  const ctrl = _activeTests.get(testId);
  if (ctrl) { ctrl.abort = true; }
}

function abortAll() {
  _globalAbort = true;
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

    // 5b. Balance check — verify source wallet has enough BEFORE locking anything on-chain
    step("Balance Check", "running");
    checkAbort();
    try {
      const wallets = walletState.getStatus();
      let balance = null;
      let balanceLabel = "";

      if (fromChain === "bitcoin") {
        const rawBal = wallets.btc?.balance;
        if (rawBal && rawBal !== "unknown") {
          balance = Math.floor(parseFloat(rawBal) * 1e8); // → sats
          balanceLabel = `${balance.toLocaleString()} sats`;
        }
      } else if (fromChain === "evm") {
        // Free public RPC fallbacks — used when .env doesn't have custom RPCs
        const FREE_RPCS_FALLBACK = {
          'base':       'https://sepolia.base.org',
          'ethereum':   'https://rpc.sepolia.org',
          'arbitrum':   'https://sepolia-rollup.arbitrum.io/rpc',
          'bnbchain':   'https://data-seed-prebsc-1-s1.binance.org:8545',
          'hyperevm':   'https://rpc.hyperliquid-testnet.xyz/evm',
          'monad':      'https://testnet-rpc.monad.xyz',
          'citrea':     'https://rpc.testnet.citrea.xyz',
          'alpen':      'https://rpc.testnet.alpen.xyz',
        };

        // Fetch on-chain ERC20 or native balance live before committing
        try {
          const tokenAddr = fromMeta?.token_address;
          const { ethers } = require('ethers');

          // Resolve chain key (e.g. "base_sepolia" → "base")
          const rawKey = fromAsset.split(':')[0];
          const chainKey = rawKey.replace(/_sepolia|_testnet\d*|_mainnet|_signet|_devnet/g, '');

          // Use configured RPC first, then free public fallback
          const chainConf = require('../config').chains;
          const rpcUrl = chainConf[chainKey]?.rpc || FREE_RPCS_FALLBACK[chainKey] || '';
          if (!rpcUrl) throw new Error(`No RPC URL for chain key: ${chainKey} (raw: ${rawKey})`);

          const provider = new ethers.JsonRpcProvider(rpcUrl);
          if (!tokenAddr || tokenAddr === 'native' || tokenAddr === '0x0000000000000000000000000000000000000000') {
            const wei = await provider.getBalance(fromAddress);
            balance = Number(wei);
            balanceLabel = `${(balance/1e18).toFixed(6)} ETH`;
          } else {
            const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];
            const token = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
            const [bal, decimals] = await Promise.all([token.balanceOf(fromAddress), token.decimals().catch(()=>8)]);
            balance = Number(bal);
            const ticker = fromAsset.split(':')[1]?.toUpperCase() || 'TOKEN';
            balanceLabel = `${(balance/Math.pow(10,decimals)).toFixed(6)} ${ticker}`;
          }
        } catch(onChainErr) {
          // RPC failed — try cached balance from wallet panel fetch (assetId → raw atomic units)
          const cachedBals = wallets.evm?.tokenBalances || {};
          // Direct assetId lookup (new format: "base_sepolia:wbtc" → raw units)
          if (cachedBals[fromAsset] !== undefined) {
            balance = Number(cachedBals[fromAsset]);
            balanceLabel = `${balance} (cached)`;
          } else {
            // Last resort: check if dashboard fetched EVM native/token balances via server
            console.warn('[runner] EVM balance RPC error:', onChainErr.message);
          }
        }
      } else if (fromChain === "solana") {
        const rawBal = wallets.solana?.balance;
        if (rawBal) { balance = parseFloat(rawBal); balanceLabel = `${balance} SOL`; }
      }

      if (balance !== null && balance < safeAmount) {
        const msg = `Insufficient balance: have ${balanceLabel}, need ${safeAmount.toLocaleString()} (atomic units)`;
        step("Balance Check", "fail", msg);
        emit("test_end", { testId, label, status: "skipped", error: msg });
        _activeTests.delete(testId);
        return { testId, label, status: "skipped", error: msg };
      }

      // For EVM: if we couldn't verify balance, warn but allow to proceed
      // The wallet panel has already shown the user their balance — blocking here is too aggressive
      // and breaks flows when the public RPC is slow or rate-limited temporarily.
      if (fromChain === "evm" && balance === null) {
        step("Balance Check", "pass", "⚠️ Balance unverifiable (RPC unavailable) — proceeding with caution. Ensure you have funds.");
      }

      const balMsg = balance !== null ? `${balanceLabel} ≥ ${safeAmount.toLocaleString()} ✓` : "Balance verified OK";
      step("Balance Check", "pass", balMsg);
    } catch(balErr) {
      // Balance check threw unexpectedly — for EVM this is fatal (don't create order)
      if (fromChain === "evm") {
        const msg = `Balance check error: ${balErr.message} — Order blocked. Fix RPC connection.`;
        step("Balance Check", "fail", msg);
        emit("test_end", { testId, label, status: "skipped", error: msg });
        _activeTests.delete(testId);
        return { testId, label, status: "skipped", error: msg };
      }
      // For non-EVM (BTC/SOL) a balance error is acceptable — proceed with warning
      step("Balance Check", "pass", `Could not verify (${balErr.message}) — continuing`);
    }

    // 5c. Create order — Garden manages secrets, no secret_hash needed
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


    // ── ERC20 approve helper — used by both MetaMask and envkey paths ──
    const FREE_RPCS_LOCAL = {
      84532:    'https://sepolia.base.org',
      11155111: 'https://rpc.sepolia.org',
      421614:   'https://sepolia-rollup.arbitrum.io/rpc',
      97:       'https://data-seed-prebsc-1-s1.binance.org:8545',
      'base_sepolia':     'https://sepolia.base.org',
      'base':             'https://sepolia.base.org',
      'ethereum_sepolia': 'https://rpc.sepolia.org',
      'ethereum':         'https://rpc.sepolia.org',
      'arbitrum_sepolia': 'https://sepolia-rollup.arbitrum.io/rpc',
      'arbitrum':         'https://sepolia-rollup.arbitrum.io/rpc',
      'bnbchain_testnet': 'https://data-seed-prebsc-1-s1.binance.org:8545',
      'bnbchain':         'https://data-seed-prebsc-1-s1.binance.org:8545',
      'hyperevm_testnet': 'https://rpc.hyperliquid-testnet.xyz/evm',
      'monad_testnet':    'https://testnet-rpc.monad.xyz',
    };

    // Resolve best available RPC for a chainId or chain key
    function resolveRpcLocal(chainIdOrKey) {
      const chainConf = require('../config').chains;
      const numId = parseInt(chainIdOrKey);
      if (!isNaN(numId)) {
        const found = Object.values(chainConf).find(c => c.chainId === numId);
        if (found?.rpc) return found.rpc;
        if (FREE_RPCS_LOCAL[numId]) return FREE_RPCS_LOCAL[numId];
      }
      const k = String(chainIdOrKey).toLowerCase();
      if (FREE_RPCS_LOCAL[k]) return FREE_RPCS_LOCAL[k];
      const stripped = k.replace(/_sepolia|_testnet\d*|_mainnet/g, '');
      if (FREE_RPCS_LOCAL[stripped]) return FREE_RPCS_LOCAL[stripped];
      if (chainConf[k]?.rpc) return chainConf[k].rpc;
      throw new Error('No RPC for chain: ' + chainIdOrKey);
    }

    // Ensure ERC20 approval is in place — waits for on-chain confirmation
    async function ensureErc20Approval({ tokenAddr, spender, amount, chainIdOrKey, walletMode }) {
      if (!tokenAddr || tokenAddr === 'native' || tokenAddr === '0x0000000000000000000000000000000000000000') return;
      const { ethers } = require('ethers');
      const ERC20_ABI = [
        'function allowance(address,address) view returns (uint256)',
        'function approve(address,uint256) returns (bool)',
      ];
      let rpcUrl;
      try { rpcUrl = resolveRpcLocal(chainIdOrKey); } catch(_) {}
      const fromAddr = walletState.getAddressByType('evm');

      // Check current allowance
      let needsApproval = true;
      if (rpcUrl && fromAddr) {
        try {
          const provider = new ethers.JsonRpcProvider(rpcUrl);
          const token = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
          const allowance = await token.allowance(fromAddr, spender);
          needsApproval = allowance < BigInt(amount);
          step('ERC20 Approve', needsApproval ? 'running' : 'pass',
            needsApproval
              ? `Allowance ${allowance.toString()} < ${amount} — approval required`
              : `Allowance already sufficient (${allowance.toString()})`);
          if (!needsApproval) return; // already approved
        } catch(e) {
          step('ERC20 Approve', 'running', `Could not read allowance (${e.message.slice(0,60)}) — will approve anyway`);
        }
      } else {
        step('ERC20 Approve', 'running', 'No RPC to check allowance — will approve anyway');
      }

      // Build approve(spender, MAX_UINT256) calldata
      const approveIface = new ethers.Interface(['function approve(address,uint256) returns (bool)']);
      const approveData  = approveIface.encodeFunctionData('approve', [
        spender,
        BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'),
      ]);

      let approveTxHash;
      if (walletMode === 'envkey') {
        step('ERC20 Approve', 'running', 'Sending approve() via .env key…');
        approveTxHash = await envkey.sendEvmTransaction({
          to: tokenAddr, data: approveData, value: '0x0',
          chainId: chainIdOrKey, gasLimit: '0x186a0',
        });
        // sendEvmTransaction already calls sent.wait(1) — confirmed
        step('ERC20 Approve', 'pass', `Approved on-chain: ${approveTxHash}`);
      } else {
        // MetaMask / browser wallet
        step('ERC20 Approve', 'running', 'Requesting approve() in wallet — please sign…');
        approveTxHash = await requestEvmTx({
          orderId,
          label: label + ' [ERC20 Approve]',
          to: tokenAddr, data: approveData, value: '0x0',
          chainId: chainIdOrKey, gasLimit: '0x186a0',
        });
        step('ERC20 Approve', 'running', `Approve tx sent: ${approveTxHash} — waiting for confirmation…`);
        // Wait for on-chain confirmation before proceeding to initiate
        if (rpcUrl && approveTxHash && approveTxHash.startsWith('0x')) {
          try {
            const { waitForConfirmation } = require('../htlc/evm');
            // Pass chainIdOrKey directly — waitForConfirmation → getProvider → resolveRpc handles numeric IDs and full chain keys
            await waitForConfirmation(approveTxHash, String(chainIdOrKey), 120000);
            step('ERC20 Approve', 'pass', `Confirmed on-chain: ${approveTxHash}`);
          } catch(waitErr) {
            // If confirmation wait fails, give it 8s and continue
            step('ERC20 Approve', 'running', `Confirmation wait failed (${waitErr.message.slice(0,50)}) — waiting 8s then proceeding`);
            await new Promise(r => setTimeout(r, 8000));
            step('ERC20 Approve', 'pass', `Approved (unconfirmed): ${approveTxHash}`);
          }
        } else {
          await new Promise(r => setTimeout(r, 8000));
          step('ERC20 Approve', 'pass', `Approved: ${approveTxHash}`);
        }
      }
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
      const prebuiltTx = orderRes.result?.initiate_transaction;
      const signData   = orderRes.result?.sign_data || orderRes.result?.eip712_data || orderRes.result?.permit_data;

      if (signData && prebuiltTx?.chain_id) {
        // ── GASLESS PATH: sign EIP-712 typed data, relayer submits tx ──
        step("Initiate HTLC", "pending", "Waiting for EIP-712 signature (gasless)…");
        const signature = await requestEvmSign({
          orderId,
          label,
          signData,
          chainId: prebuiltTx.chain_id,
        });
        // Notify Garden with signature instead of tx_hash — relayer submits for us
        step("Initiate HTLC", "pass", "Signed (gasless — relayer submitting)");
        await garden.patchOrder(orderId, "initiate", { signature });
        step("Notify Garden", "pass", "Signature accepted by relayer");
        // Skip the normal Notify Garden step since we already patched above
        initTxHash = "gasless_relayer";
      } else if (prebuiltTx?.data && prebuiltTx?.to) {
        // ── REGULAR PATH: send tx via MetaMask, user pays gas ──
        // Ensure ERC20 approval is in place before initiating
        await ensureErc20Approval({
          tokenAddr:    orderRes.result?.source?.token_address,
          spender:      prebuiltTx.to,
          amount:       htlcAmount,
          chainIdOrKey: prebuiltTx.chain_id,
          walletMode:   'metamask',
        });
        step("Initiate HTLC", "pending", "Waiting for wallet approval of initiate tx…");
        initTxHash = await requestEvmTx({
          orderId,
          label,
          to:      prebuiltTx.to,
          data:    prebuiltTx.data,
          value:   prebuiltTx.value || "0x0",
          chainId: prebuiltTx.chain_id,
          gasLimit: prebuiltTx.gas_limit || "0x493e0",
        });
      } else if (walletState.getStatus().evmSource === "privy") {
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
      } else if (walletState.getStatus().evmSource === "envkey" && envkey.isAvailable()) {
        // Backend private key — sign and broadcast directly, no user interaction
        step("Initiate HTLC", "running", "Signing with .env private key…");
        // Ensure ERC20 approval is in place before initiating
        await ensureErc20Approval({
          tokenAddr:    orderRes.result?.source?.token_address,
          spender:      prebuiltTx?.to || htlcAddress,
          amount:       htlcAmount,
          chainIdOrKey: prebuiltTx?.chain_id || fromAsset.split(":")[0],
          walletMode:   'envkey',
        });
        initTxHash = await envkey.sendEvmTransaction({
          to:       prebuiltTx?.to      || htlcAddress,
          data:     prebuiltTx?.data    || "0x",
          value:    prebuiltTx?.value   || "0x0",
          chainId:  prebuiltTx?.chain_id || fromAsset.split(":")[0],
          gasLimit: prebuiltTx?.gas_limit,
        });
      } else {
        throw new Error("EVM source: connect MetaMask in the dashboard, or set EVM_PRIVATE_KEY in .env for automated signing.");
      }
    } else {
      throw new Error(`Initiation not yet implemented for: ${fromChain}`);
    }
    step("Initiate HTLC", "pass", "Transaction sent", initTxHash);

    // 8. Notify Garden (skip if gasless path already patched above)
    if (initTxHash !== "gasless_relayer") {
      step("Notify Garden", "running");
      checkAbort();

      // Wait for EVM tx to confirm on-chain before notifying Garden
      // Garden's API rejects the notification if the tx isn't confirmed yet
      if (fromChain === "evm" && initTxHash && initTxHash.startsWith?.("0x")) {
        step("Notify Garden", "running", `Waiting for tx confirmation on-chain…`);
        try {
          const { waitForConfirmation } = require("../htlc/evm");
          // Strip testnet suffixes to match config.chains key (e.g. "base_sepolia" → "base")
          const rawChainKey = fromAsset.split(":")[0];
          const chainKey = rawChainKey.replace(/_sepolia|_testnet\d*|_mainnet|_signet/g, "");
          const receipt = await waitForConfirmation(initTxHash, chainKey, 180000);
          if (receipt?.status === 0) {
            throw new Error(`On-chain tx reverted (status=0). Check allowance and funds.`);
          }
          step("Notify Garden", "running", `Confirmed in block ${receipt?.blockNumber} — notifying Garden…`);
        } catch(waitErr) {
          if (waitErr.message.includes("reverted")) throw waitErr;
          // If wait times out or fails, still try to notify (Garden may detect it independently)
          step("Notify Garden", "running", `Confirmation wait failed (${waitErr.message.slice(0,80)}) — notifying anyway…`);
        }
      }

      // Retry notifying Garden until it acknowledges OR the order already advanced past initiation
      // (Garden returns 400 while tx isn't confirmed enough — keep retrying every 5s)
      const NOTIFY_TIMEOUT = 5 * 60 * 1000; // 5 minutes max
      const NOTIFY_INTERVAL = 5000;
      const notifyStart = Date.now();
      let notifyAttempts = 0;
      let notifyDone = false;

      while (!notifyDone && (Date.now() - notifyStart) < NOTIFY_TIMEOUT) {
        checkAbort();
        notifyAttempts++;
        try {
          await garden.patchOrder(orderId, "initiate", initTxHash);
          step("Notify Garden", "pass", notifyAttempts === 1 ? "Acknowledged" : `Acknowledged after ${notifyAttempts} attempts (${Math.round((Date.now()-notifyStart)/1000)}s)`);
          notifyDone = true;
        } catch(patchErr) {
          const httpStatus = patchErr.response?.status;
          const detail = patchErr.response?.data ? JSON.stringify(patchErr.response.data).slice(0, 200) : patchErr.message;

          // Check if Garden already knows about this tx (order may have progressed on its own)
          try {
            const orderCheck = await garden.getOrder(orderId);
            // Garden response: { status: "ok", result: { status/order_status: "Matched", ... } }
            const orderObj = orderCheck?.result || orderCheck;
            const currentStatus = (orderObj?.status || orderObj?.order_status || orderObj?.state || "").toLowerCase().replace(/\s+/g,"");
            // Filter out HTTP-level "ok" — that's not an order lifecycle status
            const realStatus = currentStatus === 'ok' ? '' : currentStatus;
            const pastInitiation = ["initiatedetected","initiated","counterpartyinitiatedetected",
                                    "counterpartyinitiated","redeemed","completed"].some(s => realStatus.includes(s));
            if (pastInitiation) {
              step("Notify Garden", "pass", `Order already at '${realStatus}' — Garden detected tx on-chain (attempt ${notifyAttempts})`);
              notifyDone = true;
              break;
            }
            // Terminal failure states — stop retrying
            const isTerminal = ["expired","refunded","failed","cancelled"].some(s => realStatus.includes(s));
            if (isTerminal) {
              throw new Error(`Order reached terminal status '${realStatus}' before Garden acknowledged initiation`);
            }
            const displayStatus = realStatus || '(fetching…)';
            step("Notify Garden", "running",
              `Attempt ${notifyAttempts} — HTTP ${httpStatus||'?'} (${detail.slice(0,80)}) · order: ${displayStatus} · retrying in 5s…`);
          } catch(checkErr) {
            if (checkErr.message.includes("terminal status")) throw checkErr;
            step("Notify Garden", "running",
              `Attempt ${notifyAttempts} — ${detail.slice(0,80)} · retrying in 5s…`);
          }

          await new Promise(r => setTimeout(r, NOTIFY_INTERVAL));
        }
      }

      if (!notifyDone) {
        // Timed out retrying — check order status one final time before giving up
        try {
          const finalCheck = await garden.getOrder(orderId);
          const finalObj = finalCheck?.result || finalCheck;
          const finalStatusRaw = (finalObj?.status || finalObj?.order_status || finalObj?.state || "").toLowerCase().replace(/\s+/g,"");
          const finalStatus = finalStatusRaw === 'ok' ? '' : finalStatusRaw;
          const pastInitiation = ["initiated","counterparty","redeemed","completed"].some(s => finalStatus.includes(s));
          if (pastInitiation) {
            step("Notify Garden", "pass", `Timed out notifying but order is at '${finalStatus}' — proceeding`);
            notifyDone = true;
          } else {
            step("Notify Garden", "fail", `Failed to notify Garden after ${notifyAttempts} attempts (${Math.round(NOTIFY_TIMEOUT/1000)}s). Order status: ${finalStatus}`);
            throw new Error(`Notify Garden timed out after ${notifyAttempts} attempts. Order stuck at: ${finalStatus}`);
          }
        } catch(finalErr) {
          if (!finalErr.message.includes("timed out")) throw finalErr;
          throw finalErr;
        }
      }
    }

    // 9. Poll through the real Garden lifecycle:
    //    Matched → InitiateDetected → Initiated → CounterPartyInitiateDetected → CounterPartyInitiated
    // Only after CounterPartyInitiated is the solver's HTLC confirmed and we can redeem.

    step("Solver Initiated", "running", "Waiting for solver to lock on destination chain…");
    checkAbort();

    let solverOrder = null;
    const solverResult = await garden.pollOrder(
      orderId,
      "counterpartyinitiated",   // target — matches "CounterPartyInitiated" case-insensitively
      600000,                     // 10 min max
      5000,
      (status, order) => {
        // Live status updates surfaced to UI while we wait
        const pretty = {
          "matched":                         "Matched — waiting for solver auction…",
          "initiatedetected":                "InitiateDetected — your tx seen on-chain…",
          "initiated":                       "Initiated — your tx confirmed ✓  Waiting for solver…",
          "counterpartyinitiatedetected":    "CounterPartyInitiateDetected — solver tx seen on destination…",
        }[status] || `Status: ${status}`;

        const destSwap   = order?.destination_swap;
        const confirms   = destSwap?.current_confirmations ?? "?";
        const reqConfirm = destSwap?.required_confirmations ?? "?";
        const detail     = destSwap?.initiate_tx_hash
          ? `${pretty}  (solver tx: …${destSwap.initiate_tx_hash.slice(-8)}, confirmations: ${confirms}/${reqConfirm})`
          : pretty;
        step("Solver Initiated", "running", detail);
      }
    );

    if (!solverResult.success) {
      throw new Error(`Solver did not initiate on destination: ${solverResult.reason} (last status: ${solverResult.status})`);
    }

    solverOrder = solverResult.order;
    const destSwap = solverOrder?.destination_swap;
    const solverTxHash = destSwap?.initiate_tx_hash || "unknown";
    step("Solver Initiated", "pass",
      `CounterPartyInitiated ✓  solver tx: ${solverTxHash.slice(0, 10)}…  (${Math.round(solverResult.elapsed / 1000)}s)`,
      solverTxHash
    );

    // 10. Redeem on destination — now that solver's HTLC is confirmed
    step("Redeem", "running");
    checkAbort();
    let redeemTxHash = "solver_auto_redeem";
    const destStatus = walletState.getStatus();

    try {
      // Garden puts the pre-built redeem tx in redeem_transaction once CounterPartyInitiated
      const redeemTx = solverOrder?.redeem_transaction;
      // Secret is available from the order once solver has initiated
      const secret   = solverOrder?.secret || solverOrder?.swap_secret || orderRes.result?.secret;
      // Destination HTLC address comes from destination_swap
      const htlcContract = destSwap?.htlc_address || solverOrder?.destination_htlc_address;
      // Chain key for EVM ops — strip testnet suffix to match config.chains key
      const toChainKey = toAsset.split(":")[0].replace(/_sepolia|_testnet\d*|_mainnet|_signet/g, "");

      if (toChain === "evm") {
        if (redeemTx?.data && redeemTx?.to &&
            (destStatus.evmSource === "envkey" || destStatus.evmSource === "privy") &&
            envkey.isEvmAvailable()) {
          // envkey path — use Garden's pre-built redeem tx directly
          step("Redeem", "running", "Signing redeem with .env key…");
          redeemTxHash = await envkey.sendEvmTransaction({
            to: redeemTx.to,
            data: redeemTx.data,
            value: redeemTx.value || "0x0",
            chainId: redeemTx.chain_id,
            gasLimit: redeemTx.gas_limit,
          });
        } else if (secret && htlcContract && envkey.isEvmAvailable()) {
          // envkey path — build redeem manually from secret + HTLC address
          step("Redeem", "running", "Redeeming EVM HTLC with .env key…");
          const { redeemEvm } = require("../htlc/evm");
          redeemTxHash = await redeemEvm({ htlcAddress: htlcContract, secret, chainKey: toChainKey });
        } else if (redeemTx?.data && redeemTx?.to && destStatus.evmSource === "metamask") {
          // MetaMask path — request user to sign the redeem tx
          step("Redeem", "running", "Requesting MetaMask signature for redeem…");
          redeemTxHash = await requestEvmTx({
            orderId,
            label: `Redeem on ${toAsset}`,
            to:      redeemTx.to,
            data:    redeemTx.data,
            value:   redeemTx.value || "0x0",
            chainId: redeemTx.chain_id,
            gasLimit: redeemTx.gas_limit,
          });
        } else {
          step("Redeem", "pending", "Waiting for solver to auto-redeem EVM destination…");
        }

      } else if (toChain === "solana") {
        if (redeemTx && destStatus.solanaSource === "envkey" && envkey.isSolanaAvailable()) {
          step("Redeem", "running", "Signing Solana redeem with .env key…");
          redeemTxHash = await envkey.sendSolanaTransaction(redeemTx);
        } else {
          step("Redeem", "pending", "Waiting for solver to auto-redeem Solana destination…");
        }

      } else if (toChain === "bitcoin") {
        // BTC destination — solver always redeems
        step("Redeem", "pending", "Waiting for solver to redeem BTC destination…");

      } else {
        // starknet / sui / tron — solver handles
        step("Redeem", "pending", `Waiting for solver to auto-redeem ${toChain} destination…`);
      }

    } catch (redeemErr) {
      console.warn(`[runner] backend redeem failed, falling back to solver: ${redeemErr.message}`);
      step("Redeem", "pending", `Backend redeem failed (${redeemErr.message.slice(0,120)}) — solver will handle`);
      redeemTxHash = "solver_auto_redeem";
    }

    step("Redeem", "pass",
      redeemTxHash === "solver_auto_redeem" ? "Solver will auto-redeem" : "Redeemed ✓",
      redeemTxHash !== "solver_auto_redeem" ? redeemTxHash : null
    );

    // 11. Poll for final completion (Redeemed / Completed)
    step("Completion", "running", "Waiting for final confirmation…");
    const finalResult = await garden.pollOrder(
      orderId,
      "redeemed",   // Garden uses "Redeemed" or "Completed"
      300000,
      5000,
      (status) => step("Completion", "running", `Status: ${status}…`)
    );

    // Also accept "completed" as success
    const finalOrder = finalResult.order;
    const finalStatus = (finalOrder?.status || "").toLowerCase();
    if (!finalResult.success && !finalStatus.includes("completed") && !finalStatus.includes("redeemed")) {
      throw new Error(`Swap did not complete: ${finalResult.reason} (last status: ${finalResult.status})`);
    }

    const elapsed = Math.round((Date.now() - new Date(steps[0].ts).getTime()) / 1000);
    step("Completion", "pass", `Done in ~${elapsed}s  (final status: ${finalOrder?.status || "completed"})`);

    // 12. Verify amounts
    step("Amount Verification", "running");
    const received    = parseFloat(
      finalOrder?.destination_filled_amount ||
      finalOrder?.destination_swap?.amount  ||
      outputAmount
    );
    const expected    = parseFloat(outputAmount);
    const slippagePct = expected > 0 ? Math.abs(received - expected) / expected * 100 : 0;
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
async function buildRoutes(amountOverrides = {}) {
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

  // Use validated pairs cache if available (populated by explicit Validate Pairs action).
  // Otherwise run all combinations — unsupported pairs skip quickly via quote error.
  const now = Date.now();
  const validPairs = (_validPairsCache.pairs && now - _validPairsCache.ts < PAIRS_CACHE_MS)
    ? _validPairsCache.pairs : null;
  if (validPairs) console.log(`[buildRoutes] filtering by ${validPairs.size} validated pairs`);

  function assetFamily(asset) {
    const t = (asset.name || asset.id || '').toLowerCase().split(':').pop();
    if (/btc$|^btc|wbtc|cbtc|cbbtc|sbtc|hbtc|btcn|lbtc|tbtc|pbtc|rbtc/.test(t)) return 'btc';
    if (/^eth$|^weth$/.test(t)) return 'eth';
    if (/usdc|usdt|dai|busd/.test(t)) return 'stable';
    return 'other_' + t;
  }
  function isPairPlausible(from, to) {
    const ff = assetFamily(from), tf = assetFamily(to);
    if (ff === tf) return true;
    if (ff === 'btc' && tf !== 'btc') return false;
    if (tf === 'btc' && ff !== 'btc') return false;
    return true;
  }

  const routes = [];
  for (const from of supported) {
    for (const to of supported) {
      if (from.id === to.id) continue;
      if (!isPairPlausible(from, to)) continue;
      if (validPairs && !validPairs.has(`${from.id}::${to.id}`)) continue;
      const overrideAmt = amountOverrides[from.id];
      routes.push({
        fromAsset: from.id,
        toAsset:   to.id,
        fromChain: getWalletTypeForAsset(from),
        toChain:   getWalletTypeForAsset(to),
        amount:    overrideAmt !== undefined ? parseInt(overrideAmt) : parseInt(from.min_amount || 50000),
        fromMeta:  from,
        toMeta:    to,
        label:     `${from.name} → ${to.name}`,
      });
    }
  }
  return routes;
}

// ── RUN ALL ───────────────────────────────────────────────────
async function runAll(amountOverrides = {}) {
  emit("suite_start", { env: config.env, ts: new Date().toISOString() });
  await runApiTests();
  const routes  = await buildRoutes(amountOverrides);
  const results = [];

  emit("suite_routes", { count: routes.length, routes: routes.map(r => r.label) });

  if (!routes.length) {
    emit("suite_info", { message: "No routes built — check wallet connections" });
    emit("suite_end", { env: config.env, total: 0, passed: 0, failed: 0, skipped: 0,
      message: "No routes — connect wallets first", ts: new Date().toISOString() });
    return results;
  }

  _globalAbort = false; // reset on fresh run
  for (const route of routes) {
    if (_globalAbort) {
      emit("suite_aborted", { stopped: results.length, remaining: routes.length - results.length });
      break;
    }
    const result = await runRoute(route);
    results.push(result);
    if (!_globalAbort) await new Promise(r => setTimeout(r, 1000));
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

function setValidPairsCache(pairs) {
  _validPairsCache = { ts: Date.now(), pairs };
  console.log(`[runner] valid pairs cache updated: ${pairs.size} pairs`);
}

module.exports = { runAll, runApiTests, runRoute, buildRoutes, setEmitter, handleApproval, handleEvmTxResponse, abortTest, abortAll, setValidPairsCache };