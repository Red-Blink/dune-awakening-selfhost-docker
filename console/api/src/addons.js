import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";

export const COMMUNITY_ADDONS_INDEX_URL = "https://raw.githubusercontent.com/Red-Blink/dune-docker-addons/main/index.json";

const MAX_COMMUNITY_ADDONS = 200;
const MAX_ADDON_ARCHIVE_BYTES = 50 * 1024 * 1024;
const COMMUNITY_CACHE_TTL_MS = 5 * 60 * 1000;
const COMMUNITY_CACHE_STALE_MS = 24 * 60 * 60 * 1000;
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_USER_AGENT = "redblink-dune-docker-console";
const ADDON_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const ADDON_LIFECYCLE_STATES = new Set(["active", "deprecated", "unsupported", "removed", "blocked"]);
const INSTALL_BLOCKED_LIFECYCLES = new Set(["unsupported", "removed", "blocked"]);
const RETIRED_CORE_ADDONS = new Map([
  ["eda-exchange-bot", "EDA Exchange Bot has been retired because Market Bot is now built into the console under Exchange."]
]);
const ALLOWED_ADDON_PERMISSIONS = new Set([
  "players:read",
  "ops:read",
  "database:read",
  "database:write",
  "admin:grant-items",
  "rewards:grant",
  "players:message",
  "server:status",
  "server:restart",
  "files:addon-data",
  "broadcast:send",
  "scheduler:server"
]);
const communityCatalogCaches = new WeakMap();

export async function fetchCommunityAddons(fetchImpl = globalThis.fetch, indexUrl = COMMUNITY_ADDONS_INDEX_URL) {
  if (typeof fetchImpl !== "function") throw new Error("Fetch is unavailable in this runtime.");
  const cache = communityCatalogCache(fetchImpl, indexUrl);
  const now = Date.now();
  if (cache.value && cache.expiresAt > now) return cache.value;
  if (cache.inFlight) return cache.inFlight;

  cache.inFlight = refreshCommunityAddons(fetchImpl, indexUrl, cache);
  try {
    return await cache.inFlight;
  } finally {
    cache.inFlight = null;
  }
}

