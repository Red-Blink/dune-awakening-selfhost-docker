import test from "node:test";
import assert from "node:assert/strict";
import { baseInventory } from "../src/duneDb.js";

const REQUIRED_TABLES = ["dune.placeables", "dune.inventories", "dune.items"];
const BASE_ID = 1006;

// Template ids deliberately absent from runtime/data/admin-items.json, so the
// assertions below test this module's fallback rather than tracking whatever
// the shipped catalog happens to call a real item this week.
function row(overrides = {}) {
  return {
    placeable_id: "40001",
    inventory_id: "500",
    group_key: "storage",
    type_name: "Storage Container",
    container_name: "",
    max_item_count: 45,
    template_id: "TestOre",
    stack_size: 10,
    ...overrides
  };
}

function createDb({ rows = [], missingTable = "" } = {}) {
  const calls = [];
  const db = {
    calls,
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) {
        const table = String(values[0] || "");
        return { rows: [{ exists: REQUIRED_TABLES.includes(table) && table !== missingTable }] };
      }
      return { rows };
    }
  };
  return db;
}

function mainQuery(db) {
  return db.calls.find((call) => call.text.includes("requested_claims"));
}

test("baseInventory rolls items up by template and by container", async () => {
  const db = createDb({
    rows: [
      row({ placeable_id: "40001", inventory_id: "500", template_id: "TestOre", stack_size: 10 }),
      row({ placeable_id: "40001", inventory_id: "500", template_id: "TestBar", stack_size: 3 }),
      row({ placeable_id: "40002", inventory_id: "501", container_name: "Ore Stash", max_item_count: 20, template_id: "TestOre", stack_size: 25 }),
      row({
        placeable_id: "40003", inventory_id: "502", group_key: "refining",
        type_name: "Small Ore Refinery", max_item_count: 5, template_id: "TestOre", stack_size: 7
      })
    ]
  });

  const result = await baseInventory(db, BASE_ID);

  assert.equal(result.baseId, BASE_ID);
  // Sorted by quantity descending: 42 of TestOre across three containers.
  assert.deepEqual(result.items.map((item) => [item.templateId, item.quantity, item.containerCount]), [
    ["TestOre", 42, 3],
    ["TestBar", 3, 1]
  ]);
  assert.deepEqual(result.items[0].containers.map((holder) => [holder.placeableId, holder.quantity]), [
    ["40002", 25],
    ["40001", 10],
    ["40003", 7]
  ]);
  // No catalog entry, so name falls back to the raw template id.
  assert.equal(result.items[0].name, "TestOre");

  assert.deepEqual(result.containers.map((container) => [container.placeableId, container.usedSlots, container.maxSlots]), [
    ["40002", 1, 20],
    ["40001", 2, 45],
    ["40003", 1, 5]
  ]);
  assert.deepEqual(result.totals, { items: 45, distinct: 2, containers: 3, usedSlots: 4, maxSlots: 70 });
  assert.deepEqual(result.groups, [
    { key: "storage", name: "Storage", containerCount: 2, itemCount: 38 },
    { key: "refining", name: "Refining", containerCount: 1, itemCount: 7 },
    { key: "crafting", name: "Crafting", containerCount: 0, itemCount: 0 },
    { key: "machines", name: "Machines", containerCount: 0, itemCount: 0 }
  ]);
});

test("baseInventory keeps an empty container instead of dropping it", async () => {
  // The left join against dune.items emits one all-null item row for a
  // container holding nothing.
  const db = createDb({
    rows: [row({ placeable_id: "40010", inventory_id: "510", template_id: null, stack_size: null, max_item_count: 5, group_key: "machines", type_name: "Repair Station" })]
  });

  const result = await baseInventory(db, BASE_ID);

  assert.deepEqual(result.containers, [{
    placeableId: "40010",
    name: "",
    typeName: "Repair Station",
    group: "machines",
    usedSlots: 0,
    maxSlots: 5,
    itemCount: 0,
    items: []
  }]);
  assert.deepEqual(result.items, []);
  assert.equal(result.totals.containers, 1);
  assert.equal(result.totals.distinct, 0);
});

