// src/wallet/envkey.js
// Backend signers for ALL chain types using .env private keys.
// Priority: envkey (lowest) < privy < wallet extension (highest)
const { ethers } = require("ethers");
const config     = require("../config");

// ── EVM ───────────────────────────────────────────────────────
const _rpcs = {
  ethereum_sepolia:  "https://rpc.sepolia.org",
  arbitrum_sepolia:  "https://sepolia-rollup.arbitrum.io/rpc",
  base_sepolia:      "https://sepolia.base.org",
  bnbchain_testnet:  "https://data-seed-prebsc-1-s1.binance.org:8545",
  hyperevm_testnet:  "https://rpc.hyperliquid-testnet.xyz/evm",
  monad_testnet:     "https://testnet-rpc.monad.xyz",
  citrea_testnet:    "https://rpc.testnet.citrea.xyz",
  alpen_testnet:     "https://rpc.testnet.alpen.xyz",
};
function setRpc(chain, url) { _rpcs[chain] = url; }

// ── availability ──────────────────────────────────────────────
const isEvmAvailable      = () => !!config.envKeys.evm;
const isBtcAvailable      = () => !!config.envKeys.btc;
const isSolanaAvailable   = () => !!config.envKeys.solana;
const isStarknetAvailable = () => !!config.envKeys.starknet;
const isSuiAvailable      = () => !!config.envKeys.sui;
const isTronAvailable     = () => !!config.envKeys.tron;
const isAvailable         = isEvmAvailable; // legacy alias

function isAvailableFor(type) {
  switch ((type || "").toLowerCase()) {
    case "evm":      return isEvmAvailable();
    case "bitcoin":  return isBtcAvailable();
    case "solana":   return isSolanaAvailable();
    case "starknet": return isStarknetAvailable();
    case "sui":      return isSuiAvailable();
    case "tron":     return isTronAvailable();
    default:         return false;
  }
}

// ── EVM ───────────────────────────────────────────────────────
function getEvmPrivateKey() {
  const key = config.envKeys.evm;
  if (!key) throw new Error("EVM_PRIVATE_KEY not set in .env");
  return key.startsWith("0x") ? key : "0x" + key;
}

function getEvmAddress() {
  try { return new ethers.Wallet(getEvmPrivateKey()).address; }
  catch (e) { throw new Error(`Invalid EVM_PRIVATE_KEY: ${e.message}`); }
}

// legacy alias
const getAddress = getEvmAddress;

function getRpcForChain(chainIdOrKey) {
  if (_rpcs[chainIdOrKey]) return _rpcs[chainIdOrKey];
  const chainId = parseInt(chainIdOrKey);
  if (!isNaN(chainId)) {
    const chain = Object.values(config.chains).find(c => c.chainId === chainId);
    if (chain?.rpc) return chain.rpc;
    for (const [key] of Object.entries(_rpcs)) {
      const cfgChain = Object.values(config.chains).find(c =>
        c.id && key.startsWith(c.id) && c.chainId === chainId
      );
      if (cfgChain) return _rpcs[key];
    }
  }
  const strKey = String(chainIdOrKey).toLowerCase();
  for (const [key, url] of Object.entries(_rpcs)) {
    if (key.startsWith(strKey) || strKey.startsWith(key.split("_")[0])) return url;
  }
  const byId = Object.values(config.chains).find(c => c.id === strKey);
  if (byId?.rpc) return byId.rpc;
  throw new Error(`No RPC found for chain: ${chainIdOrKey}`);
}

async function sendEvmTransaction({ to, data, value = "0x0", chainId, gasLimit }) {
  const rpc      = getRpcForChain(chainId);
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet   = new ethers.Wallet(getEvmPrivateKey(), provider);
  const tx = {
    to, data: data || "0x", value: value || "0x0",
    gasLimit: gasLimit ? BigInt(gasLimit) : BigInt(500000),
  };
  console.log(`[envkey/evm] sendTx chain=${chainId} to=${to}`);
  const sent = await wallet.sendTransaction(tx);
  console.log(`[envkey/evm] broadcast: ${sent.hash}`);
  await sent.wait(1);
  return sent.hash;
}

// legacy alias
const sendTransaction = sendEvmTransaction;

async function signEvmTypedData(domain, types, value) {
  const wallet = new ethers.Wallet(getEvmPrivateKey());
  return wallet.signTypedData(domain, types, value);
}

// ── BITCOIN ───────────────────────────────────────────────────
function getBtcWif()     { return config.envKeys.btc || null; }
function getBtcAddress() {
  // Derive address from WIF using bitcoinjs or just return the configured address
  // Config may have OVERRIDE_BTC_ADDRESS set alongside the WIF
  const addr = config.btc?.address;
  if (addr) return addr;
  // If no address configured, WIF key must be paired with address via dashboard
  return null;
}

