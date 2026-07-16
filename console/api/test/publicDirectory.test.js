import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectDirectorySnapshot,
  createPublicDirectoryReporter,
  getOrCreateIdentity,
  isBattlegroupRunning,
  readConfiguredCapacity,
  readDirectorySettings,
  readGameBuild,
  readPublicProbePort
} from "../src/services/publicDirectory.js";

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-directory-"));
  const generatedDir = join(repoRoot, "runtime", "generated");
  const secretsDir = join(repoRoot, "runtime", "secrets");
  mkdirSync(join(repoRoot, "runtime", "director", "config"), { recursive: true });
  mkdirSync(generatedDir, { recursive: true });
  mkdirSync(secretsDir, { recursive: true });
  writeFileSync(join(repoRoot, ".env"), [
    'SERVER_TITLE="Test Sietch"',
    "SERVER_REGION=Europe Test",
    "SERVER_IP_MODE=public"
  ].join("\n"));
  writeFileSync(join(generatedDir, "image-tags.env"), "DUNE_WORLD_IMAGE_TAG=2036754-0-shipping\n");
  writeFileSync(join(generatedDir, "sietch-config.json"), JSON.stringify({
    maps: { Survival_1: { active_dimensions: 2 } }
  }));
  writeFileSync(join(repoRoot, "runtime", "director", "config", "director_config.ini"), [
    "[Server]",
    "PlayerHardCap=60",
    "ShouldUpdatePlayerCountOnFls=true",
    "[Survival_1]",
    "PlayerHardCap=60",
    "ShouldUpdatePlayerCountOnFls=true",
    "[Overmap]",
    "PlayerHardCap=80",
    "ShouldUpdatePlayerCountOnFls=false"
  ].join("\n"));
  return {
    repoRoot,
    generatedDir,
    secretsDir,
    cleanup: () => rmSync(repoRoot, { recursive: true, force: true })
  };
}

