// src/server.js
const express    = require("express");
const http       = require("http");
const WebSocket  = require("ws");
const cors       = require("cors");
const path       = require("path");
const axios      = require("axios");
const config      = require("./config");
const runner      = require("./tests/runner");
const garden      = require("./api/garden");
const walletState = require("./wallet/state");
const envkey      = require("./wallet/envkey");
const arbitrageAgent = require("./agents/arbitrageAgent");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../dashboard")));

const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: '/ws' });

function broadcast(event, data) {
  const msg = JSON.stringify({ event, data, ts: new Date().toISOString() });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}
runner.setEmitter(broadcast);

// ── HEALTH ────────────────────────────────────────────────────
app.get("/api/health", (req, res) => res.json({ status: "ok" }));

// ── CORE TEST ROUTES / BOT STATE ─────────────────────────────
let _amountOverrides = {};

let _arbSummary = {
  totalProfitUsd: 0,
  trades: [],
};

function recordArbTrade(entry) {
  const usdPnl = Number(entry.usdPnl || 0);
  if (!Number.isFinite(usdPnl)) return;
  _arbSummary.totalProfitUsd += usdPnl;
  _arbSummary.trades.unshift({
    ...entry,
    usdPnl,
    ts: entry.ts || new Date().toISOString(),
  });
  if (_arbSummary.trades.length > 50) _arbSummary.trades.pop();
}

app.post("/api/run/set-amounts", (req, res) => {
  _amountOverrides = req.body.amounts || {};
  console.log(`[set-amounts] ${Object.keys(_amountOverrides).length} overrides stored`);
  res.json({ ok: true, count: Object.keys(_amountOverrides).length });
});

app.post("/api/run", async (req, res) => {
  res.json({ started: true, env: config.env });
  const overrides = Object.assign({}, _amountOverrides);
  _amountOverrides = {};
  runner.runAll(overrides).catch(err => broadcast("error", { message: err.message }));
});

app.post("/api/run/route", async (req, res) => {
  const { fromChain, toChain } = req.body;
  if (!fromChain || !toChain) return res.status(400).json({ error: "fromChain and toChain required" });
  const from = config.chains[fromChain];
  const to   = config.chains[toChain];
  if (!from || !to) return res.status(400).json({ error: "Unknown chain" });
  res.json({ started: true });
  runner.runRoute({ fromChain, toChain, fromAsset: from.asset, toAsset: to.asset, amount: 50000, label: `${from.name} → ${to.name}` })
    .catch(err => broadcast("error", { message: err.message }));
});

app.post("/api/run/api-tests", async (req, res) => {
  const results = await runner.runApiTests();
  res.json(results);
});

app.post("/api/abort", (req, res) => {
  const { testId } = req.body;
  if (testId) runner.abortTest(testId);
  else runner.abortAll();
  res.json({ ok: true });
});

app.post("/api/approve", (req, res) => {
  runner.handleApproval(req.body.id, req.body.approved);
  res.json({ ok: true });
});

app.post("/api/evm-sign-response", (req, res) => {
  const { id, signature } = req.body;
  if (!id) return res.status(400).json({ error: "id required" });
  runner.handleEvmSignResponse(id, signature || false);
  res.json({ ok: true });
});

app.post("/api/evm-tx-response", (req, res) => {
  runner.handleEvmTxResponse(req.body.id, req.body.txHash || false);
  res.json({ ok: true });
});

app.get("/api/chains", (req, res) => {
  res.json(Object.values(config.chains).map(c => ({
    id: c.id, name: c.name, type: c.type, rpc: c.rpc, explorer: c.explorer, asset: c.asset
  })));
});

app.get("/api/config", (req, res) => {
  res.json({
    env: config.env, isMainnet: config.isMainnet,
    manualApprove: config.manualApprove,
    chainCount: Object.keys(config.chains).length
  });
});

app.post("/api/switch-env", (req, res) => {
  const { env } = req.body;
  if (!["testnet", "mainnet"].includes(env)) return res.status(400).json({ error: "Invalid env" });
  process.env.GARDEN_ENV = env;
  // Clear all caches on env switch
  _cachedAssets = null;
  _validPairsCache = { env: null, ts: 0, pairs: null };
  res.json({ ok: true, message: `Switched to ${env}. Restart the server.` });
});

// ── Asset ID resolver ─────────────────────────────────────────
// CHANGE: No long-lived cache — always fetch fresh assets
let _cachedAssets = null;
let _cachedAssetsTs = 0;
const ASSET_CACHE_TTL = 30 * 1000; // 30 seconds max (was 5 min)

async function getAssets() {
  const now = Date.now();
  // Short TTL to avoid hammering API on rapid calls, but effectively "fresh"
  if (_cachedAssets && (now - _cachedAssetsTs) < ASSET_CACHE_TTL) return _cachedAssets;
  try {
    _cachedAssets = await garden.getAssets();
    _cachedAssetsTs = now;
  } catch (_) {
    _cachedAssets = [];
  }
  return _cachedAssets;
}

// Force-clear asset cache (called before route building)
function clearAssetCache() {
  _cachedAssets = null;
  _cachedAssetsTs = 0;
}

