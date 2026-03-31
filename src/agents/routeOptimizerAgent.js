// src/agents/routeOptimizerAgent.js
"use strict";

const tradeHistory = require("./tradeHistory");

const MIN_GAS_WEI = 10n ** 15n;
const GAS_PER_TX = 2;
const BEAM_WIDTH = 6;
const MAX_DEPTH = 15;

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr;
}

/**
 * allTests: for each bitcoin→* matrix cell, pick among all liquid catalog routes (uniform), not only max scoreHop
 * (BTC↔BTC-family pairs score highest, so iBTC on Base often won every time).
 * Default: on. Set ALLTESTS_RANDOM_BTC_DEST=false to restore deterministic “best score” picks.
 */
function allTestsRandomBitcoinDestEnabled() {
  const v = process.env.ALLTESTS_RANDOM_BTC_DEST;
  if (v === undefined || String(v).trim() === "") return true;
  const s = String(v).toLowerCase();
  if (s === "0" || s === "false" || s === "no") return false;
  return s === "1" || s === "true" || s === "yes";
}

class AgentMemoryFallback {
  constructor() {
    this.chainGas = new Map();
  }

  async loadFromDB() {
    return;
  }

  getAllPairStats() {
    try {
      const map = tradeHistory.getPairStats();
      const next = new Map();
      for (const [k, v] of map) {
        const total = Number(v.successes || 0) + Number(v.failures || 0);
        next.set(k, {
          ...v,
          successRate: total > 0 ? Number(v.successes || 0) / total : 0,
          avgEdgeBps: 0,
        });
      }
      return next;
    } catch (_) {
      return new Map();
    }
  }

  getGasBuffer(chainKey) {
    const stat = this.chainGas.get(chainKey);
    if (!stat) return 1.5;
    if (stat.failures >= 3) return 2.2;
    if (stat.failures > stat.successes) return 1.9;
    return 1.5;
  }

  recordPairResult(fromAssetId, toAssetId, result) {
    tradeHistory.record({
      status: result?.status || "unknown",
      fromAssetId,
      toAssetId,
      amount: Number(result?.amount || 0),
      outputAmount: Number(result?.outputAmount || 0),
      usdIn: Number(result?.usdIn || 0),
      usdOut: Number(result?.usdOut || 0),
      slippagePct: Number(result?.slippagePct || 0),
      durationSec: Number(result?.durationSec || 0),
      agent: "routeOptimizer",
      error: result?.error || null,
    });
  }

  recordChainGasResult(chainKey, payload = {}) {
    const prev = this.chainGas.get(chainKey) || { successes: 0, failures: 0 };
    if (payload.failed) prev.failures += 1;
    else prev.successes += 1;
    this.chainGas.set(chainKey, prev);
  }
}

function assetFamilyFromIdOrName(assetId, name) {
  const base = String(name || assetId || "").toLowerCase();
  const t = base.split(":").pop();
  if (/btc$|^btc|wbtc|cbtc|cbbtc|sbtc|hbtc|btcn|lbtc|tbtc|pbtc|rbtc/.test(t)) return "btc";
  if (/^eth$|^weth$/.test(t)) return "eth";
  if (/usdc|usdt|dai|busd|usde/.test(t)) return "stable";
  if (/^ltc$|^wltc$|^cbltc$/.test(t)) return "ltc";
  return "other_" + t;
}

function getChainKey(assetId) {
  return (assetId || "").split(":")[0].replace(/_sepolia|_testnet\d*|_mainnet|_signet|_devnet/g, "");
}

/** Full Garden chain prefix per asset (no normalization) — used so chain-routes can visit distinct networks (e.g. bitcoin_testnet vs bitcoin_signet). */
function getChainRouteStepKey(assetId) {
  return (assetId || "").split(":")[0].toLowerCase();
}

function getWalletTypeFromChain(chainKey) {
  if (/^bitcoin/.test(chainKey)) return "bitcoin";
  if (/^solana/.test(chainKey)) return "solana";
  if (/^starknet/.test(chainKey)) return "starknet";
  if (/^tron/.test(chainKey)) return "tron";
  if (/^sui/.test(chainKey)) return "sui";
  return "evm";
}

function toComparableBigInt(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return BigInt(Math.floor(value));
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return null;
    try {
      return BigInt(s.includes(".") ? s.split(".")[0] : s);
    } catch (_) {
      return null;
    }
  }
  return null;
}

function isAtLeastAtomic(left, right) {
  const l = toComparableBigInt(left);
  const r = toComparableBigInt(right);
  if (l !== null && r !== null) return l >= r;
  const ln = Number(left);
  const rn = Number(right);
  if (!Number.isFinite(ln) || !Number.isFinite(rn)) return false;
  return ln >= rn;
}

function compareAtomicDesc(left, right) {
  const l = toComparableBigInt(left);
  const r = toComparableBigInt(right);
  if (l !== null && r !== null) {
    if (l === r) return 0;
    return l > r ? -1 : 1;
  }
  const ln = Number(left);
  const rn = Number(right);
  if (ln === rn) return 0;
  return rn - ln;
}

