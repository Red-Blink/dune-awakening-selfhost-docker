import test from "node:test";
import assert from "node:assert/strict";
import { vehicleStorage } from "../src/duneDb.js";
import { pgTransactionalDb, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

// Real PostgreSQL rather than a mocked db, because the question this feature
// turns on is a data question, not a string question: which link between a
// vehicle and an inventory is actually populated. A mock that returns
// whatever rows the test hands it can prove the fold, but it cannot prove the
// join -- and the join is the part that was wrong in the schema's own
// documentation.
//
// The schema below is transcribed from a real production dump
// (.claude/dune_backup.sql), constraints included, not invented:
//   inventories                                      (line 19703)
//     CHECK valid_fkey: actor_id | exchange_id | item_id | vehicle_module_id  (19713)
//     CHECK inventories_id_check: id > 0                                      (19712)
//   items                                            (line 19783)
//     CHECK items_stack_size_check: stack_size > 0                            (19795)
//     CHECK items_position_index_check: position_index >= 0                   (19794)
//     position_index and stats are NOT NULL                                   (19787, 19791)
//   inventories.actor_id -> actors.id       ON DELETE CASCADE   (line 75804)
//   items.inventory_id -> inventories.id    ON DELETE CASCADE   (line 75844)
//   vehicles.id -> actors.id                ON DELETE CASCADE   (line 76467)
//   vehicle_modules.vehicle_id -> vehicles.id  ON DELETE CASCADE (line 76459)
//   inventories.vehicle_module_id -> vehicle_modules.id CASCADE (line 75828)
//
// The NOT NULL on items.position_index is why this file exists rather than
// only the mocked cases: a hand-written schema that let it be null would make
// the "unplaced slot" path look reachable when production cannot produce it.

const VEHICLE_ID = 9401;
const OTHER_VEHICLE_ID = 9402;
const PLACEABLE_ID = 9403;
const MODULE_ID = 9404;

const CARGO_INVENTORY_ID = 8401;
const OTHER_CARGO_INVENTORY_ID = 8402;
const PLACEABLE_INVENTORY_ID = 8403;
// The per-component holds that share the vehicle actor. Real dumps carry two
// or three of these per vehicle with inventory_type NULL and no capacity --
// they are what the inventory_type = 0 filter exists to exclude.
const COMPONENT_INVENTORY_IDS = [8404, 8405];

const SCHEMA = `
  create schema dune;

  create table dune.actors (id bigint primary key, map text, partition_id bigint);
  create table dune.vehicles (id bigint primary key references dune.actors(id) on delete cascade);
  create table dune.placeables (id bigint primary key references dune.actors(id) on delete cascade);
  create table dune.vehicle_modules (
    id bigint primary key,
    vehicle_id bigint not null references dune.vehicles(id) on delete cascade,
    template_id text not null
  );
  create table dune.inventories (
    id bigint primary key,
    actor_id bigint references dune.actors(id) on delete cascade,
    exchange_id bigint,
    item_id bigint,
    vehicle_module_id bigint references dune.vehicle_modules(id) on delete cascade,
    inventory_type integer,
    max_item_count integer,
    max_item_volume real,
    constraint inventories_id_check check (id > 0),
    constraint valid_fkey check (
      actor_id is not null or exchange_id is not null or item_id is not null or vehicle_module_id is not null
    )
  );
  create table dune.items (
    id bigint primary key,
    inventory_id bigint references dune.inventories(id) on delete cascade,
    stack_size bigint not null,
    position_index bigint not null,
    template_id text not null,
    is_new boolean default true,
    acquisition_time bigint default 0 not null,
    stats jsonb not null,
    quality_level bigint default 0 not null,
    volume_override real,
    constraint items_position_index_check check (position_index >= 0),
    constraint items_stack_size_check check (stack_size > 0)
  );
`;

const SEED = `
  insert into dune.actors (id, map, partition_id) values
    (${VEHICLE_ID}, 'HaggaBasin', 1),
    (${OTHER_VEHICLE_ID}, 'HaggaBasin', 1),
    (${PLACEABLE_ID}, 'HaggaBasin', 1);
  insert into dune.vehicles (id) values (${VEHICLE_ID}), (${OTHER_VEHICLE_ID});
  insert into dune.placeables (id) values (${PLACEABLE_ID});
  insert into dune.vehicle_modules (id, vehicle_id, template_id)
    values (${MODULE_ID}, ${VEHICLE_ID}, 'BuggyInventory_4');

  -- The cargo hold. inventory_type = 0, capacity matching the fitted
  -- BuggyInventory_4 (20 / 2000), reached through actor_id.
  insert into dune.inventories (id, actor_id, inventory_type, max_item_count, max_item_volume)
    values (${CARGO_INVENTORY_ID}, ${VEHICLE_ID}, 0, 20, 2000);
  -- The decoys: same actor, no inventory_type, no capacity. A query that
  -- dropped the inventory_type filter would pick one of these roughly at
  -- random and report an empty hold.
  insert into dune.inventories (id, actor_id, inventory_type, max_item_count, max_item_volume)
    values (${COMPONENT_INVENTORY_IDS[0]}, ${VEHICLE_ID}, null, null, null),
           (${COMPONENT_INVENTORY_IDS[1]}, ${VEHICLE_ID}, null, null, null);
  -- A second vehicle's hold, to prove no cross-leak.
  insert into dune.inventories (id, actor_id, inventory_type, max_item_count, max_item_volume)
    values (${OTHER_CARGO_INVENTORY_ID}, ${OTHER_VEHICLE_ID}, 0, 10, 250);
  -- A placeable's storage container, on the same shape of link. A query that
  -- read dune.inventories by actor_id without joining dune.vehicles would
  -- serve this through a vehicles-scoped route.
  insert into dune.inventories (id, actor_id, inventory_type, max_item_count, max_item_volume)
    values (${PLACEABLE_INVENTORY_ID}, ${PLACEABLE_ID}, 0, 45, 500);

  insert into dune.items (id, inventory_id, stack_size, position_index, template_id, stats, quality_level, volume_override) values
    (7001, ${CARGO_INVENTORY_ID}, 162, 5, 'JasmiumCrystal', '{}'::jsonb, 0, 1.5),
    -- Same template as above in a different slot: the per-slot view exists so
    -- these stay two rows rather than one merged 202.
    (7002, ${CARGO_INVENTORY_ID}, 40, 2, 'JasmiumCrystal', '{}'::jsonb, 0, 1.5),
    (7003, ${CARGO_INVENTORY_ID}, 1, 7, 'Mk5Cutteray',
      '{"FItemStackAndDurabilityStats":[null,{"CurrentDurability":"300","MaxDurability":"600"}],
        "FAugmentedItemStats":[null,{"AppliedAugments":[{"Name":"T6_Augment_UnitTestFixture1"}],"AppliedAugmentQualities":[3]}]}'::jsonb,
      4, 12),
    -- Items in the decoy component holds and in the other vehicle's hold:
    -- neither may appear in this vehicle's contents.
    (7004, ${COMPONENT_INVENTORY_IDS[0]}, 99, 0, 'ComponentHoldDecoy', '{}'::jsonb, 0, null),
    (7005, ${OTHER_CARGO_INVENTORY_ID}, 7, 0, 'OtherVehicleSpice', '{}'::jsonb, 0, null),
    (7006, ${PLACEABLE_INVENTORY_ID}, 500, 0, 'PlaceableScrapMetal', '{}'::jsonb, 0, null);
`;

async function withDatabase(t, run) {
  return withIsolatedDatabase(t, {
    namePrefix: "dune_vehicle_storage",
    unavailableLabel: "the vehicle storage integration test"
  }, async (pool) => {
    await pool.query(SCHEMA);
    await pool.query(SEED);
    return run(pool);
  });
}

test("real PostgreSQL: vehicleStorage reads the cargo hold and only the cargo hold", async (t) => {
  await withDatabase(t, async (pool) => {
    const result = await vehicleStorage(pgTransactionalDb(pool), VEHICLE_ID);

    assert.equal(result.supported, true);
    assert.equal(result.found, true);
    assert.equal(result.vehicleId, String(VEHICLE_ID));
    assert.equal(result.inventoryId, String(CARGO_INVENTORY_ID));
    assert.equal(result.maxSlots, 20);
    assert.equal(result.maxVolume, 2000);
    assert.equal(result.usedSlots, 3);

    const templates = result.slots.map((slot) => slot.templateId).sort();
    assert.deepEqual(templates, ["JasmiumCrystal", "JasmiumCrystal", "Mk5Cutteray"]);
    // The three ways this could have gone wrong, each named.
    assert.ok(!templates.includes("ComponentHoldDecoy"), "a component hold leaked into the cargo contents");
    assert.ok(!templates.includes("OtherVehicleSpice"), "another vehicle's hold leaked in");
    assert.ok(!templates.includes("PlaceableScrapMetal"), "a placeable's container leaked in");
  });
});

test("real PostgreSQL: vehicleStorage orders slots by position and keeps duplicate templates apart", async (t) => {
  await withDatabase(t, async (pool) => {
    const result = await vehicleStorage(pgTransactionalDb(pool), VEHICLE_ID);

    assert.deepEqual(result.slots.map((slot) => slot.positionIndex), [2, 5, 7]);
    const jasmium = result.slots.filter((slot) => slot.templateId === "JasmiumCrystal");
    assert.deepEqual(jasmium.map((slot) => slot.quantity), [40, 162]);
    assert.deepEqual(jasmium.map((slot) => slot.itemId), ["7002", "7001"]);
  });
});

test("real PostgreSQL: vehicleStorage reads durability, grade and augments out of stats", async (t) => {
  await withDatabase(t, async (pool) => {
    const result = await vehicleStorage(pgTransactionalDb(pool), VEHICLE_ID);
    const cutteray = result.slots.find((slot) => slot.templateId === "Mk5Cutteray");

    assert.equal(cutteray.qualityLevel, 4);
    assert.equal(cutteray.currentDurability, 300);
    assert.equal(cutteray.maxDurability, 600);
    assert.deepEqual(cutteray.augments.map((augment) => augment.templateId), ["T6_Augment_UnitTestFixture1"]);
    assert.deepEqual(cutteray.augments.map((augment) => augment.qualityLevel), [3]);
  });
});

test("real PostgreSQL: vehicleStorage totals per-unit volume across the stack", async (t) => {
  await withDatabase(t, async (pool) => {
    const result = await vehicleStorage(pgTransactionalDb(pool), VEHICLE_ID);
    // 162*1.5 + 40*1.5 + 1*12 = 243 + 60 + 12.
    assert.equal(result.currentVolume, 315);
    assert.equal(result.volumeComplete, true);
  });
});

test("real PostgreSQL: vehicleStorage answers found:false for a placeable's actor id", async (t) => {
  await withDatabase(t, async (pool) => {
    // The placeable really does own an inventory_type = 0 inventory holding
    // items -- this is the case the join through dune.vehicles exists for.
    const result = await vehicleStorage(pgTransactionalDb(pool), PLACEABLE_ID);
    assert.equal(result.supported, true);
    assert.equal(result.found, false);
    assert.deepEqual(result.slots, []);
  });
});

test("real PostgreSQL: vehicleStorage answers found:false for an id that does not exist", async (t) => {
  await withDatabase(t, async (pool) => {
    const result = await vehicleStorage(pgTransactionalDb(pool), 999999);
    assert.equal(result.found, false);
  });
});

test("real PostgreSQL: vehicleStorage returns an empty hold rather than found:false", async (t) => {
  await withDatabase(t, async (pool) => {
    // OTHER_VEHICLE_ID's hold minus its one item: the LEFT JOIN's all-null row
    // must still produce a found hold with its capacity, so the overlay can
    // draw 10 empty cells instead of claiming the vehicle has no hold.
    await pool.query("delete from dune.items where inventory_id = $1", [OTHER_CARGO_INVENTORY_ID]);
    const result = await vehicleStorage(pgTransactionalDb(pool), OTHER_VEHICLE_ID);

    assert.equal(result.found, true);
    assert.equal(result.maxSlots, 10);
    assert.equal(result.usedSlots, 0);
    assert.deepEqual(result.slots, []);
  });
});

test("real PostgreSQL: the vehicle_module link this query avoids is the empty one", async (t) => {
  await withDatabase(t, async (pool) => {
    // Production has 0 of 535 inventories linked by vehicle_module_id. This
    // asserts the consequence rather than the count: a hold reached that way
    // does not exist, so a query joining through it would return nothing --
    // which is why duneDb.vehicleStorage joins on actor_id instead.
    const viaModule = await pool.query(`
      select count(*)::int as n
      from dune.vehicle_modules vm
      join dune.inventories inv on inv.vehicle_module_id = vm.id
      where vm.vehicle_id = $1`, [VEHICLE_ID]);
    assert.equal(viaModule.rows[0].n, 0);

    const viaActor = await pool.query(`
      select count(*)::int as n
      from dune.vehicles v
      join dune.inventories inv on inv.actor_id = v.id and inv.inventory_type = 0
      where v.id = $1`, [VEHICLE_ID]);
    assert.equal(viaActor.rows[0].n, 1);
  });
});
