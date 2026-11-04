import { api, post } from "./client";
import type { Task } from "./setup";

export type PerformanceSnapshot = {
  cpuPercent: number | null;
  memory: { usedBytes: number; totalBytes: number; availableBytes: number; percent: number | null };
  disk: { usedBytes: number; totalBytes: number; freeBytes: number; percent: number | null };
  uptimeSeconds: number;
  uptime: string;
  sampledAt: string;
};

export type RestartMessageTemplate = { title: string; body: string };

export type RestartMessages = { battlegroup: RestartMessageTemplate; map: RestartMessageTemplate };

export type RestartQueueSettings = {
  enabled: boolean;
  defaultCountdownMinutes: number;
  broadcastCheckpoints: number[];
  broadcastDurationSec: number;
  recoveryGraceMinutes: number;
  messages: RestartMessages;
};

export type RestartQueueEntry = {
  id: string;
  status: "counting" | "restarting";
  target: "battlegroup" | "map" | "service";
  mapLabel: string;
  requestedBy: string;
  startedAt: string;
  restartAt: number;
  countdownMinutes: number;
  remainingSeconds: number;
  sentCheckpoints: number[];
};

export type RestartQueueState = { entries: RestartQueueEntry[] };

export type RestartQueueResponse = {
  settings: RestartQueueSettings;
  defaults: RestartQueueSettings;
  state: RestartQueueState;
  // Scoped to `target` when one was passed to restartQueue(); otherwise the
  // same as battlegroupPlayersOnline.
  playersOnline: number | null;
  // Always battlegroup-wide, so a scoped query can still show "X on this map,
  // Y in the battlegroup" for context.
  battlegroupPlayersOnline: number | null;
  playersOnlineSupported: boolean;
};

export type RestartHistoryRow = {
  id: string;
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
  scope: "battlegroup" | "map" | "service";
  target: string;
  map: string;
  partitionId: string;
  source: string;
  reason: string;
  result: "Succeeded" | "Failed";
};

export type RestartHistoryResponse = {
  rows: RestartHistoryRow[];
  lastBattlegroupRestart: RestartHistoryRow | null;
};

export type RestartQueueTarget = { partitionId?: string | number; map?: string };

export type ServerStatusResponse = {
  operation: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  schemaVersion: 1;
  ok: boolean;
  data: {
    summary: {
      overall: string | null;
      title: string | null;
      region: string | null;
      mode: string | null;
      serverIp: string | null;
      battlegroup: string | null;
      population: { current: number | null; capacity: number | null };
    };
    containers: Array<{ name: string; status: string }>;
    listeners: Array<{ name: string; port: number | null; protocol: string; status: string }>;
    database: { worldPartitions: number | null };
    gameServers: Array<{ map: string; status: string; uptime: string }>;
    automation: { autoscaler: string | null; autoUpdates: string | null };
    rabbitmq: {
      directorConnections: number | null;
      gameServerConnections: number | null;
      textRouterConnections: number | null;
      details: string | null;
    };
    fls: {
      directorHeartbeat: string | null;
      populationDeclaration: string | null;
      maxCapacityDeclaration: string | null;
      gatewayDbMonitoring: string | null;
    };
  };
};

// The backend now merges a partial body onto the currently persisted
// settings (see restartQueue.js saveSettings), so every field here is
// optional -- a caller sends only what it actually changed (e.g. the
// messages editor sends only `messages`).
export type SaveRestartQueueBody = {
  enabled?: boolean;
  defaultCountdownMinutes?: number;
  broadcastCheckpoints?: number[] | string;
  broadcastDurationSec?: number;
  recoveryGraceMinutes?: number;
  messages?: RestartMessages;
};

// A gated restart endpoint returns the normal { task } when it runs, or
// { queued: true, ... } when the Restart Queue captured it into a countdown.
export type RestartDispatchResponse = {
  task?: Task;
  queued?: boolean;
  online?: number;
  entryId?: string;
  state?: RestartQueueState;
};

function immediateQuery(immediate?: boolean) {
  return immediate ? "?restartQueue=immediate" : "";
}

// sampledAt is when the command actually ran, which is what Home dates its
// freshness line from -- a cache hit must not claim to be current.
export type StatusStamp = { sampledAt?: string; fromCache?: boolean };
export type StatusRead = { stdout: string; stderr?: string; exitCode?: number } & StatusStamp;

function freshQuery(fresh?: boolean) {
  return fresh ? "?fresh=1" : "";
}

