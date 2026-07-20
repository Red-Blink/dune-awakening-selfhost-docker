import { assertIdentifier, intParam, isReadOnlySql, quoteIdentifier, quoteQualified, rowsResult } from "./db.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  craftingRecipeCatalogRows,
  compareJourneyCatalogOrder,
  factionDisplayName,
  factionIdByName,
  factionTierBumps,
  journeyCompletionNodeIds,
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
const INVENTORY_EDITABLE_COLUMNS = new Set(["stack_size", "quality_level", "position_index", "current_durability", "max_durability"]);
let craftingRecipeCatalogCache = null;
let adminItemMetadataCache = null;
let augmentCompatibilityCache = null;

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
  const quoted = await db.query("select quote_literal($1::text) as password", [String(password)]);
  await db.query(`alter role dune with password ${quoted.rows[0].password}`);
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

const MAX_FILTER_TERMS = 20;

function validateFilterTree(tree) {
  if (tree === null || tree === undefined) return null;
  if (!Array.isArray(tree) || !tree.length) throw new Error("Invalid filter");
  let totalTerms = 0;
  for (const group of tree) {
    if (!Array.isArray(group) || !group.length) throw new Error("Invalid filter");
    for (const term of group) {
      if (!term || (term.type !== "text" && term.type !== "column")) throw new Error("Invalid filter");
      if (term.type === "column" && !String(term.column || "")) throw new Error("Invalid filter");
      if (typeof term.value !== "string") throw new Error("Invalid filter");
      totalTerms += 1;
    }
  }
  if (totalTerms > MAX_FILTER_TERMS) throw new Error("Too many filter conditions");
  return tree;
}

function escapeLikeValue(value) {
  return String(value).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

async function buildFilterWhereClause(db, schema, table, filterTree) {
  const validated = validateFilterTree(filterTree);
  if (!validated) return { sql: "", params: [] };
  const columnNames = (await tableColumns(db, schema, table)).map((column) => column.name);
  const params = [];
  const orGroups = validated.map((group) => {
    const andTerms = group.map((term) => {
      if (term.type === "column") {
        const matched = columnNames.find((name) => name.toLowerCase() === String(term.column).toLowerCase());
        if (!matched) return "false";
        params.push(term.value);
        return `lower(${quoteIdentifier(matched)}::text) = lower($${params.length})`;
      }
      const likeValue = `%${escapeLikeValue(term.value)}%`;
      const conditions = columnNames.map((name) => {
        params.push(likeValue);
        return `${quoteIdentifier(name)}::text ILIKE $${params.length}`;
      });
      return conditions.length ? `(${conditions.join(" or ")})` : "false";
    });
    return `(${andTerms.join(" and ")})`;
  });
  return { sql: ` where ${orGroups.join(" or ")}`, params };
}

export async function tableCount(db, schema, table, filterTree = null) {
  const safe = quoteQualified(schema, table);
  const { sql: whereSql, params } = await buildFilterWhereClause(db, schema, table, filterTree);
  const result = await db.query(`select count(*)::bigint as count from ${safe}${whereSql}`, params);
  return { schema, table, count: result.rows[0]?.count ?? "0" };
}

export async function tablePreview(db, schema, table, limit = 50, offset = 0, filterTree = null) {
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
  const { sql: whereSql, params: whereParams } = await buildFilterWhereClause(db, schema, table, filterTree);
  const result = await db.query(`select ${rowIdSql} as __rowid, * from ${safe}${whereSql}${orderSql} limit $${whereParams.length + 1} offset $${whereParams.length + 2}`, [...whereParams, maxLimit, safeOffset]);
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
  const params = entries.map(([key, value]) => normalizeEditableValue(value, editable.get(key)));
  const whereParams = rowRef.params.map((value) => normalizeEditableValue(value));
  const result = await withKnownLiveRefresh(db, () => db.query(`update ${safe} set ${assignments.join(", ")} where ${rowWhereSql(rowRef, params.length)}`, [...params, ...whereParams]), {
    features: liveRefreshFeaturesForTable(schema, table, entries.map(([key]) => key))
  });
  return { ok: true, updatedRows: result.rowCount || 0, schema, table, message: result.rowCount ? itemEditMessage : undefined };
}

export async function listSpicefieldTypes(db) {
  if (!(await tableExists(db, "spicefield_types"))) return unsupported("spicefields", ["dune.spicefield_types"]);
  const result = await db.query(`
    select spicefield_type_id,
           map_name,
           field_type,
           dimension_index,
           max_globally_active,
           max_globally_primed,
           current_globally_active,
           current_globally_primed,
           is_spawning_active,
           global_spawn_weight
    from dune.spicefield_types
    order by map_name, dimension_index, field_type, spicefield_type_id`);
  return { capabilities: { spicefields: true }, rows: result.rows };
}

export async function updateSpicefieldType(db, typeId, values = {}) {
  if (!(await tableExists(db, "spicefield_types"))) return unsupported("spicefields", ["dune.spicefield_types"]);
  const id = intParam(typeId, "spicefield type id", 1);
  const entries = [];
  if (Object.prototype.hasOwnProperty.call(values, "max_globally_active")) {
    entries.push(["max_globally_active", intParam(values.max_globally_active, "max active", 0, 10000)]);
  }
  if (Object.prototype.hasOwnProperty.call(values, "max_globally_primed")) {
    entries.push(["max_globally_primed", intParam(values.max_globally_primed, "max primed", 0, 10000)]);
  }
  if (Object.prototype.hasOwnProperty.call(values, "is_spawning_active")) {
    entries.push(["is_spawning_active", normalizeBooleanInput(values.is_spawning_active, "spawning active")]);
  }
  if (Object.prototype.hasOwnProperty.call(values, "global_spawn_weight")) {
    entries.push(["global_spawn_weight", numberParam(values.global_spawn_weight, "spawn weight", 0, 100000)]);
  }
  if (!entries.length) {
    const error = new Error("No spice field values were provided.");
    error.statusCode = 400;
    throw error;
  }
  const assignments = entries.map(([key], index) => `${quoteIdentifier(key)} = $${index + 1}`);
  const params = entries.map(([, value]) => value);
  const result = await db.query(`
    update dune.spicefield_types
       set ${assignments.join(", ")}
     where spicefield_type_id = $${params.length + 1}
     returning spicefield_type_id,
               map_name,
               field_type,
               dimension_index,
               max_globally_active,
               max_globally_primed,
               current_globally_active,
               current_globally_primed,
               is_spawning_active,
               global_spawn_weight`, [...params, id]);
  if (!result.rowCount) {
    const error = new Error(`Spice field type ${id} was not found.`);
    error.statusCode = 404;
    throw error;
  }
  return { ok: true, updatedRows: result.rowCount || 0, row: result.rows[0] };
}

export async function landsraadOverview(db) {
  if (!(await tableExists(db, "landsraad_decree_term")) || !(await tableExists(db, "landsraad_tasks"))) {
    return unsupported("landsraad", ["dune.landsraad_decree_term", "dune.landsraad_tasks"]);
  }

  const hasDecrees = await tableExists(db, "landsraad_decrees");
  const hasRewards = await tableExists(db, "landsraad_task_rewards");
  const hasFactionContributions = await tableExists(db, "landsraad_task_faction_contributions");
  const termColumns = await columnsFor(db, "landsraad_decree_term");
  const taskColumns = await columnsFor(db, "landsraad_tasks");
  const termResult = await db.query(`
    select t.term_id,
           ${termColumns.has("start_time") ? "t.start_time::text" : "''"} as start_time,
           ${termColumns.has("end_time") ? "t.end_time::text" : "''"} as end_time,
           ${termColumns.has("test_term") ? "coalesce(t.test_term, false)" : "false"} as test_term,
           ${termColumns.has("reigning_faction_id") ? "coalesce(rf.name, '')" : "''"} as reigning_faction,
           ${termColumns.has("active_decree_id") ? "coalesce(ad.decree_name, '')" : "''"} as active_decree,
           ${termColumns.has("elected_decree_id") ? "coalesce(ed.decree_name, '')" : "''"} as elected_decree,
           ${termColumns.has("winning_faction_id") ? "coalesce(wf.name, '')" : "''"} as winning_faction
    from dune.landsraad_decree_term t
    ${termColumns.has("reigning_faction_id") ? "left join dune.factions rf on rf.id = t.reigning_faction_id" : ""}
    ${termColumns.has("active_decree_id") ? "left join dune.landsraad_decrees ad on ad.id = t.active_decree_id" : ""}
    ${termColumns.has("elected_decree_id") ? "left join dune.landsraad_decrees ed on ed.id = t.elected_decree_id" : ""}
    ${termColumns.has("winning_faction_id") ? "left join dune.factions wf on wf.id = t.winning_faction_id" : ""}
    order by t.term_id desc
    limit 1`);
  const term = termResult.rows[0] || null;

  const decrees = hasDecrees ? (await db.query(`
    select id,
           decree_name as name,
           coalesce(weight, 0) as weight,
           coalesce(disabled, false) as disabled
    from dune.landsraad_decrees
    order by id`)).rows : [];

  let tasks = [];
  let rewards = [];
  if (term) {
    const taskSelects = [
      "t.id::text as task_id",
      taskColumns.has("board_index") ? "coalesce(t.board_index, 0) as board_index" : "0 as board_index",
      taskColumns.has("house_name") ? "coalesce(t.house_name, '') as house_name" : "'' as house_name",
      taskColumns.has("house_name") ? "regexp_replace(coalesce(t.house_name, ''), '^DA_House', '') as display_name" : "'' as display_name",
      taskColumns.has("goal_amount") ? "coalesce(t.goal_amount, 0)::int as goal_amount" : "0 as goal_amount",
      taskColumns.has("completed") ? "coalesce(t.completed, false) as completed" : "false as completed",
      taskColumns.has("winning_faction_id") ? "coalesce(wf.name, '') as winning_faction" : "'' as winning_faction",
      taskColumns.has("sysselraad") ? "coalesce(t.sysselraad, false) as sysselraad" : "false as sysselraad",
      hasFactionContributions ? "coalesce(sum(fc.amount), 0)::real as faction_progress" : "0::real as faction_progress"
    ];
    const joins = [
      taskColumns.has("winning_faction_id") ? "left join dune.factions wf on wf.id = t.winning_faction_id" : "",
      hasFactionContributions ? "left join dune.landsraad_task_faction_contributions fc on fc.task_id = t.id" : ""
    ].filter(Boolean).join("\n");
    const groupBy = hasFactionContributions
      ? `group by ${taskSelects
        .filter((select) => !select.includes("sum("))
        .map((select) => select.split(/\s+as\s+/i)[0])
        .join(", ")}`
      : "";
    tasks = (await db.query(`
      select ${taskSelects.join(",\n             ")}
      from dune.landsraad_tasks t
      ${joins}
      where t.term_id = $1
      ${groupBy}
      order by ${taskColumns.has("board_index") ? "coalesce(t.board_index, 0)" : "t.id::text"}, t.id::text`, [term.term_id])).rows;

    if (hasRewards) {
      rewards = (await db.query(`
        select r.ctid::text as row_locator,
               r.task_id::text as task_id,
               r.threshold::int as threshold,
               coalesce(r.template_id, '') as template_id,
               coalesce(r.amount, 0)::int as amount
        from dune.landsraad_task_rewards r
        join dune.landsraad_tasks t on t.id = r.task_id
        where t.term_id = $1
        order by ${taskColumns.has("board_index") ? "coalesce(t.board_index, 0)" : "t.id"}, r.task_id, r.threshold`, [term.term_id])).rows;
    }
  }

  return {
    capabilities: {
      landsraad: true,
      decrees: hasDecrees,
      rewards: hasRewards,
      factionContributions: hasFactionContributions,
      playerContributions: await tableExists(db, "landsraad_task_player_contributions"),
      guildContributions: await tableExists(db, "landsraad_task_guild_contributions")
    },
    term,
    decrees,
    tasks,
    rewards
  };
}

export async function updateLandsraadTaskGoal(db, taskId, goalAmount) {
  await requireCapability(await tableExists(db, "landsraad_tasks"), "Landsraad task goals require dune.landsraad_tasks.");
  const id = intParam(taskId, "task id", 1);
  const goal = intParam(goalAmount, "goal amount", 0, 2147483647);
  const result = await db.query(`
    update dune.landsraad_tasks
       set goal_amount = $1
     where id = $2
     returning id::text as task_id, goal_amount::int`, [goal, id]);
  if (!result.rowCount) {
    const error = new Error(`Landsraad task ${id} was not found.`);
    error.statusCode = 404;
    throw error;
  }
  return { ok: true, updatedRows: result.rowCount || 0, row: result.rows[0] };
}

export async function updateLandsraadTermTaskGoals(db, termId, goalAmount) {
  await requireCapability(await tableExists(db, "landsraad_tasks"), "Landsraad task goals require dune.landsraad_tasks.");
  const id = intParam(termId, "term id", 1);
  const goal = intParam(goalAmount, "goal amount", 0, 2147483647);
  const result = await db.query(`
    update dune.landsraad_tasks
       set goal_amount = $1
     where term_id = $2`, [goal, id]);
  return { ok: true, updatedRows: result.rowCount || 0, termId: id, goalAmount: goal };
}

export async function updateLandsraadRewardTier(db, values = {}) {
  await requireCapability(await tableExists(db, "landsraad_task_rewards"), "Landsraad rewards require dune.landsraad_task_rewards.");
  const { rowLocator, taskId, threshold, newThreshold, templateId, amount } = values;
  const safeRowLocator = String(rowLocator ?? "").trim();
  if (!/^\(\d+,\d+\)$/.test(safeRowLocator)) {
    const error = new Error("A valid Landsraad reward row locator is required. Reload the page and try again.");
    error.statusCode = 400;
    throw error;
  }
  const safeTaskId = intParam(taskId, "task id", 1);
  const oldThreshold = intParam(threshold, "reward threshold", 0, 2147483647);
  const nextThreshold = Object.prototype.hasOwnProperty.call(values, "newThreshold")
    ? intParam(newThreshold, "new reward threshold", 0, 2147483647)
    : oldThreshold;
  const nextTemplateId = String(templateId ?? "").trim();
  const nextAmount = intParam(amount, "reward amount", 0, 2147483647);
  if (!nextTemplateId || nextTemplateId.length > 256) {
    const error = new Error("Reward template id is required and must be shorter than 257 characters.");
    error.statusCode = 400;
    throw error;
  }
  const result = await db.query(`
    update dune.landsraad_task_rewards
       set threshold = $1,
           template_id = $2,
           amount = $3
     where ctid = $4::tid
       and task_id = $5
       and threshold = $6
     returning ctid::text as row_locator,
               task_id::text as task_id,
               threshold::int as threshold,
               template_id,
               amount::int`, [nextThreshold, nextTemplateId, nextAmount, safeRowLocator, safeTaskId, oldThreshold]);
  if (!result.rowCount) {
    const error = new Error(`Landsraad reward tier ${oldThreshold} for task ${safeTaskId} was not found.`);
    error.statusCode = 404;
    throw error;
  }
  return { ok: true, updatedRows: result.rowCount || 0, row: result.rows[0] };
}

export async function setLandsraadPlayerContribution(db, { playerId, taskId, amount } = {}) {
  await requireCapability(await tableExists(db, "landsraad_task_player_contributions"), "Landsraad player contributions require dune.landsraad_task_player_contributions.");
  await requireCapability(await tableExists(db, "landsraad_task_faction_contributions"), "Landsraad faction contribution totals require dune.landsraad_task_faction_contributions.");
  const safeTaskId = intParam(taskId, "task id", 1);
  const safeAmount = numberParam(amount, "contribution amount", 0, 1_000_000_000);
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, playerId);
    const factionResult = await tx.query(`
      select faction_id
      from dune.player_faction
      where actor_id = $1
      order by faction_id
      limit 1`, [player.controllerId]);
    const factionId = factionResult.rows[0]?.faction_id;
    if (factionId === undefined || factionId === null) {
      const error = new Error("Player has no faction assignment, so Landsraad contribution totals cannot be calculated.");
      error.statusCode = 400;
      throw error;
    }
    await tx.query("delete from dune.landsraad_task_player_contributions where player_id = $1 and task_id = $2", [player.controllerId, safeTaskId]);
    await tx.query(`
      insert into dune.landsraad_task_player_contributions (player_id, faction_id, task_id, amount)
      values ($1, $2, $3, $4)`, [player.controllerId, factionId, safeTaskId, safeAmount]);
    await tx.query("delete from dune.landsraad_task_faction_contributions where task_id = $1", [safeTaskId]);
    await tx.query(`
      insert into dune.landsraad_task_faction_contributions (faction_id, task_id, amount)
      select faction_id, task_id, floor(sum(amount))::int
      from dune.landsraad_task_player_contributions
      where task_id = $1
      group by faction_id, task_id`, [safeTaskId]);
    if (await tableExists(tx, "landsraad_task_guild_contributions") && await tableExists(tx, "guild_members")) {
      await tx.query("delete from dune.landsraad_task_guild_contributions where task_id = $1", [safeTaskId]);
      await tx.query(`
        insert into dune.landsraad_task_guild_contributions (guild_id, faction_id, task_id, amount)
        select gm.guild_id, pc.faction_id, pc.task_id, floor(sum(pc.amount))::int
        from dune.landsraad_task_player_contributions pc
        join dune.guild_members gm on gm.player_id = pc.player_id
        where pc.task_id = $1
        group by gm.guild_id, pc.faction_id, pc.task_id`, [safeTaskId]);
    }
    return {
      ok: true,
      player,
      taskId: safeTaskId,
      factionId,
      amount: safeAmount,
      message: "Landsraad contribution updated and totals recalculated."
    };
  });
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