async function resolveAssetId(simplified) {
  if (!simplified) return null;
  const parts = simplified.split(":");
  const chainHint  = parts[0].toLowerCase();
  const tickerHint = (parts[1] || "").toLowerCase();

  const assets = await getAssets();
  const list = assets.result || assets.assets || (Array.isArray(assets) ? assets : []);

  const exactMatch = list.find(a => (a.id || "").toLowerCase() === simplified.toLowerCase());
  if (exactMatch) {
    const walletType = (() => {
      const c = (exactMatch.chain || exactMatch.id?.split(":")[0] || "").toLowerCase();
      if (c.startsWith("bitcoin")) return "bitcoin";
      if (c.startsWith("solana"))  return "solana";
      if (c.startsWith("starknet"))return "starknet";
      if (c.startsWith("tron"))    return "tron";
      if (c.startsWith("sui"))     return "sui";
      return "evm";
    })();
    return { assetId: exactMatch.id, walletType, meta: exactMatch };
  }

  let best = null, bestScore = -1;
  for (const a of list) {
    const id      = (a.id || "").toLowerCase();
    const chain   = (a.chain || id.split(":")[0] || "").toLowerCase();
    const ticker  = (a.asset || a.ticker || id.split(":")[1] || "").toLowerCase();

    const chainMatch = chain === chainHint
      || chain.startsWith(chainHint + "_")
      || chainHint.startsWith(chain + "_")
      || chain.split("_")[0] === chainHint.split("_")[0];
    if (!chainMatch) continue;

    const tickerMatch = !tickerHint || ticker === tickerHint || ticker.includes(tickerHint) || tickerHint.includes(ticker);
    if (!tickerMatch) continue;

    const score = (chain === chainHint ? 2 : 1) + (ticker === tickerHint ? 2 : 1);
    if (score > bestScore) { bestScore = score; best = a; }
  }

  if (!best) return null;

  const walletType = (() => {
    const c = (best.chain || best.id?.split(":")[0] || "").toLowerCase();
    if (c.startsWith("bitcoin")) return "bitcoin";
    if (c.startsWith("solana"))  return "solana";
    if (c.startsWith("starknet"))return "starknet";
    if (c.startsWith("tron"))    return "tron";
    if (c.startsWith("sui"))     return "sui";
    return "evm";
  })();

  return { assetId: best.id, walletType, meta: best };
}

