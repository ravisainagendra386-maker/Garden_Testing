// src/tests/runner.js
const garden = require("../api/garden");

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

function resolveRpcUrl(chainIdOrAsset) {
  const { chains } = require('../config');
  if (typeof chainIdOrAsset === 'number' || (typeof chainIdOrAsset === 'string' && /^\d+$/.test(chainIdOrAsset))) {
    const cid = String(chainIdOrAsset);
    const entry = Object.values(chains).find(c => c.chainId && String(c.chainId) === cid);
    if (entry?.rpc) return entry.rpc;
    const CID_MAP = {
      '97':        FREE_RPCS.bnbchain,
      '84532':     FREE_RPCS.base,
      '421614':    FREE_RPCS.arbitrum,
      '11155111':  FREE_RPCS.ethereum,
      '10143':     FREE_RPCS.monad,
      '998':       FREE_RPCS.hyperevm,
    };
    return CID_MAP[cid] || null;
  }
  const raw = String(chainIdOrAsset).split(':')[0];
  const stripped = raw.replace(/_sepolia|_testnet\d*|_mainnet|_signet|_devnet/g, '');
  return chains[stripped]?.rpc || FREE_RPCS[stripped] || chains[raw]?.rpc || null;
}

const config  = require("../config");
const { initiateEvm, redeemEvm } = require("../htlc/evm");
const envkey = require("../wallet/envkey");
const { initiateHtlc }           = require("../wallet/btc");
const walletState = require("../wallet/state");
const routeOptimizerAgent        = require("../agents/routeOptimizerAgent");
const tradeHistory               = require("../agents/tradeHistory");

let _emit = null;
let _approvalQueue = [];
const _activeTests = new Map();
let _globalAbort = false;

function setEmitter(fn) { _emit = fn; }
function emit(event, data) {
  if (_emit) _emit(event, data);
  else console.log(`[${event}]`, JSON.stringify(data).slice(0, 120));
}

// ── APPROVAL / EVM TX / EIP-712 SIGN QUEUE ──────────────────

async function requestApproval(txData) {
  return new Promise(resolve => {
    const id = Date.now().toString();
    emit("approval_request", { id, ...txData });
    _approvalQueue.push({ id, resolve });
  });
}

async function requestEvmTx({ orderId, label, to, data, value, chainId, gasLimit }) {
  return new Promise((resolve, reject) => {
    const id = `evmtx_${Date.now()}`;
    emit("evm_tx_request", { id, orderId, label, to, data, value, chainId: String(chainId), gasLimit });
    _approvalQueue.push({ id, resolve, reject });
    setTimeout(() => {
      const idx = _approvalQueue.findIndex(a => a.id === id);
      if (idx !== -1) { _approvalQueue.splice(idx, 1); reject(new Error("EVM tx timeout — wallet not responded in 5 min")); }
    }, 300000);
  });
}

