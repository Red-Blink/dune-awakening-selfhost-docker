import { assertIdentifier, intParam, isReadOnlySql, quoteIdentifier, quoteQualified, rowsResult } from "./db.js";

export class UnsupportedCapabilityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "UnsupportedCapabilityError";
    this.unsupported = true;
    this.details = details;
  }
}

export async function dbStatus(db) {
  const result = await db.query("select current_user, current_database(), version()");
  const tables = await db.query("select count(*)::int as count from information_schema.tables where table_schema = 'dune'");
  return { connected: true, config: db.config, server: result.rows[0], duneTableCount: tables.rows[0]?.count ?? 0, usesDefaultPassword: process.env.DUNE_DB_PASSWORD ? process.env.DUNE_DB_PASSWORD === "dune" : true };
}

export async function changeDunePassword(db, password) {
  const escaped = String(password).replaceAll("'", "''");
  await db.query(`alter role dune with password '${escaped}'`);
  return { ok: true, user: "dune" };
}

export async function listSchemas(db) {
  const result = await db.query("select schema_name from information_schema.schemata order by schema_name");
  return result.rows.map((row) => row.schema_name);
}

export async function listTables(db, schema = "dune") {
  assertIdentifier(schema, "schema");
  const result = await db.query(`
    select t.table_schema as schema,
           t.table_name as name,
           coalesce(s.n_live_tup, 0)::bigint as estimated_rows
    from information_schema.tables t
    left join pg_stat_user_tables s on s.schemaname = t.table_schema and s.relname = t.table_name
    where t.table_type = 'BASE TABLE' and t.table_schema = $1
    order by t.table_name`, [schema]);
  return result.rows;
}

export async function tableColumns(db, schema, table) {
  assertIdentifier(schema, "schema");
  assertIdentifier(table, "table");
  const result = await db.query(`
    select column_name as name, data_type, is_nullable, column_default
    from information_schema.columns
    where table_schema = $1 and table_name = $2
    order by ordinal_position`, [schema, table]);
  return result.rows;
}

export async function tableCount(db, schema, table) {
  const safe = quoteQualified(schema, table);
  const result = await db.query(`select count(*)::bigint as count from ${safe}`);
  return { schema, table, count: result.rows[0]?.count ?? "0" };
}

export async function tablePreview(db, schema, table, limit = 50, offset = 0) {
  const safe = quoteQualified(schema, table);
  const maxLimit = intParam(limit, "limit", 1, 500);
  const safeOffset = intParam(offset, "offset", 0);
  const result = await db.query(`select ctid::text as __rowid, * from ${safe} limit $1 offset $2`, [maxLimit, safeOffset]);
  return { schema, table, limit: maxLimit, offset: safeOffset, ...rowsResult(result) };
}

export async function updateTableRow(db, schema, table, rowId, values = {}) {
  assertIdentifier(schema, "schema");
  assertIdentifier(table, "table");
  const safe = quoteQualified(schema, table);
  const targetRow = String(rowId || "").trim();
  if (!/^\(\d+,\d+\)$/.test(targetRow)) throw new Error("Invalid row identifier");
  const columns = await tableColumns(db, schema, table);
  const editable = new Map(columns.map((column) => [column.name, column]));
  const entries = Object.entries(values || {}).filter(([key]) => key !== "__rowid" && editable.has(key));
  if (!entries.length) throw new Error("No editable column values were provided");
  if (entries.length > 100) throw new Error("Too many columns in one row update");

  const assignments = entries.map(([key], index) => `${quoteIdentifier(key)} = $${index + 1}`);
  const params = entries.map(([, value]) => normalizeEditableValue(value));
  params.push(targetRow);
  const result = await db.query(`update ${safe} set ${assignments.join(", ")} where ctid = $${params.length}::tid`, params);
  return { ok: true, updatedRows: result.rowCount || 0, schema, table };
}

function normalizeEditableValue(value) {
  if (value === undefined) return null;
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return value;
}

export async function searchDatabase(db, q) {
  const term = String(q || "").trim();
  if (!term) throw new Error("Search query is required");
  const result = await db.query(`
    select table_schema as schema, table_name as table, column_name as column, data_type
    from information_schema.columns
    where table_schema not in ('pg_catalog', 'information_schema')
      and (table_name ilike $1 or column_name ilike $1)
    order by table_schema, table_name, column_name
    limit 300`, [`%${term}%`]);
  return result.rows;
}

export async function runSql(db, query, allowDestructive = false) {
  const sql = String(query || "").trim();
  if (!sql) throw new Error("SQL query is required");
  if (!allowDestructive && !isReadOnlySql(sql)) throw new Error("Only read-only SQL is allowed without destructive confirmation");
  const result = await db.query(sql);
  return rowsResult(result);
}

