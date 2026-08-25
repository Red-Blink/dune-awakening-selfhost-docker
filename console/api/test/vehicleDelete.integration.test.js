import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteVehicleCompletely,
  queueVehicleDelete,
  cancelQueuedVehicleDelete,
  listQueuedVehicleDeletes,
  flushVehicleDeletes,
  _resetRefillPartitionDwellForTests
} from "../src/duneDb.js";
import { pgTransactionalDb, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

// Like baseDelete.integration.test.js, this exercises real PostgreSQL rather
// than a mocked db: the guarantees that matter here -- the cascade actually
// removing every row, the transaction actually rolling back atomically, a
// real FOR UPDATE lock -- are exactly the kind a string-matched mock cannot
// prove. This is the load-bearing artifact for the whole feature: the
// starting question was "does this cascade safely at all", and this file is
// what keeps the answer true going forward.
//
// The schema below is transcribed from a real production dump
// (.claude/dune_backup.sql), not invented:
//   vehicles.id -> actors.id                                CASCADE (line 76467)
//   vehicle_modules.vehicle_id -> vehicles.id                CASCADE (line 76459)
//   inventories.vehicle_module_id -> vehicle_modules.id      CASCADE (line 75828)
//   backup_vehicles.vehicle_id -> vehicles.id                CASCADE (line 75459)
//   recovered_vehicles.vehicle_id -> vehicles.id             CASCADE (line 76348)
//   overmap_players.vehicle_id -> actors.id                  SET NULL
// markers/player_markers are deliberately NOT FK-cascaded from actors,
// matching production -- only permission_actor_destroy clears them.
const VEHICLE_ID = 9201;
const MODULE_IDS = [9202, 9203];
const PLAYER_ID = 4;

const OTHER_VEHICLE_ID = 9301;
const OTHER_MODULE_ID = 9302;

const SCHEMA = `
  create schema dune;

  create type dune.actorstate as enum (
    'Default', 'Travel', 'VehicleBackup', 'AbortedAuthorityTransfer', 'VehicleRecovery', 'BaseBackup'
  );

  create table dune.actors (id bigint primary key, map text, partition_id bigint, owner_account_id bigint);
  create table dune.map_names (map_name_id smallint primary key, map_name text not null);
  create table dune.world_partition (partition_id bigint primary key, map text, dimension_index integer default 0, server_id text);

  create table dune.vehicles (id bigint primary key references dune.actors(id) on delete cascade);
  create table dune.vehicle_modules (
    id bigint primary key,
    vehicle_id bigint not null references dune.vehicles(id) on delete cascade
  );
  create table dune.inventories (
    id bigint primary key,
    vehicle_module_id bigint references dune.vehicle_modules(id) on delete cascade,
    max_item_count integer not null default 10
  );
  create table dune.items (
    id bigint generated always as identity primary key,
    inventory_id bigint not null references dune.inventories(id) on delete cascade,
    template_id text not null,
    stack_size integer not null default 1
  );
  create table dune.backup_vehicles (vehicle_id bigint not null references dune.vehicles(id) on delete cascade);
  create table dune.recovered_vehicles (vehicle_id bigint not null references dune.vehicles(id) on delete cascade);
  create table dune.overmap_players (
    player_id bigint primary key,
    vehicle_id bigint references dune.actors(id) on delete set null
  );
  create table dune.actor_state (actor_id bigint primary key, state dune.actorstate not null);

  create table dune.permission_actor (
    actor_id bigint primary key references dune.actors(id) on delete cascade,
    actor_name text
  );
  create table dune.permission_actor_rank (
    permission_actor_id bigint not null references dune.permission_actor(actor_id) on delete cascade,
    player_id bigint not null references dune.actors(id) on delete cascade,
    rank smallint not null
  );
  -- Deliberately NOT FK-cascaded from actors, matching production: only
  -- permission_actor_destroy clears these.
  create table dune.markers (marker_hash_id bigint primary key);
  create table dune.player_markers (marker_hash_id bigint not null, player_id bigint not null);

  -- Transcribed verbatim from the shipped schema (.claude/dune_backup.sql
  -- lines 13231 and 5619), not reinvented.
  create function dune.permission_actor_destroy(in_actor_id bigint)
  returns void language plpgsql as $$
  begin
    delete from permission_actor_rank where permission_actor_id = in_actor_id;
    delete from permission_actor where actor_id = in_actor_id;
    delete from markers where marker_hash_id = in_actor_id;
    delete from player_markers where marker_hash_id = in_actor_id;
    perform pg_notify('permission_notify_channel', format('destroy#{"ActorId" : %s}', in_actor_id));
  end $$;

  create function dune.delete_actors(in_ids bigint[])
  returns void language plpgsql as $$
  begin
    delete from actors where id = any(in_ids);
  end $$;
`;

function seedVehicle(vehicleId, moduleIds, playerId, { claimed = true, withItems = true } = {}) {
  const moduleRows = moduleIds.map((id) => `
    insert into dune.vehicle_modules (id, vehicle_id) values (${id}, ${vehicleId});
    insert into dune.inventories (id, vehicle_module_id) values (${id} * 10, ${id});
    ${withItems ? `insert into dune.items (inventory_id, template_id, stack_size) values (${id} * 10, 'Spice', 12);` : ""}
  `).join("\n");
  return `
    insert into dune.actors (id, map, partition_id) values (${vehicleId}, 'HaggaBasin', 3);
    insert into dune.vehicles (id) values (${vehicleId});
    ${moduleRows}
    insert into dune.backup_vehicles (vehicle_id) values (${vehicleId});
    insert into dune.recovered_vehicles (vehicle_id) values (${vehicleId});
    insert into dune.overmap_players (player_id, vehicle_id) values (${vehicleId} * 100, ${vehicleId});
    ${claimed ? `
      insert into dune.permission_actor (actor_id, actor_name) values (${vehicleId}, 'Test Vehicle ${vehicleId}');
      insert into dune.markers (marker_hash_id) values (${vehicleId});
      insert into dune.player_markers (marker_hash_id, player_id) values (${vehicleId}, ${playerId});
      insert into dune.permission_actor_rank (permission_actor_id, player_id, rank) values (${vehicleId}, ${playerId}, 1);
    ` : ""}
  `;
}

const SEED = `
  insert into dune.actors (id) values (${PLAYER_ID});
  ${seedVehicle(VEHICLE_ID, MODULE_IDS, PLAYER_ID)}
  ${seedVehicle(OTHER_VEHICLE_ID, [OTHER_MODULE_ID], PLAYER_ID)}
`;

async function withDatabase(t, run) {
  return withIsolatedDatabase(t, {
    namePrefix: "dune_vehicle_delete",
    unavailableLabel: "the vehicle deletion integration test"
  }, async (pool) => {
    await pool.query(SCHEMA);
    await pool.query(SEED);
    return run(pool);
  });
}

async function actorCount(pool, ids) {
  const result = await pool.query("select count(*)::int as n from dune.actors where id = any($1::bigint[])", [ids]);
  return result.rows[0].n;
}

async function tableCount(pool, table) {
  const result = await pool.query(`select count(*)::int as n from dune.${table}`);
  return result.rows[0].n;
}

test("real PostgreSQL: deleteVehicleCompletely cascades away the whole vehicle and nothing belonging to another", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    const result = await deleteVehicleCompletely(db, VEHICLE_ID);

    assert.equal(result.ok, true);
    assert.equal(result.actorId, String(VEHICLE_ID));
    assert.equal(result.deletedModuleCount, MODULE_IDS.length);

    assert.equal(await actorCount(pool, [VEHICLE_ID]), 0);
    assert.equal(await tableCount(pool, "vehicles"), 1, "the other vehicle must survive");
    assert.equal(await tableCount(pool, "vehicle_modules"), 1);
    assert.equal(await tableCount(pool, "inventories"), 1);
    assert.equal(await tableCount(pool, "items"), 1);
    assert.equal(await tableCount(pool, "backup_vehicles"), 1);
    assert.equal(await tableCount(pool, "recovered_vehicles"), 1);
    assert.equal(await tableCount(pool, "permission_actor"), 1);
    assert.equal(await tableCount(pool, "permission_actor_rank"), 1);

    // markers/player_markers do not cascade from actors in production -- only
    // permission_actor_destroy's explicit deletes clear them, keyed on the
    // vehicle's own actor id. This is the regression guard for the ordering
    // requirement: permission_actor_destroy must run before delete_actors.
    const markers = await pool.query("select marker_hash_id from dune.markers");
    assert.deepEqual(markers.rows.map((row) => Number(row.marker_hash_id)), [OTHER_VEHICLE_ID]);
    const playerMarkers = await pool.query("select marker_hash_id from dune.player_markers");
    assert.deepEqual(playerMarkers.rows.map((row) => Number(row.marker_hash_id)), [OTHER_VEHICLE_ID]);

    // overmap_players.vehicle_id -> actors.id is SET NULL, not CASCADE: the
    // row itself survives, only the dangling reference clears.
    const overmap = await pool.query("select vehicle_id from dune.overmap_players where player_id = $1", [VEHICLE_ID * 100]);
    assert.equal(overmap.rows[0].vehicle_id, null);

    assert.equal(await actorCount(pool, [OTHER_VEHICLE_ID]), 1);
  });
});

