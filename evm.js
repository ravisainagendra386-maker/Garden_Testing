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

function getProvider(chainKey) {
  const rpc = config.chains[chainKey]?.rpc;
  if (!rpc) throw new Error(`No RPC for chain: ${chainKey}`);
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

// Check on-chain tx receipt
async function getTxReceipt(txHash, chainKey) {
  const provider = getProvider(chainKey);
  return provider.getTransactionReceipt(txHash);
}

// Wait for tx confirmation
async function waitForConfirmation(txHash, chainKey, timeoutMs = 120000) {
  const provider = getProvider(chainKey);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt) return receipt;
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`Tx ${txHash} not confirmed within ${timeoutMs}ms`);
}

module.exports = { approveIfNeeded, initiateEvm, redeemEvm, getTxReceipt, waitForConfirmation };
