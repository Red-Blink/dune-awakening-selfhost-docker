import { api, post } from "./client";
import type { Task } from "./setup";

export const backupsApi = {
  list: () => api<{ stdout: string; rows?: Record<string, unknown>[] }>("/api/backups"),
  create: () => post<{ task: Task }>("/api/backups/create"),
  restore: (backup: string) => post<{ task: Task }>("/api/backups/restore", { backup }),
  delete: (backup: string) => api<{ task: Task }>(`/api/backups/${encodeURIComponent(backup)}`, { method: "DELETE" }),
  deleteAll: () => post<{ task: Task }>("/api/backups/delete-all"),
  downloadUrl: (backup: string) => `/api/backups/${encodeURIComponent(backup)}/download`,
  importExternal: (form: FormData) => api<{ ok: boolean; row?: Record<string, unknown>; rows?: Record<string, unknown>[] }>("/api/backups/import-external", { method: "POST", body: form }),
  autoStatus: () => api<{ stdout: string; stderr?: string; exitCode?: number; status?: Record<string, unknown> }>("/api/backups/auto"),
  saveAuto: (body: { enabled: boolean; time: string; retentionDays: number }) => post<{ task: Task }>("/api/backups/auto", body),
  importRemote: (body: { host: string; user: string; path: string; port?: number }) => post<{ supported: boolean; reason: string }>("/api/backups/import-remote", body)
};
