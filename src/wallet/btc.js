const axios = require("axios");
const bitcoin = require("bitcoinjs-lib");
const { ECPairFactory } = require("ecpair");
const ecc = require("tiny-secp256k1");
const config = require("../config");

const ECPair = ECPairFactory(ecc);

function getMempoolBaseUrl() {
  if (config.isMainnet) return "https://mempool.space/api";
  // Garden docs + README refer to testnet4
  return "https://mempool.space/testnet4/api";
}

async function getBtcUtxos(address) {
  if (!address) throw new Error("BTC_ADDRESS is not set in .env");
  const base = getMempoolBaseUrl();
  const { data } = await axios.get(`${base}/address/${address}/utxo`, {
    timeout: 15000,
  });
  if (!Array.isArray(data)) throw new Error("Unexpected mempool API response");
  return data;
}

async function getBtcBalanceSats(address) {
  const utxos = await getBtcUtxos(address);
  return utxos.reduce((sum, u) => sum + Number(u.value || 0), 0);
}

/**
 * Send a simple Bitcoin transaction from the configured BTC wallet
 * to the given address, using mempool.space for UTXOs and broadcast.
 *
 * Only supports single-sig P2WPKH, suitable for the generated testnet key.
 */
async function sendBtcPayment({ to, amountSats, feeSats = 500 }) {
  const fromAddress = config.btc.address;
  const wif = config.btc.wif;
  if (!fromAddress || !wif) {
    throw new Error("BTC_ADDRESS and BTC_PRIVATE_KEY_WIF must be set in .env to send BTC.");
  }
  if (!to) throw new Error("Missing destination address for BTC payment.");

  const network = config.isMainnet ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
  const base = getMempoolBaseUrl();

  const utxos = await getBtcUtxos(fromAddress);
  if (!utxos.length) throw new Error("No UTXOs available for BTC wallet.");

  let total = 0;
  const selected = [];
  for (const u of utxos) {
    selected.push(u);
    total += Number(u.value || 0);
    if (total >= amountSats + feeSats) break;
  }
  if (total < amountSats + feeSats) {
    throw new Error(`Insufficient BTC balance for payment + fee. Have ${total}, need ${amountSats + feeSats}.`);
  }

  const psbt = new bitcoin.Psbt({ network });

  for (const u of selected) {
    // Fetch full previous tx as non-witness UTXO
    const { data: txHex } = await axios.get(`${base}/tx/${u.txid}/hex`, { timeout: 15000 });
    psbt.addInput({
      hash: u.txid,
      index: u.vout,
      nonWitnessUtxo: Buffer.from(txHex, "hex"),
    });
  }

  psbt.addOutput({ address: to, value: amountSats });
  const change = total - amountSats - feeSats;
  if (change > 0) {
    psbt.addOutput({ address: fromAddress, value: change });
  }

  const keyPair = ECPair.fromWIF(wif, network);
  for (let i = 0; i < selected.length; i++) {
    psbt.signInput(i, keyPair);
  }
  psbt.finalizeAllInputs();
  const txHex = psbt.extractTransaction().toHex();

  await axios.post(`${base}/tx`, txHex, {
    headers: { "Content-Type": "text/plain" },
    timeout: 15000,
  });

  return txHex;
}

module.exports = {
  getBtcBalanceSats,
  getBtcUtxos,
  sendBtcPayment,
};

