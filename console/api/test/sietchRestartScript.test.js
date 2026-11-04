import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sietchesSource = readFileSync(join(repoRoot, "runtime/scripts/sietches.sh"), "utf8");
const autoscalerSource = readFileSync(join(repoRoot, "runtime/scripts/autoscaler.sh"), "utf8");
const reconcileSource = sietchesSource.match(/reconcile_map_dimensions\(\) \{([\s\S]*?)\n\}\n\nset_partition_value\(\)/)?.[1] || "";

function executable(path, body) {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(path, 0o755);
}

function runFixture(row, args) {
  const fixture = mkdtempSync(join(tmpdir(), "dune-sietch-restart-"));
  const scripts = join(fixture, "runtime", "scripts");
  const generated = join(fixture, "runtime", "generated");
  const bin = join(fixture, "bin");
  const calls = join(generated, "calls.log");
  mkdirSync(join(scripts, "lib"), { recursive: true });
  mkdirSync(generated, { recursive: true });
  mkdirSync(bin, { recursive: true });
  copyFileSync(join(repoRoot, "runtime/scripts/sietches.sh"), join(scripts, "sietches.sh"));
  copyFileSync(join(repoRoot, "runtime/scripts/lib/ports.sh"), join(scripts, "lib/ports.sh"));
  copyFileSync(join(repoRoot, "runtime/scripts/lib/postgres.sh"), join(scripts, "lib/postgres.sh"));
  copyFileSync(join(repoRoot, "runtime/scripts/sietch-name.sh"), join(scripts, "sietch-name.sh"));
  copyFileSync(join(repoRoot, "runtime/scripts/host-file-ownership.sh"), join(scripts, "host-file-ownership.sh"));
  writeFileSync(join(generated, "sietch-config.json"), '{"maps":{"Survival_1":{"active_dimensions":2}},"partitions":{}}\n');
  writeFileSync(calls, "");

  executable(join(bin, "docker"), [
    'if [ "${1:-}" = "ps" ] && [ "${2:-}" = "-a" ]; then',
    '  printf "%s\\n" dune-server-survival-1-31',
    'elif [ "${1:-}" = "ps" ]; then',
    // Keep writing after the first matching name. A grep -q consumer exits
    // early and makes this pipe fail with SIGPIPE under `set -o pipefail`.
    '  printf "%s\\n" dune-postgres dune-server-survival-1 dune-server-survival-1-31',
    '  for i in {1..4096}; do printf "mock-container-%s\\n" "$i"; done',
    'elif [ "${1:-}" = "exec" ]; then',
    '  printf "%s\\n" "$MOCK_PARTITION_ROW"',
    'fi'
  ].join("\n"));

  for (const [name, label] of [
    ["start-server-survival-1.sh", "primary"],
    ["stop-server-survival-1.sh", "stop"],
    ["spicefield-overrides.sh", "spicefield"],
    ["publish-sietch-overrides.sh", "publish"],
    ["despawn-server.sh", "despawn"],
    ["spawn-server.sh", "spawn"]
  ]) {
    executable(join(scripts, name), `printf "${label} %s\\n" "$*" >> "${calls}"`);
  }

  const result = spawnSync("bash", ["runtime/scripts/sietches.sh", ...args], {
    cwd: fixture,
    encoding: "utf8",
    // DUNE_PSQL_TRANSPORT: what the docker mock above stands in for is the
    // Postgres container, so pin the exec leg. On "auto" the script would take
    // the TCP leg wherever a psql client is installed -- as it is on a CI
    // runner -- and dial a real port straight past the mock.
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      MOCK_PARTITION_ROW: row,
      DUNE_PSQL_TRANSPORT: "exec"
    }
  });
  const callLog = readFileSync(calls, "utf8");
  rmSync(fixture, { recursive: true, force: true });
  return { ...result, callLog };
}

