import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSelfUpdateHelperDockerArgs, cleanupStaleSelfUpdateHelpers, publicTask, selfUpdateHelperAgeMs, taskWarnings, TaskManager, taskTimeoutMs } from "../src/tasks.js";

test("task manager creates and completes allowlisted dune tasks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-task-"));
  const duneScript = join(dir, "dune");
  writeFileSync(duneScript, "#!/usr/bin/env bash\necho task:$*\n", { mode: 0o700 });
  chmodSync(duneScript, 0o700);

  const manager = new TaskManager({
    duneScript,
    repoRoot: dir,
    taskRetention: 20,
    commandTimeoutMs: 5000
  });

  const created = manager.create("server", "status", {});
  assert.equal(created.status, "queued");

  const task = await waitForTask(manager, created.id);
  assert.equal(task.status, "succeeded");
  assert.equal(task.exitCode, 0);
  assert.match(task.logLines.map((line) => line.line).join("\n"), /task:status/);
});

test("game update check exit 100 is treated as update-available success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-task-update-"));
  const duneScript = join(dir, "dune");
  writeFileSync(duneScript, "#!/usr/bin/env bash\necho 'Local build: 100'\necho 'Remote build: 200'\necho 'Update available.'\nexit 100\n", { mode: 0o700 });
  chmodSync(duneScript, 0o700);

  const manager = new TaskManager({
    duneScript,
    repoRoot: dir,
    taskRetention: 20,
    commandTimeoutMs: 5000
  });

  const created = manager.create("updates", "updateCheck", {});
  const task = await waitForTask(manager, created.id);
  assert.equal(task.status, "succeeded");
  assert.equal(task.exitCode, 100);
  assert.match(task.logLines.map((line) => line.line).join("\n"), /Update available/);
});

test("USERSETTINGS_WARNING lines surface as task.warnings without disturbing logLines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-task-warn-"));
  const duneScript = join(dir, "dune");
  writeFileSync(
    duneScript,
    "#!/usr/bin/env bash\necho 'Global: +m_PvpEnabledPartitions=8 was saved -- Dual Deep Desert can change this.'\necho 'USERSETTINGS_WARNING: Global: +m_PvpEnabledPartitions=8 (PvP partition selector) was saved -- Dual Deep Desert can change this.'\necho done\n",
    { mode: 0o700 }
  );
  chmodSync(duneScript, 0o700);

  const manager = new TaskManager({
    duneScript,
    repoRoot: dir,
    taskRetention: 20,
    commandTimeoutMs: 5000
  });

  const created = manager.create("server", "status", {});
  assert.equal(created.status, "queued");
  const task = await waitForTask(manager, created.id);

  assert.deepEqual(taskWarnings(task), [
    "Global: +m_PvpEnabledPartitions=8 (PvP partition selector) was saved -- Dual Deep Desert can change this."
  ]);
  assert.deepEqual(publicTask(task).warnings, taskWarnings(task));
  assert.match(task.logLines.map((line) => line.line).join("\n"), /USERSETTINGS_WARNING: /);
});

test("a task with no USERSETTINGS_WARNING lines has an empty warnings array", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-task-nowarn-"));
  const duneScript = join(dir, "dune");
  writeFileSync(duneScript, "#!/usr/bin/env bash\necho task:$*\n", { mode: 0o700 });
  chmodSync(duneScript, 0o700);

  const manager = new TaskManager({
    duneScript,
    repoRoot: dir,
    taskRetention: 20,
    commandTimeoutMs: 5000
  });

  const created = manager.create("server", "status", {});
  const task = await waitForTask(manager, created.id);
  assert.deepEqual(publicTask(task).warnings, []);
});