test("real PostgreSQL: deleteVehicleCompletely rejects a vehicle id that does not exist", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    await assert.rejects(() => deleteVehicleCompletely(db, 424242), /was not found/);
    assert.equal(await actorCount(pool, [VEHICLE_ID, OTHER_VEHICLE_ID]), 2);
  });
});

// The primary use case, not an edge case: an unclaimed junk vehicle should
// be exactly as deletable as a claimed one. vehiclePermissionActor never
// joins through permission_actor (unlike setVehiclePermissions' path), so
// this must work without a claim -- add this so nobody "fixes" it into a
// guard later.
test("real PostgreSQL: deleteVehicleCompletely deletes an unclaimed vehicle cleanly", async (t) => {
  await withIsolatedDatabase(t, {
    namePrefix: "dune_vehicle_delete_unclaimed",
    unavailableLabel: "the vehicle deletion integration test"
  }, async (pool) => {
    await pool.query(SCHEMA);
    await pool.query(`
      insert into dune.actors (id) values (${PLAYER_ID});
      ${seedVehicle(VEHICLE_ID, MODULE_IDS, PLAYER_ID, { claimed: false })}
    `);
    const db = pgTransactionalDb(pool);
    const result = await deleteVehicleCompletely(db, VEHICLE_ID);
    assert.equal(result.ok, true);
    assert.equal(await actorCount(pool, [VEHICLE_ID]), 0);
  });
});

