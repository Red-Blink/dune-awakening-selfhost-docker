import test from "node:test";
import assert from "node:assert/strict";
import { exportBlueprint, importBlueprint, listBlueprints, blueprintCapabilities } from "../src/blueprints.js";

const SAMPLE_INSTANCE = {
  building_type: "MTX_Smug_Foundation",
  x: 0,
  y: 1024,
  z: 0,
  rotation: 0
};

const SAMPLE_INSTANCE_WALL = {
  building_type: "Atreides_Outpost_Wall_02",
  x: 512,
  y: 1280,
  z: 384,
  rotation: -90
};

const SAMPLE_PLACEABLE = {
  building_type: "Generator_Placeable",
  x: -149,
  y: 968,
  z: 386,
  ry: 180
};

const SAMPLE_PENTASHIELD = {
  placeable_id: 1,
  scale: [10, 2, 10]
};

function fakeBlueprintDb(calls) {
  let nextItemId = 500;
  let nextBpId = 100;
  const items = [];
  const blueprintNames = new Map();
  const blueprints = [];
  const instances = [];
  const placeables = [];
  const pentashields = [];

  function recordNameFromStats(stats) {
    const bpIdMatch = stats.FBuildingBlueprintItemStats?.[1]?.PlayerBlueprintId?.match(/#(\d+)/);
    if (bpIdMatch) {
      const bpId = parseInt(bpIdMatch[1]);
      const bpName = stats.FBuildingBlueprintItemStats?.[1]?.BuildingBlueprintName || "";
      if (bpId > 0 && bpName) blueprintNames.set(bpId, bpName);
    }
  }

  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) {
        return { rows: [{ exists: !String(values[0]).includes("nonexistent") }] };
      }
      if (text.includes("online_status") && text.includes("player_state")) {
        return { rows: [{ status: "Offline" }] };
      }
      if (text.includes("actor_id = $1 and inventory_type = 0")) {
        return { rows: [{ id: 10 }] };
      }
      if (text.includes("max(position_index)")) {
        return { rows: [{ next_pos: 3 }] };
      }
      if (text.includes("insert into dune.items") && text.includes("BuildingBlueprint_CopyDevice")) {
        const id = ++nextItemId;
        const stats = JSON.parse(values[2]);
        recordNameFromStats(stats);
        items.push({ id, stats });
        return { rows: [{ id }] };
      }
      if (text.includes("insert into dune.building_blueprints") && text.includes("item_id")) {
        const id = ++nextBpId;
        blueprints.push({ id, item_id: values[0] });
        return { rows: [{ id }] };
      }
      if (text.includes("update dune.items set stats")) {
        const item = items.find(i => i.id === Number(values[1]));
        if (item) {
          item.stats = JSON.parse(values[0]);
          recordNameFromStats(item.stats);
        }
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("insert into dune.building_blueprint_instances")) {
        instances.push({ blueprint_id: values[0], instance_id: values[1], type: values[2], transform: values[3], stability: values[4] });
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("insert into dune.building_blueprint_placeables")) {
        placeables.push({ blueprint_id: values[0], placeable_id: values[1], type: values[2], transform: values[3] });
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("insert into dune.building_blueprint_pentashields")) {
        pentashields.push({ blueprint_id: values[0], placeable_id: values[1], scale: [Number(values[2]), Number(values[3]), Number(values[4])] });
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("FBuildingBlueprintItemStats") && text.includes("where bb.id")) {
        const bpId = Number(values[0]);
        return { rows: [{ name: blueprintNames.get(bpId) || "" }] };
      }
      if (text.includes("from dune.building_blueprint_instances") && text.includes("where building_blueprint_id") && values.length > 0) {
        return { rows: instances.filter(i => i.blueprint_id === Number(values[0])) };
      }
      if (text.includes("from dune.building_blueprint_placeables") && text.includes("where building_blueprint_id") && values.length > 0) {
        return { rows: placeables.filter(p => p.blueprint_id === Number(values[0])) };
      }
      if (text.includes("from dune.building_blueprint_pentashields") && text.includes("where building_blueprint_id") && values.length > 0) {
        return { rows: pentashields.filter(p => p.blueprint_id === Number(values[0])) };
      }
      if (text.includes("order by bb.id desc")) {
        return { rows: blueprints.map(bp => ({
          id: bp.id, owner_name: "", item_id: bp.item_id,
          pieces: instances.filter(i => i.blueprint_id === bp.id).length,
          placeables: placeables.filter(p => p.blueprint_id === bp.id).length,
          name: blueprintNames.get(bp.id) || ""
        })) };
      }
      if (text.includes("from dune.building_blueprints") && text.includes("where bb.id")) {
        return { rows: [{ id: 101, owner_name: "", item_id: 501, pieces: 0, placeables: 0, name: "" }] };
      }
      return { rows: [] };
    },
    transaction: async (fn) => fn(db)
  };
  return { db, items, blueprints, instances, placeables, pentashields };
}


