// src/agents/price-feed.js
// Centralized price feed for all agents.
// Fetches from CoinGecko, caches for TTL, falls back to hardcoded estimates.
const axios = require('axios');

/** Map Garden asset suffixes not in CoinGecko list to a priced ticker (e.g. ibtc → btc). */
const TICKER_ALIASES = {
  ibtc: 'btc',
  wcbtc: 'wbtc',
  pbtc: 'btc',
  bbtc: 'btc',
  dbtc: 'btc',
  btcn: 'btc',
};

const COINGECKO_IDS = {
  btc:   'bitcoin',
  wbtc:  'wrapped-bitcoin',
  cbtc:  'bitcoin',
  cbbtc: 'coinbase-wrapped-btc',
  sbtc:  'bitcoin',
  lbtc:  'bitcoin',
  hbtc:  'bitcoin',
  tbtc:  'tbtc',
  xbtc:  'bitcoin',
  rbtc:  'rootstock',
  eth:   'ethereum',
  weth:  'ethereum',
  usdc:  'usd-coin',
  usdt:  'tether',
  dai:   'dai',
  bnb:   'binancecoin',
  sol:   'solana',
  sui:   'sui',
  trx:   'tron',
  ltc:   'litecoin',
  strk:  'starknet',
};

const FALLBACK_PRICES = {
  btc: 67000, wbtc: 67000, cbtc: 67000, cbbtc: 67000,
  sbtc: 67000, lbtc: 67000, hbtc: 67000, tbtc: 67000,
  xbtc: 67000, rbtc: 67000,
  ibtc: 67000, wcbtc: 67000, pbtc: 67000, bbtc: 67000, dbtc: 67000,
  btcn: 67000,
  eth: 2060, weth: 2060,
  usdc: 1, usdt: 1, dai: 1,
  bnb: 600, sol: 140, sui: 2,
  trx: 0.12, ltc: 80, strk: 0.5,
  mon: 0.5, seed: 0.01,
};

// Decimals per ticker (for atomic → human conversion)
const TOKEN_DECIMALS = {
  btc: 8, wbtc: 8, cbtc: 8, cbbtc: 8, sbtc: 8, lbtc: 8, hbtc: 8, tbtc: 8, xbtc: 8, rbtc: 8,
  eth: 18, weth: 18,
  usdc: 6, usdt: 6, dai: 18,
  bnb: 18, sol: 9, sui: 9, trx: 6, ltc: 8, strk: 18,
};

let _cache = {};         // ticker → usd
let _cacheTs = 0;
const CACHE_TTL = 86_400_000; // 24 hours

async function fetchPrices() {
  const now = Date.now();
  if (now - _cacheTs < CACHE_TTL && Object.keys(_cache).length > 0) return _cache;

  try {
    const ids = [...new Set(Object.values(COINGECKO_IDS))].join(',');
    const r = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
      { timeout: 8000 }
    );
    const data = r.data;
    const fresh = { ...FALLBACK_PRICES };
    for (const [ticker, cgId] of Object.entries(COINGECKO_IDS)) {
      if (data[cgId]?.usd) fresh[ticker] = data[cgId].usd;
    }
    _cache = fresh;
    _cacheTs = now;
    console.log(`[price-feed] refreshed — BTC=$${fresh.btc} ETH=$${fresh.eth}`);
    return _cache;
  } catch (e) {
    console.warn(`[price-feed] CoinGecko failed (${e.message}) — using fallback prices`);
    _cache = { ..._cache, ...FALLBACK_PRICES };
    _cacheTs = now;
    return _cache;
  }
}

function normalizeTicker(ticker) {
  const t = (ticker || '').toLowerCase();
  return TICKER_ALIASES[t] || t;
}

function getPrice(ticker) {
  const key = normalizeTicker(ticker);
  return _cache[key] || FALLBACK_PRICES[key] || 0;
}

// Convert atomic units → USD value
function atomicToUsd(atomicAmount, ticker) {
  const t = (ticker || '').toLowerCase();
  const key = normalizeTicker(ticker);
  const decimals = TOKEN_DECIMALS[t] ?? TOKEN_DECIMALS[key] ?? 8;
  const price = getPrice(ticker);
  if (!price) return 0;
  return (Number(atomicAmount) / Math.pow(10, decimals)) * price;
}

// Convert USD → atomic units
function usdToAtomic(usd, ticker) {
  const t = (ticker || '').toLowerCase();
  const decimals = TOKEN_DECIMALS[t] ?? 8;
  const price    = getPrice(t);
  if (!price) return 0;
  return Math.round((usd / price) * Math.pow(10, decimals));
}

// Get decimals for a ticker
function getDecimals(ticker) {
  const t = (ticker || '').toLowerCase();
  const key = normalizeTicker(ticker);
  return TOKEN_DECIMALS[t] ?? TOKEN_DECIMALS[key] ?? 8;
}

// Invalidate cache (force fresh fetch)
function invalidate() { _cacheTs = 0; }

