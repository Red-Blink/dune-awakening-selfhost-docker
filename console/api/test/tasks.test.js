import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSelfUpdateHelperDockerArgs, TaskManager, taskTimeoutMs } from "../src/tasks.js";

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

test("long-running server tasks get an extended timeout", () => {
  const config = { commandTimeoutMs: 5000 };

  assert.equal(taskTimeoutMs(config, "status"), 5000);
  assert.equal(taskTimeoutMs(config, "start"), 30 * 60 * 1000);
  assert.equal(taskTimeoutMs(config, "stop"), 30 * 60 * 1000);
  assert.equal(taskTimeoutMs(config, "restartAll"), 30 * 60 * 1000);
  assert.equal(taskTimeoutMs(config, "storageCleanupImages"), 30 * 60 * 1000);
  assert.equal(taskTimeoutMs(config, "storageCleanupBuildCache"), 30 * 60 * 1000);
  assert.equal(taskTimeoutMs(config, "sietchesSetActive"), 30 * 60 * 1000);
  assert.equal(taskTimeoutMs(config, "sietchesReconcile"), 30 * 60 * 1000);
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
    extraEnv: ["ADMIN_BIND_PORT=8089"],
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
  assert(!args.includes("/repo:/repo"));
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
