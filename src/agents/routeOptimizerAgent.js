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

/**
 * Detect isolation clusters from the adjacency graph.
 * Two chains are in the same cluster if they share edges across 2+ distinct asset families.
 * Chains connected ONLY via a single family (e.g. only WBTC) are in separate clusters.
 * This naturally separates e.g. {Arb, Base, Eth} from {Corn, Botanix, Citrea}
 * when the only bridge between them is BTC-family.
 */
function detectIsolationClusters(adj, allChainKeys) {
  const pairFamilies = new Map();
  for (const [fromAsset, edges] of adj.entries()) {
    const fromChain = getChainRouteStepKey(fromAsset);
    const fromFamily = assetFamilyFromIdOrName(fromAsset, "");
    for (const edge of edges) {
      const toChain = getChainRouteStepKey(edge.toAssetId);
      if (fromChain === toChain) continue;
      const key = [fromChain, toChain].sort().join("::");
      if (!pairFamilies.has(key)) pairFamilies.set(key, new Set());
      pairFamilies.get(key).add(fromFamily);
    }
  }

  // "Strong" adjacency: only edges with 2+ distinct asset families
  const strongAdj = new Map();
  for (const chain of allChainKeys) strongAdj.set(chain, new Set());
  for (const [key, families] of pairFamilies) {
    if (families.size < 2) continue;
    const parts = key.split("::");
    strongAdj.get(parts[0])?.add(parts[1]);
    strongAdj.get(parts[1])?.add(parts[0]);
  }

  // BFS to find connected components
  const visited = new Set();
  const clusters = [];
  for (const chain of allChainKeys) {
    if (visited.has(chain)) continue;
    const cluster = new Set();
    const queue = [chain];
    visited.add(chain);
    while (queue.length) {
      const cur = queue.shift();
      cluster.add(cur);
      for (const neighbor of (strongAdj.get(cur) || [])) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    clusters.push(cluster);
  }

  // Merge singleton clusters into the nearest cluster with ANY weak edge
  const merged = clusters.filter(c => c.size > 1);
  const singletons = clusters.filter(c => c.size === 1);
  for (const s of singletons) {
    const chain = [...s][0];
    let bestCluster = null;
    let bestFamilies = 0;
    for (const [key, families] of pairFamilies) {
      const parts = key.split("::");
      const other = parts[0] === chain ? parts[1] : (parts[1] === chain ? parts[0] : null);
      if (!other) continue;
      for (const mc of merged) {
        if (mc.has(other) && families.size > bestFamilies) {
          bestFamilies = families.size;
          bestCluster = mc;
        }
      }
    }
    if (bestCluster) bestCluster.add(chain);
    else if (merged.length) merged[0].add(chain);
    else merged.push(s);
  }

  return merged.length ? merged : [new Set(allChainKeys)];
}

/**
 * Build a filtered adjacency map containing only edges within a given set of chains.
 */
function filterAdjToChains(adj, chainSet) {
  const filtered = new Map();
  for (const [fromAsset, edges] of adj.entries()) {
    if (!chainSet.has(getChainRouteStepKey(fromAsset))) continue;
    const kept = edges.filter(e => chainSet.has(getChainRouteStepKey(e.toAssetId)));
    if (kept.length) filtered.set(fromAsset, kept);
  }
  return filtered;
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
  const gasBalances = opts.gasBalances || new Map();
  const memory = opts.memory || null;
  const beamWidth = Number(opts.beamWidth || BEAM_WIDTH);
  const maxDepth = Number(opts.maxDepth || MAX_DEPTH);
  const uniqueChainsOnly = opts.chainRoutesUniqueChains === true;

  let beam = [{ assets: [seedId] }];
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
        candidates.push({ assets: [...partial.assets, edge.toAssetId] });
        expanded = true;
      }

      if (!expanded && partial.assets.length > 1) {
        const gas = estimatePathGas(partial.assets, gasBalances, memory);
        const feasibleForBeam = uniqueChainsOnly ? true : gas.feasible;
        if (feasibleForBeam && (!best || partial.assets.length > best.assets.length)) {
          best = { ...partial, gasEstimate: gas };
        }
      }
    }

    if (!candidates.length) break;
    if (uniqueChainsOnly) {
      // Guarantee at least one random candidate per reachable chain survives the beam cut.
      const byNextChain = new Map();
      for (const c of candidates) {
        const ck = getChainRouteStepKey(c.assets[c.assets.length - 1]);
        if (!byNextChain.has(ck)) byNextChain.set(ck, []);
        byNextChain.get(ck).push(c);
      }
      const guaranteed = [];
      for (const [, group] of byNextChain) {
        shuffleArray(group);
        guaranteed.push(group[0]);
        if (group.length > 1 && beamWidth > byNextChain.size * 2) {
          guaranteed.push(group[1]);
        }
      }
      const guaranteedSet = new Set(guaranteed);
      const rest = candidates.filter(c => !guaranteedSet.has(c));
      shuffleArray(rest);
      beam = [...guaranteed, ...rest].slice(0, Math.max(beamWidth, guaranteed.length));
    } else {
      shuffleArray(candidates);
      beam = candidates.slice(0, beamWidth);
    }
  }

  if (!best) {
    // Pick the longest path from the beam (random tiebreak via shuffle)
    shuffleArray(beam);
    beam.sort((a, b) => b.assets.length - a.assets.length);
    for (const p of beam) {
      if (p.assets.length < 2) continue;
      const gas = estimatePathGas(p.assets, gasBalances, memory);
      if (!uniqueChainsOnly && !gas.feasible) continue;
      best = { ...p, gasEstimate: gas };
      break;
    }
  }

  return best;
}

