// When no Garden beam seed qualifies (no funded chain-start), pick a random EVM native
// asset and verify native gas + Garden liquidity before any trade.
"use strict";

const garden = require("../api/garden");

const MIN_GAS_WEI = 10n ** 15n;

function getChainKey(assetId) {
  return String(assetId || "")
    .split(":")[0]
    .replace(/_sepolia|_testnet\d*|_mainnet|_signet|_devnet/g, "");
}

function toComparableBigInt(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.floor(value));
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return null;
    try {
      return BigInt(s.includes(".") ? s.split(".")[0] : s);
    } catch (_) {
      return null;
    }
  }
  return null;
}

function isPairPlausible(from, to) {
  const fam = (a) => {
    const t = (a.name || a.id || "").toLowerCase().split(":").pop();
    if (/btc$|^btc|wbtc|cbtc|cbbtc|sbtc|hbtc|btcn|lbtc|tbtc|pbtc|rbtc/.test(t)) return "btc";
    if (/^eth$|^weth$/.test(t)) return "eth";
    if (/usdc|usdt|dai|busd/.test(t)) return "stable";
    if (/^ltc$|^wltc$|^cbltc$/.test(t)) return "ltc";
    return "other";
  };
  const ff = fam(from),
    tf = fam(to);
  if (ff === tf) return true;
  if (ff === "btc" && tf !== "btc") return false;
  if (tf === "btc" && ff !== "btc") return false;
  return true;
}

/** EVM chain native gas token rows from Garden (ETH, BNB, etc.). */
function isNativeGasAsset(asset) {
  const chain = String(asset.chain || "").toLowerCase();
  if (!chain.startsWith("evm")) return false;
  const addr = String(
    asset.token_address || asset.tokenAddress || asset.contract_address || asset.contractAddress || ""
  ).toLowerCase();
  return !addr || addr === "native" || addr === "0x0000000000000000000000000000000000000000";
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function checkGasOnChain(gasMap, chainKey) {
  const g = gasMap.get(chainKey);
  if (g === undefined) return { ok: false, reason: "no_gas_reading" };
  const gasBig = toComparableBigInt(g) || 0n;
  return { ok: gasBig >= MIN_GAS_WEI, reason: gasBig >= MIN_GAS_WEI ? "ok" : "below_min" };
}

/**
 * Confirm Garden can quote or read liquidity between this native and another asset on the same chain.
 */
async function checkGardenLiquidityForNative(nativeAsset, supported) {
  const prefix = nativeAsset.id.split(":")[0];
  const peers = supported.filter(
    (a) => a.id !== nativeAsset.id && String(a.id).startsWith(prefix + ":") && isPairPlausible(nativeAsset, a)
  );
  shuffleInPlace(peers);
  const minAmt = Math.min(
    1000000,
    Math.max(50000, parseInt(String(nativeAsset.min_amount || 50000), 10) || 50000)
  );

  for (const peer of peers.slice(0, 16)) {
    try {
      const q = await garden.getQuote(peer.id, nativeAsset.id, minAmt);
      if (q?.result?.length) return { ok: true, peerAssetId: peer.id, direction: "peer_to_native" };
    } catch (_) {}
    try {
      const q2 = await garden.getQuote(nativeAsset.id, peer.id, minAmt);
      if (q2?.result?.length) return { ok: true, peerAssetId: peer.id, direction: "native_to_peer" };
    } catch (_) {}
  }

  try {
    const peer0 = peers[0];
    if (peer0) {
      const liq = await garden.getLiquidity(nativeAsset.id, peer0.id);
      const av = liq?.result?.available ?? liq?.result?.liquidity ?? liq?.available;
      if (av !== undefined && av !== null) return { ok: true, peerAssetId: peer0.id, direction: "liquidity" };
    }
  } catch (_) {}

  return { ok: false };
}

/**
 * When no seed qualifies, pick a random native (shuffled order), require gas then Garden liquidity.
 */
async function resolveConsolidationTargetIfNoSeeds({ supported, gasMap }) {
  const natives = supported.filter(isNativeGasAsset);
  if (!natives.length) {
    return { eligible: false, reason: "no_evm_native_assets" };
  }
  shuffleInPlace(natives);
  const attempts = [];
  for (const asset of natives) {
    const ck = getChainKey(asset.id);
    const gas = checkGasOnChain(gasMap, ck);
    if (!gas.ok) {
      attempts.push({ assetId: asset.id, gasOk: false, liquidityOk: false });
      continue;
    }
    const liq = await checkGardenLiquidityForNative(asset, supported);
    attempts.push({ assetId: asset.id, gasOk: true, liquidityOk: liq.ok, detail: liq });
    if (liq.ok) {
      return {
        eligible: true,
        targetAssetId: asset.id,
        targetName: asset.name || asset.id,
        chainKey: ck,
        gasOk: true,
        liquidityOk: true,
        liquidityDetail: liq,
        attemptsConsidered: attempts.length,
      };
    }
  }
  return { eligible: false, reason: "no_native_passed_gas_and_liquidity", attempts };
}

/**
 * Re-run gas + liquidity checks immediately before the first trade (allChains consolidation path).
 */
async function verifyConsolidationPreflight(consolidation, gasMap) {
  if (!consolidation?.eligible || !consolidation.targetAssetId) {
    return { ok: false, reason: "not_configured" };
  }
  let supported = [];
  try {
    const g = await garden.getAssets();
    supported = g.result || g.assets || g || [];
  } catch (e) {
    return { ok: false, reason: "getAssets_failed" };
  }
  const asset = supported.find((a) => a.id === consolidation.targetAssetId);
  if (!asset) return { ok: false, reason: "asset_missing" };
  const ck = getChainKey(asset.id);
  const gas = checkGasOnChain(gasMap, ck);
  if (!gas.ok) return { ok: false, reason: "gas" };
  const liq = await checkGardenLiquidityForNative(asset, supported);
  if (!liq.ok) return { ok: false, reason: "liquidity" };
  return { ok: true, reason: "ok", liquidityDetail: liq };
}

module.exports = {
  resolveConsolidationTargetIfNoSeeds,
  verifyConsolidationPreflight,
  MIN_GAS_WEI,
  isNativeGasAsset,
};
