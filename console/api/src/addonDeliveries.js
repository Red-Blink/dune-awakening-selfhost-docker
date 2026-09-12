import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const PLAYER_ID_PATTERN = /^[A-Za-z0-9_:#.-]{1,128}$/;
const ITEM_ID_PATTERN = /^[A-Za-z0-9_./:-]{1,240}$/;
const REWARD_TYPES = new Set(["item", "xp", "intel", "currency", "building-unlock"]);
const MAX_TICK_DELIVERIES = 50;
const MAX_DELIVERIES_PER_ADDON = 100_000;
const DEFERRED_RETRY_MS = 30_000;
const queues = new Map();
const deliveryCounts = new Map();

export class AddonDeliveryDeferredError extends Error {
  constructor(message) {
    super(message);
    this.name = "AddonDeliveryDeferredError";
  }
}

export function deferAddonDelivery(message) {
  throw new AddonDeliveryDeferredError(message);
}

export function normalizeAddonReward(input = {}) {
  const type = String(input.type || "").trim().toLowerCase();
  if (!REWARD_TYPES.has(type)) throw new Error("Reward type must be item, xp, intel, currency, or building-unlock.");
  const reward = {
    type,
    playerId: validPlayerId(input.playerId),
    amount: positiveInteger(input.amount ?? input.quantity ?? 1, type === "item" ? 1000 : 1_000_000_000, "reward amount")
  };
  if (type === "item" || type === "building-unlock") reward.itemId = validItemId(input.itemId ?? input.blueprintId);
  if (type === "item") reward.quality = integer(input.quality ?? input.grade ?? 0, 0, 5, "item quality");
  if (type === "currency") reward.currencyId = integer(input.currencyId, 0, 32767, "currencyId");
  if (type === "building-unlock" && reward.amount !== 1) throw new Error("Building unlock rewards must have an amount of 1.");
  return reward;
}

export function normalizeAddonMessage(input = {}) {
  const message = String(input.message || "").trim();
  if (!message || message.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(message)) {
    throw new Error("Player message must be 1-500 printable characters.");
  }
  return { type: "message", playerId: validPlayerId(input.playerId), message };
}

export function createAddonDeliveryService(config, options = {}) {
  const now = options.now || (() => new Date());
  const deliver = options.deliver;
  const canRun = options.canRun || (() => true);
  if (typeof deliver !== "function") throw new Error("Addon delivery service requires a deliver function.");
  const pendingKeys = new Set();
  let pendingLoaded = false;

  async function request(addonId, input, { permission = "rewards:grant", kind = "reward" } = {}) {
    const requestId = validRequestId(input?.requestId);
    const payload = kind === "message" ? normalizeAddonMessage(input) : normalizeAddonReward(input);
    const fingerprint = fingerprintFor({ permission, payload });
    return serialize(deliveryQueueKey(config, addonId, requestId), async () => {
      const path = deliveryPath(config, addonId, requestId);
      const existing = readDelivery(path);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error("Addon delivery requestId was already used with different delivery details.");
        if (existing.status === "delivered") return publicDelivery(existing, true);
        if (existing.status !== "pending") return publicDelivery(existing, false);
        const nextAttemptAt = Date.parse(existing.nextAttemptAt || "");
        if (Number.isFinite(nextAttemptAt) && nextAttemptAt > now().getTime()) return publicDelivery(existing, true);
        return attempt(addonId, path, existing);
      }
      const count = deliveryCount(config, addonId);
      if (count >= MAX_DELIVERIES_PER_ADDON) throw new Error(`Addon delivery history cannot exceed ${MAX_DELIVERIES_PER_ADDON} records.`);
      const stamp = now().toISOString();
      const record = {
        schemaVersion: 1,
        addonId,
        requestId,
        permission,
        fingerprint,
        payload,
        status: "pending",
        attempts: 0,
        createdAt: stamp,
        updatedAt: stamp,
        deliveredAt: "",
        nextAttemptAt: "",
        lastError: "",
        result: null
      };
      writeDelivery(path, record);
      deliveryCounts.set(deliveryCountKey(config, addonId), count + 1);
      pendingKeys.add(pendingKey(addonId, requestId));
      return attempt(addonId, path, record);
    });
  }

  async function attempt(addonId, path, record) {
    if (!canRun(addonId, record.permission)) return publicDelivery(record, false);
    const processing = { ...record, status: "processing", attempts: Number(record.attempts || 0) + 1, updatedAt: now().toISOString(), lastError: "" };
    writeDelivery(path, processing);
    try {
      const result = await deliver(processing.payload, { addonId, requestId: processing.requestId, permission: processing.permission });
      const delivered = { ...processing, status: "delivered", updatedAt: now().toISOString(), deliveredAt: now().toISOString(), result: result ?? { ok: true } };
      writeDelivery(path, delivered);
      pendingKeys.delete(pendingKey(addonId, processing.requestId));
      return publicDelivery(delivered, false);
    } catch (error) {
      if (error instanceof AddonDeliveryDeferredError) {
        const deferredAt = now();
        const pending = { ...processing, status: "pending", updatedAt: deferredAt.toISOString(), nextAttemptAt: new Date(deferredAt.getTime() + DEFERRED_RETRY_MS).toISOString(), lastError: cleanError(error) };
        writeDelivery(path, pending);
        return publicDelivery(pending, false);
      }
      const failed = { ...processing, status: "failed", updatedAt: now().toISOString(), lastError: cleanError(error) };
      writeDelivery(path, failed);
      pendingKeys.delete(pendingKey(addonId, processing.requestId));
      return publicDelivery(failed, false);
    }
  }

  function get(addonId, requestId) {
    const record = readDelivery(deliveryPath(config, addonId, validRequestId(requestId)));
    return record ? publicDelivery(record, false) : null;
  }

  function list(addonId, { status = "", limit = 100 } = {}, { kind = "" } = {}) {
    const normalizedStatus = String(status || "").trim().toLowerCase();
    if (normalizedStatus && !["pending", "processing", "delivered", "failed", "uncertain"].includes(normalizedStatus)) throw new Error("Delivery status filter is invalid.");
    const safeLimit = integer(limit, 1, 500, "delivery limit");
    return listDeliveryRecords(config, addonId)
      .filter((entry) => !normalizedStatus || entry.status === normalizedStatus)
      .filter((entry) => kind !== "message" || entry.payload?.type === "message")
      .filter((entry) => kind !== "reward" || entry.payload?.type !== "message")
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .slice(0, safeLimit)
      .map((entry) => publicDelivery(entry, false));
  }

  async function tick() {
    let attempted = 0;
    const runnable = new Map();
    loadPendingKeys();
    for (const key of [...pendingKeys].sort()) {
      if (attempted >= MAX_TICK_DELIVERIES) return { attempted };
      const [addonId, requestId] = key.split("\0");
      const path = deliveryPath(config, addonId, requestId);
      const record = readDelivery(path);
      if (!record || !["pending", "processing"].includes(record.status)) {
        pendingKeys.delete(key);
        continue;
      }
      const queueKey = deliveryQueueKey(config, addonId, requestId);
      if (record.status === "processing") {
        if (queues.has(queueKey)) continue;
        writeDelivery(path, {
          ...record,
          status: "uncertain",
          updatedAt: now().toISOString(),
          lastError: "Delivery was interrupted while in progress. It was not retried to avoid a duplicate reward."
        });
        pendingKeys.delete(key);
        continue;
      }
      const nextAttemptAt = Date.parse(record.nextAttemptAt || "");
      if (Number.isFinite(nextAttemptAt) && nextAttemptAt > now().getTime()) continue;
      const permissionKey = `${addonId}\0${record.permission}`;
      if (!runnable.has(permissionKey)) runnable.set(permissionKey, Boolean(canRun(addonId, record.permission)));
      if (!runnable.get(permissionKey)) continue;
      attempted += 1;
      await serialize(queueKey, () => attempt(addonId, path, readDelivery(path) || record));
    }
    return { attempted };
  }

  function loadPendingKeys() {
    if (pendingLoaded) return;
    pendingLoaded = true;
    const root = resolve(config.repoRoot, "runtime/addons/deliveries");
    if (!existsSync(root)) return;
    for (const addonId of readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)) {
      for (const record of listDeliveryRecords(config, addonId)) {
        if (record.status === "pending" || record.status === "processing") pendingKeys.add(pendingKey(addonId, record.requestId));
      }
    }
  }

  return { request, get, list, tick };
}

