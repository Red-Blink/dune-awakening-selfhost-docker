import { api, post } from "./client";
import type { Task } from "./setup";

export type StackUpdateProgress = {
  runId: string;
  state: "pending" | "running" | "succeeded" | "failed";
  stage: string;
  percent: number;
  message: string;
  startedAt?: string | null;
  updatedAt?: string | null;
  finishedAt?: string | null;
  // dune-awakening-selfhost-docker#748+: written by self-update.sh's
  // verify_discord_adapter_health() after a Discord Bot Settings enable/
  // role-ID-change container recreate -- see that function's own comment.
  discordHealthOk?: boolean | null;
  recovered?: boolean;
  consoleStartedAt?: string | null;
  consoleReplaced?: boolean;
};

export type QaChannel = { channel: "qa" | "release"; label: string; commitSha: string; shortSha: string; installedAt?: string | null };
export type QaStatus = {
  authenticated: boolean;
  status: "signed_out" | "pending" | "authorized" | "denied";
  reason?: string;
  requestId?: string;
  expiresAt?: string;
  user?: { id: string; username: string; avatarUrl?: string; role: "Founder" | "Core Contributor" | "QA Tester" } | null;
  channel: QaChannel;
};
export type QaBuild = {
  sha: string;
  shortSha: string;
  commitUrl?: string;
  committedAt?: string | null;
  ready: boolean;
  status: string;
  reason?: string;
  installedSha: string;
  commitsAheadOfRelease: number;
  updateAvailable: boolean;
  channel: QaChannel;
};

export const updatesApi = {
  checkGame: (options: { fresh?: boolean } = {}) => post<{ task: Task }>("/api/updates/check-game", options.fresh ? { fresh: true } : {}),
  applyGame: () => post<{ task: Task }>("/api/updates/apply-game"),
  fixSteamcmd: () => post<{ task: Task }>("/api/updates/fix-steamcmd"),
  checkStack: () => post<{ task: Task }>("/api/updates/check-stack"),
  applyStack: () => post<{ task: Task }>("/api/updates/apply-stack"),
  qaStatus: (refresh = false) => api<QaStatus>(`/api/updates/qa/status${refresh ? "?refresh=1" : ""}`, { cache: "no-store" }),
  qaLogin: () => post<{ requestId: string; authorizeUrl: string; status: string }>("/api/updates/qa/login"),
  qaLogout: () => post<{ ok: boolean }>("/api/updates/qa/logout"),
  qaBuild: () => api<QaBuild>("/api/updates/qa/build", { cache: "no-store" }),
  applyQa: () => post<{ task: Task }>("/api/updates/qa/apply"),
  reinstallRelease: () => post<{ task: Task }>("/api/updates/qa/reinstall-release"),
  stackProgress: (runId: string, startedAt?: string | null) => {
    const query = new URLSearchParams({ runId });
    if (startedAt) query.set("startedAt", startedAt);
    return api<StackUpdateProgress>(`/api/updates/stack-progress?${query.toString()}`, { cache: "no-store" });
  },
  autoGameStatus: () => api<{ stdout: string; stderr?: string; exitCode?: number }>("/api/updates/auto-game"),
  saveAutoGame: (body: {
    enabled: boolean;
    intervalMinutes: number;
    applyEnabled: boolean;
    notifyEnabled: boolean;
    notifyMinutes: string;
    waitUntilEmpty: boolean;
    maxWaitMinutes: number;
    confirmation: string;
  }) => post<{ task: Task }>("/api/updates/auto-game", body)
};
