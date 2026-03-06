// src/config.js
require("dotenv").config();

// Only GARDEN_API_KEY is required — wallets connect via dashboard
function validate() {
  if (process.env.SKIP_ENV_VALIDATE === "true") return;
  if (!process.env.GARDEN_API_KEY) {
    console.error("\n❌  Missing GARDEN_API_KEY in .env\n");
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
  // Privy — optional, can be set via dashboard Connect Wallets panel
  privy: {
    appId:     process.env.PRIVY_APP_ID     || null,
    appSecret: process.env.PRIVY_APP_SECRET || null,
    wallets: {
      evm:      process.env.PRIVY_EVM_WALLET_ID      || null,
      solana:   process.env.PRIVY_SOLANA_WALLET_ID   || null,
      sui:      process.env.PRIVY_SUI_WALLET_ID      || null,
      starknet: process.env.PRIVY_STARKNET_WALLET_ID || null,
      tron:     process.env.PRIVY_TRON_WALLET_ID     || null,
    },
  },
  // BTC — optional, can be set via dashboard
  btc: {
    wif:     process.env.BTC_PRIVATE_KEY_WIF || null,
    address: process.env.OVERRIDE_BTC_ADDRESS || process.env.BTC_ADDRESS || null,
    rpc:     r("RPC_BITCOIN_MAINNET", "RPC_BITCOIN_TESTNET"),
  },
  manualApprove: process.env.MANUAL_APPROVE === "true",
  chains: {
    bitcoin:   { id:"bitcoin",   name:"Bitcoin",   type:"bitcoin",   asset:"BTC",  rpc: r("RPC_BITCOIN_MAINNET","RPC_BITCOIN_TESTNET"),     explorer: isMainnet?"https://mempool.space/tx/":"https://mempool.space/testnet4/tx/" },
    ethereum:  { id:"ethereum",  name:"Ethereum",  type:"evm",       asset:"ETH",  chainId: isMainnet?1:11155111,    rpc: r("RPC_ETHEREUM_MAINNET","RPC_ETHEREUM_TESTNET"),   explorer: isMainnet?"https://etherscan.io/tx/":"https://sepolia.etherscan.io/tx/" },
    arbitrum:  { id:"arbitrum",  name:"Arbitrum",  type:"evm",       asset:"ETH",  chainId: isMainnet?42161:421614,  rpc: r("RPC_ARBITRUM_MAINNET","RPC_ARBITRUM_TESTNET"),   explorer: isMainnet?"https://arbiscan.io/tx/":"https://sepolia.arbiscan.io/tx/" },
    base:      { id:"base",      name:"Base",      type:"evm",       asset:"ETH",  chainId: isMainnet?8453:84532,    rpc: r("RPC_BASE_MAINNET","RPC_BASE_TESTNET"),           explorer: isMainnet?"https://basescan.org/tx/":"https://sepolia.basescan.org/tx/" },
    bnbchain:  { id:"bnbchain",  name:"BNB Chain", type:"evm",       asset:"BNB",  chainId: isMainnet?56:97,         rpc: r("RPC_BNB_MAINNET","RPC_BNB_TESTNET"),             explorer: isMainnet?"https://bscscan.com/tx/":"https://testnet.bscscan.com/tx/" },
    berachain: { id:"berachain", name:"Berachain", type:"evm",       asset:"BERA", chainId: isMainnet?80084:80069,   rpc: r("RPC_BERACHAIN_MAINNET","RPC_BERACHAIN_TESTNET"), explorer: isMainnet?"https://berascan.com/tx/":"https://bartio.beratrail.io/tx/" },
    unichain:  { id:"unichain",  name:"Unichain",  type:"evm",       asset:"ETH",  chainId: 1301,                    rpc: r("RPC_UNICHAIN_MAINNET","RPC_UNICHAIN_TESTNET"),   explorer:"https://uniscan.xyz/tx/" },
    hyperevm:  { id:"hyperevm",  name:"HyperEVM",  type:"evm",       asset:"ETH",  chainId: isMainnet?999:998,       rpc: r("RPC_HYPEREVM_MAINNET","RPC_HYPEREVM_TESTNET"),   explorer:"https://explorer.hyperliquid.xyz/tx/" },
    corn:      { id:"corn",      name:"Corn",       type:"evm",       asset:"BTCN", chainId: isMainnet?21000000:21000001, rpc: r("RPC_CORN_MAINNET","RPC_CORN_TESTNET"),       explorer:"https://explorer.usecorn.com/tx/" },
    botanix:   { id:"botanix",   name:"Botanix",   type:"evm",       asset:"BTC",  chainId: isMainnet?3637:3636,     rpc: r("RPC_BOTANIX_MAINNET","RPC_BOTANIX_TESTNET"),    explorer:"https://blockscout.botanixlabs.dev/tx/" },
    core:      { id:"core",      name:"Core",       type:"evm",       asset:"CORE", chainId: isMainnet?1116:1115,     rpc: r("RPC_CORE_MAINNET","RPC_CORE_TESTNET"),           explorer:"https://scan.coredao.org/tx/" },
    megaeth:   { id:"megaeth",   name:"MegaETH",   type:"evm",       asset:"ETH",  chainId: 6342,                    rpc: r("RPC_MEGAETH_MAINNET","RPC_MEGAETH_TESTNET"),     explorer:"https://megaexplorer.xyz/tx/" },
    solana:    { id:"solana",    name:"Solana",    type:"solana",    asset:"SOL",  rpc: r("RPC_SOLANA_MAINNET","RPC_SOLANA_TESTNET"),       explorer: isMainnet?"https://solscan.io/tx/":"https://solscan.io/tx/?cluster=testnet" },
    starknet:  { id:"starknet",  name:"Starknet",  type:"starknet",  asset:"ETH",  rpc: r("RPC_STARKNET_MAINNET","RPC_STARKNET_TESTNET"),   explorer: isMainnet?"https://starkscan.co/tx/":"https://sepolia.starkscan.co/tx/" },
    sui:       { id:"sui",       name:"Sui",        type:"sui",       asset:"SUI",  rpc: r("RPC_SUI_MAINNET","RPC_SUI_TESTNET"),             explorer: isMainnet?"https://suiexplorer.com/txblock/":"https://suiexplorer.com/txblock/?network=testnet" },
    tron:      { id:"tron",      name:"Tron",       type:"tron",      asset:"TRX",  rpc: r("RPC_TRON_MAINNET","RPC_TRON_TESTNET"),           explorer: isMainnet?"https://tronscan.org/#/transaction/":"https://nile.tronscan.org/#/transaction/" },
  },
  evmChainIds: ["ethereum","arbitrum","base","bnbchain","berachain","unichain","hyperevm","corn","botanix","core","megaeth"],
  port: parseInt(process.env.PORT || "3000"),
};

module.exports = config;