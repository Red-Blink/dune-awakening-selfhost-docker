import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildDuneArgs, runDune } from "./runner.js";
import { liveItemGrantWarning } from "./grantResults.js";

const MAX_ADDON_GRANT_QUANTITY = 1000;
const MAX_RECEIPTS_PER_ADDON = 10000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const addonQueues = new Map();

export function normalizeAddonItemGrant(payload = {}) {
  const requestId = String(payload.requestId || "").trim();
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new Error("Addon item grant requestId must be 1-128 letters, numbers, dots, colons, underscores, or hyphens.");

  const playerId = String(payload.playerId || "").trim();
  if (playerId === "*") throw new Error("Addon item grants must target one player.");

  const quantity = Number(payload.quantity ?? 1);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_ADDON_GRANT_QUANTITY) {
    throw new Error(`Addon item grant quantity must be an integer from 1 to ${MAX_ADDON_GRANT_QUANTITY}.`);
  }

  const quality = Number(payload.quality ?? payload.grade ?? 0);
  const command = buildDuneArgs("adminGiveItemId", {
    playerId,
    itemId: payload.itemId,
    quantity,
    quality
  });

  return {
    requestId,
    playerId: command[2],
    itemId: command[3],
    quantity: Number(command[4]),
    quality: Number(command[6]),
    command
  };
}

export function grantAddonItem(config, addonId, payload, { runDuneImpl = runDune, now = () => new Date() } = {}) {
  const grant = normalizeAddonItemGrant(payload);
  const previous = addonQueues.get(addonId) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() => executeGrant(config, addonId, grant, runDuneImpl, now));
  addonQueues.set(addonId, current);
  return current.finally(() => {
    if (addonQueues.get(addonId) === current) addonQueues.delete(addonId);
  });
}

async function executeGrant(config, addonId, grant, runDuneImpl, now) {
  const receiptPath = addonReceiptPath(config, addonId);
  const receipts = readReceipts(receiptPath);
  const existing = receipts.find((receipt) => receipt.requestId === grant.requestId);
  if (existing) {
    assertSameGrant(existing, grant);
    return publicReceipt(existing, true);
  }

  if (!config.mockMode) {
    const result = await runDuneImpl(config, grant.command);
    const warning = liveItemGrantWarning(result);
    if (warning) throw new Error(warning);
  }

  const receipt = {
    requestId: grant.requestId,
    playerId: grant.playerId,
    itemId: grant.itemId,
    quantity: grant.quantity,
    quality: grant.quality,
    grantedAt: now().toISOString()
  };
  writeReceipts(receiptPath, [...receipts, receipt].slice(-MAX_RECEIPTS_PER_ADDON));
  return publicReceipt(receipt, false);
}

function addonReceiptPath(config, addonId) {
  return resolve(config.repoRoot, "runtime/addons/grant-receipts", `${addonId}.json`);
}

function readReceipts(path) {
  if (!existsSync(path)) return [];
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Addon item grant receipts are unreadable; refusing to risk a duplicate grant.");
  }
  if (!Array.isArray(value)) throw new Error("Addon item grant receipts are invalid; refusing to risk a duplicate grant.");
  return value;
}

function writeReceipts(path, receipts) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(receipts, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
}

function assertSameGrant(receipt, grant) {
  if (receipt.playerId !== grant.playerId || receipt.itemId !== grant.itemId || Number(receipt.quantity) !== grant.quantity || Number(receipt.quality) !== grant.quality) {
    throw new Error("Addon item grant requestId was already used with different grant details.");
  }
}

function publicReceipt(receipt, duplicate) {
  return {
    ok: true,
    duplicate,
    requestId: receipt.requestId,
    playerId: receipt.playerId,
    itemId: receipt.itemId,
    quantity: Number(receipt.quantity),
    quality: Number(receipt.quality),
    grantedAt: receipt.grantedAt
  };
}
