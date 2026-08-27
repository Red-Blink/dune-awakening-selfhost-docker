import test from "node:test";
import assert from "node:assert/strict";
import {
  deleteAllVehicleStorageItems,
  deleteMultipleVehicleStorageItems,
  deleteVehicleStorageItem,
  vehicleStorage,
  vehicleStorageDeleteSafety
} from "../src/duneDb.js";
import { pgTransactionalDb, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";
import {
  BIG_ITEM_ID,
  BLOCKED_CARGO_INVENTORY_ID,
  BLOCKED_VEHICLE_ID,
  CARGO_INVENTORY_ID,
  COMPONENT_INVENTORY_IDS,
  OTHER_CARGO_INVENTORY_ID,
  OTHER_VEHICLE_ID,
  PLACEABLE_ID,
  SCHEMA,
  SEED,
  VEHICLE_ID
} from "../test-support/vehicleStorageFixture.js";

// This is the load-bearing file for vehicle cargo deletion. The base container
// equivalent exists because a SELECT DISTINCT combined with FOR UPDATE -- which
// Postgres rejects outright -- shipped and 500'd every single real invocation,
// undetected by the mocked tests, because the fake db.query pattern-matches
// query text and never parses SQL. resolveVehicleCargoHold reproduces that
// query shape, so it needs the same real-database coverage.

async function withDatabase(t, run) {
  return withIsolatedDatabase(t, {
    namePrefix: "dune_vehicle_storage_delete",
    unavailableLabel: "the vehicle cargo delete integration test"
  }, async (pool) => {
    await pool.query(SCHEMA);
    await pool.query(SEED);
    return run(pool);
  });
}

async function itemIds(pool, inventoryId) {
  const result = await pool.query(
    "select id::text as id from dune.items where inventory_id = $1 order by id", [inventoryId]);
  return result.rows.map((row) => row.id);
}

async function stackSize(pool, itemId) {
  const result = await pool.query("select stack_size from dune.items where id = $1", [itemId]);
  return result.rows[0] ? Number(result.rows[0].stack_size) : null;
}

test("real PostgreSQL: deleting a whole slot removes that row and nothing else", async (t) => {
  await withDatabase(t, async (pool) => {
    const before = await itemIds(pool, CARGO_INVENTORY_ID);
    const result = await deleteVehicleStorageItem(pgTransactionalDb(pool), VEHICLE_ID, "7001");

    assert.equal(result.ok, true);
    assert.equal(result.partial, false);
    assert.equal(result.removed.count, 162);
    assert.equal(result.removed.positionIndex, 5);

    const after = await itemIds(pool, CARGO_INVENTORY_ID);
    assert.equal(after.length, before.length - 1);
    assert.ok(!after.includes("7001"));
    // The sibling stack of the same template survives -- this is the whole
    // point of the per-slot view.
    assert.ok(after.includes("7002"));
  });
});

// The mocked tests cannot prove this: bigintParam keeps the id a decimal
// string, and only a real database round-trip shows that the row it names is
// the row that disappears.
test("real PostgreSQL: a bigint item id beyond Number.MAX_SAFE_INTEGER deletes exactly that row", async (t) => {
  await withDatabase(t, async (pool) => {
    // Number() would round this to 9223372036854775808 -- a row that does not
    // exist, or worse, a different one that does.
    assert.notEqual(String(Number(BIG_ITEM_ID)), BIG_ITEM_ID);
    const result = await deleteVehicleStorageItem(pgTransactionalDb(pool), VEHICLE_ID, BIG_ITEM_ID);

    assert.equal(result.removed.itemId, BIG_ITEM_ID);
    assert.equal(await stackSize(pool, BIG_ITEM_ID), null);
    // Every other stack is untouched.
    assert.deepEqual(await itemIds(pool, CARGO_INVENTORY_ID), ["7001", "7002", "7003"]);
  });
});

test("real PostgreSQL: a partial removal decrements the real stack through the shipped procedure", async (t) => {
  await withDatabase(t, async (pool) => {
    const result = await deleteVehicleStorageItem(pgTransactionalDb(pool), VEHICLE_ID, "7001", { count: 100 });

    assert.equal(result.partial, true);
    assert.equal(result.removed.count, 100);
    assert.equal(result.removed.remaining, 62);
    assert.equal(await stackSize(pool, "7001"), 62);
  });
});

test("real PostgreSQL: a count above the stack is refused and leaves the stack untouched", async (t) => {
  await withDatabase(t, async (pool) => {
    await assert.rejects(
      () => deleteVehicleStorageItem(pgTransactionalDb(pool), VEHICLE_ID, "7001", { count: 500 }),
      /Cannot remove 500: the stack holds 162/
    );
    assert.equal(await stackSize(pool, "7001"), 162);
  });
});

test("real PostgreSQL: another vehicle's cargo cannot be deleted through this vehicle", async (t) => {
  await withDatabase(t, async (pool) => {
    await assert.rejects(
      () => deleteVehicleStorageItem(pgTransactionalDb(pool), VEHICLE_ID, "7005"),
      /not found in this vehicle's cargo hold/
    );
    assert.equal(await stackSize(pool, "7005"), 7);
  });
});

test("real PostgreSQL: a component hold's item cannot be deleted through the cargo route", async (t) => {
  await withDatabase(t, async (pool) => {
    // Same actor, inventory_type IS NULL. Dropping the filter would make this
    // reachable.
    await assert.rejects(
      () => deleteVehicleStorageItem(pgTransactionalDb(pool), VEHICLE_ID, "7004"),
      /not found in this vehicle's cargo hold/
    );
    assert.equal(await stackSize(pool, "7004"), 99);
  });
});

test("real PostgreSQL: a placeable's container is not reachable through a vehicle id", async (t) => {
  await withDatabase(t, async (pool) => {
    // The placeable really does own an inventory_type = 0 inventory holding
    // items -- the join through dune.vehicles is the only thing separating it
    // from a cargo hold.
    await assert.rejects(
      () => deleteAllVehicleStorageItems(pgTransactionalDb(pool), PLACEABLE_ID),
      /no cargo hold/
    );
    assert.equal(await stackSize(pool, "7006"), 500);
  });
});

test("real PostgreSQL: a vehicle in a blocked state refuses every delete and keeps its cargo", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    await assert.rejects(
      () => deleteVehicleStorageItem(db, BLOCKED_VEHICLE_ID, "7007"),
      /currently VehicleRecovery and its cargo cannot be changed/
    );
    await assert.rejects(
      () => deleteMultipleVehicleStorageItems(db, BLOCKED_VEHICLE_ID, ["7007"]),
      /currently VehicleRecovery/
    );
    await assert.rejects(
      () => deleteAllVehicleStorageItems(db, BLOCKED_VEHICLE_ID),
      /currently VehicleRecovery/
    );
    assert.equal(await stackSize(pool, "7007"), 12);
  });
});

