// src/wallet/state.js
// Single source of truth for wallet addresses.
// Priority per type:  envkey (lowest) < privy < wallet-extension (highest)

const store = {
  evmSource:      null,  // 'metamask' | 'privy' | 'envkey' | null
  solanaSource:   null,  // 'phantom'  | 'privy' | 'envkey' | null
  btcSource:      null,  // 'manual'   | 'envkey' | null
  starknetSource: null,  // 'argent'   | 'envkey' | null
  suiSource:      null,  // 'sui'      | 'envkey' | null
  tronSource:     null,  // 'tronlink' | 'envkey' | null

  evm:      null,   // { address, source, tokenBalances }
  btc:      null,   // { address, wif, balance, source }
  solana:   null,   // { address, balance, source }
  starknet: null,   // { address, source }
  sui:      null,   // { address, source }
  tron:     null,   // { address, source }
  privy:    null,   // { appId, appSecret, evmWalletId, solanaWalletId }
};

// ── GETTERS ───────────────────────────────────────────────────
const getEvmAddress      = () => store.evm?.address      || null;
const getBtcAddress      = () => store.btc?.address      || null;
const getBtcWif          = () => store.btc?.wif          || null;
const getSolanaAddress   = () => store.solana?.address   || null;
const getStarknetAddress = () => store.starknet?.address || null;
const getSuiAddress      = () => store.sui?.address      || null;
const getTronAddress     = () => store.tron?.address     || null;
const getPrivyCreds      = () => store.privy             || null;

function getAddressByType(type) {
  switch ((type || "").toLowerCase()) {
    case "evm":      return getEvmAddress();
    case "bitcoin":  return getBtcAddress();
    case "solana":   return getSolanaAddress();
    case "starknet": return getStarknetAddress();
    case "sui":      return getSuiAddress();
    case "tron":     return getTronAddress();
    default:         return null;
  }
}

// ── HELPERS ───────────────────────────────────────────────────
// Returns true if incoming source can override current source
// Priority: extension > privy > envkey
const PRIORITY = { envkey: 0, privy: 1, phantom: 2, manual: 2, argent: 2, sui: 2, tronlink: 2, metamask: 2 };
function canOverride(incoming, current) {
  if (!current) return true;
  if (current === incoming) return true;
  return (PRIORITY[incoming] ?? 1) >= (PRIORITY[current] ?? 1);
}

// ── EVM ───────────────────────────────────────────────────────
function connectMetaMask(address) {
  if (store.evmSource && store.evmSource !== "metamask")
    console.log(`[wallet] MetaMask overriding EVM source: ${store.evmSource}`);
  store.evm = { address, source: "metamask", tokenBalances: store.evm?.tokenBalances || {} };
  store.evmSource = "metamask";
}

function connectPrivy({ appId, appSecret, evmWalletId, solanaWalletId }) {
  if (store.evmSource === "metamask")
    throw new Error("MetaMask is already connected. Disconnect MetaMask first.");
  if (store.evmSource === "envkey")
    console.log("[wallet] Privy overriding envkey EVM source");
  store.privy = { appId, appSecret, evmWalletId, solanaWalletId };
  store.evm   = { address: evmWalletId, source: "privy", tokenBalances: store.evm?.tokenBalances || {} };
  store.evmSource = "privy";
  if (solanaWalletId && store.solanaSource !== "phantom") {
    store.solana = { address: solanaWalletId, source: "privy" };
    store.solanaSource = "privy";
  }
  return { evmAddress: evmWalletId, solanaAddress: solanaWalletId || null };
}

function connectEnvKeyEvm(address) {
  if (!canOverride("envkey", store.evmSource)) {
    console.log(`[wallet] envkey EVM ignored — ${store.evmSource} already connected`);
    return false;
  }
  store.evm = { address, source: "envkey", tokenBalances: store.evm?.tokenBalances || {} };
  store.evmSource = "envkey";
  console.log(`[wallet] envkey EVM: ${address}`);
  return true;
}
// legacy alias
const connectEnvKey = connectEnvKeyEvm;

// ── BITCOIN ───────────────────────────────────────────────────
function connectBtc(address, wif, balance, source) {
  const src = source || (wif ? "manual" : "manual");
  if (!canOverride(src, store.btcSource)) {
    console.log(`[wallet] BTC ${src} ignored — ${store.btcSource} already connected`);
    return false;
  }
  store.btc = { address, wif: wif || null, balance: balance || "unknown", pendingSats: 0, source: src };
  store.btcSource = src;
  console.log(`[wallet] BTC [${src}]: ${address}`);
  return true;
}

function connectEnvKeyBtc(address, wif) {
  if (!canOverride("envkey", store.btcSource)) {
    console.log(`[wallet] envkey BTC ignored — ${store.btcSource} already connected`);
    return false;
  }
  store.btc = { address, wif, balance: "unknown", source: "envkey" };
  store.btcSource = "envkey";
  console.log(`[wallet] envkey BTC: ${address}`);
  return true;
}

