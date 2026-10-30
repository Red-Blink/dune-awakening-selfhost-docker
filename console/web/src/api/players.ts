import { api, post } from "./client";
import type { Task } from "./setup";

type PlayersListResult = { rows: Record<string, unknown>[]; totalCount: number; totalPlayers: number; capabilities: Record<string, unknown>; reason?: string };

export type PlayerListSettings = {
  settings: { inactiveWeeks: number | null };
  defaults: { inactiveWeeks: number | null };
  limits: { inactiveWeeks: { min: number; max: number } };
  source: "default" | "console";
  canConfigure?: boolean;
};

const PLAYERS_ALL_PAGE_SIZE = 200;

export const playersApi = {
  list: (params: { q?: string; page?: number; pageSize?: number; status?: "all" | "online" | "offline" | "banned"; sortColumn?: string; sortDirection?: "asc" | "desc"; recentOnly?: boolean } = {}) => {
    const search = new URLSearchParams();
    if (params.q) search.set("q", params.q);
    if (params.page !== undefined) search.set("page", String(params.page));
    if (params.pageSize !== undefined) search.set("pageSize", String(params.pageSize));
    if (params.status) search.set("status", params.status);
    if (params.sortColumn) search.set("sortColumn", params.sortColumn);
    if (params.sortDirection) search.set("sortDirection", params.sortDirection);
    if (params.recentOnly) search.set("recentOnly", "1");
    const qs = search.toString();
    return api<PlayersListResult>(`/api/players${qs ? `?${qs}` : ""}`);
  },
  // Fetches every matching player (not one UI page) for dropdowns/bulk actions/counts —
  // loops the paginated endpoint since the backend caps a single page at 200 rows.
  listAll: async (params: { q?: string; status?: "all" | "online" | "offline" | "banned" } = {}) => {
    let page = 0;
    let rows: Record<string, unknown>[] = [];
    let totalCount = 0;
    for (;;) {
      const result = await playersApi.list({ ...params, page, pageSize: PLAYERS_ALL_PAGE_SIZE });
      rows = rows.concat(result.rows || []);
      totalCount = result.totalCount;
      // If this page returned fewer rows than requested, we've reached the last page
      if ((result.rows || []).length < PLAYERS_ALL_PAGE_SIZE) break;
      page += 1;
    }
    return { rows, totalCount };
  },
  online: () => playersApi.listAll({ status: "online" }),
  onlineCount: async () => {
    const result = await api<PlayersListResult>("/api/players/online?page=0&pageSize=1");
    return Number.isFinite(Number(result.totalCount)) ? Number(result.totalCount) : 0;
  },
  listSettings: () => api<PlayerListSettings>("/api/players/list-settings", { cache: "no-store" }),
  saveListSettings: (inactiveWeeks: number | null) => post<PlayerListSettings>("/api/players/list-settings", { inactiveWeeks }),
  profile: (playerId: string) => api<Record<string, unknown>>(`/api/players/${encodeURIComponent(playerId)}`),
  inventory: (playerId: string) => api<{ rows: Record<string, unknown>[]; capabilities: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/inventory`, { cache: "no-store" }),
  currency: (playerId: string) => api<{ rows: Record<string, unknown>[]; capabilities: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/currency`),
  solarisCoin: (playerId: string) => api<{ total?: number; capabilities: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/solaris-coin`),
  factions: (playerId: string) => api<{ rows: Record<string, unknown>[]; capabilities: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/factions`),
  intel: (playerId: string) => api<{ intel?: number; maxIntel?: number; capabilities: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/intel`),
  specs: (playerId: string) => api<{ rows: Record<string, unknown>[]; skillModules?: Record<string, unknown>[]; capabilities: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/specs`),
  position: (playerId: string) => api<Record<string, unknown>>(`/api/players/${encodeURIComponent(playerId)}/position`),
  progression: (playerId: string) => api<{ level?: number; xp?: number; totalSkillPoints?: number; unspentSkillPoints?: number; capabilities: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/progression`),
  vitals: (playerId: string) => api<{ currentHealth?: number | null; maxHealth?: number; maxHealthEstimated?: boolean; hydration?: number | null; maxHydration?: number; spiceAddictionLevel?: number | null; maxSpiceAddictionLevel?: number; capabilities: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/vitals`),
  events: (playerId: string) => api<Record<string, unknown>>(`/api/players/${encodeURIComponent(playerId)}/events`),
  stats: (playerId: string) => api<Record<string, unknown>>(`/api/players/${encodeURIComponent(playerId)}/stats`),
  history: (playerId: string) => api<Record<string, unknown>>(`/api/players/${encodeURIComponent(playerId)}/history`),
  giveItems: (playerId: string, items: { itemName?: string; itemId?: string; quantity: number; durability?: number; quality?: number; grade?: number; augments?: string[]; augmentQuality?: number }[], options: { historyScope?: string; historyFriendly?: string } = {}) => post<{ ok: boolean; results: Record<string, unknown>[]; message?: string }>(`/api/players/${encodeURIComponent(playerId)}/give-items`, { items, ...options }),
  giveItemId: (playerId: string, body: { itemId: string; quantity: number; durability?: number; quality?: number; grade?: number; augments?: string[]; augmentQuality?: number }) => post<{ task: Task }>(`/api/players/${encodeURIComponent(playerId)}/give-item-id`, body),
  addXp: (playerId: string, amount: number) => post<{ task: Task }>(`/api/players/${encodeURIComponent(playerId)}/add-xp`, { amount }),
  setSkillPoints: (playerId: string, points: number) => post<{ task: Task }>(`/api/players/${encodeURIComponent(playerId)}/set-skill-points`, { points }),
  setSkillModule: (playerId: string, body: { module: string; level: number }) => post<{ task: Task }>(`/api/players/${encodeURIComponent(playerId)}/set-skill-module`, body),
  addSpecializationXp: (playerId: string, body: { trackType: string; amount: number; confirmation: string }) => post<{ supported: boolean; result?: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/specializations/add-xp`, body),
  grantMaxSpecialization: (playerId: string, body: { trackType: string; confirmation: string }) => post<{ supported: boolean; result?: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/specializations/grant-max`, body),
  resetSpecialization: (playerId: string, body: { trackType: string; confirmation: string }) => post<{ supported: boolean; result?: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/specializations/reset`, body),
  grantAllSpecializationKeystones: (playerId: string, confirmation: string) => post<{ supported: boolean; result?: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/specializations/keystones/grant-all`, { confirmation }),
  resetAllSpecializationKeystones: (playerId: string, confirmation: string) => post<{ supported: boolean; result?: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/specializations/keystones/reset-all`, { confirmation }),
  refillWater: (playerId: string, amount = 1000000) => post<{ task: Task }>(`/api/players/${encodeURIComponent(playerId)}/refill-water`, { amount }),
  kick: (playerId: string) => post<{ task: Task }>(`/api/players/${encodeURIComponent(playerId)}/kick`),
  ban: (playerId: string, reason = "") => post<{ ok: boolean; banned: boolean; ban: Record<string, unknown>; enforcement?: Record<string, unknown> }>(`/api/players/${encodeURIComponent(playerId)}/ban`, { confirmation: "BAN PLAYER", reason }),
  unban: (playerId: string) => api<{ ok: boolean; banned: boolean; wasBanned: boolean }>(`/api/players/${encodeURIComponent(playerId)}/ban`, { method: "DELETE" }),
  repairLoginQueue: (playerId: string, confirmation: string) => post<{ task: Task }>(`/api/players/${encodeURIComponent(playerId)}/repair-login-queue`, { confirmation }),
  teleportDestinations: (playerId: string) => api<{ source: { map: string; partition_id: number; online_status: string; online: boolean }; partitions: { map: string; partition_id: number; name: string; marker_count: number; alive?: boolean | null; ready?: boolean | null; current?: boolean; selectable?: boolean }[]; players: { id: string; name: string; online_status: string; map: string; partition_id: number }[]; bases: { id: string; name: string; owner_name: string; map: string; partition_id: number; is_own: boolean }[] }>(`/api/players/${encodeURIComponent(playerId)}/teleport-destinations`, { cache: "no-store" }),
  teleport: (playerId: string, body: { mode: "coordinates" | "player" | "base"; destinationId?: string; partitionId?: number; x?: number; y?: number; z?: number }) => post<{ task?: Task; message?: string; path?: "live" | "offline"; supported?: boolean; reason?: string; result?: { playerId: string; partitionId: number; x: number; y: number; z: number } }>(`/api/players/${encodeURIComponent(playerId)}/teleport`, body),
  spawnVehicle: (playerId: string, body: { vehicleId: string; template: string; offset: number }) => post<{ task: Task }>(`/api/players/${encodeURIComponent(playerId)}/spawn-vehicle`, body),
  cleanInventory: (playerId: string, confirmation: string) => post<{ task: Task }>(`/api/players/${encodeURIComponent(playerId)}/clean-inventory`, { confirmation }),
  resetProgression: (playerId: string, confirmation: string) => post<{ task: Task }>(`/api/players/${encodeURIComponent(playerId)}/reset-progression`, { confirmation }),
  addCurrency: (playerId: string, body: { currencyId: number; amount: number; confirmation: string }) => post<{ supported: boolean; result?: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/add-currency`, body),
  addFactionReputation: (playerId: string, body: { factionId: number; amount: number; confirmation: string }) => post<{ supported: boolean; result?: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/add-faction-reputation`, body),
  repairFactionReputation: (playerId: string, confirmation: string) => post<{ supported: boolean; result?: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/repair-faction-reputation`, { confirmation }),
  repairLandsraadQuests: (playerId: string, confirmation: string) => post<{ supported: boolean; backupCreated?: boolean; result?: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/repair-landsraad-quests`, { confirmation }),
  characterRecovery: (playerId: string) => api<CharacterRecoveryInspection>(`/api/players/${encodeURIComponent(playerId)}/character-recovery`, { cache: "no-store" }),
  deletedCharacters: () => api<DeletedCharacterAssetsResult>("/api/players/deleted-characters", { cache: "no-store" }),
  recoverDeletedCharacter: (playerId: string, candidateId: string, confirmation: string) => post<{ supported: boolean; backupCreated?: boolean; result?: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/character-recovery`, { candidateId, confirmation }),
  setFaction: (playerId: string, body: { factionId: 1 | 2 | 3; confirmation: string }) => post<{ supported: boolean; result?: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/faction`, body),
  addIntel: (playerId: string, body: { amount: number; confirmation: string }) => post<{ supported: boolean; result?: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/add-intel`, body),
  craftingRecipes: (playerId: string) => api<{ rows: Record<string, unknown>[]; capabilities: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/crafting-recipes`),
  unlockCraftingRecipe: (playerId: string, body: { recipeId: string; confirmation: string }) => post<{ supported: boolean; result?: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/crafting-recipes/unlock`, body),
  researchItems: (playerId: string) => api<{ rows: Record<string, unknown>[]; capabilities: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/research-items`),
  unlockResearchItem: (playerId: string, body: { itemKey: string; confirmation: string }) => post<{ supported: boolean; result?: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/research-items/unlock`, body),
  buildingUnlocks: (playerId: string) => api<{ rows: Record<string, unknown>[]; capabilities: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/building-unlocks`, { cache: "no-store" }),
  grantBuildingUnlock: (playerId: string, body: { itemId: string; confirmation: string }) => post<{ ok: boolean; status: string; deliveryVerified?: boolean; ownershipVerified?: boolean; alreadyOwned?: boolean; alreadyPending?: boolean; item?: Record<string, unknown>; result?: Record<string, unknown> }>(`/api/players/${encodeURIComponent(playerId)}/building-unlocks/grant`, body),
  customizations: (playerId: string) => api<{ rows: Record<string, unknown>[]; groups: { id: string; name: string; count: number }[]; capabilities: Record<string, unknown> }>(`/api/players/${encodeURIComponent(playerId)}/customizations`, { cache: "no-store" }),
  grantCustomizations: (playerId: string, body: { itemId?: string; groupId?: string; confirmation: string }) => post<{ ok: boolean; delivered?: number; unlocked?: number; granted: number; requested: number; skipped: number; failed: number; ownershipVerified?: boolean; results: Record<string, unknown>[] }>(`/api/players/${encodeURIComponent(playerId)}/customizations/grant`, body),
  journey: (playerId: string) => api<{ rows: Record<string, unknown>; capabilities: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/journey`),
  completeJourneyNode: (playerId: string, body: { nodeId: string; confirmation: string }) => post<{ supported: boolean; result?: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/journey/complete`, body),
  resetJourneyNode: (playerId: string, body: { nodeId: string; confirmation: string }) => post<{ supported: boolean; result?: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/journey/reset`, body),
  completeTutorial: (playerId: string, body: { tutorialId: string; confirmation: string }) => post<{ supported: boolean; result?: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/tutorials/complete`, body),
  resetTutorial: (playerId: string, body: { tutorialId: string; confirmation: string }) => post<{ supported: boolean; result?: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/tutorials/reset`, body),
  repairGear: (playerId: string, confirmation: string) => post<{ supported: boolean; result?: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/repair-gear`, { confirmation }),
  repairVehicleDecay: (playerId: string, body: { thresholdPercent: number; confirmation: string }) => post<{ supported: boolean; result?: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/repair-vehicle-decay`, body),
  deleteInventoryItem: (playerId: string, itemId: string, confirmation: string) => api<{ supported: boolean; result?: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/inventory/${encodeURIComponent(itemId)}`, { method: "DELETE", body: JSON.stringify({ confirmation }) }),
  updateInventoryItem: (playerId: string, itemId: string, values: Record<string, unknown>, confirmation: string) => api<{ supported: boolean; result?: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/inventory/${encodeURIComponent(itemId)}`, { method: "PATCH", body: JSON.stringify({ confirmation, values }) }),
  augmentInventoryItem: (playerId: string, itemId: string, augments: string[], augmentQuality: number, confirmation: string) => post<{ supported: boolean; result?: Record<string, unknown>; reason?: string }>(`/api/players/${encodeURIComponent(playerId)}/augment-item`, { itemId, augments, augmentQuality, confirmation })
};

