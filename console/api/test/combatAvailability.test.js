import test from 'node:test';
import assert from 'node:assert/strict';
import { createCombatAvailability, readCombatAvailabilityContext } from '../src/services/combatAvailability.js';
import { pgTransactionalDb, withIsolatedDatabase } from '../test-support/pgIntegrationDb.js';

const partitions = [{ map: 'Survival_1', id: '1' }, { map: 'DeepDesert_1', id: '2' }, { map: 'Survival_1', id: '3' }];
function fixture(options = {}) {
  const calls = [];
  const service = createCombatAvailability({}, {}, {
    isPaused: () => false,
    readContext: async () => ({ partitions, hasHistory: false }),
    resolveStates: async (map, ids) => {
      calls.push([map, ids]);
      return new Map(ids.map(id => [id, { configuredState: 'PVE' }]));
    }, ...options
  });
  return { service, calls };
}

test('all PvE sietches and Deep Desert hide PvP, using one resolver per map', async () => {
  const { service, calls } = fixture();
  assert.deepEqual(await service.read(), { pvpVisible: false, reason: 'pve' });
  assert.deepEqual(calls, [['Survival_1', ['1', '3']], ['DeepDesert_1', ['2']]]);
});

for (const state of ['PVP', 'CONFLICT', 'UNKNOWN']) {
  test(`${state} on a single Deep Desert partition keeps PvP available`, async () => {
    const { service } = fixture({ resolveStates: async (_map, ids) => new Map(ids.map(id => [id,
      { configuredState: id === '2' ? state : 'PVE' }])) });
    assert.equal((await service.read()).pvpVisible, true);
  });
}

test('retained PvP history remains accessible on a now-PvE server', async () => {
  const { service, calls } = fixture({ readContext: async () => ({ partitions, hasHistory: true }) });
  assert.deepEqual(await service.read(), { pvpVisible: true, reason: 'history' });
  assert.deepEqual(calls, []);
});

test('empty metadata, missing partitions, resolver failure, and drift never look like PvE', async () => {
  for (const options of [
    { readContext: async () => ({ partitions: [], hasHistory: false }) },
    { resolveStates: async () => new Map() },
    { resolveStates: async () => { throw new Error('unavailable'); } },
    { resolveStates: async (_map, ids) => new Map(ids.map(id => [id, { configuredState: 'PVE', configurationDrift: true }])) }
  ]) assert.equal((await fixture(options).service.read()).pvpVisible, true);
});

test('requests share cached results; expiry and restore maintenance force fresh resolution', async () => {
  let clock = 0, paused = false;
  const { service, calls } = fixture({ now: () => clock, ttlMs: 100, isPaused: () => paused });
  await Promise.all([service.read(), service.read()]);
  assert.equal(calls.length, 2);
  await service.read();
  assert.equal(calls.length, 2);
  clock = 101;
  await service.read();
  assert.equal(calls.length, 4);
  paused = true;
  assert.equal((await service.read()).reason, 'unknown');
  paused = false;
  await service.read();
  assert.equal(calls.length, 6);
});

test('real PostgreSQL: availability reads metadata and optional history without changing data', async t => {
  await withIsolatedDatabase(t, { namePrefix: 'combat_availability' }, async pool => {
    await pool.query(`CREATE SCHEMA dune;
      CREATE TABLE dune.world_partition (partition_id int, map text);
      INSERT INTO dune.world_partition VALUES (1,'Survival_1');`);
    const db = pgTransactionalDb(pool);
    assert.deepEqual(await readCombatAvailabilityContext(db), {
      partitions: [{ id: '1', map: 'Survival_1' }], hasHistory: false
    });
    await pool.query(`CREATE SCHEMA dune_console_combat;
      CREATE TABLE dune_console_combat.combat_events (classification text);
      INSERT INTO dune_console_combat.combat_events VALUES ('other');`);
    assert.equal((await readCombatAvailabilityContext(db)).hasHistory, false);
    await pool.query("INSERT INTO dune_console_combat.combat_events VALUES ('pvp')");
    assert.equal((await readCombatAvailabilityContext(db)).hasHistory, true);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM dune_console_combat.combat_events')).rows[0].n, 2);
  });
});
