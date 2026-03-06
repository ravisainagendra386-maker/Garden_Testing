// src/wallet/state.js
// Single source of truth for wallet addresses.
// Both server.js (writes) and runner.js (reads) use this module.
// Nothing is ever written to disk.

const store = {
  evmSource: null,  // 'metamask' | 'privy' | null
  evm:      null,   // { address, source, tokenBalances }
  btc:      null,   // { address, wif, balance }
  solana:   null,   // { address, balance, source }
  starknet: null,   // { address }
  sui:      null,   // { address }
  tron:     null,   // { address }
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

// ── SETTERS ───────────────────────────────────────────────────

function connectMetaMask(address) {
  if (store.evmSource === "privy")
    throw new Error("Privy is already connected as EVM wallet. Disconnect Privy first.");
  store.evm = { address, source: "metamask" };
  store.evmSource = "metamask";
}

function connectPrivy({ appId, appSecret, evmWalletId, solanaWalletId }) {
  if (store.evmSource === "metamask")
    throw new Error("MetaMask is already connected as EVM wallet. Disconnect MetaMask first.");
  store.privy = { appId, appSecret, evmWalletId, solanaWalletId };
  store.evm   = { address: evmWalletId, source: "privy" };
  store.evmSource = "privy";
  if (solanaWalletId && !store.solana)
    store.solana = { address: solanaWalletId, source: "privy" };
  return {
    evmAddress:    evmWalletId,
    solanaAddress: solanaWalletId || null,
  };
}

function connectBtc(address, wif, balance) {
  store.btc = { address, wif: wif || null, balance: balance || "unknown" };
}

function connectSolana(address, balance) {
  if (store.solana?.source === "privy")
    throw new Error("Privy Solana wallet already connected. Disconnect Privy first.");
  store.solana = { address, balance: balance || null, source: "phantom" };
}

function connectStarknet(address) { store.starknet = { address }; }
function connectSui(address)      { store.sui      = { address }; }
function connectTron(address)     { store.tron     = { address }; }

// Store EVM token balances fetched from public RPCs
// balances = { "arbitrum_sepolia": 12345678 (wei), ... }
function setEvmBalances(address, balances) {
  if (store.evm?.address === address) {
    store.evm.tokenBalances = balances;
  }
}

function disconnect(type) {
  if (type === "evm" || type === "metamask") {
    store.evm = null; store.evmSource = null;
  } else if (type === "privy") {
    if (store.evmSource === "privy") { store.evm = null; store.evmSource = null; }
    if (store.solana?.source === "privy") store.solana = null;
    store.privy = null;
  } else if (type === "btc")      { store.btc      = null; }
  else if (type === "solana")     { store.solana   = null; }
  else if (type === "starknet")   { store.starknet = null; }
  else if (type === "sui")        { store.sui      = null; }
  else if (type === "tron")       { store.tron     = null; }
}

// ── STATUS ────────────────────────────────────────────────────
function getStatus() {
  return {
    evmSource: store.evmSource,
    evm:      store.evm      ? { address: store.evm.address, source: store.evm.source, tokenBalances: store.evm.tokenBalances || {} } : null,
    btc:      store.btc      ? { address: store.btc.address,      balance: store.btc.balance }                     : null,
    solana:   store.solana   ? { address: store.solana.address,   balance: store.solana.balance, source: store.solana.source } : null,
    starknet: store.starknet ? { address: store.starknet.address }                                                 : null,
    sui:      store.sui      ? { address: store.sui.address }                                                      : null,
    tron:     store.tron     ? { address: store.tron.address }                                                     : null,
    privy:    store.privy    ? { connected: true,  evmAddress: store.evm?.address, solanaAddress: store.solana?.address } : { connected: false },
  };
}

module.exports = {
  getEvmAddress, getBtcAddress, getBtcWif,
  getSolanaAddress, getStarknetAddress, getSuiAddress, getTronAddress,
  getAddressByType, getPrivyCreds, getStatus,
  connectMetaMask, connectPrivy, connectBtc,
  connectSolana, connectStarknet, connectSui, connectTron,
  disconnect, setEvmBalances,
};