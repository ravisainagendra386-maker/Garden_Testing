// src/agents/routeOptimizerAgent.js
// AI Route Optimizer Agent — chain-reaction flow planner
// Chains assets A→B→C→D where each trade's output funds the next.
// Rules:
//   - No duplicate destination assets (each asset received at most once)
//   - Only connected wallet assets participate
//   - 1 funded source asset can cascade through the entire chain
//   - Routes are NEVER cached — always built fresh
//   - Parallel execution: different seed chains run simultaneously

const tradeHistory = require("./tradeHistory");

// ── ASSET FAMILY CLASSIFICATION ──────────────────────────────
function assetFamilyFromIdOrName(assetId, name) {
  const base = String(name || assetId || "").toLowerCase();
  const t = base.split(":").pop();
  if (/btc$|^btc|wbtc|cbtc|cbbtc|sbtc|hbtc|btcn|lbtc|tbtc|pbtc|rbtc/.test(t)) return "btc";
  if (/^eth$|^weth$/.test(t)) return "eth";
  if (/usdc|usdt|dai|busd/.test(t)) return "stable";
  if (/^ltc$|^wltc$|^cbltc$/.test(t)) return "ltc";
  return "other_" + t;
}

function getChainKey(assetId) {
  return (assetId || "").split(":")[0]
    .replace(/_sepolia|_testnet\d*|_mainnet|_signet|_devnet/g, "");
}

function getWalletTypeFromChain(chainKey) {
  if (/^bitcoin/.test(chainKey)) return "bitcoin";
  if (/^solana/.test(chainKey))  return "solana";
  if (/^starknet/.test(chainKey)) return "starknet";
  if (/^tron/.test(chainKey))    return "tron";
  if (/^sui/.test(chainKey))     return "sui";
  return "evm";
}

// ── SCORING ──────────────────────────────────────────────────
function scoreRoute(route, pairStats) {
  const fromId   = route.fromAsset || route.from?.assetId || "";
  const toId     = route.toAsset   || route.to?.assetId   || "";
  const fromName = route.fromMeta?.name || fromId;
  const toName   = route.toMeta?.name   || toId;

  const ff = assetFamilyFromIdOrName(fromId, fromName);
  const tf = assetFamilyFromIdOrName(toId,   toName);

  let score = 0;
  if (ff === "btc" && tf === "btc") score += 8;
  else if (ff === "btc" || tf === "btc") score += 4;
  if (ff === "eth" || tf === "eth")       score += 2;
  if (ff === "stable" || tf === "stable") score += 2;

  const amt = Number(route.amount || 0);
  if (amt > 0) {
    const log = Math.log10(amt);
    if (isFinite(log)) score += Math.max(0, 6 - log);
  }

  if (ff.startsWith("other_") && tf.startsWith("other_")) score -= 1;

  const key = `${fromId}::${toId}`;
  const stat = pairStats && pairStats.get(key);
  if (stat) {
    score += Math.min(5, stat.successes * 0.5);
    score -= Math.min(4, stat.failures * 0.5);
  }

  return score;
}

// ── ASSET GRAPH BUILDER ──────────────────────────────────────
function buildAssetGraph(routes) {
  const graph = new Map();
  const assets = new Set();
  for (const r of routes) {
    const from = r.fromAsset;
    const to   = r.toAsset;
    assets.add(from);
    assets.add(to);
    if (!graph.has(from)) graph.set(from, []);
    graph.get(from).push({ toAssetId: to, route: r });
  }
  return { graph, assets: [...assets] };
}

// ── GAS COST ESTIMATOR ───────────────────────────────────────
function estimateFlowGas(chain, gasBalances) {
  const MIN_GAS_WEI = 10n ** 15n;
  const chainGasNeeded = new Map();

  for (const route of chain.routes) {
    const fromChain = getChainKey(route.fromAsset);
    const walletType = getWalletTypeFromChain(fromChain);
    if (walletType === "evm") {
      const count = chainGasNeeded.get(fromChain) || 0;
      chainGasNeeded.set(fromChain, count + 2);
    }
  }

  const gasIssues = [];
  for (const [chainKey, txCount] of chainGasNeeded) {
    const gasBalance = gasBalances?.get(chainKey);
    if (gasBalance !== undefined) {
      const needed = MIN_GAS_WEI * BigInt(txCount);
      if (gasBalance < needed) {
        gasIssues.push({
          chain: chainKey,
          have: gasBalance.toString(),
          need: needed.toString(),
          txCount,
          shortfall: (needed - gasBalance).toString(),
        });
      }
    }
  }

  return {
    chainsUsed: [...chainGasNeeded.keys()],
    totalTxEstimate: [...chainGasNeeded.values()].reduce((s, v) => s + v, 0),
    gasIssues,
    feasible: gasIssues.length === 0,
  };
}

