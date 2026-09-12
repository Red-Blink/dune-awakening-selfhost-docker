import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertInstalledAddonPermission, compareAddonVersions, fetchCommunityAddons, installCommunityAddon, installedAddonContentPath, listInstalledAddons, normalizeAddonManifest, normalizeAddonPermissions, normalizeAddonProvenance, normalizeCommunityAddonManifest, normalizeCommunityAddonsIndex, removeInstalledAddon, setInstalledAddonEnabled, syncInstalledAddonLifecycle, updateCommunityAddon, validateZipEntries } from "../src/addons.js";

test("blocks install and update of EDA after Market Bot becomes core", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-retired-addon-"));
  try {
    const config = { repoRoot };
    await assert.rejects(
      installCommunityAddon(config, "eda-exchange-bot", {}, async () => { throw new Error("fetch should not run"); }),
      /retired.*built into the console/i
    );
    await assert.rejects(
      updateCommunityAddon(config, "eda-exchange-bot", {}, async () => { throw new Error("fetch should not run"); }),
      /retired.*built into the console/i
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("normalizes community addons index summaries", () => {
  const result = normalizeCommunityAddonsIndex({
    schemaVersion: 1,
    updatedAt: "2026-06-15T00:00:00Z",
    addons: [{
      id: "leadership-board-demo",
      name: "Leadership Board Demo",
      description: "Demo addon.",
      author: "Red-Blink",
      version: "1.0.0",
      lifecycle: "deprecated",
      lifecycleMessage: "Maintenance only.",
      lifecycleUrl: "https://example.test/addons/leadership-board-demo",
      manifestUrl: "https://raw.githubusercontent.com/Red-Blink/dune-docker-addons/main/addons/leadership-board-demo.json"
    }]
  }, "https://example.test/index.json");
  assert.equal(result.sourceUrl, "https://example.test/index.json");
  assert.equal(result.addons.length, 1);
  assert.equal(result.addons[0].id, "leadership-board-demo");
  assert.equal(result.addons[0].lifecycle, "deprecated");
  assert.equal(result.addons[0].lifecycleMessage, "Maintenance only.");
});

test("rejects unsafe or malformed community addon entries", () => {
  assert.throws(() => normalizeCommunityAddonsIndex({ schemaVersion: 1, addons: [{ id: "../bad", name: "Bad", version: "1", manifestUrl: "https://example.test/a.json" }] }), /invalid id/);
  assert.throws(() => normalizeCommunityAddonsIndex({ schemaVersion: 1, addons: [{ id: "good-addon", name: "Bad", version: "1", manifestUrl: "http://example.test/a.json" }] }), /HTTPS/);
  assert.throws(() => normalizeCommunityAddonsIndex({ schemaVersion: 1, addons: [{ id: "good-addon", name: "Bad", version: "1", lifecycle: "invalid-lifecycle", manifestUrl: "https://example.test/a.json" }] }), /Unsupported addon lifecycle/);
  assert.throws(() => normalizeCommunityAddonsIndex({ schemaVersion: 2, addons: [] }), /Unsupported/);
});

test("fetches and validates community addons with injected fetch", async () => {
  const result = await fetchCommunityAddons(async (url) => ({
    ok: true,
    status: 200,
    async json() {
      if (String(url).endsWith("/demo.json")) {
        return {
          id: "demo-addon",
          name: "Demo",
          version: "1.0.0",
          type: "ui",
          sourceUrl: "https://github.com/Red-Blink/demo-addon",
          downloadUrl: "https://github.com/Red-Blink/demo-addon/releases/download/v1.0.0/demo.zip",
          sha256: "862cbb38adab95ffc7b584aa374d3a1fb4437cf33f0360e3a8f5120ab83e4bd4",
          permissions: []
        };
      }
      return {
        schemaVersion: 1,
        addons: [{ id: "demo-addon", name: "Demo", version: "1.0.0", manifestUrl: "https://example.test/demo.json" }]
      };
    },
    url
  }), "https://example.test/index.json");
  assert.equal(result.addons[0].name, "Demo");
  assert.equal(result.addons[0].sourceUrl, "https://github.com/Red-Blink/demo-addon");
  assert.deepEqual(result.addons[0].provenance, {
    indexUrl: "https://example.test/index.json",
    manifestUrl: "https://example.test/demo.json",
    sourceUrl: "https://github.com/Red-Blink/demo-addon",
    downloadUrl: "https://github.com/Red-Blink/demo-addon/releases/download/v1.0.0/demo.zip",
    version: "1.0.0",
    sha256: "862cbb38adab95ffc7b584aa374d3a1fb4437cf33f0360e3a8f5120ab83e4bd4"
  });
});

test("uses the authenticated GitHub contents API for raw catalog files", async () => {
  const previousToken = process.env.DUNE_SELF_UPDATE_TOKEN;
  process.env.DUNE_SELF_UPDATE_TOKEN = "catalog-test-token";
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => name.toLowerCase() === "etag" ? '"catalog-v1"' : "" },
      json: async () => ({ schemaVersion: 1, addons: [] })
    };
  };
  try {
    await fetchCommunityAddons(fetchImpl);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.github.com/repos/Red-Blink/dune-docker-addons/contents/index.json?ref=main");
    assert.equal(requests[0].options.headers.authorization, "Bearer catalog-test-token");
    assert.equal(requests[0].options.headers.accept, "application/vnd.github.raw+json");
    assert.equal(requests[0].options.headers["x-github-api-version"], "2022-11-28");
    assert.equal(requests[0].options.headers["user-agent"], "redblink-dune-docker-console");
  } finally {
    if (previousToken === undefined) delete process.env.DUNE_SELF_UPDATE_TOKEN;
    else process.env.DUNE_SELF_UPDATE_TOKEN = previousToken;
  }
});