// ── SOLANA ────────────────────────────────────────────────────
function getSolanaPrivateKey() { return config.envKeys.solana || null; }
function getSolanaAddress() {
  const key = getSolanaPrivateKey();
  if (!key) return null;
  try {
    // Try to derive pubkey from base58 secret key using @solana/web3.js if available
    const { Keypair } = require("@solana/web3.js");
    const bs58 = require("bs58");
    let secretKey;
    // base58 encoded full 64-byte keypair
    try { secretKey = bs58.decode(key); } catch(_) {
      // Maybe it's a JSON array
      secretKey = Uint8Array.from(JSON.parse(key));
    }
    const kp = Keypair.fromSecretKey(secretKey);
    return kp.publicKey.toBase58();
  } catch(e) {
    console.warn(`[envkey/solana] Could not derive address: ${e.message}`);
    return null;
  }
}

async function sendSolanaTransaction(serializedTx) {
  // Requires @solana/web3.js — sign and send
  const { Connection, Transaction, Keypair } = require("@solana/web3.js");
  const bs58 = require("bs58");
  const key  = getSolanaPrivateKey();
  if (!key) throw new Error("SOLANA_PRIVATE_KEY not set in .env");

  let secretKey;
  try { secretKey = bs58.decode(key); }
  catch(_) { secretKey = Uint8Array.from(JSON.parse(key)); }

  const keypair   = Keypair.fromSecretKey(secretKey);
  const rpcUrl    = config.chains.solana?.rpc || "https://api.testnet.solana.com";
  const conn      = new Connection(rpcUrl, "confirmed");
  const txBuf     = Buffer.from(serializedTx, "base64");
  const tx        = Transaction.from(txBuf);
  tx.partialSign(keypair);
  const sig = await conn.sendRawTransaction(tx.serialize());
  console.log(`[envkey/solana] broadcast: ${sig}`);
  return sig;
}

// ── STARKNET ──────────────────────────────────────────────────
function getStarknetAddress() {
  // Starknet address must be set separately — private key alone doesn't give address without deployed contract
  return process.env.STARKNET_ADDRESS || null;
}

// ── SUI ───────────────────────────────────────────────────────
function getSuiAddress() {
  const key = config.envKeys.sui;
  if (!key) return null;
  try {
    const { Ed25519Keypair } = require("@mysten/sui.js/keypairs/ed25519");
    const kp = Ed25519Keypair.fromSecretKey(Buffer.from(key, "base64"));
    return kp.getPublicKey().toSuiAddress();
  } catch(e) {
    console.warn(`[envkey/sui] Could not derive address: ${e.message}`);
    return null;
  }
}

// ── TRON ──────────────────────────────────────────────────────
function getTronAddress() {
  const key = config.envKeys.tron;
  if (!key) return null;
  try {
    const TronWeb = require("tronweb");
    return TronWeb.address.fromPrivateKey(key.startsWith("0x") ? key.slice(2) : key);
  } catch(e) {
    console.warn(`[envkey/tron] Could not derive address: ${e.message}`);
    return null;
  }
}

// ── UNIFIED ADDRESS GETTER ────────────────────────────────────
function getAddressFor(type) {
  switch ((type || "").toLowerCase()) {
    case "evm":      return isEvmAvailable()      ? getEvmAddress()      : null;
    case "bitcoin":  return isBtcAvailable()       ? getBtcAddress()      : null;
    case "solana":   return isSolanaAvailable()    ? getSolanaAddress()   : null;
    case "starknet": return isStarknetAvailable()  ? getStarknetAddress() : null;
    case "sui":      return isSuiAvailable()       ? getSuiAddress()      : null;
    case "tron":     return isTronAvailable()      ? getTronAddress()     : null;
    default:         return null;
  }
}

module.exports = {
  // availability
  isAvailable, isAvailableFor,
  isEvmAvailable, isBtcAvailable, isSolanaAvailable,
  isStarknetAvailable, isSuiAvailable, isTronAvailable,
  // address getters
  getAddress, getEvmAddress, getBtcAddress, getSolanaAddress,
  getStarknetAddress, getSuiAddress, getTronAddress, getAddressFor,
  // key getters
  getBtcWif, getSolanaPrivateKey,
  // tx senders
  sendTransaction, sendEvmTransaction, sendSolanaTransaction,
  signEvmTypedData,
  // rpc
  setRpc, getRpcForChain,
};