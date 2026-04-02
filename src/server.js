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
const crypto         = require("crypto");
const arbitrageAgent = require("./agents/arbitrageAgent");

// ── AUTH ──────────────────────────────────────────────────────
const _sessions = new Set();

function authMiddleware(req, res, next) {
  const auth  = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !_sessions.has(token)) return res.status(401).json({ error: "Unauthorized" });
  next();
}

const app = express();
app.use(cors({ origin: ["http://localhost:3000", "http://127.0.0.1:3000"] }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "../dashboard")));

app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!process.env.DASHBOARD_EMAIL || !process.env.DASHBOARD_PASSWORD)
    return res.status(500).json({ error: "DASHBOARD_EMAIL / DASHBOARD_PASSWORD not set in .env" });
  if (email !== process.env.DASHBOARD_EMAIL || password !== process.env.DASHBOARD_PASSWORD)
    return res.status(401).json({ error: "Invalid credentials" });
  const token = crypto.randomBytes(32).toString("hex");
  _sessions.add(token);
  res.json({ token });
});

app.post("/api/logout", (req, res) => {
  const auth  = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  _sessions.delete(token);
  res.json({ ok: true });
});

// All /api/* routes below this line require a valid session token.
app.use("/api", (req, res, next) => {
  if (req.path === "/health") return next();
  return authMiddleware(req, res, next);
});

const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: '/ws' });

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    const envPortExplicit = Object.prototype.hasOwnProperty.call(process.env, "PORT") && process.env.PORT !== "";
    const basePort = Number(config?.port || 0);
    const fallbackEnabled = Number.isFinite(basePort) && basePort > 0;
    if (!fallbackEnabled) return;

    const maxAttempts = 10;
    let nextPort = basePort;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      nextPort = basePort + attempt;
      console.warn(
        `\n⚠️  Port ${basePort} is already in use.${envPortExplicit ? " (PORT was explicitly set)" : ""}` +
        `\n   Retrying on ${nextPort}...\n`
      );
      // Ensure the rest of the app (and dashboard banner) uses the actual bound port.
      config.port = nextPort;
      try { server.listen(nextPort); return; } catch (_) {}
    }

    console.error(`\n❌  Could not find a free port in range ${basePort + 1}-${basePort + maxAttempts}.\n`);
    process.exitCode = 1;
  }
});

wss.on("error", (err) => {
});

function broadcast(event, data) {
  const msg = JSON.stringify({ event, data, ts: new Date().toISOString() });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}
runner.setEmitter(broadcast);

// ── HEALTH ────────────────────────────────────────────────────
app.get("/api/health", (req, res) => res.json({ status: "ok" }));

// ── BINARY FUNDING TREE (Garden API assets + optional quote sim) ──
// Query: limit=<n> caps tree size (omit = use all supported assets for connected wallets)
//        simulate=1 runs level-by-level Garden quote simulation
app.get("/api/funding-tree", async (req, res) => {
  try {
    let assetLimit = null;
    if (req.query.limit != null && String(req.query.limit).trim() !== "") {
      const n = parseInt(String(req.query.limit), 10);
      if (!Number.isFinite(n) || n < 1) {
        return res.status(400).json({ ok: false, error: "limit must be a positive integer" });
      }
      assetLimit = n;
    }
    const ftOpts = { assetLimit };
    const simulate = req.query.simulate === "1" || req.query.simulate === "true";
    if (simulate) {
      const summary = await runner.simulateFundingTreeByLevel({}, { silent: true, ...ftOpts });
      return res.json(summary);
    }
    const plan = await runner.buildFundingTreePlan({}, ftOpts);
    return res.json({
      ok: true,
      structureValidation: plan.structureValidation,
      coverage: plan.coverage,
      levels: plan.levels.map(({ level, edges }) => ({
        level,
        edgeCount: edges.length,
        edges: edges.map((e) => ({
          parent: e.parent,
          child: e.child,
          parentAssetId: e.parentAssetId,
          childAssetId: e.childAssetId,
        })),
      })),
      returnToRootEdges: (plan.returnToRootEdges || []).map((r) => ({
        leafIndex: r.leafIndex,
        rootIndex: r.rootIndex,
        leafAssetId: r.leafAssetId,
        rootAssetId: r.rootAssetId,
      })),
      assetIds: plan.assetIds,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || String(e) });
  }
});

// ── CORE TEST ROUTES / BOT STATE ─────────────────────────────
let _amountOverrides = {};
let _lastEvmTokenBalancesByAddress = {};
let _lastSupportedTokensByAddress = {};
let _evmBalanceScanInFlight = null; // resolves when the active POST /api/wallet/evm/balances finishes

let _arbSummary = {
  totalProfitUsd: 0,
  trades: [],
};

// Last seed allowlist computed during route-readiness; reused at run time so display and execution use the same seed.
let _lastSeedAllowlist = null;
let _lastSeedAllowlistMode = null;
let _lastSeedAllowlistTs = 0;
const SEED_ALLOWLIST_REUSE_TTL = 90_000; // 90 s — stale after that, recompute
let _lastReadinessPlan = null;
let _lastReadinessPlanTs = 0;