test("long-running server tasks get an extended timeout", () => {
  const config = { commandTimeoutMs: 5000 };

  assert.equal(taskTimeoutMs(config, "status"), 5000);
  assert.equal(taskTimeoutMs(config, "start"), 30 * 60 * 1000);
  assert.equal(taskTimeoutMs(config, "stop"), 30 * 60 * 1000);
  assert.equal(taskTimeoutMs(config, "restartAll"), 30 * 60 * 1000);
  assert.equal(taskTimeoutMs(config, "storageCleanupImages"), 30 * 60 * 1000);
  assert.equal(taskTimeoutMs(config, "storageCleanupBuildCache"), 30 * 60 * 1000);
  assert.equal(taskTimeoutMs(config, "sietchesSetActive"), 30 * 60 * 1000);
  assert.equal(taskTimeoutMs(config, "deepdesertAction"), 30 * 60 * 1000);
  assert.equal(taskTimeoutMs(config, "sietchesRestart"), 30 * 60 * 1000);
  assert.equal(taskTimeoutMs(config, "sietchesReconcile"), 30 * 60 * 1000);
  assert.equal(taskTimeoutMs(config, "restartServiceStop"), 30 * 60 * 1000);
  assert.equal(taskTimeoutMs(config, "restartServiceStart"), 30 * 60 * 1000);
  assert.equal(taskTimeoutMs(config, "sietchesRestartStop"), 30 * 60 * 1000);
  assert.equal(taskTimeoutMs(config, "sietchesRestartStart"), 30 * 60 * 1000);
});

test("web self-update helper mounts the host repo path", () => {
  const args = buildSelfUpdateHelperDockerArgs({
    helperName: "dune-web-self-update-test",
    hostRepoRoot: "/home/ubuntu/dune-awakening-selfhost-docker",
    composeProjectName: "dune-awakening-selfhost-docker",
    helperImage: "redblink-dune-docker-console:dev",
    hostUid: "1000",
    hostGid: "1000",
    dockerSocketGid: "988",
    extraEnv: ["ADMIN_BIND_PORT=8089", "DUNE_SELF_UPDATE_TOKEN", "DUNE_SELF_UPDATE_RUN_ID=123e4567-e89b-42d3-a456-426614174000"],
    command: "runtime/scripts/dune self-update install latest"
  });

  assert(args.includes("-v"));
  assert(args.includes("/home/ubuntu/dune-awakening-selfhost-docker:/repo"));
  assert(args.includes("DUNE_HOST_REPO_ROOT=/home/ubuntu/dune-awakening-selfhost-docker"));
  assert(args.includes("1000:1000"));
  assert(args.includes("988"));
  assert(args.includes("DUNE_HOST_UID=1000"));
  assert(args.includes("DUNE_HOST_GID=1000"));
  assert(args.includes("DOCKER_SOCKET_GID=988"));
  assert(args.includes("ADMIN_BIND_PORT=8089"));
  assert(args.includes("DUNE_SELF_UPDATE_TOKEN"));
  assert(args.includes("DUNE_SELF_UPDATE_RUN_ID=123e4567-e89b-42d3-a456-426614174000"));
  assert(args.includes("io.github.red-blink.dune-selfhost.role=self-update-helper"));
  assert.deepEqual(args.slice(args.indexOf("--entrypoint"), args.indexOf("--entrypoint") + 4), ["--entrypoint", "/bin/sh", "redblink-dune-docker-console:dev", "-lc"]);
  assert(!args.includes("/repo:/repo"));
});

test("self-update helper age recognizes both current and legacy helper names", () => {
  const now = 2_000_000_000_000;
  assert.equal(selfUpdateHelperAgeMs("dune-web-self-update-1999999880000", now), 120_000);
  assert.equal(selfUpdateHelperAgeMs("dune-console-self-update-1999999700", now), 300_000);
  assert.equal(selfUpdateHelperAgeMs("redblink-dune-docker-console", now), 0);
});

