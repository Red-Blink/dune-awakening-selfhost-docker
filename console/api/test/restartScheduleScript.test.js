import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("scheduled restart reapplies saved Spice Field overrides after startup", () => {
  const dir = mkdtempSync(join(tmpdir(), "dune-restart-schedule-"));
  const scriptsDir = join(dir, "runtime", "scripts");
  const generatedDir = join(dir, "runtime", "generated");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(generatedDir, { recursive: true });
  // The script queries through runtime/scripts/lib/postgres.sh, which sources
  // lib/ports.sh; both have to exist in the fixture for the source to succeed.
  mkdirSync(join(scriptsDir, "lib"), { recursive: true });
  copyFileSync(join(repoRoot, "runtime/scripts/lib/ports.sh"), join(scriptsDir, "lib/ports.sh"));
  copyFileSync(join(repoRoot, "runtime/scripts/lib/postgres.sh"), join(scriptsDir, "lib/postgres.sh"));

  copyFileSync(
    join(repoRoot, "runtime", "scripts", "restart-schedule.sh"),
    join(scriptsDir, "restart-schedule.sh")
  );
  chmodSync(join(scriptsDir, "restart-schedule.sh"), 0o700);

  writeExecutable(join(scriptsDir, "runtime-env.sh"), [
    "resolve_server_ip_mode() { echo local; }",
    "resolve_server_ip() { :; }",
    "is_ipv4() { return 1; }",
    "is_private_ipv4() { return 0; }"
  ].join("\n"));
  writeExecutable(join(scriptsDir, "host-file-ownership.sh"), "dune_resolve_host_owner() { stat -c '%u:%g' .; }");
  writeExecutable(join(scriptsDir, "sietches.sh"), [
    "#!/usr/bin/env bash",
    "echo sietch-$1 >> runtime/generated/restart-order.log"
  ].join("\n"));
  writeFileSync(join(scriptsDir, "usersettings.py"), [
    "import sys",
    "from pathlib import Path",
    "with Path('runtime/generated/restart-order.log').open('a') as handle:",
    "    handle.write(f'settings-{sys.argv[1]}\\n')"
  ].join("\n"));
  writeExecutable(join(scriptsDir, "stop-all.sh"), [
    "#!/usr/bin/env bash",
    "echo stop >> runtime/generated/restart-order.log"
  ].join("\n"));
  writeExecutable(join(scriptsDir, "start-all.sh"), [
    "#!/usr/bin/env bash",
    "echo start foreground=${DUNE_START_FOREGROUND_DEFERRED_RECONCILE:-} >> runtime/generated/restart-order.log"
  ].join("\n"));
  writeExecutable(join(scriptsDir, "spicefield-overrides.sh"), [
    "#!/usr/bin/env bash",
    "echo spicefield-$1 >> runtime/generated/restart-order.log"
  ].join("\n"));

  const result = spawnSync("bash", ["runtime/scripts/restart-schedule.sh", "run-now"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      DUNE_SCHEDULED_RESTART_COOLDOWN_SECONDS: "0",
      DUNE_SCHEDULED_RESTART_SPICEFIELD_REPLAY_DELAYS: "0"
    }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(readFileSync(join(generatedDir, "restart-order.log"), "utf8").trim().split("\n"), [
    "sietch-preflight",
    "settings-preflight",
    "settings-materialize-current",
    "stop",
    "start foreground=1",
    "spicefield-apply"
  ]);
});

test("scheduled restart skips queued back-to-back activations", () => {
  const dir = mkdtempSync(join(tmpdir(), "dune-restart-schedule-"));
  const scriptsDir = join(dir, "runtime", "scripts");
  const generatedDir = join(dir, "runtime", "generated");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(generatedDir, { recursive: true });
  // The script queries through runtime/scripts/lib/postgres.sh, which sources
  // lib/ports.sh; both have to exist in the fixture for the source to succeed.
  mkdirSync(join(scriptsDir, "lib"), { recursive: true });
  copyFileSync(join(repoRoot, "runtime/scripts/lib/ports.sh"), join(scriptsDir, "lib/ports.sh"));
  copyFileSync(join(repoRoot, "runtime/scripts/lib/postgres.sh"), join(scriptsDir, "lib/postgres.sh"));

  copyFileSync(
    join(repoRoot, "runtime", "scripts", "restart-schedule.sh"),
    join(scriptsDir, "restart-schedule.sh")
  );
  chmodSync(join(scriptsDir, "restart-schedule.sh"), 0o700);

  writeExecutable(join(scriptsDir, "runtime-env.sh"), "resolve_server_ip_mode() { echo local; }");
  writeExecutable(join(scriptsDir, "host-file-ownership.sh"), "dune_resolve_host_owner() { stat -c '%u:%g' .; }");
  writeExecutable(join(scriptsDir, "sietches.sh"), "exit 0");
  writeFileSync(join(scriptsDir, "usersettings.py"), "raise SystemExit(0)\n");
  writeExecutable(join(scriptsDir, "stop-all.sh"), [
    "#!/usr/bin/env bash",
    "echo stop >> runtime/generated/restart-order.log"
  ].join("\n"));
  writeExecutable(join(scriptsDir, "start-all.sh"), [
    "#!/usr/bin/env bash",
    "echo start >> runtime/generated/restart-order.log"
  ].join("\n"));
  writeExecutable(join(scriptsDir, "spicefield-overrides.sh"), [
    "#!/usr/bin/env bash",
    "echo spicefield-$1 >> runtime/generated/restart-order.log"
  ].join("\n"));
  writeFileSync(join(generatedDir, "restart-schedule-last-run"), `${Math.floor(Date.now() / 1000)}\n`);

  const result = spawnSync("bash", ["runtime/scripts/restart-schedule.sh", "run-now"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      DUNE_SCHEDULED_RESTART_COOLDOWN_SECONDS: "900",
      DUNE_SCHEDULED_RESTART_SPICEFIELD_REPLAY_DELAYS: "0"
    }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Skipping scheduled restart/);
  assert.throws(() => readFileSync(join(generatedDir, "restart-order.log"), "utf8"), /ENOENT/);
});

test("scheduled restart leaves the running Battlegroup untouched when saved settings fail preflight", () => {
  const dir = mkdtempSync(join(tmpdir(), "dune-restart-schedule-"));
  const scriptsDir = join(dir, "runtime", "scripts");
  const generatedDir = join(dir, "runtime", "generated");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(generatedDir, { recursive: true });
  // The script queries through runtime/scripts/lib/postgres.sh, which sources
  // lib/ports.sh; both have to exist in the fixture for the source to succeed.
  mkdirSync(join(scriptsDir, "lib"), { recursive: true });
  copyFileSync(join(repoRoot, "runtime/scripts/lib/ports.sh"), join(scriptsDir, "lib/ports.sh"));
  copyFileSync(join(repoRoot, "runtime/scripts/lib/postgres.sh"), join(scriptsDir, "lib/postgres.sh"));

  copyFileSync(join(repoRoot, "runtime/scripts/restart-schedule.sh"), join(scriptsDir, "restart-schedule.sh"));
  chmodSync(join(scriptsDir, "restart-schedule.sh"), 0o700);
  writeExecutable(join(scriptsDir, "runtime-env.sh"), "resolve_server_ip_mode() { echo local; }");
  writeExecutable(join(scriptsDir, "host-file-ownership.sh"), "dune_resolve_host_owner() { stat -c '%u:%g' .; }");
  writeExecutable(join(scriptsDir, "sietches.sh"), [
    "#!/usr/bin/env bash",
    "echo invalid-sietch-config >&2",
    "exit 1"
  ].join("\n"));
  writeFileSync(join(scriptsDir, "usersettings.py"), "raise SystemExit(0)\n");
  writeExecutable(join(scriptsDir, "stop-all.sh"), "echo stop >> runtime/generated/restart-order.log");
  writeExecutable(join(scriptsDir, "start-all.sh"), "echo start >> runtime/generated/restart-order.log");
  writeExecutable(join(scriptsDir, "spicefield-overrides.sh"), "exit 0");

  const result = spawnSync("bash", ["runtime/scripts/restart-schedule.sh", "run-now"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, DUNE_SCHEDULED_RESTART_COOLDOWN_SECONDS: "0" }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid-sietch-config/);
  assert.throws(() => readFileSync(join(generatedDir, "restart-order.log"), "utf8"), /ENOENT/);
});

test("scheduled restart respects a manual stop and identifies failed lifecycle steps", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dune-restart-manual-stop-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scripts = join(dir, "runtime/scripts");
  const generated = join(dir, "runtime/generated");
  mkdirSync(join(scripts, "lib"), { recursive: true });
  mkdirSync(generated, { recursive: true });
  for (const file of ["restart-schedule.sh", "runtime-env.sh", "memory-swap-common.sh", "env-file.sh",
    "host-file-ownership.sh", "compose-project.sh", "lib/secrets.sh", "lib/ports.sh", "lib/postgres.sh", "restart-history.sh"]) {
    copyFileSync(join(repoRoot, "runtime/scripts", file), join(scripts, file));
  }
  writeExecutable(join(scripts, "sietches.sh"), "#!/bin/sh\ntouch runtime/generated/preflight-called");
  writeFileSync(join(scripts, "usersettings.py"), "");
  writeExecutable(join(scripts, "stop-all.sh"), "#!/bin/sh\nexit \"$STOP_EXIT\"");
  writeExecutable(join(scripts, "start-all.sh"), "#!/bin/sh\nexit 23");
  const marker = join(generated, "manual-stop.env");
  const history = join(generated, "restart-history.jsonl");
  const run = (stopExit) => spawnSync("bash", ["runtime/scripts/restart-schedule.sh", "run-now"], {
    cwd: dir, encoding: "utf8", env: { ...process.env, DUNE_HOST_UID: String(process.getuid()),
      DUNE_HOST_GID: String(process.getgid()), DUNE_SCHEDULED_RESTART_COOLDOWN_SECONDS: "0",
      SERVER_IP_MODE: "local", STOP_EXIT: String(stopExit) }
  });
  for (const contents of ["DUNE_MANUAL_STOP=1\n", `DUNE_MANUAL_STOP_BOOT_ID=${readFileSync("/proc/sys/kernel/random/boot_id", "utf8")}`]) {
    writeFileSync(marker, contents);
    const result = run(0);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /manually stopped/);
    assert.equal(existsSync(join(generated, "preflight-called")), false);
    assert.equal(existsSync(history), false);
  }
  writeFileSync(marker, "DUNE_MANUAL_STOP_BOOT_ID=previous-boot\n");
  for (const [stopExit, reason] of [[17, "shutdown (exit 17)"], [0, "startup (exit 23)"]]) {
    const result = run(stopExit);
    assert.equal(result.status, 1, result.stderr);
    const row = JSON.parse(readFileSync(history, "utf8").trim().split("\n").at(-1));
    assert.equal(row.result, "Failed");
    assert.equal(row.reason, "Scheduled restart failed during " + reason);
  }
});

function writeExecutable(path, content) {
  writeFileSync(path, `${content}\n`);
  chmodSync(path, 0o700);
}
