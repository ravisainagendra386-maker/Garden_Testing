require("dotenv").config();

const ENV = process.env.GARDEN_ENV || "testnet";
const isMainnet = ENV === "mainnet";

function truthy(v) {
  return String(v || "").toLowerCase() === "true";
}

const envValidationSkipped = truthy(process.env.SKIP_ENV_VALIDATE);

function pickRpc(envKey, fallback) {
  return process.env[envKey] || fallback || "";
}

const defaults = {
  rpc: {
    ethereum_sepolia: "https://ethereum-sepolia.publicnode.com",
    arbitrum_sepolia: "https://arbitrum-sepolia.publicnode.com",
    base_sepolia: "https://base-sepolia.publicnode.com",
    bnbchain_testnet: "https://bsc-testnet.publicnode.com",
    solana_testnet: "https://api.testnet.solana.com",
  },
};

const asset = (mainnet, testnet) => (isMainnet ? mainnet : testnet);

const config = {
  env: ENV,
  isMainnet,
  envValidationSkipped,

  garden: {
    apiKey: process.env.GARDEN_API_KEY || "",
    baseUrl: isMainnet
      ? "https://api.garden.finance/v2"
      : "https://testnet.api.garden.finance/v2",
  },

  privy: {
    appId: process.env.PRIVY_APP_ID || "",
    appSecret: process.env.PRIVY_APP_SECRET || "",
    wallets: {
      evm: process.env.PRIVY_EVM_WALLET_ID || "",
      solana: process.env.PRIVY_SOLANA_WALLET_ID || "",
      sui: process.env.PRIVY_SUI_WALLET_ID || "",
      starknet: process.env.PRIVY_STARKNET_WALLET_ID || "",
      tron: process.env.PRIVY_TRON_WALLET_ID || "",
    },
  },

  btc: {
    wif: process.env.BTC_PRIVATE_KEY_WIF || "",
    address: process.env.OVERRIDE_BTC_ADDRESS || process.env.BTC_ADDRESS || "",
  },

  overrides: {
    evm: process.env.OVERRIDE_EVM_ADDRESS || null,
    solana: process.env.OVERRIDE_SOLANA_ADDRESS || null,
    btc: process.env.OVERRIDE_BTC_ADDRESS || null,
    sui: process.env.OVERRIDE_SUI_ADDRESS || null,
    starknet: process.env.OVERRIDE_STARKNET_ADDRESS || null,
    tron: process.env.OVERRIDE_TRON_ADDRESS || null,
  },

  manualApprove: truthy(process.env.MANUAL_APPROVE),

  // Minimal chain set that matches current Garden v2 asset enums.
  chains: {
    bitcoin: {
      id: "bitcoin",
      name: "Bitcoin",
      type: "bitcoin",
      rpc: "",
      explorer: isMainnet
        ? "https://mempool.space/tx/"
        : "https://mempool.space/testnet4/tx/",
      asset: asset("bitcoin:btc", "bitcoin_testnet:btc"),
    },
    ethereum: {
      id: "ethereum",
      name: "Ethereum",
      type: "evm",
      chainId: isMainnet ? 1 : 11155111,
      rpc: pickRpc("RPC_ETHEREUM", defaults.rpc.ethereum_sepolia),
      explorer: isMainnet
        ? "https://etherscan.io/tx/"
        : "https://sepolia.etherscan.io/tx/",
      asset: asset("ethereum:wbtc", "ethereum_sepolia:wbtc"),
    },
    arbitrum: {
      id: "arbitrum",
      name: "Arbitrum",
      type: "evm",
      chainId: isMainnet ? 42161 : 421614,
      rpc: pickRpc("RPC_ARBITRUM", defaults.rpc.arbitrum_sepolia),
      explorer: isMainnet ? "https://arbiscan.io/tx/" : "https://sepolia.arbiscan.io/tx/",
      asset: asset("arbitrum:wbtc", "arbitrum_sepolia:wbtc"),
    },
    base: {
      id: "base",
      name: "Base",
      type: "evm",
      chainId: isMainnet ? 8453 : 84532,
      rpc: pickRpc("RPC_BASE", defaults.rpc.base_sepolia),
      explorer: isMainnet ? "https://basescan.org/tx/" : "https://sepolia.basescan.org/tx/",
      asset: asset("base:cbbtc", "base_sepolia:wbtc"),
    },
    bnbchain: {
      id: "bnbchain",
      name: "BNB Chain",
      type: "evm",
      chainId: isMainnet ? 56 : 97,
      rpc: pickRpc("RPC_BNBCHAIN", defaults.rpc.bnbchain_testnet),
      explorer: isMainnet ? "https://bscscan.com/tx/" : "https://testnet.bscscan.com/tx/",
      asset: asset("bnbchain:btcb", "bnbchain_testnet:wbtc"),
    },
    solana: {
      id: "solana",
      name: "Solana",
      type: "solana",
      rpc: pickRpc("RPC_SOLANA", defaults.rpc.solana_testnet),
      explorer: isMainnet ? "https://solscan.io/tx/" : "https://solscan.io/tx/?cluster=testnet",
      asset: asset("solana:sol", "solana_testnet:sol"),
    },
    starknet: {
      id: "starknet",
      name: "Starknet",
      type: "starknet",
      rpc: pickRpc("RPC_STARKNET", ""),
      explorer: isMainnet ? "https://starkscan.co/tx/" : "https://sepolia.starkscan.co/tx/",
      asset: asset("starknet:wbtc", "starknet_sepolia:wbtc"),
    },
    tron: {
      id: "tron",
      name: "Tron",
      type: "tron",
      rpc: pickRpc("RPC_TRON", ""),
      explorer: isMainnet ? "https://tronscan.org/#/transaction/" : "https://nile.tronscan.org/#/transaction/",
      asset: asset("tron:usdt", "tron_shasta:usdt"),
    },
  },

  evmChainIds: ["ethereum", "arbitrum", "base", "bnbchain"],

  test: {
    btcAmountSats: parseInt(process.env.TEST_BTC_AMOUNT_SATS || "50000", 10),
    evmAmount: parseInt(process.env.TEST_EVM_AMOUNT || "10000", 10),
  },

  port: parseInt(process.env.PORT || "3000", 10),
};

module.exports = config;