test("deduplicates concurrent community catalog reads and caches validated results", async () => {
  let requestCount = 0;
  const fetchImpl = async () => {
    requestCount += 1;
    await Promise.resolve();
    return {
      ok: true,
      status: 200,
      headers: { get: () => "" },
      json: async () => ({ schemaVersion: 1, updatedAt: "2026-08-17T00:00:00Z", addons: [] })
    };
  };
  const [first, second] = await Promise.all([
    fetchCommunityAddons(fetchImpl, "https://example.test/index.json"),
    fetchCommunityAddons(fetchImpl, "https://example.test/index.json")
  ]);
  const third = await fetchCommunityAddons(fetchImpl, "https://example.test/index.json");
  assert.equal(requestCount, 1);
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
});

test("revalidates the catalog with ETags and serves validated stale data on HTTP 429", async () => {
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  let mode = "fresh";
  const requests = [];
  Date.now = () => now;
  const fetchImpl = async (_url, options) => {
    requests.push(options);
    if (mode === "not-modified") {
      return { ok: false, status: 304, headers: { get: () => "" } };
    }
    if (mode === "limited") {
      return {
        ok: false,
        status: 429,
        headers: { get: (name) => name.toLowerCase() === "retry-after" ? "120" : "" }
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => name.toLowerCase() === "etag" ? '"catalog-v1"' : "" },
      json: async () => ({ schemaVersion: 1, updatedAt: "2026-08-17T00:00:00Z", addons: [] })
    };
  };
  try {
    const fresh = await fetchCommunityAddons(fetchImpl, "https://example.test/index.json");
    now += 5 * 60 * 1000 + 1;
    mode = "not-modified";
    const revalidated = await fetchCommunityAddons(fetchImpl, "https://example.test/index.json");
    assert.equal(requests[1].headers["if-none-match"], '"catalog-v1"');
    assert.deepEqual(revalidated, fresh);

    now += 5 * 60 * 1000 + 1;
    mode = "limited";
    const stale = await fetchCommunityAddons(fetchImpl, "https://example.test/index.json");
    assert.deepEqual(stale, fresh);
    assert.equal(requests.length, 3);
  } finally {
    Date.now = originalNow;
  }
});

