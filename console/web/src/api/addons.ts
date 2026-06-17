import { api, post } from "./client";

export type CommunityAddonSummary = {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  sourceUrl: string;
  manifestUrl: string;
  lifecycle: AddonLifecycle;
  lifecycleMessage: string;
  lifecycleUrl: string;
  permissions: string[];
};

export type AddonLifecycle = "active" | "deprecated" | "unsupported" | "removed" | "blocked";

export type CommunityAddonsIndex = {
  schemaVersion: number;
  sourceUrl: string;
  updatedAt: string;
  addons: CommunityAddonSummary[];
};

export type InstalledAddon = {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  type: string;
  status: string;
  enabled: boolean;
  lifecycle: AddonLifecycle;
  lifecycleMessage: string;
  lifecycleUrl: string;
  entryPath: string;
  permissions: string[];
  approvedPermissions: string[];
};

export type LeadershipPlayer = {
  actorId: string;
  controllerId: string;
  name: string;
  level: number;
  faction: string;
  guild: string;
  status: string;
  map: string;
  lastSeen: string;
};

export const addonsApi = {
  community: () => api<CommunityAddonsIndex>("/api/addons/community"),
  installed: () => api<{ addons: InstalledAddon[] }>("/api/addons/installed"),
  installCommunity: (id: string, approvedPermissions: string[]) => post<{ ok: boolean; addon: InstalledAddon; sha256: string }>("/api/addons/community/install", { id, approvedPermissions }),
  enable: (id: string) => post<{ ok: boolean; addon: InstalledAddon }>(`/api/addons/installed/${encodeURIComponent(id)}/enable`),
  disable: (id: string) => post<{ ok: boolean; addon: InstalledAddon }>(`/api/addons/installed/${encodeURIComponent(id)}/disable`),
  remove: (id: string) => api<{ ok: boolean; id: string }>(`/api/addons/installed/${encodeURIComponent(id)}`, { method: "DELETE" }),
  bridge: (id: string, action: string, payload: Record<string, unknown> = {}) => post<{ ok: boolean; result: unknown }>(`/api/addons/installed/${encodeURIComponent(id)}/bridge`, { action, ...payload })
};