export async function tableExists(db, name, schema = "dune") {
  const result = await db.query("select to_regclass($1) is not null as exists", [`${schema}.${name}`]);
  return Boolean(result.rows[0]?.exists);
}

export async function columnsFor(db, table, schema = "dune") {
  const result = await db.query(`
    select column_name
    from information_schema.columns
    where table_schema = $1 and table_name = $2`, [schema, table]);
  return new Set(result.rows.map((row) => row.column_name));
}

export async function listPlayers(db, { online = false, q = "" } = {}) {
  if (!(await tableExists(db, "actors")) || !(await tableExists(db, "player_state"))) {
    return unsupported("players", ["dune.actors", "dune.player_state"]);
  }
  const lastSeenSelect = await playerLastSeenSelect(db);
  const values = [];
  let where = "a.class ilike '%PlayerCharacter%'";
  if (online) where += " and coalesce(ps.online_status::text, '') = 'Online'";
  if (q) {
    values.push(`%${q}%`);
    where += ` and (ps.character_name ilike $${values.length} or ac."user" ilike $${values.length} or a.id::text = $${values.length} or a.owner_account_id::text = $${values.length})`;
  }
  const result = await db.query(`
    select a.id as actor_id,
           a.id as player_pawn_id,
           coalesce(a.owner_account_id, 0) as account_id,
           coalesce(ps.character_name, '') as character_name,
           coalesce(ps.player_controller_id, 0) as player_controller_id,
           coalesce(ac."user", '') as funcom_id,
           coalesce(ac."user", '') as fls_id,
           case
             when nullif(ac."user", '') is not null then ac."user"
             when a.owner_account_id is not null and a.owner_account_id <> 0 then a.owner_account_id::text
             else ''
           end as action_player_id,
           a.class,
           coalesce(a.map, '') as map,
           coalesce(ps.online_status::text, 'Offline') as online_status,
           ${lastSeenSelect} as last_seen
    from dune.actors a
    left join dune.player_state ps on ps.account_id = a.owner_account_id
    left join dune.accounts ac on ac.id = a.owner_account_id
    where ${where}
    order by lower(coalesce(ps.character_name, '')), a.id
    limit 500`, values);
  return { capabilities: { players: true, online }, rows: result.rows };
}

async function playerLastSeenSelect(db) {
  const candidates = [
    ["player_state", "ps", ["last_seen", "last_seen_at", "last_online", "last_online_at", "last_login", "last_login_at", "last_activity", "last_activity_at", "updated_at"]],
    ["actors", "a", ["last_seen", "last_seen_at", "last_online", "last_online_at", "last_login", "last_login_at", "last_activity", "last_activity_at", "updated_at"]],
    ["accounts", "ac", ["last_seen", "last_seen_at", "last_online", "last_online_at", "last_login", "last_login_at", "last_activity", "last_activity_at", "updated_at"]]
  ];
  for (const [table, alias, names] of candidates) {
    if (!(await tableExists(db, table))) continue;
    const columns = await columnsFor(db, table);
    const found = names.find((name) => columns.has(name));
    if (found) return `${alias}.${quoteIdentifier(found)}::text`;
  }
  return "''";
}

export async function playerProfile(db, id) {
  const actorId = intParam(id, "player id", 1);
  const result = await db.query(`
    select a.id as actor_id,
           a.id as player_pawn_id,
           coalesce(a.owner_account_id, 0) as account_id,
           coalesce(ps.character_name, '') as character_name,
           coalesce(ps.player_controller_id, 0) as player_controller_id,
           coalesce(ac."user", '') as funcom_id,
           coalesce(ac."user", '') as fls_id,
           case
             when nullif(ac."user", '') is not null then ac."user"
             when a.owner_account_id is not null and a.owner_account_id <> 0 then a.owner_account_id::text
             else ''
           end as action_player_id,
           a.class,
           coalesce(a.map, '') as map,
           coalesce(ps.online_status::text, 'Offline') as online_status
    from dune.actors a
    left join dune.player_state ps on ps.account_id = a.owner_account_id
    left join dune.accounts ac on ac.id = a.owner_account_id
    where a.id = $1`, [actorId]);
  if (!result.rows[0]) throw new Error("Player not found");
  return { capabilities: await playerCapabilities(db), player: result.rows[0] };
}

export async function playerInventory(db, id) {
  if (!(await tableExists(db, "items")) || !(await tableExists(db, "inventories"))) return unsupported("inventory", ["dune.items", "dune.inventories"]);
  const result = await db.query(`
    select i.id,
           i.template_id,
           i.stack_size,
           i.quality_level,
           i.position_index,
           i.inventory_id,
           coalesce((i.stats->'FItemStackAndDurabilityStats'->1->>'CurrentDurability'), null) as current_durability,
           coalesce((i.stats->'FItemStackAndDurabilityStats'->1->>'MaxDurability'), null) as max_durability,
           i.stats
    from dune.items i
    join dune.inventories inv on i.inventory_id = inv.id
    where inv.actor_id = $1
    order by i.template_id`, [intParam(id, "player id", 1)]);
  return { capabilities: { inventory: true }, rows: result.rows };
}

