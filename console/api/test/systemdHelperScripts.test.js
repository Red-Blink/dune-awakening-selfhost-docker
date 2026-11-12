import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const helperScripts = new Map([
  ["runtime/scripts/restart-schedule.sh", 3],
  ["runtime/scripts/ip-change-restart.sh", 3],
  ["runtime/scripts/shutdown-protection.sh", 4],
  // Database backup timer (3) plus scheduled system backup timer (3).
  ["runtime/scripts/db.sh", 6],
  ["runtime/scripts/update.sh", 3]
]);

test("host systemd helpers explicitly run as root", () => {
  for (const [relativePath, expectedHelpers] of helperScripts) {
    const source = readFileSync(resolve(repoRoot, relativePath), "utf8");
    const helpers = source
      .split("\n")
      .filter((line) => line.includes("docker run --rm") && line.includes("--privileged"));

    assert.equal(helpers.length, expectedHelpers, `${relativePath} helper count changed`);
    for (const helper of helpers) {
      assert.match(helper, /docker run --rm --user 0:0 --privileged/,
        `${relativePath} must run its host systemd helper as root`);
    }
  }
});

test("shutdown protection unit is stopped at host shutdown", () => {
  const source = readFileSync(resolve(repoRoot, "runtime/scripts/shutdown-protection.sh"), "utf8");

  // One template for both install paths, so they cannot drift apart again.
  assert.equal(source.match(/^\[Unit\]$/gm)?.length, 1);
  assert.match(source, /^DefaultDependencies=no$/m);
  // Without this, DefaultDependencies=no leaves the unit running and ExecStop never fires.
  assert.match(source, /^Conflicts=shutdown\.target$/m);
  assert.match(source, /^Before=shutdown\.target\b/m);
  assert.match(source, /^After=docker\.service$/m);
  assert.match(source, /DUNE_SHUTDOWN_UNIT_CONTENT="\$\(unit_content "\$HOST_ROOT_DIR"\)"/);
});

test("self-update refreshes an enabled shutdown protection unit", () => {
  const selfUpdate = readFileSync(resolve(repoRoot, "runtime/scripts/self-update.sh"), "utf8");
  const protection = readFileSync(resolve(repoRoot, "runtime/scripts/shutdown-protection.sh"), "utf8");

  assert.equal(selfUpdate.match(/^    refresh_shutdown_protection_after_update$/gm)?.length, 2);
  assert.match(selfUpdate, /runtime\/scripts\/shutdown-protection\.sh refresh \|\| true/);
  const refresh = protection.match(/^refresh_protection\(\) \{[\s\S]*?^\}$/m)?.[0];
  assert.ok(refresh, "refresh_protection is missing");
  assert.match(refresh, /DUNE_SHUTDOWN_PROTECTION_ENABLED:-0\}" != "1" \]; then\n\s+return 0/);
  assert.doesNotMatch(refresh, /write_state/, "refresh must not change the saved enabled state");
});

test("scheduled restart jobs run as the host checkout owner", () => {
  const source = readFileSync(resolve(repoRoot, "runtime/scripts/restart-schedule.sh"), "utf8");

  assert.match(source, /source runtime\/scripts\/host-file-ownership\.sh/);
  assert.match(source, /read -r HOST_SERVICE_UID HOST_SERVICE_GID <<< "\$\(dune_resolve_host_owner\)"/);
  assert.equal(source.match(/^User=\$HOST_SERVICE_UID$/gm)?.length, 2);
  assert.equal(source.match(/^Group=\$HOST_SERVICE_GID$/gm)?.length, 2);
  assert.equal(source.match(/^User=\$\{DUNE_HOST_SERVICE_UID\}$/gm)?.length, 2);
  assert.equal(source.match(/^Group=\$\{DUNE_HOST_SERVICE_GID\}$/gm)?.length, 2);
  assert.match(source, /reexec_scheduled_job_as_install_owner/);
  assert.match(source, /exec setpriv[\s\S]*?--reuid="\$target_user"[\s\S]*?--init-groups/);
  assert.match(source, /runtime\/scripts\/sietches\.sh preflight[\s\S]*?usersettings\.py preflight[\s\S]*?usersettings\.py materialize-current[\s\S]*?runtime\/scripts\/stop-all\.sh/);
});

test("shell self-update helper uses host ownership and Docker socket group", () => {
  const source = readFileSync(resolve(repoRoot, "runtime/scripts/self-update.sh"), "utf8");

  assert.match(source, /--user "\$\{DUNE_HOST_UID:-0\}:\$\{DUNE_HOST_GID:-0\}"/);
  assert.match(source, /--group-add "\$\{DOCKER_SOCKET_GID:-0\}"/);
  assert.match(source, /-e "DUNE_HOST_UID=\$\{DUNE_HOST_UID:-0\}"/);
  assert.match(source, /-e "DUNE_HOST_GID=\$\{DUNE_HOST_GID:-0\}"/);
});
