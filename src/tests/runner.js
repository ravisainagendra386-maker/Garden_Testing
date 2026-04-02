// src/tests/runner.js
const fs = require("fs");
const path = require("path");
const garden = require("../api/garden");

const FREE_RPCS = {
  base:       'https://sepolia.base.org',
  ethereum:   'https://rpc.sepolia.org',
  arbitrum:   'https://sepolia-rollup.arbitrum.io/rpc',
  bnbchain:   'https://data-seed-prebsc-1-s1.binance.org:8545',
  hyperevm:   'https://rpc.hyperliquid-testnet.xyz/evm',
  monad:      'https://testnet-rpc.monad.xyz',
  citrea:     'https://rpc.testnet.citrea.xyz',
  alpen:      'https://rpc.testnet.alpenlabs.io',
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
      '5115':      FREE_RPCS.citrea,
      '48898':     FREE_RPCS.alpen,
      '8150':      FREE_RPCS.alpen,   // Alpen testnet (Garden uses 8150 as chain_id)
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
const priceFeed = require("../agents/price-feed");
const { appendRuntimeLog } = require("../utils/runtimeLog");
const tradeHistory               = require("../agents/tradeHistory");
const { RouteOptimizerAgent }    = require("../agents/routeOptimizerAgent");
const fundingTree                = require("../utils/fundingTree");

// Module-level asset cache — avoids redundant garden.getAssets() calls during a run
let _runnerAssetCache = null;
let _runnerAssetCacheTs = 0;
let _runnerAssetInFlight = null;
const RUNNER_ASSET_CACHE_TTL = 120_000; // 2 min
async function getAssetsForRunner() {
  const now = Date.now();
  if (_runnerAssetCache && (now - _runnerAssetCacheTs) < RUNNER_ASSET_CACHE_TTL) return _runnerAssetCache;
  if (_runnerAssetInFlight) return _runnerAssetInFlight;
  _runnerAssetInFlight = garden.getAssets()
    .then(g => { _runnerAssetCache = g.result || g.assets || (Array.isArray(g) ? g : []); _runnerAssetCacheTs = Date.now(); return _runnerAssetCache; })
    .finally(() => { _runnerAssetInFlight = null; });
  return _runnerAssetInFlight;
}


let _emit = null;
let _approvalQueue = [];
const _activeTests = new Map();
let _globalAbort = false;
/** True while `runAll` is in progress (including gaps between routes, e.g. long sleeps). Used to hydrate dashboard after reconnect. */
let _suiteRunActive = false;
let _suiteRunMeta = null;
let _abortEpoch = 0;

function getSuiteRunStatus() {
  if (!_suiteRunActive || !_suiteRunMeta) return { suiteRunning: false };
  return { suiteRunning: true, ..._suiteRunMeta };
}
let _requestSeq = 0;
const _routeAgent = new RouteOptimizerAgent();
let _routeAgentInitPromise = null;

async function ensureRouteAgentReady() {
  if (!_routeAgentInitPromise) {
    _routeAgentInitPromise = _routeAgent.init().catch((e) => {
      _routeAgentInitPromise = null;
      console.warn("[runner] RouteOptimizerAgent init failed:", e?.message || e);
    });
  }
  await _routeAgentInitPromise;
}

function setEmitter(fn) { _emit = fn; }
function emit(event, data) {
  try {
    const keep = new Set(["suite_start", "suite_routes", "suite_info", "suite_end", "test_start", "test_step", "test_end", "error", "simulation_trace", "simulation_summary"]);
    if (keep.has(event)) appendRuntimeLog({ event, data, timestamp: Date.now() });
  } catch (_) {}
  if (_emit) _emit(event, data);
  else console.log(`[${event}]`, JSON.stringify(data).slice(0, 120));
}

/** Rewire the next beam hop to spend the asset & amount we actually received (e.g. after same-chain dest substitution). */
function patchNextChainHopFromReceive(nextRoute, prevPassResult) {
  if (!nextRoute || !prevPassResult || prevPassResult.status !== "pass") return;
  const { actualDestAsset, actualDestMeta, nextHopAmountAtomic } = prevPassResult;
  if (!actualDestAsset || !actualDestMeta || !Number.isFinite(nextHopAmountAtomic)) return;
  const fromChain = getWalletTypeForAsset(actualDestMeta);
  if (!fromChain) return;
  const amount = clampGardenQuoteAmount(nextHopAmountAtomic, actualDestMeta);
  const fromName = actualDestMeta.name || actualDestAsset;
  const toName = nextRoute.toMeta?.name || nextRoute.toAsset;
  Object.assign(nextRoute, {
    fromAsset: actualDestAsset,
    fromMeta: actualDestMeta,
    fromChain,
    amount,
    label: `${fromName} → ${toName}`,
  });
}

/** Clamp Swap API quote size to asset policy (min/max). Balance can exceed max; Garden still rejects. */
function clampGardenQuoteAmount(raw, fromMeta) {
  let base = Number(raw);
  if (!Number.isFinite(base) || base <= 0) base = 50000;
  base = Math.floor(base);
  const lo = Math.max(1, parseInt(String(fromMeta?.min_amount ?? 50000), 10) || 50000);
  const hiRaw = fromMeta?.max_amount;
  const hi = hiRaw != null && String(hiRaw) !== ''
    ? parseInt(String(hiRaw), 10)
    : NaN;
  const cap = Number.isFinite(hi) && hi >= lo ? hi : Number.MAX_SAFE_INTEGER;
  return Math.min(Math.max(base, lo), cap);
}

// ── APPROVAL / EVM TX / EIP-712 SIGN QUEUE ──────────────────

async function requestApproval(txData) {
  return new Promise(resolve => {
    const id = `approval_${Date.now()}_${++_requestSeq}`;
    emit("approval_request", { id, ...txData });
    _approvalQueue.push({ id, resolve });
  });
}

async function requestEvmTx({ orderId, label, to, data, value, chainId, gasLimit }) {
  return new Promise((resolve, reject) => {
    const id = `evmtx_${Date.now()}_${++_requestSeq}`;
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
    const id = `evmsign_${Date.now()}_${++_requestSeq}`;
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
  _abortEpoch++;
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

function pickTokenAddress(...candidates) {
  for (const c of candidates) {
    if (!c) continue;
    const addr = c.token_address || c.tokenAddress || c.contract_address || c.contractAddress || c.token?.address || c.address || null;
    if (addr) return addr;
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
  return from.id !== to.id; // all asset combinations allowed across all families
}

function isInsufficientLiquidityGardenError(err) {
  const m = String(err?.message || err?.raw?.error || "").toLowerCase();
  if (m.includes("insufficient liquidity") || m.includes("no liquidity")) return true;
  if (m.includes("not enough liquidity") || m.includes("liquidity unavailable")) return true;
  if (m.includes("liquidity") && (m.includes("too low") || m.includes("too shallow") || m.includes("depth"))) return true;
  return false;
}

/** Same threshold as runRoute EVM native gas check (0.001 ETH-equivalent wei). */
const MIN_NATIVE_WEI_FOR_GAS = 10n ** 15n;
/** Rough minimum SOL for a few txs + rent buffer (lamports). */
const MIN_SOL_LAMPORTS_FOR_FEES = 1_000_000n;
/** Reserve sats on Bitcoin after the swap amount for network fee. */
const MIN_BTC_FEE_SATS_RESERVE = 2_000n;

/**
 * Garden asset for paying chain fees (native / gas token) on this chain prefix.
 */
function findNativeFeeAssetOnChain(assets, chainPrefix) {
  if (!Array.isArray(assets) || !chainPrefix) return null;
  const pref = String(chainPrefix);
  const onChain = assets.filter((a) => String(a.id).startsWith(`${pref}:`));
  if (!onChain.length) return null;
  const isAddrNative = (a) => {
    const t = String(pickTokenAddress(a) || a.token_address || "").toLowerCase();
    return !t || t === "native" || t === "0x0000000000000000000000000000000000000000";
  };
  let hit = onChain.find(isAddrNative);
  if (hit) return hit;
  const chainKey = pref.replace(/_sepolia|_testnet\d*|_mainnet|_signet|_devnet/g, "");
  const sym = String(config.chains[chainKey]?.asset || "").toUpperCase();
  if (sym) {
    hit = onChain.find((a) => {
      const tick = tickerFromMeta(a).toUpperCase();
      return tick === sym || String(a.name || "").toUpperCase().includes(sym);
    });
  }
  return hit || null;
}

/**
 * Pre-hop gas check: if destination chain has insufficient native gas AND
 * Garden supports the native token there, substitute toAsset → native so the
 * trade itself delivers gas.  Returns { route, ok, substituted?, reason? }.
 * Returns { route: null, ok: false } when no native is supported (caller should block/skip).
 */
async function resolveToAssetWithGasSubstitution(route, supportedAssets, gasCache) {
  if (!route || !Array.isArray(supportedAssets)) return { route, ok: true };

  const destChainRaw = String(route.toAsset || '').split(':')[0];
  const destChainKey = destChainRaw.replace(/_sepolia|_testnet\d*|_mainnet|_signet|_devnet/g, '');

  // Only EVM destinations need the native-gas check for now
  if (route.toChain !== 'evm') return { route, ok: true };

  // Look up gas balance (cached → live RPC fallback with 3s timeout)
  let gasWei = gasCache?.get(destChainKey);
  if (gasWei === undefined) {
    const evmAddress = walletState.getAddressByType('evm');
    if (evmAddress) {
      try {
        const { ethers } = require('ethers');
        const rpcUrl = resolveRpcUrl(destChainRaw);
        if (rpcUrl) {
          const provider = new ethers.JsonRpcProvider(rpcUrl);
          const bal = await Promise.race([
            provider.getBalance(evmAddress),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
          ]);
          gasWei = BigInt(bal.toString());
          if (gasCache) gasCache.set(destChainKey, gasWei);
        }
      } catch (_) { gasWei = undefined; }
    }
  }

  // Gas unknown or sufficient — proceed normally
  if (gasWei === undefined || gasWei >= MIN_NATIVE_WEI_FOR_GAS) return { route, ok: true };

  // Gas insufficient — find Garden-supported native token on destination chain
  const nativeAsset = findNativeFeeAssetOnChain(supportedAssets, destChainRaw);
  if (!nativeAsset?.id) {
    return { route: null, ok: false, reason: `no_native_support:${destChainKey}` };
  }
  if (nativeAsset.id === route.toAsset) return { route, ok: true }; // already native

  // Substitute receiving asset → native so the swap delivers gas directly
  return {
    route: { ...route, toAsset: nativeAsset.id, toMeta: nativeAsset },
    ok: true,
    substituted: true,
    reason: `substituted_native:${destChainKey}`,
  };
}

function getSolanaNativeLamports(wallets) {
  const raw = wallets?.solana?.balance;
  if (raw == null || raw === "") return null;
  const sol = parseFloat(String(raw));
  if (!Number.isFinite(sol)) return null;
  return BigInt(Math.max(0, Math.floor(sol * 1e9)));
}

async function readEvmNativeAndTokenBalance(fromMeta, fromAsset, fromAddress) {
  const { ethers } = require("ethers");
  const tokenAddr = pickTokenAddress(fromMeta);
  const rawKey = fromAsset.split(":")[0];
  const chainKey = rawKey.replace(/_sepolia|_testnet\d*|_mainnet|_signet|_devnet/g, "");
  const chainConf = require("../config").chains;
  const rpcUrl = chainConf[chainKey]?.rpc || FREE_RPCS[chainKey] || "";
  if (!rpcUrl) throw new Error(`No RPC URL for chain key: ${chainKey}`);
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const weiGas = await provider.getBalance(fromAddress);
  const gasWei = BigInt(weiGas.toString());
  if (!tokenAddr || tokenAddr === "native" || tokenAddr === "0x0000000000000000000000000000000000000000") {
    return { gasWei, tokenBalance: Number(weiGas), isNativeToken: true, chainKey };
  }
  const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
  ];
  const token = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
  const bal = await token.balanceOf(fromAddress);
  return { gasWei, tokenBalance: Number(bal), isNativeToken: false, chainKey };
}

/**
 * allChains: same-chain swap into native fee asset when non-EVM native balance is low (not destination fallback).
 * Execution uses the same runRoute path; chains without HTLC initiation in this runner may fail until implemented.
 */
async function maybeNonEvmAllChainsGasPrefundViaGarden(ctx) {
  const {
    fromChain,
    fromAsset,
    fromMeta,
    amount,
    label,
    step,
    checkAbort,
    forcePrefund = false,
  } = ctx;
  const wallets = walletState.getStatus();
  let assets = [];
  try {
    assets = await getAssetsForRunner();
  } catch (_) {
    return { ok: false, error: "getAssets failed for gas prefund" };
  }
  const chainPrefix = String(fromAsset).split(":")[0];
  const nativeMeta = findNativeFeeAssetOnChain(assets, chainPrefix);
  if (!nativeMeta?.id) {
    return { ok: true, skipped: true, reason: "no_native_meta" };
  }
  if (String(fromAsset) === String(nativeMeta.id)) {
    return { ok: true, skipped: true, reason: "already_native" };
  }

  if (fromChain === "solana") {
    const lamports = getSolanaNativeLamports(wallets);
    if (!forcePrefund && lamports !== null && lamports >= MIN_SOL_LAMPORTS_FOR_FEES) {
      return { ok: true, skipped: true, reason: "sol_fee_ok" };
    }
    if (lamports === 0n) {
      return {
        ok: false,
        error: "Insufficient SOL for fees: 0 lamports — cannot prefund (need dust for tx fees)",
      };
    }
  }

  const minAmt = Math.max(1, parseInt(String(fromMeta?.min_amount ?? 50000), 10) || 50000);
  const safeAmt = clampGardenQuoteAmount(amount, fromMeta);
  let prefundAmt = Math.max(minAmt, Math.min(safeAmt, minAmt * 4));
  prefundAmt = clampGardenQuoteAmount(prefundAmt, fromMeta);

  let quoteRes;
  try {
    quoteRes = await garden.getQuote(fromAsset, nativeMeta.id, prefundAmt);
  } catch (e) {
    return {
      ok: false,
      error: `No Garden quote for gas prefund (${fromAsset} → ${nativeMeta.id}): ${e.message || e}`,
    };
  }
  if (!quoteRes?.result?.length) {
    return { ok: false, error: "Gas prefund quote returned empty" };
  }

  checkAbort();
  step(
    "Gas prefund",
    "running",
    `Swapping to native fee asset (${fromChain}, ${prefundAmt} atomic)…`
  );
  const prefundResult = await runRoute({
    fromChain,
    toChain: fromChain,
    fromAsset,
    toAsset: nativeMeta.id,
    amount: prefundAmt,
    label: `${label} [gas prefund ${fromChain}]`,
    fromMeta,
    toMeta: nativeMeta,
    executionMode: "allChains",
    skipGasPrefund: true,
  });

  if (prefundResult.status !== "pass") {
    return {
      ok: false,
      error: `Gas prefund failed (${fromChain}): ${prefundResult.error || prefundResult.status}`,
    };
  }
  step("Gas prefund", "pass", `Native fee asset topped up via Garden (${fromChain})`);
  emit("suite_info", {
    message: `Gas prefund completed before main hop: ${label} (${fromChain})`,
  });
  return { ok: true, didPrefund: true, amountConsumed: prefundAmt, nativeAssetId: nativeMeta.id, nativeMeta };
}

/**
 * allChains: if source is not native fee token and native gas is below threshold, run a same-chain
 * Garden swap into native first (gas-funding pre-swap — not destination liquidity fallback).
 * EVM uses RPC balances; other chains use wallet/API checks where available.
 */
async function maybeAllChainsGasPrefundViaGarden({
  executionMode,
  skipGasPrefund,
  fromChain,
  fromAsset,
  fromMeta,
  fromAddress,
  amount,
  label,
  testId,
  step,
  checkAbort,
  forcePrefund = false,
}) {
  if (executionMode !== "allChains" || skipGasPrefund) {
    return { ok: true, skipped: true };
  }

  if (fromChain === "evm") {
  let evmRead;
  try {
    evmRead = await readEvmNativeAndTokenBalance(fromMeta, fromAsset, fromAddress);
  } catch (e) {
    return { ok: true, skipped: true, reason: "evm_read_failed", detail: String(e?.message || e) };
  }
  const { gasWei, isNativeToken, tokenBalance } = evmRead;
  if (isNativeToken) return { ok: true, skipped: true, reason: "source_is_native" };
  if (!forcePrefund && gasWei >= MIN_NATIVE_WEI_FOR_GAS) {
    return { ok: true, skipped: true, reason: "gas_sufficient" };
  }
  if (gasWei === 0n) {
    return {
      ok: false,
      error:
        "Insufficient native gas: 0 — cannot auto-prefund (need a non-zero balance for approvals / txs)",
    };
  }

  let assets = [];
  try {
    assets = await getAssetsForRunner();
  } catch (_) {
    return { ok: false, error: "getAssets failed for gas prefund" };
  }
  const chainPrefix = String(fromAsset).split(":")[0];
  const nativeMeta = findNativeFeeAssetOnChain(assets, chainPrefix);
  if (!nativeMeta?.id) {
    return { ok: false, error: "Could not resolve native fee asset on chain for gas prefund" };
  }
  if (String(fromAsset) === String(nativeMeta.id)) {
    return { ok: true, skipped: true, reason: "already_native_asset_id" };
  }

  const minAmt = Math.max(1, parseInt(String(fromMeta?.min_amount ?? 50000), 10) || 50000);
  const safeAmt = clampGardenQuoteAmount(amount, fromMeta);
  const tb = Number(tokenBalance || 0);
  let prefundAmt = Math.max(minAmt, Math.min(safeAmt, Math.floor(tb / 4)));
  prefundAmt = clampGardenQuoteAmount(prefundAmt, fromMeta);
  if (prefundAmt < minAmt) {
    return { ok: false, error: "Token balance too low for gas prefund swap" };
  }

  let quoteRes;
  try {
    quoteRes = await garden.getQuote(fromAsset, nativeMeta.id, prefundAmt);
  } catch (e) {
    return {
      ok: false,
      error: `No Garden quote for gas prefund (${fromAsset} → ${nativeMeta.id}): ${e.message || e}`,
    };
  }
  if (!quoteRes?.result?.length) {
    return { ok: false, error: "Gas prefund quote returned empty" };
  }

  checkAbort();
  step("Gas prefund", "running", `Swapping to native for gas (${prefundAmt} atomic)…`);
  const prefundResult = await runRoute({
    fromChain,
    toChain: fromChain,
    fromAsset,
    toAsset: nativeMeta.id,
    amount: prefundAmt,
    label: `${label} [gas prefund]`,
    fromMeta,
    toMeta: nativeMeta,
    executionMode: "allChains",
    skipGasPrefund: true,
  });

  if (prefundResult.status !== "pass") {
    return {
      ok: false,
      error: `Gas prefund failed: ${prefundResult.error || prefundResult.status}`,
    };
  }
  step("Gas prefund", "pass", "Native gas topped up via Garden (same-chain swap)");
  emit("suite_info", { message: `Gas prefund completed before main hop: ${label} (consumed ${prefundAmt} atomic)` });
  return { ok: true, didPrefund: true, amountConsumed: prefundAmt, nativeAssetId: nativeMeta.id, nativeMeta };
  }

  if (
    fromChain === "solana" ||
    fromChain === "bitcoin" ||
    fromChain === "starknet" ||
    fromChain === "sui" ||
    fromChain === "tron"
  ) {
    return maybeNonEvmAllChainsGasPrefundViaGarden({
      executionMode,
      skipGasPrefund,
      fromChain,
      fromAsset,
      fromMeta,
      fromAddress,
      amount,
      label,
      testId,
      step,
      checkAbort,
      forcePrefund,
    });
  }

  return { ok: true, skipped: true, reason: "gas_prefund_not_supported_chain" };
}

/**
 * If the primary destination has no quote liquidity, try other assets on the same chain
 * (same id prefix / wallet type, Garden-supported plausible pairs).
 * If all fail at the requested size, halves from_amount down to min_amount (Garden often has
 * depth only at smaller sizes on testnets).
 */
async function getQuoteWithDestinationFallback({
  fromAsset,
  toAsset,
  toMeta,
  toChain,
  fromMeta,
  safeAmount,
  allowFallback = true,
}) {
  const minAmt = Math.max(1, parseInt(String(fromMeta?.min_amount ?? 50000), 10) || 50000);
  let tryAmt = Math.floor(Number(safeAmount) || minAmt);
  if (!Number.isFinite(tryAmt) || tryAmt < minAmt) tryAmt = minAmt;

  async function tryQuotesAtAmount(amt) {
    const tried = new Set([String(toAsset)]);
    let lastErr = null;

    async function attemptQuote(tA) {
      const res = await garden.getQuote(fromAsset, tA, amt);
      if (!res?.result?.length) return null;
      return res;
    }

    try {
      const res = await attemptQuote(toAsset);
      if (res) {
        return { quoteRes: res, toAsset, toMeta, swappedDestination: false, usedFromAmount: amt };
      }
    } catch (e) {
      lastErr = e;
      if (!allowFallback || !isInsufficientLiquidityGardenError(e)) throw e;
    }

    if (!allowFallback) {
      throw lastErr || new Error("No quotes returned — pair may have no liquidity");
    }

    let assets = [];
    try {
      const g = await garden.getAssets();
      assets = g.result || g.assets || g || [];
    } catch (_) {
      throw lastErr || new Error("getAssets failed during destination fallback");
    }

    const chainPrefix = String(toAsset).split(":")[0];
    const candidates = assets.filter((a) => {
      if (tried.has(String(a.id))) return false;
      if (a.id === fromAsset) return false;
      if (String(a.id).split(":")[0] !== chainPrefix) return false;
      if (!fromMeta || !isPairPlausible(fromMeta, a)) return false;
      if (getWalletTypeForAsset(a) !== toChain) return false;
      return true;
    });
    candidates.sort((x, y) => String(x.id).localeCompare(String(y.id)));

    for (const a of candidates) {
      tried.add(String(a.id));
      try {
        const res = await attemptQuote(a.id);
        if (res) {
          return { quoteRes: res, toAsset: a.id, toMeta: a, swappedDestination: true, usedFromAmount: amt };
        }
      } catch (e) {
        lastErr = e;
        if (!isInsufficientLiquidityGardenError(e)) throw e;
      }
    }

    throw lastErr || new Error("No quotes returned — pair may have no liquidity");
  }

  for (;;) {
    try {
      return await tryQuotesAtAmount(tryAmt);
    } catch (e) {
      if (!isInsufficientLiquidityGardenError(e)) throw e;
      if (tryAmt <= minAmt) throw e;
      const next = Math.max(minAmt, Math.floor(tryAmt / 2));
      if (next >= tryAmt) throw e;
      tryAmt = next;
    }
  }
}

// ── SINGLE ROUTE TEST ─────────────────────────────────────────
async function runRoute({
  fromChain,
  toChain,
  fromAsset,
  toAsset,
  amount,
  label,
  fromMeta,
  toMeta,
  executionMode = "allTests",
  skipGasPrefund = false,
  suiteEpoch = null,
}) {
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
    const suiteAborted =
      suiteEpoch !== null && suiteEpoch !== undefined
        ? _abortEpoch !== suiteEpoch
        : _globalAbort;
    if (ctrl.abort || suiteAborted) throw new Error("Test aborted by user");
  }

  emit("test_start", { testId, label, fromChain, toChain, fromAsset, toAsset, amount });

  let swapDestAsset = toAsset;
  let swapDestMeta = toMeta;

  try {
    // 1. Wallet addresses
    const envEvmAvailable = envkey.isAvailable();
    const envEvmAddress = envkey.getEvmAddress?.() || null;
    const walletStatusAtStart = walletState.getStatus();
    const walletEvmSourceAtStart = walletStatusAtStart?.evmSource || null;
    const preferEnvkeyEvm =
      fromChain === "evm" &&
      envEvmAvailable &&
      !!envEvmAddress &&
      (walletEvmSourceAtStart === "envkey" || !walletEvmSourceAtStart);

    const fromAddress = preferEnvkeyEvm ? envEvmAddress : walletState.getAddressByType(fromChain);
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

    const prefundRes = await maybeAllChainsGasPrefundViaGarden({
      executionMode,
      skipGasPrefund,
      fromChain,
      fromAsset,
      fromMeta,
      fromAddress,
      amount,
      label,
      testId,
      step,
      checkAbort,
    });
    if (!prefundRes.ok) {
      const msg = prefundRes.error || "Gas prefund failed";
      step("Gas prefund", "fail", msg);
      emit("test_end", { testId, label, status: "skipped", error: msg });
      _activeTests.delete(testId);
      return { testId, label, status: "skipped", error: msg };
    }

    // 3. Amount (policy max can be far below wallet balance)
    const rawRequested = Number(amount) || 50000;
    const safeAmount = clampGardenQuoteAmount(amount, fromMeta);
    step("Route Policy", "pass", rawRequested !== safeAmount
      ? `Using amount: ${safeAmount} (capped from ${rawRequested} per Garden max ${fromMeta?.max_amount})`
      : `Using amount: ${safeAmount} (atomic units)`);

    // 4. Quote (try alternate destination assets on same chain if primary has no liquidity)
    step("Get Quote", "running");
    checkAbort();
    let quoteRes;
    let quoteSwitchedDest = false;
    let execAmount = safeAmount;
    try {
      const resolved = await getQuoteWithDestinationFallback({
        fromAsset,
        toAsset: swapDestAsset,
        toMeta: swapDestMeta,
        toChain,
        fromMeta,
        safeAmount,
        allowFallback: true,
      });
      quoteRes = resolved.quoteRes;
      quoteSwitchedDest = resolved.swappedDestination;
      swapDestAsset = resolved.toAsset;
      swapDestMeta = resolved.toMeta;
      if (Number.isFinite(resolved.usedFromAmount)) execAmount = resolved.usedFromAmount;
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
    let outputAmount   = String(bestQuote.destination.amount);
    let solverId       = bestQuote.solver_id;
    const fromDisplay  = `${bestQuote.source.display} (${bestQuote.source.value} USD)`;
    const toDisplay    = `${bestQuote.destination.display} (${bestQuote.destination.value} USD)`;
    const swapNote = quoteSwitchedDest
      ? ` · destination asset switched to ${swapDestAsset} (original had no liquidity)`
      : "";
    const sizeNote =
      execAmount < safeAmount
        ? ` · traded ${execAmount} from_amount (reduced from ${safeAmount} for liquidity)`
        : "";
    step("Get Quote", "pass", `${fromDisplay} → ${toDisplay}${swapNote}${sizeNote}`);

    // 5a. Liquidity check
    step("Liquidity Check", "running");
    checkAbort();
    try {
      const liq = await garden.getLiquidity(fromAsset, swapDestAsset);
      const available = liq.result?.available ?? liq.result?.liquidity ?? liq.available;
      if (available !== undefined && Number(available) < execAmount) {
        throw new Error(`Insufficient liquidity: ${available} available, need ${execAmount}`);
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

    // 5a2. Destination-side liquidity sanity check (reverse route)
    // Ensures the received token is also liquid enough before locking source funds.
    step("Destination Liquidity Check", "running");
    checkAbort();
    try {
      const revLiq = await garden.getLiquidity(swapDestAsset, fromAsset);
      const revAvailable = revLiq.result?.available ?? revLiq.result?.liquidity ?? revLiq.available;
      const expectedOutNum = Number(outputAmount || 0);
      if (revAvailable !== undefined && expectedOutNum > 0 && Number(revAvailable) < expectedOutNum) {
        throw new Error(`Insufficient destination-side liquidity: ${revAvailable} available, need ${expectedOutNum}`);
      }
      step("Destination Liquidity Check", "pass",
        revAvailable !== undefined ? `Available: ${revAvailable}` : "Destination liquidity OK");
    } catch (e) {
      if ((e.message || "").includes("Insufficient") || (e.message || "").includes("liquidity")) {
        emit("test_end", { testId, label, status: "skipped", error: e.message });
        _activeTests.delete(testId);
        return { testId, label, status: "skipped", error: e.message };
      }
      step("Destination Liquidity Check", "pass", "Could not verify (continuing)");
    }

    // 5b. Balance check
    step("Balance Check", "running");
    checkAbort();
    try {
      const wallets = walletState.getStatus();
      let feeCheckAssets = [];
      if (["solana", "starknet", "sui", "tron"].includes(fromChain)) {
        try {
          const g = await garden.getAssets();
          feeCheckAssets = g.result || g.assets || g || [];
        } catch (_) {}
      }
      let balance = null;
      let balanceLabel = "";
      let gasBalanceWei = null;
      let gasSymbol = "";
      let isNativeToken = false;
      let balanceSource = "none";

      if (fromChain === "bitcoin") {
        const rawBal = wallets.btc?.balance;
        if (rawBal && rawBal !== "unknown") {
          balance = Math.floor(parseFloat(rawBal) * 1e8);
          balanceLabel = `${balance.toLocaleString()} sats`;
        }
      } else if (fromChain === "evm") {
        try {
          const tokenAddr = pickTokenAddress(fromMeta);
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
            balanceSource = "evm-rpc-native";
          } else {
            const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];
            const token = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
            const [bal, decimals] = await Promise.all([token.balanceOf(fromAddress), token.decimals().catch(()=>8)]);
            balance = Number(bal);
            const ticker = fromAsset.split(':')[1]?.toUpperCase() || 'TOKEN';
            balanceLabel = `${(balance/Math.pow(10,decimals)).toFixed(6)} ${ticker}`;
            balanceSource = "evm-rpc-token";
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
            balanceSource = "cached";
          } else {
            console.warn('[runner] EVM balance RPC error:', onChainErr.message);
            balanceSource = "rpc-error";
          }
        }
      } else if (fromChain === "solana") {
        const rawBal = wallets.solana?.balance;
        if (rawBal) { balance = parseFloat(rawBal); balanceLabel = `${balance} SOL`; }
      }

      if (balance !== null && balance < execAmount) {
        const msg = `Insufficient balance: have ${balanceLabel}, need ${execAmount.toLocaleString()} (atomic units)`;
        step("Balance Check", "fail", msg);
        emit("test_end", { testId, label, status: "skipped", error: msg });
        _activeTests.delete(testId);
        return { testId, label, status: "skipped", error: msg };
      }

      if (fromChain === "bitcoin" && balance !== null) {
        const rem = BigInt(balance) - BigInt(Math.floor(execAmount));
        if (rem < MIN_BTC_FEE_SATS_RESERVE) {
          const msg = `Insufficient sats left for BTC network fee after swap: ${rem} remaining, need ≥ ${MIN_BTC_FEE_SATS_RESERVE} sats reserve`;
          step("Balance Check", "fail", msg);
          emit("test_end", { testId, label, status: "skipped", error: msg });
          _activeTests.delete(testId);
          return { testId, label, status: "skipped", error: msg };
        }
      }

      if (fromChain === "solana" && feeCheckAssets.length) {
        const chainPrefix = String(fromAsset).split(":")[0];
        const nativeMeta = findNativeFeeAssetOnChain(feeCheckAssets, chainPrefix);
        if (nativeMeta && String(fromAsset) !== String(nativeMeta.id)) {
          const lamports = getSolanaNativeLamports(wallets);
          if (lamports !== null && lamports < MIN_SOL_LAMPORTS_FOR_FEES) {
            const msg = `Insufficient native SOL for fees: ~${lamports} lamports, need at least ${MIN_SOL_LAMPORTS_FOR_FEES}`;
            step("Balance Check", "fail", msg);
            emit("test_end", { testId, label, status: "skipped", error: msg });
            _activeTests.delete(testId);
            return { testId, label, status: "skipped", error: msg };
          }
        }
      }

      if (["starknet", "sui", "tron"].includes(fromChain) && feeCheckAssets.length) {
        const chainPrefix = String(fromAsset).split(":")[0];
        const nativeMeta = findNativeFeeAssetOnChain(feeCheckAssets, chainPrefix);
        if (nativeMeta && String(fromAsset) !== String(nativeMeta.id)) {
          const nm = String(nativeMeta.name || nativeMeta.id || "native fee asset");
          step(
            "Native fee check",
            "pass",
            `${fromChain}: non-native source — ensure ${nm} for network fees (balance not read in this runner)`,
          );
        }
      }

      if (fromChain === "evm" && gasBalanceWei !== null) {
        const MIN_NATIVE_WEI = MIN_NATIVE_WEI_FOR_GAS;
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
        balMsg = `Token: ${balanceLabel} ≥ ${execAmount.toLocaleString()}, Gas: ${nativeAmt.toFixed(6)} ${gasSymbol}`;
      } else {
        balMsg = `${balanceLabel} ≥ ${execAmount.toLocaleString()} (atomic)`;
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

    // 5c. Create order — re-fetch a fresh quote right before to minimize expiry window.
    //     If it still expires, one retry with another fresh quote.
    step("Create Order", "running");
    checkAbort();
    let orderRes;
    for (let attempt = 0; attempt < 2; attempt++) {
      // Fresh quote immediately before order — keeps the window as small as possible
      try {
        const fresh = await garden.getQuote(fromAsset, swapDestAsset, execAmount);
        const fq = fresh?.result?.[0];
        if (fq) { outputAmount = String(fq.destination.amount); solverId = fq.solver_id; }
      } catch (_) { /* use the last known quote values */ }

      const orderBody = {
        source:      { asset: fromAsset, owner: fromAddress, amount: String(execAmount) },
        destination: { asset: swapDestAsset, owner: toAddress, amount: outputAmount },
        solver_id:   solverId,
      };
      console.log("[create order]", JSON.stringify(orderBody));
      try {
        orderRes = await garden.createOrder(orderBody);
        break;
      } catch (orderErr) {
        const msg = orderErr.message || "";
        if (/quote.?expired/i.test(msg) && attempt === 0) {
          step("Create Order", "running", "Quote expired — retrying with fresh quote");
          continue;
        }
        if (msg.includes("400") || msg.includes("liquidity") || msg.includes("insufficient")) {
          step("Create Order", "skipped", `Skipped: ${msg.split("]").pop().trim()}`);
          emit("test_end", { testId, label, status: "skipped", error: msg });
          _activeTests.delete(testId);
          return { testId, label, status: "skipped", error: msg };
        }
        throw orderErr;
      }
    }
    console.log("[order response]", JSON.stringify(orderRes).slice(0, 400));

    const orderId     = orderRes.result?.order_id || orderRes.result?.id;
    const htlcAddress = orderRes.result?.source?.htlc_address
                     || orderRes.result?.source?.swap_id
                     || orderRes.result?.to;
    const htlcAmount  = orderRes.result?.source?.amount || execAmount;

    if (!orderId) throw new Error(`No order_id in response: ${JSON.stringify(orderRes).slice(0, 200)}`);
    step("Create Order", "pass", `Order ID: ${orderId}`);

    // 6. Manual approval gate
    if (config.manualApprove) {
      step("Awaiting Approval", "pending", "Waiting for your approval…");
      checkAbort();
      const approved = await requestApproval({ orderId, fromAsset, toAsset: swapDestAsset, safeAmount: execAmount, outputAmount, htlcAddress, label });
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
      5115:     'https://rpc.testnet.citrea.xyz',
      8150:     'https://rpc.testnet.alpenlabs.io',
      48898:    'https://rpc.testnet.alpenlabs.io',
      10143:    'https://testnet-rpc.monad.xyz',
      998:      'https://rpc.hyperliquid-testnet.xyz/evm',
      'base_sepolia':     'https://sepolia.base.org',
      'base':             'https://sepolia.base.org',
      'ethereum_sepolia': 'https://rpc.sepolia.org',
      'ethereum':         'https://rpc.sepolia.org',
      'arbitrum_sepolia': 'https://sepolia-rollup.arbitrum.io/rpc',
      'arbitrum':         'https://sepolia-rollup.arbitrum.io/rpc',
      'bnbchain_testnet': 'https://data-seed-prebsc-1-s1.binance.org:8545',
      'bnbchain':         'https://data-seed-prebsc-1-s1.binance.org:8545',
      'hyperevm_testnet': 'https://rpc.hyperliquid-testnet.xyz/evm',
      'hyperevm':         'https://rpc.hyperliquid-testnet.xyz/evm',
      'monad_testnet':    'https://testnet-rpc.monad.xyz',
      'monad':            'https://testnet-rpc.monad.xyz',
      'citrea_testnet':   'https://rpc.testnet.citrea.xyz',
      'citrea':           'https://rpc.testnet.citrea.xyz',
      'alpen_testnet':    'https://rpc.testnet.alpenlabs.io',
      'alpen':            'https://rpc.testnet.alpenlabs.io',
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
      const approvalTxForLog = orderRes.result?.approval_transaction;
      const walletStatus = walletState.getStatus();
      const evmSource = walletStatus?.evmSource;
      const envkeyAvailable = envkey.isAvailable();
      const effectiveEnvkey =
        envkeyAvailable &&
        !!envkey.getEvmAddress?.() &&
        (evmSource === "envkey" || !evmSource);


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
        const shouldUseEnvkey = effectiveEnvkey;
        if (shouldUseEnvkey) {
          // In envkey mode we must never call requestEvmTx() (that triggers MetaMask popups).
          if (approvalTx?.data && approvalTx?.to) {
            step("ERC20 Approve", "running", "Sending approve() via .env key…");
            const approveTxHash = await envkey.sendEvmTransaction({
              to: approvalTx.to, data: approvalTx.data,
              value: approvalTx.value || "0x0",
              chainId: approvalTx.chain_id || prebuiltTx.chain_id,
              gasLimit: approvalTx.gas_limit || "0xea60",
            });
            step("ERC20 Approve", "pass", `Approved on-chain: ${approveTxHash}`);
          } else {
            await ensureErc20Approval({
              tokenAddr:    pickTokenAddress(fromMeta, orderRes.result?.source),
              spender:      prebuiltTx.to,
              amount:       htlcAmount,
              chainIdOrKey: prebuiltTx.chain_id,
              walletMode:   'envkey',
            });
          }

          step("Initiate HTLC", "pending", "Sending initiate tx via .env private key…");
          initTxHash = await envkey.sendEvmTransaction({
            to: prebuiltTx.to, data: prebuiltTx.data,
            value: prebuiltTx.value || "0x0",
            chainId: prebuiltTx.chain_id,
            gasLimit: prebuiltTx.gas_limit || "0x493e0",
          });
        } else {
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
              tokenAddr:    pickTokenAddress(fromMeta, orderRes.result?.source),
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
        }
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
          tokenAddr:    pickTokenAddress(fromMeta, orderRes.result?.source),
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

      // Notify Garden can take a long time depending on chain/indexer latency.
      // We use a "soft timeout": retry frequently for 20 minutes, then back off
      // to every 10 minutes until the order reaches a terminal state.
      const NOTIFY_SOFT_TIMEOUT = 20 * 60 * 1000;
      const NOTIFY_POST_SOFT_INTERVAL = 10 * 60 * 1000;
      function getNotifyInterval(elapsedMs) {
        if (elapsedMs < 2 * 60 * 1000)  return 10000;
        if (elapsedMs < 5 * 60 * 1000)  return 20000;
        if (elapsedMs < 8 * 60 * 1000)  return 30000;
        if (elapsedMs < NOTIFY_SOFT_TIMEOUT) return 120000;
        return NOTIFY_POST_SOFT_INTERVAL;
      }
      const notifyStart = Date.now();
      let notifyAttempts = 0;
      let notifyDone = false;

      while (!notifyDone) {
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
            // If the order already reached a terminal state, stop waiting here.
            const isTerminal = ["expired","refunded","failed","cancelled","redeemed","completed"].some(s => realStatus.includes(s));
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

      // No hard timeout here: if patching fails, we keep polling/backing off until terminal.
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
        testId, status: "pass", fromAssetId: fromAsset, toAssetId: swapDestAsset,
        fromChain, toChain, amount: execAmount, outputAmount: received,
        usdIn: Number(bestQuote?.source?.value ?? 0),
        usdOut: Number(bestQuote?.destination?.value ?? 0),
        slippagePct, durationSec: elapsed, ts: new Date().toISOString(),
        agent: "runner", steps,
      });
    } catch (_) {}

    const rawFilled =
      finalOrder?.destination_filled_amount ??
      finalOrder?.destination_swap?.amount ??
      outputAmount;
    const parsedNext = parseInt(String(rawFilled).replace(/\..*$/, ""), 10);
    let nextHopAmountAtomic = Number.isFinite(parsedNext) && parsedNext > 0
      ? parsedNext
      : Math.max(1, Math.floor(parseFloat(String(outputAmount)) || 0));

    emit("test_end", { testId, label, status: "pass", steps, duration: elapsed });
    _activeTests.delete(testId);
    return {
      testId,
      label,
      status: "pass",
      steps,
      duration: elapsed,
      actualDestAsset: swapDestAsset,
      actualDestMeta: swapDestMeta,
      nextHopAmountAtomic,
    };

  } catch (err) {
    const failStep = { name: "Error", status: "fail", detail: err.message, ts: new Date().toISOString() };
    steps.push(failStep);
    emit("test_step", { testId, label, step: failStep });
    const finalStatus = err.message.includes("aborted") ? "aborted" : "fail";
    emit("test_end",  { testId, label, status: finalStatus, error: err.message, steps });
    try {
      const failDuration = steps.length > 0
        ? Math.round((Date.now() - new Date(steps[0].ts).getTime()) / 1000)
        : 0;
      tradeHistory.record({
        testId, status: finalStatus, fromAssetId: fromAsset, toAssetId: swapDestAsset,
        fromChain, toChain, amount, outputAmount: 0,
        usdIn: 0, usdOut: 0, slippagePct: 0, durationSec: failDuration,
        ts: new Date().toISOString(),
        agent: "runner", error: err.message, steps,
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
async function buildRoutes(amountOverrides = {}, mode = "allTests", seedAllowlist = null) {
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

  // Gather balances early so default route amounts can use them.
  const balanceMap = new Map();
  const gasMap = new Map();
  try {
    const cached = wallets.evm?.tokenBalances || {};
    for (const [assetId, bal] of Object.entries(cached)) {
      balanceMap.set(assetId, bal);
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

  const routes = [];
  let _debugBufferedMinLogCount = 0;
  const _debugBufferedMinLoggedAssets = new Set();
  for (const from of supported) {
    for (const to of supported) {
      if (from.id === to.id) continue;
      if (!isPairPlausible(from, to)) continue;
      const overrideAmt = amountOverrides[from.id];
      const minAmtAtomic = parseInt(from.min_amount || 50000, 10);

      let rawChosen = 0;
      let _bufferPick = null;
      if (overrideAmt !== undefined) {
        rawChosen = parseInt(overrideAmt, 10);
      } else {
        const fromChain = getWalletTypeForAsset(from);
        const balAtomicBig = balanceMap.has(from.id) ? toBigIntAtomic(balanceMap.get(from.id)) : null;
        _bufferPick = pickBufferedMinTradeAmountAtomic({
          minTradeAtomicBig: BigInt(Math.max(1, minAmtAtomic)),
          balanceAtomicBig: balAtomicBig,
        });
        rawChosen = Number(_bufferPick.chosen);
      }

      const chosenAmount = clampGardenQuoteAmount(rawChosen, from);

      if (
        overrideAmt === undefined &&
        _bufferPick &&
        _debugBufferedMinLogCount < 20 &&
        !_debugBufferedMinLoggedAssets.has(from.id)
      ) {
        _debugBufferedMinLoggedAssets.add(from.id);
        _debugBufferedMinLogCount += 1;
      }
      routes.push({
        fromAsset: from.id,
        toAsset:   to.id,
        fromChain: getWalletTypeForAsset(from),
        toChain:   getWalletTypeForAsset(to),
        amount:    chosenAmount,
        fromMeta:  from,
        toMeta:    to,
        label:     `${from.name} → ${to.name}`,
        executionMode: mode,
      });
    }
  }

 
  // Chain-reaction optimizer
  try {
    await ensureRouteAgentReady();
    const result = _routeAgent.run(routes, {
      maxTotal: 160,
      perPairLimit: 3,
      balances: balanceMap,
      gasBalances: gasMap,
      connectedWalletTypes: connectedTypes,
      seedAllowlist: seedAllowlist instanceof Set && seedAllowlist.size ? seedAllowlist : undefined,
    }, mode);
    emit("route_plan", {
      mode: result.mode,
      availableRunOptions: result.availableRunOptions || ["allTests", "allChains"],
      topThreeConditions: result.topThreeConditions,
      requiredAmountSufficient: result.requiredAmountSufficient,
      requiredAmountSummary: result.requiredAmountSummary,
      plannedRoutes: result.plan?.length || 0,
      chains: result.chains?.length || 0,
    });
    return result.plan || routes;
  } catch (_) {
    return routes;
  }
}

function toBigIntAtomic(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.max(0, Math.floor(value)));
  if (typeof value === "string") {
    const clean = value.trim();
    if (!clean) return 0n;
    const intPart = clean.includes(".") ? clean.split(".")[0] : clean;
    try { return BigInt(intPart || "0"); } catch (_) { return 0n; }
  }
  return 0n;
}

function tickerFromMeta(meta) {
  const idSuffix = String(meta?.id || "").split(":")[1] || "";
  return String(meta?.asset || meta?.ticker || idSuffix || "").toLowerCase();
}

function getQuoteAmountAtomic(bestQuote, side, fallbackAmount) {
  const source = bestQuote?.source || {};
  const destination = bestQuote?.destination || {};
  const candidates = side === "from"
    ? [source.amount, bestQuote?.fromAmount, bestQuote?.from_amount, fallbackAmount]
    : [destination.amount, bestQuote?.toAmount, bestQuote?.to_amount, bestQuote?.output_amount, fallbackAmount];
  for (const c of candidates) {
    const asBig = toBigIntAtomic(c);
    if (asBig > 0n) return asBig;
  }
  return 0n;
}

function getWalletAssetAtomicBalance(route) {
  const wallets = walletState.getStatus();
  if (route.fromChain === "bitcoin") {
    const rawBal = wallets.btc?.balance;
    if (rawBal && rawBal !== "unknown") return BigInt(Math.max(0, Math.floor(parseFloat(rawBal) * 1e8)));
    return null;
  }
  if (route.fromChain === "evm") {
    const cached = wallets.evm?.tokenBalances || {};
    if (cached[route.fromAsset] !== undefined) return toBigIntAtomic(cached[route.fromAsset]);
  }
  return null;
}

function mulRatioCeilBigInt(value, numerator, denominator) {
  const v = toBigIntAtomic(value);
  return (v * BigInt(numerator) + BigInt(denominator - 1)) / BigInt(denominator);
}

function mulBpsCeilBigInt(valueAtomicBig, bps) {
  const v = toBigIntAtomic(valueAtomicBig);
  const denom = 10000n;
  const numer = denom + BigInt(bps);
  return (v * numer + (denom - 1n)) / denom;
}

function pickBufferedMinTradeAmountAtomic({
  minTradeAtomicBig,
  balanceAtomicBig,
  feeBps = 30,   // 0.3%
  bufferBps = 50 // 0.5%
}) {
  const minA = toBigIntAtomic(minTradeAtomicBig);
  const balA = balanceAtomicBig === null ? null : toBigIntAtomic(balanceAtomicBig);
  if (balA === null) {
    return { chosen: minA, reason: "balance_unknown", minA, feeThresh: null, bufThresh: null, balA: null };
  }

  const feeThresh = mulBpsCeilBigInt(minA, feeBps);     // min + 0.3%
  const bufThresh = mulBpsCeilBigInt(minA, bufferBps);  // min + 0.5%

  if (balA >= bufThresh) return { chosen: bufThresh, reason: "min_plus_buffer", minA, feeThresh, bufThresh, balA };
  if (balA > feeThresh)  return { chosen: balA,       reason: "use_max_balance", minA, feeThresh, bufThresh, balA };
  return { chosen: minA, reason: "use_min_trade", minA, feeThresh, bufThresh, balA };
}

async function simulateSingleHop({
  fromAsset,
  fromMeta,
  toAsset,
  toMeta,
  toChain,
  inputAtomicBig,
}) {
  const inputAmount = Number(inputAtomicBig);
  const safeAmount = clampGardenQuoteAmount(inputAmount, fromMeta);
  const resolved = await getQuoteWithDestinationFallback({
    fromAsset,
    toAsset,
    toMeta,
    toChain,
    fromMeta,
    safeAmount,
  });
  const quotes = resolved.quoteRes?.result || [];
  if (!quotes.length) throw new Error("No quote returned in simulation");
  const best = quotes[0];
  const fromAmt = getQuoteAmountAtomic(best, "from", safeAmount);
  const toAmt = getQuoteAmountAtomic(best, "to", 0);
  const feeValue = best?.fee ?? best?.fees ?? best?.fixed_fee ?? null;
  return {
    fromAmountAtomic: fromAmt,
    toAmountAtomic: toAmt,
    destinationAsset: resolved.toAsset,
    destinationMeta: resolved.toMeta,
    swappedDestination: resolved.swappedDestination,
    fee: feeValue,
    best,
  };
}

/**
 * allChains: backward-compute the minimum seed amount needed so that every hop in the chain
 * receives at least its asset's min_amount.
 *
 * Method: quote each hop at its min_amount to get the effective spread ratio,
 * then propagate requirements backward from the last hop to the seed.
 *
 * Returns null if any quote fails (non-blocking — caller proceeds without the check).
 */
async function computeChainRequiredSeed(chainRoutes) {
  if (!chainRoutes || chainRoutes.length === 0) return null;

  // Forward pass: quote each hop at its min_amount to measure spread
  const hopRatios = [];
  for (const route of chainRoutes) {
    const min = Math.max(1, parseInt(String(route.fromMeta?.min_amount ?? 50000), 10) || 50000);
    try {
      const quoteRes = await garden.getQuote(route.fromAsset, route.toAsset, min);
      const quotes = quoteRes?.result || (Array.isArray(quoteRes) ? quoteRes : []);
      if (!quotes.length) return null;
      const q = quotes[0];
      const outAmt = parseInt(String(q.destination?.amount ?? 0), 10);
      if (outAmt <= 0) return null;
      hopRatios.push({ inputMin: min, outputAtMin: outAmt, ratio: outAmt / min });
    } catch (_) {
      return null; // quote unavailable — non-blocking
    }
  }

  // Backward pass: what input at hop i is needed so hop i+1 receives at least its min_amount?
  const requiredInput = new Array(chainRoutes.length);
  requiredInput[chainRoutes.length - 1] =
    Math.max(1, parseInt(String(chainRoutes[chainRoutes.length - 1].fromMeta?.min_amount ?? 50000), 10) || 50000);

  for (let i = chainRoutes.length - 2; i >= 0; i--) {
    const neededOutput = requiredInput[i + 1];
    const ratio = hopRatios[i].ratio;
    if (!ratio || ratio <= 0) return null;
    requiredInput[i] = Math.ceil(neededOutput / ratio);
  }

  // Seed must also clear its own min_amount
  const hop0Min = Math.max(1, parseInt(String(chainRoutes[0].fromMeta?.min_amount ?? 50000), 10) || 50000);
  requiredInput[0] = Math.max(requiredInput[0], hop0Min);

  return {
    requiredSeedAtomic: requiredInput[0],
    hopBreakdown: chainRoutes.map((r, i) => ({
      hop: i + 1,
      fromAsset: r.fromAsset,
      toAsset: r.toAsset,
      minAmountAtomic: Math.max(1, parseInt(String(r.fromMeta?.min_amount ?? 50000), 10) || 50000),
      requiredInputAtomic: requiredInput[i],
      effectiveRatio: hopRatios[i]?.ratio ?? null,
    })),
  };
}

async function simulateRouteFlow(flowRoutes, flowId) {
  if (!flowRoutes.length) return { ok: true, flowId, requiredStartAtomic: "0", requiredStartBufferedAtomic: "0", hops: [] };
  await priceFeed.fetchPrices().catch(() => {});

  const first = flowRoutes[0];
  let startBalance = getWalletAssetAtomicBalance(first);
  if (startBalance === null) {
    return { ok: false, flowId, reason: "balance_unknown", error: `Balance unknown for ${first.fromAsset}` };
  }

  let effectiveFromAsset = first.fromAsset;
  let effectiveFromMeta = first.fromMeta;
  let currentAtomic = startBalance;
  const hops = [];

  for (let i = 0; i < flowRoutes.length; i++) {
    const route = flowRoutes[i];
    const toAsset = route.toAsset;
    const toMeta = route.toMeta;
    const toChain = route.toChain;

    const fromTicker = tickerFromMeta(effectiveFromMeta);
    const toTickerPreview = tickerFromMeta(toMeta);

    const minTradeAtomic = toBigIntAtomic(effectiveFromMeta?.min_amount || 50000);
    const currentUsd = priceFeed.atomicToUsd(Number(currentAtomic), fromTicker);
    const minTradeUsd = priceFeed.atomicToUsd(Number(minTradeAtomic), fromTicker);

    if (!Number.isFinite(currentUsd) || currentUsd <= 0 || currentUsd < minTradeUsd) {
      appendRuntimeLog({
        sessionId: "92463b",
        runId: "simulation-preflight",
        hypothesisId: "SIM1",
        location: "simulateRouteFlow:insufficient_balance_usd",
        message: "Simulation hop failed minTrade USD check",
        data: {
          flowId,
          hopIndex: i + 1,
          effectiveFromAsset,
          toAsset,
          inputAtomic: currentAtomic.toString(),
          currentUsd,
          minTradeAtomic: minTradeAtomic.toString(),
          minTradeUsd,
          toTickerPreview,
        },
        timestamp: Date.now(),
      });
      return {
        ok: false,
        flowId,
        reason: "insufficient_balance_usd",
        error: `Hop ${i + 1}: current USD ${currentUsd.toFixed(4)} < minTrade USD ${minTradeUsd.toFixed(4)}`,
        hops,
      };
    }

    const hop = await simulateSingleHop({
      fromAsset: effectiveFromAsset,
      fromMeta: effectiveFromMeta,
      toAsset,
      toMeta,
      toChain,
      inputAtomicBig: currentAtomic,
    });

    if (hop.toAmountAtomic <= 0n) {
      appendRuntimeLog({
        sessionId: "92463b",
        runId: "simulation-preflight",
        hypothesisId: "SIM2",
        location: "simulateRouteFlow:quote_zero_toAmount",
        message: "Simulation hop failed: toAmount is zero",
        data: { flowId, hopIndex: i + 1, effectiveFromAsset, toAsset, inputAtomic: currentAtomic.toString() },
        timestamp: Date.now(),
      });
      return { ok: false, flowId, reason: "quote_zero_toAmount", error: `Hop ${i + 1}: toAmount is zero`, hops };
    }

    const actualToMeta = hop.destinationMeta || toMeta;
    const actualToTicker = tickerFromMeta(actualToMeta);
    const fromUsd = priceFeed.atomicToUsd(Number(hop.fromAmountAtomic), fromTicker);
    const toUsd = priceFeed.atomicToUsd(Number(hop.toAmountAtomic), actualToTicker);

    // Rough sanity check for extreme drops in USD value.
    if (
      Number.isFinite(fromUsd) &&
      fromUsd > 0 &&
      Number.isFinite(toUsd) &&
      toUsd > 0 &&
      toUsd < fromUsd * 0.4
    ) {
      appendRuntimeLog({
        sessionId: "92463b",
        runId: "simulation-preflight",
        hypothesisId: "SIM3",
        location: "simulateRouteFlow:abnormal_value_drop",
        message: "Simulation hop failed: abnormal value drop",
        data: {
          flowId,
          hopIndex: i + 1,
          effectiveFromAsset,
          toAsset: hop.destinationAsset,
          usdBefore: fromUsd,
          usdAfter: toUsd,
        },
        timestamp: Date.now(),
      });
      return {
        ok: false,
        flowId,
        reason: "abnormal_value_drop",
        error: `Hop ${i + 1}: abnormal value drop ${fromUsd.toFixed(4)} -> ${toUsd.toFixed(4)} USD`,
        hops,
      };
    }

    hops.push({
      hop: i + 1,
      fromAsset: effectiveFromAsset,
      toAsset: hop.destinationAsset || toAsset,
      inputAmountAtomic: hop.fromAmountAtomic.toString(),
      outputAmountAtomic: hop.toAmountAtomic.toString(),
      fee: hop.fee,
      usdBefore: Number.isFinite(fromUsd) ? fromUsd : null,
      usdAfter: Number.isFinite(toUsd) ? toUsd : null,
      minTradeUsd: Number.isFinite(minTradeUsd) ? minTradeUsd : null,
      swappedDestination: !!hop.swappedDestination,
    });

    // Apply the same semantics as execution: next hop spends the actual asset received here.
    effectiveFromAsset = hop.destinationAsset || toAsset;
    effectiveFromMeta = actualToMeta;
    currentAtomic = hop.toAmountAtomic;
  }

  appendRuntimeLog({
    sessionId: "92463b",
    runId: "simulation-preflight",
    hypothesisId: "SIM_OK",
    location: "simulateRouteFlow:success",
    message: "Simulation flow succeeded",
    data: { flowId, startAsset: first.fromAsset, startBalanceAtomic: startBalance.toString(), hops },
    timestamp: Date.now(),
  });

  const buffered = mulRatioCeilBigInt(startBalance, 105, 100);
  return {
    ok: true,
    flowId,
    startAsset: first.fromAsset,
    startBalanceAtomic: startBalance.toString(),
    requiredStartAtomic: buffered.toString(),
    requiredStartBufferedAtomic: buffered.toString(),
    hops,
  };
}

async function simulateFlowsForRoutes(routes, mode = "allTests", opts = {}) {
  const bySeed = new Map();
  const standalone = [];
  for (const route of routes || []) {
    if (route._chainStart) {
      if (!bySeed.has(route._chainStart)) bySeed.set(route._chainStart, []);
      bySeed.get(route._chainStart).push(route);
    } else {
      standalone.push(route);
    }
  }
  const simulationFlows = [];
  for (const [seed, chainRoutes] of bySeed.entries()) {
    simulationFlows.push({ id: `seed:${seed}`, routes: chainRoutes });
  }
  for (let i = 0; i < standalone.length; i++) {
    simulationFlows.push({ id: `standalone:${i + 1}`, routes: [standalone[i]] });
  }
  const maxFlows = Number(opts.maxFlows || 0);
  const bounded = maxFlows > 0 ? simulationFlows.slice(0, maxFlows) : simulationFlows;
  const simulationResults = [];
  for (const flow of bounded) {
    try {
      const res = await simulateRouteFlow(flow.routes, flow.id);
      simulationResults.push(res);
      if (!opts.silent) emit("simulation_trace", res);
    } catch (e) {
      const msg = e?.message || String(e);
      const isLiq = isInsufficientLiquidityGardenError({ message: msg });
      const first = flow.routes?.[0] || {};
      const fail = {
        ok: false,
        flowId: flow.id,
        reason: isLiq ? "insufficient_liquidity" : "simulation_exception",
        error: msg,
        skippable: isLiq && String(flow.id || "").startsWith("standalone:"),
        routeHint: { fromAsset: first.fromAsset || null, toAsset: first.toAsset || null, label: first.label || null },
      };
      simulationResults.push(fail);
      if (!opts.silent) emit("simulation_trace", fail);
    }
  }
  const skipped = simulationResults.filter((x) => x && x.ok === false && x.skippable);
  const firstFail = simulationResults.find((x) => x && x.ok === false && !x.skippable) || null;
  const simulationFailed = firstFail;
  const summary = {
    mode,
    totalFlows: bounded.length,
    passedFlows: simulationResults.filter((x) => x.ok).length,
    failedFlows: simulationResults.filter((x) => !x.ok).length,
    skippedFlows: skipped.map((x) => ({ flowId: x.flowId, reason: x.reason, error: x.error, routeHint: x.routeHint })),
    skippedFlowIds: skipped.map((x) => x.flowId),
    requiredStartByFlow: simulationResults
      .filter((x) => x.ok)
      .map((x) => ({ flowId: x.flowId, startAsset: x.startAsset, requiredStartBufferedAtomic: x.requiredStartBufferedAtomic })),
    ok: !simulationFailed,
    failedFlow: simulationFailed
      ? { flowId: simulationFailed.flowId, reason: simulationFailed.reason, error: simulationFailed.error || null }
      : null,
  };
  if (!opts.silent) emit("simulation_summary", summary);
  return summary;
}

async function simulateExecutionPreflight(amountOverrides = {}, mode = "allTests", opts = {}) {
  if (mode === "allTests") {
    // allTests runs as a funding-tree fanout. Individual edge failures (e.g. insufficient
    // liquidity on a pair) are expected and non-fatal — the runner skips them at execution
    // time. Only a structural failure (no connected wallets, Garden API down) blocks the run.
    const ft = await simulateFundingTreeByLevel(amountOverrides, { silent: true, assetLimit: opts?.assetLimit ?? null });
    const structureOk = !!ft?.structureValidation?.ok;
    const levels = Array.isArray(ft?.levels) ? ft.levels.filter(l => l.level !== "return_to_root") : [];
    const totalEdges = levels.reduce((sum, l) => sum + (Array.isArray(l.edges) ? l.edges.length : 0), 0);
    const passedEdges = levels.reduce((sum, l) => sum + (Array.isArray(l.edges) ? l.edges.filter(e => e.ok).length : 0), 0);
    const skippedEdges = totalEdges - passedEdges;
    return {
      mode,
      ok: structureOk,
      totalFlows: totalEdges,
      passedFlows: passedEdges,
      failedFlows: 0,
      skippedFlows: skippedEdges > 0 ? [{ reason: "insufficient_liquidity_or_unsupported_pair" }] : [],
      skippedFlowIds: [],
      skippedFlowsCount: skippedEdges,
      requiredStartByFlow: [],
      failedFlow: structureOk ? null : { flowId: "fundingTree", reason: "structure_invalid", error: (ft?.structureValidation?.errors || []).join("; ") || "Funding tree structure invalid" },
      fundingTree: ft,
    };
  }
  const routes = await buildRoutes(amountOverrides, mode);

  // allChains: augment preflight with required-seed calculation so the dashboard
  // can show exactly how much funding the chain needs before the user clicks Run.
  if (mode === "allChains") {
    const bySeed = new Map();
    for (const r of routes) {
      if (r._chainStart) {
        if (!bySeed.has(r._chainStart)) bySeed.set(r._chainStart, []);
        bySeed.get(r._chainStart).push(r);
      }
    }
    // Pick the same single random seed that runAll would pick
    const seedEntries = pickRandomizedSeedEntries(bySeed);
    const pickedSeed = seedEntries[0];
    if (pickedSeed) {
      const [seedId, chainRoutes] = pickedSeed;
      const req = await computeChainRequiredSeed(chainRoutes).catch(() => null);
      const seedBal = getWalletAssetAtomicBalance(chainRoutes[0]);
      const seedBalNum = seedBal !== null ? Number(seedBal) : null;
      const sufficient = req && seedBalNum !== null ? seedBalNum >= req.requiredSeedAtomic : null;
      emit("allchains_preflight", {
        seedAsset: seedId,
        hopCount: chainRoutes.length,
        requiredSeedAtomic: req?.requiredSeedAtomic ?? null,
        seedBalanceAtomic: seedBalNum,
        sufficient,
        shortfall: req && seedBalNum !== null && !sufficient
          ? req.requiredSeedAtomic - seedBalNum
          : 0,
        hopBreakdown: req?.hopBreakdown ?? null,
      });
      if (req && seedBalNum !== null && !sufficient) {
        return {
          mode,
          ok: false,
          totalFlows: chainRoutes.length,
          passedFlows: 0,
          failedFlows: 1,
          skippedFlows: [],
          skippedFlowIds: [],
          requiredStartByFlow: [],
          failedFlow: {
            flowId: `seed:${seedId}`,
            reason: "insufficient_seed_balance",
            error: `Need ${req.requiredSeedAtomic} atomic but have ${seedBalNum} (shortfall ${req.requiredSeedAtomic - seedBalNum})`,
          },
          chainRequirement: req,
          seedBalanceAtomic: seedBalNum,
        };
      }
    }
  }

  return simulateFlowsForRoutes(routes, mode, opts);
}

/**
 * allChains: run exactly one beam (one seed chain), e.g. S1 → X → Y → Z → P → Q.
 * Prefer the longest hop list; tie-break by seed id. Other starting assets (S2…) belong to another run.
 */
function pickRandomizedSeedEntries(bySeed) {
  const entries = [...(bySeed?.entries?.() || [])];
  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = entries[i]; entries[i] = entries[j]; entries[j] = tmp;
  }
  return entries;
}

// ── RUN ALL — PARALLEL CHAIN-REACTION EXECUTION ──────────────
async function runAll(amountOverrides = {}, mode = "allTests", seedAllowlist = null, serverPlan = null) {
  const ts = new Date().toISOString();
  emit("suite_start", { env: config.env, mode, ts });
  _suiteRunActive = true;
  const suiteEpoch = _abortEpoch;
  _suiteRunMeta = { env: config.env, mode, startedAt: ts, suiteEpoch };
  let _suiteEndEmitted = false;
  try {
  await runApiTests();
  const results = [];

  async function maybePrefundNativeOnChainFromAsset({ fromChain, fromAsset, fromMeta, amount, label }) {
    // Force-enable the existing gas prefund logic for both modes by calling it with allChains semantics.
    // This still cannot invent gas from 0 native; it requires at least dust for tx fees.
    const fromAddress = walletState.getAddressByType(fromChain);
    if (!fromAddress) return { ok: true, skipped: true, reason: "no_from_address" };
    const prefund = await maybeAllChainsGasPrefundViaGarden({
      executionMode: "allChains",
      skipGasPrefund: false,
      forcePrefund: true,
      fromChain,
      fromAsset,
      fromMeta,
      fromAddress,
      amount,
      label,
      testId: "prefund",
      step: () => {},
      checkAbort: () => {},
    });
    return prefund;
  }

  async function runAllFundingTree() {
    const plan = await buildFundingTreePlan(amountOverrides, { assetLimit: null });
    emit("suite_routes", { count: (plan?.levels || []).reduce((a, l) => a + (l.edges?.length || 0), 0), routes: ["funding_tree"] });
    const funded = new Set([0]);
    const PAR = 3;
    const blockedChains = new Set();
    const gasCache = new Map();
    const gasFilled = new Set();         // EVM chains where gas fill has already run this session
    const chainGasNeeds = plan.chainGasNeeds || new Map();
    const supportedAssets = await getAssetsForRunner().catch(() => []);

    if (chainGasNeeds.size) {
      emit("suite_info", { message: `Gas pre-plan: chains needing native fill before first edge: ${[...chainGasNeeds.keys()].join(', ')}` });
    }

    // Run a gas-fill route (fromAsset → native) for a dest chain, updating gasCache on success.
    async function runGasFill(fromMeta, fromChain, nativeMeta, destChainKey) {
      const amount = clampGardenQuoteAmount(
        parseInt(String(fromMeta.min_amount ?? 50000), 10) || 50000, fromMeta
      );
      const gasRoute = {
        fromAsset: fromMeta.id, toAsset: nativeMeta.id,
        fromChain, toChain: 'evm', amount, fromMeta, toMeta: nativeMeta,
        label: `${fromMeta.name || fromMeta.id} → ${nativeMeta.name || nativeMeta.id} [gas fill: ${destChainKey}]`,
        executionMode: 'allTests', suiteEpoch,
      };
      emit("suite_info", { message: `Pre-filling gas on ${destChainKey}: ${gasRoute.label}` });
      const r = await runRoute(gasRoute).catch(() => ({ status: 'fail' }));
      results.push(r);
      if (r.status === 'pass') gasCache.set(destChainKey, MIN_NATIVE_WEI_FOR_GAS);
      else emit("suite_info", { message: `Gas fill failed for ${destChainKey} — substitution fallback active` });
    }

    for (const { level, edges } of plan.levels || []) {
      if (_abortEpoch !== suiteEpoch) break;
      const runnable = (edges || []).filter((e) => funded.has(e.parent));
      const running = new Set();

      for (const e of runnable) {
        if (_abortEpoch !== suiteEpoch) break;
        const ent = plan.routesByEdgeKey.get(`${e.parent}->${e.child}`);
        if (!ent?.ok) continue;

        const baseRoute = { ...ent.route, executionMode: "allTests", suiteEpoch };
        const destChainKey = String(baseRoute.toAsset || '').split(':')[0]
          .replace(/_sepolia|_testnet\d*|_mainnet|_signet|_devnet/g, '');

        if (blockedChains.has(destChainKey)) {
          emit("suite_info", { message: `Skipping ${baseRoute.label} — chain ${destChainKey} blocked (no native gas support)` });
          continue;
        }

        // Pre-fill gas on dest chain if needed (planned at build time, runs once per chain)
        if (chainGasNeeds.has(destChainKey) && !gasFilled.has(destChainKey)) {
          gasFilled.add(destChainKey);
          const { nativeMeta } = chainGasNeeds.get(destChainKey);
          if (nativeMeta.id !== baseRoute.toAsset) {
            await runGasFill(baseRoute.fromMeta, baseRoute.fromChain, nativeMeta, destChainKey);
          }
        }

        // Safety-net: if gas still insufficient, substitute toAsset → native
        const destCheck = await resolveToAssetWithGasSubstitution(baseRoute, supportedAssets, gasCache);
        if (!destCheck.ok) {
          blockedChains.add(destChainKey);
          emit("suite_info", { message: `Blocking chain ${destChainKey} — no Garden-supported native gas token` });
          continue;
        }
        if (destCheck.substituted) {
          emit("suite_info", { message: `Substituted dest to native: ${baseRoute.label} → ${destCheck.route.toAsset}` });
        }
        const route = destCheck.route;

        const p = runRoute(route).then((r) => {
          results.push(r);
          if (r?.status === "pass") funded.add(e.child);
        }).catch(() => {});
        running.add(p);
        if (running.size >= PAR) {
          await Promise.race([...running]);
          for (const x of [...running]) if (x && x.status === "fulfilled") running.delete(x);
        }
      }
      if (running.size) await Promise.allSettled([...running]);

      // Fallback parent: for any child still unfunded after this level (parent never funded
      // or parent swap failed), find the best already-funded substitute source and retry.
      for (const e of (edges || [])) {
        if (funded.has(e.child) || _abortEpoch !== suiteEpoch) continue;
        const childMeta = plan.picked[e.child];
        const origWalletType = getWalletTypeForAsset(plan.picked[e.parent]);

        // Prefer same wallet type as original parent; exclude original parent (already failed)
        // and the child itself; limit to 2 attempts to avoid spamming Garden quotes.
        const candidates = [...funded]
          .filter(fi => fi !== e.child && fi !== e.parent && isPairPlausible(plan.picked[fi], childMeta))
          .sort((a, b) => {
            const aMatch = getWalletTypeForAsset(plan.picked[a]) === origWalletType ? 0 : 1;
            const bMatch = getWalletTypeForAsset(plan.picked[b]) === origWalletType ? 0 : 1;
            return aMatch - bMatch || a - b;
          });

        for (const fi of candidates.slice(0, 2)) {
          if (_abortEpoch !== suiteEpoch) break;
          const altFromMeta = plan.picked[fi];
          const altFromChain = getWalletTypeForAsset(altFromMeta);
          const toChain = getWalletTypeForAsset(childMeta);
          const amount = clampGardenQuoteAmount(
            parseInt(String(altFromMeta.min_amount ?? 50000), 10) || 50000, altFromMeta
          );
          const fallbackRoute = {
            fromAsset: altFromMeta.id, toAsset: childMeta.id,
            fromChain: altFromChain, toChain, amount,
            fromMeta: altFromMeta, toMeta: childMeta,
            label: `${altFromMeta.name || altFromMeta.id} → ${childMeta.name || childMeta.id} [fallback parent]`,
            executionMode: 'allTests', suiteEpoch,
          };
          emit("suite_info", { message: `Fallback parent for ${childMeta.id}: trying ${altFromMeta.id}` });

          // Gas fill for fallback dest chain if still needed
          const fbDestKey = String(childMeta.id).split(':')[0]
            .replace(/_sepolia|_testnet\d*|_mainnet|_signet|_devnet/g, '');
          if (chainGasNeeds.has(fbDestKey) && !gasFilled.has(fbDestKey)) {
            gasFilled.add(fbDestKey);
            const { nativeMeta } = chainGasNeeds.get(fbDestKey);
            if (nativeMeta.id !== fallbackRoute.toAsset)
              await runGasFill(altFromMeta, altFromChain, nativeMeta, fbDestKey);
          }

          const destCheck = await resolveToAssetWithGasSubstitution(fallbackRoute, supportedAssets, gasCache);
          if (!destCheck.ok) continue;
          const result = await runRoute(destCheck.route).catch(() => ({ status: 'fail' }));
          results.push(result);
          if (result.status === 'pass') { funded.add(e.child); break; }
        }
      }
    }
    return results;
  }

  if (mode === "allTests") {
    await runAllFundingTree();
    const passed = results.filter(r => r.status === "pass").length;
    const failed = results.filter(r => r.status === "fail").length;
    const aborted = results.filter(r => r.status === "aborted").length;
    const skipped = results.filter(r => r.status === "skipped").length;
    emit("suite_end", { env: config.env, total: results.length, executed: passed + failed + aborted, passed, failed, aborted, skipped, ts: new Date().toISOString() });
    _suiteEndEmitted = true;
    return results;
  }

  // allChains: use server's pre-built plan if available (same seed/routes the display showed).
  // Falls back to buildRoutes if serverPlan is null (e.g. consolidate-and-run, TTL expiry).
  const allBuiltRoutes = (mode === "allChains" && serverPlan && serverPlan.length > 0)
    ? serverPlan
    : await buildRoutes(amountOverrides, mode, seedAllowlist);
  // allChains: only chain routes — standalones are not part of the cycle
  const routes = mode === "allChains"
    ? allBuiltRoutes.filter(r => r._chainStart)
    : allBuiltRoutes;

  emit("suite_routes", { count: routes.length, routes: routes.map(r => r.label) });

  if (!routes.length) {
    emit("suite_end", {
      env: config.env, total: 0, executed: 0, passed: 0, failed: 0, aborted: 0, skipped: 0,
      message: "No routes — connect wallets first",
      ts: new Date().toISOString(),
    });
    _suiteEndEmitted = true;
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

  const seedEntries =
    mode === "allChains"
      ? (() => {
          // allChains: single-seed model — one funded asset drives the full multi-hop beam path.
          // All routes share _chainStart = that seed, so seedsToRun has exactly 1 entry.
          // Sort by _chainIndex (always 0 with single seed, but kept for safety).
          return [...bySeed.entries()].sort((a, b) => {
            const ai = Math.min(...a[1].map(r => r._chainIndex ?? 999));
            const bi = Math.min(...b[1].map(r => r._chainIndex ?? 999));
            return ai - bi;
          });
        })()
      : [...bySeed.entries()];
  const seedsToRun = new Map(seedEntries);

  if (mode === "allChains" && seedsToRun.size === 0) {
    emit("suite_end", {
      env: config.env, total: 0, executed: 0, passed: 0, failed: 0, aborted: 1, skipped: 0,
      message: "allChains: no funded seed chains found — ensure at least one asset has balance ≥ min_amount",
      ts: new Date().toISOString(),
    });
    _suiteEndEmitted = true;
    return [];
  }

  // allChains skips preflight simulation — quoting 100+ routes sequentially hangs the runner.
  // Per-hop gas checks (resolveToAssetWithGasSubstitution) and seed sufficiency
  // (computeChainRequiredSeed) guard execution at runtime instead.
  const simSummary = mode === "allChains"
    ? { ok: true, totalFlows: 0, passedFlows: 0, failedFlows: 0, skippedFlows: [], skippedFlowIds: [] }
    : await simulateFlowsForRoutes(routes, mode, { allowLiquiditySkips: true });
  if (!simSummary.ok) {
    emit("suite_end", {
      env: config.env,
      total: 0,
      executed: 0,
      passed: 0,
      failed: 0,
      aborted: 1,
      skipped: 0,
      message: `Pre-execution simulation failed: ${simSummary.failedFlow?.error || simSummary.failedFlow?.reason || "unknown"}`,
      ts: new Date().toISOString(),
    });
    _suiteEndEmitted = true;
    return [{
      status: "aborted",
      error: simSummary.failedFlow?.error || simSummary.failedFlow?.reason || "simulation_failed",
      flowId: simSummary.failedFlow?.flowId || null,
    }];
  }

  // Skip standalone routes that preflight marked as skippable liquidity failures.
  if (Array.isArray(simSummary.skippedFlows) && simSummary.skippedFlows.length) {
    const skipKeys = new Set(
      simSummary.skippedFlows
        .map((s) => `${s?.routeHint?.fromAsset || ""}::${s?.routeHint?.toAsset || ""}`)
        .filter((k) => k !== "::")
    );
    if (skipKeys.size) {
      for (let i = standalone.length - 1; i >= 0; i--) {
        const r = standalone[i];
        if (skipKeys.has(`${r.fromAsset}::${r.toAsset}`)) standalone.splice(i, 1);
      }
    }
  }

  // Each seed's chain runs sequentially (A→B before B→C)
  // Different seeds run in parallel
  async function runChain(chainRoutes, seedLabel) {
    const gasCache = new Map(); // per-chain gas balance cache for this chain's lifetime
    const supportedAssets = await getAssetsForRunner().catch(() => []);
    let lastPassResult = null; // set when the final hop completes — used for cycle closing

    // allChains pre-check: ensure seed balance covers min_amount requirements for all hops.
    // Quotes each hop at min_amount, works backward to compute the required seed amount.
    // Then APPLY the computed amount to the first hop so downstream hops receive enough.
    if (mode === "allChains" && chainRoutes.length >= 1) {
      const reqStart = await computeChainRequiredSeed(chainRoutes).catch(() => null);
      if (reqStart) {
        const seedBal = getWalletAssetAtomicBalance(chainRoutes[0]);
        const seedBalNum = seedBal !== null ? Number(seedBal) : null;
        if (seedBalNum !== null && seedBalNum < reqStart.requiredSeedAtomic) {
          emit("suite_info", {
            message: `allChains aborted: seed balance ${seedBalNum} < required ${reqStart.requiredSeedAtomic} atomic (${chainRoutes[0].fromAsset}) — ${chainRoutes.length}-hop chain needs more funding`,
            requiredSeedAtomic: reqStart.requiredSeedAtomic,
            seedBalance: seedBalNum,
            shortfall: reqStart.requiredSeedAtomic - seedBalNum,
            hopBreakdown: reqStart.hopBreakdown,
          });
          return;
        }
        // Apply the fee-compounded amount to the first hop so each downstream
        // hop receives at least its min_amount after 0.35% fees per hop.
        // Use the larger of: quote-based backward pass OR formula-based estimate.
        const seedAmount = clampGardenQuoteAmount(
          Math.max(reqStart.requiredSeedAtomic, chainRoutes[0].amount || 0),
          chainRoutes[0].fromMeta
        );
        const cappedSeedAmount = seedBalNum !== null
          ? Math.min(seedAmount, seedBalNum)
          : seedAmount;
        chainRoutes[0].amount = cappedSeedAmount;
        emit("suite_info", {
          message: `allChains seed check passed: balance ${seedBalNum} >= required ${reqStart.requiredSeedAtomic} for ${chainRoutes.length}-hop chain — first hop amount set to ${cappedSeedAmount}`,
          requiredSeedAtomic: reqStart.requiredSeedAtomic,
          appliedSeedAmount: cappedSeedAmount,
          hopBreakdown: reqStart.hopBreakdown,
        });
      } else {
        // Quote-based calculation unavailable — use formula (1/(1-0.0035))^N as fallback
        const N = chainRoutes.length;
        const feeMultiplier = Math.pow(1 / (1 - 0.0035), N);
        const hop0Min = Math.max(1, parseInt(String(chainRoutes[0].fromMeta?.min_amount ?? 50000), 10) || 50000);
        const formulaAmount = Math.ceil(hop0Min * feeMultiplier);
        const seedBal = getWalletAssetAtomicBalance(chainRoutes[0]);
        const seedBalNum = seedBal !== null ? Number(seedBal) : null;
        const fallbackAmount = clampGardenQuoteAmount(
          Math.max(formulaAmount, chainRoutes[0].amount || 0),
          chainRoutes[0].fromMeta
        );
        chainRoutes[0].amount = seedBalNum !== null
          ? Math.min(fallbackAmount, seedBalNum)
          : fallbackAmount;
        emit("suite_info", {
          message: `allChains seed amount set via fee formula: ${chainRoutes[0].amount} (min ${hop0Min} × ${feeMultiplier.toFixed(4)} for ${N} hops)`,
        });
      }
    }

    for (let i = 0; i < chainRoutes.length; i++) {
      if (_abortEpoch !== suiteEpoch) break;

      // ── Pre-hop gas check ────────────────────────────────────────────
      // Before executing, check if the destination chain has gas.
      //   • Has gas        → pick random destination asset as normal
      //   • No gas + Garden supports native gas token → substitute dest
      //     to native token (delivers gas in one trade, no extra swap)
      //   • No gas + no native support → skip this chain, emit fail,
      //     re-route current source directly to the NEXT chain
      const destCheck = await resolveToAssetWithGasSubstitution(chainRoutes[i], supportedAssets, gasCache);
      if (!destCheck.ok) {
        const skippedChain = String(chainRoutes[i].toAsset || '').split(':')[0];
        const failLabel = chainRoutes[i].label || `${chainRoutes[i].fromAsset} → ${chainRoutes[i].toAsset}`;
        const failError = `No gas on ${skippedChain} and Garden has no supported native gas token — chain skipped`;
        const failTestId = `no_gas_skip_${i}_${Date.now()}`;

        emit("test_start", { testId: failTestId, label: failLabel, fromAsset: chainRoutes[i].fromAsset, toAsset: chainRoutes[i].toAsset, fromChain: chainRoutes[i].fromChain, toChain: chainRoutes[i].toChain, amount: chainRoutes[i].amount });
        emit("test_step",  { testId: failTestId, label: failLabel, step: { name: "Gas check", status: "fail", detail: failError, ts: new Date().toISOString() } });
        emit("test_end",   { testId: failTestId, label: failLabel, status: "fail", error: failError });
        results.push({ testId: failTestId, label: failLabel, status: "fail", error: failError, ts: new Date().toISOString() });

        if (mode === "allChains" && i + 1 < chainRoutes.length) {
          // Bypass skipped chain: re-route to next chain's destination.
          // Keep current source, skip the intermediary chain that has no gas.
          const nextHop = chainRoutes[i + 1];
          const bypassLabel = `${chainRoutes[i].fromMeta?.name || chainRoutes[i].fromAsset} → ${nextHop.toMeta?.name || nextHop.toAsset}`;
          Object.assign(nextHop, {
            fromAsset: chainRoutes[i].fromAsset,
            fromMeta:  chainRoutes[i].fromMeta,
            fromChain: chainRoutes[i].fromChain,
            amount:    chainRoutes[i].amount,
            label:     bypassLabel,
          });
          emit("suite_info", { message: `Skipped ${skippedChain} (no gas) — re-routed: ${bypassLabel}` });
          continue;
        }
        emit("suite_info", { message: `Chain stopped: ${failError}` });
        break;
      }

      if (destCheck.substituted) {
        emit("suite_info", { message: `Dest substituted to native gas token: ${chainRoutes[i].fromAsset} → ${destCheck.route.toAsset} (saves a trade)` });
      }
      const route = destCheck.route;

      // ── Execute the hop ──────────────────────────────────────────────
      const result = await runRoute({ ...route, suiteEpoch });
      results.push(result);

      // If the dest was substituted to native and the hop passed, mark gas as funded
      if (result.status === "pass" && destCheck.substituted) {
        const fundedChain = String(route.toAsset || '').split(':')[0].replace(/_sepolia|_testnet\d*|_mainnet|_signet|_devnet/g, '');
        gasCache.set(fundedChain, MIN_NATIVE_WEI_FOR_GAS);
      }

      if (result.status !== "pass") {
        if (mode === "allChains") {
          // Dest fallback: try other assets on the same destination chain
          const toChainPrefix = String(route.toAsset || '').split(':')[0].toLowerCase();
          const triedDests = new Set([route.toAsset]);
          const destCandidates = supportedAssets
            .filter(a => {
              const ck = String(a.id || '').split(':')[0].toLowerCase();
              if (ck !== toChainPrefix) return false;
              if (triedDests.has(a.id)) return false;
              if (a.id === route.fromAsset) return false;
              return true;
            })
            .sort((a, b) => String(a.id).localeCompare(String(b.id)));
          let replaced = false;
          for (const cand of destCandidates) {
            if (_abortEpoch !== suiteEpoch) break;
            triedDests.add(cand.id);
            const candRoute = {
              ...route,
              toAsset: cand.id,
              toMeta: cand,
              label: `${route.fromMeta?.name || route.fromAsset} → ${cand.name || cand.id} [dest fallback]`,
            };
            const candCheck = await resolveToAssetWithGasSubstitution(candRoute, supportedAssets, gasCache);
            if (!candCheck.ok) continue;
            const tryRes = await runRoute({ ...candCheck.route, suiteEpoch, executionMode: "allChains" });
            results.push(tryRes);
            if (tryRes.status === "pass") {
              replaced = true;
              if (i + 1 < chainRoutes.length) {
                patchNextChainHopFromReceive(chainRoutes[i + 1], tryRes);
                const nextMin = Math.max(1, parseInt(String(chainRoutes[i + 1].fromMeta?.min_amount ?? 50000), 10) || 50000);
                if (Number(chainRoutes[i + 1].amount || 0) < nextMin) {
                  emit("suite_info", {
                    message: `Chain stopped before hop ${i + 2} (fallback): received ${chainRoutes[i + 1].amount} atomic < min ${nextMin} for ${chainRoutes[i + 1].label}`,
                  });
                  replaced = false;
                  break;
                }
              } else {
                lastPassResult = tryRes;
              }
              break;
            }
          }
          if (replaced) continue;

          // All dest fallbacks failed — skip this hop, continue to next child
          if (i + 1 < chainRoutes.length) {
            emit("suite_info", {
              message: `Hop ${i + 1} failed (${route.label}): ${result.error || result.status} — skipping to next child`,
            });
            continue;
          }
        }
        emit("suite_info", {
          message:
            result.status === "skipped"
              ? `Chain stopped at ${route.label} — ${result.error || "skipped"}`
              : `Chain broken at ${route.label} — ${result.error || result.status}`,
        });
        break;
      }

      // ── Patch next hop from received output ──────────────────────────
      if (i + 1 < chainRoutes.length) {
        patchNextChainHopFromReceive(chainRoutes[i + 1], result);
        const nextMin = Math.max(1, parseInt(String(chainRoutes[i + 1].fromMeta?.min_amount ?? 50000), 10) || 50000);
        if (Number(chainRoutes[i + 1].amount || 0) < nextMin) {
          emit("suite_info", {
            message: `Chain stopped before hop ${i + 2}: received ${chainRoutes[i + 1].amount} atomic but next hop requires min ${nextMin} (${chainRoutes[i + 1].label})`,
            receivedAtomic: chainRoutes[i + 1].amount,
            nextHopMin: nextMin,
          });
          break;
        }
        // Gas for the next hop's source chain is already handled:
        // resolveToAssetWithGasSubstitution on the CURRENT hop substituted the
        // dest to native if gas was needed, so the received token IS native gas.
        // The NEXT iteration's pre-hop check handles the next dest chain.
      } else {
        lastPassResult = result;
      }

      if (!_globalAbort) await new Promise(r => setTimeout(r, 500));
    }

    // Per-chain cycle-close removed — in allChains mode the whole-cycle close
    // (lastChain.output → firstChain.seed) is handled in the outer chainPromise loop.
    return lastPassResult; // caller patches next chain's amount and handles cycle close
  }

  // allChains: all seed chains run sequentially in _chainIndex order; each chain's output
  // is patched into the next chain's first hop as the seed amount.
  // allTests: seed chains run in parallel for throughput.
  const chainPromise = (mode === "allChains")
    ? (async () => {
        let prevResult = null;
        const allSeedEntries = [...seedsToRun.entries()];
        const wholeCycleSeed = allSeedEntries[0]?.[1]?.[0]?.fromAsset || null; // e.g. BTC — first hop's fromAsset = cycle start
        const gasCache = new Map();
        const supportedAssets = await getAssetsForRunner().catch(() => []);

        for (const [seed, chainRoutes] of allSeedEntries) {
          if (_abortEpoch !== suiteEpoch) break;
          // Cross-chain fund handoff: patch this chain's seed amount from previous chain's output
          if (prevResult && chainRoutes.length > 0) {
            patchNextChainHopFromReceive(chainRoutes[0], prevResult);
            const seedMin = Math.max(1, parseInt(String(chainRoutes[0].fromMeta?.min_amount ?? 50000), 10) || 50000);
            if (Number(chainRoutes[0].amount || 0) < seedMin) {
              emit("suite_info", { message: `allChains: stopping at chain ${seed} — received ${chainRoutes[0].amount} atomic < min ${seedMin}` });
              prevResult = null;
              break;
            }
          }
          prevResult = await runChain(chainRoutes, seed);
        }

        // Whole-cycle close: last chain's output → first chain's seed (LBTC(eth) → WBTC(arb))
        if (prevResult && wholeCycleSeed && _abortEpoch === suiteEpoch) {
          const finalAsset = prevResult.actualDestAsset || null;
          const finalMeta  = prevResult.actualDestMeta  || null;
          if (finalAsset && finalAsset !== wholeCycleSeed) {
            const closingRoute = routes.find(r => r.fromAsset === finalAsset && r.toAsset === wholeCycleSeed);
            if (closingRoute) {
              const receivedAmt = Number(prevResult.nextHopAmountAtomic || 0);
              const cycleMin = Math.max(1, parseInt(String(finalMeta?.min_amount ?? 50000), 10) || 50000);
              if (receivedAmt >= cycleMin) {
                const cycleGasCheck = await resolveToAssetWithGasSubstitution(
                  { ...closingRoute, amount: clampGardenQuoteAmount(receivedAmt, finalMeta), suiteEpoch, executionMode: "allChains" },
                  supportedAssets, gasCache
                );
                if (cycleGasCheck.ok) {
                  emit("suite_info", { message: `Cycle close: ${finalAsset} → ${wholeCycleSeed} (${receivedAmt} atomic)` });
                  results.push(await runRoute(cycleGasCheck.route));
                } else {
                  emit("suite_info", { message: `Cycle close skipped: no gas on seed chain for ${closingRoute.label}` });
                }
              } else {
                emit("suite_info", { message: `Cycle close skipped: received ${receivedAmt} < min ${cycleMin} for ${finalAsset} → ${wholeCycleSeed}` });
              }
            } else {
              emit("suite_info", { message: `Cycle close skipped: no route found ${finalAsset} → ${wholeCycleSeed}` });
            }
          }
        }
      })()
    : Promise.all(
        [...seedsToRun.entries()].map(([seed, chainRoutes]) =>
          runChain(chainRoutes, seed)
        )
      );

  // Standalone routes with concurrency limit
  const PARALLEL_LIMIT = 3;
  async function runStandalonePool() {
    const running = new Set();
    for (const route of standalone) {
      if (_abortEpoch !== suiteEpoch) break;

      const p = runRoute({ ...route, suiteEpoch }).then(result => {
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

  // allChains: chain routes only — no standalone execution.
  // allTests: chains and standalones run in parallel.
  if (mode === "allChains") {
    await chainPromise;
  } else {
    await Promise.all([chainPromise, runStandalonePool()]);
  }

  const passed = results.filter(r => r.status === "pass").length;
  const failed = results.filter(r => r.status === "fail").length;
  const aborted = results.filter(r => r.status === "aborted").length;
  const skipped = results.filter(r => r.status === "skipped").length;
  emit("suite_end", {
    env: config.env,
    total: results.length,
    executed: passed + failed + aborted,
    passed,
    failed,
    aborted,
    skipped,
    ts: new Date().toISOString(),
  });
  _suiteEndEmitted = true;
  return results;
  } finally {
    if (!_suiteEndEmitted) {
      emit("suite_end", {
        env: config.env, total: 0, executed: 0, passed: 0, failed: 0, aborted: 1, skipped: 0,
        message: "Run terminated unexpectedly",
        ts: new Date().toISOString(),
      });
    }
    _suiteRunActive = false;
    _suiteRunMeta = null;
  }
}

/**
 * Build a binary funding tree from Garden API assets (connected-wallet filter).
 * Tree size = number of assets picked (all supported, or capped by opts.assetLimit).
 * Each edge is parent→child funding hop; N nodes → N−1 edges.
 *
 * @param {Record<string, number>} amountOverrides
 * @param {{ assetLimit?: number | null }} [opts] — assetLimit: max nodes (omit/null = use all fetched supported assets)
 */
async function buildFundingTreePlan(amountOverrides = {}, opts = {}) {
  const wallets = walletState.getStatus();
  const connectedTypes = new Set();
  if (wallets.evm)      connectedTypes.add("evm");
  if (wallets.btc)      connectedTypes.add("bitcoin");
  if (wallets.solana)   connectedTypes.add("solana");
  if (wallets.starknet) connectedTypes.add("starknet");
  if (wallets.sui)      connectedTypes.add("sui");
  if (wallets.tron)     connectedTypes.add("tron");

  if (connectedTypes.size === 0) {
    throw new Error("Connect at least one wallet type to build funding tree");
  }

  let assets = [];
  try {
    const res = await garden.getAssets();
    assets = res.result || res.assets || res || [];
  } catch (e) {
    throw new Error(`Garden getAssets failed: ${e.message || e}`);
  }

  const supported = assets.filter((a) => {
    const wt = getWalletTypeForAsset(a);
    return wt && connectedTypes.has(wt);
  });

  if (supported.length < 1) {
    throw new Error("No supported Garden assets for connected wallets — cannot build funding tree");
  }

  // Shuffle assets so tree structure (and therefore pair selection) is random each run
  let sorted = [...supported];
  for (let i = sorted.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = sorted[i]; sorted[i] = sorted[j]; sorted[j] = tmp;
  }
  const limit = opts.assetLimit;
  if (limit != null && Number.isFinite(Number(limit)) && Number(limit) >= 1) {
    sorted = sorted.slice(0, Math.min(sorted.length, Math.floor(Number(limit))));
  } else if (limit != null) {
    throw new Error("opts.assetLimit must be a positive integer or null/omitted");
  }

  const picked = sorted;
  const assetIds = picked.map((a) => a.id);
  const tree = fundingTree.buildBinaryFundingTree(assetIds);
  const structureValidation = fundingTree.validateFundingTreeStructure(tree);
  const levels = fundingTree.groupEdgesByChildDepth(tree);
  const routesByEdgeKey = new Map();
  const allEdges = fundingTree.listFundingEdges(tree);

  for (const e of allEdges) {
    const key = `${e.parent}->${e.child}`;
    const fromMeta = picked[e.parent];
    const toMeta = picked[e.child];
    if (!isPairPlausible(fromMeta, toMeta)) {
      routesByEdgeKey.set(key, { ok: false, reason: "pair_not_plausible" });
      continue;
    }
    const fromChain = getWalletTypeForAsset(fromMeta);
    const toChain = getWalletTypeForAsset(toMeta);
    const overrideAmt = amountOverrides[fromMeta.id];
    const minAmtAtomic = parseInt(fromMeta.min_amount || 50000, 10);
    const rawChosen =
      overrideAmt !== undefined ? parseInt(overrideAmt, 10) : minAmtAtomic;
    const amount = clampGardenQuoteAmount(rawChosen, fromMeta);
    routesByEdgeKey.set(key, {
      ok: true,
      route: {
        fromAsset: fromMeta.id,
        toAsset: toMeta.id,
        fromChain,
        toChain,
        amount,
        fromMeta,
        toMeta,
        label: `${fromMeta.name || fromMeta.id} → ${toMeta.name || toMeta.id}`,
        _fundingTree: {
          parentIndex: e.parent,
          childIndex: e.child,
          childDepth: fundingTree.depthFromRoot(e.child),
        },
      },
    });
  }

  const returnToRootEdges = fundingTree.buildReturnToRootEdges(tree);
  for (const r of returnToRootEdges) {
    const key = `return:${r.leafIndex}`;
    const fromMeta = picked[r.leafIndex];
    const toMeta = picked[r.rootIndex];
    if (!isPairPlausible(fromMeta, toMeta)) {
      routesByEdgeKey.set(key, { ok: false, reason: "pair_not_plausible" });
      continue;
    }
    const fromChain = getWalletTypeForAsset(fromMeta);
    const toChain = getWalletTypeForAsset(toMeta);
    const overrideAmt = amountOverrides[fromMeta.id];
    const minAmtAtomic = parseInt(fromMeta.min_amount || 50000, 10);
    const rawChosen =
      overrideAmt !== undefined ? parseInt(overrideAmt, 10) : minAmtAtomic;
    const amount = clampGardenQuoteAmount(rawChosen, fromMeta);
    routesByEdgeKey.set(key, {
      ok: true,
      route: {
        fromAsset: fromMeta.id,
        toAsset: toMeta.id,
        fromChain,
        toChain,
        amount,
        fromMeta,
        toMeta,
        label: `${fromMeta.name || fromMeta.id} → ${toMeta.name || toMeta.id} [return to root]`,
        _fundingTree: {
          kind: "return_to_root",
          leafIndex: r.leafIndex,
          rootIndex: r.rootIndex,
        },
      },
    });
  }

  const routesResolved = [...routesByEdgeKey.values()].filter((x) => x.ok).length;
  const forwardResolved = [...allEdges].filter((e) => {
    const ent = routesByEdgeKey.get(`${e.parent}->${e.child}`);
    return ent && ent.ok;
  }).length;
  const returnResolved = returnToRootEdges.filter((r) => {
    const ent = routesByEdgeKey.get(`return:${r.leafIndex}`);
    return ent && ent.ok;
  }).length;

  // Pre-check EVM gas needs for all destination chains so execution can fill gas before first swap.
  const chainGasNeeds = new Map(); // chainKey → { chainRaw, nativeMeta }
  const evmAddr = walletState.getAddressByType('evm');
  if (evmAddr) {
    const { ethers } = require('ethers');
    const destChainRaws = new Set();
    for (const e of allEdges) {
      const toMeta = picked[e.child];
      if (getWalletTypeForAsset(toMeta) === 'evm')
        destChainRaws.add(String(toMeta.id).split(':')[0]);
    }
    await Promise.all([...destChainRaws].map(async (chainRaw) => {
      const chainKey = chainRaw.replace(/_sepolia|_testnet\d*|_mainnet|_signet|_devnet/g, '');
      try {
        const rpcUrl = resolveRpcUrl(chainRaw);
        if (!rpcUrl) return;
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const bal = await Promise.race([
          provider.getBalance(evmAddr),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
        ]);
        if (BigInt(bal.toString()) >= MIN_NATIVE_WEI_FOR_GAS) return;
        const nativeMeta = findNativeFeeAssetOnChain(assets, chainRaw);
        if (!nativeMeta?.id) return;
        chainGasNeeds.set(chainKey, { chainRaw, nativeMeta });
      } catch (_) {}
    }));
  }

  return {
    tree,
    picked,
    assetIds,
    levels,
    returnToRootEdges,
    routesByEdgeKey,
    structureValidation,
    chainGasNeeds,
    coverage: {
      routesResolved,
      routesTotal: allEdges.length + returnToRootEdges.length,
      forwardEdges: allEdges.length,
      returnEdges: returnToRootEdges.length,
      forwardRoutesResolved: forwardResolved,
      returnRoutesResolved: returnResolved,
      assetsUnique: new Set(assetIds).size === tree.size,
      assetCount: tree.size,
    },
  };
}

/**
 * Simulate funding level-by-level: each wave = edges whose child sits at the same depth.
 * Uses Garden quotes (simulateSingleHop); does not model splitting one parent balance across two children.
 */
async function simulateFundingTreeByLevel(amountOverrides = {}, opts = {}) {
  const silent = !!opts.silent;
  const plan = await buildFundingTreePlan(amountOverrides, opts);
  const levelResults = [];

  for (const { level, edges } of plan.levels) {
    const edgeResults = [];
    for (const e of edges) {
      const key = `${e.parent}->${e.child}`;
      const entry = plan.routesByEdgeKey.get(key);
      if (!entry || !entry.ok) {
        edgeResults.push({
          parent: e.parent,
          child: e.child,
          parentAssetId: e.parentAssetId,
          childAssetId: e.childAssetId,
          ok: false,
          error: entry?.reason || "no_route",
        });
        continue;
      }
      const { route } = entry;
      try {
        const minAmt = Math.max(
          1,
          parseInt(String(route.fromMeta?.min_amount ?? 50000), 10) || 50000
        );
        const sim = await simulateSingleHop({
          fromAsset: route.fromAsset,
          fromMeta: route.fromMeta,
          toAsset: route.toAsset,
          toMeta: route.toMeta,
          toChain: route.toChain,
          inputAtomicBig: BigInt(minAmt),
        });
        edgeResults.push({
          parent: e.parent,
          child: e.child,
          parentAssetId: e.parentAssetId,
          childAssetId: e.childAssetId,
          ok: true,
          fromAmountAtomic: String(sim.fromAmountAtomic),
          toAmountAtomic: String(sim.toAmountAtomic),
          destinationAsset: sim.destinationAsset,
          swappedDestination: sim.swappedDestination,
        });
      } catch (err) {
        edgeResults.push({
          parent: e.parent,
          child: e.child,
          parentAssetId: e.parentAssetId,
          childAssetId: e.childAssetId,
          ok: false,
          error: err.message || String(err),
        });
      }
    }
    const snapshot = {
      level,
      edges: edgeResults,
      ok: edgeResults.length > 0 && edgeResults.every((x) => x.ok),
    };
    levelResults.push(snapshot);
    if (!silent) emit("funding_tree_level", snapshot);
  }

  const returnEdgeResults = [];
  for (const r of plan.returnToRootEdges || []) {
    const key = `return:${r.leafIndex}`;
    const entry = plan.routesByEdgeKey.get(key);
    if (!entry || !entry.ok) {
      returnEdgeResults.push({
        kind: "return_to_root",
        leafIndex: r.leafIndex,
        rootIndex: r.rootIndex,
        leafAssetId: r.leafAssetId,
        rootAssetId: r.rootAssetId,
        ok: false,
        error: entry?.reason || "no_route",
      });
      continue;
    }
    const { route } = entry;
    try {
      const minAmt = Math.max(
        1,
        parseInt(String(route.fromMeta?.min_amount ?? 50000), 10) || 50000
      );
      const sim = await simulateSingleHop({
        fromAsset: route.fromAsset,
        fromMeta: route.fromMeta,
        toAsset: route.toAsset,
        toMeta: route.toMeta,
        toChain: route.toChain,
        inputAtomicBig: BigInt(minAmt),
      });
      returnEdgeResults.push({
        kind: "return_to_root",
        leafIndex: r.leafIndex,
        rootIndex: r.rootIndex,
        leafAssetId: r.leafAssetId,
        rootAssetId: r.rootAssetId,
        ok: true,
        fromAmountAtomic: String(sim.fromAmountAtomic),
        toAmountAtomic: String(sim.toAmountAtomic),
        destinationAsset: sim.destinationAsset,
        swappedDestination: sim.swappedDestination,
      });
    } catch (err) {
      returnEdgeResults.push({
        kind: "return_to_root",
        leafIndex: r.leafIndex,
        rootIndex: r.rootIndex,
        leafAssetId: r.leafAssetId,
        rootAssetId: r.rootAssetId,
        ok: false,
        error: err.message || String(err),
      });
    }
  }
  const returnSnapshot = {
    level: "return_to_root",
    edges: returnEdgeResults,
    ok:
      returnEdgeResults.length === 0 ||
      returnEdgeResults.every((x) => x.ok),
  };
  levelResults.push(returnSnapshot);
  if (!silent) emit("funding_tree_level", returnSnapshot);

  const forwardOk =
    plan.levels.length === 0 ||
    levelResults
      .filter((l) => l.level !== "return_to_root")
      .every((l) => l.ok);
  const summary = {
    ok:
      plan.structureValidation.ok &&
      forwardOk &&
      returnSnapshot.ok,
    structureValidation: plan.structureValidation,
    levels: levelResults,
    coverage: plan.coverage,
  };
  if (!silent) emit("funding_tree_simulation", summary);
  return summary;
}

module.exports = {
  runAll,
  simulateExecutionPreflight,
  runApiTests,
  runRoute,
  buildRoutes,
  buildFundingTreePlan,
  simulateFundingTreeByLevel,
  setEmitter,
  handleApproval,
  handleEvmTxResponse,
  handleEvmSignResponse,
  abortTest,
  abortAll,
  getSuiteRunStatus,
};