test("real PostgreSQL: clearing the blocking state lets the same delete through", async (t) => {
  await withDatabase(t, async (pool) => {
    await pool.query("delete from dune.actor_state where actor_id = $1", [BLOCKED_VEHICLE_ID]);
    const result = await deleteVehicleStorageItem(pgTransactionalDb(pool), BLOCKED_VEHICLE_ID, "7007");
    assert.equal(result.ok, true);
    assert.equal(await stackSize(pool, "7007"), null);
  });
});

test("real PostgreSQL: vehicleStorageDeleteSafety reports the live blocking state", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    const blocked = await vehicleStorageDeleteSafety(db, BLOCKED_VEHICLE_ID);
    assert.equal(blocked.safe, false);
    assert.equal(blocked.state, "VehicleRecovery");

    const ok = await vehicleStorageDeleteSafety(db, VEHICLE_ID);
    assert.equal(ok.safe, true);
    assert.equal(ok.state, "");
  });
});

test("real PostgreSQL: bulk delete removes only the requested rows that exist in the hold", async (t) => {
  await withDatabase(t, async (pool) => {
    // 7005 belongs to the other vehicle and 7004 to a component hold: both are
    // silently skipped, not errors, and neither may be deleted.
    const result = await deleteMultipleVehicleStorageItems(
      pgTransactionalDb(pool), VEHICLE_ID, ["7001", "7003", "7004", "7005"]);

    assert.deepEqual(result.removed.map((row) => row.itemId).sort(), ["7001", "7003"]);
    assert.match(result.message, /2 of 4 requested item\(s\)/);
    assert.deepEqual(await itemIds(pool, CARGO_INVENTORY_ID), ["7002", BIG_ITEM_ID]);
    assert.equal(await stackSize(pool, "7004"), 99);
    assert.equal(await stackSize(pool, "7005"), 7);
  });
});

