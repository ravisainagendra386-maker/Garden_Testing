// src/config.js
require("dotenv").config();

const REQUIRED = ["GARDEN_API_KEY","PRIVY_APP_ID","PRIVY_APP_SECRET",
  "PRIVY_EVM_WALLET_ID","PRIVY_SOLANA_WALLET_ID","BTC_PRIVATE_KEY_WIF","BTC_ADDRESS"];

function validate() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error("\n❌  Missing required environment variables:");
    missing.forEach((k) => console.error(`   • ${k}`));
    console.error("\n👉  Open .env and fill in the missing values.\n");
    process.exit(1);
  }
}
validate();

const ENV = process.env.GARDEN_ENV || "testnet";
const isMainnet = ENV === "mainnet";
const r = (m, t) => isMainnet ? (process.env[m] || "") : (process.env[t] || "");

const config = {
  env: ENV,
  isMainnet,
  garden: {
    apiKey: process.env.GARDEN_API_KEY,
    baseUrl: isMainnet
      ? "https://api.garden.finance/v2"
      : "https://testnet.api.garden.finance/v2",
  },
  privy: {
    appId: process.env.PRIVY_APP_ID,
    appSecret: process.env.PRIVY_APP_SECRET,
    wallets: {
      evm:      process.env.PRIVY_EVM_WALLET_ID,
      solana:   process.env.PRIVY_SOLANA_WALLET_ID,
      sui:      process.env.PRIVY_SUI_WALLET_ID      || null,
      starknet: process.env.PRIVY_STARKNET_WALLET_ID || null,
      tron:     process.env.PRIVY_TRON_WALLET_ID     || null,
    },
  },
  btc: {
    wif:     process.env.BTC_PRIVATE_KEY_WIF,
    address: process.env.OVERRIDE_BTC_ADDRESS || process.env.BTC_ADDRESS,
    rpc:     r("RPC_BITCOIN_MAINNET","RPC_BITCOIN_TESTNET"),
  },
  // Wallet address overrides — change these to use a different address
  overrides: {
    evm:      process.env.OVERRIDE_EVM_ADDRESS      || null,
    solana:   process.env.OVERRIDE_SOLANA_ADDRESS    || null,
    btc:      process.env.OVERRIDE_BTC_ADDRESS       || null,
    sui:      process.env.OVERRIDE_SUI_ADDRESS       || null,
    starknet: process.env.OVERRIDE_STARKNET_ADDRESS  || null,
    tron:     process.env.OVERRIDE_TRON_ADDRESS      || null,
  },
  manualApprove: process.env.MANUAL_APPROVE === "true",
  chains: {
    bitcoin:  { id:"bitcoin",  name:"Bitcoin",   type:"bitcoin",   rpc: r("RPC_BITCOIN_MAINNET","RPC_BITCOIN_TESTNET"),     explorer: isMainnet?"https://mempool.space/tx/":"https://mempool.space/testnet4/tx/" },
    ethereum: { id:"ethereum", name:"Ethereum",  type:"evm", chainId: isMainnet?1:11155111, rpc: r("RPC_ETHEREUM_MAINNET","RPC_ETHEREUM_TESTNET"), explorer: isMainnet?"https://etherscan.io/tx/":"https://sepolia.etherscan.io/tx/" },
    arbitrum: { id:"arbitrum", name:"Arbitrum",  type:"evm", chainId: isMainnet?42161:421614, rpc: r("RPC_ARBITRUM_MAINNET","RPC_ARBITRUM_TESTNET"), explorer: isMainnet?"https://arbiscan.io/tx/":"https://sepolia.arbiscan.io/tx/" },
    base:     { id:"base",     name:"Base",      type:"evm", chainId: isMainnet?8453:84532, rpc: r("RPC_BASE_MAINNET","RPC_BASE_TESTNET"), explorer: isMainnet?"https://basescan.org/tx/":"https://sepolia.basescan.org/tx/" },
    bnbchain: { id:"bnbchain", name:"BNB Chain", type:"evm", chainId: isMainnet?56:97, rpc: r("RPC_BNB_MAINNET","RPC_BNB_TESTNET"), explorer: isMainnet?"https://bscscan.com/tx/":"https://testnet.bscscan.com/tx/" },
    berachain:{ id:"berachain",name:"Berachain", type:"evm", chainId: isMainnet?80084:80069, rpc: r("RPC_BERACHAIN_MAINNET","RPC_BERACHAIN_TESTNET"), explorer: isMainnet?"https://berascan.com/tx/":"https://bartio.beratrail.io/tx/" },
    unichain: { id:"unichain", name:"Unichain",  type:"evm", chainId: 1301, rpc: r("RPC_UNICHAIN_MAINNET","RPC_UNICHAIN_TESTNET"), explorer:"https://uniscan.xyz/tx/" },
    hyperevm: { id:"hyperevm", name:"HyperEVM",  type:"evm", chainId: isMainnet?999:998, rpc: r("RPC_HYPEREVM_MAINNET","RPC_HYPEREVM_TESTNET"), explorer:"https://explorer.hyperliquid.xyz/tx/" },
    corn:     { id:"corn",     name:"Corn",      type:"evm", chainId: isMainnet?21000000:21000001, rpc: r("RPC_CORN_MAINNET","RPC_CORN_TESTNET"), explorer:"https://explorer.usecorn.com/tx/" },
    botanix:  { id:"botanix",  name:"Botanix",   type:"evm", chainId: isMainnet?3637:3636, rpc: r("RPC_BOTANIX_MAINNET","RPC_BOTANIX_TESTNET"), explorer:"https://blockscout.botanixlabs.dev/tx/" },
    core:     { id:"core",     name:"Core",      type:"evm", chainId: isMainnet?1116:1115, rpc: r("RPC_CORE_MAINNET","RPC_CORE_TESTNET"), explorer:"https://scan.coredao.org/tx/" },
    megaeth:  { id:"megaeth",  name:"MegaETH",   type:"evm", chainId: 6342, rpc: r("RPC_MEGAETH_MAINNET","RPC_MEGAETH_TESTNET"), explorer:"https://megaexplorer.xyz/tx/" },
    solana:   { id:"solana",   name:"Solana",    type:"solana", rpc: r("RPC_SOLANA_MAINNET","RPC_SOLANA_TESTNET"), explorer: isMainnet?"https://solscan.io/tx/":"https://solscan.io/tx/?cluster=testnet" },
    starknet: { id:"starknet", name:"Starknet",  type:"starknet", rpc: r("RPC_STARKNET_MAINNET","RPC_STARKNET_TESTNET"), explorer: isMainnet?"https://starkscan.co/tx/":"https://sepolia.starkscan.co/tx/" },
    sui:      { id:"sui",      name:"Sui",       type:"sui", rpc: r("RPC_SUI_MAINNET","RPC_SUI_TESTNET"), explorer: isMainnet?"https://suiexplorer.com/txblock/":"https://suiexplorer.com/txblock/?network=testnet" },
    tron:     { id:"tron",     name:"Tron",      type:"tron", rpc: r("RPC_TRON_MAINNET","RPC_TRON_TESTNET"), explorer: isMainnet?"https://tronscan.org/#/transaction/":"https://nile.tronscan.org/#/transaction/" },
  },
  evmChainIds: ["ethereum","arbitrum","base","bnbchain","berachain","unichain","hyperevm","corn","botanix","core","megaeth"],
  port: parseInt(process.env.PORT || "3000"),
};

module.exports = config;
