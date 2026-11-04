import { databaseRestoreMaintenanceActive } from '../db.js';
import { resolvePartitionCombatStatesFromRuntime } from './mapCombatState.js';

export async function readCombatAvailabilityContext(db) {
  return db.transaction(async tx => {
    await tx.query('SET TRANSACTION READ ONLY');
    await tx.query("SET LOCAL statement_timeout = '5s'");
    const partitions = await tx.query('SELECT map, partition_id::text AS id FROM dune.world_partition');
    const relation = await tx.query("SELECT to_regclass('dune_console_combat.combat_events') IS NOT NULL AS present");
    let hasHistory = false;
    if (relation.rows[0]?.present) {
      const history = await tx.query("SELECT EXISTS (SELECT 1 FROM dune_console_combat.combat_events WHERE classification = 'pvp') AS present");
      hasHistory = history.rows[0]?.present === true;
    }
    return { partitions: partitions.rows, hasHistory };
  });
}

// Hide only when every partition is confirmed PvE and no recorded PvP would
// become inaccessible. Offline sietches and Deep Desert use the same resolver.
export function createCombatAvailability(config, db, {
  readContext = () => readCombatAvailabilityContext(db),
  resolveStates = (map, ids) => resolvePartitionCombatStatesFromRuntime(config, map, ids),
  now = Date.now, ttlMs = 60_000,
  isPaused = () => databaseRestoreMaintenanceActive(config.repoRoot)
} = {}) {
  let cached;
  let pending;
  let generation = 0;
  const unknown = { pvpVisible: true, reason: 'unknown' };
  async function resolve() {
    const { partitions, hasHistory } = await readContext();
    if (hasHistory) return { pvpVisible: true, reason: 'history' };
    if (!partitions.length) return unknown;
    const maps = new Map();
    for (const { map, id } of partitions) {
      if (!maps.has(map)) maps.set(map, []);
      maps.get(map).push(id);
    }
    for (const [map, ids] of maps) {
      const states = await resolveStates(map, ids);
      for (const id of ids) {
        const state = states.get(String(id));
        if (!state || state.configuredState !== 'PVE' || state.configurationDrift || state.restartRequired) {
          return { pvpVisible: true, reason: state?.configuredState === 'PVP' ? 'pvp' : 'unknown' };
        }
      }
    }
    return { pvpVisible: false, reason: 'pve' };
  }
  return {
    async read() {
      if (isPaused()) {
        generation++;
        cached = undefined;
        pending = undefined;
        return unknown;
      }
      if (cached && cached.expires > now()) return cached.value;
      if (!pending) {
        const started = generation;
        const task = resolve().catch(() => unknown).then(value => {
          if (generation === started) cached = { value, expires: now() + (value.reason === 'unknown' ? Math.min(ttlMs, 5000) : ttlMs) };
          return value;
        }).finally(() => { if (pending === task) pending = undefined; });
        pending = task;
      }
      return pending;
    }
  };
}
