import { assertIdentifier, intParam, isReadOnlySql, quoteIdentifier, quoteQualified, rowsResult } from "./db.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  craftingRecipeCatalogRows,
  factionDisplayName,
  factionIdByName,
  factionTierBumps,
  journeyDepth,
  journeyDisplayName,
  journeyParentId,
  recipeCategory,
  recipeDisplayName,
  repairTarget,
  researchCategory,
  researchDisplayName,
  researchProductGroup,
  researchRecipeId,
  researchType,
  tagsForJourneyNodeSubtree,
  tutorialStatus,
  validateMapName,
  validateRecipeId,
  validateResearchKey,
  validateTemplateId,
  xpToLevel
} from "./duneDb/presentation.js";

const MAX_INTEL_POINTS = 2779;
const MAX_TABLE_PREVIEW_ROWS = 10000;
let craftingRecipeCatalogCache = null;

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
           t.table_name as name
    from information_schema.tables t
    where t.table_type = 'BASE TABLE' and t.table_schema = $1
    order by t.table_name`, [schema]);
  const rows = [];
  for (const row of result.rows) {
    const safe = quoteQualified(row.schema, row.name);
    const count = await db.query(`select count(*)::bigint as row_count from ${safe}`);
    rows.push({ ...row, row_count: count.rows[0]?.row_count ?? "0" });
  }
  return rows;
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

async function tablePrimaryKeyColumns(db, schema, table) {
  assertIdentifier(schema, "schema");
  assertIdentifier(table, "table");
  const result = await db.query(`
    select a.attname as name
    from pg_index i
    join pg_class c on c.oid = i.indrelid
    join pg_namespace n on n.oid = c.relnamespace
    join unnest(i.indkey) with ordinality as k(attnum, ordinality) on true
    join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
    where n.nspname = $1 and c.relname = $2 and i.indisprimary
    order by k.ordinality`, [schema, table]);
  return result.rows.map((row) => row.name).filter(Boolean);
}

export async function tableCount(db, schema, table) {
  const safe = quoteQualified(schema, table);
  const result = await db.query(`select count(*)::bigint as count from ${safe}`);
  return { schema, table, count: result.rows[0]?.count ?? "0" };
}

export async function tablePreview(db, schema, table, limit = 50, offset = 0) {
  const safe = quoteQualified(schema, table);
  const maxLimit = intParam(limit, "limit", 1, MAX_TABLE_PREVIEW_ROWS);
  const safeOffset = intParam(offset, "offset", 0);
  const primaryKeys = await tablePrimaryKeyColumns(db, schema, table);
  const rowIdSql = primaryKeys.length
    ? `json_build_object('pk', json_build_object(${primaryKeys.map((key) => `'${key}', ${quoteIdentifier(key)}`).join(", ")}))::text`
    : "ctid::text";
  const orderSql = primaryKeys.length
    ? ` order by ${primaryKeys.map((key) => quoteIdentifier(key)).join(", ")}`
    : " order by ctid";
  const result = await db.query(`select ${rowIdSql} as __rowid, * from ${safe}${orderSql} limit $1 offset $2`, [maxLimit, safeOffset]);
  return { schema, table, limit: maxLimit, offset: safeOffset, ...rowsResult(result) };
}

export async function updateTableRow(db, schema, table, rowId, values = {}) {
  assertIdentifier(schema, "schema");
  assertIdentifier(table, "table");
  const safe = quoteQualified(schema, table);
  const rowRef = await rowReference(db, schema, table, rowId);
  const columns = await tableColumns(db, schema, table);
  const editable = new Map(columns.map((column) => [column.name, column]));
  const entries = Object.entries(values || {}).filter(([key]) => key !== "__rowid" && editable.has(key));
  if (!entries.length) throw new Error("No editable column values were provided");
  if (entries.length > 100) throw new Error("Too many columns in one row update");

  if (schema === "dune" && table === "player_virtual_currency_balances" && Object.prototype.hasOwnProperty.call(values, "balance")) {
    return updateCurrencyBalanceViaGameFunction(db, safe, rowRef, values);
  }

  const itemEditMessage = schema === "dune" && table === "items" ? await manualItemEditMessage(db, safe, rowRef) : undefined;
  const assignments = entries.map(([key], index) => `${quoteIdentifier(key)} = $${index + 1}`);
  const params = entries.map(([, value]) => normalizeEditableValue(value));
  const whereParams = rowRef.params.map((value) => normalizeEditableValue(value));
  const result = await withKnownLiveRefresh(db, () => db.query(`update ${safe} set ${assignments.join(", ")} where ${rowWhereSql(rowRef, params.length)}`, [...params, ...whereParams]), {
    features: liveRefreshFeaturesForTable(schema, table, entries.map(([key]) => key))
  });
  return { ok: true, updatedRows: result.rowCount || 0, schema, table, message: result.rowCount ? itemEditMessage : undefined };
}

async function rowReference(db, schema, table, rowId) {
  const raw = String(rowId || "").trim();
  if (/^\(\d+,\d+\)$/.test(raw)) return { type: "ctid", params: [raw] };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid row identifier");
  }
  const pk = parsed?.pk;
  if (!pk || typeof pk !== "object" || Array.isArray(pk)) throw new Error("Invalid row identifier");

  const primaryKeys = await tablePrimaryKeyColumns(db, schema, table);
  if (!primaryKeys.length) throw new Error("This table does not expose a stable row identifier. Refresh the table and try again.");
  for (const key of primaryKeys) {
    if (!Object.prototype.hasOwnProperty.call(pk, key)) throw new Error("Row identifier is missing a primary key value");
  }
  return {
    type: "pk",
    columns: primaryKeys,
    params: primaryKeys.map((key) => pk[key])
  };
}

function rowWhereSql(rowRef, offset = 0, qualifier = "") {
  const prefix = qualifier ? `${quoteIdentifier(qualifier)}.` : "";
  if (rowRef.type === "ctid") return `${prefix}ctid = $${offset + 1}::tid`;
  return rowRef.columns.map((key, index) => `${prefix}${quoteIdentifier(key)} = $${offset + index + 1}`).join(" and ");
}

async function updateCurrencyBalanceViaGameFunction(db, safeTable, rowRef, values) {
  const current = await db.query(`select player_controller_id, currency_id, balance from ${safeTable} where ${rowWhereSql(rowRef)}`, rowRef.params);
  const row = current.rows[0];
  if (!row) return { ok: true, updatedRows: 0, schema: "dune", table: "player_virtual_currency_balances" };
  const controllerId = intParam(values.player_controller_id ?? row.player_controller_id, "player controller id", 1);
  const currencyId = intParam(values.currency_id ?? row.currency_id, "currency id", 0, 32767);
  if (String(controllerId) !== String(row.player_controller_id) || String(currencyId) !== String(row.currency_id)) {
    throw new Error("Currency row editing can change balance only. Edit player_controller_id or currency_id with explicit SQL if needed.");
  }
  const oldBalance = BigInt(String(row.balance ?? 0));
  const newBalance = BigInt(String(values.balance ?? 0));
  const delta = newBalance - oldBalance;
  if (delta !== 0n) {
    await db.query("select dune.adjust_player_virtual_currency_balance($1::bigint, $2::smallint, $3::bigint)", [controllerId, currencyId, delta.toString()]);
  }
  const state = await db.query(`
    select coalesce(online_status::text, 'Offline') as online_status
    from dune.player_state
    where player_controller_id = $1
    limit 1`, [controllerId]);
  const onlineStatus = state.rows[0]?.online_status || "Offline";
  const online = String(onlineStatus).toLowerCase() === "online";
  const direction = delta < 0n ? "lowered" : delta > 0n ? "increased" : "saved";
  const message = online
    ? `Currency balance was ${direction} in the database and the known game balance function was called. This player is online, so the running server may keep showing the old value until the player relogs or the affected map/server is restarted.`
    : `Currency balance was ${direction} in the database and will be loaded when the player next joins.`;
  return { ok: true, updatedRows: 1, schema: "dune", table: "player_virtual_currency_balances", message };
}

async function manualItemEditMessage(db, safeTable, rowRef) {
  const result = await db.query(`
    select it.id,
           it.template_id,
           coalesce(ps.character_name, 'this player') as character_name,
           coalesce(ps.online_status::text, 'Offline') as online_status
    from ${safeTable} it
    left join dune.inventories inv on inv.id = it.inventory_id
    left join dune.actors a on a.id = inv.actor_id
    left join dune.player_state ps on ps.account_id = a.owner_account_id
    where ${rowWhereSql(rowRef, 0, "it")}
    limit 1`, rowRef.params);
  const row = result.rows[0];
  if (!row) return undefined;
  if (String(row.online_status || "").toLowerCase() === "online") {
    return `${row.template_id || "Item"} was saved in the database for ${row.character_name}, but this player is online. The running game inventory may keep showing the old stack until the player relogs, refreshes inventory, or the affected map/server is restarted.`;
  }
  return `${row.template_id || "Item"} was saved in the database and will be loaded when the player next joins.`;
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
  const readOnly = isReadOnlySql(sql);
  if (!allowDestructive && !readOnly) throw new Error("Only read-only SQL is allowed without destructive confirmation");
  const result = readOnly
    ? await db.query(sql)
    : await withKnownLiveRefresh(db, () => db.query(sql), { features: liveRefreshFeaturesForSql(sql) });
  return rowsResult(result);
}

function liveRefreshFeaturesForTable(schema, table, columns = []) {
  if (schema !== "dune") return [];
  const changed = new Set(columns);
  if (table === "player_virtual_currency_balances" && changed.has("balance")) return ["solaris"];
  if (table === "player_faction_reputation" && changed.has("reputation_amount")) return ["faction"];
  if (table === "tutorial_per_player" && changed.has("tutorial_state")) return ["tutorial"];
  if (table === "journey_story_node") return ["journey"];
  if (table === "player_tags") return ["tags"];
  if (table === "player_faction") return ["playerFaction"];
  if (table === "specialization_tracks") return ["specialization"];
  if (table === "purchased_specialization_keystones") return ["keystones"];
  if (table === "mnemonic_recall") return ["mnemonic"];
  return [];
}

function liveRefreshFeaturesForSql(sql) {
  const text = String(sql || "").toLowerCase();
  const features = [];
  if (/\bplayer_virtual_currency_balances\b/.test(text) && !/adjust_player_virtual_currency_balance/i.test(sql)) features.push("solaris");
  if (/\bplayer_faction_reputation\b/.test(text)) features.push("faction");
  if (/\btutorial_per_player\b/.test(text)) features.push("tutorial");
  if (/\bjourney_story_node\b/.test(text)) features.push("journey");
  if (/\bplayer_tags\b/.test(text)) features.push("tags");
  if (/\bplayer_faction\b/.test(text)) features.push("playerFaction");
  if (/\bspecialization_tracks\b/.test(text)) features.push("specialization");
  if (/\bpurchased_specialization_keystones\b/.test(text)) features.push("keystones");
  if (/\bmnemonic_recall\b/.test(text)) features.push("mnemonic");
  if (/\bdelete\s+from\s+(?:dune\.)?items\b/.test(text)) features.push("itemDelete");
  return features;
}

async function withKnownLiveRefresh(db, fn, { features = [] } = {}) {
  const selected = new Set(features);
  if (!selected.size) return await fn();
  const solarisSupported = selected.has("solaris") && await supportsSolarisLiveRefresh(db);
  const solarisBefore = solarisSupported ? await solarisBalanceSnapshot(db) : new Map();
  const factionSupported = selected.has("faction") && await supportsFactionMutation(db);
  const factionBefore = factionSupported ? await factionReputationSnapshot(db) : new Map();
  const tutorialSupported = selected.has("tutorial") && await supportsTutorialLiveRefresh(db);
  const tutorialBefore = tutorialSupported ? await tutorialSnapshot(db) : new Map();
  const journeySupported = selected.has("journey") && await supportsJourneyLiveRefresh(db);
  const journeyBefore = journeySupported ? await journeySnapshot(db) : new Map();
  const tagsSupported = selected.has("tags") && await supportsTagsLiveRefresh(db);
  const tagsBefore = tagsSupported ? await playerTagsSnapshot(db) : new Map();
  const itemDeleteSupported = selected.has("itemDelete") && await supportsItemDeleteLiveRefresh(db);
  const itemsBefore = itemDeleteSupported ? await itemSnapshot(db) : new Map();
  const playerFactionSupported = selected.has("playerFaction") && await supportsPlayerFactionLiveRefresh(db);
  const playerFactionBefore = playerFactionSupported ? await playerFactionSnapshot(db) : new Map();
  const specializationSupported = selected.has("specialization") && await supportsSpecializationLiveRefresh(db);
  const specializationBefore = specializationSupported ? await specializationSnapshot(db) : new Map();
  const keystonesSupported = selected.has("keystones") && await supportsKeystoneLiveRefresh(db);
  const keystonesBefore = keystonesSupported ? await keystoneSnapshot(db) : new Map();
  const mnemonicSupported = selected.has("mnemonic") && await supportsMnemonicLiveRefresh(db);
  const mnemonicBefore = mnemonicSupported ? await mnemonicSnapshot(db) : new Map();
  const result = await fn();
  if (solarisSupported) {
    const solarisAfter = await solarisBalanceSnapshot(db);
    await emitChangedSolarisBalances(db, solarisBefore, solarisAfter);
  }
  if (factionSupported) {
    const factionAfter = await factionReputationSnapshot(db);
    await syncChangedFactionReputation(db, factionBefore, factionAfter);
  }
  if (tutorialSupported) {
    const tutorialAfter = await tutorialSnapshot(db);
    await syncChangedTutorials(db, tutorialBefore, tutorialAfter);
  }
  if (journeySupported) {
    const journeyAfter = await journeySnapshot(db);
    await syncChangedJourneyNodes(db, journeyBefore, journeyAfter);
  }
  if (tagsSupported) {
    const tagsAfter = await playerTagsSnapshot(db);
    await syncChangedPlayerTags(db, tagsBefore, tagsAfter);
  }
  if (itemDeleteSupported) {
    const itemsAfter = await itemSnapshot(db);
    await logDeletedItems(db, itemsBefore, itemsAfter);
  }
  if (playerFactionSupported) {
    const playerFactionAfter = await playerFactionSnapshot(db);
    await syncChangedPlayerFaction(db, playerFactionBefore, playerFactionAfter);
  }
  if (specializationSupported) {
    const specializationAfter = await specializationSnapshot(db);
    await syncChangedSpecializations(db, specializationBefore, specializationAfter);
  }
  if (keystonesSupported) {
    const keystonesAfter = await keystoneSnapshot(db);
    await syncChangedKeystonePlayers(db, keystonesBefore, keystonesAfter);
  }
  if (mnemonicSupported) {
    const mnemonicAfter = await mnemonicSnapshot(db);
    await syncChangedMnemonicLessons(db, mnemonicBefore, mnemonicAfter);
  }
  return result;
}

async function supportsSolarisLiveRefresh(db) {
  try {
    return await tableExists(db, "player_virtual_currency_balances") &&
      await functionExists(db, "dune.get_solaris_id()") &&
      await functionExists(db, "dune.log_event_solaris(oid,dune.logmessagetype,bigint,bigint,bigint)") &&
      await functionExists(db, "dune.adjust_player_virtual_currency_balance(bigint,smallint,bigint)");
  } catch {
    return false;
  }
}

async function solarisBalanceSnapshot(db) {
  const result = await db.query(`
    select player_controller_id::text as player_controller_id, balance::text as balance
    from dune.player_virtual_currency_balances
    where currency_id = dune.get_solaris_id()
    order by player_controller_id`);
  return new Map(result.rows.map((row) => [String(row.player_controller_id), BigInt(row.balance || 0)]));
}

async function emitChangedSolarisBalances(db, before, after) {
  for (const [controllerId, balance] of after) {
    const previous = before.get(controllerId);
    if (previous === undefined || previous === balance) continue;
    const delta = balance - previous;
    await db.query(`
      select dune.log_event_solaris(
        'dune.adjust_player_virtual_currency_balance(bigint,smallint,bigint)'::regprocedure::oid,
        'update_solaris'::dune.logmessagetype,
        $1::bigint,
        $2::bigint,
        $3::bigint
      )`, [controllerId, balance.toString(), delta.toString()]);
  }
}

async function factionReputationSnapshot(db) {
  const result = await db.query(`
    select actor_id::text as actor_id, faction_id::text as faction_id, reputation_amount::text as reputation_amount
    from dune.player_faction_reputation
    order by actor_id, faction_id`);
  return new Map(result.rows.map((row) => [`${row.actor_id}:${row.faction_id}`, {
    actorId: String(row.actor_id),
    factionId: Number(row.faction_id),
    reputation: Number(row.reputation_amount || 0)
  }]));
}

async function syncChangedFactionReputation(db, before, after) {
  const syncActorIds = new Set();
  for (const [key, next] of after) {
    const previous = before.get(key);
    if (previous && previous.reputation === next.reputation) continue;
    await db.query("select dune.set_player_faction_reputation($1::bigint, $2::smallint, $3::integer)", [next.actorId, next.factionId, next.reputation]);
    if (next.factionId === 1 || next.factionId === 2) syncActorIds.add(next.actorId);
  }
  for (const [key, previous] of before) {
    if (after.has(key)) continue;
    if (previous.factionId === 1 || previous.factionId === 2) syncActorIds.add(previous.actorId);
  }
  for (const actorId of syncActorIds) {
    await syncFactionComponent(db, actorId);
  }
}

async function supportsTutorialLiveRefresh(db) {
  try {
    return await tableExists(db, "tutorial_per_player") &&
      await functionExists(db, "dune.create_or_update_tutorial_entry(bigint,smallint,smallint)");
  } catch {
    return false;
  }
}

async function tutorialSnapshot(db) {
  const result = await db.query(`
    select player_id::text as player_id, tutorial_id::text as tutorial_id, tutorial_state::text as tutorial_state
    from dune.tutorial_per_player
    order by player_id, tutorial_id`);
  return new Map(result.rows.map((row) => [`${row.player_id}:${row.tutorial_id}`, {
    playerId: String(row.player_id),
    tutorialId: Number(row.tutorial_id),
    state: Number(row.tutorial_state || 0)
  }]));
}

async function syncChangedTutorials(db, before, after) {
  for (const [key, next] of after) {
    const previous = before.get(key);
    if (previous && previous.state === next.state) continue;
    await db.query("select dune.create_or_update_tutorial_entry($1::bigint, $2::smallint, $3::smallint)", [next.playerId, next.tutorialId, next.state]);
  }
}

async function supportsJourneyLiveRefresh(db) {
  try {
    return Boolean(await journeyIdentitySchema(db)) &&
      await functionExists(db, "dune.save_journey_story_node(bigint,text,boolean,boolean,jsonb,jsonb,jsonb,jsonb,dune.journeystoryresetgroup)") &&
      await functionExists(db, "dune.delete_journey_story_node(bigint,text)");
  } catch {
    return false;
  }
}

async function journeySnapshot(db) {
  const schema = await journeyIdentitySchema(db);
  if (!schema) return new Map();
  const idColumn = quoteIdentifier(schema.journeyIdColumn);
  const result = await db.query(`
    select ${idColumn}::text as account_id,
           story_node_id,
           coalesce(override_reward_block, false) as override_reward_block,
           coalesce(has_pending_reward, false) as has_pending_reward,
           coalesce(complete_condition_state, '{}'::jsonb)::text as complete_condition_state,
           coalesce(reveal_condition_state, '{}'::jsonb)::text as reveal_condition_state,
           coalesce(fail_condition_state, '{}'::jsonb)::text as fail_condition_state,
           coalesce(metadata_state, '{}'::jsonb)::text as metadata_state,
           reset_group::text as reset_group
    from dune.journey_story_node
    order by ${idColumn}, story_node_id`);
  return new Map(result.rows.map((row) => [`${row.account_id}:${row.story_node_id}`, {
    accountId: String(row.account_id),
    storyNodeId: String(row.story_node_id),
    overrideRewardBlock: Boolean(row.override_reward_block),
    hasPendingReward: Boolean(row.has_pending_reward),
    completeConditionState: String(row.complete_condition_state || "{}"),
    revealConditionState: String(row.reveal_condition_state || "{}"),
    failConditionState: String(row.fail_condition_state || "{}"),
    metadataState: String(row.metadata_state || "{}"),
    resetGroup: String(row.reset_group || "Default")
  }]));
}

async function syncChangedJourneyNodes(db, before, after) {
  for (const [key, next] of after) {
    const previous = before.get(key);
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) continue;
    await db.query(`
      select dune.save_journey_story_node(
        $1::bigint, $2::text, $3::boolean, $4::boolean,
        $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::dune.JourneyStoryResetGroup
      )`, [
      next.accountId,
      next.storyNodeId,
      next.overrideRewardBlock,
      next.hasPendingReward,
      next.completeConditionState,
      next.revealConditionState,
      next.failConditionState,
      next.metadataState,
      next.resetGroup
    ]);
  }
  for (const [key, previous] of before) {
    if (after.has(key)) continue;
    await db.query("select dune.delete_journey_story_node($1::bigint, $2::text)", [previous.accountId, previous.storyNodeId]);
  }
}

async function supportsTagsLiveRefresh(db) {
  try {
    const schema = await journeyIdentitySchema(db);
    return Boolean(schema?.tagIdColumn) &&
      await functionExists(db, "dune.update_player_tags(bigint,text[],text[])");
  } catch {
    return false;
  }
}

async function playerTagsSnapshot(db) {
  const schema = await journeyIdentitySchema(db);
  if (!schema) return new Map();
  const idColumn = quoteIdentifier(schema.tagIdColumn);
  const result = await db.query(`
    select ${idColumn}::text as account_id, tag
    from dune.player_tags
    order by ${idColumn}, tag`);
  const out = new Map();
  for (const row of result.rows) {
    const accountId = String(row.account_id);
    if (!out.has(accountId)) out.set(accountId, new Set());
    out.get(accountId).add(String(row.tag));
  }
  return out;
}

async function syncChangedPlayerTags(db, before, after) {
  const accountIds = new Set([...before.keys(), ...after.keys()]);
  for (const accountId of accountIds) {
    const oldTags = before.get(accountId) || new Set();
    const newTags = after.get(accountId) || new Set();
    const added = [...newTags].filter((tag) => !oldTags.has(tag));
    const removed = [...oldTags].filter((tag) => !newTags.has(tag));
    if (!added.length && !removed.length) continue;
    await db.query("select dune.update_player_tags($1::bigint, $2::text[], $3::text[])", [accountId, added, removed]);
  }
}

async function supportsItemDeleteLiveRefresh(db) {
  try {
    return await tableExists(db, "items") &&
      await functionExists(db, "dune._add_item_delete_log(bigint,bigint,text)");
  } catch {
    return false;
  }
}

async function itemSnapshot(db) {
  const result = await db.query(`
    select id::text as id, inventory_id::text as inventory_id, template_id
    from dune.items
    order by id`);
  return new Map(result.rows.map((row) => [String(row.id), {
    id: String(row.id),
    inventoryId: String(row.inventory_id),
    templateId: String(row.template_id || "")
  }]));
}

async function logDeletedItems(db, before, after) {
  for (const [id, item] of before) {
    if (after.has(id)) continue;
    await db.query("select dune._add_item_delete_log($1::bigint, $2::bigint, $3::text)", [item.id, item.inventoryId, item.templateId]);
  }
}

async function supportsPlayerFactionLiveRefresh(db) {
  try {
    return await tableExists(db, "player_faction") &&
      await functionExists(db, "dune.change_player_faction(bigint,smallint,smallint,timestamp without time zone)");
  } catch {
    return false;
  }
}

async function playerFactionSnapshot(db) {
  const result = await db.query(`
    select actor_id::text as actor_id,
           faction_id::text as faction_id,
           coalesce(utc_time_faction_change, now())::text as utc_time_faction_change
    from dune.player_faction
    order by actor_id`);
  return new Map(result.rows.map((row) => [String(row.actor_id), {
    actorId: String(row.actor_id),
    factionId: Number(row.faction_id),
    changedAt: String(row.utc_time_faction_change || "")
  }]));
}

async function pledgeGuildAdminFactionIfNeeded(db, actorId, factionId) {
  if (Number(factionId) === 3) return;
  try {
    if (!(await tableExists(db, "guild_members")) ||
        !(await tableExists(db, "guilds")) ||
        !(await functionExists(db, "dune.pledge_guild_allegiance(bigint,bigint,smallint)"))) {
      return;
    }
    const result = await db.query(`
      select gm.guild_id::text as guild_id,
             coalesce(g.guild_faction, 3)::int as guild_faction
      from dune.guild_members gm
      join dune.guilds g on g.guild_id = gm.guild_id
      where gm.player_id = $1::bigint
        and gm.role_id = 100`, [actorId]);
    for (const row of result.rows) {
      if (Number(row.guild_faction) === Number(factionId)) continue;
      await db.query("select dune.pledge_guild_allegiance($1::bigint, $2::bigint, 3::smallint)", [row.guild_id, actorId]);
    }
  } catch {
    // Older schemas can still refresh faction membership without guild allegiance support.
  }
}

async function syncChangedPlayerFaction(db, before, after) {
  for (const [actorId, next] of after) {
    const previous = before.get(actorId);
    if (previous && previous.factionId === next.factionId && previous.changedAt === next.changedAt) continue;
    await db.query("select dune.change_player_faction($1::bigint, $2::smallint, 3::smallint, coalesce($3::timestamp, now()::timestamp))", [next.actorId, next.factionId, next.changedAt || null]);
    await pledgeGuildAdminFactionIfNeeded(db, next.actorId, next.factionId);
  }
  for (const [actorId, previous] of before) {
    if (after.has(actorId)) continue;
    await db.query("select dune.change_player_faction($1::bigint, 3::smallint, 3::smallint, now()::timestamp)", [previous.actorId]);
  }
}

async function supportsSpecializationLiveRefresh(db) {
  try {
    return await tableExists(db, "specialization_tracks") &&
      await functionExists(db, "dune.set_specialization_xp_and_level(bigint,dune.specializationtracktype,integer,real)");
  } catch {
    return false;
  }
}

async function specializationTrackTypes(db) {
  const valid = (track) => {
    const value = String(track || "").trim();
    return value && !/^(count|invalid|none|unknown)$/i.test(value);
  };
  try {
    const result = await db.query("select unnest(enum_range(null::dune.specializationtracktype))::text as track_type order by track_type");
    const rows = result.rows.map((row) => String(row.track_type || "").trim()).filter(valid);
    if (rows.length) return rows;
  } catch {
    // Fall through to the known public specialization tracks.
  }
  return ["Combat", "Crafting", "Exploration", "Gathering", "Sabotage"];
}

async function validateSpecializationTrack(db, value) {
  const requested = String(value || "").trim();
  if (!requested) throw new Error("Specialization track is required");
  const tracks = await specializationTrackTypes(db);
  const match = tracks.find((track) => track.toLowerCase() === requested.toLowerCase());
  if (!match) throw new Error(`Unknown specialization track: ${requested}`);
  return match;
}

async function specializationSnapshot(db) {
  const result = await db.query(`
    select player_id::text as player_id,
           track_type::text as track_type,
           xp_amount::text as xp_amount,
           level::text as level
    from dune.specialization_tracks
    order by player_id, track_type`);
  return new Map(result.rows.map((row) => [`${row.player_id}:${row.track_type}`, {
    playerId: String(row.player_id),
    trackType: String(row.track_type),
    xp: Number(row.xp_amount || 0),
    level: Number(row.level || 0)
  }]));
}

async function syncChangedSpecializations(db, before, after) {
  for (const [key, next] of after) {
    const previous = before.get(key);
    if (previous && previous.xp === next.xp && previous.level === next.level) continue;
    await db.query("select dune.set_specialization_xp_and_level($1::bigint, $2::dune.specializationtracktype, $3::integer, $4::real)", [next.playerId, next.trackType, next.xp, next.level]);
  }
}

async function supportsKeystoneLiveRefresh(db) {
  try {
    return await tableExists(db, "purchased_specialization_keystones") &&
      await tableExists(db, "specialization_keystones_map") &&
      await tableExists(db, "player_state") &&
      await tableExists(db, "actor_fgl_entities") &&
      await tableExists(db, "fgl_entities");
  } catch {
    return false;
  }
}

async function keystoneSnapshot(db) {
  const result = await db.query(`
    select player_id::text as player_id,
           coalesce(string_agg(keystone_id::text, ',' order by keystone_id), '') as keystones
    from dune.purchased_specialization_keystones
    group by player_id
    order by player_id`);
  return new Map(result.rows.map((row) => [String(row.player_id), String(row.keystones || "")]));
}

async function syncChangedKeystonePlayers(db, before, after) {
  const playerIds = new Set([...before.keys(), ...after.keys()]);
  for (const playerId of playerIds) {
    if ((before.get(playerId) || "") === (after.get(playerId) || "")) continue;
    await syncKeystoneSkillPoints(db, playerId);
  }
}

async function syncKeystoneSkillPoints(db, playerId) {
  const state = await db.query(`
    select (fe.components->'FLevelComponent'->1->>'TotalXPEarned')::bigint as xp,
           coalesce((
             select sum((value->>'SkillPointsSpent')::int)
             from jsonb_each(fe.components->'FLevelComponent'->1->'ModuleData')
             where key != format('(TagName="%s"', fe.components->'FLevelComponent'->1->'StarterSkillTreeTag'->>'TagName') || ')'
           ), 0)::bigint as spent_sp
    from dune.fgl_entities fe
    join dune.actor_fgl_entities afe on afe.entity_id = fe.entity_id
    where afe.slot_name = 'DuneCharacter'
      and afe.actor_id = (
        select player_pawn_id from dune.player_state
        where player_controller_id = $1::bigint
        limit 1
      )
    limit 1`, [playerId]);
  const row = state.rows[0];
  if (!row) return;
  const bonus = await db.query(`
    select coalesce(sum(case
      when m.name ~ '_SkillPoint_Super$' then 5
      when m.name ~ '_SkillPoint_Major$' then 3
      when m.name ~ '_SkillPoint[0-9]*$' then 1
      else 0
    end), 0)::bigint as bonus
    from dune.purchased_specialization_keystones p
    join dune.specialization_keystones_map m on m.id = p.keystone_id
    where p.player_id = $1::bigint`, [playerId]);
  const expectedTotal = xpToLevel(Number(row.xp || 0)) + Number(bonus.rows[0]?.bonus || 0);
  const expectedUnspent = Math.max(0, expectedTotal - Number(row.spent_sp || 0) - 1);
  await db.query(`
    update dune.fgl_entities fe
    set components = jsonb_set(jsonb_set(
      components,
      '{FLevelComponent,1,TotalSkillPoints}',
      to_jsonb($2::bigint)),
      '{FLevelComponent,1,UnspentSkillPoints}',
      to_jsonb($3::bigint))
    from dune.actor_fgl_entities afe
    where afe.entity_id = fe.entity_id
      and afe.slot_name = 'DuneCharacter'
      and afe.actor_id = (
        select player_pawn_id from dune.player_state
        where player_controller_id = $1::bigint
        limit 1
      )`, [playerId, expectedTotal, expectedUnspent]);
}

async function supportsMnemonicLiveRefresh(db) {
  try {
    return await tableExists(db, "mnemonic_recall") &&
      await functionExists(db, "dune.save_mnemonic_recall_lesson(bigint,text,bigint,integer,boolean)") &&
      await functionExists(db, "dune.delete_mnemonic_recall_lesson(bigint,text)");
  } catch {
    return false;
  }
}

async function mnemonicSnapshot(db) {
  const result = await db.query(`
    select account_id::text as account_id,
           lesson_id,
           lesson_state::text as lesson_state,
           lesson_progress::text as lesson_progress,
           coalesce(is_new, false) as is_new
    from dune.mnemonic_recall
    order by account_id, lesson_id`);
  return new Map(result.rows.map((row) => [`${row.account_id}:${row.lesson_id}`, {
    accountId: String(row.account_id),
    lessonId: String(row.lesson_id),
    state: String(row.lesson_state || "0"),
    progress: Number(row.lesson_progress || 0),
    isNew: Boolean(row.is_new)
  }]));
}

async function syncChangedMnemonicLessons(db, before, after) {
  for (const [key, next] of after) {
    const previous = before.get(key);
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) continue;
    await db.query("select dune.save_mnemonic_recall_lesson($1::bigint, $2::text, $3::bigint, $4::integer, $5::boolean)", [next.accountId, next.lessonId, next.state, next.progress, next.isNew]);
  }
  for (const [key, previous] of before) {
    if (after.has(key)) continue;
    await db.query("select dune.delete_mnemonic_recall_lesson($1::bigint, $2::text)", [previous.accountId, previous.lessonId]);
  }
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
  const lastSeenWithOnlineFallback = `
    case
      when coalesce(ps.online_status::text, '') = 'Online'
        then coalesce(nullif(${lastSeenSelect}, ''), (current_timestamp at time zone 'UTC')::text)
      else ${lastSeenSelect}
    end
  `;
  const values = [];
  let where = "a.class ilike '%PlayerCharacter%'";
  where += " and coalesce(ac.\"user\", '') <> 'A5C0DE5E12A00001'";
  where += " and coalesce(ac.\"user\", '') <> 'A5C0DE5E12A00002'";
  where += " and coalesce(ac.funcom_id, '') <> 'Server#0001'";
  where += " and coalesce(ac.funcom_id, '') <> 'MessageOfTheDay#0001'";
  where += " and coalesce(ps.character_name, '') <> 'Server'";
  where += " and coalesce(ps.character_name, '') <> 'Message of the Day'";
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
           coalesce(ac.funcom_id, '') as funcom_id,
           coalesce(ac."user", '') as fls_id,
           case
             when nullif(ac."user", '') is not null then ac."user"
             when a.owner_account_id is not null and a.owner_account_id <> 0 then a.owner_account_id::text
             else ''
           end as action_player_id,
           a.class,
           coalesce(a.map, '') as map,
           coalesce(ps.online_status::text, 'Offline') as online_status,
           ${lastSeenWithOnlineFallback} as last_seen
    from dune.actors a
    left join dune.player_state ps on ps.account_id = a.owner_account_id
    left join dune.accounts ac on ac.id = a.owner_account_id
    where ${where}
    order by lower(coalesce(ps.character_name, '')), a.id
    limit 500`, values);
  return { capabilities: { players: true, online }, rows: result.rows };
}

