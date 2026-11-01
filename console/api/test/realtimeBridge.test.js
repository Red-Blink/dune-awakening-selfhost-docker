import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRealtime, parseObjectFilter, RealtimeError } from "../src/services/realtime.js";
import { READ_ONLY_BRIDGE_ACTIONS } from "../src/bridgeReadActions.js";

const API_ROOT = resolve(import.meta.dirname, "..");
const PORT = 26000 + (process.pid % 12000);
const BASE = `http://127.0.0.1:${PORT}`;

const SNAP = {
  gen: 1,
  t: 1,
  sources: [
    { pid: 4242, map: "Survival_1", partition: 1, ready: true, n: 3 },
    { pid: 4343, map: "DeepDesert_1", partition: 1, ready: true, n: 1 }
  ],
  objects: [
    { i: 1, k: "worm", c: "BP_Crea_SandwormArrakis_C", s: 0, x: 1, y: 2, z: 3 },
    { i: 2, k: "npc", c: "BP_Npc_SoldierBase_C", s: 0, x: 4, y: 5, z: 6 },
    { i: 3, k: "player", c: "BP_Player_C", s: 0, x: 7, y: 8, z: 9 },
    { i: 4, k: "worm", c: "BP_Crea_SandwormArrakis_C", s: 1, x: 10, y: 11, z: 12 }
  ]
};

async function fakeAgent() {
  const asked = [];
  const server = http.createServer((req, res) => {
    asked.push(req.url);
    if (req.url === "/healthz") return res.end(JSON.stringify({ ok: true, ready: 2, sources: SNAP.sources }));
    if (req.url.startsWith("/api/objects")) {
      const kinds = new URL(req.url, "http://x").searchParams.get("kinds").split(",");
      return res.end(JSON.stringify({ ...SNAP, objects: SNAP.objects.filter((o) => kinds.includes(o.k)) }));
    }
    res.statusCode = 404;
    return res.end();
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return { server, asked, url: `http://127.0.0.1:${server.address().port}` };
}

test("parseObjectFilter accepts known kinds and map names only", () => {
  assert.deepEqual(parseObjectFilter({}), {});
  assert.deepEqual(parseObjectFilter({ kinds: ["worm", "worm", "npc"], map: "Survival_1" }), { kinds: ["worm", "npc"], map: "Survival_1" });
  for (const bad of [{ kinds: "worm" }, { kinds: ["nope"] }, { kinds: [1] }, { kinds: new Array(17).fill("worm") }, { map: "../x" }, { map: 5 }, { map: "a b" }]) {
    assert.throws(() => parseObjectFilter(bad), (error) => error instanceof RealtimeError && error.status === 400, JSON.stringify(bad));
  }
});

test("objects() filters by kind and map and never adds players", async () => {
  const agent = await fakeAgent();
  try {
    const realtime = createRealtime({ agentUrl: agent.url });

    const all = await realtime.objects({ allowPlayers: false });
    assert.deepEqual(all.objects.map((o) => o.i), [1, 2, 4]);

    const worms = await realtime.objects({ allowPlayers: false, kinds: ["worm"] });
    assert.deepEqual(worms.objects.map((o) => o.i), [1, 4]);

    // Asking for players without the right returns nothing and never reaches the agent.
    const before = agent.asked.length;
    const none = await realtime.objects({ allowPlayers: false, kinds: ["player"] });
    assert.deepEqual(none.objects, []);
    assert.equal(agent.asked.length, before);

    const withPlayers = await realtime.objects({ allowPlayers: true, kinds: ["player"] });
    assert.deepEqual(withPlayers.objects.map((o) => o.i), [3]);

    const desert = await realtime.objects({ allowPlayers: false, map: "DeepDesert_1" });
    assert.deepEqual(desert.objects.map((o) => ({ i: o.i, s: o.s })), [{ i: 4, s: 0 }]);
    assert.deepEqual(desert.sources.map((s) => s.map), ["DeepDesert_1"]);
    assert.ok(desert.sources.every((s) => !("pid" in s)));

    const missing = await realtime.objects({ allowPlayers: false, map: "Nowhere_1" });
    assert.deepEqual(missing.objects, []);
    assert.deepEqual(missing.sources, []);
  } finally {
    agent.server.close();
  }
});

test("both bridge actions count as read-only", () => {
  assert.ok(READ_ONLY_BRIDGE_ACTIONS.has("realtime.health"));
  assert.ok(READ_ONLY_BRIDGE_ACTIONS.has("realtime.objects"));
});

function writeAddon(repoRoot, id, permissions, approvedPermissions) {
  const addonDir = join(repoRoot, "runtime/addons/installed", id);
  mkdirSync(join(addonDir, "web"), { recursive: true });
  writeFileSync(join(addonDir, "web/index.html"), "<!doctype html><title>Test</title>");
  writeFileSync(join(addonDir, "addon.json"), JSON.stringify({
    schemaVersion: 1,
    id,
    name: id,
    description: "Realtime bridge test addon",
    author: "Test",
    version: "1.0.0",
    type: "ui",
    entry: { navigation: "Test", path: "web/index.html" },
    permissions
  }));
  return { enabled: true, approvedPermissions };
}

function makeRepoRoot() {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-realtime-bridge-http-"));
  mkdirSync(join(repoRoot, "console/web/dist"), { recursive: true });
  const state = {
    "rt-only": writeAddon(repoRoot, "rt-only", { realtime: ["read"] }, ["realtime:read"]),
    "rt-players": writeAddon(repoRoot, "rt-players", { realtime: ["read"], players: ["read"] }, ["realtime:read", "players:read"]),
    "rt-unapproved": writeAddon(repoRoot, "rt-unapproved", { realtime: ["read"] }, []),
    "players-only": writeAddon(repoRoot, "players-only", { players: ["read"] }, ["players:read"])
  };
  writeFileSync(join(repoRoot, "runtime/addons/state.json"), JSON.stringify(state));
  return repoRoot;
}

function startServer(repoRoot, agentUrl) {
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: API_ROOT,
    shell: false,
    env: {
      ...process.env,
      DUNE_DOCKER_DIR: repoRoot,
      DUNE_REALTIME_AGENT_URL: agentUrl,
      ADMIN_AUTH_DISABLED: "1",
      ADMIN_MOCK_MODE: "1",
      ADMIN_AUTO_START_STACK_ON_BOOT: "0",
      ADMIN_BIND_HOST: "127.0.0.1",
      ADMIN_BIND_PORT: String(PORT),
      ADMIN_STATIC_DIR: join(repoRoot, "console/web/dist")
    }
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const ready = new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error(`API did not start listening.\n${output}`)), 20000);
    const poll = setInterval(async () => {
      try {
        const response = await fetch(`${BASE}/api/health`);
        if (response.ok) {
          clearTimeout(timeout);
          clearInterval(poll);
          resolveReady();
        }
      } catch {}
    }, 100);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      clearInterval(poll);
      rejectReady(new Error(`API exited with code ${code} before listening.\n${output}`));
    });
  });
  return { child, ready };
}