test("never sends the GitHub token to addon release downloads", async () => {
  const previousToken = process.env.DUNE_SELF_UPDATE_TOKEN;
  process.env.DUNE_SELF_UPDATE_TOKEN = "catalog-test-token";
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-addon-token-scope-"));
  const archive = Buffer.from("verified addon archive");
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const text = String(url);
    requests.push({ url: text, options });
    if (text.endsWith(".zip")) return { ok: true, status: 200, headers: { get: () => "" }, arrayBuffer: async () => archive };
    if (text.includes("/contents/addons/demo-addon.json")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "" },
        json: async () => ({
          id: "demo-addon",
          name: "Demo Addon",
          version: "1.0.0",
          type: "ui",
          sourceUrl: "https://github.com/example/demo-addon",
          downloadUrl: "https://github.com/example/demo-addon/releases/download/v1.0.0/demo-addon.zip",
          sha256,
          permissions: []
        })
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => "" },
      json: async () => ({
        schemaVersion: 1,
        addons: [{
          id: "demo-addon",
          name: "Demo Addon",
          version: "1.0.0",
          sourceUrl: "https://github.com/example/demo-addon",
          permissions: [],
          manifestUrl: "https://raw.githubusercontent.com/example/demo-addon/main/addons/demo-addon.json"
        }]
      })
    };
  };
  try {
    await installCommunityAddon({ repoRoot }, "demo-addon", { approvedPermissions: [] }, fetchImpl, addonArchiveRunner("demo-addon", "1.0.0", []));
    const githubApiRequests = requests.filter((request) => request.url.startsWith("https://api.github.com/"));
    const downloadRequest = requests.find((request) => request.url.endsWith(".zip"));
    assert(githubApiRequests.length >= 2);
    assert(githubApiRequests.every((request) => request.options.headers.authorization === "Bearer catalog-test-token"));
    assert(downloadRequest);
    assert.equal(downloadRequest.options.headers.authorization, undefined);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    if (previousToken === undefined) delete process.env.DUNE_SELF_UPDATE_TOKEN;
    else process.env.DUNE_SELF_UPDATE_TOKEN = previousToken;
  }
});

test("enriches community addon permissions from manifest when index omits them", async () => {
  const result = await fetchCommunityAddons(async (url) => ({
    ok: true,
    status: 200,
    async json() {
      if (String(url).endsWith("/demo.json")) {
        return {
          id: "demo-addon",
          name: "Demo",
          version: "1.0.0",
          type: "ui",
          sourceUrl: "https://github.com/Red-Blink/demo-addon",
          downloadUrl: "https://github.com/Red-Blink/demo-addon/releases/download/v1.0.0/demo.zip",
          sha256: "862cbb38adab95ffc7b584aa374d3a1fb4437cf33f0360e3a8f5120ab83e4bd4",
          permissions: { players: ["read"], database: ["read"] }
        };
      }
      return {
        schemaVersion: 1,
        addons: [{
          id: "demo-addon",
          name: "Demo",
          version: "1.0.0",
          sourceUrl: "https://github.com/Red-Blink/demo-addon",
          manifestUrl: "https://example.test/demo.json"
        }]
      };
    },
    url
  }), "https://example.test/index.json");
  assert.deepEqual(result.addons[0].permissions, ["database:read", "players:read"]);
});

test("validates community addon manifests for pinned install assets", () => {
  const manifest = normalizeCommunityAddonManifest({
    id: "leadership-board-demo",
    name: "Leadership Board Demo",
    version: "1.0.0",
    type: "ui",
    entry: { navigation: "Leadership Board Demo", path: "web/index.html" },
    sourceUrl: "https://github.com/Red-Blink/dune-docker-leadership",
    downloadUrl: "https://github.com/Red-Blink/dune-docker-leadership/releases/download/v1.0.0/leadership-board.zip",
    sha256: "862cbb38adab95ffc7b584aa374d3a1fb4437cf33f0360e3a8f5120ab83e4bd4",
    permissions: ["players:read"]
  });
  assert.equal(manifest.id, "leadership-board-demo");
  assert.equal(manifest.downloadUrl, "https://github.com/Red-Blink/dune-docker-leadership/releases/download/v1.0.0/leadership-board.zip");
  assert.equal(manifest.permissions[0], "players:read");
});

