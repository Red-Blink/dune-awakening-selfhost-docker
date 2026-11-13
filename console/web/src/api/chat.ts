import { api, post } from "./client";

export type ChatSettings = { enabled: boolean; retentionDays: number };
export type ChatRow = { id: string; capturedAt: string; channel: string; sender: string; senderName: string; context: string; text: string };
export type ChatHistory = {
  settings: ChatSettings; state: string; lastCheckedAt: string | null; maxRows: number; maxBytes: number;
  channels: string[]; canConfigure: boolean;
  rows: ChatRow[]; total: number; page: number; limit: number;
};
export const chatApi = {
  history: (query: { q: string; context: string; channel: string; page: number; limit: number }) => {
    const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
    return api<ChatHistory>(`/api/chat/history?${params}`, { cache: "no-store" });
  },
  save: (settings: ChatSettings) => post("/api/chat/settings", settings),
  clear: () => api("/api/chat/history", { method: "DELETE" })
};