function pickSeedAllowlistByMode(routes, balances, gasMap, mode) {
  if (mode !== "allChains") return null;
  try {
    const { RouteOptimizerAgent } = require("./agents/routeOptimizerAgent");
    const picker = new RouteOptimizerAgent();
    const pickedSeeds = picker.pickOneSeedPerChain(routes, balances, gasMap || new Map());
    return pickedSeeds.size ? pickedSeeds : null;
  } catch (_) {
    return null;
  }
}

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
  const mode = req.body?.mode === "allChains" ? "allChains" : "allTests";
  const force = req.body?.force === true;
  try {
    function jsonBigIntReplacer(_k, v) {
      return typeof v === "bigint" ? v.toString() : v;
    }
    function toJsonSafePayload(value) {
      try {
        return JSON.parse(JSON.stringify(value, jsonBigIntReplacer));
      } catch (_) {
        return { error: "serialization_failed" };
      }
    }

    const suiteStatus = runner.getSuiteRunStatus();
    if (suiteStatus?.suiteRunning) {
      if (!force) {
        return res.status(409).json({
          started: false,
          reason: "A suite is already running. Pass {force:true} to abort it and start a new run.",
          running: suiteStatus,
        });
      }
      runner.abortAll();
    }

    if (_evmBalanceScanInFlight) {
      await Promise.race([_evmBalanceScanInFlight, new Promise(r => setTimeout(r, 15000))]);
    }
    const { routes, connectedTypes, supported } = await buildRoutesForReadiness();
    const { balanceMap, gasMap } = await gatherBalances(connectedTypes, supported);
    // Reuse the seed the user just saw in the run window (within TTL), otherwise recompute.
    const seedAllowlistFresh = (_lastSeedAllowlist && _lastSeedAllowlistMode === mode &&
      (Date.now() - _lastSeedAllowlistTs) < SEED_ALLOWLIST_REUSE_TTL)
      ? _lastSeedAllowlist
      : pickSeedAllowlistByMode(routes, balanceMap, gasMap, mode);
    const seedAllowlist = seedAllowlistFresh;
    const seedAllowlistSize = seedAllowlist ? seedAllowlist.size : null;
    const { RouteOptimizerAgent } = require("./agents/routeOptimizerAgent");
    const agent = new RouteOptimizerAgent();
    const preview = agent.run(routes, {
      balances: balanceMap,
      gasBalances: gasMap,
      connectedWalletTypes: connectedTypes,
      seedAllowlist,
    }, mode);
    const readiness = preview.readiness;

    const hasQualifiedChainStart = (readiness.assets || []).some((a) => a.isChainStart && a.sufficient);
    const executablePlanCount = preview.executablePlanCount || 0;
    // Only when no beam seed qualifies AND there is no other executable plan (e.g. standalone) do we
    // require random native gas + Garden liquidity preflight (does not block funded standalone paths).
    if (mode === "allChains" && !hasQualifiedChainStart && executablePlanCount === 0) {
      const { resolveConsolidationTargetIfNoSeeds, verifyConsolidationPreflight } = require("./utils/consolidationTarget");
      let consolidation = null;
      try {
        consolidation = await resolveConsolidationTargetIfNoSeeds({ supported, gasMap });
      } catch (e) {
        return res.status(409).json({
          started: false, env: config.env, strictMode: true,
          reason: `Consolidation target resolution failed: ${e.message}`,
        });
      }
      if (consolidation.eligible) {
        const pre = await verifyConsolidationPreflight(consolidation, gasMap);
        if (!pre.ok) {
          return res.status(409).json({
            started: false, env: config.env, strictMode: true,
            reason: "Consolidation preflight failed: native gas or Garden liquidity check did not pass before run.",
            consolidation, preflight: pre,
          });
        }
        const targetId = consolidation.targetAssetId;
        const assetById = new Map(supported.map(a => [String(a.id), a]));
        const targetMeta = assetById.get(String(targetId));
        if (!targetMeta) {
          return res.status(409).json({
            started: false, env: config.env, strictMode: true,
            reason: `Consolidation target asset ${targetId} not found in supported assets`,
          });
        }
        const sources = [];
        for (const a of (readiness.assets || [])) {
          if (a.id === targetId || a.isChainFundedSource) continue;
          const bal = balanceMap.get(a.id);
          if (bal === null || bal === undefined) continue;
          const balNum = Number(bal);
          const minAmt = Math.max(1, parseInt(String(a.required || 50000), 10) || 50000);
          if (balNum < minAmt) continue;
          const srcMeta = assetById.get(String(a.id));
          if (!srcMeta) continue;
          sources.push({ id: a.id, amount: balNum, meta: srcMeta });
        }
        if (sources.length) {
          const toChainType = getWalletTypeForAsset(targetMeta);
          const consolidationRoutes = [];
          for (const src of sources) {
            const fromChainType = getWalletTypeForAsset(src.meta);
            if (!fromChainType || !toChainType) continue;
            const minAmt = Math.max(1, parseInt(String(src.meta.min_amount ?? 50000), 10) || 50000);
            const maxAmt = src.meta.max_amount ? parseInt(String(src.meta.max_amount), 10) : null;
            let useAmt = Math.max(minAmt, Math.floor(src.amount));
            if (maxAmt && useAmt > maxAmt) useAmt = maxAmt;
            consolidationRoutes.push({
              fromAsset: src.id, toAsset: targetId,
              fromChain: fromChainType, toChain: toChainType,
              amount: useAmt, fromMeta: src.meta, toMeta: targetMeta,
              label: `${src.meta.name || src.id} → ${targetMeta.name || targetId} [auto-consolidation]`,
              executionMode: "allChains",
            });
          }
          if (consolidationRoutes.length) {
            res.json({
              started: true, env: config.env, mode, autoConsolidating: true,
              consolidationTarget: targetId, consolidationHops: consolidationRoutes.length,
            });
            _amountOverrides = {};
            (async () => {
              broadcast("suite_start", { env: config.env, mode: "auto-consolidation", ts: new Date().toISOString() });
              let passed = 0;
              for (const route of consolidationRoutes) {
                broadcast("suite_info", { message: `Auto-consolidating: ${route.label}` });
                try {
                  const r = await runner.runRoute(route);
                  if (r.status === "pass") { passed++; broadcast("suite_info", { message: `Consolidated: ${route.label}` }); }
                  else broadcast("suite_info", { message: `Consolidation skipped/failed (${route.label}): ${r.error || r.status}` });
                } catch (e) { broadcast("suite_info", { message: `Consolidation error (${route.label}): ${e.message}` }); }
              }
              broadcast("suite_info", { message: `Auto-consolidation done (${passed}/${consolidationRoutes.length} passed) — waiting 2s then starting allChains` });
              await new Promise(r => setTimeout(r, 2000));
              runner.runAll({}, "allChains").catch(err => broadcast("error", { message: `allChains after auto-consolidation error: ${err.message}` }));
            })().catch(err => broadcast("error", { message: `auto-consolidation error: ${err.message}` }));
            return;
          }
        }
      }
    }

    // Strict run gate:
    // - allChains still requires an executable beam plan (runner executes beam-style routes).
    // - allTests now executes as a funding-tree fanout in runner, so it must not be blocked by beam readiness.
    // Do not hard-block run start based solely on optimizer executable count.
    // Runner-level execution handles skips/failures and emits concrete per-route outcomes.
    const strictReady = true;
    if (!strictReady) {
      return res.status(409).json({
        started: false,
        env: config.env,
        strictMode: true,
        reason: "No executable beam plan from currently funded sources.",
        readinessPct: readiness.readinessPct,
        requiredAmountSufficient: readiness.requiredAmountSufficient,
        requiredAmountSummary: readiness.requiredAmountSummary || null,
        seedAllowlistSize,
        builtChains: readiness.flowChains?.length || 0,
        rawPlannedRoutes: preview.rawPlanCount || 0,
        executablePlannedRoutes: preview.executablePlanCount || 0,
      });
    }

    const overrides = Object.assign({}, _amountOverrides);
    // allChains: skip preflight simulation entirely — it quotes all routes (200+ network calls).
    // Seed sufficiency and per-hop gas checks run at execution time inside runChain.
    let preflight = { ok: true, skipped: true, reason: "preflight_skipped" };
    if (!preflight.ok && mode !== "allTests") {
      _amountOverrides = {};
      const safePreflight = toJsonSafePayload(preflight);
      return res.status(409).json({
        started: false,
        env: config.env,
        strictMode: true,
        reason: `Pre-execution simulation failed: ${preflight.failedFlow?.error || preflight.failedFlow?.reason || "unknown"}`,
        simulation: safePreflight,
      });
    }

    res.json({
      started: true,
      env: config.env,
      mode,
      strictMode: true,
      rawPlannedRoutes: preview.rawPlanCount || 0,
      executablePlannedRoutes: preview.executablePlanCount || 0,
      simulation: toJsonSafePayload(preflight),
      warning:
        !preflight.ok && mode === "allTests"
          ? `allTests: preflight did not fully pass (${preflight.failedFlow?.reason || "failed"}); continuing anyway`
          : null,
    });
    _amountOverrides = {};
    // Prefer the exact plan the readiness modal showed (saved during /api/route-readiness)
    // so execution matches the displayed flow. Falls back to this handler's own optimizer run.
    const readinessPlanFresh = (mode === "allChains" && _lastReadinessPlan &&
      (Date.now() - _lastReadinessPlanTs) < SEED_ALLOWLIST_REUSE_TTL)
      ? _lastReadinessPlan : null;
    const serverPlan = readinessPlanFresh ||
      ((mode === "allChains" && preview.plan && preview.plan.length > 0) ? preview.plan : null);
    _lastReadinessPlan = null;
    _lastReadinessPlanTs = 0;
    runner.runAll(overrides, mode, seedAllowlist, serverPlan).catch(err => broadcast("error", { message: err.message }));
  } catch (err) {
    res.status(500).json({ started: false, error: err.message });
  }
});