export async function playerCurrency(db, id) {
  if (!(await tableExists(db, "player_virtual_currency_balances"))) return unsupported("currency", ["dune.player_virtual_currency_balances"]);
  const actorId = intParam(id, "player id", 1);
  const result = await db.query(`
    select currency_id, balance
    from dune.player_virtual_currency_balances
    where player_controller_id = $1
       or player_controller_id = (select coalesce(player_controller_id, 0) from dune.player_state where player_pawn_id = $1 limit 1)
    order by currency_id`, [actorId]);
  return { capabilities: { currency: true }, rows: result.rows };
}

export async function playerFactions(db, id) {
  if (!(await tableExists(db, "player_faction_reputation"))) return unsupported("factions", ["dune.player_faction_reputation"]);
  const hasFactions = await tableExists(db, "factions");
  const result = await db.query(`
    select pfr.actor_id,
           pfr.faction_id,
           ${hasFactions ? "coalesce(f.name, '')" : "''"} as faction_name,
           pfr.reputation_amount
    from dune.player_faction_reputation pfr
    ${hasFactions ? "left join dune.factions f on f.id = pfr.faction_id" : ""}
    where pfr.actor_id = $1
    order by pfr.faction_id`, [intParam(id, "player id", 1)]);
  return { capabilities: { factions: true, factionNames: hasFactions }, rows: result.rows };
}

export async function playerSpecs(db, id) {
  if (!(await tableExists(db, "specialization_tracks"))) return unsupported("specs", ["dune.specialization_tracks"]);
  const result = await db.query(`
    select player_id, track_type::text, xp_amount, level
    from dune.specialization_tracks
    where player_id = $1
    order by track_type`, [intParam(id, "player id", 1)]);
  return { capabilities: { specs: true }, rows: result.rows };
}

export async function playerPosition(db, id) {
  const actorId = intParam(id, "player id", 1);
  try {
    const result = await db.query(`
      select id as actor_id, map, (transform).location::text as location, (transform).rotation::text as rotation
      from dune.actors
      where id = $1`, [actorId]);
    return { capabilities: { position: true }, position: result.rows[0] || null };
  } catch (error) {
    return { capabilities: { position: false }, reason: "dune.actors transform composite columns were not available", error: error.message };
  }
}

export async function liveMapCapabilities(db) {
  const actors = await tableExists(db, "actors");
  const playerState = await tableExists(db, "player_state");
  const vehicles = await tableExists(db, "vehicles");
  const placeables = await tableExists(db, "placeables");
  const buildings = await tableExists(db, "buildings");
  const worldPartition = await tableExists(db, "world_partition");
  const farmState = await tableExists(db, "farm_state");
  return {
    players: actors && playerState,
    vehicles: actors && vehicles,
    storage: actors && placeables,
    bases: actors && buildings,
    services: worldPartition,
    farmState,
    coordinateTransform: "Uses raw dune.actors.transform world coordinates; calibrated image/world transform is not verified."
  };
}

const LIVE_MAP_CONFIGS = {
  HaggaBasin: {
    key: "HaggaBasin",
    label: "Hagga Basin",
    actorMap: "HaggaBasin",
    image: "/images/maps/hagga-basin.png",
    width: 4096,
    height: 4096,
    minX: -456752.21,
    maxX: 354547.46,
    minY: -450630.14,
    maxY: 353821.95,
    flipY: false,
    defaultPartitionId: 1
  },
  DeepDesert: {
    key: "DeepDesert",
    label: "The Deep Desert",
    actorMap: "DeepDesert",
    image: "/images/maps/deep-desert.png",
    width: 4096,
    height: 4096,
    minX: -1268624.82,
    maxX: 1163312.83,
    minY: -1266548.17,
    maxY: 1162416.13,
    flipY: false,
    defaultPartitionId: 8
  }
};

export function liveMapConfigPayload(selected = "") {
  const key = LIVE_MAP_CONFIGS[selected] ? selected : "HaggaBasin";
  return {
    map: LIVE_MAP_CONFIGS[key],
    maps: LIVE_MAP_CONFIGS,
    defaultMap: "HaggaBasin"
  };
}

