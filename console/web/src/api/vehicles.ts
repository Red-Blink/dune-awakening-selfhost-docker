import { api } from "./client";

export type VehicleModule = {
  templateId: string;
  name: string;
  condition: number | string | null;
  // Null when the DB holds <2 samples of this template_id, so no max can be
  // inferred -- render the raw condition with no bar in that case.
  maxCondition: number | string | null;
  conditionPercent: number | null;
  maxInferred?: boolean | null;
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
  capabilities: { vehicles?: boolean; vehiclePermissions?: boolean } & Record<string, unknown>;
  reason?: string;
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
  }
};