// ── CONSOLIDATE then RUN allChains ───────────────────────────────────────────
// Runs source→target swaps in sequence, then kicks off allChains from the now-funded target.
app.post("/api/consolidate-and-run", async (req, res) => {
  const { sources, targetId } = req.body || {};
  if (!Array.isArray(sources) || !sources.length || !targetId) {
    return res.status(400).json({ error: "sources[] and targetId required" });
  }

  const suiteStatus = runner.getSuiteRunStatus();
  if (suiteStatus?.suiteRunning) {
    runner.abortAll();
    await new Promise(r => setTimeout(r, 300));
  }

  let allAssets = [];
  try {
    const g = await garden.getAssets();
    allAssets = g.result || g.assets || (Array.isArray(g) ? g : []);
  } catch (e) {
    return res.status(500).json({ error: `getAssets failed: ${e.message}` });
  }

  const assetById = new Map(allAssets.map(a => [String(a.id), a]));
  const targetMeta = assetById.get(String(targetId));
  if (!targetMeta) return res.status(400).json({ error: `Target asset ${targetId} not found` });

  function walletTypeOf(asset) {
    const ch = (asset.chain || "").toLowerCase();
    if (ch.startsWith("evm"))      return "evm";
    if (ch.startsWith("solana"))   return "solana";
    if (ch.startsWith("starknet")) return "starknet";
    if (ch.startsWith("tron"))     return "tron";
    if (ch.startsWith("sui"))      return "sui";
    if (ch === "bitcoin" && /^bitcoin_(testnet|mainnet|signet)$/.test(String(asset.id || "").split(":")[0])) return "bitcoin";
    return null;
  }

  const toChainType = walletTypeOf(targetMeta);
  if (!toChainType) return res.status(400).json({ error: `Unsupported chain type for target ${targetId}` });

  const consolidationRoutes = [];
  for (const src of sources) {
    const srcId  = String(src.id || src.assetId || "");
    const amount = Number(src.amount || 0);
    if (!srcId || amount <= 0 || srcId === String(targetId)) continue;
    const fromMeta = assetById.get(srcId);
    if (!fromMeta) continue;
    const fromChainType = walletTypeOf(fromMeta);
    if (!fromChainType) continue;
    const minAmt = Math.max(1, parseInt(String(fromMeta.min_amount ?? 50000), 10) || 50000);
    const maxAmt = fromMeta.max_amount ? parseInt(String(fromMeta.max_amount), 10) : null;
    let useAmount = Math.max(minAmt, Math.floor(amount));
    if (maxAmt && useAmount > maxAmt) useAmount = maxAmt;
    consolidationRoutes.push({
      fromAsset: srcId, toAsset: String(targetId),
      fromChain: fromChainType, toChain: toChainType,
      amount: useAmount, fromMeta, toMeta: targetMeta,
      label: `${fromMeta.name || srcId} → ${targetMeta.name || targetId} [consolidation]`,
      executionMode: "allChains",
    });
  }

  if (!consolidationRoutes.length) {
    return res.status(400).json({ error: "No valid consolidation routes from provided sources" });
  }

  res.json({ started: true, consolidationHops: consolidationRoutes.length, targetId });

  (async () => {
    broadcast("suite_start", { env: config.env, mode: "consolidation", ts: new Date().toISOString() });
    let passed = 0;
    for (const route of consolidationRoutes) {
      broadcast("suite_info", { message: `Consolidating: ${route.label}` });
      try {
        const r = await runner.runRoute(route);
        if (r.status === "pass") {
          passed++;
          broadcast("suite_info", { message: `✅ Consolidated: ${route.label}` });
        } else {
          broadcast("suite_info", { message: `⚠️ Consolidation swap skipped/failed (${route.label}): ${r.error || r.status}` });
        }
      } catch (e) {
        broadcast("suite_info", { message: `⚠️ Consolidation swap error (${route.label}): ${e.message}` });
      }
    }

    if (passed < consolidationRoutes.length) {
      const failed = consolidationRoutes.length - passed;
      broadcast("suite_end", {
        env: config.env, total: consolidationRoutes.length, executed: consolidationRoutes.length,
        passed, failed, aborted: 0, skipped: 0,
        message: `Consolidation incomplete: ${passed}/${consolidationRoutes.length} swaps passed, ${failed} failed — allChains not started (full amount required)`,
        ts: new Date().toISOString(),
      });
      return;
    }

    broadcast("suite_info", { message: `Consolidation complete (${passed}/${consolidationRoutes.length} passed) — waiting 2s for balances to settle, then starting allChains from ${targetId}` });
    await new Promise(r => setTimeout(r, 2000));
    runner.runAll({}, "allChains").catch(err => broadcast("error", { message: `allChains after consolidation error: ${err.message}` }));
  })().catch(err => broadcast("error", { message: `consolidate-and-run error: ${err.message}` }));
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

/** Whether `runAll` is currently executing (survives page reload; used to restore Running + Stop on the dashboard). */
app.get("/api/run/status", (req, res) => {
  res.json(runner.getSuiteRunStatus());
});

app.post("/api/abort", (req, res) => {
  const { testId } = req.body;
  if (testId) runner.abortTest(testId);
  else {
    runner.abortAll();
    _buildRoutesInFlight = null;
    _lastReadinessPlan = null;
    _lastReadinessPlanTs = 0;
  }
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
let _cachedAssets = null;
let _cachedAssetsTs = 0;
let _assetsInFlight = null;                  // dedup: concurrent callers share one fetch
const ASSET_CACHE_TTL = 120 * 1000;          // 2 min — Garden asset list rarely changes mid-session

async function getAssets() {
  const now = Date.now();
  if (_cachedAssets && (now - _cachedAssetsTs) < ASSET_CACHE_TTL) return _cachedAssets;
  if (_assetsInFlight) return _assetsInFlight; // already fetching — share the in-flight promise
  _assetsInFlight = garden.getAssets()
    .then(r => { _cachedAssets = r; _cachedAssetsTs = Date.now(); return r; })
    .catch(() => { return _cachedAssets || []; })
    .finally(() => { _assetsInFlight = null; });
  return _assetsInFlight;
}

// Force-clear asset cache — only call on explicit user actions (env switch, debug refresh)
function clearAssetCache() {
  _cachedAssets = null;
  _cachedAssetsTs = 0;
  _assetsInFlight = null;
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
    let fromAssetId, toAssetId, fromWalletType, toWalletType, fromMeta = null, toMeta = null, label;

    if (fromChain.includes(":") || toChain.includes(":")) {
      const [fromRes, toRes] = await Promise.all([resolveAssetId(fromChain), resolveAssetId(toChain)]);
      if (!fromRes) return res.status(400).json({ error: `Unknown asset: ${fromChain}` });
      if (!toRes)   return res.status(400).json({ error: `Unknown asset: ${toChain}` });
      fromAssetId    = fromRes.assetId;
      toAssetId      = toRes.assetId;
      fromWalletType = fromRes.walletType;
      toWalletType   = toRes.walletType;
      fromMeta       = fromRes.meta || null;
      toMeta         = toRes.meta || null;
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
      fromMeta,
      toMeta,
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
function isPairPlausible(from, to) {
  return from.id !== to.id; // all asset combinations allowed across all families
}

// ── HELPER: Check if a chain (by key or numeric ID) has a resolvable RPC ──
function chainHasRpc(chainKeyOrId) {
  if (!chainKeyOrId) return false;
  const envkey = require("./wallet/envkey");
  try { return !!envkey.getRpcForChain(chainKeyOrId); } catch (_) { return false; }
}

// ── HELPER: Build routes from assets + connected wallets ──────
let _buildRoutesInFlight = null; // dedup: concurrent callers share one pending build
async function buildRoutesForReadiness() {
  if (_buildRoutesInFlight) return _buildRoutesInFlight;
  _buildRoutesInFlight = _doBuildRoutesForReadiness().finally(() => { _buildRoutesInFlight = null; });
  return _buildRoutesInFlight;
}
async function _doBuildRoutesForReadiness() {
  const connectedTypes = getConnectedWalletTypes();
  if (connectedTypes.size === 0) return { routes: [], connectedTypes };

  const ar = await getAssets();
  const assets = ar.result || ar.assets || ar || [];
  if (!assets.length) return { routes: [], connectedTypes };

  // Only include assets whose wallet type is connected AND chain has an RPC.
  // Also checks numeric chain_id from asset metadata (Garden sends this in
  // prebuilt txs; if we can't resolve it to an RPC, execution will fail).
  const supported = assets.filter(a => {
    const wt = getWalletTypeForAsset(a);
    if (!wt || !connectedTypes.has(wt)) return false;
    const chainKey = String(a.id || '').split(':')[0].replace(/_sepolia|_testnet\d*|_mainnet|_signet|_devnet/g, '');
    if (!chainHasRpc(chainKey)) return false;
    const numericChainId = a.chain_id || a.chainId;
    if (numericChainId && wt === 'evm' && !chainHasRpc(numericChainId)) return false;
    return true;
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
  const evmAddrKey = wallets?.evm?.address ? String(wallets.evm.address).toLowerCase() : null;
  const evmTokenByChain = evmAddrKey ? (_lastEvmTokenBalancesByAddress[evmAddrKey] || {}) : {};
  const evmSupportedByChain = evmAddrKey ? (_lastSupportedTokensByAddress[evmAddrKey] || {}) : {};

  function getAssetTokenAddress(asset) {
    return asset?.token_address || asset?.tokenAddress || asset?.contract_address || asset?.contractAddress || asset?.token?.address || null;
  }

  function gteLikeValue(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'bigint') return v;
    try { return BigInt(String(v)); } catch (_) { return null; }
  }

  // Map EVM supported source assets to their cached balances by token contract.
  for (const a of (supported || [])) {
    if (getWalletTypeForAsset(a) !== "evm") continue;
    const assetId = a.id;
    const chainKey = String(assetId || "").split(":")[0];
    const tokenAddr = String(getAssetTokenAddress(a) || "").toLowerCase();

    // Native EVM assets: use native chain balance cache.
    if (!tokenAddr || tokenAddr === "native" || tokenAddr === "0x0000000000000000000000000000000000000000") {
      const nativeWei = wallets.evm?.tokenBalances?.[chainKey];
      if (nativeWei !== undefined && nativeWei !== null) {
        const bn = gteLikeValue(nativeWei);
        if (bn !== null) balanceMap.set(assetId, bn);
      }
      continue;
    }

    // ERC20 assets: use token balance cache built by /api/wallet/evm/balances.
    const chainTokenBals = evmTokenByChain[chainKey] || {};
    const chainSupported = evmSupportedByChain[chainKey] || [];
    const matched = Object.values(chainTokenBals).find(tb =>
      String(tb?.tokenAddr || "").toLowerCase() === tokenAddr
    );
    if (matched?.raw !== undefined && matched?.raw !== null) {
      const bn = gteLikeValue(matched.raw);
      if (bn !== null) balanceMap.set(assetId, bn);
      continue;
    }
    // If token is known on chain but not present in balances, treat as explicit zero (not unknown).
    if (chainSupported.some(st => String(st?.tokenAddr || "").toLowerCase() === tokenAddr)) {
      balanceMap.set(assetId, 0n);
    }
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
      citrea:'https://rpc.testnet.citrea.xyz', alpen:'https://rpc.testnet.alpenlabs.io',
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
// Cross-request cache to avoid re-quoting the same (from,to,amount) repeatedly.
// Cache values are non-sensitive (atomic amounts only).
const _quoteCacheGlobal = new Map(); // key -> { toAmount, ts }
const _QUOTE_CACHE_TTL_MS = 60_000;
async function buildCombinationsResponse() {
  const wallets = walletState.getStatus();
  const evmAddrKey = wallets?.evm?.address ? String(wallets.evm.address).toLowerCase() : null;
  const evmTokenByChain = evmAddrKey ? (_lastEvmTokenBalancesByAddress[evmAddrKey] || {}) : {};
  const evmSupportedByChain = evmAddrKey ? (_lastSupportedTokensByAddress[evmAddrKey] || {}) : {};
  const quoteCache = new Map(); // per-request hot cache: `${fromId}->${toId}->${fromAmount}` -> { toAmount }
  const quoteStats = { calls: 0, hits: 0, misses: 0, errors: 0 };
  const startedAt = Date.now();

  const assetsFetchStartedAt = Date.now();
  const ar      = await getAssets();
  const assetsFetchMs = Date.now() - assetsFetchStartedAt;
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

  // Include assets for all supported wallet types; status logic determines ready/partial/no.
  const supported = assets.filter(a => {
    const wt = getWalletType(a);
    return !!wt;
  });

  console.log(`[combinations] assets: ${assets.length}, supported: ${supported.length}`);
  const combinations = [];
  let quoteEnabledCount = 0;

  function getAssetTokenAddress(asset) {
    return asset?.token_address || asset?.tokenAddress || asset?.contract_address || asset?.contractAddress || asset?.token?.address || null;
  }

  function gteAtomic(left, right) {
    try {
      return BigInt(String(left)) >= BigInt(String(right));
    } catch (_) {
      const l = Number(left);
      const r = Number(right);
      return Number.isFinite(l) && Number.isFinite(r) && l >= r;
    }
  }

  async function computeSuggestedAmount({
    from,
    to,
    minAmount,
    maxAmount,
    minToAmount,
    walletBalance,
    canAfford,
    quoteEnabled,
  }) {
    function toBigIntOrNull(v) {
      if (v === null || v === undefined) return null;
      if (typeof v === "bigint") return v;
      if (typeof v === "number") {
        if (!Number.isFinite(v)) return null;
        return BigInt(Math.floor(v));
      }
      try {
        const s = String(v).trim();
        if (!s) return null;
        return BigInt(s.includes(".") ? s.split(".")[0] : s);
      } catch (_) {
        return null;
      }
    }

    function clampInt(n, lo, hi) {
      return Math.max(lo, Math.min(n, hi));
    }

    if (walletBalance === null || canAfford === false) return minAmount;

    const minBig = toBigIntOrNull(minAmount);
    const maxBig = toBigIntOrNull(maxAmount);
    const minToBig = toBigIntOrNull(minToAmount);
    const balBig = toBigIntOrNull(walletBalance);

    if (minBig !== null && maxBig !== null && minToBig !== null && balBig !== null) {
      // Mathematical formula (no external pricing):
      // target = to.min_amount + 0.4% (ceil) in destination asset atomic units.
      // Only safe to use directly as an input default when the pair is "like-kind"
      // (same token/decimals), otherwise atomic units are incomparable.
      const buf04 = (minToBig + 249n) / 250n; // ceil(minTo * 0.4%)
      const targetTo = minToBig + (buf04 > 0n ? buf04 : 1n);

      const fromTokenKey = String(from?.id || "").split(":")[1]?.toLowerCase() || "";
      const toTokenKey = String(to?.id || "").split(":")[1]?.toLowerCase() || "";
      const btcPegSet = new Set(["btc", "wbtc", "cbbtc", "ibtc"]);
      const isBtcPegged =
        btcPegSet.has(fromTokenKey) &&
        btcPegSet.has(toTokenKey) &&
        Number.isFinite(Number(from?.decimals)) &&
        Number.isFinite(Number(to?.decimals)) &&
        Number(from?.decimals) === Number(to?.decimals) &&
        Number(from?.decimals) === 8;
      const likeKind =
        fromTokenKey &&
        toTokenKey &&
        fromTokenKey === toTokenKey &&
        Number(from?.decimals) === Number(to?.decimals);

      if (likeKind) {
        // Rule A: Default suggested = clamp(targetTo, minAmount, maxAmount)
        let target = targetTo;
        if (target < minBig) target = minBig;
        if (target > maxBig) target = maxBig;

        // Rule B: If wallet balance is between sender min and target, use max wallet balance (clamped)
        // (user requested: "if wallet balance is between min trade and toMin+0.4% then use max balance")
        if (balBig >= minBig && balBig <= target) {
          const v = balBig > maxBig ? maxBig : balBig;
          return Number(v);
        }

        return Number(target);
      }

      if (!quoteEnabled) {
        // Without quote pricing, do not auto-max; keep a conservative default.
        // (Prevents "everything becomes max balance" when quotes are disabled/unavailable.)
        return Number(minBig);
      }

      function extractToAtomic(qr) {
        // Some Garden deployments return an array of quote options (or an object with numeric keys).
        // Normalize to a single quote record.
        const q0 =
          Array.isArray(qr) ? (qr[0] || null) :
          (qr && typeof qr === "object" && (qr["0"] != null)) ? qr["0"] :
          qr;
        // Try common response shapes without logging entire payload.
        return (
          q0?.destination?.amount ??
          q0?.destination?.atomic_amount ??
          q0?.destination_amount ??
          q0?.destinationAmount ??
          q0?.to_amount ??
          q0?.toAmount ??
          q0?.to_amount_atomic ??
          q0?.destination_amount_atomic ??
          q0?.quote?.destination?.amount ??
          q0?.quote?.destination_amount ??
          q0?.quote?.to_amount ??
          q0?.quote?.toAmount ??
          q0?.data?.destination?.amount ??
          q0?.data?.destination_amount ??
          q0?.data?.to_amount ??
          null
        );
      }

      const cacheKey = `${from.id}->${to.id}->${minAmount}`;
      let toAtMin = null;
      const cached = quoteCache.get(cacheKey);
      if (cached && cached.toAmount != null) {
        quoteStats.hits++;
        toAtMin = toBigIntOrNull(cached.toAmount);
      } else {
        // Global cache (TTL) to reduce latency across requests.
        const g = _quoteCacheGlobal.get(cacheKey);
        if (g && (Date.now() - g.ts) < _QUOTE_CACHE_TTL_MS && g.toAmount != null) {
          quoteStats.hits++;
          quoteCache.set(cacheKey, { toAmount: g.toAmount });
          toAtMin = toBigIntOrNull(g.toAmount);
        } else {
        try {
          quoteStats.misses++;
          quoteStats.calls++;
          const q = await garden.getQuote(from.id, to.id, minAmount);
          const qr = q?.result || q;
          const toAtomic = extractToAtomic(qr);

          quoteCache.set(cacheKey, { toAmount: toAtomic });
          _quoteCacheGlobal.set(cacheKey, { toAmount: toAtomic, ts: Date.now() });
          toAtMin = toBigIntOrNull(toAtomic);
        } catch (err) {
          quoteStats.errors++;
          quoteCache.set(cacheKey, { toAmount: null });
          toAtMin = null;

          // If Garden cannot quote due to insufficient liquidity, but both sides are BTC-pegged (8 decimals),
          // assume 1:1 for the purpose of meeting destination min trade amounts.
          const msg = String(err?.message || "");
          const insufficientLiq = (err?.status === 400) && msg.toLowerCase().includes("insufficient liquidity");
          if (insufficientLiq && isBtcPegged) {
            toAtMin = minBig; // 1:1 peg assumption => toAtMin at minFrom equals minFrom
          }
        }
        }
      }

      if (toAtMin !== null && toAtMin > 0n) {
        const requiredFrom = (minBig * targetTo + (toAtMin - 1n)) / toAtMin;
        if (balBig >= requiredFrom) {
          let v = requiredFrom;
          if (v < minBig) v = minBig;
          if (v > maxBig) v = maxBig;
          return Number(v);
        }
      }

      // If we couldn't compute/afford a destination-min-satisfying amount, keep it conservative.
      return Number(minBig);
    }

    const balNum = Number(walletBalance);
    if (!Number.isFinite(balNum)) return minAmount;
    if (balNum >= minAmount) return clampInt(Math.floor(balNum), minAmount, maxAmount);
    return minAmount;
  }

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
      const minToAmount   = parseInt(to.min_amount || 50000);

      let walletBalance = null;
      let canAfford     = null;

      if (fromType === "bitcoin" && wallets.btc?.balance && wallets.btc.balance !== "unknown") {
        walletBalance = Math.floor(parseFloat(wallets.btc.balance) * 1e8);
        canAfford = walletBalance >= minAmount;
      } else if (fromType === "solana" && wallets.solana?.balance) {
        walletBalance = parseFloat(wallets.solana.balance);
        canAfford = walletBalance >= minAmount;
      } else if (fromType === "evm" && wallets.evm?.address) {
        const chainKey = (from.id || '').split(':')[0];
        const tokenAddr = (getAssetTokenAddress(from) || '').toLowerCase();
        const chainTokenBals = evmTokenByChain[chainKey] || {};
        const chainSupported = evmSupportedByChain[chainKey] || [];

        if (tokenAddr && tokenAddr !== 'native' && tokenAddr !== '0x0000000000000000000000000000000000000000') {
          const match = Object.values(chainTokenBals).find(tb =>
            String(tb?.tokenAddr || '').toLowerCase() === tokenAddr
          );
          if (match?.raw !== undefined) {
            walletBalance = String(match.raw);
            canAfford = gteAtomic(walletBalance, minAmount);
          } else if (chainSupported.some(st => String(st?.tokenAddr || '').toLowerCase() === tokenAddr)) {
            // Known supported ERC20 on this chain but wallet balance is zero.
            walletBalance = "0";
            canAfford = false;
          }
        } else {
          const nativeWei = wallets.evm?.tokenBalances?.[chainKey];
          if (nativeWei !== undefined) {
            walletBalance = String(nativeWei);
            canAfford = gteAtomic(walletBalance, minAmount);
          }
        }
      }

      function toBigIntOrNull(v) {
        if (v === null || v === undefined) return null;
        if (typeof v === "bigint") return v;
        if (typeof v === "number") {
          if (!Number.isFinite(v)) return null;
          // If a float sneaks in, we only keep the integer part for atomic comparisons.
          return BigInt(Math.floor(v));
        }
        try {
          // String may be a big integer.
          const s = String(v).trim();
          if (!s) return null;
          return BigInt(s.includes(".") ? s.split(".")[0] : s);
        } catch (_) {
          return null;
        }
      }

      function clampInt(n, lo, hi) {
        return Math.max(lo, Math.min(n, hi));
      }

      // Default input/suggested amount rules:
      // - If balance < minAmount or unknown: suggested=minAmount
      // - If receiving asset has a minimum constraint, compute required send amount to
      //   reach (to.min_amount + 0.4%) using Garden quote pricing (chain-aware).
      //   If quote is unavailable, fall back to "max balance" behavior.
      // Always enforce sender min/max bounds.
      // Always clamp to maxAmount when known.
      const balanceKnown = walletBalance !== null;
      let comboStatus = "no";
      // "Send" wallet must be connected to be considered tradeable/partial.
      // If only destination wallet is connected, keep it in "no" (Not Connected).
      if (!fromConnected) comboStatus = "no";
      else if (toConnected && canAfford === true) comboStatus = "ready";
      else comboStatus = "partial";
      const canTrade = comboStatus === "ready";
      // Enable quote-based defaulting whenever we have a sender balance that can afford the sender min.
      // This keeps defaults accurate even when destination wallet isn't connected (partial),
      // while still avoiding quote spam for "no" combos / unknown balance.
      const minBigForQuote = toBigIntOrNull(minAmount);
      const quoteMinRequired = (minBigForQuote !== null) ? (minBigForQuote + ((minBigForQuote + 199n) / 200n)) : null; // min + ceil(min*0.5%)
      const canAffordPlus05 =
        quoteMinRequired !== null ? gteAtomic(walletBalance, quoteMinRequired.toString()) : (canAfford === true);

      const quoteEnabled = fromConnected && balanceKnown === true && canAffordPlus05 === true;
      if (quoteEnabled) quoteEnabledCount++;

      const suggestedFinal = await computeSuggestedAmount({
        from,
        to,
        minAmount,
        maxAmount,
        minToAmount,
        walletBalance,
        canAfford,
        quoteEnabled,
      });

      combinations.push({
        id: `${from.id}->${to.id}`,
        from: { assetId: from.id, name: from.name, chain: from.chain, icon: from.icon, walletType: fromType, decimals: from.decimals },
        to:   { assetId: to.id,   name: to.name,   chain: to.chain,   icon: to.icon,   walletType: toType,   decimals: to.decimals },
        minAmount, maxAmount, toMinAmount: minToAmount, suggestedAmount: suggestedFinal,
        fromWalletConnected: fromConnected,
        toWalletConnected:   toConnected,
        canTrade,
        canAfford,
        balanceKnown,
        walletBalance,
        comboStatus,
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
    // Wait for any in-flight EVM balance scan so we don't read stale/empty data
    if (_evmBalanceScanInFlight) {
      console.log("[route-readiness] waiting for in-flight EVM balance scan…");
      await Promise.race([
        _evmBalanceScanInFlight,
        new Promise(r => setTimeout(r, 15000)),
      ]);
    }

    const mode = req.query?.mode === "allChains" ? "allChains" : "allTests";
    const { routes, connectedTypes, supported } = await buildRoutesForReadiness();

    if (!routes.length) {
      return res.json({
        assets: [], totalRoutes: 0, runnableRoutes: 0, readinessPct: 100,
        flowChains: [], clusters: [], walletCoverage: null, mode,
        rawPlannedRoutes: 0, executablePlannedRoutes: 0, executablePlanRoutes: [],
      });
    }

    const { balanceMap, gasMap } = await gatherBalances(connectedTypes, supported);
    const seedAllowlist = pickSeedAllowlistByMode(routes, balanceMap, gasMap, mode);
    const seedAllowlistSize = seedAllowlist ? seedAllowlist.size : null;

    // Fetch isolation groups from Garden policy API for diagnostics
    let isolationGroups = null;
    try {
      const policyData = await garden.getGlobalPolicy();
      if (policyData?.isolation_groups || policyData?.isolationGroups) {
        isolationGroups = policyData.isolation_groups || policyData.isolationGroups;
        if (Array.isArray(isolationGroups) && isolationGroups.length) {
          console.log(`[policy] ${isolationGroups.length} isolation group(s) found:`,
            isolationGroups.map(g => `[${(g.assets || g.chains || g).join(', ')}]`).join(' | '));
        }
      }
    } catch (_) {}

    const { RouteOptimizerAgent } = require("./agents/routeOptimizerAgent");
    const agent = new RouteOptimizerAgent();
    const preview = agent.run(routes, {
      balances: balanceMap,
      gasBalances: gasMap,
      connectedWalletTypes: connectedTypes,
      seedAllowlist,
    }, mode);
    // Lock in the raffled seed so /api/run uses the exact same asset the display just showed.
    // Store as a single-element Set so candidateSeeds = [chosenSeed] → raffle is deterministic.
    if (preview.chosenSeed && mode === "allChains") {
      _lastSeedAllowlist = new Set([preview.chosenSeed]);
      _lastSeedAllowlistMode = mode;
      _lastSeedAllowlistTs = Date.now();
    }
    if (mode === "allChains" && Array.isArray(preview.plan) && preview.plan.length > 0) {
      _lastReadinessPlan = preview.plan;
      _lastReadinessPlanTs = Date.now();
    }
    const payload = preview.readiness;
    const hasQualifiedChainStart = (payload.assets || []).some((a) => a.isChainStart && a.sufficient);
    const executablePlanCountGet = preview.executablePlanCount || 0;
    const builtChains = (payload.flowChains || []).length;
    // Banner: offer a native consolidation hint when no beam chains were built (no Garden flow from seeds),
    // even if standalone/matrix hops still look executable — POST /api/run keeps stricter gating.
    const shouldResolveConsolidation =
      mode === "allChains" &&
      !hasQualifiedChainStart &&
      (executablePlanCountGet === 0 || builtChains === 0);
    let consolidation = null;
    if (shouldResolveConsolidation) {
      const { resolveConsolidationTargetIfNoSeeds } = require("./utils/consolidationTarget");
      try {
        consolidation = await resolveConsolidationTargetIfNoSeeds({ supported, gasMap });
      } catch (e) {
        consolidation = { eligible: false, reason: "resolver_error", error: e.message };
      }
    }
    // allChains: skip preflight simulation — quotes 200+ routes and hangs the readiness poll.
    const simulation = mode === "allChains"
      ? { ok: true, skipped: true, reason: "allChains_preflight_skipped" }
      : await runner.simulateExecutionPreflight(_amountOverrides, mode, { silent: true, maxFlows: 12 })
          .catch((e) => ({ ok: false, failedFlow: { reason: "simulation_error", error: e.message } }));
    const executablePlanRoutes = Array.isArray(preview.plan)
      ? preview.plan.map((r) => (r && typeof r === "object"
        ? { fromAsset: r.fromAsset, toAsset: r.toAsset, label: r.label || null }
        : null)).filter(Boolean)
      : [];
    res.json({
      ...payload,
      mode,
      selectedRunOption: mode,
      availableRunOptions: ["allTests", "allChains"],
      seedAllowlistSize,
      builtChains: payload.flowChains?.length || 0,
      rawPlannedRoutes: preview.rawPlanCount || 0,
      executablePlannedRoutes: preview.executablePlanCount || 0,
      executablePlanRoutes,
      canInitiate: (preview.executablePlanCount || 0) > 0,
      hasQualifiedChainStart,
      executablePlanCount: executablePlanCountGet,
      consolidation,
      simulation,
    });
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

  let fromMeta = null;
  let toMeta = null;
  try {
    const assets = await getAssets();
    const list = assets.result || assets.assets || (Array.isArray(assets) ? assets : []);
    fromMeta = list.find(a => a.id === fromAssetId) || null;
    toMeta = list.find(a => a.id === toAssetId) || null;
  } catch (_) {}

  res.json({ started: true });
  runner.runRoute({
    fromChain: fromWalletType || "evm",
    toChain:   toWalletType   || "evm",
    fromAsset: fromAssetId,
    toAsset:   toAssetId,
    amount,
    fromMeta,
    toMeta,
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
  try {
    walletState.connectMetaMask(address);
    res.json({ ok: true, address });
  }
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
  alpen_testnet:     "https://rpc.testnet.alpenlabs.io",
};

const ERC20_BALANCE_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

app.post("/api/wallet/evm/balances", async (req, res) => {
  const { address } = req.body;
  if (!address) return res.status(400).json({ error: "address required" });

  let _resolveBalanceScan;
  _evmBalanceScanInFlight = new Promise(r => { _resolveBalanceScan = r; });

  try {
  const results = {};
  const tokenResults = {};
  const supportedTokens = {};
  const rpcErrors = [];

  const chainTokenMap = {};
  const rawAssets = await getAssets().catch(() => null);
  const assetList = (rawAssets?.result || rawAssets?.assets || (Array.isArray(rawAssets) ? rawAssets : []));
  for (const a of assetList) {
    const chainId = (a.chain || a.id?.split(':')[0] || '').toLowerCase();
    const tokenAddr = a.token_address || a.tokenAddress || a.contract_address || a.contractAddress || a.token?.address;
    const ticker = (a.asset || a.ticker || a.id?.split(':')[1] || '').toLowerCase();
    if (!tokenAddr || tokenAddr === 'native' || tokenAddr === '0x0000000000000000000000000000000000000000') continue;
    let rpcKey = Object.keys(FREE_RPCS).find(k => chainId.startsWith(k.split('_')[0]) || k.startsWith(chainId.split('_')[0]));
    if (!rpcKey && chainId.startsWith('evm:')) {
      const numericChainId = parseInt(chainId.split(':')[1], 10);
      if (!Number.isNaN(numericChainId)) {
        const cfgChain = Object.values(config.chains).find(c => Number(c.chainId) === numericChainId);
        if (cfgChain?.id) {
          rpcKey = Object.keys(FREE_RPCS).find(k => k.startsWith(cfgChain.id)) || null;
        }
      }
    }
    if (!rpcKey) continue;
    if (!chainTokenMap[rpcKey]) chainTokenMap[rpcKey] = [];
    if (!supportedTokens[rpcKey]) supportedTokens[rpcKey] = [];
    if (!chainTokenMap[rpcKey].find(t => t.tokenAddr === tokenAddr)) {
      chainTokenMap[rpcKey].push({ id: a.id, ticker, tokenAddr });
    }
    if (!supportedTokens[rpcKey].find(t => t.tokenAddr === tokenAddr)) {
      supportedTokens[rpcKey].push({ id: a.id, ticker, tokenAddr });
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
  _lastEvmTokenBalancesByAddress[address.toLowerCase()] = tokenResults;
  _lastSupportedTokensByAddress[address.toLowerCase()] = supportedTokens;
  console.log(`[evm balances] ${Object.keys(results).length} chains OK, ${rpcErrors.length} errors, ${Object.values(tokenResults).reduce((s,t)=>s+Object.keys(t).length,0)} ERC20 balances`);
  res.json({ ok: true, address, balances: results, tokenBalances: tokenResults, supportedTokens, rpcErrors });
  } finally {
    _resolveBalanceScan();
    _evmBalanceScanInFlight = null;
  }
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

app.get("/api/rpc/scan", async (req, res) => {
  const checks = await Promise.all(Object.entries(FREE_RPCS).map(async ([chain, url]) => {
    const startedAt = Date.now();
    try {
      const out = await axios.post(url, {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_blockNumber",
        params: [],
      }, { timeout: 7000 });
      const raw = out.data?.result;
      if (!raw) throw new Error("No result from RPC");
      return {
        chain,
        url,
        ok: true,
        blockNumber: parseInt(raw, 16),
        latencyMs: Date.now() - startedAt,
      };
    } catch (e) {
      return {
        chain,
        url,
        ok: false,
        error: e.message,
        latencyMs: Date.now() - startedAt,
      };
    }
  }));

  const ok = checks.filter(c => c.ok).length;
  const failed = checks.length - ok;
  res.json({ ok: failed === 0, total: checks.length, healthy: ok, failed, checks });
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
  const evmAddrKey = status?.evm?.address ? String(status.evm.address).toLowerCase() : null;
  safeStatus.evmTokenBalances = evmAddrKey ? (_lastEvmTokenBalancesByAddress[evmAddrKey] || {}) : {};
  safeStatus.supportedTokens = evmAddrKey ? (_lastSupportedTokensByAddress[evmAddrKey] || {}) : {};
  for (const key of ['evm','btc','solana','starknet','sui','tron']) {
    if (safeStatus[key]?.source === 'envkey' && safeStatus[key]?.address) {
      const addr = safeStatus[key].address;
      safeStatus[key].addressDisplay = addr.slice(0,6) + '…' + addr.slice(-4);
      safeStatus[key].addressRedacted = false;
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