/**
 * Two-phase chain-first routing for allChains mode.
 * Phase 1: Build a chain-level graph and find the longest chain order via DFS.
 * Phase 2: For each hop, pick a RANDOM asset pair, check conditions (known-bad pair,
 *          gas availability). If dest has no gas and Garden supports a native gas token
 *          on that chain, substitute the dest asset to native so the swap delivers gas.
 *          Child chains are unchanged.
 *
 * This avoids BEAM_WIDTH pruning entirely — with ~20 chain nodes, full DFS is fast.
 */
function chainFirstPath(seedId, adj, opts = {}) {
  const usedDestinations = opts.usedDestinations || new Set();
  const pairStats = opts.pairStats || null;
  const gasBalances = opts.gasBalances || new Map();
  const memory = opts.memory || null;
  const supportedAssets = opts.supportedAssets || [];

  const seedChain = getChainRouteStepKey(seedId);

  // Phase 1: Build chain-level adjacency and track asset pairs per chain hop.
  const chainAdj = new Map();
  const chainPairs = new Map();

  for (const [fromAsset, edges] of adj.entries()) {
    const fromChain = getChainRouteStepKey(fromAsset);
    for (const edge of edges) {
      if (usedDestinations.has(edge.toAssetId)) continue;
      const toChain = getChainRouteStepKey(edge.toAssetId);
      if (fromChain === toChain) continue;

      if (!chainAdj.has(fromChain)) chainAdj.set(fromChain, new Set());
      chainAdj.get(fromChain).add(toChain);

      const pairKey = `${fromChain}::${toChain}`;
      if (!chainPairs.has(pairKey)) chainPairs.set(pairKey, []);
      chainPairs.get(pairKey).push({
        fromAsset,
        toAsset: edge.toAssetId,
        route: edge.route,
      });
    }
  }

  const allChains = [...new Set([...chainAdj.keys(), ...[...chainAdj.values()].flatMap(s => [...s])])];
  console.log(`[chain-first] Phase 1: ${allChains.length} chains in graph, seed=${seedChain}`);

  // DFS: find the longest path visiting the most unique chains
  let bestChainPath = [seedChain];

  function dfs(current, visited, path) {
    if (path.length > bestChainPath.length) bestChainPath = [...path];
    if (path.length >= allChains.length) return;

    const neighbors = chainAdj.get(current);
    if (!neighbors) return;

    const unvisited = [...neighbors].filter(n => !visited.has(n));
    shuffleArray(unvisited);

    for (const next of unvisited) {
      visited.add(next);
      path.push(next);
      dfs(next, visited, path);
      path.pop();
      visited.delete(next);
      if (bestChainPath.length >= allChains.length) return;
    }
  }

  dfs(seedChain, new Set([seedChain]), [seedChain]);
  console.log(`[chain-first] Phase 1 result: ${bestChainPath.length}-chain path: ${bestChainPath.join(' → ')}`);

  if (bestChainPath.length < 2) return null;

  // Phase 2: For each hop, pick a random asset pair and check conditions.
  const resultAssets = [];
  let prevChosenToAsset = null;

  for (let i = 0; i < bestChainPath.length - 1; i++) {
    const fromChain = bestChainPath[i];
    const toChain = bestChainPath[i + 1];
    const pairKey = `${fromChain}::${toChain}`;
    let candidates = chainPairs.get(pairKey) || [];

    // Chain continuity: narrow to pairs starting from previous hop's output
    if (prevChosenToAsset) {
      const exact = candidates.filter(c => c.fromAsset === prevChosenToAsset);
      if (exact.length) candidates = exact;
    }

    // Random selection: shuffle then iterate
    shuffleArray(candidates);

    // Gas check for destination chain
    const destGas = gasBalances.get(toChain);
    const destGasBig = toComparableBigInt(destGas);
    const destHasGas = destGas === undefined || (destGasBig !== null && destGasBig >= MIN_GAS_WEI);

    // If dest has no gas, find a Garden-supported native gas token on that chain
    let nativeGasAssetId = null;
    if (!destHasGas) {
      const nativeAsset = findNativeGasAssetOnChain(toChain, supportedAssets, adj);
      if (nativeAsset) {
        nativeGasAssetId = nativeAsset;
        console.log(`[chain-first]   ${toChain}: no gas — will substitute dest to native ${nativeGasAssetId}`);
      }
    }

    let pick = null;
    for (const c of candidates) {
      // Check: skip pairs with 0% historical success (3+ attempts, all failed)
      const stat = pairStats?.get(`${c.fromAsset}::${c.toAsset}`);
      if (stat) {
        const total = Number(stat.successes || 0) + Number(stat.failures || 0);
        if (total >= 3 && Number(stat.successes || 0) === 0) continue;
      }

      // Gas substitution: if dest has no gas and native token is supported,
      // check if there's a pair from this source to the native token instead
      if (nativeGasAssetId && c.toAsset !== nativeGasAssetId) {
        const nativeEdge = (adj.get(c.fromAsset) || []).find(e => e.toAssetId === nativeGasAssetId);
        if (nativeEdge) {
          pick = { fromAsset: c.fromAsset, toAsset: nativeGasAssetId, route: nativeEdge.route, _gasSubstituted: true };
          console.log(`[chain-first]   ${fromChain} → ${toChain}: substituted ${c.toAsset} → ${nativeGasAssetId} (gas delivery)`);
          break;
        }
      }

      pick = c;
      break;
    }

    // Fallback: if all failed checks, pick first candidate anyway
    if (!pick && candidates.length) pick = candidates[0];

    if (!pick) {
      console.log(`[chain-first] Phase 2: no asset pair for ${fromChain} → ${toChain} — chain path broken`);
      break;
    }

    resultAssets.push(pick.fromAsset);
    prevChosenToAsset = pick.toAsset;

    if (i === bestChainPath.length - 2) {
      resultAssets.push(pick.toAsset);
    }
  }

  if (resultAssets.length < 2) return null;

  console.log(`[chain-first] Phase 2 result: ${resultAssets.length}-asset path across ${bestChainPath.length} chains`);
  return { assets: resultAssets, score: 0, gasEstimate: estimatePathGas(resultAssets, gasBalances, memory) };
}

