import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDuneArgs } from "../src/runner.js";
import { TaskManager } from "../src/tasks.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const duneSource = source("runtime/scripts/dune");

function source(path) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function assertExecutable(path) {
  assert.notEqual(statSync(resolve(repoRoot, path)).mode & 0o111, 0, `${path} is not executable`);
}

function assertDuneRoute(command, script) {
  assert.ok(duneSource.split("\n").includes(`  ${command})`), `missing dune route: ${command}`);
  assert.ok(duneSource.includes(script), `dune route ${command} does not invoke ${script}`);
  assertExecutable(script);
}

function assertRootHelpers(path, expectedCount) {
  const helpers = source(path)
    .split("\n")
    .filter((line) => line.includes("docker run --rm") && line.includes("--privileged"));
  assert.equal(helpers.length, expectedCount, `${path} privileged helper count changed`);
  for (const helper of helpers) assert.match(helper, /docker run --rm --user 0:0 --privileged/);
}

async function assertWebWrite(operation, payload, expectedArgs) {
  const dir = mkdtempSync(join(tmpdir(), "dune-operation-matrix-"));
  const duneScript = join(dir, "dune");
  writeFileSync(duneScript, "#!/usr/bin/env bash\nprintf 'web-write:%s\\n' \"$*\"\n", { mode: 0o700 });
  chmodSync(duneScript, 0o700);

  const manager = new TaskManager({
    duneScript,
    repoRoot: dir,
    taskRetention: 10,
    commandTimeoutMs: 5000
  });
  const created = manager.create("matrix", operation, payload);
  const completed = await waitForTask(manager, created.id);
  assert.equal(completed.status, "succeeded", completed.errorMessage || "task failed");
  const expectedOutput = `web-write:${expectedArgs.join(" ")}`;
  assert.ok(completed.logLines.some((line) => line.line.includes(expectedOutput)), `missing task output: ${expectedOutput}`);
}

function waitForTask(manager, id) {
  return new Promise((resolveTask, reject) => {
    const deadline = Date.now() + 3000;
    const timer = setInterval(() => {
      const task = manager.get(id);
      if (task && ["succeeded", "failed", "cancelled"].includes(task.status)) {
        clearInterval(timer);
        resolveTask(task);
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error("task did not finish"));
      }
    }, 10);
  });
}

// Critical operations (1-10)
test("01 Critical: self-update preserves host identity and Docker access", () => {
  assert.deepEqual(buildDuneArgs("selfUpdateApply"), ["self-update", "install", "latest"]);
  const script = source("runtime/scripts/self-update.sh");
  assert.match(script, /--user "\$\{DUNE_HOST_UID:-0\}:\$\{DUNE_HOST_GID:-0\}"/);
  assert.match(script, /--group-add "\$\{DOCKER_SOCKET_GID:-0\}"/);
});

test("02 Critical: console command routes to an executable helper", () => {
  assertDuneRoute("console|web", "runtime/scripts/console.sh");
});

test("03 Critical: game update routes correctly and its host helpers run as root", () => {
  assert.deepEqual(buildDuneArgs("updateApply"), ["update", "--yes"]);
  assertDuneRoute("update", "runtime/scripts/update.sh");
  assertRootHelpers("runtime/scripts/update.sh", 3);
});

test("04 Critical: start repairs runtime ownership before starting services", () => {
  assert.deepEqual(buildDuneArgs("start"), ["start"]);
  assert.match(duneSource, /DUNE_IGNORE_MANUAL_STOP=1 runtime\/scripts\/start-all\.sh/);
  assert.match(source("runtime/scripts/start-all.sh"), /runtime\/scripts\/repair-host-runtime-permissions\.sh/);
});

test("05 Critical: stop routes to the executable full-stop helper", () => {
  assert.deepEqual(buildDuneArgs("stop"), ["stop"]);
  assert.match(duneSource, /DUNE_MANUAL_STOP=1 runtime\/scripts\/stop-all\.sh/);
  assertExecutable("runtime/scripts/stop-all.sh");
});