// ── SOLANA ────────────────────────────────────────────────────
function connectSolana(address, balance, source) {
  const src = source || "phantom";
  if (!canOverride(src, store.solanaSource)) {
    console.log(`[wallet] Solana ${src} ignored — ${store.solanaSource} already connected`);
    return false;
  }
  store.solana = { address, balance: balance || null, source: src };
  store.solanaSource = src;
  return true;
}

function connectEnvKeySolana(address) {
  if (!canOverride("envkey", store.solanaSource)) {
    console.log(`[wallet] envkey Solana ignored — ${store.solanaSource} already connected`);
    return false;
  }
  store.solana = { address, balance: null, source: "envkey" };
  store.solanaSource = "envkey";
  console.log(`[wallet] envkey Solana: ${address}`);
  return true;
}

// ── STARKNET ──────────────────────────────────────────────────
function connectStarknet(address, source) {
  const src = source || "argent";
  store.starknet = { address, source: src };
  store.starknetSource = src;
}

function connectEnvKeyStarknet(address) {
  if (!canOverride("envkey", store.starknetSource)) return false;
  store.starknet = { address, source: "envkey" };
  store.starknetSource = "envkey";
  console.log(`[wallet] envkey Starknet: ${address}`);
  return true;
}

// ── SUI ───────────────────────────────────────────────────────
function connectSui(address, source) {
  const src = source || "sui";
  store.sui = { address, source: src };
  store.suiSource = src;
}

function connectEnvKeySui(address) {
  if (!canOverride("envkey", store.suiSource)) return false;
  store.sui = { address, source: "envkey" };
  store.suiSource = "envkey";
  console.log(`[wallet] envkey Sui: ${address}`);
  return true;
}

// ── TRON ──────────────────────────────────────────────────────
function connectTron(address, source) {
  const src = source || "tronlink";
  store.tron = { address, source: src };
  store.tronSource = src;
}

function connectEnvKeyTron(address) {
  if (!canOverride("envkey", store.tronSource)) return false;
  store.tron = { address, source: "envkey" };
  store.tronSource = "envkey";
  console.log(`[wallet] envkey Tron: ${address}`);
  return true;
}

// ── EVM BALANCES ──────────────────────────────────────────────
function setEvmBalances(address, balances) {
  if (store.evm?.address === address) store.evm.tokenBalances = balances;
}

// ── DISCONNECT ────────────────────────────────────────────────
function disconnect(type) {
  switch (type) {
    case "evm": case "metamask": case "envkey":
      store.evm = null; store.evmSource = null; break;
    case "privy":
      if (store.evmSource === "privy")       { store.evm = null; store.evmSource = null; }
      if (store.solanaSource === "privy")    { store.solana = null; store.solanaSource = null; }
      store.privy = null; break;
    case "btc":      store.btc = null;      store.btcSource = null;      break;
    case "solana":   store.solana = null;   store.solanaSource = null;   break;
    case "starknet": store.starknet = null; store.starknetSource = null; break;
    case "sui":      store.sui = null;      store.suiSource = null;      break;
    case "tron":     store.tron = null;     store.tronSource = null;     break;
  }
}

// ── STATUS ────────────────────────────────────────────────────
function getStatus() {
  return {
    evmSource:      store.evmSource,
    solanaSource:   store.solanaSource,
    btcSource:      store.btcSource,
    starknetSource: store.starknetSource,
    suiSource:      store.suiSource,
    tronSource:     store.tronSource,
    evm:      store.evm      ? { address: store.evm.address,      source: store.evm.source,      tokenBalances: store.evm.tokenBalances || {} } : null,
    btc:      store.btc      ? { address: store.btc.address,      source: store.btc.source,      balance: store.btc.balance, pendingSats: store.btc.pendingSats || 0 }                   : null,
    solana:   store.solana   ? { address: store.solana.address,   source: store.solana.source,   balance: store.solana.balance }                : null,
    starknet: store.starknet ? { address: store.starknet.address, source: store.starknet.source }                                               : null,
    sui:      store.sui      ? { address: store.sui.address,      source: store.sui.source }                                                    : null,
    tron:     store.tron     ? { address: store.tron.address,     source: store.tron.source }                                                   : null,
    privy:    store.privy    ? { connected: true, evmAddress: store.evm?.address, solanaAddress: store.solana?.address } : { connected: false },
  };
}

module.exports = {
  // getters
  getEvmAddress, getBtcAddress, getBtcWif,
  getSolanaAddress, getStarknetAddress, getSuiAddress, getTronAddress,
  getAddressByType, getPrivyCreds, getStatus,
  // connect — extension/manual (highest priority)
  connectMetaMask, connectPrivy, connectBtc, connectSolana,
  connectStarknet, connectSui, connectTron,
  // connect — envkey (lowest priority)
  connectEnvKey, connectEnvKeyEvm, connectEnvKeyBtc, connectEnvKeySolana,
  connectEnvKeyStarknet, connectEnvKeySui, connectEnvKeyTron,
  // misc
  disconnect, setEvmBalances,
  setBtcPending: (sats) => { if (store.btc) store.btc.pendingSats = sats; },
};