import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
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