test("normalizes addon provenance fields", () => {
  assert.deepEqual(normalizeAddonProvenance({
    provenance: {
      indexUrl: "https://example.test/index.json",
      manifestUrl: "https://example.test/demo.json",
      sourceUrl: "https://github.com/Red-Blink/demo-addon",
      downloadUrl: "https://github.com/Red-Blink/demo-addon/releases/download/v1.0.0/demo.zip",
      version: "1.0.0",
      sha256: "862CBB38ADAB95FFC7B584AA374D3A1FB4437CF33F0360E3A8F5120AB83E4BD4",
      installedAt: "2026-06-21T00:00:00.000Z"
    }
  }), {
    indexUrl: "https://example.test/index.json",
    manifestUrl: "https://example.test/demo.json",
    sourceUrl: "https://github.com/Red-Blink/demo-addon",
    downloadUrl: "https://github.com/Red-Blink/demo-addon/releases/download/v1.0.0/demo.zip",
    version: "1.0.0",
    sha256: "862cbb38adab95ffc7b584aa374d3a1fb4437cf33f0360e3a8f5120ab83e4bd4",
    installedAt: "2026-06-21T00:00:00.000Z"
  });
  assert.deepEqual(normalizeAddonProvenance({}), {});
  assert.throws(() => normalizeAddonProvenance({ provenance: { indexUrl: "http://example.test/index.json" } }), /HTTPS/);
  assert.throws(() => normalizeAddonProvenance({ sha256: "bad" }), /sha256/);
});

test("normalizes addon permission arrays and structured permissions", () => {
  assert.deepEqual(normalizeAddonPermissions(["players:read", "players:read"]), ["players:read"]);
  assert.deepEqual(normalizeAddonPermissions({ database: ["read", "write"], server: ["status"], scheduler: ["server"] }), ["database:read", "database:write", "scheduler:server", "server:status"]);
  assert.deepEqual(normalizeAddonPermissions({ admin: ["grant-items"] }), ["admin:grant-items"]);
  assert.deepEqual(normalizeAddonPermissions({ rewards: ["grant"], players: ["message"], files: ["addon-data"] }), ["files:addon-data", "players:message", "rewards:grant"]);
  assert.throws(() => normalizeAddonPermissions(["database:drop"]), /not supported/);
  assert.throws(() => normalizeAddonPermissions({ database: "read" }), /must be an array/);
});

test("rejects unsafe addon manifests and zip entries", () => {
  assert.throws(() => normalizeAddonManifest({ id: "bad", name: "Bad", version: "1", type: "service", entry: { path: "web/index.html" } }), /Only ui/);
  assert.throws(() => normalizeAddonManifest({ id: "bad", name: "Bad", version: "1", type: "ui", entry: { path: "../index.html" } }), /unsafe/);
  assert.throws(() => normalizeCommunityAddonManifest({ id: "bad", name: "Bad", version: "1", type: "ui", entry: { path: "web/index.html" }, sourceUrl: "https://example.test", downloadUrl: "https://example.test/a.zip", sha256: "bad" }), /sha256/);
  assert.throws(() => validateZipEntries(["addon.json", "../evil"]), /unsafe/);
  assert.throws(() => validateZipEntries(["web/index.html"]), /addon.json/);
  assert.equal(validateZipEntries(["addon.json", "web/index.html", "web/addon.js"]), true);
});

test("compares semantic addon versions including prereleases", () => {
  assert.equal(compareAddonVersions("0.11.0", "0.9.2"), 1);
  assert.equal(compareAddonVersions("1.0.0", "1.0.0-rc.2"), 1);
  assert.equal(compareAddonVersions("1.0.0-rc.10", "1.0.0-rc.2"), 1);
  assert.equal(compareAddonVersions("v1.2.3+build.5", "1.2.3"), 0);
  assert.equal(compareAddonVersions("2.0.0-alpha", "2.0.0-beta"), -1);
  assert.throws(() => compareAddonVersions("release-1", "1.0.0"), /semantic versioning/);
});

