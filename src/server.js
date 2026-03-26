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

// #region agent log
fetch('http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'8d11f5'},body:JSON.stringify({sessionId:'8d11f5',runId:'pre-fix',hypothesisId:'H1',location:'src/server.js:startup',message:'process/server created',data:{pid:process.pid,node:process.version,cwd:process.cwd(),argv:process.argv.slice(0,5)},timestamp:Date.now()})}).catch(()=>{});
// #endregion agent log

server.on("error", (err) => {
  // #region agent log
  fetch('http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'8d11f5'},body:JSON.stringify({sessionId:'8d11f5',runId:'pre-fix',hypothesisId:'H2',location:'src/server.js:server.error',message:'http server error event',data:{name:err?.name,code:err?.code,message:err?.message,errno:err?.errno,syscall:err?.syscall,address:err?.address,port:err?.port},timestamp:Date.now()})}).catch(()=>{});
  // #endregion agent log

  if (err && err.code === "EADDRINUSE") {
    const envPortExplicit = Object.prototype.hasOwnProperty.call(process.env, "PORT") && process.env.PORT !== "";
    const basePort = Number(config?.port || 0);
    const fallbackEnabled = Number.isFinite(basePort) && basePort > 0;
    // #region agent log
    fetch('http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'8d11f5'},body:JSON.stringify({sessionId:'8d11f5',runId:'pre-fix',hypothesisId:'H5',location:'src/server.js:EADDRINUSE',message:'port in use handling',data:{envPortExplicit,configPort:basePort,fallbackEnabled},timestamp:Date.now()})}).catch(()=>{});
    // #endregion agent log

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
      // #region agent log
      fetch('http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'8d11f5'},body:JSON.stringify({sessionId:'8d11f5',runId:'pre-fix',hypothesisId:'H6',location:'src/server.js:retryListen',message:'retrying listen on candidate port',data:{attempt,fromPort:basePort,toPort:nextPort,envPortExplicit},timestamp:Date.now()})}).catch(()=>{});
      // #endregion agent log
      try { server.listen(nextPort); return; } catch (_) {}
    }

    console.error(`\n❌  Could not find a free port in range ${basePort + 1}-${basePort + maxAttempts}.\n`);
    process.exitCode = 1;
  }
});

wss.on("error", (err) => {
  // #region agent log
  fetch('http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'8d11f5'},body:JSON.stringify({sessionId:'8d11f5',runId:'pre-fix',hypothesisId:'H3',location:'src/server.js:wss.error',message:'websocket server error event',data:{name:err?.name,code:err?.code,message:err?.message},timestamp:Date.now()})}).catch(()=>{});
  // #endregion agent log
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

let _arbSummary = {
  totalProfitUsd: 0,
  trades: [],
};

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
    // #region agent log
    fetch("http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "8d11f5" },
      body: JSON.stringify({
        sessionId: "8d11f5",
        runId: "api-run",
        hypothesisId: "H_api_run_1",
        location: "src/server.js:/api/run:entry",
        message: "/api/run called",
        data: { mode, force: !!force, hasBody: !!req.body },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion

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
        // #region agent log
        fetch("http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "8d11f5" },
          body: JSON.stringify({
            sessionId: "8d11f5",
            runId: "api-run",
            hypothesisId: "H_api_run_2",
            location: "src/server.js:/api/run:blocked_running",
            message: "Blocking /api/run because suite already running (force=false)",
            data: { mode, running: suiteStatus },
            timestamp: Date.now(),
          }),
        }).catch(() => {});
        // #endregion
        return res.status(409).json({
          started: false,
          reason: "A suite is already running. Pass {force:true} to abort it and start a new run.",
          running: suiteStatus,
        });
      }
      runner.abortAll();
    }

    // #region agent log
    fetch("http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "8d11f5" },
      body: JSON.stringify({
        sessionId: "8d11f5",
        runId: "api-run",
        hypothesisId: "H_api_run_5",
        location: "src/server.js:/api/run:before_buildRoutesForReadiness",
        message: "Before buildRoutesForReadiness",
        data: { mode },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    const { routes, connectedTypes, supported } = await buildRoutesForReadiness();
    // #region agent log
    fetch("http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "8d11f5" },
      body: JSON.stringify({
        sessionId: "8d11f5",
        runId: "api-run",
        hypothesisId: "H_api_run_6",
        location: "src/server.js:/api/run:after_buildRoutesForReadiness",
        message: "After buildRoutesForReadiness",
        data: { routesCount: routes?.length || 0, connectedTypesCount: connectedTypes?.size || 0, supportedCount: supported?.length || 0 },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    const { balanceMap, gasMap } = await gatherBalances(connectedTypes, supported);
    // #region agent log
    fetch("http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "8d11f5" },
      body: JSON.stringify({
        sessionId: "8d11f5",
        runId: "api-run",
        hypothesisId: "H_api_run_7",
        location: "src/server.js:/api/run:after_gatherBalances",
        message: "After gatherBalances",
        data: { balanceCount: balanceMap?.size || 0, gasCount: gasMap?.size || 0 },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    const seedAllowlist = pickSeedAllowlistByMode(routes, balanceMap, gasMap, mode);
    const seedAllowlistSize = seedAllowlist ? seedAllowlist.size : null;
    const { RouteOptimizerAgent } = require("./agents/routeOptimizerAgent");
    const agent = new RouteOptimizerAgent();
    // #region agent log
    fetch("http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "8d11f5" },
      body: JSON.stringify({
        sessionId: "8d11f5",
        runId: "api-run",
        hypothesisId: "H_api_run_9",
        location: "src/server.js:/api/run:before_agent_run",
        message: "Before RouteOptimizerAgent.run",
        data: { mode, routesCount: routes?.length || 0, seedAllowlistSize },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    const preview = agent.run(routes, {
      balances: balanceMap,
      gasBalances: gasMap,
      connectedWalletTypes: connectedTypes,
      seedAllowlist,
    }, mode);
    // #region agent log
    fetch("http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "8d11f5" },
      body: JSON.stringify({
        sessionId: "8d11f5",
        runId: "api-run",
        hypothesisId: "H_api_run_10",
        location: "src/server.js:/api/run:after_agent_run",
        message: "After RouteOptimizerAgent.run",
        data: {
          mode,
          rawPlanCount: preview?.rawPlanCount || 0,
          executablePlanCount: preview?.executablePlanCount || 0,
          readinessPct: preview?.readiness?.readinessPct ?? null,
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
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
          started: false,
          env: config.env,
          strictMode: true,
          reason: `Consolidation target resolution failed: ${e.message}`,
        });
      }
      if (consolidation.eligible) {
        const pre = await verifyConsolidationPreflight(consolidation, gasMap);
        if (!pre.ok) {
          return res.status(409).json({
            started: false,
            env: config.env,
            strictMode: true,
            reason: "Consolidation preflight failed: native gas or Garden liquidity check did not pass before run.",
            consolidation,
            preflight: pre,
          });
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
      // #region agent log
      fetch("http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "8d11f5" },
        body: JSON.stringify({
          sessionId: "8d11f5",
          runId: "api-run",
          hypothesisId: "H_api_run_3",
          location: "src/server.js:/api/run:strict_not_ready",
          message: "Blocking /api/run due to strictReady=false",
          data: {
            mode,
            readinessPct: readiness.readinessPct,
            executablePlanCount: preview.executablePlanCount || 0,
            builtChains: readiness.flowChains?.length || 0,
            seedAllowlistSize,
          },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
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
    let preflight = { ok: true, skipped: true, reason: "allTests_preflight_skipped" };
    if (mode !== "allTests") {
      // #region agent log
      fetch("http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "8d11f5" },
        body: JSON.stringify({
          sessionId: "8d11f5",
          runId: "api-run",
          hypothesisId: "H_api_run_11",
          location: "src/server.js:/api/run:before_preflight",
          message: "Before runner.simulateExecutionPreflight",
          data: { mode },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
      preflight = await runner.simulateExecutionPreflight(overrides, mode, { silent: true, maxFlows: 12 });
      // #region agent log
      fetch("http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "8d11f5" },
        body: JSON.stringify({
          sessionId: "8d11f5",
          runId: "api-run",
          hypothesisId: "H_api_run_12",
          location: "src/server.js:/api/run:after_preflight",
          message: "After runner.simulateExecutionPreflight",
          data: { mode, ok: !!preflight?.ok, failedFlow: preflight?.failedFlow || null },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
    } else {
      // #region agent log
      fetch("http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "8d11f5" },
        body: JSON.stringify({
          sessionId: "8d11f5",
          runId: "api-run",
          hypothesisId: "H_api_run_13",
          location: "src/server.js:/api/run:skip_preflight_allTests",
          message: "Skipping preflight for allTests",
          data: { mode },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
    }
    // #region agent log
    fetch('http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'82b36e'},body:JSON.stringify({sessionId:'82b36e',runId:'api-run',hypothesisId:'H5',location:'src/server.js:/api/run:preflight_done',message:'simulateExecutionPreflight result',data:{mode,ok:!!preflight?.ok,failedFlow:preflight?.failedFlow||null,skippedFlowIds:preflight?.skippedFlowIds||null,skippedFlowsCount:Array.isArray(preflight?.skippedFlows)?preflight.skippedFlows.length:0},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    if (!preflight.ok && mode !== "allTests") {
      _amountOverrides = {};
      const safePreflight = toJsonSafePayload(preflight);
      // #region agent log
      fetch('http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'82b36e'},body:JSON.stringify({sessionId:'82b36e',runId:'api-run',hypothesisId:'H5',location:'src/server.js:/api/run:preflight_block',message:'Blocking run due to preflight not ok',data:{mode,reason:`${preflight.failedFlow?.error||preflight.failedFlow?.reason||'unknown'}`},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
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
    // #region agent log
    fetch("http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "8d11f5" },
      body: JSON.stringify({
        sessionId: "8d11f5",
        runId: "api-run",
        hypothesisId: "H_api_run_4",
        location: "src/server.js:/api/run:started_true",
        message: "Started run; calling runner.runAll",
        data: { mode, rawPlannedRoutes: preview.rawPlanCount || 0, executablePlannedRoutes: preview.executablePlanCount || 0 },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    _amountOverrides = {};
    runner.runAll(overrides, mode).catch(err => broadcast("error", { message: err.message }));
  } catch (err) {
    // #region agent log
    fetch("http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "8d11f5" },
      body: JSON.stringify({
        sessionId: "8d11f5",
        runId: "api-run",
        hypothesisId: "H_api_run_8",
        location: "src/server.js:/api/run:catch",
        message: "/api/run threw exception",
        data: { mode, error: String(err?.message || err), stack: String(err?.stack || "").slice(0, 400) },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    res.status(500).json({ started: false, error: err.message });
  }
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

  // CHANGE: Always fresh assets
  clearAssetCache();
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
          // #region agent log
          if (Date.now() % 20 === 0) {
            fetch('http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'8d11f5'},body:JSON.stringify({sessionId:'8d11f5',runId:'post-fix',hypothesisId:'H16',location:'src/server.js:computeSuggestedAmount:likeKind:maxBal',message:'likeKind suggested uses max wallet balance (balance between min and target)',data:{from:from?.id,to:to?.id,minAmount:String(minBig),toMinAmount:String(minToBig),targetTo:String(targetTo),balance:String(balBig),suggested:String(v)},timestamp:Date.now()})}).catch(()=>{});
          }
          // #endregion agent log
          return Number(v);
        }

        // #region agent log
        if (Date.now() % 20 === 1) {
          fetch('http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'8d11f5'},body:JSON.stringify({sessionId:'8d11f5',runId:'post-fix',hypothesisId:'H16',location:'src/server.js:computeSuggestedAmount:likeKind:target',message:'likeKind suggested uses target (to.min+0.4%)',data:{from:from?.id,to:to?.id,minAmount:String(minBig),toMinAmount:String(minToBig),targetTo:String(targetTo),balance:String(balBig),suggested:String(target)},timestamp:Date.now()})}).catch(()=>{});
        }
        // #endregion agent log
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

          // #region agent log
          if (toAtomic == null && quoteStats.calls <= 5) {
            let topKeys = null;
            let destKeys = null;
            let quoteKeys = null;
            let quoteDestKeys = null;
            try { topKeys = Object.keys(qr || {}).slice(0, 30); } catch (_) {}
            try { destKeys = Object.keys(qr?.destination || {}).slice(0, 30); } catch (_) {}
            try { quoteKeys = Object.keys(qr?.quote || {}).slice(0, 30); } catch (_) {}
            try { quoteDestKeys = Object.keys(qr?.quote?.destination || {}).slice(0, 30); } catch (_) {}
            fetch('http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'8d11f5'},body:JSON.stringify({sessionId:'8d11f5',runId:'post-fix',hypothesisId:'H14',location:'src/server.js:computeSuggestedAmount:quoteShape',message:'quote missing destination amount field',data:{from:from?.id,to:to?.id,fromAmount:minAmount,hasResult:!!q?.result,topKeys,destKeys,quoteKeys,quoteDestKeys},timestamp:Date.now()})}).catch(()=>{});
          }
          // #endregion agent log
          quoteCache.set(cacheKey, { toAmount: toAtomic });
          _quoteCacheGlobal.set(cacheKey, { toAmount: toAtomic, ts: Date.now() });
          toAtMin = toBigIntOrNull(toAtomic);
        } catch (err) {
          quoteStats.errors++;
          quoteCache.set(cacheKey, { toAmount: null });
          toAtMin = null;

          // #region agent log
          if (quoteStats.errors <= 5) {
            fetch('http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'8d11f5'},body:JSON.stringify({sessionId:'8d11f5',runId:'post-fix',hypothesisId:'H15',location:'src/server.js:computeSuggestedAmount:quoteError',message:'quote call failed',data:{from:from?.id,to:to?.id,fromAmount:minAmount,message:err?.message||null,name:err?.name||null,status:err?.status||null},timestamp:Date.now()})}).catch(()=>{});
          }
          // #endregion agent log

          // If Garden cannot quote due to insufficient liquidity, but both sides are BTC-pegged (8 decimals),
          // assume 1:1 for the purpose of meeting destination min trade amounts.
          const msg = String(err?.message || "");
          const insufficientLiq = (err?.status === 400) && msg.toLowerCase().includes("insufficient liquidity");
          if (insufficientLiq && isBtcPegged) {
            toAtMin = minBig; // 1:1 peg assumption => toAtMin at minFrom equals minFrom
            // #region agent log
            fetch('http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'8d11f5'},body:JSON.stringify({sessionId:'8d11f5',runId:'post-fix',hypothesisId:'H17',location:'src/server.js:computeSuggestedAmount:btcPegFallback',message:'using BTC-peg 1:1 fallback due to insufficient liquidity',data:{from:from?.id,to:to?.id,decimalsFrom:from?.decimals,decimalsTo:to?.decimals,minAmount:String(minBig),toMinAmount:String(minToBig),targetTo:String(targetTo)},timestamp:Date.now()})}).catch(()=>{});
            // #endregion agent log
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
          // #region agent log
          if (quoteStats.calls <= 3) {
            fetch('http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'8d11f5'},body:JSON.stringify({sessionId:'8d11f5',runId:'post-fix',hypothesisId:'H12',location:'src/server.js:computeSuggestedAmount:requiredFrom',message:'computed requiredFrom for to.min+0.5%',data:{from:from?.id,to:to?.id,minAmount:String(minBig),targetTo:String(targetTo),toAtMin:String(toAtMin),requiredFrom:String(requiredFrom),balance:String(balBig),suggested:String(v)},timestamp:Date.now()})}).catch(()=>{});
          }
          // #endregion agent log
          return Number(v);
        }
      }

      // If we couldn't compute/afford a destination-min-satisfying amount, keep it conservative.
      // #region agent log
      if (String(from?.id || "").toLowerCase().includes("eth") && (String(to?.id || "").toLowerCase().includes("usdc") || String(to?.name || "").toLowerCase().includes("usdc"))) {
        fetch('http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'8d11f5'},body:JSON.stringify({sessionId:'8d11f5',runId:'post-fix',hypothesisId:'H13',location:'src/server.js:computeSuggestedAmount:fallbackMin',message:'suggestedAmount fallback -> minAmount (quote/rate unavailable or cannot afford required)',data:{from:from?.id,to:to?.id,minAmount:String(minBig),toMinAmount:String(minToBig),targetTo:String(targetTo),toAtMin:toAtMin===null?null:String(toAtMin),balance:String(balBig)},timestamp:Date.now()})}).catch(()=>{});
      }
      // #endregion agent log
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

  // #region agent log
  try {
    let tReq = 0, tBal = 0, tMin = 0;
    for (const c of combinations) {
      const bal = toBigIntOrNull(c.walletBalance);
      const min = toBigIntOrNull(c.minAmount);
      const minTo = toBigIntOrNull(c.toMinAmount);
      if (bal === null || min === null || minTo === null || c.canAfford === false) { tMin++; continue; }
      const sug = toBigIntOrNull(c.suggestedAmount);
      const max = toBigIntOrNull(c.maxAmount);
      const maxBal = (max !== null && bal !== null && bal > max) ? max : bal;
      const isMaxBal = sug !== null && maxBal !== null && sug === maxBal;
      if (!isMaxBal) tReq++;
      else if (bal >= min) tBal++;
      else tMin++;
    }
    fetch('http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'8d11f5'},body:JSON.stringify({sessionId:'8d11f5',runId:'pre-fix',hypothesisId:'H8',location:'src/server.js:buildCombinationsResponse',message:'suggestedAmount tier counts (to.min via USD -> required send)',data:{total:combinations.length,tReq,tBal,tMin},timestamp:Date.now()})}).catch(()=>{});
  } catch (_) {}
  // #endregion agent log

  // #region agent log
  fetch('http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'8d11f5'},body:JSON.stringify({sessionId:'8d11f5',runId:'pre-fix',hypothesisId:'H10',location:'src/server.js:buildCombinationsResponse',message:'buildCombinationsResponse perf',data:{ms:Date.now()-startedAt,assetsFetchMs,assets:assets.length,supported:supported.length,combinations:combinations.length,quoteEnabledCount,quoteCalls:quoteStats.calls,quoteHits:quoteStats.hits,quoteMisses:quoteStats.misses,quoteErrors:quoteStats.errors,quoteCacheSize:quoteCache.size},timestamp:Date.now()})}).catch(()=>{});
  // #endregion agent log

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
  const reqStartedAt = Date.now();
  // #region agent log
  fetch('http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'8d11f5'},body:JSON.stringify({sessionId:'8d11f5',runId:'pre-fix',hypothesisId:'H11',location:'src/server.js:/api/combinations:entry',message:'combinations request start',data:{qs:req.query||null},timestamp:Date.now()})}).catch(()=>{});
  // #endregion agent log
  try {
    const payload = await buildCombinationsResponse();
    // #region agent log
    fetch('http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'8d11f5'},body:JSON.stringify({sessionId:'8d11f5',runId:'pre-fix',hypothesisId:'H11',location:'src/server.js:/api/combinations:success',message:'combinations request success',data:{ms:Date.now()-reqStartedAt,total:payload?.total},timestamp:Date.now()})}).catch(()=>{});
    // #endregion agent log
    res.json(payload);
  } catch (err) {
    // #region agent log
    fetch('http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'8d11f5'},body:JSON.stringify({sessionId:'8d11f5',runId:'pre-fix',hypothesisId:'H11',location:'src/server.js:/api/combinations:error',message:'combinations request error',data:{ms:Date.now()-reqStartedAt,message:err?.message,name:err?.name},timestamp:Date.now()})}).catch(()=>{});
    // #endregion agent log
    res.status(500).json({ error: err.message });
  }
});

// ── ROUTE READINESS — chain-reaction aware ───────────────────
app.get("/api/route-readiness", async (req, res) => {
  try {
    const mode = req.query?.mode === "allChains" ? "allChains" : "allTests";
    // #region agent log
    fetch('http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'66ed74'},body:JSON.stringify({sessionId:'66ed74',runId:'server',hypothesisId:'H28',location:'src/server.js:/api/route-readiness:entry',message:'route-readiness request received',data:{mode,hasQueryMode:typeof req.query?.mode==='string'},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
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

    const { RouteOptimizerAgent } = require("./agents/routeOptimizerAgent");
    const agent = new RouteOptimizerAgent();
    const preview = agent.run(routes, {
      balances: balanceMap,
      gasBalances: gasMap,
      connectedWalletTypes: connectedTypes,
      seedAllowlist,
    }, mode);
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
    const simulation = await runner.simulateExecutionPreflight(_amountOverrides, mode, { silent: true, maxFlows: 12 })
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
  // #region agent log
  fetch('http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'8d11f5'},body:JSON.stringify({sessionId:'8d11f5',runId:'pre-fix',hypothesisId:'H7',location:'src/server.js:/api/wallet/balances',message:'wallet balances response shape',data:{evm:{has:!!safeStatus?.evm,source:safeStatus?.evm?.source||null,addressPrefix:(safeStatus?.evm?.address||'').slice(0,10),addressDisplayPrefix:(safeStatus?.evm?.addressDisplay||'').slice(0,10)}},timestamp:Date.now()})}).catch(()=>{});
  // #endregion agent log
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
// #region agent log
fetch('http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'8d11f5'},body:JSON.stringify({sessionId:'8d11f5',runId:'pre-fix',hypothesisId:'H1',location:'src/server.js:beforeListen',message:'about to listen',data:{pid:process.pid,port:config?.port,envPort:process.env.PORT||null},timestamp:Date.now()})}).catch(()=>{});
// #endregion agent log
server.listen(config.port, () => {
  // #region agent log
  fetch('http://127.0.0.1:7282/ingest/f4ac0055-0c9e-4897-b3eb-77966339412a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'8d11f5'},body:JSON.stringify({sessionId:'8d11f5',runId:'pre-fix',hypothesisId:'H4',location:'src/server.js:listenCallback',message:'listening callback fired',data:{pid:process.pid,port:config?.port},timestamp:Date.now()})}).catch(()=>{});
  // #endregion agent log
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