export async function liveMapPartitions(db) {
  if (!(await tableExists(db, "actors"))) return { rows: [] };
  const hasWorldPartition = await tableExists(db, "world_partition");
  const result = await db.query(`
    select coalesce(a.map, '') as map,
           coalesce(a.partition_id, 0) as partition_id,
           ${hasWorldPartition ? "coalesce(nullif(wp.label, ''), nullif(wp.map, ''), 'Partition ' || coalesce(a.partition_id, 0)::text)" : "'Partition ' || coalesce(a.partition_id, 0)::text"} as name,
           count(*)::int as marker_count
    from dune.actors a
    ${hasWorldPartition ? "left join dune.world_partition wp on wp.partition_id = a.partition_id" : ""}
    where a.transform is not null
    group by a.map, a.partition_id${hasWorldPartition ? ", wp.label, wp.map" : ""}
    order by map, partition_id`);
  return { rows: result.rows.map((row) => ({ ...row, partition_id: Number(row.partition_id || 0), marker_count: Number(row.marker_count || 0) })) };
}

export async function liveMapPlayers(db, map = "") {
  if (!(await tableExists(db, "actors")) || !(await tableExists(db, "player_state"))) return unsupportedMap("players", ["dune.actors", "dune.player_state"]);
  const values = [];
  const where = mapFilterClause(map, values, "a");
  try {
    const result = await db.query(`
      select a.id,
             'player' as type,
             coalesce(nullif(ps.character_name, ''), 'Unknown') as name,
             coalesce(ps.online_status::text, '') as online_status,
             coalesce(a.map, '') as map,
             coalesce(a.partition_id, 0) as partition_id,
             coalesce(a.class, '') as class,
             ((a.transform).location).x as x,
             ((a.transform).location).y as y,
             ((a.transform).location).z as z
      from dune.actors a
      join dune.player_state ps on ps.player_pawn_id = a.id
      where a.transform is not null ${where}
      order by coalesce(ps.online_status::text, '') desc, lower(coalesce(ps.character_name, ''))`, values);
    return { capabilities: { players: true }, rows: result.rows.map(normalizeMarker) };
  } catch (error) {
    return { capabilities: { players: false }, rows: [], reason: `Player marker transform query is unsupported by this schema: ${error.message}` };
  }
}

export async function liveMapVehicles(db, map = "") {
  if (!(await tableExists(db, "actors")) || !(await tableExists(db, "vehicles"))) return unsupportedMap("vehicles", ["dune.actors", "dune.vehicles"]);
  const values = [];
  const where = mapFilterClause(map, values, "a");
  try {
    const result = await db.query(`
      select a.id,
             'vehicle' as type,
             coalesce(a.class, '') as name,
             coalesce(a.map, '') as map,
             coalesce(a.partition_id, 0) as partition_id,
             coalesce(a.class, '') as class,
             ((a.transform).location).x as x,
             ((a.transform).location).y as y,
             ((a.transform).location).z as z
      from dune.vehicles v
      join dune.actors a on a.id = v.id
      where a.transform is not null ${where}
      order by a.map, a.partition_id, a.id`, values);
    return { capabilities: { vehicles: true }, rows: result.rows.map(normalizeMarker) };
  } catch (error) {
    return { capabilities: { vehicles: false }, rows: [], reason: `Vehicle marker transform query is unsupported by this schema: ${error.message}` };
  }
}

export async function liveMapStorage(db, map = "") {
  if (!(await tableExists(db, "actors")) || !(await tableExists(db, "placeables"))) return unsupportedMap("storage", ["dune.actors", "dune.placeables"]);
  const values = [];
  const where = mapFilterClause(map, values, "a");
  try {
    const result = await db.query(`
      select p.id,
             'storage' as type,
             coalesce(max(case when pa.actor_name not like '##%' and pa.actor_name <> 'None' then pa.actor_name end), p.building_type) as name,
             coalesce(a.map, '') as map,
             coalesce(a.partition_id, 0) as partition_id,
             p.building_type as class,
             count(i.id)::int as item_count,
             ((a.transform).location).x as x,
             ((a.transform).location).y as y,
             ((a.transform).location).z as z
      from dune.placeables p
      join dune.actors a on a.id = p.id
      left join dune.permission_actor pa on pa.actor_id = p.id
      left join dune.inventories inv on inv.actor_id = p.id
      left join dune.items i on i.inventory_id = inv.id
      where p.building_type in ('SpiceSilo_Placeable','GenericContainer_Placeable','StorageContainer_Placeable','MediumStorageContainer_Placeable')
        and a.transform is not null ${where}
      group by p.id, p.building_type, a.map, a.partition_id, a.transform
      order by a.map, a.partition_id, p.id`, values);
    return { capabilities: { storage: true }, rows: result.rows.map(normalizeMarker) };
  } catch (error) {
    return { capabilities: { storage: false }, rows: [], reason: `Storage marker transform query is unsupported by this schema: ${error.message}` };
  }
}