app.post("/api/quote", async (req, res) => {
  const { fromChain, toChain, amount } = req.body;
  if (!fromChain || !toChain) return res.status(400).json({ error: "fromChain and toChain required" });

  try {
    let fromAssetId, toAssetId;
    if (fromChain.includes(":") || toChain.includes(":")) {
      const [fromRes, toRes] = await Promise.all([resolveAssetId(fromChain), resolveAssetId(toChain)]);
      if (!fromRes) return res.status(400).json({ error: `Unknown asset: ${fromChain}` });
      if (!toRes)   return res.status(400).json({ error: `Unknown asset: ${toChain}` });
      fromAssetId = fromRes.assetId;
      toAssetId   = toRes.assetId;
    } else {
      const from = config.chains[fromChain]; const to = config.chains[toChain];
      if (!from || !to) return res.status(400).json({ error: "Unknown chain" });
      fromAssetId = from.asset; toAssetId = to.asset;
    }
    res.json(await garden.getQuote(fromAssetId, toAssetId, amount));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/trade", async (req, res) => {
  const { fromChain, toChain, amount } = req.body;
  if (!fromChain || !toChain || !amount) return res.status(400).json({ error: "fromChain, toChain, amount required" });

  try {
    let fromAssetId, toAssetId, fromWalletType, toWalletType, label;

    if (fromChain.includes(":") || toChain.includes(":")) {
      const [fromRes, toRes] = await Promise.all([resolveAssetId(fromChain), resolveAssetId(toChain)]);
      if (!fromRes) return res.status(400).json({ error: `Unknown asset: ${fromChain}` });
      if (!toRes)   return res.status(400).json({ error: `Unknown asset: ${toChain}` });
      fromAssetId    = fromRes.assetId;
      toAssetId      = toRes.assetId;
      fromWalletType = fromRes.walletType;
      toWalletType   = toRes.walletType;
      label = `Swap: ${fromChain} → ${toChain}`;
    } else {
      const from = config.chains[fromChain]; const to = config.chains[toChain];
      if (!from || !to) return res.status(400).json({ error: "Unknown chain" });
      fromAssetId    = from.asset;
      toAssetId      = to.asset;
      fromWalletType = from.type === "evm" ? "evm" : fromChain;
      toWalletType   = to.type   === "evm" ? "evm" : toChain;
      label = `Swap: ${from.name} → ${to.name}`;
    }

    res.json({ started: true, fromAsset: fromAssetId, toAsset: toAssetId });
    runner.runRoute({
      fromChain: fromWalletType,
      toChain:   toWalletType,
      fromAsset: fromAssetId,
      toAsset:   toAssetId,
      amount:    parseInt(amount),
      label,
    }).catch(err => broadcast("error", { message: err.message }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ASSETS — always fresh ─────────────────────────────────────
app.get("/api/assets", async (req, res) => {
  try {
    // CHANGE: Force fresh fetch
    clearAssetCache();
    res.json(await getAssets());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── HELPER: Get connected wallet types ────────────────────────
function getConnectedWalletTypes() {
  const wallets = walletState.getStatus();
  const types = new Set();
  if (wallets.evm)      types.add("evm");
  if (wallets.btc)      types.add("bitcoin");
  if (wallets.solana)   types.add("solana");
  if (wallets.starknet) types.add("starknet");
  if (wallets.sui)      types.add("sui");
  if (wallets.tron)     types.add("tron");
  return types;
}

// ── HELPER: Determine wallet type for a Garden asset ──────────
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

// ── HELPER: Asset family classification ───────────────────────
function assetFamily(asset) {
  const t = (asset.name || asset.id || '').toLowerCase().split(':').pop();
  if (/btc$|^btc|wbtc|cbtc|cbbtc|sbtc|hbtc|btcn|lbtc|tbtc|pbtc|rbtc/.test(t)) return 'btc';
  if (/^eth$|^weth$/.test(t)) return 'eth';
  if (/usdc|usdt|dai|busd/.test(t)) return 'stable';
  if (/^ltc$|^wltc$|^cbltc$/.test(t)) return 'ltc';
  return 'other_' + t;
}

// ── HELPER: Check if pair is plausible per Garden route policy ─
// Per docs: /policy returns isolation_groups and blacklist_pairs
// BTC family only trades with BTC family (isolation group)
function isPairPlausible(from, to) {
  const ff = assetFamily(from), tf = assetFamily(to);
  if (ff === tf) return true;
  if (ff === 'btc' && tf !== 'btc') return false;
  if (tf === 'btc' && ff !== 'btc') return false;
  return true;
}

// ── HELPER: Build routes from assets + connected wallets ──────
// CHANGE: Always fresh — no valid-pairs cache filtering
async function buildRoutesForReadiness() {
  const connectedTypes = getConnectedWalletTypes();
  if (connectedTypes.size === 0) return { routes: [], connectedTypes };

  // Always fetch fresh assets
  clearAssetCache();
  const ar = await getAssets();
  const assets = ar.result || ar.assets || ar || [];
  if (!assets.length) return { routes: [], connectedTypes };

  // CHANGE: Only include assets whose wallet type is connected
  const supported = assets.filter(a => {
    const wt = getWalletTypeForAsset(a);
    return wt && connectedTypes.has(wt);
  });

  const routes = [];
  for (const from of supported) {
    for (const to of supported) {
      if (from.id === to.id) continue;
      if (!isPairPlausible(from, to)) continue;
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

  return { routes, connectedTypes, supported };
}

// ── HELPER: Gather balances for readiness calculation ─────────
async function gatherBalances(connectedTypes, supported) {
  const wallets = walletState.getStatus();
  const balanceMap = new Map();
  const gasMap     = new Map();

  // Cached token balances from wallet panel
  const cached = wallets.evm?.tokenBalances || {};
  for (const [assetId, bal] of Object.entries(cached)) {
    balanceMap.set(assetId, Number(bal));
  }

  // BTC balance
  if (wallets.btc?.balance && wallets.btc.balance !== 'unknown') {
    const sats = Math.floor(parseFloat(wallets.btc.balance) * 1e8);
    for (const a of (supported || [])) {
      if (getWalletTypeForAsset(a) === 'bitcoin') balanceMap.set(a.id, sats);
    }
  }

  // EVM native gas balances
  const evmAddress = wallets.evm?.address;
  if (evmAddress) {
    const { ethers } = require('ethers');
    const chainConf = require('./config').chains || {};
    const RPC_FALLBACK = {
      base:'https://sepolia.base.org', ethereum:'https://rpc.sepolia.org',
      arbitrum:'https://sepolia-rollup.arbitrum.io/rpc',
      bnbchain:'https://data-seed-prebsc-1-s1.binance.org:8545',
      hyperevm:'https://rpc.hyperliquid-testnet.xyz/evm',
      monad:'https://testnet-rpc.monad.xyz',
      citrea:'https://rpc.testnet.citrea.xyz', alpen:'https://rpc.testnet.alpen.xyz',
    };

    const evmChainKeys = new Set();
    for (const a of (supported || [])) {
      if (getWalletTypeForAsset(a) === 'evm') {
        evmChainKeys.add(a.id.split(':')[0].replace(
          /_sepolia|_testnet\d*|_mainnet|_signet|_devnet/g, ''
        ));
      }
    }

    await Promise.all([...evmChainKeys].map(async (ck) => {
      try {
        const rpc = chainConf[ck]?.rpc || RPC_FALLBACK[ck];
        if (!rpc) return;
        const provider = new ethers.JsonRpcProvider(rpc);
        const bal = await Promise.race([
          provider.getBalance(evmAddress),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
        ]);
        gasMap.set(ck, BigInt(bal.toString()));
      } catch (_) {}
    }));
  }

  return { balanceMap, gasMap };
}

// ── TRADE COMBINATIONS ────────────────────────────────────────
async function buildCombinationsResponse() {
  const wallets = walletState.getStatus();

  // CHANGE: Always fresh assets
  clearAssetCache();
  const ar      = await getAssets();
  const assets  = ar.result || ar.assets || ar || [];
  if (!assets.length) return { ok: true, total: 0, combinations: [], pairsValidated: false, totalBeforeFilter: 0 };

  function getWalletType(asset) {
    const chain   = (asset.chain || "").toLowerCase();
    const prefix  = (asset.id    || "").split(":")[0].toLowerCase();
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

  function isWalletConnected(t) {
    return { evm: !!wallets.evm, bitcoin: !!wallets.btc, solana: !!wallets.solana,
             starknet: !!wallets.starknet, sui: !!wallets.sui, tron: !!wallets.tron }[t] || false;
  }

  // CHANGE: Filter out assets whose wallet is not connected
  const supported = assets.filter(a => {
    const wt = getWalletType(a);
    return wt && isWalletConnected(wt);
  });

  console.log(`[combinations] assets: ${assets.length}, connected+supported: ${supported.length}`);
  const combinations = [];

  for (const from of supported) {
    for (const to of supported) {
      if (from.id === to.id) continue;
      if (!isPairPlausible(from, to)) continue;

      const fromType      = getWalletType(from);
      const toType        = getWalletType(to);
      const fromConnected = isWalletConnected(fromType);
      const toConnected   = isWalletConnected(toType);
      const minAmount     = parseInt(from.min_amount || 50000);
      const maxAmount     = parseInt(from.max_amount || 1000000);

      let walletBalance = null;
      let canAfford     = null;

      if (fromType === "bitcoin" && wallets.btc?.balance && wallets.btc.balance !== "unknown") {
        walletBalance = Math.floor(parseFloat(wallets.btc.balance) * 1e8);
        canAfford = walletBalance >= minAmount;
      } else if (fromType === "solana" && wallets.solana?.balance) {
        walletBalance = parseFloat(wallets.solana.balance);
        canAfford = walletBalance >= minAmount;
      } else if (fromType === "evm" && wallets.evm?.address) {
        const evmBal = wallets.evm?.tokenBalances?.[from.id];
        if (evmBal !== undefined) {
          walletBalance = evmBal;
          canAfford = walletBalance >= minAmount;
        }
      }

      const suggested = (walletBalance !== null && canAfford !== false)
        ? Math.max(minAmount, Math.min(walletBalance, maxAmount))
        : minAmount;

      const balanceKnown = walletBalance !== null;
      const canTrade = fromConnected && toConnected;

      combinations.push({
        id: `${from.id}->${to.id}`,
        from: { assetId: from.id, name: from.name, chain: from.chain, icon: from.icon, walletType: fromType, decimals: from.decimals },
        to:   { assetId: to.id,   name: to.name,   chain: to.chain,   icon: to.icon,   walletType: toType,   decimals: to.decimals },
        minAmount, maxAmount, suggestedAmount: suggested,
        fromWalletConnected: fromConnected,
        toWalletConnected:   toConnected,
        canTrade,
        canAfford,
        balanceKnown,
        walletBalance,
      });
    }
  }

  // CHANGE: No valid-pairs cache filtering — always show all connected combos
  combinations.sort((a, b) => {
    if (a.canTrade && !b.canTrade) return -1;
    if (!a.canTrade && b.canTrade) return 1;
    const ap = a.fromWalletConnected || a.toWalletConnected;
    const bp = b.fromWalletConnected || b.toWalletConnected;
    if (ap && !bp) return -1;
    if (!ap && bp) return 1;
    return a.from.name.localeCompare(b.from.name);
  });

  return {
    ok: true,
    total: combinations.length,
    combinations,
    pairsValidated: false,
    totalBeforeFilter: combinations.length,
  };
}

app.get("/api/combinations", async (req, res) => {
  try {
    const payload = await buildCombinationsResponse();
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ROUTE READINESS — chain-reaction aware ───────────────────
app.get("/api/route-readiness", async (req, res) => {
  try {
    const { routes, connectedTypes, supported } = await buildRoutesForReadiness();

    if (!routes.length) {
      return res.json({
        assets: [], totalRoutes: 0, runnableRoutes: 0, readinessPct: 100,
        flowChains: [], clusters: [], walletCoverage: null,
      });
    }

    const { balanceMap, gasMap } = await gatherBalances(connectedTypes, supported);

    // CHANGE: Pass connectedWalletTypes so optimizer filters disconnected assets
    const routeOptimizerAgent = require('./agents/routeOptimizerAgent');
    res.json(routeOptimizerAgent.getRouteReadiness(routes, {
      balances: balanceMap,
      gasBalances: gasMap,
      connectedWalletTypes: connectedTypes,
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── VALID PAIR CACHE — kept but never blocks route building ──
// CHANGE: This is now optional — routes are NEVER filtered by this cache
// It only serves the UI "Validate Pairs" button for informational purposes
let _validPairsCache = { env: null, ts: 0, pairs: null };
let _validatingInProgress = false;

app.get("/api/valid-pairs", async (req, res) => {
  const now = Date.now();
  const CACHE_MS = 10 * 60 * 1000;

  if (_validPairsCache.env === config.env && _validPairsCache.pairs && now - _validPairsCache.ts < CACHE_MS) {
    return res.json({ ok: true, pairs: [..._validPairsCache.pairs], cached: true,
      age: Math.round((now - _validPairsCache.ts) / 1000) });
  }
  if (_validatingInProgress) {
    return res.json({ ok: true, pairs: [], inProgress: true });
  }

  res.json({ ok: true, pairs: [], started: true });

  _validatingInProgress = true;
  try {
    clearAssetCache();
    const ar     = await getAssets();
    const assets = ar.result || ar.assets || ar || [];
    if (!assets.length) { _validatingInProgress = false; return; }

    const validPairs = new Set();
    const toCheck = [];
    for (const from of assets) {
      for (const to of assets) {
        if (from.id === to.id) continue;
        toCheck.push([from.id, to.id, parseInt(from.min_amount || 50000)]);
      }
    }

    broadcast("validate_progress", { done: 0, total: toCheck.length, valid: 0 });

    const BATCH = 8;
    let done = 0;
    for (let i = 0; i < toCheck.length; i += BATCH) {
      const batch = toCheck.slice(i, i + BATCH);
      await Promise.all(batch.map(async ([from, to, amt]) => {
        try {
          const q = await garden.getQuote(from, to, amt);
          if (q.result?.length > 0) validPairs.add(`${from}::${to}`);
        } catch (_) {}
        done++;
      }));
      broadcast("validate_progress", { done, total: toCheck.length, valid: validPairs.size });
      if (i + BATCH < toCheck.length) await new Promise(r => setTimeout(r, 100));
    }

    _validPairsCache = { env: config.env, ts: Date.now(), pairs: validPairs };
    // CHANGE: Do NOT pass to runner — runner builds fresh routes every time
    broadcast("validate_done", { total: toCheck.length, valid: validPairs.size });
    console.log(`[valid-pairs] ${validPairs.size} / ${toCheck.length} valid`);
  } catch (err) {
    broadcast("validate_done", { error: err.message });
  } finally {
    _validatingInProgress = false;
  }
});

app.post("/api/valid-pairs/clear", (req, res) => {
  _validPairsCache = { env: null, ts: 0, pairs: null };
  res.json({ ok: true });
});

// ── ARBITRAGE BOT ENDPOINTS ────────────────────────────────────

app.post("/api/arbitrage/scan", async (req, res) => {
  try {
    const combosPayload = await buildCombinationsResponse();
    const combinations  = combosPayload.combinations || [];
    const { minEdgeBps, maxRoutes } = req.body || {};
    const opportunities = await arbitrageAgent.scanOpportunities(combinations, {
      minEdgeBps,
      maxRoutes,
    });
    res.json({ ok: true, total: opportunities.length, opportunities });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/arbitrage/execute", async (req, res) => {
  const { fromAssetId, toAssetId, fromWalletType, toWalletType, amount, minEdgeBps } = req.body || {};
  if (!fromAssetId || !toAssetId || !fromWalletType || !toWalletType || !amount) {
    return res.status(400).json({ ok: false, error: "fromAssetId, toAssetId, fromWalletType, toWalletType, amount required" });
  }

  try {
    const verification = await arbitrageAgent.verifyOpportunity(
      { fromAssetId, toAssetId, amount },
      { minEdgeBps: minEdgeBps ?? 5 }
    );

    if (!verification.profitable) {
      return res.json({ ok: false, reason: "Not profitable at current prices", verification });
    }

    res.json({ ok: true, started: true, verification });

    runner.runRoute({
      fromChain: fromWalletType,
      toChain:   toWalletType,
      fromAsset: fromAssetId,
      toAsset:   toAssetId,
      amount:    verification.amount,
      label:     `Arb: ${fromAssetId} → ${toAssetId}`,
    }).then(result => {
      if (result && result.status === "pass") {
        recordArbTrade({
          fromAssetId,
          toAssetId,
          amount: verification.amount,
          usdPnl: verification.usdPnl,
          edgeBps: verification.edgeBps,
        });
        broadcast("arb_trade", {
          fromAssetId,
          toAssetId,
          amount: verification.amount,
          usdPnl: verification.usdPnl,
          edgeBps: verification.edgeBps,
        });
      }
    }).catch(err => {
      broadcast("error", { message: `Arbitrage execution failed: ${err.message}` });
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/arbitrage/summary", (req, res) => {
  res.json({
    ok: true,
    totalProfitUsd: _arbSummary.totalProfitUsd,
    trades: _arbSummary.trades,
  });
});

app.post("/api/run/combination", async (req, res) => {
  const { fromAssetId, toAssetId, fromWalletType, toWalletType, amount } = req.body;
  if (!fromAssetId || !toAssetId || !amount)
    return res.status(400).json({ error: "fromAssetId, toAssetId, amount required" });

  res.json({ started: true });
  runner.runRoute({
    fromChain: fromWalletType || "evm",
    toChain:   toWalletType   || "evm",
    fromAsset: fromAssetId,
    toAsset:   toAssetId,
    amount,
    label: `${fromAssetId} → ${toAssetId}`,
  }).catch(err => broadcast("error", { message: err.message }));
});

// ── WALLET: PRIVY ─────────────────────────────────────────────
app.post("/api/privy/connect", (req, res) => {
  const { appId, appSecret, evmWalletId, solanaWalletId } = req.body;
  if (!appId || !appSecret || !evmWalletId) return res.status(400).json({ error: "appId, appSecret, evmWalletId required" });
  try {
    const result = walletState.connectPrivy({ appId, appSecret, evmWalletId, solanaWalletId });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/privy/status", (req, res) => res.json(walletState.getStatus().privy));
app.post("/api/privy/disconnect", (req, res) => { walletState.disconnect("privy"); res.json({ ok: true }); });

// ── WALLET: EVM ───────────────────────────────────────────────
app.post("/api/wallet/evm", (req, res) => {
  const { address } = req.body;
  if (!address) return res.status(400).json({ error: "address required" });
  try { walletState.connectMetaMask(address); res.json({ ok: true, address }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── WALLET: EVM BALANCE ──────────────────────────────────────
const FREE_RPCS = {
  ethereum_sepolia:  "https://rpc.sepolia.org",
  arbitrum_sepolia:  "https://sepolia-rollup.arbitrum.io/rpc",
  base_sepolia:      "https://sepolia.base.org",
  bnbchain_testnet:  "https://data-seed-prebsc-1-s1.binance.org:8545",
  hyperevm_testnet:  "https://rpc.hyperliquid-testnet.xyz/evm",
  monad_testnet:     "https://testnet-rpc.monad.xyz",
  citrea_testnet:    "https://rpc.testnet.citrea.xyz",
  alpen_testnet:     "https://rpc.testnet.alpen.xyz",
};

const ERC20_BALANCE_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

app.post("/api/wallet/evm/balances", async (req, res) => {
  const { address } = req.body;
  if (!address) return res.status(400).json({ error: "address required" });

  const results = {};
  const tokenResults = {};
  const rpcErrors = [];

  const chainTokenMap = {};
  const rawAssets = await getAssets().catch(() => null);
  const assetList = (rawAssets?.result || rawAssets?.assets || (Array.isArray(rawAssets) ? rawAssets : []));
  for (const a of assetList) {
    const chainId = (a.chain || a.id?.split(':')[0] || '').toLowerCase();
    const tokenAddr = a.token_address || a.tokenAddress;
    const ticker = (a.asset || a.ticker || a.id?.split(':')[1] || '').toLowerCase();
    if (!tokenAddr || tokenAddr === 'native' || tokenAddr === '0x0000000000000000000000000000000000000000') continue;
    const rpcKey = Object.keys(FREE_RPCS).find(k => chainId.startsWith(k.split('_')[0]) || k.startsWith(chainId.split('_')[0]));
    if (!rpcKey) continue;
    if (!chainTokenMap[rpcKey]) chainTokenMap[rpcKey] = [];
    if (!chainTokenMap[rpcKey].find(t => t.tokenAddr === tokenAddr)) {
      chainTokenMap[rpcKey].push({ id: a.id, ticker, tokenAddr });
    }
  }

  const { ethers } = require('ethers');

  await Promise.all(Object.entries(FREE_RPCS).map(async ([chainPrefix, rpcUrl]) => {
    try {
      const r = await axios.post(rpcUrl, {
        jsonrpc: "2.0", id: 1, method: "eth_getBalance",
        params: [address, "latest"]
      }, { timeout: 5000 });
      const hex = r.data?.result;
      if (hex) results[chainPrefix] = String(parseInt(hex, 16));
      else rpcErrors.push({ chain: chainPrefix, message: "No result from RPC" });

      const tokens = chainTokenMap[chainPrefix] || [];
      if (tokens.length && hex) {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const tokenBals = {};
        await Promise.all(tokens.map(async ({ ticker, tokenAddr }) => {
          try {
            const token = new ethers.Contract(tokenAddr, ERC20_BALANCE_ABI, provider);
            const [bal, decimals] = await Promise.all([
              token.balanceOf(address),
              token.decimals().catch(() => 8)
            ]);
            const balNum = Number(bal);
            const formatted = (balNum / Math.pow(10, Number(decimals))).toFixed(6);
            tokenBals[ticker.toUpperCase()] = { raw: String(balNum), formatted, tokenAddr };
          } catch (_) {}
        }));
        if (Object.keys(tokenBals).length) tokenResults[chainPrefix] = tokenBals;
      }
    } catch(err) {
      rpcErrors.push({ chain: chainPrefix, message: err.message });
    }
  }));

  walletState.setEvmBalances(address, results);
  console.log(`[evm balances] ${Object.keys(results).length} chains OK, ${rpcErrors.length} errors, ${Object.values(tokenResults).reduce((s,t)=>s+Object.keys(t).length,0)} ERC20 balances`);
  res.json({ ok: true, address, balances: results, tokenBalances: tokenResults, rpcErrors });
});

// ── RPC: update URL for a chain ──────────────────────────────
app.post("/api/rpc/update", async (req, res) => {
  const { chain, url, testOnly } = req.body;
  if (!chain || !url) return res.status(400).json({ error: "chain and url required" });
  try {
    const test = await axios.post(url, {
      jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: []
    }, { timeout: 5000 });
    if (!test.data?.result) throw new Error("No result from RPC");
    const blockNumber = parseInt(test.data.result, 16);
    if (!testOnly) { FREE_RPCS[chain] = url; envkey.setRpc(chain, url); }
    res.json({ ok: true, chain, url, blockNumber, saved: !testOnly });
  } catch(err) {
    res.status(400).json({ error: `RPC test failed: ${err.message}` });
  }
});

app.get("/api/rpc/list", (req, res) => {
  res.json({ rpcs: FREE_RPCS });
});

// ── WALLET: BTC ───────────────────────────────────────────────
app.post("/api/wallet/btc", async (req, res) => {
  const { address, wif } = req.body;
  if (!address) return res.status(400).json({ error: "address required" });
  try {
    const net = config.isMainnet ? "" : "/testnet4";
    const r   = await axios.get(`https://mempool.space${net}/api/address/${address}`);
    const cs  = r.data?.chain_stats   || {};
    const ms  = r.data?.mempool_stats || {};
    const confirmedSats = (cs.funded_txo_sum || 0) - (cs.spent_txo_sum || 0);
    const pendingSats   = (ms.funded_txo_sum || 0) - (ms.spent_txo_sum || 0);
    const balance = (confirmedSats / 1e8).toFixed(8);
    walletState.connectBtc(address, wif, balance);
    res.json({ ok: true, address, balance, confirmedSats, pendingSats });
  } catch (_) {
    walletState.connectBtc(address, wif, "unknown");
    res.json({ ok: true, address, balance: "unknown" });
  }
});

// ── WALLET: SOLANA ────────────────────────────────────────────
app.post("/api/wallet/solana", (req, res) => {
  const { address, balance } = req.body;
  if (!address) return res.status(400).json({ error: "address required" });
  try { walletState.connectSolana(address, balance); res.json({ ok: true, address }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── WALLET: STARKNET / SUI / TRON ────────────────────────────
app.post("/api/wallet/starknet", (req, res) => { walletState.connectStarknet(req.body.address); res.json({ ok: true }); });
app.post("/api/wallet/sui",      (req, res) => { walletState.connectSui(req.body.address);      res.json({ ok: true }); });
app.post("/api/wallet/tron",     (req, res) => { walletState.connectTron(req.body.address);     res.json({ ok: true }); });

// ── WALLET: DISCONNECT & STATUS ───────────────────────────────
app.post("/api/wallet/disconnect", (req, res) => {
  const type = req.body.type;
  walletState.disconnect(type);

  try {
    if ((type === 'evm' || type === 'metamask' || type === 'privy') && envkey.isEvmAvailable()) {
      const addr = envkey.getEvmAddress();
      const ok = walletState.connectEnvKeyEvm(addr);
      if (ok) console.log(`[disconnect] EVM fell back to envkey: ${addr}`);
    }
    if (type === 'btc' && envkey.isBtcAvailable()) {
      const addr = envkey.getBtcAddress();
      if (addr) { const ok = walletState.connectEnvKeyBtc(addr, envkey.getBtcWif()); if (ok) console.log(`[disconnect] BTC fell back to envkey: ${addr}`); }
    }
    if (type === 'solana' && envkey.isSolanaAvailable()) {
      const addr = envkey.getSolanaAddress();
      if (addr) { const ok = walletState.connectEnvKeySolana(addr); if (ok) console.log(`[disconnect] Solana fell back to envkey: ${addr}`); }
    }
    if (type === 'starknet' && envkey.isStarknetAvailable()) {
      const addr = envkey.getStarknetAddress();
      if (addr) { const ok = walletState.connectEnvKeyStarknet(addr); if (ok) console.log(`[disconnect] Starknet fell back to envkey: ${addr}`); }
    }
    if (type === 'sui' && envkey.isSuiAvailable()) {
      const addr = envkey.getSuiAddress();
      if (addr) { const ok = walletState.connectEnvKeySui(addr); if (ok) console.log(`[disconnect] Sui fell back to envkey: ${addr}`); }
    }
    if (type === 'tron' && envkey.isTronAvailable()) {
      const addr = envkey.getTronAddress();
      if (addr) { const ok = walletState.connectEnvKeyTron(addr); if (ok) console.log(`[disconnect] Tron fell back to envkey: ${addr}`); }
    }
    if (type === 'privy' && envkey.isSolanaAvailable()) {
      const addr = envkey.getSolanaAddress();
      if (addr) walletState.connectEnvKeySolana(addr);
    }
  } catch(e) { console.error(`[disconnect] envkey fallback error: ${e.message}`); }

  res.json({ ok: true });
});

app.get("/api/wallet/envkey-status", (req, res) => {
  res.json({
    evm:      envkey.isEvmAvailable()      ? { address: envkey.getEvmAddress()      } : null,
    btc:      envkey.isBtcAvailable()      ? { address: envkey.getBtcAddress()       } : null,
    solana:   envkey.isSolanaAvailable()   ? { address: envkey.getSolanaAddress()    } : null,
    starknet: envkey.isStarknetAvailable() ? { address: envkey.getStarknetAddress()  } : null,
    sui:      envkey.isSuiAvailable()      ? { address: envkey.getSuiAddress()       } : null,
    tron:     envkey.isTronAvailable()     ? { address: envkey.getTronAddress()      } : null,
  });
});

app.post("/api/wallet/use-envkey", (req, res) => {
  const { type } = req.body;
  try {
    let addr = null;
    if (type === 'evm' && envkey.isEvmAvailable()) {
      addr = envkey.getEvmAddress();
      walletState.disconnect('evm');
      walletState.connectEnvKeyEvm(addr);
    } else if (type === 'btc' && envkey.isBtcAvailable()) {
      addr = envkey.getBtcAddress();
      walletState.disconnect('btc');
      walletState.connectEnvKeyBtc(addr, envkey.getBtcWif());
    } else if (type === 'solana' && envkey.isSolanaAvailable()) {
      addr = envkey.getSolanaAddress();
      walletState.disconnect('solana');
      walletState.connectEnvKeySolana(addr);
    } else {
      return res.status(400).json({ error: `No .env key configured for type: ${type}` });
    }
    res.json({ ok: true, address: addr, source: 'envkey' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/wallet/balances", async (req, res) => {
  const btcAddr = walletState.getBtcAddress();
  if (btcAddr) {
    try {
      const net = config.isMainnet ? "" : "/testnet4";
      const r   = await axios.get(`https://mempool.space${net}/api/address/${btcAddr}`);
      const cs  = r.data?.chain_stats   || {};
      const ms  = r.data?.mempool_stats || {};
      const confirmedSats = (cs.funded_txo_sum || 0) - (cs.spent_txo_sum || 0);
      const pendingSats   = (ms.funded_txo_sum || 0) - (ms.spent_txo_sum || 0);
      const confirmedBtc  = (confirmedSats / 1e8).toFixed(8);
      walletState.connectBtc(btcAddr, walletState.getBtcWif(), confirmedBtc);
      if (pendingSats !== 0) {
        walletState.setBtcPending && walletState.setBtcPending(pendingSats);
      }
    } catch (_) {}
  }

  const status = walletState.getStatus();
  const safeStatus = JSON.parse(JSON.stringify(status));
  for (const key of ['evm','btc','solana','starknet','sui','tron']) {
    if (safeStatus[key]?.source === 'envkey' && safeStatus[key]?.address) {
      const addr = safeStatus[key].address;
      safeStatus[key].address = addr.slice(0,6) + '…' + addr.slice(-4);
      safeStatus[key].addressRedacted = true;
    }
    if (safeStatus[key]?.wif) delete safeStatus[key].wif;
  }
  res.json(safeStatus);
});

// ── DEBUG ─────────────────────────────────────────────────────
app.get("/api/debug/assets", async (req, res) => {
  try {
    clearAssetCache();
    const raw = await garden.getAssets();
    res.json(raw);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/debug/quote", async (req, res) => {
  const { from, to, amount } = req.query;
  if (!from || !to) return res.status(400).json({ error: "from, to, amount required" });
  try {
    const data = await garden.getQuote(from, to, parseInt(amount || 50000));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message, raw: err.raw });
  }
});

// ── STUCK ORDERS ─────────────────────────────────────────────
app.get("/api/orders/stuck", async (req, res) => {
  try {
    const wallets = walletState.getStatus();
    const ownerAddresses = [
      wallets.evm?.address, wallets.btc?.address,
      wallets.solana?.address, wallets.starknet?.address,
    ].filter(Boolean);

    const allOrders = [];
    for (const addr of ownerAddresses) {
      try {
        const r = await garden.getOrders({ owner: addr, limit: 20 });
        const orders = r.result || r.orders || r || [];
        allOrders.push(...orders);
      } catch (_) {}
    }

    const cutoff = Date.now() - 5 * 60 * 1000;
    const stuck = allOrders.filter(o => {
      const status = (o.status || "").toLowerCase();
      const ts = new Date(o.created_at || o.createdAt || 0).getTime();
      return !["completed","refunded","failed","expired"].some(s => status.includes(s))
          && ts < cutoff;
    });

    res.json({ ok: true, stuck: stuck.length, orders: stuck });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per Garden docs v2.0.15: instant-refund requires `signatures` array (not `signature` string)
app.post("/api/orders/cancel/:id", async (req, res) => {
  const id = req.params.id;
  try {
    // 1. Try instant refund first (needs solver signature)
    try {
      const hashRes = await garden.getRefundHash(id);
      const refundHash = hashRes.result?.refund_hash || hashRes.result;
      if (refundHash) {
        // Per v2.0.15 changelog: action=instant-refund requires { signatures: [...] }
        const r = await garden.patchOrder(id, "instant-refund", { signatures: [refundHash] });
        return res.json({ ok: true, method: "instant-refund", result: r });
      }
    } catch (_) {}

    // 2. Regular refund (after timelock expires)
    const r = await garden.patchOrder(id, "refund", null);
    res.json({ ok: true, method: "refund", result: r });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/orders/:id/refund-hash", async (req, res) => {
  try {
    const r = await garden.getRefundHash(req.params.id);
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/orders/:id/redeem", async (req, res) => {
  const { secret } = req.body;
  if (!secret) return res.status(400).json({ error: "secret required" });
  try {
    const r = await garden.patchOrder(req.params.id, "redeem", { secret });
    res.json({ ok: true, result: r });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── START ─────────────────────────────────────────────────────
server.listen(config.port, () => {
  console.log(`\n✅  Garden Test Suite running`);
  console.log(`   Dashboard:   http://localhost:${config.port}`);
  console.log(`   Environment: ${config.env.toUpperCase()}`);
  console.log(`   Manual Approve: ${config.manualApprove ? "ON ✋" : "OFF 🤖"}`);
  console.log(`   Chains: ${Object.keys(config.chains).length}`);

  function tryEnvKey(label, checker, addrFn, connectFn) {
    if (!checker()) return;
    try {
      const addr = addrFn();
      if (addr) { const ok = connectFn(addr); if (ok) console.log(`   ${label}: ${addr}`); }
    } catch(e) { console.error(`   ⚠️  ${label} key invalid: ${e.message}`); }
  }

  tryEnvKey("EVM (.env)",      envkey.isEvmAvailable,      envkey.getEvmAddress,      walletState.connectEnvKeyEvm);
  tryEnvKey("BTC (.env)",      envkey.isBtcAvailable,      envkey.getBtcAddress,      (addr) => walletState.connectEnvKeyBtc(addr, envkey.getBtcWif()));
  tryEnvKey("Solana (.env)",   envkey.isSolanaAvailable,   envkey.getSolanaAddress,   walletState.connectEnvKeySolana);
  tryEnvKey("Starknet (.env)", envkey.isStarknetAvailable, envkey.getStarknetAddress, walletState.connectEnvKeyStarknet);
  tryEnvKey("Sui (.env)",      envkey.isSuiAvailable,      envkey.getSuiAddress,      walletState.connectEnvKeySui);
  tryEnvKey("Tron (.env)",     envkey.isTronAvailable,     envkey.getTronAddress,     walletState.connectEnvKeyTron);
  console.log("");
});

module.exports = { server, broadcast };