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
  buildHeartbeatPayload,
  collectDirectorySnapshot,
  createPublicDirectoryReporter,
  getOrCreateIdentity,
  isBattlegroupRunning,
  normalizeDiscordInvite,
  readConfiguredCapacity,
  readDirectoryInstallationKey,
  readPreviousDirectoryInstallationKey,
  readPublicModifiers,
  readDirectorySettings,
  readGameBuild,
  reconcilePublicProbe
} from "../src/services/publicDirectory.js";

test("public modifier reporting is allowlisted and omits defaults and secrets", () => {
  const files = fixture();
  const path = join(files.generatedDir, "gameplay-profile.ini");
  try {
    writeFileSync(path, [
      "[Engine:ConsoleVariables]",
      "Dune.GlobalMiningOutputMultiplier=7.77",
      "Dune.GlobalVehicleMiningOutputMultiplier=1.000000",
      "Bgd.ServerLoginPassword=must-not-leak",
      "Unknown.PrivateSetting=42",
      "Sandstorm.Enabled=0",
      "",
      "[Partition:Survival_1:1:/Script/DuneSandbox.DuneGameMode]",
      "m_GlobalXPMultiplier=3.5",
      "m_WaterConsumptionRate=0.5",
      "m_DefaultReconnectGracePeriodSeconds=600",
      "",
      "[Global:/Script/DuneSandbox.BuildingSettings]",
      "m_PickupTotalDurabilityPercentageReduction=0.25",
      "",
      "[Global:/Script/DuneSandbox.ContractsSubsystem]",
      "m_bIsEnabled=invalid"
    ].join("\n"));
    assert.deepEqual(readPublicModifiers(path), {
      "Mining Output": "7.77x",
      Sandstorms: "Disabled",
      "XP Multiplier": "3.5x",
      "Water Consumption": "0.5x",
      "Reconnect Grace Period": "10 minutes",
      "Building Pickup Durability Loss": "25%"
    });
  } finally {
    files.cleanup();
  }
});

test("public modifier reporting preserves differing map values without exposing map internals", () => {
  const files = fixture();
  const path = join(files.generatedDir, "gameplay-profile.ini");
  try {
    writeFileSync(path, [
      "[Partition:Survival_1:1:/Script/DuneSandbox.DuneGameMode]",
      "m_GlobalXPMultiplier=2",
      "",
      "[Partition:Survival_1:2:/Script/DuneSandbox.DuneGameMode]",
      "m_GlobalXPMultiplier=3.0",
      "",
      "[Partition:Survival_1:3:/Script/DuneSandbox.DuneGameMode]",
      "m_GlobalXPMultiplier=1.000000"
    ].join("\n"));
    assert.deepEqual(readPublicModifiers(path), {
      "XP Multiplier": "Varies: 2x, 3x"
    });
  } finally {
    files.cleanup();
  }
});

test("public modifier reporting includes scoped UserEngine overrides", () => {
  const files = fixture();
  const path = join(files.generatedDir, "gameplay-profile.ini");
  try {
    writeFileSync(path, [
      "[Global:/Script/DuneSandbox.SpiceAddictionSubsystem]",
      "m_bIsSpiceAddictionEnabled=False",
      "",
      "[MapEngine:Survival_1:ConsoleVariables]",
      "Sandstorm.Enabled=0",
      "",
      "[PartitionEngine:DeepDesert_1:8:ConsoleVariables]",
      "sandworm.dune.Enabled=0"
    ].join("\n"));
    assert.deepEqual(readPublicModifiers(path), {
      Sandstorms: "Disabled",
      Sandworms: "Disabled",
      "Spice Addiction": "Disabled"
    });
  } finally {
    files.cleanup();
  }
});

test("heartbeat includes an empty Discord invite so stale directory links are removed", () => {
  const payload = buildHeartbeatPayload(
    { serverId: "server-id", secret: "secret" },
    {
      name: "Test Sietch",
      region: "Europe",
      running: true,
      ready: true,
      playersOnline: 0,
      capacity: 60,
      version: "2036754",
      sietches: 1,
      discordInvite: ""
    }
  );

  assert.equal(Object.hasOwn(payload, "discordInvite"), true);
  assert.equal(payload.discordInvite, "");
});

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
    "SERVER_IP_MODE=public",
    "BATTLEGROUP_ID=sh-testbattlegroup-directory",
    "DUNE_PUBLIC_DIRECTORY_DISCORD_INVITE=https://discord.com/invite/Test_Code"
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
      region: "Europe",
      discordInvite: "https://discord.gg/Test_Code"
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
      capacity: 120,
      version: "2036754",
      installationKey: readDirectoryInstallationKey(files.repoRoot),
      previousInstallationKey: "",
      sietches: 2,
      discordInvite: "https://discord.gg/Test_Code",
      publicMetadata: {
        modifiers: {},
        progression: { characters: 0, averageLevel: 0, highestLevel: 0 }
      }
    });
    assert.equal(readGameBuild(files.repoRoot), "2036754");
    assert.equal(readConfiguredCapacity(files.repoRoot), 120);
    assert.equal(readConfiguredCapacity(files.repoRoot, 1), 60);
  } finally {
    files.cleanup();
  }
});

