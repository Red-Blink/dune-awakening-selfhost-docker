import { api, post } from "./client";

export type RefillDeviceResult = {
  placeableId: string;
  type: string;
  label: string;
  fuelName: string;
  before: number;
  after: number;
  added: number;
  capped?: boolean;
  skipped?: string;
};

export type QueuedRefill = {
  baseId: number;
  map: string;
  partitionId: number;
  queuedAt: string;
  attempts: number;
  lastError: string;
};

export type PendingRefills = {
  supported: boolean;
  total: number;
  pending: QueuedRefill[];
  byTarget: { map: string; partitionId: number; partitionMap: string; dimensionIndex: number; count: number }[];
};

export type AutoRefillBase = {
  baseId: number;
  enabledAt: string;
  lastCheckedAt: string;
  lastQueuedAt: string;
  // null when the base has no recognised generators, which is not the same as 0.
  lastLowestPercent: number | null;
  // Completed queue cycles that never brought the fuel back up. At the cap the
  // scan stops queueing this base and stamps stalledAt.
  consecutiveQueues: number;
  stalledAt: string;
};

export type AutoRefillState = {
  supported: boolean;
  thresholdPercent: number;
  intervalHours: number;
  nextRunAt: string;
  lastRunAt: string;
  lastRunStatus: string;
  lastRunDetail: string;
  total: number;
  bases: AutoRefillBase[];
};

// Water refill has no fuelName/capped/skipped concepts: it's a plain
// jsonb_set straight to capacity, not a stack of discrete inventory items.
export type RefillWaterDeviceResult = {
  placeableId: string;
  type: string;
  label: string;
  before: number;
  after: number;
  added: number;
};

export type WaterContainerEntry = {
  type: string;
  name: string;
  count: number;
  stored: number;
  capacity: number;
  percent: number;
  // Only present for Blood Purifier / Improved Blood Purifier -- their raw
  // blood input buffer, a completely different storage mechanism from water.
  bloodStored?: number;
  bloodCapacity?: number;
  bloodPercent?: number;
};

export type BaseWater = {
  supported: boolean;
  baseId: number;
  containers: WaterContainerEntry[];
  reason?: string;
};

export type AutoRefillWaterBase = {
  baseId: number;
  enabledAt: string;
  lastCheckedAt: string;
  lastQueuedAt: string;
  lastLowestPercent: number | null;
  consecutiveQueues: number;
  stalledAt: string;
};

export type AutoRefillWaterState = {
  supported: boolean;
  thresholdPercent: number;
  intervalHours: number;
  nextRunAt: string;
  lastRunAt: string;
  lastRunStatus: string;
  lastRunDetail: string;
  total: number;
  bases: AutoRefillWaterBase[];
};

// Storage containers plus the refining, crafting and machine inventories at a
// base. Generator and windtrap fuel is deliberately absent -- the Power and
// Water tabs own it.
export type BaseInventoryGroupKey = "storage" | "refining" | "crafting" | "machines";

export type BaseInventoryGroup = {
  key: BaseInventoryGroupKey;
  name: string;
  containerCount: number;
  itemCount: number;
};

// One item template's total inside one container. NOT a stack: the backend
// merges every dune.items row of the same template, so a container with 8
// occupied slots holding 3 templates yields 3 of these. Stack count is
// usedSlots.
export type BaseInventoryEntry = {
  templateId: string;
  name: string;
  quantity: number;
};

export type BaseInventoryContainer = {
  placeableId: string;
  // Empty until a player renames the placeable in-game: the game stores
  // '##' || building_type as the default, which the backend strips.
  name: string;
  typeName: string;
  group: BaseInventoryGroupKey;
  usedSlots: number;
  maxSlots: number;
  itemCount: number;
  items: BaseInventoryEntry[];
};

// How much of one item a single container holds. `name` is the container's,
// not the item's -- the item is the parent -- and is empty for a placeable the
// player has never renamed, same as BaseInventoryContainer.name.
export type BaseInventoryHolder = {
  placeableId: string;
  name: string;
  typeName: string;
  group: BaseInventoryGroupKey;
  quantity: number;
};

export type BaseInventoryItem = {
  templateId: string;
  // Falls back to templateId for anything missing from admin-items.json.
  name: string;
  image: string;
  category: string;
  quantity: number;
  containerCount: number;
  containers: BaseInventoryHolder[];
};

export type BaseInventory = {
  supported: boolean;
  baseId: number;
  groups: BaseInventoryGroup[];
  containers: BaseInventoryContainer[];
  items: BaseInventoryItem[];
  totals: { items: number; distinct: number; containers: number; usedSlots: number; maxSlots: number };
  reason?: string;
};

// rank 1/2/3 = Owner/Co-Owner/Associate, confirmed in both directions against a
// live server: the game's own Permissions panel writes exactly these values.
// The 5/4/3 badges the game UI shows beside those labels are decoration, not
// ranks -- no row in permission_actor_rank ever holds a 4 or 5.
export type BasePermissionRank = 1 | 2 | 3;

export type BasePermissionEntry = {
  playerId: string;
  name: string;
  rank: BasePermissionRank;
  label: string;
  // False when this row names an actor that is not the account's
  // player_controller_id. The game ignores such rows, but they are shown rather
  // than hidden -- it is a state the console can see and the game client cannot.
  canonical: boolean;
};