function publicDelivery(record, duplicate) {
  return {
    requestId: record.requestId,
    status: record.status,
    duplicate,
    queued: record.status === "pending",
    attempts: Number(record.attempts || 0),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    deliveredAt: record.deliveredAt || "",
    nextAttemptAt: record.nextAttemptAt || "",
    lastError: record.lastError || "",
    delivery: record.payload,
    result: record.status === "delivered" ? record.result : null
  };
}

function listDeliveryRecords(config, addonId) {
  const root = resolve(config.repoRoot, "runtime/addons/deliveries", addonId);
  if (!existsSync(root)) return [];
  const records = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const record = readDelivery(resolve(root, entry.name));
    if (record) records.push(record);
  }
  return records;
}

function deliveryPath(config, addonId, requestId) {
  return resolve(config.repoRoot, "runtime/addons/deliveries", addonId, `${requestId}.json`);
}

function readDelivery(path) {
  if (!existsSync(path)) return null;
  let record;
  try {
    record = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Addon delivery state is unreadable; refusing to risk a duplicate delivery.");
  }
  const validStatus = ["pending", "processing", "delivered", "failed", "uncertain"].includes(String(record?.status || ""));
  const expectedFingerprint = fingerprintFor({ permission: record?.permission, payload: record?.payload });
  if (Number(record?.schemaVersion) !== 1 || !REQUEST_ID_PATTERN.test(String(record?.requestId || "")) || !validStatus || record.fingerprint !== expectedFingerprint) {
    throw new Error("Addon delivery state is invalid; refusing to risk a duplicate delivery.");
  }
  return record;
}