test("updates an installed addon while preserving enabled state, schedules, and custom state", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-addon-update-"));
  try {
    const addonId = "demo-addon";
    const addonDir = join(repoRoot, "runtime/addons/installed", addonId);
    const statePath = join(repoRoot, "runtime/addons/state.json");
    const schedulePath = join(repoRoot, "runtime/addons/jobs", addonId, "buyback.json");
    mkdirSync(join(addonDir, "web"), { recursive: true });
    mkdirSync(join(repoRoot, "runtime/addons/jobs", addonId), { recursive: true });
    writeFileSync(join(addonDir, "addon.json"), JSON.stringify(addonManifestFixture(addonId, "0.9.2", ["database:read", "database:write"])));
    writeFileSync(join(addonDir, "web/index.html"), "old package");
    writeFileSync(schedulePath, JSON.stringify({ cron: "0 * * * *", custom: true }));
    mkdirSync(join(repoRoot, "runtime/addons"), { recursive: true });
    writeFileSync(statePath, JSON.stringify({
      [addonId]: {
        enabled: true,
        approvedPermissions: ["database:read", "database:write"],
        installedAt: "2026-07-01T00:00:00.000Z",
        customState: { untouched: true }
      }
    }));

    const archive = Buffer.from("verified addon archive");
    const permissions = ["database:read", "database:write", "scheduler:server"];
    const fetchImpl = addonReleaseFetch(archive, addonId, "0.11.0", permissions);
    const runCommandImpl = addonArchiveRunner(addonId, "0.11.0", permissions);
    const result = await updateCommunityAddon(
      { repoRoot },
      addonId,
      { approvedPermissions: permissions },
      fetchImpl,
      runCommandImpl
    );

    assert.equal(result.previousVersion, "0.9.2");
    assert.equal(result.addon.version, "0.11.0");
    assert.equal(result.addon.enabled, true);
    assert.equal(result.preservedConfiguration, true);
    assert.equal(readFileSync(join(addonDir, "web/index.html"), "utf8"), "new package");
    assert.deepEqual(JSON.parse(readFileSync(schedulePath, "utf8")), { cron: "0 * * * *", custom: true });
    const state = JSON.parse(readFileSync(statePath, "utf8"))[addonId];
    assert.equal(state.enabled, true);
    assert.equal(state.installedAt, "2026-07-01T00:00:00.000Z");
    assert.deepEqual(state.customState, { untouched: true });
    assert.deepEqual(state.approvedPermissions, permissions);
    assert.equal(typeof state.updatedAt, "string");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("rejects unapproved update permissions without changing the installed addon", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-addon-update-"));
  try {
    const addonId = "demo-addon";
    const addonDir = join(repoRoot, "runtime/addons/installed", addonId);
    mkdirSync(join(addonDir, "web"), { recursive: true });
    writeFileSync(join(addonDir, "addon.json"), JSON.stringify(addonManifestFixture(addonId, "0.9.2", ["database:read"])));
    writeFileSync(join(addonDir, "web/index.html"), "old package");
    const archive = Buffer.from("verified addon archive");
    const permissions = ["database:read", "scheduler:server"];

    await assert.rejects(
      updateCommunityAddon({ repoRoot }, addonId, { approvedPermissions: ["database:read"] }, addonReleaseFetch(archive, addonId, "0.11.0", permissions), addonArchiveRunner(addonId, "0.11.0", permissions)),
      /must be approved/
    );
    assert.equal(readFileSync(join(addonDir, "web/index.html"), "utf8"), "old package");
    assert.equal(JSON.parse(readFileSync(join(addonDir, "addon.json"), "utf8")).version, "0.9.2");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

function addonManifestFixture(id, version, permissions) {
  return {
    id,
    name: "Demo Addon",
    description: "Update test addon.",
    author: "Red-Blink",
    version,
    type: "ui",
    entry: { navigation: "Demo Addon", path: "web/index.html" },
    permissions
  };
}

function addonReleaseFetch(archive, id, version, permissions) {
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const manifest = {
    ...addonManifestFixture(id, version, permissions),
    sourceUrl: "https://github.com/Red-Blink/demo-addon",
    downloadUrl: `https://github.com/Red-Blink/demo-addon/releases/download/v${version}/demo-addon.zip`,
    sha256
  };
  return async (url) => {
    if (String(url).endsWith(".zip")) return { ok: true, status: 200, arrayBuffer: async () => archive };
    if (String(url).endsWith("demo-addon.json")) return { ok: true, status: 200, json: async () => manifest };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        schemaVersion: 1,
        addons: [{
          id,
          name: "Demo Addon",
          description: "Update test addon.",
          author: "Red-Blink",
          version,
          lifecycle: "active",
          sourceUrl: manifest.sourceUrl,
          manifestUrl: "https://example.test/demo-addon.json",
          permissions
        }]
      })
    };
  };
}

function addonArchiveRunner(id, version, permissions) {
  return async (_command, args) => {
    if (args[0] === "-Z1") return { stdout: "addon.json\nweb/index.html\n", stderr: "" };
    const stagingRoot = args.at(-1);
    mkdirSync(join(stagingRoot, "web"), { recursive: true });
    writeFileSync(join(stagingRoot, "addon.json"), JSON.stringify(addonManifestFixture(id, version, permissions)));
    writeFileSync(join(stagingRoot, "web/index.html"), "new package");
    return { stdout: "", stderr: "" };
  };
}

test("tracks installed addon enable disable and removal state", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-addons-"));
  try {
    const addonDir = join(repoRoot, "runtime/addons/installed/leadership-board-demo");
    mkdirSync(addonDir, { recursive: true });
    writeFileSync(join(addonDir, "addon.json"), JSON.stringify({
      id: "leadership-board-demo",
      name: "Leadership Board Demo",
      version: "1.0.0",
      type: "ui",
      entry: { path: "web/index.html" },
      permissions: ["players:read"]
    }));
    const config = { repoRoot };
    const jobsDir = join(repoRoot, "runtime/addons/jobs");
    const addonJobsDir = join(jobsDir, "leadership-board-demo");
    const otherAddonJobsDir = join(jobsDir, "another-addon");
    mkdirSync(addonJobsDir, { recursive: true });
    mkdirSync(otherAddonJobsDir, { recursive: true });
    const addonJob = join(addonJobsDir, "refresh.json");
    const addonJobTemp = join(addonJobsDir, "refresh.json.123.tmp");
    const otherAddonJob = join(otherAddonJobsDir, "refresh.json");
    writeFileSync(addonJob, "{}");
    writeFileSync(addonJobTemp, "{}");
    writeFileSync(otherAddonJob, "{}");
    const dataDir = join(repoRoot, "runtime/addons/data/leadership-board-demo");
    const deliveriesDir = join(repoRoot, "runtime/addons/deliveries/leadership-board-demo");
    const receiptPath = join(repoRoot, "runtime/addons/grant-receipts/leadership-board-demo.json");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(deliveriesDir, { recursive: true });
    mkdirSync(join(repoRoot, "runtime/addons/grant-receipts"), { recursive: true });
    writeFileSync(join(dataDir, "store.json"), "{}");
    writeFileSync(join(deliveriesDir, "reward.json"), "{}");
    writeFileSync(receiptPath, "[]");
    assert.equal(listInstalledAddons(config).addons[0].status, "Disabled");
    assert.throws(() => setInstalledAddonEnabled(config, "leadership-board-demo", true), /must be approved/);
    writeFileSync(join(repoRoot, "runtime/addons/state.json"), JSON.stringify({
      "leadership-board-demo": {
        approvedPermissions: ["players:read"],
        provenance: {
          indexUrl: "https://example.test/index.json",
          manifestUrl: "https://example.test/leadership-board-demo.json",
          sourceUrl: "https://github.com/Red-Blink/leadership-board-demo",
          downloadUrl: "https://github.com/Red-Blink/leadership-board-demo/releases/download/v1.0.0/leadership-board-demo.zip",
          version: "1.0.0",
          sha256: "862cbb38adab95ffc7b584aa374d3a1fb4437cf33f0360e3a8f5120ab83e4bd4",
          installedAt: "2026-06-21T00:00:00.000Z"
        }
      }
    }));
    assert.equal(setInstalledAddonEnabled(config, "leadership-board-demo", true).addon.status, "Enabled");
    const installedAddon = listInstalledAddons(config).addons[0];
    assert.equal(installedAddon.enabled, true);
    assert.equal(installedAddon.provenance.sha256, "862cbb38adab95ffc7b584aa374d3a1fb4437cf33f0360e3a8f5120ab83e4bd4");
    assert.equal(installedAddon.provenance.manifestUrl, "https://example.test/leadership-board-demo.json");
    assert.equal(assertInstalledAddonPermission(config, "leadership-board-demo", "players:read").permission, "players:read");
    assert.equal(installedAddonContentPath(config, "leadership-board-demo", "web/index.html"), join(addonDir, "web/index.html"));
    assert.throws(() => installedAddonContentPath(config, "leadership-board-demo", "../addon.json"), /unsafe/);
    assert.equal(setInstalledAddonEnabled(config, "leadership-board-demo", false).addon.status, "Disabled");
    assert.throws(() => installedAddonContentPath(config, "leadership-board-demo", "web/index.html"), /disabled/);
    assert.deepEqual(removeInstalledAddon(config, "leadership-board-demo"), { ok: true, id: "leadership-board-demo" });
    assert.deepEqual(listInstalledAddons(config).addons, []);
    assert.equal(existsSync(addonJobsDir), false, "uninstall removes the addon's scheduled-job directory");
    assert.equal(existsSync(addonJob), false, "uninstall removes persisted addon jobs");
    assert.equal(existsSync(addonJobTemp), false, "uninstall removes interrupted atomic-write files for addon jobs");
    assert.equal(existsSync(otherAddonJob), true, "uninstall preserves other addons' jobs");
    assert.equal(existsSync(dataDir), false, "uninstall removes addon-owned data");
    assert.equal(existsSync(deliveriesDir), false, "uninstall removes addon delivery state");
    assert.equal(existsSync(receiptPath), false, "uninstall removes legacy grant receipts");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("syncs installed addon lifecycle from community index and blocks unsafe execution", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-addons-"));
  try {
    const addonDir = join(repoRoot, "runtime/addons/installed/blocked-addon");
    mkdirSync(join(addonDir, "web"), { recursive: true });
    writeFileSync(join(addonDir, "addon.json"), JSON.stringify({
      id: "blocked-addon",
      name: "Blocked Addon",
      version: "1.0.0",
      type: "ui",
      entry: { path: "web/index.html" },
      permissions: ["players:read"]
    }));
    writeFileSync(join(addonDir, "web/index.html"), "<html></html>");
    const config = { repoRoot };
    writeFileSync(join(repoRoot, "runtime/addons/state.json"), JSON.stringify({ "blocked-addon": { enabled: true, approvedPermissions: ["players:read"] } }));
    syncInstalledAddonLifecycle(config, {
      addons: [{
        id: "blocked-addon",
        lifecycle: "blocked",
        lifecycleMessage: "Security issue.",
        lifecycleUrl: "https://example.test/security"
      }]
    });
    const addon = listInstalledAddons(config).addons[0];
    assert.equal(addon.lifecycle, "blocked");
    assert.equal(addon.lifecycleMessage, "Security issue.");
    assert.equal(addon.enabled, false);
    assert.throws(() => setInstalledAddonEnabled(config, "blocked-addon", true), /blocked/);
    assert.throws(() => assertInstalledAddonPermission(config, "blocked-addon", "players:read"), /disabled|blocked/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("marks locally installed addons missing from community index as removed", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-addons-"));
  try {
    const addonDir = join(repoRoot, "runtime/addons/installed/local-only-addon");
    mkdirSync(addonDir, { recursive: true });
    writeFileSync(join(addonDir, "addon.json"), JSON.stringify({
      id: "local-only-addon",
      name: "Local Only Addon",
      version: "1.0.0",
      type: "ui",
      entry: { path: "web/index.html" },
      permissions: []
    }));
    const config = { repoRoot };
    syncInstalledAddonLifecycle(config, { addons: [] });
    const addon = listInstalledAddons(config).addons[0];
    assert.equal(addon.lifecycle, "removed");
    assert.match(addon.lifecycleMessage, /no longer listed/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
