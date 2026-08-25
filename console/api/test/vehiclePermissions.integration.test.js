import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { setVehiclePermissions, listVehiclePermissions, vehiclePermissionCandidates, transferVehicleToSystemCustodian } from "../src/duneDb.js";
import { pgConnectionConfig, pgTransactionalDb, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

const { Client } = pg;

// The mocked suite in vehiclePermissions.test.js string-matches SQL and can
// prove what we *intend* to send. It cannot catch the failures that only a
// real PostgreSQL round trip surfaces -- see basePermissions.integration.test.js
// for the three classes of bug this style of test exists to catch (argument
// order, search_path, the unquoted notify payload). All three apply here
// unchanged since setVehiclePermissions shares mutatePermissionRoster with
// setBasePermissions.
const OWNER_RANK = 1;
const CO_OWNER_RANK = 2;
const ASSOCIATE_RANK = 3;

// Unlike a base, a vehicle IS its own permission actor -- no separate
// building/entity chain to seed, and the displayed id equals the actor id.
const VEHICLE_ID = 3001;
const MAP_NAME = "DeepDesert";
const MAP_NAME_ID = 7;

// A second vehicle with every structural row intact and no dune.permission_actor
// row -- an unclaimed vehicle.
const UNCLAIMED_VEHICLE_ID = 3002;

const SCHEMA = `
  create schema dune;

  create table dune.vehicles (id bigint primary key);
  create table dune.actors (id bigint primary key, map text, partition_id bigint, owner_account_id bigint);
  create table dune.map_names (map_name_id smallint primary key, map_name text not null);
  create table dune.permission_actor (actor_id bigint primary key, actor_name text);
  create table dune.permission_actor_rank (
    permission_actor_id bigint not null references dune.permission_actor(actor_id) on delete cascade,
    player_id bigint not null,
    rank smallint not null
  );
  create table dune.player_state (account_id bigint, player_controller_id bigint, player_pawn_id bigint, character_name text);
  create table dune.encrypted_player_state (
    account_id bigint,
    player_controller_id bigint,
    player_state_id bigint,
    player_pawn_id bigint,
    encrypted_character_name bytea
  );

  create function dune.decrypt_user_data(value bytea)
  returns text language sql immutable as $$ select convert_from(value, 'UTF8') $$;

  create function dune.permission_actor_create_or_update_base_marker(in_actor_id bigint, in_player_id bigint, in_rank smallint)
  returns void language plpgsql as $$ begin return; end $$;

  create function dune.permission_set_player_rank(in_actor_id bigint, in_player_id bigint, in_rank smallint, in_map_id text)
  returns void language plpgsql as $$
  declare found_actor_id bigint;
  begin
    select permission_actor_id from permission_actor_rank
      where permission_actor_id = in_actor_id and player_id = in_player_id into found_actor_id;
    if not found then
      insert into permission_actor_rank(permission_actor_id, player_id, rank) values(in_actor_id, in_player_id, in_rank);
    else
      update permission_actor_rank set rank = in_rank
        where permission_actor_rank.permission_actor_id = in_actor_id and player_id = in_player_id;
    end if;
    perform permission_actor_create_or_update_base_marker(in_actor_id, in_player_id, in_rank);
    perform pg_notify('permission_notify_channel',
      format('set_rank#{"ActorId" : %s , "PlayerId" : %s, "PlayerGuildId" : %s, "Rank" : %s, "Map" : %s}',
             in_actor_id, in_player_id, 0, in_rank, in_map_id));
  end $$;

  create function dune.permission_remove_player_rank(in_actor_id bigint, in_player_id bigint)
  returns void language plpgsql as $$
  begin
    delete from permission_actor_rank where permission_actor_id = in_actor_id and player_id = in_player_id;
    perform pg_notify('permission_notify_channel',
      format('remove_rank#{"ActorId" : %s , "PlayerId" : %s}', in_actor_id, in_player_id));
  end $$;
`;

const SEED = `
  insert into dune.vehicles (id) values (${VEHICLE_ID});
  insert into dune.actors (id, map, partition_id, owner_account_id) values (${VEHICLE_ID}, '${MAP_NAME}', 8, null);
  insert into dune.map_names (map_name_id, map_name) values (${MAP_NAME_ID}, '${MAP_NAME}');
  insert into dune.permission_actor (actor_id, actor_name) values (${VEHICLE_ID}, 'Vehicle Test');

  insert into dune.vehicles (id) values (${UNCLAIMED_VEHICLE_ID});
  insert into dune.actors (id, map, partition_id, owner_account_id) values (${UNCLAIMED_VEHICLE_ID}, '${MAP_NAME}', 8, null);
  -- Deliberately no dune.permission_actor row for ${UNCLAIMED_VEHICLE_ID}.

  insert into dune.actors (id, owner_account_id) values (4, 2), (5, 2), (23, 6), (29, 8);
  insert into dune.player_state (account_id, player_controller_id, player_pawn_id, character_name)
    values
      (2, 4, 4, 'DarkShark'),
      (6, 23, 23, 'Furizu'),
      (8, 29, 29, 'Yaida'),
      (9000002, 900000201, 900000203, 'Server');

  insert into dune.permission_actor_rank (permission_actor_id, player_id, rank) values (${VEHICLE_ID}, 4, ${OWNER_RANK});
  insert into dune.encrypted_player_state
    (account_id, player_controller_id, player_state_id, player_pawn_id, encrypted_character_name)
    values (9000001, 900000101, 900000102, 900000103, convert_to('GM', 'UTF8'));
`;

async function withDatabase(t, run) {
  return withIsolatedDatabase(t, {
    namePrefix: "dune_vehicle_perms",
    unavailableLabel: "the vehicle permission integration test"
  }, async (pool, database) => {
    await pool.query(SCHEMA);
    await pool.query(SEED);
    return run(pool, database);
  });
}

async function ranks(pool) {
  const result = await pool.query(
    "select player_id::text as player_id, rank::int as rank from dune.permission_actor_rank where permission_actor_id = $1 order by rank, player_id",
    [VEHICLE_ID]);
  return result.rows.map((row) => ({ playerId: row.player_id, rank: row.rank }));
}

test("real PostgreSQL: an unclaimed vehicle is refused rather than violating the permission_actor foreign key", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);

    await assert.rejects(
      () => pool.query(
        "insert into dune.permission_actor_rank (permission_actor_id, player_id, rank) values ($1, 4, $2)",
        [UNCLAIMED_VEHICLE_ID, OWNER_RANK]),
      /permission_actor_rank_permission_actor_id_fkey/);

    await assert.rejects(
      () => setVehiclePermissions(db, UNCLAIMED_VEHICLE_ID, [{ playerId: "4", rank: OWNER_RANK }], 32),
      /not claimed/);
    await assert.rejects(
      () => transferVehicleToSystemCustodian(db, UNCLAIMED_VEHICLE_ID, 32),
      /not claimed/);

    await assert.rejects(
      () => setVehiclePermissions(db, UNCLAIMED_VEHICLE_ID, [{ playerId: "4", rank: OWNER_RANK }], 32),
      (error) => !/foreign key|fkey/i.test(error.message));

    const written = await pool.query(
      "select count(*)::int as count from dune.permission_actor_rank where permission_actor_id = $1",
      [UNCLAIMED_VEHICLE_ID]);
    assert.equal(written.rows[0].count, 0);
  });
});