function fakeDb() {
  return {
    async query(sql) {
      if (sql.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (sql.includes("sum(coalesce(connected_players")) return { rows: [{ players: 4 }] };
      if (sql.includes("from dune.player_state")) return { rows: [{ players: 3 }] };
      if (sql.includes("ready_maps")) {
        assert.match(sql, /fs\.alive/, "directory readiness must reject core maps that stopped reporting");
        return { rows: [{ ready_maps: 2 }] };
      }
      if (sql.includes("as sietches")) return { rows: [{ sietches: 9 }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}

function response(body = {}, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  };
}

test("directory settings default public servers on and normalize test regions", () => {
  const files = fixture();
  try {
    assert.deepEqual(readDirectorySettings(files.repoRoot, {}), {
      enabled: true,
      mode: "public",
      title: "Test Sietch",
      region: "Europe"
    });
    writeFileSync(join(files.repoRoot, ".env"), "SERVER_IP_MODE=public\nDUNE_PUBLIC_DIRECTORY_ENABLED=false\n");
    assert.equal(readDirectorySettings(files.repoRoot, {}).enabled, false);
  } finally {
    files.cleanup();
  }
});

test("saved directory opt-out overrides a stale container environment value", () => {
  const files = fixture();
  try {
    writeFileSync(join(files.repoRoot, ".env"), [
      "SERVER_IP_MODE=public",
      "SERVER_TITLE=Test",
      "SERVER_REGION=Europe",
      "DUNE_PUBLIC_DIRECTORY_ENABLED=true"
    ].join("\n"));
    assert.equal(readDirectorySettings(files.repoRoot, { DUNE_PUBLIC_DIRECTORY_ENABLED: "false" }).enabled, true);
  } finally {
    files.cleanup();
  }
});

test("directory probe port follows the public RabbitMQ HTTP port", () => {
  const files = fixture();
  try {
    assert.equal(readPublicProbePort(files.repoRoot), 31983);
    writeFileSync(join(files.repoRoot, ".env"), "RMQ_GAME_HTTP_PORT=32983\n");
    assert.equal(readPublicProbePort(files.repoRoot), 32983);
    writeFileSync(join(files.repoRoot, ".env"), "RMQ_GAME_HTTP_PORT=invalid\n");
    assert.equal(readPublicProbePort(files.repoRoot), 31983);
  } finally {
    files.cleanup();
  }
});

test("directory snapshot uses compact database aggregates and local metadata", async () => {
  const files = fixture();
  try {
    const snapshot = await collectDirectorySnapshot(
      { repoRoot: files.repoRoot },
      fakeDb(),
      readDirectorySettings(files.repoRoot, {})
    );
    assert.deepEqual(snapshot, {
      name: "Test Sietch",
      region: "Europe",
      running: true,
      ready: true,
      playersOnline: 4,
      capacity: 60,
      version: "2036754",
      sietches: 2,
      probePort: 31983
    });
    assert.equal(readGameBuild(files.repoRoot), "2036754");
    assert.equal(readConfiguredCapacity(files.repoRoot), 60);
  } finally {
    files.cleanup();
  }
});

test("battlegroup running state distinguishes stopped stacks from partial stacks", () => {
  assert.equal(isBattlegroupRunning(() => ["dune-server-survival-1"]), true);
  assert.equal(isBattlegroupRunning(() => ["dune-postgres", "redblink-dune-docker-console"]), false);
  assert.equal(isBattlegroupRunning(() => {
    throw new Error("docker unavailable");
  }), false);
});

test("reporter sends a fresh offline heartbeat when the battlegroup is stopped", async () => {
  const files = fixture();
  let payload;
  try {
    const reporter = createPublicDirectoryReporter({
      repoRoot: files.repoRoot,
      generatedDir: files.generatedDir,
      secretsDir: files.secretsDir
    }, {
      db: {
        async query() {
          throw new Error("stopped battlegroup must not query its database");
        }
      },
      getBattlegroupRunning: () => false,
      fetchImpl: async (_url, options) => {
        payload = JSON.parse(options.body);
        return response({ ok: true, nextHeartbeatSeconds: 60 });
      },
      setTimeoutFn: () => ({ unref() {} })
    });

    await reporter.tick();

    assert.equal(payload.running, false);
    assert.equal(payload.ready, false);
    assert.equal(payload.playersOnline, 0);
    assert.equal(reporter.publicState().state, "offline");
  } finally {
    files.cleanup();
  }
});

test("reporter sends only the public directory contract and persists its identity", async () => {
  const files = fixture();
  const requests = [];
  const delays = [];
  try {
    const reporter = createPublicDirectoryReporter({
      repoRoot: files.repoRoot,
      generatedDir: files.generatedDir,
      secretsDir: files.secretsDir
    }, {
      db: fakeDb(),
      getBattlegroupRunning: () => true,
      baseUrl: "https://directory.test/api/v1/servers",
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return response({ ok: true, nextHeartbeatSeconds: 75 });
      },
      setTimeoutFn: (_fn, delay) => {
        delays.push(delay);
        return { unref() {} };
      },
      now: () => Date.parse("2026-07-16T10:00:00Z")
    });

    await reporter.tick();

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://directory.test/api/v1/servers/heartbeat");
    const payload = JSON.parse(requests[0].options.body);
    assert.deepEqual(Object.keys(payload).sort(), [
      "capacity",
      "name",
      "playersOnline",
      "probePort",
      "publicMode",
      "ready",
      "region",
      "running",
      "secret",
      "serverId",
      "sietches",
      "version"
    ]);
    assert.equal(Object.hasOwn(payload, "battlegroupId"), false);
    assert.equal(Object.hasOwn(payload, "serverIp"), false);
    assert.equal(payload.name, "Test Sietch");
    assert.equal(payload.playersOnline, 4);
    assert.equal(payload.probePort, 31983);
    assert.equal(delays.at(-1), 75000);

    const identity = JSON.parse(readFileSync(join(files.secretsDir, "public-directory.json"), "utf8"));
    assert.equal(identity.serverId, payload.serverId);
    assert.equal(identity.secret, payload.secret);
    assert.equal(statSync(join(files.secretsDir, "public-directory.json")).mode & 0o777, 0o600);
    assert.equal(reporter.publicState().remoteListed, true);
  } finally {
    files.cleanup();
  }
});

test("an immediate UI-triggered heartbeat replaces the scheduled timer", async () => {
  const files = fixture();
  const cleared = [];
  let timerId = 0;
  try {
    const reporter = createPublicDirectoryReporter({
      repoRoot: files.repoRoot,
      generatedDir: files.generatedDir,
      secretsDir: files.secretsDir
    }, {
      db: fakeDb(),
      getBattlegroupRunning: () => true,
      fetchImpl: async () => response({ ok: true, nextHeartbeatSeconds: 60 }),
      setTimeoutFn: () => ({ id: ++timerId, unref() {} }),
      clearTimeoutFn: (timer) => cleared.push(timer.id),
      random: () => 0
    });
    reporter.start();
    await reporter.tick();
    assert.deepEqual(cleared, [1]);
  } finally {
    files.cleanup();
  }
});

test("reporter removes a previous listing after switching to local mode", async () => {
  const files = fixture();
  const identityPath = join(files.secretsDir, "public-directory.json");
  const statusPath = join(files.generatedDir, "public-directory-status.json");
  const identity = getOrCreateIdentity(identityPath);
  writeFileSync(statusPath, JSON.stringify({ remoteListed: true, serverId: identity.serverId }));
  writeFileSync(join(files.repoRoot, ".env"), "SERVER_IP_MODE=local\nSERVER_TITLE=Private\nSERVER_REGION=Europe\n");
  const requests = [];
  try {
    const reporter = createPublicDirectoryReporter({
      repoRoot: files.repoRoot,
      generatedDir: files.generatedDir,
      secretsDir: files.secretsDir
    }, {
      db: fakeDb(),
      baseUrl: "https://directory.test/api/v1/servers",
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return response({ ok: true });
      },
      setTimeoutFn: () => ({ unref() {} })
    });

    await reporter.tick();

    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.method, "DELETE");
    assert.equal(requests[0].url, `https://directory.test/api/v1/servers/${identity.serverId}`);
    assert.equal(requests[0].options.headers.authorization, `Bearer ${identity.secret}`);
    assert.equal(reporter.publicState().state, "local-only");
    assert.equal(reporter.publicState().remoteListed, false);
  } finally {
    files.cleanup();
  }
});

test("reporter records errors and backs off without exposing its secret", async () => {
  const files = fixture();
  const delays = [];
  try {
    const reporter = createPublicDirectoryReporter({
      repoRoot: files.repoRoot,
      generatedDir: files.generatedDir,
      secretsDir: files.secretsDir
    }, {
      db: fakeDb(),
      getBattlegroupRunning: () => true,
      fetchImpl: async () => response({ error: "temporary failure" }, 503),
      setTimeoutFn: (_fn, delay) => {
        delays.push(delay);
        return { unref() {} };
      }
    });

    await reporter.tick();

    const state = reporter.publicState();
    assert.equal(state.state, "error");
    assert.match(state.error, /HTTP 503/);
    assert.equal(Object.hasOwn(state, "secret"), false);
    assert.equal(delays.at(-1), 60000);
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(
      join(files.generatedDir, "public-directory-status.json"),
      "utf8"
    )), "secret"), false);
  } finally {
    files.cleanup();
  }
});

