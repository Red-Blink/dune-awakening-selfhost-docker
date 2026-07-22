import { api, post } from "./client";
import type { Task } from "./setup";

export const updatesApi = {
  checkGame: (options: { fresh?: boolean } = {}) => post<{ task: Task }>("/api/updates/check-game", options.fresh ? { fresh: true } : {}),
  applyGame: () => post<{ task: Task }>("/api/updates/apply-game"),
  fixSteamcmd: () => post<{ task: Task }>("/api/updates/fix-steamcmd"),
  checkStack: () => post<{ task: Task }>("/api/updates/check-stack"),
  applyStack: () => post<{ task: Task }>("/api/updates/apply-stack"),
  autoGameStatus: () => api<{ stdout: string; stderr?: string; exitCode?: number }>("/api/updates/auto-game"),
  saveAutoGame: (body: {
    enabled: boolean;
    intervalMinutes: number;
    applyEnabled: boolean;
    notifyEnabled: boolean;
    notifyMinutes: number;
    waitUntilEmpty: boolean;
    maxWaitMinutes: number;
    confirmation: string;
  }) => post<{ task: Task }>("/api/updates/auto-game", body)
};
