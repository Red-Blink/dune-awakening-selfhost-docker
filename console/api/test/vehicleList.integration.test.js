import test from "node:test";
import assert from "node:assert/strict";
import { listVehicles, liveMapVehicles } from "../src/duneDb.js";
import { ownedListOptions, redactSharedWith } from "../src/playerScope.js";
import { pgTransactionalDb, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

// Runs the real listVehicles query; db.test.js only asserts its SQL text.
// The schema follows production where these paths depend on it: player_state
// is a view hiding non-Active characters, and a stored vehicle has no roster
// or owner_account_id, only the character on its recovery/backup record.
const SCHEMA = `
  create schema dune;

  create type dune.actorstate as enum (
    'Default', 'Travel', 'VehicleBackup', 'AbortedAuthorityTransfer', 'VehicleRecovery', 'BaseBackup', 'SimulatedLandsraadActor'
  );
  create type dune.playerconnectionstatus as enum ('Offline', 'LoggingOut', 'Online');
  create type dune.recoveredvehiclereason as enum ('Normal', 'Migrated', 'RecoveredFromLostState');
  create type dune.vector3 as (x double precision, y double precision, z double precision);
  create type dune.transform as (location dune.vector3);

  create table dune.actors (
    id bigint primary key,
    class text,
    map text,
    partition_id bigint,
    owner_account_id bigint,
    state dune.actorstate not null default 'Default',
    transform dune.transform
  );
  create table dune.map_names (map_name_id smallint primary key, map_name text not null);
  create table dune.vehicles (id bigint primary key references dune.actors(id) on delete cascade);
  create table dune.vehicle_modules (
    id bigint primary key,
    vehicle_id bigint not null references dune.vehicles(id) on delete cascade,
    template_id text not null,
    stats jsonb
  );
  create table dune.fgl_entities (entity_id bigint primary key, components jsonb);
  create table dune.actor_fgl_entities (actor_id bigint not null, entity_id bigint not null);

  create table dune.encrypted_player_state (
    id bigint primary key,
    account_id bigint not null,
    player_controller_id bigint,
    character_name text,
    online_status dune.playerconnectionstatus not null default 'Offline',
    character_state text not null default 'Active'
  );
  create view dune.player_state as
    select id, account_id, player_controller_id, character_name, online_status
    from dune.encrypted_player_state where character_state = 'Active';

  create table dune.permission_actor (
    actor_id bigint primary key references dune.actors(id) on delete cascade,
    actor_name text
  );
  create table dune.permission_actor_rank (
    permission_actor_id bigint not null references dune.permission_actor(actor_id) on delete cascade,
    player_id bigint not null references dune.actors(id) on delete cascade,
    rank smallint not null,
    unique (permission_actor_id, player_id)
  );

  create table dune.recovered_vehicles (
    vehicle_id bigint not null unique references dune.vehicles(id) on delete cascade,
    character_id bigint not null references dune.encrypted_player_state(id) on update cascade on delete cascade,
    time_stored timestamptz not null default current_timestamp,
    reason dune.recoveredvehiclereason not null default 'Normal'
  );
  create table dune.backup_vehicles (
    vehicle_id bigint not null unique references dune.vehicles(id) on delete cascade,
    character_id bigint not null unique references dune.encrypted_player_state(id) on update cascade on delete cascade
  );

  create function dune.permission_actor_destroy(in_actor_id bigint) returns void language sql as $$
    delete from dune.permission_actor where actor_id = in_actor_id;
  $$;
  create function dune.delete_actors(in_ids bigint[]) returns void language sql as $$
    delete from dune.actors where id = any(in_ids);
  $$;
`;

const DUNCAN = { character: 1, account: 100, controller: 11 };
const GURNEY = { character: 2, account: 200, controller: 12 };
const DELETED = { character: 3, account: 300 };

const OWNED = 501;
const RECOVERED = 502;
const BACKED_UP = 503;
const UNOWNED = 504;
const TRAVELLING = 505;
const RECOVERED_ORPHAN = 506;

function vehicle(id, cls, state, { partition = 1, at = "(1,2,3)" } = {}) {
  return `
    insert into dune.actors (id, class, map, partition_id, state, transform)
      values (${id}, '/Game/Vehicles/BP_${cls}.BP_${cls}_C', 'HaggaBasin', ${partition === null ? "null" : partition}, '${state}', row(row${at}::dune.vector3)::dune.transform);
    insert into dune.vehicles (id) values (${id});
    insert into dune.vehicle_modules (id, vehicle_id, template_id, stats) values (${id} * 10, ${id}, '${cls}Engine_1', '{}'::jsonb);
  `;
}

const SEED = `
  insert into dune.encrypted_player_state (id, account_id, player_controller_id, character_name) values
    (${DUNCAN.character}, ${DUNCAN.account}, ${DUNCAN.controller}, 'Duncan'),
    (${GURNEY.character}, ${GURNEY.account}, ${GURNEY.controller}, 'Gurney');
  insert into dune.encrypted_player_state (id, account_id, character_name, character_state)
    values (${DELETED.character}, ${DELETED.account}, 'Gone', 'Deleted');
  insert into dune.actors (id, owner_account_id) values (${DUNCAN.controller}, ${DUNCAN.account}), (${GURNEY.controller}, ${GURNEY.account});

  ${vehicle(OWNED, "Sandbike", "Default")}
  insert into dune.permission_actor (actor_id, actor_name) values (${OWNED}, 'Sihaya');
  insert into dune.permission_actor_rank (permission_actor_id, player_id, rank) values (${OWNED}, ${DUNCAN.controller}, 1);

  ${vehicle(RECOVERED, "Buggy", "VehicleRecovery", { partition: null })}
  insert into dune.recovered_vehicles (vehicle_id, character_id, time_stored, reason)
    values (${RECOVERED}, ${GURNEY.character}, '2026-07-02T10:00:00Z', 'RecoveredFromLostState');

  ${vehicle(BACKED_UP, "Sandbike", "VehicleBackup", { partition: null })}
  insert into dune.backup_vehicles (vehicle_id, character_id) values (${BACKED_UP}, ${DUNCAN.character});

  ${vehicle(UNOWNED, "Buggy", "Default")}
  ${vehicle(TRAVELLING, "Sandcrawler", "Travel", { partition: null })}

  ${vehicle(RECOVERED_ORPHAN, "Sandbike", "VehicleRecovery", { partition: null })}
  insert into dune.recovered_vehicles (vehicle_id, character_id) values (${RECOVERED_ORPHAN}, ${DELETED.character});
`;

async function withDatabase(t, run) {
  return withIsolatedDatabase(t, {
    namePrefix: "dune_vehicle_list",
    unavailableLabel: "the vehicle list integration test"
  }, async (pool) => {
    await pool.query(SCHEMA);
    await pool.query(SEED);
    return run(pgTransactionalDb(pool), pool);
  });
}

async function listed(db, options) {
  const result = await listVehicles(db, { sortColumn: "id", ...options });
  assert.equal(result.capabilities.vehicles, true, result.reason);
  return result;
}

const ids = (result) => result.rows.map((row) => Number(row.id));
const byId = (result, id) => result.rows.find((row) => Number(row.id) === id);

for (const schema of ["inline", "legacy", "unavailable"]) {
  test(`real PostgreSQL: livemap vehicle lifecycle visibility (${schema})`, async (t) => {
    await withDatabase(t, async (db, pool) => {
      // Stored vehicles deliberately retain valid coordinates and an assigned
      // partition: checking their saved location alone reproduces the bug.
      await pool.query(`
        create table dune.world_partition (partition_id bigint primary key, server_id text);
        insert into dune.world_partition values (1, 'fixture-server');
        update dune.actors set partition_id=1 where id in (${RECOVERED}, ${BACKED_UP}, ${TRAVELLING}, ${RECOVERED_ORPHAN});
      `);
      if (schema === "legacy") {
        await pool.query(`
          create table dune.actor_state (actor_id bigint primary key, state dune.actorstate);
          insert into dune.actor_state select id, state from dune.actors;
          alter table dune.actors drop column state;
        `);
      } else if (schema === "unavailable") {
        await pool.query("alter table dune.actors drop column state");
      }
      const markers = await liveMapVehicles(db, "HaggaBasin");
      assert.equal(markers.capabilities.vehicles, true, markers.reason);
      assert.deepEqual(ids(markers), schema === "unavailable"
        ? [OWNED, RECOVERED, BACKED_UP, UNOWNED, TRAVELLING, RECOVERED_ORPHAN]
        : [OWNED, UNOWNED]);

      if (schema !== "unavailable") {
        // Redeploying a vehicle makes it visible on the next query, even if
        // a historical backup link remains. No cache or owner is required.
        await pool.query(schema === "inline"
          ? `update dune.actors set state='Default' where id=${BACKED_UP}`
          : `delete from dune.actor_state where actor_id=${BACKED_UP}`);
        const redeployed = await liveMapVehicles(db, "HaggaBasin");
        assert.equal(redeployed.capabilities.vehicles, true, redeployed.reason);
        assert.deepEqual(ids(redeployed), [OWNED, BACKED_UP, UNOWNED]);
      }
    });
  });
}

test("real PostgreSQL: each status returns exactly its bucket, and the buckets partition the list", async (t) => {
  await withDatabase(t, async (db) => {
    const all = await listed(db, { status: "all" });
    assert.deepEqual(ids(all), [OWNED, RECOVERED, BACKED_UP, UNOWNED, TRAVELLING, RECOVERED_ORPHAN]);
    assert.equal(all.totalCount, 6);
    assert.equal(all.totalVehicles, 6);

    const expected = {
      // Travel counts as owned even though no owner resolves for it.
      owned: [OWNED, TRAVELLING],
      // A stored vehicle stays in its bucket whether or not an owner resolves.
      recovery: [RECOVERED, RECOVERED_ORPHAN],
      backup: [BACKED_UP],
      unowned: [UNOWNED]
    };
    const seen = [];
    for (const [status, want] of Object.entries(expected)) {
      const result = await listed(db, { status });
      assert.deepEqual(ids(result), want, status);
      assert.equal(result.totalCount, want.length, `${status} totalCount`);
      assert.equal(result.totalVehicles, 6, "the unfiltered total ignores the status");
      seen.push(...want);
    }
    assert.deepEqual([...seen].sort(), ids(all).sort(), "every vehicle is in exactly one bucket");

    // Omitted and unknown statuses both mean "all".
    assert.equal((await listed(db, {})).totalCount, 6);
    assert.equal((await listed(db, { status: "owned' or 1=1 --" })).totalCount, 6);
  });
});

test("real PostgreSQL: a stored vehicle's owner comes from its recovery or backup record", async (t) => {
  await withDatabase(t, async (db) => {
    const all = await listed(db, { status: "all" });
    assert.equal(byId(all, OWNED).owner, "Duncan", "rank-1 roster owner");
    assert.equal(byId(all, RECOVERED).owner, "Gurney", "recovered_vehicles.character_id");
    assert.equal(byId(all, BACKED_UP).owner, "Duncan", "backup_vehicles.character_id");
    assert.equal(byId(all, UNOWNED).owner, "");
    assert.equal(byId(all, TRAVELLING).owner, "");
    // The record's character is Deleted, so the player_state view hides it.
    assert.equal(byId(all, RECOVERED_ORPHAN).owner, "");

    const recovered = byId(all, RECOVERED);
    assert.equal(recovered.lifecycle_state, "VehicleRecovery");
    assert.equal(new Date(recovered.stored_at).toISOString(), "2026-07-02T10:00:00.000Z");
    assert.equal(recovered.stored_reason, "RecoveredFromLostState");
    assert.equal(byId(all, RECOVERED_ORPHAN).stored_reason, "Normal");
    for (const id of [OWNED, BACKED_UP, UNOWNED, TRAVELLING]) {
      assert.equal(byId(all, id).stored_at, null, `${id} was never stored for recovery`);
      assert.equal(byId(all, id).stored_reason, null);
    }
  });
});

test("real PostgreSQL: the status filter combines with search and survives an out-of-range page", async (t) => {
  await withDatabase(t, async (db) => {
    // The resolved stored owner is searchable, and narrows within the bucket.
    assert.deepEqual(ids(await listed(db, { status: "recovery", q: "Gurney" })), [RECOVERED]);
    assert.deepEqual(ids(await listed(db, { status: "owned", q: "Gurney" })), []);
    assert.deepEqual(ids(await listed(db, { status: "all", q: "Duncan" })), [OWNED, BACKED_UP]);

    const past = await listed(db, { status: "recovery", page: 5, pageSize: 1 });
    assert.deepEqual(past.rows, []);
    assert.equal(past.totalCount, 2, "totalCount must survive a page past the end");

    assert.deepEqual(ids(await listed(db, { status: "recovery", sortColumn: "owner", sortDirection: "desc" })), [RECOVERED, RECOVERED_ORPHAN]);
  });
});

test("real PostgreSQL: the list reports the stored-delete capability on this schema", async (t) => {
  await withDatabase(t, async (db, pool) => {
    const supported = await listed(db, {});
    assert.equal(supported.capabilities.vehicleDelete, true);
    assert.equal(supported.capabilities.vehicleStoredDelete, true);

    // An older schema without the recovery timestamp: the list still works,
    // with no stored date and the stored delete withheld.
    await pool.query("alter table dune.recovered_vehicles drop column time_stored");
    const older = await listed(db, { status: "recovery" });
    assert.deepEqual(ids(older), [RECOVERED, RECOVERED_ORPHAN]);
    assert.equal(byId(older, RECOVERED).owner, "Gurney");
    assert.equal(byId(older, RECOVERED).stored_at, null);
    assert.equal(older.capabilities.vehicleStoredDelete, false);
  });
});

// The ?access filter on a player's Vehicles tab, against real rows. The vehicle
// "owner" is its account owner OR a rank-1 roster holder; "co-owner" is rank 2 and
// not the account owner (the owner wins). Rank 3 is only in the unfiltered list.
test("real PostgreSQL: the access filter partitions a player's vehicles by owner, co-owner and associate", async (t) => {
  await withDatabase(t, async (db, pool) => {
    const SHARED_RANK1 = 601;      // Duncan rank 1
    const SHARED_RANK2 = 602;      // Duncan rank 2, owned by Gurney's account
    const OWNER_AND_RANK2 = 603;   // Duncan's account owns it AND he holds rank 2: owner wins
    const SHARED_RANK3 = 604;      // Duncan rank 3 (associate)
    const NOT_DUNCANS = 605;       // Gurney only
    // The player resolver reads the character's pawn actor through player_state.player_pawn_id.
    const DUNCAN_PAWN = 21, GURNEY_PAWN = 22;
    await pool.query(`
      alter table dune.encrypted_player_state add column player_pawn_id bigint;
      create or replace view dune.player_state as
        select id, account_id, player_controller_id, character_name, online_status, player_pawn_id
        from dune.encrypted_player_state where character_state = 'Active';
      insert into dune.actors (id, class, owner_account_id) values
        (${DUNCAN_PAWN}, '/Game/Characters/BP_PlayerCharacter.BP_PlayerCharacter_C', ${DUNCAN.account}),
        (${GURNEY_PAWN}, '/Game/Characters/BP_PlayerCharacter.BP_PlayerCharacter_C', ${GURNEY.account});
      update dune.encrypted_player_state set player_pawn_id = ${DUNCAN_PAWN} where id = ${DUNCAN.character};
      update dune.encrypted_player_state set player_pawn_id = ${GURNEY_PAWN} where id = ${GURNEY.character};
    `);
    await pool.query(`
      ${vehicle(SHARED_RANK1, "Sandbike", "Default")}
      ${vehicle(SHARED_RANK2, "Buggy", "Default")}
      ${vehicle(OWNER_AND_RANK2, "Buggy", "Default")}
      ${vehicle(SHARED_RANK3, "Sandbike", "Default")}
      ${vehicle(NOT_DUNCANS, "Sandbike", "Default")}
      update dune.actors set owner_account_id = ${GURNEY.account} where id = ${SHARED_RANK2};
      update dune.actors set owner_account_id = ${DUNCAN.account} where id = ${OWNER_AND_RANK2};
      insert into dune.permission_actor (actor_id, actor_name) values
        (${SHARED_RANK1}, 'a'), (${SHARED_RANK2}, 'b'), (${OWNER_AND_RANK2}, 'c'), (${SHARED_RANK3}, 'd'), (${NOT_DUNCANS}, 'e');
      insert into dune.permission_actor_rank (permission_actor_id, player_id, rank) values
        (${SHARED_RANK1}, ${DUNCAN.controller}, 1),
        (${SHARED_RANK2}, ${DUNCAN.controller}, 2),
        (${OWNER_AND_RANK2}, ${DUNCAN.controller}, 2),
        (${SHARED_RANK3}, ${DUNCAN.controller}, 3),
        (${NOT_DUNCANS}, ${GURNEY.controller}, 1);
    `);
    const mine = async (player, access) =>
      ids(await listed(db, { playerId: String(player === DUNCAN ? DUNCAN_PAWN : GURNEY_PAWN), pageSize: 200, ...(access ? { access } : {}) }))
        .filter((id) => id >= 600).sort((a, b) => a - b);

    assert.deepEqual(await mine(DUNCAN), [601, 602, 603, 604], "default is every roster rank");
    assert.deepEqual(await mine(DUNCAN, "all"), [601, 602, 603, 604]);
    assert.deepEqual(await mine(DUNCAN, "owner"), [601, 603], "account owner or rank 1");
    assert.deepEqual(await mine(DUNCAN, "coowner"), [602], "rank 2, and not a vehicle the account owns");
    assert.deepEqual(await mine(DUNCAN, "bogus"), [601, 602, 603, 604], "an unknown level means all");

    const owner = await listed(db, { playerId: String(DUNCAN_PAWN), pageSize: 200, access: "owner" });
    assert.ok(owner.rows.filter((r) => Number(r.id) >= 600).every((r) => r.relationship === "Owner"));
    const co = await listed(db, { playerId: String(DUNCAN_PAWN), pageSize: 200, access: "coowner" });
    assert.ok(co.rows.every((r) => r.relationship === "Co-Owner"));

    // Another player's rows never leak in, and the filter is per player.
    assert.deepEqual(await mine(GURNEY, "owner"), [602, 605], "Gurney's account owns 602; rank 1 on 605");
    assert.deepEqual(await mine(GURNEY, "coowner"), []);
  });
});

test("real PostgreSQL: the player tier lists only vehicles it owns and never another player's name (#1276)", async (t) => {
  await withDatabase(t, async (db, pool) => {
    const MINE = 701, CO = 702, ASSOC = 703, THEIRS = 704;
    const DUNCAN_PAWN = 21, GURNEY_PAWN = 22;
    await pool.query(`
      alter table dune.encrypted_player_state add column player_pawn_id bigint;
      create or replace view dune.player_state as
        select id, account_id, player_controller_id, character_name, online_status, player_pawn_id
        from dune.encrypted_player_state where character_state = 'Active';
      insert into dune.actors (id, class, owner_account_id) values
        (${DUNCAN_PAWN}, '/Game/Characters/BP_PlayerCharacter.BP_PlayerCharacter_C', ${DUNCAN.account}),
        (${GURNEY_PAWN}, '/Game/Characters/BP_PlayerCharacter.BP_PlayerCharacter_C', ${GURNEY.account});
      update dune.encrypted_player_state set player_pawn_id = ${DUNCAN_PAWN} where id = ${DUNCAN.character};
      update dune.encrypted_player_state set player_pawn_id = ${GURNEY_PAWN} where id = ${GURNEY.character};
      ${vehicle(MINE, "Sandbike", "Default")}
      ${vehicle(CO, "Buggy", "Default")}
      ${vehicle(ASSOC, "Buggy", "Default")}
      ${vehicle(THEIRS, "Sandbike", "Default")}
      update dune.actors set owner_account_id = ${DUNCAN.account} where id = ${MINE};
      update dune.actors set owner_account_id = ${GURNEY.account} where id in (${CO}, ${ASSOC}, ${THEIRS});
      insert into dune.permission_actor (actor_id, actor_name) values (${MINE}, 'm'), (${CO}, 'c'), (${ASSOC}, 'a'), (${THEIRS}, 't');
      insert into dune.permission_actor_rank (permission_actor_id, player_id, rank) values
        (${MINE}, ${DUNCAN.controller}, 1), (${MINE}, ${GURNEY.controller}, 3),
        (${CO}, ${GURNEY.controller}, 1), (${CO}, ${DUNCAN.controller}, 2),
        (${ASSOC}, ${GURNEY.controller}, 1), (${ASSOC}, ${DUNCAN.controller}, 3),
        (${THEIRS}, ${GURNEY.controller}, 1);
    `);
    const session = { player_controller_id: String(DUNCAN.controller), player_pawn_id: String(DUNCAN_PAWN) };
    // Hostile query: asks for another player and every rank.
    const options = ownedListOptions(session, { playerId: String(GURNEY_PAWN), access: "all", pageSize: "200" });
    const raw = await listVehicles(db, { ...options, sortColumn: "id" });
    assert.equal(raw.capabilities.vehicles, true, raw.reason);
    assert.ok(JSON.stringify(raw).includes("Gurney"), "the unredacted row carries the other player, so redaction is load-bearing");
    const mine = redactSharedWith(raw);
    assert.deepEqual(ids(mine).filter((id) => id >= 700), [MINE]);
    assert.ok(!JSON.stringify(mine).includes("Gurney"));
    // Search stays inside the owned set.
    for (const q of ["Gurney", String(THEIRS), String(CO), String(ASSOC)]) {
      assert.deepEqual(ids(await listVehicles(db, { ...options, q })).filter((id) => id >= 700), [], q);
    }
  });
});
