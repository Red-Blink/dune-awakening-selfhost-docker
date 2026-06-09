import { api, post } from "./client";

export const worldDataApi = {
  storage: () => api<{ rows: Record<string, unknown>[]; capabilities: Record<string, unknown>; reason?: string }>("/api/storage"),
  storageItems: (id: string) => api<{ rows: Record<string, unknown>[]; capabilities: Record<string, unknown>; reason?: string }>(`/api/storage/${encodeURIComponent(id)}/items`),
  storageGiveItem: (id: string, body: { itemName: string; quantity: number; confirmation: string }) => post<{ supported: boolean; result?: Record<string, unknown>; reason?: string }>(`/api/storage/${encodeURIComponent(id)}/give-item`, body),
  storageExportUrl: (id: string) => `/api/storage/${encodeURIComponent(id)}/export`
};