/**
 * Find a Garden-supported native gas token on a given chain.
 * Returns the asset ID if found, null otherwise.
 */
function findNativeGasAssetOnChain(chainKey, supportedAssets, adj) {
  const nativeTickers = new Set(['eth', 'bnb', 'bera', 'mon', 'core', 'btc', 'cbtc', 'btcn', 'trx', 'sol']);
  for (const a of supportedAssets) {
    const ac = getChainRouteStepKey(a.id || '');
    if (ac !== chainKey) continue;
    const ticker = ((a.asset || a.ticker || a.id?.split(':')[1]) || '').toLowerCase();
    const isNative = a.is_native || a.isNative ||
      (a.token_address || a.tokenAddress || '') === 'native' ||
      (a.token_address || a.tokenAddress || '') === '0x0000000000000000000000000000000000000000' ||
      nativeTickers.has(ticker);
    if (!isNative) continue;
    // Verify this asset is actually in the adjacency graph (Garden supports swaps to it)
    for (const [, edges] of adj.entries()) {
      if (edges.some(e => e.toAssetId === a.id)) return a.id;
    }
  }
  return null;
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

  const allChainKeysFromAPI = [...new Set(
    connected.flatMap(r => [getChainRouteStepKey(r.fromAsset), getChainRouteStepKey(r.toAsset)])
  )];
  const chainCount = allChainKeysFromAPI.length;
  // Scale depth and width to the number of available chains so no chain is lost to fixed limits
  const dynamicMaxDepth = Math.max(MAX_DEPTH, chainCount + 2);
  const dynamicBeamWidth = Math.max(BEAM_WIDTH, chainCount);
  console.log(`[DEBUG] All chains from API: ${allChainKeysFromAPI.sort()} (${chainCount} chains, ${connected.length} routes) — beam: width=${dynamicBeamWidth} depth=${dynamicMaxDepth}`);

  const adj = new Map();
  for (const r of connected) {
    if (!adj.has(r.fromAsset)) adj.set(r.fromAsset, []);
    adj.get(r.fromAsset).push({ toAssetId: r.toAsset, route: r });
  }

  // Build a deduplicated asset list from route metadata for native gas token lookups
  const seenAssetIds = new Set();
  const supportedAssets = [];
  for (const r of connected) {
    for (const meta of [r.fromMeta, r.toMeta]) {
      if (!meta) continue;
      const id = meta.id || meta.asset_id || r.fromAsset;
      if (seenAssetIds.has(id)) continue;
      seenAssetIds.add(id);
      supportedAssets.push(meta);
    }
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

  // BFS: transitive chain reachability from a starting asset through a given adj graph
  function transitiveChainReach(startAssetId, adjGraph) {
    const visited = new Set();
    const reachableChains = new Set();
    const queue = [startAssetId];
    visited.add(startAssetId);
    reachableChains.add(getChainRouteStepKey(startAssetId));
    while (queue.length) {
      const cur = queue.shift();
      for (const edge of (adjGraph.get(cur) || [])) {
        reachableChains.add(getChainRouteStepKey(edge.toAssetId));
        if (!visited.has(edge.toAssetId)) {
          visited.add(edge.toAssetId);
          queue.push(edge.toAssetId);
        }
      }
    }
    return reachableChains;
  }

  /**
   * Pick the best seed for a cluster: max transitive reach within the cluster adj,
   * fee-eligible, random raffle among ties.
   */
  function pickSeedForCluster(pool, clusterAdj) {
    if (!pool.length) return null;
    const scored = pool.map((s) => {
      const reach = transitiveChainReach(s.assetId, clusterAdj);
      const nHops = Math.max(0, reach.size - 1);
      const required = nHops > 0
        ? BigInt(Math.ceil(s.minAmt * Math.pow(1 / (1 - 0.0035), nHops)))
        : BigInt(s.minAmt);
      const bal = toComparableBigInt(s.balance);
      const feeOk = bal !== null && bal >= required;
      return { seed: s, reachCount: reach.size, nHops, feeOk };
    });
    const maxReach = Math.max(...scored.map((s) => s.reachCount));
    const best = scored.filter((s) => s.reachCount === maxReach && s.feeOk);
    const fallback = !best.length ? scored.filter((s) => s.reachCount === maxReach) : [];
    const finalPool = best.length ? best : (fallback.length ? fallback : scored);
    const pick = finalPool[Math.floor(Math.random() * finalPool.length)];
    return pick ? pick.seed : null;
  }

  const chains = [];
  const usedDestinations = new Set();

  if (opts.singleSeed) {
    // allChains: detect isolation clusters, run one cycle per cluster.
    // Each cluster gets its own seed + own chainFirstPath, so assets stay varied
    // within a cluster instead of being forced to WBTC at every isolation boundary.
    const clusters = detectIsolationClusters(adj, allChainKeysFromAPI);
    console.log(`[DEBUG] Detected ${clusters.length} isolation cluster(s):`,
      clusters.map(c => `[${[...c].sort().join(', ')}]`).join(' | '));

    for (const cluster of clusters) {
      const clusterAdj = filterAdjToChains(adj, cluster);
      const clusterPool = (candidateSeeds.length ? candidateSeeds : seedAssets)
        .filter(s => cluster.has(getChainRouteStepKey(s.assetId)));

      const seed = pickSeedForCluster(clusterPool, clusterAdj);
      if (!seed) {
        console.log(`[chain-first] Cluster [${[...cluster].sort().join(', ')}]: no funded seed — skipping`);
        continue;
      }
      console.log(`[chain-first] Cluster [${[...cluster].sort().join(', ')}]: seed=${seed.assetId}`);

      let path = chainFirstPath(seed.assetId, clusterAdj, {
        usedDestinations,
        pairStats,
        gasBalances,
        memory,
        supportedAssets,
      });
      if (!path || path.assets.length < 2) {
        path = beamSearchPath(seed.assetId, clusterAdj, {
          usedDestinations,
          gasBalances,
          memory,
          chainRoutesUniqueChains: true,
          maxDepth: Math.max(MAX_DEPTH, cluster.size + 2),
          beamWidth: Math.max(BEAM_WIDTH, cluster.size),
        });
      }
      if (!path || path.assets.length < 2) continue;

      for (let i = 1; i < path.assets.length; i++) usedDestinations.add(path.assets[i]);

      const routesForPath = [];
      for (let i = 0; i < path.assets.length - 1; i++) {
        const from = path.assets[i];
        const to = path.assets[i + 1];
        const edge = (clusterAdj.get(from) || []).find((e) => e.toAssetId === to);
        if (edge) routesForPath.push(edge.route);
      }
      if (!routesForPath.length) continue;

      // Close cycle: last asset → seed
      const lastAsset = path.assets[path.assets.length - 1];
      if (closeCycle && lastAsset !== seed.assetId) {
        const closingEdge = (clusterAdj.get(lastAsset) || []).find((e) => e.toAssetId === seed.assetId);
        if (closingEdge) {
          const closedAssets = [...path.assets, seed.assetId];
          const gas = estimatePathGas(closedAssets, gasBalances, memory);
          if (gas.feasible) {
            path.assets = closedAssets;
            routesForPath.push(closingEdge.route);
          }
        }
      }

      chains.push({
        startAsset: seed.assetId,
        seedBalance: seed.balance,
        assets: path.assets,
        routes: routesForPath,
        length: routesForPath.length,
        pathScore: 0,
        gasEstimate: estimatePathGas(path.assets, gasBalances, memory),
      });
    }
  } else {
    // allTests / other modes: use existing seed ordering + beam search
    if (opts.seedOrderMode === "allAssets" && seedsForBeam.length) {
      seedsForBeam = orderSeedsCyclicAllAssets(seedsForBeam);
    } else if (opts.seedOrderMode === "chains" && seedsForBeam.length) {
      seedsForBeam = orderSeedsCyclicByChain(seedsForBeam);
    }

    for (const seed of seedsForBeam) {
      const path = beamSearchPath(seed.assetId, adj, {
        usedDestinations,
        gasBalances,
        memory,
        chainRoutesUniqueChains: opts.chainRoutesUniqueChains === true,
        maxDepth: opts.beamDepth != null ? Number(opts.beamDepth) : dynamicMaxDepth,
        beamWidth: dynamicBeamWidth,
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

      const lastAsset = path.assets[path.assets.length - 1];
      const closeTarget = path.assets.length >= 2 ? path.assets[1] : null;
      if (closeCycle && closeTarget && closeTarget !== lastAsset) {
        const closingEdge = (adj.get(lastAsset) || []).find((e) => e.toAssetId === closeTarget);
        if (closingEdge) {
          const closedAssets = [...path.assets, closeTarget];
          const gas = estimatePathGas(closedAssets, gasBalances, memory);
          if (gas.feasible) {
            path.assets = closedAssets;
            routesForPath.push(closingEdge.route);
          }
        }
      }

      chains.push({
        startAsset: seed.assetId,
        seedBalance: seed.balance,
        assets: path.assets,
        routes: routesForPath,
        length: routesForPath.length,
        pathScore: 0,
        gasEstimate: estimatePathGas(path.assets, gasBalances, memory),
      });
    }
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
      const shuffled = [...neighbors];
      shuffleArray(shuffled);
      for (const edge of shuffled) {
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
          pathScore: 0,
          gasEstimate: gas,
        });
        break;
      }
    }
  }

  let beamChainKeys = [...new Set(
    chains.flatMap(c => c.routes.flatMap(r => [getChainRouteStepKey(r.fromAsset), getChainRouteStepKey(r.toAsset)]))
  )];
  let excludedChains = allChainKeysFromAPI.filter(ck => !beamChainKeys.includes(ck));
  console.log("[DEBUG] Beam included chains:", beamChainKeys.sort(), `(${beamChainKeys.length}/${allChainKeysFromAPI.length})`);
  if (excludedChains.length) console.log("[DEBUG] Beam EXCLUDED chains:", excludedChains.sort(), "— attempting island recovery");

  // Safety net: recover any chains still not covered (e.g. cluster detection missed them).
  // Uses chainFirstPath on the unreached-chain sub-graph with a local seed.
  if (excludedChains.length && opts.singleSeed) {
    const reachedChainSet = new Set(beamChainKeys);
    const unreachedSet = new Set(excludedChains);

    // Group unreached chains into their own mini-clusters
    const unreachedAdj = filterAdjToChains(adj, unreachedSet);
    const unreachedSeeds = seedAssets.filter(s => unreachedSet.has(getChainRouteStepKey(s.assetId)));

    for (const islandSeed of unreachedSeeds) {
      if (reachedChainSet.has(getChainRouteStepKey(islandSeed.assetId))) continue;

      let islandPath = chainFirstPath(islandSeed.assetId, unreachedAdj, {
        usedDestinations, pairStats, gasBalances, memory, supportedAssets,
      });
      if (!islandPath || islandPath.assets.length < 2) {
        islandPath = beamSearchPath(islandSeed.assetId, unreachedAdj, {
          usedDestinations, gasBalances, memory,
          chainRoutesUniqueChains: true,
          maxDepth: Math.max(MAX_DEPTH, unreachedSet.size + 2),
          beamWidth: Math.max(BEAM_WIDTH, unreachedSet.size),
        });
      }
      if (!islandPath || islandPath.assets.length < 2) continue;

      for (let i = 1; i < islandPath.assets.length; i++) usedDestinations.add(islandPath.assets[i]);

      const islandRoutes = [];
      for (let i = 0; i < islandPath.assets.length - 1; i++) {
        const from = islandPath.assets[i];
        const to = islandPath.assets[i + 1];
        const edge = (unreachedAdj.get(from) || adj.get(from) || []).find(e => e.toAssetId === to);
        if (edge) islandRoutes.push(edge.route);
      }
      if (!islandRoutes.length) continue;

      // Close cycle back to seed
      const lastAsset = islandPath.assets[islandPath.assets.length - 1];
      if (closeCycle && lastAsset !== islandSeed.assetId) {
        const closingEdge = (unreachedAdj.get(lastAsset) || []).find(e => e.toAssetId === islandSeed.assetId);
        if (closingEdge) {
          const closedAssets = [...islandPath.assets, islandSeed.assetId];
          const gas = estimatePathGas(closedAssets, gasBalances, memory);
          if (gas.feasible) {
            islandPath.assets = closedAssets;
            islandRoutes.push(closingEdge.route);
          }
        }
      }

      chains.push({
        startAsset: islandSeed.assetId,
        seedBalance: islandSeed.balance,
        assets: islandPath.assets,
        routes: islandRoutes,
        length: islandRoutes.length,
        pathScore: 0,
        gasEstimate: estimatePathGas(islandPath.assets, gasBalances, memory),
        _islandRecovery: true,
      });
      console.log(`[DEBUG] Island recovery: found ${islandPath.assets.length}-node path from ${islandSeed.assetId} covering ${[...new Set(islandPath.assets.map(a => getChainRouteStepKey(a)))].join(', ')}`);

      for (const a of islandPath.assets) reachedChainSet.add(getChainRouteStepKey(a));
    }
    beamChainKeys = [...reachedChainSet];
    excludedChains = allChainKeysFromAPI.filter(ck => !reachedChainSet.has(ck));
    if (excludedChains.length) {
      for (const ck of excludedChains) {
        const hasOutgoing = connected.some(r => getChainRouteStepKey(r.fromAsset) === ck);
        const hasIncoming = connected.some(r => getChainRouteStepKey(r.toAsset) === ck);
        const hasFundedSeed = seedAssets.some(s => getChainRouteStepKey(s.assetId) === ck);
        const connectedTo = [...new Set(connected.filter(r => getChainRouteStepKey(r.fromAsset) === ck).map(r => getChainRouteStepKey(r.toAsset)))];
        const connectedFrom = [...new Set(connected.filter(r => getChainRouteStepKey(r.toAsset) === ck).map(r => getChainRouteStepKey(r.fromAsset)))];
        const reason = !hasOutgoing && !hasIncoming
          ? 'Layer 1: no swap pairs from Garden API for this chain'
          : !hasFundedSeed && !hasIncoming
            ? 'Layer 2: has outgoing pairs but no funded seed and no incoming pairs from reachable chains'
            : 'Layer 3: has pairs but forms disconnected island — no path from any funded seed reaches it';
        console.log(`[DEBUG]   ${ck}: ${reason} (outgoing→[${connectedTo.join(',')}] incoming←[${connectedFrom.join(',')}] funded=${hasFundedSeed})`);
      }
    } else {
      console.log("[DEBUG] Island recovery successful — all chains now covered");
    }
  }

  const usedEdges = new Set();
  for (const c of chains) {
    for (const r of c.routes) usedEdges.add(`${r.fromAsset}::${r.toAsset}`);
  }

  const standalone = connected.filter((r) =>
    !usedEdges.has(`${r.fromAsset}::${r.toAsset}`) && !usedDestinations.has(r.toAsset)
  );
  const shuffledStandalone = [...standalone];
  shuffleArray(shuffledStandalone);

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
  if (!opts.excludeStandalone) {
    shuffledStandalone.forEach((r) => allRoutes.push(r));
  }

  return { chains, standalone: shuffledStandalone, allRoutes, seedAssets };
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
  _pairStats,
  _pickOpts = {}
) {
  if (!candidates?.length) return null;
  const ok = candidates.filter((r) =>
    isSourceLiquidForRoute(r.fromAsset, balances, gasBalances, connectedRoutes)
  );
  if (!ok.length) return null;
  return ok[Math.floor(Math.random() * ok.length)];
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
function computeChainPairMatrix(connectedRoutes, _pairStats, sufficientByFromAsset) {
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
    if (!byPairBest.has(key) || Math.random() < 0.5) {
      byPairBest.set(key, { route: r });
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
        seedOrderMode: "allAssets",
        singleSeed: opts.mode === "allChains",
        excludeStandalone: opts.mode === "allChains",
      }).chains;

  const chainStartAssets = new Set(chains.map((c) => c.startAsset));
  const chainFundedSourceAssets = new Set();
  for (const chain of chains) {
    for (let i = 1; i < chain.routes.length; i++) {
      chainFundedSourceAssets.add(chain.routes[i].fromAsset);
    }
  }
  // Sequential chain funding profile:
  // For allChains mode each hop is funded by the previous hop's output (in a
  // different denomination), so the seed only needs to cover the FIRST hop.
  // For other modes the cumulative sum approach is still used.
  const isAllChains = opts.mode === "allChains";
  const chainFundingProfile = new Map();
  for (let chainIndex = 0; chainIndex < chains.length; chainIndex++) {
    const chain = chains[chainIndex];
    const routeAmounts = (chain.routes || []).map((r) => toComparableBigInt(r.amount || r.fromMeta?.min_amount || 50000) || 0n);
    const startBalanceRaw = balances.has(chain.startAsset) ? balances.get(chain.startAsset) : null;
    const startBalanceBig = startBalanceRaw === null ? null : (toComparableBigInt(startBalanceRaw) || 0n);

    if (isAllChains) {
      for (let depth = 0; depth < (chain.assets || []).length; depth++) {
        const assetId = chain.assets[depth];
        const remainingRequired = depth === 0 ? (routeAmounts[0] || 0n) : 0n;
        const availableAtDepth = depth === 0 ? startBalanceBig : null;
        const needMore = (availableAtDepth === null && depth === 0)
          ? remainingRequired
          : (depth === 0 && availableAtDepth !== null
            ? (remainingRequired > availableAtDepth ? (remainingRequired - availableAtDepth) : 0n)
            : 0n);
        chainFundingProfile.set(assetId, {
          chainIndex,
          depth,
          remainingRequired,
          availableAtDepth,
          needMore,
          unknown: depth === 0 && availableAtDepth === null,
        });
      }
    } else {
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
    const isChainFundedSource = chainFundedSourceAssets.has(assetId);
    const routeCount = info.isChainStart
      ? (chains[info.chainIndex]?.routes.length || info.routes.length)
      : (opts.mode === "allChains" && !isChainFundedSource ? 1 : info.routes.length);
    totalRoutes += routeCount;
    const balance = balances.has(assetId) ? balances.get(assetId) : null;
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
      seedOrderMode: "allAssets",
      singleSeed: mode === "allChains",
      excludeStandalone: mode === "allChains",
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

    let routesForPlan;
    if (mode === "allChains") {
      // allChains: plan = single-seed beam path only (all routes have _chainStart).
      // Matrix routes are for display stats (chainPairMatrix) only — they don't execute.
      // This ensures the displayed plan matches what runner.js actually fires.
      routesForPlan = flow.allRoutes;
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
      // The raffled seed asset — stored by server so /api/run uses the same seed the display showed.
      chosenSeed: flow.chains[0]?.startAsset || null,
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