export async function addonLeadershipPlayers(db) {
  const result = await listPlayers(db, {});
  if (!result?.capabilities?.players) return result;
  const rows = result.rows || [];
  const [levels, factions, guilds] = await Promise.all([
    leadershipLevels(db).catch(() => new Map()),
    leadershipFactions(db).catch(() => new Map()),
    leadershipGuilds(db).catch(() => new Map())
  ]);
  return {
    capabilities: { players: true, leadership: true },
    rows: rows.map((row) => {
      const controllerId = String(row.player_controller_id || "");
      const actorId = String(row.actor_id || "");
      const accountId = String(row.account_id || "");
      return {
        actorId,
        controllerId,
        name: row.character_name || `Player ${actorId}`,
        level: levels.get(controllerId) || levels.get(actorId) || 0,
        faction: factions.get(controllerId) || factions.get(actorId) || "Unassigned",
        guild: guilds.get(controllerId) || guilds.get(actorId) || guilds.get(accountId) || "Unavailable",
        status: row.online_status || "Offline",
        map: row.map || "",
        lastSeen: row.last_seen || ""
      };
    })
  };
}

async function leadershipLevels(db) {
  const levels = new Map();
  if (await tableExists(db, "player_state") && await tableExists(db, "actor_fgl_entities") && await tableExists(db, "fgl_entities")) {
    const result = await db.query(`
      select ps.player_controller_id::text as player_controller_id,
             ps.player_pawn_id::text as player_pawn_id,
             (fe.components->'FLevelComponent'->1->>'TotalXPEarned')::bigint as xp
      from dune.player_state ps
      join dune.actor_fgl_entities afe on afe.actor_id = ps.player_pawn_id
      join dune.fgl_entities fe on fe.entity_id = afe.entity_id
      where afe.slot_name = 'DuneCharacter'
        and fe.components ? 'FLevelComponent'`);
    for (const row of result.rows) {
      const level = xpToLevel(Number(row.xp || 0));
      if (row.player_controller_id) levels.set(String(row.player_controller_id), level);
      if (row.player_pawn_id) levels.set(String(row.player_pawn_id), level);
    }
    if (levels.size) return levels;
  }
  if (!(await tableExists(db, "specialization_tracks"))) return levels;
  const result = await db.query(`
    select player_id::text as player_id,
           coalesce(max(level), 0)::int as level
    from dune.specialization_tracks
    group by player_id`);
  for (const row of result.rows) levels.set(String(row.player_id), Number(row.level) || 0);
  return levels;
}