test("real PostgreSQL: an unclaimed vehicle still reads, flagged, so the editor can explain itself", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    const unclaimed = await listVehiclePermissions(db, UNCLAIMED_VEHICLE_ID);
    assert.equal(unclaimed.claimed, false);
    assert.match(unclaimed.unclaimedReason, /not claimed/);
    assert.deepEqual(unclaimed.entries, []);

    const claimed = await listVehiclePermissions(db, VEHICLE_ID);
    assert.equal(claimed.claimed, true);
    assert.equal(claimed.unclaimedReason, "");
  });
});

test("real PostgreSQL: a roster save writes through the shipped procedures with the right argument order", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    const result = await setVehiclePermissions(db, VEHICLE_ID, [
      { playerId: "4", rank: OWNER_RANK },
      { playerId: "23", rank: ASSOCIATE_RANK }
    ], 32);

    assert.equal(result.ok, true);
    assert.equal(result.actorId, String(VEHICLE_ID));
    assert.deepEqual(await ranks(pool), [
      { playerId: "4", rank: OWNER_RANK },
      { playerId: "23", rank: ASSOCIATE_RANK }
    ]);
  });
});

test("real PostgreSQL: promoting swaps the owner without ever leaving two", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    await setVehiclePermissions(db, VEHICLE_ID, [
      { playerId: "4", rank: OWNER_RANK },
      { playerId: "23", rank: CO_OWNER_RANK }
    ], 32);
    await setVehiclePermissions(db, VEHICLE_ID, [
      { playerId: "23", rank: OWNER_RANK },
      { playerId: "4", rank: CO_OWNER_RANK }
    ], 32);

    const rows = await ranks(pool);
    assert.deepEqual(rows, [
      { playerId: "23", rank: OWNER_RANK },
      { playerId: "4", rank: CO_OWNER_RANK }
    ]);
    assert.equal(rows.filter((row) => row.rank === OWNER_RANK).length, 1);
  });
});

test("real PostgreSQL: removing a player deletes only that rank row", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    await setVehiclePermissions(db, VEHICLE_ID, [
      { playerId: "4", rank: OWNER_RANK },
      { playerId: "23", rank: ASSOCIATE_RANK },
      { playerId: "29", rank: ASSOCIATE_RANK }
    ], 32);
    const result = await setVehiclePermissions(db, VEHICLE_ID, [
      { playerId: "4", rank: OWNER_RANK },
      { playerId: "29", rank: ASSOCIATE_RANK }
    ], 32);

    assert.equal(result.removed, 1);
    assert.deepEqual(await ranks(pool), [
      { playerId: "4", rank: OWNER_RANK },
      { playerId: "29", rank: ASSOCIATE_RANK }
    ]);
  });
});

