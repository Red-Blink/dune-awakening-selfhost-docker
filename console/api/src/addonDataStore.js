import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_KEYS = 2000;
const MAX_VALUE_BYTES = 256 * 1024;
const MAX_STORE_BYTES = 8 * 1024 * 1024;
const addonQueues = new Map();

export function readAddonData(config, addonId, key) {
  const normalizedKey = normalizeKey(key);
  const store = readStore(storePath(config, addonId));
  const entry = Object.prototype.hasOwnProperty.call(store.entries, normalizedKey) ? store.entries[normalizedKey] : null;
  return entry
    ? { found: true, key: normalizedKey, version: entry.version, updatedAt: entry.updatedAt, value: entry.value }
    : { found: false, key: normalizedKey, version: 0, updatedAt: "", value: null };
}

export function listAddonData(config, addonId, { prefix = "" } = {}) {
  const normalizedPrefix = normalizePrefix(prefix);
  const store = readStore(storePath(config, addonId));
  const entries = Object.entries(store.entries)
    .filter(([key]) => key.startsWith(normalizedPrefix))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => ({ key, version: entry.version, updatedAt: entry.updatedAt }));
  return { entries };
}

export function writeAddonData(config, addonId, input, { now = () => new Date() } = {}) {
  return serialize(addonId, () => {
    const key = normalizeKey(input?.key);
    const value = normalizeValue(input?.value);
    const path = storePath(config, addonId);
    const store = readStore(path);
    const previous = Object.prototype.hasOwnProperty.call(store.entries, key) ? store.entries[key] : null;
    assertExpectedVersion(input, previous);
    if (!previous && Object.keys(store.entries).length >= MAX_KEYS) {
      throw new Error(`Addon storage cannot contain more than ${MAX_KEYS} keys.`);
    }
    const entry = {
      version: Number(previous?.version || 0) + 1,
      updatedAt: now().toISOString(),
      value
    };
    const next = { schemaVersion: 1, entries: { ...store.entries, [key]: entry } };
    writeStore(path, next);
    return { ok: true, key, version: entry.version, updatedAt: entry.updatedAt, value: entry.value };
  });
}

export function deleteAddonData(config, addonId, input) {
  return serialize(addonId, () => {
    const key = normalizeKey(input?.key);
    const path = storePath(config, addonId);
    const store = readStore(path);
    const previous = Object.prototype.hasOwnProperty.call(store.entries, key) ? store.entries[key] : null;
    assertExpectedVersion(input, previous);
    if (!previous) return { ok: true, deleted: false, key };
    const entries = { ...store.entries };
    delete entries[key];
    writeStore(path, { schemaVersion: 1, entries });
    return { ok: true, deleted: true, key };
  });
}

function normalizeKey(value) {
  const key = String(value || "").trim();
  if (!KEY_PATTERN.test(key)) throw new Error("Addon storage key must be 1-128 letters, numbers, dots, colons, underscores, or hyphens.");
  return key;
}

function normalizePrefix(value) {
  const prefix = String(value || "").trim();
  if (!prefix) return "";
  if (prefix.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(prefix)) throw new Error("Addon storage prefix is invalid.");
  return prefix;
}

function normalizeValue(value) {
  if (value === undefined) throw new Error("Addon storage value is required.");
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error("Addon storage value must be valid JSON.");
  }
  if (encoded === undefined) throw new Error("Addon storage value must be valid JSON.");
  if (Buffer.byteLength(encoded, "utf8") > MAX_VALUE_BYTES) throw new Error(`Addon storage value cannot exceed ${MAX_VALUE_BYTES} bytes.`);
  return JSON.parse(encoded);
}

function assertExpectedVersion(input, previous) {
  if (!Object.prototype.hasOwnProperty.call(input || {}, "expectedVersion")) return;
  if (input.expectedVersion === null) {
    if (previous) throw Object.assign(new Error("Addon storage value changed. Read it again before saving."), { statusCode: 409 });
    return;
  }
  const expected = Number(input.expectedVersion);
  if (!Number.isInteger(expected) || expected < 1) throw new Error("expectedVersion must be a positive integer or null.");
  if (!previous || Number(previous.version) !== expected) {
    throw Object.assign(new Error("Addon storage value changed. Read it again before saving."), { statusCode: 409 });
  }
}

function storePath(config, addonId) {
  return resolve(config.repoRoot, "runtime/addons/data", addonId, "store.json");
}

function readStore(path) {
  if (!existsSync(path)) return { schemaVersion: 1, entries: {} };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Addon storage is unreadable; refusing to overwrite it.");
  }
  if (Number(parsed?.schemaVersion) !== 1 || !parsed.entries || typeof parsed.entries !== "object" || Array.isArray(parsed.entries)) {
    throw new Error("Addon storage is invalid; refusing to overwrite it.");
  }
  for (const [key, entry] of Object.entries(parsed.entries)) {
    if (!KEY_PATTERN.test(key) || !entry || typeof entry !== "object" || !Number.isInteger(entry.version) || entry.version < 1 || typeof entry.updatedAt !== "string" || !Object.prototype.hasOwnProperty.call(entry, "value")) {
      throw new Error("Addon storage is invalid; refusing to overwrite it.");
    }
  }
  return parsed;
}

function writeStore(path, store) {
  const encoded = `${JSON.stringify(store, null, 2)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > MAX_STORE_BYTES) throw new Error(`Addon storage cannot exceed ${MAX_STORE_BYTES} bytes.`);
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, encoded, { mode: 0o600 });
  renameSync(temporaryPath, path);
}

function serialize(addonId, operation) {
  const previous = addonQueues.get(addonId) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  addonQueues.set(addonId, current);
  return current.finally(() => {
    if (addonQueues.get(addonId) === current) addonQueues.delete(addonId);
  });
}
