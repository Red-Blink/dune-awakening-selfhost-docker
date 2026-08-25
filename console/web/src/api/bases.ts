import { api, post } from "./client";

export type RefillDeviceResult = {
  placeableId: string;
  type: string;
  label: string;
  fuelName: string;
  before: number;
  after: number;
  added: number;
  capped?: boolean;
  skipped?: string;
};

export type QueuedRefill = {
  baseId: number;
  map: string;
  partitionId: number;
  queuedAt: string;
  attempts: number;
  lastError: string;
};

export type PendingRefills = {
  supported: boolean;
  total: number;
  pending: QueuedRefill[];
  byTarget: { map: string; partitionId: number; partitionMap: string; dimensionIndex: number; count: number }[];
};

export type AutoRefillBase = {
  baseId: number;
  enabledAt: string;
  lastCheckedAt: string;
  lastQueuedAt: string;
  // null when the base has no recognised generators, which is not the same as 0.
  lastLowestPercent: number | null;
  // Completed queue cycles that never brought the fuel back up. At the cap the
  // scan stops queueing this base and stamps stalledAt.
  consecutiveQueues: number;
  stalledAt: string;
};

export type AutoRefillState = {
  supported: boolean;
  thresholdPercent: number;
  intervalHours: number;
  nextRunAt: string;
  lastRunAt: string;
  lastRunStatus: string;
  lastRunDetail: string;
  total: number;
  bases: AutoRefillBase[];
};

// Water refill has no fuelName/capped/skipped concepts: it's a plain
// jsonb_set straight to capacity, not a stack of discrete inventory items.
export type RefillWaterDeviceResult = {
  placeableId: string;
  type: string;
  label: string;
  before: number;
  after: number;
  added: number;
};

export type WaterContainerEntry = {
  type: string;
  name: string;
  count: number;
  stored: number;
  capacity: number;
  percent: number;
  // Only present for Blood Purifier / Improved Blood Purifier -- their raw
  // blood input buffer, a completely different storage mechanism from water.
  bloodStored?: number;
  bloodCapacity?: number;
  bloodPercent?: number;
};

export type BaseWater = {
  supported: boolean;
  baseId: number;
  containers: WaterContainerEntry[];
  reason?: string;
};

export type AutoRefillWaterBase = {
  baseId: number;
  enabledAt: string;
  lastCheckedAt: string;
  lastQueuedAt: string;
  lastLowestPercent: number | null;
  consecutiveQueues: number;
  stalledAt: string;
};

export type AutoRefillWaterState = {
  supported: boolean;
  thresholdPercent: number;
  intervalHours: number;
  nextRunAt: string;
  lastRunAt: string;
  lastRunStatus: string;
  lastRunDetail: string;
  total: number;
  bases: AutoRefillWaterBase[];
};

// Storage containers plus the refining, crafting, and other inventories
// (recycler, repair station, the base's own Sub-Fief console) at a base.
// Generator and windtrap fuel is deliberately absent -- the Power and Water
// tabs own it.
export type BaseInventoryGroupKey = "storage" | "refining" | "crafting" | "other";

export type BaseInventoryGroup = {
  key: BaseInventoryGroupKey;
  name: string;
  containerCount: number;
  itemCount: number;
};

// One item template's total inside one container. NOT a stack: the backend
// merges every dune.items row of the same template, so a container with 8
// occupied slots holding 3 templates yields 3 of these. Stack count is
// usedSlots.
export type BaseInventoryEntry = {
  templateId: string;
  name: string;
  quantity: number;
};

export type BaseInventoryContainer = {
  placeableId: string;
  // Empty until a player renames the placeable in-game: the game stores
  // '##' || building_type as the default, which the backend strips.
  name: string;
  typeName: string;
  group: BaseInventoryGroupKey;
  usedSlots: number;
  maxSlots: number;
  // Both 0 on a schema without dune.inventories.max_item_volume /
  // dune.items.volume_override -- degraded, not omitted, so the UI can
  // always read these without a guard. currentVolume is the backend's own
  // sum of volume_override * quantity across every stack -- volume_override
  // itself is a PER-UNIT value (corrected 2026-08-19, see
  // docs/console/base-inventory.md and
  // docs/incidents/INC-2026-08-19-VOLUME-OVERRIDE-DOUBLE-MULTIPLIED.md;
  // storing the total there instead caused the live game engine, which
  // multiplies volume_override by stack_size itself for display, to
  // double-multiply and show absurdly inflated in-game item volumes).
  currentVolume: number;
  maxVolume: number;
  // False when at least one occupied stack has neither an explicit override
  // nor a catalog volume. currentVolume is then the known minimum, not zero.
  volumeComplete?: boolean;
  itemCount: number;
  items: BaseInventoryEntry[];
};

