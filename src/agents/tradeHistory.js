// src/agents/tradeHistory.js
// Lightweight in-memory store for executed route results.
// Used by the Route Optimizer and Arbitrage Agent to learn from
// past runs (ordering, failures, effective rates).

const MAX_ENTRIES = 5000; // raised from 1000 — covers ~10 days at medium scale (100–1000/day)
const _entries = [];

function record(entry) {
  if (!entry) return;
  const safe = {
    testId:       entry.testId || null,
    status:       entry.status || "unknown",
    fromAssetId:  entry.fromAssetId || null,
    toAssetId:    entry.toAssetId || null,
    fromChain:    entry.fromChain || null,
    toChain:      entry.toChain || null,
    amount:       Number(entry.amount || 0),
    outputAmount: Number(entry.outputAmount || 0),
    usdIn:        Number(entry.usdIn || 0),
    usdOut:       Number(entry.usdOut || 0),
    slippagePct:  Number(entry.slippagePct || 0),
    durationSec:  Number(entry.durationSec || 0),
    ts:           entry.ts || new Date().toISOString(),
    agent:        entry.agent || null,
    error:        entry.error || null,
    steps:        Array.isArray(entry.steps) ? entry.steps : null,
  };
  _entries.push(safe);
  if (_entries.length > MAX_ENTRIES) _entries.shift();
}

function getAll() {
  // Newest first
  return _entries.slice().reverse();
}

function getSuccessful() {
  return getAll().filter(e => e.status === "pass");
}

function getById(testId) {
  if (!testId) return null;
  for (let i = _entries.length - 1; i >= 0; i--) {
    if (_entries[i].testId === testId) return _entries[i];
  }
  return null;
}

// Aggregate basic stats per from→to asset pair
function getPairStats() {
  const map = new Map();
  for (const e of _entries) {
    if (!e.fromAssetId || !e.toAssetId) continue;
    const key = `${e.fromAssetId}::${e.toAssetId}`;
    let s = map.get(key);
    if (!s) {
      s = {
        fromAssetId: e.fromAssetId,
        toAssetId:   e.toAssetId,
        successes:   0,
        failures:    0,
        lastStatus:  null,
        lastEntry:   null,
      };
      map.set(key, s);
    }
    if (e.status === "pass") s.successes += 1;
    else if (e.status && e.status !== "aborted" && e.status !== "skipped") s.failures += 1;
    s.lastStatus = e.status;
    s.lastEntry  = e;
  }
  return map;
}

module.exports = {
  record,
  getAll,
  getSuccessful,
  getPairStats,
  getById,
};