test("corrupt identity files are replaced with private valid credentials", () => {
  const files = fixture();
  const path = join(files.secretsDir, "public-directory.json");
  try {
    writeFileSync(path, "{\"serverId\":\"bad\"}\n");
    chmodSync(path, 0o644);
    const identity = getOrCreateIdentity(path);
    assert.match(identity.serverId, /^[0-9a-f-]{36}$/i);
    assert.match(identity.secret, /^[A-Za-z0-9_-]{32,128}$/);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    files.cleanup();
  }
});

test("persisted status is field-whitelisted before API exposure", () => {
  const files = fixture();
  try {
    writeFileSync(join(files.generatedDir, "public-directory-status.json"), JSON.stringify({
      state: "online",
      serverId: "11111111-1111-4111-8111-111111111111",
      secret: "must-not-leak",
      unexpected: { nested: true }
    }));
    const reporter = createPublicDirectoryReporter({
      repoRoot: files.repoRoot,
      generatedDir: files.generatedDir,
      secretsDir: files.secretsDir
    }, {
      db: fakeDb(),
      setTimeoutFn: () => ({ unref() {} })
    });
    const state = reporter.publicState();
    assert.equal(state.state, "online");
    assert.equal(Object.hasOwn(state, "secret"), false);
    assert.equal(Object.hasOwn(state, "unexpected"), false);
  } finally {
    files.cleanup();
  }
});
