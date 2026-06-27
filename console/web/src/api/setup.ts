import { api, post } from "./client";

export type Check = { name: string; status: "pass" | "warn" | "fail" | "info"; message: string; detail?: string };
export type Task = {
  id: string;
  type: string;
  operation: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  currentStep: string;
  progressMessage: string;
  logLines: { timestamp: string; stream: string; line: string }[];
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
};

export const setupApi = {
  state: () => api<{ files: Record<string, boolean>; config: Record<string, unknown>; serverConfig?: Record<string, unknown> }>("/api/setup/state"),
  preflight: () => post<{ checks: Check[]; summary: Record<string, number> }>("/api/setup/preflight"),
  writeConfig: (body: Record<string, string>) => post<{ ok: boolean }>("/api/setup/write-config", body),
  saveToken: (token: string) => post<{ ok: boolean }>("/api/setup/save-token", { token }),
  init: () => post<{ task: Task }>("/api/setup/init"),
  tasks: () => api<{ tasks: Task[] }>("/api/setup/tasks"),
  task: (id: string) => api<{ task: Task }>(`/api/setup/tasks/${id}`)
};
