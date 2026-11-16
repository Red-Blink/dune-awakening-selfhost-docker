// Export/import of the game's own "pick up base" backups (dune.base_backups).
//
// A picked-up base is not serialized anywhere by the game: its actors, pieces,
// placeables and storage stay in their tables, linked to a base_backups row
// through base_backup_linked_actors. The game already knows how to move such
// a backup between servers -- character transfer (dune.character_transfer_export
// / _import) carries a character's base backups -- so this module reuses the
// same _character_transfer_* helpers, scoped to one backup instead of one
// character. Verified row-for-row against character_transfer_export and by a
// typed round trip; see docs/console/base-backups.md.
//
// Two rules keep the data exact:
// - Entries never pass through JavaScript numbers. Game payloads may carry
//   64-bit integers that JSON.parse would round, so the export is rendered to
//   text by Postgres and the import sends the uploaded text back as jsonb.
//   JavaScript only parses the file to validate its structure.
// - jsonb drops array lower bounds, and the game writes 0-based arrays (it
//   hard-codes landclaim_original_global_location[0..2]). The export records
//   each row's non-default bounds and the import restores them row by row.
//
// An import file is untrusted input: every reference must stay inside the
// base (see ENTRY_REFS), and imported actors are forced into the backed-up
// state with no partition, whatever the file says.

import { resolvePlayerTarget, tableExists, UnsupportedCapabilityError } from "./duneDb.js";
import { intParam } from "./db.js";
import { clampInt } from "./jsonStore.js";
import { redact } from "./redact.js";

export const BASE_BACKUP_FORMAT = "dune-base-backup";
export const BASE_BACKUP_FORMAT_VERSION = 1;

// Server-side limit for each statement inside an export/import transaction.
// The largest verified base (589 pieces, 199 items) exports in ~0.4 s.
// ADMIN_BASE_BACKUP_STATEMENT_TIMEOUT_MS overrides it (100 ms - 10 min).
function statementTimeoutMs() {
  // A blank value means unset; clampInt alone would read "" as 0 -> 100 ms.
  return clampInt(process.env.ADMIN_BASE_BACKUP_STATEMENT_TIMEOUT_MS || undefined, 120000, 100, 600000);
}
const MAX_ENTRIES = 250000;

// The game's reference rewrite walks every JSON node of a row but only changes
// string values starting with "!!". Skipping rows without one keeps a large
// base inside the query limit.
const HAS_TAGGED_ID = `data::text like '%"!!%'`;

const REQUIRED_TABLES = [
  "actors", "fgl_entities", "actor_fgl_entities", "permission_actor", "permission_actor_rank",
  "inventories", "items", "actor_inventories", "buildings", "building_instances", "placeables",
  "totems", "base_backups", "base_backup_linked_actors", "landclaim_segments", "tax_invoice",
  "sinkcharts", "building_blueprints", "building_blueprint_instances", "building_blueprint_placeables",
  "building_blueprint_pentashields", "player_state", "applied_patches"
];

const REQUIRED_FUNCTIONS = [
  "dune._character_transfer_create_data_table()",
  "dune._character_transfer_top_level_export(dune._charactertransferentrykind,jsonb)",
  "dune._character_transfer_top_level_import(dune._charactertransferentrykind,jsonb,bigint)",
  "dune._character_transfer_replace_local_id_with_transfer_id_in_json(jsonb,text)",
  "dune._character_transfer_replace_transfer_id_with_local_id_in_json(jsonb,text)",
  "dune._character_transfer_data_table_load(jsonb)",
  "dune._character_transfer_data_table_save()",
  "dune._character_transfer_get_patches_checksum()"
];

// Entry kinds an export may contain, in the order the import inserts them
// (the same dependency order as dune.character_transfer_import).
const IMPORT_ORDER = [
  { kind: "act", table: "actors", skipPlaceholder: true },
  { kind: "fgl", table: "fgl_entities" },
  { kind: "fgl", table: "actor_fgl_entities" },
  { kind: "PermissionActor", table: "permission_actor" },
  { kind: "PermissionActorRank", table: "permission_actor_rank" },
  { kind: "inv", table: "inventories" },
  { kind: "itm", table: "items" },
  { kind: "ActorInventory", table: "actor_inventories" },
  { kind: "Building", table: "buildings" },
  { kind: "BuildingInstance", table: "building_instances" },
  { kind: "Placeable", table: "placeables" },
  { kind: "Totem", table: "totems" },
  { kind: "BaseBackup", table: "base_backups" },
  { kind: "BaseBackupLinkedActor", table: "base_backup_linked_actors" },
  { kind: "LandclaimSegment", table: "landclaim_segments" },
  { kind: "TaxInvoice", table: "tax_invoice" },
  { kind: "Sinkchart", table: "sinkcharts" },
  { kind: "bbp", table: "building_blueprints" },
  { kind: "BuildingBlueprintInstance", table: "building_blueprint_instances" },
  { kind: "BuildingBlueprintPlaceable", table: "building_blueprint_placeables" },
  { kind: "BuildingBlueprintPentashield", table: "building_blueprint_pentashields" }
];

const ALLOWED_KINDS = new Set(IMPORT_ORDER.map((step) => step.kind));

const STEP_LABELS = {
  actors: "base actors",
  fgl_entities: "entity components",
  actor_fgl_entities: "entity links",
  permission_actor: "permissions",
  permission_actor_rank: "permission ranks",
  inventories: "storage inventories",
  items: "stored items",
  actor_inventories: "inventory links",
  buildings: "building actors",
  building_instances: "building pieces",
  placeables: "placeables",
  totems: "totem",
  base_backups: "backup record",
  base_backup_linked_actors: "backup links",
  landclaim_segments: "land claim segments",
  tax_invoice: "tax invoices",
  sinkcharts: "sinkcharts",
  building_blueprints: "stored blueprints",
  building_blueprint_instances: "stored blueprint pieces",
  building_blueprint_placeables: "stored blueprint placeables",
  building_blueprint_pentashields: "stored blueprint pentashields"
};

// Array lower bounds do not survive jsonb. The export stores a row's
// non-default bounds under this key in its entry data (jsonb_populate_record
// ignores unknown keys) and the import restores them before inserting.
const ARRAY_BOUNDS_KEY = "__lb";

// Base actors in the export table. $1 is the owner placeholder's transfer id:
// the placeholder stands for the player, not for a base actor.
const ACT_IDS = "(select id from pg_temp.export_data where kind = 'act' and transfer_id <> $1)";

// Every reference column an entry kind carries (mirroring the game's
// _character_transfer_get_filter) and what it may point at:
//   "act"         a base actor in this file, never the owner placeholder
//   "owner"       the owner placeholder (the receiving player), required
//   "actOrOwner"  either of the above
//   "absent"      must not be set (the export strips it)
//   any kind      an entry of that kind in this file
// A trailing "?" allows null. Without this a crafted file could hang rows off
// the receiving player's own actor (an inventory of arbitrary items, say).
const ENTRY_REFS = {
  act: {},
  fgl: { actor_id: "act" },
  PermissionActor: { actor_id: "act" },
  PermissionActorRank: { permission_actor_id: "act", player_id: "actOrOwner" },
  inv: { actor_id: "act" },
  itm: { inventory_id: "inv" },
  ActorInventory: { inventory_id: "inv" },
  Building: { id: "act" },
  BuildingInstance: { building_id: "act", owner_entity_id: "fgl?" },
  Placeable: { id: "act", owner_entity_id: "fgl?" },
  Totem: { id: "act" },
  BaseBackup: { player_id: "owner" },
  BaseBackupLinkedActor: { id: "BaseBackup", actor_id: "act" },
  LandclaimSegment: { totem_id: "act" },
  TaxInvoice: { totem_id: "act" },
  Sinkchart: { item_id: "itm" },
  bbp: { item_id: "itm", player_id: "absent" },
  BuildingBlueprintInstance: { building_blueprint_id: "bbp" },
  BuildingBlueprintPlaceable: { building_blueprint_id: "bbp" },
  BuildingBlueprintPentashield: { building_blueprint_id: "bbp" }
};

