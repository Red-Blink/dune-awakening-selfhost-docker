import { api, post } from "./client";
import type { Task } from "./setup";

export type UserSettingField = {
  scope: "engine" | "mapEngine" | "partitionEngine" | "game" | "partition";
  id: string;
  section: string | null;
  key: string | null;
  default: string;
  type: "boolean" | "integer" | "number" | "text";
  clientFile: string;
  category: string;
  description: string;
};

export type UserSettingsSchema = {
  engine: UserSettingField[];
  mapEngine: UserSettingField[];
  game: UserSettingField[];
  partition: UserSettingField[];
  partitionEngine: UserSettingField[];
};

export type LiveMapMemoryRow = {
  container: string;
  map: string;
  usedBytes: number;
  limitBytes: number;
  percent: number;
  raw: string;
  swapUsedBytes?: number;
  swapLimitBytes?: number;
  swapSupported?: boolean;
};

export type MemoryBalancerState = {
  enabled: boolean;
  running: boolean;
  lastMessage: string;
  lastAction: string;
  lastError: string;
  updatedAt: string | null;
};

export type MemorySwapState = {
  enabled: boolean;
  hostPoolActive: boolean;
  poolGiB: number;
  perServerGiB: number;
  recommendedPoolGiB: number;
  worldServerCount: number;
  existingSwapGiB: number;
  physicalMemoryGiB: number;
  safeAvailableDiskGiB: number;
  swappiness: string;
  configuredSwappiness: number;
  swapFile: string;
};

export type MapRuntimeSettings = {
  alwaysOnStartupParallelism: number;
  configuredAlwaysOnStartupParallelism: number;
  defaultAlwaysOnStartupParallelism: number;
  maxAlwaysOnStartupParallelism: number;
  configured: boolean;
  hostMemoryProtectionEnabled: boolean;
  hostMemorySafetyLimited: boolean;
  physicalMemoryGiB: number;
  hostMemoryReserveGiB: number;
  automaticHostMemoryReserveGiB: number;
  hostMemoryReserveConfigured: boolean;
};

export type SpicefieldTypeRow = {
  spicefield_type_id: number;
  map_name: string;
  field_type: string;
  dimension_index: number;
  max_globally_active: number;
  max_globally_primed: number;
  current_globally_active: number | null;
  current_globally_primed: number | null;
  is_spawning_active: boolean | null;
  global_spawn_weight: number | null;
};

export type PartitionCombatState = "PVP" | "PVE" | "CONFLICT" | "UNKNOWN";
export type MapCombatState = "PVP" | "PVE" | "MIXED" | "CONFLICT" | "UNKNOWN";
export type PartitionRuntimeStatus = "RUNNING" | "STARTING" | "OFFLINE" | "STOPPED" | "UNASSIGNED" | "UNKNOWN";

export type PartitionCombatStateRow = {
  map: string;
  partitionId: string;
  dimensionIndex: number | null;
  databaseLabel: string | null;
  runtimeStatus: PartitionRuntimeStatus;
  configuredState: PartitionCombatState;
  materializedState: PartitionCombatState | null;
  source: string;
  securityZonesEnabled: boolean;
  restartRequired: boolean;
  configurationDrift: boolean;
  warnings: string[];
};

export type MapCombatStateResult = {
  map: string;
  mapState: MapCombatState;
  partitions: PartitionCombatStateRow[];
  reason?: string;
};

export type ChoamTradeCenter = { key: string; name: string };
export type ChoamSietch = { partition_id: string; dimension_index: number; label: string };
export type ChoamTerminalPlacement = {
  trade_center_key: string;
  trade_center_name: string;
  dimension_index: number;
  partition_id: string;
  actor_id: string;
  source_player_id: string;
  created_at: string;
  actor_present: boolean;
};
export type ChoamTerminalOverview = {
  supported: boolean;
  reason?: string;
  tradeCenters: ChoamTradeCenter[];
  sietches: ChoamSietch[];
  placements: ChoamTerminalPlacement[];
};

