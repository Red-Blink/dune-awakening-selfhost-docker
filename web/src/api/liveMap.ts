import { api } from "./client";

export type LiveMapMarker = {
  id: number | string;
  type: "player" | "vehicle" | "base" | "storage" | "service";
  name?: string;
  map?: string;
  partition_id?: number;
  x?: number;
  y?: number;
  z?: number;
  [key: string]: unknown;
};

export const liveMapApi = {
  capabilities: () => api<Record<string, unknown>>("/api/map/capabilities"),
  markers: (map = "") => api<{ rows: LiveMapMarker[]; overlays: Record<string, string>; capabilities: Record<string, unknown> }>(`/api/map/markers${map ? `?map=${encodeURIComponent(map)}` : ""}`),
  players: (map = "") => api<{ rows: LiveMapMarker[]; reason?: string }>(`/api/map/players${map ? `?map=${encodeURIComponent(map)}` : ""}`),
  bases: (map = "") => api<{ rows: LiveMapMarker[]; reason?: string }>(`/api/map/bases${map ? `?map=${encodeURIComponent(map)}` : ""}`),
  storage: (map = "") => api<{ rows: LiveMapMarker[]; reason?: string }>(`/api/map/storage${map ? `?map=${encodeURIComponent(map)}` : ""}`),
  services: (map = "") => api<{ rows: LiveMapMarker[]; reason?: string }>(`/api/map/services${map ? `?map=${encodeURIComponent(map)}` : ""}`)
};
