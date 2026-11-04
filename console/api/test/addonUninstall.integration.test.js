import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { removeInstalledAddon } from "../src/addons.js";
import { cleanupAirdropDatabase } from "../src/services/addonUninstall.js";
import { pgTransactionalDb, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

const SCHEMA = `
create schema dune;
create schema dune_airdrop authorization dune;
create schema unrelated;
create table unrelated.keep_me (id int);
create table dune.encrypted_player_state (id int primary key, ticks int);
create table dune.player_state (id int primary key, ticks int);
create table dune.bot_pending_deliveries (id int);
create table dune_airdrop.pending_deliveries (id serial primary key);
create function dune_airdrop.trg_track_playtime_v2() returns trigger language plpgsql as $$
begin insert into dune_airdrop.pending_deliveries default values; return new; end $$;
create trigger trg_player_state_playtime after update on dune.encrypted_player_state
for each row execute function dune_airdrop.trg_track_playtime_v2();
insert into dune.encrypted_player_state values (1, 0);
`;

test("real PostgreSQL: uninstall removes live reward automation and preserves game and legacy data", async (t) => {
  await withIsolatedDatabase(t, { namePrefix: "dune_addon_cleanup" }, async (pool) => {
    await pool.query(SCHEMA);
    await pool.query("update dune.encrypted_player_state set ticks=ticks+1");
    assert.equal((await pool.query("select count(*)::int as n from dune_airdrop.pending_deliveries")).rows[0].n, 1);
    const db = pgTransactionalDb(pool);
    await cleanupAirdropDatabase(db, { apply: true });
    await pool.query("update dune.encrypted_player_state set ticks=ticks+1");
    assert.equal((await pool.query("select ticks from dune.encrypted_player_state")).rows[0].ticks, 2);
    assert.equal((await pool.query("select to_regnamespace('dune_airdrop') as schema")).rows[0].schema, null);
    assert.ok((await pool.query("select to_regclass('dune.bot_pending_deliveries') as legacy")).rows[0].legacy);
    assert.ok((await pool.query("select to_regclass('unrelated.keep_me') as keep")).rows[0].keep);
    // No missing-table error after a previous successful cleanup or partial retry.
    await cleanupAirdropDatabase(db, { apply: true });
  });
});

test("real PostgreSQL: same-named unrelated triggers block uninstall without dropping anything", async (t) => {
  await withIsolatedDatabase(t, { namePrefix: "dune_addon_trigger_guard" }, async (pool) => {
    await pool.query(SCHEMA);
    await pool.query(`create function unrelated.trg_track_playtime() returns trigger language plpgsql as $$ begin return new; end $$;
      create trigger trg_player_state_playtime after update on dune.player_state
      for each row execute function unrelated.trg_track_playtime();`);
    await assert.rejects(cleanupAirdropDatabase(pgTransactionalDb(pool), { apply: true }), /does not match/);
    assert.ok((await pool.query("select to_regnamespace('dune_airdrop') as schema")).rows[0].schema);
    await pool.query("update dune.encrypted_player_state set ticks=ticks+1");
    assert.equal((await pool.query("select count(*)::int as n from dune_airdrop.pending_deliveries")).rows[0].n, 1);
  });
});

test("real PostgreSQL: legacy playtime triggers on both game tables are removed without deleting shared tables", async (t) => {
  await withIsolatedDatabase(t, { namePrefix: "dune_addon_legacy_cleanup" }, async (pool) => {
    await pool.query(SCHEMA);
    await pool.query(`drop trigger trg_player_state_playtime on dune.encrypted_player_state;
      create function dune.trg_track_playtime() returns trigger language plpgsql as $$
      begin insert into dune.bot_pending_deliveries values (new.id); return new; end $$;
      create trigger trg_player_state_playtime after update on dune.player_state
        for each row execute function dune.trg_track_playtime();
      create trigger trg_player_state_playtime after update on dune.encrypted_player_state
        for each row execute function dune.trg_track_playtime();
      insert into dune.player_state values (2, 0);
      update dune.player_state set ticks=1;
      update dune.encrypted_player_state set ticks=1;`);
    assert.equal((await pool.query("select count(*)::int as n from dune.bot_pending_deliveries")).rows[0].n, 2);
    await cleanupAirdropDatabase(pgTransactionalDb(pool), { apply: true });
    await pool.query("update dune.player_state set ticks=2; update dune.encrypted_player_state set ticks=2;");
    assert.equal((await pool.query("select count(*)::int as n from dune.bot_pending_deliveries")).rows[0].n, 2);
  });
});

test("real Docker and PostgreSQL: removal stops rewards and safely retries partial companion cleanup", {
  skip: process.env.DUNE_ADDON_UNINSTALL_DOCKER_TEST !== "1"
}, async (t) => {
  await withIsolatedDatabase(t, { namePrefix: "dune_addon_lifecycle" }, async (pool) => {
    const repoRoot = mkdtempSync(join(tmpdir(), "dune-addon-lifecycle-"));
    const containerName = `dune-addon-airdrop-test-${randomBytes(5).toString("hex")}`;
    const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    try {
      await pool.query(SCHEMA);
      const addonDir = join(repoRoot, "runtime/addons/installed/dune-airdrop-addon");
      mkdirSync(addonDir, { recursive: true });
      writeFileSync(join(addonDir, "addon.json"), "{}");
      writeFileSync(join(repoRoot, "runtime/addons/state.json"), JSON.stringify({ "dune-airdrop-addon": { enabled: true } }));
      docker("run", "--detach", "--name", containerName, "--network=none", "--restart=unless-stopped",
        "--label", "io.dunedocker.addon.id=dune-airdrop-addon", "--label", `io.dunedocker.project.root=${repoRoot}`,
        "alpine:3.22", "sh", "-c", "while true; do sleep 1; done");
      const config = { repoRoot, hostRepoRoot: repoRoot };
      await assert.rejects(removeInstalledAddon(config, "dune-airdrop-addon", {
        db: pgTransactionalDb(pool),
        runDocker: async (args) => {
          if (args[0] === "rm") throw new Error("simulated removal failure");
          return { stdout: docker(...args) };
        }
      }), /still installed and disabled/);
      assert.equal(existsSync(addonDir), true);
      assert.equal(JSON.parse(readFileSync(join(repoRoot, "runtime/addons/state.json")))["dune-airdrop-addon"].enabled, false);
      assert.equal(docker("inspect", "--format", "{{.State.Running}}|{{.HostConfig.RestartPolicy.Name}}", containerName).trim(), "false|no");
      assert.equal((await pool.query("select to_regnamespace('dune_airdrop') as schema")).rows[0].schema, null);
      const result = await removeInstalledAddon(config, "dune-airdrop-addon", { db: pgTransactionalDb(pool) });
      assert.equal(result.ok, true);
      assert.equal(docker("ps", "--all", "--filter", `name=^/${containerName}$`, "--format", "{{.ID}}").trim(), "");
      assert.equal(existsSync(addonDir), false);
      assert.deepEqual(JSON.parse(readFileSync(join(repoRoot, "runtime/addons/state.json"))), {});
      await pool.query("update dune.encrypted_player_state set ticks=ticks+1");
      assert.equal((await pool.query("select to_regnamespace('dune_airdrop') as schema")).rows[0].schema, null);
    } finally {
      try { docker("rm", "--force", containerName); } catch { /* Already removed. */ }
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
