import { api } from "./client";

export type CombatStats = {
  controllerId: string; name: string; kills: number; deaths: number;
  selfDeaths: number; otherDeaths: number; unknownDeaths: number; kd: number | null;
};
export type CombatRowLimit = 10 | 20 | 50 | "all";
export type CombatRowOptions = { leaderboardLimit: CombatRowLimit; killsLimit: CombatRowLimit };
export type CombatKill = {
  id: string; time: string; map: string; killerId: string | null; victimId: string | null;
  killer: string; victim: string;
};
export type CombatHistory = {
  supported: boolean; status: "starting" | "recording" | "paused" | "unavailable";
  reason: string; selfOnly: boolean; recordingStartedAt: string | null;
  recordedSince: string | null; lastCapturedAt: string | null;
  leaderboard: CombatStats[]; recentKills: CombatKill[];
};
export const combatApi = {
  history: (controllerId?: string, options?: CombatRowOptions) => {
    const query = new URLSearchParams();
    if (controllerId) query.set("controllerId", controllerId);
    if (options) {
      query.set("leaderboardLimit", String(options.leaderboardLimit));
      query.set("killsLimit", String(options.killsLimit));
    }
    return api<CombatHistory>(`/api/players/combat${query.size ? `?${query}` : ""}`, { cache: "no-store" });
  }
};
