import { api } from "./client";
import type { DungeonRun } from "./players";

export type DungeonFilters = { dungeonId?: string; difficulty?: number | null; playerId?: string };

export type DungeonRunsPage = {
  capabilities: Record<string, unknown>;
  reason?: string;
  page?: number;
  pageSize?: number;
  totalCount?: number;
  totalRuns?: number;
  runs?: DungeonRun[];
};

export type DungeonLeaderboardEntry = { runCount: number; best: DungeonRun };
export type DungeonLeaderboard = { capabilities: Record<string, unknown>; reason?: string; entries?: DungeonLeaderboardEntry[] };

function filterQuery(filters: DungeonFilters, extra: Record<string, string> = {}) {
  const params = new URLSearchParams(extra);
  if (filters.dungeonId) params.set("dungeonId", filters.dungeonId);
  if (filters.difficulty !== undefined && filters.difficulty !== null) params.set("difficulty", String(filters.difficulty));
  if (filters.playerId) params.set("playerId", filters.playerId);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export const dungeonsApi = {
  runs: (filters: DungeonFilters & { page: number; pageSize: number }) =>
    api<DungeonRunsPage>(`/api/dungeons/runs${filterQuery(filters, { page: String(filters.page), pageSize: String(filters.pageSize) })}`),
  leaderboard: (filters: DungeonFilters = {}) => api<DungeonLeaderboard>(`/api/dungeons/leaderboard${filterQuery(filters)}`)
};