test("configured Sietch capacity respects custom caps and active dimensions", () => {
  const files = fixture();
  try {
    writeFileSync(join(files.repoRoot, "runtime", "director", "config", "director_config.ini"), [
      "[Server]",
      "PlayerHardCap=40",
      "ShouldUpdatePlayerCountOnFls=false",
      "[Survival_1]",
      "PlayerHardCap=45",
      "ShouldUpdatePlayerCountOnFls=true",
      "[Overmap]",
      "PlayerHardCap=80",
      "ShouldUpdatePlayerCountOnFls=false"
    ].join("\n"));
    assert.equal(readConfiguredCapacity(files.repoRoot, 3), 135);
  } finally {
    files.cleanup();
  }
});

test("battlegroup running state distinguishes stopped stacks from partial stacks", async () => {
  assert.equal(await isBattlegroupRunning(() => ["dune-server-survival-1"]), true);
  assert.equal(await isBattlegroupRunning(() => ["dune-postgres", "redblink-dune-docker-console"]), false);
  assert.equal(await isBattlegroupRunning(() => {
    throw new Error("docker unavailable");
  }), false);
});

test("probe reconciliation yields while its Docker command is running", async () => {
  const files = fixture();
  let releaseCommand;
  let commandFinished = false;
  const commandGate = new Promise((resolve) => { releaseCommand = resolve; });
  try {
    const reconciliation = reconcilePublicProbe(files.repoRoot, {
      enabled: true,
      signalingUrl: "https://dunedocker.app/api/v1/probes",
      serverId: "11111111-1111-4111-8111-111111111111",
      secret: "test-secret-placeholder-not-a-real-key"
    }, async () => {
      await commandGate;
      commandFinished = true;
      return "";
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(commandFinished, false);
    assert.equal(readFileSync(join(files.generatedDir, "public-probe.env"), "utf8").includes("DUNE_PUBLIC_PROBE_ENABLED=true"), true);

    releaseCommand();
    await reconciliation;
    assert.equal(commandFinished, true);
  } finally {
    files.cleanup();
  }
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
        return response({ ok: true, nextHeartbeatSeconds: 60, listingClaimed: false });
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
        if (url.endsWith("/claim-status")) return response({ ok: true, claimed: true, playerPortalEnabled: false });
        return response({ ok: true, nextHeartbeatSeconds: 75, listingClaimed: true });
      },
      setTimeoutFn: (_fn, delay) => {
        delays.push(delay);
        return { unref() {} };
      },
      now: () => Date.parse("2026-07-16T10:00:00Z")
    });

    await reporter.tick();

    assert.equal(requests.length, 2);
    const heartbeat = requests.find(request => request.url.endsWith("/heartbeat"));
    const claimStatus = requests.find(request => request.url.endsWith("/claim-status"));
    assert.ok(heartbeat);
    assert.ok(claimStatus);
    const payload = JSON.parse(heartbeat.options.body);
    assert.deepEqual(Object.keys(payload).sort(), [
      "capacity",
      "discordInvite",
      "installationKey",
      "name",
      "personalizedPingEnabled",
      "playersOnline",
      "publicMetadata",
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
    assert.equal(payload.personalizedPingEnabled, true);
    assert.equal(payload.discordInvite, "https://discord.gg/Test_Code");
    assert.match(payload.installationKey, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(JSON.stringify(payload), /sh-testbattlegroup-directory/);
    assert.equal(delays.at(-1), 75000);

    const identity = JSON.parse(readFileSync(join(files.secretsDir, "public-directory.json"), "utf8"));
    assert.equal(identity.serverId, payload.serverId);
    assert.equal(identity.secret, payload.secret);
    assert.equal(statSync(join(files.secretsDir, "public-directory.json")).mode & 0o777, 0o600);
    assert.equal(reporter.publicState().remoteListed, true);
    assert.equal(reporter.publicState().listingClaimed, true);
  } finally {
    files.cleanup();
  }
});

test("claim endpoint override does not redirect normal directory heartbeats", async () => {
  const files = fixture();
  const requests = [];
  try {
    const identity = getOrCreateIdentity(join(files.secretsDir, "public-directory.json"));
    const reporter = createPublicDirectoryReporter({
      repoRoot: files.repoRoot,
      generatedDir: files.generatedDir,
      secretsDir: files.secretsDir
    }, {
      db: fakeDb(),
      getBattlegroupRunning: () => true,
      baseUrl: "https://directory.test/api/v1/servers",
      claimBaseUrl: "https://beta-directory.test/api/v1/servers/",
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        if (url.endsWith("/claim-status")) return response({ ok: true, claimed: false, playerPortalEnabled: false });
        return response({
          ok: true,
          nextHeartbeatSeconds: 60,
          ...(url.endsWith("/heartbeat") ? { listingClaimed: false } : {})
        });
      },
      setTimeoutFn: () => ({ unref() {} })
    });

    await reporter.tick();
    await reporter.verifyClaim("9F06-E912-70F0");

    assert.equal(requests[0].url, "https://directory.test/api/v1/servers/heartbeat");
    assert.equal(
      requests[2].url,
      `https://beta-directory.test/api/v1/servers/${identity.serverId}/verify-claim`
    );
    assert.equal(requests[2].options.headers.authorization, `Bearer ${identity.secret}`);
    assert.deepEqual(JSON.parse(requests[2].options.body), { code: "9F06E91270F0" });
    assert.equal(reporter.publicState().listingClaimed, true);
  } finally {
    files.cleanup();
  }
});

