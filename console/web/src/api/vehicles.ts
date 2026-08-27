import { api, post } from "./client";

export type VehicleModule = {
  templateId: string;
  name: string;
  condition: number | string | null;
  // Null when the DB holds <2 samples of this template_id, so no max can be
  // inferred -- render the raw condition with no bar in that case.
  maxCondition: number | string | null;
  conditionPercent: number | null;
  maxInferred?: boolean | null;
  // Server-flagged (isVehicleStorageModule) rather than matched here, so the
  // template-id pattern lives next to the query that reads the hold.
  isStorage?: boolean;
};

// One stack in a vehicle's cargo hold. Same shape as bases.ts's
// BaseInventorySlot -- deliberately, so the two contents overlays render
// identically -- plus `image`, which the vehicle route resolves itself
// because there is no vehicle equivalent of the base inventory rollup the
// bases tab harvests icons from.
export type VehicleStorageSlot = {
  itemId: string;
  templateId: string;
  name: string;
  image: string;
  positionIndex: number | null;
  quantity: number;
  qualityLevel: number;
  currentDurability: number | null;
  maxDurability: number | null;
  augments: { templateId: string; name: string; qualityLevel: number }[];
};

// A vehicle has exactly one cargo hold (dune.inventories.actor_id =
// vehicle id, inventory_type = 0), so this is flat where BaseContainerSlots
// carries an inventories[] array.
export type VehicleStorage = {
  supported: boolean;
  found?: boolean;
  reason?: string;
  vehicleId: string;
  inventoryId?: string;
  maxSlots?: number;
  usedSlots?: number;
  maxVolume?: number;
  currentVolume?: number;
  // False when at least one item's per-unit volume is unknown, so the
  // reported total is a lower bound -- rendered with a leading "≥".
  volumeComplete?: boolean;
  slots: VehicleStorageSlot[];
};

export type VehicleSharedEntry = { name: string; rank: number; label: string };

export type VehicleRow = {
  id: string;
  name: string;
  type: string;
  owner: string;
  relationship?: string | null;
  shared_with: VehicleSharedEntry[];
  condition_percent: number | null;
  condition_estimated?: boolean | null;
  // Null when fuel capacity cannot be inferred (<2 samples of the generator
  // template) -- render a muted dash, not a 0% bar.
  current_fuel: number | string | null;
  max_fuel: number | string | null;
  fuel_percent: number | null;
  map: string;
  partition_id: number;
  x: number | string | null;
  y: number | string | null;
  z: number | string | null;
  // Nearest-marker sub-region name for maps with a region table (e.g. Hagga
  // Basin). Absent for maps without one, or when marker data is unavailable.
  region?: string | null;
  modules: VehicleModule[];
};

export type VehiclesListResponse = {
  rows: VehicleRow[];
  totalCount: number;
  totalVehicles: number;
  capabilities: { vehicles?: boolean; vehiclePermissions?: boolean; vehicleDelete?: boolean; vehicleDeleteQueue?: boolean; vehicleStorage?: boolean } & Record<string, unknown>;
  reason?: string;
};

export type QueuedVehicleDelete = {
  vehicleId: number;
  map: string;
  partitionId: number;
  queuedAt: string;
  attempts: number;
  lastError: string;
};

// Own type rather than reusing bases.ts's PendingRefills -- that one is keyed
// on baseId, and per-resource duplication is this codebase's convention (see
// the vehicle delete queue's own comment in duneDb.js for the same reasoning
// applied server-side).
export type PendingVehicleDeletes = {
  supported: boolean;
  total: number;
  pending: QueuedVehicleDelete[];
  byTarget: { map: string; partitionId: number; partitionMap: string; dimensionIndex: number; count: number }[];
};

// rank 1/2/3 = Owner/Co-Owner/Associate, same semantics as base permissions --
// shared_with above already surfaces the rank label, this is just the editor's
// own type for the roster it reads and writes.
export type VehiclePermissionRank = 1 | 2 | 3;

export type VehiclePermissionEntry = {
  playerId: string;
  name: string;
  rank: VehiclePermissionRank;
  label: string;
  // False when this row names an actor that is not the account's
  // player_controller_id. The game ignores such rows, but they are shown
  // rather than hidden -- it is a state the console can see and the game
  // client cannot.
  canonical: boolean;
};