export const serverApi = {
  // `fresh` bypasses the API's status cache. Required whenever the answer
  // drives the restart lifecycle: a cached pre-restart snapshot would let
  // isHomeActionComplete call a restart finished before it had started.
  status: (opts?: { fresh?: boolean }) => api<ServerStatusResponse & StatusStamp>(`/api/server/status${freshQuery(opts?.fresh)}`),
  performance: () => api<PerformanceSnapshot>("/api/server/performance"),
  restartHistory: () => api<RestartHistoryResponse>("/api/server/restart-history"),
  readiness: (opts?: { fresh?: boolean }) => api<StatusRead>(`/api/server/readiness${freshQuery(opts?.fresh)}`),
  ports: () => api<{ stdout: string }>("/api/server/ports"),
  services: () => api<{ stdout: string }>("/api/server/services"),
  doctor: () => api<{ stdout: string; stderr?: string; exitCode?: number }>("/api/server/doctor"),
  fixNetworkBinding: () => post<{ task: Task }>("/api/server/network-bind/fix"),
  // Recreates the Console container so it reads a changed .env. The request
  // is answered before the container goes away; the caller then waits for the
  // Console to answer again rather than for a task result.
  reloadConsole: () => post<{ task: Task }>("/api/console/reload"),
  cleanupDockerImages: () => post<{ task: Task }>("/api/server/storage/cleanup-images", { confirmation: "CLEAN UNUSED DOCKER IMAGES" }),
  cleanupDockerBuildCache: () => post<{ task: Task }>("/api/server/storage/cleanup-build-cache", { confirmation: "CLEAN DOCKER BUILD CACHE" }),
  start: () => post<{ task: Task }>("/api/server/start"),
  stop: () => post<{ task: Task }>("/api/server/stop"),
  restart: (opts?: { immediate?: boolean }) => post<RestartDispatchResponse>(`/api/server/restart${immediateQuery(opts?.immediate)}`),
  restartService: (service: string, opts?: { immediate?: boolean }) => post<RestartDispatchResponse>(`/api/server/restart-service${immediateQuery(opts?.immediate)}`, { service }),
  saveConfig: (body: { title?: string; mode?: "public" | "local" }) => post<{ task: Task }>("/api/server/config", body),
  saveFuncomToken: (token: string) => post<{ task: Task }>("/api/server/funcom-token", { token }),
  checkFuncomToken: (since: string) => api<{ ok: boolean; mismatch: boolean; checkedSince: string; details?: string }>(`/api/server/funcom-token/check?since=${encodeURIComponent(since)}`),
  restartSchedule: () => api<{ stdout: string; stderr?: string; exitCode?: number }>("/api/server/restart-schedule"),
  saveRestartSchedule: (body: { enabled: boolean; time: string; notifyMinutes?: number }) => post<{ task: Task }>("/api/server/restart-schedule", body),
  restartQueue: (target?: RestartQueueTarget) => {
    const params = new URLSearchParams();
    if (target?.partitionId) params.set("partitionId", String(target.partitionId));
    if (target?.map) params.set("map", target.map);
    const query = params.toString();
    return api<RestartQueueResponse>(`/api/server/restart-queue${query ? `?${query}` : ""}`);
  },
  saveRestartQueue: (body: SaveRestartQueueBody) => post<{ ok: boolean; settings: RestartQueueSettings; defaults: RestartQueueSettings; state: RestartQueueState }>("/api/server/restart-queue", body),
  cancelRestartQueue: (body: { id: string }) => post<{ ok: boolean; state: RestartQueueState }>("/api/server/restart-queue/cancel", body),
  restartQueueRestartNow: (body: { id: string }) => post<{ ok: boolean; state: RestartQueueState }>("/api/server/restart-queue/restart-now", body),
  ipChangeRestart: () => api<{ stdout: string; stderr?: string; exitCode?: number }>("/api/server/ip-change-restart"),
  saveIpChangeRestart: (body: { enabled: boolean; intervalMinutes?: number; notifyMinutes?: number }) => post<{ task: Task }>("/api/server/ip-change-restart", body),
  checkIpChangeRestartNow: () => post<{ task: Task }>("/api/server/ip-change-restart/check"),
  shutdownProtection: () => api<{ stdout: string; stderr?: string; exitCode?: number }>("/api/server/shutdown-protection"),
  saveShutdownProtection: (body: { enabled: boolean }) => post<{ task: Task }>("/api/server/shutdown-protection", body),
  removeShutdownProtection: () => post<{ task: Task }>("/api/server/shutdown-protection/remove")
};