function normalizeEditableValue(value, column = {}) {
  if (value === undefined) return null;
  if (Array.isArray(value) && column?.data_type === "ARRAY") return value;
  if (typeof value === "string" && column?.data_type === "ARRAY") {
    const trimmed = value.trim();
    if (/^\[.*\]$/s.test(trimmed)) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
      } catch {}
    }
  }
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return value;
}

function normalizeBooleanInput(value, label) {
  if (typeof value === "boolean") return value;
  if (/^(true|1|yes|on)$/i.test(String(value))) return true;
  if (/^(false|0|no|off)$/i.test(String(value))) return false;
  const error = new Error(`Invalid ${label}`);
  error.statusCode = 400;
  throw error;
}

function numberParam(value, label, min = -Number.MAX_VALUE, max = Number.MAX_VALUE) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid ${label}`);
  return n;
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
  const playerStateColumns = await columnsFor(db, "player_state");
  const lastSeenSelect = await playerLastSeenSelect(db);
  const loginSessionSelect = playerStateColumns.has("last_login_time")
    ? "coalesce(ps.last_login_time::text, '')"
    : "''";
  const currentPawnFilter = playerStateColumns.has("player_pawn_id")
    ? " and (ps.player_pawn_id is null or ps.player_pawn_id = 0 or ps.player_pawn_id = a.id)"
    : "";
  const currentPawnPriority = playerStateColumns.has("player_pawn_id")
    ? "when ps.player_pawn_id = a.id then 0"
    : "when false then 0";
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
  where += " and not (nullif(trim(coalesce(ps.character_name, '')), '') is null and coalesce(ps.online_status::text, '') <> 'Online')";
  where += currentPawnFilter;
  if (online) where += " and coalesce(ps.online_status::text, '') = 'Online'";
  if (q) {
    values.push(`%${q}%`);
    where += ` and (ps.character_name ilike $${values.length} or ac."user" ilike $${values.length} or a.id::text = $${values.length} or a.owner_account_id::text = $${values.length})`;
  }
  const result = await db.query(`
    with player_rows as (
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
             ${loginSessionSelect} as login_session,
             ${lastSeenWithOnlineFallback} as last_seen,
             coalesce(nullif(ps.player_controller_id, 0), nullif(a.owner_account_id, 0), a.id) as dedupe_key,
             case
               ${currentPawnPriority}
               when coalesce(ps.character_name, '') <> '' then 1
               else 2
             end as row_priority,
             case when coalesce(ps.online_status::text, '') = 'Online' then 0 else 1 end as online_priority
      from dune.actors a
      left join dune.player_state ps on ps.account_id = a.owner_account_id
      left join dune.accounts ac on ac.id = a.owner_account_id
      where ${where}
    ),
    deduped_players as (
      select distinct on (dedupe_key)
             actor_id,
             player_pawn_id,
             account_id,
             character_name,
             player_controller_id,
             funcom_id,
             fls_id,
             action_player_id,
             class,
             map,
             online_status,
             login_session,
             last_seen
      from player_rows
      order by dedupe_key, row_priority, online_priority, actor_id desc
    )
    select *
    from deduped_players
    order by lower(coalesce(character_name, '')), actor_id
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

const NEUTRAL_GUILD_FACTION_ID = 3;

function guildFactionDisplayName(row) {
  const factionId = row.guild_faction;
  if (!factionId || Number(factionId) === NEUTRAL_GUILD_FACTION_ID) return "Neutral";
  return row.guild_faction_name || `Faction ${factionId}`;
}

export async function listGuilds(db, { q = "" } = {}) {
  if (!(await tableExists(db, "guilds"))) return unsupported("guilds", ["dune.guilds"]);
  const guildColumns = await columnsFor(db, "guilds");
  const guildIdColumn = firstExistingColumn(guildColumns, ["guild_id", "id"]);
  const guildNameColumn = firstExistingColumn(guildColumns, ["guild_name", "name", "display_name"]);
  if (!guildIdColumn || !guildNameColumn) return unsupported("guilds", ["dune.guilds"]);
  const guildFactionColumn = firstExistingColumn(guildColumns, ["guild_faction", "faction_id", "faction"]);
  const guildDescriptionColumn = firstExistingColumn(guildColumns, ["guild_description", "description"]);
  const hasMembers = await tableExists(db, "guild_members");
  let memberGuildColumn = "";
  if (hasMembers) {
    const memberColumns = await columnsFor(db, "guild_members");
    memberGuildColumn = firstExistingColumn(memberColumns, ["guild_id", "id"]);
  }
  const hasFactions = guildFactionColumn && await tableExists(db, "factions");

  const values = [];
  let where = "1=1";
  if (q) {
    values.push(`%${q}%`);
    where += ` and g.${quoteIdentifier(guildNameColumn)} ilike $${values.length}`;
  }

  const memberCountSelect = hasMembers && memberGuildColumn
    ? `(select count(*) from dune.guild_members gm where gm.${quoteIdentifier(memberGuildColumn)} = g.${quoteIdentifier(guildIdColumn)})`
    : "0";

  const result = await db.query(`
    select g.${quoteIdentifier(guildIdColumn)}::text as guild_id,
           coalesce(g.${quoteIdentifier(guildNameColumn)}, '') as guild_name,
           ${guildFactionColumn ? `coalesce(g.${quoteIdentifier(guildFactionColumn)}::text, '')` : "''"} as guild_faction,
           ${hasFactions ? "coalesce(f.name, '')" : "''"} as guild_faction_name,
           ${guildDescriptionColumn ? `coalesce(g.${quoteIdentifier(guildDescriptionColumn)}, '')` : "''"} as guild_description,
           ${memberCountSelect}::int as member_count
    from dune.guilds g
    ${hasFactions ? `left join dune.factions f on f.id = g.${quoteIdentifier(guildFactionColumn)}` : ""}
    where ${where}
    order by lower(coalesce(g.${quoteIdentifier(guildNameColumn)}, '')), g.${quoteIdentifier(guildIdColumn)}
    limit 500`, values);

  const rows = result.rows.map((row) => ({ ...row, guild_faction: guildFactionDisplayName(row) }));
  return { capabilities: { guilds: true, guildMembers: hasMembers }, rows };
}

export async function guildMembers(db, guildId) {
  const id = intParam(guildId, "guild id", 1);
  if (!(await tableExists(db, "guild_members")) || !(await tableExists(db, "guilds"))) {
    return unsupported("guildMembers", ["dune.guild_members", "dune.guilds"]);
  }
  const memberColumns = await columnsFor(db, "guild_members");
  const guildColumns = await columnsFor(db, "guilds");
  const memberGuildColumn = firstExistingColumn(memberColumns, ["guild_id", "id"]);
  const memberPlayerColumn = firstExistingColumn(memberColumns, ["player_id", "player_controller_id", "actor_id", "account_id", "player_pawn_id"]);
  const memberRoleColumn = firstExistingColumn(memberColumns, ["role_id", "role"]);
  const guildIdColumn = firstExistingColumn(guildColumns, ["guild_id", "id"]);
  if (!memberGuildColumn || !memberPlayerColumn || !guildIdColumn) {
    return unsupported("guildMembers", ["dune.guild_members", "dune.guilds"]);
  }

  const hasPlayerState = await tableExists(db, "player_state");
  const hasActors = await tableExists(db, "actors");
  const memberPlayerRef = `gm.${quoteIdentifier(memberPlayerColumn)}`;
  const joins = [];
  if (hasPlayerState) joins.push(`left join dune.player_state ps_by_controller on ps_by_controller.player_controller_id = ${memberPlayerRef}`);
  if (hasActors) joins.push(`left join dune.actors a_by_actor_id on a_by_actor_id.id = ${memberPlayerRef}`);
  if (hasPlayerState) joins.push(`left join dune.player_state ps_by_account on ps_by_account.account_id = coalesce(${hasActors ? "a_by_actor_id.owner_account_id" : "null"}, ${memberPlayerRef})`);
  const characterNameSelect = hasPlayerState
    ? "coalesce(ps_by_controller.character_name, ps_by_account.character_name, '')"
    : "''";

  const result = await db.query(`
    select ${memberPlayerRef}::text as player_id,
           ${memberRoleColumn ? `gm.${quoteIdentifier(memberRoleColumn)}::text` : "''"} as role_id,
           ${characterNameSelect} as character_name
    from dune.guild_members gm
    join dune.guilds g on g.${quoteIdentifier(guildIdColumn)} = gm.${quoteIdentifier(memberGuildColumn)}
    ${joins.join("\n    ")}
    where gm.${quoteIdentifier(memberGuildColumn)} = $1
    order by ${memberRoleColumn ? `gm.${quoteIdentifier(memberRoleColumn)} asc, ` : ""}lower(${characterNameSelect})`, [id]);

  return { capabilities: { guildMembers: true }, rows: result.rows };
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
  const row = result.rows[0];
  const [factions, guilds] = await Promise.all([
    leadershipFactions(db).catch(() => new Map()),
    leadershipGuilds(db).catch(() => new Map())
  ]);
  const controllerId = String(row.player_controller_id || "");
  const actorIdKey = String(row.actor_id || "");
  const accountIdKey = String(row.account_id || "");
  row.faction = factions.get(controllerId) || factions.get(actorIdKey) || "Unassigned";
  row.guild = guilds.get(controllerId) || guilds.get(actorIdKey) || guilds.get(accountIdKey) || "Unavailable";
  return { capabilities: await playerCapabilities(db), player: row };
}