export type VehiclePermissions = {
  supported: boolean;
  vehicleId: number;
  actorId: string;
  map: string;
  mapNameId: number;
  // False when the vehicle has no dune.permission_actor row -- unclaimed, so
  // the permission table's foreign key rejects every write against it.
  // Optional so an older API that omits it reads as claimed, matching the
  // behaviour that existed before the flag rather than a new lockout.
  claimed?: boolean;
  unclaimedReason?: string;
  systemCustodian?: {
    available: boolean;
    canCreate?: boolean;
    playerId?: string;
    name?: string;
    reason?: string;
  };
  entries: VehiclePermissionEntry[];
  reason?: string;
};

export type VehiclePermissionCandidate = { playerId: string; name: string };

export type SetVehiclePermissionsResult = {
  ok: boolean;
  vehicleId: number;
  actorId: string;
  map: string;
  added: number;
  reranked: number;
  removed: number;
  total: number;
  message: string;
};

export const vehiclesApi = {
  list: (params: { q?: string; page?: number; pageSize?: number; sortColumn?: string; sortDirection?: "asc" | "desc" } = {}) => {
    const search = new URLSearchParams();
    if (params.q) search.set("q", params.q);
    if (params.page) search.set("page", String(params.page));
    if (params.pageSize) search.set("pageSize", String(params.pageSize));
    if (params.sortColumn) search.set("sortColumn", params.sortColumn);
    if (params.sortDirection) search.set("sortDirection", params.sortDirection);
    const qs = search.toString();
    return api<VehiclesListResponse>(`/api/vehicles${qs ? `?${qs}` : ""}`);
  },
  forPlayer: (playerId: string) => api<VehiclesListResponse>(`/api/players/${encodeURIComponent(playerId)}/vehicles`),
  permissions: (vehicleId: string) =>
    api<VehiclePermissions>(`/api/vehicles/${encodeURIComponent(vehicleId)}/permissions`),
  // Fetched when the contents overlay opens rather than folded into the list
  // response -- slots would roughly triple a payload that already loads a
  // whole page of vehicles. Same reasoning as basesApi.containerSlots.
  storage: (vehicleId: string) =>
    api<VehicleStorage>(`/api/vehicles/${encodeURIComponent(vehicleId)}/storage`),
  // A whole roster, not a delta: the server diffs it against current state and
  // applies the difference through the game's own stored procedures in one
  // transaction. Changes reach a running map immediately -- no restart.
  setPermissions: (vehicleId: string, entries: { playerId: string; rank: VehiclePermissionRank }[]) =>
    api<{ supported: boolean; result?: SetVehiclePermissionsResult; reason?: string }>(
      `/api/vehicles/${encodeURIComponent(vehicleId)}/permissions`,
      { method: "PUT", body: JSON.stringify({ entries }) }),
  permissionCandidates: (q: string, limit = 25) => {
    const search = new URLSearchParams();
    if (q) search.set("q", q);
    search.set("limit", String(limit));
    return api<{ supported: boolean; rows: VehiclePermissionCandidate[]; reason?: string }>(
      `/api/vehicles/permission-candidates?${search.toString()}`);
  },
  transferToSystemCustodian: (vehicleId: string) =>
    post<{ supported: boolean; result?: SetVehiclePermissionsResult; reason?: string }>(
      `/api/vehicles/${encodeURIComponent(vehicleId)}/system-custodian`, {}),
  // Permanently deletes the vehicle and everything on it. Like Delete Base, a
  // delete for a map that is currently running comes back as `result.queued`:
  // it is deferred to the next time that map is down, and a full database
  // backup happens automatically, immediately before the delete actually
  // runs -- never before, never skipped.
  deleteVehicle: (vehicleId: string) =>
    api<{
      supported: boolean;
      backupCreated: boolean;
      result?: {
        ok: boolean;
        vehicleId: number;
        queued?: boolean;
        map?: string;
        partitionId?: number;
        actorId?: string;
        deletedModuleCount?: number;
      };
      reason?: string;
    }>(`/api/vehicles/${encodeURIComponent(vehicleId)}`, { method: "DELETE", body: JSON.stringify({ confirmation: "DELETE VEHICLE" }) }),
  cancelQueuedDelete: (vehicleId: string) =>
    api<{ supported: boolean; result?: { ok: boolean; vehicleId: number; pending: number }; reason?: string }>(
      `/api/vehicles/${encodeURIComponent(vehicleId)}/queued-delete`, { method: "DELETE" }),
  pendingDeletes: () => api<PendingVehicleDeletes>("/api/vehicles/pending-deletes")
};