async function refreshCommunityAddons(fetchImpl, indexUrl, cache) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchCommunityJson(fetchImpl, indexUrl, { signal: controller.signal, etag: cache.etag });
    if (response?.status === 304 && cache.value) {
      cache.expiresAt = Date.now() + COMMUNITY_CACHE_TTL_MS;
      cache.staleUntil = Date.now() + COMMUNITY_CACHE_STALE_MS;
      return cache.value;
    }
    if (!response?.ok) throw communityFetchError("Community addons index", response);
    const data = await response.json();
    const index = normalizeCommunityAddonsIndex(data, indexUrl);
    const value = await enrichCommunityAddonSourceUrls(index, fetchImpl, controller.signal);
    cache.value = value;
    cache.etag = responseHeader(response, "etag");
    cache.expiresAt = Date.now() + COMMUNITY_CACHE_TTL_MS;
    cache.staleUntil = Date.now() + COMMUNITY_CACHE_STALE_MS;
    return value;
  } catch (error) {
    if (cache.value && cache.staleUntil > Date.now() && isTransientCommunityFetchError(error)) {
      cache.expiresAt = Date.now() + Math.min(COMMUNITY_CACHE_TTL_MS, retryDelayMs(error));
      return cache.value;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function enrichCommunityAddonSourceUrls(index, fetchImpl, signal) {
  const addons = await Promise.all(index.addons.map(async (addon) => {
    if (addon.sourceUrl && addon.permissions.length) return addon;
    try {
      const response = await fetchCommunityJson(fetchImpl, addon.manifestUrl, { signal });
      if (!response?.ok) {
        const error = communityFetchError("Addon manifest", response);
        if (isTransientCommunityFetchError(error)) throw error;
        return addon;
      }
      const manifest = normalizeCommunityAddonManifest(await response.json());
      return manifest.id === addon.id
        ? {
          ...addon,
          sourceUrl: manifest.sourceUrl,
          permissions: manifest.permissions,
          provenance: communityAddonProvenance(index.sourceUrl, addon, manifest)
        }
        : addon;
    } catch (error) {
      if (isTransientCommunityFetchError(error)) throw error;
      return addon;
    }
  }));
  return { ...index, addons };
}

function communityCatalogCache(fetchImpl, indexUrl) {
  let caches = communityCatalogCaches.get(fetchImpl);
  if (!caches) {
    caches = new Map();
    communityCatalogCaches.set(fetchImpl, caches);
  }
  let cache = caches.get(indexUrl);
  if (!cache) {
    cache = { value: null, etag: "", expiresAt: 0, staleUntil: 0, inFlight: null };
    caches.set(indexUrl, cache);
  }
  return cache;
}

function fetchCommunityJson(fetchImpl, url, { signal, etag = "" } = {}) {
  const githubUrl = githubContentsApiUrl(url);
  const headers = githubUrl
    ? {
      accept: "application/vnd.github.raw+json",
      "user-agent": GITHUB_USER_AGENT,
      "x-github-api-version": GITHUB_API_VERSION
    }
    : { accept: "application/json" };
  const token = String(process.env.DUNE_SELF_UPDATE_TOKEN || "").trim();
  if (githubUrl && token) headers.authorization = `Bearer ${token}`;
  if (etag) headers["if-none-match"] = etag;
  return fetchImpl(githubUrl || url, { headers, signal });
}

function githubContentsApiUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "raw.githubusercontent.com") return "";
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 4) return "";
    const [owner, repository, ref, ...pathParts] = parts;
    if (!owner || !repository || !ref || !pathParts.length) return "";
    const path = pathParts.map(encodeURIComponent).join("/");
    return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/${path}?ref=${encodeURIComponent(ref)}`;
  } catch {
    return "";
  }
}

function communityFetchError(label, response) {
  const status = Number(response?.status || 0);
  const error = new Error(`${label} returned HTTP ${status || "unknown"}.`);
  error.status = status;
  error.retryAfter = responseHeader(response, "retry-after");
  error.rateLimitRemaining = responseHeader(response, "x-ratelimit-remaining");
  error.rateLimitReset = responseHeader(response, "x-ratelimit-reset");
  return error;
}

function responseHeader(response, name) {
  return String(response?.headers?.get?.(name) || "").trim();
}

function isTransientCommunityFetchError(error) {
  const status = Number(error?.status || 0);
  return error?.name === "AbortError"
    || error instanceof TypeError
    || status === 403
    || status === 408
    || status === 425
    || status === 429
    || status >= 500;
}

function retryDelayMs(error) {
  const retryAfterSeconds = Number(error?.retryAfter || 0);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) return retryAfterSeconds * 1000;
  const resetSeconds = Number(error?.rateLimitReset || 0) - Math.floor(Date.now() / 1000);
  if (Number.isFinite(resetSeconds) && resetSeconds > 0) return resetSeconds * 1000;
  return 60 * 1000;
}

export function normalizeCommunityAddonsIndex(data, sourceUrl = COMMUNITY_ADDONS_INDEX_URL) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Community addons index must be a JSON object.");
  if (Number(data.schemaVersion) !== 1) throw new Error("Unsupported community addons index schema version.");
  if (!Array.isArray(data.addons)) throw new Error("Community addons index must include an addons array.");
  if (data.addons.length > MAX_COMMUNITY_ADDONS) throw new Error(`Community addons index cannot list more than ${MAX_COMMUNITY_ADDONS} addons.`);
  const seen = new Set();
  const addons = data.addons.map((addon, index) => normalizeCommunityAddonSummary(addon, index, seen));
  return {
    schemaVersion: 1,
    sourceUrl,
    updatedAt: stringField(data.updatedAt, "updatedAt", { optional: true }),
    addons
  };
}

export function listInstalledAddons(config) {
  const installedRoot = addonsInstalledRoot(config);
  const state = readAddonState(config);
  if (!existsSync(installedRoot)) return { addons: [] };
  const addons = readdirSync(installedRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && ADDON_ID_PATTERN.test(entry.name))
    .map((entry) => {
      try {
        const manifest = normalizeAddonManifest(JSON.parse(readFileSync(resolve(installedRoot, entry.name, "addon.json"), "utf8")));
        const addonState = state[manifest.id] || {};
        const enabled = Boolean(addonState.enabled);
        const approvedPermissions = approvedPermissionsForState(manifest, addonState);
        const lifecycle = normalizeAddonLifecycle(addonState.lifecycle || "active");
        return {
          id: manifest.id,
          name: manifest.name,
          description: manifest.description,
          author: manifest.author,
          version: manifest.version,
          type: manifest.type,
          status: enabled ? "Enabled" : "Disabled",
          enabled,
          lifecycle,
          lifecycleMessage: stringField(addonState.lifecycleMessage, "lifecycleMessage", { optional: true }),
          lifecycleUrl: addonState.lifecycleUrl ? httpsUrl(addonState.lifecycleUrl, "lifecycleUrl") : "",
          entryPath: manifest.entry.path,
          permissions: manifest.permissions,
          approvedPermissions,
          provenance: normalizeAddonProvenance(addonState)
        };
      } catch {
        return {
          id: entry.name,
          name: entry.name,
          description: "",
          author: "",
          version: "",
          type: "",
          status: "Invalid",
          enabled: false,
          entryPath: "",
          permissions: [],
          approvedPermissions: [],
          provenance: {}
        };
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  return { addons };
}

export async function installCommunityAddon(config, addonId, options = {}, fetchImpl = globalThis.fetch, runCommandImpl = runCommand) {
  if (typeof options === "function") {
    fetchImpl = options;
    options = {};
  }
  const requestedId = stringField(addonId, "id");
  if (!ADDON_ID_PATTERN.test(requestedId)) throw new Error("Invalid addon id.");
  assertAddonNotReplacedByCore(requestedId);
  const destination = resolve(addonsInstalledRoot(config), requestedId);
  if (existsSync(destination)) throw new Error(`${requestedId} is already installed. Use Update when a newer catalog version is available.`);

  const prepared = await prepareCommunityAddonRelease(config, requestedId, options, fetchImpl, runCommandImpl);
  const installedAt = new Date().toISOString();
  const stateBeforeInstall = readAddonState(config);
  let packageMoved = false;
  try {
    renameSync(prepared.stagingRoot, destination);
    packageMoved = true;
    setAddonState(config, prepared.installedManifest.id, {
      enabled: false,
      approvedPermissions: prepared.remoteManifest.permissions,
      installedAt,
      sha256: prepared.actualSha,
      provenance: communityAddonProvenance(prepared.index.sourceUrl, prepared.summary, prepared.remoteManifest, {
        sha256: prepared.actualSha,
        installedAt
      }),
      lifecycle: prepared.summary.lifecycle,
      lifecycleMessage: prepared.summary.lifecycleMessage,
      lifecycleUrl: prepared.summary.lifecycleUrl
    });
  } catch (error) {
    rmSync(prepared.stagingRoot, { recursive: true, force: true });
    if (packageMoved) {
      rmSync(destination, { recursive: true, force: true });
      writeAddonState(config, stateBeforeInstall);
    }
    throw error;
  }
  return communityAddonDeploymentResult(prepared, { enabled: false, installedAt });
}

export async function updateCommunityAddon(config, addonId, options = {}, fetchImpl = globalThis.fetch, runCommandImpl = runCommand) {
  if (typeof options === "function") {
    fetchImpl = options;
    options = {};
  }
  const requestedId = stringField(addonId, "id");
  if (!ADDON_ID_PATTERN.test(requestedId)) throw new Error("Invalid addon id.");
  assertAddonNotReplacedByCore(requestedId);
  const installedRoot = addonsInstalledRoot(config);
  const destination = resolve(installedRoot, requestedId);
  const installedManifestPath = resolve(destination, "addon.json");
  if (!existsSync(installedManifestPath)) throw new Error(`Installed addon not found: ${requestedId}`);
  const installedManifestBeforeFetch = normalizeAddonManifest(JSON.parse(readFileSync(installedManifestPath, "utf8")));
  if (installedManifestBeforeFetch.id !== requestedId) throw new Error("Installed addon package id does not match its directory.");

  const prepared = await prepareCommunityAddonRelease(config, requestedId, options, fetchImpl, runCommandImpl);
  if (!existsSync(installedManifestPath)) {
    rmSync(prepared.stagingRoot, { recursive: true, force: true });
    throw new Error(`Installed addon was removed while its update was being prepared: ${requestedId}`);
  }
  const previousManifest = normalizeAddonManifest(JSON.parse(readFileSync(installedManifestPath, "utf8")));
  if (previousManifest.id !== requestedId) {
    rmSync(prepared.stagingRoot, { recursive: true, force: true });
    throw new Error("Installed addon package id changed while its update was being prepared.");
  }
  if (compareAddonVersions(prepared.remoteManifest.version, previousManifest.version) <= 0) {
    rmSync(prepared.stagingRoot, { recursive: true, force: true });
    throw new Error(`${previousManifest.name} ${previousManifest.version} is already current; catalog version is ${prepared.remoteManifest.version}.`);
  }

  const stateBeforeUpdate = readAddonState(config);
  const previousState = stateBeforeUpdate[requestedId] || {};
  const wasEnabled = Boolean(previousState.enabled);
  const updatedAt = new Date().toISOString();
  const rollbackRoot = resolve(addonsRoot(config), "staging", `${requestedId}-rollback-${Date.now()}`);
  rmSync(rollbackRoot, { recursive: true, force: true });
  let originalMoved = false;
  try {
    renameSync(destination, rollbackRoot);
    originalMoved = true;
    renameSync(prepared.stagingRoot, destination);
    setAddonState(config, requestedId, {
      ...previousState,
      enabled: wasEnabled,
      approvedPermissions: prepared.remoteManifest.permissions,
      installedAt: previousState.installedAt || previousState.provenance?.installedAt || updatedAt,
      updatedAt,
      sha256: prepared.actualSha,
      provenance: communityAddonProvenance(prepared.index.sourceUrl, prepared.summary, prepared.remoteManifest, {
        sha256: prepared.actualSha,
        installedAt: updatedAt
      }),
      lifecycle: prepared.summary.lifecycle,
      lifecycleMessage: prepared.summary.lifecycleMessage,
      lifecycleUrl: prepared.summary.lifecycleUrl
    });
  } catch (error) {
    rmSync(prepared.stagingRoot, { recursive: true, force: true });
    if (originalMoved) {
      rmSync(destination, { recursive: true, force: true });
      if (existsSync(rollbackRoot)) renameSync(rollbackRoot, destination);
      writeAddonState(config, stateBeforeUpdate);
    }
    throw error;
  }
  rmSync(rollbackRoot, { recursive: true, force: true });
  return {
    ...communityAddonDeploymentResult(prepared, { enabled: wasEnabled, installedAt: updatedAt }),
    previousVersion: previousManifest.version,
    preservedConfiguration: true
  };
}

async function prepareCommunityAddonRelease(config, requestedId, options, fetchImpl, runCommandImpl) {
  const index = await fetchCommunityAddons(fetchImpl);
  const summary = index.addons.find((addon) => addon.id === requestedId);
  if (!summary) throw new Error(`Community addon not found: ${requestedId}`);
  assertCommunityAddonInstallable(summary);
  const manifestResponse = await fetchCommunityJson(fetchImpl, summary.manifestUrl);
  if (!manifestResponse?.ok) throw new Error(`Addon manifest returned HTTP ${manifestResponse?.status || "unknown"}.`);
  const remoteManifest = normalizeCommunityAddonManifest(await manifestResponse.json());
  if (remoteManifest.id !== summary.id) throw new Error("Addon manifest id does not match the community index entry.");
  if (remoteManifest.version !== summary.version) throw new Error("Addon manifest version does not match the community index entry.");
  const approvedPermissions = normalizeAddonPermissions(options.approvedPermissions || []);
  requireApprovedPermissions(remoteManifest.permissions, approvedPermissions);
  const archive = await downloadAddonArchive(fetchImpl, remoteManifest.downloadUrl);
  const actualSha = createHash("sha256").update(archive).digest("hex");
  if (actualSha.toLowerCase() !== remoteManifest.sha256.toLowerCase()) throw new Error("Addon archive SHA-256 does not match the community manifest.");

  const addonRoot = addonsRoot(config);
  const downloadsRoot = resolve(addonRoot, "downloads");
  const stagingRoot = resolve(addonRoot, "staging", `${remoteManifest.id}-${Date.now()}`);
  const installedRoot = addonsInstalledRoot(config);
  const archivePath = resolve(downloadsRoot, `${remoteManifest.id}-${remoteManifest.version}.zip`);
  mkdirSync(downloadsRoot, { recursive: true });
  mkdirSync(dirname(stagingRoot), { recursive: true });
  mkdirSync(installedRoot, { recursive: true });
  writeFileSync(archivePath, archive, { mode: 0o600 });

  try {
    const entries = (await runCommandImpl("unzip", ["-Z1", archivePath])).stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    validateZipEntries(entries);
    rmSync(stagingRoot, { recursive: true, force: true });
    mkdirSync(stagingRoot, { recursive: true });
    await runCommandImpl("unzip", ["-q", archivePath, "-d", stagingRoot]);

    const installedManifest = normalizeAddonManifest(JSON.parse(readFileSync(resolve(stagingRoot, "addon.json"), "utf8")));
    if (installedManifest.id !== remoteManifest.id) throw new Error("Installed addon package id does not match the community manifest.");
    if (installedManifest.version !== remoteManifest.version) throw new Error("Installed addon package version does not match the community manifest.");
    if (JSON.stringify(installedManifest.permissions) !== JSON.stringify(remoteManifest.permissions)) throw new Error("Installed addon package permissions do not match the community manifest.");
    const entryPath = safeAddonRelativePath(installedManifest.entry.path, "entry.path");
    if (!existsSync(resolve(stagingRoot, entryPath))) throw new Error("Installed addon package entry path was not found.");
    return { index, summary, remoteManifest, installedManifest, stagingRoot, actualSha };
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

function communityAddonDeploymentResult(prepared, { enabled, installedAt }) {
  return {
    ok: true,
    addon: {
      id: prepared.installedManifest.id,
      name: prepared.installedManifest.name,
      description: prepared.installedManifest.description,
      author: prepared.installedManifest.author,
      version: prepared.installedManifest.version,
      type: prepared.installedManifest.type,
      status: enabled ? "Enabled" : "Disabled",
      enabled,
      lifecycle: prepared.summary.lifecycle,
      lifecycleMessage: prepared.summary.lifecycleMessage,
      lifecycleUrl: prepared.summary.lifecycleUrl,
      entryPath: prepared.installedManifest.entry.path,
      permissions: prepared.installedManifest.permissions,
      approvedPermissions: prepared.remoteManifest.permissions,
      provenance: communityAddonProvenance(prepared.index.sourceUrl, prepared.summary, prepared.remoteManifest, {
        sha256: prepared.actualSha,
        installedAt
      })
    },
    sha256: prepared.actualSha
  };
}

export function compareAddonVersions(leftValue, rightValue) {
  const left = parseAddonVersion(leftValue);
  const right = parseAddonVersion(rightValue);
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] > right.core[index]) return 1;
    if (left.core[index] < right.core[index]) return -1;
  }
  if (!left.prerelease.length && !right.prerelease.length) return 0;
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^[0-9]+$/.test(leftPart);
    const rightNumeric = /^[0-9]+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return BigInt(leftPart) > BigInt(rightPart) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart.localeCompare(rightPart) > 0 ? 1 : -1;
  }
  return 0;
}

function parseAddonVersion(value) {
  const version = stringField(value, "version");
  const match = version.match(/^(?:v)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!match) throw new Error(`Addon version must use semantic versioning: ${version}`);
  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease: match[4] ? match[4].split(".") : []
  };
}

export function setInstalledAddonEnabled(config, addonId, enabled) {
  const id = normalizeAddonId(addonId);
  const addonPath = resolve(addonsInstalledRoot(config), id, "addon.json");
  if (!existsSync(addonPath)) throw new Error(`Installed addon not found: ${id}`);
  const manifest = normalizeAddonManifest(JSON.parse(readFileSync(addonPath, "utf8")));
  const addonState = readAddonState(config)[id] || {};
  if (enabled) assertInstalledAddonRunnable(id, addonState);
  const approvedPermissions = approvedPermissionsForState(manifest, addonState);
  if (enabled) requireApprovedPermissions(manifest.permissions, approvedPermissions);
  setAddonEnabled(config, id, enabled);
  return {
    ok: true,
    addon: {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      author: manifest.author,
      version: manifest.version,
      type: manifest.type,
      status: enabled ? "Enabled" : "Disabled",
      enabled: Boolean(enabled),
      lifecycle: normalizeAddonLifecycle(addonState.lifecycle || "active"),
      lifecycleMessage: stringField(addonState.lifecycleMessage, "lifecycleMessage", { optional: true }),
      lifecycleUrl: addonState.lifecycleUrl ? httpsUrl(addonState.lifecycleUrl, "lifecycleUrl") : "",
      entryPath: manifest.entry.path,
      permissions: manifest.permissions,
      approvedPermissions,
      provenance: normalizeAddonProvenance(addonState)
    }
  };
}

export function removeInstalledAddon(config, addonId) {
  const id = normalizeAddonId(addonId);
  const addonDir = resolve(addonsInstalledRoot(config), id);
  if (!existsSync(addonDir)) throw new Error(`Installed addon not found: ${id}`);
  removeAddonJobState(config, id);
  removeAddonOwnedState(config, id);
  rmSync(addonDir, { recursive: true, force: true });
  const state = readAddonState(config);
  delete state[id];
  writeAddonState(config, state);
  return { ok: true, id };
}

function removeAddonOwnedState(config, addonId) {
  for (const relativePath of [
    `runtime/addons/data/${addonId}`,
    `runtime/addons/deliveries/${addonId}`,
    `runtime/addons/grant-receipts/${addonId}.json`
  ]) {
    const target = resolve(config.repoRoot, relativePath);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  }
}

function removeAddonJobState(config, addonId) {
  const addonJobsDir = resolve(config.repoRoot, "runtime/addons/jobs", addonId);
  if (existsSync(addonJobsDir)) rmSync(addonJobsDir, { recursive: true, force: true });
}

export function installedAddonContentPath(config, addonId, contentPath) {
  const id = normalizeAddonId(addonId);
  const state = readAddonState(config);
  if (!state[id]?.enabled) throw new Error(`Installed addon is disabled: ${id}`);
  assertInstalledAddonRunnable(id, state[id]);
  const root = resolve(addonsInstalledRoot(config), id);
  const target = resolve(root, safeAddonRelativePath(contentPath, "content path"));
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || resolve(root, rel) !== target) throw new Error("Addon content path is unsafe.");
  return target;
}

export function assertInstalledAddonPermission(config, addonId, permission) {
  const id = normalizeAddonId(addonId);
  const requestedPermission = normalizeAddonPermission(permission);
  const addonPath = resolve(addonsInstalledRoot(config), id, "addon.json");
  if (!existsSync(addonPath)) throw new Error(`Installed addon not found: ${id}`);
  const manifest = normalizeAddonManifest(JSON.parse(readFileSync(addonPath, "utf8")));
  const state = readAddonState(config)[id] || {};
  if (!state.enabled) throw new Error(`Installed addon is disabled: ${id}`);
  assertInstalledAddonRunnable(id, state);
  if (!manifest.permissions.includes(requestedPermission)) throw new Error(`${manifest.name} did not request ${requestedPermission} permission.`);
  const approvedPermissions = approvedPermissionsForState(manifest, state);
  if (!approvedPermissions.includes(requestedPermission)) throw new Error(`${manifest.name} is not approved for ${requestedPermission} permission.`);
  return { id, manifest, permission: requestedPermission };
}

export function normalizeCommunityAddonManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Addon manifest must be a JSON object.");
  if (Number(manifest.schemaVersion ?? 1) !== 1) throw new Error("Unsupported addon manifest schema version.");
  const id = stringField(manifest.id, "id");
  if (!ADDON_ID_PATTERN.test(id)) throw new Error("Addon manifest id is invalid.");
  const type = stringField(manifest.type, "type");
  if (type !== "ui") throw new Error("Only ui addons are supported right now.");
  const permissions = normalizeAddonPermissions(manifest.permissions || []);
  return {
    schemaVersion: 1,
    id,
    name: stringField(manifest.name, "name"),
    description: stringField(manifest.description, "description", { optional: true }),
    author: stringField(manifest.author, "author", { optional: true }),
    version: stringField(manifest.version, "version"),
    type,
    sourceUrl: httpsUrl(manifest.sourceUrl, "sourceUrl"),
    downloadUrl: httpsUrl(manifest.downloadUrl, "downloadUrl"),
    sha256: sha256Field(manifest.sha256),
    permissions
  };
}

export function normalizeAddonManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Addon manifest must be a JSON object.");
  if (Number(manifest.schemaVersion ?? 1) !== 1) throw new Error("Unsupported addon manifest schema version.");
  const id = stringField(manifest.id, "id");
  if (!ADDON_ID_PATTERN.test(id)) throw new Error("Addon manifest id is invalid.");
  const type = stringField(manifest.type, "type");
  if (type !== "ui") throw new Error("Only ui addons are supported right now.");
  const entry = manifest.entry && typeof manifest.entry === "object" && !Array.isArray(manifest.entry) ? manifest.entry : {};
  const permissions = normalizeAddonPermissions(manifest.permissions || []);
  return {
    schemaVersion: 1,
    id,
    name: stringField(manifest.name, "name"),
    description: stringField(manifest.description, "description", { optional: true }),
    author: stringField(manifest.author, "author", { optional: true }),
    version: stringField(manifest.version, "version"),
    type,
    entry: {
      navigation: stringField(entry.navigation, "entry.navigation", { optional: true }),
      path: safeAddonRelativePath(entry.path, "entry.path")
    },
    permissions
  };
}

export function validateZipEntries(entries) {
  if (!entries.includes("addon.json")) throw new Error("Addon archive must contain addon.json at the root.");
  for (const entry of entries) {
    safeAddonRelativePath(entry, "zip entry");
  }
  return true;
}

function normalizeCommunityAddonSummary(addon, index, seen) {
  if (!addon || typeof addon !== "object" || Array.isArray(addon)) throw new Error(`Addon entry ${index + 1} must be an object.`);
  const id = stringField(addon.id, "id");
  if (!ADDON_ID_PATTERN.test(id)) throw new Error(`Addon entry ${index + 1} has an invalid id.`);
  if (seen.has(id)) throw new Error(`Duplicate addon id: ${id}`);
  seen.add(id);
  const summary = {
    id,
    name: stringField(addon.name, "name"),
    description: stringField(addon.description, "description", { optional: true }),
    author: stringField(addon.author, "author", { optional: true }),
    version: stringField(addon.version, "version"),
    sourceUrl: addon.sourceUrl ? httpsUrl(addon.sourceUrl, "sourceUrl") : "",
    manifestUrl: httpsUrl(addon.manifestUrl, "manifestUrl"),
    lifecycle: normalizeAddonLifecycle(addon.lifecycle || "active"),
    lifecycleMessage: stringField(addon.lifecycleMessage || addon.lifecycleReason, "lifecycleMessage", { optional: true }),
    lifecycleUrl: addon.lifecycleUrl ? httpsUrl(addon.lifecycleUrl, "lifecycleUrl") : "",
    permissions: normalizeAddonPermissions(addon.permissions || [])
  };
  return {
    ...summary,
    provenance: addon.provenance ? normalizeAddonProvenance({ provenance: addon.provenance }) : {}
  };
}

function communityAddonProvenance(indexUrl, summary, manifest, { sha256 = manifest.sha256, installedAt = "" } = {}) {
  return normalizeAddonProvenance({
    provenance: {
      indexUrl,
      manifestUrl: summary.manifestUrl,
      sourceUrl: manifest.sourceUrl,
      downloadUrl: manifest.downloadUrl,
      version: manifest.version,
      sha256,
      installedAt
    }
  });
}

export function normalizeAddonProvenance(state = {}) {
  const value = state.provenance && typeof state.provenance === "object" && !Array.isArray(state.provenance)
    ? state.provenance
    : state;
  const provenance = {
    indexUrl: value.indexUrl ? httpsUrl(value.indexUrl, "provenance.indexUrl") : "",
    manifestUrl: value.manifestUrl ? httpsUrl(value.manifestUrl, "provenance.manifestUrl") : "",
    sourceUrl: value.sourceUrl ? httpsUrl(value.sourceUrl, "provenance.sourceUrl") : "",
    downloadUrl: value.downloadUrl ? httpsUrl(value.downloadUrl, "provenance.downloadUrl") : "",
    version: value.version ? stringField(value.version, "provenance.version") : "",
    sha256: value.sha256 ? sha256Field(value.sha256) : "",
    installedAt: value.installedAt ? stringField(value.installedAt, "provenance.installedAt") : ""
  };
  return Object.fromEntries(Object.entries(provenance).filter(([, fieldValue]) => fieldValue));
}

export function syncInstalledAddonLifecycle(config, communityIndex) {
  if (!Array.isArray(communityIndex?.addons)) return { updated: false };
  const installedRoot = addonsInstalledRoot(config);
  if (!existsSync(installedRoot)) return { updated: false };
  const communityById = new Map(communityIndex.addons.map((addon) => [addon.id, addon]));
  const state = readAddonState(config);
  let updated = false;
  for (const entry of readdirSync(installedRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !ADDON_ID_PATTERN.test(entry.name)) continue;
    const addon = communityById.get(entry.name);
    const lifecycle = addon ? addon.lifecycle : "removed";
    const lifecycleMessage = addon ? addon.lifecycleMessage : "This addon is no longer listed in the community catalog.";
    const lifecycleUrl = addon ? addon.lifecycleUrl : "";
    const previous = state[entry.name] || {};
    if (previous.lifecycle !== lifecycle || previous.lifecycleMessage !== lifecycleMessage || previous.lifecycleUrl !== lifecycleUrl) {
      state[entry.name] = { ...previous, lifecycle, lifecycleMessage, lifecycleUrl };
      updated = true;
    }
    if (lifecycle === "blocked" && previous.enabled) {
      state[entry.name] = { ...state[entry.name], enabled: false };
      updated = true;
    }
  }
  if (updated) writeAddonState(config, state);
  return { updated };
}

export function normalizeAddonPermissions(value) {
  const raw = [];
  if (Array.isArray(value)) {
    raw.push(...value);
  } else if (value && typeof value === "object") {
    for (const [category, actions] of Object.entries(value)) {
      if (!Array.isArray(actions)) throw new Error(`Addon permissions.${category} must be an array.`);
      for (const action of actions) raw.push(`${category}:${action}`);
    }
  } else if (value !== undefined && value !== null) {
    throw new Error("Addon permissions must be an array or object.");
  }
  return Array.from(new Set(raw.map((permission) => normalizeAddonPermission(permission)))).sort();
}

function normalizeAddonPermission(value) {
  const permission = stringField(value, "permission").toLowerCase();
  if (!/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/.test(permission)) throw new Error(`Addon permission is invalid: ${permission}`);
  if (!ALLOWED_ADDON_PERMISSIONS.has(permission)) throw new Error(`Addon permission is not supported yet: ${permission}`);
  return permission;
}

function requireApprovedPermissions(requested, approved) {
  const approvedSet = new Set(normalizeAddonPermissions(approved));
  const missing = normalizeAddonPermissions(requested).filter((permission) => !approvedSet.has(permission));
  if (missing.length) throw new Error(`Addon permissions must be approved before install or enable: ${missing.join(", ")}`);
}

function assertCommunityAddonInstallable(addon) {
  const lifecycle = normalizeAddonLifecycle(addon.lifecycle || "active");
  if (INSTALL_BLOCKED_LIFECYCLES.has(lifecycle)) {
    throw new Error(`${addon.name || addon.id} cannot be installed because its community status is ${formatLifecycleLabel(lifecycle)}.`);
  }
}

function assertAddonNotReplacedByCore(id) {
  const message = RETIRED_CORE_ADDONS.get(id);
  if (message) throw new Error(message);
}

function assertInstalledAddonRunnable(id, state = {}) {
  const lifecycle = normalizeAddonLifecycle(state.lifecycle || "active");
  if (lifecycle === "blocked") throw new Error(`Installed addon is blocked and cannot be enabled or opened: ${id}`);
}

function normalizeAddonLifecycle(value) {
  const lifecycle = String(value || "active").trim().toLowerCase();
  if (!ADDON_LIFECYCLE_STATES.has(lifecycle)) throw new Error(`Unsupported addon lifecycle state: ${lifecycle}`);
  return lifecycle;
}

function formatLifecycleLabel(value) {
  return String(value || "").replaceAll("-", " ");
}

function approvedPermissionsForState(manifest, state = {}) {
  if (Array.isArray(state.approvedPermissions)) return normalizeAddonPermissions(state.approvedPermissions);
  return state.enabled ? normalizeAddonPermissions(manifest.permissions) : [];
}

function stringField(value, name, { optional = false } = {}) {
  const text = String(value ?? "").trim();
  if (!text && optional) return "";
  if (!text) throw new Error(`Addon ${name} is required.`);
  if (text.length > 500) throw new Error(`Addon ${name} is too long.`);
  return text;
}

function httpsUrl(value, name) {
  const text = stringField(value, name);
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`Addon ${name} must be a valid URL.`);
  }
  if (parsed.protocol !== "https:") throw new Error(`Addon ${name} must use HTTPS.`);
  return parsed.toString();
}

function sha256Field(value) {
  const text = stringField(value, "sha256").toLowerCase();
  if (!SHA256_PATTERN.test(text)) throw new Error("Addon sha256 must be a 64-character hex string.");
  return text;
}

function normalizeAddonId(value) {
  const id = stringField(value, "id");
  if (!ADDON_ID_PATTERN.test(id)) throw new Error("Invalid addon id.");
  return id;
}

function safeAddonRelativePath(value, name) {
  const text = stringField(value, name);
  const normalized = text.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.includes("\0")) throw new Error(`Addon ${name} is unsafe.`);
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) throw new Error(`Addon ${name} is unsafe.`);
  if (parts.some((part) => part !== basename(part))) throw new Error(`Addon ${name} is unsafe.`);
  if (normalized.length > 500) throw new Error(`Addon ${name} is too long.`);
  return parts.join("/");
}

async function downloadAddonArchive(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { accept: "application/zip, application/octet-stream" } });
  if (!response?.ok) throw new Error(`Addon archive returned HTTP ${response?.status || "unknown"}.`);
  const contentLength = Number(response.headers?.get?.("content-length") || 0);
  if (contentLength > MAX_ADDON_ARCHIVE_BYTES) throw new Error("Addon archive is too large.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error("Addon archive is empty.");
  if (buffer.length > MAX_ADDON_ARCHIVE_BYTES) throw new Error("Addon archive is too large.");
  return buffer;
}

function addonsRoot(config) {
  return resolve(config.repoRoot, "runtime", "addons");
}

function addonsInstalledRoot(config) {
  return resolve(addonsRoot(config), "installed");
}

function addonStatePath(config) {
  return resolve(addonsRoot(config), "state.json");
}

function readAddonState(config) {
  try {
    const state = JSON.parse(readFileSync(addonStatePath(config), "utf8"));
    return state && typeof state === "object" && !Array.isArray(state) ? state : {};
  } catch {
    return {};
  }
}

function writeAddonState(config, state) {
  const file = addonStatePath(config);
  mkdirSync(dirname(file), { recursive: true });
  const temporaryFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryFile, file);
  } finally {
    rmSync(temporaryFile, { force: true });
  }
}

function setAddonEnabled(config, addonId, enabled) {
  const state = readAddonState(config);
  state[addonId] = { ...(state[addonId] || {}), enabled: Boolean(enabled) };
  writeAddonState(config, state);
}

function setAddonState(config, addonId, nextState) {
  const state = readAddonState(config);
  state[addonId] = { ...(state[addonId] || {}), ...nextState };
  writeAddonState(config, state);
}

function runCommand(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(stderr || stdout || `${command} failed with exit ${code}`));
    });
  });
}