async function leadershipFactions(db) {
  const current = await leadershipCurrentFactions(db);
  if (current.size) return current;
  return leadershipReputationFactions(db);
}

async function leadershipCurrentFactions(db) {
  const factions = new Map();
  if (!(await tableExists(db, "player_faction"))) return factions;
  const hasFactions = await tableExists(db, "factions");
  const result = await db.query(`
    select pf.actor_id::text as actor_id,
           pf.faction_id::text as faction_id,
           ${hasFactions ? "coalesce(f.name, '')" : "''"} as faction_name
    from dune.player_faction pf
    ${hasFactions ? "left join dune.factions f on f.id = pf.faction_id" : ""}`);
  for (const row of result.rows) factions.set(String(row.actor_id), factionDisplayName(row));
  return factions;
}

async function leadershipReputationFactions(db) {
  const factions = new Map();
  if (!(await tableExists(db, "player_faction_reputation"))) return factions;
  const hasFactions = await tableExists(db, "factions");
  const result = await db.query(`
    select distinct on (pfr.actor_id)
           pfr.actor_id::text as actor_id,
           pfr.faction_id::text as faction_id,
           ${hasFactions ? "coalesce(f.name, '')" : "''"} as faction_name,
           coalesce(pfr.reputation_amount, 0) as reputation_amount
    from dune.player_faction_reputation pfr
    ${hasFactions ? "left join dune.factions f on f.id = pfr.faction_id" : ""}
    where coalesce(pfr.reputation_amount, 0) > 0
    order by pfr.actor_id, coalesce(pfr.reputation_amount, 0) desc, pfr.faction_id`);
  for (const row of result.rows) factions.set(String(row.actor_id), factionDisplayName(row));
  return factions;
}