test("real PostgreSQL: the emitted notification payload is well-formed JSON carrying the numeric map id", async (t) => {
  await withDatabase(t, async (pool, database) => {
    const listener = new Client(pgConnectionConfig(database));
    const received = [];
    await listener.connect();
    listener.on("notification", (message) => received.push(message.payload));
    await listener.query("listen permission_notify_channel");

    const db = pgTransactionalDb(pool);
    await setVehiclePermissions(db, VEHICLE_ID, [
      { playerId: "4", rank: OWNER_RANK },
      { playerId: "23", rank: ASSOCIATE_RANK }
    ], 32);

    await new Promise((resolve) => setTimeout(resolve, 250));
    await listener.query("select 1");
    await listener.end();

    const setRank = received.find((payload) => payload.startsWith("set_rank#"));
    assert.ok(setRank, `expected a set_rank notification, got ${JSON.stringify(received)}`);
    const body = JSON.parse(setRank.slice("set_rank#".length));
    assert.equal(body.ActorId, VEHICLE_ID);
    assert.equal(body.PlayerId, 23);
    assert.equal(body.Rank, ASSOCIATE_RANK);
    assert.equal(body.Map, MAP_NAME_ID);
  });
});

test("real PostgreSQL: a player id that is not a player_controller_id is refused", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    await assert.rejects(
      () => setVehiclePermissions(db, VEHICLE_ID, [
        { playerId: "4", rank: OWNER_RANK },
        { playerId: "5", rank: ASSOCIATE_RANK }
      ], 32),
      /not a known player character/);
    assert.deepEqual(await ranks(pool), [{ playerId: "4", rank: OWNER_RANK }]);
  });
});

test("real PostgreSQL: the roster reads back with resolved names and rank labels", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    await setVehiclePermissions(db, VEHICLE_ID, [
      { playerId: "4", rank: OWNER_RANK },
      { playerId: "29", rank: CO_OWNER_RANK }
    ], 32);

    const roster = await listVehiclePermissions(db, VEHICLE_ID);
    assert.equal(roster.actorId, String(VEHICLE_ID));
    assert.equal(roster.mapNameId, MAP_NAME_ID);
    assert.deepEqual(roster.entries.map((entry) => [entry.name, entry.label, entry.canonical]), [
      ["DarkShark", "Owner", true],
      ["Yaida", "Co-Owner", true]
    ]);
  });
});

// A base's actor id has no row in dune.vehicles, so the join that resolves
// vehiclePermissionActor finds nothing for it. Regression guard for the class
// of id-confusion bug fixed in 25818bb7.
test("real PostgreSQL: a nonexistent vehicle id (including a foreign actor id) is refused, not silently accepted", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    await assert.rejects(
      () => listVehiclePermissions(db, 999999),
      /That vehicle was not found/);
    await assert.rejects(
      () => setVehiclePermissions(db, 999999, [{ playerId: "4", rank: OWNER_RANK }], 32),
      /That vehicle was not found/);
  });
});

test("real PostgreSQL: the candidate picker returns player_controller_ids", async (t) => {
  await withDatabase(t, async (pool) => {
    const candidates = await vehiclePermissionCandidates(pgTransactionalDb(pool), { limit: 50 });
    const ids = candidates.map((row) => row.playerId);
    assert.deepEqual(ids.sort(), ["23", "29", "4"].sort());
    assert.ok(!ids.includes("5"), "5 belongs to the same account as 4 but is not a controller id");
  });
});

test("real PostgreSQL: Server can own a vehicle while the previous roster is preserved", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    const result = await transferVehicleToSystemCustodian(db, VEHICLE_ID);
    assert.equal(result.systemCustodian.playerId, "900000201");
    assert.deepEqual(await ranks(pool), [
      { playerId: "900000201", rank: OWNER_RANK },
      { playerId: "4", rank: CO_OWNER_RANK }
    ]);
  });
});

test("real PostgreSQL: encrypted Funcom GM is used when Server is absent", async (t) => {
  await withDatabase(t, async (pool) => {
    await pool.query("delete from dune.player_state where character_name = 'Server'");
    const db = pgTransactionalDb(pool);
    const result = await transferVehicleToSystemCustodian(db, VEHICLE_ID);
    assert.deepEqual(result.systemCustodian, { available: true, playerId: "900000101", name: "GM" });
    assert.match(result.message, /GM system custodian/);
    assert.deepEqual(await ranks(pool), [
      { playerId: "900000101", rank: OWNER_RANK },
      { playerId: "4", rank: CO_OWNER_RANK }
    ]);

    const roster = await listVehiclePermissions(db, VEHICLE_ID);
    const owner = roster.entries.find((entry) => entry.rank === OWNER_RANK);
    assert.deepEqual([owner.name, owner.playerId, owner.canonical], ["GM", "900000101", true]);
  });
});
