// src/agents/price-feed.js
// Centralized price feed for all agents.
// Fetches from CoinGecko, caches for TTL, falls back to hardcoded estimates.
const axios = require('axios');

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
  btc: 95000, wbtc: 95000, cbtc: 95000, cbbtc: 95000,
  sbtc: 95000, lbtc: 95000, hbtc: 95000, tbtc: 95000,
  xbtc: 95000, rbtc: 95000,
  eth: 3200, weth: 3200,
  usdc: 1, usdt: 1, dai: 1,
  bnb: 600, sol: 140, sui: 2,
  trx: 0.12, ltc: 80, strk: 0.5,
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
const CACHE_TTL = 60000; // 1 min

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

function getPrice(ticker) {
  return _cache[ticker?.toLowerCase()] || FALLBACK_PRICES[ticker?.toLowerCase()] || 0;
}

// Convert atomic units → USD value
function atomicToUsd(atomicAmount, ticker) {
  const t = (ticker || '').toLowerCase();
  const decimals = TOKEN_DECIMALS[t] ?? 8;
  const price    = getPrice(t);
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
  return TOKEN_DECIMALS[(ticker || '').toLowerCase()] ?? 8;
}

// Invalidate cache (force fresh fetch)
function invalidate() { _cacheTs = 0; }

module.exports = { fetchPrices, getPrice, atomicToUsd, usdToAtomic, getDecimals, invalidate };