test("06 Critical: restart routes only to allowlisted services", () => {
  assert.deepEqual(buildDuneArgs("restartService", { service: "gateway" }), ["restart", "gateway"]);
  assert.deepEqual(buildDuneArgs("restartService", { service: "director" }), ["restart", "director"]);
  assert.throws(() => buildDuneArgs("restartService", { service: "bad;command" }));
});

test("07 Critical: shutdown-protection host helpers run explicitly as root", () => {
  assert.deepEqual(buildDuneArgs("shutdownProtectionEnable"), ["shutdown-protection", "enable"]);
  assertRootHelpers("runtime/scripts/shutdown-protection.sh", 4);
});

test("08 Critical: public-IP restart host helpers run explicitly as root", () => {
  assert.deepEqual(buildDuneArgs("ipChangeRestartEnable", { intervalMinutes: 5, notifyMinutes: 1 }), ["ip-change-restart", "enable", "5", "1"]);
  assertRootHelpers("runtime/scripts/ip-change-restart.sh", 3);
});

test("09 Critical: scheduled restart host helpers run explicitly as root", () => {
  assert.deepEqual(buildDuneArgs("restartScheduleEnable", { time: "05:00", notifyMinutes: 15 }), ["restart-schedule", "enable", "05:00", "15"]);
  assertRootHelpers("runtime/scripts/restart-schedule.sh", 3);
});

test("10 Critical: automatic update and backup timer helpers run as root", () => {
  assertRootHelpers("runtime/scripts/update.sh", 3);
  assertRootHelpers("runtime/scripts/db.sh", 3);
});

// Service operations (11-19)
test("11 Service: dynamic map spawn is allowlisted", () => {
  assert.deepEqual(buildDuneArgs("mapsSpawn", { target: "DeepDesert_1" }), ["spawn", "DeepDesert_1"]);
  assertDuneRoute("spawn", "runtime/scripts/spawn-server.sh");
});

test("12 Service: dynamic map despawn is allowlisted and forced by the UI", () => {
  assert.deepEqual(buildDuneArgs("mapsDespawn", { target: "DeepDesert_1" }), ["despawn", "DeepDesert_1", "--force"]);
  assertDuneRoute("despawn", "runtime/scripts/despawn-server.sh");
});

test("13 Service: autoscaler start uses the permission-aware launcher", () => {
  assert.deepEqual(buildDuneArgs("autoscalerAction", { action: "start" }), ["autoscaler", "start"]);
  assert.match(source("runtime/scripts/autoscaler-control.sh"), /runtime\/scripts\/start-autoscaler\.sh/);
  assert.match(source("runtime/scripts/start-autoscaler.sh"), /repair-host-runtime-permissions\.sh/);
});

test("14 Service: autoscaler stop is allowlisted", () => {
  assert.deepEqual(buildDuneArgs("autoscalerAction", { action: "stop" }), ["autoscaler", "stop"]);
  assert.match(source("runtime/scripts/autoscaler-control.sh"), /docker rm -f "\$CONTAINER_NAME"/);
});

test("15 Service: autoscaler restart performs stop then start", () => {
  assert.deepEqual(buildDuneArgs("autoscalerAction", { action: "restart" }), ["autoscaler", "restart"]);
  assert.match(source("runtime/scripts/autoscaler-control.sh"), /restart\)\s*\n\s*stop \|\| true\s*\n\s*start/);
});

test("16 Service: gateway startup helper is executable", () => {
  assertExecutable("runtime/scripts/start-server-gateway.sh");
  assert.match(source("runtime/scripts/start-all.sh"), /start-server-gateway\.sh/);
});

test("17 Service: gateway restart route uses its startup helper", () => {
  assert.deepEqual(buildDuneArgs("restartService", { service: "gateway" }), ["restart", "gateway"]);
  assert.match(duneSource, /gateway\|sgw\)[\s\S]*?start-server-gateway\.sh/);
});

