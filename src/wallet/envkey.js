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
  alpen_testnet:     "https://rpc.testnet.alpenlabs.io",
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

// Free public RPCs as last-resort fallback (same list as server.js)
const FREE_RPCS_FALLBACK = {
  'base_sepolia':     'https://sepolia.base.org',
  'base':             'https://sepolia.base.org',
  'ethereum_sepolia': 'https://rpc.sepolia.org',
  'ethereum':         'https://rpc.sepolia.org',
  'arbitrum_sepolia': 'https://sepolia-rollup.arbitrum.io/rpc',
  'arbitrum':         'https://sepolia-rollup.arbitrum.io/rpc',
  'bnbchain_testnet': 'https://data-seed-prebsc-1-s1.binance.org:8545',
  'bnbchain':         'https://data-seed-prebsc-1-s1.binance.org:8545',
  'hyperevm_testnet': 'https://rpc.hyperliquid-testnet.xyz/evm',
  'hyperevm':         'https://rpc.hyperliquid-testnet.xyz/evm',
  'monad_testnet':    'https://testnet-rpc.monad.xyz',
  'monad':            'https://testnet-rpc.monad.xyz',
  'citrea_testnet':   'https://rpc.testnet.citrea.xyz',
  'citrea':           'https://rpc.testnet.citrea.xyz',
  'alpen_testnet':    'https://rpc.testnet.alpenlabs.io',
  'alpen':            'https://rpc.testnet.alpenlabs.io',
  // numeric chain IDs
  84532:    'https://sepolia.base.org',
  11155111: 'https://rpc.sepolia.org',
  421614:   'https://sepolia-rollup.arbitrum.io/rpc',
  97:       'https://data-seed-prebsc-1-s1.binance.org:8545',
  998:      'https://rpc.hyperliquid-testnet.xyz/evm',
  10143:    'https://testnet-rpc.monad.xyz',
  5115:     'https://rpc.testnet.citrea.xyz',
  48898:    'https://rpc.testnet.alpenlabs.io',
  8150:     'https://rpc.testnet.alpenlabs.io',  // Alpen testnet (Garden's internal chain_id)
};

function getRpcForChain(chainIdOrKey) {
  if (_rpcs[chainIdOrKey]) return _rpcs[chainIdOrKey];
  const chainId = parseInt(chainIdOrKey);
  if (!isNaN(chainId)) {
    const chain = Object.values(config.chains).find(c => c.chainId === chainId);
    if (chain?.rpc) return chain.rpc;
    // Free fallback by numeric id
    if (FREE_RPCS_FALLBACK[chainId]) return FREE_RPCS_FALLBACK[chainId];
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
  // Free fallback by string key
  if (FREE_RPCS_FALLBACK[strKey]) return FREE_RPCS_FALLBACK[strKey];
  const stripped = strKey.replace(/_sepolia|_testnet\d*|_mainnet/g, '');
  if (FREE_RPCS_FALLBACK[stripped]) return FREE_RPCS_FALLBACK[stripped];
  const byId = Object.values(config.chains).find(c => c.id === strKey);
  if (byId?.rpc) return byId.rpc;
  throw new Error(`No RPC found for chain: ${chainIdOrKey}`);
}

function getRpcCandidates(chainIdOrKey) {
  const candidates = [];
  try { candidates.push(getRpcForChain(chainIdOrKey)); } catch (_) {}

  const key = String(chainIdOrKey).toLowerCase();
  const num = parseInt(chainIdOrKey);
  if (!isNaN(num)) {
    if (num === 11155111) {
      candidates.push(
        "https://ethereum-sepolia-rpc.publicnode.com",
        "https://sepolia.gateway.tenderly.co",
        "https://rpc2.sepolia.org"
      );
    } else if (num === 84532) {
      candidates.push("https://sepolia.base.org");
    } else if (num === 421614) {
      candidates.push("https://sepolia-rollup.arbitrum.io/rpc");
    }
  } else if (key.includes("ethereum")) {
    candidates.push(
      "https://ethereum-sepolia-rpc.publicnode.com",
      "https://sepolia.gateway.tenderly.co",
      "https://rpc2.sepolia.org"
    );
  }

  const seen = new Set();
  return candidates.filter((u) => {
    if (!u || seen.has(u)) return false;
    seen.add(u);
    return true;
  });
}

// Track the last confirmed nonce per chainId to avoid "nonce already used" when
// sequential TXs fire faster than the RPC can update its pending nonce counter.
const _nonceByChain = new Map();

async function sendEvmTransaction({ to, data, value = "0x0", chainId, gasLimit }) {
  const rpcCandidates = getRpcCandidates(chainId);
  if (!rpcCandidates.length) throw new Error(`No RPC found for chain: ${chainId}`);

  let lastErr = null;
  for (const rpc of rpcCandidates) {
    try {
      const provider = new ethers.JsonRpcProvider(rpc);
      const wallet = new ethers.Wallet(getEvmPrivateKey(), provider);
      // Resolve nonce: use tracked nonce if higher than what the RPC reports
      const onChainNonce = await provider.getTransactionCount(wallet.address, "pending");
      const tracked = _nonceByChain.get(String(chainId)) ?? -1;
      const nonce = Math.max(onChainNonce, tracked + 1);

      const tx = {
        to, data: data || "0x", value: value || "0x0",
        gasLimit: gasLimit ? BigInt(gasLimit) : BigInt(500000),
        nonce,
      };

      console.log(`[envkey/evm] sendTx chain=${chainId} rpc=${rpc} to=${to} nonce=${nonce}`);
      const sent = await wallet.sendTransaction(tx);
      console.log(`[envkey/evm] broadcast: ${sent.hash}`);
      _nonceByChain.set(String(chainId), nonce);
      await sent.wait(1);
      return sent.hash;
    } catch (e) {
      lastErr = e;
      console.warn(`[envkey/evm] RPC failed chain=${chainId} rpc=${rpc}: ${e.message}`);
    }
  }
  throw lastErr || new Error(`All RPC candidates failed for chain ${chainId}`);
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