export async function liveMapBases(db, map = "") {
  if (!(await tableExists(db, "actors")) || !(await tableExists(db, "buildings"))) return unsupportedMap("bases", ["dune.actors", "dune.buildings"]);
  const values = [];
  const where = mapFilterClause(map, values, "a");
  try {
    const result = await db.query(`
      select b.id,
             'base' as type,
             coalesce(pa.actor_name, 'Base ' || b.id::text) as name,
             coalesce(a.map, '') as map,
             coalesce(a.partition_id, 0) as partition_id,
             coalesce(a.class, '') as class,
             ((a.transform).location).x as x,
             ((a.transform).location).y as y,
             ((a.transform).location).z as z
      from dune.buildings b
      join dune.building_instances bi on bi.building_id = b.id
      join dune.actor_fgl_entities afe on afe.entity_id = bi.owner_entity_id
      join dune.actors a on a.id = afe.actor_id
      left join dune.permission_actor pa on pa.actor_id = a.id
      where a.transform is not null ${where}
      group by b.id, pa.actor_name, a.id, a.map, a.partition_id, a.class, a.transform
      order by a.map, a.partition_id, b.id`, values);
    return { capabilities: { bases: true }, rows: result.rows.map(normalizeMarker) };
  } catch (error) {
    return { capabilities: { bases: false }, rows: [], reason: `Base marker transform query is unsupported by this schema: ${error.message}` };
  }
}

export async function liveMapServices(db, map = "") {
  if (!(await tableExists(db, "world_partition"))) return unsupportedMap("services", ["dune.world_partition"]);
  const hasFarm = await tableExists(db, "farm_state");
  const values = [];
  const where = mapFilterClause(map, values, "wp");
  const result = await db.query(`
    select wp.partition_id,
           'service' as type,
           coalesce(wp.label, wp.map || ' #' || wp.partition_id::text) as name,
           coalesce(wp.map, '') as map,
           coalesce(wp.dimension_index, 0) as dimension_index,
           coalesce(wp.server_id, '') as server_id,
           coalesce(wp.blocked, false) as blocked,
           ${hasFarm ? "coalesce(fs.alive, false)" : "false"} as alive,
           ${hasFarm ? "coalesce(fs.ready, false)" : "false"} as ready,
           ${hasFarm ? "coalesce(fs.connected_players, 0)" : "0"} as connected_players
    from dune.world_partition wp
    ${hasFarm ? "left join dune.farm_state fs on fs.server_id = wp.server_id" : ""}
    where 1=1 ${where}
    order by wp.map, wp.dimension_index, wp.partition_id`, values);
  return { capabilities: { services: true, farmState: hasFarm }, rows: result.rows };
}

export async function liveMapMarkers(db, map = "") {
  const [players, vehicles, bases, storage] = await Promise.all([
    liveMapPlayers(db, map),
    liveMapVehicles(db, map),
    liveMapBases(db, map),
    liveMapStorage(db, map)
  ]);
  return {
    capabilities: await liveMapCapabilities(db),
    overlays: {
      players: players.reason || "",
      vehicles: vehicles.reason || "",
      bases: bases.reason || "",
      storage: storage.reason || ""
    },
    rows: [
      ...(players.rows || []),
      ...(vehicles.rows || []),
      ...(bases.rows || []),
      ...(storage.rows || [])
    ]
  };
}

export async function unsupportedPlayerFeature(db, id, feature) {
  intParam(id, "player id", 1);
  return { capabilities: { [feature]: false }, rows: [], reason: `${feature} schema has not been detected in this database yet` };
}

export async function listStorage(db) {
  if (!(await tableExists(db, "placeables"))) return unsupported("storage", ["dune.placeables"]);
  const result = await db.query(`
    select p.id,
           coalesce(max(case when pa.actor_name not like '##%' and pa.actor_name <> 'None' then pa.actor_name end), '') as name,
           p.building_type as class,
           coalesce(a.map, '') as map,
           count(i.id)::int as item_count,
           coalesce(max(ps.character_name), '') as owner_name
    from dune.placeables p
    left join dune.actors a on a.id = p.id
    left join dune.permission_actor pa on pa.actor_id = p.id
    left join dune.inventories inv on inv.actor_id = p.id
    left join dune.items i on i.inventory_id = inv.id
    left join dune.actor_fgl_entities afe on afe.entity_id = p.owner_entity_id
    left join dune.permission_actor_rank par on par.permission_actor_id = afe.actor_id
    left join dune.actors player_a on player_a.id = par.player_id
    left join dune.player_state ps on ps.account_id = player_a.owner_account_id
    where p.building_type in ('SpiceSilo_Placeable','GenericContainer_Placeable','StorageContainer_Placeable','MediumStorageContainer_Placeable')
      and p.is_hologram = false and p.owner_entity_id is not null and p.owner_entity_id != 0
    group by p.id, p.building_type, a.map
    order by p.id`);
  return { capabilities: { storage: true, storageGiveItem: await supportsStorageGiveItem(db) }, rows: result.rows };
}

export async function storageItems(db, id) {
  return playerInventory(db, id);
}

export async function storageCapabilities(db) {
  return {
    storageGiveItem: await supportsStorageGiveItem(db)
  };
}