test("18 Service: director startup helper is executable", () => {
  assertExecutable("runtime/scripts/start-director.sh");
  assert.match(source("runtime/scripts/start-all.sh"), /start-director\.sh/);
});

test("19 Service: director restart route uses its startup helper", () => {
  assert.deepEqual(buildDuneArgs("restartService", { service: "director" }), ["restart", "director"]);
  assert.match(duneSource, /director\|bgd\)[\s\S]*?start-director\.sh/);
});

// Database operations (20-22)
test("20 Database: backup creation route is allowlisted", () => {
  assert.deepEqual(buildDuneArgs("backupCreate"), ["db", "backup"]);
  assertDuneRoute("db", "runtime/scripts/db.sh");
});

test("21 Database: restore validates the backup and disables duplicate safety backups", () => {
  assert.deepEqual(buildDuneArgs("backupRestore", { backup: "dune-db-test.backup" }), ["db", "restore", "dune-db-test.backup", "--no-safety-backup"]);
  assert.throws(() => buildDuneArgs("backupRestore", { backup: "../unsafe.backup" }));
});

test("22 Database: maintenance health check is routed by the database helper", () => {
  const script = source("runtime/scripts/db.sh");
  assert.match(script, /dune db health/);
  assert.match(script, /health\)\s*\n\s*health_db/);
  assertExecutable("runtime/scripts/db.sh");
});

// Configuration operations (23-27)
test("23 Config: memory settings validate map and memory values", () => {
  assert.deepEqual(buildDuneArgs("memorySet", { map: "DeepDesert_1", memory: "8g" }), ["memory", "set", "DeepDesert_1", "8g"]);
  assert.throws(() => buildDuneArgs("memorySet", { map: "DeepDesert_1", memory: "8gb" }));
});

test("24 Config: network repair route is allowlisted", () => {
  assert.deepEqual(buildDuneArgs("networkBindFix"), ["network", "fix"]);
  assertDuneRoute("network", "runtime/scripts/network-bind.sh");
});

test("24b Maintenance: Docker storage cleanup routes are fixed and allowlisted", () => {
  assert.deepEqual(buildDuneArgs("storageCleanupImages"), ["storage", "cleanup"]);
  assert.deepEqual(buildDuneArgs("storageCleanupBuildCache"), ["storage", "cleanup", "--build-cache"]);
  assertDuneRoute("storage", "runtime/scripts/storage.sh");
  const server = source("console/api/src/server.js");
  assert.match(server, /storage\/cleanup-images[\s\S]*?confirmedTask[\s\S]*?storageCleanupImages[\s\S]*?CLEAN OBSOLETE DUNE IMAGES/);
  assert.match(server, /storage\/cleanup-build-cache[\s\S]*?confirmedTask[\s\S]*?storageCleanupBuildCache[\s\S]*?CLEAN DOCKER BUILD CACHE/);
});

test("25 Config: map listing route is read-safe", () => {
  assert.deepEqual(buildDuneArgs("mapsList"), ["maps", "list"]);
  assertDuneRoute("maps", "runtime/scripts/map-modes.sh");
});

test("26 Config: map mode writes validate the mode", () => {
  assert.deepEqual(buildDuneArgs("mapsSetMode", { map: "DeepDesert_1", mode: "always-on" }), ["maps", "set", "DeepDesert_1", "always-on"]);
  assert.throws(() => buildDuneArgs("mapsSetMode", { map: "DeepDesert_1", mode: "invalid" }));
});

test("27 Config: sietch updates validate map and count", () => {
  assert.deepEqual(buildDuneArgs("sietchesSetActive", { map: "Survival_1", count: 2 }), ["sietches", "set-active", "Survival_1", "2"]);
  assert.throws(() => buildDuneArgs("sietchesSetActive", { map: "Survival_1", count: 0 }));
});