test("blueprint capabilities detects missing tables", async () => {
  const db = {
    query: async (text, vals) => {
      if (String(vals[0]).includes("building_blueprint_instances")) return { rows: [{ exists: false }] };
      return { rows: [{ exists: true }] };
    }
  };
  const cap = await blueprintCapabilities(db);
  assert.equal(cap, false);
});

test("blueprint capabilities requires pentashield table", async () => {
  const db = {
    query: async (text, vals) => {
      if (String(vals[0]).includes("building_blueprint_pentashields")) return { rows: [{ exists: false }] };
      return { rows: [{ exists: true }] };
    }
  };
  const cap = await blueprintCapabilities(db);
  assert.equal(cap, false);
});

test("blueprint capabilities returns true when all tables present", async () => {
  const db = { query: async () => ({ rows: [{ exists: true }] }) };
  const cap = await blueprintCapabilities(db);
  assert.equal(cap, true);
});

test("import blueprint creates item with Blueprint_CopyDevice template", async () => {
  const { db } = fakeBlueprintDb([]);
  const result = await importBlueprint(db, 123, { name: "My Base", instances: [SAMPLE_INSTANCE] });
  assert.ok(result.ok);
  assert.match(result.message, /blueprint #\d+/);
  assert.equal(result.pieces, 1);
});

test("import blueprint inserts building instances with transform", async () => {
  const { db, instances } = fakeBlueprintDb([]);
  await importBlueprint(db, 123, {
    instances: [
      { ...SAMPLE_INSTANCE, x: 100, y: 200, z: 300, rotation: 90 },
      { ...SAMPLE_INSTANCE_WALL, x: 512, y: 1280, z: 384, rotation: -90 }
    ]
  });
  assert.equal(instances.length, 2);
  assert.equal(instances[0].type, "MTX_Smug_Foundation");
  assert.match(String(instances[0].transform), /100/);
  assert.equal(instances[0].stability, true);
});

test("import blueprint detects structural building types for stability", async () => {
  const { db, instances } = fakeBlueprintDb([]);
  await importBlueprint(db, 123, {
    instances: [
      { building_type: "MTX_Smug_Foundation", x: 0, y: 0, z: 0, rotation: 0 },
      { building_type: "Atreides_Outpost_Foundation", x: 0, y: 0, z: 0, rotation: 0 },
      { building_type: "Harkonnen_Outpost_Foundation", x: 0, y: 0, z: 0, rotation: 0 },
      { building_type: "Atreides_Outpost_Wall_02", x: 0, y: 0, z: 0, rotation: 0 }
    ]
  });
  assert.equal(instances.length, 4);
  assert.equal(instances[0].stability, true);
  assert.equal(instances[1].stability, true);
  assert.equal(instances[2].stability, true);
  assert.equal(instances[3].stability, false);
});

test("import blueprint respects explicit provides_stability from JSON", async () => {
  const { db, instances } = fakeBlueprintDb([]);
  await importBlueprint(db, 123, {
    instances: [
      { building_type: "Atreides_Outpost_Wall_02", x: 0, y: 0, z: 0, rotation: 0, provides_stability: true },
      { building_type: "MTX_Smug_Foundation", x: 0, y: 0, z: 0, rotation: 0, provides_stability: false }
    ]
  });
  assert.equal(instances.length, 2);
  assert.equal(instances[0].stability, true);
  assert.equal(instances[1].stability, false);
});

test("import blueprint inserts placeables with 6-element transform", async () => {
  const { db, placeables } = fakeBlueprintDb([]);
  await importBlueprint(db, 123, {
    placeables: [{ ...SAMPLE_PLACEABLE, x: -149, y: 968, z: 386, rx: 10, ry: 180, rz: 5 }]
  });
  assert.equal(placeables.length, 1);
  assert.equal(placeables[0].type, "Generator_Placeable");
  assert.match(String(placeables[0].transform), /-149/);
});

test("import blueprint inserts pentashields with scale", async () => {
  const { db, pentashields } = fakeBlueprintDb([]);
  await importBlueprint(db, 123, { pentashields: [SAMPLE_PENTASHIELD] });
  assert.equal(pentashields.length, 1);
  assert.deepEqual(pentashields[0].scale, [10, 2, 10]);
});

test("import blueprint throws on missing tables", async () => {
  const db = {
    query: async (text) => ({ rows: [{ exists: false }] }),
    transaction: async (fn) => fn(db)
  };
  await assert.rejects(() => importBlueprint(db, 123, { instances: [SAMPLE_INSTANCE] }), /Blueprint operations require/);
});

test("import blueprint rejects empty blueprint", async () => {
  const { db } = fakeBlueprintDb([]);
  await assert.rejects(() => importBlueprint(db, 123, { instances: [], placeables: [], pentashields: [] }), /no instances, placeables, or pentashields/);
  await assert.rejects(() => importBlueprint(db, 123, {}), /must be an object with instances/);
});

test("import blueprint updates item stats with blueprint ID and name", async () => {
  const calls = [];
  const { db } = fakeBlueprintDb(calls);
  const result = await importBlueprint(db, 123, { name: "My Awesome Base", instances: [SAMPLE_INSTANCE] });
  assert.ok(result.blueprintId > 0);
  const update = calls.find(c => c.text.includes("update dune.items set stats"));
  assert.ok(update, "Expected update stats query");
  const stats = JSON.parse(update.values[0]);
  assert.match(stats.FBuildingBlueprintItemStats[1].PlayerBlueprintId, /#\d+/);
  assert.equal(stats.FBuildingBlueprintItemStats[1].BuildingBlueprintName, "My Awesome Base");
});

test("import blueprint deduplicates placeable_ids for sequential ids", async () => {
  const { db, placeables } = fakeBlueprintDb([]);
  await importBlueprint(db, 123, {
    placeables: [
      { building_type: "Generator_Placeable", x: 0, y: 0, z: 0, ry: 0 },
      { building_type: "Recycler_Placeable", x: 0, y: 0, z: 0, ry: 0 },
      { building_type: "Windtrap_Placeable", x: 0, y: 0, z: 0, ry: 0 }
    ]
  });
  assert.equal(placeables.length, 3);
  assert.equal(placeables[0].placeable_id, 1);
  assert.equal(placeables[1].placeable_id, 2);
  assert.equal(placeables[2].placeable_id, 3);
});

test("export blueprint returns full JSON structure", async () => {
  const { db } = fakeBlueprintDb([]);
  await importBlueprint(db, 123, {
    name: "Export Test",
    instances: [SAMPLE_INSTANCE, SAMPLE_INSTANCE_WALL],
    placeables: [SAMPLE_PLACEABLE],
    pentashields: [SAMPLE_PENTASHIELD]
  });
  const result = await exportBlueprint(db, 101);
  assert.equal(result.name, "Export Test");
  assert.equal(result.instances.length, 2);
  assert.equal(result.placeables.length, 1);
  assert.equal(result.pentashields.length, 1);
});

test("export blueprint handles empty blueprint", async () => {
  const { db } = fakeBlueprintDb([]);
  const result = await exportBlueprint(db, 999);
  assert.equal(result.name, "");
  assert.equal(result.instances.length, 0);
});

test("list blueprints returns rows with piece and placeable counts", async () => {
  const { db } = fakeBlueprintDb([]);
  await importBlueprint(db, 123, {
    name: "Base 1",
    instances: [SAMPLE_INSTANCE, SAMPLE_INSTANCE_WALL],
    placeables: [SAMPLE_PLACEABLE]
  });
  const rows = await listBlueprints(db);
  assert.ok(rows.length >= 1);
  const bp = rows[rows.length - 1];
  assert.equal(bp.name, "Base 1");
  assert.equal(bp.pieces, 2);
  assert.equal(bp.placeables, 1);
});

test("import blueprint batches 51+ instances correctly", async () => {
  const { db, instances } = fakeBlueprintDb([]);
  const fiftyOneInstances = Array.from({ length: 51 }, (_, i) => ({
    building_type: i === 0 ? "MTX_Smug_Foundation" : "Atreides_Outpost_Wall_02",
    x: i * 100,
    y: 0,
    z: 0,
    rotation: 0
  }));
  await importBlueprint(db, 123, { instances: fiftyOneInstances });
  assert.equal(instances.length, 51);
});

test("import blueprint with pentashield only succeeds", async () => {
  const { db, pentashields } = fakeBlueprintDb([]);
  const result = await importBlueprint(db, 123, {
    pentashields: [SAMPLE_PENTASHIELD, { placeable_id: 2, scale: [5, 1, 5] }]
  });
  assert.ok(result.ok);
  assert.equal(pentashields.length, 2);
});
