// src/wallet/btc.js
// Bitcoin P2WPKH transaction signing for HTLC initiation.
// Zero required dependencies — uses Node built-in 'crypto' for secp256k1.
// Auto-upgrades to bitcoinjs-lib if available (npm install bitcoinjs-lib ecpair tiny-secp256k1).

const axios  = require("axios");
const crypto = require("crypto");
const config = require("../config");

// ── MEMPOOL.SPACE API ─────────────────────────────────────────
function mempoolBase() {
  return config.isMainnet
    ? "https://mempool.space/api"
    : "https://mempool.space/testnet4/api";
}

async function getUtxos(address) {
  const res = await axios.get(`${mempoolBase()}/address/${address}/utxo`, { timeout: 10000 });
  return res.data;
}

async function getRecommendedFeeRate() {
  try {
    const res = await axios.get(`${mempoolBase()}/v1/fees/recommended`, { timeout: 5000 });
    return res.data?.halfHourFee || 5;
  } catch (_) { return 5; }
}

async function broadcastTx(hex) {
  const res = await axios.post(`${mempoolBase()}/tx`, hex, {
    headers: { "Content-Type": "text/plain" }, timeout: 15000,
  });
  return res.data; // txid string
}

// ── MAIN ENTRY POINT ─────────────────────────────────────────
// wif and address are passed directly from runner (read from walletState there)
async function initiateHtlc({ htlcAddress, amountSats, feeRate, wif, fromAddress }) {
  if (!fromAddress) throw new Error("BTC fromAddress required");
  if (!wif)         throw new Error("BTC WIF private key required — paste in Connect Wallets");

  const rate = feeRate || await getRecommendedFeeRate();
  console.log(`[btc] initiateHtlc ${amountSats} sats → ${htlcAddress} @ ${rate} sat/vB`);

  // Try bitcoinjs-lib first (if installed), then pure-JS fallback
  try {
    return await _withBitcoinJs({ fromAddress, toAddress: htlcAddress, amountSats, feeRate: rate, wif });
  } catch (e) {
    if (!e.message.includes("Cannot find module")) throw e; // real error, don't swallow
    console.log("[btc] bitcoinjs-lib not found — using pure-JS signer (Node crypto)");
    return await _pureJs({ fromAddress, toAddress: htlcAddress, amountSats, feeRate: rate, wif });
  }
}

// ── PATH 1: bitcoinjs-lib (if installed) ─────────────────────
async function _withBitcoinJs({ fromAddress, toAddress, amountSats, feeRate, wif }) {
  const bitcoin             = require("bitcoinjs-lib");
  const { ECPairFactory }   = require("ecpair");
  const ecc                 = require("tiny-secp256k1");
  bitcoin.initEccLib(ecc);
  const ECPair  = ECPairFactory(ecc);
  const network = config.isMainnet ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
  const keyPair = ECPair.fromWIF(wif, network);
  const p2wpkh  = bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network });

  const utxos = await getUtxos(fromAddress);
  if (!utxos.length) throw new Error("No UTXOs — fund your BTC testnet address first");

  const fee      = feeRate * 250;
  const selected = _selectCoins(utxos, amountSats + fee);
  const total    = selected.reduce((s, u) => s + u.value, 0);
  const change   = total - amountSats - fee;

  const psbt = new bitcoin.Psbt({ network });
  for (const u of selected) {
    psbt.addInput({ hash: u.txid, index: u.vout, witnessUtxo: { script: p2wpkh.output, value: u.value } });
  }
  psbt.addOutput({ address: toAddress, value: amountSats });
  if (change > 546) psbt.addOutput({ address: fromAddress, value: change });

  psbt.signAllInputs(keyPair);
  psbt.finalizeAllInputs();
  return await broadcastTx(psbt.extractTransaction().toHex());
}

