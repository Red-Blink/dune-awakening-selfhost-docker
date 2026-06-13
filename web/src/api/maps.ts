import { api, post } from "./client";
import type { Task } from "./setup";

export type UserSettingField = {
  scope: "engine" | "game" | "partition" | "partitionEngine";
  id: string;
  section: string | null;
  key: string | null;
  default: string;
  type: "boolean" | "integer" | "number" | "text";
};

export type UserSettingsSchema = {
  engine: UserSettingField[];
  game: UserSettingField[];
  partition: UserSettingField[];
  partitionEngine: UserSettingField[];
};

export type LiveMapMemoryRow = {
  container: string;
  map: string;
  usedBytes: number;
  limitBytes: number;
  percent: number;
  raw: string;
};

export type SwapMemoryState = {
  enabled: boolean;
  running: boolean;
  lastMessage: string;
  lastAction: string;
  lastError: string;
  updatedAt: string | null;
};

export const mapsApi = {
  maps: () => api<{ stdout: string }>("/api/maps"),
  status: () => api<Record<string, { stdout?: string; stderr?: string; exitCode?: number }>>("/api/map/status"),
  mode: (map = "") => api<{ stdout: string }>(`/api/maps/mode${map ? `?map=${encodeURIComponent(map)}` : ""}`),
  setMode: (body: { map: string; mode: string; confirmation: string }) => post<{ task: Task }>("/api/maps/mode", body),
  saveMapSettings: (body: { map: string; partitionId?: string; mode?: string; memory?: string; modeChanged: boolean; memoryChanged: boolean; running: boolean; confirmation: string }) => post<{ task: Task }>("/api/maps/settings", body),
  reconcile: (confirmation: string) => post<{ task: Task }>("/api/maps/reconcile", { confirmation }),
  spawn: (target: string, confirmation: string) => post<{ task: Task }>("/api/maps/spawn", { target, confirmation }),
  despawn: (target: string, confirmation: string) => post<{ task: Task }>("/api/maps/despawn", { target, confirmation }),
  autoscaler: () => api<{ stdout: string }>("/api/maps/autoscaler"),
  autoscalerAction: (action: string, confirmation: string) => post<{ task: Task }>("/api/maps/autoscaler", { action, confirmation }),
  memory: () => api<{ stdout: string }>("/api/maps/memory"),
  liveMemory: () => api<{ rows: LiveMapMemoryRow[]; sampledAt: string; error?: string }>("/api/maps/memory/live"),
  swapMemory: () => api<SwapMemoryState>("/api/maps/memory/swap"),
  setSwapMemory: (enabled: boolean) => post<SwapMemoryState>("/api/maps/memory/swap", { enabled }),
  setMemory: (body: { map: string; memory: string; confirmation: string }) => post<{ task: Task }>("/api/maps/memory", { ...body, action: "set" }),
  unsetMemory: (body: { map: string; confirmation: string }) => post<{ task: Task }>("/api/maps/memory", { ...body, action: "unset" }),
  userEngine: () => api<{ stdout: string; stderr?: string; exitCode?: number }>("/api/maps/userengine"),
  userGame: (map: string, partitionId?: string) => api<{ stdout: string; stderr?: string; exitCode?: number }>(`/api/maps/usergame?map=${encodeURIComponent(map)}${partitionId ? `&partitionId=${encodeURIComponent(partitionId)}` : ""}`),
  userSettingsSchema: () => api<UserSettingsSchema>("/api/maps/user-settings/schema"),
  rawUserSettings: (kind: "engine" | "game" | "profile", map?: string, partitionId?: string) => api<{ content: string }>(`/api/maps/user-settings/raw?kind=${encodeURIComponent(kind)}${map ? `&map=${encodeURIComponent(map)}` : ""}${partitionId ? `&partitionId=${encodeURIComponent(partitionId)}` : ""}`),
  saveUserSettings: (body: { scope: "engine" | "global" | "map" | "partition"; map?: string; partitionId?: string; values: Record<string, string> }) => post<{ task: Task }>("/api/maps/user-settings/save", body),
  resetUserSettings: (body: { scope: "engine" | "global" | "map" | "partition"; map?: string; partitionId?: string; confirmation: string }) => post<{ task: Task }>("/api/maps/user-settings/reset", body),
  saveRawUserSettings: (body: { scope: "engine" | "game" | "global" | "profile"; map?: string; partitionId?: string; content: string }) => post<{ task: Task }>("/api/maps/user-settings/raw", body),
  materializeUserSettings: (confirmation: string) => post<{ task: Task }>("/api/maps/user-settings/materialize", { confirmation }),
  restoreUserSettingsDefaults: (confirmation: string) => post<{ supported: boolean; reason: string }>("/api/maps/user-settings/restore-defaults", { confirmation }),
  sietches: () => api<{ stdout: string }>("/api/sietches"),
  sietchDimensions: (map = "Survival_1", ids = false) => api<{ stdout: string }>(`/api/sietches/dimensions?map=${encodeURIComponent(map)}${ids ? "&ids=1" : ""}`),
  updateSietches: (body: Record<string, unknown>) => post<{ task: Task }>("/api/sietches/update", body),
  deepdesert: () => api<{ stdout: string }>("/api/deepdesert"),
  updateDeepdesert: (body: { action: string; confirmation: string }) => post<{ task: Task }>("/api/deepdesert/update", body)
};