test("primary Sietch restart touches only the primary Survival_1 container", () => {
  const result = runFixture("0|f|1", ["restart", "1"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.callLog, "stop \nprimary \nspicefield apply\npublish restart\npublish once\n");
  assert.match(result.stdout, /primary Survival_1 Sietch/);
});

test("secondary Sietch restart despawns and respawns only its partition", () => {
  const result = runFixture("1|f|2", ["restart", "31"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.callLog, "despawn 31 --force\nspawn 31\n");
  assert.match(result.stdout, /partition 31 restart completed/);
});

test("inactive Sietches cannot be restarted", () => {
  const result = runFixture("2|f|3", ["restart", "31"]);
  assert.notEqual(result.status, 0);
  assert.equal(result.callLog, "");
  assert.match(result.stderr, /not active/);
});

test("stop-partition stops only the primary Survival_1 container", () => {
  const result = runFixture("0|f|1", ["stop-partition", "1"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.callLog, "stop \n");
});

test("start-partition starts only the primary Survival_1 container", () => {
  const result = runFixture("0|f|1", ["start-partition", "1"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.callLog, "primary \nspicefield apply\npublish restart\npublish once\n");
  assert.match(result.stdout, /primary Survival_1 Sietch/);
});

test("stop-partition despawns only a secondary Sietch container", () => {
  const result = runFixture("1|f|2", ["stop-partition", "31"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.callLog, "despawn 31 --force\n");
});

test("start-partition spawns only a secondary Sietch container", () => {
  const result = runFixture("1|f|2", ["start-partition", "31"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.callLog, "spawn 31\n");
  assert.match(result.stdout, /partition 31 restart completed/);
});

test("start-partition on an unknown partition fails instead of guessing", () => {
  const result = runFixture("", ["start-partition", "31"]);
  assert.notEqual(result.status, 0);
  assert.equal(result.callLog, "");
  assert.match(result.stderr, /is not a Survival_1 Sietch/);
});

test("Sietch reconciliation delegates publication to the contraction-aware lifecycle", () => {
  assert.doesNotMatch(reconcileSource, /refresh_survival_control_plane_state/);
  assert.doesNotMatch(reconcileSource, /refresh_survival_director_state/);
  assert.doesNotMatch(reconcileSource, /restart-director\.sh/);
  assert.doesNotMatch(reconcileSource, /start-server-survival-1\.sh/);
  assert.match(reconcileSource, /sync_survival_sietch_topology_state/);
  assert.match(reconcileSource, /refresh_survival_topology_publication "\$topology_removed"/);
  const spawnLoop = reconcileSource.slice(reconcileSource.indexOf('for partition_row in'), reconcileSource.indexOf('# Only a target'));
  assert.doesNotMatch(spawnLoop, /topology_removed=1/);
  const removeLoop = reconcileSource.slice(reconcileSource.indexOf('while [ "$target_explicit"'), reconcileSource.indexOf('if [ "$target_explicit" = "1" ] && dune_psql'));
  assert.match(removeLoop, /despawn-server\.sh[\s\S]*topology_removed=1/);
});

test("new Sietches settle before publishing the updated topology", () => {
  const settleAt = reconcileSource.indexOf('wait_for_survival_topology_settle "$target" 90');
  const refreshAt = reconcileSource.indexOf("refresh_survival_topology_publication");
  assert.ok(settleAt >= 0, "missing Survival topology settle wait");
  assert.ok(refreshAt > settleAt, "topology publication must run after new Sietches settle");
});

test("autoscaler browser healing pauses during coordinated Sietch topology changes", () => {
  assert.match(reconcileSource, /sietch-topology-maintenance/);
  assert.match(reconcileSource, /trap 'touch "\$topology_maintenance_file"' EXIT/);
  assert.match(autoscalerSource, /SIETCH_TOPOLOGY_MAINTENANCE_FILE=/);
  assert.match(autoscalerSource, /SIETCH_TOPOLOGY_HEAL_GRACE_SECONDS=/);
  assert.match(
    autoscalerSource,
    /marker_age.*SIETCH_TOPOLOGY_HEAL_GRACE_SECONDS[\s\S]*?director_heal_clear stale_since[\s\S]*?return 0/,
  );
});

test("autoscaler browser healing ignores READY markers from previous core server processes", () => {
  const coreReady = autoscalerSource.match(/core_maps_ready_for_browser_heal\(\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(coreReady, /\{\{\.State\.StartedAt\}\}/);
  assert.match(coreReady, /docker logs --timestamps/);
  assert.match(coreReady, /filter-container-logs\.py "\$started_at"/);
  assert.match(autoscalerSource, /AUTOSCALER_STARTED_AT="\$\(date \+%s\)"/);
  assert.match(
    autoscalerSource,
    /now - AUTOSCALER_STARTED_AT[\s\S]*?director_heal_clear stale_since[\s\S]*?director_heal_clear core_ready_since[\s\S]*?return 0/,
  );
});

test("scaling down removes inactive Sietch rows before publishing topology", () => {
  const deleteAt = reconcileSource.indexOf("delete from dune.world_partition");
  const refreshAt = reconcileSource.indexOf("refresh_survival_topology_publication");
  assert.ok(deleteAt >= 0, "missing inactive partition deletion");
  assert.ok(refreshAt > deleteAt, "topology publication must run after inactive partitions are removed");
  assert.match(reconcileSource, /ranked\.ord > \$target\s+and ranked\.server_id = ''/);
  assert.match(reconcileSource, /\[ "\$target_explicit" = "1" \]/);
  assert.match(
    reconcileSource,
    /while \[ "\$target_explicit" = "1" \] && \[ "\$assigned_count" -gt "\$target" \]/,
  );
});

test("Sietch config preflight rejects invalid state without replacing it with defaults", () => {
  const fixture = mkdtempSync(join(tmpdir(), "dune-sietch-preflight-"));
  const scripts = join(fixture, "runtime", "scripts");
  const generated = join(fixture, "runtime", "generated");
  mkdirSync(join(scripts, "lib"), { recursive: true });
  mkdirSync(generated, { recursive: true });
  for (const name of ["sietches.sh", "sietch-name.sh", "host-file-ownership.sh", "lib/ports.sh", "lib/postgres.sh"]) {
    copyFileSync(join(repoRoot, "runtime/scripts", name), join(scripts, name));
  }
  const config = join(generated, "sietch-config.json");
  writeFileSync(config, '{"maps":{"Survival_1":{"active_dimensions":3}}, BROKEN\n');

  const result = spawnSync("bash", ["runtime/scripts/sietches.sh", "preflight"], {
    cwd: fixture,
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid Sietch configuration/);
  assert.equal(readFileSync(config, "utf8"), '{"maps":{"Survival_1":{"active_dimensions":3}}, BROKEN\n');
  rmSync(fixture, { recursive: true, force: true });
});

test("Sietch config handling fails closed instead of synthesizing defaults for unreadable state", () => {
  assert.doesNotMatch(sietchesSource, /content='\{[\s\S]*?"maps": \{\}[\s\S]*?mv -f "\$tmp" "\$CONFIG_FILE"/);
  assert.match(sietchesSource, /Refusing to replace it with defaults because that could remove active Sietches/);
});

test("Sietch publisher generations supersede loops across PID namespaces", () => {
  const publisherSource = readFileSync(join(repoRoot, "runtime/scripts/publish-sietch-overrides.sh"), "utf8");
  assert.match(publisherSource, /LOOP_TOKEN_FILE=/);
  assert.match(publisherSource, /stop_loop_processes\(\)[\s\S]*?invalidate_loop_token/);
  assert.match(publisherSource, /start_loop\(\)[\s\S]*?write_loop_token "\$loop_token"/);
  assert.match(publisherSource, /while true; do\s+if ! loop_token_is_current "\$loop_token"/);
});

function runMetadataFixture(partitionId, running = true, removedPartitions = null) {
  const fixture = mkdtempSync(join(tmpdir(), "dune-sietch-metadata-"));
  const scripts = join(fixture, "runtime", "scripts");
  const calls = join(fixture, "calls.log");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(calls, "");
  for (const [name, label] of [
    ["start-server-survival-1.sh", "primary"],
    ["despawn-server.sh", "despawn"],
    ["spawn-server.sh", "spawn"],
    ["publish-sietch-overrides.sh", "publish"],
    ["restart-director.sh", "director"],
    ["start-server-gateway.sh", "gateway"],
  ]) {
    executable(join(scripts, name), `printf "${label} %s\\n" "$*" >> "$MOCK_CALLS"`);
  }
  const names = [
    "restart_survival_server_if_running",
    "restart_sietch_partition_if_running",
    "refresh_survival_browser_state",
    "refresh_survival_director_state",
    "refresh_survival_gateway_state",
    "refresh_survival_sietch_metadata_state",
    "refresh_survival_topology_publication",
  ];
  const functions = names.map((name) => {
    const body = sietchesSource.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"))?.[0];
    assert.ok(body, `missing ${name}`);
    return body;
  }).join("\n");
  const script = [
    "set -euo pipefail",
    functions,
    'docker() { if [ "$MOCK_RUNNING" = 1 ]; then printf "%s\\n" dune-server-survival-1 dune-server-survival-1-31 dune-director dune-server-gateway; fi; }',
    'sync_survival_usersettings_state() { echo sync >> "$MOCK_CALLS"; }',
    'apply_survival_sietch_labels_from_config() { echo labels >> "$MOCK_CALLS"; }',
    'sync_survival_sietch_topology_state() { sync_survival_usersettings_state; apply_survival_sietch_labels_from_config; }',
    ...(removedPartitions === null ? [
      `restart_sietch_partition_if_running ${partitionId}`,
      "refresh_survival_sietch_metadata_state",
    ] : [`refresh_survival_topology_publication ${removedPartitions}`]),
  ].join("\n");
  try {
    const result = spawnSync("bash", ["-c", script], {
      cwd: fixture,
      encoding: "utf8",
      env: { ...process.env, MOCK_CALLS: calls, MOCK_RUNNING: running ? "1" : "0", DUNE_SKIP_SURVIVAL_DIRECTOR_REFRESH: "0" },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return readFileSync(calls, "utf8");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

test("secondary Sietch identity changes restart only the selected map and republish metadata", () => {
  assert.equal(runMetadataFixture(31), "despawn 31\nspawn 31\nsync\nlabels\npublish restart\npublish once\n");
});

test("Sietch contraction resets Director publication once without replacing Gateway", () => {
  assert.equal(runMetadataFixture(31, true, 1), "sync\nlabels\ndirector \npublish restart\npublish once\n");
});

test("Sietch additions publish without resetting Director or other maps", () => {
  assert.equal(runMetadataFixture(31, true, 0), "sync\nlabels\npublish restart\npublish once\n");
});

test("Sietch contraction does not start a stopped Director", () => {
  assert.equal(runMetadataFixture(31, false, 1), "sync\nlabels\npublish restart\npublish once\n");
});

test("primary Sietch identity changes restart the primary once without replacing Director or Gateway", () => {
  assert.equal(runMetadataFixture(1), "primary \nsync\nlabels\npublish restart\npublish once\n");
});

test("identity changes preserve stopped Sietches while updating publication", () => {
  assert.equal(runMetadataFixture(31, false), "sync\nlabels\npublish restart\npublish once\n");
});

test("password, display name and combined settings use the targeted identity refresh", () => {
  for (const command of ["set-password", "set-display", "set-settings"]) {
    const arm = sietchesSource.split(`  ${command})\n`)[1]?.split("    ;;", 1)[0];
    assert.ok(arm, `missing ${command}`);
    assert.match(arm, /partition-engine-set/);
    assert.match(arm, /materialize-current/);
    assert.match(arm, /restart_sietch_partition_if_running/);
    assert.match(arm, /refresh_survival_sietch_metadata_state/);
    assert.doesNotMatch(arm, /refresh_survival_control_plane_state|refresh_survival_director_state|refresh_survival_gateway_state/);
  }
});