// Raw player-id columns the transfer filters copy verbatim. A source-server
// player id means nothing (or someone else) on the target, so the import
// points them at the receiving player.
const PLAYER_ID_COLUMNS = {
  base_backups: ["last_edited_by_player_id"],
  placeables: ["last_placed_by_player_id"],
  building_instances: ["last_placed_by_player_id"],
  permission_actor: ["edited_by_player_id"]
};

// Caps for strings copied from an uploaded file into responses and the audit log.
const MAX_ECHO_LENGTH = 200;
const MAX_ERROR_LENGTH = 1000;
function clip(value, max = MAX_ECHO_LENGTH) {
  const text = value == null ? "" : String(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export class BaseBackupError extends Error {
  constructor(message, { statusCode = 400, code = "invalid", details = {} } = {}) {
    super(message);
    this.name = "BaseBackupError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class BaseBackupTimeoutError extends BaseBackupError {
  constructor({ operation, step, kind, elapsedMs, limitMs }) {
    const seconds = (ms) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`);
    const outcome = operation === "export"
      ? "No file was produced."
      : `Nothing was changed: the ${operation} was rolled back.`;
    super(`Base backup ${operation} timed out after ${seconds(elapsedMs)} while ${step} (limit ${seconds(limitMs)}). ${outcome}`, {
      // Not 504: Cloudflare replaces an origin 502/504 body with its own page.
      statusCode: 503,
      code: "timeout",
      details: { operation, step, timeoutKind: kind, elapsedMs, limitMs }
    });
    this.name = "BaseBackupTimeoutError";
  }
}

// Maps an export/import failure to { status, body } for the HTTP routes.
// Timeouts become 503 with the step that ran out of time; version refusals
// 409 with both versions, so the UI can offer "Import Anyway".
export function baseBackupHttpError(error) {
  const message = clip(redact(error?.message || "Unexpected error."), MAX_ERROR_LENGTH);
  if (error?.unsupported) return { status: 501, body: { supported: false, error: message } };
  if (error instanceof BaseBackupError) {
    return { status: error.statusCode || 400, body: { ok: false, code: error.code, error: message, ...error.details } };
  }
  if (error?.statusCode === 404) return { status: 404, body: { ok: false, code: "not_found", error: message } };
  if (/^Invalid /.test(String(error?.message || ""))) return { status: 400, body: { ok: false, code: "invalid", error: message } };
  return { status: 500, body: { ok: false, error: message } };
}

// Client-side bound for each statement of an export/import transaction. It sits
// just above the server's statement_timeout so the server cancels first and the
// failure is classified as a server timeout; the pool's own 15 s query_timeout
// (ADMIN_DB_QUERY_TIMEOUT_MS) would otherwise end any statement longer than 15 s
// long before the 120 s limit, which large bases need.
const CLIENT_TIMEOUT_MARGIN_MS = 10000;
export function clientQueryTimeoutMs() {
  return statementTimeoutMs() + CLIENT_TIMEOUT_MARGIN_MS;
}

export function classifyTimeout(error) {
  const message = String(error?.message || "");
  if (error?.code === "57014" || /canceling statement due to statement timeout/i.test(message)) return "server_timeout";
  if (/query read timeout/i.test(message)) return "client_timeout";
  return null;
}

// Runs one export/import transaction, recording which step is executing so a
// timeout can be reported precisely. db.transaction rethrows a plain Error,
// so the classification has to be captured here, before that happens.
async function runTracked(db, operation, fn) {
  const state = { failure: null };
  const step = (tx) => async (label, sql, params = []) => {
    const started = Date.now();
    try {
      return await tx.query(sql, params);
    } catch (error) {
      const kind = classifyTimeout(error);
      if (kind && !state.failure) {
        state.failure = {
          operation,
          step: label,
          kind,
          elapsedMs: Date.now() - started,
          limitMs: kind === "server_timeout" ? statementTimeoutMs() : clientQueryTimeoutMs()
        };
      }
      throw error;
    }
  };
  try {
    return await db.transaction(async (tx) => fn(step(tx)), { queryTimeoutMs: clientQueryTimeoutMs() });
  } catch (error) {
    if (state.failure) throw new BaseBackupTimeoutError(state.failure);
    throw error;
  }
}

async function functionExists(db, signature) {
  const result = await db.query("select to_regprocedure($1) is not null as exists", [signature]);
  return Boolean(result.rows[0]?.exists);
}

export async function baseBackupCapabilities(db) {
  const [tables, functions] = await Promise.all([
    Promise.all(REQUIRED_TABLES.map((table) => tableExists(db, table))),
    Promise.all(REQUIRED_FUNCTIONS.map((signature) => functionExists(db, signature)))
  ]);
  const missing = [
    ...REQUIRED_TABLES.filter((_, index) => !tables[index]).map((table) => `dune.${table}`),
    ...REQUIRED_FUNCTIONS.filter((_, index) => !functions[index])
  ];
  // An older game build may lack an entry kind; that must read as unsupported,
  // not fail mid-transaction on an enum cast.
  const kinds = await db.query(`
    select case when to_regtype('dune._charactertransferentrykind') is null then null
                else (select array_agg(e::text) from unnest(enum_range(null::dune._charactertransferentrykind)) e) end as kinds`);
  const available = new Set(kinds.rows[0]?.kinds || []);
  // Character is only a temporary export helper; it remains forbidden in files.
  for (const kind of [...ALLOWED_KINDS, "Character"]) {
    if (!available.has(kind)) missing.push(`dune._charactertransferentrykind '${kind}'`);
  }
  return { supported: missing.length === 0, missing };
}

async function requireBaseBackupCapability(db) {
  const capability = await baseBackupCapabilities(db);
  if (!capability.supported) {
    throw new UnsupportedCapabilityError("Base backup export/import is not supported by this game database", { missing: capability.missing });
  }
}

function displayName(name, totemType) {
  const trimmed = String(name || "").trim();
  if (trimmed && !trimmed.startsWith("##")) return trimmed;
  return totemType ? String(totemType).replace(/_Placeable$/, "").replace(/_/g, " ") : "Unnamed base";
}

function mapBackupRow(row) {
  return {
    id: Number(row.id),
    ownerControllerId: row.owner_controller_id == null ? null : Number(row.owner_controller_id),
    ownerPawnId: row.owner_pawn_id == null ? null : Number(row.owner_pawn_id),
    ownerName: row.owner_name || "",
    name: displayName(row.name, row.totem_type),
    rawName: row.name || "",
    map: row.map || "",
    totemType: row.totem_type || "",
    pieces: Number(row.pieces || 0),
    placeables: Number(row.placeables || 0),
    items: Number(row.items || 0)
  };
}

const LIST_SQL = `
  select bb.id,
         bb.player_id as owner_controller_id,
         ps.player_pawn_id as owner_pawn_id,
         coalesce(ps.character_name, '') as owner_name,
         coalesce(bb.base_backup_name, '') as name,
         totem.map,
         totem.totem_type,
         (select count(*) from dune.building_instances bi
            join dune.base_backup_linked_actors l on l.actor_id = bi.building_id
           where l.id = bb.id) as pieces,
         (select count(*) from dune.placeables p
            join dune.base_backup_linked_actors l on l.actor_id = p.id
           where l.id = bb.id) as placeables,
         (select count(*) from dune.items it
            join dune.inventories inv on inv.id = it.inventory_id
            join dune.base_backup_linked_actors l on l.actor_id = inv.actor_id
           where l.id = bb.id) as items
  from dune.base_backups bb
  left join dune.player_state ps on ps.player_controller_id = bb.player_id
  left join lateral (
    select a.map, p.building_type as totem_type
    from dune.base_backup_linked_actors l
    join dune.totems t on t.id = l.actor_id
    join dune.actors a on a.id = t.id
    left join dune.placeables p on p.id = t.id
    where l.id = bb.id
    limit 1
  ) totem on true`;

export async function listBaseBackups(db, { playerId = "" } = {}) {
  const capability = await baseBackupCapabilities(db);
  if (!capability.supported) {
    return { supported: false, capabilities: { baseBackups: false }, missing: capability.missing, rows: [] };
  }
  let where = "";
  const params = [];
  if (playerId !== "" && playerId != null) {
    const player = await resolvePlayerTarget(db, playerId);
    params.push(player.controllerId);
    where = "where bb.player_id = $1";
  }
  const result = await db.query(`${LIST_SQL} ${where} order by bb.id`, params);
  const maps = await buildableMaps((sql, values) => db.query(sql, values));
  return { supported: true, capabilities: { baseBackups: true }, rows: result.rows.map(mapBackupRow), maps };
}

async function getBaseBackupSummary(db, backupId) {
  const result = await db.query(`${LIST_SQL} where bb.id = $1`, [backupId]);
  if (!result.rows[0]) throw new BaseBackupError(`Base backup ${backupId} not found`, { statusCode: 404, code: "not_found" });
  return mapBackupRow(result.rows[0]);
}

export async function serverGameVersion(db) {
  const result = await db.query(`
    select dune._character_transfer_get_patches_checksum() as checksum,
           (select count(*)::int from dune.applied_patches) as patch_count,
           (select coalesce(json_agg(name order by date desc), '[]'::json)
              from (select name, date from dune.applied_patches order by date desc limit 5) latest) as latest`);
  const row = result.rows[0] || {};
  return {
    patchesChecksum: row.checksum || "",
    appliedPatchesCount: Number(row.patch_count || 0),
    latestPatches: Array.isArray(row.latest) ? row.latest : []
  };
}

// Column names/types of the game tables, read from the live catalog so new
// columns (array or player-id) are handled without a code change.
const COLUMNS_SQL = `
  select c.relname as table_name, a.attname as column_name,
         format_type(a.atttypid, a.atttypmod) as column_type, t.typcategory = 'A' as is_array
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_type t on t.oid = a.atttypid
  where n.nspname = 'dune' and c.relname = any($1::text[]) and a.attnum > 0 and not a.attisdropped
  order by c.relname, a.attnum`;

function columnsByTable(rows) {
  const byTable = new Map();
  for (const row of rows) {
    if (!byTable.has(row.table_name)) byTable.set(row.table_name, []);
    byTable.get(row.table_name).push({ name: row.column_name, type: row.column_type, isArray: row.is_array === true });
  }
  return byTable;
}

const IMPORT_TABLES = [...new Set(IMPORT_ORDER.map((step) => step.table))];

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
// A one-dimensional array type name as rendered by format_type, e.g.
// "real[]", "smallint[]", "dune.some_type[]". Interpolated into a cast, so it
// is checked rather than trusted.
const ARRAY_TYPE = /^(?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_ ]*\[\]$/;
function arrayTypeName(type) {
  const value = String(type || "");
  if (!ARRAY_TYPE.test(value)) throw new BaseBackupError(`Unexpected array column type ${value}`, { statusCode: 500, code: "internal" });
  return value;
}
function quoteIdent(name) {
  if (!IDENTIFIER.test(name)) throw new BaseBackupError(`Unexpected identifier ${name}`, { statusCode: 500, code: "internal" });
  return `"${name}"`;
}

// `|| {"__lb": {"transform": 0}}` for a row whose arrays are not 1-based,
// `|| {}` otherwise. 1 is what jsonb_populate_record produces anyway.
function boundsExpression(table, columns) {
  const arrays = (columns.get(table) || []).filter((column) => column.isArray);
  if (!arrays.length) return "";
  const pairs = arrays
    .map((column) => `'${column.name}', nullif(array_lower(${quoteIdent(table)}.${quoteIdent(column.name)}, 1), 1)`)
    .join(", ");
  return ` || coalesce((select jsonb_build_object('${ARRAY_BOUNDS_KEY}', bounds)
            from (select jsonb_strip_nulls(jsonb_build_object(${pairs})) as bounds) b
            where bounds <> '{}'::jsonb), '{}'::jsonb)`;
}

// Export steps: [label, param, sql]. Each statement takes one parameter, $1:
// "backup" (the backup id), "placeholder" (the owner placeholder's transfer
// id) or none. /*BOUNDS*/ becomes that table's array-bounds expression.
// Mirrors the base-backup sections of dune.character_transfer_export, scoped
// to one backup, plus the permission rows it also carries for exported actors.
const EXPORT_ACT = ACT_IDS;
const EXPORT_STEPS = [
  ["exporting base actors", "backup", `
    insert into pg_temp.export_data(id, kind, data)
    select id, 'act', dune._character_transfer_top_level_export('act', to_jsonb(actors) - 'partition_id')/*BOUNDS*/
    from dune.actors where id in (select actor_id from dune.base_backup_linked_actors where id = $1)`],
  ["exporting entity components", "placeholder", `
    insert into pg_temp.export_data(id, kind, data)
    select entity_id, 'fgl', dune._character_transfer_top_level_export('fgl', to_jsonb(fgl_entities) || to_jsonb(actor_fgl_entities))/*BOUNDS*/
    from dune.actor_fgl_entities join dune.fgl_entities using (entity_id)
    where actor_id in ${EXPORT_ACT}`],
  ["exporting permissions", "placeholder", `
    insert into pg_temp.export_data(id, kind, data)
    select actor_id, 'PermissionActor', dune._character_transfer_top_level_export('PermissionActor', to_jsonb(permission_actor))/*BOUNDS*/
    from dune.permission_actor where actor_id in ${EXPORT_ACT}`],
  ["exporting permission ranks", "placeholder", `
    insert into pg_temp.export_data(id, kind, data)
    select permission_actor_id, 'PermissionActorRank', dune._character_transfer_top_level_export('PermissionActorRank', to_jsonb(permission_actor_rank))/*BOUNDS*/
    from dune.permission_actor_rank
    where permission_actor_id in ${EXPORT_ACT}
      and player_id in (select id from pg_temp.export_data where kind = 'act')`],
  ["exporting storage inventories", "placeholder", `
    insert into pg_temp.export_data(id, kind, data)
    select id, 'inv', dune._character_transfer_top_level_export('inv', to_jsonb(inventories))/*BOUNDS*/
    from dune.inventories where actor_id in ${EXPORT_ACT}`],
  ["exporting stored items", null, `
    insert into pg_temp.export_data(id, kind, data)
    select id, 'itm', dune._character_transfer_top_level_export('itm', to_jsonb(items))/*BOUNDS*/
    from dune.items where inventory_id in (select id from pg_temp.export_data where kind = 'inv')`],
  ["exporting inventory links", null, `
    insert into pg_temp.export_data(id, kind, data)
    select null, 'ActorInventory', dune._character_transfer_top_level_export('ActorInventory', to_jsonb(actor_inventories))/*BOUNDS*/
    from dune.actor_inventories where inventory_id in (select id from pg_temp.export_data where kind = 'inv')`],
  ["exporting building actors", "placeholder", `
    insert into pg_temp.export_data(id, kind, data)
    select null, 'Building', dune._character_transfer_top_level_export('Building', to_jsonb(buildings))/*BOUNDS*/
    from dune.buildings where id in ${EXPORT_ACT}`],
  ["exporting building pieces", "placeholder", `
    insert into pg_temp.export_data(id, kind, data)
    select null, 'BuildingInstance', dune._character_transfer_top_level_export('BuildingInstance', to_jsonb(building_instances))/*BOUNDS*/
    from dune.building_instances where building_id in ${EXPORT_ACT}`],
  ["exporting placeables", "placeholder", `
    insert into pg_temp.export_data(id, kind, data)
    select null, 'Placeable', dune._character_transfer_top_level_export('Placeable', to_jsonb(placeables))/*BOUNDS*/
    from dune.placeables where id in ${EXPORT_ACT}`],
  ["exporting totem", "placeholder", `
    insert into pg_temp.export_data(id, kind, data)
    select null, 'Totem', dune._character_transfer_top_level_export('Totem', to_jsonb(totems))/*BOUNDS*/
    from dune.totems where id in ${EXPORT_ACT}`],
  ["exporting backup record", "backup", `
    insert into pg_temp.export_data(id, kind, data)
    select id, 'BaseBackup', dune._character_transfer_top_level_export('BaseBackup', to_jsonb(base_backups))/*BOUNDS*/
    from dune.base_backups where id = $1`],
  ["exporting backup links", "backup", `
    insert into pg_temp.export_data(id, kind, data)
    select id, 'BaseBackupLinkedActor', dune._character_transfer_top_level_export('BaseBackupLinkedActor', to_jsonb(base_backup_linked_actors))/*BOUNDS*/
    from dune.base_backup_linked_actors where id = $1`],
  ["exporting land claim segments", "placeholder", `
    insert into pg_temp.export_data(id, kind, data)
    select null, 'LandclaimSegment', dune._character_transfer_top_level_export('LandclaimSegment', to_jsonb(landclaim_segments))/*BOUNDS*/
    from dune.landclaim_segments where totem_id in ${EXPORT_ACT}`],
  ["exporting tax invoices", "placeholder", `
    insert into pg_temp.export_data(id, kind, data)
    select id, 'TaxInvoice', dune._character_transfer_top_level_export('TaxInvoice', to_jsonb(tax_invoice))/*BOUNDS*/
    from dune.tax_invoice where totem_id in ${EXPORT_ACT}`],
  ["exporting sinkcharts", null, `
    insert into pg_temp.export_data(id, kind, data)
    select null, 'Sinkchart', dune._character_transfer_top_level_export('Sinkchart', to_jsonb(sinkcharts))/*BOUNDS*/
    from dune.sinkcharts where item_id in (select id from pg_temp.export_data where kind = 'itm')`],
  // A blueprint stored in a chest keeps its creator only on the source server.
  ["exporting stored blueprints", null, `
    insert into pg_temp.export_data(id, kind, data)
    select id, 'bbp', dune._character_transfer_top_level_export('bbp', to_jsonb(building_blueprints) - 'player_id')/*BOUNDS*/
    from dune.building_blueprints where item_id in (select id from pg_temp.export_data where kind = 'itm')`],
  ["exporting stored blueprint pieces", null, `
    insert into pg_temp.export_data(id, kind, data)
    select null, 'BuildingBlueprintInstance', dune._character_transfer_top_level_export('BuildingBlueprintInstance', to_jsonb(building_blueprint_instances))/*BOUNDS*/
    from dune.building_blueprint_instances where building_blueprint_id in (select id from pg_temp.export_data where kind = 'bbp')`],
  ["exporting stored blueprint placeables", null, `
    insert into pg_temp.export_data(id, kind, data)
    select null, 'BuildingBlueprintPlaceable', dune._character_transfer_top_level_export('BuildingBlueprintPlaceable', to_jsonb(building_blueprint_placeables))/*BOUNDS*/
    from dune.building_blueprint_placeables where building_blueprint_id in (select id from pg_temp.export_data where kind = 'bbp')`],
  ["exporting stored blueprint pentashields", null, `
    insert into pg_temp.export_data(id, kind, data)
    select null, 'BuildingBlueprintPentashield', dune._character_transfer_top_level_export('BuildingBlueprintPentashield', to_jsonb(building_blueprint_pentashields))/*BOUNDS*/
    from dune.building_blueprint_pentashields where building_blueprint_id in (select id from pg_temp.export_data where kind = 'bbp')`]
];

// A live (not picked-up) base: the actors the game's pickup would take
// (dune.base_backup_save_from_totem), read from pg_temp.live_base and
// pg_temp.live_base_actors. Differences from a backup export, as overrides of
// the steps above (null drops a step):
// - every actor in the state a pickup leaves it in, 'BaseBackup';
// - building actors as the fresh copies a pickup makes: class, map,
//   transform and dimension only, with no entity (the old one holds only
//   transient health/weather state; picked-up backups never have one);
// - only the pieces the totem owns (a pickup moves exactly those);
// - none of the totem's own permission rows or invoices (a pickup destroys
//   them: permission_actor_destroy, taxation_remove_invoices_from_totem);
// - the backup record and its links do not exist yet and are built here,
//   with the totem id as the record's local id.
const LIVE_BASE = "(select totem_id from pg_temp.live_base)";
const LIVE_STEP_OVERRIDES = {
  "exporting base actors": [null, `
    insert into pg_temp.export_data(id, kind, data)
    select id, 'act', dune._character_transfer_top_level_export('act', to_jsonb(actors) - 'partition_id'
      || jsonb_build_object('state', 'BaseBackup')
      || case when id in (select b.id from dune.buildings b) then jsonb_build_object(
           'gas_attributes', '{}'::jsonb, 'properties', '{}'::jsonb, 'owner_account_id', null, 'serial', 0)
         else '{}'::jsonb end)/*BOUNDS*/
    from dune.actors where id in (select actor_id from pg_temp.live_base_actors)`],
  "exporting entity components": ["placeholder", `
    insert into pg_temp.export_data(id, kind, data)
    select entity_id, 'fgl', dune._character_transfer_top_level_export('fgl', to_jsonb(fgl_entities) || to_jsonb(actor_fgl_entities))/*BOUNDS*/
    from dune.actor_fgl_entities join dune.fgl_entities using (entity_id)
    where actor_id in ${EXPORT_ACT} and actor_id not in (select b.id from dune.buildings b)`],
  "exporting permissions": ["placeholder", `
    insert into pg_temp.export_data(id, kind, data)
    select actor_id, 'PermissionActor', dune._character_transfer_top_level_export('PermissionActor', to_jsonb(permission_actor))/*BOUNDS*/
    from dune.permission_actor where actor_id in ${EXPORT_ACT} and actor_id <> ${LIVE_BASE}`],
  "exporting permission ranks": ["placeholder", `
    insert into pg_temp.export_data(id, kind, data)
    select permission_actor_id, 'PermissionActorRank', dune._character_transfer_top_level_export('PermissionActorRank', to_jsonb(permission_actor_rank))/*BOUNDS*/
    from dune.permission_actor_rank
    where permission_actor_id in ${EXPORT_ACT} and permission_actor_id <> ${LIVE_BASE}
      and player_id in (select id from pg_temp.export_data where kind = 'act')`],
  "exporting building pieces": ["placeholder", `
    insert into pg_temp.export_data(id, kind, data)
    select null, 'BuildingInstance', dune._character_transfer_top_level_export('BuildingInstance', to_jsonb(building_instances))/*BOUNDS*/
    from dune.building_instances
    where building_id in ${EXPORT_ACT} and owner_entity_id = (select entity_id from pg_temp.live_base)`],
  "exporting backup record": [null, `
    insert into pg_temp.export_data(id, kind, data)
    select totem_id, 'BaseBackup', dune._character_transfer_top_level_export('BaseBackup', jsonb_build_object(
      'id', totem_id, 'player_id', owner_id, 'base_backup_name', name, 'last_edited_by_player_id', 0))
    from pg_temp.live_base`],
  "exporting backup links": [null, `
    insert into pg_temp.export_data(id, kind, data)
    select lb.totem_id, 'BaseBackupLinkedActor', dune._character_transfer_top_level_export('BaseBackupLinkedActor',
      jsonb_build_object('id', lb.totem_id, 'actor_id', la.actor_id))
    from pg_temp.live_base lb cross join pg_temp.live_base_actors la order by la.actor_id`],
  "exporting tax invoices": null
};
const LIVE_EXPORT_STEPS = EXPORT_STEPS.flatMap(([label, param, sql]) => {
  if (!(label in LIVE_STEP_OVERRIDES)) return [[label, param, sql]];
  const override = LIVE_STEP_OVERRIDES[label];
  return override ? [[label, ...override]] : [];
});

// The base's totem, found as exportBaseAsBlueprint finds it: through the
// entity that owns the base's pieces. The 'Actor' slot only: a totem also has
// a ContainerInventory entity (the game's save_from_totem misses this filter).
// The owner is the rank-1 member, as the game defines it
// (base_backup_find_totems_from_player_owner); co-owners never stand in.
// Ordered, so the pre-check and the export always resolve the same totem.
const LIVE_BASE_SQL = `
  select t.id as totem_id, afe.entity_id,
         (select par.player_id from dune.permission_actor_rank par
           where par.permission_actor_id = t.id and par.rank = 1 order by par.player_id limit 1) as owner_id,
         coalesce((select pa.actor_name from dune.permission_actor pa where pa.actor_id = t.id), '') as name,
         a.state::text as state
  from dune.building_instances bi
  join dune.actor_fgl_entities afe on afe.entity_id = bi.owner_entity_id and afe.slot_name = 'Actor'
  join dune.totems t on t.id = afe.actor_id
  join dune.actors a on a.id = t.id
  where bi.building_id = $1
  order by t.id
  limit 1`;

// The same set base_backup_save_from_totem links: the totem, the placeables it
// owns that stand on the base, and the building actors holding its pieces.
const LIVE_ACTORS_SQL = `
  create temporary table live_base_actors on commit drop as
  select totem_id as actor_id from pg_temp.live_base
  union
  select p.id from dune.placeables p join pg_temp.live_base lb on p.owner_entity_id = lb.entity_id
   where p.has_buildable_support
  union
  select bi.building_id from dune.building_instances bi join pg_temp.live_base lb on bi.owner_entity_id = lb.entity_id`;

async function beginWork(run) {
  await run("starting transaction", `set local statement_timeout = ${statementTimeoutMs()}`);
  await run("starting transaction", "set local search_path = dune, public");
  await run("preparing transfer table", "select dune._character_transfer_create_data_table()");
}

// Runs the export steps in one repeatable-read snapshot and renders the file.
// `prepare(run)` sets the scope up and returns the owner's local id (the
// placeholder); `source(run)` describes what was exported.
async function renderExport(db, versionInfo, steps, params, prepare, source) {
  const game = await serverGameVersion(db);
  return runTracked(db, "export", async (run) => {
    await run("starting transaction", "set transaction isolation level repeatable read");
    await beginWork(run);
    const ownerId = await prepare(run);
    // The owner is a placeholder: never shipped as row data, remapped to the
    // receiving player on import.
    const placeholder = await run("reading backup owner",
      "insert into pg_temp.export_data(id, kind, data) values ($1, 'act', '{}'::jsonb) returning transfer_id",
      [ownerId]);
    const placeholderTransferId = Number(placeholder.rows[0].transfer_id);

    const columns = columnsByTable((await run("reading table columns", COLUMNS_SQL, [IMPORT_TABLES])).rows);
    for (const [label, param, sql] of steps) {
      const values = param === "placeholder" ? [placeholderTransferId] : param ? [params[param]] : [];
      // A built record (jsonb_build_object) has no table and no arrays.
      const table = sql.match(/to_jsonb\((\w+)\)/)?.[1];
      await run(label, sql.replace("/*BOUNDS*/", table ? boundsExpression(table, columns) : ""), values);
    }
    // The game's fallback for an unexported player reference reads the exporting
    // controller from a Character entry. Base exports use the owner placeholder
    // instead; this helper is transaction-local and never leaves in the file.
    await run("mapping outside players to the owner",
      "insert into pg_temp.export_data(id, kind, data) values (null, 'Character', jsonb_build_object('player_controller_id', $1::bigint))",
      [placeholderTransferId]);
    await run("rewriting internal references",
      `update pg_temp.export_data set data = dune._character_transfer_replace_local_id_with_transfer_id_in_json(data, '') where ${HAS_TAGGED_ID}`);
    await run("removing export helper", "delete from pg_temp.export_data where kind = 'Character'");

    const envelope = {
      format: BASE_BACKUP_FORMAT,
      version: BASE_BACKUP_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      source: await source(run),
      game: {
        build: versionInfo.gameBuild || "",
        steamBuildId: versionInfo.steamBuildId || null,
        ...game
      },
      console: { version: versionInfo.consoleVersion || "", buildId: versionInfo.consoleBuildId || "" },
      ownerPlaceholderTransferId: placeholderTransferId
    };
    // Postgres renders the whole file, entries included, as text.
    const rendered = await run("writing export file",
      "select jsonb_pretty($1::jsonb || jsonb_build_object('entries', coalesce(dune._character_transfer_data_table_save(), '[]'::jsonb))) as text",
      [JSON.stringify(envelope)]);
    return rendered.rows[0].text;
  });
}

// Returns { text, summary }: `text` is the complete export file, produced by
// Postgres so no payload value is ever parsed into a JavaScript number.
export async function exportBaseBackup(db, backupId, versionInfo = {}) {
  const id = intParam(backupId, "base backup id", 1);
  await requireBaseBackupCapability(db);
  const summary = await getBaseBackupSummary(db, id);
  const text = await renderExport(db, versionInfo, EXPORT_STEPS, { backup: id }, async (run) => {
    const owner = await run("reading backup owner", "select player_id from dune.base_backups where id = $1", [id]);
    if (!owner.rows[0]) throw new Error(`Base backup ${id} no longer exists`);
    return owner.rows[0].player_id;
  }, async () => ({
    backupId: summary.id,
    name: summary.name,
    rawName: summary.rawName,
    map: summary.map,
    totemType: summary.totemType,
    ownerName: summary.ownerName,
    counts: { pieces: summary.pieces, placeables: summary.placeables, items: summary.items }
  }));
  return { text, summary };
}

// Why a base cannot be exported as a backup, or null when it can.
function liveBaseRefusal(baseId, row) {
  if (!row) return new BaseBackupError(`Base ${baseId} not found, or it has no totem`, { statusCode: 404, code: "not_found" });
  if (row.state === "BaseBackup") {
    return new BaseBackupError("This base has been picked up with the base backup tool. Export it from Base Backups instead.",
      { statusCode: 409, code: "picked_up" });
  }
  if (row.owner_id == null) {
    return new BaseBackupError("This base has no owner, so it cannot be saved as a base backup. Download it as a blueprint instead.",
      { statusCode: 409, code: "no_owner" });
  }
  return null;
}

// Resolves a Bases row (a building actor id) to its totem, refusing what
// cannot become a backup. Runs before the export transaction so the refusal
// keeps its status code.
async function liveBaseSummary(db, baseId) {
  const result = await db.query(`
    with base as (${LIVE_BASE_SQL})
    select base.*, a.map, p.building_type as totem_type, coalesce(ps.character_name, '') as owner_name
    from base
    join dune.actors a on a.id = base.totem_id
    left join dune.placeables p on p.id = base.totem_id
    left join dune.player_state ps on ps.player_controller_id = base.owner_id`, [baseId]);
  const row = result.rows[0];
  const refusal = liveBaseRefusal(baseId, row);
  if (refusal) throw refusal;
  return {
    baseId,
    totemId: Number(row.totem_id),
    name: displayName(row.name, row.totem_type),
    rawName: row.name || "",
    map: row.map || "",
    totemType: row.totem_type || "",
    ownerName: row.owner_name || ""
  };
}

// Exports a live base, one that has not been picked up, as the same file a
// pickup followed by a backup export would give. Read-only: the base and
// everything in it are left exactly as they are.
export async function exportLiveBase(db, baseId, versionInfo = {}) {
  const id = intParam(baseId, "base id", 1);
  await requireBaseBackupCapability(db);
  const summary = await liveBaseSummary(db, id);
  // Checked again inside the snapshot: the base may have been picked up (or
  // lost its owner) since the pre-check. db.transaction drops custom error
  // properties, so the refusal is carried out here and rethrown with them.
  let refusal = null;
  const renderLive = () => renderExport(db, versionInfo, LIVE_EXPORT_STEPS, {}, async (run) => {
    await run("finding the base's totem", `create temporary table live_base on commit drop as ${LIVE_BASE_SQL}`, [id]);
    const base = await run("finding the base's totem", "select totem_id, owner_id, state from pg_temp.live_base");
    const row = base.rows[0];
    refusal = liveBaseRefusal(id, row);
    if (refusal) throw new Error(refusal.message);
    await run("collecting the base's actors", LIVE_ACTORS_SQL);
    return row.owner_id;
  }, async (run) => {
    const counts = (await run("counting exported rows", `
      select count(*) filter (where kind = 'BuildingInstance')::int as pieces,
             count(*) filter (where kind = 'Placeable')::int as placeables,
             count(*) filter (where kind = 'itm')::int as items
      from pg_temp.export_data`)).rows[0];
    Object.assign(summary, counts);
    return {
      kind: "live-base",
      baseId: id,
      backupId: null,
      name: summary.name,
      rawName: summary.rawName,
      map: summary.map,
      totemType: summary.totemType,
      ownerName: summary.ownerName,
      counts: { pieces: counts.pieces, placeables: counts.placeables, items: counts.items }
    };
  });
  let text;
  try {
    text = await renderLive();
  } catch (error) {
    if (refusal) throw refusal;
    throw error;
  }
  return { text, summary };
}

// Upgrades an older export to the current format. Version 1 is current.
// A future upgrade that has to rewrite entries must do it in SQL (or on
// lossless text), never through JSON.parse'd payload numbers.
export function upgradeEnvelope(file) {
  if (file.version === BASE_BACKUP_FORMAT_VERSION) return file;
  throw new BaseBackupError(`Unsupported base backup file version ${file.version}`, { code: "unsupported_version" });
}

function transferIdOf(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

// Structural validation. Transfer ids are small sequential integers, so
// reading them here is safe; payload values are never interpreted.
export function validateBaseBackupFile(parsed) {
  const invalid = (message) => new BaseBackupError(message, { code: "invalid_file" });
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid("File is not a base backup export");
  if (parsed.format !== BASE_BACKUP_FORMAT) throw invalid("File is not a base backup export (unknown format)");
  const file = upgradeEnvelope(parsed);
  const entries = file.entries;
  if (!Array.isArray(entries) || entries.length === 0) throw invalid("Base backup file has no entries");
  if (entries.length > MAX_ENTRIES) throw invalid(`Base backup file has too many entries (${entries.length})`);

  const placeholder = transferIdOf(file.ownerPlaceholderTransferId);
  if (!placeholder) throw invalid("Base backup file is missing its owner placeholder");

  const seen = new Set();
  const counts = {};
  const actIds = new Set();
  let backupTransferId = null;
  let placeholderFound = false;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") throw invalid("Base backup file has a malformed entry");
    const transferId = transferIdOf(entry.id);
    if (!transferId) throw invalid("Base backup file has an entry without a valid id");
    if (seen.has(transferId)) throw invalid(`Base backup file repeats entry id ${transferId}`);
    seen.add(transferId);
    if (!ALLOWED_KINDS.has(entry.kind)) throw invalid(`Base backup file contains an unsupported entry kind: ${String(entry.kind)}`);
    if (!entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) throw invalid(`Base backup entry ${transferId} has no data`);
    counts[entry.kind] = (counts[entry.kind] || 0) + 1;
    if (entry.kind === "act") {
      if (transferId === placeholder) placeholderFound = true;
      else actIds.add(transferId);
    }
    if (entry.kind === "BaseBackup") backupTransferId = transferId;
  }
  if (!placeholderFound) throw invalid("Base backup file is missing its owner placeholder");
  if (counts.BaseBackup !== 1) throw invalid("Base backup file must contain exactly one backup record");
  if (!counts.Totem) throw invalid("Base backup file has no totem");

  // Every reference must resolve inside the base (see ENTRY_REFS).
  const idsByKind = new Map();
  for (const entry of entries) {
    const transferId = transferIdOf(entry.id);
    if (entry.kind === "act" && transferId === placeholder) continue;
    if (!idsByKind.has(entry.kind)) idsByKind.set(entry.kind, new Set());
    idsByKind.get(entry.kind).add(transferId);
  }
  const linked = new Set();
  for (const entry of entries) {
    if (entry.kind === "act" && transferIdOf(entry.id) === placeholder) {
      if (Object.keys(entry.data).length) throw invalid("Base backup file's owner placeholder carries data");
      continue;
    }
    for (const [key, rule] of Object.entries(ENTRY_REFS[entry.kind])) {
      const raw = entry.data[key];
      const target = rule.replace(/\?$/, "");
      const where = `${entry.kind} ${transferIdOf(entry.id)} ${key}`;
      if (target === "absent") {
        if (raw != null) throw invalid(`Base backup file sets ${where}, which an export never carries`);
        continue;
      }
      if (raw == null) {
        if (rule.endsWith("?")) continue;
        throw invalid(`Base backup file is missing ${where}`);
      }
      const ref = transferIdOf(raw);
      const isOwner = ref === placeholder;
      const isAct = ref != null && (idsByKind.get("act")?.has(ref) || false);
      const ok = target === "owner" ? isOwner
        : target === "actOrOwner" ? isOwner || isAct
          : target === "act" ? isAct
            : ref != null && (idsByKind.get(target)?.has(ref) || false);
      if (!ok) {
        throw invalid(isOwner
          ? `Base backup file points ${where} at the receiving player, which only the backup owner may do`
          : `Base backup file points ${where} outside the base`);
      }
    }
    if (entry.kind === "BaseBackupLinkedActor") linked.add(transferIdOf(entry.data.actor_id));
  }
  for (const actorId of actIds) {
    if (!linked.has(actorId)) throw invalid("Base backup file contains an actor that is not part of the backup");
  }

  return {
    file,
    placeholderTransferId: placeholder,
    counts
  };
}

// Parses the uploaded bytes for validation only. The same text is what gets
// sent to Postgres.
export function parseBaseBackupFile(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Worded to avoid the web client's generic "invalid JSON" rewrite, which
    // would blame the console's own saved data instead of the chosen file.
    throw new BaseBackupError("The selected file could not be read as JSON.", { code: "invalid_file" });
  }
  return validateBaseBackupFile(parsed);
}

export function versionComparison(fileGame = {}, serverGame = {}, serverBuild = "") {
  // File values are untrusted and end up in the response and audit log.
  const file = {
    build: clip(fileGame?.build, 64),
    steamBuildId: fileGame?.steamBuildId == null ? null : clip(fileGame.steamBuildId, 64),
    patchesChecksum: clip(fileGame?.patchesChecksum, 64),
    appliedPatchesCount: Number.isFinite(Number(fileGame?.appliedPatchesCount)) ? Number(fileGame.appliedPatchesCount) : 0
  };
  const server = {
    build: String(serverBuild || ""),
    patchesChecksum: String(serverGame.patchesChecksum || ""),
    appliedPatchesCount: Number(serverGame.appliedPatchesCount || 0)
  };
  return { mismatch: !file.patchesChecksum || file.patchesChecksum !== server.patchesChecksum, file, server };
}

export async function importBaseBackup(db, playerPawnId, fileText, { allowVersionMismatch = false, serverBuild = "" } = {}) {
  const text = Buffer.isBuffer(fileText) ? fileText.toString("utf8") : String(fileText ?? "");
  const { file, placeholderTransferId, counts } = parseBaseBackupFile(text);
  await requireBaseBackupCapability(db);

  const player = await resolvePlayerTarget(db, playerPawnId);
  if (!player.controllerId) throw new BaseBackupError("Target player has no player controller", { statusCode: 409, code: "invalid_target" });

  const version = versionComparison(file.game, await serverGameVersion(db), serverBuild);
  if (version.mismatch && !allowVersionMismatch) {
    throw new BaseBackupError("This base backup was exported from a different game version.", {
      statusCode: 409,
      code: "version_mismatch",
      details: { file: version.file, server: version.server }
    });
  }

  // Live columns of every target table; names and array types are checked
  // before they are interpolated into SQL.
  const columns = columnsByTable((await db.query(COLUMNS_SQL, [IMPORT_TABLES])).rows);
  for (const list of columns.values()) {
    for (const column of list) {
      quoteIdent(column.name);
      if (column.isArray) arrayTypeName(column.type);
    }
  }

  const result = await runTracked(db, "import", async (run) => {
    await beginWork(run);
    await run("loading the file",
      `select dune._character_transfer_data_table_load(
         (select coalesce(jsonb_agg(entry), '[]'::jsonb)
            from jsonb_array_elements($1::jsonb -> 'entries') entry
           where (entry ->> 'id')::bigint <> $2))`,
      [text, placeholderTransferId]);
    await run("mapping the owner to the receiving player",
      "insert into pg_temp.export_data(id, transfer_id, kind, data) values ($1, $2, 'act', '{}'::jsonb)",
      [player.controllerId, placeholderTransferId]);
    await run("rewriting internal references",
      `update pg_temp.export_data set data = dune._character_transfer_replace_transfer_id_with_local_id_in_json(data, '') where ${HAS_TAGGED_ID}`);

    // Each table's rows are staged first, so every per-row fix happens before
    // anything reaches a game table: array bounds, the backed-up actor state,
    // and source-server player ids.
    const staged = "pg_temp.base_backup_import_rows";
    for (const { kind, table, skipPlaceholder } of IMPORT_ORDER) {
      const label = `inserting ${STEP_LABELS[table]}`;
      const tableColumns = columns.get(table) || [];
      const has = (name) => tableColumns.some((column) => column.name === name);
      await run(label, `drop table if exists ${staged}`);
      await run(label, `
        create temp table base_backup_import_rows on commit drop as
        select jsonb_populate_record(null::dune.${table}, dune._character_transfer_top_level_import(kind, data, id)) as r,
               data -> '${ARRAY_BOUNDS_KEY}' as lb
        from pg_temp.export_data where kind = $1 ${skipPlaceholder ? "and transfer_id <> $2" : ""}`,
        skipPlaceholder ? [kind, placeholderTransferId] : [kind]);

      for (const column of tableColumns.filter((c) => c.isArray)) {
        const col = quoteIdent(column.name);
        await run(label, `
          update ${staged}
          set r.${col} = ('[' || (lb ->> $1) || ':' || ((lb ->> $1)::int + cardinality((r).${col}) - 1) || ']=' || ((r).${col})::text)::${arrayTypeName(column.type)}
          where lb ? $1 and (lb ->> $1) in ('0', '1') and cardinality((r).${col}) > 0`, [column.name]);
      }

      const fixes = [];
      // An imported base belongs to no map partition until the player
      // redeploys it, whatever the file says.
      if (table === "actors" && has("partition_id")) fixes.push("r.partition_id = null");
      if (table === "actors" && has("state")) fixes.push("r.state = 'BaseBackup'");
      if (table === "buildings" && has("owner_id")) fixes.push("r.owner_id = null");
      for (const column of PLAYER_ID_COLUMNS[table] || []) {
        if (!has(column)) continue;
        const col = quoteIdent(column);
        fixes.push(`r.${col} = case when coalesce((r).${col}, 0) <> 0 then $1::bigint else (r).${col} end`);
      }
      if (fixes.length) {
        const usesPlayer = fixes.some((fix) => fix.includes("$1"));
        await run(label, `update ${staged} set ${fixes.join(", ")}`, usesPlayer ? [player.controllerId] : []);
      }

      await run(label, `insert into dune.${table} select (r).* from ${staged}`);
    }

    const created = await run("reading the new backup", "select id from pg_temp.export_data where kind = 'BaseBackup'");
    return { backupId: Number(created.rows[0].id) };
  });

  const warnings = [];
  if (String(player.onlineStatus).toLowerCase() === "online") {
    // Confirmed in-game: a running session never picks up an imported backup.
    warnings.push("The receiving player is online. They must log out and back in before the backup appears in their base backup tool.");
  }
  if (version.mismatch) {
    warnings.push("Imported despite a game version mismatch between the file and this server.");
  }
  return {
    ok: true,
    backupId: result.backupId,
    name: clip(file.source?.name),
    playerPawnId: player.actorId,
    playerControllerId: player.controllerId,
    online: String(player.onlineStatus).toLowerCase() === "online",
    counts: {
      actors: (counts.act || 1) - 1,
      pieces: counts.BuildingInstance || 0,
      placeables: counts.Placeable || 0,
      items: counts.itm || 0
    },
    version,
    warnings,
    warning: warnings.join(" ") || undefined
  };
}

// Maps a backup may be moved to: those where a claim totem has actually been
// placed on this server. Social hubs and dungeons never allow building, so an
// open list would let an admin strand a base on a map it cannot be placed on.
export async function buildableMaps(query) {
  const result = await query(`
    select distinct a.map from dune.totems t join dune.actors a on a.id = t.id
    where a.map is not null and a.map <> '' order by a.map`);
  return result.rows.map((row) => row.map);
}

// Longest real claim name seen on a live server; the game's own limit is not
// known, so stay inside what it has demonstrably stored and displayed.
export const BASE_BACKUP_NAME_MAX = 23;

export function validateBaseBackupName(value) {
  const name = String(value ?? "").trim();
  const invalid = (message) => new BaseBackupError(message, { code: "invalid_name" });
  if (!name) throw invalid("Backup name cannot be empty.");
  if (name.length > BASE_BACKUP_NAME_MAX) throw invalid(`Backup name can be at most ${BASE_BACKUP_NAME_MAX} characters.`);
  // "##..." is the game's own placeholder for an unnamed claim.
  if (name.startsWith("##")) throw invalid("Backup name cannot start with ##.");
  if (/[\u0000-\u001f\u007f]/.test(name)) throw invalid("Backup name cannot contain control characters.");
  return name;
}

// Reassigns a backup to another player, renames it and/or moves it to another
// map. The game only lets a backup be placed on the map it was saved on --
// base_backup_get_available_backups reports the totem actor's map -- so a move
// rewrites every linked actor's map, and clears its partition: a partition
// belongs to the old map, and imported backups (no partition) are proven to
// redeploy. Redeploying overwrites map, partition and dimension with the
// placing player's anyway (base_backup_finish_placing). The in-game tool
// caches its backup list per session, so the current owner must be offline:
// otherwise they could redeploy from the stale list after the reassign, and
// base_backup_finish_placing would take the map and partition from the new
// owner. The new owner only needs to relog to see it.
export async function updateBaseBackup(db, backupId, { ownerPlayerId, name, map } = {}) {
  const id = intParam(backupId, "base backup id", 1);
  const wantsOwner = ownerPlayerId !== undefined && ownerPlayerId !== null && ownerPlayerId !== "";
  const wantsName = name !== undefined && name !== null;
  const wantsMap = map !== undefined && map !== null && map !== "";
  if (!wantsOwner && !wantsName && !wantsMap) throw new BaseBackupError("Nothing to change.", { code: "no_change" });
  const newName = wantsName ? validateBaseBackupName(name) : null;
  await requireBaseBackupCapability(db);
  let newMap = null;
  if (wantsMap) {
    const allowed = await buildableMaps((sql, values) => db.query(sql, values));
    newMap = String(map);
    if (!allowed.includes(newMap)) {
      throw new BaseBackupError(`A backup can only be moved to a map where bases are built: ${allowed.join(", ") || "none found"}.`, {
        code: "invalid_map", details: { maps: allowed }
      });
    }
  }
  const newOwner = wantsOwner ? await resolvePlayerTarget(db, ownerPlayerId) : null;
  if (newOwner && !newOwner.controllerId) {
    throw new BaseBackupError("That player has no player controller.", { statusCode: 409, code: "invalid_target" });
  }

  const result = await runTracked(db, "edit", async (run) => {
    await run("starting transaction", `set local statement_timeout = ${statementTimeoutMs()}`);
    const current = await run("locking the backup", `
      select bb.player_id, coalesce(bb.base_backup_name, '') as name,
             coalesce(ps.character_name, '') as owner_name,
             coalesce(ps.online_status::text, 'Offline') as owner_status,
             (select a.map from dune.base_backup_linked_actors l
                join dune.totems t on t.id = l.actor_id
                join dune.actors a on a.id = t.id
              where l.id = bb.id limit 1) as map
      from dune.base_backups bb
      left join dune.player_state ps on ps.player_controller_id = bb.player_id
      where bb.id = $1
      for update of bb`, [id]);
    const row = current.rows[0];
    if (!row) return { missing: true };
    if (String(row.owner_status).toLowerCase() !== "offline") return { ownerOnline: true, ownerName: row.owner_name };

    const ownerChanged = Boolean(newOwner) && Number(row.player_id) !== newOwner.controllerId;
    const nameChanged = newName !== null && newName !== row.name;
    const mapChanged = newMap !== null && newMap !== row.map;
    if (!ownerChanged && !nameChanged && !mapChanged) return { unchanged: true };

    let movedActors = 0;
    if (mapChanged) {
      // Lock the actors too: a redeploy in flight rewrites them.
      const moved = await run("moving the base to the new map", `
        update dune.actors a set map = $2, partition_id = null
        where a.id in (select actor_id from dune.base_backup_linked_actors where id = $1)`, [id, newMap]);
      movedActors = Number(moved.rowCount || 0);
    }

    await run("saving the backup", `
      update dune.base_backups
      set player_id = case when $2 then $3::bigint else player_id end,
          last_edited_by_player_id = case when $2 then $3::bigint else last_edited_by_player_id end,
          base_backup_name = case when $4 then $5::text else base_backup_name end
      where id = $1`, [id, ownerChanged, ownerChanged ? newOwner.controllerId : null, nameChanged, newName]);
    return {
      owner: ownerChanged ? { from: Number(row.player_id), fromName: row.owner_name, to: newOwner.controllerId } : null,
      name: nameChanged ? { from: row.name, to: newName } : null,
      map: mapChanged ? { from: row.map || "", to: newMap, actors: movedActors } : null
    };
  });

  if (result.missing) {
    throw new BaseBackupError(`Base backup ${id} no longer exists. It may have been redeployed or recycled in-game.`, { statusCode: 404, code: "not_found" });
  }
  if (result.ownerOnline) {
    throw new BaseBackupError(`${result.ownerName || "The backup's owner"} is online. They must log out before this backup can be changed.`, {
      statusCode: 409, code: "owner_online", details: { ownerName: clip(result.ownerName) }
    });
  }
  if (result.unchanged) throw new BaseBackupError("Nothing to change: the backup already has that owner, name and map.", { code: "no_change" });

  const warnings = [];
  if (result.owner && String(newOwner.onlineStatus).toLowerCase() !== "offline") {
    warnings.push("The new owner is online. They must log out and back in before the backup appears in their base backup tool.");
  }
  return {
    ok: true,
    backupId: id,
    owner: result.owner,
    name: result.name,
    map: result.map,
    warnings,
    warning: warnings.join(" ") || undefined
  };
}

const DELETE_FUNCTION = "dune.base_backup_delete(bigint)";

async function requireDeleteCapability(db) {
  await requireBaseBackupCapability(db);
  if (!(await functionExists(db, DELETE_FUNCTION))) {
    throw new UnsupportedCapabilityError("Deleting base backups needs the game's dune.base_backup_delete function", { missing: [DELETE_FUNCTION] });
  }
}

function deleteBlockedError(row, id) {
  if (!row) {
    return new BaseBackupError(`Base backup ${id} no longer exists. It may have been redeployed or recycled in-game.`, { statusCode: 404, code: "not_found" });
  }
  if (String(row.owner_status || "").toLowerCase() !== "offline") {
    return new BaseBackupError(`${row.owner_name || "The backup's owner"} is online. They must log out before this backup can be deleted.`, {
      statusCode: 409, code: "owner_online", details: { ownerName: clip(row.owner_name) }
    });
  }
  return null;
}

const OWNER_STATUS_SQL = `
  select coalesce(ps.character_name, '') as owner_name,
         coalesce(ps.online_status::text, 'Offline') as owner_status
  from dune.base_backups bb
  left join dune.player_state ps on ps.player_controller_id = bb.player_id
  where bb.id = $1`;

// Cheap, non-locking check the route runs before its (slow) safety database
// backup, so an obviously blocked delete fails fast. deleteBaseBackup checks
// again under a row lock.
export async function checkBaseBackupDeletable(db, backupId) {
  const id = intParam(backupId, "base backup id", 1);
  await requireDeleteCapability(db);
  const current = await db.query(OWNER_STATUS_SQL, [id]);
  const blocked = deleteBlockedError(current.rows[0], id);
  if (blocked) throw blocked;
  return getBaseBackupSummary(db, id);
}

// Permanently deletes a picked-up base: every linked actor (and through the
// foreign keys its pieces, placeables, totem, storage and items) and the
// backup row, using the game's own dune.base_backup_delete. The current owner
// must be offline -- a stale in-game list could otherwise try to redeploy a
// backup that is gone. The caller takes a safety database backup first.
export async function deleteBaseBackup(db, backupId) {
  const id = intParam(backupId, "base backup id", 1);
  await requireDeleteCapability(db);

  const result = await runTracked(db, "delete", async (run) => {
    await run("starting transaction", `set local statement_timeout = ${statementTimeoutMs()}`);
    const current = await run("locking the backup", `${OWNER_STATUS_SQL} for update of bb`, [id]);
    const blocked = deleteBlockedError(current.rows[0], id);
    if (blocked) return { blocked };
    const summary = await run("reading the backup", `${LIST_SQL} where bb.id = $1`, [id]);
    await run("deleting the backup", "select dune.base_backup_delete($1)", [id]);
    const left = await run("checking the delete", `
      select (select count(*) from dune.base_backups where id = $1)::int as backups,
             (select count(*) from dune.base_backup_linked_actors where id = $1)::int as links`, [id]);
    if (left.rows[0].backups || left.rows[0].links) {
      // Rolls the whole delete back: never leave half a backup behind.
      throw new Error(`Base backup ${id} was not fully deleted; nothing was changed.`);
    }
    return { summary: mapBackupRow(summary.rows[0]) };
  });

  if (result.blocked) throw result.blocked;
  const { summary } = result;
  return {
    ok: true,
    backupId: id,
    name: summary.name,
    ownerName: summary.ownerName,
    map: summary.map,
    counts: { pieces: summary.pieces, placeables: summary.placeables, items: summary.items }
  };
}
