// src/agents/routeOptimizerAgent.js
// Heuristic "AI" agent that reorders and trims route lists
// to prioritize high-signal combinations (esp. BTC<>BTC) and
// keep test suites efficient. It also uses recent trade history
// so routes that passed previously are tried earlier.

const tradeHistory = require("./tradeHistory");

function assetFamilyFromIdOrName(assetId, name) {
  const base = String(name || assetId || "").toLowerCase();
  const t = base.split(":").pop();
  if (/btc$|^btc|wbtc|cbtc|cbbtc|sbtc|hbtc|btcn|lbtc|tbtc|pbtc|rbtc/.test(t)) return "btc";
  if (/^eth$|^weth$/.test(t)) return "eth";
  if (/usdc|usdt|dai|busd/.test(t)) return "stable";
  return "other_" + t;
}

function scoreRoute(route, pairStats) {
  const fromId   = route.fromAsset || route.from?.assetId || "";
  const toId     = route.toAsset   || route.to?.assetId   || "";
  const fromName = route.fromMeta?.name || fromId;
  const toName   = route.toMeta?.name   || toId;

  const ff = assetFamilyFromIdOrName(fromId, fromName);
  const tf = assetFamilyFromIdOrName(toId,   toName);

  let score = 0;

  // Strongly prioritize BTC↔BTC routes (core Garden use-case)
  if (ff === "btc" && tf === "btc") score += 8;
  else if (ff === "btc" || tf === "btc") score += 4;

  // Stablecoin and ETH routes are also useful for coverage
  if (ff === "eth" || tf === "eth")       score += 2;
  if (ff === "stable" || tf === "stable") score += 2;

  // Prefer smaller trade sizes first (safer for exploratory runs)
  const amt = Number(route.amount || 0);
  if (amt > 0) {
    // Invert logarithm so smaller amounts get slightly higher score
    const log = Math.log10(amt);
    if (isFinite(log)) score += Math.max(0, 6 - log);
  }

  // Light penalty for pure "other" pairs so they don't dominate
  if (ff.startsWith("other_") && tf.startsWith("other_")) score -= 1;

  // History-aware bonuses / penalties
  const key = `${fromId}::${toId}`;
  const stat = pairStats && pairStats.get(key);
  if (stat) {
    // Successful routes bubble up; each past success adds a bit.
    score += Math.min(5, stat.successes * 0.5);
    // Frequent failures push the route later, but don't fully exclude it.
    score -= Math.min(4, stat.failures * 0.5);
  }

  return score;
}

/**
 * Optimize a flat list of routes built from Garden assets.
 *
 * @param {Array<object>} routes - Output from runner.buildRoutes()
 * @param {object} [opts]
 * @param {number} [opts.maxTotal=120]      - Hard cap on total routes to run
 * @param {number} [opts.perPairLimit=3]    - Max occurrences per from→to asset pair
 * @returns {Array<object>} optimized list of routes
 */
function optimizeRoutes(routes, opts = {}) {
  if (!Array.isArray(routes) || routes.length === 0) return [];

  const maxTotal    = Number.isFinite(opts.maxTotal) ? opts.maxTotal : 120;
  const perPairLimit = Number.isFinite(opts.perPairLimit) ? opts.perPairLimit : 3;

  // Snapshot of recent history so scoring can prefer stable pairs.
  let pairStats = null;
  try {
    pairStats = tradeHistory.getPairStats();
  } catch (_) {
    pairStats = null;
  }

  const scored = routes.map((r) => {
    const key = `${r.fromAsset}::${r.toAsset}`;
    return { route: r, key, score: scoreRoute(r, pairStats) };
  });

  // Highest score first
  scored.sort((a, b) => b.score - a.score);

  const usedPerPair = new Map();
  const plan = [];

  for (const item of scored) {
    const count = usedPerPair.get(item.key) || 0;
    if (count >= perPairLimit) continue;
    usedPerPair.set(item.key, count + 1);
    plan.push(item.route);
    if (plan.length >= maxTotal) break;
  }

  return plan;
}

module.exports = { optimizeRoutes };

