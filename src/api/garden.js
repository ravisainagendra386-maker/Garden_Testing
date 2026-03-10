// src/api/garden.js
const axios = require("axios");
const config = require("../config");

const client = axios.create({
  baseURL: config.garden.baseUrl,
  headers: { "garden-app-id": config.garden.apiKey, "Content-Type": "application/json" },
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
  health:           ()            => client.get("/health").then(r => r.data),
  getChains:        ()            => client.get("/chains").then(r => r.data),
  getAssets:        ()            => client.get("/assets").then(r => r.data),
  getPolicy:        (from, to)    => client.get("/policy", { params: { from, to } }).then(r => r.data),
  getLiquidity:     (from, to)    => client.get("/liquidity", { params: { from, to } }).then(r => r.data),
  getQuote:         (from, to, amt) => client.get("/quote", { params: { from, to, from_amount: amt } }).then(r => r.data),
  getOrder:         (id)          => client.get(`/orders/${id}`).then(r => r.data),
  getOrders:        (f = {})      => client.get("/orders", { params: f }).then(r => r.data),
  createOrder:      (body)        => client.post("/orders", body).then(r => r.data),
  // txPayload:
  // - string: tx_hash for initiate()
  // - { signature }: gasless EIP-712 initiate
  // - { secret }: redeem() action
  patchOrder: (id, action, txPayload) => {
    const body = { action };
    if (txPayload) {
      if (typeof txPayload === 'object' && txPayload.signature) {
        body.signature = txPayload.signature;   // gasless path
      } else if (typeof txPayload === 'object' && txPayload.secret) {
        body.secret = txPayload.secret;         // redeem path
      } else if (typeof txPayload === 'string') {
        body.tx_hash = txPayload;               // regular initiate path
      }
    }
    return client.patch(`/orders/${id}`, body).then(r => r.data);
  },
  getRefundHash:    (id)          => client.get(`/orders/${id}/instant-refund-hash`).then(r => r.data),
  getVolume:        ()            => client.get("/volume").then(r => r.data),
  getFees:          ()            => client.get("/fees").then(r => r.data),

  // Poll order until status matches target or timeout
  // Poll until order reaches targetStatus (substring match, case-insensitive)
  // onProgress(status, order) called on every poll tick so caller can update UI
  async pollOrder(orderId, targetStatus, timeoutMs = 600000, intervalMs = 5000, onProgress) {
    // Garden's real lifecycle statuses (in order):
    // Matched → InitiateDetected → Initiated → CounterPartyInitiateDetected
    //   → CounterPartyInitiated → Redeemed/Completed/Expired/Refunded
    const TERMINAL_FAIL = ["refunded", "expired", "failed", "cancelled"];
    const start = Date.now();
    let lastStatus = "";
    while (Date.now() - start < timeoutMs) {
      let res;
      try { res = await garden.getOrder(orderId); }
      catch(e) { await new Promise(r => setTimeout(r, intervalMs)); continue; }

      const order  = res.result || res;
      const status = (order?.status || order?.order_status || "").toLowerCase().replace(/\s+/g, "");

      if (status && status !== lastStatus) {
        lastStatus = status;
        if (onProgress) onProgress(status, order);
      }

      // Success condition
      if (status.includes(targetStatus.toLowerCase().replace(/\s+/g, "")))
        return { success: true, order, status, elapsed: Date.now() - start };

      // Failure terminals
      if (TERMINAL_FAIL.some(t => status.includes(t)))
        return { success: false, order, status, elapsed: Date.now() - start, reason: status };

      await new Promise(r => setTimeout(r, intervalMs));
    }
    return { success: false, order: null, status: lastStatus, elapsed: timeoutMs, reason: "timeout" };
  },
};

module.exports = garden;