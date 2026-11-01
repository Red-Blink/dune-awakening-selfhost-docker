import test from "node:test";
import assert from "node:assert/strict";
import * as duneDb from "../src/duneDb.js";
import { listBases, listOwnedStorage } from "../src/duneDb.js";
import { ownedListOptions, redactSharedWith, playerOwnedAssetsBody } from "../src/playerScope.js";
import { pgTransactionalDb, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

// #1276 against real rows: a player sees only what they OWN (rank 1). A base,
// vehicle or chest they co-own or have associate access to is not listed, and
// no other player's name appears on anything that is.
const SCHEMA = `
  create schema dune;
  create type dune.vector3 as (x double precision, y double precision, z double precision);
  create type dune.transform as (location dune.vector3);
  create table dune.buildings (id bigint primary key, owner_id bigint);
  create table dune.building_instances (building_id bigint not null, instance_id integer not null, building_type text, owner_entity_id bigint, health real);
  create table dune.actor_fgl_entities (entity_id bigint not null, actor_id bigint not null);
  create table dune.actors (id bigint primary key, class text, map text, partition_id bigint, owner_account_id bigint, transform dune.transform);
  create table dune.permission_actor (actor_id bigint primary key, actor_name text, actor_type smallint, access_level smallint, is_child boolean default false, edited_by_player_id bigint);
  create table dune.permission_actor_rank (
    permission_actor_id bigint not null references dune.permission_actor(actor_id) on delete cascade,
    player_id bigint not null,
    rank smallint not null,
    unique (permission_actor_id, player_id)
  );
  create table dune.player_state (
    id bigint, account_id bigint, player_controller_id bigint, player_pawn_id bigint,
    character_name text, online_status text default 'Offline'
  );
  create table dune.placeables (id bigint primary key, owner_entity_id bigint, health real, building_type text, is_hologram boolean not null default false);
  create table dune.inventories (id bigint primary key, actor_id bigint, max_item_count integer, max_item_volume real);
  create table dune.items (id bigint primary key, inventory_id bigint, stack_size bigint, position_index bigint, template_id text);
  create table dune.map_names (map_name_id smallint primary key, map_name text not null);
  create table dune.discord_player_links (discord_user_id text primary key, player_controller_id text unique);
`;

const DUNCAN = { pawn: 21, controller: 11, account: 100 };
const GURNEY = { pawn: 22, controller: 12, account: 200 };

function base(n, name) {
  const id = 1000 + n;
  return `
    insert into dune.buildings (id) values (${id});
    insert into dune.actors (id, class, map, partition_id, transform) values (${id}, '/Game/Totem.Totem_C', 'HaggaBasin', 1, row(row(1,2,3)::dune.vector3)::dune.transform);
    insert into dune.actor_fgl_entities (entity_id, actor_id) values (${id + 500}, ${id});
    insert into dune.building_instances (building_id, instance_id, building_type, owner_entity_id, health) values (${id}, 1, 'Sardaukar_Foundation', ${id + 500}, 100);
    insert into dune.permission_actor (actor_id, actor_name, actor_type, access_level, is_child) values (${id}, '${name}', 1, 3, false);
  `;
}

// A chest hangs off its base's claim actor via owner_entity_id -> actor_fgl_entities.
function chest(id, baseId, items) {
  return `
    insert into dune.actors (id, class, map) values (${id}, '/Game/Chest.Chest_C', 'HaggaBasin');
    insert into dune.placeables (id, owner_entity_id, building_type) values (${id}, ${baseId + 500}, 'StorageContainer_Placeable');
    insert into dune.inventories (id, actor_id) values (${id * 10}, ${id});
    ${Array.from({ length: items }, (_, i) => `insert into dune.items (id, inventory_id, stack_size, position_index, template_id) values (${id * 100 + i}, ${id * 10}, 1, ${i}, 'X');`).join("\n")}
  `;
}

const SEED = `
  insert into dune.actors (id, class, owner_account_id) values
    (${DUNCAN.pawn}, '/Game/Characters/BP_PlayerCharacter.BP_PlayerCharacter_C', ${DUNCAN.account}),
    (${GURNEY.pawn}, '/Game/Characters/BP_PlayerCharacter.BP_PlayerCharacter_C', ${GURNEY.account}),
    (${DUNCAN.controller}, null, ${DUNCAN.account}),
    (${GURNEY.controller}, null, ${GURNEY.account});
  insert into dune.player_state (id, account_id, player_controller_id, player_pawn_id, character_name) values
    (1, ${DUNCAN.account}, ${DUNCAN.controller}, ${DUNCAN.pawn}, 'Duncan'),
    (2, ${GURNEY.account}, ${GURNEY.controller}, ${GURNEY.pawn}, 'Gurney');
  ${base(1, "Owned by Duncan")}
  ${base(2, "Duncan is co-owner")}
  ${base(3, "Duncan is associate")}
  ${base(4, "Gurney only")}
  insert into dune.permission_actor_rank (permission_actor_id, player_id, rank) values
    (1001, ${DUNCAN.controller}, 1), (1001, ${GURNEY.controller}, 3),
    (1002, ${DUNCAN.controller}, 2), (1002, ${GURNEY.controller}, 1),
    (1003, ${DUNCAN.controller}, 3), (1003, ${GURNEY.controller}, 1),
    (1004, ${GURNEY.controller}, 1);
  ${chest(2001, 1001, 2)}
  ${chest(2002, 1002, 1)}
  ${chest(2003, 1003, 1)}
  ${chest(2004, 1004, 3)}
  ${chest(2005, 1001, 1)}
  ${chest(2006, 1001, 1)}
  ${chest(2007, 1001, 1)}
  update dune.placeables set is_hologram = true where id = 2005;
  update dune.placeables set building_type = 'SpiceSilo_Placeable' where id = 2006;
  update dune.placeables set building_type = 'Workbench_Placeable' where id = 2007;
  -- A second rank row and a second permission row on one base must not multiply its item count.
  insert into dune.permission_actor_rank (permission_actor_id, player_id, rank) values (1001, 77, 2);
  insert into dune.player_state (id, account_id, player_controller_id, player_pawn_id, character_name) values (3, 300, 77, 23, 'Hawat');
  insert into dune.actors (id, class, owner_account_id) values (77, null, 300), (23, '/Game/Characters/BP_PlayerCharacter.BP_PlayerCharacter_C', 300);
  insert into dune.discord_player_links (discord_user_id, player_controller_id) values ('d-duncan', '${DUNCAN.controller}'), ('d-hawat', '77');
`;

async function withDatabase(t, run) {
  return withIsolatedDatabase(t, { namePrefix: "dune_player_owned_assets", unavailableLabel: "the player owned assets integration test" }, async (pool) => {
    await pool.query(SCHEMA);
    await pool.query(SEED);
    return run(pgTransactionalDb(pool), pool);
  });
}

const linked = (p) => ({ player_controller_id: String(p.controller), player_pawn_id: String(p.pawn) });

test("real PostgreSQL: bases listed through the player options are rank-1 only and hide other players", async (t) => {
  await withDatabase(t, async (db) => {
    // Hostile query string: tries to select another player and every rank.
    const options = ownedListOptions(linked(DUNCAN), { playerId: String(GURNEY.pawn), access: "all", q: "", pageSize: "200" });
    const result = redactSharedWith(await listBases(db, options));
    assert.equal(result.capabilities?.bases, true, result.reason);
    assert.deepEqual(result.rows.map((r) => r.base_id), ["1001"]);
    assert.ok(!JSON.stringify(result).includes("Gurney"), "co/shared players must not appear");
    // Searching another player's base or name finds nothing: search stays inside the owned set.
    for (const q of ["Gurney only", "Duncan is co-owner", "1002", "1004"]) {
      const found = await listBases(db, { ...options, q });
      assert.deepEqual(found.rows.map((r) => r.base_id), [], q);
    }
    assert.deepEqual((await listBases(db, { ...options, q: "Owned by" })).rows.map((r) => r.base_id), ["1001"]);
    // Totals describe the owned scope only.
    assert.equal(result.totalBases, 1);
    assert.equal(result.totalShared, 0);
  });
});

test("real PostgreSQL: the unredacted base row does carry the other player (so redaction is load-bearing)", async (t) => {
  await withDatabase(t, async (db) => {
    const raw = await listBases(db, ownedListOptions(linked(DUNCAN), {}));
    assert.ok(JSON.stringify(raw).includes("Gurney"));
    assert.ok(!JSON.stringify(redactSharedWith(raw)).includes("Gurney"));
  });
});

test("real PostgreSQL: owned storage excludes co-owned, associate and other players' chests", async (t) => {
  await withDatabase(t, async (db) => {
    const duncan = await listOwnedStorage(db, DUNCAN.controller);
    assert.deepEqual(duncan.rows.map((r) => Number(r.id)), [2001, 2006], "owned storage and silo; no hologram, no non-storage placeable");
    assert.equal(duncan.rows[0].item_count, 2, "no row multiplication from the roster join");
    assert.equal(duncan.rows[0].owner_name, "Duncan");
    assert.ok(!JSON.stringify(duncan).includes("Gurney"));
    const gurney = await listOwnedStorage(db, GURNEY.controller);
    assert.deepEqual(gurney.rows.map((r) => Number(r.id)), [2002, 2003, 2004]);
    assert.deepEqual((await listOwnedStorage(db, 999)).rows, []);
  });
});

const instructions = { reason: "not linked", message: "link it" };
const call = (session, path, query = {}) => playerOwnedAssetsBody({ duneDb, db: session.db, session, path, query, linkInstructions: instructions });

test("real PostgreSQL: the handler serves each list for a linked player and nothing from another", async (t) => {
  await withDatabase(t, async (db) => {
    const session = { userId: "d-duncan", db, tier: "player" };
    const hostile = { playerId: String(GURNEY.pawn), access: "all", pageSize: "100000" };
    const bases = await call(session, "/api/bases", hostile);
    assert.deepEqual(bases.rows.map((r) => r.base_id), ["1001"]);
    assert.ok(!JSON.stringify(bases).includes("Gurney"));
    const storage = await call(session, "/api/storage", hostile);
    assert.deepEqual(storage.rows.map((r) => Number(r.id)), [2001, 2006]);
    assert.ok(!JSON.stringify(storage).includes("Gurney"));
  });
});

test("real PostgreSQL: the handler returns notLinked, never data, for an unlinked or unspawned player", async (t) => {
  await withDatabase(t, async (db, pool) => {
    for (const path of ["/api/bases", "/api/vehicles", "/api/storage"]) {
      const unlinked = await call({ userId: "nobody", db, tier: "player" }, path, { playerId: String(DUNCAN.pawn) });
      assert.equal(unlinked.notLinked, true, path);
      assert.deepEqual(unlinked.rows, [], path);
    }
    // Linked, but the character has no pawn yet: getLinkedPlayer falls back to "0".
    await pool.query("update dune.player_state set player_pawn_id = null where player_controller_id = 77");
    const unspawned = await call({ userId: "d-hawat", db, tier: "player" }, "/api/bases", {});
    assert.equal(unspawned.notLinked, undefined, "linking again would not help");
    assert.equal(unspawned.notSpawned, true);
    assert.deepEqual(unspawned.rows, []);
  });
});

test("real PostgreSQL: a chest's item count is not multiplied by a second character on the owner's account", async (t) => {
  await withDatabase(t, async (db, pool) => {
    await pool.query(`insert into dune.player_state (id, account_id, player_controller_id, player_pawn_id, character_name) values (9, ${DUNCAN.account}, 999, 29, 'Duncan II')`);
    const rows = (await listOwnedStorage(db, DUNCAN.controller)).rows;
    assert.equal(rows.find((r) => Number(r.id) === 2001).item_count, 2);
  });
});

test("real PostgreSQL: owned storage reports unsupported, not a crash, when a table is missing", async (t) => {
  await withDatabase(t, async (db, pool) => {
    await pool.query("drop table dune.items");
    const result = await listOwnedStorage(db, DUNCAN.controller);
    assert.equal(result.capabilities.storage, false);
    assert.deepEqual(result.rows, []);
  });
});
