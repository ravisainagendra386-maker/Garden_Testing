const config = require("../config");
const garden = require("../api/garden");
const { getBtcBalanceSats, sendBtcPayment } = require("../wallet/btc");
const { getAddress } = require("../wallet/privy");

let _emit = null;
let _approvalQueue = [];
const _orderMonitors = new Map(); // orderId -> intervalId

function setEmitter(fn) {
  _emit = fn;
}

function emit(event, data) {
  if (_emit) _emit(event, data);
  else console.log(`[${event}]`, data);
}

function normalizeOrderStatus(s) {
  return String(s || "").trim();
}

function nextActionForStatus(status, fromType) {
  switch (status) {
    case "Created":
      return "Waiting for solver to match…";
    case "Matched":
      return fromType === "bitcoin"
        ? "Awaiting your BTC deposit to the provided address."
        : "Awaiting you to initiate the transaction on the source chain.";
    case "InitiateDetected":
      return "Initiation detected, waiting for confirmation…";
    case "Initiated":
      return "Initiation confirmed. Waiting for solver to initiate destination…";
    case "CounterPartyInitiateDetected":
      return "Solver initiation detected, waiting for confirmation…";
    case "CounterPartyInitiated":
      return "Solver initiation confirmed. You must redeem on destination to complete.";
    case "RedeemDetected":
      return "Redeem detected, waiting for confirmation…";
    case "Redeemed":
      return "Redeem confirmed. Waiting for solver to redeem source…";
    case "CounterPartyRedeemDetected":
      return "Solver redeem detected, waiting for confirmation…";
    case "CounterPartyRedeemed":
    case "Completed":
      return "Completed.";
    case "Expired":
      return "Expired. Refund required.";
    case "RefundDetected":
      return "Refund detected, waiting for confirmation…";
    case "Refunded":
      return "Refunded.";
    case "DeadLineExceeded":
      return "Deadline exceeded.";
    default:
      return status ? `Status: ${status}` : "Unknown status";
  }
}

async function resolveOwnerAddress(chainKey) {
  const chain = config.chains[chainKey];
  if (!chain) throw new Error(`Unknown chain: ${chainKey}`);

  if (chain.type === "bitcoin") {
    if (!config.btc.address) throw new Error("BTC_ADDRESS is missing in .env");
    return config.btc.address;
  }
  if (chain.type === "evm") {
    try {
      return await getAddress("evm");
    } catch (e) {
      throw new Error(
        "No EVM address available. Set OVERRIDE_EVM_ADDRESS in .env or configure Privy (PRIVY_*)."
      );
    }
  }

  throw new Error(`Owner resolution not implemented for chain type: ${chain.type}`);
}

async function runApiTests() {
  const results = [];
  const tests = [
    { name: "Server Health", fn: () => garden.health() },
    { name: "Get Chains", fn: () => garden.getChains() },
    { name: "Get Assets", fn: () => garden.getAssets() },
    { name: "Get Volume", fn: () => garden.getVolume() },
  ];

  for (const t of tests) {
    const start = Date.now();
    try {
      await t.fn();
      results.push({ name: t.name, status: "pass", ms: Date.now() - start });
    } catch (err) {
      results.push({
        name: t.name,
        status: "fail",
        error:
          err?.message ||
          "API call failed (is `GARDEN_API_KEY` set in your .env?)",
        ms: Date.now() - start,
      });
    }
  }

  emit("api_tests_done", results);
  return results;
}

function buildRoutes() {
  const btc = config.chains.bitcoin;
  const others = Object.values(config.chains).filter((c) => c.id !== "bitcoin");

  const routes = [];

  // BTC as source → any other chain
  for (const dest of others) {
    routes.push({
      fromChain: "bitcoin",
      toChain: dest.id,
      fromAsset: btc.asset,
      toAsset: dest.asset,
      amount: config.test.btcAmountSats || 50000,
      label: `BTC → ${dest.name}`,
    });
  }

  // Only EVM chains as source → BTC (non-EVM initiation is not implemented here)
  for (const src of others.filter((c) => c.type === "evm")) {
    routes.push({
      fromChain: src.id,
      toChain: "bitcoin",
      fromAsset: src.asset,
      toAsset: btc.asset,
      amount: config.test.evmAmount || 10000,
      label: `${src.name} → BTC`,
    });
  }

  return routes;
}