async function leadershipGuilds(db) {
  const guilds = new Map();
  if (!(await tableExists(db, "guild_members")) || !(await tableExists(db, "guilds"))) return guilds;
  const memberColumns = await columnsFor(db, "guild_members");
  const guildColumns = await columnsFor(db, "guilds");
  const memberPlayerColumn = firstExistingColumn(memberColumns, ["player_id", "player_controller_id", "actor_id", "account_id", "player_pawn_id"]);
  const memberGuildColumn = firstExistingColumn(memberColumns, ["guild_id", "id"]);
  const guildIdColumn = firstExistingColumn(guildColumns, ["guild_id", "id"]);
  const guildNameColumn = firstExistingColumn(guildColumns, ["guild_name", "name", "display_name"]);
  if (!memberPlayerColumn || !memberGuildColumn || !guildIdColumn || !guildNameColumn) return guilds;
  const result = await db.query(`
    select gm.${quoteIdentifier(memberPlayerColumn)}::text as player_id,
           coalesce(g.${quoteIdentifier(guildNameColumn)}, '') as guild_name
    from dune.guild_members gm
    join dune.guilds g on g.${quoteIdentifier(guildIdColumn)} = gm.${quoteIdentifier(memberGuildColumn)}
    where nullif(g.${quoteIdentifier(guildNameColumn)}, '') is not null`);
  for (const row of result.rows) {
    if (row.player_id && row.guild_name) guilds.set(String(row.player_id), String(row.guild_name));
  }
  return guilds;
}

function firstExistingColumn(columns, names) {
  return names.find((name) => columns.has(name)) || "";
}

async function journeyIdentitySchema(db) {
  if (!(await tableExists(db, "journey_story_node")) || !(await tableExists(db, "player_tags"))) return null;
  const journeyColumns = await columnsFor(db, "journey_story_node");
  const tagColumns = await columnsFor(db, "player_tags");
  const journeyIdColumn = firstExistingColumn(journeyColumns, ["character_id", "account_id"]);
  const tagIdColumn = firstExistingColumn(tagColumns, ["character_id", "account_id"]);
  if (!journeyIdColumn || !tagIdColumn || journeyIdColumn !== tagIdColumn) return null;
  return { journeyIdColumn, tagIdColumn };
}

function playerJourneyIdentity(player, columnName) {
  if (columnName === "character_id") return player.playerStateId;
  return player.accountId;
}

async function playerLastSeenSelect(db) {
  const candidates = [
    ["player_state", "ps", ["last_seen", "last_seen_at", "last_online", "last_online_at", "last_avatar_activity", "last_login", "last_login_at", "last_login_time", "last_activity", "last_activity_at", "updated_at"]],
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
           coalesce(ac.funcom_id, '') as funcom_id,
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
  const player = await resolvePlayerMutationTarget(db, id);
  const result = await db.query(`
    select pfr.actor_id,
           pfr.faction_id,
           ${hasFactions ? "coalesce(f.name, '')" : "''"} as faction_name,
           pfr.reputation_amount
    from dune.player_faction_reputation pfr
    ${hasFactions ? "left join dune.factions f on f.id = pfr.faction_id" : ""}
    where pfr.actor_id = $1
    order by pfr.faction_id`, [player.controllerId]);
  return { capabilities: { factions: true, factionNames: hasFactions }, player, rows: result.rows };
}

export async function playerSpecs(db, id) {
  if (!(await tableExists(db, "specialization_tracks"))) return unsupported("specs", ["dune.specialization_tracks"]);
  const player = await resolvePlayerMutationTarget(db, id);
  const tracks = await specializationTrackTypes(db);
  const result = await db.query(`
    select player_id, track_type::text, xp_amount, level
    from dune.specialization_tracks
    where player_id = $1
    order by track_type`, [player.controllerId]);
  const byTrack = new Map(result.rows.map((row) => [String(row.track_type), row]));
  return {
    capabilities: {
      specs: true,
      specializationMutation: await supportsSpecializationLiveRefresh(db),
      keystones: await tableExists(db, "purchased_specialization_keystones")
    },
    player,
    skillModules: await playerSkillModules(db, player),
    rows: tracks.map((track) => {
      const row = byTrack.get(track);
      return {
        player_id: player.controllerId,
        track_type: track,
        xp_amount: row?.xp_amount ?? 0,
        level: row?.level ?? 0
      };
    })
  };
}

async function playerSkillModules(db, player) {
  if (!(await tableExists(db, "actor_fgl_entities")) || !(await tableExists(db, "fgl_entities"))) return [];
  const result = await db.query(`
    select regexp_replace(module.key, '^\\(TagName="(.+)"\\)$', '\\1') as module_id,
           case
             when module.value ? 'SkillPointsSpent'
              and module.value->>'SkillPointsSpent' ~ '^-?[0-9]+$'
             then (module.value->>'SkillPointsSpent')::int
             else 0
           end as skill_points_spent
    from dune.actor_fgl_entities afe
    join dune.fgl_entities fe on fe.entity_id = afe.entity_id
    cross join lateral jsonb_each(coalesce(fe.components->'FLevelComponent'->1->'ModuleData', '{}'::jsonb)) as module(key, value)
    where afe.slot_name = 'DuneCharacter'
      and afe.actor_id = $1
      and module.key like '(TagName="Skills.%")'
    order by module_id`, [player.actorId]);
  return result.rows
    .map((row) => ({
      module_id: String(row.module_id || ""),
      skill_points_spent: Number(row.skill_points_spent || 0)
    }))
    .filter((row) => row.module_id && row.skill_points_spent > 0);
}

export async function addSpecializationXp(db, id, { trackType, amount }) {
  await requireCapability(await supportsSpecializationLiveRefresh(db), "Specialization XP requires dune.specialization_tracks plus dune.set_specialization_xp_and_level(bigint,dune.specializationtracktype,integer,real).");
  const track = await validateSpecializationTrack(db, trackType);
  const delta = intParam(amount, "specialization XP amount", -44182, 44182);
  if (delta === 0) throw new Error("Specialization XP amount cannot be zero");
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    requireOfflinePlayer(player, "Specialization changes");
    const current = await tx.query(`
      select xp_amount, level
      from dune.specialization_tracks
      where player_id = $1 and track_type::text = $2
      for update`, [player.controllerId, track]);
    const oldXp = Number(current.rows[0]?.xp_amount || 0);
    const oldLevel = Number(current.rows[0]?.level || 0);
    const nextXp = Math.max(0, Math.min(44182, oldXp + delta));
    await withKnownLiveRefresh(tx, () => tx.query(
      "select dune.set_specialization_xp_and_level($1::bigint, $2::dune.specializationtracktype, $3::integer, $4::real)",
      [player.controllerId, track, nextXp, oldLevel]
    ), { features: ["specialization"] });
    return {
      ok: true,
      player,
      trackType: track,
      oldXp,
      xp: nextXp,
      level: oldLevel,
      amount: delta,
      message: `${track} specialization XP was updated. The player must relog to see the change.`
    };
  });
}

