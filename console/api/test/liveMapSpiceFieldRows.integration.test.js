import test from "node:test";
import assert from "node:assert/strict";
import { liveMapSpiceFieldRows, liveMapFlourSandFieldRows } from "../src/duneDb.js";
import { pgTransactionalDb, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

// Real column types/constraints pulled from dune2's live schema -- notably
// resourcefield_state's actual primary key is (field_id, map,
// dimension_index), not field_id alone: the same field_id genuinely repeats
// across Deep Desert's two dimensions (confirmed live), so the query under
// test must be dimension-aware rather than treating field_id as unique.
//
// resourcefield_state.map and world_partition.map are different namespaces
// (confirmed live) -- resourcefield_state uses the friendly game-map name
// ("DeepDesert"/"HaggaBasin"), world_partition uses the server's internal
// instance name ("DeepDesert_1"/"Survival_1" for Hagga Basin). Fixtures
// below use the real internal names for world_partition so this test
// actually exercises the join's name translation, not just its shape.
const SCHEMA = `
  create schema dune;
  create table dune.resourcefield_state (
    field_id bigint not null,
    map text not null,
    dimension_index integer not null,
    spawn_time double precision not null,
    value_remaining bigint not null,
    field_kind_id smallint not null,
    primary key (field_id, map, dimension_index)
  );
  create table dune.world_partition (
    partition_id bigint primary key,
    server_id text,
    map text not null,
    dimension_index integer not null,
    blocked boolean not null default false,
    label text
  );
`;

test("real PostgreSQL: liveMapSpiceFieldRows resolves partition_id per dimension via the map-name translation, covers all tiers, classifies size by threshold, and includes Hagga Basin", async (t) => {
  await withIsolatedDatabase(t, {
    namePrefix: "dune_spice_rows",
    unavailableLabel: "the live-spice-rows integration test",
    createFailLabel: "the live-spice-rows integration test"
  }, async (pool) => {
    await pool.query(SCHEMA);
    await pool.query(`
      insert into dune.world_partition (partition_id, map, dimension_index, label) values
        (8, 'DeepDesert_1', 0, 'PvP'),
        (59, 'DeepDesert_1', 1, 'PvE'),
        (1, 'Survival_1', 0, 'Hagga Basin');

      -- The exact field_id collision confirmed live: same physical position,
      -- both dimensions, both currently Large.
      insert into dune.resourcefield_state (field_id, map, dimension_index, spawn_time, value_remaining, field_kind_id) values
        (9205150785405452288, 'DeepDesert', 0, 0, 2500000, 1),
        (9205150785405452288, 'DeepDesert', 1, 0, 2500000, 1),
        -- Medium spice, exact tier value -- now included, since the Large-only threshold was widened.
        (1234567890123456, 'DeepDesert', 0, 0, 150000, 1),
        -- Small spice, exact tier value.
        (1234567890123457, 'DeepDesert', 0, 0, 5000, 1),
        -- Between the Small and Medium thresholds (not an exact tier value) -- classifies as
        -- Medium by the threshold rule. Also stands in for the known, accepted imprecision: a
        -- genuinely-Large field drained down into this same range would classify identically,
        -- and the query has no way to tell the two apart.
        (1234567890123458, 'DeepDesert', 0, 0, 75000, 1),
        -- Flour sand (field_kind_id=0) at Large-sized value -- must be excluded regardless of value.
        (2222222222222222, 'DeepDesert', 0, 0, 2500000, 0),
        -- Hagga Basin only ever has Small-tier spice (confirmed live) -- resolves against the
        -- Survival_1 partition, not filtered out (no map filter passed to this query).
        (3333333333333333, 'HaggaBasin', 0, 0, 5000, 1);
    `);

    const db = pgTransactionalDb(pool);
    const result = await liveMapSpiceFieldRows(db, "");

    assert.equal(result.capabilities.spiceActive, true);
    assert.equal(result.rows.length, 6);
    const byFieldId = Object.fromEntries(result.rows.map((row) => [`${row.field_id}:${row.partition_id}`, row]));
    assert.equal(byFieldId["9205150785405452288:8"].size, "Large");
    assert.equal(byFieldId["9205150785405452288:59"].size, "Large");
    assert.equal(byFieldId["1234567890123456:8"].size, "Medium");
    assert.equal(byFieldId["1234567890123457:8"].size, "Small");
    assert.equal(byFieldId["1234567890123458:8"].size, "Medium");
    assert.equal(byFieldId["3333333333333333:1"].map, "HaggaBasin");
    assert.equal(byFieldId["3333333333333333:1"].size, "Small");
  });
});

test("real PostgreSQL: liveMapFlourSandFieldRows returns only field_kind_id=0 rows, no value threshold, and resolves Hagga Basin's partition too", async (t) => {
  await withIsolatedDatabase(t, {
    namePrefix: "dune_flour_sand_rows",
    unavailableLabel: "the flour-sand-rows integration test",
    createFailLabel: "the flour-sand-rows integration test"
  }, async (pool) => {
    await pool.query(SCHEMA);
    await pool.query(`
      insert into dune.world_partition (partition_id, map, dimension_index, label) values
        (8, 'DeepDesert_1', 0, 'PvP'),
        (1, 'Survival_1', 0, 'Hagga Basin');

      insert into dune.resourcefield_state (field_id, map, dimension_index, spawn_time, value_remaining, field_kind_id) values
        (4444444444444444, 'DeepDesert', 0, 0, 60000, 0),
        -- Large spice at the same map/dimension -- must be excluded (field_kind_id=1, not 0).
        (5555555555555555, 'DeepDesert', 0, 0, 2500000, 1),
        -- Flour sand on Hagga Basin (confirmed live) -- resolves against the Survival_1 partition.
        (6666666666666667, 'HaggaBasin', 0, 0, 60000, 0);
    `);

    const db = pgTransactionalDb(pool);
    const result = await liveMapFlourSandFieldRows(db, "");

    assert.equal(result.capabilities.flourSand, true);
    assert.equal(result.rows.length, 2);
    const byFieldId = Object.fromEntries(result.rows.map((row) => [row.field_id, row]));
    assert.equal(byFieldId["4444444444444444"].partition_id, 8);
    assert.equal(byFieldId["4444444444444444"].value_remaining, 60000);
    assert.equal(byFieldId["6666666666666667"].map, "HaggaBasin");
    assert.equal(byFieldId["6666666666666667"].partition_id, 1);
  });
});

test("real PostgreSQL: rows survive when world_partition has no matching row (confirmed live: Deep Desert partitions can momentarily deregister)", async (t) => {
  await withIsolatedDatabase(t, {
    namePrefix: "dune_spice_rows_no_partition",
    unavailableLabel: "the no-partition-row integration test",
    createFailLabel: "the no-partition-row integration test"
  }, async (pool) => {
    await pool.query(SCHEMA);
    await pool.query(`
      -- world_partition deliberately empty -- reproduces the live bug where
      -- Deep Desert's partition rows were briefly absent and an inner join
      -- silently dropped every real spice/flour-sand row.
      insert into dune.resourcefield_state (field_id, map, dimension_index, spawn_time, value_remaining, field_kind_id) values
        (6666666666666666, 'DeepDesert', 0, 0, 2500000, 1),
        (7777777777777777, 'DeepDesert', 0, 0, 60000, 0);
    `);

    const db = pgTransactionalDb(pool);
    const spice = await liveMapSpiceFieldRows(db, "DeepDesert");
    const flourSand = await liveMapFlourSandFieldRows(db, "DeepDesert");

    assert.equal(spice.rows.length, 1);
    assert.equal(spice.rows[0].field_id, "6666666666666666");
    assert.equal(spice.rows[0].partition_id, null);
    assert.equal(flourSand.rows.length, 1);
    assert.equal(flourSand.rows[0].field_id, "7777777777777777");
    assert.equal(flourSand.rows[0].partition_id, null);
  });
});
