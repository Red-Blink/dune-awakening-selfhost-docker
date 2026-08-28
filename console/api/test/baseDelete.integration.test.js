import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteBaseCompletely,
  queueBaseDelete,
  cancelQueuedBaseDelete,
  listQueuedBaseDeletes,
  flushBaseDeletes,
  BASE_DELETE_BACKED_UP_MESSAGE,
  _resetRefillPartitionDwellForTests
} from "../src/duneDb.js";
import { pgTransactionalDb, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

// Like basePermissions.integration.test.js, this exercises real PostgreSQL
// rather than a mocked db: the guarantees that matter here -- the cascade
// actually removing every row, the transaction actually rolling back
// atomically, a real FOR UPDATE lock -- are exactly the kind a string-matched
// mock cannot prove.
//
// The claim actor (9001) and the displayed base id (a buildings.id, e.g.
// 9002) are deliberately different ids, mirroring production where they never
// match. A second, unrelated base (9101/9102/9103) exists in every test to
// prove a delete never reaches past its own actor set.
const CLAIM_ACTOR = 9001;
const BUILDING_ACTORS = [9002, 9003];
const PLACEABLE_ACTOR = 9004;
const ENTITY_ID = 501;
const PLAYER_ID = 4;

const OTHER_CLAIM_ACTOR = 9101;
const OTHER_BUILDING_ACTOR = 9102;
const OTHER_PLACEABLE_ACTOR = 9103;
const OTHER_ENTITY_ID = 601;

const SCHEMA = `
  create schema dune;

  create table dune.actors (id bigint primary key, map text, partition_id bigint, owner_account_id bigint);
  create table dune.map_names (map_name_id smallint primary key, map_name text not null);
  create table dune.world_partition (partition_id bigint primary key, map text, dimension_index integer default 0, server_id text);

  create table dune.buildings (id bigint primary key references dune.actors(id) on delete cascade);
  -- Unique constraints transcribed from production (building_instances_uniq,
  -- actor_fgl_entities_entity_id_key, actor_fgl_no_slot_duplication). They are
  -- what stop a base's piece set multiplying, so a fixture without them cannot
  -- reproduce that class of bug. actor_id is nullable here because it is
  -- nullable in production -- the fixture must not be stricter than the real
  -- schema, or a row production allows would never be exercised.
  create table dune.building_instances (
    building_id bigint not null references dune.actors(id) on delete cascade,
    instance_id integer not null,
    owner_entity_id bigint,
    constraint building_instances_uniq unique (building_id, instance_id)
  );
  create table dune.actor_fgl_entities (
    entity_id bigint not null unique,
    actor_id bigint references dune.actors(id) on delete cascade,
    slot_name text not null default '',
    constraint actor_fgl_no_slot_duplication unique (actor_id, slot_name)
  );
  create table dune.placeables (
    id bigint primary key references dune.actors(id) on delete cascade,
    owner_entity_id bigint,
    building_type text
  );
  -- actor_type/access_level/is_child are NOT NULL in production with no
  -- defaults, so a fixture omitting them accepts rows the real database would
  -- reject.
  create table dune.permission_actor (
    actor_id bigint primary key references dune.actors(id) on delete cascade,
    actor_name text,
    actor_type smallint not null,
    access_level smallint not null,
    is_child boolean not null
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
  -- Transcribed from production (dune_backup.sql:17781/17793 for the tables,
  -- 75467-75476 for the constraints). A picked-up base has a base_backups
  -- parent row, and the link row cascades from BOTH it and dune.actors -- so
  -- deleting the claim actor also erases the evidence that the base was ever
  -- backed up. Modelled faithfully because a fixture that can be inserted
  -- without a base_backups row would let a test pass against a shape the real
  -- database rejects.
  create table dune.base_backups (
    id bigint primary key,
    player_id bigint references dune.actors(id) on delete cascade,
    base_backup_name text,
    constraint base_backups_id_check check (id > 0)
  );
  create table dune.base_backup_linked_actors (
    id bigint not null references dune.base_backups(id) on delete cascade,
    actor_id bigint references dune.actors(id) on delete cascade
  );
  create table dune.inventories (
    id bigint primary key,
    actor_id bigint not null references dune.actors(id) on delete cascade,
    max_item_count integer not null default 10
  );
  create table dune.items (
    id bigint generated always as identity primary key,
    inventory_id bigint not null references dune.inventories(id) on delete cascade,
    template_id text not null,
    stack_size integer not null default 1
  );
  -- Synthetic fixture, not a modeled production constraint: a full audit of
  -- every FK referencing dune.actors in the real schema (55 constraints,
  -- verified against a restored production dump) found every one is
  -- ON DELETE CASCADE or SET NULL -- none RESTRICT/NO ACTION, so this exact
  -- failure trigger cannot occur against real data. It exists purely to
  -- force a deterministic mid-transaction failure so the atomicity test
  -- below can prove db.transaction's real rollback guarantee -- that
  -- guarantee is what's under test, not this table.
  create table dune.other_refs (id bigint primary key, referenced_actor_id bigint references dune.actors(id));

  -- Transcribed from the shipped schema (see the plan/PR notes), not
  -- reinvented: permission_actor_destroy is the only thing that clears
  -- markers/player_markers, which do not cascade from actors.
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

function seedBase(claimActor, buildingActors, placeableActor, entityId, playerId) {
  const buildingRows = buildingActors.map((id, index) => `
    insert into dune.actors (id, map, partition_id) values (${id}, 'HaggaBasin', 3);
    insert into dune.buildings (id) values (${id});
    insert into dune.building_instances (building_id, instance_id, owner_entity_id) values (${id}, ${index}, ${entityId});
  `).join("\n");
  return `
    insert into dune.actors (id, map, partition_id) values (${claimActor}, 'HaggaBasin', 3);
    insert into dune.actor_fgl_entities (entity_id, actor_id) values (${entityId}, ${claimActor});
    insert into dune.permission_actor (actor_id, actor_name, actor_type, access_level, is_child) values (${claimActor}, 'Test Base ${claimActor}', 4, 1, false);
    insert into dune.markers (marker_hash_id) values (${claimActor});
    insert into dune.player_markers (marker_hash_id, player_id) values (${claimActor}, ${playerId});
    insert into dune.inventories (id, actor_id) values (${claimActor} * 10, ${claimActor});
    insert into dune.items (inventory_id, template_id, stack_size) values (${claimActor} * 10, 'Spice', 12);
    ${buildingRows}
    insert into dune.actors (id, map, partition_id) values (${placeableActor}, 'HaggaBasin', 3);
    insert into dune.placeables (id, owner_entity_id, building_type) values (${placeableActor}, ${entityId}, 'storagecontainer_placeable');
    insert into dune.inventories (id, actor_id) values (${placeableActor} * 10, ${placeableActor});
    insert into dune.items (inventory_id, template_id, stack_size) values (${placeableActor} * 10, 'Aluminum Ingot', 5);
  `;
}

const SEED = `
  insert into dune.actors (id) values (${PLAYER_ID});
  ${seedBase(CLAIM_ACTOR, BUILDING_ACTORS, PLACEABLE_ACTOR, ENTITY_ID, PLAYER_ID)}
  insert into dune.permission_actor_rank (permission_actor_id, player_id, rank) values (${CLAIM_ACTOR}, ${PLAYER_ID}, 1);
  ${seedBase(OTHER_CLAIM_ACTOR, [OTHER_BUILDING_ACTOR], OTHER_PLACEABLE_ACTOR, OTHER_ENTITY_ID, PLAYER_ID)}
  insert into dune.permission_actor_rank (permission_actor_id, player_id, rank) values (${OTHER_CLAIM_ACTOR}, ${PLAYER_ID}, 1);
`;

async function withDatabase(t, run) {
  return withIsolatedDatabase(t, {
    namePrefix: "dune_base_delete",
    unavailableLabel: "the base deletion integration test"
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

test("real PostgreSQL: deleteBaseCompletely enumerates the claim actor, every building, and every placeable, deduplicated", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    const result = await deleteBaseCompletely(db, BUILDING_ACTORS[0]);

    assert.equal(result.ok, true);
    assert.equal(result.actorId, String(CLAIM_ACTOR));
    assert.equal(result.deletedBuildingCount, BUILDING_ACTORS.length);
    assert.equal(result.deletedPlaceableCount, 1);
    // claim actor + 2 buildings + 1 placeable = 4, not 5 -- a building actor
    // id must never be counted twice even though it is discovered through
    // both its own buildings row and its building_instances row.
    assert.equal(result.deletedActorCount, 4);
  });
});

test("real PostgreSQL: deleteBaseCompletely cascades away everything belonging to the base and nothing belonging to another", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    await deleteBaseCompletely(db, BUILDING_ACTORS[0]);

    const deletedIds = [CLAIM_ACTOR, ...BUILDING_ACTORS, PLACEABLE_ACTOR];
    assert.equal(await actorCount(pool, deletedIds), 0);
    assert.equal(await tableCount(pool, "buildings"), 1, "the other base's building must survive");
    assert.equal(await tableCount(pool, "building_instances"), 1);
    assert.equal(await tableCount(pool, "placeables"), 1);
    assert.equal(await tableCount(pool, "actor_fgl_entities"), 1);
    assert.equal(await tableCount(pool, "permission_actor"), 1);
    assert.equal(await tableCount(pool, "permission_actor_rank"), 1);
    assert.equal(await tableCount(pool, "inventories"), 2);
    assert.equal(await tableCount(pool, "items"), 2);

    // markers/player_markers do not cascade from actors in production -- only
    // permission_actor_destroy's explicit deletes clear them, keyed on the
    // claim actor id.
    const markers = await pool.query("select marker_hash_id from dune.markers");
    assert.deepEqual(markers.rows.map((row) => Number(row.marker_hash_id)), [OTHER_CLAIM_ACTOR]);
    const playerMarkers = await pool.query("select marker_hash_id from dune.player_markers");
    assert.deepEqual(playerMarkers.rows.map((row) => Number(row.marker_hash_id)), [OTHER_CLAIM_ACTOR]);

    // The other base's own actors, unrelated to this delete, are untouched.
    assert.equal(await actorCount(pool, [OTHER_CLAIM_ACTOR, OTHER_BUILDING_ACTOR, OTHER_PLACEABLE_ACTOR]), 3);
  });
});

test("real PostgreSQL: deleteBaseCompletely rejects a base id that does not exist", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    await assert.rejects(() => deleteBaseCompletely(db, 424242), /was not found/);
    // Nothing about the seeded bases should have moved.
    assert.equal(await actorCount(pool, [CLAIM_ACTOR, OTHER_CLAIM_ACTOR]), 2);
  });
});

test("real PostgreSQL: a mid-transaction failure rolls back permission_actor_destroy's work too", async (t) => {
  await withDatabase(t, async (pool) => {
    // other_refs is synthetic (see its CREATE TABLE comment) -- no real FK
    // on dune.actors would actually reject a delete this way. It's a
    // deliberate, controlled trigger for a real failure, so the transaction
    // genuinely has something to roll back rather than never getting far
    // enough to test the guarantee at all.
    await pool.query("insert into dune.other_refs (id, referenced_actor_id) values (1, $1)", [BUILDING_ACTORS[1]]);

    const db = pgTransactionalDb(pool);
    await assert.rejects(() => deleteBaseCompletely(db, BUILDING_ACTORS[0]));

    // If the rollback were partial, permission_actor_destroy's deletes (which
    // ran first) would have stuck even though delete_actors failed after it.
    assert.equal(await actorCount(pool, [CLAIM_ACTOR, ...BUILDING_ACTORS, PLACEABLE_ACTOR]), 4);
    assert.equal(await tableCount(pool, "permission_actor"), 2);
    assert.equal(await tableCount(pool, "permission_actor_rank"), 2);
    const markers = await pool.query("select marker_hash_id from dune.markers where marker_hash_id = $1", [CLAIM_ACTOR]);
    assert.equal(markers.rows.length, 1);
    const playerMarkers = await pool.query("select marker_hash_id from dune.player_markers where marker_hash_id = $1", [CLAIM_ACTOR]);
    assert.equal(playerMarkers.rows.length, 1);
  });
});

// --- Pending delete queue ----------------------------------------------------

async function withTempRepoRoot(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-delete-queue-"));
  try {
    return await fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

test("delete queue stores one entry per base and cancel reports a missing one", async () => {
  await withTempRepoRoot((repoRoot) => {
    assert.deepEqual(listQueuedBaseDeletes(repoRoot), []);

    queueBaseDelete(repoRoot, { baseId: 482, map: "Survival_1", partitionId: 3 });
    queueBaseDelete(repoRoot, { baseId: 517, map: "Overmap", partitionId: 9 });
    queueBaseDelete(repoRoot, { baseId: 482, map: "Survival_1", partitionId: 3 });

    const pending = listQueuedBaseDeletes(repoRoot);
    assert.deepEqual(pending.map((entry) => entry.baseId), [517, 482]);

    const result = cancelQueuedBaseDelete(repoRoot, 482);
    assert.equal(result.pending, 1);
    assert.deepEqual(listQueuedBaseDeletes(repoRoot).map((entry) => entry.baseId), [517]);
    assert.throws(() => cancelQueuedBaseDelete(repoRoot, 482), /has no queued delete/);
  });
});

test("real PostgreSQL: flush applies a delete once its partition is confirmed down", async (t) => {
  await withDatabase(t, async (pool) => {
    await withTempRepoRoot(async (repoRoot) => {
      _resetRefillPartitionDwellForTests();
      // Unassigned server_id is positive evidence the map is gone (what
      // despawn does), so this is write-safe immediately -- no dwell needed.
      await pool.query("insert into dune.world_partition (partition_id, map, server_id) values (3, 'Survival_1', null)");
      queueBaseDelete(repoRoot, { baseId: BUILDING_ACTORS[0], map: "HaggaBasin", partitionId: 3 });

      const db = pgTransactionalDb(pool);
      const result = await flushBaseDeletes(db, repoRoot);

      assert.deepEqual(result.flushed.map((entry) => ({ baseId: entry.baseId, ok: entry.ok })), [{ baseId: BUILDING_ACTORS[0], ok: true }]);
      assert.equal(result.pending, 0);
      assert.deepEqual(listQueuedBaseDeletes(repoRoot), []);
      assert.equal(await actorCount(pool, [CLAIM_ACTOR]), 0);
    });
  });
});

// The route checks baseIsBackedUp once, before queueing. A queued delete can
// then wait hours for its map to come down, which is more than enough time for
// a player to pick the base up. These two cases pin the re-check that closes
// that window, and the retry accounting that keeps a blocked entry alive.
test("real PostgreSQL: deleteBaseCompletely refuses a base that was picked up into a backup", async (t) => {
  await withDatabase(t, async (pool) => {
    // Exactly what the backup tool leaves behind: the claim is gone and the
    // actor is registered. Neither signal alone means picked-up.
    await pool.query("delete from dune.permission_actor where actor_id = $1", [CLAIM_ACTOR]);
    await pool.query("insert into dune.base_backups (id, player_id, base_backup_name) values (1, $1, 'Picked up')", [PLAYER_ID]);
    await pool.query("insert into dune.base_backup_linked_actors (id, actor_id) values (1, $1)", [CLAIM_ACTOR]);

    const db = pgTransactionalDb(pool);
    await assert.rejects(
      () => deleteBaseCompletely(db, BUILDING_ACTORS[0]),
      (error) => error.message === BASE_DELETE_BACKED_UP_MESSAGE);
    // Refused, and refused atomically: permission_actor_destroy runs after this
    // guard, so the markers a redeploy needs are still there.
    assert.equal(await actorCount(pool, [CLAIM_ACTOR, ...BUILDING_ACTORS]), 3);
    assert.equal(await tableCount(pool, "markers"), 2);
  });
});

test("real PostgreSQL: an unclaimed base with no backup registration still deletes", async (t) => {
  await withDatabase(t, async (pool) => {
    // Unclaimed alone is not picked-up -- baseIsBackedUp needs both signals, so
    // dropping the claim must not turn into an accidental delete-blocker.
    await pool.query("delete from dune.permission_actor where actor_id = $1", [CLAIM_ACTOR]);

    const db = pgTransactionalDb(pool);
    const result = await deleteBaseCompletely(db, BUILDING_ACTORS[0]);
    assert.equal(result.ok, true);
    assert.equal(await actorCount(pool, [CLAIM_ACTOR, ...BUILDING_ACTORS]), 0);
  });
});

test("real PostgreSQL: flush retains a picked-up base without burning its retry budget", async (t) => {
  await withDatabase(t, async (pool) => {
    await withTempRepoRoot(async (repoRoot) => {
      _resetRefillPartitionDwellForTests();
      await pool.query("insert into dune.world_partition (partition_id, map, server_id) values (3, 'Survival_1', null)");
      await pool.query("delete from dune.permission_actor where actor_id = $1", [CLAIM_ACTOR]);
      await pool.query("insert into dune.base_backups (id, player_id, base_backup_name) values (1, $1, 'Picked up')", [PLAYER_ID]);
      await pool.query("insert into dune.base_backup_linked_actors (id, actor_id) values (1, $1)", [CLAIM_ACTOR]);
      queueBaseDelete(repoRoot, { baseId: BUILDING_ACTORS[0], map: "HaggaBasin", partitionId: 3 });

      const db = pgTransactionalDb(pool);
      // More rounds than MAX_DELETE_FLUSH_ATTEMPTS: a counted failure would
      // have dropped the entry by now.
      for (let round = 0; round < 4; round += 1) {
        const result = await flushBaseDeletes(db, repoRoot, { now: () => 1_000_000 + round * 120_000 });
        assert.equal(result.flushed[0].ok, false);
        assert.equal(result.flushed[0].attempts, 0);
        assert.equal(result.flushed[0].dropped, false);
      }
      assert.equal(listQueuedBaseDeletes(repoRoot)[0].attempts, 0);
      assert.equal(await actorCount(pool, [CLAIM_ACTOR]), 1);
    });
  });
});

test("real PostgreSQL: flush applies the delete once the base is redeployed", async (t) => {
  await withDatabase(t, async (pool) => {
    await withTempRepoRoot(async (repoRoot) => {
      _resetRefillPartitionDwellForTests();
      await pool.query("insert into dune.world_partition (partition_id, map, server_id) values (3, 'Survival_1', null)");
      await pool.query("delete from dune.permission_actor where actor_id = $1", [CLAIM_ACTOR]);
      await pool.query("insert into dune.base_backups (id, player_id, base_backup_name) values (1, $1, 'Picked up')", [PLAYER_ID]);
      await pool.query("insert into dune.base_backup_linked_actors (id, actor_id) values (1, $1)", [CLAIM_ACTOR]);
      queueBaseDelete(repoRoot, { baseId: BUILDING_ACTORS[0], map: "HaggaBasin", partitionId: 3 });

      const db = pgTransactionalDb(pool);
      // Controlled clock: a blocked entry gets a nextRetryAt one retry delay
      // out, so the second pass has to be far enough ahead to be eligible at
      // all -- otherwise it skips the entry and proves nothing.
      assert.equal((await flushBaseDeletes(db, repoRoot, { now: () => 1_000_000 })).flushed[0].ok, false);

      // Redeploy: the claim comes back. The entry is still queued, so the very
      // next eligible pass should apply it rather than needing to be re-requested.
      await pool.query("insert into dune.permission_actor (actor_id, actor_name, actor_type, access_level, is_child) values ($1, 'Redeployed', 4, 1, false)", [CLAIM_ACTOR]);
      const result = await flushBaseDeletes(db, repoRoot, { now: () => 1_200_000 });
      assert.equal(result.flushed[0].ok, true);
      assert.equal(result.pending, 0);
      assert.equal(await actorCount(pool, [CLAIM_ACTOR]), 0);
    });
  });
});

// The safety backup is a full database dump, so a base that can never be
// deleted must not buy one on every retry pass -- at a 60s retry delay and a
// 7 day age limit that is thousands of dumps. db.sh count-prunes the origin as
// a backstop; this keeps the churn from happening in the first place.
test("real PostgreSQL: a blocked base is refused without paying for a safety backup", async (t) => {
  await withDatabase(t, async (pool) => {
    await withTempRepoRoot(async (repoRoot) => {
      _resetRefillPartitionDwellForTests();
      await pool.query("insert into dune.world_partition (partition_id, map, server_id) values (3, 'Survival_1', null)");
      await pool.query("delete from dune.permission_actor where actor_id = $1", [CLAIM_ACTOR]);
      await pool.query("insert into dune.base_backups (id, player_id, base_backup_name) values (1, $1, 'Picked up')", [PLAYER_ID]);
      await pool.query("insert into dune.base_backup_linked_actors (id, actor_id) values (1, $1)", [CLAIM_ACTOR]);
      queueBaseDelete(repoRoot, { baseId: BUILDING_ACTORS[0], map: "HaggaBasin", partitionId: 3 });

      const db = pgTransactionalDb(pool);
      let backupCalls = 0;
      const result = await flushBaseDeletes(db, repoRoot, { onBeforeApply: () => { backupCalls += 1; } });

      assert.equal(backupCalls, 0, "a refusal must not take a full database backup");
      assert.equal(result.flushed[0].ok, false);
      assert.match(result.flushed[0].error, /picked up into a backup/i);
      assert.equal(result.flushed[0].attempts, 0, "the retry budget is still preserved");
      assert.equal(listQueuedBaseDeletes(repoRoot).length, 1, "and the entry stays queued");
      assert.equal(await actorCount(pool, [CLAIM_ACTOR]), 1);
    });
  });
});

// The other case that cannot proceed. baseIsBackedUp inner-joins the entity
// chain, so a base whose owner_entity_id links are gone reports "not backed up",
// would buy a full-database backup, and then throw "no resolvable owner entity"
// on the very next line. Measured against a restored dump, 12 of 35 buildings
// rows resolve to no claim actor, so this is the common case, not a corner.
test("real PostgreSQL: a base with no resolvable owner is cleared without a safety backup", async (t) => {
  await withDatabase(t, async (pool) => {
    await withTempRepoRoot(async (repoRoot) => {
      _resetRefillPartitionDwellForTests();
      await pool.query("insert into dune.world_partition (partition_id, map, server_id) values (3, 'Survival_1', null)");
      // ON DELETE SET NULL against fgl_entities is how this happens in production.
      await pool.query("update dune.building_instances set owner_entity_id = null where building_id = $1", [BUILDING_ACTORS[0]]);
      queueBaseDelete(repoRoot, { baseId: BUILDING_ACTORS[0], map: "HaggaBasin", partitionId: 3 });

      const db = pgTransactionalDb(pool);
      let backupCalls = 0;
      const result = await flushBaseDeletes(db, repoRoot, { onBeforeApply: () => { backupCalls += 1; } });

      assert.equal(backupCalls, 0, "an unresolvable base must not buy a full database backup");
      assert.equal(result.flushed[0].ok, true, "resolved, not failed");
      assert.equal(result.flushed[0].alreadyGone, true);
      assert.deepEqual(listQueuedBaseDeletes(repoRoot), [], "and the entry is cleared, not left to retry");
    });
  });
});

test("real PostgreSQL: flush leaves a delete queued while its map is still live", async (t) => {
  await withDatabase(t, async (pool) => {
    await withTempRepoRoot(async (repoRoot) => {
      _resetRefillPartitionDwellForTests();
      // server_id assigned, and nothing is connected under a matching
      // application_name -- read as live until the dwell elapses.
      await pool.query("insert into dune.world_partition (partition_id, map, server_id) values (3, 'Survival_1', 'srv-1')");
      queueBaseDelete(repoRoot, { baseId: BUILDING_ACTORS[0], map: "HaggaBasin", partitionId: 3 });

      const db = pgTransactionalDb(pool);
      const stillLive = await flushBaseDeletes(db, repoRoot, { now: () => 1_000_000 });
      assert.deepEqual(stillLive.flushed, []);
      assert.equal(stillLive.pending, 1);
      assert.equal(await actorCount(pool, [CLAIM_ACTOR]), 1, "a live-map base must not be deleted");

      const afterDwell = await flushBaseDeletes(db, repoRoot, { now: () => 1_000_000 + 30_000 });
      assert.equal(afterDwell.flushed[0]?.ok, true);
      assert.equal(await actorCount(pool, [CLAIM_ACTOR]), 0);
    });
  });
});

test("real PostgreSQL: flush treats a base already gone as success, not a retryable failure", async (t) => {
  await withDatabase(t, async (pool) => {
    await withTempRepoRoot(async (repoRoot) => {
      _resetRefillPartitionDwellForTests();
      await pool.query("insert into dune.world_partition (partition_id, map, server_id) values (3, 'Survival_1', null)");
      queueBaseDelete(repoRoot, { baseId: BUILDING_ACTORS[0], map: "HaggaBasin", partitionId: 3 });

      // Stands in for the base's own owner demolishing it while the delete
      // sits queued -- delete_actors cascades away everything this base has.
      const db = pgTransactionalDb(pool);
      await db.transaction(async (tx) => {
        // The shipped function uses unqualified Dune table names. Production
        // establishes this transaction-local path before calling it, so the
        // fixture must reproduce that contract as well.
        await tx.query("set local search_path to dune, public");
        await tx.query("select dune.delete_actors($1::bigint[])", [[CLAIM_ACTOR, ...BUILDING_ACTORS, PLACEABLE_ACTOR]]);
      });

      const result = await flushBaseDeletes(db, repoRoot);

      assert.equal(result.flushed[0].ok, true);
      assert.equal(result.flushed[0].alreadyGone, true);
      assert.equal(result.flushed[0].attempts, undefined, "a base already gone must not burn an attempt");
      assert.deepEqual(listQueuedBaseDeletes(repoRoot), []);
    });
  });
});

test("real PostgreSQL: flush drops an entry after three genuine failures and expires one older than the age limit", async (t) => {
  await withDatabase(t, async (pool) => {
    await withTempRepoRoot(async (repoRoot) => {
      _resetRefillPartitionDwellForTests();
      await pool.query("insert into dune.world_partition (partition_id, map, server_id) values (3, 'Survival_1', null)");
      queueBaseDelete(repoRoot, { baseId: BUILDING_ACTORS[0], map: "HaggaBasin", partitionId: 3 });
      const queuedAt = Date.parse(listQueuedBaseDeletes(repoRoot)[0].queuedAt);

      // A real transaction that always fails, matching the plan's mocked
      // "connection terminated"-style forced failure but proven against a
      // live pool here: db.transaction is overridden, db.query stays real.
      const real = pgTransactionalDb(pool);
      const failingDb = { query: real.query, transaction: async () => { throw new Error("simulated permanent failure"); } };

      let round = 0;
      const step = () => flushBaseDeletes(failingDb, repoRoot, { now: () => 1_000_000 + (round++) * 120_000 });

      const first = await step();
      assert.equal(first.flushed[0].ok, false);
      assert.equal(first.flushed[0].attempts, 1);
      assert.equal(first.flushed[0].dropped, false);

      const second = await step();
      assert.equal(second.flushed[0].attempts, 2);

      const third = await step();
      assert.equal(third.flushed[0].attempts, 3);
      assert.equal(third.flushed[0].dropped, true);
      assert.deepEqual(listQueuedBaseDeletes(repoRoot), []);

      // A fresh entry that has simply outlived the age limit is dropped on
      // that basis alone, independent of the attempt counter above.
      queueBaseDelete(repoRoot, { baseId: BUILDING_ACTORS[0], map: "HaggaBasin", partitionId: 3 });
      const requeuedAt = Date.parse(listQueuedBaseDeletes(repoRoot)[0].queuedAt);
      const expired = await flushBaseDeletes(failingDb, repoRoot, { now: () => requeuedAt + 7 * 24 * 3600_000 });
      assert.equal(expired.flushed[0].expired, true);
      assert.deepEqual(listQueuedBaseDeletes(repoRoot), []);
      assert.ok(queuedAt <= requeuedAt);
    });
  });
});

test("real PostgreSQL: a failed safety backup aborts the whole flush pass, leaving every entry queued", async (t) => {
  await withDatabase(t, async (pool) => {
    await withTempRepoRoot(async (repoRoot) => {
      _resetRefillPartitionDwellForTests();
      await pool.query("insert into dune.world_partition (partition_id, map, server_id) values (3, 'Survival_1', null)");
      queueBaseDelete(repoRoot, { baseId: BUILDING_ACTORS[0], map: "HaggaBasin", partitionId: 3 });
      queueBaseDelete(repoRoot, { baseId: OTHER_BUILDING_ACTOR, map: "HaggaBasin", partitionId: 3 });

      const db = pgTransactionalDb(pool);
      let backupCalls = 0;
      const result = await flushBaseDeletes(db, repoRoot, {
        onBeforeApply: () => { backupCalls += 1; throw new Error("backup destination is full"); }
      });

      assert.equal(backupCalls, 1, "one failed backup must abort the pass, not be retried per base");
      assert.equal(result.backupFailed, true);
      assert.deepEqual(result.flushed, []);
      assert.equal(listQueuedBaseDeletes(repoRoot).length, 2, "neither base may be deleted without its safety backup");
      assert.equal(await actorCount(pool, [CLAIM_ACTOR, OTHER_CLAIM_ACTOR]), 2);
    });
  });
});