test("baseInventory counts a container's capacity once per inventory, not per item row", async () => {
  // Every item row repeats its inventory's max_item_count; summing blindly
  // would report 135 slots for one 45-slot container.
  const db = createDb({
    rows: [
      row({ template_id: "TestOre", stack_size: 1 }),
      row({ template_id: "TestBar", stack_size: 1 }),
      row({ template_id: "TestGem", stack_size: 1 })
    ]
  });

  const result = await baseInventory(db, BASE_ID);

  assert.equal(result.containers.length, 1);
  assert.equal(result.containers[0].maxSlots, 45);
  assert.equal(result.containers[0].usedSlots, 3);
});

test("baseInventory merges repeated stacks of one template within a container", async () => {
  const db = createDb({
    rows: [
      row({ template_id: "TestOre", stack_size: 100 }),
      row({ template_id: "TestOre", stack_size: 40 })
    ]
  });

  const result = await baseInventory(db, BASE_ID);

  assert.deepEqual(result.containers[0].items, [{ templateId: "TestOre", name: "TestOre", quantity: 140 }]);
  assert.equal(result.containers[0].usedSlots, 2, "two stacks occupy two slots even when merged for display");
  assert.equal(result.items[0].containerCount, 1);
});

test("baseInventory leaves the container name empty when the game holds only its default", async () => {
  // dune.permission_actor.actor_name is '##' || building_type until a player
  // renames the placeable; the SQL strips that, so "" reaches the frontend
  // and it falls back to the type name.
  const db = createDb({ rows: [row({ container_name: "" })] });

  const result = await baseInventory(db, BASE_ID);

  assert.equal(result.containers[0].name, "");
  assert.equal(result.containers[0].typeName, "Storage Container");
});

test("baseInventory only ever asks for allowlisted building types", async () => {
  const db = createDb({ rows: [] });
  await baseInventory(db, BASE_ID);

  const [, groups, buildingTypes] = mainQuery(db).values;
  assert.ok(buildingTypes.includes("storagecontainer_placeable"));
  assert.ok(buildingTypes.includes("spicesilo_placeable"));
  assert.ok(buildingTypes.includes("smallorerefinery_placeable"));
  assert.ok(buildingTypes.includes("recycler_placeable"));
  assert.ok(buildingTypes.includes("repairstation_placeable"));
  // The Power and Water tabs own these; an unrecognised placeable must not
  // acquire a group by accident either.
  assert.ok(!buildingTypes.includes("generator_placeable"));
  assert.ok(!buildingTypes.includes("windtrap_placeable"));
  assert.ok(!buildingTypes.includes("watercistern_placeable"));
  assert.equal(groups.length, buildingTypes.length);
  assert.deepEqual([...new Set(groups)], ["storage", "refining", "crafting", "machines"]);
  // Refineries and fabricators are separate groups, not one "production" bucket.
  assert.equal(groups[buildingTypes.indexOf("smallorerefinery_placeable")], "refining");
  assert.equal(groups[buildingTypes.indexOf("survivalfabricator_placeable")], "crafting");
});

test("baseInventory drops the uncapped second inventory refineries carry", async () => {
  const db = createDb({ rows: [] });
  await baseInventory(db, BASE_ID);

  assert.match(mainQuery(db).text, /inv\.max_item_count >= 0/);
});

test("baseInventory reports unsupported when a required table is missing", async () => {
  for (const table of REQUIRED_TABLES) {
    const db = createDb({ missingTable: table });
    await assert.rejects(() => baseInventory(db, BASE_ID), (error) => {
      assert.equal(error.unsupported, true);
      assert.match(error.message, new RegExp(table.replace(".", "\\.")));
      return true;
    });
  }
});

test("baseInventory rejects an invalid base id", async () => {
  const db = createDb({ rows: [] });
  await assert.rejects(() => baseInventory(db, 0));
  await assert.rejects(() => baseInventory(db, "not-a-base"));
});