// ── WALLET COVERAGE ANALYZER ─────────────────────────────────
function analyzeWalletCoverage(routes, connectedWalletTypes) {
  const needed = new Set();
  const missing = new Set();

  for (const r of routes) {
    const fromChain = getChainKey(r.fromAsset);
    const toChain   = getChainKey(r.toAsset);
    const fromWallet = getWalletTypeFromChain(fromChain);
    const toWallet   = getWalletTypeFromChain(toChain);

    needed.add(fromWallet);
    needed.add(toWallet);

    if (!connectedWalletTypes.has(fromWallet)) missing.add(fromWallet);
    if (!connectedWalletTypes.has(toWallet))   missing.add(toWallet);
  }

  return {
    needed: [...needed],
    missing: [...missing],
    allConnected: missing.size === 0,
    coveragePct: needed.size > 0
      ? Math.round((needed.size - missing.size) / needed.size * 100) : 100,
  };
}

// ══════════════════════════════════════════════════════════════
// ── CHAIN-REACTION FLOW BUILDER (core new logic) ─────────────
// ══════════════════════════════════════════════════════════════
//
// Builds optimal chains: A→B→C→D where each trade's destination
// output funds the next trade's source.
//
// Key rules:
//   1. No duplicate destination assets across ALL chains
//   2. Only connected-wallet assets participate
//   3. Seed assets (with balance) start each chain
//   4. Subsequent hops need zero balance (funded by previous output)
//   5. Cross-chain and cross-family hops are preferred for coverage
//   6. Each chain runs sequentially; different chains run in parallel