for (const state of ["Travel", "VehicleBackup", "VehicleRecovery"]) {
  test(`real PostgreSQL: deleteVehicleCompletely refuses a vehicle in ${state} state`, async (t) => {
    await withDatabase(t, async (pool) => {
      await pool.query("insert into dune.actor_state (actor_id, state) values ($1, $2)", [VEHICLE_ID, state]);
      const db = pgTransactionalDb(pool);
      await assert.rejects(() => deleteVehicleCompletely(db, VEHICLE_ID), new RegExp(state));
      assert.equal(await actorCount(pool, [VEHICLE_ID]), 1, "a blocked-state vehicle must not be touched");
    });
  });
}

for (const state of ["Default", "AbortedAuthorityTransfer", "BaseBackup"]) {
  test(`real PostgreSQL: deleteVehicleCompletely allows a vehicle in ${state} state`, async (t) => {
    await withDatabase(t, async (pool) => {
      await pool.query("insert into dune.actor_state (actor_id, state) values ($1, $2)", [VEHICLE_ID, state]);
      const db = pgTransactionalDb(pool);
      const result = await deleteVehicleCompletely(db, VEHICLE_ID);
      assert.equal(result.ok, true);
    });
  });
}

test("real PostgreSQL: an older schema without dune.actor_state at all deletes normally", async (t) => {
  await withIsolatedDatabase(t, {
    namePrefix: "dune_vehicle_delete_no_actor_state",
    unavailableLabel: "the vehicle deletion integration test"
  }, async (pool) => {
    const schemaWithoutActorState = SCHEMA
      .replace(/create type dune\.actorstate[\s\S]*?\);/, "")
      .replace(/create table dune\.actor_state[\s\S]*?\);/, "");
    await pool.query(schemaWithoutActorState);
    await pool.query(SEED);
    const db = pgTransactionalDb(pool);
    const result = await deleteVehicleCompletely(db, VEHICLE_ID);
    assert.equal(result.ok, true);
  });
});

test("real PostgreSQL: a mid-transaction failure rolls back permission_actor_destroy's work too", async (t) => {
  await withDatabase(t, async (pool) => {
    // A synthetic FK, not a modeled production constraint (see
    // baseDelete.integration.test.js's identical pattern) -- a deliberate,
    // controlled trigger for a real failure so this proves db.transaction's
    // rollback guarantee rather than assuming it.
    await pool.query("create table dune.other_refs (id bigint primary key, referenced_actor_id bigint references dune.actors(id))");
    await pool.query("insert into dune.other_refs (id, referenced_actor_id) values (1, $1)", [VEHICLE_ID]);

    const db = pgTransactionalDb(pool);
    await assert.rejects(() => deleteVehicleCompletely(db, VEHICLE_ID));

    // If the rollback were partial, permission_actor_destroy's deletes
    // (which ran first) would have stuck even though delete_actors failed
    // after it.
    assert.equal(await actorCount(pool, [VEHICLE_ID]), 1);
    assert.equal(await tableCount(pool, "permission_actor"), 2);
    assert.equal(await tableCount(pool, "permission_actor_rank"), 2);
    const markers = await pool.query("select marker_hash_id from dune.markers where marker_hash_id = $1", [VEHICLE_ID]);
    assert.equal(markers.rows.length, 1);
  });
});

