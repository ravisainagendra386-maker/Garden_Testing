// src/server.js
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const path = require("path");
const axios = require("axios");
const config = require("./config");
const runner = require("./tests/runner");
const walletStore = {
  privy:    null,
  btc:      null,
  evm:      null,
  solana:   null,
  starknet: null,
  sui:      null,
  tron:     null,
};
const garden = require("./api/garden");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../dashboard")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ── IN-MEMORY WALLET STORE (never written to disk) ────────────
const walletStore = {
  privy:    null, // { appId, appSecret, evmWalletId, solanaWalletId, evmAddress, solanaAddress }
  btc:      null, // { address, wif, balance }
  evm:      null, // { address }
  solana:   null, // { address, balance }
  starknet: null, // { address }
  sui:      null, // { address }
  tron:     null, // { address }
};

function broadcast(event, data) {
  const msg = JSON.stringify({ event, data, ts: new Date().toISOString() });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}
runner.setEmitter(broadcast);

// ── HEALTH ────────────────────────────────────────────────────
app.get("/api/health", (req, res) => res.json({ status: "ok" }));

// ── TEST ROUTES ───────────────────────────────────────────────
app.post("/api/run", async (req, res) => {
  res.json({ started: true, env: config.env });
  runner.runAll().catch(err => broadcast("error", { message: err.message }));
});

app.post("/api/run/route", async (req, res) => {
  const { fromChain, toChain } = req.body;
  if (!fromChain || !toChain) return res.status(400).json({ error: "fromChain and toChain required" });
  const from = config.chains[fromChain];
  const to = config.chains[toChain];
  if (!from || !to) return res.status(400).json({ error: "Unknown chain" });
  res.json({ started: true });
  runner.runRoute({ fromChain, toChain, fromAsset: from.asset, toAsset: to.asset, amount: 50000, label: `${from.name} → ${to.name}` })
    .catch(err => broadcast("error", { message: err.message }));
});

app.post("/api/run/api-tests", async (req, res) => {
  const results = await runner.runApiTests();
  res.json(results);
});

app.post("/api/approve", (req, res) => {
  runner.handleApproval(req.body.id, req.body.approved);
  res.json({ ok: true });
});

app.get("/api/chains", (req, res) => {
  res.json(Object.values(config.chains).map(c => ({ id: c.id, name: c.name, type: c.type, rpc: c.rpc, explorer: c.explorer, asset: c.asset })));
});

app.get("/api/config", (req, res) => {
  res.json({ env: config.env, isMainnet: config.isMainnet, manualApprove: config.manualApprove, chainCount: Object.keys(config.chains).length });
});

app.post("/api/switch-env", (req, res) => {
  const { env } = req.body;
  if (!["testnet", "mainnet"].includes(env)) return res.status(400).json({ error: "Invalid env" });
  process.env.GARDEN_ENV = env;
  res.json({ ok: true, message: `Switched to ${env}. Please restart the server.` });
});