export type CharacterRecoveryCandidate = {
  characterStateId: string;
  characterName: string;
  lastAvatarActivity: string | null;
  lastLoginTime: string | null;
  deletedAt: string | null;
  controllerId: string;
  pawnId: string;
  playerStateActorId: string;
  map: string;
  partitionId: string;
  sietch: string;
  inventoryCount: number;
  itemCount: number;
  transferCount: number;
  removalReason: string;
  removalEventTime: string | null;
  replacementDetected: boolean;
  recoverable: boolean;
};

export type CharacterRecoveryInspection = {
  ok: boolean;
  online: boolean;
  active: {
    characterStateId: string;
    characterName: string;
    pawnId: string;
    itemCount: number;
    transferCount: number;
  };
  candidates: CharacterRecoveryCandidate[];
  suggestedCandidateId: string;
  canRecover: boolean;
  message: string;
};

// One orphaned base or vehicle. `matchedBy` is the respawn-location group that
// tied it to a deleted character ("Base Totem", "Respawn Point", "Respawn
// Beacon"); it is empty for unattributed rows. Counts are per-kind and null on
// the kind they do not apply to, or when the optional table they need is absent.
export type DeletedCharacterAsset = {
  kind: "base" | "vehicle";
  id: string;
  actorId: string;
  name: string;
  assetType: string;
  map: string;
  partitionId: string;
  partitionMap: string;
  partitionLabel: string;
  x: number | null;
  y: number | null;
  z: number | null;
  pieceCount: number | null;
  placeableCount: number | null;
  moduleCount: number | null;
  characterStateId: string;
  matchedBy: string;
};

export type DeletedCharacterEntry = {
  characterStateId: string;
  accountId: string;
  characterName: string;
  flsId: string;
  deletedAt: string | null;
  lastAvatarActivity: string | null;
  lastLoginTime: string | null;
  controllerId: string;
  pawnId: string;
  removalReason: string;
  removalEventTime: string | null;
  replacementCharacterName: string;
  bases: DeletedCharacterAsset[];
  vehicles: DeletedCharacterAsset[];
};

export type DeletedCharacterTotals = {
  deletedCharacters: number;
  deletedCharactersHoldingAssets: number;
  deletedCharactersWithoutAssets: number;
  attributedBases: number;
  attributedVehicles: number;
  unattributedBases: number;
  unattributedVehicles: number;
  orphanedBases: number;
  orphanedVehicles: number;
};

export type DeletedCharacterAssetsResult = {
  supported?: boolean;
  capabilities?: Record<string, unknown>;
  characters: DeletedCharacterEntry[];
  unattributed: { bases: DeletedCharacterAsset[]; vehicles: DeletedCharacterAsset[] };
  totals: DeletedCharacterTotals;
  truncated?: boolean;
  reason?: string;
};