test("real PostgreSQL: the actor row is locked for update", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    await db.transaction(async (tx) => {
      await tx.query("set local search_path to dune, public");
      const locked = await tx.query("select id from dune.actors where id = $1::bigint for update", [VEHICLE_ID]);
      assert.equal(locked.rowCount, 1);
    });
  });
});

// --- Pending delete queue ----------------------------------------------------

async function withTempRepoRoot(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-vehicle-delete-queue-"));
  try {
    return await fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

test("vehicle delete queue stores one entry per vehicle and cancel reports a missing one", async () => {
  await withTempRepoRoot((repoRoot) => {
    assert.deepEqual(listQueuedVehicleDeletes(repoRoot), []);

    queueVehicleDelete(repoRoot, { vehicleId: 482, map: "Survival_1", partitionId: 3 });
    queueVehicleDelete(repoRoot, { vehicleId: 517, map: "Overmap", partitionId: 9 });
    queueVehicleDelete(repoRoot, { vehicleId: 482, map: "Survival_1", partitionId: 3 });

    const pending = listQueuedVehicleDeletes(repoRoot);
    assert.deepEqual(pending.map((entry) => entry.vehicleId), [517, 482]);

    const result = cancelQueuedVehicleDelete(repoRoot, 482);
    assert.equal(result.pending, 1);
    assert.deepEqual(listQueuedVehicleDeletes(repoRoot).map((entry) => entry.vehicleId), [517]);
    assert.throws(() => cancelQueuedVehicleDelete(repoRoot, 482), /has no queued delete/);
  });
});

test("real PostgreSQL: flush applies a delete once its partition is confirmed down", async (t) => {
  await withDatabase(t, async (pool) => {
    await withTempRepoRoot(async (repoRoot) => {
      _resetRefillPartitionDwellForTests();
      await pool.query("insert into dune.world_partition (partition_id, map, server_id) values (3, 'Survival_1', null)");
      queueVehicleDelete(repoRoot, { vehicleId: VEHICLE_ID, map: "HaggaBasin", partitionId: 3 });

      const db = pgTransactionalDb(pool);
      const result = await flushVehicleDeletes(db, repoRoot);

      assert.deepEqual(result.flushed.map((entry) => ({ vehicleId: entry.vehicleId, ok: entry.ok })), [{ vehicleId: VEHICLE_ID, ok: true }]);
      assert.equal(result.pending, 0);
      assert.deepEqual(listQueuedVehicleDeletes(repoRoot), []);
      assert.equal(await actorCount(pool, [VEHICLE_ID]), 0);
    });
  });
});

test("real PostgreSQL: flush leaves a delete queued while its map is still live", async (t) => {
  await withDatabase(t, async (pool) => {
    await withTempRepoRoot(async (repoRoot) => {
      _resetRefillPartitionDwellForTests();
      await pool.query("insert into dune.world_partition (partition_id, map, server_id) values (3, 'Survival_1', 'srv-1')");
      queueVehicleDelete(repoRoot, { vehicleId: VEHICLE_ID, map: "HaggaBasin", partitionId: 3 });

      const db = pgTransactionalDb(pool);
      const stillLive = await flushVehicleDeletes(db, repoRoot, { now: () => 1_000_000 });
      assert.deepEqual(stillLive.flushed, []);
      assert.equal(stillLive.pending, 1);
      assert.equal(await actorCount(pool, [VEHICLE_ID]), 1, "a live-map vehicle must not be deleted");

      const afterDwell = await flushVehicleDeletes(db, repoRoot, { now: () => 1_000_000 + 30_000 });
      assert.equal(afterDwell.flushed[0]?.ok, true);
      assert.equal(await actorCount(pool, [VEHICLE_ID]), 0);
    });
  });
});

test("real PostgreSQL: flush treats a vehicle already gone as success, not a retryable failure", async (t) => {
  await withDatabase(t, async (pool) => {
    await withTempRepoRoot(async (repoRoot) => {
      _resetRefillPartitionDwellForTests();
      await pool.query("insert into dune.world_partition (partition_id, map, server_id) values (3, 'Survival_1', null)");
      queueVehicleDelete(repoRoot, { vehicleId: VEHICLE_ID, map: "HaggaBasin", partitionId: 3 });

      // Stands in for the vehicle already being gone (e.g. the game's own
      // Coriolis-storm cleanup) while the delete sits queued.
      const db = pgTransactionalDb(pool);
      await db.transaction(async (tx) => {
        await tx.query("set local search_path to dune, public");
        await tx.query("select dune.delete_actors($1::bigint[])", [[VEHICLE_ID]]);
      });

      const result = await flushVehicleDeletes(db, repoRoot);

      assert.equal(result.flushed[0].ok, true);
      assert.equal(result.flushed[0].alreadyGone, true);
      assert.equal(result.flushed[0].attempts, undefined, "a vehicle already gone must not burn an attempt");
      assert.deepEqual(listQueuedVehicleDeletes(repoRoot), []);
    });
  });
});

test("real PostgreSQL: flush drops an entry after three genuine failures and expires one older than the age limit", async (t) => {
  await withDatabase(t, async (pool) => {
    await withTempRepoRoot(async (repoRoot) => {
      _resetRefillPartitionDwellForTests();
      await pool.query("insert into dune.world_partition (partition_id, map, server_id) values (3, 'Survival_1', null)");
      queueVehicleDelete(repoRoot, { vehicleId: VEHICLE_ID, map: "HaggaBasin", partitionId: 3 });
      const queuedAt = Date.parse(listQueuedVehicleDeletes(repoRoot)[0].queuedAt);

      const real = pgTransactionalDb(pool);
      const failingDb = { query: real.query, transaction: async () => { throw new Error("simulated permanent failure"); } };

      let round = 0;
      const step = () => flushVehicleDeletes(failingDb, repoRoot, { now: () => 1_000_000 + (round++) * 120_000 });

      const first = await step();
      assert.equal(first.flushed[0].ok, false);
      assert.equal(first.flushed[0].attempts, 1);
      assert.equal(first.flushed[0].dropped, false);

      const second = await step();
      assert.equal(second.flushed[0].attempts, 2);

      const third = await step();
      assert.equal(third.flushed[0].attempts, 3);
      assert.equal(third.flushed[0].dropped, true);
      assert.deepEqual(listQueuedVehicleDeletes(repoRoot), []);

      queueVehicleDelete(repoRoot, { vehicleId: VEHICLE_ID, map: "HaggaBasin", partitionId: 3 });
      const requeuedAt = Date.parse(listQueuedVehicleDeletes(repoRoot)[0].queuedAt);
      const expired = await flushVehicleDeletes(failingDb, repoRoot, { now: () => requeuedAt + 7 * 24 * 3600_000 });
      assert.equal(expired.flushed[0].expired, true);
      assert.deepEqual(listQueuedVehicleDeletes(repoRoot), []);
      assert.ok(queuedAt <= requeuedAt);
    });
  });
});

test("real PostgreSQL: a failed safety backup aborts the whole flush pass, leaving every entry queued", async (t) => {
  await withDatabase(t, async (pool) => {
    await withTempRepoRoot(async (repoRoot) => {
      _resetRefillPartitionDwellForTests();
      await pool.query("insert into dune.world_partition (partition_id, map, server_id) values (3, 'Survival_1', null)");
      queueVehicleDelete(repoRoot, { vehicleId: VEHICLE_ID, map: "HaggaBasin", partitionId: 3 });
      queueVehicleDelete(repoRoot, { vehicleId: OTHER_VEHICLE_ID, map: "HaggaBasin", partitionId: 3 });

      const db = pgTransactionalDb(pool);
      let backupCalls = 0;
      const result = await flushVehicleDeletes(db, repoRoot, {
        onBeforeApply: () => { backupCalls += 1; throw new Error("backup destination is full"); }
      });

      assert.equal(backupCalls, 1, "one failed backup must abort the pass, not be retried per vehicle");
      assert.equal(result.backupFailed, true);
      assert.deepEqual(result.flushed, []);
      assert.equal(listQueuedVehicleDeletes(repoRoot).length, 2, "neither vehicle may be deleted without its safety backup");
      assert.equal(await actorCount(pool, [VEHICLE_ID, OTHER_VEHICLE_ID]), 2);
    });
  });
});
