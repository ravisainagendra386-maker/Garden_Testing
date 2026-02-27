const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const path = require("path");
const config = require("./config");
const runner = require("./tests/runner");
const garden = require("./api/garden");
const { getBtcBalanceSats } = require("./wallet/btc");
const { getAddress } = require("./wallet/privy");
const { ethers } = require("ethers");

const app = express();
app.use(cors());
app.use(express.json());

// Serve dashboard
app.use(express.static(path.join(__dirname, "../dashboard")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function broadcast(event, data) {
  const msg = JSON.stringify({ event, data, ts: new Date().toISOString() });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

runner.setEmitter(broadcast);

app.post("/api/run", async (_req, res) => {
  res.json({ started: true, env: config.env });
  runner.runAll().catch((err) => broadcast("error", { message: err.message }));
});

app.post("/api/run/route", async (req, res) => {
  const { fromChain, toChain } = req.body || {};
  if (!fromChain || !toChain)
    return res
      .status(400)
      .json({ error: "fromChain and toChain required" });
  const from = config.chains[fromChain];
  const to = config.chains[toChain];
  if (!from || !to) return res.status(400).json({ error: "Unknown chain" });
  res.json({ started: true });
  runner
    .runRoute({
      fromChain,
      toChain,
      fromAsset: from.asset,
      toAsset: to.asset,
      amount:
        fromChain === "bitcoin"
          ? config.test.btcAmountSats
          : config.test.evmAmount,
      label: `${from.name} → ${to.name}`,
    })
    .catch((err) => broadcast("error", { message: err.message }));
});

app.post("/api/run/api-tests", async (_req, res) => {
  const results = await runner.runApiTests();
  res.json(results);
});

app.post("/api/approve", (req, res) => {
  const { id, approved } = req.body || {};
  runner.handleApproval(id, approved);
  res.json({ ok: true });
});

app.get("/api/chains", (_req, res) => {
  res.json(
    Object.values(config.chains).map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      rpc: c.rpc,
      explorer: c.explorer,
      asset: c.asset,
    }))
  );
});

app.get("/api/config", (_req, res) => {
  res.json({
    env: config.env,
    isMainnet: config.isMainnet,
    manualApprove: config.manualApprove,
    chainCount: Object.keys(config.chains).length,
    envValidationSkipped: config.envValidationSkipped,
    hasGardenApiKey: Boolean(config.garden.apiKey),
  });
});

app.post("/api/switch-env", (req, res) => {
  const { env } = req.body || {};
  if (!["testnet", "mainnet"].includes(env))
    return res.status(400).json({ error: "Invalid env" });
  process.env.GARDEN_ENV = env;
  res.json({ ok: true, message: `Switched to ${env}. Please restart the server.` });
});

app.post("/api/quote", async (req, res) => {
  const { fromChain, toChain, amount } = req.body || {};
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

app.get("/api/balance", async (req, res) => {
  const chain = String(req.query.chain || "bitcoin");
  const c = config.chains[chain];
  if (!c) return res.status(400).json({ error: "Unknown chain" });

  try {
    if (c.type === "bitcoin") {
      const address = config.btc.address;
      if (!address) return res.status(400).json({ error: "BTC_ADDRESS is missing in .env" });
      const balanceSats = await getBtcBalanceSats(address);
      return res.json({ chain, type: c.type, address, balanceSats });
    }
    if (c.type === "evm") {
      const address = await getAddress("evm");
      const provider = new ethers.JsonRpcProvider(c.rpc);
      const wei = await provider.getBalance(address);
      return res.json({ chain, type: c.type, address, balanceWei: wei.toString(), balanceEth: ethers.formatEther(wei) });
    }
    return res.json({ chain, type: c.type, address: null, balance: null, note: "Balance not implemented for this chain type yet." });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/trade", async (req, res) => {
  const { fromChain, toChain, amount } = req.body || {};
  if (!fromChain || !toChain || !amount)
    return res.status(400).json({ error: "fromChain, toChain, amount required" });
  const from = config.chains[fromChain];
  const to = config.chains[toChain];
  if (!from || !to) return res.status(400).json({ error: "Unknown chain" });
  try {
    const label = `Trade: ${from.name} → ${to.name}`;
    const result = await runner.runRoute({
      fromChain,
      toChain,
      fromAsset: from.asset,
      toAsset: to.asset,
      amount,
      label,
    });
    if (result.status === "fail") return res.status(400).json({ error: result.error || "Trade failed" });
    return res.json({
      ok: true,
      label,
      testId: result.testId,
      orderId: result.orderId || null,
      depositTo: result.depositTo || null,
      depositAmount: result.depositAmount || null,
      note: "Order created and status monitoring started. See Dashboard/Live Log.",
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

server.listen(config.port, () => {
  console.log(`\n✅  Garden Test Suite running`);
  console.log(`   Dashboard: http://localhost:${config.port}`);
  console.log(`   Environment: ${config.env.toUpperCase()}`);
  console.log(`   Manual Approve: ${config.manualApprove ? "ON ✋" : "OFF"}`);
  if (config.envValidationSkipped) {
    console.log(`   Env validation: SKIPPED (set SKIP_ENV_VALIDATE=false to enforce)`);
  }
  console.log(`   Chains: ${Object.keys(config.chains).length}\n`);
});

module.exports = { server, broadcast };