// Convert atomic → USD using explicit decimals (from Garden metadata) instead of hardcoded map
function atomicToUsdExplicit(atomicAmount, ticker, decimals) {
  const price = getPrice(ticker);
  if (!price || decimals === undefined || decimals === null) return 0;
  return (Number(atomicAmount) / Math.pow(10, Number(decimals))) * price;
}

// Convert USD → atomic using explicit decimals
function usdToAtomicExplicit(usd, ticker, decimals) {
  const price = getPrice(ticker);
  if (!price || decimals === undefined || decimals === null) return 0;
  return Math.ceil((usd / price) * Math.pow(10, Number(decimals)));
}

/**
 * Compute the required seed amount (atomic) for an allChains cycle.
 * Uses Garden metadata decimals (fromMeta.decimals, toMeta.decimals) directly
 * instead of hardcoded TOKEN_DECIMALS.
 *
 * @param {Array} chainRoutes - Planned route objects with fromAsset, toAsset, fromMeta, toMeta
 * @param {Object} [opts]
 * @param {number} [opts.buffer=0.05]  - Price buffer (5% default) above market
 * @param {number} [opts.feePerHop=0.0035] - Garden fee per hop (0.35%)
 */
function computePriceBasedSeedRequirement(chainRoutes, opts = {}) {
  const buffer = opts.buffer ?? 0.05;
  const feePerHop = opts.feePerHop ?? 0.0035;
  const N = chainRoutes.length;
  if (!N) return null;

  // For each hop i, the seed value shrinks by (1-fee)^i before reaching that hop.
  // So the seed must satisfy: seed_usd × (1-fee)^i >= hop_i_min_usd
  // → seed_usd >= hop_i_min_usd / (1-fee)^i
  // Required seed = max across all hops of (hop_min_usd / (1-fee)^i) × (1+buffer).
  const hopBreakdown = [];
  let maxRequiredUsd = 0;
  let bottleneckHop = 0;

  for (let i = 0; i < N; i++) {
    const route = chainRoutes[i];
    const fromTicker = extractTicker(route.fromAsset || '');
    const toTicker = extractTicker(route.toAsset || '');
    const fromDec = Number(route.fromMeta?.decimals ?? getDecimals(fromTicker));
    const toDec = Number(route.toMeta?.decimals ?? getDecimals(toTicker));
    const fromMin = Math.max(1, parseInt(String(route.fromMeta?.min_amount ?? 50000), 10) || 50000);
    const toMin = Math.max(1, parseInt(String(route.toMeta?.min_amount ?? 50000), 10) || 50000);
    const fromMinUsd = atomicToUsdExplicit(fromMin, fromTicker, fromDec);
    const toMinUsd = atomicToUsdExplicit(toMin, toTicker, toDec);
    const hopMinUsd = Math.max(fromMinUsd, toMinUsd);

    // How much seed USD is needed so that after i hops of fees, this hop is still funded
    const feeDecay = Math.pow(1 - feePerHop, i);
    const seedNeededForHop = hopMinUsd / feeDecay;

    if (seedNeededForHop > maxRequiredUsd) {
      maxRequiredUsd = seedNeededForHop;
      bottleneckHop = i;
    }

    hopBreakdown.push({
      hop: i + 1,
      fromAsset: route.fromAsset,
      toAsset: route.toAsset,
      fromTicker, toTicker,
      fromDec, toDec,
      fromMinAtomic: fromMin, toMinAtomic: toMin,
      fromMinUsd: +fromMinUsd.toFixed(4),
      toMinUsd: +toMinUsd.toFixed(4),
      hopMinUsd: +hopMinUsd.toFixed(4),
      feeDecay: +feeDecay.toFixed(6),
      seedNeededUsd: +seedNeededForHop.toFixed(4),
    });
  }

  const requiredUsd = maxRequiredUsd * (1 + buffer);

  const seedTicker = extractTicker(chainRoutes[0].fromAsset || '');
  const seedDec = Number(chainRoutes[0].fromMeta?.decimals ?? getDecimals(seedTicker));
  const seedPrice = getPrice(seedTicker);
  const requiredSeedAtomic = seedPrice > 0
    ? usdToAtomicExplicit(requiredUsd, seedTicker, seedDec)
    : 0;

  return {
    requiredSeedAtomic,
    requiredSeedUsd: +requiredUsd.toFixed(4),
    maxHopMinUsd: +(hopBreakdown[bottleneckHop]?.hopMinUsd ?? 0),
    bottleneckFeeDecay: +(hopBreakdown[bottleneckHop]?.feeDecay ?? 1),
    hops: N,
    bottleneckHop,
    seedTicker,
    seedDec,
    seedPriceUsd: seedPrice,
    hopBreakdown,
  };
}

function extractTicker(assetId) {
  return (assetId || '').split(':').pop()?.toLowerCase() || '';
}

module.exports = {
  fetchPrices, getPrice, atomicToUsd, usdToAtomic, getDecimals, invalidate,
  atomicToUsdExplicit, usdToAtomicExplicit,
  computePriceBasedSeedRequirement, extractTicker,
  FALLBACK_PRICES, TOKEN_DECIMALS, TICKER_ALIASES, COINGECKO_IDS,
};

