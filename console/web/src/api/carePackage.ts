import { api, post } from "./client";

export type CarePackageConfig = {
  enabled: boolean;
  version: string;
  activeKitId: string;
  autoGrantKitId: string;
  kits: CarePackageEntry[];
  items: { itemName?: string; itemId?: string; quantity: number; durability?: number; quality?: number; grade?: number; image?: string; category?: string; source?: string; augments?: string[]; augmentQuality?: number }[];
  xp: number;
  allowRepeatGrants: boolean;
  autoGrantEnabled: boolean;
  autoGrantIntervalSeconds: number;
  grantWhen: "first_online" | "last_seen";
  autoGrantRules: CarePackageAutoGrantRule[];
};

export type CarePackageEntry = {
  id: string;
  name: string;
  items: { itemName?: string; itemId?: string; quantity: number; durability?: number; quality?: number; grade?: number; image?: string; category?: string; source?: string; augments?: string[]; augmentQuality?: number }[];
  xp: number;
  sendMessage?: string;
};

export type CarePackageAutoGrantRule = {
  id: string;
  enabled: boolean;
  kitId: string;
  grantWhen: "first_online" | "last_seen";
  lastSeenDays?: number;
};

export const carePackageApi = {
  capabilities: () => api<Record<string, unknown>>("/api/care-package/capabilities"),
  config: () => api<CarePackageConfig>("/api/care-package/config"),
  saveConfig: (config: CarePackageConfig, confirmation: string) => post<CarePackageConfig>("/api/care-package/config", { ...config, confirmation }),
  grants: () => api<{ rows: Record<string, unknown>[] }>("/api/care-package/grants"),
  history: () => api<{ rows: Record<string, unknown>[] }>("/api/care-package/history"),
  eligible: (ruleId?: string, onlyEligible = false) => {
    const params = new URLSearchParams();
    if (ruleId) params.set("ruleId", ruleId);
    if (onlyEligible) params.set("onlyEligible", "1");
    return api<{ config: CarePackageConfig; rows: Record<string, unknown>[] }>(`/api/care-package/eligible${params.size ? `?${params.toString()}` : ""}`);
  },
  grantEligible: (confirmation: string) => post<Record<string, unknown>>("/api/care-package/grant-eligible", { confirmation }),
  run: (confirmation = "RUN CARE PACKAGE SCAN") => post<Record<string, unknown>>("/api/care-package/run", { confirmation }),
  grant: (playerId: string, confirmation: string, kitId?: string) => post<Record<string, unknown>>(`/api/care-package/grant/${encodeURIComponent(playerId)}`, { confirmation, kitId }),
  retry: (grantId: string, confirmation: string) => post<Record<string, unknown>>(`/api/care-package/retry/${encodeURIComponent(grantId)}`, { confirmation }),
  clearHistory: (confirmation = "CLEAR GRANT HISTORY") => post<{ ok: boolean; removed: number; rows: Record<string, unknown>[] }>("/api/care-package/history/clear", { confirmation }),
  enable: (confirmation: string) => post<CarePackageConfig>("/api/care-package/enable", { confirmation }),
  disable: (confirmation: string) => post<CarePackageConfig>("/api/care-package/disable", { confirmation })
};
