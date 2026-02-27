// src/wallet/privy.js
// Privy Node SDK wrapper for all non-BTC chains.
const { PrivyClient } = require("@privy-io/node");
const config = require("../config");

let _privy = null;
function getPrivy() {
  if (!_privy) _privy = new PrivyClient(config.privy.appId, config.privy.appSecret);
  return _privy;
}

// Get address for a wallet type, respecting overrides
async function getAddress(type) {
  if (config.overrides[type]) return config.overrides[type];
  const privy = getPrivy();
  const walletId = config.privy.wallets[type];
  if (!walletId) throw new Error(`No Privy wallet configured for type: ${type}`);

  if (type === "evm") {
    const w = await privy.walletApi.getWallet({ id: walletId });
    return w.address;
  }
  if (type === "solana") {
    const w = await privy.walletApi.getWallet({ id: walletId });
    return w.address;
  }
  if (type === "sui") {
    const w = await privy.walletApi.getWallet({ id: walletId });
    return w.address;
  }
  if (type === "starknet") {
    const w = await privy.walletApi.getWallet({ id: walletId });
    return w.address;
  }
  if (type === "tron") {
    const w = await privy.walletApi.getWallet({ id: walletId });
    return w.address;
  }
  throw new Error(`Unknown wallet type: ${type}`);
}

// Sign and send an EVM transaction
async function sendEvmTransaction({ to, data, value = "0x0", chainId }) {
  const privy = getPrivy();
  const res = await privy.walletApi.ethereum.sendTransaction({
    walletId: config.privy.wallets.evm,
    caip2: `eip155:${chainId}`,
    transaction: { to, data, value, gasLimit: "500000" },
  });
  return res.hash;
}

// Sign and send a Solana transaction (base64 serialized)
async function sendSolanaTransaction(serializedTx) {
  const privy = getPrivy();
  const res = await privy.walletApi.solana.signAndSendTransaction({
    walletId: config.privy.wallets.solana,
    serializedTransaction: serializedTx,
    encoding: "base64",
  });
  return res.signature;
}

// Sign a message with EVM wallet (used for Garden session auth)
async function signEvmMessage(message) {
  const privy = getPrivy();
  const res = await privy.walletApi.ethereum.signMessage({
    walletId: config.privy.wallets.evm,
    message,
  });
  return res.signature;
}

module.exports = { getPrivy, getAddress, sendEvmTransaction, sendSolanaTransaction, signEvmMessage };