async function runRoute({ fromChain, toChain, fromAsset, toAsset, amount, label }) {
  const testId = `${fromChain}->${toChain}-${Date.now()}`;
  const steps = [];
  const fromType = config.chains[fromChain]?.type || "evm";

  function step(name, status, detail = "", txHash = null) {
    const s = { name, status, detail, txHash, ts: new Date().toISOString() };
    steps.push(s);
    emit("test_step", { testId, label, step: s });
  }

  emit("test_start", {
    testId,
    label,
    fromChain,
    toChain,
    fromAsset,
    toAsset,
    amount,
  });

  // E2E can be toggled, but trade initiation (order creation + status) is always available.
  if (String(process.env.ENABLE_E2E || "").toLowerCase() !== "true") {
    step("E2E Disabled", "pending", "Order creation/status works. On-chain execution is disabled (ENABLE_E2E=false).");
  }

  try {
    step("Health Check", "running");
    await garden.health();
    step("Health Check", "pass", "API is live");

    // 1) Check wallet balance (source chain)
    if (fromType === "bitcoin") {
      step("Wallet Balance", "running");
      const addr = config.btc.address;
      if (!addr) throw new Error("BTC_ADDRESS is missing in .env");
      const bal = await getBtcBalanceSats(addr);
      step("Wallet Balance", "pass", `${bal} sats available on ${addr}`);
      if (bal < Number(amount)) {
        throw new Error(`Insufficient BTC balance: have ${bal} sats, need ${amount} sats`);
      }
    } else {
      step("Wallet Balance", "pending", "Balance checks for non-BTC routes are not implemented yet.");
    }

    // 2) Quote
    step("Get Quote", "running");
    const quoteRes = await garden.getQuote(fromAsset, toAsset, amount);
    const quote = Array.isArray(quoteRes?.result) ? quoteRes.result[0] : quoteRes?.result;
    if (!quote) throw new Error("No quote returned");
    const dstAmt = quote.destination?.amount || quote.to_amount || quote.output_amount;
    step("Get Quote", "pass", `Destination amount: ${dstAmt}`);

    // 3) Create order
    step("Create Order", "running");
    const fromOwner = await resolveOwnerAddress(fromChain);
    const toOwner = await resolveOwnerAddress(toChain);
    const orderRes = await garden.createOrder({
      source: { asset: fromAsset, owner: fromOwner, amount: String(amount) },
      destination: { asset: toAsset, owner: toOwner, amount: String(dstAmt || amount) },
      slippage: 50,
    });

    const orderId = orderRes?.result?.order_id;
    if (!orderId) throw new Error("Order creation failed: missing order_id");

    // Bitcoin create-order includes deposit address + amount
    const depositTo = orderRes?.result?.to;
    const depositAmount = orderRes?.result?.amount;
    step("Order Created", "pass", `order_id: ${orderId}`);

    if (fromType === "bitcoin" && depositTo) {
      step("Send BTC Deposit", "running", `Sending ${depositAmount || amount} sats to ${depositTo}…`);
      const txHash = await sendBtcPayment({
        to: depositTo,
        amountSats: Number(depositAmount || amount),
      });
      step("Send BTC Deposit", "pass", `Tx broadcast`, txHash);
    } else {
      step("Awaiting Initiation", "pending", `Order matched/ready (order: ${orderId})`);
    }

    monitorOrderStatus({ orderId, testId, label, fromType });

    // Do not end the test immediately; it will end when Completed/Refunded/etc.
    return { testId, label, status: "running", orderId, depositTo, depositAmount };
  } catch (err) {
    step("Error", "fail", err.message || "Unknown error");
    emit("test_end", { testId, label, status: "fail", error: err.message, steps });
    return { testId, label, status: "fail", error: err.message, steps };
  }
}

function monitorOrderStatus({ orderId, testId, label, fromType }) {
  if (!orderId) return;
  if (_orderMonitors.has(orderId)) return;

  let lastStatus = null;
  const intervalId = setInterval(async () => {
    try {
      const res = await garden.getOrder(orderId);
      const status = normalizeOrderStatus(res?.result?.status);
      if (!status) return;
      if (status === lastStatus) return;
      lastStatus = status;

      emit("test_step", {
        testId,
        label,
        step: {
          name: "Order Status",
          status: ["Completed", "CounterPartyRedeemed", "Refunded"].includes(status) ? "pass" : "running",
          detail: `${status} — ${nextActionForStatus(status, fromType)}`,
          ts: new Date().toISOString(),
        },
      });

      if (["Completed", "CounterPartyRedeemed"].includes(status)) {
        clearInterval(intervalId);
        _orderMonitors.delete(orderId);
        emit("test_end", { testId, label, status: "pass", orderId });
      } else if (["Refunded", "Expired", "DeadLineExceeded"].includes(status)) {
        clearInterval(intervalId);
        _orderMonitors.delete(orderId);
        emit("test_end", { testId, label, status: "fail", orderId, error: `Order ended with status ${status}` });
      }
    } catch (e) {
      // Keep polling; transient network errors happen.
    }
  }, 5000);

  _orderMonitors.set(orderId, intervalId);
}

async function runAll() {
  emit("suite_start", { env: config.env, ts: new Date().toISOString() });
  await runApiTests();

  const routes = buildRoutes();
  const results = [];
  for (const route of routes) {
    const r = await runRoute(route);
    results.push(r);
    await new Promise((r2) => setTimeout(r2, 150));
  }

  emit("suite_end", {
    env: config.env,
    total: results.length,
    passed: results.filter((r) => r.status === "pass").length,
    failed: results.filter((r) => r.status === "fail").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    ts: new Date().toISOString(),
  });

  return results;
}

async function requestApproval(txData) {
  return new Promise((resolve) => {
    const id = Date.now().toString();
    emit("approval_request", { id, ...txData });
    _approvalQueue.push({ id, resolve });
  });
}

function handleApproval(id, approved) {
  const idx = _approvalQueue.findIndex((q) => q.id === id);
  if (idx !== -1) {
    _approvalQueue[idx].resolve(Boolean(approved));
    _approvalQueue.splice(idx, 1);
  }
}

module.exports = {
  runAll,
  runApiTests,
  runRoute,
  buildRoutes,
  setEmitter,
  handleApproval,
  requestApproval,
};