export async function grantMaxSpecialization(db, id, { trackType }) {
  await requireCapability(await supportsSpecializationLiveRefresh(db), "Granting specialization requires dune.specialization_tracks plus dune.set_specialization_xp_and_level(bigint,dune.specializationtracktype,integer,real).");
  const track = await validateSpecializationTrack(db, trackType);
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    requireOfflinePlayer(player, "Specialization changes");
    await withKnownLiveRefresh(tx, () => tx.query(
      "select dune.set_specialization_xp_and_level($1::bigint, $2::dune.specializationtracktype, $3::integer, $4::real)",
      [player.controllerId, track, 44182, 100]
    ), { features: ["specialization"] });
    return {
      ok: true,
      player,
      trackType: track,
      xp: 44182,
      level: 100,
      message: `${track} specialization was granted at max level. The player must relog to see the change.`
    };
  });
}

export async function resetSpecialization(db, id, { trackType }) {
  await requireCapability(await tableExists(db, "specialization_tracks"), "Resetting specialization requires dune.specialization_tracks.");
  const track = await validateSpecializationTrack(db, trackType);
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    requireOfflinePlayer(player, "Specialization changes");
    await withKnownLiveRefresh(tx, () => tx.query(
      "delete from dune.specialization_tracks where player_id = $1 and track_type::text = $2",
      [player.controllerId, track]
    ), { features: ["specialization"] });
    return {
      ok: true,
      player,
      trackType: track,
      xp: 0,
      level: 0,
      message: `${track} specialization was reset. The player must relog to see the change.`
    };
  });
}

export async function grantAllSpecializationKeystones(db, id) {
  await requireCapability(await supportsKeystoneLiveRefresh(db), "Granting specialization keystones requires dune.purchased_specialization_keystones and dune.specialization_keystones_map.");
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    requireOfflinePlayer(player, "Specialization keystone changes");
    const result = await withKnownLiveRefresh(tx, () => tx.query(`
      insert into dune.purchased_specialization_keystones (player_id, keystone_id)
      select $1::bigint, id
      from dune.specialization_keystones_map
      on conflict do nothing`, [player.controllerId]), { features: ["keystones"] });
    return {
      ok: true,
      player,
      insertedRows: result.rowCount || 0,
      message: "All specialization keystones were granted. The player must relog to see the change."
    };
  });
}

export async function resetAllSpecializationKeystones(db, id) {
  await requireCapability(await tableExists(db, "purchased_specialization_keystones"), "Resetting specialization keystones requires dune.purchased_specialization_keystones.");
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    requireOfflinePlayer(player, "Specialization keystone changes");
    const result = await withKnownLiveRefresh(tx, () => tx.query(
      "delete from dune.purchased_specialization_keystones where player_id = $1",
      [player.controllerId]
    ), { features: ["keystones"] });
    return {
      ok: true,
      player,
      deletedRows: result.rowCount || 0,
      message: "All specialization keystones were reset. The player must relog to see the change."
    };
  });
}

export async function playerPosition(db, id) {
  const actorId = intParam(id, "player id", 1);
  try {
    const result = await db.query(`
      select id as actor_id,
             map,
             ((transform).location).x as x,
             ((transform).location).y as y,
             ((transform).location).z as z,
             0::float8 as yaw,
             (transform).location::text as location,
             (transform).rotation::text as rotation
      from dune.actors
      where id = $1 and transform is not null`, [actorId]);
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
    ${hasWorldPartition ? "join dune.world_partition wp on wp.partition_id = a.partition_id" : ""}
    where a.transform is not null
      and coalesce(a.partition_id, 0) > 0
      ${hasWorldPartition ? "and nullif(wp.server_id, '') is not null" : ""}
    group by a.map, a.partition_id${hasWorldPartition ? ", wp.label, wp.map" : ""}
    order by map, partition_id`);
  return { rows: result.rows.map((row) => ({ ...row, partition_id: Number(row.partition_id || 0), marker_count: Number(row.marker_count || 0) })) };
}

export async function liveMapPlayers(db, map = "") {
  if (!(await tableExists(db, "actors")) || !(await tableExists(db, "player_state"))) return unsupportedMap("players", ["dune.actors", "dune.player_state"]);
  const hasWorldPartition = await tableExists(db, "world_partition");
  const values = [];
  const where = mapFilterClause(map, values, "a");
  const partitionWhere = validActorPartitionClause(hasWorldPartition, "a");
  try {
    const result = await db.query(`
      select a.id,
             'player' as type,
             coalesce(nullif(ps.character_name, ''), 'Unknown') as name,
             coalesce(ps.online_status::text, '') as online_status,
             coalesce(ac."user", '') as fls_id,
             coalesce(ac."user", '') as action_player_id,
             coalesce(ac.funcom_id, '') as funcom_id,
             coalesce(a.owner_account_id, 0) as account_id,
             coalesce(a.map, '') as map,
             coalesce(a.partition_id, 0) as partition_id,
             coalesce(a.class, '') as class,
             ((a.transform).location).x as x,
             ((a.transform).location).y as y,
             ((a.transform).location).z as z
      from dune.actors a
      join dune.player_state ps on ps.player_pawn_id = a.id
      left join dune.accounts ac on ac.id = ps.account_id
      where a.transform is not null ${partitionWhere} ${where}
      order by coalesce(ps.online_status::text, '') desc, lower(coalesce(ps.character_name, ''))`, values);
    return { capabilities: { players: true }, rows: result.rows.map(normalizeMarker) };
  } catch (error) {
    return { capabilities: { players: false }, rows: [], reason: `Player marker transform query is unsupported by this schema: ${error.message}` };
  }
}

export async function teleportOfflinePlayerToCoords(db, playerId, { x, y, z, partitionId = 0 } = {}) {
  const flsId = validatePlayerIdForDb(playerId);
  const resolvedPartition = await resolveTeleportPartition(db, flsId, partitionId);
  if (!resolvedPartition) {
    return { supported: false, reason: "Could not resolve a valid map partition for this offline player." };
  }
  const functionCheck = await db.query("select to_regprocedure('dune.admin_move_offline_player_to_partition(text,bigint,dune.vector)') as proc");
  if (!functionCheck.rows[0]?.proc) {
    return {
      supported: false,
      reason: "Offline drag teleport requires the database function dune.admin_move_offline_player_to_partition. Online players can still be teleported immediately."
    };
  }
  await db.query(`
    select dune.admin_move_offline_player_to_partition($1::text, $2::bigint, ROW($3::float8,$4::float8,$5::float8)::dune.Vector)`, [
    flsId,
    resolvedPartition,
    Number(x),
    Number(y),
    Number(z)
  ]);
  return {
    supported: true,
    result: { playerId: flsId, partitionId: resolvedPartition, x: Number(x), y: Number(y), z: Number(z) },
    message: "Offline player respawn location was saved. The player will land there the next time they log in."
  };
}

export async function liveMapVehicles(db, map = "") {
  if (!(await tableExists(db, "actors")) || !(await tableExists(db, "vehicles"))) return unsupportedMap("vehicles", ["dune.actors", "dune.vehicles"]);
  const hasWorldPartition = await tableExists(db, "world_partition");
  const values = [];
  const where = mapFilterClause(map, values, "a");
  const partitionWhere = validActorPartitionClause(hasWorldPartition, "a");
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
      where a.transform is not null ${partitionWhere} ${where}
      order by a.map, a.partition_id, a.id`, values);
    return { capabilities: { vehicles: true }, rows: result.rows.map(normalizeMarker) };
  } catch (error) {
    return { capabilities: { vehicles: false }, rows: [], reason: `Vehicle marker transform query is unsupported by this schema: ${error.message}` };
  }
}

export async function liveMapStorage(db, map = "") {
  if (!(await tableExists(db, "actors")) || !(await tableExists(db, "placeables"))) return unsupportedMap("storage", ["dune.actors", "dune.placeables"]);
  const hasWorldPartition = await tableExists(db, "world_partition");
  const values = [];
  const where = mapFilterClause(map, values, "a");
  const partitionWhere = validActorPartitionClause(hasWorldPartition, "a");
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
        and a.transform is not null ${partitionWhere} ${where}
      group by p.id, p.building_type, a.map, a.partition_id, a.transform
      order by a.map, a.partition_id, p.id`, values);
    return { capabilities: { storage: true }, rows: result.rows.map(normalizeMarker) };
  } catch (error) {
    return { capabilities: { storage: false }, rows: [], reason: `Storage marker transform query is unsupported by this schema: ${error.message}` };
  }
}

export async function liveMapBases(db, map = "") {
  if (!(await tableExists(db, "actors")) || !(await tableExists(db, "buildings"))) return unsupportedMap("bases", ["dune.actors", "dune.buildings"]);
  const hasWorldPartition = await tableExists(db, "world_partition");
  const values = [];
  const where = mapFilterClause(map, values, "a");
  const partitionWhere = validActorPartitionClause(hasWorldPartition, "a");
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
      where a.transform is not null ${partitionWhere} ${where}
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
    return {
      ok: true,
      player,
      currencyId: resolvedCurrencyId,
      amount: delta,
      balance: balance.rows[0] || null,
      message: playerOnline(player)
        ? "Solari Credit was updated in the database. The player may need to relog before the new credit balance appears in-game."
        : "Solari Credit was updated in the database and will be loaded when the player next joins."
    };
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
      where actor_id = $1 and faction_id = $2`, [player.controllerId, faction]);
    const oldValue = Number(current.rows[0]?.reputation_amount || 0);
    const nextValue = Math.max(0, Math.min(12474, oldValue + delta));
    await tx.query("select dune.set_player_faction_reputation($1::bigint, $2::smallint, $3::integer)", [player.controllerId, faction, nextValue]);
    if (faction === 1 || faction === 2) await syncFactionComponent(tx, player.controllerId);
    return {
      ok: true,
      player,
      factionId: faction,
      actorId: player.controllerId,
      oldValue,
      newValue: nextValue,
      message: playerOnline(player)
        ? "Faction reputation was updated in the database. The player may need to relog before the new reputation appears in-game."
        : "Faction reputation was updated in the database and will be loaded when the player next joins."
    };
  });
}