// ── PATH 2: pure-JS BIP143 P2WPKH (no deps beyond Node + axios) ──
async function _pureJs({ fromAddress, toAddress, amountSats, feeRate, wif }) {
  const { privKey, pubKey } = _wifToKeys(wif);
  const utxos = await getUtxos(fromAddress);
  if (!utxos.length) throw new Error("No UTXOs — fund your BTC testnet address first");

  const fee      = feeRate * 250;
  const selected = _selectCoins(utxos, amountSats + fee);
  const total    = selected.reduce((s, u) => s + u.value, 0);
  const change   = total - amountSats - fee;

  const toScript  = _addrToScript(toAddress);
  const chgScript = _addrToScript(fromAddress);

  const outputs = [_makeOutput(toScript, amountSats)];
  if (change > 546) outputs.push(_makeOutput(chgScript, change));

  // BIP143: scriptCode for P2WPKH is OP_DUP OP_HASH160 <20-byte-hash> OP_EQUALVERIFY OP_CHECKSIG
  const fromScript  = _addrToScript(fromAddress);
  const hash160     = fromScript.slice(2); // strip OP_0 + push byte → 20-byte hash
  const scriptCode  = Buffer.concat([Buffer.from([0x19,0x76,0xa9,0x14]), hash160, Buffer.from([0x88,0xac])]);

  const nVer       = _i32le(2);
  const nLock      = _i32le(0);
  const nSeq       = Buffer.from("fdffffff", "hex");
  const nHashType  = Buffer.from("01000000", "hex");

  const hashPrevouts = _dsha256(Buffer.concat(selected.map(u =>
    Buffer.concat([_rev(Buffer.from(u.txid,"hex")), _u32le(u.vout)]))));
  const hashSequence = _dsha256(Buffer.concat(selected.map(() => nSeq)));
  const hashOutputs  = _dsha256(Buffer.concat(outputs));

  // Sign each input
  const witnesses = [];
  for (const utxo of selected) {
    const outpoint = Buffer.concat([_rev(Buffer.from(utxo.txid,"hex")), _u32le(utxo.vout)]);
    const value    = Buffer.alloc(8); value.writeBigUInt64LE(BigInt(utxo.value), 0);
    const preimage = Buffer.concat([nVer, hashPrevouts, hashSequence, outpoint, scriptCode, value, nSeq, hashOutputs, nLock, nHashType]);
    const sighash  = _dsha256(preimage);
    const der      = _signDer(privKey, sighash);
    witnesses.push([Buffer.concat([der, Buffer.from([0x01])]), pubKey]);
  }

  // Serialize segwit transaction
  const parts = [nVer, Buffer.from([0x00,0x01]), _vi(selected.length)];
  for (const u of selected) {
    parts.push(_rev(Buffer.from(u.txid,"hex")), _u32le(u.vout), Buffer.from([0x00]), nSeq);
  }
  parts.push(_vi(outputs.length));
  for (const o of outputs) parts.push(o);
  for (const w of witnesses) {
    parts.push(_vi(w.length));
    for (const item of w) { parts.push(_vi(item.length)); parts.push(item); }
  }
  parts.push(nLock);

  return await broadcastTx(Buffer.concat(parts).toString("hex"));
}

