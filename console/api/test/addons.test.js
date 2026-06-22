import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertInstalledAddonPermission, fetchCommunityAddons, installedAddonContentPath, listInstalledAddons, normalizeAddonManifest, normalizeAddonPermissions, normalizeAddonProvenance, normalizeCommunityAddonManifest, normalizeCommunityAddonsIndex, removeInstalledAddon, setInstalledAddonEnabled, syncInstalledAddonLifecycle, validateZipEntries } from "../src/addons.js";

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
  assert.deepEqual(normalizeAddonPermissions({ database: ["read", "write"], server: ["status"] }), ["database:read", "database:write", "server:status"]);
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