test("self-update helper cleanup removes stale or stopped helpers and blocks a live one", async () => {
  const now = Date.now();
  const stale = `dune-web-self-update-${now - 3_000_000}`;
  const stopped = `dune-web-self-update-${now - 10_000}`;
  const active = `dune-web-self-update-${now}`;
  const calls = [];
  await cleanupStaleSelfUpdateHelpers("/repo", async (args) => {
    calls.push(args);
    if (args[0] === "ps") return { code: 0, stdout: `${stale}\trunning\n${stopped}\texited\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  assert.deepEqual(calls[1], ["rm", "-f", stale, stopped]);

  await assert.rejects(cleanupStaleSelfUpdateHelpers("/repo", async () => ({
    code: 0,
    stdout: `${active}\trunning\n`,
    stderr: ""
  })), /Another console update is already running/);
});

test("detached self-update stays running until durable helper status completes it", async () => {
  const previousProject = process.env.DUNE_COMPOSE_PROJECT_NAME;
  process.env.DUNE_COMPOSE_PROJECT_NAME = "dune-test";
  const calls = [];
  const repoRoot = mkdtempSync(join(tmpdir(), "arrakis-self-update-task-"));
  const manager = new TaskManager({
    repoRoot,
    hostRepoRoot: "/host/repo",
    taskRetention: 20,
    commandTimeoutMs: 5000
  }, {
    runDockerCommand: async (args) => {
      calls.push(args);
      if (args[0] === "ps") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "helper-id\n", stderr: "" };
    }
  });

  try {
    const created = manager.create("updates", "selfUpdateApply", {});
    let current = manager.get(created.id);
    for (let attempt = 0; attempt < 100 && current?.currentStep !== "Update helper running"; attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      current = manager.get(created.id);
    }
    assert.equal(current?.status, "running");
    assert.equal(current?.finishedAt, null);
    assert.match(current?.progressMessage || "", /helper is running/i);
    assert.equal(calls[0][0], "ps");
    assert(calls[1].includes(`DUNE_SELF_UPDATE_RUN_ID=${created.id}`));
    assert(calls[1].includes("DUNE_SELF_UPDATE_BUILD_TIMEOUT_SECONDS=1800"));
    assert.match(readFileSync(join(repoRoot, "runtime", "generated", "self-update-status", `${created.id}.env`), "utf8"), /^stage=launching$/m);
  } finally {
    if (previousProject === undefined) delete process.env.DUNE_COMPOSE_PROJECT_NAME;
    else process.env.DUNE_COMPOSE_PROJECT_NAME = previousProject;
  }
});

test("repeated updateCheck tasks within the cache window reuse one SteamCMD invocation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-task-cache-"));
  let collectCount = 0;
  const fakeCache = {
    peek: () => null,
    read: async (opts) => {
      if (!opts.fresh) {
        if (collectCount > 0) {
          return {
            code: 0,
            stdout: "Local build: 100\nRemote build: 200\nNo update available.",
            stderr: "",
            fromCache: true,
            sampledAtMs: Date.now() - 1000
          };
        }
      }
      collectCount++;
      return {
        code: 0,
        stdout: "Local build: 100\nRemote build: 200\nNo update available.",
        stderr: "",
        fromCache: false,
        sampledAtMs: Date.now()
      };
    },
    invalidate: () => {}
  };

  const manager = new TaskManager({
    duneScript: join(dir, "dune"),
    repoRoot: dir,
    taskRetention: 20,
    commandTimeoutMs: 5000,
    updateCheckCacheMs: 5000
  }, { updateCheckCache: fakeCache });

  const created1 = manager.create("updates", "updateCheck", {});
  const task1 = await waitForTask(manager, created1.id);
  assert.equal(task1.status, "succeeded", task1.errorMessage);
  assert.equal(task1.exitCode, 0);

  const created2 = manager.create("updates", "updateCheck", {});
  const task2 = await waitForTask(manager, created2.id);
  assert.equal(task2.status, "succeeded", task2.errorMessage);
  assert.equal(task2.exitCode, 0);
  assert.match(task2.logLines.map((line) => line.line).join("\n"), /Reusing update check result/);

  assert.equal(collectCount, 1, "collect should have been called exactly once");
});

test("updateCheck with fresh:true bypasses the cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-task-fresh-"));
  let collectCount = 0;
  const fakeCache = {
    peek: () => null,
    read: async (opts) => {
      collectCount++;
      return {
        code: 0,
        stdout: "Local build: 100\nRemote build: 200\nNo update available.",
        stderr: "",
        fromCache: false,
        sampledAtMs: Date.now()
      };
    },
    invalidate: () => {}
  };

  const manager = new TaskManager({
    duneScript: join(dir, "dune"),
    repoRoot: dir,
    taskRetention: 20,
    commandTimeoutMs: 5000,
    updateCheckCacheMs: 5000
  }, { updateCheckCache: fakeCache });

  const created1 = manager.create("updates", "updateCheck", {});
  const task1 = await waitForTask(manager, created1.id);
  assert.equal(task1.status, "succeeded", task1.errorMessage);

  const created2 = manager.create("updates", "updateCheck", { fresh: true });
  const task2 = await waitForTask(manager, created2.id);
  assert.equal(task2.status, "succeeded", task2.errorMessage);
  assert.match(task2.logLines.map((line) => line.line).join("\n"), /Ran a live Steam update check/);

  assert.equal(collectCount, 2, "collect should have been called exactly twice (once for each call, no caching with fresh:true)");
});

test("a successful updateApply invalidates the update check cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-task-invalidate-"));
  let collectCount = 0;
  let cacheValid = false;
  const fakeCache = {
    peek: () => null,
    read: async (opts) => {
      if (!opts.fresh && cacheValid) {
        return {
          code: 0,
          stdout: "Local build: 100\nRemote build: 200\nNo update available.",
          stderr: "",
          fromCache: true,
          sampledAtMs: Date.now() - 1000
        };
      }
      collectCount++;
      cacheValid = true;
      return {
        code: 0,
        stdout: "Local build: 100\nRemote build: 200\nNo update available.",
        stderr: "",
        fromCache: false,
        sampledAtMs: Date.now()
      };
    },
    invalidate: () => { cacheValid = false; }
  };

  const duneScript = join(dir, "dune");
  writeFileSync(duneScript, "#!/usr/bin/env bash\nif [ \"$1\" = \"update\" ] && [ \"$2\" = \"check\" ]; then\n  echo 'Local build: 100'\n  echo 'Remote build: 200'\n  echo 'No update available.'\nfi\nexit 0\n", { mode: 0o700 });
  chmodSync(duneScript, 0o700);

  const manager = new TaskManager({
    duneScript,
    repoRoot: dir,
    taskRetention: 20,
    commandTimeoutMs: 5000,
    updateCheckCacheMs: 5000
  }, { updateCheckCache: fakeCache });

  const created1 = manager.create("updates", "updateCheck", {});
  const task1 = await waitForTask(manager, created1.id);
  assert.equal(task1.status, "succeeded", task1.errorMessage);

  const created2 = manager.create("updates", "updateApply", {});
  const task2 = await waitForTask(manager, created2.id);
  assert.equal(task2.status, "succeeded", task2.errorMessage);

  const created3 = manager.create("updates", "updateCheck", {});
  const task3 = await waitForTask(manager, created3.id);
  assert.equal(task3.status, "succeeded", task3.errorMessage);
  assert.match(task3.logLines.map((line) => line.line).join("\n"), /Ran a live Steam update check/, "should have run live, not from cache");

  assert.equal(collectCount, 2, "collect should have been called 2 times (once before update, once after invalidation)");
});

test("TaskManager threads payload.fresh into the injected update check cache's read call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-task-thread-"));
  const calls = [];
  const fakeCache = {
    peek: () => null,
    read: async (opts) => {
      calls.push(opts);
      return {
        code: 0,
        stdout: "Local build: 1\nRemote build: 1\nNo update available.",
        stderr: "",
        fromCache: false,
        sampledAtMs: Date.now()
      };
    },
    invalidate: () => {}
  };

  const manager = new TaskManager({
    duneScript: join(dir, "dune"),
    repoRoot: dir,
    taskRetention: 20,
    commandTimeoutMs: 5000
  }, { updateCheckCache: fakeCache });

  const created1 = manager.create("updates", "updateCheck", {});
  const task1 = await waitForTask(manager, created1.id);
  assert.equal(task1.status, "succeeded");

  const created2 = manager.create("updates", "updateCheck", { fresh: true });
  const task2 = await waitForTask(manager, created2.id);
  assert.equal(task2.status, "succeeded");

  assert.deepEqual(calls, [{ fresh: false }, { fresh: true }]);
});

test("create() returns an already-succeeded task synchronously on a peek cache hit", () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-task-peek-"));
  const fakeCache = {
    peek: () => ({ code: 0, stdout: "Local build: 1\nRemote build: 1\nNo update available.", stderr: "", fromCache: true, sampledAtMs: Date.now() - 1000 }),
    read: async () => { throw new Error("read() should not be called on a peek hit"); },
    invalidate: () => {}
  };
  const manager = new TaskManager({
    duneScript: join(dir, "dune"), repoRoot: dir, taskRetention: 20, commandTimeoutMs: 5000
  }, { updateCheckCache: fakeCache });

  const created = manager.create("updates", "updateCheck", {});
  assert.equal(created.status, "succeeded");
  assert.equal(created.exitCode, 0);
  assert.equal(created.currentStep, "Finished");
  assert.match(created.logLines.map((l) => l.line).join("\n"), /Reusing update check result/);
});

test("create() with fresh:true skips peek and stays on the queued/async path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-task-peek-fresh-"));
  let peekCalls = 0;
  const fakeCache = {
    peek: () => { peekCalls += 1; return { code: 0, stdout: "x", stderr: "", sampledAtMs: Date.now() }; },
    read: async () => ({ code: 0, stdout: "Ran a live Steam update check.\nLocal build: 1\nRemote build: 1\nNo update available.", stderr: "", fromCache: false, sampledAtMs: Date.now() }),
    invalidate: () => {}
  };
  const manager = new TaskManager({ duneScript: join(dir, "dune"), repoRoot: dir, taskRetention: 20, commandTimeoutMs: 5000 }, { updateCheckCache: fakeCache });
  const created = manager.create("updates", "updateCheck", { fresh: true });
  assert.equal(created.status, "queued");
  assert.equal(peekCalls, 0);
  const task = await waitForTask(manager, created.id);
  assert.equal(task.status, "succeeded");
});

test("create() falls through to the queued/async path when peek returns null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-task-peek-miss-"));
  const fakeCache = {
    peek: () => null,
    read: async () => ({ code: 0, stdout: "Ran a live Steam update check.\nLocal build: 1\nRemote build: 1\nNo update available.", stderr: "", fromCache: false, sampledAtMs: Date.now() }),
    invalidate: () => {}
  };
  const manager = new TaskManager({ duneScript: join(dir, "dune"), repoRoot: dir, taskRetention: 20, commandTimeoutMs: 5000 }, { updateCheckCache: fakeCache });
  const created = manager.create("updates", "updateCheck", {});
  assert.equal(created.status, "queued");
  const task = await waitForTask(manager, created.id);
  assert.equal(task.status, "succeeded");
  assert.match(task.logLines.map((l) => l.line).join("\n"), /Ran a live Steam update check/);
});

test("a survival restart flushes queued map writes between the stop and start steps, not after both", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-task-flush-order-"));
  const duneScript = join(dir, "dune");
  const callLogPath = join(dir, "calls.log");
  writeFileSync(callLogPath, "");
  writeFileSync(duneScript, `#!/usr/bin/env bash\necho "$*" >> "${callLogPath}"\n`, { mode: 0o700 });
  chmodSync(duneScript, 0o700);

  const manager = new TaskManager(
    { duneScript, repoRoot: dir, taskRetention: 20, commandTimeoutMs: 5000 },
    { onMapDown: async (operation) => { appendFileSync(callLogPath, `flush:${operation}\n`); return { flushed: [] }; } }
  );

  const created = manager.create("server", "restartService", { service: "survival" });
  const task = await waitForTask(manager, created.id);
  assert.equal(task.status, "succeeded", task.errorMessage);

  const callLog = readFileSync(callLogPath, "utf8").trim().split("\n");
  assert.deepEqual(callLog, ["stop-service survival", "flush:restartServiceStop", "restart survival"]);
});

test("a battlegroup restart stops game maps and flushes queued writes before PostgreSQL is removed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-task-full-restart-flush-"));
  const duneScript = join(dir, "dune");
  const callLogPath = join(dir, "calls.log");
  writeFileSync(callLogPath, "");
  writeFileSync(duneScript, `#!/usr/bin/env bash\necho "$*" >> "${callLogPath}"\n`, { mode: 0o700 });
  chmodSync(duneScript, 0o700);

  const manager = new TaskManager(
    { duneScript, repoRoot: dir, taskRetention: 20, commandTimeoutMs: 5000 },
    { onMapDown: async (operation) => { appendFileSync(callLogPath, `flush:${operation}\n`); return { flushed: [] }; } }
  );

  const created = manager.create("server", "restartAll", {});
  const task = await waitForTask(manager, created.id);
  assert.equal(task.status, "succeeded", task.errorMessage);
  assert.deepEqual(readFileSync(callLogPath, "utf8").trim().split("\n"), [
    "stop-game-servers-for-db-writes",
    "flush:stopGameServersForDbWrites",
    "stop",
    "start"
  ]);
});

