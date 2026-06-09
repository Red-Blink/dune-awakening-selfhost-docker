import { api } from "./client";

export type LiveMapMarker = {
  id: number | string;
  type: "player" | "vehicle" | "base" | "storage";
  name?: string;
  map?: string;
  partition_id?: number;
  x?: number;
  y?: number;
  z?: number;
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
  markers: (map = "") => api<{ rows: LiveMapMarker[]; overlays: Record<string, string>; capabilities: Record<string, unknown>; map: LiveMapConfig; maps: Record<string, LiveMapConfig>; defaultMap: string; partitions: LiveMapPartition[] }>(`/api/map/markers${map ? `?map=${encodeURIComponent(map)}` : ""}`),
  partitions: () => api<{ rows: LiveMapPartition[] }>("/api/map/partitions"),
  players: (map = "") => api<{ rows: LiveMapMarker[]; reason?: string }>(`/api/map/players${map ? `?map=${encodeURIComponent(map)}` : ""}`),
  bases: (map = "") => api<{ rows: LiveMapMarker[]; reason?: string }>(`/api/map/bases${map ? `?map=${encodeURIComponent(map)}` : ""}`),
  storage: (map = "") => api<{ rows: LiveMapMarker[]; reason?: string }>(`/api/map/storage${map ? `?map=${encodeURIComponent(map)}` : ""}`),
  services: (map = "") => api<{ rows: LiveMapMarker[]; reason?: string }>(`/api/map/services${map ? `?map=${encodeURIComponent(map)}` : ""}`)
};
