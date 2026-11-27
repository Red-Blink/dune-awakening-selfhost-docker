import test from "node:test";
import assert from "node:assert/strict";
import { liveMapPartitionRuntimeState, liveMapPartitions } from "../src/duneDb.js";
import { pgTransactionalDb, withIsolatedDatabase } from "../test-support/pgIntegrationDb.js";

// Real schema/naming pulled from dune2's live database -- notably
// world_partition.map uses the server's internal instance name
// ("DeepDesert_1"/"Survival_1" for Hagga Basin), not the friendly game map
// name actors report ("DeepDesert"/"HaggaBasin"). See the map-name
// translation comment on liveMapPartitions itself for why this matters.
const SCHEMA = `
  create schema dune;
  create table dune.world_partition (
    partition_id bigint primary key,
    server_id text,
    map text not null,
    partition_definition jsonb not null default '{}',
    dimension_index integer not null default 0,
    blocked boolean not null default false,
    label text
  );
  create table dune.actors (
    id bigint primary key,
    map text,
    partition_id bigint,
    transform jsonb
  );
  create table dune.farm_state (
    server_id text primary key,
    alive boolean not null default false,
    ready boolean not null default false
  );
`;

test("real PostgreSQL: a freshly registered partition with zero actors still appears", async (t) => {
  await withIsolatedDatabase(t, {
    namePrefix: "dune_live_map_partitions",
    unavailableLabel: "the live-map-partitions integration test",
    createFailLabel: "the live-map-partitions integration test"
  }, async (pool) => {
    await pool.query(SCHEMA);
    await pool.query(`
      -- Confirmed live: a second Hagga Basin instance ("Alraab") registered
      -- in world_partition with a real server_id, but nobody has spawned
      -- into it yet -- zero matching actor rows.
      insert into dune.world_partition (partition_id, server_id, map, dimension_index, label) values
        (1, 'abbir-server-id', 'Survival_1', 0, 'Abbir'),
        (60, 'alraab-server-id', 'Survival_1', 1, 'Alraab'),
        (8, 'deepdesert-pvp-id', 'DeepDesert_1', 0, 'PvP'),
        -- A stopped dynamic map keeps its world-partition record but has no
        -- active server id. It must remain selectable so saved map data can
        -- be inspected without pretending that the map is running.
        (61, '', 'DeepDesert_1', 1, 'PvE'),
        -- Game update 1.6.0: DT_MapsInfo names Polar Sink "PolarCap_1" with
        -- no separate friendly name, so the instance name passes through.
        (70, 'polarcap-server-id', 'PolarCap_1', 0, 'Polar Sink'),
        -- Confirmed live: dungeon/story sub-instances carry a real,
        -- non-null server_id too (they are genuinely running server
        -- processes) -- a null-server_id check alone does not exclude
        -- them, only the map-name allowlist does.
        (5, 'hephaestus-server-id', 'CB_Story_Hephaestus', 0, 'WreckOfHephaestus_0');

      insert into dune.actors (id, map, partition_id, transform) values
        (1, 'HaggaBasin', 1, '{}'),
        (2, 'HaggaBasin', 1, '{}');

      insert into dune.farm_state (server_id, alive, ready) values
        ('abbir-server-id', true, true),
        ('alraab-server-id', true, false),
        ('deepdesert-pvp-id', true, true);
    `);

    const db = pgTransactionalDb(pool);
    const result = await liveMapPartitions(db);

    const byPartitionId = Object.fromEntries(result.rows.map((row) => [row.partition_id, row]));
    assert.equal(byPartitionId[1].map, "HaggaBasin");
    assert.equal(byPartitionId[1].name, "Abbir");
    assert.equal(byPartitionId[1].marker_count, 2);
    assert.equal(byPartitionId[1].alive, true);
    assert.equal(byPartitionId[1].ready, true);

    // The real bug: partition 60 has zero actors, but is a real, running
    // partition -- must still show up, not be silently dropped.
    assert.ok(byPartitionId[60], "partition 60 (Alraab) should appear even with 0 actors");
    assert.equal(byPartitionId[60].map, "HaggaBasin");
    assert.equal(byPartitionId[60].name, "Alraab");
    assert.equal(byPartitionId[60].marker_count, 0);
    assert.equal(byPartitionId[60].alive, true);
    assert.equal(byPartitionId[60].ready, false);

    assert.equal(byPartitionId[8].map, "DeepDesert");
    assert.equal(byPartitionId[61].map, "DeepDesert");
    assert.equal(byPartitionId[61].alive, false);
    assert.equal(byPartitionId[61].ready, false);

    assert.ok(byPartitionId[70], "Polar Sink partition should be a Live Map partition");
    assert.equal(byPartitionId[70].map, "PolarCap_1");
    assert.equal(byPartitionId[70].name, "Polar Sink");

    assert.deepEqual(await liveMapPartitionRuntimeState(db, 1), { known: true, exists: true, alive: true, ready: true });
    assert.deepEqual(await liveMapPartitionRuntimeState(db, 61), { known: true, exists: true, alive: false, ready: false });
    assert.deepEqual(await liveMapPartitionRuntimeState(db, 999), { known: true, exists: false, alive: false, ready: false });

    assert.equal(byPartitionId[5], undefined, "dungeon sub-instances must be excluded even though they carry a real server_id");
  });
});

test("real PostgreSQL: falls back to actor-derived partitions when world_partition doesn't exist", async (t) => {
  await withIsolatedDatabase(t, {
    namePrefix: "dune_live_map_partitions_no_wp",
    unavailableLabel: "the live-map-partitions-no-world-partition integration test",
    createFailLabel: "the live-map-partitions-no-world-partition integration test"
  }, async (pool) => {
    await pool.query(`
      create schema dune;
      create table dune.actors (
        id bigint primary key,
        map text,
        partition_id bigint,
        transform jsonb
      );
      insert into dune.actors (id, map, partition_id, transform) values
        (1, 'HaggaBasin', 1, '{}');
    `);

    const db = pgTransactionalDb(pool);
    const result = await liveMapPartitions(db);

    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].map, "HaggaBasin");
    assert.equal(result.rows[0].partition_id, 1);
    assert.equal(result.rows[0].marker_count, 1);
    assert.equal(result.rows[0].alive, null);
    assert.equal(result.rows[0].ready, null);
  });
});