export async function addIntel(db, id, { amount }) {
  await requireCapability(await supportsIntelMutation(db), "Intel mutation requires dune.actors.properties with TechKnowledgePlayerComponent.");
  const delta = intParam(amount, "intel amount", 1, 1000000000);
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    requireOfflinePlayer(player, "Intel grants");
    const current = await tx.query(`
      select (properties->'TechKnowledgePlayerComponent'->>'m_TechKnowledgePoints')::bigint as intel
      from dune.actors
      where id = $1 and properties ? 'TechKnowledgePlayerComponent'`, [player.actorId]);
    if (!current.rows.length) throw new UnsupportedCapabilityError(`TechKnowledgePlayerComponent not found for player ${player.actorId}.`);
    const oldValue = Number(current.rows[0]?.intel || 0);
    const applied = Math.min(delta, Math.max(0, MAX_INTEL_POINTS - oldValue));
    const nextValue = oldValue + applied;
    await tx.query(`
      update dune.actors
      set properties = jsonb_set(properties, '{TechKnowledgePlayerComponent,m_TechKnowledgePoints}', to_jsonb($2::bigint))
      where id = $1 and properties ? 'TechKnowledgePlayerComponent'`, [player.actorId, nextValue]);
    return {
      ok: true,
      player,
      oldValue,
      newValue: nextValue,
      amount: applied,
      requestedAmount: delta,
      maxValue: MAX_INTEL_POINTS,
      capped: applied < delta,
      message: applied < delta
        ? `Intel was updated up to the spendable cap of ${MAX_INTEL_POINTS} and will be loaded when the player next joins.`
        : "Intel was updated in the database and will be loaded when the player next joins."
    };
  });
}

export async function playerCraftingRecipes(db, id) {
  await requireCapability(await supportsCraftingRecipes(db), "Crafting recipes require dune.actors.properties with CraftingRecipesLibraryActorComponent.");
  const player = await resolvePlayerMutationTarget(db, id);
  const result = await db.query(`
    with player_recipes as (
      select recipe->'BaseRecipeId'->>'Name' as recipe_id
      from dune.actors a
      cross join lateral jsonb_array_elements(coalesce(a.properties->'CraftingRecipesLibraryActorComponent'->'m_KnownItemRecipes', '[]'::jsonb)) recipe
      where a.id = $1 and recipe->'BaseRecipeId'->>'Name' is not null
    )
    select recipe_id from player_recipes
    order by recipe_id`, [player.actorId]);
  const unlocked = new Set(result.rows.map((row) => String(row.recipe_id || "")).filter(Boolean));
  const catalog = craftingRecipeCatalog();
  const rows = catalog.length
    ? catalog.map((row) => ({ ...row, unlocked: unlocked.has(row.recipeId) }))
    : [...unlocked].map((recipeId) => ({
      recipeId,
      displayName: recipeDisplayName(recipeId),
      category: recipeCategory(recipeId),
      source: "Known Recipes",
      qualityLevel: 0,
      unlocked: true
    }));
  return {
    capabilities: { craftingRecipes: true },
    player,
    rows
  };
}

export async function unlockCraftingRecipe(db, id, { recipeId }) {
  await requireCapability(await supportsCraftingRecipes(db), "Crafting recipes require dune.actors.properties with CraftingRecipesLibraryActorComponent.");
  const safeRecipeId = validateRecipeId(recipeId);
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    requireOfflinePlayer(player, "Crafting recipe unlocks");
    const catalogHasRecipe = craftingRecipeCatalog().some((row) => row.recipeId === safeRecipeId);
    if (!catalogHasRecipe) {
      const known = await tx.query(`
        select exists (
          select 1
          from dune.actors a
          cross join lateral jsonb_array_elements(coalesce(a.properties->'CraftingRecipesLibraryActorComponent'->'m_KnownItemRecipes', '[]'::jsonb)) recipe
          where recipe->'BaseRecipeId'->>'Name' = $1
        ) as exists`, [safeRecipeId]);
      if (!known.rows[0]?.exists) throw new Error(`Crafting recipe ${safeRecipeId} was not found in the game database.`);
    }
    const current = await tx.query(`
      select properties->'CraftingRecipesLibraryActorComponent'->'m_KnownItemRecipes' as recipes
      from dune.actors
      where id = $1 and properties ? 'CraftingRecipesLibraryActorComponent'
      for update`, [player.actorId]);
    if (!current.rows.length) throw new UnsupportedCapabilityError(`CraftingRecipesLibraryActorComponent not found for player ${player.actorId}.`);
    const recipes = Array.isArray(current.rows[0]?.recipes) ? current.rows[0].recipes : [];
    if (recipes.some((recipe) => recipe?.BaseRecipeId?.Name === safeRecipeId)) {
      return { ok: true, player, recipeId: safeRecipeId, alreadyUnlocked: true };
    }
    const nextRecipes = [...recipes, {
      m_Source: "SchematicPickup",
      m_bIsNew: true,
      BaseRecipeId: { Name: safeRecipeId },
      m_QualityLevel: 0,
      m_NumberOfRecipeUses: 0,
      m_bIsLimitedUseRecipe: false
    }];
    await tx.query(`
      update dune.actors
      set properties = jsonb_set(properties, '{CraftingRecipesLibraryActorComponent,m_KnownItemRecipes}', $2::jsonb, true)
      where id = $1 and properties ? 'CraftingRecipesLibraryActorComponent'`, [player.actorId, JSON.stringify(nextRecipes)]);
    return { ok: true, player, recipeId: safeRecipeId, alreadyUnlocked: false };
  });
}

function craftingRecipeCatalog() {
  if (craftingRecipeCatalogCache) return craftingRecipeCatalogCache;
  try {
    const path = [
      resolve(process.cwd(), "runtime/data/admin-items.json"),
      resolve(process.cwd(), "../../runtime/data/admin-items.json")
    ].find((candidate) => existsSync(candidate)) || resolve(process.cwd(), "runtime/data/admin-items.json");
    craftingRecipeCatalogCache = craftingRecipeCatalogRows(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    craftingRecipeCatalogCache = [];
  }
  return craftingRecipeCatalogCache;
}

export async function playerResearchItems(db, id) {
  await requireCapability(await supportsResearchItems(db), "Research unlocks require dune.actors.properties with TechKnowledgePlayerComponent.");
  const player = await resolvePlayerMutationTarget(db, id);
  const result = await db.query(`
    with all_research as (
      select distinct item->>'ItemKey' as item_key
      from dune.actors a
      cross join lateral jsonb_array_elements(coalesce(a.properties->'TechKnowledgePlayerComponent'->'m_TechKnowledge'->'m_TechKnowledgeData', '[]'::jsonb)) item
      where item->>'ItemKey' is not null
    ),
    player_research as (
      select item->>'ItemKey' as item_key,
             coalesce(nullif(item->>'UnlockedState', ''), 'Unknown') as unlocked_state,
             coalesce((item->>'bIsNewEntry')::boolean, false) as is_new
      from dune.actors a
      cross join lateral jsonb_array_elements(coalesce(a.properties->'TechKnowledgePlayerComponent'->'m_TechKnowledge'->'m_TechKnowledgeData', '[]'::jsonb)) item
      where a.id = $1 and item->>'ItemKey' is not null
    )
    select all_research.item_key,
           coalesce(player_research.unlocked_state, 'Missing') as unlocked_state,
           coalesce(player_research.is_new, false) as is_new
    from all_research
    left join player_research on player_research.item_key = all_research.item_key
    order by all_research.item_key`, [player.actorId]);
  return {
    capabilities: { researchItems: true },
    player,
    rows: result.rows.map((row) => ({
      itemKey: row.item_key,
      displayName: researchDisplayName(row.item_key),
      category: researchCategory(row.item_key),
      productGroup: researchProductGroup(row.item_key, researchCategory(row.item_key)),
      type: researchType(row.item_key),
      unlockedState: row.unlocked_state || "Unknown",
      isNew: Boolean(row.is_new),
      unlocked: row.unlocked_state === "Purchased"
    }))
  };
}

export async function unlockResearchItem(db, id, { itemKey }) {
  await requireCapability(await supportsResearchItems(db), "Research unlocks require dune.actors.properties with TechKnowledgePlayerComponent.");
  const safeItemKey = validateResearchKey(itemKey);
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    requireOfflinePlayer(player, "Research unlocks");
    const known = await tx.query(`
      select exists (
        select 1
        from dune.actors a
        cross join lateral jsonb_array_elements(coalesce(a.properties->'TechKnowledgePlayerComponent'->'m_TechKnowledge'->'m_TechKnowledgeData', '[]'::jsonb)) item
        where item->>'ItemKey' = $1
      ) as exists`, [safeItemKey]);
    if (!known.rows[0]?.exists) throw new Error(`Research key ${safeItemKey} was not found in the game database.`);
    const current = await tx.query(`
      select properties->'TechKnowledgePlayerComponent'->'m_TechKnowledge'->'m_TechKnowledgeData' as items
      from dune.actors
      where id = $1 and properties ? 'TechKnowledgePlayerComponent'
      for update`, [player.actorId]);
    if (!current.rows.length) throw new UnsupportedCapabilityError(`TechKnowledgePlayerComponent not found for player ${player.actorId}.`);
    const items = Array.isArray(current.rows[0]?.items) ? current.rows[0].items : [];
    let alreadyUnlocked = false;
    let found = false;
    const nextItems = items.map((item) => {
      if (item?.ItemKey !== safeItemKey) return item;
      found = true;
      alreadyUnlocked = item.UnlockedState === "Purchased";
      return { ...item, bIsNewEntry: false, UnlockedState: "Purchased" };
    });
    if (!found) {
      nextItems.push({ ItemKey: safeItemKey, bIsNewEntry: false, UnlockedState: "Purchased" });
    }
    await tx.query(`
      update dune.actors
      set properties = jsonb_set(properties, '{TechKnowledgePlayerComponent,m_TechKnowledge,m_TechKnowledgeData}', $2::jsonb, true)
      where id = $1 and properties ? 'TechKnowledgePlayerComponent'`, [player.actorId, JSON.stringify(nextItems)]);
    const recipeId = researchRecipeId(safeItemKey);
    const recipeMaterialized = recipeId ? await materializeCraftingRecipeIfKnown(tx, player.actorId, recipeId) : false;
    return { ok: true, player, itemKey: safeItemKey, alreadyUnlocked, recipeId, recipeMaterialized };
  });
}