test("a Sietch restart flushes queued map writes between the stop and start steps, not after both", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-task-flush-order-sietch-"));
  const duneScript = join(dir, "dune");
  const callLogPath = join(dir, "calls.log");
  writeFileSync(callLogPath, "");
  writeFileSync(duneScript, `#!/usr/bin/env bash\necho "$*" >> "${callLogPath}"\n`, { mode: 0o700 });
  chmodSync(duneScript, 0o700);

  const manager = new TaskManager(
    { duneScript, repoRoot: dir, taskRetention: 20, commandTimeoutMs: 5000 },
    { onMapDown: async (operation) => { appendFileSync(callLogPath, `flush:${operation}\n`); return { flushed: [] }; } }
  );

  const created = manager.create("server", "sietchesRestart", { partitionId: 31 });
  const task = await waitForTask(manager, created.id);
  assert.equal(task.status, "succeeded", task.errorMessage);

  const callLog = readFileSync(callLogPath, "utf8").trim().split("\n");
  assert.deepEqual(callLog, ["sietches stop-partition 31", "flush:sietchesRestartStop", "sietches start-partition 31"]);
});

test("map-down refill results distinguish generator, water, and queue-specific failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-task-flush-results-"));
  const manager = new TaskManager(
    { duneScript: join(dir, "dune"), repoRoot: dir, taskRetention: 20, commandTimeoutMs: 5000 },
    {
      onMapDown: async () => ({
        flushed: [
          { ok: true, refillType: "generator" },
          { ok: true, refillType: "water" },
          { ok: true, refillType: "generator", noLongerApplicable: true },
          { ok: true, refillType: "water", noLongerApplicable: true }
        ],
        failures: [{ refillType: "water", error: "database unavailable" }]
      })
    }
  );
  const task = { logLines: [], subscribers: new Set() };

  await manager.flushPendingMapWrites(task, "restartServiceStop");

  const lines = task.logLines.map((entry) => entry.line);
  assert.deepEqual(lines, [
    "Applied 1 queued generator refill.",
    "Applied 1 queued water refill.",
    "Cleared 1 obsolete generator refill; the base or its generators no longer exist.",
    "Cleared 1 obsolete water refill; the base or its water storage no longer exists.",
    "QUEUED_WRITE_WARNING: Queued water refills were not applied: database unavailable"
  ]);
  // The prefix is stripped back off for the task's own warnings list, which is
  // what the Console panel renders -- the log keeps the tagged line.
  assert.deepEqual(taskWarnings(task), ["Queued water refills were not applied: database unavailable"]);
});

