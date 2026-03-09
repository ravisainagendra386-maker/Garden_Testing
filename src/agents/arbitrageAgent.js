// src/agents/arbitrageAgent.js
// AI Arbitrage Agent — scans tradeable combinations for round-trip
// opportunities (A→B→A) using Garden quotes, then scores them.
// It uses recent trade history to focus on routes that have
// already proven executable, then verifies profitability with
// fresh quotes before suggesting or executing any trade.
// In addition to Garden quote USD values, it consults CoinGecko
// (via price-feed) to normalise PnL across assets.

const garden       = require("../api/garden");
const tradeHistory = require("./tradeHistory");
const priceFeed    = require("./price-feed");

function tickerFromAssetId(assetId) {
  const parts = String(assetId || "").split(":");
  return (parts[1] || "").toLowerCase();
}

async function getBestQuote(fromAssetId, toAssetId, amountAtomic) {
  try {
    const res = await garden.getQuote(fromAssetId, toAssetId, amountAtomic);
    const list = res.result || res.quotes || [];
    if (!Array.isArray(list) || list.length === 0) return null;
    const best = list[0];
    const outAmount = Number(
      best?.destination?.amount ??
      best?.to_amount ??
      best?.output_amount ??
      0
    );
    const rawSourceUsd = Number(best?.source?.value ?? best?.source?.usd ?? 0);
    const rawDestUsd   = Number(best?.destination?.value ?? best?.destination?.usd ?? 0);

    const fromTicker = tickerFromAssetId(fromAssetId);
    const toTicker   = tickerFromAssetId(toAssetId);

    // Use Garden-provided USD if available, otherwise fall back to CoinGecko.
    const cgSourceUsd = fromTicker ? priceFeed.atomicToUsd(amountAtomic, fromTicker) : 0;
    const cgDestUsd   = toTicker   ? priceFeed.atomicToUsd(outAmount,   toTicker)   : 0;

    const usdIn  = rawSourceUsd || cgSourceUsd;
    const usdOut = rawDestUsd   || cgDestUsd;

    if (!Number.isFinite(outAmount) || outAmount <= 0) return null;
    return { outAmount, usdIn, usdOut };
  } catch (_) {
    return null;
  }
}

/**
 * Scan combinations for round-trip arbitrage opportunities.
 *
 * @param {Array<object>} combinations - /api/combinations payload .combinations
 * @param {object} [opts]
 * @param {number} [opts.minEdgeBps=10] - Minimum edge in basis points (0.10%)
 * @param {number} [opts.maxRoutes=40]  - Max number of tradeable routes to scan
 * @returns {Promise<Array<object>>}
 */
async function scanOpportunities(combinations, opts = {}) {
  const minEdgeBps = Number.isFinite(opts.minEdgeBps) ? opts.minEdgeBps : 10;
  const maxRoutes  = Number.isFinite(opts.maxRoutes)  ? opts.maxRoutes  : 40;

  const tradeable = (combinations || []).filter(c => c.canTrade);
  if (!tradeable.length) return [];

  // Ensure we have fresh-ish CoinGecko prices available for PnL estimation.
  try { await priceFeed.fetchPrices(); } catch (_) {}

  // Use history to prioritise combinations that have executed successfully before.
  const pairStats = tradeHistory.getPairStats();
  const scoredCombos = tradeable.map(c => {
    const key = `${c.from.assetId}::${c.to.assetId}`;
    const stat = pairStats.get(key);
    let score = 0;
    if (stat) {
      // More past successes → scan earlier
      score += Math.min(6, stat.successes * 0.7);
      // Past failures reduce priority
      score -= Math.min(4, stat.failures * 0.5);
    }
    // Prefer BTC-family routes slightly for arbitrage search
    const name = (c.from.name || c.from.assetId || "").toLowerCase();
    if (/btc$|^btc|wbtc|cbtc|cbbtc|sbtc|hbtc|btcn|lbtc|tbtc|pbtc|rbtc/.test(name)) score += 1;
    return { combo: c, score };
  });

  scoredCombos.sort((a, b) => b.score - a.score);

  // Simple cap so we don't hammer the API
  const toScan = scoredCombos.slice(0, maxRoutes).map(x => x.combo);
  const opportunities = [];

  for (const combo of toScan) {
    const fromId = combo.from.assetId;
    const toId   = combo.to.assetId;
    const amount = parseInt(combo.suggestedAmount || combo.minAmount || 50000, 10);
    if (!fromId || !toId || !amount || !Number.isFinite(amount) || amount <= 0) continue;

    // First leg: A → B
    const forward = await getBestQuote(fromId, toId, amount);
    if (!forward) continue;

    // Second leg: B → A, using exact output of first leg
    const back = await getBestQuote(toId, fromId, forward.outAmount);
    if (!back) continue;

    const inAtomic  = amount;
    const outAtomic = back.outAmount;
    if (!inAtomic || !outAtomic) continue;

    const edge     = (outAtomic - inAtomic) / inAtomic;
    const edgeBps  = edge * 10000;
    const usdIn    = forward.usdIn;
    const usdCycle = back.usdOut;
    const usdPnl   = usdCycle - usdIn;

    if (!Number.isFinite(edgeBps) || !Number.isFinite(usdPnl)) continue;
    if (edgeBps < minEdgeBps || usdPnl <= 0) continue;

    opportunities.push({
      id: combo.id,
      from: combo.from,
      to: combo.to,
      amount,
      edge,
      edgeBps,
      usdPnl,
      forward: { usdIn, usdOut: forward.usdOut },
      back:    { usdIn: forward.usdOut, usdOut: usdCycle },
    });
  }

  opportunities.sort((a, b) => b.usdPnl - a.usdPnl);
  return opportunities;
}

/**
 * Re-verify a single opportunity with fresh quotes before executing.
 *
 * @param {{fromAssetId:string,toAssetId:string,amount:number}} opp
 * @param {object} [opts]
 * @param {number} [opts.minEdgeBps=5]
 * @returns {Promise<object>} { profitable, edge, edgeBps, usdPnl, amount, fromAssetId, toAssetId }
 */
async function verifyOpportunity({ fromAssetId, toAssetId, amount }, opts = {}) {
  const minEdgeBps = Number.isFinite(opts.minEdgeBps) ? opts.minEdgeBps : 5;
  const amt = parseInt(amount || 0, 10);
  if (!fromAssetId || !toAssetId || !amt || amt <= 0) {
    return { profitable: false, reason: "Invalid input" };
  }

  try { await priceFeed.fetchPrices(); } catch (_) {}

  const forward = await getBestQuote(fromAssetId, toAssetId, amt);
  if (!forward) return { profitable: false, reason: "No forward quote" };

  const back = await getBestQuote(toAssetId, fromAssetId, forward.outAmount);
  if (!back) return { profitable: false, reason: "No return quote" };

  const inAtomic  = amt;
  const outAtomic = back.outAmount;
  const edge      = (outAtomic - inAtomic) / inAtomic;
  const edgeBps   = edge * 10000;
  const usdIn     = forward.usdIn;
  const usdCycle  = back.usdOut;
  const usdPnl    = usdCycle - usdIn;

  const profitable = Number.isFinite(edgeBps) &&
    Number.isFinite(usdPnl) &&
    edgeBps >= minEdgeBps &&
    usdPnl > 0;

  return {
    profitable,
    edge,
    edgeBps,
    usdPnl,
    amount: inAtomic,
    fromAssetId,
    toAssetId,
  };
}

module.exports = {
  scanOpportunities,
  verifyOpportunity,
};