function toJsonSafe(value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function formatUnitsAtomic(value, decimals = 8) {
  const v = toComparableBigInt(value);
  if (v === null) return null;
  const d = Number.isFinite(Number(decimals)) ? Math.max(0, Number(decimals)) : 8;
  const base = 10n ** BigInt(d);
  const whole = v / base;
  const frac = v % base;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(d, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fracStr}`;
}

function scoreHop(fromId, toId, pairStats) {
  const ff = assetFamilyFromIdOrName(fromId, "");
  const tf = assetFamilyFromIdOrName(toId, "");
  const fc = getChainKey(fromId);
  const tc = getChainKey(toId);
  let score = 0;

  if (ff === "btc" && tf === "btc") score += 8;
  else if (ff === "btc" || tf === "btc") score += 4;
  if (ff === "eth" || tf === "eth") score += 2;
  if (ff === "stable" || tf === "stable") score += 1;
  if (fc !== tc) score += 5;
  if (ff !== tf) score += 2;

  const stat = pairStats?.get(`${fromId}::${toId}`);
  if (stat) {
    const total = Number(stat.successes || 0) + Number(stat.failures || 0);
    if (total >= 3) {
      const successRate = Number(stat.successRate ?? (stat.successes / total));
      score += (successRate - 0.5) * 10;
      if (Number(stat.avgEdgeBps || 0) > 0) score += Math.min(3, Number(stat.avgEdgeBps) / 10);
    } else {
      score -= 0.5;
    }
  } else {
    score -= 0.3;
  }

  return score;
}

function estimatePathGas(pathAssets, gasBalances, memory) {
  const txsPerChain = new Map();
  for (const assetId of pathAssets) {
    const ck = getChainKey(assetId);
    if (getWalletTypeFromChain(ck) !== "evm") continue;
    txsPerChain.set(ck, (txsPerChain.get(ck) || 0) + GAS_PER_TX);
  }

  const gasIssues = [];
  for (const [chain, txCount] of txsPerChain) {
    const have = gasBalances?.get(chain);
    if (have === undefined) continue;
    const buffer = memory?.getGasBuffer?.(chain) ?? 1.5;
    const needed = BigInt(Math.ceil(Number(MIN_GAS_WEI) * txCount * buffer));
    const haveBig = toComparableBigInt(have);
    if (haveBig !== null && haveBig < needed) {
      gasIssues.push({
        chain,
        have: haveBig.toString(),
        need: needed.toString(),
        txCount,
        shortfall: (needed - haveBig).toString(),
      });
    }
  }

  return {
    chainsUsed: [...txsPerChain.keys()],
    totalTxEstimate: [...txsPerChain.values()].reduce((sum, n) => sum + n, 0),
    gasIssues,
    feasible: gasIssues.length === 0,
  };
}

function beamSearchPath(seedId, adj, opts = {}) {
  const usedDestinations = opts.usedDestinations || new Set();
  const pairStats = opts.pairStats || null;
  const gasBalances = opts.gasBalances || new Map();
  const memory = opts.memory || null;
  const beamWidth = Number(opts.beamWidth || BEAM_WIDTH);
  const maxDepth = Number(opts.maxDepth || MAX_DEPTH);
  const uniqueChainsOnly = opts.chainRoutesUniqueChains === true;

  let beam = [{ assets: [seedId], score: 0 }];
  let best = null;

  for (let depth = 0; depth < maxDepth; depth++) {
    const candidates = [];

    for (const partial of beam) {
      const current = partial.assets[partial.assets.length - 1];
      const neighbors = adj.get(current) || [];
      let expanded = false;

      for (const edge of neighbors) {
        if (usedDestinations.has(edge.toAssetId)) continue;
        if (partial.assets.includes(edge.toAssetId)) continue;
        if (uniqueChainsOnly) {
          const seenChainKeys = new Set(partial.assets.map((a) => getChainRouteStepKey(a)));
          const nextCk = getChainRouteStepKey(edge.toAssetId);
          if (seenChainKeys.has(nextCk)) continue;
        }
        const assets = [...partial.assets, edge.toAssetId];
        const score = partial.score + scoreHop(current, edge.toAssetId, pairStats);
        candidates.push({ assets, score });
        expanded = true;
      }

      if (!expanded && partial.assets.length > 1) {
        const gas = estimatePathGas(partial.assets, gasBalances, memory);
        if (gas.feasible && (!best || partial.score > best.score)) {
          best = { ...partial, gasEstimate: gas };
        }
      }
    }

    if (!candidates.length) break;
    shuffleArray(candidates);          // random hop selection at every depth
    beam = candidates.slice(0, beamWidth);
  }

  if (!best) {
    for (const p of beam.sort((a, b) => b.score - a.score)) {
      if (p.assets.length < 2) continue;
      const gas = estimatePathGas(p.assets, gasBalances, memory);
      if (!gas.feasible) continue;
      best = { ...p, gasEstimate: gas };
      break;
    }
  }

  return best;
}

/** Ring walk on sorted chain list: from source at index i, visit (i+1)…(i+n−1) mod n — matches a₁→⋯→aₙ→a₁. */
function cyclicChainDestinations(chainKeys, src) {
  const n = chainKeys.length;
  if (n <= 1) return [];
  const i = chainKeys.indexOf(src);
  if (i < 0) return chainKeys.filter((k) => k !== src);
  const out = [];
  for (let k = 1; k < n; k++) {
    const j = (i + k) % n;
    out.push(chainKeys[j]);
  }
  return out;
}

/** a₁→a₂→⋯→aₙ→a₁ — round-robin seeds by sorted chain key (one pass per chain per round). */
function orderSeedsCyclicByChain(seedList) {
  if (!seedList?.length) return seedList;
  const chainKeys = [...new Set(seedList.map((s) => getChainRouteStepKey(s.assetId)))].sort();
  const byChain = new Map();
  for (const s of seedList) {
    const ck = getChainRouteStepKey(s.assetId);
    if (!byChain.has(ck)) byChain.set(ck, []);
    byChain.get(ck).push(s);
  }
  const out = [];
  let round = 0;
  for (;;) {
    let added = false;
    for (const ck of chainKeys) {
      const arr = byChain.get(ck) || [];
      if (round < arr.length) {
        out.push(arr[round]);
        added = true;
      }
    }
    if (!added) break;
    round++;
  }
  return out.length ? out : seedList;
}

/** allTests: deterministic order over every funded seed asset (full asset ids), then beams. */
function orderSeedsCyclicAllAssets(seedList) {
  if (!seedList?.length) return seedList;
  return [...seedList].sort((a, b) => String(a.assetId).localeCompare(String(b.assetId)));
}

function buildChainReactionFlow(routes, opts = {}) {
  const connectedTypes = opts.connectedWalletTypes || new Set();
  const balances = opts.balances || new Map();
  const gasBalances = opts.gasBalances || new Map();
  const memory = opts.memory || null;
  const seedAllowlist = opts.seedAllowlist || null;
  const closeCycle = opts.closeCycle === true;

  const connected = routes.filter((r) => {
    const fw = r.fromChain || getWalletTypeFromChain(getChainKey(r.fromAsset));
    const tw = r.toChain || getWalletTypeFromChain(getChainKey(r.toAsset));
    return !connectedTypes.size || (connectedTypes.has(fw) && connectedTypes.has(tw));
  });

  if (!connected.length) return { chains: [], standalone: [], allRoutes: [], seedAssets: [] };

  const adj = new Map();
  for (const r of connected) {
    if (!adj.has(r.fromAsset)) adj.set(r.fromAsset, []);
    adj.get(r.fromAsset).push({ toAssetId: r.toAsset, route: r });
  }

  const pairStats = memory?.getAllPairStats?.() || null;
  const seen = new Set();
  const seedAssets = [];
  for (const r of connected) {
    const assetId = r.fromAsset;
    if (seen.has(assetId)) continue;
    seen.add(assetId);
    const bal = balances.get(assetId);
    const minAmt = Number(r.amount || r.fromMeta?.min_amount || 50000);
    if (bal === null || bal === undefined || !isAtLeastAtomic(bal, minAmt)) continue;
    const ck = getChainKey(assetId);
    if (getWalletTypeFromChain(ck) === "evm") {
      const gas = gasBalances.get(ck);
      const gasBig = toComparableBigInt(gas);
      if (gas !== undefined && gasBig !== null && gasBig < MIN_GAS_WEI) continue;
    }
    seedAssets.push({ assetId, balance: bal, minAmt, outDegree: adj.get(assetId)?.length || 0 });
  }

  const famOrder = { btc: 0, eth: 1, stable: 2, ltc: 3 };
  seedAssets.sort((a, b) => {
    const fa = famOrder[assetFamilyFromIdOrName(a.assetId, "")] ?? 99;
    const fb = famOrder[assetFamilyFromIdOrName(b.assetId, "")] ?? 99;
    if (fa !== fb) return fa - fb;
    if (b.outDegree !== a.outDegree) return b.outDegree - a.outDegree;
    return compareAtomicDesc(a.balance, b.balance);
  });

  const candidateSeeds = seedAllowlist instanceof Set && seedAllowlist.size
    ? seedAssets.filter((s) => seedAllowlist.has(s.assetId))
    : seedAssets;

  let seedsForBeam = candidateSeeds.length > 0 ? candidateSeeds : seedAssets;
  if (opts.seedOrderMode === "allAssets" && seedsForBeam.length) {
    seedsForBeam = orderSeedsCyclicAllAssets(seedsForBeam);
  } else if (opts.seedOrderMode === "chains" && seedsForBeam.length) {
    seedsForBeam = orderSeedsCyclicByChain(seedsForBeam);
  }

  const chains = [];
  const usedDestinations = new Set();
  for (const seed of seedsForBeam) {
    const path = beamSearchPath(seed.assetId, adj, {
      usedDestinations,
      pairStats,
      gasBalances,
      memory,
      chainRoutesUniqueChains: opts.chainRoutesUniqueChains === true,
    });
    if (!path || path.assets.length < 2) continue;

    for (let i = 1; i < path.assets.length; i++) usedDestinations.add(path.assets[i]);

    const routesForPath = [];
    for (let i = 0; i < path.assets.length - 1; i++) {
      const from = path.assets[i];
      const to = path.assets[i + 1];
      const edge = (adj.get(from) || []).find((e) => e.toAssetId === to);
      if (edge) routesForPath.push(edge.route);
    }
    if (!routesForPath.length) continue;

    const startAsset = seed.assetId;
    const lastAsset = path.assets[path.assets.length - 1];
    /**
     * X = first hop after seed. Cycle close is only last→X (Q→X). Asset list becomes S1→…→Q→X
     * (terminal asset is X again). No last→seed (Q→S1) fallback.
     */
    const firstHopDest = path.assets.length >= 2 ? path.assets[1] : null;

    let closedOk = false;
    let lastGasFail = null;
    if (closeCycle && firstHopDest && firstHopDest !== lastAsset) {
      const closingEdge = (adj.get(lastAsset) || []).find((e) => e.toAssetId === firstHopDest);
      if (closingEdge) {
        const closedAssets = [...path.assets, firstHopDest];
        const gas = estimatePathGas(closedAssets, gasBalances, memory);
        if (gas.feasible) {
          path.assets = closedAssets;
          routesForPath.push(closingEdge.route);
          closedOk = true;
        } else {
          lastGasFail = { gas, closedAssetsLen: closedAssets.length };
        }
      }
    }

    if (closeCycle && !closedOk && lastGasFail) {
    }

    chains.push({
      startAsset: seed.assetId,
      seedBalance: seed.balance,
      assets: path.assets,
      routes: routesForPath,
      length: routesForPath.length,
      pathScore: path.score,
      gasEstimate: estimatePathGas(path.assets, gasBalances, memory),
    });
  }

  if (
    opts.chainRoutesUniqueChains === true &&
    chains.length === 0 &&
    seedAssets.length > 0
  ) {
    return buildChainReactionFlow(routes, { ...opts, chainRoutesUniqueChains: false });
  }

  if (chains.length === 0 && seedsForBeam.length > 0) {
    for (const seed of seedsForBeam) {
      const neighbors = adj.get(seed.assetId) || [];
      if (!neighbors.length) continue;
      const sorted = [...neighbors].sort(
        (a, b) =>
          scoreHop(seed.assetId, b.toAssetId, pairStats) -
          scoreHop(seed.assetId, a.toAssetId, pairStats)
      );
      for (const edge of sorted) {
        if (usedDestinations.has(edge.toAssetId)) continue;
        const assets = [seed.assetId, edge.toAssetId];
        const gas = estimatePathGas(assets, gasBalances, memory);
        if (!gas.feasible) continue;
        usedDestinations.add(edge.toAssetId);
        chains.push({
          startAsset: seed.assetId,
          seedBalance: seed.balance,
          assets,
          routes: [edge.route],
          length: 1,
          pathScore: scoreHop(seed.assetId, edge.toAssetId, pairStats),
          gasEstimate: gas,
        });
        break;
      }
    }
  }

  const usedEdges = new Set();
  for (const c of chains) {
    for (const r of c.routes) usedEdges.add(`${r.fromAsset}::${r.toAsset}`);
  }

  const standalone = connected.filter((r) =>
    !usedEdges.has(`${r.fromAsset}::${r.toAsset}`) && !usedDestinations.has(r.toAsset)
  );
  const scoredStandalone = standalone
    .map((route) => ({ route, score: scoreHop(route.fromAsset, route.toAsset, pairStats) }))
    .sort((a, b) => b.score - a.score);

  const allRoutes = [];
  chains.forEach((c, chainIndex) => {
    c.routes.forEach((route, depth) => {
      allRoutes.push({
        ...route,
        _chainReaction: depth > 0,
        _chainStart: c.startAsset,
        _depth: depth,
        _chainIndex: chainIndex,
        _pathScore: c.pathScore,
      });
    });
  });
  scoredStandalone.forEach((s) => allRoutes.push(s.route));

  return { chains, standalone: scoredStandalone.map((s) => s.route), allRoutes, seedAssets };
}

/** Same connected-route filter as getRouteReadiness — must match for a single flow build in run(). */
function resolveConnectedTypesAndRoutes(routes, connectedWalletTypes) {
  const connectedTypes = connectedWalletTypes || new Set();
  if (!connectedTypes.size) {
    for (const r of routes) {
      if (r.fromChain) connectedTypes.add(r.fromChain);
      if (r.toChain) connectedTypes.add(r.toChain);
    }
  }
  const connectedRoutes = routes.filter((r) => {
    const fw = r.fromChain || getWalletTypeFromChain(getChainKey(r.fromAsset));
    const tw = r.toChain || getWalletTypeFromChain(getChainKey(r.toAsset));
    return !connectedTypes.size || (connectedTypes.has(fw) && connectedTypes.has(tw));
  });
  return { connectedTypes, connectedRoutes };
}

function minAmtForAssetFromRoutes(connectedRoutes, assetId) {
  let m = null;
  for (const r of connectedRoutes) {
    if (r.fromAsset !== assetId) continue;
    const v = Number(r.amount || r.fromMeta?.min_amount || 50000);
    if (m === null || v < m) m = v;
  }
  return m ?? 50000;
}

/** Source can fund min trade + (EVM) gas threshold — skips illiquid sources. */
function isSourceLiquidForRoute(assetId, balances, gasBalances, connectedRoutes) {
  const minAmt = minAmtForAssetFromRoutes(connectedRoutes, assetId);
  const bal = balances.get(assetId);
  if (bal === null || bal === undefined) return false;
  if (!isAtLeastAtomic(bal, minAmt)) return false;
  const ck = getChainKey(assetId);
  if (getWalletTypeFromChain(ck) === "evm") {
    const gas = gasBalances.get(ck);
    const gasBig = toComparableBigInt(gas);
    if (gas !== undefined && gasBig !== null && gasBig < MIN_GAS_WEI) return false;
  }
  return true;
}

/** Map chain route prefix -> asset ids that appear as liquid sources on that chain. */
function buildLiquidSourceAssetsByChain(connectedRoutes, balances, gasBalances) {
  const by = new Map();
  for (const r of connectedRoutes) {
    const ck = getChainRouteStepKey(r.fromAsset);
    const a = r.fromAsset;
    if (!isSourceLiquidForRoute(a, balances, gasBalances, connectedRoutes)) continue;
    if (!by.has(ck)) by.set(ck, new Set());
    by.get(ck).add(a);
  }
  const out = new Map();
  for (const [k, set] of by) out.set(k, [...set].sort((x, y) => String(x).localeCompare(String(y))));
  return out;
}

/** One random funded source asset per chain prefix (Garden network), for allChains seeds. */
function pickOneRandomAssetPerChainPrefix(connectedRoutes, balances, gasBalances) {
  const by = new Map();
  for (const r of connectedRoutes) {
    const ck = getChainRouteStepKey(r.fromAsset);
    if (!by.has(ck)) by.set(ck, new Set());
    by.get(ck).add(r.fromAsset);
  }
  const picked = new Map();
  for (const [ck, assetsSet] of by) {
    const liquid = [...assetsSet].filter((a) => isSourceLiquidForRoute(a, balances, gasBalances, connectedRoutes));
    if (!liquid.length) continue;
    const chosen = liquid[Math.floor(Math.random() * liquid.length)];
    picked.set(ck, chosen);
  }
  return picked;
}

function pickBestLiquidRouteAmong(
  candidates,
  balances,
  gasBalances,
  connectedRoutes,
  pairStats,
  pickOpts = {}
) {
  if (!candidates?.length) return null;
  const ok = candidates.filter((r) =>
    isSourceLiquidForRoute(r.fromAsset, balances, gasBalances, connectedRoutes)
  );
  if (!ok.length) return null;
  const fromChainKey = pickOpts.fromChainKey || "";
  const bitcoinSource =
    /^bitcoin/.test(String(fromChainKey)) &&
    allTestsRandomBitcoinDestEnabled() &&
    ok.length > 1;
  if (bitcoinSource) {
    return ok[Math.floor(Math.random() * ok.length)];
  }
  ok.sort(
    (a, b) =>
      scoreHop(b.fromAsset, b.toAsset, pairStats) - scoreHop(a.fromAsset, a.toAsset, pairStats)
  );
  return ok[0];
}

/**
 * allTests: one best liquid direct route per ordered chain pair (C×C), including same-chain when a route exists.
 * Skips pairs with no catalog edge or no liquid source.
 */
function buildAllTestsChainMatrixCoverage(connectedRoutes, balances, gasBalances, pairStats) {
  const pairBuckets = new Map();
  for (const r of connectedRoutes) {
    const fc = getChainRouteStepKey(r.fromAsset);
    const tc = getChainRouteStepKey(r.toAsset);
    const key = `${fc}::${tc}`;
    if (!pairBuckets.has(key)) pairBuckets.set(key, []);
    pairBuckets.get(key).push(r);
  }
  const chainKeys = [
    ...new Set(
      connectedRoutes.flatMap((r) => [getChainRouteStepKey(r.fromAsset), getChainRouteStepKey(r.toAsset)])
    ),
  ].sort((a, b) => String(a).localeCompare(String(b)));
  const out = [];
  const seenEdge = new Set();
  for (const ci of chainKeys) {
    for (const cj of chainKeys) {
      const candidates = pairBuckets.get(`${ci}::${cj}`) || [];
      const best = pickBestLiquidRouteAmong(candidates, balances, gasBalances, connectedRoutes, pairStats, {
        fromChainKey: ci,
      });
      if (!best || best.fromAsset === best.toAsset) continue;
      const ek = `${best.fromAsset}::${best.toAsset}`;
      if (seenEdge.has(ek)) continue;
      seenEdge.add(ek);
      out.push(best);
    }
  }
  return out;
}

function orderAssetsForChainFallback(ck, pickedMap, liquidByChain) {
  const arr = liquidByChain.get(ck) || [];
  const preferred = pickedMap.get(ck);
  if (!preferred) return [...arr];
  const rest = arr.filter((a) => a !== preferred);
  return [preferred, ...rest];
}

/**
 * allChains: same C×C matrix, but prefers routes that use the random per-chain pick as src/dst when possible;
 * falls back to other liquid assets on the same chains so illiquid picks are replaced.
 */
function buildAllChainsPickedMatrixCoverage(
  connectedRoutes,
  balances,
  gasBalances,
  pairStats,
  pickedMap,
  liquidByChain
) {
  const routeIndex = new Map();
  for (const r of connectedRoutes) {
    routeIndex.set(`${r.fromAsset}::${r.toAsset}`, r);
  }
  const chainKeys = [
    ...new Set(
      connectedRoutes.flatMap((r) => [getChainRouteStepKey(r.fromAsset), getChainRouteStepKey(r.toAsset)])
    ),
  ].sort((a, b) => String(a).localeCompare(String(b)));
  const out = [];
  const seenEdge = new Set();
  for (const ci of chainKeys) {
    for (const cj of chainKeys) {
      const fromOrder = orderAssetsForChainFallback(ci, pickedMap, liquidByChain);
      const toOrder = orderAssetsForChainFallback(cj, pickedMap, liquidByChain);
      let chosen = null;
      outer: for (const fa of fromOrder) {
        for (const ta of toOrder) {
          if (fa === ta) continue;
          const r = routeIndex.get(`${fa}::${ta}`);
          if (!r) continue;
          if (!isSourceLiquidForRoute(fa, balances, gasBalances, connectedRoutes)) continue;
          chosen = r;
          break outer;
        }
      }
      if (!chosen) continue;
      const ek = `${chosen.fromAsset}::${chosen.toAsset}`;
      if (seenEdge.has(ek)) continue;
      seenEdge.add(ek);
      out.push(chosen);
    }
  }
  return out;
}

function mergeRoutesDedupe(matrixPrefix, restRoutes) {
  const edgeKey = (r) => `${r.fromAsset}::${r.toAsset}`;
  const seen = new Set(matrixPrefix.map(edgeKey));
  const out = [...matrixPrefix];
  for (const r of restRoutes) {
    const k = edgeKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/**
 * allChains: one source chain → at most N−1 hops (one per other chain). No N×(N−1) aggregate.
 * Picks the chain with the most catalog coverage; rows + representativeRoutes are for that fan-out only.
 */
function computeChainPairMatrix(connectedRoutes, pairStats, sufficientByFromAsset) {
  const chainSet = new Set();
  for (const r of connectedRoutes) {
    chainSet.add(getChainRouteStepKey(r.fromAsset));
    chainSet.add(getChainRouteStepKey(r.toAsset));
  }
  const chainKeys = [...chainSet].sort();
  const n = chainKeys.length;
  const fanoutTotal = Math.max(0, n - 1);

  const byPairBest = new Map();
  for (const r of connectedRoutes) {
    const fc = getChainRouteStepKey(r.fromAsset);
    const tc = getChainRouteStepKey(r.toAsset);
    if (fc === tc) continue;
    const key = `${fc}::${tc}`;
    const sc = scoreHop(r.fromAsset, r.toAsset, pairStats);
    const prev = byPairBest.get(key);
    if (!prev || sc > prev.score) {
      byPairBest.set(key, { route: r, score: sc });
    }
  }

  const perChainFanout = [];
  for (const src of chainKeys) {
    let covered = 0;
    let executable = 0;
    const rows = [];
    for (const dst of cyclicChainDestinations(chainKeys, src)) {
      const key = `${src}::${dst}`;
      const best = byPairBest.get(key);
      const route = best ? best.route : null;
      if (route) covered += 1;

      const fromAsset = route?.fromAsset || null;
      const toAsset = route?.toAsset || null;
      let fromExecutable = false;
      if (route && sufficientByFromAsset && typeof sufficientByFromAsset.get === "function") {
        fromExecutable = sufficientByFromAsset.get(fromAsset) === true;
      }
      if (fromExecutable) executable += 1;

      rows.push({
        fromChain: src,
        toChain: dst,
        covered: !!route,
        route,
        fromAsset,
        toAsset,
        fromTicker: route
          ? String(
            route.fromMeta?.asset ||
              route.fromMeta?.ticker ||
              (fromAsset && fromAsset.split(":")[1]) ||
              ""
          ).toUpperCase()
          : null,
        toTicker: route
          ? String(
            route.toMeta?.asset || route.toMeta?.ticker || (toAsset && toAsset.split(":")[1]) || ""
          ).toUpperCase()
          : null,
        fromExecutable,
      });
    }
    perChainFanout.push({ chainKey: src, covered, executable, fanoutSlots: fanoutTotal, rows });
  }

  if (!perChainFanout.length) {
    return {
      distinctChains: n,
      chainKeys,
      fanoutTotal,
      coveredFanout: 0,
      executableFanout: 0,
      bestFanoutChainKey: null,
      fanoutCoveragePct: 100,
      executableFanoutPct: 100,
      perChainFanout: [],
      rows: [],
      representativeRoutes: [],
    };
  }

  let best = perChainFanout[0];
  for (const p of perChainFanout) {
    if (p.covered > best.covered || (p.covered === best.covered && p.chainKey < best.chainKey)) {
      best = p;
    }
  }

  const representativeRoutes = [];
  for (const row of best.rows) {
    if (row.route) representativeRoutes.push(row.route);
  }

  const fanoutCoveragePct =
    fanoutTotal > 0 ? Math.round((best.covered / fanoutTotal) * 100) : 100;
  const executableFanoutPct =
    fanoutTotal > 0 ? Math.round((best.executable / fanoutTotal) * 100) : 100;

  return {
    distinctChains: n,
    chainKeys,
    fanoutTotal,
    coveredFanout: best.covered,
    executableFanout: best.executable,
    bestFanoutChainKey: best.chainKey,
    fanoutCoveragePct,
    executableFanoutPct,
    perChainFanout: perChainFanout.map((p) => ({
      chainKey: p.chainKey,
      covered: p.covered,
      executable: p.executable,
      fanoutSlots: p.fanoutSlots,
    })),
    rows: best.rows,
    representativeRoutes,
  };
}

/** Round-robin order by source chain prefix so allChains does not run every (bitcoin→*) hop before other sources. */
function interleaveRepresentativeRoutesByFromChain(routes) {
  if (!routes?.length) return [];
  const byChain = new Map();
  for (const r of routes) {
    const k = getChainRouteStepKey(r.fromAsset);
    if (!byChain.has(k)) byChain.set(k, []);
    byChain.get(k).push(r);
  }
  const keys = [...byChain.keys()].sort();
  const out = [];
  let round = 0;
  for (;;) {
    let added = false;
    for (const k of keys) {
      const arr = byChain.get(k);
      if (round < arr.length) {
        out.push(arr[round]);
        added = true;
      }
    }
    if (!added) break;
    round++;
  }
  return out;
}

function planFromAllRoutes(allRoutes, opts = {}) {
  const maxTotal = Number.isFinite(opts.maxTotal) ? opts.maxTotal : 120;
  const perPairLimit = Number.isFinite(opts.perPairLimit) ? opts.perPairLimit : 3;
  const usedPerPair = new Map();
  const plan = [];
  for (const route of allRoutes) {
    const key = `${route.fromAsset}::${route.toAsset}`;
    const count = usedPerPair.get(key) || 0;
    if (count >= perPairLimit) continue;
    usedPerPair.set(key, count + 1);
    plan.push(route);
    if (plan.length >= maxTotal) break;
  }
  return plan;
}

function optimizeRoutes(routes, opts = {}) {
  if (!Array.isArray(routes) || routes.length === 0) return [];
  const { connectedTypes, connectedRoutes } = resolveConnectedTypesAndRoutes(routes, opts.connectedWalletTypes);
  const { allRoutes } = buildChainReactionFlow(connectedRoutes, {
    connectedWalletTypes: connectedTypes,
    balances: opts.balances || new Map(),
    gasBalances: opts.gasBalances || new Map(),
    memory: opts.memory || null,
    seedAllowlist: opts.seedAllowlist || null,
    chainRoutesUniqueChains: opts.chainRoutesUniqueChains === true,
  });
  return planFromAllRoutes(allRoutes, opts);
}

function analyzeWalletCoverage(routes, connectedWalletTypes) {
  const needed = new Set();
  const missing = new Set();
  for (const r of routes) {
    const fw = r.fromChain || getWalletTypeFromChain(getChainKey(r.fromAsset));
    const tw = r.toChain || getWalletTypeFromChain(getChainKey(r.toAsset));
    needed.add(fw);
    needed.add(tw);
    if (!connectedWalletTypes.has(fw)) missing.add(fw);
    if (!connectedWalletTypes.has(tw)) missing.add(tw);
  }
  return {
    needed: [...needed],
    missing: [...missing],
    allConnected: missing.size === 0,
    coveragePct: needed.size > 0 ? Math.round(((needed.size - missing.size) / needed.size) * 100) : 100,
  };
}

function getRouteReadiness(routes, opts = {}) {
  if (!Array.isArray(routes) || routes.length === 0) {
    return {
      assets: [],
      totalRoutes: 0,
      runnableRoutes: 0,
      readinessPct: 100,
      flowChains: [],
      chainPairMatrix: null,
      beamHopTotal: null,
      beamHopRunnable: null,
      walletCoverage: null,
      requiredAmountSufficient: true,
      requiredAmountSummary: { sufficientCount: 0, insufficientCount: 0, unknownCount: 0 },
      topThreeConditions: ["chain_funded", "insufficient_balance", "insufficient_gas"],
    };
  }

  const balances = opts.balances || new Map();
  const gasBalances = opts.gasBalances || new Map();
  const memory = opts.memory || null;

  const connectedTypes = opts.connectedWalletTypes || new Set();
  if (!connectedTypes.size) {
    for (const r of routes) {
      if (r.fromChain) connectedTypes.add(r.fromChain);
      if (r.toChain) connectedTypes.add(r.toChain);
    }
  }

  const connectedRoutes = routes.filter((r) => {
    const fw = r.fromChain || getWalletTypeFromChain(getChainKey(r.fromAsset));
    const tw = r.toChain || getWalletTypeFromChain(getChainKey(r.toAsset));
    return !connectedTypes.size || (connectedTypes.has(fw) && connectedTypes.has(tw));
  });

  const chains =
    opts.prebuiltChains != null
      ? opts.prebuiltChains
      : buildChainReactionFlow(connectedRoutes, {
        connectedWalletTypes: connectedTypes,
        balances,
        gasBalances,
        memory,
        seedAllowlist: opts.seedAllowlist || null,
        chainRoutesUniqueChains: opts.mode === "allChains",
        seedOrderMode: opts.mode === "allChains" ? "chains" : "allAssets",
      }).chains;

  const chainStartAssets = new Set(chains.map((c) => c.startAsset));
  const chainFundedSourceAssets = new Set();
  for (const chain of chains) {
    for (let i = 1; i < chain.routes.length; i++) {
      chainFundedSourceAssets.add(chain.routes[i].fromAsset);
    }
  }
  // Sequential chain funding profile:
  // tracks how much funding is still required at each hop when propagating
  // from the chain start asset depth-by-depth.
  const chainFundingProfile = new Map();
  for (let chainIndex = 0; chainIndex < chains.length; chainIndex++) {
    const chain = chains[chainIndex];
    const routeAmounts = (chain.routes || []).map((r) => toComparableBigInt(r.amount || r.fromMeta?.min_amount || 50000) || 0n);
    const startBalanceRaw = balances.has(chain.startAsset) ? balances.get(chain.startAsset) : null;
    const startBalanceBig = startBalanceRaw === null ? null : (toComparableBigInt(startBalanceRaw) || 0n);
    const prefixSpentByDepth = [0n];
    for (let i = 0; i < routeAmounts.length; i++) {
      prefixSpentByDepth.push(prefixSpentByDepth[i] + routeAmounts[i]);
    }
    const suffixNeedByDepth = new Array((chain.assets || []).length).fill(0n);
    for (let depth = 0; depth < (chain.assets || []).length; depth++) {
      let rem = 0n;
      for (let j = depth; j < routeAmounts.length; j++) rem += routeAmounts[j];
      suffixNeedByDepth[depth] = rem;
    }
    for (let depth = 0; depth < (chain.assets || []).length; depth++) {
      const assetId = chain.assets[depth];
      const remainingRequired = suffixNeedByDepth[depth] || 0n;
      const spentBefore = prefixSpentByDepth[depth] || 0n;
      const availableAtDepth = startBalanceBig === null
        ? null
        : (startBalanceBig > spentBefore ? (startBalanceBig - spentBefore) : 0n);
      const needMore = availableAtDepth === null
        ? remainingRequired
        : (remainingRequired > availableAtDepth ? (remainingRequired - availableAtDepth) : 0n);
      chainFundingProfile.set(assetId, {
        chainIndex,
        depth,
        remainingRequired,
        availableAtDepth,
        needMore,
        unknown: availableAtDepth === null,
      });
    }
  }
  const bySource = new Map();
  for (const r of connectedRoutes) {
    if (!bySource.has(r.fromAsset)) {
      const ck = getChainKey(r.fromAsset);
      bySource.set(r.fromAsset, {
        id: r.fromAsset,
        ticker: (r.fromMeta?.asset || r.fromMeta?.ticker || r.fromAsset.split(":")[1] || "").toUpperCase(),
        chain: ck,
        chainRaw: r.fromAsset.split(":")[0],
        walletType: r.fromChain || getWalletTypeFromChain(ck),
        name: r.fromMeta?.name || r.fromAsset,
        decimals: Number(r.fromMeta?.decimals || 8),
        minAmount: Number(r.fromMeta?.min_amount || r.amount || 50000),
        routes: [],
        isChainStart: chainStartAssets.has(r.fromAsset),
        chainIndex: chains.findIndex((c) => c.startAsset === r.fromAsset),
      });
    }
    bySource.get(r.fromAsset).routes.push(r);
  }

  const assets = [];
  let totalRoutes = 0;
  let runnableRoutes = 0;
  let sufficientCount = 0;
  let insufficientCount = 0;
  let unknownCount = 0;
  let fundedSeedCount = 0;

  for (const [assetId, info] of bySource) {
    const routeCount = info.isChainStart
      ? (chains[info.chainIndex]?.routes.length || info.routes.length)
      : info.routes.length;
    totalRoutes += routeCount;
    const balance = balances.has(assetId) ? balances.get(assetId) : null;
    const isChainFundedSource = chainFundedSourceAssets.has(assetId);
    const flowFunding = chainFundingProfile.get(assetId) || null;
    const requiredPerRoute = info.isChainStart
      ? info.minAmount
      : (isChainFundedSource ? 0 : info.minAmount);
    const requiredTotalBig = flowFunding
      ? flowFunding.remainingRequired
      : (isChainFundedSource
        ? 0n
        : (toComparableBigInt(requiredPerRoute) || 0n) * BigInt(routeCount));

    let hasGas = true;
    let gasBalance = null;
    if (info.walletType === "evm" && !isChainFundedSource) {
      const gas = gasBalances.get(info.chain);
      const gasBig = toComparableBigInt(gas);
      if (gas !== undefined && gasBig !== null) {
        gasBalance = gasBig;
        hasGas = gasBig >= MIN_GAS_WEI;
      }
    }

    let sufficient = false;
    let reason = null;
    if (isChainFundedSource) {
      if (flowFunding?.unknown) {
        reason = "balance_unknown";
        unknownCount += 1;
      } else if ((flowFunding?.needMore || 0n) > 0n) {
        reason = "insufficient_balance";
        insufficientCount += 1;
      } else if (info.walletType === "evm" && !hasGas) {
        reason = "insufficient_gas";
        insufficientCount += 1;
      } else {
        sufficient = true;
        reason = "chain_funded";
      }
    } else if (balance === null) {
      reason = "balance_unknown";
      unknownCount += 1;
    } else if (!isAtLeastAtomic(balance, requiredTotalBig)) {
      reason = "insufficient_balance";
      insufficientCount += 1;
    } else if (info.walletType === "evm" && !hasGas) {
      reason = "insufficient_gas";
      insufficientCount += 1;
    } else {
      sufficient = true;
    }

    if (sufficient) {
      sufficientCount += 1;
      runnableRoutes += routeCount;
      if (!isChainFundedSource) fundedSeedCount += 1;
    }

    let needMoreBig = 0n;
    if (flowFunding) {
      needMoreBig = flowFunding.needMore || 0n;
    } else if (!isChainFundedSource) {
      if (balance === null) {
        needMoreBig = requiredTotalBig;
      } else {
        const balBig = toComparableBigInt(balance) || 0n;
        needMoreBig = requiredTotalBig > balBig ? (requiredTotalBig - balBig) : 0n;
      }
    }

    assets.push({
      id: assetId,
      ticker: info.ticker,
      chain: info.chain,
      chainRaw: info.chainRaw,
      walletType: info.walletType,
      name: info.name,
      balance: toJsonSafe(balance),
      gasBalance: gasBalance !== null ? toJsonSafe(gasBalance) : null,
      required: toJsonSafe(requiredPerRoute),
      requiredTotal: toJsonSafe(requiredTotalBig),
      needMoreAtomic: toJsonSafe(needMoreBig),
      balanceNormalized: balance === null ? null : formatUnitsAtomic(balance, info.decimals),
      requiredTotalNormalized: formatUnitsAtomic(requiredTotalBig, info.decimals),
      needMoreNormalized: formatUnitsAtomic(needMoreBig, info.decimals),
      decimals: info.decimals,
      sufficient,
      reason,
      routeCount,
      isChainStart: info.isChainStart,
      isChainFundedSource,
      chainLength: chains[info.chainIndex]?.routes.length || 0,
      inFlowChain: info.chainIndex >= 0,
      flowChainIndex: info.chainIndex,
    });
  }

  assets.sort((a, b) => {
    if (a.isChainStart !== b.isChainStart) return a.isChainStart ? -1 : 1;
    if (a.sufficient !== b.sufficient) return a.sufficient ? -1 : 1;
    return b.routeCount - a.routeCount;
  });

  const flowChains = chains.map((c, idx) => ({
    index: idx,
    startAsset: c.startAsset,
    seedBalance: toJsonSafe(c.seedBalance),
    assets: c.assets,
    length: c.length,
    uniqueChainCount: new Set((c.assets || []).map((a) => getChainRouteStepKey(a))).size,
    pathScore: c.pathScore,
    ...(c.gasEstimate || estimatePathGas(c.assets, gasBalances, memory)),
  }));

  const pairStatsForMatrix = memory?.getAllPairStats?.() || null;
  const sufficientByFrom = new Map(assets.map((a) => [a.id, a.sufficient]));
  const chainPairMatrixRaw =
    opts.mode === "allChains"
      ? computeChainPairMatrix(connectedRoutes, pairStatsForMatrix, sufficientByFrom)
      : null;

  // Beam hop counts (one path per seed) — secondary to N−1 fan-out in allChains UI.
  let beamHopTotal = null;
  let beamHopRunnable = null;
  if (opts.mode === "allChains" && chains.length > 0) {
    beamHopTotal = chains.reduce((s, c) => s + (c.routes?.length || 0), 0);
    const assetById = new Map(assets.map((a) => [a.id, a]));
    beamHopRunnable = chains.reduce((s, c) => {
      let n = 0;
      for (const r of c.routes || []) {
        const row = assetById.get(r.fromAsset);
        if (!row || !row.sufficient) break;
        n++;
      }
      return s + n;
    }, 0);
  }

  // allChains: headline = N−1 fan-out from best source chain (no N×(N−1)).
  let totalRoutesReport = totalRoutes;
  let runnableRoutesReport = runnableRoutes;
  let readinessPctReport =
    totalRoutesReport > 0 ? Math.round((runnableRoutesReport / totalRoutesReport) * 100) : 100;

  if (opts.mode === "allChains" && chainPairMatrixRaw && chainPairMatrixRaw.fanoutTotal > 0) {
    totalRoutesReport = chainPairMatrixRaw.fanoutTotal;
    runnableRoutesReport = chainPairMatrixRaw.coveredFanout;
    readinessPctReport = chainPairMatrixRaw.fanoutCoveragePct;
  } else if (opts.mode === "allChains" && chains.length > 0 && beamHopTotal !== null) {
    totalRoutesReport = beamHopTotal;
    runnableRoutesReport = beamHopRunnable;
    readinessPctReport =
      beamHopTotal > 0 ? Math.round((beamHopRunnable / beamHopTotal) * 100) : 100;
  }

  const chainPairMatrix =
    opts.mode === "allChains" && chainPairMatrixRaw
      ? {
        distinctChains: chainPairMatrixRaw.distinctChains,
        chainKeys: chainPairMatrixRaw.chainKeys,
        fanoutTotal: chainPairMatrixRaw.fanoutTotal,
        coveredFanout: chainPairMatrixRaw.coveredFanout,
        executableFanout: chainPairMatrixRaw.executableFanout,
        bestFanoutChainKey: chainPairMatrixRaw.bestFanoutChainKey,
        fanoutCoveragePct: chainPairMatrixRaw.fanoutCoveragePct,
        executableFanoutPct: chainPairMatrixRaw.executableFanoutPct,
        perChainFanout: chainPairMatrixRaw.perChainFanout,
        rows: chainPairMatrixRaw.rows.map((row) => ({
          fromChain: row.fromChain,
          toChain: row.toChain,
          covered: row.covered,
          fromAsset: row.fromAsset,
          toAsset: row.toAsset,
          fromTicker: row.fromTicker,
          toTicker: row.toTicker,
          fromExecutable: row.fromExecutable,
        })),
      }
      : null;

  return {
    assets,
    totalRoutes: totalRoutesReport,
    runnableRoutes: runnableRoutesReport,
    readinessPct: readinessPctReport,
    flowChains,
    chainPairMatrix,
    beamHopTotal,
    beamHopRunnable,
    walletCoverage: analyzeWalletCoverage(connectedRoutes, connectedTypes),
    totalAssets: bySource.size,
    totalFlowChainRoutes: chains.reduce((sum, c) => sum + c.routes.length, 0),
    fundedSeedCount,
    requiredAmountSufficient: insufficientCount === 0 && unknownCount === 0,
    requiredAmountSummary: { sufficientCount, insufficientCount, unknownCount },
    topThreeConditions: ["chain_funded", "insufficient_balance", "insufficient_gas"],
  };
}

class RouteOptimizerAgent {
  constructor(dbAdapter = null) {
    this.memory = new AgentMemoryFallback(dbAdapter);
  }

  async init() {
    await this.memory.loadFromDB();
    console.log("[RouteOptimizerAgent] Ready");
  }

  pickOneSeedPerChain(routes, balances = new Map(), gasBalances = new Map()) {
    const minAmtByAsset = new Map();
    for (const r of routes) {
      const id = r.fromAsset;
      if (minAmtByAsset.has(id)) continue;
      minAmtByAsset.set(id, Number(r.amount || r.fromMeta?.min_amount || 50000));
    }

    const byChain = new Map();
    for (const r of routes) {
      const ck = getChainKey(r.fromAsset);
      if (!byChain.has(ck)) byChain.set(ck, new Set());
      byChain.get(ck).add(r.fromAsset);
    }

    const picked = new Set();
    for (const [ck, assetsSet] of byChain) {
      const assets = [...assetsSet];
      const available = assets.filter((assetId) => {
        const bal = balances.get(assetId);
        const minAmt = minAmtByAsset.get(assetId) ?? 50000;
        if (bal === null || bal === undefined) return false;
        if (!isAtLeastAtomic(bal, minAmt)) return false;
        if (getWalletTypeFromChain(ck) === "evm") {
          const gas = gasBalances.get(ck);
          const gasBig = toComparableBigInt(gas);
          if (gas !== undefined && gasBig !== null && gasBig < MIN_GAS_WEI) return false;
        }
        return true;
      });
      if (!available.length) continue;
      const chosen = available[Math.floor(Math.random() * available.length)];
      picked.add(chosen);
      console.log(`[RouteOptimizerAgent] chain=${ck} pickedSeed=${chosen}`);
    }
    return picked;
  }

  run(routes, opts = {}, mode = "allTests") {
    const balances = opts.balances || new Map();
    const gasBalances = opts.gasBalances || new Map();

    let seedAllowlist = null;
    let pickedMapForChains = null;

    const { connectedTypes, connectedRoutes } = resolveConnectedTypesAndRoutes(
      routes,
      opts.connectedWalletTypes
    );

    if (mode === "allChains") {
      if (opts.seedAllowlist instanceof Set && opts.seedAllowlist.size > 0) {
        seedAllowlist = opts.seedAllowlist;
        pickedMapForChains = new Map();
        for (const assetId of seedAllowlist) {
          pickedMapForChains.set(getChainRouteStepKey(assetId), assetId);
        }
      } else {
        pickedMapForChains = pickOneRandomAssetPerChainPrefix(connectedRoutes, balances, gasBalances);
        seedAllowlist = new Set(pickedMapForChains.values());
      }
    }

    const closeCycle = true;

    const flow = buildChainReactionFlow(connectedRoutes, {
      connectedWalletTypes: connectedTypes,
      balances,
      gasBalances,
      memory: this.memory,
      seedAllowlist,
      chainRoutesUniqueChains: mode === "allChains",
      seedOrderMode: mode === "allChains" ? "chains" : "allAssets",
      closeCycle,
    });

    const pairStats = this.memory?.getAllPairStats?.() || null;
    const liquidByChain = buildLiquidSourceAssetsByChain(connectedRoutes, balances, gasBalances);

    let matrixPrefix = [];
    if (mode === "allTests") {
      matrixPrefix = buildAllTestsChainMatrixCoverage(connectedRoutes, balances, gasBalances, pairStats);
    } else {
      const pm =
        pickedMapForChains ||
        pickOneRandomAssetPerChainPrefix(connectedRoutes, balances, gasBalances);
      matrixPrefix = buildAllChainsPickedMatrixCoverage(
        connectedRoutes,
        balances,
        gasBalances,
        pairStats,
        pm,
        liquidByChain
      );
    }

    const chainKeys = [
      ...new Set(
        connectedRoutes.flatMap((r) => [getChainRouteStepKey(r.fromAsset), getChainRouteStepKey(r.toAsset)])
      ),
    ];
    const chainDim = chainKeys.length;
    const maxTotalDefault = Math.min(
      2048,
      Math.max(160, chainDim * chainDim + matrixPrefix.length + 100)
    );

    let routesForPlan = flow.allRoutes;
    if (mode === "allChains") {
      const matrix = computeChainPairMatrix(connectedRoutes, pairStats, null);
      const interleaved = interleaveRepresentativeRoutesByFromChain(matrix.representativeRoutes);
      routesForPlan = mergeRoutesDedupe(matrixPrefix, [...interleaved, ...flow.allRoutes]);
    } else {
      routesForPlan = mergeRoutesDedupe(matrixPrefix, flow.allRoutes);
    }

    const rawPlan = planFromAllRoutes(routesForPlan, {
      maxTotal: Number.isFinite(opts.maxTotal) ? opts.maxTotal : maxTotalDefault,
      perPairLimit: Number.isFinite(opts.perPairLimit) ? opts.perPairLimit : 3,
    });

    const readiness = getRouteReadiness(routes, {
      ...opts,
      balances,
      gasBalances,
      memory: this.memory,
      seedAllowlist,
      mode,
      prebuiltChains: flow.chains,
    });

    // Safety: only execute routes whose source asset is currently sufficient.
    const sufficientBySource = new Map((readiness.assets || []).map((a) => [a.id, !!a.sufficient]));
    const executablePlan = rawPlan.filter((r) => sufficientBySource.get(r.fromAsset) === true);
    const linearExecutablePlan = (() => {
      if (mode !== "allChains") return executablePlan;
      // One executable hop per directed chain pair (within N−1 fan-out + rest), not one per source asset.
      const seenChainPairs = new Set();
      return executablePlan.filter((r) => {
        const fc = getChainRouteStepKey(r.fromAsset);
        const tc = getChainRouteStepKey(r.toAsset);
        const key = `${fc}::${tc}`;
        if (seenChainPairs.has(key)) return false;
        seenChainPairs.add(key);
        return true;
      });
    })();

    const result = {
      mode,
      selectedRunOption: mode,
      availableRunOptions: ["allTests", "allChains"],
      topThreeConditions: readiness.topThreeConditions,
      requiredAmountSufficient: readiness.requiredAmountSufficient,
      requiredAmountSummary: readiness.requiredAmountSummary,
      rawPlanCount: rawPlan.length,
      executablePlanCount: linearExecutablePlan.length,
      plan: linearExecutablePlan,
      readiness,
      chains: readiness.flowChains,
    };

    console.log(
      `[RouteOptimizerAgent] mode=${mode} plan=${linearExecutablePlan.length} ` +
      `requiredAmountSufficient=${result.requiredAmountSufficient}`
    );

    return result;
  }

  recordOutcome(fromAssetId, toAssetId, result) {
    this.memory.recordPairResult(fromAssetId, toAssetId, result);
  }

  recordGasUsage(chainKeyStr, gasUsedWei, failed = false) {
    this.memory.recordChainGasResult(chainKeyStr, { gasUsedWei, failed });
  }
}

module.exports = {
  RouteOptimizerAgent,
  optimizeRoutes,
  getRouteReadiness,
  buildChainReactionFlow,
  computeChainPairMatrix,
};