const { PrivyClient } = require("@privy-io/node");
const { ethers } = require("ethers");
const config = require("../config");

let _privy = null;
let _overrideEvmWallet = null;

function getPrivy() {
  if (!_privy) _privy = new PrivyClient(config.privy.appId, config.privy.appSecret);
  return _privy;
}

function getOverrideEvmWallet() {
  if (!process.env.OVERRIDE_EVM_PRIVATE_KEY) return null;
  if (_overrideEvmWallet) return _overrideEvmWallet;
  const pk = process.env.OVERRIDE_EVM_PRIVATE_KEY.trim();
  if (!pk) return null;
  // Choose Ethereum chain RPC as default provider for this wallet
  const chain = config.chains.ethereum;
  const provider = new ethers.JsonRpcProvider(chain.rpc);
  _overrideEvmWallet = new ethers.Wallet(pk, provider);
  return _overrideEvmWallet;
}

async function getAddress(type) {
  if (type === "evm") {
    const overrideWallet = getOverrideEvmWallet();
    if (overrideWallet) return overrideWallet.address;
  }

  if (config.overrides[type]) return config.overrides[type];
  const privy = getPrivy();
  const walletId = config.privy.wallets[type];
  if (!walletId) throw new Error(`No Privy wallet configured for type: ${type}`);

  const w = await privy.walletApi.getWallet({ id: walletId });
  return w.address;
}

async function sendEvmTransaction({ to, data, value = "0x0", chainId }) {
  const overrideWallet = getOverrideEvmWallet();
  if (overrideWallet) {
    const tx = {
      to,
      data,
      value,
      gasLimit: 500000n,
      chainId,
    };
    const sent = await overrideWallet.sendTransaction(tx);
    return sent.hash;
  }

  const privy = getPrivy();
  const res = await privy.walletApi.ethereum.sendTransaction({
    walletId: config.privy.wallets.evm,
    caip2: `eip155:${chainId}`,
    transaction: { to, data, value, gasLimit: "500000" },
  });
  return res.hash;
}

async function sendSolanaTransaction(serializedTx) {
  const privy = getPrivy();
  const res = await privy.walletApi.solana.signAndSendTransaction({
    walletId: config.privy.wallets.solana,
    serializedTransaction: serializedTx,
    encoding: "base64",
  });
  return res.signature;
}

async function signEvmMessage(message) {
  const overrideWallet = getOverrideEvmWallet();
  if (overrideWallet) {
    return await overrideWallet.signMessage(message);
  }

  const privy = getPrivy();
  const res = await privy.walletApi.ethereum.signMessage({
    walletId: config.privy.wallets.evm,
    message,
  });
  return res.signature;
}

module.exports = {
  getPrivy,
  getAddress,
  sendEvmTransaction,
  sendSolanaTransaction,
  signEvmMessage,
};

