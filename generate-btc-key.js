// src/wallet/generate-btc-key.js
// Run this ONCE to generate a Bitcoin testnet4 key pair.
// Usage: node src/wallet/generate-btc-key.js
// Then paste the output into your .env file.

const bitcoin = require("bitcoinjs-lib");
const { ECPairFactory } = require("ecpair");
const ecc = require("tiny-secp256k1");

const ECPair = ECPairFactory(ecc);
const testnet = bitcoin.networks.testnet; // testnet4 uses same network params

const keyPair = ECPair.makeRandom({ network: testnet });
const { address } = bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network: testnet });
const wif = keyPair.toWIF();

console.log("\n✅  Bitcoin Testnet Key Generated");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("Add these to your .env file:\n");
console.log(`BTC_PRIVATE_KEY_WIF=${wif}`);
console.log(`BTC_ADDRESS=${address}`);
console.log("\n⚠️  Keep BTC_PRIVATE_KEY_WIF secret. Never share or commit it.");
console.log("💧  Fund this address on testnet4 faucet: https://mempool.space/testnet4");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
