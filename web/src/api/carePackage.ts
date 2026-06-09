import { api, post } from "./client";

export type StarterKitConfig = {
  enabled: boolean;
  version: string;
  activeKitId: string;
  autoGrantKitId: string;
  kits: StarterKitEntry[];
  items: { itemName?: string; itemId?: string; quantity: number; durability: number; image?: string }[];
  xp: number;
  allowRepeatGrants: boolean;
  autoGrantEnabled: boolean;
  autoGrantIntervalSeconds: number;
  grantWhen: "first_online" | "last_seen";
  autoGrantRules: StarterKitAutoGrantRule[];
};

export type StarterKitEntry = {
  id: string;
  name: string;
  items: { itemName?: string; itemId?: string; quantity: number; durability: number }[];
  xp: number;
  welcomeMessage?: string;
};

export type StarterKitAutoGrantRule = {
  id: string;
  enabled: boolean;
  kitId: string;
  grantWhen: "first_online" | "last_seen";
  lastSeenDays?: number;
};

export const starterKitApi = {
  capabilities: () => api<Record<string, unknown>>("/api/starter-kit/capabilities"),
  config: () => api<StarterKitConfig>("/api/starter-kit/config"),
  saveConfig: (config: StarterKitConfig, confirmation: string) => post<StarterKitConfig>("/api/starter-kit/config", { ...config, confirmation }),
  grants: () => api<{ rows: Record<string, unknown>[] }>("/api/starter-kit/grants"),
  history: () => api<{ rows: Record<string, unknown>[] }>("/api/starter-kit/history"),
  eligible: (ruleId?: string) => api<{ config: StarterKitConfig; rows: Record<string, unknown>[] }>(`/api/starter-kit/eligible${ruleId ? `?ruleId=${encodeURIComponent(ruleId)}` : ""}`),
  grantEligible: (confirmation: string) => post<Record<string, unknown>>("/api/starter-kit/grant-eligible", { confirmation }),
  run: (confirmation = "RUN STARTER KIT SCAN") => post<Record<string, unknown>>("/api/starter-kit/run", { confirmation }),
  grant: (playerId: string, confirmation: string, kitId?: string) => post<Record<string, unknown>>(`/api/starter-kit/grant/${encodeURIComponent(playerId)}`, { confirmation, kitId }),
  retry: (grantId: string, confirmation: string) => post<Record<string, unknown>>(`/api/starter-kit/retry/${encodeURIComponent(grantId)}`, { confirmation }),
  enable: (confirmation: string) => post<StarterKitConfig>("/api/starter-kit/enable", { confirmation }),
  disable: (confirmation: string) => post<StarterKitConfig>("/api/starter-kit/disable", { confirmation })
};
