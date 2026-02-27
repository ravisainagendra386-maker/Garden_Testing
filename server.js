// src/server.js
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const path = require("path");
const config = require("./config");
const runner = require("./tests/runner");
const garden = require("./api/garden");

const app = express();
app.use(cors());
app.use(express.json());

// Serve dashboard
app.use(express.static(path.join(__dirname, "../dashboard")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Broadcast to all connected dashboard clients
function broadcast(event, data) {
  const msg = JSON.stringify({ event, data, ts: new Date().toISOString() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

// Wire up runner to use WebSocket broadcast
runner.setEmitter(broadcast);

// ── REST API ─────────────────────────────────────────────────

// Run all tests
app.post("/api/run", async (req, res) => {
  res.json({ started: true, env: config.env });
  runner.runAll().catch(err => broadcast("error", { message: err.message }));
});

// Run single route
app.post("/api/run/route", async (req, res) => {
  const { fromChain, toChain } = req.body;
  if (!fromChain || !toChain) return res.status(400).json({ error: "fromChain and toChain required" });
  const from = config.chains[fromChain];
  const to = config.chains[toChain];
  if (!from || !to) return res.status(400).json({ error: "Unknown chain" });
  res.json({ started: true });
  runner.runRoute({
    fromChain, toChain,
    fromAsset: from.asset, toAsset: to.asset,
    amount: fromChain === "bitcoin" ? config.test.btcAmountSats : config.test.evmAmount,
    label: `${from.name} → ${to.name}`,
  }).catch(err => broadcast("error", { message: err.message }));
});

// Run API tests only
app.post("/api/run/api-tests", async (req, res) => {
  const results = await runner.runApiTests();
  res.json(results);
});

// Manual approve/reject a pending transaction
app.post("/api/approve", (req, res) => {
  const { id, approved } = req.body;
  runner.handleApproval(id, approved);
  res.json({ ok: true });
});

// Get all chains
app.get("/api/chains", (req, res) => {
  res.json(Object.values(config.chains).map(c => ({
    id: c.id, name: c.name, type: c.type,
    rpc: c.rpc, explorer: c.explorer, asset: c.asset,
  })));
});

// Get current config (no secrets)
app.get("/api/config", (req, res) => {
  res.json({
    env: config.env,
    isMainnet: config.isMainnet,
    manualApprove: config.manualApprove,
    chainCount: Object.keys(config.chains).length,
  });
});

// Switch env (testnet/mainnet) — restarts with new env
app.post("/api/switch-env", (req, res) => {
  const { env } = req.body;
  if (!["testnet", "mainnet"].includes(env)) return res.status(400).json({ error: "Invalid env" });
  process.env.GARDEN_ENV = env;
  res.json({ ok: true, message: `Switched to ${env}. Please restart the server.` });
});

// Get Garden API quote for chatbot
app.post("/api/quote", async (req, res) => {
  const { fromChain, toChain, amount } = req.body;
  const from = config.chains[fromChain];
  const to = config.chains[toChain];
  if (!from || !to) return res.status(400).json({ error: "Unknown chain" });
  try {
    const q = await garden.getQuote(from.asset, to.asset, amount);
    res.json(q);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Chatbot: initiate a specific trade
app.post("/api/trade", async (req, res) => {
  const { fromChain, toChain, amount } = req.body;
  if (!fromChain || !toChain || !amount) return res.status(400).json({ error: "fromChain, toChain, amount required" });
  const from = config.chains[fromChain];
  const to = config.chains[toChain];
  if (!from || !to) return res.status(400).json({ error: "Unknown chain" });
  res.json({ started: true, label: `${from.name} → ${to.name}` });
  runner.runRoute({
    fromChain, toChain,
    fromAsset: from.asset, toAsset: to.asset, amount,
    label: `Chatbot: ${from.name} → ${to.name}`,
  }).catch(err => broadcast("error", { message: err.message }));
});

server.listen(config.port, () => {
  console.log(`\n✅  Garden Test Suite running`);
  console.log(`   Dashboard: http://localhost:${config.port}`);
  console.log(`   Environment: ${config.env.toUpperCase()}`);
  console.log(`   Manual Approve: ${config.manualApprove ? "ON ✋" : "OFF 🤖"}`);
  console.log(`   Chains: ${Object.keys(config.chains).length}\n`);
});

module.exports = { server, broadcast };