export async function exportRows(db, query) {
  const result = await runSql(db, query, false);
  return JSON.stringify(result, null, 2);
}

export async function addCurrency(db, id, { currencyId = 0, amount }) {
  await requireCapability(await supportsCurrencyMutation(db), "Currency mutation requires dune.player_virtual_currency_balances plus dune.adjust_player_virtual_currency_balance(bigint,smallint,bigint).");
  const delta = intParam(amount, "currency amount", -1000000000000, 1000000000000);
  if (delta === 0) throw new Error("Currency amount cannot be zero");
  const resolvedCurrencyId = await resolveCurrencyId(db, currencyId);
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    await tx.query("select dune.adjust_player_virtual_currency_balance($1::bigint, $2::smallint, $3::bigint)", [player.controllerId, resolvedCurrencyId, delta]);
    const balance = await tx.query(`
      select currency_id, balance
      from dune.player_virtual_currency_balances
      where player_controller_id = $1 and currency_id = $2`, [player.controllerId, resolvedCurrencyId]);
    return { ok: true, player, currencyId: resolvedCurrencyId, amount: delta, balance: balance.rows[0] || null };
  });
}

export async function addFactionReputation(db, id, { factionId, amount }) {
  await requireCapability(await supportsFactionMutation(db), "Faction reputation mutation requires dune.player_faction_reputation, dune.actors.properties, and dune.set_player_faction_reputation(bigint,smallint,integer).");
  const faction = intParam(factionId, "faction id", 1, 32767);
  const delta = intParam(amount, "faction reputation amount", -12474, 12474);
  if (delta === 0) throw new Error("Faction reputation amount cannot be zero");
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    const current = await tx.query(`
      select reputation_amount
      from dune.player_faction_reputation
      where actor_id = $1 and faction_id = $2`, [player.actorId, faction]);
    const oldValue = Number(current.rows[0]?.reputation_amount || 0);
    const nextValue = Math.max(0, Math.min(12474, oldValue + delta));
    await tx.query("select dune.set_player_faction_reputation($1::bigint, $2::smallint, $3::integer)", [player.actorId, faction, nextValue]);
    if (faction === 1 || faction === 2) await syncFactionComponent(tx, player.actorId);
    return { ok: true, player, factionId: faction, oldValue, newValue: nextValue };
  });
}

export async function deleteInventoryItem(db, playerId, itemId) {
  await requireCapability(await supportsInventoryDelete(db), "Inventory delete requires dune.items, dune.inventories, and dune.delete_item(bigint).");
  const safeItemId = intParam(itemId, "item id", 1);
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, playerId);
    const item = await tx.query(`
      select i.id, i.template_id, i.stack_size, i.quality_level, i.position_index, i.inventory_id, inv.actor_id
      from dune.items i
      join dune.inventories inv on inv.id = i.inventory_id
      where i.id = $1 and inv.actor_id = $2
      for update`, [safeItemId, player.actorId]);
    if (!item.rows[0]) throw new Error("Inventory item was not found in the selected player's directly-owned inventory");
    await tx.query("select dune.delete_item($1::bigint)", [safeItemId]);
    return { ok: true, player, deleted: item.rows[0] };
  });
}

export async function giveItemToStorage(db, storageId, { itemName = "", itemId = "", templateId = "", quantity = 1, quality = 0 }) {
  await requireCapability(await supportsStorageGiveItem(db), "Storage give-item requires compatible dune.inventories and dune.items insert columns.");
  const target = intParam(storageId, "storage id", 1);
  const resolvedTemplate = validateTemplateId(templateId || itemId || itemName);
  const stackSize = intParam(quantity, "quantity", 1, 1000000);
  const qualityLevel = intParam(quality, "quality", 0, 1000000);
  return db.transaction(async (tx) => {
    const storage = await tx.query(`
      select id, actor_id, coalesce(max_item_count, 0)::int as max_item_count, coalesce(max_item_volume, 0)::int as max_item_volume
      from dune.inventories
      where actor_id = $1
      order by id
      limit 1
      for update`, [target]);
    if (!storage.rows[0]) throw new Error("Storage inventory was not found for the selected storage actor");
    const inventory = storage.rows[0];
    const count = await tx.query("select count(*)::int as count from dune.items where inventory_id = $1", [inventory.id]);
    const currentCount = Number(count.rows[0]?.count || 0);
    if (inventory.max_item_count > 0 && currentCount >= inventory.max_item_count) throw new Error("Storage is full by item slot count");
    const position = await tx.query("select coalesce(max(position_index), -1)::int + 1 as position_index from dune.items where inventory_id = $1", [inventory.id]);
    const stats = {
      FCustomizationStats: [[], {}],
      FItemStackAndDurabilityStats: [[], {}]
    };
    const inserted = await tx.query(`
      insert into dune.items (inventory_id, template_id, stack_size, quality_level, position_index, stats)
      values ($1, $2, $3, $4, $5, $6::jsonb)
      returning id, template_id, stack_size, quality_level, position_index, inventory_id`, [
      inventory.id,
      resolvedTemplate,
      stackSize,
      qualityLevel,
      Number(position.rows[0]?.position_index || 0),
      JSON.stringify(stats)
    ]);
    return { ok: true, storage: inventory, inserted: inserted.rows[0] };
  });
}