export const mapsApi = {
  maps: () => api<{ stdout: string }>("/api/maps"),
  status: () => api<Record<string, { stdout?: string; stderr?: string; exitCode?: number }>>("/api/map/status"),
  mode: (map = "") => api<{ stdout: string }>(`/api/maps/mode${map ? `?map=${encodeURIComponent(map)}` : ""}`),
  saveMapSettings: (body: { map: string; partitionId?: string; mode?: string; memory?: string; modeChanged: boolean; memoryChanged: boolean; running: boolean; confirmation: string }) => post<{ task: Task }>("/api/maps/settings", body),
  runtimeSettings: () => api<MapRuntimeSettings>("/api/maps/runtime-settings"),
  saveRuntimeSettings: (body: { alwaysOnStartupParallelism: number; hostMemoryProtectionEnabled: boolean; hostMemoryReserveGiB: number | null }) => post<MapRuntimeSettings>("/api/maps/runtime-settings", body),
  spawn: (target: string, confirmation: string) => post<{ task: Task }>("/api/maps/spawn", { target, confirmation }),
  despawn: (target: string, confirmation: string) => post<{ task: Task }>("/api/maps/despawn", { target, confirmation }),
  // Restart for a map with no managed service (Deep Desert, the SH_* hubs):
  // despawn then spawn as one task. Always pass a partition id, never a map name
  // -- spawn-server.sh given a name picks the first unassigned partition.
  respawn: (partitionId: string, confirmation: string) => post<{ task: Task }>("/api/maps/respawn", { target: partitionId, confirmation }),
  autoscaler: () => api<{ stdout: string }>("/api/maps/autoscaler"),
  memory: () => api<{ stdout: string }>("/api/maps/memory"),
  liveMemory: () => api<{ rows: LiveMapMemoryRow[]; sampledAt: string; error?: string }>("/api/maps/memory/live"),
  memoryBalancer: () => api<MemoryBalancerState>("/api/maps/memory/balancer"),
  setMemoryBalancer: (enabled: boolean) => post<MemoryBalancerState>("/api/maps/memory/balancer", { enabled }),
  memorySwap: () => api<MemorySwapState>("/api/maps/memory/swap"),
  setMemorySwap: (body: { enabled: boolean; perServerGiB?: number; poolGiB?: number; swappiness?: number; confirmation: string }) => post<{ task: Task }>("/api/maps/memory/swap", body),
  setMemory: (body: { map: string; memory: string; confirmation: string }) => post<{ task: Task }>("/api/maps/memory", { ...body, action: "set" }),
  spicefields: () => api<{ capabilities?: Record<string, boolean>; rows: SpicefieldTypeRow[]; reason?: string }>("/api/maps/spicefields"),
  updateSpicefield: (typeId: number | string, body: { max_globally_active: number; max_globally_primed: number; is_spawning_active: boolean; global_spawn_weight: number }) =>
    api<{ ok: boolean; updatedRows: number; row: SpicefieldTypeRow }>(`/api/maps/spicefields/${encodeURIComponent(String(typeId))}`, { method: "PATCH", body: JSON.stringify(body) }),
  choamTerminals: () => api<ChoamTerminalOverview>("/api/maps/choam-terminals"),
  installChoamTerminals: (tradeCenterKey: string) =>
    post<{ ok: boolean; created: { dimensionIndex: number; partitionId: string; actorId: string; label: string }[]; unchanged: number; restartRequired: boolean }>("/api/maps/choam-terminals", { tradeCenterKey }),
  removeChoamTerminals: (tradeCenterKey: string) =>
    api<{ ok: boolean; removed: number; restartRequired: boolean }>("/api/maps/choam-terminals", { method: "DELETE", body: JSON.stringify({ tradeCenterKey }) }),
  userEngine: () => api<{ stdout: string; stderr?: string; exitCode?: number }>("/api/maps/userengine"),
  userGame: (map: string, partitionId?: string) => api<{ stdout: string; stderr?: string; exitCode?: number }>(`/api/maps/usergame?map=${encodeURIComponent(map)}${partitionId ? `&partitionId=${encodeURIComponent(partitionId)}` : ""}`),
  userSettingsSchema: () => api<UserSettingsSchema>("/api/maps/user-settings/schema"),
  userSettingsRestartPending: () => api<{ pending: boolean }>("/api/maps/user-settings/restart-pending"),
  userSettingsValues: (scope: "engine" | "mapEngine" | "partitionEngine" | "global" | "map" | "partition", map?: string, partitionId?: string) => api<{ stdout: string }>(`/api/maps/user-settings/values?scope=${encodeURIComponent(scope)}${map ? `&map=${encodeURIComponent(map)}` : ""}${partitionId ? `&partitionId=${encodeURIComponent(partitionId)}` : ""}`),
  rawUserSettings: (kind: "engine" | "game" | "profile" | "client-game" | "client-engine", map?: string, partitionId?: string) => api<{ content: string }>(`/api/maps/user-settings/raw?kind=${encodeURIComponent(kind)}${map ? `&map=${encodeURIComponent(map)}` : ""}${partitionId ? `&partitionId=${encodeURIComponent(partitionId)}` : ""}`),
  saveUserSettings: (body: { scope: "engine" | "mapEngine" | "partitionEngine" | "global" | "map" | "partition"; map?: string; partitionId?: string; values: Record<string, string>; restart?: boolean }) => post<{ task: Task }>("/api/maps/user-settings/save", body),
  resetUserSettings: (body: { scope: "engine" | "mapEngine" | "partitionEngine" | "global" | "map" | "partition"; map?: string; partitionId?: string; confirmation: string }) => post<{ task: Task }>("/api/maps/user-settings/reset", body),
  saveRawUserSettings: (body: { scope: "engine" | "game" | "global" | "profile"; map?: string; partitionId?: string; content: string }) => post<{ task: Task }>("/api/maps/user-settings/raw", body),
  sietches: () => api<{ stdout: string }>("/api/sietches"),
  // exitCode is surfaced because commandJson answers 200 even when the CLI
  // fails: a caller that only reads stdout cannot tell "no sietches" from
  // "the command did not run".
  sietchDimensions: (map = "Survival_1", ids = false) => api<{ stdout: string; exitCode?: number }>(`/api/sietches/dimensions?map=${encodeURIComponent(map)}${ids ? "&ids=1" : ""}`),
  updateSietches: (body: Record<string, unknown>) => post<{ task: Task }>("/api/sietches/update", body),
  restartSietch: (partitionId: string) => post<{ task: Task }>("/api/sietches/update", { action: "restart", partitionId, confirmation: "RESTART SIETCH" }),
  deepdesert: () => api<{ stdout: string }>("/api/deepdesert"),
  updateDeepdesert: (body: { action: string; confirmation: string }) => post<{ task: Task }>("/api/deepdesert/update", body),
  combatState: (map: string) => api<MapCombatStateResult>(`/api/maps/combat-state?map=${encodeURIComponent(map)}`)
};