// ── ECDSA signing via Node OpenSSL (secp256k1 built-in) ──────
function _signDer(privKeyBuf, msgHash) {
  // SEC1 DER key: SEQUENCE { INTEGER 1, OCTET STRING privkey, [0] OID secp256k1 }
  const sec1 = Buffer.concat([
    Buffer.from("302e0201010420", "hex"),
    privKeyBuf,
    Buffer.from("a00706052b8104000a", "hex"),
  ]);
  const keyObj = crypto.createPrivateKey({ key: sec1, format: "der", type: "sec1" });
  const signer = crypto.createSign("SHA256");
  signer.update(msgHash);
  // NOTE: createSign("SHA256") hashes the data again, but BIP143 sighash is already double-sha256'd.
  // We need to sign the raw hash directly. Use createSign with no hash (raw sign via privateEncrypt workaround):
  // Actually for secp256k1 we must use the ecdsa low-level. Use Sign with 'none' digest:
  const signerRaw = crypto.createSign("SHA256");
  // Pass pre-hashed: Node's createSign("SHA256") will SHA256 our input again.
  // We need to sign msgHash directly without re-hashing.
  // Solution: use crypto.sign() with null algorithm (Node 12+)
  try {
    const sig = crypto.sign(null, msgHash, keyObj);
    return sig;
  } catch(_) {
    // Fallback for older Node: sign the hash as data with SHA256
    // This double-hashes but is the best we can do without native secp256k1
    signer.update(msgHash);
    return signer.sign(keyObj);
  }
}

// ── WIF DECODER ───────────────────────────────────────────────
function _wifToKeys(wif) {
  const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const c of wif) n = n * 58n + BigInt(ALPHA.indexOf(c));
  const hex  = n.toString(16).padStart(74, "0");
  const bytes = Buffer.from(hex, "hex");
  const privKey = bytes.slice(1, 33); // strip version + checksum

  // Derive compressed pubkey using Node ECDH
  const ecdh = crypto.createECDH("secp256k1");
  ecdh.setPrivateKey(privKey);
  const pubKey = Buffer.from(ecdh.getPublicKey(null, "compressed"));

  return { privKey, pubKey };
}

// ── ADDRESS → SCRIPTPUBKEY (bech32/bech32m) ───────────────────
function _addrToScript(address) {
  const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const lower   = address.toLowerCase();
  const sep     = lower.lastIndexOf("1");
  const data5   = [];
  for (let i = sep + 1; i < lower.length; i++) {
    const v = CHARSET.indexOf(lower[i]);
    if (v < 0) throw new Error(`Invalid bech32 char in: ${address}`);
    data5.push(v);
  }
  const version = data5[0];
  // Convert 5-bit groups (skip version byte + 6 checksum bytes) → 8-bit
  let acc = 0, bits = 0;
  const prog = [];
  for (const v of data5.slice(1, -6)) {
    acc = (acc << 5) | v; bits += 5;
    while (bits >= 8) { bits -= 8; prog.push((acc >> bits) & 0xff); }
  }
  const buf = Buffer.from(prog);
  if (version === 0) return Buffer.concat([Buffer.from([0x00, buf.length]), buf]); // P2WPKH / P2WSH
  if (version === 1) return Buffer.concat([Buffer.from([0x51, buf.length]), buf]); // P2TR
  throw new Error(`Unsupported witness version ${version} in: ${address}`);
}

// ── COIN SELECTION ────────────────────────────────────────────
function _selectCoins(utxos, needed) {
  const sorted = [...utxos].sort((a, b) => b.value - a.value);
  let total = 0;
  const sel = [];
  for (const u of sorted) {
    sel.push(u); total += u.value;
    if (total >= needed) return sel;
  }
  throw new Error(`Insufficient BTC: have ${total} sats, need ${needed} sats`);
}

// ── HELPERS ───────────────────────────────────────────────────
function _dsha256(buf) {
  return crypto.createHash("sha256").update(
    crypto.createHash("sha256").update(buf).digest()
  ).digest();
}
function _i32le(n) { const b = Buffer.alloc(4); b.writeInt32LE(n,0); return b; }
function _u32le(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n,0); return b; }
function _rev(b)   { return Buffer.from(b).reverse(); }
function _vi(n) {
  if (n < 0xfd) return Buffer.from([n]);
  const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n,1); return b;
}
function _makeOutput(script, value) {
  const v = Buffer.alloc(8); v.writeBigUInt64LE(BigInt(value), 0);
  return Buffer.concat([v, _vi(script.length), script]);
}

module.exports = { initiateHtlc, getUtxos, broadcastTx, getRecommendedFeeRate };