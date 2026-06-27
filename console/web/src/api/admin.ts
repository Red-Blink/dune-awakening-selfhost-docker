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

export type CharacterTransferSettings = {
  ShouldDeleteOriginCharactersDuringTransfers: boolean;
  AcceptOutgoingCharacterTransfers: boolean;
  IncomingCharacterTransfers: number;
  ExportCharacterTimeout: number;
  ImportCharacterTimeout: number;
  FreeToTransferCharactersFrom: boolean;
  FreeToTransferCharactersTo: boolean;
  ValidateBeforeImportCharacterTimeout: number;
  ForceIsWorldClosed: boolean;
  ForceIsWorldClosingSoon: boolean;
};

export type IncomingCharacterTransferPolicy = {
  value: number;
  label: string;
};

export type MessageOfTheDaySettings = {
  enabled: boolean;
  title: string;
  message: string;
};

export type PlayerAnnouncementSettings = {
  joinEnabled: boolean;
  joinMessage: string;
  leaveEnabled: boolean;
  leaveMessage: string;
};

export const adminApi = {
  itemCatalog: (q = "", limit = 10000) => api<{ rows: ItemCatalogEntry[] }>(`/api/admin/items/catalog?q=${encodeURIComponent(q)}&limit=${encodeURIComponent(String(limit))}`),
  itemSearch: (q: string) => api<{ stdout: string }>(`/api/admin/items/search?q=${encodeURIComponent(q)}`),
  itemList: (category = "") => api<{ stdout: string }>(`/api/admin/items${category ? `?category=${encodeURIComponent(category)}` : ""}`),
  vehicles: (q = "") => api<{ stdout: string }>(`/api/admin/vehicles${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  structuredVehicles: () => api<{ vehicles: VehicleCatalogEntry[]; stdout?: string; stderr?: string }>("/api/admin/vehicles/structured"),
  skillModules: (q = "") => api<{ stdout: string }>(`/api/admin/skill-modules${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  history: () => api<{ stdout: string }>("/api/admin/history"),
  clearHistory: (scope: "all" | "admin-tools" = "all") => post<{ ok: boolean }>("/api/admin/history/clear", { scope }),
  characterTransferSettings: () => api<{ settings: CharacterTransferSettings; defaults: CharacterTransferSettings; policies: IncomingCharacterTransferPolicy[]; customized: boolean; path: string }>("/api/admin/character-transfer-settings"),
  saveCharacterTransferSettings: (settings: CharacterTransferSettings) => post<{ ok: boolean; settings: CharacterTransferSettings; task: Task }>("/api/admin/character-transfer-settings", { settings }),
  restoreCharacterTransferSettings: () => post<{ ok: boolean; settings: CharacterTransferSettings; task: Task }>("/api/admin/character-transfer-settings", { restoreDefaults: true }),
  messageOfTheDay: () => api<{ settings: MessageOfTheDaySettings; defaults: MessageOfTheDaySettings }>("/api/admin/message-of-the-day"),
  saveMessageOfTheDay: (settings: MessageOfTheDaySettings) => post<{ ok: boolean; settings: MessageOfTheDaySettings; defaults: MessageOfTheDaySettings }>("/api/admin/message-of-the-day", { settings }),
  restoreMessageOfTheDay: () => post<{ ok: boolean; settings: MessageOfTheDaySettings; defaults: MessageOfTheDaySettings }>("/api/admin/message-of-the-day", { restoreDefaults: true }),
  playerAnnouncements: () => api<{ settings: PlayerAnnouncementSettings; defaults: PlayerAnnouncementSettings }>("/api/admin/player-announcements"),
  savePlayerAnnouncements: (settings: PlayerAnnouncementSettings) => post<{ ok: boolean; settings: PlayerAnnouncementSettings; defaults: PlayerAnnouncementSettings }>("/api/admin/player-announcements", { settings }),
  restorePlayerAnnouncements: () => post<{ ok: boolean; settings: PlayerAnnouncementSettings; defaults: PlayerAnnouncementSettings }>("/api/admin/player-announcements", { restoreDefaults: true }),
  kickAllOnline: (confirmation: string) => post<{ task: Task }>("/api/players/kick-all-online", { confirmation }),
  broadcast: (title: string, body: string, durationSec: number) => post<{ supported: boolean; reason?: string; ok?: boolean; stdout?: string; stderr?: string; note?: string }>("/api/admin/broadcast", { title, body, durationSec }),
  mapChat: (mapName: string, dimension: number, body: string) => post<{ supported: boolean; reason?: string; ok?: boolean; stdout?: string; stderr?: string; note?: string }>("/api/admin/map-chat", { mapName, dimension, body })
};
