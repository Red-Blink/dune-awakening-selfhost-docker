import { api } from "./client";

export const guildsApi = {
  list: (q = "") => api<{ rows: Record<string, unknown>[]; capabilities: Record<string, unknown>; reason?: string }>(`/api/guilds${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  members: (guildId: string) => api<{ rows: Record<string, unknown>[]; capabilities: Record<string, unknown>; reason?: string }>(`/api/guilds/${encodeURIComponent(guildId)}/members`)
};
