// src/htlc/evm.js
// Initiates and redeems EVM HTLC contracts.
// Called after Garden API returns the HTLC address and amount.
const { ethers } = require("ethers");
const config = require("../config");
const { sendEvmTransaction } = require("../wallet/privy");

// Minimal ERC20 ABI for approve
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

// Minimal HTLC ABI
const HTLC_ABI = [
  "function initiate(bytes32 secretHash, address receiver, uint256 expiry) payable",
  "function initiateWithToken(address token, uint256 amount, bytes32 secretHash, address receiver, uint256 expiry)",
  "function redeem(bytes32 secret)",
  "function refund(bytes32 secretHash)",
];

// Free public RPCs — used as fallback when config RPC env vars are not set.
// Arrays: first entry is primary, rest are failovers tried on RPC errors.
const EVM_FREE_RPCS = {
  'base':             ['https://sepolia.base.org'],
  'base_sepolia':     ['https://sepolia.base.org'],
  'ethereum':         ['https://rpc.sepolia.org', 'https://rpc2.sepolia.org', 'https://ethereum-sepolia-rpc.publicnode.com'],
  'ethereum_sepolia': ['https://rpc.sepolia.org', 'https://rpc2.sepolia.org', 'https://ethereum-sepolia-rpc.publicnode.com'],
  'arbitrum':         ['https://sepolia-rollup.arbitrum.io/rpc'],
  'arbitrum_sepolia': ['https://sepolia-rollup.arbitrum.io/rpc'],
  'bnbchain':         ['https://data-seed-prebsc-1-s1.binance.org:8545'],
  'bnbchain_testnet': ['https://data-seed-prebsc-1-s1.binance.org:8545'],
  'hyperevm':         ['https://rpc.hyperliquid-testnet.xyz/evm'],
  'hyperevm_testnet': ['https://rpc.hyperliquid-testnet.xyz/evm'],
  'monad':            ['https://testnet-rpc.monad.xyz'],
  'monad_testnet':    ['https://testnet-rpc.monad.xyz'],
  'citrea':           ['https://rpc.testnet.citrea.xyz'],
  'citrea_testnet':   ['https://rpc.testnet.citrea.xyz'],
  'alpen':            ['https://rpc.testnet.alpenlabs.io'],
  'alpen_testnet':    ['https://rpc.testnet.alpenlabs.io'],
};

// Returns an array of RPC URLs for a chain (primary first, then fallbacks).
function resolveRpcList(chainKey) {
  const rpcs = [];
  // 0. Numeric chain ID lookup
  const numId = parseInt(chainKey);
  if (!isNaN(numId)) {
    const byId = Object.values(config.chains).find(c => c.chainId === numId);
    if (byId?.rpc) rpcs.push(byId.rpc);
    const FREE_BY_ID = {
      84532:    ['https://sepolia.base.org'],
      8453:     ['https://mainnet.base.org'],
      11155111: ['https://rpc.sepolia.org', 'https://rpc2.sepolia.org', 'https://ethereum-sepolia-rpc.publicnode.com'],
      1:        ['https://eth.llamarpc.com'],
      421614:   ['https://sepolia-rollup.arbitrum.io/rpc'],
      42161:    ['https://arb1.arbitrum.io/rpc'],
      97:       ['https://data-seed-prebsc-1-s1.binance.org:8545'],
      56:       ['https://bsc-dataseed.binance.org'],
      998:      ['https://rpc.hyperliquid-testnet.xyz/evm'],
      41454:    ['https://testnet-rpc.monad.xyz'],
    };
    if (FREE_BY_ID[numId]) rpcs.push(...FREE_BY_ID[numId]);
  }
  // 1. Exact config match
  if (config.chains[chainKey]?.rpc) rpcs.push(config.chains[chainKey].rpc);
  // 2. Free fallback by exact key
  if (EVM_FREE_RPCS[chainKey]) rpcs.push(...EVM_FREE_RPCS[chainKey]);
  // 3. Strip testnet suffixes and retry
  const stripped = chainKey.replace(/_sepolia|_testnet\d*|_mainnet|_signet/g, '');
  if (config.chains[stripped]?.rpc) rpcs.push(config.chains[stripped].rpc);
  if (EVM_FREE_RPCS[stripped]) rpcs.push(...EVM_FREE_RPCS[stripped]);
  // 4. Partial match in config
  const partial = Object.entries(config.chains).find(([k]) =>
    k.startsWith(stripped) || stripped.startsWith(k)
  );
  if (partial?.[1]?.rpc) rpcs.push(partial[1].rpc);
  // Deduplicate while preserving order
  const unique = [...new Set(rpcs)];
  if (unique.length === 0) throw new Error(`No RPC for chain: ${chainKey}`);
  return unique;
}