function writeDelivery(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
}

function serialize(key, operation) {
  const previous = queues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  queues.set(key, current);
  return current.finally(() => {
    if (queues.get(key) === current) queues.delete(key);
  });
}

function validRequestId(value) {
  const requestId = String(value || "").trim();
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new Error("Delivery requestId must be 1-128 letters, numbers, dots, colons, underscores, or hyphens.");
  return requestId;
}

function validPlayerId(value) {
  const playerId = String(value || "").trim();
  if (!PLAYER_ID_PATTERN.test(playerId) || playerId === "*") throw new Error("Delivery must target one valid player ID.");
  return playerId;
}

function validItemId(value) {
  const itemId = String(value || "").trim();
  if (!ITEM_ID_PATTERN.test(itemId)) throw new Error("Reward itemId is invalid.");
  return itemId;
}

function positiveInteger(value, max, label) {
  return integer(value, 1, max, label);
}

function integer(value, min, max, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label} must be an integer from ${min} through ${max}.`);
  return number;
}

function fingerprintFor(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function cleanError(error) {
  return String(error?.message || "Delivery failed.").replace(/[\r\n]+/g, " ").slice(0, 500);
}

function pendingKey(addonId, requestId) {
  return `${addonId}\0${requestId}`;
}

function deliveryCount(config, addonId) {
  const key = deliveryCountKey(config, addonId);
  const root = resolve(config.repoRoot, "runtime/addons/deliveries", addonId);
  if (!existsSync(root)) {
    deliveryCounts.set(key, 0);
    return 0;
  }
  if (deliveryCounts.has(key)) return deliveryCounts.get(key);
  const count = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json")).length;
  deliveryCounts.set(key, count);
  return count;
}

function deliveryCountKey(config, addonId) {
  return `${resolve(config.repoRoot)}\0${addonId}`;
}

function deliveryQueueKey(config, addonId, requestId) {
  return `${resolve(config.repoRoot)}\0${addonId}\0${requestId}`;
}