export async function playerJourney(db, id, journeyTagsData = {}) {
  const schema = await journeyIdentitySchema(db);
  await requireCapability(await supportsJourneySchema(db, schema), "Journey data is unavailable for this game database schema.");
  const player = await resolvePlayerMutationTarget(db, id);
  const journeyIdColumn = quoteIdentifier(schema.journeyIdColumn);
  const tagIdColumn = quoteIdentifier(schema.tagIdColumn);
  const journeyIdentityId = playerJourneyIdentity(player, schema.journeyIdColumn);
  const tagIdentityId = playerJourneyIdentity(player, schema.tagIdColumn);
  const tagMap = journeyTagsData?.journey_node_tags || {};
  const contractTags = journeyTagsData?.contract_tags || {};
  const contractAliases = journeyTagsData?.contract_aliases || {};
  const taggedNodeIds = Object.keys(tagMap).sort((a, b) => a.localeCompare(b));
  const knownNodeIds = taggedNodeIds.length ? taggedNodeIds : [];
  const contractNodeIds = Object.values(contractAliases).filter(Boolean).sort((a, b) => String(a).localeCompare(String(b)));
  const codex = await db.query(`
    select story_node_id
    from dune.journey_story_node
    where story_node_id like 'DA_Dunipedia_%'
    group by story_node_id
    order by story_node_id`);
  const playerNodes = await db.query(`
    select story_node_id,
           complete_condition_state = 'true'::jsonb as is_complete,
           reveal_condition_state = 'true'::jsonb as is_revealed,
           coalesce(has_pending_reward, false) as has_pending_reward
    from dune.journey_story_node
    where ${journeyIdColumn} = $1`, [journeyIdentityId]);
  const playerTags = await db.query(`select tag from dune.player_tags where ${tagIdColumn} = $1`, [tagIdentityId]);
  const state = new Map(playerNodes.rows.map((row) => [row.story_node_id, {
    complete: Boolean(row.is_complete),
    revealed: Boolean(row.is_revealed),
    pendingReward: Boolean(row.has_pending_reward)
  }]));
  const tagState = new Set(playerTags.rows.map((row) => String(row.tag || "")));
  const tutorialRows = await db.query(`
    select t.id,
           t.name,
           tp.tutorial_state
    from dune.tutorials t
    left join dune.tutorial_per_player tp on tp.tutorial_id = t.id and tp.player_id = $1
    order by t.name`, [player.controllerId]);

  const storyRows = knownNodeIds.filter((nodeId) => journeyGroup(nodeId) === "story").map((nodeId) => journeyNodeRow(nodeId, "Story", state, tagMap, knownNodeIds));
  const journeyContractRows = knownNodeIds.filter((nodeId) => journeyGroup(nodeId) === "contract").map((nodeId) => journeyNodeRow(nodeId, "Contract", state, tagMap, knownNodeIds));
  const contractRows = [
    ...journeyContractRows,
    ...contractNodeIds.map((nodeId) => contractNodeRow(String(nodeId), contractTags, contractAliases, tagState))
  ].sort((a, b) => a.rawName.localeCompare(b.rawName));
  const codexIds = codex.rows.map((row) => row.story_node_id).filter(Boolean);
  const codexRows = codexIds.map((nodeId) => journeyNodeRow(nodeId, "Codex", state, {}, codexIds));
  const tutorial = tutorialRows.rows.map((row) => ({
    id: String(row.id),
    name: journeyDisplayName(row.name),
    rawName: String(row.name || ""),
    category: "Tutorial",
    depth: 0,
    parentId: "",
    status: tutorialStatus(row.tutorial_state),
    complete: Number(row.tutorial_state) === 2,
    state: row.tutorial_state === null || row.tutorial_state === undefined ? null : Number(row.tutorial_state),
    tags: 0
  }));
  return { capabilities: { journey: true }, player, rows: { story: storyRows, contract: contractRows, codex: codexRows, tutorial } };
}

export async function completeJourneyNode(db, id, { nodeId }, journeyTagsData = {}) {
  const schema = await journeyIdentitySchema(db);
  await requireCapability(await supportsJourneySchema(db, schema), "Journey completion is unavailable for this game database schema.");
  const safeNodeId = validateJourneyNodeId(nodeId);
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    const journeyIdColumn = quoteIdentifier(schema.journeyIdColumn);
    const journeyIdentityId = playerJourneyIdentity(player, schema.journeyIdColumn);
    const tagIdentityId = playerJourneyIdentity(player, schema.tagIdColumn);
    if (isContractNode(safeNodeId, journeyTagsData)) {
      const tags = contractTagsForNode(safeNodeId, journeyTagsData);
      const tagResult = await applyDirectJourneyTags(tx, player, tags, "add", schema.tagIdColumn, tagIdentityId);
      return { ok: true, player, nodeId: safeNodeId, updatedRows: 0, tagsApplied: tags.length, factionBumps: tagResult.factionBumps, contract: true };
    }
    const updated = await tx.query(`
      update dune.journey_story_node
      set complete_condition_state = 'true'::jsonb,
          reveal_condition_state = 'true'::jsonb
      where ${journeyIdColumn} = $1
        and (story_node_id = $2 or story_node_id like $2 || '.%')`, [journeyIdentityId, safeNodeId]);
    let updatedRows = Number(updated.rowCount || 0);
    if (updatedRows === 0) {
      await tx.query(`
        insert into dune.journey_story_node
          (${journeyIdColumn}, story_node_id, has_pending_reward, complete_condition_state, reveal_condition_state, fail_condition_state, metadata_state, reset_group)
        values ($1, $2, false, 'true'::jsonb, 'true'::jsonb, '{}'::jsonb, '{}'::jsonb, 'Default'::dune.JourneyStoryResetGroup)`, [journeyIdentityId, safeNodeId]);
      updatedRows = 1;
    }
    const tags = tagsForJourneyNodeSubtree(safeNodeId, journeyTagsData);
    const tagResult = await applyDirectJourneyTags(tx, player, tags, "add", schema.tagIdColumn, tagIdentityId);
    return { ok: true, player, nodeId: safeNodeId, updatedRows, tagsApplied: tags.length, factionBumps: tagResult.factionBumps };
  });
}

export async function resetJourneyNode(db, id, { nodeId }, journeyTagsData = {}) {
  const schema = await journeyIdentitySchema(db);
  await requireCapability(await supportsJourneySchema(db, schema), "Journey reset is unavailable for this game database schema.");
  const safeNodeId = validateJourneyNodeId(nodeId);
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    const journeyIdColumn = quoteIdentifier(schema.journeyIdColumn);
    const journeyIdentityId = playerJourneyIdentity(player, schema.journeyIdColumn);
    const tagIdentityId = playerJourneyIdentity(player, schema.tagIdColumn);
    if (isContractNode(safeNodeId, journeyTagsData)) {
      const tags = contractTagsForNode(safeNodeId, journeyTagsData);
      await applyDirectJourneyTags(tx, player, tags, "remove", schema.tagIdColumn, tagIdentityId);
      return { ok: true, player, nodeId: safeNodeId, updatedRows: 0, tagsRemoved: tags.length, contract: true };
    }
    const updated = await tx.query(`
      update dune.journey_story_node
      set complete_condition_state = 'false'::jsonb,
          has_pending_reward = false
      where ${journeyIdColumn} = $1
        and (story_node_id = $2 or story_node_id like $2 || '.%')`, [journeyIdentityId, safeNodeId]);
    const tags = tagsForJourneyNodeSubtree(safeNodeId, journeyTagsData);
    await applyDirectJourneyTags(tx, player, tags, "remove", schema.tagIdColumn, tagIdentityId);
    return { ok: true, player, nodeId: safeNodeId, updatedRows: Number(updated.rowCount || 0), tagsRemoved: tags.length };
  });
}

export async function completeTutorial(db, id, { tutorialId }) {
  await requireCapability(await supportsTutorials(db), "Tutorial completion requires dune.tutorials and dune.tutorial_per_player.");
  const safeTutorialId = intParam(tutorialId, "tutorial id", 1, 32767);
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    const known = await tx.query("select exists (select 1 from dune.tutorials where id = $1) as exists", [safeTutorialId]);
    if (!known.rows[0]?.exists) throw new Error(`Tutorial ${safeTutorialId} was not found in the game database.`);
    await tx.query("select dune.create_or_update_tutorial_entry($1::bigint, $2::smallint, 2::smallint)", [player.controllerId, safeTutorialId]);
    return { ok: true, player, tutorialId: safeTutorialId, state: 2 };
  });
}