test("reporter uploads only player portal identities requested by the claimed listing", async () => {
  const files = fixture();
  const requests = [];
  const requestedHash = "a".repeat(64);
  const journeyData = { journey_aliases: { journey: "Friendly Journey" } };
  const skillData = [{ id: "Skills.Ability.Test", name: "Friendly Skill" }];
  try {
    const reporter = createPublicDirectoryReporter({
      repoRoot: files.repoRoot,
      generatedDir: files.generatedDir,
      secretsDir: files.secretsDir
    }, {
      db: fakeDb(),
      getBattlegroupRunning: () => true,
      baseUrl: "https://directory.test/api/v1/servers",
      playerPortalJourneyData: journeyData,
      playerPortalSkillData: skillData,
      collectPlayerPortalSnapshots: async (_db, hashes, loadedJourneys, loadedSkills) => {
        assert.deepEqual(hashes, [requestedHash]);
        assert.equal(loadedJourneys, journeyData);
        assert.equal(loadedSkills, skillData);
        return [{ accountHash: requestedHash, found: true, data: { overview: { characterName: "Test" } } }];
      },
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        if (url.endsWith("/heartbeat")) return response({ ok: true, nextHeartbeatSeconds: 60, listingClaimed: true });
        if (url.endsWith("/claim-status")) return response({ ok: true, claimed: true, playerPortalEnabled: true, requestedAccountHashes: [requestedHash] });
        return response({ ok: true, stored: 1 });
      },
      setTimeoutFn: () => ({ unref() {} }),
      now: () => Date.parse("2026-07-22T12:00:00Z")
    });

    await reporter.tick();
    assert.ok(requests.some(request => request.url.endsWith(`/claim-status`)));
    const upload = requests.find(request => request.url.endsWith("/player-portal/snapshot"));
    assert.ok(upload);
    const body = JSON.parse(upload.options.body);
    assert.equal(body.snapshots.length, 1);
    assert.equal(body.snapshots[0].accountHash, requestedHash);
    assert.equal(Object.hasOwn(body.snapshots[0], "platformId"), false);
  } finally {
    files.cleanup();
  }
});

test("directory installation keys are stable without exposing battlegroup IDs", () => {
  const files = fixture();
  try {
    const first = readDirectoryInstallationKey(files.repoRoot);
    const second = readDirectoryInstallationKey(files.repoRoot);
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(second, first);
    assert.notEqual(first, "sh-testbattlegroup-directory");

    writeFileSync(join(files.repoRoot, "runtime", "generated", "battlegroup.env"), "BATTLEGROUP_ID=sh-restored-battlegroup\n");
    assert.notEqual(readDirectoryInstallationKey(files.repoRoot), first);
  } finally {
    files.cleanup();
  }
});

test("external restores report the previous opaque installation key only for the adopted battlegroup", () => {
  const files = fixture();
  try {
    const previousKey = readDirectoryInstallationKey(files.repoRoot);
    writeFileSync(join(files.generatedDir, "battlegroup.env"), "BATTLEGROUP_ID=sh-adopted-battlegroup\n");
    writeFileSync(join(files.generatedDir, "battlegroup-restore-point.env"), [
      "PREVIOUS_BATTLEGROUP_ID=sh-testbattlegroup-directory",
      "ADOPTED_BATTLEGROUP_ID=sh-adopted-battlegroup"
    ].join("\n"));

    const currentKey = readDirectoryInstallationKey(files.repoRoot);
    assert.notEqual(currentKey, previousKey);
    assert.equal(readPreviousDirectoryInstallationKey(files.repoRoot, currentKey), previousKey);
    assert.equal(readPreviousDirectoryInstallationKey(files.repoRoot, previousKey), "");

    const payload = buildHeartbeatPayload(
      { serverId: "server-id", secret: "secret" },
      { name: "Test", region: "Europe", running: true, ready: true, playersOnline: 0, capacity: 60,
        version: "2036754", sietches: 1, installationKey: currentKey,
        previousInstallationKey: previousKey, discordInvite: "" }
    );
    assert.equal(payload.installationKey, currentKey);
    assert.equal(payload.previousInstallationKey, previousKey);
    assert.doesNotMatch(JSON.stringify(payload), /sh-(test|adopted)-battlegroup/);
  } finally {
    files.cleanup();
  }
});