function buildChainReactionFlow(routes, opts = {}) {
  const connectedTypes = opts.connectedWalletTypes || new Set();
  const balances       = opts.balances || new Map();
  const gasBalances    = opts.gasBalances || new Map();
  const MIN_GAS_WEI   = 10n ** 15n;

  // ── Phase 1: Filter to only connected-wallet routes ────────
  const connected = routes.filter(r => {
    const fromWallet = r.fromChain || getWalletTypeFromChain(getChainKey(r.fromAsset));
    const toWallet   = r.toChain   || getWalletTypeFromChain(getChainKey(r.toAsset));
    return connectedTypes.has(fromWallet) && connectedTypes.has(toWallet);
  });

  if (!connected.length) {
    return { chains: [], standalone: [], allRoutes: [] };
  }

  // ── Phase 2: Build adjacency list ─────────────────────────
  const adj = new Map(); // assetId → [{ toAssetId, route }]
  for (const r of connected) {
    if (!adj.has(r.fromAsset)) adj.set(r.fromAsset, []);
    adj.get(r.fromAsset).push({ toAssetId: r.toAsset, route: r });
  }

  // ── Phase 3: Find seed assets (have actual balance + gas) ──
  const seedAssets = [];
  const seenSeeds = new Set();

  for (const r of connected) {
    const assetId = r.fromAsset;
    if (seenSeeds.has(assetId)) continue;
    seenSeeds.add(assetId);

    const bal = balances.get(assetId);
    const minAmt = Number(r.amount || r.fromMeta?.min_amount || 50000);

    if (bal === null || bal === undefined || bal < minAmt) continue;

    // Check gas for EVM chains
    const chainKey = getChainKey(assetId);
    const walletType = getWalletTypeFromChain(chainKey);
    if (walletType === "evm") {
      const gas = gasBalances.get(chainKey);
      if (gas !== undefined && gas < MIN_GAS_WEI) continue;
    }

    seedAssets.push({ assetId, balance: bal, minAmt });
  }

  // Sort seeds: BTC family first, then by balance (descending)
  seedAssets.sort((a, b) => {
    const famA = assetFamilyFromIdOrName(a.assetId, "");
    const famB = assetFamilyFromIdOrName(b.assetId, "");
    const famOrder = { btc: 0, eth: 1, stable: 2, ltc: 3 };
    const orderA = famOrder[famA] ?? 99;
    const orderB = famOrder[famB] ?? 99;
    if (orderA !== orderB) return orderA - orderB;
    // More outgoing edges = more potential chain length
    const edgesA = adj.get(a.assetId)?.length || 0;
    const edgesB = adj.get(b.assetId)?.length || 0;
    if (edgesB !== edgesA) return edgesB - edgesA;
    return b.balance - a.balance;
  });

  // ── Phase 4: Build chain-reaction chains via greedy DFS ────
  // Global constraint: no asset appears as destination more than once
  const usedDestinations = new Set();
  const usedEdges = new Set();
  const chains = [];

  for (const seed of seedAssets) {
    const chainRoutes = [];
    const chainAssets = [seed.assetId];
    let current = seed.assetId;
    const maxDepth = 15;

    for (let depth = 0; depth < maxDepth; depth++) {
      const neighbors = adj.get(current) || [];

      // Score each candidate next hop
      let bestNext = null;
      let bestScore = -Infinity;

      for (const { toAssetId, route } of neighbors) {
        const edgeKey = `${current}::${toAssetId}`;

        // Hard constraints
        if (usedDestinations.has(toAssetId)) continue; // no duplicate destinations
        if (usedEdges.has(edgeKey)) continue;           // no duplicate edges
        if (chainAssets.includes(toAssetId)) continue;  // no cycles within chain

        // Scoring
        let score = 0;
        const fromChain = getChainKey(current);
        const toChain   = getChainKey(toAssetId);
        if (fromChain !== toChain) score += 5;          // cross-chain bonus

        const fromFam = assetFamilyFromIdOrName(current, "");
        const toFam   = assetFamilyFromIdOrName(toAssetId, "");
        if (fromFam !== toFam) score += 2;              // family diversity

        // Prefer assets with more outgoing edges (longer chains possible)
        const outEdges = adj.get(toAssetId)?.length || 0;
        score += Math.min(3, outEdges * 0.5);

        // BTC↔BTC core use-case bonus
        if (fromFam === "btc" && toFam === "btc") score += 4;

        if (score > bestScore) {
          bestScore = score;
          bestNext = { toAssetId, route };
        }
      }

      if (!bestNext) break; // dead end — no valid next hop

      // Commit this hop
      const edgeKey = `${current}::${bestNext.toAssetId}`;
      usedEdges.add(edgeKey);
      usedDestinations.add(bestNext.toAssetId);
      chainRoutes.push(bestNext.route);
      chainAssets.push(bestNext.toAssetId);
      current = bestNext.toAssetId;
    }

    if (chainRoutes.length > 0) {
      chains.push({
        startAsset: seed.assetId,
        seedBalance: seed.balance,
        assets: chainAssets,
        routes: chainRoutes,
        length: chainRoutes.length,
      });
    }
  }

  // ── Phase 5: Collect standalone routes ─────────────────────
  // Routes not in any chain, whose destination hasn't been used
  const chainRouteKeys = new Set();
  for (const c of chains) {
    for (const r of c.routes) {
      chainRouteKeys.add(`${r.fromAsset}::${r.toAsset}`);
    }
  }

  const standalone = connected.filter(r =>
    !chainRouteKeys.has(`${r.fromAsset}::${r.toAsset}`) &&
    !usedDestinations.has(r.toAsset)
  );

  // ── Phase 6: Merge into ordered plan ───────────────────────
  // Chain routes first (in chain order), then standalone by score
  const allRoutes = [];

  for (const c of chains) {
    for (let i = 0; i < c.routes.length; i++) {
      allRoutes.push({
        ...c.routes[i],
        _chainReaction: i > 0,  // first hop uses seed balance; rest are chain-funded
        _chainStart: c.startAsset,
        _depth: i,
        _chainIndex: chains.indexOf(c),
      });
    }
  }

  // Score and sort standalone routes
  let pairStats = null;
  try { pairStats = tradeHistory.getPairStats(); } catch (_) {}

  const scoredStandalone = standalone
    .map(r => ({ route: r, score: scoreRoute(r, pairStats) }))
    .sort((a, b) => b.score - a.score);

  for (const { route } of scoredStandalone) {
    allRoutes.push(route);
  }

  console.log(
    `[chainReaction] ${seedAssets.length} seeds → ${chains.length} chains ` +
    `(${chains.reduce((s, c) => s + c.routes.length, 0)} chain routes) + ` +
    `${scoredStandalone.length} standalone = ${allRoutes.length} total`
  );

  return {
    chains,
    standalone: scoredStandalone.map(s => s.route),
    allRoutes,
    seedAssets,
  };
}