test("real PostgreSQL: bulk delete carries the destroyed grade and durability into its result", async (t) => {
  await withDatabase(t, async (pool) => {
    const result = await deleteMultipleVehicleStorageItems(pgTransactionalDb(pool), VEHICLE_ID, ["7003"]);
    const cutteray = result.removed[0];
    // Without these a bulk-destroyed pristine legendary logs identically to a
    // bulk-destroyed broken common of the same template.
    assert.equal(cutteray.qualityLevel, 4);
    assert.equal(cutteray.currentDurability, 300);
    assert.equal(cutteray.maxDurability, 600);
    assert.equal(cutteray.positionIndex, 7);
  });
});

test("real PostgreSQL: delete-all clears this hold and leaves every other inventory alone", async (t) => {
  await withDatabase(t, async (pool) => {
    const result = await deleteAllVehicleStorageItems(pgTransactionalDb(pool), VEHICLE_ID);

    assert.equal(result.removed.length, 4);
    assert.deepEqual(await itemIds(pool, CARGO_INVENTORY_ID), []);
    // The component holds, the other vehicle, and the placeable all survive.
    assert.deepEqual(await itemIds(pool, COMPONENT_INVENTORY_IDS[0]), ["7004"]);
    assert.deepEqual(await itemIds(pool, OTHER_CARGO_INVENTORY_ID), ["7005"]);
    assert.deepEqual(await itemIds(pool, BLOCKED_CARGO_INVENTORY_ID), ["7007"]);
  });
});

test("real PostgreSQL: delete-all on an already-empty hold reports it distinctly", async (t) => {
  await withDatabase(t, async (pool) => {
    await pool.query("delete from dune.items where inventory_id = $1", [OTHER_CARGO_INVENTORY_ID]);
    const result = await deleteAllVehicleStorageItems(pgTransactionalDb(pool), OTHER_VEHICLE_ID);
    assert.equal(result.removed.length, 0);
    assert.match(result.message, /already empty/);
  });
});

// The read and the write have to agree about which rows are in scope, or one
// of them is lying to the operator.
test("real PostgreSQL: what the overlay lists is exactly what delete-all removes", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    const listed = await vehicleStorage(db, VEHICLE_ID);
    const removed = await deleteAllVehicleStorageItems(db, VEHICLE_ID);

    assert.deepEqual(
      listed.slots.map((slot) => slot.itemId).sort(),
      removed.removed.map((row) => row.itemId).sort()
    );
  });
});

test("real PostgreSQL: a second delete of the same row reports not-found rather than succeeding twice", async (t) => {
  await withDatabase(t, async (pool) => {
    const db = pgTransactionalDb(pool);
    await deleteVehicleStorageItem(db, VEHICLE_ID, "7001");
    await assert.rejects(
      () => deleteVehicleStorageItem(db, VEHICLE_ID, "7001"),
      /not found in this vehicle's cargo hold/
    );
  });
});
