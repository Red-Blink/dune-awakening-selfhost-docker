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

export const serverApi = {
  status: () => api<{ stdout: string }>("/api/server/status"),
  performance: () => api<PerformanceSnapshot>("/api/server/performance"),
  readiness: () => api<{ stdout: string; stderr?: string; exitCode?: number }>("/api/server/readiness"),
  ports: () => api<{ stdout: string }>("/api/server/ports"),
  services: () => api<{ stdout: string }>("/api/server/services"),
  doctor: () => api<{ stdout: string; stderr?: string; exitCode?: number }>("/api/server/doctor"),
  start: () => post<{ task: Task }>("/api/server/start"),
  stop: () => post<{ task: Task }>("/api/server/stop"),
  restart: () => post<{ task: Task }>("/api/server/restart"),
  restartService: (service: string) => post<{ task: Task }>("/api/server/restart-service", { service }),
  saveTitle: (title: string) => post<{ task: Task }>("/api/server/title", { title }),
  saveFuncomToken: (token: string) => post<{ task: Task }>("/api/server/funcom-token", { token }),
  checkFuncomToken: (since: string) => api<{ ok: boolean; mismatch: boolean; checkedSince: string; details?: string }>(`/api/server/funcom-token/check?since=${encodeURIComponent(since)}`),
  restartSchedule: () => api<{ stdout: string; stderr?: string; exitCode?: number }>("/api/server/restart-schedule"),
  saveRestartSchedule: (body: { enabled: boolean; time: string }) => post<{ task: Task }>("/api/server/restart-schedule", body)
};
