import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeInstalledAddon } from "../src/addons.js";
import { airdropContainerBelongsToProject, cleanupAirdropDatabase } from "../src/services/addonUninstall.js";

const id = "dune-airdrop-addon";
const containerId = "a".repeat(64);
function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-addon-uninstall-"));
  const addon = join(repoRoot, "runtime/addons/installed", id);
  mkdirSync(addon, { recursive: true });
  const stateFile = join(repoRoot, "runtime/addons/state.json");
  writeFileSync(join(addon, "addon.json"), "{}");
  writeFileSync(stateFile, JSON.stringify({ [id]: { enabled: true }, unrelated: { enabled: true } }));
  const calls = [];
  const container = { id: containerId, name: "/airdrop-daemon", image: "airdrop-daemon", labels: {}, mounts: [
    { Type: "bind", Source: join(repoRoot, ".env"), Destination: "/repo/.env" },
    { Type: "bind", Source: join(repoRoot, "runtime/scripts"), Destination: "/repo/runtime/scripts" }
  ] };
  const runDocker = async (args) => {
    calls.push(args);
    if (args[0] === "ps") return { stdout: `${containerId.slice(0, 12)}\n` };
    if (args[0] === "inspect") return { stdout: JSON.stringify(container) };
    return { stdout: "" };
  };
  const db = { transaction: async (fn) => fn({ query: async (sql) => {
    if (sql.includes("from pg_namespace")) return { rows: [{ owner: "dune" }] };
    if (sql.includes("from pg_trigger")) return { rows: [{ table_name: "encrypted_player_state", function_schema: "dune_airdrop", function_name: "trg_track_playtime_v2" }] };
    if (sql.startsWith("drop")) calls.push([sql]);
    return { rows: [] };
  } }) };
  return { config: { repoRoot, hostRepoRoot: repoRoot }, addon, stateFile, calls, container, runDocker, db,
    cleanup: () => rmSync(repoRoot, { recursive: true, force: true }) };
}

test("uninstall stops the owned companion and removes database automation before deleting files", async () => {
  const f = fixture();
  try {
    await removeInstalledAddon(f.config, id, { db: f.db, runDocker: async (args) => {
      assert.ok(existsSync(f.addon), "files remain available until cleanup completes");
      assert.equal(JSON.parse(readFileSync(f.stateFile))[id].enabled, false);
      return f.runDocker(args);
    } });
    assert.deepEqual(f.calls.filter((args) => !["ps", "inspect"].includes(args[0])), [
      ["update", "--restart=no", containerId], ["stop", "--time", "15", containerId],
      ["drop trigger trg_player_state_playtime on dune.encrypted_player_state"],
      ["drop schema if exists dune_airdrop cascade"], ["rm", containerId]
    ]);
    assert.equal(existsSync(f.addon), false);
    assert.deepEqual(JSON.parse(readFileSync(f.stateFile)), { unrelated: { enabled: true } });
  } finally { f.cleanup(); }
});

for (const failingStep of ["ps", "inspect", "update", "stop", "rm"]) {
  test(`a Docker ${failingStep} failure retains the installed addon and reports failure`, async () => {
    const f = fixture();
    try {
      await assert.rejects(removeInstalledAddon(f.config, id, { db: f.db, runDocker: async (args) => {
        if (args[0] === failingStep) throw new Error("failure");
        return f.runDocker(args);
      } }));
      assert.equal(existsSync(f.addon), true);
      assert.equal(JSON.parse(readFileSync(f.stateFile))[id].enabled, false);
    } finally { f.cleanup(); }
  });
}

test("a failed database preflight does not stop companions or erase files", async () => {
  const f = fixture();
  try {
    await assert.rejects(removeInstalledAddon(f.config, id, { db: { transaction: async () => { throw new Error("unavailable"); } }, runDocker: f.runDocker }), /cleanup failed/);
    assert.ok(f.calls.every((args) => ["ps", "inspect"].includes(args[0])));
    assert.equal(existsSync(f.addon), true);
  } finally { f.cleanup(); }
});

test("a database cleanup failure leaves companions stopped with restart disabled for a retry", async () => {
  const f = fixture(); let transactions = 0;
  try {
    const db = { transaction: async (fn) => {
      if (++transactions === 2) throw new Error("lock timeout");
      return f.db.transaction(fn);
    } };
    await assert.rejects(removeInstalledAddon(f.config, id, { db, runDocker: f.runDocker }), /still installed and disabled/);
    assert.ok(f.calls.some((args) => args[0] === "stop"));
    assert.ok(!f.calls.some((args) => args[0] === "rm"));
    assert.equal(existsSync(f.addon), true);
  } finally { f.cleanup(); }
});

test("a matching name alone cannot authorize removing another project's container", async () => {
  const f = fixture();
  try {
    f.container.mounts = [];
    await assert.rejects(removeInstalledAddon(f.config, id, { db: f.db, runDocker: f.runDocker }), /could not be matched/);
    assert.ok(f.calls.every((args) => ["ps", "inspect"].includes(args[0])));
    assert.equal(existsSync(f.addon), true);
  } finally { f.cleanup(); }
});

test("core service containers are never eligible for companion removal", async () => {
  const f = fixture();
  try {
    f.container.name = "/dune-postgres";
    await assert.rejects(removeInstalledAddon(f.config, id, { db: f.db, runDocker: f.runDocker }), /core service/);
    assert.ok(f.calls.every((args) => ["ps", "inspect"].includes(args[0])));
  } finally { f.cleanup(); }
});

test("explicit companion ownership labels support renamed containers without treating other projects as ours", () => {
  const container = { labels: { "io.dunedocker.addon.id": id, "io.dunedocker.project.root": "/srv/dune" } };
  assert.equal(airdropContainerBelongsToProject(container, "/srv/dune"), true);
  assert.equal(airdropContainerBelongsToProject(container, "/srv/other"), false);
});

test("unexpected trigger functions or schema owners block cleanup before destructive SQL", async () => {
  for (const wrongOwner of [false, true]) {
    const sqls = [];
    const db = { transaction: async (fn) => fn({ query: async (sql) => {
      sqls.push(sql);
      if (sql.includes("from pg_namespace")) return { rows: [{ owner: wrongOwner ? "someone_else" : "dune" }] };
      if (sql.includes("from pg_trigger")) return { rows: [{ table_name: "player_state", function_schema: "other_addon", function_name: "trg_track_playtime" }] };
      return { rows: [] };
    } }) };
    await assert.rejects(cleanupAirdropDatabase(db, { apply: true }), /unexpected owner|does not match/);
    assert.ok(sqls.every((sql) => !sql.startsWith("drop")));
  }
});
