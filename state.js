// src/wallet/state.js
// Single source of truth for all connected wallet addresses.
// Used by both server.js (to store) and runner.js (to read).
// Nothing is ever written to disk.

const store = {
  // Which source is active: 'metamask' | 'privy' | null
  evmSource: null,

  // Addresses
  evm:      null, // { address, source: 'metamask'|'privy' }
  btc:      null, // { address, wif, balance }
  solana:   null, // { address, balance, source: 'phantom'|'privy' }
  starknet: null, // { address }
  sui:      null, // { address }
  tron:     null, // { address }

  // Privy credentials (for signing transactions server-side)
  privy: null,    // { appId, appSecret, evmWalletId, solanaWalletId }
};

// ── GETTERS ───────────────────────────────────────────────────

function getEvmAddress() {
  return store.evm?.address || null;
}

function getBtcAddress() {
  return store.btc?.address || null;
}

function getBtcWif() {
  return store.btc?.wif || null;
}

function getSolanaAddress() {
  return store.solana?.address || null;
}

function getStarknetAddress() {
  return store.starknet?.address || null;
}

function getSuiAddress() {
  return store.sui?.address || null;
}

function getTronAddress() {
  return store.tron?.address || null;
}

function getPrivy() {
  return store.privy || null;
}

// Get address by chain type — used by runner.js
function getAddressByType(type) {
  switch (type) {
    case 'evm':      return getEvmAddress();
    case 'bitcoin':  return getBtcAddress();
    case 'solana':   return getSolanaAddress();
    case 'starknet': return getStarknetAddress();
    case 'sui':      return getSuiAddress();
    case 'tron':     return getTronAddress();
    default: return null;
  }
}

// ── SETTERS ───────────────────────────────────────────────────

// Connect MetaMask — blocks if Privy EVM already connected
function connectMetaMask(address) {
  if (store.evmSource === 'privy') {
    throw new Error('Privy is already connected as EVM wallet. Disconnect Privy first.');
  }
  store.evm = { address, source: 'metamask' };
  store.evmSource = 'metamask';
}

// Connect Privy — blocks if MetaMask already connected
function connectPrivy({ appId, appSecret, evmWalletId, solanaWalletId }) {
  if (store.evmSource === 'metamask') {
    throw new Error('MetaMask is already connected as EVM wallet. Disconnect MetaMask first.');
  }
  const evmAddress = `privy:${evmWalletId}`;
  const solanaAddress = solanaWalletId ? `privy:${solanaWalletId}` : null;
  store.privy = { appId, appSecret, evmWalletId, solanaWalletId };
  store.evm = { address: evmAddress, source: 'privy' };
  store.evmSource = 'privy';
  if (solanaAddress && !store.solana) {
    store.solana = { address: solanaAddress, source: 'privy' };
  }
  return { evmAddress, solanaAddress };
}

function connectBtc(address, wif, balance) {
  store.btc = { address, wif: wif || null, balance: balance || 'unknown' };
}

// Connect Phantom — blocks if Privy Solana already connected
function connectSolana(address, balance) {
  if (store.solana?.source === 'privy') {
    throw new Error('Privy is already connected as Solana wallet. Disconnect Privy first.');
  }
  store.solana = { address, balance: balance || null, source: 'phantom' };
}

function connectStarknet(address) { store.starknet = { address }; }
function connectSui(address)      { store.sui      = { address }; }
function connectTron(address)     { store.tron     = { address }; }

// Disconnect by type
function disconnect(type) {
  if (type === 'evm' || type === 'metamask') {
    store.evm = null;
    store.evmSource = null;
  }
  if (type === 'privy') {
    // If Privy was EVM source, clear EVM too
    if (store.evmSource === 'privy') {
      store.evm = null;
      store.evmSource = null;
    }
    // If Privy was Solana source, clear Solana too
    if (store.solana?.source === 'privy') {
      store.solana = null;
    }
    store.privy = null;
  }
  if (type === 'btc')      store.btc      = null;
  if (type === 'solana')   store.solana   = null;
  if (type === 'starknet') store.starknet = null;
  if (type === 'sui')      store.sui      = null;
  if (type === 'tron')     store.tron     = null;
}

// ── STATUS SUMMARY ────────────────────────────────────────────
function getStatus() {
  return {
    evm:      store.evm      ? { address: store.evm.address,      source: store.evm.source }      : null,
    btc:      store.btc      ? { address: store.btc.address,      balance: store.btc.balance }     : null,
    solana:   store.solana   ? { address: store.solana.address,   balance: store.solana.balance,  source: store.solana.source } : null,
    starknet: store.starknet ? { address: store.starknet.address }                                 : null,
    sui:      store.sui      ? { address: store.sui.address }                                      : null,
    tron:     store.tron     ? { address: store.tron.address }                                     : null,
    privy:    store.privy    ? { connected: true, evmAddress: store.evm?.address, solanaAddress: store.solana?.address } : { connected: false },
    evmSource: store.evmSource,
  };
}

module.exports = {
  getEvmAddress, getBtcAddress, getBtcWif,
  getSolanaAddress, getStarknetAddress, getSuiAddress, getTronAddress,
  getAddressByType, getPrivy, getStatus,
  connectMetaMask, connectPrivy, connectBtc,
  connectSolana, connectStarknet, connectSui, connectTron,
  disconnect,
};
