import test from "node:test";
import assert from "node:assert/strict";
import { vehicleStorage } from "../src/duneDb.js";
import { pgTransactionalDb, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";
import {
  BIG_ITEM_ID,
  CARGO_INVENTORY_ID,
  OTHER_CARGO_INVENTORY_ID,
  OTHER_VEHICLE_ID,
  PLACEABLE_ID,
  SCHEMA,
  SEED,
  VEHICLE_ID
} from "../test-support/vehicleStorageFixture.js";

// Real PostgreSQL rather than a mocked db, because the question this feature
// turns on is a data question, not a string question: which link between a
// vehicle and an inventory is actually populated. A mock that returns whatever
// rows the test hands it can prove the fold, but it cannot prove the join --
// and the join is the part the schema's own documentation had wrong.
//
// The schema and seed live in test-support/vehicleStorageFixture.js, shared
// with vehicleStorageDelete.integration.test.js so the read and the write can
// never disagree about the shape they exercise.

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
    assert.equal(result.usedSlots, 4);

    const templates = result.slots.map((slot) => slot.templateId).sort();
    assert.deepEqual(templates, ["BigIdStone", "JasmiumCrystal", "JasmiumCrystal", "Mk5Cutteray"]);
    // The three ways this could have gone wrong, each named.
    assert.ok(!templates.includes("ComponentHoldDecoy"), "a component hold leaked into the cargo contents");
    assert.ok(!templates.includes("OtherVehicleSpice"), "another vehicle's hold leaked in");
    assert.ok(!templates.includes("PlaceableScrapMetal"), "a placeable's container leaked in");
  });
});

test("real PostgreSQL: vehicleStorage orders slots by position and keeps duplicate templates apart", async (t) => {
  await withDatabase(t, async (pool) => {
    const result = await vehicleStorage(pgTransactionalDb(pool), VEHICLE_ID);

    assert.deepEqual(result.slots.map((slot) => slot.positionIndex), [2, 5, 7, 9]);
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
    // 162*1.5 + 40*1.5 + 1*12 + 3*0 = 243 + 60 + 12 + 0.
    assert.equal(result.currentVolume, 315);
    assert.equal(result.volumeComplete, true);
  });
});

test("real PostgreSQL: vehicleStorage surfaces a bigint item id exactly, not rounded", async (t) => {
  await withDatabase(t, async (pool) => {
    const result = await vehicleStorage(pgTransactionalDb(pool), VEHICLE_ID);
    const big = result.slots.find((slot) => slot.templateId === "BigIdStone");
    // Number()-ing this id rounds it to a different value; the read has to
    // hand the UI the exact string the delete route will be given back.
    assert.equal(big.itemId, BIG_ITEM_ID);
    assert.notEqual(String(Number(BIG_ITEM_ID)), BIG_ITEM_ID);
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
