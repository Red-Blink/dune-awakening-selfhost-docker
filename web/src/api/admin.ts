import { api, post } from "./client";
import type { Task } from "./setup";

export type VehicleCatalogEntry = {
  id: string;
  name: string;
  actor?: string;
  templates: string[];
};

export type ItemCatalogEntry = {
  id: string;
  itemId: string;
  name: string;
  category: string;
  source: string;
  image?: string;
};

export const adminApi = {
  itemCatalog: (q = "", limit = 10000) => api<{ rows: ItemCatalogEntry[] }>(`/api/admin/items/catalog?q=${encodeURIComponent(q)}&limit=${encodeURIComponent(String(limit))}`),
  itemSearch: (q: string) => api<{ stdout: string }>(`/api/admin/items/search?q=${encodeURIComponent(q)}`),
  itemList: (category = "") => api<{ stdout: string }>(`/api/admin/items${category ? `?category=${encodeURIComponent(category)}` : ""}`),
  vehicles: (q = "") => api<{ stdout: string }>(`/api/admin/vehicles${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  structuredVehicles: () => api<{ vehicles: VehicleCatalogEntry[]; stdout?: string; stderr?: string }>("/api/admin/vehicles/structured"),
  skillModules: (q = "") => api<{ stdout: string }>(`/api/admin/skill-modules${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  history: () => api<{ stdout: string }>("/api/admin/history"),
  kickAllOnline: (confirmation: string) => post<{ task: Task }>("/api/players/kick-all-online", { confirmation }),
  broadcast: (message: string, durationSec: number) => post<{ supported: boolean; reason?: string; ok?: boolean; stdout?: string; stderr?: string; note?: string }>("/api/admin/broadcast", { message, durationSec }),
  shutdownBroadcast: (body: { confirmation: string; delayMinutes: number; shutdownType: string }) => post<{ supported: boolean; reason?: string; ok?: boolean; stdout?: string; stderr?: string; note?: string }>("/api/admin/broadcast-shutdown", body),
  whisper: (playerId: string, message: string) => post<{ supported: false; reason: string }>("/api/admin/whisper", { playerId, message })
};