app.post("/api/quote", async (req, res) => {
  const { fromChain, toChain, amount } = req.body;
  const from = config.chains[fromChain]; const to = config.chains[toChain];
  if (!from || !to) return res.status(400).json({ error: "Unknown chain" });
  try { res.json(await garden.getQuote(from.asset, to.asset, amount)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/trade", async (req, res) => {
  const { fromChain, toChain, amount } = req.body;
  if (!fromChain || !toChain || !amount) return res.status(400).json({ error: "fromChain, toChain, amount required" });
  const from = config.chains[fromChain]; const to = config.chains[toChain];
  if (!from || !to) return res.status(400).json({ error: "Unknown chain" });
  res.json({ started: true });
  runner.runRoute({ fromChain, toChain, fromAsset: from.asset, toAsset: to.asset, amount, label: `Chatbot: ${from.name} → ${to.name}` })
    .catch(err => broadcast("error", { message: err.message }));
});

// ── WALLET: PRIVY ─────────────────────────────────────────────
app.post("/api/privy/connect", async (req, res) => {
  const { appId, appSecret, evmWalletId, solanaWalletId } = req.body;
  if (!appId || !appSecret || !evmWalletId) return res.status(400).json({ error: "appId, appSecret, evmWalletId required" });
  try {
    const { PrivyClient } = require("@privy-io/node");
    const privy = new PrivyClient(appId, appSecret);
    const evmAddress = `privy:${evmWalletId}`;
    let solanaAddress = solanaWalletId ? `privy:${solanaWalletId}` : null;
    walletStore.privy = { appId, appSecret, evmWalletId, solanaWalletId, evmAddress, solanaAddress };
    res.json({ ok: true, evmAddress, solanaAddress });
  } catch (err) {
    res.status(500).json({ error: `Privy failed: ${err.message}` });
  }
});

app.get("/api/privy/status", (req, res) => {
  if (!walletStore.privy) return res.json({ connected: false });
  res.json({ connected: true, evmAddress: walletStore.privy.evmAddress, solanaAddress: walletStore.privy.solanaAddress });
});

app.post("/api/privy/disconnect", (req, res) => {
  walletStore.privy = null;
  res.json({ ok: true });
});

// ── WALLET: BTC ───────────────────────────────────────────────
app.post("/api/wallet/btc", async (req, res) => {
  const { address, wif } = req.body;
  if (!address) return res.status(400).json({ error: "address required" });
  try {
    const net = config.isMainnet ? "" : "/testnet4";
    const r = await axios.get(`https://mempool.space${net}/api/address/${address}`);
    const s = r.data?.chain_stats || {};
    const sats = (s.funded_txo_sum || 0) - (s.spent_txo_sum || 0);
    const balance = (sats / 1e8).toFixed(8);
    walletStore.btc = { address, wif: wif || null, balance };
    res.json({ ok: true, address, balance });
  } catch (_) {
    walletStore.btc = { address, wif: wif || null, balance: "unknown" };
    res.json({ ok: true, address, balance: "unknown" });
  }
});

// ── WALLET: EVM (from MetaMask frontend) ─────────────────────
app.post("/api/wallet/evm", (req, res) => {
  const { address } = req.body;
  if (!address) return res.status(400).json({ error: "address required" });
  walletStore.evm = { address };
  res.json({ ok: true, address });
});

// ── WALLET: SOLANA (from Phantom frontend) ───────────────────
app.post("/api/wallet/solana", (req, res) => {
  const { address, balance } = req.body;
  if (!address) return res.status(400).json({ error: "address required" });
  walletStore.solana = { address, balance: balance || null };
  res.json({ ok: true, address });
});

// ── WALLET: STARKNET / SUI / TRON ────────────────────────────
app.post("/api/wallet/starknet", (req, res) => { walletStore.starknet = req.body.address ? { address: req.body.address } : null; res.json({ ok: true }); });
app.post("/api/wallet/sui",      (req, res) => { walletStore.sui      = req.body.address ? { address: req.body.address } : null; res.json({ ok: true }); });
app.post("/api/wallet/tron",     (req, res) => { walletStore.tron     = req.body.address ? { address: req.body.address } : null; res.json({ ok: true }); });

// ── WALLET: DISCONNECT ────────────────────────────────────────
app.post("/api/wallet/disconnect", (req, res) => {
  const { type } = req.body;
  if (type in walletStore) walletStore[type] = null;
  res.json({ ok: true });
});

// ── WALLET: GET ALL STATUSES ──────────────────────────────────
app.get("/api/wallet/balances", async (req, res) => {
  // Refresh BTC balance live
  if (walletStore.btc?.address) {
    try {
      const net = config.isMainnet ? "" : "/testnet4";
      const r = await axios.get(`https://mempool.space${net}/api/address/${walletStore.btc.address}`);
      const s = r.data?.chain_stats || {};
      const sats = (s.funded_txo_sum || 0) - (s.spent_txo_sum || 0);
      walletStore.btc.balance = (sats / 1e8).toFixed(8);
    } catch (_) {}
  }
  res.json({
    evm:      walletStore.evm      ? { address: walletStore.evm.address } : null,
    btc:      walletStore.btc      ? { address: walletStore.btc.address, balance: walletStore.btc.balance } : null,
    solana:   walletStore.solana   ? { address: walletStore.solana.address, balance: walletStore.solana.balance } : null,
    starknet: walletStore.starknet ? { address: walletStore.starknet.address } : null,
    sui:      walletStore.sui      ? { address: walletStore.sui.address } : null,
    tron:     walletStore.tron     ? { address: walletStore.tron.address } : null,
    privy:    walletStore.privy    ? { connected: true, evmAddress: walletStore.privy.evmAddress, solanaAddress: walletStore.privy.solanaAddress } : { connected: false },
  });
});

// ── START ─────────────────────────────────────────────────────
server.listen(config.port, () => {
  console.log(`\n✅  Garden Test Suite running`);
  console.log(`   Dashboard: http://localhost:${config.port}`);
  console.log(`   Environment: ${config.env.toUpperCase()}`);
  console.log(`   Manual Approve: ${config.manualApprove ? "ON ✋" : "OFF 🤖"}`);
  console.log(`   Env validation: ${process.env.SKIP_ENV_VALIDATE === 'true' ? 'SKIPPED (set SKIP_ENV_VALIDATE=false to enforce)' : 'ACTIVE'}`);
  console.log(`   Chains: ${Object.keys(config.chains).length}\n`);
});

app.post("/api/privy/connect", async (req, res) => {
  const { appId, appSecret, evmWalletId, solanaWalletId } = req.body;
  if (!appId || !appSecret || !evmWalletId) return res.status(400).json({ error: "appId, appSecret, evmWalletId required" });
  try {
    const evmAddress = `privy:${evmWalletId}`;
    const solanaAddress = solanaWalletId ? `privy:${solanaWalletId}` : null;
    walletStore.privy = { appId, appSecret, evmWalletId, solanaWalletId, evmAddress, solanaAddress };
    res.json({ ok: true, evmAddress, solanaAddress });
  } catch (err) {
    res.status(500).json({ error: `Privy failed: ${err.message}` });
  }
});
module.exports = { server, broadcast };