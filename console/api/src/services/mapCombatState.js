// Canonical, read-only resolver for map/partition PvP-PvE combat state.
//
// This module is the single reusable source of truth consumed by the Web
// Console, Discord bridge, Prometheus exporter, RabbitMQ publication, and
// any other read-only integration that needs to report whether a partition
// (and, in aggregate, a map) is currently PvP, PvE, MIXED, in CONFLICT, or
// UNKNOWN.
//
// Combat state is resolved exclusively from the effective, merged
// UserGame.ini configuration for the partition (via
// `runtime/scripts/usersettings.py partition-combat-state`). It must never
// be inferred from:
//   - map names
//   - dimension indexes
//   - database labels (`world_partition.label`)
//   - display names
//   - service/container names
//   - lifecycle modes ("dynamic" / "always-on" / etc.)
//   - client-side badges
//
// Those signals remain valid as *descriptive metadata* attached alongside
// the resolved state, never as a substitute for it.
//
// Runtime availability (whether a server process is currently up) is a
// separate dimension from configured combat state and is reported
// independently — an offline partition retains its configured PvP/PvE
// designation.

import { runDune } from "../runner.js";

export const PARTITION_COMBAT_STATES = ["PVP", "PVE", "CONFLICT", "UNKNOWN"];
export const MAP_COMBAT_STATES = ["PVP", "PVE", "MIXED", "CONFLICT", "UNKNOWN"];
export const RUNTIME_STATUSES = ["RUNNING", "STARTING", "OFFLINE", "STOPPED", "UNASSIGNED", "UNKNOWN"];

function validateMapNameForCombatState(value) {
  const raw = String(value || "").trim();
  if (/^[A-Za-z0-9_:-]{1,80}$/.test(raw)) return raw;
  throw new Error("Invalid map name");
}

function validatePartitionIdForCombatState(value) {
  const raw = String(value ?? "").trim();
  if (/^\d{1,9}$/.test(raw) && Number(raw) > 0) return raw;
  throw new Error("Invalid partition id");
}

/**
 * Resolve runtime availability for a partition from world_partition /
 * farm_state fields. This is metadata about whether a server process is
 * currently up — it must never be blended into the combat-state itself.
 *
 * @param {{ serverId?: string, ready?: boolean, alive?: boolean, blocked?: boolean }} row
 * @returns {"RUNNING"|"STARTING"|"OFFLINE"|"STOPPED"|"UNASSIGNED"|"UNKNOWN"}
 */
export function resolveRuntimeStatus(row = {}) {
  const hasServer = Boolean(String(row.serverId || "").trim());
  if (row.blocked === true) return "STOPPED";
  if (!hasServer) return "UNASSIGNED";
  if (row.alive === true && row.ready === true) return "RUNNING";
  if (row.alive === true) return "STARTING";
  if (hasServer) return "OFFLINE";
  return "UNKNOWN";
}

/**
 * Call the canonical Python resolver for a single partition and parse its
 * structured JSON result. Throws if the underlying `usersettings.py`
 * invocation fails; callers should catch and surface an UNKNOWN/error state
 * rather than letting a resolver failure silently look like PVE.
 *
 * @param {object} config - server config (repoRoot, duneScript, commandTimeoutMs)
 * @param {string} mapName
 * @param {string} partitionId
 * @returns {Promise<{
 *   map: string,
 *   partitionId: string,
 *   configuredState: "PVP"|"PVE"|"CONFLICT"|"UNKNOWN",
 *   configuredSource: string,
 *   materializedState: "PVP"|"PVE"|"CONFLICT"|"UNKNOWN"|null,
 *   materializedSource: string|null,
 *   securityZonesEnabled: boolean,
 *   restartRequired: boolean,
 *   configurationDrift: boolean,
 *   warnings: string[],
 *   unresolvedFields: string[]
 * }>}
 */