test("a wedged flush is reported and the restart carries on instead of hanging", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-task-flush-timeout-"));
  const previous = process.env.ADMIN_MAP_WRITE_FLUSH_TIMEOUT_MS;
  process.env.ADMIN_MAP_WRITE_FLUSH_TIMEOUT_MS = "1000";
  try {
    const manager = new TaskManager(
      { duneScript: join(dir, "dune"), repoRoot: dir, taskRetention: 20, commandTimeoutMs: 5000 },
      // Never settles: a stuck PostgreSQL connection, or a backup process that
      // never exits. Without the bound this await never returns and the
      // restart's start half never runs.
      { onMapDown: () => new Promise(() => {}) }
    );
    const task = { logLines: [], subscribers: new Set() };
    // withTimeout unrefs its timer, so a wedged onMapDown leaves nothing to
    // keep the event loop alive and the runner would tear this file down.
    const keepAlive = setInterval(() => {}, 1000);

    await manager.flushPendingMapWrites(task, "restartServiceStop");
    clearInterval(keepAlive);

    assert.deepEqual(task.logLines.map((entry) => entry.line), [
      "QUEUED_WRITE_WARNING: Queued map writes were not applied: Queued map writes did not finish within 1s; continuing the restart. They stay queued and apply on a later pass."
    ]);
    assert.deepEqual(taskWarnings(task), ["Queued map writes were not applied: Queued map writes did not finish within 1s; continuing the restart. They stay queued and apply on a later pass."]);
    assert.deepEqual(task.logLines.map((entry) => entry.stream), ["stderr"]);
  } finally {
    if (previous === undefined) delete process.env.ADMIN_MAP_WRITE_FLUSH_TIMEOUT_MS;
    else process.env.ADMIN_MAP_WRITE_FLUSH_TIMEOUT_MS = previous;
  }
});