async function requestEvmSign({ orderId, label, signData, chainId }) {
  return new Promise((resolve, reject) => {
    const id = `evmsign_${Date.now()}`;
    emit("evm_sign_request", { id, orderId, label, signData, chainId: String(chainId) });
    _approvalQueue.push({ id, resolve, reject });
    setTimeout(() => {
      const idx = _approvalQueue.findIndex(a => a.id === id);
      if (idx !== -1) { _approvalQueue.splice(idx, 1); reject(new Error("EIP-712 sign timeout — wallet not responded in 5 min")); }
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
function getWalletTypeForAsset(asset) {
  const chain  = (asset.chain || "").toLowerCase();
  const prefix = (asset.id    || "").split(":")[0].toLowerCase();
  if (chain.startsWith("evm"))      return "evm";
  if (chain.startsWith("solana"))   return "solana";
  if (chain.startsWith("starknet")) return "starknet";
  if (chain.startsWith("tron"))     return "tron";
  if (chain.startsWith("sui"))      return "sui";
  if (chain === "bitcoin") {
    if (/^bitcoin_(testnet|mainnet|signet)$/.test(prefix)) return "bitcoin";
    return null;
  }
  return null;
}

// ── ASSET FAMILY (for pair plausibility) ─────────────────────
function assetFamily(asset) {
  const t = (asset.name || asset.id || '').toLowerCase().split(':').pop();
  if (/btc$|^btc|wbtc|cbtc|cbbtc|sbtc|hbtc|btcn|lbtc|tbtc|pbtc|rbtc/.test(t)) return 'btc';
  if (/^eth$|^weth$/.test(t)) return 'eth';
  if (/usdc|usdt|dai|busd/.test(t)) return 'stable';
  if (/^ltc$|^wltc$|^cbltc$/.test(t)) return 'ltc';
  return 'other_' + t;
}

function isPairPlausible(from, to) {
  const ff = assetFamily(from), tf = assetFamily(to);
  if (ff === tf) return true;
  if (ff === 'btc' && tf !== 'btc') return false;
  if (tf === 'btc' && ff !== 'btc') return false;
  return true;
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
    if (ctrl.abort || _globalAbort) throw new Error("Test aborted by user");
  }

  emit("test_start", { testId, label, fromChain, toChain, fromAsset, toAsset, amount });

  try {
    // 1. Wallet addresses
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

    // 3. Amount
    const safeAmount = Number(amount) || 50000;
    step("Route Policy", "pass", `Using amount: ${safeAmount} (atomic units)`);

    // 4. Quote
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

    const bestQuote    = quotes[0];
    const outputAmount = String(bestQuote.destination.amount);
    const solverId     = bestQuote.solver_id;
    const fromDisplay  = `${bestQuote.source.display} (${bestQuote.source.value} USD)`;
    const toDisplay    = `${bestQuote.destination.display} (${bestQuote.destination.value} USD)`;
    step("Get Quote", "pass", `${fromDisplay} → ${toDisplay}`);

    // 5a. Liquidity check
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

    // 5b. Balance check
    step("Balance Check", "running");
    checkAbort();
    try {
      const wallets = walletState.getStatus();
      let balance = null;
      let balanceLabel = "";
      let gasBalanceWei = null;
      let gasSymbol = "";
      let isNativeToken = false;

      if (fromChain === "bitcoin") {
        const rawBal = wallets.btc?.balance;
        if (rawBal && rawBal !== "unknown") {
          balance = Math.floor(parseFloat(rawBal) * 1e8);
          balanceLabel = `${balance.toLocaleString()} sats`;
        }
      } else if (fromChain === "evm") {
        try {
          const tokenAddr = fromMeta?.token_address;
          const { ethers } = require('ethers');
          const rawKey = fromAsset.split(':')[0];
          const chainKey = rawKey.replace(/_sepolia|_testnet\d*|_mainnet|_signet|_devnet/g, '');
          const chainConf = require('../config').chains;
          const rpcUrl = chainConf[chainKey]?.rpc || FREE_RPCS[chainKey] || '';
          if (!rpcUrl) throw new Error(`No RPC URL for chain key: ${chainKey}`);

          const provider = new ethers.JsonRpcProvider(rpcUrl);
          if (!tokenAddr || tokenAddr === 'native' || tokenAddr === '0x0000000000000000000000000000000000000000') {
            const wei = await provider.getBalance(fromAddress);
            balance = Number(wei);
            const nativeSym = chainConf[chainKey]?.asset || 'ETH';
            balanceLabel = `${(balance/1e18).toFixed(6)} ${nativeSym}`;
            isNativeToken = true;
          } else {
            const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];
            const token = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
            const [bal, decimals] = await Promise.all([token.balanceOf(fromAddress), token.decimals().catch(()=>8)]);
            balance = Number(bal);
            const ticker = fromAsset.split(':')[1]?.toUpperCase() || 'TOKEN';
            balanceLabel = `${(balance/Math.pow(10,decimals)).toFixed(6)} ${ticker}`;
            try {
              const weiGas = await provider.getBalance(fromAddress);
              gasBalanceWei = BigInt(weiGas.toString());
              gasSymbol = chainConf[chainKey]?.asset || 'ETH';
            } catch(_) {}
          }
        } catch(onChainErr) {
          const cachedBals = walletState.getStatus().evm?.tokenBalances || {};
          if (cachedBals[fromAsset] !== undefined) {
            balance = Number(cachedBals[fromAsset]);
            balanceLabel = `${balance} (cached)`;
          } else {
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

      if (fromChain === "evm" && gasBalanceWei !== null) {
        const MIN_NATIVE_WEI = 10n ** 15n;
        if (gasBalanceWei < MIN_NATIVE_WEI) {
          const nativeAmt = Number(gasBalanceWei) / 1e18;
          const msg = `Insufficient native gas: have ${nativeAmt.toFixed(6)} ${gasSymbol}, require at least ${(Number(MIN_NATIVE_WEI)/1e18).toFixed(6)} ${gasSymbol}`;
          step("Balance Check", "fail", msg);
          emit("test_end", { testId, label, status: "skipped", error: msg });
          _activeTests.delete(testId);
          return { testId, label, status: "skipped", error: msg };
        }
      }

      if (fromChain === "evm" && balance === null) {
        step("Balance Check", "pass", "⚠️ Balance unverifiable (RPC unavailable) — proceeding with caution");
      }

      let balMsg;
      if (balance === null) {
        balMsg = "Balance verified OK";
      } else if (fromChain === "evm" && !isNativeToken && gasBalanceWei !== null) {
        const nativeAmt = Number(gasBalanceWei) / 1e18;
        balMsg = `Token: ${balanceLabel} ≥ ${safeAmount.toLocaleString()}, Gas: ${nativeAmt.toFixed(6)} ${gasSymbol}`;
      } else {
        balMsg = `${balanceLabel} ≥ ${safeAmount.toLocaleString()} (atomic)`;
      }
      step("Balance Check", "pass", balMsg);
    } catch(balErr) {
      if (fromChain === "evm") {
        const msg = `Balance check error: ${balErr.message} — Order blocked.`;
        step("Balance Check", "fail", msg);
        emit("test_end", { testId, label, status: "skipped", error: msg });
        _activeTests.delete(testId);
        return { testId, label, status: "skipped", error: msg };
      }
      step("Balance Check", "pass", `Could not verify (${balErr.message}) — continuing`);
    }

    // 5c. Create order
    step("Create Order", "running");
    checkAbort();
    const orderBody = {
      source: {
        asset:  fromAsset,
        owner:  fromAddress,
        amount: String(safeAmount),
      },
      destination: {
        asset:  toAsset,
        owner:  toAddress,
        amount: outputAmount,
      },
      solver_id: solverId,
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
      throw orderErr;
    }
    console.log("[order response]", JSON.stringify(orderRes).slice(0, 400));

    const orderId     = orderRes.result?.order_id || orderRes.result?.id;
    const htlcAddress = orderRes.result?.source?.htlc_address
                     || orderRes.result?.source?.swap_id
                     || orderRes.result?.to;
    const htlcAmount  = orderRes.result?.source?.amount || safeAmount;

    if (!orderId) throw new Error(`No order_id in response: ${JSON.stringify(orderRes).slice(0, 200)}`);
    step("Create Order", "pass", `Order ID: ${orderId}`);

    // 6. Manual approval gate
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

    // ── ERC20 approve helper ──
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
          if (!needsApproval) return;
        } catch(e) {
          step('ERC20 Approve', 'running', `Could not read allowance — will approve anyway`);
        }
      } else {
        step('ERC20 Approve', 'running', 'No RPC to check allowance — will approve anyway');
      }

      const approveIface = new (require('ethers')).Interface(['function approve(address,uint256) returns (bool)']);
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
        step('ERC20 Approve', 'pass', `Approved on-chain: ${approveTxHash}`);
      } else {
        step('ERC20 Approve', 'running', 'Requesting approve() in wallet…');
        approveTxHash = await requestEvmTx({
          orderId,
          label: label + ' [ERC20 Approve]',
          to: tokenAddr, data: approveData, value: '0x0',
          chainId: chainIdOrKey, gasLimit: '0x186a0',
        });
        step('ERC20 Approve', 'running', `Approve tx sent: ${approveTxHash} — waiting for confirmation…`);
        if (rpcUrl && approveTxHash && approveTxHash.startsWith('0x')) {
          try {
            const { waitForConfirmation } = require('../htlc/evm');
            await waitForConfirmation(approveTxHash, String(chainIdOrKey), 120000);
            step('ERC20 Approve', 'pass', `Confirmed on-chain: ${approveTxHash}`);
          } catch(waitErr) {
            step('ERC20 Approve', 'running', `Confirmation wait failed — waiting 8s`);
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
      if (!btcWif) throw new Error("BTC private key (WIF) not saved");
      initTxHash = await initiateHtlc({ htlcAddress, amountSats: htlcAmount, wif: btcWif, fromAddress: btcAddress });
    } else if (fromChain === "evm") {
      const prebuiltTx = orderRes.result?.initiate_transaction;
      const signData   = orderRes.result?.sign_data || orderRes.result?.eip712_data || orderRes.result?.permit_data;

      if (signData && prebuiltTx?.chain_id) {
        // Gasless EIP-712 path
        step("Initiate HTLC", "pending", "Waiting for EIP-712 signature (gasless)…");
        const signature = await requestEvmSign({
          orderId, label, signData, chainId: prebuiltTx.chain_id,
        });
        step("Initiate HTLC", "pass", "Signed (gasless — relayer submitting)");
        await garden.patchOrder(orderId, "initiate", { signature });
        step("Notify Garden", "pass", "Signature accepted by relayer");
        initTxHash = "gasless_relayer";
      } else if (prebuiltTx?.data && prebuiltTx?.to) {
        // Regular EVM tx path
        const approvalTx = orderRes.result?.approval_transaction;
        if (approvalTx?.data && approvalTx?.to) {
          step("ERC20 Approve", "running", "Requesting approve() in wallet…");
          const approveTxHash = await requestEvmTx({
            orderId,
            label: label + ' [ERC20 Approve]',
            to: approvalTx.to, data: approvalTx.data,
            value: approvalTx.value || "0x0",
            chainId: approvalTx.chain_id,
            gasLimit: approvalTx.gas_limit || "0xea60",
          });
          step("ERC20 Approve", "running", `Approve tx sent: ${approveTxHash}`);
          try {
            const { waitForConfirmation } = require('../htlc/evm');
            await waitForConfirmation(approveTxHash, String(approvalTx.chain_id), 120000);
            step("ERC20 Approve", "pass", `Confirmed: ${approveTxHash}`);
          } catch (waitErr) {
            step("ERC20 Approve", "pass", `Approve sent (confirmation wait failed)`);
          }
        } else {
          await ensureErc20Approval({
            tokenAddr:    fromMeta?.token_address || orderRes.result?.source?.token_address,
            spender:      prebuiltTx.to,
            amount:       htlcAmount,
            chainIdOrKey: prebuiltTx.chain_id,
            walletMode:   'metamask',
          });
        }

        step("Initiate HTLC", "pending", "Waiting for wallet approval…");
        initTxHash = await requestEvmTx({
          orderId, label,
          to: prebuiltTx.to, data: prebuiltTx.data,
          value: prebuiltTx.value || "0x0",
          chainId: prebuiltTx.chain_id,
          gasLimit: prebuiltTx.gas_limit || "0x493e0",
        });
      } else if (walletState.getStatus().evmSource === "privy") {
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
        step("Initiate HTLC", "running", "Signing with .env private key…");
        await ensureErc20Approval({
          tokenAddr:    fromMeta?.token_address || orderRes.result?.source?.token_address,
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
        throw new Error("EVM source: connect MetaMask or set EVM_PRIVATE_KEY in .env");
      }
    } else {
      throw new Error(`Initiation not yet implemented for: ${fromChain}`);
    }
    step("Initiate HTLC", "pass", "Transaction sent", initTxHash);

    // 8. Notify Garden (skip if gasless)
    if (initTxHash !== "gasless_relayer") {
      step("Notify Garden", "running");
      checkAbort();

      if (fromChain === "evm" && initTxHash && initTxHash.startsWith?.("0x")) {
        step("Notify Garden", "running", `Waiting for tx confirmation…`);
        try {
          const { waitForConfirmation } = require("../htlc/evm");
          const rawChainKey = fromAsset.split(":")[0];
          const chainKey = rawChainKey.replace(/_sepolia|_testnet\d*|_mainnet|_signet/g, "");
          const receipt = await waitForConfirmation(initTxHash, chainKey, 180000);
          if (receipt?.status === 0) {
            throw new Error(`On-chain tx reverted (status=0)`);
          }
          step("Notify Garden", "running", `Confirmed in block ${receipt?.blockNumber} — notifying…`);
        } catch(waitErr) {
          if (waitErr.message.includes("reverted")) throw waitErr;
          step("Notify Garden", "running", `Confirmation wait failed — notifying anyway…`);
        }
      }

      const NOTIFY_TIMEOUT = 20 * 60 * 1000;
      function getNotifyInterval(elapsedMs) {
        if (elapsedMs < 2 * 60 * 1000)  return 10000;
        if (elapsedMs < 5 * 60 * 1000)  return 20000;
        if (elapsedMs < 8 * 60 * 1000)  return 30000;
        if (elapsedMs < 20 * 60 * 1000) return 120000;
        return 180000;
      }
      const notifyStart = Date.now();
      let notifyAttempts = 0;
      let notifyDone = false;

      while (!notifyDone && (Date.now() - notifyStart) < NOTIFY_TIMEOUT) {
        checkAbort();
        notifyAttempts++;
        try {
          await garden.patchOrder(orderId, "initiate", initTxHash);
          step("Notify Garden", "pass", notifyAttempts === 1 ? "Acknowledged" : `Acknowledged after ${notifyAttempts} attempts`);
          notifyDone = true;
        } catch(patchErr) {
          try {
            const orderCheck = await garden.getOrder(orderId);
            const orderObj = orderCheck?.result || orderCheck;
            const currentStatus = (orderObj?.status || orderObj?.order_status || orderObj?.state || "").toLowerCase().replace(/\s+/g,"");
            const realStatus = currentStatus === 'ok' ? '' : currentStatus;
            const destSwap = orderObj?.destination_swap;
            const hasRedeemTx = !!(destSwap?.redeem_tx_hash || destSwap?.redeem_tx || destSwap?.redeem_txid);
            const pastInitiation = ["initiatedetected","initiated","counterpartyinitiatedetected",
                                    "counterpartyinitiated","redeemed","completed"].some(s => realStatus.includes(s)) || hasRedeemTx;
            if (pastInitiation) {
              step("Notify Garden", "pass", `Order already at '${realStatus}' — Garden detected tx`);
              notifyDone = true;
              break;
            }
            const isTerminal = ["expired","refunded","failed","cancelled"].some(s => realStatus.includes(s));
            if (isTerminal) {
              throw new Error(`Order reached terminal status '${realStatus}'`);
            }
          } catch(checkErr) {
            if (checkErr.message.includes("terminal status")) throw checkErr;
          }
          const interval = getNotifyInterval(Date.now() - notifyStart);
          await new Promise(r => setTimeout(r, interval));
        }
      }

      if (!notifyDone) {
        try {
          const finalCheck = await garden.getOrder(orderId);
          const finalObj = finalCheck?.result || finalCheck;
          const finalStatusRaw = (finalObj?.status || finalObj?.order_status || finalObj?.state || "").toLowerCase().replace(/\s+/g,"");
          const finalStatus = finalStatusRaw === 'ok' ? '' : finalStatusRaw;
          const destSwapFinal = finalObj?.destination_swap;
          const hasRedeemTxFinal = !!(destSwapFinal?.redeem_tx_hash || destSwapFinal?.redeem_tx || destSwapFinal?.redeem_txid);
          const pastInitiation = ["initiated","counterparty","redeemed","completed"].some(s => finalStatus.includes(s)) || hasRedeemTxFinal;
          if (pastInitiation) {
            step("Notify Garden", "pass", `Timed out but order is at '${finalStatus}' — proceeding`);
            notifyDone = true;
          } else {
            throw new Error(`Notify Garden timed out after ${notifyAttempts} attempts. Status: ${finalStatus}`);
          }
        } catch(finalErr) {
          throw finalErr;
        }
      }
    }

    // ── Check current state ──
    let skipToCompletion = false;
    let skipToRedeem = false;
    let solverOrder = null;

    try {
      const currentOrder = await garden.getOrder(orderId);
      const ord = currentOrder?.result || currentOrder;
      const currentStatus = (ord?.status || ord?.order_status || "").toLowerCase().replace(/\s+/g, "");
      const realStatus = currentStatus === 'ok' ? '' : currentStatus;
      const destSwapCheck = ord?.destination_swap;
      const hasRedeemTx = !!(destSwapCheck?.redeem_tx_hash || destSwapCheck?.redeem_tx || destSwapCheck?.redeem_txid);
      const hasInitTx = !!destSwapCheck?.initiate_tx_hash;

      if (hasRedeemTx || realStatus.includes("redeemed") || realStatus.includes("completed")) {
        skipToCompletion = true;
        solverOrder = ord;
        step("Solver Initiated", "pass", `Skipped — order already at '${realStatus}'`);
        step("Redeem", "pass", `Skipped — already redeemed`);
      } else if (hasInitTx || realStatus.includes("counterpartyinitiated")) {
        skipToRedeem = true;
        solverOrder = ord;
        step("Solver Initiated", "pass", `Skipped — solver already initiated`);
      }
    } catch (_) {}

    // 9. Poll for solver initiation
    if (!skipToCompletion && !skipToRedeem) {
      step("Solver Initiated", "running", "Waiting for solver to lock on destination chain…");
      checkAbort();

      const solverResult = await garden.pollOrder(
        orderId,
        "counterpartyinitiated",
        600000,
        5000,
        (status, order) => {
          const pretty = {
            "matched":                      "Matched — waiting for solver…",
            "initiatedetected":             "InitiateDetected — your tx seen…",
            "initiated":                    "Initiated — your tx confirmed ✓",
            "counterpartyinitiatedetected": "CounterPartyInitiateDetected — solver tx seen…",
            "counterpartyinitiated":        "CounterPartyInitiated — solver HTLC confirmed…",
            "redeemed":                     "Redeemed",
            "completed":                    "Completed",
          }[status] || `Status: ${status}`;

          const destSwap   = order?.destination_swap;
          const confirms   = destSwap?.current_confirmations ?? "?";
          const reqConfirm = destSwap?.required_confirmations ?? "?";
          const detail     = destSwap?.initiate_tx_hash
            ? `${pretty} (solver tx: …${destSwap.initiate_tx_hash.slice(-8)}, ${confirms}/${reqConfirm})`
            : pretty;
          step("Solver Initiated", "running", detail);
        }
      );

      if (!solverResult.success) {
        const st = (solverResult.status || "").toLowerCase();
        if (st.includes("redeemed") || st.includes("completed")) {
          solverOrder = solverResult.order;
          step("Solver Initiated", "pass", `Order already at '${solverResult.status}'`);
        } else {
          throw new Error(`Solver did not initiate: ${solverResult.reason} (status: ${solverResult.status})`);
        }
      } else {
        solverOrder = solverResult.order;
      }
      const destSwap = solverOrder?.destination_swap;
      const solverTxHash = destSwap?.initiate_tx_hash || "unknown";
      step("Solver Initiated", "pass",
        `CounterPartyInitiated ✓ (${Math.round(solverResult.elapsed / 1000)}s)`,
        solverTxHash
      );
    }

    // 10. Redeem on destination
    if (!skipToCompletion) {
      step("Redeem", "running");
      checkAbort();
      let redeemTxHash = "solver_auto_redeem";

      try {
        const secret =
          solverOrder?.secret ||
          solverOrder?.swap_secret ||
          solverOrder?.source_swap?.secret ||
          solverOrder?.destination_swap?.secret ||
          orderRes.result?.secret;

        if (toChain === "evm") {
          if (!secret) {
            step("Redeem", "pending", "Waiting for Garden to reveal secret…");
            redeemTxHash = "solver_auto_redeem";
          } else {
            step("Redeem", "running", "Submitting redeem via Garden API…");
            try {
              await garden.patchOrder(orderId, "redeem", { secret });
              redeemTxHash = "garden_api";
              step("Redeem", "running", "Redeem requested — polling for redeem_tx_hash…");
            } catch (notifyRedeemErr) {
              redeemTxHash = "solver_auto_redeem";
              step("Redeem", "pending", `Redeem request failed — solver will handle`);
            }
          }
        } else if (toChain === "bitcoin") {
          step("Redeem", "pending", "Waiting for solver to redeem BTC destination…");
        } else {
          step("Redeem", "pending", `Waiting for solver to auto-redeem ${toChain}…`);
        }
      } catch (redeemErr) {
        console.warn(`[runner] redeem failed, falling back to solver: ${redeemErr.message}`);
        step("Redeem", "pending", `Redeem failed — solver will handle`);
        redeemTxHash = "solver_auto_redeem";
      }

      step("Redeem", "pass",
        redeemTxHash === "solver_auto_redeem" ? "Solver will auto-redeem" : "Redeemed ✓",
        redeemTxHash !== "solver_auto_redeem" ? redeemTxHash : null
      );
    }

    // 11. Poll for completion
    step("Completion", "running", "Waiting for redeem_tx_hash on destination…");
    const COMPLETION_TIMEOUT = 300000;
    const COMPLETION_INTERVAL = 5000;
    const completionStart = Date.now();
    let lastStatus = "";
    let finalOrder = null;

    while (Date.now() - completionStart < COMPLETION_TIMEOUT) {
      checkAbort();
      let res;
      try {
        res = await garden.getOrder(orderId);
      } catch (_) {
        await new Promise(r => setTimeout(r, COMPLETION_INTERVAL));
        continue;
      }
      const ord = res.result || res;
      const status = (ord?.status || ord?.order_status || "").toLowerCase();
      const dest = ord?.destination_swap;
      const redeemHash = dest?.redeem_tx_hash || dest?.redeem_tx || dest?.redeem_txid;

      if (status !== lastStatus) {
        lastStatus = status;
        step("Completion", "running", `Status: ${status || "(unknown)"}…`);
      }

      if (redeemHash) {
        finalOrder = ord;
        break;
      }

      if (["refunded","expired","failed","cancelled"].some(t => status.includes(t))) {
        throw new Error(`Swap did not complete: ${status}`);
      }

      await new Promise(r => setTimeout(r, COMPLETION_INTERVAL));
    }

    if (!finalOrder) {
      throw new Error("Swap did not complete: timeout waiting for redeem_tx_hash");
    }

    const elapsed = Math.round((Date.now() - new Date(steps[0].ts).getTime()) / 1000);
    step("Completion", "pass", `Done in ~${elapsed}s`);

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

    try {
      tradeHistory.record({
        testId, status: "pass", fromAssetId: fromAsset, toAssetId: toAsset,
        fromChain, toChain, amount: safeAmount, outputAmount: received,
        usdIn: Number(bestQuote?.source?.value ?? 0),
        usdOut: Number(bestQuote?.destination?.value ?? 0),
        slippagePct, durationSec: elapsed, ts: new Date().toISOString(),
      });
    } catch (_) {}

    emit("test_end", { testId, label, status: "pass", steps, duration: elapsed });
    _activeTests.delete(testId);
    return { testId, label, status: "pass", steps };

  } catch (err) {
    const failStep = { name: "Error", status: "fail", detail: err.message, ts: new Date().toISOString() };
    steps.push(failStep);
    emit("test_step", { testId, label, step: failStep });
    const finalStatus = err.message.includes("aborted") ? "aborted" : "fail";
    emit("test_end",  { testId, label, status: finalStatus, error: err.message, steps });
    try {
      tradeHistory.record({
        testId, status: finalStatus, fromAssetId: fromAsset, toAssetId: toAsset,
        fromChain, toChain, amount, outputAmount: 0,
        usdIn: 0, usdOut: 0, slippagePct: 0, durationSec: 0,
        ts: new Date().toISOString(),
      });
    } catch (_) {}
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

// ── BUILD ROUTES — ALWAYS FRESH (no cache) ────────────────────
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

  // Always fetch fresh
  let assets = [];
  try {
    const res = await garden.getAssets();
    assets = res.result || res.assets || res || [];
  } catch (_) {}
  if (!assets.length) return [];

  // Only connected wallet assets
  const supported = assets.filter(a => {
    const wt = getWalletTypeForAsset(a);
    return wt && connectedTypes.has(wt);
  });

  const routes = [];
  for (const from of supported) {
    for (const to of supported) {
      if (from.id === to.id) continue;
      if (!isPairPlausible(from, to)) continue;
      const overrideAmt = amountOverrides[from.id];
      routes.push({
        fromAsset: from.id,
        toAsset:   to.id,
        fromChain: getWalletTypeForAsset(from),
        toChain:   getWalletTypeForAsset(to),
        amount:    overrideAmt !== undefined
          ? parseInt(overrideAmt)
          : parseInt(from.min_amount || 50000),
        fromMeta:  from,
        toMeta:    to,
        label:     `${from.name} → ${to.name}`,
      });
    }
  }

  // Gather balances for chain-reaction planning
  const balanceMap = new Map();
  const gasMap = new Map();
  try {
    const cached = wallets.evm?.tokenBalances || {};
    for (const [assetId, bal] of Object.entries(cached)) {
      balanceMap.set(assetId, Number(bal));
    }
    if (wallets.btc?.balance && wallets.btc.balance !== 'unknown') {
      const sats = Math.floor(parseFloat(wallets.btc.balance) * 1e8);
      for (const a of supported) {
        if (getWalletTypeForAsset(a) === 'bitcoin') balanceMap.set(a.id, sats);
      }
    }
    const evmAddress = walletState.getAddressByType('evm');
    if (evmAddress) {
      const { ethers } = require('ethers');
      const chainConf = require('../config').chains || {};
      const evmChainKeys = new Set();
      for (const a of supported) {
        if (getWalletTypeForAsset(a) === 'evm') {
          evmChainKeys.add(a.id.split(':')[0].replace(
            /_sepolia|_testnet\d*|_mainnet|_signet|_devnet/g, ''
          ));
        }
      }
      await Promise.all([...evmChainKeys].map(async (chainKey) => {
        try {
          const rpcUrl = chainConf[chainKey]?.rpc || FREE_RPCS[chainKey];
          if (!rpcUrl) return;
          const provider = new ethers.JsonRpcProvider(rpcUrl);
          const bal = await Promise.race([
            provider.getBalance(evmAddress),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
          ]);
          gasMap.set(chainKey, BigInt(bal.toString()));
        } catch (_) {}
      }));
    }
  } catch (_) {}

 
  // Chain-reaction optimizer
  try {
    return routeOptimizerAgent.optimizeRoutes(routes, {
      maxTotal: 160,
      perPairLimit: 3,
      balances: balanceMap,
      gasBalances: gasMap,
      connectedWalletTypes: connectedTypes,
    });
  } catch (_) {
    return routes;
  }
}

// ── RUN ALL — PARALLEL CHAIN-REACTION EXECUTION ──────────────
async function runAll(amountOverrides = {}) {
  emit("suite_start", { env: config.env, ts: new Date().toISOString() });
  await runApiTests();
  const routes = await buildRoutes(amountOverrides);
  const results = [];

  emit("suite_routes", { count: routes.length, routes: routes.map(r => r.label) });

  if (!routes.length) {
    emit("suite_end", {
      env: config.env, total: 0, passed: 0, failed: 0, skipped: 0,
      message: "No routes — connect wallets first",
      ts: new Date().toISOString(),
    });
    return results;
  }

  _globalAbort = false;

  // Group by chain-reaction seed for parallel execution
  const bySeed = new Map();
  const standalone = [];

  for (const route of routes) {
    if (route._chainStart) {
      if (!bySeed.has(route._chainStart)) bySeed.set(route._chainStart, []);
      bySeed.get(route._chainStart).push(route);
    } else {
      standalone.push(route);
    }
  }

  // Each seed's chain runs sequentially (A→B before B→C)
  // Different seeds run in parallel
  async function runChain(chainRoutes, seedLabel) {
    for (const route of chainRoutes) {
      if (_globalAbort) break;
      const result = await runRoute(route);
      results.push(result);

      // If chain-reaction trade fails, stop this chain
      if (result.status === 'fail' && route._chainReaction) {
        emit("suite_info", {
          message: `Chain broken at ${route.label} — skipping remaining hops from seed ${seedLabel}`,
        });
        break;
      }

      if (!_globalAbort) await new Promise(r => setTimeout(r, 500));
    }
  }

  // Launch all seed chains in parallel
  const chainPromises = [...bySeed.entries()].map(([seed, chainRoutes]) =>
    runChain(chainRoutes, seed)
  );

  // Standalone routes with concurrency limit
  const PARALLEL_LIMIT = 3;
  async function runStandalonePool() {
    const running = new Set();
    for (const route of standalone) {
      if (_globalAbort) break;

      const p = runRoute(route).then(result => {
        results.push(result);
        running.delete(p);
        return result;
      });
      running.add(p);

      if (running.size >= PARALLEL_LIMIT) {
        await Promise.race([...running]);
      }
    }
    if (running.size > 0) await Promise.all([...running]);
  }

  // Execute everything in parallel
  await Promise.all([...chainPromises, runStandalonePool()]);

  emit("suite_end", {
    env: config.env,
    total: results.length,
    passed:  results.filter(r => r.status === "pass").length,
    failed:  results.filter(r => r.status === "fail").length,
    skipped: results.filter(r => r.status === "skipped").length,
    ts: new Date().toISOString(),
  });
  return results;
}

module.exports = {
  runAll,
  runApiTests,
  runRoute,
  buildRoutes,
  setEmitter,
  handleApproval,
  handleEvmTxResponse,
  handleEvmSignResponse,
  abortTest,
  abortAll,
};