// One occupied slot -- a real dune.items row, unlike BaseInventoryEntry above.
// This is what the contents modal renders and what a delete addresses.
export type BaseInventorySlot = {
  // dune.items.id. Globally unique, so it is the React key and the delete
  // target; templateId is not unique within a container.
  itemId: string;
  templateId: string;
  name: string;
  // 0-based slot within its inventory. Null when the schema lacks the column,
  // in which case the grid view is not offered. There is no unique constraint
  // on (inventory_id, position_index), so duplicates and values beyond
  // maxSlots are both possible and must not be dropped when laying out a grid.
  positionIndex: number | null;
  quantity: number;
  qualityLevel: number;
  currentDurability: number | null;
  maxDurability: number | null;
  // Always an array, empty for an item with none -- never undefined, so a
  // plain `.length > 0` check is enough to decide whether to render a line.
  augments: { templateId: string; name: string; qualityLevel: number }[];
};

// Slots hang off an inventory rather than the container because a placeable can
// back more than one: the container's maxSlots is their sum, while
// positionIndex is scoped to a single inventory, so two of them would both
// have a slot 0.
export type BaseContainerInventory = {
  inventoryId: string;
  maxSlots: number;
  usedSlots: number;
  // Same degrade-to-0 convention as BaseInventoryContainer's fields above.
  currentVolume: number;
  maxVolume: number;
  volumeComplete?: boolean;
  slots: BaseInventorySlot[];
};

// Fetched per container when the contents modal opens, not folded into
// BaseInventory: slots roughly triple that response on a tab that loads on
// every base expand, while the modal only ever shows one container.
export type BaseContainerSlots = {
  supported: boolean;
  // False when the container is not at this base -- an ownership answer, not
  // an error, and the same 200-with-a-reason shape used elsewhere here.
  found?: boolean;
  baseId: number;
  placeableId: string;
  typeName?: string;
  group?: BaseInventoryGroupKey;
  maxSlots?: number;
  usedSlots?: number;
  currentVolume?: number;
  maxVolume?: number;
  volumeComplete?: boolean;
  inventories: BaseContainerInventory[];
  reason?: string;
  deleteSafety?: BaseContainerDeleteSafety;
  addSafety?: BaseContainerAddSafety;
};

// Shared result shape for the bulk delete (selected items) and delete-all
// actions -- both return the same "how many actually got removed" summary,
// since a requested item id may already be gone by the time the delete runs.
export type BaseContainerBulkDeleteResult = {
  ok: boolean;
  baseId: number;
  placeableId: string;
  inventoryId: string;
  typeName: string;
  group: BaseInventoryGroupKey;
  removed: { itemId: string; templateId: string; count: number }[];
  message: string;
  deleteSafety: BaseContainerDeleteSafety;
};

// Item deletion is deliberately fail-closed: only plain storage on a map that
// the backend can verify is safely down may be changed.
export type BaseContainerDeleteSafety = {
  safe: boolean;
  known: boolean;
  map: string;
  partitionId: number;
  reason: string;
};

// Structurally identical to the delete gate, and gated on the same four
// conditions -- only the wording of `reason` differs, so the operator reads a
// sentence about the thing they actually tried to do. Aliased rather than
// reused so that if the two ever need to diverge (adds queueable while a
// running map holds, say) doing so does not silently retype the other one.
export type BaseContainerAddSafety = BaseContainerDeleteSafety;

// Mirrors giveItemToStorage's parameter surface. `quality` is the item grade
// (0-5); `augmentQuality` is the grade rolled onto each selected augment.
export type AddContainerItemRequest = {
  itemId?: string;
  itemName?: string;
  quantity: number;
  quality?: number;
  augments?: string[];
  augmentQuality?: number;
};