export type BasePermissions = {
  supported: boolean;
  baseId: number;
  actorId: string;
  map: string;
  mapNameId: number;
  systemCustodian?: {
    available: boolean;
    playerId?: string;
    name?: string;
    reason?: string;
  };
  entries: BasePermissionEntry[];
  reason?: string;
};

export type BasePermissionCandidate = { playerId: string; name: string };

export type SetBasePermissionsResult = {
  ok: boolean;
  baseId: number;
  actorId: string;
  map: string;
  added: number;
  reranked: number;
  removed: number;
  total: number;
  message: string;
};

export const basesApi = {
  list: (params: { q?: string; page?: number; pageSize?: number; sortColumn?: string; sortDirection?: "asc" | "desc" } = {}) => {
    const search = new URLSearchParams();
    if (params.q) search.set("q", params.q);
    if (params.page) search.set("page", String(params.page));
    if (params.pageSize) search.set("pageSize", String(params.pageSize));
    if (params.sortColumn) search.set("sortColumn", params.sortColumn);
    if (params.sortDirection) search.set("sortDirection", params.sortDirection);
    const qs = search.toString();
    return api<{ rows: Record<string, unknown>[]; totalCount: number; totalBases: number; totalPieces: number; totalPlaceables: number; capabilities: Record<string, unknown>; reason?: string }>(`/api/bases${qs ? `?${qs}` : ""}`);
  },
  // A refill for a map that is currently running comes back as
  // `result.queued`: the write is deferred to the next time that map is down.
  refillGenerators: (baseId: string) =>
    post<{
      supported: boolean;
      result?: {
        ok: boolean;
        baseId: number;
        queued?: boolean;
        map?: string;
        partitionId?: number;
        totalAdded?: number;
        devices?: RefillDeviceResult[];
      };
      reason?: string;
    }>(`/api/bases/${encodeURIComponent(baseId)}/refill-generators`, {}),
  cancelQueuedRefill: (baseId: string) =>
    api<{ supported: boolean; result?: { ok: boolean; baseId: number; pending: number }; reason?: string }>(
      `/api/bases/${encodeURIComponent(baseId)}/queued-refill`, { method: "DELETE" }),
  pendingRefills: () => api<PendingRefills>("/api/bases/pending-refills"),
  autoRefill: () => api<AutoRefillState>("/api/bases/auto-refill"),
  setAutoRefill: (baseId: string, enabled: boolean) =>
    post<{ ok: boolean; baseId: number; enabled: boolean; total: number }>(
      `/api/bases/${encodeURIComponent(baseId)}/auto-refill`, { enabled }),
  permissions: (baseId: string) =>
    api<BasePermissions>(`/api/bases/${encodeURIComponent(baseId)}/permissions`),
  // A whole roster, not a delta: the server diffs it against current state and
  // applies the difference through the game's own stored procedures in one
  // transaction. Changes reach a running map immediately -- no restart.
  setPermissions: (baseId: string, entries: { playerId: string; rank: BasePermissionRank }[]) =>
    api<{ supported: boolean; result?: SetBasePermissionsResult; reason?: string }>(
      `/api/bases/${encodeURIComponent(baseId)}/permissions`,
      { method: "PUT", body: JSON.stringify({ entries }) }),
  transferToSystemCustodian: (baseId: string) =>
    post<{ supported: boolean; result?: SetBasePermissionsResult; reason?: string }>(
      `/api/bases/${encodeURIComponent(baseId)}/system-custodian`, {}),
  permissionCandidates: (q: string, limit = 25) => {
    const search = new URLSearchParams();
    if (q) search.set("q", q);
    search.set("limit", String(limit));
    return api<{ supported: boolean; rows: BasePermissionCandidate[]; reason?: string }>(
      `/api/bases/permission-candidates?${search.toString()}`);
  },
  water: (baseId: string) =>
    api<BaseWater>(`/api/bases/${encodeURIComponent(baseId)}/water`),
  // Read-only. One response backs both the item rollup and the container
  // cards, so switching between them never refetches.
  inventory: (baseId: string) =>
    api<BaseInventory>(`/api/bases/${encodeURIComponent(baseId)}/inventory`),
  // A refill for a map that is currently running comes back as
  // `result.queued`: the write is deferred to the next time that map is down.
  refillWater: (baseId: string) =>
    post<{
      supported: boolean;
      result?: {
        ok: boolean;
        baseId: number;
        queued?: boolean;
        map?: string;
        partitionId?: number;
        totalAdded?: number;
        devices?: RefillWaterDeviceResult[];
      };
      reason?: string;
    }>(`/api/bases/${encodeURIComponent(baseId)}/refill-water`, {}),
  cancelQueuedWaterRefill: (baseId: string) =>
    api<{ supported: boolean; result?: { ok: boolean; baseId: number; pending: number }; reason?: string }>(
      `/api/bases/${encodeURIComponent(baseId)}/queued-water-refill`, { method: "DELETE" }),
  pendingWaterRefills: () => api<PendingRefills>("/api/bases/pending-water-refills"),
  autoRefillWater: () => api<AutoRefillWaterState>("/api/bases/auto-refill-water"),
  setAutoRefillWater: (baseId: string, enabled: boolean) =>
    post<{ ok: boolean; baseId: number; enabled: boolean; total: number }>(
      `/api/bases/${encodeURIComponent(baseId)}/auto-refill-water`, { enabled })
};
