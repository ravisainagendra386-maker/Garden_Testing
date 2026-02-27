const axios = require("axios");
const config = require("../config");

const client = axios.create({
  baseURL: config.garden.baseUrl,
  headers: {
    "garden-app-id": config.garden.apiKey || "",
    "Content-Type": "application/json",
  },
  timeout: 15000,
});

client.interceptors.response.use(
  (r) => r,
  (err) => {
    const msg = err.response?.data?.error || err.message || "Garden API error";
    const e = new Error(`[Garden ${err.response?.status || 0}] ${msg}`);
    e.status = err.response?.status;
    e.raw = err.response?.data;
    throw e;
  }
);

const garden = {
  health: () => client.get("/health").then((r) => r.data),
  getChains: () => client.get("/chains").then((r) => r.data),
  getAssets: () => client.get("/assets").then((r) => r.data),
  getPolicy: (from, to) =>
    client.get("/policy", { params: { from, to } }).then((r) => r.data),
  getLiquidity: (from, to) =>
    client.get("/liquidity", { params: { from, to } }).then((r) => r.data),
  getQuote: (from, to, amt) =>
    client
      .get("/quote", { params: { from, to, from_amount: amt } })
      .then((r) => r.data),
  getOrder: (id) => client.get(`/orders/${id}`).then((r) => r.data),
  getOrders: (f = {}) => client.get("/orders", { params: f }).then((r) => r.data),
  createOrder: (body) => client.post("/orders", body).then((r) => r.data),
  getRefundHash: (id) =>
    client.get(`/orders/${id}/instant-refund-hash`).then((r) => r.data),
  getVolume: () => client.get("/volume").then((r) => r.data),
  getFees: () => client.get("/fees").then((r) => r.data),

  async pollOrder(orderId, predicate, timeoutMs = 600000, intervalMs = 5000) {
    const start = Date.now();
    const pred =
      typeof predicate === "function"
        ? predicate
        : (status) => String(status).toLowerCase().includes(String(predicate).toLowerCase());

    while (Date.now() - start < timeoutMs) {
      const res = await garden.getOrder(orderId);
      const status = String(res.result?.status || "").toLowerCase();
      if (pred(status, res.result))
        return { success: true, order: res.result, elapsed: Date.now() - start };
      if (status.includes("refund") || status.includes("fail") || status.includes("expired"))
        return { success: false, order: res.result, elapsed: Date.now() - start, reason: status };
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return { success: false, order: null, elapsed: timeoutMs, reason: "timeout" };
  },
};

module.exports = garden;