export async function repairGear(db, id) {
  await requireCapability(await supportsRepairGear(db), "Repair gear requires dune.items.stats and dune.inventories.inventory_type.");
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    if (String(player.onlineStatus).toLowerCase() === "online") throw new Error("Repair gear requires the player to be offline so live state cannot overwrite the DB change");
    const items = await tx.query(`
      select i.id, i.stats
      from dune.items i
      join dune.inventories inv on inv.id = i.inventory_id
      where inv.actor_id = $1 and inv.inventory_type in (0, 1, 14, 15, 27, 30)
      for update`, [player.actorId]);
    let repaired = 0;
    for (const row of items.rows) {
      const stats = row.stats || {};
      const durability = stats.FItemStackAndDurabilityStats?.[1];
      if (!durability || typeof durability !== "object") continue;
      const target = repairTarget(durability);
      if (!target) continue;
      durability.CurrentDurability = target;
      durability.DecayedDurability = target;
      await tx.query("update dune.items set stats = $1::jsonb where id = $2", [JSON.stringify(stats), row.id]);
      repaired += 1;
    }
    return { ok: true, player, scanned: items.rows.length, repaired };
  });
}

export async function refuelVehicle(db, id, { vehicleId }) {
  await requireCapability(await supportsRefuelVehicle(db), "Refuel vehicle requires dune.actors.owner_account_id, class, and properties JSON.");
  const safeVehicleId = intParam(vehicleId, "vehicle id", 1);
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    if (String(player.onlineStatus).toLowerCase() === "online") throw new Error("Refuel vehicle requires the player to be offline so live state cannot overwrite the DB change");
    const vehicle = await tx.query(`
      select id, class, owner_account_id, properties
      from dune.actors
      where id = $1
      for update`, [safeVehicleId]);
    const row = vehicle.rows[0];
    if (!row) throw new Error("Vehicle actor was not found");
    if (Number(row.owner_account_id || 0) !== Number(player.accountId || 0)) throw new Error("Vehicle is not owned by the selected player's account");
    const bpClass = String(row.class || "").split(".").pop();
    if (!bpClass) throw new Error("Vehicle class could not be resolved");
    await tx.query(`
      update dune.actors
      set properties = jsonb_set(coalesce(properties, '{}'::jsonb), $1::text[], '1.0'::jsonb, true)
      where id = $2`, [[bpClass, "m_InitialFuel"], safeVehicleId]);
    return { ok: true, player, vehicle: { id: row.id, class: row.class } };
  });
}

async function playerCapabilities(db) {
  return {
    inventory: await tableExists(db, "items") && await tableExists(db, "inventories"),
    currency: await tableExists(db, "player_virtual_currency_balances"),
    factions: await tableExists(db, "player_faction_reputation"),
    specs: await tableExists(db, "specialization_tracks"),
    addCurrency: await supportsCurrencyMutation(db),
    addFactionReputation: await supportsFactionMutation(db),
    inventoryDelete: await supportsInventoryDelete(db),
    repairGear: await supportsRepairGear(db),
    refuelVehicle: await supportsRefuelVehicle(db),
    progression: false,
    events: false,
    stats: false,
    history: false
  };
}

async function supportsCurrencyMutation(db) {
  return await tableExists(db, "player_virtual_currency_balances") &&
    await functionExists(db, "dune.adjust_player_virtual_currency_balance(bigint,smallint,bigint)");
}

async function supportsFactionMutation(db) {
  if (!(await tableExists(db, "player_faction_reputation")) || !(await tableExists(db, "actors"))) return false;
  const actorColumns = await columnsFor(db, "actors");
  return actorColumns.has("properties") &&
    await functionExists(db, "dune.set_player_faction_reputation(bigint,smallint,integer)");
}

async function supportsInventoryDelete(db) {
  return await tableExists(db, "items") &&
    await tableExists(db, "inventories") &&
    await functionExists(db, "dune.delete_item(bigint)");
}

async function supportsStorageGiveItem(db) {
  if (!(await tableExists(db, "items")) || !(await tableExists(db, "inventories"))) return false;
  const inventoryColumns = await columnsFor(db, "inventories");
  const itemColumns = await columnsFor(db, "items");
  return ["id", "actor_id", "max_item_count", "max_item_volume"].every((column) => inventoryColumns.has(column)) &&
    ["inventory_id", "template_id", "stack_size", "quality_level", "position_index", "stats"].every((column) => itemColumns.has(column));
}