// How much of one item a single container holds. `name` is the container's,
// not the item's -- the item is the parent -- and is empty for a placeable the
// player has never renamed, same as BaseInventoryContainer.name.
export type BaseInventoryHolder = {
  placeableId: string;
  name: string;
  typeName: string;
  group: BaseInventoryGroupKey;
  quantity: number;
};

export type BaseInventoryItem = {
  templateId: string;
  // Falls back to templateId for anything missing from admin-items.json.
  name: string;
  image: string;
  category: string;
  quantity: number;
  containerCount: number;
  containers: BaseInventoryHolder[];
};

export type BaseInventory = {
  // False when the database lacks dune.placeables/inventories/items. That is a
  // 200 carrying `reason`, not an error status -- a schema that cannot support
  // the tab is a settled answer, and retrying it would never change.
  supported: boolean;
  baseId: number;
  groups: BaseInventoryGroup[];
  containers: BaseInventoryContainer[];
  items: BaseInventoryItem[];
  totals: { items: number; distinct: number; containers: number; usedSlots: number; maxSlots: number; currentVolume: number; maxVolume: number; volumeComplete?: boolean };
  // Only set alongside supported: false.
  reason?: string;
};

// rank 1/2/3 = Owner/Co-Owner/Associate, confirmed in both directions against a
// live server: the game's own Permissions panel writes exactly these values.
// The 5/4/3 badges the game UI shows beside those labels are decoration, not
// ranks -- no row in permission_actor_rank ever holds a 4 or 5.
export type BasePermissionRank = 1 | 2 | 3;

export type BasePermissionEntry = {
  playerId: string;
  name: string;
  rank: BasePermissionRank;
  label: string;
  // False when this row names an actor that is not the account's
  // player_controller_id. The game ignores such rows, but they are shown rather
  // than hidden -- it is a state the console can see and the game client cannot.
  canonical: boolean;
};

// permission_actor.access_level: a separate 5-tier scale from
// BasePermissionRank (1-3). 3/Associate is "Sub-Fief" -- it matches the base's
// own roster-wide default; every other value was deliberately set wider
// (Public, Guild) or narrower (Co-Owner, Owner) than that.
export type BaseAccessLevel = 1 | 2 | 3 | 4 | 5;

// Matches childAccessGroupFor's categories in duneDb.js -- its own map, not
// BASE_INVENTORY_TYPES: most child pieces (doors, generators, turbines, the
// totem) carry no inventory at all, so this tab's grouping is broader than
// the Inventory tab's (which only covers actual dune.inventories rows).
export type BaseChildAccessGroup = "storage" | "refining" | "crafting" | "generators" | "water" | "pentashield" | "door" | "other";

export type BaseChildAccessRow = {
  actorId: string;
  name: string;
  buildingType: string;
  group: BaseChildAccessGroup;
  currentAccess: BaseAccessLevel;
  currentAccessLabel: string;
  isSubFief: boolean;
};

export type BaseChildAccessAudit = {
  supported: boolean;
  inspected: number;
  rows: BaseChildAccessRow[];
  reason?: string;
};

export type BasePermissions = {
  supported: boolean;
  baseId: number;
  actorId: string;
  map: string;
  mapNameId: number;
  // False when the base has no dune.permission_actor row -- unclaimed, so the
  // permission table's foreign key rejects every write against it. Optional so
  // an older API that does not send it is read as claimed, which is the
  // behaviour that existed before the flag rather than a new lockout.
  claimed?: boolean;
  unclaimedReason?: string;
  systemCustodian?: {
    available: boolean;
    canCreate?: boolean;
    playerId?: string;
    name?: string;
    reason?: string;
  };
  entries: BasePermissionEntry[];
  reason?: string;
};

export type BasePermissionCandidate = { playerId: string; name: string };

export type SetBasePermissionsResult = {
  ok: boolean;
  baseId: number;
  actorId: string;
  map: string;
  added: number;
  reranked: number;
  removed: number;
  total: number;
  message: string;
};

export type LandClaimSegment = {
  x: number;
  y: number;
  rowCount: number;
};

export type BaseLandClaim = {
  supported: boolean;
  baseId: number;
  totemId: string;
  map: string;
  partitionId: number;
  yaw: number;
  verticalLevel: number;
  maxVerticalLevel: number;
  segments: LandClaimSegment[];
  segmentCount: number;
  duplicateCoordinates: number;
  reason?: string;
};