// ══════════════════════════════════════════════════════════════
// ── MAIN: OPTIMIZE ROUTES ────────────────────────────────────
// ══════════════════════════════════════════════════════════════

function optimizeRoutes(routes, opts = {}) {
  if (!Array.isArray(routes) || routes.length === 0) return [];

  const maxTotal     = Number.isFinite(opts.maxTotal) ? opts.maxTotal : 120;
  const perPairLimit = Number.isFinite(opts.perPairLimit) ? opts.perPairLimit : 3;

  // Determine connected wallet types from routes
  const connectedTypes = opts.connectedWalletTypes || new Set();
  if (!connectedTypes.size) {
    for (const r of routes) {
      if (r.fromChain) connectedTypes.add(r.fromChain);
      if (r.toChain)   connectedTypes.add(r.toChain);
    }
  }

  const { allRoutes } = buildChainReactionFlow(routes, {
    connectedWalletTypes: connectedTypes,
    balances:    opts.balances    || new Map(),
    gasBalances: opts.gasBalances || new Map(),
  });

  // Apply per-pair limit and max total
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

  console.log(`[routeOptimizer] Final plan: ${plan.length} routes`);
  return plan;
}

// ══════════════════════════════════════════════════════════════
// ── MAIN: GET ROUTE READINESS ────────────────────────────────
// ══════════════════════════════════════════════════════════════
//
// "Required" = balance needed to START the chain (only seed assets)
// Chain-funded assets show required=0 and reason='chain_funded'
// Readiness % = balance coverage for all routes (chain + standalone)