// Read-only operations (28-34)
test("28 Read-only: status is allowlisted", () => assert.deepEqual(buildDuneArgs("status"), ["status"]));
test("29 Read-only: logs validate service names", () => {
  assert.deepEqual(buildDuneArgs("logs", { service: "gateway" }), ["logs", "gateway"]);
  assert.throws(() => buildDuneArgs("logs", { service: "bad;command" }));
});
test("30 Read-only: ports is allowlisted", () => assert.deepEqual(buildDuneArgs("ports"), ["ports"]));
test("31 Read-only: version routes to an executable helper", () => assertDuneRoute("version", "runtime/scripts/version.sh"));
test("32 Read-only: readiness is allowlisted", () => assert.deepEqual(buildDuneArgs("readiness"), ["ready"]));
test("33 Read-only: service listing is allowlisted", () => assert.deepEqual(buildDuneArgs("services"), ["ps"]));
test("34 Read-only: doctor is allowlisted", () => assert.deepEqual(buildDuneArgs("doctor"), ["doctor"]));

// Web UI write operations (35-40)
test("35 Web UI: server start executes through the task runner", async () => {
  await assertWebWrite("start", {}, ["start"]);
});
test("36 Web UI: map mode write executes through the task runner", async () => {
  await assertWebWrite("mapsSetMode", { map: "DeepDesert_1", mode: "always-on" }, ["maps", "set", "DeepDesert_1", "always-on"]);
});
test("37 Web UI: backup restore executes through the task runner", async () => {
  await assertWebWrite("backupRestore", { backup: "dune-db-test.backup" }, ["db", "restore", "dune-db-test.backup", "--no-safety-backup"]);
});
test("38 Web UI: memory write executes through the task runner", async () => {
  await assertWebWrite("memorySet", { map: "DeepDesert_1", memory: "8g" }, ["memory", "set", "DeepDesert_1", "8g"]);
});
test("39 Web UI: restart schedule write executes through the task runner", async () => {
  await assertWebWrite("restartScheduleEnable", { time: "05:00", notifyMinutes: 15 }, ["restart-schedule", "enable", "05:00", "15"]);
});
test("40 Web UI: sietch write executes through the task runner", async () => {
  await assertWebWrite("sietchesSetActive", { map: "Survival_1", count: 2 }, ["sietches", "set-active", "Survival_1", "2"]);
});

// Upgrade and ownership migration (41-43)
test("41 Upgrade: host runtime migration repairs only the controlled writable paths", () => {
  const script = source("runtime/scripts/repair-host-runtime-permissions.sh");
  for (const path of ["runtime/generated", "runtime/logs", "runtime/backups", "runtime/secrets", "runtime/text-router"]) {
    assert.ok(script.includes(path), `permission repair does not cover ${path}`);
  }
  assert.match(script, /--user 0:0/);
  assert.match(script, /find "\$path" -xdev/);
  assert.match(script, /runtime\/game\/\*\/Saved\/UserSettings/);
  assert.doesNotMatch(script, /find runtime\/game -xdev/);
});

test("42 Upgrade: stale root host IDs normalize to the non-root repository owner", () => {
  const repair = source("runtime/scripts/repair-host-runtime-permissions.sh");
  const autoscaler = source("runtime/scripts/start-autoscaler.sh");
  assert.match(repair, /"\$TARGET_UID" = "0".*"\$OWNER_UID" != "0"/);
  assert.match(repair, /TARGET_UID="\$OWNER_UID"/);
  assert.match(autoscaler, /"\$HOST_UID" = "0".*"\$REPO_UID" != "0"/);
  assert.match(autoscaler, /HOST_UID="\$REPO_UID"/);
});

test("43 Upgrade: orchestrator repairs every writable volume before dropping privileges", () => {
  const entrypoint = source("orchestrator/entrypoint.sh");
  for (const path of ["/srv/dune/server", "/srv/dune/steam", "/srv/dune/generated", "/srv/dune/cache", "/home/dune/.steam", "/work"]) {
    assert.ok(entrypoint.includes(path), `orchestrator entrypoint does not repair ${path}`);
  }
  assert.match(entrypoint, /chown -R dune:dune/);
  assert.match(entrypoint, /exec gosu dune/);
});
