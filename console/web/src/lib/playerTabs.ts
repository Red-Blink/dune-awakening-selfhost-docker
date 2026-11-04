// What the `player` tier sees in the console (#1276). Hiding is cosmetic: the
// API refuses everything outside console/api/src/playerScope.js whatever the UI
// shows. This list only keeps a player from being offered pages that would
// answer 403. It deliberately has no Live Map or Maps page.
export const PLAYER_TABS = ["Home", "Players", "Guilds", "Bases", "Vehicles", "Storage"] as const;

export function isPlayerTier(tier: string | undefined | null) {
  return tier === "player";
}

// Whether `tab` may be shown for `tier`. Tiers other than player are not
// narrowed here (their nav is governed by allowedActions as before).
export function tabAllowedForTier(tab: string, tier: string | undefined | null) {
  return !isPlayerTier(tier) || (PLAYER_TABS as readonly string[]).includes(tab);
}
