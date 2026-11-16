import test from "node:test";
import assert from "node:assert/strict";
import {
  deleteBaseBackup, exportBaseBackup, exportLiveBase, importBaseBackup, listBaseBackups, updateBaseBackup, BaseBackupError, BaseBackupTimeoutError
} from "../src/baseBackups.js";
import { pgTransactionalDb, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";
import {
  BASE_BACKUP_SCHEMA, TRANSFER_HELPER_STUBS, BASE_BACKUP_SEED, SOURCE, TARGET, BIG_INT_TEXT, LIVE
} from "../test-support/baseBackupFixture.js";

// Real PostgreSQL: the guarantees under test are the database's -- foreign
// keys, 0-based array bounds, composite types, jsonb number handling -- so a
// string-matched fake db could not show them. The character-transfer helpers
// are stand-ins (see test-support/baseBackupFixture.js).

async function withDatabase(t, run) {
  return withIsolatedDatabase(t, {
    namePrefix: "dune_base_backup_xfer",
    unavailableLabel: "the base-backup export/import integration test"
  }, async (pool) => {
    await pool.query(BASE_BACKUP_SCHEMA);
    await pool.query(TRANSFER_HELPER_STUBS);
    await pool.query(BASE_BACKUP_SEED);
    return run(pool, pgTransactionalDb(pool));
  });
}

async function exportText(db) {
  const { text } = await exportBaseBackup(db, SOURCE.backup, { gameBuild: "2036754", consoleVersion: "test" });
  return text;
}

async function linkedActors(pool, backupId) {
  const result = await pool.query(`
    select a.id, a.class, a.partition_id, a.state, a.transform::text as transform, p.building_type
    from dune.base_backup_linked_actors l
    join dune.actors a on a.id = l.actor_id
    left join dune.placeables p on p.id = a.id
    where l.id = $1 order by a.class`, [backupId]);
  return result.rows;
}

test("real PostgreSQL: a base backup export carries the whole backup, version info and array bounds", async (t) => {
  await withDatabase(t, async (pool, db) => {
    const text = await exportText(db);
    // The 64-bit value is still exact in the file: it never became a JS number.
    assert.ok(text.includes(BIG_INT_TEXT), "64-bit item stat must survive export verbatim");
    const file = JSON.parse(text);
    assert.equal(file.format, "dune-base-backup");
    assert.equal(file.version, 1);
    assert.equal(file.source.name, "Test Base");
    assert.equal(file.source.ownerName, "Owner");
    assert.deepEqual(file.source.counts, { pieces: 3, placeables: 2, items: 2 });
    assert.equal(file.game.build, "2036754");
    assert.equal(file.game.appliedPatchesCount, 2);
    const checksum = (await pool.query("select md5('PATCH-1,PATCH-2') as md5")).rows[0].md5;
    assert.equal(file.game.patchesChecksum, checksum);
    // Non-default array bounds travel per row; 1-based rows carry none.
    const bounds = (kind) => file.entries.filter((e) => e.kind === kind).map((e) => e.data.__lb || null);
    assert.deepEqual(bounds("BuildingInstance"), [{ transform: 0 }, { transform: 0 }, { transform: 0 }]);
    assert.deepEqual(bounds("Totem"), [{ landclaim_original_global_location: 0 }]);
    assert.deepEqual(bounds("Sinkchart"), [{ marker_hash_ids: 0 }]);
    assert.deepEqual(bounds("BuildingBlueprintPentashield"), [{ scale: 0 }]);
    assert.deepEqual(bounds("BuildingBlueprintInstance").sort((a, b) => (a ? 0 : 1) - (b ? 0 : 1)), [{ transform: 0 }, null]);
    assert.equal("arrayLowerBounds" in file, false);
    // A reference outside the base on an allowlisted path is exported as @0.
    const sinkItem = file.entries.find((e) => e.kind === "itm" && e.data.template_id === "Sinkchart_Item");
    assert.equal(sinkItem.data.stats.FSinkchartsStats[1].CreatorPlayerId, "!!act@0");

    const byKind = {};
    for (const entry of file.entries) byKind[entry.kind] = (byKind[entry.kind] || 0) + 1;
    assert.deepEqual(byKind, {
      act: 4, // 3 base actors + the owner placeholder
      fgl: 3, PermissionActor: 1, inv: 1, itm: 2, ActorInventory: 1, Building: 1,
      BuildingInstance: 3, Placeable: 2, Totem: 1, BaseBackup: 1, BaseBackupLinkedActor: 3,
      LandclaimSegment: 2, Sinkchart: 1, bbp: 1, BuildingBlueprintInstance: 2, BuildingBlueprintPentashield: 1
    });
    const placeholder = file.entries.find((entry) => entry.id === file.ownerPlaceholderTransferId);
    assert.deepEqual(placeholder, { id: file.ownerPlaceholderTransferId, kind: "act", data: {} });
    for (const entry of file.entries.filter((e) => e.kind === "act")) {
      assert.equal("partition_id" in entry.data, false, "partition_id is never exported");
    }
    // The unrelated claimed actor is not in the file.
    assert.equal(file.entries.filter((e) => e.kind === "PermissionActor").length, 1);
    // Blueprint creator is stripped: it only means something on the source.
    assert.equal("player_id" in file.entries.find((e) => e.kind === "bbp").data, false);
  });
});

test("real PostgreSQL: importing a base backup recreates it exactly for the receiving player", async (t) => {
  await withDatabase(t, async (pool, db) => {
    const text = await exportText(db);
    const result = await importBaseBackup(db, TARGET.pawn, Buffer.from(text), { serverBuild: "2036754" });
    assert.equal(result.ok, true);
    assert.equal(result.version.mismatch, false);
    assert.equal(result.playerControllerId, TARGET.controller);
    assert.deepEqual(result.counts, { actors: 3, pieces: 3, placeables: 2, items: 2 });
    const backupId = result.backupId;
    assert.notEqual(backupId, SOURCE.backup);

    const backup = (await pool.query("select * from dune.base_backups where id = $1", [backupId])).rows[0];
    assert.equal(Number(backup.player_id), TARGET.controller);
    assert.equal(backup.base_backup_name, "Test Base");
    assert.equal(Number(backup.last_edited_by_player_id), TARGET.controller);

    const sourceActors = await linkedActors(pool, SOURCE.backup);
    const newActors = await linkedActors(pool, backupId);
    assert.equal(newActors.length, 3);
    for (const [index, actor] of newActors.entries()) {
      const source = sourceActors[index];
      assert.ok(Number(actor.id) >= 5000, "imported actors get fresh ids");
      assert.equal(actor.partition_id, null, "imported actors belong to no partition until redeployed");
      assert.equal(actor.state, source.state);
      assert.equal(actor.class, source.class);
      assert.equal(actor.transform, source.transform, "actor location and rotation are exact");
    }
    const newIds = Object.fromEntries(newActors.map((a) => [a.class, Number(a.id)]));
    const newTotem = newIds.BP_Totem_Small_C;
    const newBuilding = newIds.BP_DuneBuildingBase_C;
    const newChest = newIds.BP_StorageContainer_C;

    // Building pieces: identical values AND the game's 0-based bounds.
    const pieces = await pool.query(`
      select n.instance_id, array_lower(n.transform, 1) as lower, n.transform = s.transform as same,
             n.last_placed_by_player_id, n.owner_entity_id
      from dune.building_instances n
      join dune.building_instances s on s.building_id = $2 and s.instance_id = n.instance_id
      where n.building_id = $1 order by n.instance_id`, [newBuilding, SOURCE.building]);
    assert.equal(pieces.rows.length, 3);
    for (const piece of pieces.rows) {
      assert.equal(piece.lower, 0, "building piece transform must stay 0-based");
      assert.equal(piece.same, true, "building piece transform values are exact");
    }
    assert.deepEqual(pieces.rows.map((p) => Number(p.last_placed_by_player_id)), [TARGET.controller, TARGET.controller, 0]);
    const totemEntity = (await pool.query(
      "select entity_id from dune.actor_fgl_entities where actor_id = $1 and slot_name = 'Actor'", [newTotem])).rows[0].entity_id;
    for (const piece of pieces.rows) assert.equal(String(piece.owner_entity_id), String(totemEntity));

    const totem = (await pool.query(`
      select array_lower(n.landclaim_original_global_location, 1) as lower,
             n.landclaim_original_global_location = s.landclaim_original_global_location as same,
             float4send(n.landclaim_original_global_yaw_rotation) = float4send(s.landclaim_original_global_yaw_rotation) as yaw_exact
      from dune.totems n, dune.totems s where n.id = $1 and s.id = $2`, [newTotem, SOURCE.totem])).rows[0];
    assert.deepEqual(totem, { lower: 0, same: true, yaw_exact: true });
    assert.equal((await pool.query("select count(*)::int as n from dune.landclaim_segments where totem_id = $1", [newTotem])).rows[0].n, 2);

    // Embedded references follow the new ids; "!!act#0" stays a null reference.
    const chestEntity = (await pool.query(`
      select f.components from dune.fgl_entities f join dune.actor_fgl_entities a on a.entity_id = f.entity_id
      where a.actor_id = $1`, [newChest])).rows[0].components;
    assert.equal(chestEntity.FPlaceableComponent[1].m_Chest, `!!act#${newChest}`);
    assert.equal(chestEntity.FPlaceableComponent[1].m_None, "!!act#0");

    // Storage: items, the 64-bit stat exact, sinkchart and stored blueprint.
    const items = await pool.query(`
      select it.id, it.template_id, it.stats ->> 'Big' as big, it.stats ->> 'Ref' as ref
      from dune.items it join dune.inventories inv on inv.id = it.inventory_id
      where inv.actor_id = $1 order by it.position_index`, [newChest]);
    assert.equal(items.rows.length, 2);
    assert.equal(items.rows[0].big, BIG_INT_TEXT, "64-bit item stat must be exact after import");
    assert.equal(items.rows[0].ref, `!!act#${newChest}`);
    const creator = (await pool.query("select stats #>> '{FSinkchartsStats,1,CreatorPlayerId}' as v from dune.items where id = $1", [items.rows[0].id])).rows[0].v;
    assert.equal(creator, "!!act#0", "a reference that stayed on the source server becomes a null reference");
    const sinkchart = (await pool.query(`
      select array_lower(n.marker_hash_ids, 1) as lower, n.marker_hash_ids = s.marker_hash_ids as same
      from dune.sinkcharts n, dune.sinkcharts s where n.item_id = $1 and s.item_id = 800`, [items.rows[0].id])).rows[0];
    assert.deepEqual(sinkchart, { lower: 0, same: true });
    const blueprint = (await pool.query("select * from dune.building_blueprints where item_id = $1", [items.rows[1].id])).rows[0];
    assert.equal(blueprint.player_id, null);
    // Each row keeps its own bounds, even where one blueprint mixes them.
    const blueprintArrays = (await pool.query(`
      select (select array_agg(array_lower(transform, 1) order by instance_id) from dune.building_blueprint_instances where building_blueprint_id = $1) as inst_lowers,
             (select array_lower(scale, 1) from dune.building_blueprint_pentashields where building_blueprint_id = $1) as scale_lower,
             (select pg_typeof(scale)::text from dune.building_blueprint_pentashields where building_blueprint_id = $1) as scale_type`,
      [blueprint.id])).rows[0];
    assert.deepEqual(blueprintArrays, { inst_lowers: [0, 1], scale_lower: 0, scale_type: "smallint[]" });

    // Raw player ids point at the receiving player.
    const chestPermission = (await pool.query("select * from dune.permission_actor where actor_id = $1", [newChest])).rows[0];
    assert.equal(Number(chestPermission.edited_by_player_id), TARGET.controller);
    const placeables = await pool.query("select last_placed_by_player_id from dune.placeables where id = any($1::bigint[])", [[newTotem, newChest]]);
    for (const row of placeables.rows) assert.equal(Number(row.last_placed_by_player_id), TARGET.controller);

    // The source backup is untouched.
    assert.equal((await linkedActors(pool, SOURCE.backup)).length, 3);
    assert.equal(Number((await pool.query("select player_id from dune.base_backups where id = 1")).rows[0].player_id), SOURCE.controller);
  });
});

// The game's rewrite points .stats.FBuildingBlueprintItemStats.*.BlueprintNameLastEditedByPlayerId
// at "the exporting player" when the id is not in the export. Here: a deleted
// character's leftover controller (no player_state), and the owner's own rename.
const RENAMED_BY = ["FBuildingBlueprintItemStats", "1", "BlueprintNameLastEditedByPlayerId"];
async function renameStoredBlueprint(pool, itemId, controllerId) {
  await pool.query(`update dune.items set stats = jsonb_set(stats, $2::text[], to_jsonb($3::text)) where id = $1`,
    [itemId, RENAMED_BY, `!!act#${controllerId}`]);
}

for (const [who, controller] of [["a player outside the base", 30], ["the owner", SOURCE.controller]]) {
  test(`real PostgreSQL: a stored blueprint last renamed by ${who} exports and imports as the receiving player's`, async (t) => {
    await withDatabase(t, async (pool, db) => {
      await pool.query("insert into dune.actors (id, class) values (30, 'BP_DunePlayerController_C')");
      await renameStoredBlueprint(pool, 801, controller);

      const text = await exportText(db);
      const file = JSON.parse(text);
      const stored = file.entries.find((e) => e.kind === "itm" && e.data.template_id === "BuildingBlueprint_CopyDevice");
      assert.equal(stored.data.stats.FBuildingBlueprintItemStats[1].BlueprintNameLastEditedByPlayerId,
        `!!act@${file.ownerPlaceholderTransferId}`, "the reference points at the owner placeholder");
      assert.equal(file.entries.some((e) => e.kind === "Character"), false, "the helper entry is never shipped");

      const result = await importBaseBackup(db, TARGET.pawn, text, { serverBuild: "2036754" });
      const renamedBy = (await pool.query(`
        select it.stats #>> $2::text[] as v
        from dune.items it
        join dune.inventories inv on inv.id = it.inventory_id
        join dune.base_backup_linked_actors l on l.actor_id = inv.actor_id
        where l.id = $1 and it.template_id = 'BuildingBlueprint_CopyDevice'`, [result.backupId, RENAMED_BY])).rows[0].v;
      assert.equal(renamedBy, `!!act#${TARGET.controller}`);
    });
  });
}

test("real PostgreSQL: a live base holding a blueprint renamed by a player outside the base exports", async (t) => {
  await withDatabase(t, async (pool, db) => {
    await pool.query("insert into dune.actors (id, class) values (30, 'BP_DunePlayerController_C')");
    await pool.query(`update dune.items set stats = stats || '{"FBuildingBlueprintItemStats": [[], {"BlueprintNameLastEditedByPlayerId": "!!act#30"}]}' where id = 810`);
    const { text } = await exportLiveBase(db, LIVE.building, { gameBuild: "2036754", consoleVersion: "test" });
    const file = JSON.parse(text);
    const item = file.entries.find((e) => e.kind === "itm" && e.data.template_id === "Water_Item");
    assert.equal(item.data.stats.FBuildingBlueprintItemStats[1].BlueprintNameLastEditedByPlayerId, `!!act@${file.ownerPlaceholderTransferId}`);
    assert.equal(file.entries.some((e) => e.kind === "Character"), false);
  });
});

test("real PostgreSQL: the owner fallback does not allow unrelated outside-player references", async (t) => {
  await withDatabase(t, async (pool, db) => {
    await pool.query("insert into dune.actors (id, class) values (30, 'BP_DunePlayerController_C')");
    await pool.query(`update dune.items set stats = stats || '{"UnreviewedPlayerReference":"!!act#30"}' where id = 801`);
    await assert.rejects(exportText(db), /was not exported/);
  });
});

test("real PostgreSQL: importing the same file twice creates two independent backups", async (t) => {
  await withDatabase(t, async (pool, db) => {
    const text = await exportText(db);
    const first = await importBaseBackup(db, TARGET.pawn, text, { serverBuild: "2036754" });
    const second = await importBaseBackup(db, TARGET.pawn, text, { serverBuild: "2036754" });
    assert.notEqual(first.backupId, second.backupId);
    const firstIds = (await linkedActors(pool, first.backupId)).map((a) => a.id);
    const secondIds = (await linkedActors(pool, second.backupId)).map((a) => a.id);
    assert.equal(firstIds.filter((id) => secondIds.includes(id)).length, 0);
    await pool.query("delete from dune.base_backups where id = $1", [first.backupId]);
    assert.equal((await linkedActors(pool, second.backupId)).length, 3);
  });
});

test("real PostgreSQL: an import that hits the statement timeout reports the step and rolls back", async (t) => {
  await withDatabase(t, async (pool, db) => {
    const text = await exportText(db);
    await pool.query(`
      alter function dune._character_transfer_data_table_load(jsonb) rename to _stub_load_real;
      create function dune._character_transfer_data_table_load(entries jsonb) returns void language plpgsql as $$
      begin perform pg_sleep(2); perform dune._stub_load_real(entries); end $$;`);
    const before = (await pool.query("select (select count(*) from dune.base_backups)::int as backups, (select count(*) from dune.actors)::int as actors")).rows[0];
    const previous = process.env.ADMIN_BASE_BACKUP_STATEMENT_TIMEOUT_MS;
    process.env.ADMIN_BASE_BACKUP_STATEMENT_TIMEOUT_MS = "200";
    try {
      await assert.rejects(
        importBaseBackup(db, TARGET.pawn, text, { serverBuild: "2036754" }),
        (error) => {
          assert.ok(error instanceof BaseBackupTimeoutError);
          assert.equal(error.statusCode, 503);
          assert.equal(error.code, "timeout");
          assert.equal(error.details.operation, "import");
          assert.equal(error.details.step, "loading the file");
          assert.equal(error.details.timeoutKind, "server_timeout");
          assert.equal(error.details.limitMs, 200);
          assert.match(error.message, /timed out after .* while loading the file \(limit 200ms\)\. Nothing was changed/);
          return true;
        });
    } finally {
      if (previous === undefined) delete process.env.ADMIN_BASE_BACKUP_STATEMENT_TIMEOUT_MS;
      else process.env.ADMIN_BASE_BACKUP_STATEMENT_TIMEOUT_MS = previous;
    }
    const after = (await pool.query("select (select count(*) from dune.base_backups)::int as backups, (select count(*) from dune.actors)::int as actors")).rows[0];
    assert.deepEqual(after, before);
  });
});

test("real PostgreSQL: a file from another game version is refused unless the override is set", async (t) => {
  await withDatabase(t, async (pool, db) => {
    const text = (await exportText(db)).replace(/"patchesChecksum": "[0-9a-f]+"/, '"patchesChecksum": "0000"');
    await assert.rejects(importBaseBackup(db, TARGET.pawn, text, { serverBuild: "2036754" }), (error) => {
      assert.ok(error instanceof BaseBackupError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "version_mismatch");
      assert.equal(error.details.file.patchesChecksum, "0000");
      return true;
    });
    assert.equal((await pool.query("select count(*)::int as n from dune.base_backups")).rows[0].n, 1);
    const result = await importBaseBackup(db, TARGET.pawn, text, { allowVersionMismatch: true, serverBuild: "2036754" });
    assert.equal(result.version.mismatch, true);
    assert.match(result.warning, /version mismatch/);
  });
});

test("real PostgreSQL: an imported base never lands in a map partition, whatever the file says", async (t) => {
  await withDatabase(t, async (pool, db) => {
    const file = JSON.parse(await exportText(db));
    for (const entry of file.entries) {
      if (entry.kind === "act" && entry.id !== file.ownerPlaceholderTransferId) {
        entry.data.partition_id = 12345;
        entry.data.state = "Default";
      }
    }
    const result = await importBaseBackup(db, TARGET.pawn, JSON.stringify(file), { serverBuild: "2036754" });
    const actors = await pool.query(`
      select a.partition_id, a.state from dune.actors a
      join dune.base_backup_linked_actors l on l.actor_id = a.id where l.id = $1`, [result.backupId]);
    assert.equal(actors.rows.length, 3);
    for (const actor of actors.rows) assert.deepEqual(actor, { partition_id: null, state: "BaseBackup" });
  });
});

test("real PostgreSQL: a file that hangs rows off the receiving player is refused before anything is written", async (t) => {
  await withDatabase(t, async (pool, db) => {
    const file = JSON.parse(await exportText(db));
    file.entries.find((entry) => entry.kind === "inv").data.actor_id = file.ownerPlaceholderTransferId;
    const before = (await pool.query("select (select count(*) from dune.inventories)::int as inv, (select count(*) from dune.base_backups)::int as bb")).rows[0];
    await assert.rejects(importBaseBackup(db, TARGET.pawn, JSON.stringify(file), { serverBuild: "2036754" }), (error) => {
      assert.ok(error instanceof BaseBackupError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "invalid_file");
      assert.match(error.message, /inv \d+ actor_id at the receiving player/);
      return true;
    });
    const after = (await pool.query("select (select count(*) from dune.inventories)::int as inv, (select count(*) from dune.base_backups)::int as bb")).rows[0];
    assert.deepEqual(after, before);
  });
});

test("real PostgreSQL: a backup can be reassigned and renamed while its owner is offline", async (t) => {
  await withDatabase(t, async (pool, db) => {
    const result = await updateBaseBackup(db, SOURCE.backup, { ownerPlayerId: TARGET.pawn, name: "  Moved Base  " });
    assert.deepEqual(result.owner, { from: SOURCE.controller, fromName: "Owner", to: TARGET.controller });
    assert.deepEqual(result.name, { from: "Test Base", to: "Moved Base" });
    const row = (await pool.query("select player_id, base_backup_name, last_edited_by_player_id from dune.base_backups where id = $1", [SOURCE.backup])).rows[0];
    assert.deepEqual(
      { player: Number(row.player_id), name: row.base_backup_name, edited: Number(row.last_edited_by_player_id) },
      { player: TARGET.controller, name: "Moved Base", edited: TARGET.controller });
    // The base itself is untouched: same linked actors, still backed up.
    assert.equal((await linkedActors(pool, SOURCE.backup)).length, 3);

    // A rename alone leaves the owner (and last-edited) as they are.
    await updateBaseBackup(db, SOURCE.backup, { name: "Renamed Again" });
    const renamed = (await pool.query("select player_id, base_backup_name from dune.base_backups where id = $1", [SOURCE.backup])).rows[0];
    assert.deepEqual({ player: Number(renamed.player_id), name: renamed.base_backup_name }, { player: TARGET.controller, name: "Renamed Again" });
  });
});

test("real PostgreSQL: editing is refused while the current owner is online, and nothing changes", async (t) => {
  await withDatabase(t, async (pool, db) => {
    await pool.query("update dune.player_state set online_status = 'Online' where player_controller_id = $1", [SOURCE.controller]);
    await assert.rejects(updateBaseBackup(db, SOURCE.backup, { ownerPlayerId: TARGET.pawn, name: "Nope" }), (error) => {
      assert.ok(error instanceof BaseBackupError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "owner_online");
      return true;
    });
    const row = (await pool.query("select player_id, base_backup_name from dune.base_backups where id = $1", [SOURCE.backup])).rows[0];
    assert.deepEqual({ player: Number(row.player_id), name: row.base_backup_name }, { player: SOURCE.controller, name: "Test Base" });
  });
});

test("real PostgreSQL: editing a backup that no longer exists is a 404", async (t) => {
  await withDatabase(t, async (pool, db) => {
    await pool.query("delete from dune.base_backups where id = $1", [SOURCE.backup]);
    await assert.rejects(updateBaseBackup(db, SOURCE.backup, { name: "Gone" }), (error) => error.statusCode === 404 && error.code === "not_found");
  });
});

test("real PostgreSQL: a backup can be moved to another map where bases are built", async (t) => {
  await withDatabase(t, async (pool, db) => {
    const { listBaseBackups } = await import("../src/baseBackups.js");
    assert.deepEqual((await listBaseBackups(db)).maps, ["DeepDesert", "HaggaBasin"]);

    await assert.rejects(updateBaseBackup(db, SOURCE.backup, { map: "Arrakeen" }), (error) => error.code === "invalid_map");

    const result = await updateBaseBackup(db, SOURCE.backup, { map: "HaggaBasin" });
    assert.deepEqual(result.map, { from: "DeepDesert", to: "HaggaBasin", actors: 3 });
    const actors = await pool.query(`
      select a.map, a.partition_id, a.state from dune.actors a
      join dune.base_backup_linked_actors l on l.actor_id = a.id where l.id = $1`, [SOURCE.backup]);
    assert.equal(actors.rows.length, 3);
    for (const actor of actors.rows) assert.deepEqual(actor, { map: "HaggaBasin", partition_id: null, state: "BaseBackup" });
    // Only the backup's own actors moved: the live claim keeps its map and partition.
    const other = (await pool.query("select map, partition_id from dune.actors where id = 998")).rows[0];
    assert.deepEqual({ map: other.map, partition: Number(other.partition_id) }, { map: "HaggaBasin", partition: 7 });
    const listed = (await listBaseBackups(db)).rows.find((row) => row.id === SOURCE.backup);
    assert.equal(listed.map, "HaggaBasin");
  });
});

test("real PostgreSQL: deleting a backup removes the base and everything stored in it, nothing else", async (t) => {
  await withDatabase(t, async (pool, db) => {
    const result = await deleteBaseBackup(db, SOURCE.backup);
    assert.deepEqual(result.counts, { pieces: 3, placeables: 2, items: 2 });
    assert.equal(result.name, "Test Base");
    const left = (await pool.query(`
      select (select count(*) from dune.base_backups where id = $1)::int as backups,
             (select count(*) from dune.actors where id = any($2::bigint[]))::int as actors,
             (select count(*) from dune.building_instances where building_id = $3)::int as pieces,
             (select count(*) from dune.items where id in (800, 801))::int as items,
             (select count(*) from dune.inventories where id = 900)::int as inventories,
             (select count(*) from dune.sinkcharts)::int as sinkcharts,
             (select count(*) from dune.building_blueprints where id = 300)::int as blueprints,
             (select count(*) from dune.landclaim_segments where totem_id = $4)::int as segments`,
      [SOURCE.backup, [SOURCE.totem, SOURCE.building, SOURCE.chest], SOURCE.building, SOURCE.totem])).rows[0];
    assert.deepEqual(left, { backups: 0, actors: 0, pieces: 0, items: 0, inventories: 0, sinkcharts: 0, blueprints: 0, segments: 0 });
    // Players, the live claim and unrelated actors are untouched.
    const kept = (await pool.query("select count(*)::int as n from dune.actors where id in (10, 11, 20, 21, 998, 999)")).rows[0].n;
    assert.equal(kept, 6);
  });
});

test("real PostgreSQL: a backup is not deleted while its owner is online", async (t) => {
  await withDatabase(t, async (pool, db) => {
    await pool.query("update dune.player_state set online_status = 'Online' where player_controller_id = $1", [SOURCE.controller]);
    await assert.rejects(deleteBaseBackup(db, SOURCE.backup), (error) => error.code === "owner_online");
    assert.equal((await linkedActors(pool, SOURCE.backup)).length, 3);
  });
});

test("real PostgreSQL: deleting the original leaves an imported copy intact", async (t) => {
  await withDatabase(t, async (pool, db) => {
    const copy = await importBaseBackup(db, TARGET.pawn, await exportText(db), { serverBuild: "2036754" });
    await deleteBaseBackup(db, SOURCE.backup);
    assert.equal((await linkedActors(pool, copy.backupId)).length, 3);
    const items = (await pool.query(`
      select count(*)::int as n from dune.items it join dune.inventories inv on inv.id = it.inventory_id
      join dune.base_backup_linked_actors l on l.actor_id = inv.actor_id where l.id = $1`, [copy.backupId])).rows[0].n;
    assert.equal(items, 2);
  });
});

// Every row of every table an export reads, so "read-only" is checked, not assumed.
async function databaseFingerprint(pool) {
  const tables = ["actors", "fgl_entities", "actor_fgl_entities", "permission_actor", "permission_actor_rank", "inventories",
    "items", "actor_inventories", "buildings", "building_instances", "placeables", "totems", "base_backups",
    "base_backup_linked_actors", "landclaim_segments", "tax_invoice", "sinkcharts", "building_blueprints"];
  const parts = [];
  for (const table of tables) {
    parts.push((await pool.query(`select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from dune.${table} x`)).rows[0].h);
  }
  return parts.join(" ");
}

test("real PostgreSQL: a live base exports as the backup a pickup would make, and changes nothing", async (t) => {
  await withDatabase(t, async (pool, db) => {
    const before = await databaseFingerprint(pool);
    const { text, summary } = await exportLiveBase(db, LIVE.building, { gameBuild: "2036754", consoleVersion: "test" });
    assert.equal(await databaseFingerprint(pool), before, "the live export wrote to the database");
    assert.deepEqual({ name: summary.name, ownerName: summary.ownerName, map: summary.map }, { name: "Live Base", ownerName: "Owner", map: "HaggaBasin" });

    const file = JSON.parse(text);
    assert.deepEqual({ kind: file.source.kind, baseId: file.source.baseId, backupId: file.source.backupId },
      { kind: "live-base", baseId: LIVE.building, backupId: null });
    assert.deepEqual(file.source.counts, { pieces: 2, placeables: 3, items: 1 });
    const kinds = {};
    for (const entry of file.entries) kinds[entry.kind] = (kinds[entry.kind] || 0) + 1;
    // 4 actors + the owner placeholder; the lamp stays behind.
    assert.equal(kinds.act, 5);
    // The totem's two entities and the door's; not the building actor's.
    assert.equal(kinds.fgl, 3);
    // The door's permissions only, and only its rank for the owner.
    assert.equal(kinds.PermissionActor, 1);
    assert.equal(kinds.PermissionActorRank, 1);
    assert.equal(kinds.TaxInvoice, undefined);
    assert.equal(kinds.BaseBackup, 1);
    assert.equal(kinds.BaseBackupLinkedActor, 4);
    const record = file.entries.find((entry) => entry.kind === "BaseBackup").data;
    assert.deepEqual(record, { player_id: file.ownerPlaceholderTransferId, base_backup_name: "Live Base", last_edited_by_player_id: 0 });
    const building = file.entries.find((entry) => entry.kind === "act" && entry.data.class === "BP_DuneBuildingBase_C").data;
    assert.deepEqual({ properties: building.properties, gas: building.gas_attributes, serial: building.serial },
      { properties: {}, gas: {}, serial: 0 });
    // Every actor in the state a pickup leaves it in.
    const states = file.entries.filter((entry) => entry.kind === "act" && entry.id !== file.ownerPlaceholderTransferId).map((entry) => entry.data.state);
    assert.deepEqual([...new Set(states)], ["BaseBackup"]);

    const imported = await importBaseBackup(db, TARGET.pawn, text, { serverBuild: "2036754" });
    const listed = (await listBaseBackups(db, { playerId: TARGET.pawn })).rows.find((row) => row.id === imported.backupId);
    assert.deepEqual({ name: listed.name, map: listed.map, pieces: listed.pieces, placeables: listed.placeables, items: listed.items },
      { name: "Live Base", map: "HaggaBasin", pieces: 2, placeables: 3, items: 1 });
    const actors = await linkedActors(pool, imported.backupId);
    assert.deepEqual(actors.map((actor) => actor.class).sort(), ["BP_Door_C", "BP_DuneBuildingBase_C", "BP_StorageContainer_C", "BP_Totem_Small_C"]);
    for (const actor of actors) assert.deepEqual({ partition: actor.partition_id, state: actor.state }, { partition: null, state: "BaseBackup" });
    // The totem's 0-based land claim location survives, as for a backup.
    const location = (await pool.query(`
      select array_lower(t.landclaim_original_global_location, 1) as lb from dune.totems t
      join dune.base_backup_linked_actors l on l.actor_id = t.id where l.id = $1`, [imported.backupId])).rows[0].lb;
    assert.equal(location, 0);
  });
});

test("real PostgreSQL: a live base export refuses a picked-up base, an unknown base and an ownerless one", async (t) => {
  await withDatabase(t, async (pool, db) => {
    await assert.rejects(exportLiveBase(db, SOURCE.building), (error) => error.statusCode === 409 && error.code === "picked_up");
    await assert.rejects(exportLiveBase(db, 424242), (error) => error.statusCode === 404);
    // Only a co-owner left: the game's owner is rank 1, so this has none.
    await pool.query("delete from dune.permission_actor_rank where permission_actor_id = $1 and rank = 1", [LIVE.totem]);
    assert.equal((await pool.query("select count(*)::int as n from dune.permission_actor_rank where permission_actor_id = $1", [LIVE.totem])).rows[0].n, 1);
    await assert.rejects(exportLiveBase(db, LIVE.building), (error) => error.statusCode === 409 && error.code === "no_owner");
  });
});