export async function resolvePartitionCombatStateFromRuntime(config, mapName, partitionId) {
  const map = validateMapNameForCombatState(mapName);
  const id = validatePartitionIdForCombatState(partitionId);
  const args = ["usersettings", "partition-combat-state", map, id];
  const result = await runDune(config, args, { timeoutMs: 8000, env: config.env });
  const parsed = JSON.parse(result.stdout || "{}");
  if (!PARTITION_COMBAT_STATES.includes(parsed.configuredState)) {
    throw new Error(`Resolver returned unrecognized configuredState: ${parsed.configuredState}`);
  }
  return parsed;
}

/**
 * Aggregate independently-resolved partition combat states into a single
 * map-level combat state. Mirrors the Python `aggregate_map_combat_state`
 * implementation exactly (both must be kept in sync).
 *
 * @param {string[]} partitionStates
 * @returns {"PVP"|"PVE"|"MIXED"|"CONFLICT"|"UNKNOWN"}
 */
export function aggregateMapCombatState(partitionStates) {
  const states = Array.isArray(partitionStates) ? partitionStates : [];
  if (!states.length) return "UNKNOWN";
  if (states.some((state) => state === "CONFLICT")) return "CONFLICT";
  const determinable = new Set(states.filter((state) => state === "PVP" || state === "PVE"));
  if (determinable.size === 0) return "UNKNOWN";
  if (determinable.size === 1) return determinable.has("PVP") ? "PVP" : "PVE";
  return "MIXED";
}

/**
 * Build the full structured combat-state result for every partition of a
 * map, plus the map-level aggregate. Partitions come from
 * `dune.world_partition` rows supplied by the caller (already joined with
 * `farm_state` for runtime metadata) — this function does not query the
 * database directly so it stays testable and reusable by non-DB callers
 * (e.g. the Discord bridge, RabbitMQ publisher).
 *
 * @param {object} config
 * @param {Array<{
 *   partitionId: string|number,
 *   map: string,
 *   dimensionIndex?: number,
 *   databaseLabel?: string,
 *   serverId?: string,
 *   ready?: boolean,
 *   alive?: boolean,
 *   blocked?: boolean
 * }>} partitionRows
 * @returns {Promise<{
 *   map: string,
 *   mapState: "PVP"|"PVE"|"MIXED"|"CONFLICT"|"UNKNOWN",
 *   partitions: Array<object>
 * }>}
 */
export async function resolveMapCombatState(config, mapName, partitionRows) {
  const map = validateMapNameForCombatState(mapName);
  const rows = Array.isArray(partitionRows) ? partitionRows : [];

  const partitions = await Promise.all(rows.map(async (row) => {
    const partitionId = String(row.partitionId ?? "").trim();
    const runtimeStatus = resolveRuntimeStatus(row);
    const base = {
      map,
      partitionId,
      dimensionIndex: row.dimensionIndex ?? null,
      databaseLabel: row.databaseLabel ?? null,
      runtimeStatus,
    };

    if (!partitionId) {
      return {
        ...base,
        configuredState: "UNKNOWN",
        materializedState: null,
        source: "missing-partition-id",
        securityZonesEnabled: false,
        restartRequired: false,
        configurationDrift: false,
        warnings: ["Partition has no partition id; combat state cannot be resolved."],
      };
    }

    try {
      const resolved = await resolvePartitionCombatStateFromRuntime(config, map, partitionId);
      return {
        ...base,
        configuredState: resolved.configuredState,
        materializedState: resolved.materializedState,
        source: resolved.configuredSource,
        securityZonesEnabled: resolved.securityZonesEnabled,
        restartRequired: resolved.restartRequired,
        configurationDrift: resolved.configurationDrift,
        warnings: resolved.warnings,
      };
    } catch (error) {
      return {
        ...base,
        configuredState: "UNKNOWN",
        materializedState: null,
        source: "resolver-error",
        securityZonesEnabled: false,
        restartRequired: false,
        configurationDrift: false,
        warnings: [`Combat state could not be resolved: ${error.message || error}`],
      };
    }
  }));

  const mapState = aggregateMapCombatState(partitions.map((p) => p.configuredState));

  return { map, mapState, partitions };
}
