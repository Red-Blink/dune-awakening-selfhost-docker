import { api, post } from "./client";
import type { Task } from "./setup";

export type LiveMapMarker = {
  id: number | string;
  type: "player" | "vehicle" | "base" | "storage" | "spice" | "spice_active" | "flour_sand" | "ore" | "scrap" | "flora" | "poi" | "house_representative" | "trainer" | "fortress" | "hazard" | "enemy";
  name?: string;
  owner_name?: string;
  base_type?: string;
  map?: string;
  partition_id?: number;
  x?: number;
  y?: number;
  z?: number;
  confidence?: string;
  subtype?: string;
  [key: string]: unknown;
};

export type LiveMapConfig = {
  key: string;
  label: string;
  actorMap: string;
  image: string;
  width: number;
  height: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  flipY: boolean;
  defaultPartitionId: number | string;
};

export type LiveMapPartition = {
  map: string;
  partition_id: number;
  name: string;
  marker_count: number;
};

export const liveMapApi = {
  capabilities: () => api<Record<string, unknown>>("/api/map/capabilities"),
  markers: (map = "", partitionId = "", includeStatic = true) => {
    const params = new URLSearchParams();
    if (map) params.set("map", map);
    if (partitionId) params.set("partitionId", partitionId);
    if (!includeStatic) params.set("static", "0");
    const query = params.toString();
    return api<{ rows: LiveMapMarker[]; overlays: Record<string, string>; capabilities: Record<string, unknown>; map: LiveMapConfig; maps: Record<string, LiveMapConfig>; defaultMap: string; partitions: LiveMapPartition[]; coriolisSeed?: string; coriolisNextCycleAt?: string; coriolisSeedStaleSince?: string }>(`/api/map/markers${query ? `?${query}` : ""}`);
  },
  teleportPlayer: (body: { playerId: string; x: number; y: number; z: number; yaw?: number; partitionId?: number; online?: boolean }) => post<{ ok?: boolean; task?: Task; message?: string; path?: "live" | "offline"; supported?: boolean; reason?: string }>("/api/map/teleport-player", body),
  partitions: () => api<{ rows: LiveMapPartition[] }>("/api/map/partitions"),
  players: (map = "") => api<{ rows: LiveMapMarker[]; reason?: string }>(`/api/map/players${map ? `?map=${encodeURIComponent(map)}` : ""}`),
  bases: (map = "") => api<{ rows: LiveMapMarker[]; reason?: string }>(`/api/map/bases${map ? `?map=${encodeURIComponent(map)}` : ""}`),
  storage: (map = "") => api<{ rows: LiveMapMarker[]; reason?: string }>(`/api/map/storage${map ? `?map=${encodeURIComponent(map)}` : ""}`),
  services: (map = "") => api<{ rows: LiveMapMarker[]; reason?: string }>(`/api/map/services${map ? `?map=${encodeURIComponent(map)}` : ""}`),
  spice: (map = "") => api<{ rows: LiveMapMarker[]; reason?: string; currentSeed?: string; generatedAt?: string }>(`/api/map/spice${map ? `?map=${encodeURIComponent(map)}` : ""}`)
};