function getRouteReadiness(routes, opts = {}) {
  if (!Array.isArray(routes) || routes.length === 0) {
    return {
      assets: [], totalRoutes: 0, runnableRoutes: 0, readinessPct: 100,
      flowChains: [], clusters: [], walletCoverage: null,
    };
  }

  const balances    = opts.balances    || new Map();
  const gasBalances = opts.gasBalances || new Map();
  const MIN_GAS_WEI = 10n ** 15n;

  // Determine connected wallet types
  const connectedTypes = opts.connectedWalletTypes || new Set();
  if (!connectedTypes.size) {
    for (const r of routes) {
      if (r.fromChain) connectedTypes.add(r.fromChain);
      if (r.toChain)   connectedTypes.add(r.toChain);
    }
  }

  // Filter out disconnected assets entirely
  const connectedRoutes = routes.filter(r => {
    const fw = r.fromChain || getWalletTypeFromChain(getChainKey(r.fromAsset));
    const tw = r.toChain   || getWalletTypeFromChain(getChainKey(r.toAsset));
    return connectedTypes.has(fw) && connectedTypes.has(tw);
  });

  // Build chain-reaction flow
  const { chains, allRoutes } = buildChainReactionFlow(connectedRoutes, {
    connectedWalletTypes: connectedTypes,
    balances,
    gasBalances,
  });

  const walletCoverage = analyzeWalletCoverage(connectedRoutes, connectedTypes);

  // Identify which assets are chain starts
  const chainStartAssets = new Set(chains.map(c => c.startAsset));

  // Build per-source-asset info
  const bySourceAsset = new Map();
  for (const r of connectedRoutes) {
    const key = r.fromAsset;
    if (!bySourceAsset.has(key)) {
      const ticker   = (r.fromMeta?.asset || r.fromMeta?.ticker || key.split(':')[1] || '').toUpperCase();
      const chain    = getChainKey(key);
      const chainRaw = key.split(':')[0];
      const walletType = r.fromChain || getWalletTypeFromChain(chain);

      bySourceAsset.set(key, {
        id: key, ticker, chain, chainRaw, walletType,
        icon: r.fromMeta?.icon || null,
        name: r.fromMeta?.name || ticker,
        minAmount: Number(r.fromMeta?.min_amount || r.amount || 50000),
        routes: [],
        isChainStart: chainStartAssets.has(key),
        chainIndex: chains.findIndex(c => c.startAsset === key),
        chainLength: 0,
      });
    }
    bySourceAsset.get(key).routes.push(r);
  }

  // Set chain lengths
  for (const [, info] of bySourceAsset) {
    if (info.chainIndex >= 0) {
      info.chainLength = chains[info.chainIndex].routes.length;
    }
  }

  // Calculate readiness per asset
  const assets = [];
  let totalRoutes   = 0;
  let runnableRoutes = 0;

  for (const [assetId, info] of bySourceAsset) {
    // For chain-start assets: route count = entire chain length
    // For non-chain-start: just their own routes
    const routeCount = info.isChainStart
      ? (chains[info.chainIndex]?.routes.length || info.routes.length)
      : info.routes.length;
    totalRoutes += routeCount;

    const balance = balances.has(assetId) ? balances.get(assetId) : null;

    // Required: only chain-start assets need balance
    // Chain-funded assets need 0 (funded by previous trade output)
    const required = info.isChainStart ? info.minAmount : 0;

    // Gas check for EVM chain-start assets
    let hasGas = true;
    let gasBalance = null;
    if (info.walletType === 'evm' && info.isChainStart) {
      const gas = gasBalances.get(info.chain);
      if (gas !== undefined) {
        gasBalance = gas;
        hasGas = gas >= MIN_GAS_WEI;
      }
    }

    // Determine sufficiency
    let sufficient = false;
    let reason = null;

    if (!info.isChainStart) {
      sufficient = true;
      reason = 'chain_funded';
    } else if (balance === null) {
      reason = 'balance_unknown';
      sufficient = false;
    } else if (balance < required) {
      reason = 'insufficient_balance';
      sufficient = false;
    } else if (info.walletType === 'evm' && !hasGas) {
      reason = 'insufficient_gas';
      sufficient = false;
    } else {
      sufficient = true;
    }

    if (sufficient) runnableRoutes += routeCount;

    assets.push({
      id: assetId,
      ticker: info.ticker,
      chain: info.chain,
      chainRaw: info.chainRaw,
      walletType: info.walletType,
      icon: info.icon,
      name: info.name,
      balance,
      gasBalance: gasBalance !== null ? gasBalance.toString() : null,
      required,
      sufficient,
      reason,
      routeCount,
      isChainStart: info.isChainStart,
      chainLength: info.chainLength,
      inFlowChain: info.chainIndex >= 0,
      flowChainIndex: info.chainIndex,
    });
  }

  // Sort: chain-start first, then sufficient, then by route count
  assets.sort((a, b) => {
    if (a.isChainStart && !b.isChainStart) return -1;
    if (!a.isChainStart && b.isChainStart) return 1;
    if (a.sufficient && !b.sufficient) return -1;
    if (!a.sufficient && b.sufficient) return 1;
    return b.routeCount - a.routeCount;
  });

  const readinessPct = totalRoutes > 0
    ? Math.round(runnableRoutes / totalRoutes * 100)
    : 100;

  // Gas analysis per chain
  const flowChainAnalysis = chains.map((chain, idx) => {
    const gasEst = estimateFlowGas(chain, gasBalances);
    return {
      index: idx,
      startAsset: chain.startAsset,
      seedBalance: chain.seedBalance,
      assets: chain.assets,
      length: chain.length,
      ...gasEst,
    };
  });

  return {
    assets,
    totalRoutes,
    runnableRoutes,
    readinessPct,
    flowChains: flowChainAnalysis,
    clusters: [],
    walletCoverage,
    totalAssets: bySourceAsset.size,
    totalFlowChainRoutes: chains.reduce((s, c) => s + c.routes.length, 0),
  };
}

module.exports = { optimizeRoutes, getRouteReadiness, buildChainReactionFlow };