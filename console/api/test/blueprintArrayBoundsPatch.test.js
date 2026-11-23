import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

const patchSql = readFileSync(new URL("../../../runtime/sql/patch-blueprint-array-bounds.sql", import.meta.url), "utf8");

test("blueprint array-bound repair is wired after successful database migration", () => {
  const updater = readFileSync(new URL("../../../runtime/scripts/update-db.sh", import.meta.url), "utf8");
  const wrapper = readFileSync(new URL("../../../runtime/scripts/patch-blueprint-array-bounds.sh", import.meta.url), "utf8");

  assert.match(updater, /runtime\/scripts\/patch-blueprint-array-bounds[.]sh/);
  assert.match(wrapper, /-v ON_ERROR_STOP=1/);
  assert.match(wrapper, /-f - < "\$patch_sql"/);
  assert.match(patchSql, /blueprint[.]player_id IS NOT NULL/);
  assert.match(patchSql, /array_lower\(child[.]transform, 1\) = 0/);
  assert.match(patchSql, /array_lower\(child[.]scale, 1\) = 0/);
});

test("real PostgreSQL: blueprint repair restores only Console imports and preserves values", async (t) => {
  await withIsolatedDatabase(t, {
    namePrefix: "dune_blueprint_array_bounds",
    unavailableLabel: "the blueprint array-bound integration test"
  }, async (pool) => {
    await pool.query(`
      create schema dune;
      create table dune.building_blueprints (id integer primary key, player_id bigint);
      create table dune.building_blueprint_instances (
        id integer primary key, building_blueprint_id integer not null, transform real[] not null
      );
      create table dune.building_blueprint_placeables (
        id integer primary key, building_blueprint_id integer not null, transform real[] not null
      );
      create table dune.building_blueprint_pentashields (
        id integer primary key, building_blueprint_id integer not null, scale smallint[] not null
      );

      insert into dune.building_blueprints values (10, 123), (20, null);

      insert into dune.building_blueprint_instances values
        (1, 10, '[0:3]={1,2,3,4}'),
        (2, 10, '{5,6,7,8}'),
        (3, 20, '[0:3]={9,10,11,12}'),
        (4, 20, '{13,14,15,16}');
      insert into dune.building_blueprint_placeables values
        (1, 10, '[0:5]={10,20,30,40,50,60}'),
        (2, 10, '{70,80,90,100,110,120}'),
        (3, 20, '[0:5]={130,140,150,160,170,180}'),
        (4, 20, '{190,200,210,220,230,240}'),
        (5, 10, '{26,60,70,250,0,0}');
      insert into dune.building_blueprint_pentashields values
        (1, 10, '[0:2]={2,4,6}'),
        (2, 10, '{8,10,12}'),
        (3, 20, '[0:2]={14,16,18}'),
        (4, 20, '{20,22,24}');
    `);

    await pool.query(patchSql);
    await pool.query(patchSql);

    const instances = await pool.query(`
      select id, array_lower(transform, 1) as lower_bound,
             transform[array_lower(transform, 1)] as first,
             transform[array_upper(transform, 1)] as last
      from dune.building_blueprint_instances order by id
    `);
    assert.deepEqual(instances.rows, [
      { id: 1, lower_bound: 1, first: 1, last: 4 },
      { id: 2, lower_bound: 1, first: 5, last: 8 },
      { id: 3, lower_bound: 0, first: 9, last: 12 },
      { id: 4, lower_bound: 1, first: 13, last: 16 }
    ]);

    const placeables = await pool.query(`
      select id, array_lower(transform, 1) as lower_bound,
             transform[array_lower(transform, 1)] as first,
             transform[array_upper(transform, 1)] as last
      from dune.building_blueprint_placeables order by id
    `);
    assert.deepEqual(placeables.rows, [
      { id: 1, lower_bound: 1, first: 10, last: 60 },
      { id: 2, lower_bound: 1, first: 70, last: 120 },
      { id: 3, lower_bound: 0, first: 130, last: 180 },
      { id: 4, lower_bound: 1, first: 190, last: 240 },
      { id: 5, lower_bound: 1, first: 26, last: 0 }
    ]);

    const placeableAxes = await pool.query(`
      select id, transform::text as transform
      from dune.building_blueprint_placeables order by id
    `);
    assert.deepEqual(placeableAxes.rows, [
      { id: 1, transform: "{10,20,30,40,50,60}" },
      { id: 2, transform: "{70,80,90,100,110,120}" },
      { id: 3, transform: "[0:5]={130,140,150,160,170,180}" },
      { id: 4, transform: "{190,200,210,220,230,240}" },
      { id: 5, transform: "{26,60,70,250,0,0}" }
    ]);

    const shields = await pool.query(`
      select id, array_lower(scale, 1) as lower_bound,
             scale[array_lower(scale, 1)] as first,
             scale[array_upper(scale, 1)] as last
      from dune.building_blueprint_pentashields order by id
    `);
    assert.deepEqual(shields.rows, [
      { id: 1, lower_bound: 1, first: 2, last: 6 },
      { id: 2, lower_bound: 1, first: 8, last: 12 },
      { id: 3, lower_bound: 0, first: 14, last: 18 },
      { id: 4, lower_bound: 1, first: 20, last: 24 }
    ]);
  });
});