export type UpdateBaseLandClaimResult = BaseLandClaim & {
  ok: boolean;
  added: number;
  verticalChanged: boolean;
};

export type BasesListResponse = {
  rows: Record<string, unknown>[];
  totalCount: number;
  totalBases: number;
  totalOwned?: number;
  totalShared?: number;
  totalPieces: number;
  totalPlaceables: number;
  capabilities: Record<string, unknown>;
  reason?: string;
};

type BasesListParams = { q?: string; page?: number; pageSize?: number; sortColumn?: string; sortDirection?: "asc" | "desc" };

function basesListQuery(params: BasesListParams) {
  const search = new URLSearchParams();
  if (params.q) search.set("q", params.q);
  if (params.page) search.set("page", String(params.page));
  if (params.pageSize) search.set("pageSize", String(params.pageSize));
  if (params.sortColumn) search.set("sortColumn", params.sortColumn);
  if (params.sortDirection) search.set("sortDirection", params.sortDirection);
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export const basesApi = {
  list: (params: BasesListParams = {}) => api<BasesListResponse>(`/api/bases${basesListQuery(params)}`),
  forPlayer: (playerId: string, params: BasesListParams = {}) =>
    api<BasesListResponse>(`/api/players/${encodeURIComponent(playerId)}/bases${basesListQuery(params)}`),
  // A refill for a map that is currently running comes back as
  // `result.queued`: the write is deferred to the next time that map is down.
  refillGenerators: (baseId: string) =>
    post<{
      supported: boolean;
      result?: {
        ok: boolean;
        baseId: number;
        queued?: boolean;
        map?: string;
        partitionId?: number;
        totalAdded?: number;
        devices?: RefillDeviceResult[];
      };
      reason?: string;
    }>(`/api/bases/${encodeURIComponent(baseId)}/refill-generators`, {}),
  cancelQueuedRefill: (baseId: string) =>
    api<{ supported: boolean; result?: { ok: boolean; baseId: number; pending: number }; reason?: string }>(
      `/api/bases/${encodeURIComponent(baseId)}/queued-refill`, { method: "DELETE" }),
  pendingRefills: () => api<PendingRefills>("/api/bases/pending-refills"),
  // Permanently deletes the base and everything on it. Like the refills
  // above, a delete for a map that is currently running comes back as
  // `result.queued`: it is deferred to the next time that map is down, and a
  // full database backup happens automatically, immediately before the
  // delete actually runs (at request time here, or at flush time for a
  // queued one) -- never before, never skipped.
  deleteBase: (baseId: string) =>
    api<{
      supported: boolean;
      backupCreated: boolean;
      result?: {
        ok: boolean;
        baseId: number;
        queued?: boolean;
        map?: string;
        partitionId?: number;
        actorId?: string;
        deletedActorCount?: number;
        deletedBuildingCount?: number;
        deletedPlaceableCount?: number;
      };
      reason?: string;
    }>(`/api/bases/${encodeURIComponent(baseId)}`, { method: "DELETE", body: JSON.stringify({ confirmation: "DELETE BASE" }) }),
  cancelQueuedDelete: (baseId: string) =>
    api<{ supported: boolean; result?: { ok: boolean; baseId: number; pending: number }; reason?: string }>(
      `/api/bases/${encodeURIComponent(baseId)}/queued-delete`, { method: "DELETE" }),
  pendingDeletes: () => api<PendingRefills>("/api/bases/pending-deletes"),
  autoRefill: () => api<AutoRefillState>("/api/bases/auto-refill"),
  setAutoRefill: (baseId: string, enabled: boolean) =>
    post<{ ok: boolean; baseId: number; enabled: boolean; total: number }>(
      `/api/bases/${encodeURIComponent(baseId)}/auto-refill`, { enabled }),
  permissions: (baseId: string) =>
    api<BasePermissions>(`/api/bases/${encodeURIComponent(baseId)}/permissions`),
  landClaim: (baseId: string) =>
    api<BaseLandClaim>(`/api/bases/${encodeURIComponent(baseId)}/land-claim`),
  updateLandClaim: (baseId: string, addSegments: { x: number; y: number }[], verticalLevel: number) =>
    api<{ supported: boolean; backupCreated: boolean; result?: UpdateBaseLandClaimResult; reason?: string; error?: string }>(
      `/api/bases/${encodeURIComponent(baseId)}/land-claim`,
      { method: "PUT", body: JSON.stringify({ addSegments, verticalLevel, confirmation: "EDIT LAND CLAIM" }) }),
  // A whole roster, not a delta: the server diffs it against current state and
  // applies the difference through the game's own stored procedures in one
  // transaction. Changes reach a running map immediately -- no restart.
  setPermissions: (baseId: string, entries: { playerId: string; rank: BasePermissionRank }[]) =>
    api<{ supported: boolean; result?: SetBasePermissionsResult; reason?: string }>(
      `/api/bases/${encodeURIComponent(baseId)}/permissions`,
      { method: "PUT", body: JSON.stringify({ entries }) }),
  childAccess: (baseId: string) =>
    api<BaseChildAccessAudit>(`/api/bases/${encodeURIComponent(baseId)}/child-access`),
  setChildAccess: (baseId: string, updates: { actorId: string; accessLevel: BaseAccessLevel }[]) =>
    post<{ supported: boolean; result?: { ok: boolean; baseId: number; updated: number; message: string }; reason?: string }>(
      `/api/bases/${encodeURIComponent(baseId)}/child-access`, { updates, confirmation: "SET CHILD ACCESS" }),
  transferToSystemCustodian: (baseId: string) =>
    post<{ supported: boolean; result?: SetBasePermissionsResult; reason?: string }>(
      `/api/bases/${encodeURIComponent(baseId)}/system-custodian`, {}),
  permissionCandidates: (q: string, limit = 25) => {
    const search = new URLSearchParams();
    if (q) search.set("q", q);
    search.set("limit", String(limit));
    return api<{ supported: boolean; rows: BasePermissionCandidate[]; reason?: string }>(
      `/api/bases/permission-candidates?${search.toString()}`);
  },
  water: (baseId: string) =>
    api<BaseWater>(`/api/bases/${encodeURIComponent(baseId)}/water`),
  // Read-only. One response backs both the item rollup and the container
  // cards, so switching between them never refetches.
  inventory: (baseId: string) =>
    api<BaseInventory>(`/api/bases/${encodeURIComponent(baseId)}/inventory`),
  // One container's slots, fetched when the contents modal opens. Kept off
  // inventory() above so the base tab does not carry every slot at the base.
  containerSlots: (baseId: string, placeableId: string) =>
    api<BaseContainerSlots>(
      `/api/bases/${encodeURIComponent(baseId)}/containers/${encodeURIComponent(placeableId)}`),
  // Destroys a stored item. `count` omitted removes the whole slot; a count
  // below the stack removes part of it. A count ABOVE the stack is rejected by
  // the server rather than clearing the slot -- the stack may have shrunk since
  // this view loaded, and widening that into "delete it all" would remove more
  // than was asked for.
  deleteContainerItem: (baseId: string, placeableId: string, itemId: string, confirmation: string, count?: number) =>
    api<{
      supported: boolean;
      result?: {
        ok: boolean;
        partial: boolean;
        typeName: string;
        group: BaseInventoryGroupKey;
        removed: {
          itemId: string;
          templateId: string;
          count: number;
          remaining: number;
          positionIndex: number | null;
          qualityLevel: number;
          currentDurability: number | null;
          maxDurability: number | null;
        };
        message: string;
        deleteSafety: BaseContainerDeleteSafety;
      };
      error?: string;
      reason?: string;
    }>(`/api/bases/${encodeURIComponent(baseId)}/containers/${encodeURIComponent(placeableId)}/items/${encodeURIComponent(itemId)}`,
      { method: "DELETE", body: JSON.stringify(count === undefined ? { confirmation } : { confirmation, count }) }),
  // Creates a stored item. Always inserts a NEW row -- it never tops up a
  // matching stack -- and always appends to the next free slot. There is no
  // slot parameter by design: clicking an empty cell in the grid is a shortcut
  // to the form, not a placement target, so nothing in the UI may promise one.
  addContainerItem: (baseId: string, placeableId: string, item: AddContainerItemRequest, confirmation: string) =>
    post<{
      supported: boolean;
      result?: {
        ok: boolean;
        inventoryId: string;
        typeName: string;
        group: BaseInventoryGroupKey;
        added: {
          itemId: string;
          templateId: string;
          quantity: number;
          qualityLevel: number;
          positionIndex: number;
          augments?: string[];
        };
        capacity: { usedSlots: number; maxSlots: number };
        message: string;
        addSafety: BaseContainerAddSafety;
      };
      error?: string;
      reason?: string;
    }>(`/api/bases/${encodeURIComponent(baseId)}/containers/${encodeURIComponent(placeableId)}/items`,
      { ...item, confirmation }),
  // Deletes several selected whole stacks in one confirmation. Storage-group
  // only -- the backend re-verifies ownership and group itself, this is not
  // a trust boundary the frontend enforces.
  deleteContainerItems: (baseId: string, placeableId: string, itemIds: string[], confirmation: string) =>
    api<{
      supported: boolean;
      result?: BaseContainerBulkDeleteResult;
      error?: string;
      reason?: string;
    }>(`/api/bases/${encodeURIComponent(baseId)}/containers/${encodeURIComponent(placeableId)}/items`,
      { method: "DELETE", body: JSON.stringify({ confirmation, itemIds }) }),
  // Clears every item currently in the container. The item list to delete
  // is resolved server-side, fresh inside the delete transaction -- not
  // whatever the tab last fetched -- so this always means "everything
  // actually there right now," even if the tab's own view is stale.
  deleteAllContainerItems: (baseId: string, placeableId: string, confirmation: string) =>
    api<{
      supported: boolean;
      result?: BaseContainerBulkDeleteResult;
      error?: string;
      reason?: string;
    }>(`/api/bases/${encodeURIComponent(baseId)}/containers/${encodeURIComponent(placeableId)}/all-items`,
      { method: "DELETE", body: JSON.stringify({ confirmation }) }),
  // Gives one item to a Storage-group container. Volume-checked the same
  // way Fill already is; itemName/itemId is resolved against the admin
  // catalog server-side, same as the standalone Storage tab's Give action.
  // `requested`/`given`/`clamped` (issue #347 follow-up): a give that would
  // exceed the container's remaining volume is clamped to whatever fits and
  // inserted -- never rejected outright -- so `given` can be less than
  // `requested`. Only genuinely zero room left (not even 1 unit fits) is
  // still a real error, surfaced via `error`/`reason` as before.
  // `inserted` below is intentionally snake_case (id/template_id/stack_size/
  // quality_level/position_index/inventory_id/volume_override), not
  // camelCase like the rest of this API surface -- found during post-merge
  // review of upstream PR #182 (2026-08-20): duneDb.js's giveItemToStorage/
  // giveItemToBaseContainer/fillItemToStorage/fillItemToBaseContainer/
  // giveMultipleItemsToBaseContainer all return `inserted: inserted.rows[0]`
  // straight from a `returning ...` query, unlike addBaseContainerItem
  // (a few lines below in duneDb.js), which explicitly builds a camelCase
  // object for exactly this reason. This type previously declared the
  // camelCase shape the rest of the codebase uses, which was never true at
  // runtime -- currently latent (no caller here reads `.inserted` yet), but
  // any future caller trusting the old declared type would have gotten
  // `undefined` silently instead of a compile error.
  giveContainerItem: (baseId: string, placeableId: string, body: { itemName?: string; itemId?: string; quantity: number; confirmation: string }) =>
    api<{
      supported: boolean;
      result?: { ok: boolean; inserted: { id: string; template_id: string; stack_size: number; quality_level: number; position_index: number; inventory_id: string; volume_override: number | null }; insertedStacks?: { id: string; template_id: string; stack_size: number; quality_level: number; position_index: number; inventory_id: string; volume_override: number | null }[]; stacks?: number; requested: number; given: number; clamped: boolean; clampReason?: "volume" | "slots" | "stack-rows" | null; message?: string };
      error?: string;
      reason?: string;
    }>(`/api/bases/${encodeURIComponent(baseId)}/containers/${encodeURIComponent(placeableId)}/give-item`,
      { method: "POST", body: JSON.stringify(body) }),
  // Gives several distinct item templates to a Storage-group container in
  // one confirmation and one server-side transaction -- not N sequential
  // calls, which would let some items succeed and others fail on the same
  // click. Capped at 50 distinct items per batch by the backend.
  // Never rejects on hitting a capacity limit: once one item in the batch
  // does not fully fit (clamped, or zero room), the batch stops there --
  // every requested item still appears in `results`, including ones never
  // attempted because an earlier item already stopped the batch
  // (`attempted: false`). `inserted` is only present on items that were
  // actually given a row (`given > 0`).
  giveContainerItems: (baseId: string, placeableId: string, items: { itemName?: string; itemId?: string; quantity: number }[], confirmation: string) =>
    api<{
      supported: boolean;
      result?: {
        ok: boolean;
        results: {
          // See giveContainerItem's own comment above -- same real
          // snake_case shape, not the camelCase this type previously (and
          // incorrectly) declared.
          inserted?: { id: string; template_id: string; stack_size: number; quality_level: number; position_index: number; inventory_id: string; volume_override: number | null };
          insertedStacks?: { id: string; template_id: string; stack_size: number; quality_level: number; position_index: number; inventory_id: string; volume_override: number | null }[];
          stacks?: number;
          templateId: string;
          requested: number;
          given: number;
          clamped: boolean;
          clampReason?: "volume" | "slots" | "stack-rows" | null;
          attempted: boolean;
          reason?: string;
        }[];
      };
      error?: string;
      reason?: string;
    }>(`/api/bases/${encodeURIComponent(baseId)}/containers/${encodeURIComponent(placeableId)}/give-items`,
      { method: "POST", body: JSON.stringify({ items, confirmation }) }),
  // Fills a Storage-group container with a raw resource, refined resource,
  // or component -- the same server-side allowlist the standalone Storage
  // tab's Fill action already enforces (FILLABLE_GROUPS in adminCatalog.js).
  // Same clamp-and-inform contract as giveContainerItem. `requested` is
  // null for a "Fill to Capacity" call (quantity: 0, no specific amount was
  // ever asked for to compare against) and a real number for "Fill
  // Amount" (an explicit quantity that may itself get clamped down).
  // See giveContainerItem's own comment above -- same real snake_case
  // shape, not the camelCase this type previously (and incorrectly)
  // declared.
  fillContainerItem: (baseId: string, placeableId: string, body: { itemName?: string; itemId?: string; quantity: number; confirmation: string }) =>
    api<{
      supported: boolean;
      result?: { ok: boolean; inserted: { id: string; template_id: string; stack_size: number; quality_level: number; position_index: number; inventory_id: string; volume_override: number | null }; insertedStacks?: { id: string; template_id: string; stack_size: number; quality_level: number; position_index: number; inventory_id: string; volume_override: number | null }[]; stacks?: number; requested: number | null; given: number; clamped: boolean; clampReason?: "volume" | "slots" | "stack-rows" | null; message?: string };
      error?: string;
      reason?: string;
    }>(`/api/bases/${encodeURIComponent(baseId)}/containers/${encodeURIComponent(placeableId)}/fill-item`,
      { method: "POST", body: JSON.stringify(body) }),
  // A refill for a map that is currently running comes back as
  // `result.queued`: the write is deferred to the next time that map is down.
  refillWater: (baseId: string) =>
    post<{
      supported: boolean;
      result?: {
        ok: boolean;
        baseId: number;
        queued?: boolean;
        map?: string;
        partitionId?: number;
        totalAdded?: number;
        devices?: RefillWaterDeviceResult[];
      };
      reason?: string;
    }>(`/api/bases/${encodeURIComponent(baseId)}/refill-water`, {}),
  cancelQueuedWaterRefill: (baseId: string) =>
    api<{ supported: boolean; result?: { ok: boolean; baseId: number; pending: number }; reason?: string }>(
      `/api/bases/${encodeURIComponent(baseId)}/queued-water-refill`, { method: "DELETE" }),
  pendingWaterRefills: () => api<PendingRefills>("/api/bases/pending-water-refills"),
  autoRefillWater: () => api<AutoRefillWaterState>("/api/bases/auto-refill-water"),
  setAutoRefillWater: (baseId: string, enabled: boolean) =>
    post<{
      ok: boolean;
      baseId: number;
      enabled: boolean;
      newlyEnabled?: boolean;
      total: number;
      initialCheck?: {
        status: string;
        detail: string;
        checked: number;
        queued: number;
        alreadyQueued?: number;
        failures: number;
      };
    }>(
      `/api/bases/${encodeURIComponent(baseId)}/auto-refill-water`, { enabled })
};
