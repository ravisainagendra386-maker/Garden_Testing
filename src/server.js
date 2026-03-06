// src/server.js
const express    = require("express");
const http       = require("http");
const WebSocket  = require("ws");
const cors       = require("cors");
const path       = require("path");
const axios      = require("axios");
const config     = require("./config");
const runner     = require("./tests/runner");
const garden     = require("./api/garden");
const walletState = require("./wallet/state");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../dashboard")));

const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

function broadcast(event, data) {
  const msg = JSON.stringify({ event, data, ts: new Date().toISOString() });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}
runner.setEmitter(broadcast);

// ── HEALTH ────────────────────────────────────────────────────
app.get("/api/health", (req, res) => res.json({ status: "ok" }));

// ── CORE TEST ROUTES ──────────────────────────────────────────
app.post("/api/run", async (req, res) => {
  res.json({ started: true, env: config.env });
  runner.runAll().catch(err => broadcast("error", { message: err.message }));
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

app.post("/api/abort", (req, res) => {
  const { testId } = req.body;
  if (testId) runner.abortTest(testId);
  else runner.abortAll();
  res.json({ ok: true });
});

app.post("/api/approve", (req, res) => {
  runner.handleApproval(req.body.id, req.body.approved);
  res.json({ ok: true });

app.post("/api/evm-tx-response", (req, res) => {
  runner.handleEvmTxResponse(req.body.id, req.body.txHash || false);
  res.json({ ok: true });
});
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
  res.json({ ok: true, message: `Switched to ${env}. Restart the server.` });
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

// ── ASSETS ────────────────────────────────────────────────────
app.get("/api/assets", async (req, res) => {
  try { res.json(await garden.getAssets()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── TRADE COMBINATIONS ────────────────────────────────────────
app.get("/api/combinations", async (req, res) => {
  try {
    const wallets = walletState.getStatus();
    const ar      = await garden.getAssets();
    const assets  = ar.result || ar.assets || ar || [];
    if (!assets.length) return res.json({ ok: true, total: 0, combinations: [] });

    // Dynamic wallet type — auto-supports new Garden networks.
    // Only rejects non-wallet chains: alpen_signet, litecoin, spark, xrpl.
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
        return null; // alpen_signet, litecoin_testnet, spark_regtest etc.
      }
      return null;
    }

    function isWalletConnected(t) {
      return { evm: !!wallets.evm, bitcoin: !!wallets.btc, solana: !!wallets.solana,
               starknet: !!wallets.starknet, sui: !!wallets.sui, tron: !!wallets.tron }[t] || false;
    }

    const supported = assets.filter(a => getWalletType(a) !== null);
    console.log(`[combinations] assets: ${assets.length}, supported: ${supported.length}, wallets:`, JSON.stringify({evm:!!wallets.evm,btc:!!wallets.btc}));
    const combinations = [];

    // Build all pairs — use asset min/max directly, no policy call needed
    for (const from of supported) {
      for (const to of supported) {
        if (from.id === to.id) continue;
        const fromType      = getWalletType(from);
        const toType        = getWalletType(to);
        const fromConnected = isWalletConnected(fromType);
        const toConnected   = isWalletConnected(toType);
        const minAmount     = parseInt(from.min_amount || 50000);
        const maxAmount     = parseInt(from.max_amount || 1000000);

        // Balance check per wallet type
        let walletBalance = null;
        let canAfford     = null; // null=unknown, true=ok, false=insufficient

        if (fromType === "bitcoin" && wallets.btc?.balance && wallets.btc.balance !== "unknown") {
          walletBalance = Math.floor(parseFloat(wallets.btc.balance) * 1e8); // BTC → sats
          canAfford = walletBalance >= minAmount;
        } else if (fromType === "solana" && wallets.solana?.balance) {
          walletBalance = parseFloat(wallets.solana.balance);
          canAfford = walletBalance >= minAmount;
        } else if (fromType === "evm" && wallets.evm?.address) {
          // Use cached EVM balance if available (populated by /api/wallet/evm/balance)
          const evmBal = wallets.evm?.tokenBalances?.[from.id];
          if (evmBal !== undefined) {
            walletBalance = evmBal;
            canAfford = walletBalance >= minAmount;
          }
          // else remains null = unknown
        }

        const suggested = (walletBalance !== null && canAfford !== false)
          ? Math.max(minAmount, Math.min(walletBalance, maxAmount))
          : minAmount;

        const balanceKnown = walletBalance !== null;
        const canTrade = fromConnected && toConnected && (canAfford !== false);

        combinations.push({
          id: `${from.id}->${to.id}`,
          from: { assetId: from.id, name: from.name, chain: from.chain, icon: from.icon, walletType: fromType, decimals: from.decimals },
          to:   { assetId: to.id,   name: to.name,   chain: to.chain,   icon: to.icon,   walletType: toType,   decimals: to.decimals },
          minAmount, maxAmount, suggestedAmount: suggested,
          fromWalletConnected: fromConnected,
          toWalletConnected:   toConnected,
          canTrade,
          canAfford,       // null=unknown, true=ok, false=insufficient
          balanceKnown,    // false for EVM (need RPC), true for BTC/SOL
          walletBalance,
        });
      }
    }

    combinations.sort((a, b) => {
      if (a.canTrade && !b.canTrade) return -1;
      if (!a.canTrade && b.canTrade) return 1;
      const ap = a.fromWalletConnected || a.toWalletConnected;
      const bp = b.fromWalletConnected || b.toWalletConnected;
      if (ap && !bp) return -1;
      if (!ap && bp) return 1;
      return a.from.name.localeCompare(b.from.name);
    });

    res.json({ ok: true, total: combinations.length, combinations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Run a confirmed trade from the combinations panel
// fromWalletType and toWalletType are the wallet types (evm/bitcoin/solana etc)
app.post("/api/run/combination", async (req, res) => {
  const { fromAssetId, toAssetId, fromWalletType, toWalletType, amount } = req.body;
  if (!fromAssetId || !toAssetId || !amount)
    return res.status(400).json({ error: "fromAssetId, toAssetId, amount required" });

  res.json({ started: true });
  runner.runRoute({
    fromChain: fromWalletType || "evm",
    toChain:   toWalletType   || "evm",
    fromAsset: fromAssetId,
    toAsset:   toAssetId,
    amount,
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
  try { walletState.connectMetaMask(address); res.json({ ok: true, address }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── WALLET: EVM BALANCE (free public RPCs) ───────────────────
// Fetches native ETH balance + known ERC20 token balances per chain
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

app.post("/api/wallet/evm/balances", async (req, res) => {
  const { address } = req.body;
  if (!address) return res.status(400).json({ error: "address required" });

  const results = {};
  const rpcErrors = [];

  await Promise.all(Object.entries(FREE_RPCS).map(async ([chainPrefix, rpcUrl]) => {
    try {
      const r = await axios.post(rpcUrl, {
        jsonrpc: "2.0", id: 1, method: "eth_getBalance",
        params: [address, "latest"]
      }, { timeout: 5000 });
      const hex = r.data?.result;
      if (hex) results[chainPrefix] = parseInt(hex, 16);
      else rpcErrors.push({ chain: chainPrefix, message: "No result from RPC" });
    } catch(err) {
      rpcErrors.push({ chain: chainPrefix, message: err.message });
    }
  }));

  walletState.setEvmBalances(address, results);
  console.log(`[evm balances] ${Object.keys(results).length} chains OK, ${rpcErrors.length} errors`);
  res.json({ ok: true, address, balances: results, rpcErrors });
});

// ── WALLET: BTC ───────────────────────────────────────────────
app.post("/api/wallet/btc", async (req, res) => {
  const { address, wif } = req.body;
  if (!address) return res.status(400).json({ error: "address required" });
  try {
    const net = config.isMainnet ? "" : "/testnet4";
    const r   = await axios.get(`https://mempool.space${net}/api/address/${address}`);
    const s   = r.data?.chain_stats || {};
    const sats = (s.funded_txo_sum || 0) - (s.spent_txo_sum || 0);
    const balance = (sats / 1e8).toFixed(8);
    walletState.connectBtc(address, wif, balance);
    res.json({ ok: true, address, balance });
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
  walletState.disconnect(req.body.type);
  res.json({ ok: true });
});

app.get("/api/wallet/balances", async (req, res) => {
  const btcAddr = walletState.getBtcAddress();
  if (btcAddr) {
    try {
      const net = config.isMainnet ? "" : "/testnet4";
      const r   = await axios.get(`https://mempool.space${net}/api/address/${btcAddr}`);
      const s   = r.data?.chain_stats || {};
      const sats = (s.funded_txo_sum || 0) - (s.spent_txo_sum || 0);
      walletState.connectBtc(btcAddr, walletState.getBtcWif(), (sats / 1e8).toFixed(8));
    } catch (_) {}
  }
  res.json(walletState.getStatus());
});

// ── START ─────────────────────────────────────────────────────
server.listen(config.port, () => {
  console.log(`\n✅  Garden Test Suite running`);
  console.log(`   Dashboard:   http://localhost:${config.port}`);
  console.log(`   Environment: ${config.env.toUpperCase()}`);
  console.log(`   Manual Approve: ${config.manualApprove ? "ON ✋" : "OFF 🤖"}`);
  console.log(`   Chains: ${Object.keys(config.chains).length}\n`);
});

// ── DEBUG: raw quote response ─────────────────────────────────
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

module.exports = { server, broadcast };

// ── STUCK ORDERS: list and retry ─────────────────────────────
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

    // Filter stuck: initiated but not completed/refunded, older than 5min
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

app.post("/api/orders/cancel/:id", async (req, res) => {
  try {
    const r = await garden.patchOrder(req.params.id, "refund", null);
    res.json({ ok: true, result: r });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});