// Backward-compatible: returns the primary RPC URL as a string.
function resolveRpc(chainKey) {
  return resolveRpcList(chainKey)[0];
}

function getProvider(chainKey) {
  const rpc = resolveRpc(chainKey);
  return new ethers.JsonRpcProvider(rpc);
}

// Approve token spend if needed (ERC20)
async function approveIfNeeded({ tokenAddress, spenderAddress, amount, chainKey, walletAddress }) {
  const provider = getProvider(chainKey);
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const allowance = await token.allowance(walletAddress, spenderAddress);
  if (allowance >= BigInt(amount)) return null; // already approved

  const iface = new ethers.Interface(ERC20_ABI);
  const data = iface.encodeFunctionData("approve", [spenderAddress, amount]);
  const chainId = config.chains[chainKey].chainId;
  return sendEvmTransaction({ to: tokenAddress, data, chainId });
}

// Initiate HTLC — called after order creation
async function initiateEvm({ htlcAddress, tokenAddress, amount, secretHash, receiverAddress, expiry, chainKey }) {
  const chainId = config.chains[chainKey].chainId;
  const iface = new ethers.Interface(HTLC_ABI);

  let data, value;
  if (tokenAddress === "native") {
    // Native ETH
    data = iface.encodeFunctionData("initiate", [secretHash, receiverAddress, expiry]);
    value = ethers.toBeHex(amount);
  } else {
    // ERC20 token — must approve first
    data = iface.encodeFunctionData("initiateWithToken", [tokenAddress, amount, secretHash, receiverAddress, expiry]);
    value = "0x0";
  }

  return sendEvmTransaction({ to: htlcAddress, data, value, chainId });
}

// Redeem HTLC with secret
async function redeemEvm({ htlcAddress, secret, chainKey }) {
  const chainId = config.chains[chainKey].chainId;
  const iface = new ethers.Interface(HTLC_ABI);
  const data = iface.encodeFunctionData("redeem", ["0x" + secret]);
  return sendEvmTransaction({ to: htlcAddress, data, chainId });
}

// Check on-chain tx receipt — tries fallback RPCs if primary fails.
async function getTxReceipt(txHash, chainKey) {
  const rpcs = resolveRpcList(chainKey);
  for (const rpc of rpcs) {
    try {
      const provider = new ethers.JsonRpcProvider(rpc);
      return await provider.getTransactionReceipt(txHash);
    } catch (_) { /* try next */ }
  }
  throw new Error(`getTxReceipt failed for ${txHash} — all ${rpcs.length} RPC(s) unreachable`);
}

// Wait for tx confirmation — rotates through fallback RPCs on errors.
async function waitForConfirmation(txHash, chainKey, timeoutMs = 120000) {
  const rpcs = resolveRpcList(chainKey);
  let rpcIdx = 0;
  let provider = new ethers.JsonRpcProvider(rpcs[0]);
  let consecutiveErrors = 0;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const receipt = await Promise.race([
        provider.getTransactionReceipt(txHash),
        new Promise((_, rej) => setTimeout(() => rej(new Error('rpc_timeout')), 10000)),
      ]);
      if (receipt) return receipt;
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      // After 2 consecutive failures on this RPC, try the next one
      if (consecutiveErrors >= 2 && rpcs.length > 1) {
        rpcIdx = (rpcIdx + 1) % rpcs.length;
        provider = new ethers.JsonRpcProvider(rpcs[rpcIdx]);
        consecutiveErrors = 0;
      }
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`Tx ${txHash} not confirmed within ${timeoutMs}ms (tried ${rpcs.length} RPC(s))`);
}

module.exports = { approveIfNeeded, initiateEvm, redeemEvm, getTxReceipt, waitForConfirmation, resolveRpcList };