test("Discord invite normalization accepts only official invite URLs", () => {
  assert.equal(normalizeDiscordInvite("https://discord.gg/Test_Code"), "https://discord.gg/Test_Code");
  assert.equal(normalizeDiscordInvite("https://discord.com/invite/Test-Code/"), "https://discord.gg/Test-Code");
  assert.equal(normalizeDiscordInvite("https://www.discord.com/invite/TestCode"), "https://discord.gg/TestCode");
  assert.equal(normalizeDiscordInvite(""), "");
  assert.equal(normalizeDiscordInvite("https://example.com/invite/TestCode"), null);
  assert.equal(normalizeDiscordInvite("https://discord.gg/TestCode?tracking=1"), null);
  assert.equal(normalizeDiscordInvite("javascript:alert(1)"), null);
});

test("directory receipt configures the authenticated outbound WebRTC probe", async () => {
  const files = fixture();
  const reconciles = [];
  try {
    const reporter = createPublicDirectoryReporter({
      repoRoot: files.repoRoot,
      generatedDir: files.generatedDir,
      secretsDir: files.secretsDir
    }, {
      db: fakeDb(),
      getBattlegroupRunning: () => true,
      fetchImpl: async () => response({
        ok: true,
        nextHeartbeatSeconds: 60,
        probe: {
          mode: "webrtc",
          signalingUrl: "https://dunedocker.app/api/v1/probes"
        }
      }),
      reconcileProbe: async (probe) => reconciles.push(probe),
      setTimeoutFn: () => ({ unref() {} })
    });

    await reporter.tick();

    assert.equal(reconciles.length, 1);
    assert.equal(reconciles[0].enabled, true);
    assert.equal(reconciles[0].signalingUrl, "https://dunedocker.app/api/v1/probes");
    assert.match(reconciles[0].serverId, /^[0-9a-f-]{36}$/i);
    assert.match(reconciles[0].secret, /^[A-Za-z0-9_-]{32,128}$/);
    assert.equal(reporter.publicState().probeEndpoint, "https://dunedocker.app/api/v1/probes");
    assert.equal(reporter.publicState().probeState, "started");
    assert.equal(reporter.publicState().probeError, null);
  } finally {
    files.cleanup();
  }
});

test("invalid personalized ping signaling URLs are ignored", async () => {
  const files = fixture();
  const reconciles = [];
  try {
    const reporter = createPublicDirectoryReporter({
      repoRoot: files.repoRoot,
      generatedDir: files.generatedDir,
      secretsDir: files.secretsDir
    }, {
      db: fakeDb(),
      getBattlegroupRunning: () => true,
      fetchImpl: async () => response({
        ok: true,
        probe: {
          mode: "webrtc",
          signalingUrl: "https://attacker.example/api/v1/probes"
        }
      }),
      reconcileProbe: async (probe) => reconciles.push(probe),
      setTimeoutFn: () => ({ unref() {} })
    });

    await reporter.tick();

    assert.deepEqual(reconciles, []);
    assert.equal(reporter.publicState().probeEndpoint, null);
    assert.equal(reporter.publicState().probeState, "unavailable");
  } finally {
    files.cleanup();
  }
});

test("unsupported personalized ping modes are ignored", async () => {
  const files = fixture();
  const reconciles = [];
  try {
    const reporter = createPublicDirectoryReporter({
      repoRoot: files.repoRoot,
      generatedDir: files.generatedDir,
      secretsDir: files.secretsDir
    }, {
      db: fakeDb(),
      getBattlegroupRunning: () => true,
      fetchImpl: async () => response({
        ok: true,
        probe: {
          mode: "https",
          signalingUrl: "https://dunedocker.app/api/v1/probes"
        }
      }),
      reconcileProbe: async (probe) => reconciles.push(probe),
      setTimeoutFn: () => ({ unref() {} })
    });

    await reporter.tick();

    assert.deepEqual(reconciles, []);
    assert.equal(reporter.publicState().probeEndpoint, null);
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
    assert.equal(delays.at(-1), 30000);
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