export async function resetTutorial(db, id, { tutorialId }) {
  await requireCapability(await supportsTutorials(db), "Tutorial reset requires dune.tutorials and dune.tutorial_per_player.");
  const safeTutorialId = intParam(tutorialId, "tutorial id", 1, 32767);
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    const deleted = await tx.query("delete from dune.tutorial_per_player where player_id = $1 and tutorial_id = $2", [player.controllerId, safeTutorialId]);
    return { ok: true, player, tutorialId: safeTutorialId, deletedRows: Number(deleted.rowCount || 0) };
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
    const stillExists = await tx.query("select exists(select 1 from dune.items where id = $1 and inventory_id = $2) as exists", [safeItemId, item.rows[0].inventory_id]);
    if (stillExists.rows[0]?.exists) {
      await tx.query("delete from dune.items where id = $1 and inventory_id = $2", [safeItemId, item.rows[0].inventory_id]);
    }
    const deleted = await tx.query("select not exists(select 1 from dune.items where id = $1 and inventory_id = $2) as deleted", [safeItemId, item.rows[0].inventory_id]);
    if (!deleted.rows[0]?.deleted) throw new Error("Inventory item delete did not remove the item from the database.");
    return {
      ok: true,
      player,
      deleted: item.rows[0],
      message: playerOnline(player)
        ? `${item.rows[0].template_id || "Item"} was deleted from the database. The player may need to relog, refresh inventory, or restart the affected map before the item disappears in-game.`
        : `${item.rows[0].template_id || "Item"} was deleted from the database and will be gone when the player next joins.`
    };
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

export async function giveItemToPlayer(db, playerId, { itemName = "", itemId = "", templateId = "", quantity = 1, quality = 1 }) {
  await requireCapability(await supportsPlayerGiveItem(db), "Player give-item requires compatible dune.inventories and dune.items insert columns.");
  const target = intParam(playerId, "player id", 1);
  const resolvedTemplate = validateTemplateId(templateId || itemId || itemName);
  const stackSize = intParam(quantity, "quantity", 1, 1000000);
  const qualityLevel = intParam(quality, "grade", 0, 5);
  return db.transaction(async (tx) => {
    const inventory = await tx.query(`
      select id, actor_id, coalesce(max_item_count, 0)::int as max_item_count, coalesce(max_item_volume, 0)::int as max_item_volume
      from dune.inventories
      where actor_id = $1 and inventory_type = 0
      order by id
      limit 1
      for update`, [target]);
    const fallbackInventory = inventory.rows[0] ? inventory : await tx.query(`
      select id, actor_id, coalesce(max_item_count, 0)::int as max_item_count, coalesce(max_item_volume, 0)::int as max_item_volume
      from dune.inventories
      where actor_id = $1
      order by id
      limit 1
      for update`, [target]);
    if (!fallbackInventory.rows[0]) throw new Error("Player inventory was not found");
    const inv = fallbackInventory.rows[0];
    const count = await tx.query("select count(*)::int as count from dune.items where inventory_id = $1", [inv.id]);
    const currentCount = Number(count.rows[0]?.count || 0);
    if (inv.max_item_count > 0 && currentCount >= inv.max_item_count) throw new Error("Player inventory is full by item slot count");
    const position = await tx.query("select coalesce(max(position_index), -1)::int + 1 as position_index from dune.items where inventory_id = $1", [inv.id]);
    const stats = {
      FCustomizationStats: [[], {}],
      FItemStackAndDurabilityStats: [[], {}]
    };
    const inserted = await tx.query(`
      insert into dune.items (inventory_id, template_id, stack_size, quality_level, position_index, stats)
      values ($1, $2, $3, $4, $5, $6::jsonb)
      returning id, template_id, stack_size, quality_level, position_index, inventory_id`, [
      inv.id,
      resolvedTemplate,
      stackSize,
      qualityLevel,
      Number(position.rows[0]?.position_index || 0),
      JSON.stringify(stats)
    ]);
    return { ok: true, playerId: target, inserted: inserted.rows[0], message: `${resolvedTemplate} was added at Grade ${qualityLevel}. The player may need to relog or refresh inventory before it appears in-game.` };
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
    addIntel: await supportsIntelMutation(db),
    craftingRecipes: await supportsCraftingRecipes(db),
    researchItems: await supportsResearchItems(db),
    inventoryDelete: await supportsInventoryDelete(db),
    repairGear: await supportsRepairGear(db),
    refuelVehicle: await supportsRefuelVehicle(db),
    progression: false,
    events: false,
    stats: false,
    history: false
  };
}

async function supportsIntelMutation(db) {
  if (!(await tableExists(db, "actors"))) return false;
  const actorColumns = await columnsFor(db, "actors");
  return actorColumns.has("properties");
}

async function supportsCraftingRecipes(db) {
  if (!(await tableExists(db, "actors"))) return false;
  const actorColumns = await columnsFor(db, "actors");
  return actorColumns.has("properties");
}

async function supportsResearchItems(db) {
  if (!(await tableExists(db, "actors"))) return false;
  const actorColumns = await columnsFor(db, "actors");
  return actorColumns.has("properties");
}

async function supportsJourney(db) {
  return await supportsJourneySchema(db, await journeyIdentitySchema(db));
}

async function supportsJourneySchema(db, schema) {
  return Boolean(schema) &&
    await tableExists(db, "player_tags") &&
    await supportsTutorials(db);
}

async function supportsTutorials(db) {
  return await tableExists(db, "tutorials") &&
    await tableExists(db, "tutorial_per_player") &&
    await functionExists(db, "dune.create_or_update_tutorial_entry(bigint,smallint,smallint)");
}

function validateJourneyNodeId(value) {
  const nodeId = String(value || "").trim();
  if (!nodeId || nodeId.length > 500 || /[\r\n]/.test(nodeId)) throw new Error("Journey node ID is invalid");
  return nodeId;
}

function journeyGroup(nodeId) {
  const value = String(nodeId || "");
  if (/^DA_(CT|LDR)_/.test(value)) return "contract";
  return "story";
}

function journeyNodeRow(nodeId, category, state, tagMap, allNodeIds) {
  const nodeState = state.get(nodeId) || {};
  return {
    id: nodeId,
    name: journeyDisplayName(nodeId),
    rawName: nodeId,
    category,
    depth: journeyDepth(nodeId, allNodeIds),
    parentId: journeyParentId(nodeId, allNodeIds),
    status: nodeState.complete ? "Complete" : nodeState.revealed ? "Revealed" : "Incomplete",
    complete: Boolean(nodeState.complete),
    revealed: Boolean(nodeState.revealed),
    pendingReward: Boolean(nodeState.pendingReward),
    tags: Array.isArray(tagMap?.[nodeId]) ? tagMap[nodeId].length : 0,
    dependency: journeyParentId(nodeId, allNodeIds) || ""
  };
}

function contractNodeRow(nodeId, contractTags, contractAliases, tagState) {
  const tags = Array.isArray(contractTags?.[nodeId]) ? contractTags[nodeId] : [];
  const shortName = Object.entries(contractAliases || {}).find(([, full]) => full === nodeId)?.[0] || nodeId.replace(/^DA_CT_/, "");
  const complete = tags.length > 0 && tags.every((tag) => tagState.has(String(tag)));
  return {
    id: nodeId,
    name: journeyDisplayName(shortName),
    rawName: shortName,
    category: "Contract",
    depth: 0,
    parentId: "",
    status: complete ? "Complete" : "Incomplete",
    complete,
    revealed: false,
    pendingReward: false,
    tags: tags.length,
    dependency: ""
  };
}

function isContractNode(nodeId, journeyTagsData = {}) {
  const contractTags = journeyTagsData?.contract_tags || {};
  return Array.isArray(contractTags[nodeId]);
}

function contractTagsForNode(nodeId, journeyTagsData = {}) {
  const contractTags = journeyTagsData?.contract_tags || {};
  const tags = contractTags[nodeId];
  if (!Array.isArray(tags) || !tags.length) throw new Error(`Contract ${nodeId} was not found in the game data catalog.`);
  return tags.map((tag) => String(tag || "").trim()).filter(Boolean);
}

async function applyDirectJourneyTags(db, player, tags, mode, tagColumnName, identityId) {
  if (!tags.length) return { factionBumps: 0 };
  const tagColumn = quoteIdentifier(tagColumnName);
  if (mode === "remove") {
    await db.query(`delete from dune.player_tags where ${tagColumn} = $1 and tag = any($2::text[])`, [identityId, tags]);
    return { factionBumps: 0 };
  }
  await db.query(`
    insert into dune.player_tags (${tagColumn}, tag)
    select $1, incoming.tag
    from unnest($2::text[]) as incoming(tag)
    where not exists (
      select 1
      from dune.player_tags existing
      where existing.${tagColumn} = $1
        and existing.tag = incoming.tag
    )`, [identityId, tags]);
  return applyJourneyFactionBumps(db, player, tags);
}

async function applyJourneyFactionBumps(db, player, tags) {
  const bumps = factionTierBumps(tags);
  let factionBumps = 0;
  for (const [name, rep] of bumps.entries()) {
    const factionId = factionIdByName(name);
    if (!factionId) continue;
    const current = await db.query(`
      select coalesce(reputation_amount, 0) as reputation_amount
      from dune.player_faction_reputation
      where actor_id = $1 and faction_id = $2`, [player.controllerId, factionId]);
    if (Number(current.rows[0]?.reputation_amount || 0) >= rep) continue;
    await db.query("select dune.set_player_faction_reputation($1::bigint, $2::smallint, $3::integer)", [player.controllerId, factionId, rep]);
    factionBumps += 1;
  }
  if (factionBumps > 0) await syncFactionComponent(db, player.controllerId);
  return { factionBumps };
}

async function materializeCraftingRecipeIfKnown(db, actorId, recipeId) {
  if (!recipeId) return false;
  const known = await db.query(`
    select exists (
      select 1
      from dune.actors a
      cross join lateral jsonb_array_elements(coalesce(a.properties->'CraftingRecipesLibraryActorComponent'->'m_KnownItemRecipes', '[]'::jsonb)) recipe
      where recipe->'BaseRecipeId'->>'Name' = $1
    ) as exists`, [recipeId]);
  if (!known.rows[0]?.exists) return false;
  const current = await db.query(`
    select properties->'CraftingRecipesLibraryActorComponent'->'m_KnownItemRecipes' as recipes
    from dune.actors
    where id = $1 and properties ? 'CraftingRecipesLibraryActorComponent'
    for update`, [actorId]);
  if (!current.rows.length) return false;
  const recipes = Array.isArray(current.rows[0]?.recipes) ? current.rows[0].recipes : [];
  if (recipes.some((recipe) => recipe?.BaseRecipeId?.Name === recipeId)) return false;
  const nextRecipes = [...recipes, {
    m_Source: "SchematicPickup",
    m_bIsNew: true,
    BaseRecipeId: { Name: recipeId },
    m_QualityLevel: 0,
    m_NumberOfRecipeUses: 0,
    m_bIsLimitedUseRecipe: false
  }];
  await db.query(`
    update dune.actors
    set properties = jsonb_set(properties, '{CraftingRecipesLibraryActorComponent,m_KnownItemRecipes}', $2::jsonb, true)
    where id = $1 and properties ? 'CraftingRecipesLibraryActorComponent'`, [actorId, JSON.stringify(nextRecipes)]);
  return true;
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

async function supportsPlayerGiveItem(db) {
  if (!(await tableExists(db, "items")) || !(await tableExists(db, "inventories"))) return false;
  const inventoryColumns = await columnsFor(db, "inventories");
  const itemColumns = await columnsFor(db, "items");
  return ["id", "actor_id", "inventory_type", "max_item_count", "max_item_volume"].every((column) => inventoryColumns.has(column)) &&
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
           coalesce(ps.id, 0) as player_state_id,
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
    playerStateId: Number(row.player_state_id || 0),
    onlineStatus: row.online_status || "Offline"
  };
}

function playerOnline(player) {
  return String(player?.onlineStatus || "").toLowerCase() === "online";
}

function requireOfflinePlayer(player, actionName) {
  if (playerOnline(player)) {
    throw new Error(`${actionName} require the player to be offline. Have the player log out fully, wait until their status is Offline, then apply the edit.`);
  }
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

function mapFilterClause(map, values, alias) {
  const safe = validateMapName(map);
  if (!safe) return "";
  values.push(safe);
  return ` and ${alias}.map = $${values.length}`;
}

function validActorPartitionClause(hasWorldPartition, alias) {
  const partitionId = `coalesce(${alias}.partition_id, 0)`;
  if (!hasWorldPartition) return ` and ${partitionId} > 0`;
  return ` and ${partitionId} > 0 and exists (select 1 from dune.world_partition wp where wp.partition_id = ${alias}.partition_id and nullif(wp.server_id, '') is not null)`;
}

function validatePlayerIdForDb(value) {
  const raw = String(value || "");
  if (/^[A-Za-z0-9_:#.-]{1,128}$/.test(raw)) return raw;
  throw new Error("Invalid player id");
}

async function resolveTeleportPartition(db, playerId, partitionId) {
  const requested = Number(partitionId || 0);
  if (Number.isInteger(requested) && requested > 0) return requested;
  const current = await db.query(`
    select coalesce(a.partition_id, 0) as partition_id
    from dune.accounts ac
    join dune.player_state ps on ps.account_id = ac.id
    join dune.actors a on a.id = ps.player_pawn_id
    where ac."user" = $1
    limit 1`, [playerId]).catch(() => ({ rows: [] }));
  const currentPartition = Number(current.rows[0]?.partition_id || 0);
  if (currentPartition > 0) return currentPartition;
  const fallback = await db.query(`
    select partition_id
    from dune.world_partition
    where coalesce(blocked, false) = false
    order by partition_id
    limit 1`).catch(() => ({ rows: [] }));
  return Number(fallback.rows[0]?.partition_id || 0);
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