test("a per-entry flush failure reaches the task log rather than being dropped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-task-flush-entry-failures-"));
  const manager = new TaskManager(
    { duneScript: join(dir, "dune"), repoRoot: dir, taskRetention: 20, commandTimeoutMs: 5000 },
    {
      onMapDown: async () => ({
        flushed: [
          { ok: true, refillType: "delete" },
          { ok: false, refillType: "delete", error: "This base was picked up into a backup and is no longer claimed." }
        ]
      })
    }
  );
  const task = { logLines: [], subscribers: new Set() };

  await manager.flushPendingMapWrites(task, "restartServiceStop");

  assert.deepEqual(task.logLines.map((entry) => entry.line), [
    "Applied 1 queued base delete.",
    "QUEUED_WRITE_WARNING: 1 queued base delete could not be applied and stay queued: This base was picked up into a backup and is no longer claimed."
  ]);
  // Applied lines stay off the warnings list; only the failure is promoted.
  assert.deepEqual(taskWarnings(task), ["1 queued base delete could not be applied and stay queued: This base was picked up into a backup and is no longer claimed."]);
});

function waitForTask(manager, id) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 3000;
    const timer = setInterval(() => {
      const task = manager.get(id);
      if (task && ["succeeded", "failed", "cancelled"].includes(task.status)) {
        clearInterval(timer);
        resolve(task);
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error("task did not finish"));
      }
    }, 20);
  });
}