export async function playerInventory(db, id) {
  if (!(await tableExists(db, "items")) || !(await tableExists(db, "inventories"))) return unsupported("inventory", ["dune.items", "dune.inventories"]);

  const inv = await db.query(`
    select id, max_item_count, max_item_volume
    from dune.inventories
    where actor_id = $1 and inventory_type = 0
    order by id limit 1`, [intParam(id, "player id", 1)]);

  const invId = inv.rows[0]?.id;
  const maxSlots = Number(inv.rows[0]?.max_item_count) || 40;
  const maxVolume = Number(inv.rows[0]?.max_item_volume) || 225;

  const result = await db.query(`
    select i.id,
           i.template_id,
           i.stack_size,
           i.quality_level,
           i.position_index,
           i.inventory_id,
           coalesce((i.stats->'FItemStackAndDurabilityStats'->1->>'CurrentDurability'), null) as current_durability,
           coalesce(
             nullif((i.stats->'FItemStackAndDurabilityStats'->1->>'MaxDurability')::numeric, 0),
             nullif((i.stats->'FItemStackAndDurabilityStats'->1->>'DecayedMaxDurability')::numeric, 0),
             null
           ) as max_durability,
           i.stats
    from dune.items i
    join dune.inventories inv2 on i.inventory_id = inv2.id
    where inv2.actor_id = $1 and inv2.inventory_type = 0
    order by i.template_id`, [intParam(id, "player id", 1)]);
  const itemMetadata = adminItemMetadata();
  const rows = result.rows.map(({ stats, ...row }) => {
    const metadata = itemMetadata.get(String(row.template_id || ""));
    return {
      ...row,
      category: metadata?.category || "",
      source: metadata?.source || "",
      augments: extractAugmentIdsFromStats(stats)
    };
  });
  return { capabilities: { inventory: true }, maxSlots, maxVolume, rows };
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
  const playerExists = await offlineTeleportPlayerExists(db, flsId);
  if (!playerExists) {
    const error = new Error("Player was not found in the game database.");
    error.statusCode = 404;
    throw error;
  }
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

const PERMISSION_RANK_LABELS = {
  1: "Owner",
  2: "Co-Owner",
  3: "Associate"
};

function permissionRankLabel(rank) {
  return PERMISSION_RANK_LABELS[rank] || `Rank ${rank}`;
}

const BASE_SORT_COLUMNS = {
  base_id: { order: ["id"] },
  name: { order: ["lower(coalesce(name, ''))"] },
  base_type: { order: ["lower(coalesce(base_type, ''))"] },
  owner_name: { order: ["lower(coalesce(owner_name, ''))"], owner: true },
  shared_with: { order: ["shared_count"], shared: true },
  map: { order: ["lower(coalesce(map, ''))"] },
  coordinates: { order: ["x", "y", "z"] },
  piece_count: { order: ["piece_count"], pieces: true },
  placeable_count: { order: ["placeable_count"], placeables: true }
};

const BASE_TYPE_SQL = `case
  when lower(coalesce(a.class, '')) like '%totemsmall%' then 'Sub-Fief'
  when lower(coalesce(a.class, '')) like '%totem%' then 'Advanced Sub-Fief'
  else 'Unknown'
end`;

const BASE_NAME_SQL = `case
  when nullif(btrim(pa.actor_name), '') is not null
    and lower(btrim(pa.actor_name)) <> 'none'
    and btrim(pa.actor_name) not like '##%'
  then btrim(pa.actor_name)
  when lower(coalesce(a.class, '')) like '%totemsmall%' then 'Totem_Small_Patent'
  when lower(coalesce(a.class, '')) like '%totem%' then 'Totem_Patent'
  else 'Unnamed Base'
end`;

export async function listBases(db, { q = "", page = 0, pageSize = 50, sortColumn = "name", sortDirection = "asc" } = {}) {
  const requiredTables = ["buildings", "building_instances", "actor_fgl_entities", "actors"];
  for (const table of requiredTables) {
    if (!(await tableExists(db, table))) {
      return { ...unsupported("bases", requiredTables.map((t) => `dune.${t}`)), totalCount: 0, totalBases: 0, totalPieces: 0, totalPlaceables: 0 };
    }
  }
  const safePageSize = intParam(pageSize, "pageSize", 1, 200);
  const safePage = intParam(page, "page", 0);
  const offset = safePage * safePageSize;
  const safeSortColumn = Object.hasOwn(BASE_SORT_COLUMNS, sortColumn) ? sortColumn : "name";
  const safeSortDirection = String(sortDirection).toLowerCase() === "desc" ? "desc" : "asc";
  const sortSpec = BASE_SORT_COLUMNS[safeSortColumn];

  // Owner resolution (lowest-rank permission holder) is a per-base correlated LATERAL —
  // expensive at scale. When searching, the `having` clause needs it to filter on, so it
  // must run inside `matched` (before pagination) for every candidate base. When not
  // searching, defer it to the final SELECT so it only runs for the page being displayed.
  const searching = Boolean(q);
  const resolveOwnerBeforePaging = searching || sortSpec.owner;
  const values = [];
  let having = "";
  if (searching) {
    values.push(`%${q}%`);
    having = `having (${BASE_NAME_SQL}) ilike $${values.length} or (${BASE_TYPE_SQL}) ilike $${values.length} or coalesce(owner.character_name, '') ilike $${values.length}`;
  }
  values.push(safePageSize, offset);
  const limitParamIndex = values.length - 1;
  const offsetParamIndex = values.length;

  const matchedOwnerSelect = resolveOwnerBeforePaging ? "coalesce(owner.character_name, '') as owner_name,\n               " : "";
  const matchedOwnerJoin = resolveOwnerBeforePaging ? `
        left join lateral (
          select ps.character_name
          from dune.permission_actor_rank par
          join dune.actors player_a on player_a.id = par.player_id
          join dune.player_state ps on ps.account_id = player_a.owner_account_id
          where par.permission_actor_id = a.id
          order by par.rank asc, ps.character_name asc
          limit 1
        ) owner on true` : "";
  const matchedGroupByOwner = resolveOwnerBeforePaging ? "owner.character_name, " : "";

  const finalOwnerSelect = resolveOwnerBeforePaging ? "p.owner_name," : "coalesce(owner.character_name, '') as owner_name,";
  const finalOwnerJoin = resolveOwnerBeforePaging ? "" : `
      left join lateral (
        select ps.character_name
        from dune.permission_actor_rank par
        join dune.actors player_a on player_a.id = par.player_id
        join dune.player_state ps on ps.account_id = player_a.owner_account_id
        where par.permission_actor_id = p.actor_id
        order by par.rank asc, ps.character_name asc
        limit 1
      ) owner on true`;
  const sharedOwnerRef = resolveOwnerBeforePaging ? "p.owner_name" : "coalesce(owner.character_name, '')";
  const matchedSortSelect = [
    "((a.transform).location).x as x",
    "((a.transform).location).y as y",
    "((a.transform).location).z as z",
    sortSpec.pieces ? "(select count(*) from dune.building_instances count_bi where count_bi.building_id = b.id)::int as piece_count" : "",
    sortSpec.placeables ? "(select count(*) from dune.placeables count_pl where count_pl.owner_entity_id in (select distinct bi2.owner_entity_id from dune.building_instances bi2 where bi2.building_id = b.id))::int as placeable_count" : "",
    sortSpec.shared ? "(select count(*) from dune.permission_actor_rank count_par where count_par.permission_actor_id = a.id and count_par.rank <> 1)::int as shared_count" : ""
  ].filter(Boolean).join(",\n               ");
  const pagedOrder = [...sortSpec.order, ...(sortSpec.order.includes("id") ? [] : ["id"])].map((column) => `${column} ${safeSortDirection}`).join(", ");
  const finalPieceCount = sortSpec.pieces ? "p.piece_count" : "(select count(*) from dune.building_instances bi where bi.building_id = p.id)::int";
  const finalPlaceableCount = sortSpec.placeables ? "p.placeable_count" : "(select count(*) from dune.placeables pl where pl.owner_entity_id = p.owner_entity_id)::int";

  try {
    const result = await db.query(`
      with matched as (
        select b.id,
               a.id as actor_id,
               max(bi.owner_entity_id) as owner_entity_id,
               ${BASE_NAME_SQL} as name,
               ${BASE_TYPE_SQL} as base_type,
               ${matchedOwnerSelect}coalesce(a.map, '') as map,
               a.transform,
               ${matchedSortSelect}
        from dune.buildings b
        join dune.building_instances bi on bi.building_id = b.id
        join dune.actor_fgl_entities afe on afe.entity_id = bi.owner_entity_id
        join dune.actors a on a.id = afe.actor_id
        left join dune.permission_actor pa on pa.actor_id = a.id
        ${matchedOwnerJoin}
        where a.transform is not null
        group by b.id, a.id, a.class, pa.actor_name, ${matchedGroupByOwner}a.map, a.transform
        ${having}
      ),
      paged as (
        select *,
               count(*) over() as total_count,
               row_number() over (order by ${pagedOrder}) as sort_position
        from matched
        order by ${pagedOrder}
        limit $${limitParamIndex} offset $${offsetParamIndex}
      )
      select p.id::text as base_id,
             p.name,
             p.base_type,
             ${finalOwnerSelect}
             p.map,
             p.x,
             p.y,
             p.z,
             p.total_count,
             ${finalPieceCount} as piece_count,
             ${finalPlaceableCount} as placeable_count,
             coalesce(shared.entries, '[]'::jsonb) as shared_with
      from paged p
      ${finalOwnerJoin}
      left join lateral (
        select jsonb_agg(jsonb_build_object('name', ps.character_name, 'rank', par.rank) order by par.rank asc, ps.character_name asc) as entries
        from dune.permission_actor_rank par
        join dune.actors player_a on player_a.id = par.player_id
        join dune.player_state ps on ps.account_id = player_a.owner_account_id
        where par.permission_actor_id = p.actor_id
          and par.rank <> 1
          and ps.character_name is distinct from ${sharedOwnerRef}
      ) shared on true
      order by p.sort_position`, values);

    const totalsResult = await db.query(`
      with valid_bases as (
        select distinct b.id as building_id, afe.entity_id as owner_entity_id
        from dune.buildings b
        join dune.building_instances bi on bi.building_id = b.id
        join dune.actor_fgl_entities afe on afe.entity_id = bi.owner_entity_id
        join dune.actors a on a.id = afe.actor_id
        where a.transform is not null
      )
      select (select count(*) from valid_bases)::int as total_bases,
             (select count(*) from dune.building_instances bi join valid_bases vb on vb.building_id = bi.building_id)::int as total_pieces,
             (select count(distinct pl.id) from dune.placeables pl join valid_bases vb on vb.owner_entity_id = pl.owner_entity_id)::int as total_placeables`);

    return {
      capabilities: { bases: true },
      totalCount: result.rows[0] ? Number(result.rows[0].total_count) : 0,
      totalBases: totalsResult.rows[0] ? Number(totalsResult.rows[0].total_bases) : 0,
      totalPieces: totalsResult.rows[0] ? Number(totalsResult.rows[0].total_pieces) : 0,
      totalPlaceables: totalsResult.rows[0] ? Number(totalsResult.rows[0].total_placeables) : 0,
      rows: result.rows.map(({ total_count, sort_position, ...row }) => ({
        ...row,
        x: Number(row.x),
        y: Number(row.y),
        z: Number(row.z),
        piece_count: Number(row.piece_count),
        placeable_count: Number(row.placeable_count),
        shared_with: (Array.isArray(row.shared_with) ? row.shared_with : []).map((entry) => ({
          name: entry.name,
          rank: entry.rank,
          label: permissionRankLabel(entry.rank)
        }))
      }))
    };
  } catch (error) {
    return { capabilities: { bases: false }, rows: [], totalCount: 0, totalBases: 0, totalPieces: 0, totalPlaceables: 0, reason: `Base list query is unsupported by this schema: ${error.message}` };
  }
}

function quaternionYawDegrees(qz, qw) {
  return (2 * Math.atan2(Number(qz) || 0, Number(qw) || 0)) * (180 / Math.PI);
}

export async function exportBaseAsBlueprint(db, id) {
  const baseId = intParam(id, "base id", 1);
  const requiredTables = ["buildings", "building_instances", "actor_fgl_entities", "actors"];
  for (const table of requiredTables) {
    await requireCapability(await tableExists(db, table), `Base export requires dune.${requiredTables.join(", dune.")}.`);
  }
  const baseRow = await db.query(`
    select b.id::text as base_id,
           ${BASE_NAME_SQL} as name,
           ${BASE_TYPE_SQL} as base_type,
           coalesce(owner.character_name, '') as owner_name,
           coalesce(a.map, '') as map,
           ((a.transform).location).x as x,
           ((a.transform).location).y as y,
           ((a.transform).location).z as z,
           max(bi.owner_entity_id) as owner_entity_id
    from dune.buildings b
    join dune.building_instances bi on bi.building_id = b.id
    join dune.actor_fgl_entities afe on afe.entity_id = bi.owner_entity_id
    join dune.actors a on a.id = afe.actor_id
    left join dune.permission_actor pa on pa.actor_id = a.id
    left join lateral (
      select ps.character_name
      from dune.permission_actor_rank par
      join dune.actors player_a on player_a.id = par.player_id
      join dune.player_state ps on ps.account_id = player_a.owner_account_id
      where par.permission_actor_id = a.id
      order by par.rank asc, ps.character_name asc
      limit 1
    ) owner on true
    where b.id = $1
    group by b.id, pa.actor_name, owner.character_name, a.class, a.map, a.transform`, [baseId]);
  if (!baseRow.rows.length) throw new UnsupportedCapabilityError(`Base ${baseId} was not found.`);
  const base = baseRow.rows[0];
  const anchor = { x: Number(base.x), y: Number(base.y), z: Number(base.z) };

  // Blueprint import (blueprints.js) expects positions relative to a capture origin and a single
  // yaw-degree rotation for instances, not the live tables' absolute world coords + quaternion.
  // The anchor point is arbitrary (the base's own actor position) but consistent, so the exported
  // pieces stay correctly positioned relative to each other when re-placed anywhere in-game.
  // Rotation is captured yaw-only (Z axis) since every sampled live piece has qx=qy=0; pitch/roll
  // on tilted geometry, if any exists, is lost.
  const pieceRows = await db.query(`
    select instance_id, building_type, transform
    from dune.building_instances
    where building_id = $1
    order by instance_id`, [baseId]);
  const instances = pieceRows.rows.map((row) => {
    const t = row.transform || [];
    return {
      instance_id: row.instance_id,
      building_type: row.building_type,
      x: (Number(t[0]) || 0) - anchor.x,
      y: (Number(t[1]) || 0) - anchor.y,
      z: (Number(t[2]) || 0) - anchor.z,
      rotation: quaternionYawDegrees(t[5], t[6])
    };
  });

  const placeableRows = (await tableExists(db, "placeables"))
    ? await db.query(`
        select p.id as placeable_id, p.building_type,
               ((a.transform).location).x as x,
               ((a.transform).location).y as y,
               ((a.transform).location).z as z,
               ((a.transform).rotation).z as qz,
               ((a.transform).rotation).w as qw
        from dune.placeables p
        join dune.actors a on a.id = p.id
        where p.owner_entity_id = $1
          and a.transform is not null
        order by p.id`, [base.owner_entity_id])
    : { rows: [] };
  const placeables = placeableRows.rows.map((row) => ({
    placeable_id: row.placeable_id,
    building_type: row.building_type,
    x: Number(row.x) - anchor.x,
    y: Number(row.y) - anchor.y,
    z: Number(row.z) - anchor.z,
    rx: 0,
    ry: 0,
    rz: quaternionYawDegrees(row.qz, row.qw)
  }));

  return {
    base_id: base.base_id,
    name: base.name,
    base_type: base.base_type,
    owner_name: base.owner_name,
    map: base.map,
    x: anchor.x,
    y: anchor.y,
    z: anchor.z,
    piece_count: instances.length,
    placeable_count: placeables.length,
    instances,
    placeables
  };
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

function adminItemMetadata() {
  if (adminItemMetadataCache) return adminItemMetadataCache;
  const metadata = new Map();
  try {
    const path = [
      resolve(process.cwd(), "runtime/data/admin-items.json"),
      resolve(process.cwd(), "../../runtime/data/admin-items.json")
    ].find((candidate) => existsSync(candidate)) || resolve(process.cwd(), "runtime/data/admin-items.json");
    const items = JSON.parse(readFileSync(path, "utf8"));
    for (const item of Array.isArray(items) ? items : []) {
      const id = String(item.id || "").trim();
      if (!id) continue;
      metadata.set(id, { name: String(item.name || ""), category: String(item.category || ""), source: String(item.source || "") });
    }
  } catch {
    // Inventory still works without the optional local catalog metadata.
  }
  adminItemMetadataCache = metadata;
  return adminItemMetadataCache;
}

function augmentCompatibilityCatalog() {
  if (augmentCompatibilityCache) return augmentCompatibilityCache;
  try {
    const path = [
      resolve(process.cwd(), "runtime/data/augment-compatibility.json"),
      resolve(process.cwd(), "../../runtime/data/augment-compatibility.json")
    ].find((candidate) => existsSync(candidate)) || resolve(process.cwd(), "runtime/data/augment-compatibility.json");
    const data = JSON.parse(readFileSync(path, "utf8"));
    const namedItems = new Map();
    for (const [name, tags] of Object.entries(data.methodItems || {})) {
      if (Array.isArray(tags)) namedItems.set(normalizeAugmentName(name), tags.map(String));
    }
    augmentCompatibilityCache = { augments: data.augments || {}, namedItems };
  } catch {
    augmentCompatibilityCache = { augments: {}, namedItems: new Map() };
  }
  return augmentCompatibilityCache;
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
  const journeyAliases = journeyTagsData?.journey_aliases || {};
  const contractTags = journeyTagsData?.contract_tags || {};
  const contractAliases = journeyTagsData?.contract_aliases || {};
  const taggedNodeIds = Object.keys(tagMap).sort((a, b) => a.localeCompare(b));
  const discovered = await db.query(`
    select story_node_id
    from dune.journey_story_node
    where story_node_id not like 'DA_Dunipedia_%'
    group by story_node_id
    order by story_node_id`);
  const discoveredNodeIds = discovered.rows.map((row) => String(row.story_node_id || "")).filter(Boolean);
  const catalogNodeIds = Object.keys(journeyAliases);
  const knownNodeIds = [...new Set([...catalogNodeIds, ...taggedNodeIds, ...discoveredNodeIds])]
    .sort((a, b) => compareJourneyCatalogOrder(a, b, journeyTagsData));
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

  const storyRows = knownNodeIds.filter((nodeId) => journeyGroup(nodeId) === "story").map((nodeId) => journeyNodeRow(nodeId, "Story", state, tagMap, knownNodeIds, journeyAliases));
  const journeyContractRows = knownNodeIds.filter((nodeId) => journeyGroup(nodeId) === "contract").map((nodeId) => journeyNodeRow(nodeId, "Contract", state, tagMap, knownNodeIds, journeyAliases));
  const contractRows = [
    ...journeyContractRows,
    ...contractNodeIds.map((nodeId) => contractNodeRow(String(nodeId), contractTags, contractAliases, tagState))
  ].sort((a, b) => a.rawName.localeCompare(b.rawName));
  const codexIds = codex.rows.map((row) => row.story_node_id).filter(Boolean);
  const codexRows = codexIds.map((nodeId) => journeyNodeRow(nodeId, "Codex", state, {}, codexIds, journeyAliases));
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
    const completionNodeIds = journeyCompletionNodeIds(safeNodeId, journeyTagsData);
    const updated = await tx.query(`
      update dune.journey_story_node
      set complete_condition_state = 'true'::jsonb,
          reveal_condition_state = 'true'::jsonb
      where ${journeyIdColumn} = $1
        and (story_node_id = any($2::text[]) or story_node_id = $3 or story_node_id like $3 || '.%')`, [journeyIdentityId, completionNodeIds, safeNodeId]);
    let updatedRows = Number(updated.rowCount || 0);
    const inserted = await tx.query(`
      with wanted(story_node_id) as (
        select unnest($2::text[])
      )
      insert into dune.journey_story_node
        (${journeyIdColumn}, story_node_id, has_pending_reward, complete_condition_state, reveal_condition_state, fail_condition_state, metadata_state, reset_group)
      select $1, wanted.story_node_id, false, 'true'::jsonb, 'true'::jsonb, '{}'::jsonb, '{}'::jsonb, 'Default'::dune.JourneyStoryResetGroup
      from wanted
      where not exists (
        select 1
        from dune.journey_story_node existing
        where existing.${journeyIdColumn} = $1
          and existing.story_node_id = wanted.story_node_id
      )`, [journeyIdentityId, completionNodeIds]);
    updatedRows += Number(inserted.rowCount || 0);
    if (updatedRows === 0) {
      const fallback = await tx.query(`
        insert into dune.journey_story_node
          (${journeyIdColumn}, story_node_id, has_pending_reward, complete_condition_state, reveal_condition_state, fail_condition_state, metadata_state, reset_group)
        values ($1, $2, false, 'true'::jsonb, 'true'::jsonb, '{}'::jsonb, '{}'::jsonb, 'Default'::dune.JourneyStoryResetGroup)`, [journeyIdentityId, safeNodeId]);
      updatedRows = Number(fallback.rowCount || 1);
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

export async function updateInventoryItem(db, playerId, itemId, values) {
  await requireCapability(await supportsInventoryEdit(db), "Inventory edit requires dune.items and dune.inventories.");
  const safeItemId = intParam(itemId, "item id", 1);
  const nextValues = Object.fromEntries(Object.entries(values || {}).filter(([key]) => INVENTORY_EDITABLE_COLUMNS.has(key)));
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, playerId);
    const owned = await tx.query(`
      select i.id, i.stats
      from dune.items i
      join dune.inventories inv on inv.id = i.inventory_id
      where i.id = $1 and inv.actor_id = $2
      for update`, [safeItemId, player.actorId]);
    if (!owned.rows[0]) throw new Error("Inventory item was not found in the selected player's directly-owned inventory");

    const hasMax = Object.prototype.hasOwnProperty.call(nextValues, "max_durability") && nextValues.max_durability !== null && nextValues.max_durability !== "";
    const hasCurrent = Object.prototype.hasOwnProperty.call(nextValues, "current_durability") && nextValues.current_durability !== null && nextValues.current_durability !== "";
    if (hasMax || hasCurrent) {
      const stats = owned.rows[0].stats || {};
      const durability = { ...(stats.FItemStackAndDurabilityStats?.[1] || {}) };
      const maxKey = Object.prototype.hasOwnProperty.call(durability, "MaxDurability") ? "MaxDurability" : "DecayedMaxDurability";
      const nextMax = numberParam(hasMax ? nextValues.max_durability : durability[maxKey], "max durability", 0, 100);
      const nextCurrent = numberParam(hasCurrent ? nextValues.current_durability : durability.CurrentDurability, "current durability", 0, nextMax);
      durability.CurrentDurability = nextCurrent;
      durability[maxKey] = nextMax;
      nextValues.stats = { ...stats, FItemStackAndDurabilityStats: [stats.FItemStackAndDurabilityStats?.[0] || [], durability] };
    }
    delete nextValues.current_durability;
    delete nextValues.max_durability;

    const rowId = JSON.stringify({ pk: { id: safeItemId } });
    return updateTableRow(tx, "dune", "items", rowId, nextValues);
  });
}

function validateAugmentIds(augments) {
  if (!Array.isArray(augments)) return [];
  const ids = augments.filter(Boolean).slice(0, 20).map((id) => validateTemplateId(id));
  return ids;
}

function isStandaloneAugmentTemplate(templateId) {
  const id = String(templateId || "");
  return Boolean(augmentCompatibilityCatalog().augments[id]) || /^T\d+_Augment_/i.test(id);
}

function normalizeStandaloneAugmentQuality(templateId, qualityLevel) {
  return isStandaloneAugmentTemplate(templateId) && qualityLevel < 1 ? 1 : qualityLevel;
}

function augmentRollPayloadFromStats(stats) {
  const augmentStats = stats?.FAugmentItemStats;
  if (!Array.isArray(augmentStats) || !augmentStats[1] || typeof augmentStats[1] !== "object") return null;
  const payload = augmentStats[1];
  return perfectAugmentRollPayload(payload);
}

function augmentRollCount(augmentId = "") {
  const entry = augmentCompatibilityCatalog().augments[String(augmentId || "")];
  const explicit = Number(entry?.rollCount ?? entry?.statRollCount);
  if (Number.isFinite(explicit) && explicit > 0) return Math.trunc(explicit);
  const gradeEffects = entry?.gradeEffects && typeof entry.gradeEffects === "object" ? Object.values(entry.gradeEffects) : [];
  const effectCounts = gradeEffects
    .filter(Array.isArray)
    .map((effects) => effects.length)
    .filter((count) => count > 0);
  if (effectCounts.length > 0) return Math.max(...effectCounts);
  if (typeof entry?.effectSummary === "string" && entry.effectSummary.trim()) {
    return Math.max(1, entry.effectSummary.split(";").map((part) => part.trim()).filter(Boolean).length);
  }
  return 1;
}

function perfectAugmentRollPayload(payload = {}, augmentId = "") {
  const rollCount = Array.isArray(payload.StatRolls) && payload.StatRolls.length > 0 ? payload.StatRolls.length : augmentRollCount(augmentId);
  return {
    StatRolls: Array.from({ length: rollCount }, () => 1),
    AppliedEffectIndices: Array.isArray(payload.AppliedEffectIndices) ? payload.AppliedEffectIndices : []
  };
}

function augmentItemText(templateId) {
  const metadata = adminItemMetadata().get(String(templateId || "")) || {};
  return [
    templateId,
    metadata.name,
    metadata.category,
    metadata.source
  ].filter(Boolean).join(" ").toLowerCase();
}

function normalizeAugmentName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function augmentTemplateMetadata(templateId) {
  return adminItemMetadata().get(String(templateId || "")) || {};
}

function augmentItemKindForTemplate(templateId) {
  const metadata = augmentTemplateMetadata(templateId);
  const category = String(metadata.category || "").toLowerCase();
  const source = String(metadata.source || "").toLowerCase();
  const text = augmentItemText(templateId);
  if (category === "schematics" || source === "schematics" || /_schematic$/i.test(String(templateId || "")) || /schematic/i.test(text)) return "schematic";
  if (
    category === "clothing" ||
    source === "clothing" ||
    /social|castoffs|garment|helmet|boots|gloves|stillsuit|still_suit|suit|top|bottom|shirt|pants|robe|cloak|hood|wearable|clothing|armor|chest|guard/i.test(text)
  ) return "clothing";
  if (
    category === "weapons" ||
    source === "weapons" ||
    /weapon|lasgun|lg\b|choamlg|spitdart|jabal|dmr|rifle|longrifle|logrifle|karpov|battle.?rifle|hark.?ar|unique.?ar|\bar\d*|br\d*|disruptor|smg|lmg|vulcan|atre.?lmg|drillshot|shotgun|scattergun|grda|pyrocket|fireball|flamethrower|rocket|missile|pistol|snubnose|rafiq|maula|sda|choamsda|uniquesda|melee|sword|blade|knife|dirk|rapier|kindjal|minotaur|dualblades|crysknife|dewreaper|ghola|hook/i.test(text)
  ) return "weapon";
  return "other";
}

function inferredAugmentItemTags(templateId) {
  const metadata = augmentTemplateMetadata(templateId);
  const namedTags = augmentCompatibilityCatalog().namedItems.get(normalizeAugmentName(metadata.name));
  if (namedTags?.length) return namedTags;
  return [];
}

function augmentTagsMatch(itemTags, augmentTags) {
  return augmentTags.some((augmentTag) => itemTags.some((itemTag) => itemTag === augmentTag || itemTag.startsWith(`${augmentTag}.`)));
}

function augmentAllowedForTemplate(templateId, augmentId) {
  const entry = augmentCompatibilityCatalog().augments[String(augmentId || "")];
  const augmentTags = Array.isArray(entry?.tags) ? entry.tags.map(String) : [];
  if (augmentTags.length === 0) return false;
  const itemTags = inferredAugmentItemTags(templateId);
  return itemTags.length > 0 && augmentTagsMatch(itemTags, augmentTags);
}

function validateAugmentsForTemplate(templateId, augmentIds) {
  if (!augmentIds.length) return;
  const kind = augmentItemKindForTemplate(templateId);
  if (kind !== "clothing" && kind !== "weapon") {
    throw new Error(`Cannot apply augments to ${templateId}. Only clothing and weapons support augments.`);
  }
  const maxAugments = kind === "clothing" ? 2 : 3;
  if (augmentIds.length > maxAugments) throw new Error(`${templateId} supports up to ${maxAugments} augment(s).`);
  const invalid = augmentIds.filter((id) => !augmentAllowedForTemplate(templateId, id));
  if (invalid.length > 0) {
    throw new Error(`Cannot apply ${invalid.join(", ")} to ${templateId}. Select augment(s) that match this ${kind}.`);
  }
}

function augmentSlotKeystoneIdsForTemplate(templateId) {
  const kind = augmentItemKindForTemplate(templateId);
  if (kind === "clothing") return [42, 43];
  if (kind !== "weapon") return [];

  const tags = inferredAugmentItemTags(templateId);
  const isMelee = tags.some((tag) => /MeleeWeapons/i.test(tag));
  const isRanged = tags.some((tag) => /RangedWeapons/i.test(tag));
  if (isMelee && !isRanged) return [44, 45, 46];
  if (isRanged && !isMelee) return [47, 48, 49];
  return [44, 45, 46, 47, 48, 49];
}

async function ensureAugmentSlotKeystones(tx, player, templateId, augmentIds = []) {
  if (!augmentIds.length) return { supported: true, insertedRows: 0, keystoneIds: [] };
  if (!(await tableExists(tx, "purchased_specialization_keystones")) || !(await tableExists(tx, "specialization_keystones_map"))) {
    return { supported: false, insertedRows: 0, keystoneIds: [] };
  }

  const keystoneIds = augmentSlotKeystoneIdsForTemplate(templateId);
  if (!keystoneIds.length) return { supported: true, insertedRows: 0, keystoneIds: [] };

  if (await tableExists(tx, "specialization_tracks")) {
    await withKnownLiveRefresh(tx, () => tx.query(`
      insert into dune.specialization_tracks (player_id, track_type, xp_amount, level)
      values ($1::bigint, 'Crafting'::dune.specializationtracktype, 3100, 19.338913)
      on conflict (player_id, track_type) do update
      set xp_amount = greatest(dune.specialization_tracks.xp_amount, excluded.xp_amount),
          level = greatest(dune.specialization_tracks.level, excluded.level)`, [player.controllerId]), { features: ["specialization"] });
  }

  const result = await withKnownLiveRefresh(tx, () => tx.query(`
    insert into dune.purchased_specialization_keystones (player_id, keystone_id)
    select $1::bigint, id
    from dune.specialization_keystones_map
    where id = any($2::bigint[])
    on conflict do nothing`, [player.controllerId, keystoneIds]), { features: ["keystones"] });
  return { supported: true, insertedRows: result.rowCount || 0, keystoneIds };
}

function normalizeAugmentQuality(value) {
  return intParam(value ?? 1, "augment grade", 1, 5);
}

function augmentRollScore(rowTemplateId, sourceTemplateId, rollPayload) {
  const rolls = Array.isArray(rollPayload?.StatRolls) ? rollPayload.StatRolls.map(Number) : [];
  const hasSpecificRoll = rolls.length > 1 || rolls.some((value) => value !== 1);
  return (sourceTemplateId && rowTemplateId === sourceTemplateId ? 100 : 0) + (hasSpecificRoll ? 10 : 0);
}

async function loadAugmentRollPayloads(tx, augmentIds = [], qualityOverride = null, { sourceTemplateId = "", excludeItemId = 0 } = {}) {
  const uniqueIds = [...new Set(augmentIds)];
  if (uniqueIds.length === 0) return new Map();
  const overrideQuality = qualityOverride === null || qualityOverride === undefined ? null : normalizeAugmentQuality(qualityOverride);
  const scoredPayloads = new Map();
  const rows = await tx.query(`
    select distinct on (template_id) template_id, quality_level, stats
    from dune.items
    where template_id = any($1::text[])
      and stats ? 'FAugmentItemStats'
    order by template_id, id desc`, [uniqueIds]);
  const payloads = new Map();
  for (const row of rows.rows) {
    const payload = augmentRollPayloadFromStats(row.stats);
    if (payload) {
      payloads.set(row.template_id, { quality: overrideQuality ?? Number(row.quality_level ?? 1), rollData: payload });
      scoredPayloads.set(row.template_id, 0);
    }
  }
  const missingAfterStandalone = uniqueIds.filter((id) => !payloads.has(id));
  const patterns = uniqueIds.map((id) => `%${id}%`);
  if (patterns.length > 0) {
    const augmentedRows = await tx.query(`
      select id, template_id, stats
      from dune.items
      where stats ? 'FAugmentedItemStats'
        and stats::text like any($1::text[])
        and ($2::bigint = 0 or id <> $2::bigint)
      order by
        case when template_id = $3 then 0 else 1 end,
        id desc
      limit 200`, [patterns, Number(excludeItemId || 0), sourceTemplateId || ""]);
    for (const row of augmentedRows.rows) {
      const payload = row.stats?.FAugmentedItemStats?.[1];
      const applied = Array.isArray(payload?.AppliedAugments) ? payload.AppliedAugments : [];
      const rollData = Array.isArray(payload?.AppliedAugmentRollData) ? payload.AppliedAugmentRollData : [];
      const qualities = Array.isArray(payload?.AppliedAugmentQualities) ? payload.AppliedAugmentQualities : [];
      for (let index = 0; index < applied.length; index += 1) {
        const appliedId = typeof applied[index] === "string" ? applied[index] : applied[index]?.Name;
        if (!uniqueIds.includes(appliedId)) continue;
        const rollPayload = perfectAugmentRollPayload(rollData[index] || {}, appliedId);
        const score = augmentRollScore(row.template_id, sourceTemplateId, rollPayload);
        if (!payloads.has(appliedId) || score > (scoredPayloads.get(appliedId) ?? -1)) {
          payloads.set(appliedId, { quality: overrideQuality ?? Number(qualities[index] ?? 1), rollData: rollPayload });
          scoredPayloads.set(appliedId, score);
        }
      }
    }
  }
  for (const id of uniqueIds) {
    if (!payloads.has(id)) payloads.set(id, { quality: overrideQuality ?? 1, rollData: perfectAugmentRollPayload({}, id) });
  }
  return payloads;
}

function buildAugmentedItemStats(augmentIds = [], rollPayloads = new Map()) {
  const missing = augmentIds.filter((id) => !rollPayloads.has(id));
  if (missing.length > 0) {
    throw new Error(`Cannot build augment payloads for: ${missing.join(", ")}.`);
  }
  return [
    [],
    {
      AppliedAugments: augmentIds.map((id) => ({ Name: id })),
      AppliedAugmentQualities: augmentIds.map((id) => rollPayloads.get(id).quality),
      AppliedAugmentRollData: augmentIds.map((id) => rollPayloads.get(id).rollData)
    }
  ];
}

function normalizeDurabilityStats(durabilityStats, fallback = {}) {
  const existing = Array.isArray(durabilityStats) ? durabilityStats : [[], {}];
  const first = Array.isArray(existing[0]) ? existing[0] : [];
  const durability = existing[1] && typeof existing[1] === "object" && !Array.isArray(existing[1])
    ? { ...existing[1] }
    : {};
  if (Object.keys(durability).length > 0) return [first, durability];

  const max = Number(fallback.max ?? fallback.current ?? 100);
  const current = Number(fallback.current ?? max);
  return [first, {
    CurrentDurability: current,
    MaxDurability: max,
    DecayedMaxDurability: max
  }];
}

function normalizeAugmentableBaseStats(templateId, stats = {}, durability = {}) {
  const kind = augmentItemKindForTemplate(templateId);
  if (kind !== "clothing" && kind !== "weapon") return stats || {};
  const next = { ...(stats || {}) };
  next.FCustomizationStats = removeLegacyAugmentsFromCustomization(next.FCustomizationStats);
  next.FItemStackAndDurabilityStats = normalizeDurabilityStats(next.FItemStackAndDurabilityStats, durability);
  if (kind === "weapon" && !Array.isArray(next.FWeaponItemStats)) {
    next.FWeaponItemStats = [[], { CurrentAmmo: 0 }];
  }
  return next;
}

function removeLegacyAugmentsFromCustomization(customizationStats) {
  const existingCustomization = Array.isArray(customizationStats) ? customizationStats : [[], {}];
  const first = Array.isArray(existingCustomization[0]) ? existingCustomization[0] : [];
  const cleanedFirst = first.filter((value) => !(typeof value === "string" && /^T\d+_Augment_/i.test(value)));
  return [cleanedFirst, existingCustomization[1] || {}];
}

function buildItemStats({ templateId = "", augments = [], durability = {}, rollPayloads = new Map() } = {}) {
  const durabilityObj = durability.max !== undefined
    ? { CurrentDurability: Number(durability.current ?? durability.max), MaxDurability: Number(durability.max), DecayedMaxDurability: Number(durability.max) }
    : {};
  const stats = normalizeAugmentableBaseStats(templateId, {
    FCustomizationStats: [[], {}],
    FItemStackAndDurabilityStats: [[], durabilityObj]
  }, durability);
  if (augments.length > 0) stats.FAugmentedItemStats = buildAugmentedItemStats(augments, rollPayloads);
  return stats;
}

function currentEpochSeconds() {
  return Math.floor(Date.now() / 1000);
}

function itemInsertShape(baseColumns, baseValues, itemColumns) {
  const columns = [...baseColumns];
  const values = [...baseValues];
  if (itemColumns.has("is_new")) {
    columns.push("is_new");
    values.push(false);
  }
  if (itemColumns.has("acquisition_time")) {
    columns.push("acquisition_time");
    values.push(currentEpochSeconds());
  }
  return { columns, values };
}

function extractAugmentIdsFromStats(stats) {
  const found = [];
  const visit = (value) => {
    if (!value) return;
    if (typeof value === "string") {
      if (/^T\d+_Augment_/i.test(value)) found.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(stats?.FAugmentedItemStats);
  visit(stats?.FCustomizationStats);
  return [...new Set(found)];
}

export async function augmentInventoryItem(db, playerId, itemId, { augments = [], augmentQuality = 1 } = {}) {
  await requireCapability(await supportsInventoryEdit(db), "Augment inventory item requires dune.items and dune.inventories.");
  const safeItemId = intParam(itemId, "item id", 1);
  const augmentIds = validateAugmentIds(augments);
  const augmentQualityLevel = normalizeAugmentQuality(augmentQuality);
  if (augmentIds.length === 0) throw new Error("At least one augment ID is required");
  return db.transaction(async (tx) => {
    const itemColumns = await columnsFor(tx, "items");
    const metadataSelect = [
      itemColumns.has("is_new") ? "i.is_new" : "null::boolean as is_new",
      itemColumns.has("acquisition_time") ? "i.acquisition_time" : "null::bigint as acquisition_time"
    ].join(", ");
    const player = await resolvePlayerMutationTarget(tx, playerId);
    requireOfflinePlayer(player, "Apply augments");
    const owned = await tx.query(`
      select i.id, i.stats, i.template_id, ${metadataSelect}
      from dune.items i
      join dune.inventories inv on inv.id = i.inventory_id
      where i.id = $1 and inv.actor_id = $2
      for update`, [safeItemId, player.actorId]);
    if (!owned.rows[0]) throw new Error("Inventory item was not found in the selected player's directly-owned inventory");
    const existing = owned.rows[0].stats || {};
    const existingAugments = extractAugmentIdsFromStats(existing);
    const nextAugments = [...new Set(augmentIds)].slice(0, 20);
    validateAugmentsForTemplate(owned.rows[0].template_id, nextAugments);
    const slotUnlocks = await ensureAugmentSlotKeystones(tx, player, owned.rows[0].template_id, nextAugments);
    const rollPayloads = await loadAugmentRollPayloads(tx, nextAugments, augmentQualityLevel, { sourceTemplateId: owned.rows[0].template_id, excludeItemId: safeItemId });
    const nextStats = {
      ...normalizeAugmentableBaseStats(owned.rows[0].template_id, existing),
      FAugmentedItemStats: buildAugmentedItemStats(nextAugments, rollPayloads)
    };
    const setClauses = ["stats = $1::jsonb"];
    const values = [JSON.stringify(nextStats)];
    if (itemColumns.has("is_new")) {
      values.push(false);
      setClauses.push(`is_new = $${values.length}`);
    }
    if (itemColumns.has("acquisition_time") && Number(owned.rows[0].acquisition_time || 0) <= 0) {
      values.push(currentEpochSeconds());
      setClauses.push(`acquisition_time = $${values.length}`);
    }
    values.push(safeItemId);
    await tx.query(`update dune.items set ${setClauses.join(", ")} where id = $${values.length}`, values);
    return { ok: true, itemId: safeItemId, templateId: owned.rows[0].template_id, augments: nextAugments, augmentQuality: augmentQualityLevel, previous: existingAugments, slotUnlocks };
  });
}

export async function playerInventoryItemIds(db, playerId, templateId) {
  const target = intParam(playerId, "player id", 1);
  const resolvedTemplate = validateTemplateId(templateId);
  const result = await db.query(`
    select i.id::bigint as id
    from dune.items i
    join dune.inventories inv on inv.id = i.inventory_id
    where inv.actor_id = $1
      and i.template_id = $2`, [target, resolvedTemplate]);
  return result.rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id));
}

export async function maxPlayerInventoryItemId(db, playerId, templateId) {
  const ids = await playerInventoryItemIds(db, playerId, templateId);
  return ids.length > 0 ? Math.max(...ids) : 0;
}

export async function augmentNewestPlayerItem(db, playerId, templateId, { afterItemId = 0, existingItemIds = [], augments = [], augmentQuality = 1 } = {}) {
  const target = intParam(playerId, "player id", 1);
  const resolvedTemplate = validateTemplateId(templateId);
  const safeAfterItemId = intParam(afterItemId || 0, "after item id", 0);
  const knownItemIds = Array.isArray(existingItemIds)
    ? [...new Set(existingItemIds.map((id) => intParam(id, "existing item id", 1)))]
    : [];
  const augmentIds = validateAugmentIds(augments);
  if (augmentIds.length === 0) throw new Error("At least one augment ID is required");
  const augmentQualityLevel = normalizeAugmentQuality(augmentQuality);
  validateAugmentsForTemplate(resolvedTemplate, augmentIds);
  return db.transaction(async (tx) => {
    const itemColumns = await columnsFor(tx, "items");
    const found = await tx.query(`
      select i.id, i.stats, i.template_id
      from dune.items i
      join dune.inventories inv on inv.id = i.inventory_id
      where inv.actor_id = $1
        and i.template_id = $2
        and (
          coalesce(array_length($3::bigint[], 1), 0) = 0
          or not (i.id = any($3::bigint[]))
        )
        and (
          coalesce(array_length($3::bigint[], 1), 0) > 0
          or i.id > $4
        )
      order by i.id desc
      limit 1
      for update`, [target, resolvedTemplate, knownItemIds, safeAfterItemId]);
    const item = found.rows[0];
    if (!item) throw new Error(`${resolvedTemplate} was granted live, but the new inventory row was not found yet`);
    const owner = await tx.query(`
      select coalesce(player_controller_id, $1::bigint) as controller_id
      from dune.player_state
      where player_pawn_id = $1::bigint or id = $1::bigint
      limit 1`, [target]);
    const player = { actorId: target, controllerId: Number(owner.rows[0]?.controller_id || target) };
    const slotUnlocks = await ensureAugmentSlotKeystones(tx, player, resolvedTemplate, augmentIds);
    const rollPayloads = await loadAugmentRollPayloads(tx, augmentIds, augmentQualityLevel, { sourceTemplateId: resolvedTemplate, excludeItemId: Number(item.id) });
    const nextStats = {
      ...normalizeAugmentableBaseStats(resolvedTemplate, item.stats || {}, { current: 100, max: 100 }),
      FAugmentedItemStats: buildAugmentedItemStats(augmentIds, rollPayloads)
    };
    const setClauses = ["stats = $1::jsonb"];
    const values = [JSON.stringify(nextStats)];
    if (itemColumns.has("is_new")) {
      values.push(false);
      setClauses.push(`is_new = $${values.length}`);
    }
    values.push(item.id);
    await tx.query(`update dune.items set ${setClauses.join(", ")} where id = $${values.length}`, values);
    return { ok: true, itemId: Number(item.id), templateId: resolvedTemplate, augments: augmentIds, augmentQuality: augmentQualityLevel, slotUnlocks };
  });
}

export async function playerItemAugmentState(db, playerId, itemId, expectedAugments = []) {
  const target = intParam(playerId, "player id", 1);
  const safeItemId = intParam(itemId, "item id", 1);
  const expected = validateAugmentIds(expectedAugments);
  const result = await db.query(`
    select i.id, i.template_id, i.stats
    from dune.items i
    join dune.inventories inv on inv.id = i.inventory_id
    where i.id = $1 and inv.actor_id = $2
    limit 1`, [safeItemId, target]);
  const item = result.rows[0];
  if (!item) return { ok: false, itemId: safeItemId, reason: "missing" };
  const stats = item.stats || {};
  const applied = extractAugmentIdsFromStats(stats);
  const missingAugments = expected.filter((id) => !applied.includes(id));
  const kind = augmentItemKindForTemplate(item.template_id);
  const missingBaseStats = kind === "weapon" && !Array.isArray(stats.FWeaponItemStats);
  const durabilityStats = Array.isArray(stats.FItemStackAndDurabilityStats) ? stats.FItemStackAndDurabilityStats[1] : null;
  const missingDurability = (kind === "weapon" || kind === "clothing") && (
    !durabilityStats ||
    typeof durabilityStats !== "object" ||
    (
      durabilityStats.CurrentDurability === undefined &&
      durabilityStats.MaxDurability === undefined &&
      durabilityStats.DecayedMaxDurability === undefined
    )
  );
  return {
    ok: missingAugments.length === 0 && !missingBaseStats && !missingDurability,
    itemId: Number(item.id),
    templateId: item.template_id,
    appliedAugments: applied,
    missingAugments,
    missingBaseStats,
    missingDurability,
    kind
  };
}

export async function giveItemToStorage(db, storageId, { itemName = "", itemId = "", templateId = "", quantity = 1, quality = 0, augments = [], augmentQuality = 1 }) {
  await requireCapability(await supportsStorageGiveItem(db), "Storage give-item requires compatible dune.inventories and dune.items insert columns.");
  const target = intParam(storageId, "storage id", 1);
  const resolvedTemplate = validateTemplateId(templateId || itemId || itemName);
  const stackSize = intParam(quantity, "quantity", 1, 1000000);
  const qualityLevel = normalizeStandaloneAugmentQuality(resolvedTemplate, intParam(quality, "quality", 0, 1000000));
  const augmentIds = validateAugmentIds(augments);
  const augmentQualityLevel = normalizeAugmentQuality(augmentQuality);
  validateAugmentsForTemplate(resolvedTemplate, augmentIds);
  return db.transaction(async (tx) => {
    const itemColumns = await columnsFor(tx, "items");
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
    const rollPayloads = await loadAugmentRollPayloads(tx, augmentIds, augmentQualityLevel, { sourceTemplateId: resolvedTemplate });
    const stats = buildItemStats({ templateId: resolvedTemplate, augments: augmentIds, rollPayloads });
    const insert = itemInsertShape(
      ["inventory_id", "template_id", "stack_size", "quality_level", "position_index", "stats"],
      [inventory.id, resolvedTemplate, stackSize, qualityLevel, Number(position.rows[0]?.position_index || 0), JSON.stringify(stats)],
      itemColumns
    );
    const inserted = await tx.query(`
      insert into dune.items (${insert.columns.join(", ")})
      values (${insert.values.map((_, index) => index === 5 ? `$${index + 1}::jsonb` : `$${index + 1}`).join(", ")})
      returning id, template_id, stack_size, quality_level, position_index, inventory_id`, insert.values);
    return { ok: true, storage: inventory, inserted: inserted.rows[0], augments: augmentIds.length > 0 ? augmentIds : undefined };
  });
}

export async function giveItemToPlayer(db, playerId, { itemName = "", itemId = "", templateId = "", quantity = 1, quality = 1, augments = [], augmentQuality = 1, allowOnlinePreAugmented = false }) {
  await requireCapability(await supportsPlayerGiveItem(db), "Player give-item requires compatible dune.inventories and dune.items insert columns.");
  const target = intParam(playerId, "player id", 1);
  const resolvedTemplate = validateTemplateId(templateId || itemId || itemName);
  const stackSize = intParam(quantity, "quantity", 1, 1000000);
  const qualityLevel = normalizeStandaloneAugmentQuality(resolvedTemplate, intParam(quality, "grade", 0, 5));
  const augmentIds = validateAugmentIds(augments);
  const augmentQualityLevel = normalizeAugmentQuality(augmentQuality);
  validateAugmentsForTemplate(resolvedTemplate, augmentIds);
  return db.transaction(async (tx) => {
    const itemColumns = await columnsFor(tx, "items");
    const player = await resolvePlayerMutationTarget(tx, target);
    const playerOnline = String(player.onlineStatus || "").toLowerCase() === "online";
    if (augmentIds.length > 0 && !allowOnlinePreAugmented) requireOfflinePlayer(player, "Pre-augmented item grants");
    const inventory = await tx.query(`
      select id, actor_id, coalesce(max_item_count, 0)::int as max_item_count, coalesce(max_item_volume, 0)::int as max_item_volume
      from dune.inventories
      where actor_id = $1 and inventory_type = 0
      order by id
      limit 1
      for update`, [player.actorId]);
    const fallbackInventory = inventory.rows[0] ? inventory : await tx.query(`
      select id, actor_id, coalesce(max_item_count, 0)::int as max_item_count, coalesce(max_item_volume, 0)::int as max_item_volume
      from dune.inventories
      where actor_id = $1
      order by id
      limit 1
      for update`, [player.actorId]);
    if (!fallbackInventory.rows[0]) throw new Error("Player inventory was not found");
    const inv = fallbackInventory.rows[0];
    const count = await tx.query("select count(*)::int as count from dune.items where inventory_id = $1", [inv.id]);
    const currentCount = Number(count.rows[0]?.count || 0);
    if (inv.max_item_count > 0 && currentCount >= inv.max_item_count) throw new Error("Player inventory is full by item slot count");
    const position = await tx.query("select coalesce(max(position_index), -1)::int + 1 as position_index from dune.items where inventory_id = $1", [inv.id]);
    const slotUnlocks = await ensureAugmentSlotKeystones(tx, player, resolvedTemplate, augmentIds);
    const rollPayloads = await loadAugmentRollPayloads(tx, augmentIds, augmentQualityLevel, { sourceTemplateId: resolvedTemplate });
    const stats = buildItemStats({ templateId: resolvedTemplate, augments: augmentIds, durability: { current: 100, max: 100 }, rollPayloads });
    const insert = itemInsertShape(
      ["inventory_id", "template_id", "stack_size", "quality_level", "position_index", "stats"],
      [inv.id, resolvedTemplate, stackSize, qualityLevel, Number(position.rows[0]?.position_index || 0), JSON.stringify(stats)],
      itemColumns
    );
    const inserted = await tx.query(`
      insert into dune.items (${insert.columns.join(", ")})
      values (${insert.values.map((_, index) => index === 5 ? `$${index + 1}::jsonb` : `$${index + 1}`).join(", ")})
      returning id, template_id, stack_size, quality_level, position_index, inventory_id`, insert.values);
    const augmentNote = augmentIds.length > 0 ? ` with ${augmentIds.length} augment(s) pre-applied` : "";
    return {
      ok: true,
      playerId: player.actorId,
      inserted: inserted.rows[0],
      augments: augmentIds.length > 0 ? augmentIds : undefined,
      augmentQuality: augmentIds.length > 0 ? augmentQualityLevel : undefined,
      slotUnlocks,
      requiresRelog: playerOnline,
      message: `${resolvedTemplate} was added at Grade ${qualityLevel}${augmentNote}.${playerOnline ? " Relog required for item or augments to appear correctly." : " The player will see the database edit on next login."}`
    };
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

export async function repairVehicleDecay(db, id, { thresholdPercent = 50 } = {}) {
  await requireCapability(await supportsRepairVehicleDecay(db), "Repair vehicle decay requires dune.vehicle_modules.stats, dune.vehicle_modules.vehicle_id, and dune.actors.owner_account_id.");
  const threshold = Number(thresholdPercent);
  if (!Number.isFinite(threshold) || threshold < 1 || threshold > 100) throw new Error("Vehicle repair threshold must be between 1 and 100 percent");
  const thresholdRatio = threshold / 100;
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    if (String(player.onlineStatus).toLowerCase() === "online") throw new Error("Repair vehicle decay requires the player to be offline so live state cannot overwrite the DB change");
    const scanned = await tx.query(`
      select count(*)::int as scanned,
             count(distinct vm.vehicle_id)::int as vehicles
      from dune.vehicle_modules vm
      join dune.actors a on a.id = vm.vehicle_id
      where a.owner_account_id = $1
        and vm.stats is not null
        and jsonb_typeof(vm.stats->'FVehicleModuleDurabilityStats') = 'array'
        and jsonb_array_length(vm.stats->'FVehicleModuleDurabilityStats') >= 2
        and (vm.stats->'FVehicleModuleDurabilityStats'->1) ? 'MaxDurability'
        and (vm.stats->'FVehicleModuleDurabilityStats'->1) ? 'DecayedMaxDurability'`, [player.accountId]);
    const repaired = await tx.query(`
      with eligible as (
        select vm.id,
               vm.vehicle_id,
               (durability->>'MaxDurability')::numeric as max_durability
        from dune.vehicle_modules vm
        join dune.actors a on a.id = vm.vehicle_id
        cross join lateral (
          select vm.stats->'FVehicleModuleDurabilityStats'->1 as durability
        ) d
        where a.owner_account_id = $1
          and vm.stats is not null
          and jsonb_typeof(vm.stats->'FVehicleModuleDurabilityStats') = 'array'
          and jsonb_array_length(vm.stats->'FVehicleModuleDurabilityStats') >= 2
          and durability ? 'MaxDurability'
          and durability ? 'DecayedMaxDurability'
          and (durability->>'MaxDurability') ~ '^-?[0-9]+(\\.[0-9]+)?$'
          and (durability->>'DecayedMaxDurability') ~ '^-?[0-9]+(\\.[0-9]+)?$'
          and (durability->>'MaxDurability')::numeric > 0
          and (durability->>'DecayedMaxDurability')::numeric < ((durability->>'MaxDurability')::numeric * $2)
      )
      update dune.vehicle_modules vm
      set stats = jsonb_set(
        jsonb_set(
          vm.stats,
          '{FVehicleModuleDurabilityStats,1,CurrentDurability}',
          to_jsonb(eligible.max_durability)
        ),
        '{FVehicleModuleDurabilityStats,1,DecayedMaxDurability}',
        to_jsonb(eligible.max_durability)
      )
      from eligible
      where vm.id = eligible.id
      returning vm.id, vm.vehicle_id`, [player.accountId, thresholdRatio]);
    const repairedVehicles = new Set(repaired.rows.map((row) => String(row.vehicle_id))).size;
    return {
      ok: true,
      player,
      thresholdPercent: threshold,
      scanned: Number(scanned.rows[0]?.scanned || 0),
      vehicles: Number(scanned.rows[0]?.vehicles || 0),
      repaired: repaired.rows.length,
      repairedVehicles
    };
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
    inventoryEdit: await supportsInventoryEdit(db),
    repairGear: await supportsRepairGear(db),
    repairVehicleDecay: await supportsRepairVehicleDecay(db),
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

function journeyNodeRow(nodeId, category, state, tagMap, allNodeIds, journeyAliases = {}) {
  const nodeState = state.get(nodeId) || {};
  return {
    id: nodeId,
    name: journeyDisplayName(nodeId, journeyAliases),
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
  const catalogHasRecipe = craftingRecipeCatalog().some((row) => row.recipeId === recipeId);
  if (!catalogHasRecipe) {
    const known = await db.query(`
      select exists (
        select 1
        from dune.actors a
        cross join lateral jsonb_array_elements(coalesce(a.properties->'CraftingRecipesLibraryActorComponent'->'m_KnownItemRecipes', '[]'::jsonb)) recipe
        where recipe->'BaseRecipeId'->>'Name' = $1
      ) as exists`, [recipeId]);
    if (!known.rows[0]?.exists) return false;
  }
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

async function supportsInventoryEdit(db) {
  return await tableExists(db, "items") && await tableExists(db, "inventories");
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

async function supportsRepairVehicleDecay(db) {
  if (!(await tableExists(db, "vehicle_modules")) || !(await tableExists(db, "actors"))) return false;
  const moduleColumns = await columnsFor(db, "vehicle_modules");
  const actorColumns = await columnsFor(db, "actors");
  return ["id", "vehicle_id", "stats"].every((column) => moduleColumns.has(column)) &&
    ["id", "owner_account_id"].every((column) => actorColumns.has(column));
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

async function offlineTeleportPlayerExists(db, playerId) {
  const result = await db.query(`
    select exists (
      select 1
      from dune.accounts ac
      join dune.player_state ps on ps.account_id = ac.id
      join dune.actors a on a.id = ps.player_pawn_id
      where ac."user" = $1
      limit 1
    ) as exists`, [playerId]);
  return Boolean(result.rows[0]?.exists);
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

function emptyAddonOpsHealthPlayers() {
  return {
    total: 0,
    onlineStatus: {},
    lifeState: {},
    characterState: {},
    combinations: []
  };
}

function emptyAddonOpsHealthFarms() {
  return {
    total: 0,
    ready: 0,
    alive: 0,
    connectedPlayers: 0,
    incomingS2SConnections: 0,
    outgoingS2SConnections: 0
  };
}

function addCount(target, key, count) {
  target[String(key || "Unknown")] = (target[String(key || "Unknown")] || 0) + count;
}

export async function addonOpsHealthPlayers(db) {
  if (!(await tableExists(db, "player_state"))) return emptyAddonOpsHealthPlayers();

  const columns = await columnsFor(db, "player_state");
  const required = ["online_status", "life_state", "character_state"];
  if (!required.every((column) => columns.has(column))) return emptyAddonOpsHealthPlayers();

  const result = await db.query(`
    select coalesce(online_status::text, 'Unknown') as online_status,
           coalesce(life_state::text, 'Unknown') as life_state,
           coalesce(character_state::text, 'Unknown') as character_state,
           count(*)::int as players
    from dune.player_state
    group by 1, 2, 3
    order by 1, 2, 3`);

  const out = emptyAddonOpsHealthPlayers();
  for (const row of result.rows || []) {
    const players = Number(row.players || 0);
    const onlineStatus = String(row.online_status || "Unknown");
    const lifeState = String(row.life_state || "Unknown");
    const characterState = String(row.character_state || "Unknown");

    out.total += players;
    addCount(out.onlineStatus, onlineStatus, players);
    addCount(out.lifeState, lifeState, players);
    addCount(out.characterState, characterState, players);
    out.combinations.push({ onlineStatus, lifeState, characterState, players });
  }

  return out;
}

export async function addonOpsHealthFarms(db) {
  if (!(await tableExists(db, "farm_state"))) return emptyAddonOpsHealthFarms();

  const columns = await columnsFor(db, "farm_state");
  const boolCount = (column) => columns.has(column)
    ? `sum(case when coalesce(${quoteIdentifier(column)}, false) then 1 else 0 end)::int`
    : "0::int";
  const intSum = (column) => columns.has(column)
    ? `coalesce(sum(coalesce(${quoteIdentifier(column)}, 0)), 0)::int`
    : "0::int";

  const result = await db.query(`
    select count(*)::int as total,
           ${boolCount("ready")} as ready,
           ${boolCount("alive")} as alive,
           ${intSum("connected_players")} as connected_players,
           ${intSum("incoming_s2s_connections")} as incoming_s2s_connections,
           ${intSum("outgoing_s2s_connections")} as outgoing_s2s_connections
    from dune.farm_state`);

  const row = result.rows?.[0] || {};
  return {
    total: Number(row.total || 0),
    ready: Number(row.ready || 0),
    alive: Number(row.alive || 0),
    connectedPlayers: Number(row.connected_players || 0),
    incomingS2SConnections: Number(row.incoming_s2s_connections || 0),
    outgoingS2SConnections: Number(row.outgoing_s2s_connections || 0)
  };
}

export async function addonOpsHealthSummaryV2(db) {
  const [players, farms] = await Promise.all([
    addonOpsHealthPlayers(db),
    addonOpsHealthFarms(db)
  ]);

  return { players, farms };
}

export async function addonOpsHealthSummary(db) {
  return addonOpsHealthSummaryV2(db);
}

export async function addonOpsActivitySummary(db) {
  const exists = await tableExists(db, "player_state");
  if (!exists) return emptyActivitySummary();

  const columns = await columnsFor(db, "player_state");
  const hasLoginTime = columns.has("last_login_time");
  const hasActivity = columns.has("last_avatar_activity");
  const hasReturning = columns.has("last_returning_player_event_time");
  const hasTransfer = columns.has("transfer_count");

  const now = "now()";
  const constraints = [];

  if (hasActivity) {
    constraints.push(
      `count(*) filter (where last_avatar_activity > ${now} - interval '1 hour')::int as active_last_1h`,
      `count(*) filter (where last_avatar_activity > ${now} - interval '24 hours')::int as active_last_24h`,
      `count(*) filter (where last_avatar_activity > ${now} - interval '7 days')::int as active_last_7d`,
      `count(*) filter (where last_avatar_activity < ${now} - interval '30 days')::int as inactive_players`
    );
  } else {
    constraints.push("0::int as active_last_1h", "0::int as active_last_24h", "0::int as active_last_7d", "0::int as inactive_players");
  }

  if (hasReturning) {
    constraints.push(`count(*) filter (where last_returning_player_event_time > ${now} - interval '7 days')::int as returning_players`);
  } else {
    constraints.push("0::int as returning_players");
  }

  if (hasTransfer) {
    constraints.push("count(*) filter (where transfer_count = 0)::int as new_players");
  } else if (hasLoginTime) {
    constraints.push(`count(*) filter (where last_login_time > ${now} - interval '7 days')::int as new_players`);
  } else {
    constraints.push("0::int as new_players");
  }

  const result = await db.query(`
    select count(*)::int as total_players,
           count(*) filter (where online_status = 'Online')::int as online_players,
           count(*) filter (where life_state::text <> 'Alive')::int as players_dead,
           ${constraints.join(",\n           ")}
    from dune.player_state`);

  const r = result.rows?.[0] || {};

  let guildActivity = [];
  try {
    const guildsExist = await tableExists(db, "guilds");
    const membersExist = await tableExists(db, "guild_members");
    if (guildsExist && membersExist) {
      const memberCols = await columnsFor(db, "guild_members");
      const guildCols = await columnsFor(db, "guilds");
      const playerCol = firstExistingColumn(memberCols, ["player_id", "player_controller_id", "account_id"]);
      const memberGuildCol = firstExistingColumn(memberCols, ["guild_id", "id"]);
      const guildIdCol = firstExistingColumn(guildCols, ["guild_id", "id"]);
      const guildNameCol = firstExistingColumn(guildCols, ["guild_name", "name", "display_name"]);
      if (playerCol && memberGuildCol && guildIdCol && guildNameCol) {
        const guildResult = await db.query(`
          select coalesce(g.${quoteIdentifier(guildNameCol)}, 'Unknown') as guild,
                 count(gm.*)::int as members,
                 count(ps.*) filter (where ps.online_status = 'Online')::int as online
          from dune.guilds g
          left join dune.guild_members gm on gm.${quoteIdentifier(memberGuildCol)} = g.${quoteIdentifier(guildIdCol)}
          left join dune.player_state ps on ps.player_controller_id::text = gm.${quoteIdentifier(playerCol)}::text
          group by g.${quoteIdentifier(guildNameCol)}
          order by members desc
          limit 20`);
        guildActivity = guildResult.rows || [];
      }
    }
  } catch { }

  let factionActivity = [];
  try {
    const factionExists = await tableExists(db, "player_faction");
    if (factionExists) {
      const factionCols = await columnsFor(db, "player_faction");
      const factionsExist = await tableExists(db, "factions");
      const actorCol = firstExistingColumn(factionCols, ["actor_id", "player_id", "player_controller_id"]);
      const factionIdCol = firstExistingColumn(factionCols, ["faction_id", "faction"]);
      if (actorCol && factionIdCol) {
        const factionResult = await db.query(`
          select coalesce(f.name, pf.${quoteIdentifier(factionIdCol)}::text, 'Unknown') as faction,
                 count(*)::int as members,
                 count(*) filter (where ps.online_status = 'Online')::int as online
          from dune.player_faction pf
          join dune.player_state ps on ps.player_pawn_id::text = pf.${quoteIdentifier(actorCol)}::text
          ${factionsExist ? "left join dune.factions f on f.id::text = pf." + quoteIdentifier(factionIdCol) + "::text" : ""}
          group by f.name, pf.${quoteIdentifier(factionIdCol)}
          order by members desc
          limit 20`);
        factionActivity = factionResult.rows || [];
      }
    }
  } catch { }

  let mapActivity = [];
  try {
    const mapsExist = await tableExists(db, "map_names");
    const playerMapTable = await tableExists(db, "overmap_players");
    if (mapsExist) {
      const mapCols = await columnsFor(db, "map_names");
      const mapIdCol = firstExistingColumn(mapCols, ["map_name_id", "id"]);
      const mapNameCol = firstExistingColumn(mapCols, ["map_name", "name"]);
      if (mapIdCol && mapNameCol) {
        const mapResult = await db.query(`
          select coalesce(mn.${quoteIdentifier(mapNameCol)}, 'Unknown') as map,
                 ${playerMapTable
                    ? `count(op.*)::int as actors,
                       count(op.*) filter (where op.is_online)::int as online
                       from dune.map_names mn
                       left join dune.overmap_players op on op.map_name_id = mn.${quoteIdentifier(mapIdCol)}
                       group by mn.${quoteIdentifier(mapNameCol)}`
                    : `0::int as actors, 0::int as online
                       from dune.map_names mn
                       group by mn.${quoteIdentifier(mapNameCol)}`}
          order by actors desc
          limit 20`);
        mapActivity = mapResult.rows || [];
      }
    }
  } catch { }

  return {
    totalPlayers: Number(r.total_players || 0),
    onlinePlayers: Number(r.online_players || 0),
    activeLast1h: r.active_last_1h != null ? Number(r.active_last_1h) : null,
    activeLast24h: r.active_last_24h != null ? Number(r.active_last_24h) : null,
    activeLast7d: r.active_last_7d != null ? Number(r.active_last_7d) : null,
    inactivePlayers: r.inactive_players != null ? Number(r.inactive_players) : null,
    returningPlayers: r.returning_players != null ? Number(r.returning_players) : null,
    newPlayers: r.new_players != null ? Number(r.new_players) : null,
    playersDead: Number(r.players_dead || 0),
    guildActivity,
    factionActivity,
    mapActivity
  };
}

function emptyActivitySummary() {
  return {
    totalPlayers: 0, onlinePlayers: 0,
    activeLast1h: 0, activeLast24h: 0, activeLast7d: 0,
    inactivePlayers: 0, returningPlayers: 0, newPlayers: 0,
    playersDead: 0,
    guildActivity: [], factionActivity: [], mapActivity: []
  };
}

export async function addonOpsResourcesSummary(db) {
  if (!(await tableExists(db, "resourcefield_state"))) return emptyResourcesSummary();

  const result = await db.query(`
    select count(*)::int as total_fields,
           coalesce(sum(value_remaining), 0)::bigint as total_value
    from dune.resourcefield_state
    where field_kind_id = 1`);

  const r = result.rows?.[0] || {};

  let resourcesByMap = [];
  try {
      const mapResult = await db.query(`
        select map,
               count(*)::int as fields,
               coalesce(sum(value_remaining), 0)::bigint as total_value
        from dune.resourcefield_state
        where field_kind_id = 1
        group by map
        order by fields desc`);
    resourcesByMap = mapResult.rows || [];
  } catch { }

  let spiceFieldsBySize = [];
  try {
    const spiceExists = await tableExists(db, "spicefield_types");
    if (spiceExists) {
      const spiceResult = await db.query(`
        select sft.field_type as size,
               sft.map_name as map,
               coalesce(sum(sft.current_globally_active), 0)::int as currently_active,
               coalesce(sum(sft.max_globally_active), 0)::int as max_active,
               (select coalesce(sum(value_remaining), 0)::bigint
                from dune.resourcefield_state rfs
                where rfs.map = sft.map_name and rfs.field_kind_id = 1) as total_value,
               (select count(*)::int
                from dune.resourcefield_state rfs
                where rfs.map = sft.map_name and rfs.field_kind_id = 1) as active_fields
        from dune.spicefield_types sft
        where sft.is_spawning_active = true
        group by sft.field_type, sft.map_name
        order by sft.map_name, sft.field_type`);
      spiceFieldsBySize = spiceResult.rows || [];
    }
  } catch { }

  return {
    totalFields: Number(r.total_fields || 0),
    totalValueRemaining: Number(r.total_value || 0),
    resourcesByMap,
    spiceFieldsBySize
  };
}

function emptyResourcesSummary() {
  return { totalFields: 0, totalValueRemaining: 0, resourcesByMap: [], spiceFieldsBySize: [] };
}

export async function addonOpsCombatDeaths(db) {
  const exists = await tableExists(db, "player_death_log");
  if (!exists) return emptyCombatDeaths();

  const result = await db.query(`
    select count(*)::int as total_deaths,
           count(*) filter (where death_cause = 'Dead')::int as unknown_deaths,
           count(*) filter (where death_cause = 'DeadByCoriolis')::int as coriolis_deaths,
           count(*) filter (where death_cause = 'DeadBySandworm')::int as sandworm_deaths
    from dune.player_death_log`);

  const r = result.rows?.[0] || {};
  const causes = [
    { cause: "Sandworm", count: Number(r.sandworm_deaths || 0) },
    { cause: "Coriolis", count: Number(r.coriolis_deaths || 0) },
    { cause: "Unknown", count: Number(r.unknown_deaths || 0) }
  ].filter(d => d.count > 0);

  return {
    totalDeaths: Number(r.total_deaths || 0),
    pvpDeaths: 0,
    pveDeaths: Number(r.total_deaths || 0),
    deathsByCause: causes,
    deathsByMap: [],
    topHostileNpcs: [],
    kdRatio: null
  };
}

function emptyCombatDeaths() {
  return { totalDeaths: 0, pvpDeaths: 0, pveDeaths: 0, deathsByCause: [], deathsByMap: [], topHostileNpcs: [], kdRatio: null };
}

export async function addonOpsEconomySummary(db) {
  let totalCurrencyHolders = 0;
  let totalSupply = 0;
  let currencyBreakdown = [];

  try {
    const currencyExists = await tableExists(db, "player_virtual_currency_balances");
    if (currencyExists) {
      const result = await db.query(`
        select count(distinct player_controller_id)::int as holders,
               coalesce(sum(balance), 0)::bigint as total_supply
        from dune.player_virtual_currency_balances`);
      const r = result.rows?.[0] || {};
      totalCurrencyHolders = Number(r.holders || 0);
      totalSupply = Number(r.total_supply || 0);

      const breakdown = await db.query(`
        select currency_id::text as currency_id,
               count(distinct player_controller_id)::int as holders,
               coalesce(sum(balance), 0)::bigint as supply,
               coalesce(round(avg(balance)), 0)::bigint as avg_balance,
               coalesce(min(balance), 0)::bigint as min_balance,
               coalesce(max(balance), 0)::bigint as max_balance
        from dune.player_virtual_currency_balances
        group by currency_id
        order by supply desc`);
      currencyBreakdown = breakdown.rows || [];
    }
  } catch { }

  let activeOrders = 0;
  let fulfilledOrders = 0;
  let topTradedItems = [];

  try {
    const ordersExist = await tableExists(db, "dune_exchange_orders");
    const fulfilledExist = await tableExists(db, "dune_exchange_fulfilled_orders");
    if (ordersExist) {
      const ordersResult = await db.query(`select count(*)::int as count from dune.dune_exchange_orders`);
      activeOrders = Number(ordersResult.rows?.[0]?.count || 0);

      const topResult = await db.query(`
        select coalesce(template_id, 'Unknown') as template_id,
               count(*)::int as orders,
               coalesce(round(avg(item_price)), 0)::bigint as avg_price,
               coalesce(min(item_price), 0)::bigint as min_price,
               coalesce(max(item_price), 0)::bigint as max_price
        from dune.dune_exchange_orders
        group by template_id
        order by orders desc
        limit 20`);
      topTradedItems = topResult.rows || [];
    }
    if (fulfilledExist) {
      const fulfilledResult = await db.query(`select count(*)::int as count from dune.dune_exchange_fulfilled_orders`);
      fulfilledOrders = Number(fulfilledResult.rows?.[0]?.count || 0);
    }
  } catch { }

  let taxCollected = 0;
  try {
    const taxExists = await tableExists(db, "tax_invoice");
    if (taxExists) {
      const taxResult = await db.query(`
        select coalesce(sum(amount), 0)::bigint as total
        from dune.tax_invoice`);
      taxCollected = Number(taxResult.rows?.[0]?.total || 0);
    }
  } catch { }

  return {
    totalCurrencyHolders,
    totalSupply,
    activeOrders,
    fulfilledOrders,
    taxCollected,
    currencyBreakdown,
    topTradedItems
  };
}

function emptyEconomySummary() {
  return { totalCurrencyHolders: 0, totalSupply: 0, activeOrders: 0, fulfilledOrders: 0, taxCollected: 0, currencyBreakdown: [], topTradedItems: [] };
}
export async function migrateDiscordAdapterSchema(db) {
  const migrate = async (tx) => {
    await tx.query(`
      create table if not exists dune.discord_player_links (
        discord_user_id text primary key,
        player_controller_id text not null,
        linked_at timestamp with time zone not null default now()
      )`);
    await tx.query("alter table dune.discord_player_links alter column linked_at set default now()");
    await tx.query("update dune.discord_player_links set linked_at = now() where linked_at is null");
    await tx.query("alter table dune.discord_player_links alter column linked_at set not null");
    await tx.query(`
      delete from dune.discord_player_links older
      using dune.discord_player_links newer
      where older.player_controller_id = newer.player_controller_id
        and (older.linked_at, older.discord_user_id) < (newer.linked_at, newer.discord_user_id)`);
    await tx.query(`
      create unique index if not exists discord_player_links_player_controller_id_uidx
      on dune.discord_player_links (player_controller_id)`);
    await tx.query(`
      create table if not exists dune.discord_pending_links (
        code text primary key,
        discord_user_id text not null,
        player_controller_id text not null,
        character_name text not null,
        created_at timestamp with time zone not null default now(),
        expires_at timestamp with time zone not null
      )`);
    await tx.query("alter table dune.discord_pending_links alter column created_at set default now()");
    await tx.query("update dune.discord_pending_links set created_at = now() where created_at is null");
    await tx.query("alter table dune.discord_pending_links alter column created_at set not null");
    await tx.query("delete from dune.discord_pending_links where expires_at <= now()");
    await tx.query(`
      delete from dune.discord_pending_links older
      using dune.discord_pending_links newer
      where older.discord_user_id = newer.discord_user_id
        and (older.created_at, older.code) < (newer.created_at, newer.code)`);
    await tx.query(`
      delete from dune.discord_pending_links older
      using dune.discord_pending_links newer
      where older.player_controller_id = newer.player_controller_id
        and (older.created_at, older.code) < (newer.created_at, newer.code)`);
    await tx.query(`
      create unique index if not exists discord_pending_links_discord_user_id_uidx
      on dune.discord_pending_links (discord_user_id)`);
    await tx.query(`
      create unique index if not exists discord_pending_links_player_controller_id_uidx
      on dune.discord_pending_links (player_controller_id)`);
  };
  if (typeof db.transaction === "function") return db.transaction(migrate);
  return migrate(db);
}

export async function resolvePlayerByName(db, characterName) {
  const result = await db.query(`
    select distinct on (ps.player_controller_id)
           ps.player_controller_id::text as player_controller_id,
           ps.character_name,
           ps.player_pawn_id::text as player_pawn_id,
           coalesce(ps.online_status::text, 'Offline') as online_status,
           coalesce(ac.funcom_id, '') as funcom_id,
           coalesce(ac."user", '') as fls_id
    from dune.player_state ps
    left join dune.accounts ac on ac.id = ps.account_id
    where lower(ps.character_name) = lower($1)
    order by ps.player_controller_id,
             case when coalesce(ps.online_status::text, '') = 'Online' then 0 else 1 end,
             ps.player_pawn_id desc`, [String(characterName).trim()]);
  return result.rows;
}

export async function getLinkedPlayer(db, discordUserId) {
  const result = await db.query(`
    select dpl.discord_user_id,
           dpl.player_controller_id,
           coalesce(ps.character_name, '') as character_name,
           coalesce(ps.player_pawn_id::text, '0') as player_pawn_id,
           coalesce(ps.online_status::text, 'Offline') as online_status
    from dune.discord_player_links dpl
    join dune.player_state ps on ps.player_controller_id::text = dpl.player_controller_id
    where dpl.discord_user_id = $1
    limit 1`, [String(discordUserId)]);
  return result.rows[0] || null;
}

export async function discordPlayerLink(db, discordUserId, playerControllerId) {
  const link = async (tx) => {
    const conflict = await tx.query(`
      select discord_user_id
      from dune.discord_player_links
      where player_controller_id = $1
        and discord_user_id <> $2
      for update`, [playerControllerId, String(discordUserId)]);
    if (conflict.rowCount) {
      return { conflict: true };
    }
    await tx.query(`
      insert into dune.discord_player_links (discord_user_id, player_controller_id)
      values ($1, $2)
      on conflict (discord_user_id) do update
        set player_controller_id = excluded.player_controller_id,
            linked_at = now()`, [String(discordUserId), playerControllerId]);
    return { conflict: false, player: await getLinkedPlayer(tx, discordUserId) };
  };
  const result = typeof db.transaction === "function" ? await db.transaction(link) : await link(db);
  if (result.conflict) {
    const error = new Error("This character is already linked to another Discord account.");
    error.code = "character_already_linked";
    error.statusCode = 409;
    throw error;
  }
  return result.player;
}

export async function discordPlayerUnlink(db, discordUserId) {
  const player = await getLinkedPlayer(db, discordUserId);
  await db.query("delete from dune.discord_player_links where discord_user_id = $1", [String(discordUserId)]);
  return Boolean(player);
}

export async function playerOwnedStorageQuery(db, playerControllerId) {
  const result = await db.query(`
    select p.id,
           coalesce(max(case when pa.actor_name not like '##%' and pa.actor_name <> 'None' then pa.actor_name end), p.building_type) as name,
           p.building_type as class,
           coalesce(a.map, '') as map,
           count(i.id)::int as item_count
    from dune.placeables p
    left join dune.actors a on a.id = p.id
    left join dune.inventories inv on inv.actor_id = p.id
    left join dune.items i on i.inventory_id = inv.id
    left join dune.actor_fgl_entities afe on afe.entity_id = p.owner_entity_id
    left join dune.permission_actor_rank par on par.permission_actor_id = afe.actor_id
    left join dune.permission_actor pa on pa.actor_id = par.permission_actor_id
    where par.player_id = $1
      and par.rank = 1
      and p.is_hologram = false
      and p.owner_entity_id is not null
      and p.owner_entity_id != 0
    group by p.id, p.building_type, a.map
    order by p.id`, [playerControllerId]);
  return { rows: result.rows };
}

export async function guildStorageQuery(db, playerControllerId) {
  const result = await db.query(`
    select p.id,
           coalesce(max(case when pa.actor_name not like '##%' and pa.actor_name <> 'None' then pa.actor_name end), p.building_type) as name,
           p.building_type as class,
           coalesce(a.map, '') as map,
           count(i.id)::int as item_count
    from dune.placeables p
    left join dune.actors a on a.id = p.id
    left join dune.inventories inv on inv.actor_id = p.id
    left join dune.items i on i.inventory_id = inv.id
    left join dune.actor_fgl_entities afe on afe.entity_id = p.owner_entity_id
    left join dune.permission_actor_rank par on par.permission_actor_id = afe.actor_id
    left join dune.guild_members gm on gm.player_id = par.player_id
    left join dune.guild_members self_gm on self_gm.player_id = $1
    left join dune.permission_actor pa on pa.actor_id = par.permission_actor_id
    where gm.guild_id = self_gm.guild_id
      and p.is_hologram = false
      and p.owner_entity_id is not null
      and p.owner_entity_id != 0
    group by p.id, p.building_type, a.map
    order by p.id`, [playerControllerId]);
  return { rows: result.rows };
}

export async function searchItemsInContainers(db, { playerControllerId, query, scope = "owned" }) {
  const searchTerm = `%${String(query).trim()}%`;

  if (scope === "owned") {
    const result = await db.query(`
      select i.id,
             i.template_id,
             i.stack_size,
             i.quality_level,
             i.inventory_id,
             inv.actor_id as container_id,
             coalesce(
               nullif((i.stats->'FItemStackAndDurabilityStats'->1->>'CurrentDurability'), null),
               null
             ) as current_durability,
             coalesce(
               nullif((i.stats->'FItemStackAndDurabilityStats'->1->>'MaxDurability')::numeric, 0),
               nullif((i.stats->'FItemStackAndDurabilityStats'->1->>'DecayedMaxDurability')::numeric, 0),
               null
             ) as max_durability
      from dune.items i
      join dune.inventories inv on i.inventory_id = inv.id
      join dune.placeables p on p.id = inv.actor_id
      left join dune.actor_fgl_entities afe on afe.entity_id = p.owner_entity_id
      left join dune.permission_actor_rank par on par.permission_actor_id = afe.actor_id
      where par.player_id = $1
        and par.rank = 1
        and i.template_id ilike $2
      order by i.template_id
      limit 200`, [playerControllerId, searchTerm]);
    return { rows: result.rows };
  }

  if (scope === "guild") {
    const result = await db.query(`
      select distinct i.id,
             i.template_id,
             i.stack_size,
             i.quality_level,
             i.inventory_id,
             inv.actor_id as container_id,
             coalesce(
               nullif((i.stats->'FItemStackAndDurabilityStats'->1->>'CurrentDurability'), null),
               null
             ) as current_durability,
             coalesce(
               nullif((i.stats->'FItemStackAndDurabilityStats'->1->>'MaxDurability')::numeric, 0),
               nullif((i.stats->'FItemStackAndDurabilityStats'->1->>'DecayedMaxDurability')::numeric, 0),
               null
             ) as max_durability
      from dune.items i
      join dune.inventories inv on i.inventory_id = inv.id
      join dune.placeables p on p.id = inv.actor_id
      left join dune.actor_fgl_entities afe on afe.entity_id = p.owner_entity_id
      left join dune.permission_actor_rank par on par.permission_actor_id = afe.actor_id
      left join dune.guild_members gm on gm.player_id = par.player_id
      left join dune.guild_members self_gm on self_gm.player_id = $1
      where gm.guild_id = self_gm.guild_id
        and i.template_id ilike $2
      order by i.template_id
      limit 200`, [playerControllerId, searchTerm]);
    return { rows: result.rows };
  }

  throw new Error(`Unsupported search scope: ${scope}. Use "owned" or "guild".`);
}

export async function searchItemsInPlayerInventory(db, playerPawnId, query) {
  const searchTerm = `%${String(query).trim()}%`;
  const result = await db.query(`
    select i.id,
           i.template_id,
           i.stack_size,
           i.quality_level,
           i.position_index,
           i.inventory_id,
           coalesce(
             nullif((i.stats->'FItemStackAndDurabilityStats'->1->>'CurrentDurability'), null),
             null
           ) as current_durability,
           coalesce(
             nullif((i.stats->'FItemStackAndDurabilityStats'->1->>'MaxDurability')::numeric, 0),
             nullif((i.stats->'FItemStackAndDurabilityStats'->1->>'DecayedMaxDurability')::numeric, 0),
             null
           ) as max_durability
    from dune.items i
    join dune.inventories inv on i.inventory_id = inv.id
    where inv.actor_id = $1
      and i.template_id ilike $2
    order by i.template_id
    limit 200`, [intParam(playerPawnId, "player pawn id", 1), searchTerm]);
  return { rows: result.rows };
}

export async function createPendingLink(db, discordUserId, playerControllerId, characterName, code, expiresAt) {
  const create = async (tx) => {
    await tx.query(`
      delete from dune.discord_pending_links
      where discord_user_id = $1`, [String(discordUserId)]);
    const result = await tx.query(`
      insert into dune.discord_pending_links (code, discord_user_id, player_controller_id, character_name, expires_at)
      values ($1, $2, $3, $4, $5)
      on conflict (code) do nothing`, [code, String(discordUserId), playerControllerId, characterName, expiresAt]);
    return result.rowCount === 1;
  };
  if (typeof db.transaction === "function") return db.transaction(create);
  return create(db);
}

export async function deletePendingLink(db, discordUserId, code) {
  const result = await db.query(`
    delete from dune.discord_pending_links
    where discord_user_id = $1 and code = $2`, [String(discordUserId), code]);
  return result.rowCount || 0;
}

export async function consumePendingLink(db, discordUserId, code) {
  const result = await db.query(`
    delete from dune.discord_pending_links
    where code = $1
      and discord_user_id = $2
      and expires_at > now()
    returning discord_user_id, player_controller_id, character_name`, [code, String(discordUserId)]);
  return result.rows[0] || null;
}

export async function cleanupExpiredPendingLinks(db) {
  const result = await db.query("delete from dune.discord_pending_links where expires_at <= now()");
  return result.rowCount;
}