async function bridge(addonId, action, extra = {}) {
  const response = await fetch(`${BASE}/api/addons/installed/${addonId}/bridge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...extra })
  });
  return { status: response.status, body: await response.json() };
}

async function stop(child) {
  child.kill("SIGTERM");
  await new Promise((resolveExit) => {
    child.on("exit", resolveExit);
    setTimeout(() => {
      child.kill("SIGKILL");
      resolveExit();
    }, 3000).unref?.();
  });
}

test("realtime bridge actions are permission gated and filter players", async (t) => {
  const agent = await fakeAgent();
  const repoRoot = makeRepoRoot();
  const { child, ready } = startServer(repoRoot, agent.url);
  try {
    await ready;

    await t.test("health reports the agent", async () => {
      const { status, body } = await bridge("rt-only", "realtime.health");
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.result.available, true);
      assert.equal(body.result.ready, 2);
      assert.ok(body.result.sources.every((s) => !("pid" in s)));
    });

    await t.test("objects without players:read carry no player", async () => {
      const { status, body } = await bridge("rt-only", "realtime.objects");
      assert.equal(status, 200);
      assert.ok(body.result.objects.length > 0);
      assert.ok(body.result.objects.every((o) => o.k !== "player"));
    });

    await t.test("an explicit player request without players:read returns nothing", async () => {
      const { status, body } = await bridge("rt-only", "realtime.objects", { kinds: ["player"] });
      assert.equal(status, 200);
      assert.deepEqual(body.result.objects, []);
    });

    await t.test("objects with players:read include players", async () => {
      const { body } = await bridge("rt-players", "realtime.objects");
      assert.ok(body.result.objects.some((o) => o.k === "player"));
    });

    await t.test("kind and map filters apply", async () => {
      const { body } = await bridge("rt-players", "realtime.objects", { kinds: ["worm"], map: "DeepDesert_1" });
      assert.deepEqual(body.result.objects.map((o) => o.i), [4]);
    });

    await t.test("bad filters are rejected with 400", async () => {
      for (const extra of [{ kinds: ["nope"] }, { kinds: "worm" }, { map: "../etc" }]) {
        const { status, body } = await bridge("rt-only", "realtime.objects", extra);
        assert.equal(status, 400, JSON.stringify(extra));
        assert.equal(body.ok, false);
      }
    });

    await t.test("an unapproved addon is refused", async () => {
      for (const action of ["realtime.health", "realtime.objects"]) {
        const { status, body } = await bridge("rt-unapproved", action);
        assert.equal(status, 500);
        assert.match(body.error, /not approved for realtime:read/i);
      }
    });

    await t.test("players:read alone does not unlock realtime", async () => {
      const { status, body } = await bridge("players-only", "realtime.objects");
      assert.equal(status, 500);
      assert.match(body.error, /did not request realtime:read/i);
    });
  } finally {
    await stop(child);
    agent.server.close();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("realtime bridge answers available:false when the agent is down", async (t) => {
  const repoRoot = makeRepoRoot();
  // Nothing listens on this loopback port.
  const { child, ready } = startServer(repoRoot, "http://127.0.0.1:9");
  try {
    await ready;
    for (const action of ["realtime.health", "realtime.objects"]) {
      await t.test(action, async () => {
        const { status, body } = await bridge("rt-only", action);
        assert.equal(status, 200);
        assert.equal(body.ok, true);
        assert.equal(body.result.available, false);
        assert.match(body.result.error, /not available/i);
        assert.doesNotMatch(JSON.stringify(body), /127\.0\.0\.1/);
      });
    }
  } finally {
    await stop(child);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