async function supportsRepairGear(db) {
  if (!(await tableExists(db, "items")) || !(await tableExists(db, "inventories"))) return false;
  const inventoryColumns = await columnsFor(db, "inventories");
  const itemColumns = await columnsFor(db, "items");
  return inventoryColumns.has("inventory_type") && itemColumns.has("stats");
}

async function supportsRefuelVehicle(db) {
  if (!(await tableExists(db, "actors"))) return false;
  const actorColumns = await columnsFor(db, "actors");
  return ["id", "class", "owner_account_id", "properties"].every((column) => actorColumns.has(column));
}

async function functionExists(db, signature) {
  const result = await db.query("select to_regprocedure($1) is not null as exists", [signature]);
  return Boolean(result.rows[0]?.exists);
}

async function requireCapability(supported, reason) {
  if (!supported) throw new UnsupportedCapabilityError(reason);
}

async function resolvePlayerMutationTarget(db, id) {
  const actorId = intParam(id, "player id", 1);
  const result = await db.query(`
    select a.id as actor_id,
           coalesce(a.owner_account_id, ps.account_id, 0) as account_id,
           coalesce(ps.player_controller_id, a.id) as controller_id,
           coalesce(ps.online_status::text, 'Offline') as online_status
    from dune.actors a
    left join dune.player_state ps on ps.player_pawn_id = a.id or ps.account_id = a.owner_account_id
    where a.id = $1
    limit 1`, [actorId]);
  const row = result.rows[0];
  if (!row) throw new Error("Player not found");
  return {
    actorId: Number(row.actor_id),
    accountId: Number(row.account_id || 0),
    controllerId: Number(row.controller_id || row.actor_id),
    onlineStatus: row.online_status || "Offline"
  };
}

async function resolveCurrencyId(db, currencyId) {
  const raw = String(currencyId ?? "0").trim().toLowerCase();
  if (!raw || raw === "0" || raw === "solaris") {
    if (!(await functionExists(db, "dune.get_solaris_id()"))) {
      throw new UnsupportedCapabilityError("Solaris currency requires dune.get_solaris_id() in this schema.");
    }
    const result = await db.query("select dune.get_solaris_id()::int as currency_id");
    return intParam(result.rows[0]?.currency_id, "currency id", 0, 32767);
  }
  return intParam(raw, "currency id", 0, 32767);
}

async function syncFactionComponent(db, actorId) {
  const result = await db.query(`
    select faction_id, reputation_amount
    from dune.player_faction_reputation
    where actor_id = $1 and faction_id in (1, 2)`, [actorId]);
  const reps = new Map(result.rows.map((row) => [Number(row.faction_id), Number(row.reputation_amount || 0)]));
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = [
    { Faction: { Name: "Atreides" }, timestamp, ReputationAmount: reps.get(1) || 0 },
    { Faction: { Name: "Harkonnen" }, timestamp, ReputationAmount: reps.get(2) || 0 }
  ];
  await db.query(`
    update dune.actors
    set properties = jsonb_set(coalesce(properties, '{}'::jsonb), '{FactionPlayerComponent,m_FactionDataArray}', $1::jsonb, true)
    where id = $2`, [JSON.stringify(payload), actorId]);
}

function validateTemplateId(value) {
  const raw = String(value || "").trim();
  if (/^[A-Za-z0-9_./:-]{1,240}$/.test(raw)) return raw;
  throw new Error("Invalid item template/id");
}

function repairTarget(durability) {
  const max = Number(durability.MaxDurability);
  const current = Number(durability.CurrentDurability || 0);
  const decayed = Number(durability.DecayedDurability || 0);
  const target = Number.isFinite(max) && max > 0 ? max : Math.max(current, decayed, 100);
  if (!Number.isFinite(target) || target <= 0) return 0;
  if (current >= target && decayed >= target) return 0;
  return target;
}

function validateMapName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^[A-Za-z0-9_:-]{1,80}$/.test(raw)) return raw;
  throw new Error("Invalid map name");
}

function mapFilterClause(map, values, alias) {
  const safe = validateMapName(map);
  if (!safe) return "";
  values.push(safe);
  return ` and ${alias}.map = $${values.length}`;
}

function normalizeMarker(row) {
  return {
    ...row,
    id: Number(row.id),
    partition_id: Number(row.partition_id || 0),
    x: Number(row.x),
    y: Number(row.y),
    z: Number(row.z)
  };
}

function unsupportedMap(feature, requiredTables) {
  return {
    capabilities: { [feature]: false },
    rows: [],
    reason: `Unsupported by detected schema. Missing required table(s): ${requiredTables.join(", ")}`
  };
}

function unsupported(feature, requiredTables) {
  return {
    capabilities: { [feature]: false },
    rows: [],
    reason: `Unsupported by detected schema. Missing required table(s): ${requiredTables.join(", ")}`
  };
}