// The prefix is an internal marker for taskWarnings, not something an operator
// should read. The log is a disclosure anyone can open and the de-prefixed text
// already renders above it, so shipping the sentinel would show the same line
// twice, once with leaked plumbing on the front.
test("the public task strips the internal warning prefix from its log lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-task-prefix-"));
  const manager = new TaskManager(
    { duneScript: join(dir, "dune"), repoRoot: dir, taskRetention: 20, commandTimeoutMs: 5000 },
    {
      onMapDown: async () => ({
        flushed: [{ ok: false, refillType: "delete", error: "This base was picked up into a backup." }]
      })
    }
  );
  const task = { logLines: [], subscribers: new Set() };

  await manager.flushPendingMapWrites(task, "restartServiceStop");

  const internal = task.logLines.map((entry) => entry.line);
  assert.match(internal[0], /^QUEUED_WRITE_WARNING: /, "the marker stays on the internal line");

  const shipped = publicTask({ ...task, id: "t", type: "server", operation: "restartService", status: "succeeded", currentStep: "", progressMessage: "", startedAt: "", finishedAt: null, exitCode: 0, errorMessage: null });
  assert.doesNotMatch(shipped.logLines[0].line, /QUEUED_WRITE_WARNING/, "but never reaches the browser");
  assert.deepEqual(shipped.warnings, ["1 queued base delete could not be applied and stay queued: This base was picked up into a backup."]);
});

// Subprocess output reaches append() verbatim, so a spawned script printing the
// internal marker could otherwise forge an operator-facing warning. The
// usersettings marker is deliberately still honoured: usersettings.py is the
// shipped script that raises it.
test("a subprocess cannot forge a queued-write warning, but usersettings warnings still work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-task-spoof-"));
  const duneScript = join(dir, "dune");
  writeFileSync(
    duneScript,
    "#!/usr/bin/env bash\necho 'QUEUED_WRITE_WARNING: All queued base deletes were applied.'\necho 'USERSETTINGS_WARNING: a real one'\necho done\n",
    { mode: 0o700 }
  );
  chmodSync(duneScript, 0o700);

  const manager = new TaskManager({ duneScript, repoRoot: dir, taskRetention: 20, commandTimeoutMs: 5000 });
  const task = await waitForTask(manager, manager.create("server", "status", {}).id);

  assert.deepEqual(taskWarnings(task), ["a real one"], "only the shipped script's marker is honoured");
  const log = task.logLines.map((line) => line.line);
  // The forged line is still logged -- it is the operator's own script output --
  // but stripped of the marker so it cannot be promoted.
  assert.ok(log.includes("All queued base deletes were applied."), `forged text stays in the log: ${log.join(" | ")}`);
  assert.ok(!log.some((line) => line.startsWith("QUEUED_WRITE_WARNING: ")), "the marker must not survive from a subprocess");
});
