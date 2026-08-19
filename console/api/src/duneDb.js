import { assertIdentifier, bigintParam, intParam, isReadOnlySql, quoteIdentifier, quoteQualified, rowsResult } from "./db.js";
import { getBridgeRequestSummary } from "./audit.js";
import { resolvePorts } from "./config.js";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { redact } from "./redact.js";
import { itemImagePath } from "./adminCatalog.js";
import { clampInt, writeJsonAtomic } from "./jsonStore.js";
import { isFiefClaimPlaceable } from "./blueprintSafety.js";
import { CARE_PACKAGE_SERVER_PERSONA, FUNCOM_GM_PERSONA, MESSAGE_OF_THE_DAY_PERSONA } from "./systemPersonas.js";
import {
  craftingRecipeCatalogRows,
  compareJourneyCatalogOrder,
  factionIdByName,
  factionProgressionRankLimit,
  factionProgressionRepairPlan,
  factionReputationEstimatedRank,
  factionTierBumps,
  factionDisplayName,
  journeyDepth,
  journeyDisplayName,
  journeyParentId,
  tagsForJourneyNodeSubtree,
  recipeCategory,
  recipeDisplayName,
  repairTarget,
  researchCategory,
  researchDisplayName,
  researchProductGroup,
  researchRecipeId,
  researchType,
  tutorialStatus,
  validateMapName,
  validateRecipeId,
  validateResearchKey,
  validateTemplateId,
  specializationXpToLevel,
  xpToLevel
} from "./duneDb/presentation.js";

const MAX_INTEL_POINTS = 2779;
const VITALITY_HEALTH_TIERS = [
  { level: 6, bonus: 15 },
  { level: 26, bonus: 5 },
  { level: 56, bonus: 5 },
  { level: 77, bonus: 25 },
  { level: 91, bonus: 5 }
];
const BASE_MAX_HEALTH = 150;
const BASE_MAX_HYDRATION = 100;
const BASE_MAX_ADDICTION = 10;
const FIND_FREMEN_JOURNEY_ROOT = "DA_MQ_FindTheFremen";
const FIND_FREMEN_REWARD_TAG = "Journey.RewardsUnblocked";
const JOURNEY_RECIPE_REWARDS = new Map([
  ["DA_MQ_FindTheFremen.FirstTest.FirstQuestion.CompleteFirstTest", "RCP_LeakyStillsuit_Top_Recipe"],
  ["DA_MQ_FindTheFremen.SecondTest.SecondQuestion.CompleteSecondTest", "RCP_ChoamStaticCompactorRecipe"],
  ["DA_MQ_FindTheFremen.FourthTest.FourthQuestion.CompleteFourthTest", "RCP_Crysknife_Recipe"],
  ["DA_MQ_FindTheFremen.FifthTest.FifthQuestion.CompleteFifthTest", "RCP_T4_Structure_Thumper1_Recipe"],
  ["DA_MQ_FindTheFremen.SeventhTest.SeventhQuestion.CompleteSeventhTest", "RCP_StilltentRecipe"]
]);

function maxHealthForCombatLevel(combatLevel) {
  return VITALITY_HEALTH_TIERS.reduce((total, tier) => (combatLevel >= tier.level ? total + tier.bonus : total), BASE_MAX_HEALTH);
}
const MAX_TABLE_PREVIEW_ROWS = 10000;
const INVENTORY_EDITABLE_COLUMNS = new Set(["stack_size", "quality_level", "position_index", "current_durability"]);
let craftingRecipeCatalogCache = null;
let adminItemMetadataCache = null;
let mapRegionNamesCache = null;
let augmentCompatibilityCache = null;
const PLAYER_TARGET_CACHE_TTL_MS = 3000;
const playerTargetCache = new Map(); // id -> { promise, expiresAt }

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
  const host = String(db.config?.host || "");
  const loopbackOnly = ["127.0.0.1", "::1", "localhost"].includes(host.toLowerCase());
  return {
    connected: true,
    config: db.config,
    server: result.rows[0],
    duneTableCount: tables.rows[0]?.count ?? 0,
    usesDefaultPassword: process.env.DUNE_DB_PASSWORD ? process.env.DUNE_DB_PASSWORD === "dune" : true,
    sshTunnelAccess: {
      available: loopbackOnly && Number.isInteger(Number(db.config?.port)),
      loopbackOnly,
      host: loopbackOnly ? host : "",
      port: loopbackOnly ? Number(db.config.port) : null,
      database: String(db.config?.database || result.rows[0]?.current_database || "dune"),
      user: String(db.config?.user || result.rows[0]?.current_user || "dune")
    }
  };
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

export async function listRoutines(db, schema = "dune", search = "") {
  assertIdentifier(schema, "schema");
  const term = String(search || "").trim();
  if (term.length > 120) throw new Error("Routine search is too long");
  const result = await db.query(`
    select p.oid::bigint::text as oid,
           n.nspname as schema,
           p.proname as name,
           case p.prokind when 'p' then 'procedure' else 'function' end as kind,
           pg_get_function_identity_arguments(p.oid) as arguments,
           case when p.prokind = 'p' then null else pg_get_function_result(p.oid) end as result_type,
           l.lanname as language,
           pg_get_userbyid(p.proowner) as owner,
           coalesce(obj_description(p.oid, 'pg_proc'), '') as description
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_language l on l.oid = p.prolang
    where n.nspname = $1
      and p.prokind in ('f', 'p')
      and ($2 = '' or p.proname ilike '%' || $2 || '%' or pg_get_function_identity_arguments(p.oid) ilike '%' || $2 || '%')
    order by p.proname, pg_get_function_identity_arguments(p.oid)
    limit 500`, [schema, term]);
  return result.rows;
}

export async function routineDefinition(db, oid) {
  const safeOid = intParam(oid, "routine oid", 1, 4294967295);
  const result = await db.query(`
    select p.oid::bigint::text as oid,
           n.nspname as schema,
           p.proname as name,
           case p.prokind when 'p' then 'procedure' else 'function' end as kind,
           pg_get_function_identity_arguments(p.oid) as arguments,
           pg_get_functiondef(p.oid) as definition
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.oid = $1::oid and p.prokind in ('f', 'p')`, [safeOid]);
  if (!result.rows[0]) throw new Error("Routine not found");
  return result.rows[0];
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

export async function applyLandsraadMilestonePreset(db, values = {}) {
  await requireCapability(await tableExists(db, "landsraad_tasks"), "Landsraad milestone presets require dune.landsraad_tasks.");
  await requireCapability(await tableExists(db, "landsraad_task_rewards"), "Landsraad milestone presets require dune.landsraad_task_rewards.");
  if (typeof db.transaction !== "function") throw new Error("Landsraad milestone presets require rollback-safe transaction support.");

  const goalAmount = intParam(values.goalAmount, "Landsraad goal amount", 0, 2147483647);
  const thresholds = normalizeLandsraadThresholds(values.thresholds);
  const termResult = await db.query(`
    select term_id::text as term_id
    from dune.landsraad_decree_term
    order by term_id desc
    limit 1`);
  const termId = termResult.rows[0]?.term_id;
  if (!termId) return { ok: true, applied: false, reason: "No current Landsraad term is available yet." };

  const readiness = await landsraadMilestoneReadiness(db, termId, thresholds.length);
  if (!readiness.ready) return { ok: true, applied: false, termId, ...readiness };

  return db.transaction(async (tx) => {
    const currentTerm = await tx.query(`
      select term_id::text as term_id
      from dune.landsraad_decree_term
      order by term_id desc
      limit 1
      for update`);
    if (currentTerm.rows[0]?.term_id !== termId) {
      return { ok: true, applied: false, termId: currentTerm.rows[0]?.term_id || null, reason: "The Landsraad term changed while the preset was being applied." };
    }

    const currentReadiness = await landsraadMilestoneReadiness(tx, termId, thresholds.length);
    if (!currentReadiness.ready) return { ok: true, applied: false, termId, ...currentReadiness };

    const maximumResult = await tx.query(`
      select coalesce(max(r.threshold), 0)::bigint as maximum
      from dune.landsraad_task_rewards r
      join dune.landsraad_tasks t on t.id = r.task_id
      where t.term_id = $1`, [termId]);
    const maximum = Math.max(Number(maximumResult.rows[0]?.maximum || 0), ...thresholds);
    const temporaryBase = maximum + 1;
    if (!Number.isSafeInteger(temporaryBase) || temporaryBase + thresholds.length > 2147483647) {
      throw new Error("Current Landsraad thresholds are too large to update safely.");
    }

    const goals = await tx.query(`
      update dune.landsraad_tasks
         set goal_amount = $1
       where term_id = $2`, [goalAmount, termId]);
    const staged = await tx.query(`
      with ranked as (
        select r.ctid as row_locator,
               row_number() over (partition by r.task_id order by r.threshold, r.ctid)::int as tier
        from dune.landsraad_task_rewards r
        join dune.landsraad_tasks t on t.id = r.task_id
        where t.term_id = $1
      )
      update dune.landsraad_task_rewards r
         set threshold = $2 + ranked.tier
        from ranked
       where r.ctid = ranked.row_locator`, [termId, temporaryBase]);

    let rewardsUpdated = 0;
    for (let index = 0; index < thresholds.length; index += 1) {
      const updated = await tx.query(`
        update dune.landsraad_task_rewards r
           set threshold = $1
          from dune.landsraad_tasks t
         where t.id = r.task_id
           and t.term_id = $2
           and r.threshold = $3`, [thresholds[index], termId, temporaryBase + index + 1]);
      rewardsUpdated += updated.rowCount || 0;
    }

    if ((staged.rowCount || 0) !== rewardsUpdated) {
      throw new Error("Not every Landsraad reward milestone could be updated safely.");
    }
    return {
      ok: true,
      applied: true,
      termId,
      goalAmount,
      thresholds,
      tasksUpdated: goals.rowCount || 0,
      rewardsUpdated
    };
  });
}

async function landsraadMilestoneReadiness(db, termId, expectedTierCount) {
  const result = await db.query(`
    select count(*)::int as task_count,
           coalesce(min(reward_count), 0)::int as minimum_tiers,
           coalesce(max(reward_count), 0)::int as maximum_tiers
    from (
      select t.id, count(r.*)::int as reward_count
      from dune.landsraad_tasks t
      left join dune.landsraad_task_rewards r on r.task_id = t.id
      where t.term_id = $1
      group by t.id
    ) current_tasks`, [termId]);
  const row = result.rows[0] || {};
  const taskCount = Number(row.task_count || 0);
  const minimumTiers = Number(row.minimum_tiers || 0);
  const maximumTiers = Number(row.maximum_tiers || 0);
  if (!taskCount) return { ready: false, taskCount, minimumTiers, maximumTiers, reason: "The current Landsraad term has no tasks yet." };
  if (minimumTiers !== expectedTierCount || maximumTiers !== expectedTierCount) {
    return {
      ready: false,
      taskCount,
      minimumTiers,
      maximumTiers,
      reason: `The current Landsraad term has ${minimumTiers === maximumTiers ? minimumTiers : `${minimumTiers}-${maximumTiers}`} reward tiers per house; this preset contains ${expectedTierCount}.`
    };
  }
  return { ready: true, taskCount, minimumTiers, maximumTiers };
}

function normalizeLandsraadThresholds(values) {
  if (!Array.isArray(values) || !values.length || values.length > 20) {
    throw new Error("Landsraad milestone presets require between 1 and 20 reward thresholds.");
  }
  const thresholds = values.map((value, index) => intParam(value, `Landsraad reward level ${index + 1} threshold`, 1, 2147483647));
  for (let index = 1; index < thresholds.length; index += 1) {
    if (thresholds[index] <= thresholds[index - 1]) throw new Error("Landsraad reward thresholds must increase from one level to the next.");
  }
  return thresholds;
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
        and gm.role_id = ${GUILD_LEADER_ROLE_ID}`, [actorId]);
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

const PLAYER_SORT_COLUMNS = {
  character_name: { order: ["lower(coalesce(character_name, ''))"] },
  fls_id: { order: ["lower(coalesce(fls_id, ''))"] },
  online_status: { order: ["online_status"] },
  map: { order: ["lower(coalesce(map, ''))"] },
  last_seen: { order: ["last_seen"] },
  total_playtime_seconds: { order: ["total_playtime_seconds"] },
  actor_id: { order: ["actor_id"] }
};

const playerPlaytimeMigrations = new WeakMap();

export function migratePlayerPlaytimeSchema(db) {
  if (!playerPlaytimeMigrations.has(db)) {
    const migrate = async (tx) => {
      await tx.query(`
        create table if not exists dune.console_player_playtime (
          account_id bigint primary key,
          total_seconds bigint not null default 0,
          session_started_at timestamp with time zone,
          session_login_at timestamp with time zone,
          last_observed_at timestamp with time zone,
          updated_at timestamp with time zone not null default current_timestamp,
          constraint console_player_playtime_total_nonnegative check (total_seconds >= 0)
        )`);
    };
    const promise = Promise.resolve(typeof db.transaction === "function" ? db.transaction(migrate) : migrate(db))
      .catch((error) => {
        playerPlaytimeMigrations.delete(db);
        throw error;
      });
    playerPlaytimeMigrations.set(db, promise);
  }
  return playerPlaytimeMigrations.get(db);
}

// The game exposes current presence and the current session's login timestamp,
// but no lifetime counter. Keep completed seconds in a console-owned table and
// retain the active session separately so the UI can include time elapsed since
// the last poll. A session that ends while the console is down is capped at its
// last observation instead of inventing playtime during the outage.
export async function trackPlayerPlaytime(db) {
  if (!(await tableExists(db, "player_state"))) return { supported: false };
  const playerStateColumns = await columnsFor(db, "player_state");
  if (!["account_id", "online_status"].every((column) => playerStateColumns.has(column))) {
    return { supported: false };
  }
  await migratePlayerPlaytimeSchema(db);
  const sessionLoginSelect = playerStateColumns.has("last_login_time")
    ? "ps.last_login_time"
    : "null::timestamp with time zone";
  return db.query(`
    with currently_online as (
      select distinct on (ps.account_id)
             ps.account_id,
             ${sessionLoginSelect} as session_login_at
      from dune.player_state ps
      where ps.account_id is not null
        and ps.account_id <> 0
        and coalesce(ps.online_status::text, '') = 'Online'
      order by ps.account_id, ${sessionLoginSelect} desc nulls last
    ),
    closed_sessions as (
      update dune.console_player_playtime tracked
      set total_seconds = tracked.total_seconds + greatest(0, floor(extract(epoch from
            coalesce(tracked.last_observed_at, tracked.session_started_at) - tracked.session_started_at)))::bigint,
          session_started_at = null,
          session_login_at = null,
          updated_at = current_timestamp
      where tracked.session_started_at is not null
        and not exists (select 1 from currently_online online where online.account_id = tracked.account_id)
      returning tracked.account_id
    )
    insert into dune.console_player_playtime (
      account_id, total_seconds, session_started_at, session_login_at, last_observed_at, updated_at
    )
    select online.account_id,
           0,
           coalesce(online.session_login_at, current_timestamp),
           online.session_login_at,
           current_timestamp,
           current_timestamp
    from currently_online online
    on conflict (account_id) do update
    set total_seconds = dune.console_player_playtime.total_seconds +
          case
            when dune.console_player_playtime.session_started_at is not null
             and excluded.session_login_at is not null
             and dune.console_player_playtime.session_login_at is distinct from excluded.session_login_at
              then greatest(0, floor(extract(epoch from
                   coalesce(dune.console_player_playtime.last_observed_at, dune.console_player_playtime.session_started_at)
                   - dune.console_player_playtime.session_started_at)))::bigint
            else 0
          end,
        session_started_at = case
          when dune.console_player_playtime.session_started_at is not null
           and (excluded.session_login_at is null
             or dune.console_player_playtime.session_login_at is not distinct from excluded.session_login_at)
            then dune.console_player_playtime.session_started_at
          else excluded.session_started_at
        end,
        session_login_at = case
          when dune.console_player_playtime.session_started_at is not null
           and excluded.session_login_at is null
            then dune.console_player_playtime.session_login_at
          else excluded.session_login_at
        end,
        last_observed_at = current_timestamp,
        updated_at = current_timestamp`);
}

// Funcom creates this reserved GM identity in some freshly initialized
// battlegroups. It is an internal service actor, not an administrable player.
const INTERNAL_GM_PLAYER_PAWN_ID = FUNCOM_GM_PERSONA.playerPawnId;

// Stable pawn ids of every reserved non-player identity (GM, Server, Message of
// the Day). Exclude by id, not display name -- persona names may be encrypted
// or absent in the legacy player_state view, and a real player could be named
// "Server".
const SYSTEM_PERSONA_PAWN_IDS = [FUNCOM_GM_PERSONA, CARE_PACKAGE_SERVER_PERSONA, MESSAGE_OF_THE_DAY_PERSONA].map((persona) => persona.playerPawnId);

export async function listPlayers(db, { status = "all", q = "", page = 0, pageSize = 50, sortColumn = "character_name", sortDirection = "asc", includeTotals = true, bannedFlsIds = [] } = {}) {
  if (!(await tableExists(db, "actors")) || !(await tableExists(db, "player_state"))) {
    return { ...unsupported("players", ["dune.actors", "dune.player_state"]), totalCount: 0, totalPlayers: 0 };
  }
  const safePageSize = intParam(pageSize, "pageSize", 1, 200);
  const safePage = intParam(page, "page", 0);
  const offset = safePage * safePageSize;
  const safeSortColumn = Object.hasOwn(PLAYER_SORT_COLUMNS, sortColumn) ? sortColumn : "character_name";
  const safeSortDirection = String(sortDirection).toLowerCase() === "desc" ? "desc" : "asc";
  const sortOrder = PLAYER_SORT_COLUMNS[safeSortColumn].order;
  const pagedOrder = [...sortOrder, ...(sortOrder.includes("actor_id") ? [] : ["actor_id"])]
    .map((column) => `${column} ${safeSortDirection}`).join(", ");
  const playerStateColumns = await columnsFor(db, "player_state");
  const encryptedAccountColumns = await tableExists(db, "encrypted_accounts")
    ? await columnsFor(db, "encrypted_accounts")
    : new Set();
  const canReadEncryptedAccounts = ["id", "user", "encrypted_funcom_id"]
    .every((column) => encryptedAccountColumns.has(column)) &&
    await functionExists(db, "dune.decrypt_user_data(bytea)");
  const encryptedAccountsJoin = canReadEncryptedAccounts
    ? `left join dune.encrypted_accounts ea on ea.id = a.owner_account_id
       left join lateral (
         select case
           when ea.encrypted_funcom_id is null then ''
           else coalesce(dune.decrypt_user_data(ea.encrypted_funcom_id), '')
         end as funcom_id
       ) decrypted_account on true`
    : "";
  const plainFlsId = "case when trim(coalesce(ac.\"user\", '')) ~ '^[A-Fa-f0-9]{15,64}$' then trim(ac.\"user\") else '' end";
  const encryptedFlsId = canReadEncryptedAccounts
    ? "case when trim(coalesce(ea.\"user\", '')) ~ '^[A-Fa-f0-9]{15,64}$' then trim(ea.\"user\") else '' end"
    : "''";
  const resolvedFlsId = canReadEncryptedAccounts
    ? `coalesce(nullif(${plainFlsId}, ''), nullif(${encryptedFlsId}, ''), '')`
    : plainFlsId;
  const decryptedFuncomId = canReadEncryptedAccounts
    ? "coalesce(decrypted_account.funcom_id, '')"
    : "''";
  const plainFuncomId = "case when char_length(trim(coalesce(ac.funcom_id, ''))) between 1 and 180 and trim(coalesce(ac.funcom_id, '')) !~ '[[:cntrl:]]' then trim(ac.funcom_id) else '' end";
  const validDecryptedFuncomId = `case when char_length(trim(${decryptedFuncomId})) between 1 and 180 and trim(${decryptedFuncomId}) !~ '[[:cntrl:]]' then trim(${decryptedFuncomId}) else '' end`;
  const resolvedFuncomId = canReadEncryptedAccounts
    ? `coalesce(nullif(${plainFuncomId}, ''), nullif(${validDecryptedFuncomId}, ''), '')`
    : plainFuncomId;
  const lastSeenSelect = await playerLastSeenSelect(db);
  const hasOnlineStatus = playerStateColumns.has("online_status");
  const hasPlayerPlaytime = await tableExists(db, "console_player_playtime");
  const playerPlaytimeJoin = hasPlayerPlaytime
    ? "left join dune.console_player_playtime player_playtime on player_playtime.account_id = a.owner_account_id"
    : "";
  const totalPlaytimeSelect = hasPlayerPlaytime
    ? `greatest(0, coalesce(player_playtime.total_seconds, 0) +
         case when player_playtime.session_started_at is not null
           then floor(extract(epoch from
             (case when ${hasOnlineStatus ? "coalesce(ps.online_status::text, '') = 'Online'" : "false"}
               then current_timestamp
               else coalesce(player_playtime.last_observed_at, player_playtime.session_started_at)
              end) - player_playtime.session_started_at))::bigint
           else 0 end)`
    : "0::bigint";
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
      when ${hasOnlineStatus ? "coalesce(ps.online_status::text, '') = 'Online'" : "false"}
        then coalesce(nullif(${lastSeenSelect}, ''), (current_timestamp at time zone 'UTC')::text)
      else ${lastSeenSelect}
    end
  `;
  let baseWhere = "a.class ilike '%PlayerCharacter%'";
  baseWhere += ` and a.id <> ${INTERNAL_GM_PLAYER_PAWN_ID}::bigint`;
  baseWhere += ` and ${resolvedFlsId} <> 'A5C0DE5E12A00001'`;
  baseWhere += ` and ${resolvedFlsId} <> 'A5C0DE5E12A00002'`;
  baseWhere += ` and ${resolvedFuncomId} <> 'Server#0001'`;
  baseWhere += ` and ${resolvedFuncomId} <> 'MessageOfTheDay#0001'`;
  baseWhere += " and coalesce(ps.character_name, '') <> 'Server'";
  baseWhere += " and coalesce(ps.character_name, '') <> 'Message of the Day'";
  if (hasOnlineStatus) {
    baseWhere += " and not (nullif(trim(coalesce(ps.character_name, '')), '') is null and coalesce(ps.online_status::text, '') <> 'Online')";
  }
  baseWhere += currentPawnFilter;

  const normalizedBannedFlsIds = [...new Set((Array.isArray(bannedFlsIds) ? bannedFlsIds : [])
    .map((value) => String(value || "").trim().toLowerCase())
    .filter((value) => /^[a-f0-9]{15,64}$/.test(value)))]
    .slice(0, 2000);
  const values = [normalizedBannedFlsIds];
  const bannedExpression = `lower(${resolvedFlsId}) = any($1::text[])`;
  let where = baseWhere;
  if (hasOnlineStatus) {
    if (status === "online") where += ` and not (${bannedExpression}) and coalesce(ps.online_status::text, '') = 'Online'`;
    if (status === "offline") where += ` and not (${bannedExpression}) and coalesce(ps.online_status::text, '') <> 'Online'`;
  }
  if (status === "banned") where += ` and (${bannedExpression})`;
  if (q) {
    values.push(`%${q}%`);
    const fuzzySearchParameter = values.length;
    values.push(String(q));
    const exactIdParameter = values.length;
    where += ` and (ps.character_name ilike $${fuzzySearchParameter} or ${resolvedFlsId} ilike $${fuzzySearchParameter} or a.id::text = $${exactIdParameter} or a.owner_account_id::text = $${exactIdParameter})`;
  }
  values.push(safePageSize, offset);
  const limitParamIndex = values.length - 1;
  const offsetParamIndex = values.length;

  const result = await db.query(`
    with player_rows as (
      select a.id as actor_id,
             a.id as player_pawn_id,
             coalesce(a.owner_account_id, 0) as account_id,
             coalesce(ps.character_name, '') as character_name,
             coalesce(ps.player_controller_id, 0) as player_controller_id,
             ${resolvedFuncomId} as funcom_id,
             ${resolvedFlsId} as fls_id,
             case
               when nullif(${resolvedFlsId}, '') is not null then ${resolvedFlsId}
               when a.owner_account_id is not null and a.owner_account_id <> 0 then a.owner_account_id::text
               else ''
             end as action_player_id,
             a.class,
             coalesce(a.map, '') as map,
             ${hasOnlineStatus ? "coalesce(ps.online_status::text, 'Offline')" : "'Offline'"} as actual_online_status,
             case when ${bannedExpression} then 'Banned'
                  else ${hasOnlineStatus ? "coalesce(ps.online_status::text, 'Offline')" : "'Offline'"}
             end as online_status,
             (${bannedExpression}) as is_banned,
             ${loginSessionSelect} as login_session,
             ${lastSeenWithOnlineFallback} as last_seen,
             ${totalPlaytimeSelect} as total_playtime_seconds,
             coalesce(nullif(ps.player_controller_id, 0), nullif(a.owner_account_id, 0), a.id) as dedupe_key,
             case
               ${currentPawnPriority}
               when coalesce(ps.character_name, '') <> '' then 1
               else 2
             end as row_priority,
             case when ${hasOnlineStatus ? "coalesce(ps.online_status::text, '') = 'Online'" : "false"} then 0 else 1 end as online_priority
      from dune.actors a
      left join dune.player_state ps on ps.account_id = a.owner_account_id
      left join dune.accounts ac on ac.id = a.owner_account_id
      ${playerPlaytimeJoin}
      ${encryptedAccountsJoin}
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
             actual_online_status,
             online_status,
             is_banned,
             login_session,
             last_seen,
             total_playtime_seconds
      from player_rows
      order by dedupe_key, row_priority, online_priority, actor_id desc
    ),
    totals as (
      select count(*)::int as total_count
      from deduped_players
    )
    select paged.*, totals.total_count
    from totals
    left join lateral (
      select *
      from deduped_players
      order by ${pagedOrder}
      limit $${limitParamIndex} offset $${offsetParamIndex}
    ) paged on true
    order by ${pagedOrder}`, values);

  const totalsResult = includeTotals ? await db.query(`
    with player_rows as (
      select coalesce(nullif(ps.player_controller_id, 0), nullif(a.owner_account_id, 0), a.id) as dedupe_key
      from dune.actors a
      left join dune.player_state ps on ps.account_id = a.owner_account_id
      left join dune.accounts ac on ac.id = a.owner_account_id
      ${encryptedAccountsJoin}
      where ${baseWhere}
    )
    select count(distinct dedupe_key)::int as total_players
    from player_rows`) : null;

  return {
    capabilities: { players: true, status, statusFilterApplied: hasOnlineStatus, banFilterApplied: true },
    totalCount: result.rows[0] ? Number(result.rows[0].total_count) : 0,
    totalPlayers: totalsResult ? (totalsResult.rows[0] ? Number(totalsResult.rows[0].total_players) : 0) : undefined,
    rows: result.rows
      .filter((row) => row.actor_id !== null && row.actor_id !== undefined)
      .map(({ total_count, ...row }) => row)
  };
}

const LIST_ALL_PLAYERS_PAGE_SIZE = 200;

// Internal call sites (care package scans, message-of-the-day, announcements, leadership)
// need every matching player, not one UI page — loop pages instead of relying on a single
// listPlayers() call, since that now caps at LIST_ALL_PLAYERS_PAGE_SIZE per page.
export async function listAllPlayers(db, { status = "all", q = "" } = {}) {
  let page = 0;
  let rows = [];
  let first = null;
  for (;;) {
    const result = await listPlayers(db, { status, q, page, pageSize: LIST_ALL_PLAYERS_PAGE_SIZE, includeTotals: false });
    if (!first) first = result;
    if (!result?.capabilities?.players) return result;
    rows = rows.concat(result.rows || []);
    // If this page returned fewer rows than requested, we've reached the last page
    if ((result.rows || []).length < LIST_ALL_PLAYERS_PAGE_SIZE) break;
    page += 1;
  }
  return { ...first, rows };
}

// Battlegroup-wide count of real players currently online. The restart queue
// uses it to decide immediate-vs-countdown. dune.player_state is
// battlegroup-wide (one Postgres for every map), so a single aggregate covers
// the whole battlegroup. Excludes the game's own reserved identities (GM,
// Server, Message of the Day) by their stable pawn ids -- not by display name,
// which may be encrypted/absent and could collide with a real player -- so an
// idle server never looks occupied.
export async function countOnlinePlayers(db) {
  if (!(await tableExists(db, "player_state"))) return { supported: false, online: 0, total: 0 };
  const personaFilter = SYSTEM_PERSONA_PAWN_IDS.map((id) => `${id}::bigint`).join(", ");
  const result = await db.query(`
    select count(*) filter (where coalesce(online_status::text, '') = 'Online')::int as online,
           count(*)::int as total
    from dune.player_state
    where coalesce(player_pawn_id, 0) not in (${personaFilter})`);
  const r = result.rows?.[0] || {};
  return { supported: true, online: Number(r.online || 0), total: Number(r.total || 0) };
}

// Scoped online count for a single restart target (a map or sietch partition),
// so the restart queue can decide "immediate vs countdown" -- and tell the
// admin -- based on who is actually on that map, not the whole battlegroup.
// Resolves to one or more partition ids: a direct partitionId wins; otherwise
// `map` is looked up against dune.world_partition.map, which is the same
// namespace the restart machinery already uses for its targets (see
// partitionRestartTargets above) -- never dune.actors.map, which names the
// in-game region instead of the partition. Returns { supported: false } when
// neither resolves to a real partition, so callers fall back to the
// battlegroup-wide count rather than silently reporting zero.
export async function countOnlinePlayersForTarget(db, { partitionId, map } = {}) {
  if (!(await tableExists(db, "player_state")) || !(await tableExists(db, "actors"))) {
    return { supported: false, online: 0, total: 0 };
  }
  const partitionIds = await resolveRestartTargetPartitionIds(db, { partitionId, map });
  if (!partitionIds.length) return { supported: false, online: 0, total: 0 };
  const result = await db.query(`
    select count(*) filter (where coalesce(ps.online_status::text, '') = 'Online')::int as online,
           count(*)::int as total
    from dune.actors a
    join dune.player_state ps on ps.player_pawn_id = a.id
    where a.partition_id = any($1::int[])
      and a.id not in (${SYSTEM_PERSONA_PAWN_IDS.map((id) => `${id}::bigint`).join(", ")})`, [partitionIds]);
  const r = result.rows?.[0] || {};
  return { supported: true, online: Number(r.online || 0), total: Number(r.total || 0) };
}

async function resolveRestartTargetPartitionIds(db, { partitionId, map } = {}) {
  const direct = Number(partitionId);
  if (Number.isInteger(direct) && direct > 0) return [direct];
  const mapName = String(map || "").trim();
  if (!mapName || !(await tableExists(db, "world_partition"))) return [];
  const result = await db.query("select partition_id from dune.world_partition where map = $1", [mapName]);
  return result.rows
    .map((row) => Number(row.partition_id))
    .filter((id) => Number.isInteger(id) && id > 0);
}

export async function addonLeadershipPlayers(db) {
  const result = await listAllPlayers(db, {});
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
  const [guild, reputation] = await Promise.all([
    leadershipGuildFactions(db),
    leadershipReputationFactions(db)
  ]);
  const factions = new Map(current);
  for (const [actorId, faction] of guild) {
    if (!factions.has(actorId)) factions.set(actorId, faction);
  }
  for (const [actorId, faction] of reputation) {
    if (!factions.has(actorId)) factions.set(actorId, faction);
  }
  return factions;
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

async function leadershipGuildFactions(db) {
  const factions = new Map();
  if (!(await tableExists(db, "guild_members")) || !(await tableExists(db, "guilds"))) return factions;
  const memberColumns = await columnsFor(db, "guild_members");
  const guildColumns = await columnsFor(db, "guilds");
  const memberPlayerColumn = firstExistingColumn(memberColumns, ["player_id", "player_controller_id", "actor_id", "account_id", "player_pawn_id"]);
  const memberGuildColumn = firstExistingColumn(memberColumns, ["guild_id", "id"]);
  const guildIdColumn = firstExistingColumn(guildColumns, ["guild_id", "id"]);
  const guildFactionColumn = firstExistingColumn(guildColumns, ["guild_faction", "faction_id", "faction"]);
  if (!memberPlayerColumn || !memberGuildColumn || !guildIdColumn || !guildFactionColumn) return factions;
  const hasFactions = await tableExists(db, "factions");
  const result = await db.query(`
    select gm.${quoteIdentifier(memberPlayerColumn)}::text as player_id,
           g.${quoteIdentifier(guildFactionColumn)}::text as faction_id,
           ${hasFactions ? "coalesce(f.name, '')" : "''"} as faction_name
    from dune.guild_members gm
    join dune.guilds g on g.${quoteIdentifier(guildIdColumn)} = gm.${quoteIdentifier(memberGuildColumn)}
    ${hasFactions ? `left join dune.factions f on f.id = g.${quoteIdentifier(guildFactionColumn)}` : ""}
    where g.${quoteIdentifier(guildFactionColumn)} is not null
      and g.${quoteIdentifier(guildFactionColumn)} <> ${NEUTRAL_GUILD_FACTION_ID}`);
  for (const row of result.rows) {
    if (row.player_id) factions.set(String(row.player_id), factionDisplayName(row));
  }
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

const GUILD_SORT_COLUMNS = {
  guild_name: { order: ["lower(guild_name)"] },
  guild_faction: { order: ["lower(coalesce(guild_faction_name, guild_faction, ''))"] },
  member_count: { order: ["member_count"] },
  guild_id: { order: ["guild_id"] }
};

export async function listGuilds(db, { q = "", page = 0, pageSize = 50, sortColumn = "guild_name", sortDirection = "asc" } = {}) {
  if (!(await tableExists(db, "guilds"))) {
    return { ...unsupported("guilds", ["dune.guilds"]), totalCount: 0, totalGuilds: 0 };
  }
  const guildColumns = await columnsFor(db, "guilds");
  const guildIdColumn = firstExistingColumn(guildColumns, ["guild_id", "id"]);
  const guildNameColumn = firstExistingColumn(guildColumns, ["guild_name", "name", "display_name"]);
  if (!guildIdColumn || !guildNameColumn) {
    return { ...unsupported("guilds", ["dune.guilds"]), totalCount: 0, totalGuilds: 0 };
  }
  const guildFactionColumn = firstExistingColumn(guildColumns, ["guild_faction", "faction_id", "faction"]);
  const guildDescriptionColumn = firstExistingColumn(guildColumns, ["guild_description", "description"]);
  const hasMembers = await tableExists(db, "guild_members");
  let memberGuildColumn = "";
  if (hasMembers) {
    const memberColumns = await columnsFor(db, "guild_members");
    memberGuildColumn = firstExistingColumn(memberColumns, ["guild_id", "id"]);
  }
  const hasFactions = guildFactionColumn && await tableExists(db, "factions");

  const safePageSize = intParam(pageSize, "pageSize", 1, 200);
  const safePage = intParam(page, "page", 0);
  const offset = safePage * safePageSize;
  const safeSortColumn = Object.hasOwn(GUILD_SORT_COLUMNS, sortColumn) ? sortColumn : "guild_name";
  const safeSortDirection = String(sortDirection).toLowerCase() === "desc" ? "desc" : "asc";
  const sortOrder = GUILD_SORT_COLUMNS[safeSortColumn].order;
  const pagedOrder = [...sortOrder, ...(sortOrder.includes("guild_id") ? [] : ["guild_id"])]
    .map((column) => `${column} ${safeSortDirection}`).join(", ");

  const values = [];
  let where = "1=1";
  if (q) {
    values.push(`%${q}%`);
    where += ` and g.${quoteIdentifier(guildNameColumn)} ilike $${values.length}`;
  }
  values.push(safePageSize, offset);
  const limitParamIndex = values.length - 1;
  const offsetParamIndex = values.length;

  const memberCountSelect = hasMembers && memberGuildColumn
    ? `(select count(*) from dune.guild_members gm where gm.${quoteIdentifier(memberGuildColumn)} = g.${quoteIdentifier(guildIdColumn)})`
    : "0";

  const result = await db.query(`
    with matched as (
      select g.${quoteIdentifier(guildIdColumn)}::text as guild_id,
             coalesce(g.${quoteIdentifier(guildNameColumn)}, '') as guild_name,
             ${guildFactionColumn ? `coalesce(g.${quoteIdentifier(guildFactionColumn)}::text, '')` : "''"} as guild_faction,
             ${hasFactions ? "coalesce(f.name, '')" : "''"} as guild_faction_name,
             ${guildDescriptionColumn ? `coalesce(g.${quoteIdentifier(guildDescriptionColumn)}, '')` : "''"} as guild_description,
             ${memberCountSelect}::int as member_count
      from dune.guilds g
      ${hasFactions ? `left join dune.factions f on f.id = g.${quoteIdentifier(guildFactionColumn)}` : ""}
      where ${where}
    ),
    totals as (
      select count(*)::int as total_count
      from matched
    )
    select paged.*, totals.total_count
    from totals
    left join lateral (
      select *
      from matched
      order by ${pagedOrder}
      limit $${limitParamIndex} offset $${offsetParamIndex}
    ) paged on true
    order by ${pagedOrder}`, values);

  const totalsResult = await db.query("select count(*)::int as total_guilds from dune.guilds");

  const rows = result.rows
    .filter((row) => row.guild_id !== null && row.guild_id !== undefined)
    .map(({ total_count, ...row }) => ({ ...row, guild_faction: guildFactionDisplayName(row) }));
  return {
    capabilities: { guilds: true, guildMembers: hasMembers },
    totalCount: result.rows[0] ? Number(result.rows[0].total_count) : 0,
    totalGuilds: totalsResult.rows[0] ? Number(totalsResult.rows[0].total_guilds) : 0,
    rows
  };
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

const GUILD_OFFICER_ROLE_ID = 50;
const GUILD_LEADER_ROLE_ID = 100;
const MAX_GUILD_COUNT_PER_PLAYER = 1; // real game invariant -- get_guild_for_player does a bare SELECT INTO with no LIMIT, implying one guild per player
const DEFAULT_MAX_MEMBERS_PER_GUILD = 32;
// Verified against dune.guild_handle_actor_delete in the shipped database: the game's own
// generic database-removal path publishes reason 0 through dune.remove_guild_members.
const GUILD_REMOVE_REASON_DATABASE_REMOVAL = 0;

// The four guild mutations below hardcode literal guild_id/player_id/role_id/guild_name column
// names in raw SQL, unlike guildMembers()'s defensive firstExistingColumn() resolution for reads
// -- because these column names are what dune.promote_guild_member/dune.add_guild_member/
// dune.remove_guild_members/dune.disband_guild's own PL/pgSQL bodies reference internally, so any
// schema where those functions exist must already have these exact names. This check still
// verifies it directly (rather than relying solely on functionExists) so a schema drift a future
// game patch introduces surfaces as a clean "unsupported" response instead of a raw SQL error.
async function guildIdentityColumnsExist(db, { members = [] } = {}) {
  const guildColumns = await columnsFor(db, "guilds");
  if (!guildColumns.has("guild_id") || !guildColumns.has("guild_name")) return false;
  if (!members.length) return true;
  const memberColumns = await columnsFor(db, "guild_members");
  return members.every((column) => memberColumns.has(column));
}

async function lockGuildOperations(db) {
  // Match the lock order used by every shipped guild mutation. Taking the game's advisory
  // transaction lock before row locks avoids deadlocking with an in-game mutation that already
  // owns the advisory lock and is waiting for the same guild row.
  await db.query("select dune.guilds_get_exclusive_operation_lock()");
}

async function supportsGuildPromotion(db) {
  return await tableExists(db, "guild_members") && await tableExists(db, "guilds") &&
    await functionExists(db, "dune.promote_guild_member(bigint,bigint,smallint)") &&
    await guildIdentityColumnsExist(db, { members: ["guild_id", "player_id", "role_id"] });
}

// dune.promote_guild_member(guild_id, player_id, new_role) only special-cases new_role = 100
// (it demotes whoever currently holds it); for any other target role it's a plain role_id
// update. This lets Promote graduate a Member straight to Officer with no leader side effect,
// and Officer to Leader (with the automatic leader demotion), using the one real stored
// procedure -- confirmed by reading its body in .claude/dune_backup.sql before relying on it.
export async function promoteGuildMember(db, guildId, playerId) {
  await requireCapability(await supportsGuildPromotion(db), "Guild leadership changes require dune.guild_members, dune.guilds, and dune.promote_guild_member(bigint,bigint,smallint).");
  const safeGuildId = intParam(guildId, "guild id", 1);
  const safePlayerId = intParam(playerId, "player id", 1);

  return db.transaction(async (tx) => {
    await lockGuildOperations(tx);
    // Lock the guilds row first -- guaranteed to exist if the guild is real, giving concurrent
    // promote requests for the same guild something to serialize against even before touching
    // guild_members. Same technique as the inventory-row lock in refillBaseGenerators.
    const guild = await tx.query("select guild_id, guild_name from dune.guilds where guild_id = $1 for update", [safeGuildId]);
    if (!guild.rowCount) throw new Error(`Guild ${safeGuildId} was not found.`);

    const member = await tx.query(
      "select role_id::text as role_id from dune.guild_members where guild_id = $1 and player_id = $2 for update",
      [safeGuildId, safePlayerId]
    );
    if (!member.rowCount) throw new Error(`Player ${safePlayerId} is not a member of guild ${safeGuildId}.`);
    const currentRole = Number(member.rows[0].role_id);
    if (currentRole >= GUILD_LEADER_ROLE_ID) {
      return { ok: true, alreadyLeader: true, guildId: safeGuildId, playerId: safePlayerId };
    }
    const nextRole = currentRole >= GUILD_OFFICER_ROLE_ID ? GUILD_LEADER_ROLE_ID : GUILD_OFFICER_ROLE_ID;

    let previousLeaderId = null;
    if (nextRole === GUILD_LEADER_ROLE_ID) {
      const previousLeader = await tx.query(
        "select player_id from dune.guild_members where guild_id = $1 and role_id = $2",
        [safeGuildId, GUILD_LEADER_ROLE_ID]
      );
      previousLeaderId = previousLeader.rows[0]?.player_id ? String(previousLeader.rows[0].player_id) : null;
    }

    await tx.query("select dune.promote_guild_member($1::bigint, $2::bigint, $3::smallint)", [safeGuildId, safePlayerId, nextRole]);

    return {
      ok: true,
      guildId: safeGuildId,
      guildName: guild.rows[0].guild_name,
      playerId: safePlayerId,
      newRoleId: nextRole,
      previousLeaderId,
      message: nextRole === GUILD_LEADER_ROLE_ID
        ? "Leadership was updated in the database. Online players may need to relog before the change appears in-game."
        : "Rank was updated in the database. Online players may need to relog before the change appears in-game."
    };
  });
}

async function supportsGuildDemotion(db) {
  return await tableExists(db, "guild_members") && await tableExists(db, "guilds") &&
    await functionExists(db, "dune.demote_guild_member(bigint,bigint,smallint)") &&
    await guildIdentityColumnsExist(db, { members: ["guild_id", "player_id", "role_id"] });
}

// dune.demote_guild_member(guild_id, player_id, new_role) already refuses to demote the guild
// leader itself (raises "Trying to demote admin. promote a member to admin instead."), and this
// feature only ever offers Demote on Officer rows (Leader and Member are excluded in the UI), so
// Demote always targets the plain Member role.
export async function demoteGuildMember(db, guildId, playerId) {
  await requireCapability(await supportsGuildDemotion(db), "Guild demotions require dune.guild_members, dune.guilds, and dune.demote_guild_member(bigint,bigint,smallint).");
  const safeGuildId = intParam(guildId, "guild id", 1);
  const safePlayerId = intParam(playerId, "player id", 1);

  return db.transaction(async (tx) => {
    await lockGuildOperations(tx);
    const guild = await tx.query("select guild_id from dune.guilds where guild_id = $1 for update", [safeGuildId]);
    if (!guild.rowCount) throw new Error(`Guild ${safeGuildId} was not found.`);

    const member = await tx.query(
      "select role_id::text as role_id from dune.guild_members where guild_id = $1 and player_id = $2 for update",
      [safeGuildId, safePlayerId]
    );
    if (!member.rowCount) throw new Error(`Player ${safePlayerId} is not a member of guild ${safeGuildId}.`);
    const currentRole = Number(member.rows[0].role_id);
    if (currentRole >= GUILD_LEADER_ROLE_ID) {
      throw new Error("This player is the guild leader. Promote another member to Leader before demoting them.");
    }
    if (currentRole < GUILD_OFFICER_ROLE_ID) {
      throw new Error(`Player ${safePlayerId} is already a Member and cannot be demoted further.`);
    }

    await tx.query("select dune.demote_guild_member($1::bigint, $2::bigint, $3::smallint)", [safeGuildId, safePlayerId, 1]);

    return { ok: true, guildId: safeGuildId, playerId: safePlayerId };
  });
}

async function supportsGuildAdd(db) {
  return await tableExists(db, "guild_members") && await tableExists(db, "guilds") &&
    await functionExists(db, "dune.add_guild_member(bigint,bigint,smallint,integer,integer,smallint)") &&
    await guildIdentityColumnsExist(db);
}

export async function addGuildMember(db, guildId, playerId, roleId = 1, maxMembersPerGuild = DEFAULT_MAX_MEMBERS_PER_GUILD) {
  await requireCapability(await supportsGuildAdd(db), "Adding guild members requires dune.guild_members, dune.guilds, and dune.add_guild_member(bigint,bigint,smallint,integer,integer,smallint).");
  const safeGuildId = intParam(guildId, "guild id", 1);
  const safeRole = intParam(roleId, "role id", 1, 99); // Add Member never creates a second Leader -- promote is a separate, explicit action
  const safeMaxMembers = intParam(maxMembersPerGuild, "maximum guild members", 1, 2147483647);

  return db.transaction(async (tx) => {
    await lockGuildOperations(tx);
    const guild = await tx.query("select guild_id, guild_name from dune.guilds where guild_id = $1 for update", [safeGuildId]);
    if (!guild.rowCount) throw new Error(`Guild ${safeGuildId} was not found.`);

    // add_guild_member uses this limit only to decide when invitations should be cleared; it
    // does not reject an over-capacity insert itself. Enforce the effective server limit while
    // holding the same guild-row lock that serializes concurrent Console additions.
    const memberCount = await tx.query("select count(*)::int as count from dune.guild_members where guild_id = $1", [safeGuildId]);
    const currentMembers = Number(memberCount.rows[0]?.count || 0);
    if (currentMembers >= safeMaxMembers) {
      throw new Error(`Guild ${safeGuildId} already has the configured maximum of ${safeMaxMembers} members.`);
    }

    const player = await resolvePlayerMutationTarget(tx, playerId);
    try {
      // dune.add_guild_member(in_player_id, in_guild_id, ...) -- player id comes first,
      // confirmed against the real function signature in .claude/dune_backup.sql and against
      // a live restore of it (an earlier version of this code had these two swapped).
      await tx.query(
        "select dune.add_guild_member($1::bigint, $2::bigint, $3::smallint, $4::integer, $5::integer, $6::smallint)",
        [player.controllerId, safeGuildId, safeRole, MAX_GUILD_COUNT_PER_PLAYER, safeMaxMembers, NEUTRAL_GUILD_FACTION_ID]
      );
    } catch (error) {
      if (/Cannot insert more than/.test(error.message)) throw new Error("This player is already in a guild. Remove them from their current guild first.");
      if (/non existing guild/.test(error.message)) throw new Error(`Guild ${safeGuildId} was not found.`);
      if (/non compatible/.test(error.message)) throw new Error("This player's faction is not compatible with this guild.");
      throw error;
    }

    return { ok: true, guildId: safeGuildId, guildName: guild.rows[0].guild_name, playerId: player.controllerId, roleId: safeRole };
  });
}

async function supportsGuildRemove(db) {
  return await tableExists(db, "guild_members") && await tableExists(db, "guilds") &&
    await functionExists(db, "dune.remove_guild_members(bigint[],bigint,smallint)") &&
    await guildIdentityColumnsExist(db, { members: ["guild_id", "player_id", "role_id"] });
}

export async function removeGuildMember(db, guildId, playerId) {
  await requireCapability(await supportsGuildRemove(db), "Removing guild members requires dune.guild_members, dune.guilds, and dune.remove_guild_members(bigint[],bigint,smallint).");
  const safeGuildId = intParam(guildId, "guild id", 1);
  const safePlayerId = intParam(playerId, "player id", 1);

  return db.transaction(async (tx) => {
    await lockGuildOperations(tx);
    const guild = await tx.query("select guild_id from dune.guilds where guild_id = $1 for update", [safeGuildId]);
    if (!guild.rowCount) throw new Error(`Guild ${safeGuildId} was not found.`);

    const member = await tx.query(
      "select role_id::text as role_id from dune.guild_members where guild_id = $1 and player_id = $2 for update",
      [safeGuildId, safePlayerId]
    );
    if (!member.rowCount) throw new Error(`Player ${safePlayerId} is not a member of guild ${safeGuildId}.`);
    if (Number(member.rows[0].role_id) >= GUILD_LEADER_ROLE_ID) {
      throw new Error("This player is the guild leader. Promote another member to Leader before removing them.");
    }

    // The leader check above happens inside this same locked transaction (guild row + member
    // row both FOR UPDATE), so there's no window for a concurrent promote to change leadership
    // between the check and the delete below.
    await tx.query("select dune.remove_guild_members($1::bigint[], $2::bigint, $3::smallint)", [[safePlayerId], safeGuildId, GUILD_REMOVE_REASON_DATABASE_REMOVAL]);

    return { ok: true, guildId: safeGuildId, playerId: safePlayerId };
  });
}

async function supportsGuildDisband(db) {
  return await tableExists(db, "guilds") && await tableExists(db, "guild_members") &&
    await functionExists(db, "dune.disband_guild(bigint)") &&
    await guildIdentityColumnsExist(db, { members: ["guild_id"] });
}

export async function disbandGuild(db, guildId) {
  await requireCapability(await supportsGuildDisband(db), "Disbanding a guild requires dune.guilds and dune.disband_guild(bigint).");
  const safeGuildId = intParam(guildId, "guild id", 1);

  return db.transaction(async (tx) => {
    await lockGuildOperations(tx);
    const guild = await tx.query("select guild_id, guild_name from dune.guilds where guild_id = $1 for update", [safeGuildId]);
    if (!guild.rowCount) throw new Error(`Guild ${safeGuildId} was not found.`);

    const memberCount = await tx.query("select count(*)::int as count from dune.guild_members where guild_id = $1", [safeGuildId]);

    // dune.disband_guild deletes the guilds row; guild_members rows for this guild go with it via
    // guild_members_guild_id_fkey (FOREIGN KEY ... REFERENCES dune.guilds ON DELETE CASCADE), so
    // there is nothing left for us to clean up here.
    await tx.query("select dune.disband_guild($1::bigint)", [safeGuildId]);

    return { ok: true, guildId: safeGuildId, guildName: guild.rows[0].guild_name, memberCount: memberCount.rows[0]?.count || 0 };
  });
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
           coalesce(nullif(ps.account_id, 0), nullif(a.owner_account_id, 0), 0) as account_id,
           coalesce(ps.character_name, '') as character_name,
           coalesce(ps.player_controller_id, 0) as player_controller_id,
           coalesce(ps.id, 0) as player_state_id,
           coalesce(ac.funcom_id, '') as funcom_id,
           coalesce(ac."user", '') as fls_id,
           coalesce(ac.platform_id, '') as platform_id,
           coalesce(ac.platform_name, '') as platform_name,
           case
             when nullif(ac."user", '') is not null then ac."user"
             when coalesce(nullif(ps.account_id, 0), nullif(a.owner_account_id, 0)) is not null
               then coalesce(nullif(ps.account_id, 0), nullif(a.owner_account_id, 0))::text
             else ''
           end as action_player_id,
           a.class,
           coalesce(a.map, '') as map,
           coalesce(ps.online_status::text, 'Offline') as online_status
    from dune.actors a
    join dune.player_state ps on ps.player_pawn_id = a.id
    left join dune.accounts ac on ac.id = coalesce(nullif(ps.account_id, 0), nullif(a.owner_account_id, 0))
    where a.id = $1
      and a.class ilike '%PlayerCharacter%'
    order by ps.id desc
    limit 1`, [actorId]);
  if (!result.rows[0]) throw playerNotFoundError();
  const row = result.rows[0];
  const [currentFactions, guilds] = await Promise.all([
    leadershipCurrentFactions(db).catch(() => new Map()),
    leadershipGuilds(db).catch(() => new Map())
  ]);
  const controllerId = String(row.player_controller_id || "");
  const actorIdKey = String(row.actor_id || "");
  const accountIdKey = String(row.account_id || "");
  const assignedFaction = currentFactions.get(controllerId) || "";
  row.faction = assignedFaction || "Neutral";
  row.faction_assigned = Boolean(assignedFaction);
  row.guild = guilds.get(controllerId) || guilds.get(actorIdKey) || guilds.get(accountIdKey) || "—";
  return { capabilities: await playerCapabilities(db), player: row };
}

// Player-carried inventory containers keyed by dune.inventories.inventory_type.
// The console groups them into four tabs (labels applied client-side):
//   backpack           = 0
//   character          = 1  (worn armor/clothing)
//   loadout            = 15 (held weapons/tools)
//   unique schematics  = 30
// Emote/cosmetic containers (14, 27) are deliberately excluded: across every player
// in the reference data they hold nothing but Emote_* items, which are neither
// equipped gear nor schematics. (repairGear keeps its own wider set; emote items
// simply carry no durability to repair.)
const PLAYER_BACKPACK_INVENTORY_TYPE = 0;
const PLAYER_GEAR_INVENTORY_TYPES = [1, 15];
const PLAYER_SCHEMATIC_INVENTORY_TYPES = [30];
const PLAYER_INVENTORY_TYPES = [
  PLAYER_BACKPACK_INVENTORY_TYPE,
  ...PLAYER_GEAR_INVENTORY_TYPES,
  ...PLAYER_SCHEMATIC_INVENTORY_TYPES
];

// Shared shaping for inventory item rows: strips the raw stats blob and folds in
// admin catalog metadata + extracted augment ids. Used by both the backpack-only
// playerInventory and the all-containers playerInventoryAll.
function mapInventoryItemRows(rows) {
  const itemMetadata = adminItemMetadata();
  return rows.map(({ stats, ...row }) => {
    const metadata = itemMetadata.get(String(row.template_id || ""));
    return {
      ...row,
      item_name: metadata?.name || "",
      category: metadata?.category || "",
      source: metadata?.source || "",
      augments: extractAugmentIdsFromStats(stats)
    };
  });
}

const INVENTORY_ITEM_SELECT = `
    select i.id,
           i.template_id,
           i.stack_size,
           i.quality_level,
           i.position_index,
           i.inventory_id,
           inv2.inventory_type,
           coalesce((i.stats->'FItemStackAndDurabilityStats'->1->>'CurrentDurability'), null) as current_durability,
           coalesce(
             nullif((i.stats->'FItemStackAndDurabilityStats'->1->>'MaxDurability')::numeric, 0),
             nullif((i.stats->'FItemStackAndDurabilityStats'->1->>'DecayedMaxDurability')::numeric, 0),
             null
           ) as max_durability,
           i.stats
    from dune.items i
    join dune.inventories inv2 on i.inventory_id = inv2.id`;

async function backpackCapacity(db, playerId) {
  const inv = await db.query(`
    select max_item_count, max_item_volume
    from dune.inventories
    where actor_id = $1 and inventory_type = 0
    order by id limit 1`, [playerId]);
  return {
    maxSlots: Number(inv.rows[0]?.max_item_count) || 40,
    maxVolume: Number(inv.rows[0]?.max_item_volume) || 225
  };
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
  const rows = mapInventoryItemRows(result.rows);
  return { capabilities: { inventory: true }, maxSlots, maxVolume, rows };
}

// Like playerInventory but returns every player-carried container (backpack +
// equipped gear), tagging each row with inventory_type so the console can group
// them. maxSlots/maxVolume still describe the backpack for backward compatibility.
export async function playerInventoryAll(db, id) {
  if (!(await tableExists(db, "items")) || !(await tableExists(db, "inventories"))) return unsupported("inventory", ["dune.items", "dune.inventories"]);
  const playerId = intParam(id, "player id", 1);

  const { maxSlots, maxVolume } = await backpackCapacity(db, playerId);

  const result = await db.query(`${INVENTORY_ITEM_SELECT}
    where inv2.actor_id = $1 and inv2.inventory_type = any($2::int[])
    order by inv2.inventory_type, i.template_id`, [playerId, PLAYER_INVENTORY_TYPES]);
  const rows = mapInventoryItemRows(result.rows);
  return { capabilities: { inventory: true }, maxSlots, maxVolume, rows };
}

export async function playerCurrency(db, id) {
  if (!(await tableExists(db, "player_virtual_currency_balances"))) return unsupported("currency", ["dune.player_virtual_currency_balances"]);
  const actorId = intParam(id, "player id", 1);
  const hasSolarisId = await functionExists(db, "dune.get_solaris_id()");
  const solarisId = hasSolarisId ? Number((await db.query("select dune.get_solaris_id() as id")).rows[0].id) : null;
  const result = await db.query(`
    select currency_id, balance,
           case
             ${hasSolarisId ? "when currency_id = dune.get_solaris_id() then 'Solari Credit'" : ""}
             when currency_id = 1 then 'Scrip'
             else 'Currency ' || currency_id
           end as label
    from dune.player_virtual_currency_balances
    where player_controller_id = $1
       or player_controller_id = (select coalesce(player_controller_id, 0) from dune.player_state where player_pawn_id = $1 limit 1)
    order by currency_id`, [actorId]);

  const rows = [...result.rows];
  const expectedCurrencies = [
    { currency_id: 1, label: "Scrip" },
    ...(solarisId !== null ? [{ currency_id: solarisId, label: "Solari Credit" }] : [])
  ];
  for (const expected of expectedCurrencies) {
    if (!rows.some((row) => row.currency_id === expected.currency_id)) {
      rows.push({ currency_id: expected.currency_id, balance: 0, label: expected.label });
    }
  }
  rows.sort((a, b) => a.currency_id - b.currency_id);
  return { capabilities: { currency: true }, rows };
}

export async function playerSolarisCoinTotal(db, id) {
  if (!(await tableExists(db, "items")) || !(await tableExists(db, "inventories"))) {
    return { capabilities: { solarisCoin: false }, reason: "Unsupported by detected schema. Missing required table(s): dune.items, dune.inventories" };
  }
  const actorId = intParam(id, "player id", 1);
  const result = await db.query(`
    select coalesce(sum(i.stack_size), 0)::bigint as total
    from dune.items i
    join dune.inventories inv on inv.id = i.inventory_id
    where inv.actor_id = $1
      and i.template_id = 'SolarisCoin'`, [actorId]);
  return { capabilities: { solarisCoin: true }, total: Number(result.rows[0]?.total || 0) };
}

export async function playerFactions(db, id, journeyTagsData = {}) {
  if (!(await tableExists(db, "player_faction_reputation"))) return unsupported("factions", ["dune.player_faction_reputation"]);
  const hasFactions = await tableExists(db, "factions");
  const player = await resolvePlayerTargetCached(db, id);
  const componentResult = await db.query(`
    select properties->'FactionPlayerComponent'->'m_FactionDataArray' as faction_data
    from dune.actors
    where id = $1`, [player.controllerId]);
  const componentReputation = factionComponentReputationMap(componentResult.rows[0]?.faction_data);
  const result = hasFactions
    ? await db.query(`
        select f.id as faction_id,
               f.name as faction_name,
               coalesce(pfr.reputation_amount, 0) as reputation_amount
        from dune.factions f
        left join dune.player_faction_reputation pfr on pfr.faction_id = f.id and pfr.actor_id = $1
        where f.name <> 'None'
        order by f.id`, [player.controllerId])
    : await db.query(`
        select pfr.faction_id, '' as faction_name, pfr.reputation_amount
        from dune.player_faction_reputation pfr
        where pfr.actor_id = $1
        order by pfr.faction_id`, [player.controllerId]);
  let alignedFactionId = null;
  if (await tableExists(db, "player_faction")) {
    const alignment = await db.query("select faction_id from dune.player_faction where actor_id = $1", [player.controllerId]);
    alignedFactionId = alignment.rows[0] ? Number(alignment.rows[0].faction_id) : null;
  }
  const progressionSchema = await journeyIdentitySchema(db);
  const hasPlayerTags = Boolean(progressionSchema);
  let playerTags = [];
  let completedFactionNodes = [];
  if (progressionSchema) {
    const tagIdColumn = quoteIdentifier(progressionSchema.tagIdColumn);
    const journeyIdColumn = quoteIdentifier(progressionSchema.journeyIdColumn);
    const tagIdentityId = playerJourneyIdentity(player, progressionSchema.tagIdColumn);
    const journeyIdentityId = playerJourneyIdentity(player, progressionSchema.journeyIdColumn);
    const tags = await db.query(`
      select tag
      from dune.player_tags
      where ${tagIdColumn} = $1
        and tag like 'Faction.%'`, [tagIdentityId]);
    playerTags = tags.rows.map((row) => String(row.tag || ""));
    const nodes = await db.query(`
      select story_node_id
      from dune.journey_story_node
      where ${journeyIdColumn} = $1
        and complete_condition_state = 'true'::jsonb
        and story_node_id like 'DA_FQ_ClimbTheRanks.%'`, [journeyIdentityId]);
    completedFactionNodes = nodes.rows.map((row) => String(row.story_node_id || ""));
  }
  const rows = result.rows.map((row) => {
    const factionId = Number(row.faction_id);
    if (factionId !== 1 && factionId !== 2) return row;
    const reputation = Number(row.reputation_amount || 0);
    const componentValue = componentReputation.get(factionId);
    const reputationInSync = componentValue === reputation || (reputation === 0 && componentValue === undefined);
    const factionName = row.faction_name || (factionId === 1 ? "Atreides" : "Harkonnen");
    const estimatedRank = factionReputationEstimatedRank(row.reputation_amount);
    const progressionLimit = hasPlayerTags ? factionProgressionRankLimit(playerTags, factionName) : null;
    const rankLimited = progressionLimit !== null && estimatedRank > progressionLimit;
    const progressionRepair = hasPlayerTags && factionId === alignedFactionId
      ? factionProgressionRepairPlan(playerTags, factionName, completedFactionNodes, journeyTagsData)
      : { missingTags: [], earnedTier: 0 };
    return {
      ...row,
      component_reputation_amount: componentValue ?? null,
      reputation_in_sync: reputationInSync,
      estimated_rank: estimatedRank,
      current_rank_limit: rankLimited ? progressionLimit : null,
      rank_limited_by_progression: rankLimited,
      progression_repair_available: progressionRepair.missingTags.length > 0,
      progression_repair_target: progressionRepair.missingTags.length > 0 ? progressionRepair.earnedTier : null
    };
  });
  return { capabilities: { factions: true, factionNames: hasFactions, factionRanks: true }, player, rows };
}

export async function playerProgression(db, id) {
  if (!(await supportsPlayerProgression(db))) {
    return unsupported("progression", ["dune.player_state", "dune.actor_fgl_entities", "dune.fgl_entities"]);
  }
  const player = await resolvePlayerTargetCached(db, id);
  const result = await db.query(`
    select (fe.components->'FLevelComponent'->1->>'TotalXPEarned')::bigint as xp,
           (fe.components->'FLevelComponent'->1->>'TotalSkillPoints')::bigint as total_skill_points,
           (fe.components->'FLevelComponent'->1->>'UnspentSkillPoints')::bigint as unspent_skill_points
    from dune.fgl_entities fe
    join dune.actor_fgl_entities afe on afe.entity_id = fe.entity_id
    where afe.slot_name = 'DuneCharacter'
      and afe.actor_id = $1::bigint
    limit 1`, [player.actorId]);
  const row = result.rows[0];
  if (!row || row.xp === null) {
    return { capabilities: { progression: false }, player, reason: "No DuneCharacter FLevelComponent found for this player." };
  }
  const xp = Number(row.xp || 0);
  return {
    capabilities: { progression: true },
    player,
    xp,
    level: xpToLevel(xp),
    totalSkillPoints: Number(row.total_skill_points || 0),
    unspentSkillPoints: Number(row.unspent_skill_points || 0)
  };
}

export async function playerIntel(db, id) {
  if (!(await supportsIntelMutation(db))) {
    return unsupported("intel", ["dune.actors (properties column)"]);
  }
  const player = await resolvePlayerTargetCached(db, id);
  const result = await db.query(`
    select (properties->'TechKnowledgePlayerComponent'->>'m_TechKnowledgePoints')::bigint as intel
    from dune.actors
    where id = $1 and properties ? 'TechKnowledgePlayerComponent'`, [player.actorId]);
  const row = result.rows[0];
  if (!row || row.intel === null) {
    return { capabilities: { intel: false }, player, reason: "No TechKnowledgePlayerComponent found for this player." };
  }
  return {
    capabilities: { intel: true },
    player,
    intel: Number(row.intel || 0),
    maxIntel: MAX_INTEL_POINTS
  };
}

export async function playerVitals(db, id) {
  if (!(await supportsPlayerVitals(db))) {
    return unsupported("vitals", ["dune.actors (gas_attributes column)", "dune.player_state", "dune.actor_fgl_entities", "dune.fgl_entities"]);
  }
  const player = await resolvePlayerTargetCached(db, id);
  const hasSpecTracks = await tableExists(db, "specialization_tracks");
  const [healthResult, gasResult, combatResult] = await Promise.all([
    db.query(`
      select (fe.components->'FHealthComponent'->1->>'m_CurrentHealth')::numeric as current_health
      from dune.fgl_entities fe
      join dune.actor_fgl_entities afe on afe.entity_id = fe.entity_id
      where afe.slot_name = 'DuneCharacter'
        and afe.actor_id = $1::bigint
      limit 1`, [player.actorId]),
    db.query(`
      select (gas_attributes->'DuneHydrationAttributeSet'->'CurrentHydration'->>'CurrentValue')::numeric as hydration,
             (gas_attributes->'DuneSpiceAddictionAttributeSet'->'SpiceAddictionLevel'->>'CurrentValue')::numeric as spice_addiction_level
      from dune.actors
      where id = $1`, [player.actorId]),
    hasSpecTracks
      ? db.query(`select level from dune.specialization_tracks where player_id = $1 and track_type::text = 'Combat' limit 1`, [player.controllerId])
      : Promise.resolve({ rows: [] })
  ]);
  const health = healthResult.rows[0];
  const gas = gasResult.rows[0];
  const combatLevel = Number(combatResult.rows[0]?.level || 0);
  const toNum = (v) => (v === undefined || v === null ? null : Number(v));
  return {
    capabilities: { vitals: true },
    player,
    currentHealth: toNum(health?.current_health),
    maxHealth: maxHealthForCombatLevel(combatLevel),
    // The persisted FHealthComponent exposes current health but no maximum.
    // This value is derived from the known base health and Vitality tiers,
    // so callers must not present it as a value read directly from the game.
    maxHealthEstimated: true,
    hydration: toNum(gas?.hydration),
    maxHydration: BASE_MAX_HYDRATION,
    spiceAddictionLevel: toNum(gas?.spice_addiction_level),
    maxSpiceAddictionLevel: BASE_MAX_ADDICTION
  };
}

// dune.specialization_keystones_map has no track column; the track is the name prefix
// (e.g. "Combat_CombatKeystone_SkillPoint4" belongs to the Combat track).
async function specializationKeystoneCounts(db, controllerId) {
  const result = await db.query(`
    select split_part(m.name, '_', 1) as track_type,
           count(*)::int as total,
           count(p.player_id)::int as owned
    from dune.specialization_keystones_map m
    left join dune.purchased_specialization_keystones p
      on p.keystone_id = m.id and p.player_id = $1
    group by 1`, [controllerId]).catch(() => ({ rows: [] }));
  return new Map((result.rows || []).map((row) => [String(row.track_type || ""), {
    owned: Number(row.owned) || 0,
    total: Number(row.total) || 0
  }]));
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
  const points = await db.query(`
    select coalesce((fe.components->'FLevelComponent'->1->>'UnspentSkillPoints')::int,0) unspent_points
    from dune.actor_fgl_entities afe join dune.fgl_entities fe on fe.entity_id=afe.entity_id
    where afe.slot_name='DuneCharacter' and afe.actor_id=$1 limit 1`, [player.actorId]).catch(() => ({ rows: [] }));
  const keystonesSupported = await tableExists(db, "purchased_specialization_keystones")
    && await tableExists(db, "specialization_keystones_map");
  const keystonesByTrack = keystonesSupported ? await specializationKeystoneCounts(db, player.controllerId) : new Map();
  return {
    capabilities: {
      specs: true,
      specializationMutation: await supportsSpecializationLiveRefresh(db),
      keystones: keystonesSupported
    },
    player,
    unspentPoints: Number(points.rows[0]?.unspent_points) || 0,
    skillModules: await playerSkillModules(db, player),
    rows: tracks.map((track) => {
      const row = byTrack.get(track);
      const keystones = keystonesByTrack.get(track) || { owned: 0, total: 0 };
      return {
        player_id: player.controllerId,
        track_type: track,
        xp_amount: row?.xp_amount ?? 0,
        level: row?.level ?? 0,
        keystone_count: keystones.owned,
        keystone_total: keystones.total,
        has_keystone: keystones.total > 0 && keystones.owned >= keystones.total
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
    const nextLevel = specializationXpToLevel(nextXp);
    await withKnownLiveRefresh(tx, () => tx.query(
      "select dune.set_specialization_xp_and_level($1::bigint, $2::dune.specializationtracktype, $3::integer, $4::real)",
      [player.controllerId, track, nextXp, nextLevel]
    ), { features: ["specialization"] });
    return {
      ok: true,
      player,
      trackType: track,
      oldXp,
      xp: nextXp,
      oldLevel,
      level: nextLevel,
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
  // Picking up a base leaves every placeable and transform at its old location.
  // Link the storage actor back to its backup group, then require that group's
  // claim actor to still be unclaimed. The second signal keeps a stale backup
  // link from hiding storage after the player redeploys the base.
  const storedBaseTables = await Promise.all([
    "base_backup_linked_actors",
    "actor_fgl_entities",
    "building_instances",
    "permission_actor"
  ].map((table) => tableExists(db, table)));
  const storedBaseExclusion = storedBaseTables.every(Boolean) ? `
        and not exists (
          select 1
          from dune.base_backup_linked_actors storage_link
          where storage_link.actor_id = p.id
            and exists (
              select 1
              from dune.base_backup_linked_actors claim_link
              join dune.actor_fgl_entities claim_entity on claim_entity.actor_id = claim_link.actor_id
              join dune.building_instances claim_building on claim_building.owner_entity_id = claim_entity.entity_id
              left join dune.permission_actor claim_permission on claim_permission.actor_id = claim_link.actor_id
              where claim_link.id = storage_link.id
                and claim_permission.actor_id is null
            )
        )` : "";
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
      where p.building_type in ('SpiceSilo_Placeable','GenericContainer_Placeable','StorageContainer_Placeable','MediumStorageContainer_Placeable','Developer_StorageContainer_Placeable')
        and a.transform is not null ${partitionWhere} ${where} ${storedBaseExclusion}
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
  const hasBaseBackups = await tableExists(db, "base_backup_linked_actors");
  // Mirror listBases: neither an ownerless base nor an old backup link alone
  // is enough to hide a marker. Together they identify a currently stored base.
  const storedBaseExclusion = hasBaseBackups
    ? "and not (pa.actor_id is null and exists (select 1 from dune.base_backup_linked_actors backup_link where backup_link.actor_id = a.id))"
    : "";
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
      where a.transform is not null ${partitionWhere} ${where} ${storedBaseExclusion}
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

// Partition topology rows for combat-state resolution. Returns
// `dune.world_partition` metadata (partition id, dimension index, database
// label) joined with `farm_state` runtime availability. These fields are
// descriptive metadata only — callers must resolve PvP/PvE combat state via
// `services/mapCombatState.js`, never by inferring it from the columns
// returned here.
export async function mapCombatPartitionRows(db, map) {
  if (!(await tableExists(db, "world_partition"))) return unsupportedMap("combatState", ["dune.world_partition"]);
  const hasFarm = await tableExists(db, "farm_state");
  const values = [];
  const where = mapFilterClause(map, values, "wp");
  const result = await db.query(`
    select wp.partition_id::text as partition_id,
           coalesce(wp.map, '') as map,
           coalesce(wp.dimension_index, 0) as dimension_index,
           coalesce(wp.label, '') as database_label,
           coalesce(wp.server_id, '') as server_id,
           coalesce(wp.blocked, false) as blocked,
           ${hasFarm ? "coalesce(fs.alive, false)" : "false"} as alive,
           ${hasFarm ? "coalesce(fs.ready, false)" : "false"} as ready
    from dune.world_partition wp
    ${hasFarm ? "left join dune.farm_state fs on fs.server_id = wp.server_id" : ""}
    where 1=1 ${where}
    order by wp.dimension_index, wp.partition_id`, values);
  return { capabilities: { combatState: true, farmState: hasFarm }, rows: result.rows };
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

const PERMISSION_OWNER_RANK = 1;
const PERMISSION_EDITABLE_RANKS = new Set([1, 2, 3]);
// Fallback only. The real cap comes from live server config via
// parseEffectivePermissionLimit -- matching the shipped DefaultGame.ini's
// m_MaxPermissionsPerActor=32 under [/Script/DuneSandbox.PermissionSettings].
const DEFAULT_MAX_PERMISSIONS_PER_ACTOR = 32;

// Base permission editing goes through the game's own stored procedures, never
// through direct DML on permission_actor_rank. They do three things a hand-
// written insert would skip: refresh the base marker, delete the player's marker
// on removal, and pg_notify('permission_notify_channel', ...) -- which the
// running map server LISTENs on and applies immediately. Verified in-game on a
// live server: a rank change written this way moved a player between sections in
// the owner's open Permissions panel with no relog and no restart. Writing the
// table directly would land the row and leave the running server unaware of it,
// which is the silently-reverted behaviour this avoids.
async function supportsBasePermissionEditing(db) {
  for (const table of ["permission_actor_rank", "permission_actor", "actors", "player_state", "map_names"]) {
    if (!(await tableExists(db, table))) return false;
  }
  return await functionExists(db, "dune.permission_set_player_rank(bigint,bigint,smallint,text)")
    && await functionExists(db, "dune.permission_remove_player_rank(bigint,bigint)");
}

export async function basePermissionsSupported(db) {
  return supportsBasePermissionEditing(db).catch(() => false);
}

// The base id the Bases table shows is min(buildings.id) for the claim, which is
// NOT the permission actor id -- on a live server the two differ for every base,
// by a varying offset. Resolving the actor here (rather than trusting anything
// client-supplied) is what keeps an edit from landing on a neighbouring base.
//
// map_name_id is resolved for the same call: permission_set_player_rank
// interpolates its map argument into the notify payload unquoted, so it must be
// the numeric dune.map_names id. Passing the text map name would emit malformed
// JSON to the game server.
export async function basePermissionActor(db, baseId) {
  const target = intParam(baseId, "base id", 1);
  const result = await db.query(`
    select a.id::text as actor_id,
           coalesce(a.map, '') as map,
           coalesce(mn.map_name_id, 0)::int as map_name_id,
           coalesce(a.partition_id, 0)::int as partition_id
    from dune.buildings b
    left join dune.building_instances bi on bi.building_id = b.id
    left join dune.actor_fgl_entities afe on afe.entity_id = bi.owner_entity_id
    left join dune.actors a on a.id = afe.actor_id
    left join dune.map_names mn on mn.map_name = a.map
    where b.id = $1
    -- A base commonly has several building_instances rows ("pieces"), and only
    -- this one column varies per piece. Without an explicit order, an orphaned
    -- piece (owner_entity_id null) could beat a sibling piece that resolves
    -- fine, since the left join no longer filters candidacy down to valid rows
    -- the way the old inner join did. Prefer a resolved row deterministically.
    order by (a.id is null) asc, bi.instance_id asc
    limit 1`, [target]);
  const row = result.rows[0];
  if (!row) throw new Error("That base was not found.");
  // building_instances.owner_entity_id is nullable (ON DELETE SET NULL against
  // fgl_entities), so the entity link can be broken even though the base row
  // itself still exists. Left-joining down to actors instead of inner-joining
  // lets that case surface as its own message rather than the same "not found"
  // an operator would see for a genuinely deleted base id.
  if (!row.actor_id) throw new Error("This base has no resolvable owner entity, so permission editing is unavailable for it.");
  return {
    baseId: target,
    actorId: String(row.actor_id),
    map: String(row.map || ""),
    mapNameId: Number(row.map_name_id || 0),
    partitionId: Number(row.partition_id || 0)
  };
}

// permission_actor_rank.permission_actor_id carries a foreign key against
// dune.permission_actor(actor_id), and basePermissionActor resolves its id from
// the buildings -> building_instances -> actor_fgl_entities -> actors chain,
// which says nothing about whether that actor is claimed. An unclaimed base has
// every structural row intact and no permission_actor row, so handing its actor
// id to permission_set_player_rank fails the FK inside the shipped procedure --
// surfacing as a raw "violates foreign key constraint
// permission_actor_rank_permission_actor_id_fkey" with no indication of what an
// operator did wrong.
//
// Checked here rather than by widening basePermissionActor's own query: that
// resolution is shared with the base-delete path, whose supportsBaseDelete
// probes buildings/building_instances/actor_fgl_entities/placeables/actors but
// not permission_actor. Joining the table into the shared query would break
// deletion on a schema that lacks it. Both callers of this helper already gate
// on supportsBasePermissionEditing, which does probe permission_actor.
async function basePermissionActorClaimed(db, actorId) {
  const result = await db.query(
    "select exists (select 1 from dune.permission_actor where actor_id = $1::bigint) as claimed",
    [actorId]);
  return Boolean(result.rows[0]?.claimed);
}

// Deliberately distinct from BASE_BACKED_UP_MESSAGE in server.js: that one names
// the base-backup tool, which is only one of the ways a base ends up unclaimed.
// This covers the general case, including a base whose permission_actor row went
// away without a base_backup_linked_actors entry to explain it.
const BASE_UNCLAIMED_MESSAGE = "This base is not claimed -- it has no dune.permission_actor row, so the game has nothing to attach permissions to. A player must claim or redeploy it first.";

// The base-backup tool ("pick up base") only deletes permission_actor/
// permission_actor_rank and registers the base's actor ids in
// base_backup_linked_actors -- see listBases' matching exclusion. That keeps
// a picked-up base out of the panel, but a caller hitting a route directly
// (or a stale bookmarked base id) would otherwise still be able to mutate
// it. Every mutation route checks this before writing, the same way each
// already checks the pending-delete lock.
export async function baseIsBackedUp(db, baseId) {
  const target = intParam(baseId, "base id", 1);
  if (!(await tableExists(db, "base_backup_linked_actors"))) return false;
  const result = await db.query(`
    select exists (
      select 1
      from dune.buildings b
      join dune.building_instances bi on bi.building_id = b.id
      join dune.actor_fgl_entities afe on afe.entity_id = bi.owner_entity_id
      join dune.actors a on a.id = afe.actor_id
      left join dune.permission_actor pa on pa.actor_id = a.id
      where b.id = $1
        and pa.actor_id is null
        and exists (select 1 from dune.base_backup_linked_actors bbla where bbla.actor_id = a.id)
    ) as backed_up`, [target]);
  return Boolean(result.rows[0]?.backed_up);
}

// permission_actor_rank.player_id is a player's player_controller_id, not just
// any actors row belonging to their account -- one account holds several. The
// shipped permission_actor_create_or_update_base_marker joins
// `player_state on player_controller_id = player_id`, and a live A/B confirmed
// it: a rank row written for a non-canonical actor id was accepted by the
// procedure and never appeared in game, while the same write against the
// player_controller_id appeared immediately.
//
// The fallback lookup exists so such a phantom row is still shown to the
// operator rather than silently vanishing from the roster: resolving the name
// through owner_account_id is how listBases does it, and every actors row of an
// account maps to the same character name.
export async function listBasePermissions(db, baseId) {
  await requireCapability(await supportsBasePermissionEditing(db),
    "Base permission editing requires dune.permission_actor_rank, dune.map_names, and the dune.permission_set_player_rank/permission_remove_player_rank functions.");
  const { actorId, map, mapNameId } = await basePermissionActor(db, baseId);
  // Reading an unclaimed base still succeeds -- the roster is simply empty, and
  // seeing that is how an operator diagnoses the base in the first place. The
  // flag rides along so the editor can disable the writes that would fail
  // instead of offering controls that end in an FK error.
  const claimed = await basePermissionActorClaimed(db, actorId);
  const encryptedPlayerStateColumns = await tableExists(db, "encrypted_player_state")
    ? await columnsFor(db, "encrypted_player_state")
    : new Set();
  const hasEncryptedController = encryptedPlayerStateColumns.has("player_controller_id");
  const canDecryptEncryptedName = hasEncryptedController
    && encryptedPlayerStateColumns.has("encrypted_character_name")
    && await functionExists(db, "dune.decrypt_user_data(bytea)");
  const encryptedJoin = hasEncryptedController
    ? `left join lateral (
      select eps.player_controller_id,
             ${canDecryptEncryptedName ? `case
               when eps.player_controller_id in (${CARE_PACKAGE_SERVER_PERSONA.playerControllerId}::bigint, ${FUNCOM_GM_PERSONA.playerControllerId}::bigint) then ''::text
               else dune.decrypt_user_data(eps.encrypted_character_name)
             end` : "''::text"} as character_name
      from dune.encrypted_player_state eps
      where eps.player_controller_id = par.player_id
      limit 1
    ) eps on true`
    : "";
  const encryptedName = hasEncryptedController ? "eps.character_name" : "''";
  const encryptedCanonical = hasEncryptedController ? "or eps.player_controller_id is not null" : "";
  const result = await db.query(`
    select par.player_id::text as player_id,
           case
             when par.player_id = ${CARE_PACKAGE_SERVER_PERSONA.playerControllerId}::bigint then '${CARE_PACKAGE_SERVER_PERSONA.displayName}'
             when par.player_id = ${FUNCOM_GM_PERSONA.playerControllerId}::bigint then '${FUNCOM_GM_PERSONA.displayName}'
             else coalesce(ps.character_name, ${encryptedName}, fallback.character_name, '')
           end as character_name,
           par.rank::int as rank,
           (ps.player_controller_id is not null ${encryptedCanonical}) as canonical
    from dune.permission_actor_rank par
    left join dune.player_state ps on ps.player_controller_id = par.player_id
    ${encryptedJoin}
    left join lateral (
      select fps.character_name
      from dune.actors fa
      join dune.player_state fps on fps.account_id = fa.owner_account_id
      where fa.id = par.player_id
      limit 1
    ) fallback on true
    where par.permission_actor_id = $1::bigint
    order by par.rank asc, coalesce(ps.character_name, fallback.character_name, '') asc`, [actorId]);
  const systemCustodian = await basePermissionSystemCustodian(db);
  return {
    baseId: intParam(baseId, "base id", 1),
    actorId,
    map,
    mapNameId,
    claimed,
    unclaimedReason: claimed ? "" : BASE_UNCLAIMED_MESSAGE,
    systemCustodian,
    entries: result.rows.map((row) => ({
      playerId: String(row.player_id),
      name: String(row.character_name || ""),
      rank: Number(row.rank),
      label: permissionRankLabel(Number(row.rank)),
      // False means this row names an actor that is not the account's
      // player_controller_id, so the game ignores it. Surfaced rather than
      // hidden: it is the one roster state the console can see and the game
      // client cannot.
      canonical: row.canonical === true
    }))
  };
}

// System identities stay out of ordinary player search. Prefer the RedBlink
// Server persona when installed, then fall back to Funcom's reserved GM persona.
// Both are matched by their stable account/controller/state/pawn tuple rather
// than their display name: encrypted schemas do not expose a plain name, and a
// normal character can be named "Server". The legacy name lookup is retained
// last for installations that created Server before the reserved tuple existed.
export async function basePermissionSystemCustodian(db) {
  const personas = [CARE_PACKAGE_SERVER_PERSONA, FUNCOM_GM_PERSONA];
  const sources = [];
  for (const table of ["player_state", "encrypted_player_state"]) {
    if (!(await tableExists(db, table))) continue;
    const columns = await columnsFor(db, table);
    if (!columns.has("account_id") || !columns.has("player_controller_id")) continue;
    sources.push({ table, columns });
  }

  for (const persona of personas) {
    for (const source of sources) {
      const predicates = ["account_id = $1::bigint", "player_controller_id = $2::bigint"];
      const values = [persona.accountId, persona.playerControllerId];
      if (source.columns.has("player_state_id")) {
        values.push(persona.playerStateId);
        predicates.push(`player_state_id = $${values.length}::bigint`);
      }
      if (source.columns.has("player_pawn_id")) {
        values.push(persona.playerPawnId);
        predicates.push(`player_pawn_id = $${values.length}::bigint`);
      }
      const exact = await db.query(`
        select player_controller_id::text as player_id
        from dune.${source.table}
        where ${predicates.join(" and ")}
        limit 2`, values);
      if (exact.rows.length > 1) {
        return { available: false, reason: `More than one canonical ${persona.displayName} system identity was found; refusing an ambiguous transfer.` };
      }
      if (exact.rows.length === 1) {
        return {
          available: true,
          playerId: persona.playerControllerId,
          name: persona.displayName
        };
      }
    }
  }

  // Compatibility for an older, manually-created Server persona whose ids do
  // not use the now-reserved 9000002xx tuple.
  const playerStateColumns = await columnsFor(db, "player_state");
  const internalGmPawnFilter = playerStateColumns.has("player_pawn_id")
    ? `and coalesce(ps.player_pawn_id, 0) <> ${INTERNAL_GM_PLAYER_PAWN_ID}::bigint`
    : "";
  const result = await db.query(`
    select distinct ps.player_controller_id::text as player_id,
           btrim(ps.character_name) as character_name
    from dune.player_state ps
    where coalesce(ps.player_controller_id, 0) > 0
      and ps.player_controller_id <> ${INTERNAL_GM_PLAYER_PAWN_ID}::bigint
      ${internalGmPawnFilter}
      and lower(btrim(coalesce(ps.character_name, ''))) = 'server'
    order by player_id
    limit 2`);
  if (result.rows.length === 0) {
    return {
      available: false,
      canCreate: true,
      playerId: CARE_PACKAGE_SERVER_PERSONA.playerControllerId,
      name: CARE_PACKAGE_SERVER_PERSONA.displayName,
      reason: "The reserved Server identity will be created when ownership is transferred."
    };
  }
  if (result.rows.length > 1) {
    return { available: false, reason: "More than one canonical Server system identity was found; refusing an ambiguous transfer." };
  }
  return {
    available: true,
    playerId: String(result.rows[0].player_id),
    name: String(result.rows[0].character_name || "Server")
  };
}

// Candidates for the roster picker. Deliberately keyed on player_controller_id
// rather than reusing listPlayers' actor_id: listPlayers is row-per-pawn, and
// handing a pawn id to permission_set_player_rank writes a row the game ignores.
export async function basePermissionCandidates(db, { q = "", limit = 25 } = {}) {
  await requireCapability(await supportsBasePermissionEditing(db),
    "Base permission editing requires dune.permission_actor_rank, dune.map_names, and the dune.permission_set_player_rank/permission_remove_player_rank functions.");
  const safeLimit = intParam(limit, "limit", 1, 100);
  const playerStateColumns = await columnsFor(db, "player_state");
  const internalGmPawnFilter = playerStateColumns.has("player_pawn_id")
    ? `and coalesce(ps.player_pawn_id, 0) <> ${INTERNAL_GM_PLAYER_PAWN_ID}::bigint`
    : "";
  const values = [];
  let filter = "";
  if (q) {
    values.push(`%${q}%`);
    const likeParam = values.length;
    values.push(q);
    const idParam = values.length;
    filter = `and (ps.character_name ilike $${likeParam} or ps.player_controller_id::text = $${idParam})`;
  }
  values.push(safeLimit);
  const result = await db.query(`
    select distinct ps.player_controller_id::text as player_id,
           coalesce(ps.character_name, '') as character_name
    from dune.player_state ps
    where coalesce(ps.player_controller_id, 0) > 0
      and ps.player_controller_id <> ${INTERNAL_GM_PLAYER_PAWN_ID}::bigint
      ${internalGmPawnFilter}
      and nullif(btrim(coalesce(ps.character_name, '')), '') is not null
      and ps.character_name not in ('Server', 'Message of the Day')
      ${filter}
    order by character_name asc
    limit $${values.length}`, values);
  return result.rows.map((row) => ({ playerId: String(row.player_id), name: String(row.character_name || "") }));
}

function normalizeDesiredPermissions(entries) {
  if (!Array.isArray(entries)) throw new Error("Permissions must be a list of players and ranks.");
  const seen = new Set();
  const desired = entries.map((entry) => {
    const playerId = String(intParam(entry?.playerId, "player id", 1));
    const rank = Number(entry?.rank);
    if (!PERMISSION_EDITABLE_RANKS.has(rank)) {
      throw new Error(`Rank ${entry?.rank} is not a valid base permission rank.`);
    }
    if (seen.has(playerId)) throw new Error("The same player was listed twice.");
    seen.add(playerId);
    return { playerId, rank };
  });
  const owners = desired.filter((entry) => entry.rank === PERMISSION_OWNER_RANK);
  if (owners.length !== 1) {
    throw new Error(owners.length === 0
      ? "A base must have exactly one Owner. Promote a player to Owner before saving."
      : `A base can only have one Owner; ${owners.length} were selected.`);
  }
  return desired;
}

// Applies a whole roster in one transaction, built entirely from the shipped
// procedures. Two invariants the procedures do NOT enforce are enforced here:
//
//   - One Owner. permission_set_player_rank is a plain upsert, so setting rank 1
//     for a second player would simply leave the base with two owners.
//   - The cap. The procedure never counts rows; the limit comes from live server
//     config (see parseEffectivePermissionLimit), not a constant.
//
// Write order matters even though NOTIFY is only delivered at commit: the marker
// refresh inside permission_set_player_rank looks up the rank-1 holder with a
// LIMIT 1, so a moment with two rank-1 rows could stamp the wrong owner onto the
// base marker. Removals run first, then non-owner ranks, then the Owner last --
// so at most one rank-1 row exists when the owner write lands.
async function mutateBasePermissions(db, target, safeMax, desiredRoster) {
  return db.transaction(async (tx) => {
    // The shipped procedures reference their tables unqualified and carry no
    // `SET search_path` of their own; they resolve only because the console
    // connects as the `dune` role, whose default "$user" path puts the dune
    // schema first. Every query this file writes is schema-qualified, so setting
    // it here costs nothing and keeps the feature working if ADMIN_DATABASE_URL
    // is ever pointed at a differently-named role.
    await tx.query("set local search_path to dune, public");

    const actor = await basePermissionActor(tx, target);
    if (!actor.mapNameId) {
      throw new Error(`This base's map (${actor.map || "unknown"}) has no dune.map_names entry, so the game cannot be notified of the change.`);
    }
    // Lock the claim actor row, not the rank rows: a base whose roster is being
    // fully replaced may have no rank rows to lock, and `for update` over zero
    // rows serializes nothing. The actors row is guaranteed to exist.
    const locked = await tx.query("select id from dune.actors where id = $1::bigint for update", [actor.actorId]);
    if (!locked.rowCount) throw new Error("That base was not found.");

    // After the lock, not before: this is the last read the transaction can make
    // before it starts calling the procedures. The game's own pickup path does
    // not take this lock, so a pickup landing mid-edit can still slip past and
    // hit the FK -- that race is what the constraint is for. What this removes
    // is the far more common steady-state case, an unclaimed base sitting in the
    // panel that every route currently accepts a write for.
    if (!(await basePermissionActorClaimed(tx, actor.actorId))) throw new Error(BASE_UNCLAIMED_MESSAGE);

    const existing = await tx.query(
      "select player_id::text as player_id, rank::int as rank from dune.permission_actor_rank where permission_actor_id = $1::bigint",
      [actor.actorId]);
    const currentByPlayer = new Map(existing.rows.map((row) => [String(row.player_id), Number(row.rank)]));
    const desired = normalizeDesiredPermissions(await desiredRoster(existing.rows, tx));
    if (desired.length > safeMax) {
      throw new Error(`This base would hold ${desired.length} permissions, above the configured maximum of ${safeMax}.`);
    }

    // Every target player must be a real permission holder, i.e. an account's
    // player_controller_id. Newer servers keep this in encrypted_player_state;
    // older schemas expose player_state. Anything else writes a row the game
    // ignores.
    const canonicalSources = [
      "select player_controller_id from dune.player_state where player_controller_id = any($1::bigint[])"
    ];
    if (await tableExists(tx, "encrypted_player_state")) {
      const encryptedColumns = await columnsFor(tx, "encrypted_player_state");
      if (encryptedColumns.has("player_controller_id")) {
        canonicalSources.push("select player_controller_id from dune.encrypted_player_state where player_controller_id = any($1::bigint[])");
      }
    }
    const canonical = await tx.query(
      `select distinct player_controller_id::text as player_id from (${canonicalSources.join(" union all ")}) known_players`,
      [desired.map((entry) => entry.playerId)]);
    const canonicalIds = new Set(canonical.rows.map((row) => String(row.player_id)));
    for (const entry of desired) {
      if (!canonicalIds.has(entry.playerId)) {
        throw new Error(`Player ${entry.playerId} is not a known player character, so the game would ignore this permission.`);
      }
    }

    const desiredByPlayer = new Map(desired.map((entry) => [entry.playerId, entry.rank]));
    const removed = [...currentByPlayer.keys()].filter((playerId) => !desiredByPlayer.has(playerId));
    // Unchanged rows are skipped: every write fires a notify, and re-notifying
    // the game about a rank it already has is pointless traffic.
    const changed = desired.filter((entry) => currentByPlayer.get(entry.playerId) !== entry.rank);

    for (const playerId of removed) {
      await tx.query("select dune.permission_remove_player_rank($1::bigint, $2::bigint)", [actor.actorId, playerId]);
    }
    for (const entry of changed.filter((row) => row.rank !== PERMISSION_OWNER_RANK)) {
      await tx.query("select dune.permission_set_player_rank($1::bigint, $2::bigint, $3::smallint, $4::text)",
        [actor.actorId, entry.playerId, entry.rank, String(actor.mapNameId)]);
    }
    for (const entry of changed.filter((row) => row.rank === PERMISSION_OWNER_RANK)) {
      await tx.query("select dune.permission_set_player_rank($1::bigint, $2::bigint, $3::smallint, $4::text)",
        [actor.actorId, entry.playerId, entry.rank, String(actor.mapNameId)]);
    }

    return {
      ok: true,
      baseId: target,
      actorId: actor.actorId,
      map: actor.map,
      added: changed.filter((entry) => !currentByPlayer.has(entry.playerId)).length,
      reranked: changed.filter((entry) => currentByPlayer.has(entry.playerId)).length,
      removed: removed.length,
      total: desired.length,
      // Changes reach a running map server immediately: the procedures notify
      // permission_notify_channel, which the server LISTENs on. No restart.
      message: "Permissions were updated. The change applies to the running map immediately."
    };
  });
}

export async function setBasePermissions(db, baseId, entries, maxPermissionsPerActor = DEFAULT_MAX_PERMISSIONS_PER_ACTOR) {
  await requireCapability(await supportsBasePermissionEditing(db),
    "Base permission editing requires dune.permission_actor_rank, dune.map_names, and the dune.permission_set_player_rank/permission_remove_player_rank functions.");
  const target = intParam(baseId, "base id", 1);
  const safeMax = intParam(maxPermissionsPerActor, "maximum permissions per base", 1, 2147483647);
  // Validate before opening the transaction too, so malformed input fails
  // without taking a claim lock. It is normalized again after the lock because
  // the shared mutation path also accepts a roster built from current state.
  const desired = normalizeDesiredPermissions(entries);
  return mutateBasePermissions(db, target, safeMax, async () => desired);
}

export async function transferBaseToSystemCustodian(db, baseId, maxPermissionsPerActor = DEFAULT_MAX_PERMISSIONS_PER_ACTOR) {
  await requireCapability(await supportsBasePermissionEditing(db),
    "Base permission editing requires dune.permission_actor_rank, dune.map_names, and the dune.permission_set_player_rank/permission_remove_player_rank functions.");
  const target = intParam(baseId, "base id", 1);
  const safeMax = intParam(maxPermissionsPerActor, "maximum permissions per base", 1, 2147483647);
  let custodian;
  const result = await mutateBasePermissions(db, target, safeMax, async (existing, tx) => {
    custodian = await basePermissionSystemCustodian(tx);
    if (!custodian.available) throw new Error(custodian.reason);
    const roster = existing.map((row) => ({
      playerId: String(row.player_id),
      rank: Number(row.rank) === PERMISSION_OWNER_RANK ? 2 : Number(row.rank)
    }));
    const currentCustodian = roster.find((entry) => entry.playerId === custodian.playerId);
    if (currentCustodian) currentCustodian.rank = PERMISSION_OWNER_RANK;
    else roster.push({ playerId: custodian.playerId, rank: PERMISSION_OWNER_RANK });
    return roster;
  });
  return {
    ...result,
    systemCustodian: custodian,
    message: result.reranked === 0 && result.added === 0
      ? `This base is already owned by the ${custodian.name} system custodian.`
      : `Ownership was transferred to the ${custodian.name} system custodian. The change applies to the running map immediately.`
  };
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

export async function listBases(db, { q = "", page = 0, pageSize = 50, sortColumn = "name", sortDirection = "asc", includeGenerators = true } = {}) {
  const requiredTables = ["buildings", "building_instances", "actor_fgl_entities", "actors"];
  // One round-trip each and none of them depends on another, so probe them
  // together rather than five times in series before any real work starts.
  const [required, hasWorldPartition, hasBaseBackups] = await Promise.all([
    Promise.all(requiredTables.map((table) => tableExists(db, table))),
    tableExists(db, "world_partition"),
    tableExists(db, "base_backup_linked_actors")
  ]);
  if (required.some((exists) => !exists)) {
    return { ...unsupported("bases", requiredTables.map((t) => `dune.${t}`)), totalCount: 0, totalBases: 0, totalPieces: 0, totalPlaceables: 0 };
  }
  // The base-backup tool ("pick up base") does not move or delete any of a
  // base's rows -- it only deletes permission_actor/permission_actor_rank
  // (unclaiming it) and registers its actor ids in base_backup_linked_actors
  // so it can be redeployed later. Left un-filtered, a picked-up base still
  // has every buildings/building_instances/placeables row intact and would
  // show up here as an ordinary, ownerless base. Both signals are required
  // -- unclaimed AND backup-linked -- rather than either alone: "unclaimed"
  // by itself would also hide a base that legitimately has no owner for some
  // other reason, and "backup-linked" by itself would hide a base again once
  // redeployed if the game doesn't clean up old linked-actor rows on redeploy
  // (unconfirmed either way). A base satisfying both is unambiguous.
  const backupExclusion = hasBaseBackups
    ? "and not (pa.actor_id is null and exists (select 1 from dune.base_backup_linked_actors bbla where bbla.actor_id = a.id))"
    : "";
  // What counts as a base, defined once. The paged query (`matched`) and the
  // totals query (`valid_claims`) run in separate round trips but must agree
  // exactly on the candidate set -- if they diverge, total_bases/total_pieces/
  // total_placeables silently stop describing the rows actually being listed.
  // Emitting both from here makes that divergence unrepresentable rather than
  // merely tested for. `extraJoin` is the one sanctioned variation: `matched`
  // needs the owner LATERAL joined before its group-by when searching or
  // sorting by owner, and that join cannot affect which rows qualify (it is a
  // LEFT JOIN LATERAL ... ON TRUE returning at most one row).
  const baseCandidateSource = (extraJoin = "") => `
        from dune.buildings b
        join dune.building_instances bi on bi.building_id = b.id
        join dune.actor_fgl_entities afe on afe.entity_id = bi.owner_entity_id
        join dune.actors a on a.id = afe.actor_id
        left join dune.permission_actor pa on pa.actor_id = a.id
        ${extraJoin}
        where a.transform is not null
        ${backupExclusion}`;
  // A base's own a.map is the game's map name ("HaggaBasin"), which cannot tell
  // two instances of it apart. world_partition resolves the partition to the
  // name the rest of the console uses ("Survival_1") plus its dimension --
  // together, the identity of one running instance. Optional table: without it
  // the fields come back empty rather than the query failing.
  const partitionSelect = hasWorldPartition
    ? "coalesce(wp.map, '') as partition_map, coalesce(wp.dimension_index, 0) as dimension_index,"
    : "'' as partition_map, 0 as dimension_index,";
  const partitionJoin = hasWorldPartition
    ? "left join dune.world_partition wp on wp.partition_id = p.partition_id"
    : "";
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
    sortSpec.pieces ? "(select count(*) from dune.building_instances count_bi join dune.actor_fgl_entities count_afe on count_afe.entity_id = count_bi.owner_entity_id where count_afe.actor_id = a.id)::int as piece_count" : "",
    sortSpec.placeables ? "(select count(distinct count_pl.id) from dune.placeables count_pl join dune.actor_fgl_entities count_afe on count_afe.entity_id = count_pl.owner_entity_id where count_afe.actor_id = a.id)::int as placeable_count" : "",
    sortSpec.shared ? "(select count(*) from dune.permission_actor_rank count_par where count_par.permission_actor_id = a.id and count_par.rank <> 1)::int as shared_count" : ""
  ].filter(Boolean).join(",\n               ");
  const pagedOrder = [...sortSpec.order, ...(sortSpec.order.includes("id") ? [] : ["id"])].map((column) => `${column} ${safeSortDirection}`).join(", ");
  const finalPieceCount = sortSpec.pieces ? "p.piece_count" : "(select count(*) from dune.building_instances bi join dune.actor_fgl_entities piece_afe on piece_afe.entity_id = bi.owner_entity_id where piece_afe.actor_id = p.actor_id)::int";
  const finalPlaceableCount = sortSpec.placeables ? "p.placeable_count" : "(select count(distinct pl.id) from dune.placeables pl join dune.actor_fgl_entities placeable_afe on placeable_afe.entity_id = pl.owner_entity_id where placeable_afe.actor_id = p.actor_id)::int";

  try {
    const result = await db.query(`
      with matched as (
        -- Recovery/staking can split one claimed base across several buildings rows.
        -- The claim actor is the stable logical base; retain the oldest member id for URLs.
        select min(b.id) as id,
               a.id as actor_id,
               max(bi.owner_entity_id) as owner_entity_id,
               ${BASE_NAME_SQL} as name,
               ${BASE_TYPE_SQL} as base_type,
               ${matchedOwnerSelect}coalesce(a.map, '') as map,
               coalesce(a.partition_id, 0) as partition_id,
               a.transform,
               ${matchedSortSelect}
        ${baseCandidateSource(matchedOwnerJoin)}
        group by a.id, a.class, pa.actor_name, ${matchedGroupByOwner}a.map, a.partition_id, a.transform
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
             p.partition_id,
             ${partitionSelect}
             p.x,
             p.y,
             p.z,
             p.total_count,
             ${finalPieceCount} as piece_count,
             ${finalPlaceableCount} as placeable_count,
             coalesce(shared.entries, '[]'::jsonb) as shared_with
      from paged p
      ${partitionJoin}
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
      with valid_claims as (
        select distinct a.id as actor_id
        ${baseCandidateSource()}
      )
      select (select count(*) from valid_claims)::int as total_bases,
             (select count(*) from dune.building_instances bi join dune.actor_fgl_entities afe on afe.entity_id = bi.owner_entity_id join valid_claims vc on vc.actor_id = afe.actor_id)::int as total_pieces,
             (select count(distinct pl.id) from dune.placeables pl join dune.actor_fgl_entities afe on afe.entity_id = pl.owner_entity_id join valid_claims vc on vc.actor_id = afe.actor_id)::int as total_placeables`);

    // Callers that already resolve generator fuel themselves (the Discord
    // player portal) opt out so the CTE does not run twice per request.
    let generatorDataAvailable = false;
    let fuelByBase = new Map();
    if (includeGenerators) {
      try {
        fuelByBase = await portalGeneratorFuel(db, result.rows.map((row) => row.base_id));
        generatorDataAvailable = true;
      } catch (error) {
        // Keep the base list usable, but do not misrepresent a failed query as
        // proof that every base has no generators.
        console.warn(`Base generator data unavailable: ${error?.message || "Unexpected error."}`);
      }
    }

    // Probed here rather than per row so the panel can disable Refill outright
    // instead of failing on click. These three don't depend on each other, so
    // they run concurrently rather than as three sequential round-trip chains
    // on this hot list/search/sort/page endpoint.
    //
    // basePermissions: probed the same way and for the same reason as
    // generatorRefill -- without the shipped permission procedures the panel
    // hides the editor rather than offering a control that fails on save.
    //
    // waterRefill: gated on supportsWaterRefill rather than
    // supportsGeneratorRefill: water refill needs none of the item-insert
    // columns the generator capability check requires, so reusing that check
    // would wrongly hide Refill Water on a schema that has everything water
    // actually needs.
    const [generatorRefill, basePermissions, waterRefill, baseDelete] = await Promise.all([
      supportsGeneratorRefill(db).catch(() => false),
      supportsBasePermissionEditing(db).catch(() => false),
      supportsWaterRefill(db).catch(() => false),
      supportsBaseDelete(db).catch(() => false)
    ]);
    // Without world_partition the console cannot tell a running map from a
    // stopped one, so the panel hides the queue entirely and refills/deletes
    // stay immediate. Each check reuses the flag just computed above instead
    // of re-deriving it, and all run concurrently for the same reason as above.
    const [generatorRefillQueue, waterRefillQueue, baseDeleteQueue] = await Promise.all([
      generatorRefill ? supportsGeneratorRefillQueue(db, { generatorRefill }).catch(() => false) : Promise.resolve(false),
      waterRefill ? supportsWaterRefillQueue(db, { waterRefill }).catch(() => false) : Promise.resolve(false),
      baseDelete ? supportsBaseDeleteQueue(db, { baseDelete }).catch(() => false) : Promise.resolve(false)
    ]);

    return {
      capabilities: { bases: true, generatorRefill, generatorRefillQueue, basePermissions, waterRefill, waterRefillQueue, baseDelete, baseDeleteQueue },
      totalCount: result.rows[0] ? Number(result.rows[0].total_count) : 0,
      totalBases: totalsResult.rows[0] ? Number(totalsResult.rows[0].total_bases) : 0,
      totalPieces: totalsResult.rows[0] ? Number(totalsResult.rows[0].total_pieces) : 0,
      totalPlaceables: totalsResult.rows[0] ? Number(totalsResult.rows[0].total_placeables) : 0,
      rows: result.rows.map(({ total_count, sort_position, ...row }) => ({
        ...row,
        partition_id: Number(row.partition_id || 0),
        partitionMap: String(row.partition_map || ""),
        dimensionIndex: Number(row.dimension_index || 0),
        x: Number(row.x),
        y: Number(row.y),
        z: Number(row.z),
        piece_count: Number(row.piece_count),
        placeable_count: Number(row.placeable_count),
        shared_with: (Array.isArray(row.shared_with) ? row.shared_with : []).map((entry) => ({
          name: entry.name,
          rank: entry.rank,
          label: permissionRankLabel(entry.rank)
        })),
        generatorDataAvailable,
        generatorCount: fuelByBase.get(String(row.base_id))?.generatorCount || 0,
        fuelCells: fuelByBase.get(String(row.base_id))?.fuelCells || 0,
        generatorRuntimeSeconds: fuelByBase.get(String(row.base_id))?.runtimeSeconds || 0,
        generatorUptimeMultiplier: fuelByBase.get(String(row.base_id))?.uptimeMultiplier || 1,
        generatorUptimeEventLabel: fuelByBase.get(String(row.base_id))?.uptimeEventLabel || "",
        generatorUptimeEventEndsAt: fuelByBase.get(String(row.base_id))?.uptimeEventEndsAt || "",
        generatorUnstockedCount: fuelByBase.get(String(row.base_id))?.unstockedCount || 0,
        generatorAllUnstocked: fuelByBase.get(String(row.base_id))?.allGeneratorsUnstocked || false,
        generators: fuelByBase.get(String(row.base_id))?.generators || []
      }))
    };
  } catch (error) {
    return { capabilities: { bases: false, generatorRefill: false }, rows: [], totalCount: 0, totalBases: 0, totalPieces: 0, totalPlaceables: 0, reason: `Base list query is unsupported by this schema: ${error.message}` };
  }
}

function quaternionYawDegrees(qz, qw) {
  return (2 * Math.atan2(Number(qz) || 0, Number(qw) || 0)) * (180 / Math.PI);
}

// Gates base deletion the same way supportsBasePermissionEditing gates
// permission edits. This repo has no migrations directory and never issues
// CREATE FUNCTION anywhere (every write path composes the game's own shipped
// procedures), so a self-hosted server missing these tables/functions cannot
// have a delete proc added for it -- it is simply unsupported.
async function supportsBaseDelete(db) {
  for (const table of ["buildings", "building_instances", "actor_fgl_entities", "placeables", "actors"]) {
    if (!(await tableExists(db, table))) return false;
  }
  return await functionExists(db, "dune.permission_actor_destroy(bigint)")
    && await functionExists(db, "dune.delete_actors(bigint[])");
}

// Mirrors supportsGeneratorRefillQueue: without dune.world_partition there is
// no way to tell a running map from a stopped one, so the panel hides the
// queue and deletes stay immediate rather than offering a control that
// silently risks a live server resurrecting the deleted rows.
export async function supportsBaseDeleteQueue(db, { baseDelete } = {}) {
  const supported = baseDelete !== undefined ? baseDelete : await supportsBaseDelete(db);
  if (!supported) return false;
  return tableExists(db, "world_partition");
}

// Every dune.actors row a full base delete must remove: the claim actor
// itself, every building's actor id (dune.buildings.id IS an actors.id, the
// same fact exportBaseAsBlueprint's piece query below relies on), and every
// placeable's actor id via its own owner_entity_id chain -- a separate FK
// path from building_instances', so it needs its own query. Deleting this
// full set is what lets the declared ON DELETE CASCADE foreign keys clean up
// buildings/building_instances/placeables/inventories/items on their own.
async function baseDeletionActorIds(db, baseId) {
  const actor = await basePermissionActor(db, baseId);
  const buildingRows = await db.query(`
    select distinct bi.building_id
    from dune.building_instances bi
    join dune.actor_fgl_entities afe on afe.entity_id = bi.owner_entity_id
    where afe.actor_id = $1::bigint`, [actor.actorId]);
  const placeableRows = await db.query(`
    select distinct p.id
    from dune.placeables p
    join dune.actor_fgl_entities afe on afe.entity_id = p.owner_entity_id
    where afe.actor_id = $1::bigint`, [actor.actorId]);
  const ids = new Set([
    actor.actorId,
    ...buildingRows.rows.map((row) => String(row.building_id)),
    ...placeableRows.rows.map((row) => String(row.id))
  ]);
  return {
    actor,
    actorIds: [...ids],
    buildingCount: buildingRows.rowCount,
    placeableCount: placeableRows.rowCount
  };
}

// Permanently deletes a base and everything on it. A destructive, irreversible
// operation, so every statement here must succeed together or not at all --
// db.transaction already rolls back on any thrown error (see db.js), so this
// is a straightforward wrap rather than new plumbing, made an explicit,
// tested guarantee here because unlike most callers of db.transaction, a
// partial failure of this one cannot be retried against player-recoverable
// state. The caller (server.js) is responsible for the mandatory pre-delete
// safety backup -- kept out of this file, which never shells out to the
// `dune` CLI the way runner.js's backupCreate does.
export async function deleteBaseCompletely(db, baseId) {
  await requireCapability(await supportsBaseDelete(db),
    "Base deletion requires dune.buildings, building_instances, actor_fgl_entities, placeables, actors, and the dune.permission_actor_destroy(bigint)/delete_actors(bigint[]) functions.");
  const target = intParam(baseId, "base id", 1);
  return db.transaction(async (tx) => {
    await tx.query("set local search_path to dune, public");
    // Re-enumerated inside the transaction, not reused from an earlier
    // read: never trust a snapshot from when the confirm dialog opened or
    // the delete was queued, the same discipline the refill queue already
    // applies to amounts.
    const { actor, actorIds, buildingCount, placeableCount } = await baseDeletionActorIds(tx, target);
    // Lock the claim actor row, not a maybe-empty child row -- same reasoning
    // as mutateBasePermissions: it is guaranteed to exist, and `for update`
    // over zero rows would serialize nothing.
    const locked = await tx.query("select id from dune.actors where id = $1::bigint for update", [actor.actorId]);
    if (!locked.rowCount) throw new Error("That base was not found.");
    // permission_actor_destroy first: it is the only thing that clears
    // markers/player_markers, which are keyed on the claim actor id but not
    // FK-cascaded from actors (only from map_names). Its permission_actor/
    // permission_actor_rank deletes are redundant with the cascade that
    // follows, but a DELETE matching zero rows is a harmless no-op.
    await tx.query("select dune.permission_actor_destroy($1::bigint)", [actor.actorId]);
    // Cascades away buildings, building_instances, placeables, inventories,
    // and items via their declared ON DELETE CASCADE foreign keys.
    await tx.query("select dune.delete_actors($1::bigint[])", [actorIds]);
    return {
      ok: true,
      baseId: target,
      actorId: actor.actorId,
      map: actor.map,
      partitionId: actor.partitionId,
      deletedActorCount: actorIds.length,
      deletedBuildingCount: buildingCount,
      deletedPlaceableCount: placeableCount
    };
  });
}

export async function exportBaseAsBlueprint(db, id) {
  const baseId = intParam(id, "base id", 1);
  const requiredTables = ["buildings", "building_instances", "actor_fgl_entities", "actors"];
  for (const table of requiredTables) {
    await requireCapability(await tableExists(db, table), `Base export requires dune.${requiredTables.join(", dune.")}.`);
  }
  const baseRow = await db.query(`
    with target_claim as (
      select distinct a.id as actor_id
      from dune.buildings b
      join dune.building_instances requested_bi on requested_bi.building_id = b.id
      join dune.actor_fgl_entities requested_afe on requested_afe.entity_id = requested_bi.owner_entity_id
      join dune.actors a on a.id = requested_afe.actor_id
      where b.id = $1
    )
    select min(b.id)::text as base_id,
           ${BASE_NAME_SQL} as name,
           ${BASE_TYPE_SQL} as base_type,
           coalesce(owner.character_name, '') as owner_name,
           coalesce(a.map, '') as map,
           ((a.transform).location).x as x,
           ((a.transform).location).y as y,
           ((a.transform).location).z as z,
           max(bi.owner_entity_id) as owner_entity_id,
           a.id::text as actor_id
    from target_claim tc
    join dune.actors a on a.id = tc.actor_id
    join dune.actor_fgl_entities afe on afe.actor_id = a.id
    join dune.building_instances bi on bi.owner_entity_id = afe.entity_id
    join dune.buildings b on b.id = bi.building_id
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
    group by pa.actor_name, owner.character_name, a.id, a.class, a.map, a.transform`, [baseId]);
  if (!baseRow.rows.length) {
    // The query above inner-joins all the way to a resolved actor -- it can't
    // usefully left-join instead, since a blueprint needs real, resolved piece
    // data to export. So distinguishing "doesn't exist" from "exists but its
    // owner-entity link is broken" (building_instances.owner_entity_id is
    // nullable) takes a cheap follow-up existence check instead, the same
    // distinction basePermissionActor and baseMapLocation make for their
    // simpler single-row queries.
    const exists = await db.query("select 1 from dune.buildings where id = $1", [baseId]);
    if (exists.rows.length) throw new UnsupportedCapabilityError(`Base ${baseId} has no resolvable owner entity, so it cannot be exported.`);
    throw new UnsupportedCapabilityError(`Base ${baseId} was not found.`);
  }
  const base = baseRow.rows[0];
  const anchor = { x: Number(base.x), y: Number(base.y), z: Number(base.z) };

  // Blueprint import (blueprints.js) expects positions relative to a capture origin and a single
  // yaw-degree rotation for instances, not the live tables' absolute world coords + quaternion.
  // The anchor point is arbitrary (the base's own actor position) but consistent, so the exported
  // pieces stay correctly positioned relative to each other when re-placed anywhere in-game.
  // Rotation is captured yaw-only since every sampled live piece has qx=qy=0; pitch/roll on
  // tilted geometry, if any exists, is lost. Native Solido placeable transforms store that yaw
  // in their second rotation slot (ry), despite the live actor quaternion rotating around Z.
  const pieceRows = await db.query(`
    select bi.building_id, bi.instance_id, bi.building_type, bi.transform
    from dune.building_instances bi
    join dune.actor_fgl_entities afe on afe.entity_id = bi.owner_entity_id
    where afe.actor_id = $1
    order by bi.building_id, bi.instance_id`, [base.actor_id]);
  const seenInstanceIds = new Set();
  // instance_id is scoped to an internal buildings row. Combined claim exports can therefore
  // contain collisions; only remap when necessary so ordinary single-part exports stay stable.
  const remapInstanceIds = pieceRows.rows.some((row) => {
    const instanceId = Number(row.instance_id);
    if (!Number.isSafeInteger(instanceId) || instanceId < 0 || seenInstanceIds.has(instanceId)) return true;
    seenInstanceIds.add(instanceId);
    return false;
  });
  const instances = pieceRows.rows.map((row, index) => {
    const t = row.transform || [];
    return {
      instance_id: remapInstanceIds ? index : row.instance_id,
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
        join dune.actor_fgl_entities afe on afe.entity_id = p.owner_entity_id
        where afe.actor_id = $1
          and a.transform is not null
          and lower(coalesce(p.building_type, '')) not in ('totem_small_placeable', 'totem_placeable')
        order by p.id`, [base.actor_id])
    : { rows: [] };
  // Keep the JS guard as a second boundary in case a future schema/query path
  // bypasses or changes the SQL predicate. A Solido blueprint must never carry
  // the live base's claim console: projecting it can create a second malformed
  // claim inside the destination fief.
  const placeables = placeableRows.rows.filter((row) => !isFiefClaimPlaceable(row.building_type)).map((row) => ({
    placeable_id: row.placeable_id,
    building_type: row.building_type,
    x: Number(row.x) - anchor.x,
    y: Number(row.y) - anchor.y,
    z: Number(row.z) - anchor.z,
    rx: 0,
    ry: quaternionYawDegrees(row.qz, row.qw),
    rz: 0
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
    where p.building_type in ('SpiceSilo_Placeable','GenericContainer_Placeable','StorageContainer_Placeable','MediumStorageContainer_Placeable','Developer_StorageContainer_Placeable')
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

async function restoreEarnedFactionProgression(db, player, factionId, journeyTagsData = {}) {
  const empty = { tagsAdded: [], tierBefore: null, tierAfter: null };
  if (factionId !== 1 && factionId !== 2) return empty;
  const progressionSchema = await journeyIdentitySchema(db);
  if (!progressionSchema) return empty;
  const factionName = factionId === 1 ? "Atreides" : "Harkonnen";
  const tagIdColumn = quoteIdentifier(progressionSchema.tagIdColumn);
  const journeyIdColumn = quoteIdentifier(progressionSchema.journeyIdColumn);
  const tagIdentityId = playerJourneyIdentity(player, progressionSchema.tagIdColumn);
  const journeyIdentityId = playerJourneyIdentity(player, progressionSchema.journeyIdColumn);
  const tags = await db.query(`select tag from dune.player_tags where ${tagIdColumn} = $1`, [tagIdentityId]);
  const existingTags = tags.rows.map((row) => String(row.tag || ""));
  const nodes = await db.query(`
    select story_node_id
    from dune.journey_story_node
    where ${journeyIdColumn} = $1
      and complete_condition_state = 'true'::jsonb
      and story_node_id like 'DA_FQ_ClimbTheRanks.%'`, [journeyIdentityId]);
  const completedNodeIds = nodes.rows.map((row) => String(row.story_node_id || ""));
  const plan = factionProgressionRepairPlan(existingTags, factionName, completedNodeIds, journeyTagsData);
  if (plan.missingTags.length) {
    const inserted = await db.query(`
      insert into dune.player_tags (${tagIdColumn}, tag)
      select $1, incoming.tag
      from unnest($2::text[]) as incoming(tag)
      where not exists (
        select 1 from dune.player_tags existing
        where existing.${tagIdColumn} = $1 and existing.tag = incoming.tag
      )
      returning tag`, [tagIdentityId, plan.missingTags]);
    const insertedTags = new Set(inserted.rows.map((row) => String(row.tag || "")));
    const notInserted = plan.missingTags.filter((tag) => !insertedTags.has(tag));
    if (notInserted.length) throw new Error(`Faction progression repair could not verify tag(s): ${notInserted.join(", ")}`);
  }
  return { tagsAdded: plan.missingTags, tierBefore: plan.currentTier, tierAfter: plan.earnedTier };
}

export async function addFactionReputation(db, id, { factionId, amount }, journeyTagsData = {}) {
  await requireCapability(await supportsFactionMutation(db), "Faction reputation mutation requires dune.player_faction_reputation, dune.actors.properties, and dune.set_player_faction_reputation(bigint,smallint,integer).");
  const faction = intParam(factionId, "faction id", 1, 32767);
  const delta = intParam(amount, "faction reputation amount", -12474, 12474);
  if (delta === 0) throw new Error("Faction reputation amount cannot be zero");
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    requireOfflinePlayer(player, "Faction reputation changes");
    const current = await tx.query(`
      select reputation_amount
      from dune.player_faction_reputation
      where actor_id = $1 and faction_id = $2`, [player.controllerId, faction]);
    const oldValue = Number(current.rows[0]?.reputation_amount || 0);
    const nextValue = Math.max(0, Math.min(12474, oldValue + delta));
    await tx.query("select dune.set_player_faction_reputation($1::bigint, $2::smallint, $3::integer)", [player.controllerId, faction, nextValue]);
    const progressionRepair = await restoreEarnedFactionProgression(tx, player, faction, journeyTagsData);
    if (faction === 1 || faction === 2) await syncFactionComponent(tx, player.controllerId);
    const estimatedRank = faction === 1 || faction === 2 ? factionReputationEstimatedRank(nextValue) : null;
    let currentRankLimit = null;
    const progressionSchema = estimatedRank !== null ? await journeyIdentitySchema(tx) : null;
    if (estimatedRank !== null && progressionSchema) {
      const factionName = faction === 1 ? "Atreides" : "Harkonnen";
      const tagIdColumn = quoteIdentifier(progressionSchema.tagIdColumn);
      const tagIdentityId = playerJourneyIdentity(player, progressionSchema.tagIdColumn);
      const tags = await tx.query(`
        select tag
        from dune.player_tags
        where ${tagIdColumn} = $1
          and tag like $2`, [tagIdentityId, `Faction.${factionName}.Tier%`]);
      const progressionLimit = factionProgressionRankLimit(tags.rows.map((row) => row.tag), factionName);
      if (progressionLimit !== null && estimatedRank > progressionLimit) currentRankLimit = progressionLimit;
    }
    const rankMessage = estimatedRank === null
      ? ""
      : currentRankLimit === null
        ? ` Estimated Rank: ${estimatedRank}.`
        : ` Estimated Rank: ${estimatedRank}. Current Rank Limit: ${currentRankLimit} until the required faction story progression is completed.`;
    return {
      ok: true,
      player,
      factionId: faction,
      actorId: player.controllerId,
      oldValue,
      newValue: nextValue,
      estimatedRank,
      currentRankLimit,
      progressionTagsAdded: progressionRepair.tagsAdded,
      message: `Faction reputation and vendor access were synchronized at ${nextValue}.${rankMessage} They will be loaded when the player next joins.`
    };
  });
}

export async function repairFactionReputation(db, id, journeyTagsData = {}) {
  await requireCapability(await supportsFactionMutation(db) && await tableExists(db, "player_faction"), "Faction reputation repair requires dune.player_faction_reputation, dune.player_faction, dune.actors.properties, and dune.set_player_faction_reputation(bigint,smallint,integer).");
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    requireOfflinePlayer(player, "Faction reputation repair");
    const alignment = await tx.query(`
      select faction_id
      from dune.player_faction
      where actor_id = $1
      for update`, [player.controllerId]);
    const factionId = Number(alignment.rows[0]?.faction_id || 3);
    if (factionId !== 1 && factionId !== 2) {
      throw new Error("Faction reputation repair requires the player to be assigned to Atreides or Harkonnen first.");
    }
    const progressionRepair = await restoreEarnedFactionProgression(tx, player, factionId, journeyTagsData);
    const payload = await syncFactionComponent(tx, player.controllerId);
    const progressionMessage = progressionRepair.tagsAdded.length
      ? ` Restored earned faction story progression from Tier ${progressionRepair.tierBefore} through Tier ${progressionRepair.tierAfter}.`
      : " No missing earned faction story progression was detected.";
    return {
      ok: true,
      player,
      factionId,
      reputations: Object.fromEntries(payload.map((entry) => [entry.Faction.Name, entry.ReputationAmount])),
      progressionTagsAdded: progressionRepair.tagsAdded,
      progressionTierBefore: progressionRepair.tierBefore,
      progressionTierAfter: progressionRepair.tierAfter,
      message: `Faction reputation was synchronized.${progressionMessage} The player can log in now.`
    };
  });
}

const PLAYER_ASSIGNABLE_FACTIONS = Object.freeze({
  1: "Atreides",
  2: "Harkonnen",
  3: "Neutral"
});

export async function setPlayerFaction(db, id, { factionId }) {
  await requireCapability(
    await supportsPlayerFactionAssignment(db),
    "Faction assignment requires dune.player_faction and dune.change_player_faction(bigint,smallint,smallint,timestamp without time zone)."
  );
  const faction = intParam(factionId, "faction id", 1, 3);
  if (!Object.hasOwn(PLAYER_ASSIGNABLE_FACTIONS, faction)) throw new Error("Faction must be Atreides, Harkonnen, or Neutral");

  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    const current = await tx.query(`
      select faction_id
      from dune.player_faction
      where actor_id = $1
      for update`, [player.controllerId]);
    const oldFactionId = Number(current.rows[0]?.faction_id || 3);
    if (oldFactionId === faction) {
      return {
        ok: true,
        changed: false,
        player,
        oldFactionId,
        factionId: faction,
        faction: PLAYER_ASSIGNABLE_FACTIONS[faction],
        message: `Player is already assigned to ${PLAYER_ASSIGNABLE_FACTIONS[faction]}.`
      };
    }

    await tx.query(
      "select dune.change_player_faction($1::bigint, $2::smallint, 3::smallint, now()::timestamp)",
      [player.controllerId, faction]
    );
    // The shipped game function applies normal guild compatibility rules. Keep the
    // console's existing database-editor behavior for guild leaders by re-pledging
    // their guild to the newly selected House after the game breaks old allegiance.
    await pledgeGuildAdminFactionIfNeeded(tx, player.controllerId, faction);

    return {
      ok: true,
      changed: true,
      player,
      oldFactionId,
      oldFaction: PLAYER_ASSIGNABLE_FACTIONS[oldFactionId] || `Faction ${oldFactionId}`,
      factionId: faction,
      faction: PLAYER_ASSIGNABLE_FACTIONS[faction],
      message: `Player faction changed from ${PLAYER_ASSIGNABLE_FACTIONS[oldFactionId] || `Faction ${oldFactionId}`} to ${PLAYER_ASSIGNABLE_FACTIONS[faction]}.`
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
    // Do not issue a misleading no-op write once the spendable balance is
    // already full. The response below reports the amount actually applied.
    if (applied > 0) {
      await tx.query(`
        update dune.actors
        set properties = jsonb_set(properties, '{TechKnowledgePlayerComponent,m_TechKnowledgePoints}', to_jsonb($2::bigint))
        where id = $1 and properties ? 'TechKnowledgePlayerComponent'`, [player.actorId, nextValue]);
    }
    return {
      ok: true,
      player,
      oldValue,
      newValue: nextValue,
      amount: applied,
      requestedAmount: delta,
      maxValue: MAX_INTEL_POINTS,
      capped: applied < delta,
      message: applied === 0
        ? `No Intel was added because the player is already at the spendable cap of ${MAX_INTEL_POINTS}.`
        : applied < delta
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

export function adminItemMetadata() {
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

// Map area_id -> sub-region name, keyed by dune.actors.map. Sourced from the game
// client paks (see runtime/data/hagga-regions.json); the area_id space matches
// dune.markers.area_id, so a vehicle is labelled by the nearest marker's area.
function mapRegionNames() {
  if (mapRegionNamesCache) return mapRegionNamesCache;
  let data = {};
  try {
    const path = [
      resolve(process.cwd(), "runtime/data/hagga-regions.json"),
      resolve(process.cwd(), "../../runtime/data/hagga-regions.json")
    ].find((candidate) => existsSync(candidate)) || resolve(process.cwd(), "runtime/data/hagga-regions.json");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    for (const [map, areas] of Object.entries(parsed)) {
      if (!areas || typeof areas !== "object" || Array.isArray(areas)) continue;
      const byId = new Map();
      for (const [areaId, name] of Object.entries(areas)) {
        const id = Number(areaId);
        if (Number.isInteger(id) && typeof name === "string" && name) byId.set(id, name);
      }
      if (byId.size) data[map] = byId;
    }
  } catch {
    // Region labelling is optional; vehicles still list without it.
    data = {};
  }
  mapRegionNamesCache = data;
  return mapRegionNamesCache;
}

// Attach a `region` name to each vehicle row whose map has a region table, using
// the area of the nearest marker. Best-effort: silently no-ops when the markers/
// map_names tables are absent (region stays undefined). Mutates `rows` in place.
async function attachVehicleRegions(db, rows) {
  const regionTable = mapRegionNames();
  const eligible = rows.filter((row) => regionTable[row.map] && row.x !== null && row.x !== undefined && row.y !== null && row.y !== undefined);
  if (!eligible.length) return;
  if (!(await tableExists(db, "markers")) || !(await tableExists(db, "map_names"))) return;

  const byMap = new Map();
  for (const row of eligible) {
    if (!byMap.has(row.map)) byMap.set(row.map, []);
    byMap.get(row.map).push(row);
  }

  for (const [map, mapRows] of byMap) {
    const mapNameResult = await db.query("select map_name_id from dune.map_names where map_name = $1 limit 1", [map]);
    const mapNameId = mapNameResult.rows[0] ? Number(mapNameResult.rows[0].map_name_id) : null;
    if (mapNameId === null || Number.isNaN(mapNameId)) continue;

    const values = [mapNameId];
    const tuples = mapRows.map((row) => {
      values.push(String(row.id), Number(row.x), Number(row.y));
      const base = values.length;
      return `($${base - 2}::bigint, $${base - 1}::numeric, $${base}::numeric)`;
    }).join(", ");

    const result = await db.query(`
      select p.id::text id, near.area_id
      from (values ${tuples}) p(id, vx, vy)
      cross join lateral (
        select m.area_id
        from dune.markers m
        where m.map_name_id = $1 and m.area_id <> 0 and (m.marker).x is not null
        order by power((m.marker).x - p.vx, 2) + power((m.marker).y - p.vy, 2)
        limit 1
      ) near`, values);

    const areaById = new Map(result.rows.map((r) => [String(r.id), Number(r.area_id)]));
    const names = regionTable[map];
    for (const row of mapRows) {
      const areaId = areaById.get(String(row.id));
      if (areaId !== undefined && names.has(areaId)) row.region = names.get(areaId);
    }
  }
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
  const playerRecipes = await db.query(`
    with player_recipes as (
      select distinct recipe->'BaseRecipeId'->>'Name' as recipe_id
      from dune.actors a
      cross join lateral jsonb_array_elements(coalesce(a.properties->'CraftingRecipesLibraryActorComponent'->'m_KnownItemRecipes', '[]'::jsonb)) recipe
      where a.id = $1 and recipe->'BaseRecipeId'->>'Name' is not null
    )
    select recipe_id from player_recipes`, [player.actorId]);
  const unlockedRecipes = new Set(playerRecipes.rows.map((row) => String(row.recipe_id || "")).filter(Boolean));
  return {
    capabilities: { researchItems: true },
    player,
    rows: result.rows.map((row) => {
      const recipeId = linkedResearchRecipeId(row.item_key);
      const researchPurchased = row.unlocked_state === "Purchased";
      const recipeUnlocked = !recipeId || unlockedRecipes.has(recipeId);
      return {
        itemKey: row.item_key,
        displayName: researchDisplayName(row.item_key),
        category: researchCategory(row.item_key),
        productGroup: researchProductGroup(row.item_key, researchCategory(row.item_key)),
        type: researchType(row.item_key),
        unlockedState: row.unlocked_state || "Unknown",
        isNew: Boolean(row.is_new),
        recipeId,
        recipeUnlocked,
        researchPurchased,
        actionable: Boolean(recipeId),
        needsRecipeRepair: Boolean(recipeId && researchPurchased && !recipeUnlocked),
        unlocked: researchPurchased && recipeUnlocked
      };
    })
  };
}

export async function playerBuildingUnlockState(db, id) {
  const player = await resolvePlayerMutationTarget(db, id);
  const progressionColumns = await tableExists(db, "building_progression") ? await columnsFor(db, "building_progression") : new Set();
  const inventoryColumns = await tableExists(db, "inventories") ? await columnsFor(db, "inventories") : new Set();
  const itemColumns = await tableExists(db, "items") ? await columnsFor(db, "items") : new Set();
  const progressionSupported = ["character_id", "learned_building_sets", "new_buildable_pieces"].every((column) => progressionColumns.has(column));
  const inventorySupported = ["id", "actor_id"].every((column) => inventoryColumns.has(column)) &&
    ["inventory_id", "template_id"].every((column) => itemColumns.has(column));
  if (!progressionSupported) {
    return {
      capabilities: { buildingUnlockOwnership: false, buildingUnlockPending: inventorySupported },
      player,
      owned: [],
      pending: []
    };
  }

  const progression = player.playerStateId ? await db.query(`
    select coalesce(learned_building_sets, '{}'::text[]) as learned_building_sets,
           coalesce(new_buildable_pieces, '{}'::text[]) as new_buildable_pieces
    from dune.building_progression
    where character_id = $1
    limit 1`, [player.playerStateId]) : { rows: [] };
  const row = progression.rows[0] || {};
  const owned = [...new Set([
    ...(Array.isArray(row.learned_building_sets) ? row.learned_building_sets : []),
    ...(Array.isArray(row.new_buildable_pieces) ? row.new_buildable_pieces : [])
  ].map(String).filter(Boolean))];

  let pending = [];
  if (inventorySupported) {
    const pendingResult = await db.query(`
      select distinct i.template_id
      from dune.inventories inv
      join dune.items i on i.inventory_id = inv.id
      where inv.actor_id = $1
        and i.template_id is not null`, [player.actorId]);
    pending = pendingResult.rows.map((item) => String(item.template_id || "")).filter(Boolean);
  }

  return {
    capabilities: { buildingUnlockOwnership: true, buildingUnlockPending: inventorySupported },
    player,
    owned,
    pending
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
    const recipeId = linkedResearchRecipeId(safeItemKey);
    if (!recipeId) {
      throw new Error(`Research group ${safeItemKey} cannot be unlocked directly because it does not identify one build recipe. Unlock its individual Recipe or Building entries instead.`);
    }
    const recipe = await materializeResearchCraftingRecipe(tx, player.actorId, recipeId);
    await tx.query(`
      update dune.actors
      set properties = jsonb_set(properties, '{TechKnowledgePlayerComponent,m_TechKnowledge,m_TechKnowledgeData}', $2::jsonb, true)
      where id = $1 and properties ? 'TechKnowledgePlayerComponent'`, [player.actorId, JSON.stringify(nextItems)]);
    return {
      ok: true,
      player,
      itemKey: safeItemKey,
      alreadyUnlocked,
      recipeId,
      recipeMaterialized: recipe.recipeUnlocked,
      recipeAdded: recipe.recipeAdded,
      repairedRecipe: Boolean(alreadyUnlocked && recipe.recipeAdded)
    };
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

function portalMarketEntry(entry, extra = {}) {
  return {
    orderId: String(entry?.orderId || ""),
    templateId: String(entry?.templateId || ""),
    displayName: String(entry?.displayName || ""),
    qualityLevel: String(entry?.qualityLevel || ""),
    itemPrice: String(entry?.itemPrice || ""),
    stackSize: String(entry?.stackSize || ""),
    maxUnitPrice: String(entry?.maxUnitPrice || ""),
    resultCode: Number.isInteger(entry?.resultCode) ? entry.resultCode : -1,
    resultLabel: String(entry?.resultLabel || "unknown"),
    detail: String(entry?.detail || ""),
    ...extra
  };
}

function portalMarketForIdentity(identity, market) {
  if (!market || typeof market !== "object") return null;
  const ownerIds = new Set([identity.actor_id, identity.controller_id, identity.account_id]
    .map((value) => String(value || ""))
    .filter(Boolean));
  const owns = (entry) => ownerIds.has(String(entry?.sellerActorId || ""));
  const matchingListings = (Array.isArray(market.listings) ? market.listings : []).filter(owns);
  const listings = matchingListings.slice(0, 250).map((entry) => portalMarketEntry(entry));
  const history = [];
  for (const batch of Array.isArray(market.batches) ? market.batches : []) {
    for (const entry of Array.isArray(batch?.entries) ? batch.entries : []) {
      if (!owns(entry)) continue;
      history.push(portalMarketEntry(entry, {
        at: String(batch.at || ""),
        source: String(batch.source || "")
      }));
      if (history.length >= 100) break;
    }
    if (history.length >= 100) break;
  }
  return {
    available: market.available === true,
    configured: market.configured === true,
    enabled: market.enabled === true,
    exchangeId: String(market.exchangeId || ""),
    buybackPercent: Number(market.buybackPercent) || 0,
    buybackPriceBasis: String(market.buybackPriceBasis || ""),
    maxBuys: Number(market.maxBuys) || 0,
    evaluatedAt: String(market.evaluatedAt || ""),
    listings,
    listingsTruncated: matchingListings.length > listings.length,
    history
  };
}

function portalExchangeOverview(market) {
  if (!market || typeof market !== "object") return null;
  const groups = new Map();
  for (const entry of Array.isArray(market.listings) ? market.listings : []) {
    const templateId = String(entry?.templateId || "");
    const displayName = String(entry?.displayName || templateId || "Unknown Item");
    const key = `${templateId}\u0000${String(entry?.qualityLevel || "")}`;
    const price = Number(entry?.itemPrice);
    const quantity = Math.max(0, Number(entry?.stackSize) || 0);
    if (!Number.isFinite(price) || price < 0) continue;
    const row = groups.get(key) || {
      templateId,
      displayName,
      qualityLevel: String(entry?.qualityLevel || ""),
      listingCount: 0,
      totalUnits: 0,
      lowestPrice: price,
      highestPrice: price,
      maxUnitPrice: Number(entry?.maxUnitPrice) || 0
    };
    row.listingCount += 1;
    row.totalUnits += quantity;
    row.lowestPrice = Math.min(row.lowestPrice, price);
    row.highestPrice = Math.max(row.highestPrice, price);
    row.maxUnitPrice = Math.max(row.maxUnitPrice, Number(entry?.maxUnitPrice) || 0);
    groups.set(key, row);
  }
  return {
    evaluatedAt: String(market.evaluatedAt || ""),
    items: [...groups.values()]
      .sort((left, right) => right.listingCount - left.listingCount || left.displayName.localeCompare(right.displayName))
      .slice(0, 100)
  };
}

export async function portalStorage(db, playerControllerId) {
  const result = await db.query(`
    with owned_containers as (
      select distinct p.id,
        coalesce(max(case when pa.actor_name not like '##%' and pa.actor_name <> 'None' then pa.actor_name end)
          over (partition by p.id), p.building_type) container_name,
        coalesce(a.map, '') map
      from dune.placeables p
      join dune.actors a on a.id=p.id
      join dune.actor_fgl_entities afe on afe.entity_id=p.owner_entity_id
      join dune.permission_actor_rank par on par.permission_actor_id=afe.actor_id
      left join dune.permission_actor pa on pa.actor_id=par.permission_actor_id
      where par.player_id=$1 and par.rank=1 and p.is_hologram=false
        and p.owner_entity_id is not null and p.owner_entity_id<>0
    ), item_rows as (
      select oc.id::text container_id,oc.container_name,oc.map,
        i.template_id,coalesce(i.quality_level,0)::int quality_level,
        count(*)::int stack_count,coalesce(sum(i.stack_size),0)::bigint::text quantity
      from owned_containers oc
      join dune.inventories inv on inv.actor_id=oc.id
      join dune.items i on i.inventory_id=inv.id
      group by oc.id,oc.container_name,oc.map,i.template_id,i.quality_level
    )
    select * from item_rows
    order by container_name,template_id,quality_level
    limit 750`, [playerControllerId]);
  const containers = new Map();
  for (const row of result.rows || []) {
    const id = String(row.container_id || "");
    const container = containers.get(id) || {
      id,
      name: String(row.container_name || "Storage"),
      map: String(row.map || ""),
      itemTypes: 0,
      totalQuantity: 0
    };
    container.itemTypes += 1;
    container.totalQuantity += Number(row.quantity) || 0;
    containers.set(id, container);
  }
  return {
    truncated: (result.rows || []).length >= 750,
    containers: [...containers.values()],
    items: (result.rows || []).map((row) => ({
      containerId: String(row.container_id || ""),
      containerName: String(row.container_name || "Storage"),
      map: String(row.map || ""),
      templateId: String(row.template_id || ""),
      qualityLevel: Number(row.quality_level) || 0,
      stackCount: Number(row.stack_count) || 0,
      quantity: Number(row.quantity) || 0
    }))
  };
}

export async function portalLandsraad(db, playerControllerId) {
  const overview = await landsraadOverview(db);
  if (overview?.capabilities?.landsraad !== true) return null;
  let contributions = [];
  if (overview.capabilities.playerContributions) {
    contributions = (await db.query(`
      select task_id::text "taskId",coalesce(amount,0)::real amount
      from dune.landsraad_task_player_contributions
      where player_id=$1
      order by task_id`, [playerControllerId])).rows || [];
  }
  return {
    term: overview.term,
    tasks: overview.tasks,
    rewards: overview.rewards,
    contributions: contributions.map((row) => ({ taskId: String(row.taskId || row.task_id || ""), amount: Number(row.amount) || 0 }))
  };
}

// Build private, read-only snapshots only for Steam identities requested by the
// directory. Raw platform IDs and local Market Bot seller IDs never leave the
// battlegroup.
export async function playerPortalSnapshots(db, requestedAccountHashes, journeyTagsData = {}, skillModulesData = [], marketSnapshot = null, portalContext = {}) {
  const requested = new Set((Array.isArray(requestedAccountHashes) ? requestedAccountHashes : [])
    .map((value) => String(value || "").toLowerCase())
    .filter((value) => /^[0-9a-f]{64}$/.test(value))
    .slice(0, 25));
  if (!requested.size) return [];

  const identities = await db.query(`
    select distinct on (ac.id)
      ac.id::text account_id, ac.platform_id,
      ps.character_name, ps.player_controller_id::text controller_id,
      ps.player_pawn_id::text actor_id, ps.online_status::text online_status,
      coalesce(ps.last_avatar_activity, ps.last_login_time) last_seen,
      coalesce(a.map, '') player_map, coalesce(a.partition_id, 0) player_partition_id,
      ((a.transform).location).x player_x,
      ((a.transform).location).y player_y,
      ((a.transform).location).z player_z
    from dune.accounts ac
    join dune.player_state ps on ps.account_id=ac.id
    join dune.actors a on a.id=ps.player_pawn_id
    where lower(coalesce(ac.platform_name,''))='steam'
      and ac.platform_id ~ '^[0-9]{17}$'
      and ps.player_pawn_id is not null
    order by ac.id, ps.last_avatar_activity desc nulls last`);
  const matched = identities.rows.map((row) => ({
    ...row,
    accountHash: createHash("sha256").update(String(row.platform_id)).digest("hex")
  })).filter((row) => requested.has(row.accountHash));
  if (!matched.length) return [...requested].map((accountHash) => ({ accountHash, found: false }));

  const leadership = await addonLeadershipPlayers(db).catch(() => ({ rows: [] }));
  const leaders = new Map((leadership.rows || []).map((row) => [String(row.actorId), row]));
  const snapshots = [];
  for (const identity of matched) {
    const actorId = Number(identity.actor_id);
    const controllerId = Number(identity.controller_id);
    const [currency, factions, specs, crafting, research, journeys, bases, intel, keystones, blueprints, vehicles, guild, storage, landsraad] = await Promise.all([
      playerCurrency(db, actorId).catch(() => ({ rows: [] })),
      playerFactions(db, actorId).catch(() => ({ rows: [] })),
      playerSpecs(db, actorId).catch(() => ({ rows: [], skillModules: [] })),
      playerCraftingRecipes(db, actorId).catch(() => ({ rows: [] })),
      playerResearchItems(db, actorId).catch(() => ({ rows: [] })),
      playerJourney(db, actorId, journeyTagsData).catch(() => ({ rows: {} })),
      // includeGenerators: false — portalGeneratorFuel is called below for just
      // this player's bases, so letting listBases resolve it for all 200 would
      // run the same CTE twice per identity.
      listBases(db, { pageSize: 200, includeGenerators: false }).catch(() => ({ rows: [] })),
      db.query(`select coalesce((properties->'TechKnowledgePlayerComponent'->>'m_TechKnowledgePoints')::bigint,0)::text intel from dune.actors where id=$1`, [actorId]).catch(() => ({ rows: [] })),
      db.query(`select keystone_id::text from dune.purchased_specialization_keystones where player_id=$1 order by keystone_id`, [controllerId]).catch(() => ({ rows: [] })),
      db.query(`select id::text,item_id::text,building_blueprint_map from dune.building_blueprints where player_id=$1 order by id`, [controllerId]).catch(() => ({ rows: [] })),
      portalVehicles(db, [actorId, controllerId, Number(identity.account_id)]).catch(() => ({ rows: [] })),
      portalGuild(db, identity).catch(() => null),
      portalStorage(db, controllerId).catch(() => ({ containers: [], items: [], truncated: false })),
      portalLandsraad(db, controllerId).catch(() => null)
    ]);
    const leader = leaders.get(String(actorId)) || {};
    const baseRows = (bases.rows || []).filter((base) =>
      base.owner_name === identity.character_name ||
      (base.shared_with || []).some((entry) => entry.name === identity.character_name));
    const fuelByBase = await portalGeneratorFuel(db, baseRows.map((base) => base.base_id)).catch(() => new Map());
    const waterByBase = new Map(await Promise.all(baseRows.map(async (base) => {
      const water = await baseWater(db, base.base_id).catch(() => ({ supported: false, containers: [] }));
      return [String(base.base_id), water];
    })));
    const skillModules = (specs.skillModules || []).map((skill) => portalSkillRow(skill, skillModulesData));
    const journeyRows = Object.values(journeys.rows || {}).flat();
    const unlockedCrafting = (crafting.rows || []).filter((row) => row.unlocked);
    const unlockedResearch = (research.rows || []).filter((row) => row.unlocked);
    const solaris = (currency.rows || []).find((row) => Number(row.currency_id) === 0)?.balance || 0;

    snapshots.push({
      accountHash: identity.accountHash,
      found: true,
      data: {
        overview: {
          characterName: identity.character_name || "Unknown Player",
          level: Math.min(200, Math.max(0, Number(leader.level) || 0)),
          faction: leader.faction || "Unassigned",
          guild: leader.guild || "Unavailable",
          online: String(identity.online_status || "").toLowerCase() === "online",
          lastSeen: identity.last_seen || "",
          map: identity.player_map || "",
          partitionId: Number(identity.player_partition_id) || 0,
          x: Number(identity.player_x) || 0,
          y: Number(identity.player_y) || 0,
          z: Number(identity.player_z) || 0
        },
        wallet: {
          solaris: Number(solaris) || 0,
          intel: Number(intel.rows[0]?.intel) || 0,
          factionReputation: (factions.rows || []).map((row) => ({
            faction: row.faction_name || `Faction ${row.faction_id}`,
            reputation: Number(row.reputation_amount) || 0
          }))
        },
        specializations: {
          tracks: (specs.rows || []).map((row) => ({ name: row.track_type, level: Math.floor(Number(row.level) || 0), xp: Number(row.xp_amount) || 0 })),
          purchasedKeystones: keystones.rows.map((row) => row.keystone_id),
          skills: skillModules,
          unspentPoints: Number(specs.unspentPoints) || 0
        },
        unlocks: {
          skills: skillModules,
          research: unlockedResearch.map((row) => ({ id: row.itemKey || "", name: row.displayName || row.itemKey || "Research" })),
          schematics: unlockedCrafting.map((row) => ({ id: row.recipeId || "", name: row.displayName || row.recipeId || "Schematic" })),
          missingResearch: (research.rows || []).filter((row) => !row.unlocked).map((row) => ({ id: row.itemKey || "", name: row.displayName || row.itemKey || "Research" })).slice(0, 500),
          missingSchematics: (crafting.rows || []).filter((row) => !row.unlocked).map((row) => ({ id: row.recipeId || "", name: row.displayName || row.recipeId || "Schematic" })).slice(0, 500),
          blueprints: blueprints.rows.map((row) => ({ id: row.id, itemId: row.item_id, map: row.building_blueprint_map || "" }))
        },
        journeys: {
          completed: journeyRows.filter((row) => row.complete).map(portalJourneyRow),
          current: journeyRows.filter((row) => !row.complete && row.status && row.status !== "Locked").map(portalJourneyRow),
          remaining: journeyRows.filter((row) => !row.complete).length
        },
        vehicles: vehicles.rows,
        bases: baseRows.map((base) => ({
          id: base.base_id, name: base.name, type: base.base_type,
          ownership: base.owner_name === identity.character_name ? "Owned" : "Shared",
          pieceCount: Number(base.piece_count || 0),
          placeableCount: Number(base.placeable_count || 0),
          buildingCount: Number(base.piece_count || 0) + Number(base.placeable_count || 0),
          fuelCells: fuelByBase.get(String(base.base_id))?.fuelCells || 0,
          generatorCount: fuelByBase.get(String(base.base_id))?.generatorCount || 0,
          generatorRuntimeSeconds: fuelByBase.get(String(base.base_id))?.runtimeSeconds || 0,
          generatorUptimeMultiplier: fuelByBase.get(String(base.base_id))?.uptimeMultiplier || 1,
          generatorUptimeEventLabel: fuelByBase.get(String(base.base_id))?.uptimeEventLabel || "",
          generatorUptimeEventEndsAt: fuelByBase.get(String(base.base_id))?.uptimeEventEndsAt || "",
          generatorUnstockedCount: fuelByBase.get(String(base.base_id))?.unstockedCount || 0,
          generatorAllUnstocked: fuelByBase.get(String(base.base_id))?.allGeneratorsUnstocked || false,
          generators: fuelByBase.get(String(base.base_id))?.generators || [],
          waterSupported: waterByBase.get(String(base.base_id))?.supported === true,
          waterContainers: waterByBase.get(String(base.base_id))?.containers || [],
          map: base.map || "",
          partitionId: Number(base.partition_id) || 0,
          x: Number(base.x) || 0,
          y: Number(base.y) || 0,
          z: Number(base.z) || 0
        })),
        storage,
        guild,
        landsraad,
        serverInfo: portalContext.serverInfo || null,
        carePackages: {
          enabled: portalContext.carePackages?.enabled === true,
          history: (portalContext.carePackages?.history || [])
            .filter((row) => {
              const rowAccount = String(row?.account_id || row?.accountId || "");
              const rowActor = String(row?.actor_id || row?.actorId || "");
              return (rowAccount && rowAccount === String(identity.account_id || ""))
                || (rowActor && rowActor === String(identity.actor_id || ""));
            })
            .slice(0, 25)
            .map((row) => ({
              id: String(row.id || ""),
              timestamp: String(row.timestamp || ""),
              status: String(row.status || "unknown"),
              kitName: String(row.kitName || row.kit_name || row.summary || "Care Package"),
              summary: String(row.summary || "")
            }))
        },
        exchangeOverview: portalExchangeOverview(marketSnapshot),
        ...(marketSnapshot ? { marketBot: portalMarketForIdentity(identity, marketSnapshot) } : {})
      }
    });
  }
  const found = new Set(snapshots.map((entry) => entry.accountHash));
  for (const accountHash of requested) if (!found.has(accountHash)) snapshots.push({ accountHash, found: false });
  return snapshots;
}

function portalJourneyRow(row) {
  return { id: row.id || row.rawName || "", name: row.name || row.rawName || "Journey", status: row.status || "" };
}

function portalSkillRow(skill, catalog) {
  const id = String(skill?.module_id || skill?.id || "");
  const known = (Array.isArray(catalog) ? catalog : []).find((entry) => entry?.id === id) || {};
  const parts = id.split(".");
  return {
    id,
    name: String(known.name || parts.at(-1) || "Unknown Skill").replace(/^XX_/, ""),
    specialization: portalSkillSpecialization(known.category),
    type: portalSkillType(parts[1]),
    rank: Number(skill?.skill_points_spent || skill?.rank || 0),
    maxRank: Number(known.maxLevel || 0)
  };
}

function portalSkillSpecialization(value) {
  const label = String(value || "General");
  return label === "BeneGesserit" ? "Bene Gesserit" : label;
}

function portalSkillType(value) {
  return ({ Ability: "Ability", Attribute: "Passive", Key: "Keystone", Perk: "Technique", Science: "Science", Spice: "Spice" })[value] || "Skill";
}

// Admin Vehicles page. Columns operate on the `matched` CTE's output names.
// shared_with is resolved only on the paged rows (not here), so it is not
// sortable — matching how the frontend marks it non-sortable.
const VEHICLE_SORT_COLUMNS = {
  id: { order: ["id"] },
  name: { order: ["lower(coalesce(name, ''))"] },
  type: { order: ["lower(coalesce(type, ''))"] },
  owner: { order: ["lower(coalesce(owner, ''))"] },
  condition_percent: { order: ["condition_percent"] },
  fuel_percent: { order: ["fuel_percent"] },
  map: { order: ["lower(coalesce(map, ''))", "partition_id"] }
};

// Single source of truth for the friendly vehicle-type mapping. Both the SQL
// label (VEHICLE_TYPE_SQL below, computed in SQL so type can be searched/sorted
// server-side) and the JS portalVehicleDisplayName() (Discord portal path) are
// derived from this list, so the two representations can't drift apart. Order
// matters: the first substring match wins.
const VEHICLE_TYPE_MAP = [
  { match: "lightornithopter", label: "Scout Ornithopter" },
  { match: "mediumornithopter", label: "Assault Ornithopter" },
  { match: "transportornithopter", label: "Carrier Ornithopter" },
  { match: "sandcrawler", label: "Sandcrawler" },
  { match: "sandbike", label: "Sandbike" },
  { match: "buggy", label: "Buggy" },
  { match: "tank", label: "Battle Tank" }
];

// Friendly vehicle label, generated from VEHICLE_TYPE_MAP; unmapped classes fall
// back to the stripped class name.
const VEHICLE_TYPE_SQL = `case
${VEHICLE_TYPE_MAP.map((entry) => `  when lower(coalesce(a.class, '')) like '%${entry.match}%' then '${entry.label}'`).join("\n")}
  else regexp_replace(a.class, '^.*/|\\..*$', '', 'g')
end`;

// Custom actor name, cleaned in SQL to mirror portalCustomActorName():
// blank, "none", and "##"-prefixed sentinels resolve to null (no custom name).
const VEHICLE_CUSTOM_NAME_SQL = `case
  when pa.actor_name is null then null
  when btrim(pa.actor_name) = '' then null
  when lower(btrim(pa.actor_name)) = 'none' then null
  when btrim(pa.actor_name) like '##%' then null
  else btrim(pa.actor_name)
end`;

// Shared by the admin Vehicles pages and the dunedocker.app player snapshot.
// The game database always gives us a current value for fuel/durability when it
// records one, but it does not consistently persist a corresponding maximum.
// A stored module maximum is authoritative. Otherwise, infer a maximum only
// when at least two non-null observations exist for the exact same template.
// Missing current values remain unknown: they must never become 0% or 100%.
const VEHICLE_STATUS_CTES_SQL = `module_raw as (
  select vm.id, vm.vehicle_id, vm.template_id,
    (vm.stats->'FVehicleModuleDurabilityStats'->1->>'CurrentDurability')::numeric own_current,
    nullif((vm.stats->'FVehicleModuleDurabilityStats'->1->>'DecayedMaxDurability')::numeric, 0) own_decayed,
    nullif((vm.stats->'FVehicleModuleDurabilityStats'->1->>'MaxDurability')::numeric, 0) own_max
  from dune.vehicle_modules vm
), module_observed as (
  select module_raw.*,
    count(own_current) over(partition by template_id)::int current_samples,
    max(own_current) over(partition by template_id) observed_max
  from module_raw
), module_durability as (
  select id, vehicle_id, template_id,
    own_current current_durability,
    coalesce(own_max, own_decayed,
      case when current_samples >= 2 then observed_max else null end) max_durability,
    case
      when own_max is not null or own_decayed is not null then false
      when current_samples >= 2 and observed_max is not null then true
      else null
    end max_inferred
  from module_observed
), vehicle_fuel as (
  select v.id vehicle_id,
    fuel.current_fuel,
    generator.template_id generator_template
  from dune.vehicles v
  left join lateral (
    select (fe.components->'FVehicleComponent'->1->>'CurrentFuel')::numeric current_fuel
    from dune.actor_fgl_entities afe
    join dune.fgl_entities fe on fe.entity_id=afe.entity_id
    where afe.actor_id=v.id and fe.components ? 'FVehicleComponent'
    limit 1
  ) fuel on true
  left join lateral (
    select vm.template_id
    from dune.vehicle_modules vm
    where vm.vehicle_id=v.id and vm.template_id ilike '%Generator%'
    limit 1
  ) generator on true
), fuel_capacity as (
  select generator_template,
    max(current_fuel) max_fuel,
    count(current_fuel)::int fuel_samples
  from vehicle_fuel
  where generator_template is not null
  group by generator_template
)`;

// Lists every vehicle (across all players) for the admin console, one page at a
// time. Reuses portalVehicles' module-durability and fuel-capacity CTEs, the
// listPlayers totals + LEFT JOIN LATERAL pagination (so totalCount survives an
// out-of-range page — do NOT switch to count(*) over() inside the paged CTE),
// and the listBases shared-with lateral (resolved only on the paged rows).
export async function listVehicles(db, { q = "", page = 0, pageSize = 50, sortColumn = "name", sortDirection = "asc", playerId = "" } = {}) {
  const requiredTables = [
    "vehicles", "vehicle_modules", "actors", "permission_actor",
    "permission_actor_rank", "player_state", "actor_fgl_entities", "fgl_entities"
  ];
  for (const table of requiredTables) {
    if (!(await tableExists(db, table))) {
      return { ...unsupported("vehicles", requiredTables.map((t) => `dune.${t}`)), totalCount: 0, totalVehicles: 0 };
    }
  }

  const safePageSize = intParam(pageSize, "pageSize", 1, 200);
  const safePage = intParam(page, "page", 0);
  const offset = safePage * safePageSize;
  const safeSortColumn = Object.hasOwn(VEHICLE_SORT_COLUMNS, sortColumn) ? sortColumn : "name";
  const safeSortDirection = String(sortDirection).toLowerCase() === "desc" ? "desc" : "asc";
  const sortOrder = VEHICLE_SORT_COLUMNS[safeSortColumn].order;
  const pagedOrder = [...sortOrder, ...(sortOrder.includes("id") ? [] : ["id"])]
    .map((column) => `${column} ${safeSortDirection}`).join(", ");

  const player = playerId ? await resolvePlayerMutationTarget(db, playerId) : null;
  const values = [];
  const filters = [];
  let viewerJoin = "";
  let relationshipSql = "null::text";
  if (player) {
    values.push(player.accountId);
    const accountParam = values.length;
    values.push(player.controllerId);
    const controllerParam = values.length;
    viewerJoin = `left join lateral (
          select min(par.rank)::int as rank
          from dune.permission_actor_rank par
          where par.permission_actor_id=vc.id and par.player_id=$${controllerParam}
        ) viewer on true`;
    filters.push(`(vc.owner_account_id=$${accountParam} or viewer.rank is not null)`);
    relationshipSql = `case
            when vc.owner_account_id=$${accountParam} or viewer.rank=1 then 'Owner'
            when viewer.rank=2 then 'Co-Owner'
            when viewer.rank=3 then 'Associate'
            when viewer.rank is not null then 'Rank ' || viewer.rank::text
            else null
          end`;
  }
  if (q) {
    values.push(`%${q}%`);
    const likeParam = values.length;
    values.push(String(q));
    const exactParam = values.length;
    filters.push(`(coalesce(vc.clean_name, vc.type) ilike $${likeParam}`
      + ` or vc.type ilike $${likeParam}`
      + ` or coalesce(own.owner, '') ilike $${likeParam}`
      + ` or vc.map ilike $${likeParam}`
      + ` or vc.id::text = $${exactParam})`);
  }
  const filterClause = filters.length ? `where ${filters.join(" and ")}` : "";
  values.push(safePageSize, offset);
  const limitParamIndex = values.length - 1;
  const offsetParamIndex = values.length;

  try {
    const result = await db.query(`
      with ${VEHICLE_STATUS_CTES_SQL}, vehicle_core as (
        select v.id,
          ${VEHICLE_TYPE_SQL} as type,
          ${VEHICLE_CUSTOM_NAME_SQL} as clean_name,
          coalesce(a.map, '') as map,
          coalesce(a.partition_id, 0)::int as partition_id,
          a.transform,
          a.owner_account_id
        from dune.vehicles v
        join dune.actors a on a.id=v.id
        left join dune.permission_actor pa on pa.actor_id=v.id
      ), matched as (
        select vc.id,
          coalesce(vc.clean_name, vc.type) as name,
          vc.type,
          coalesce(own.owner, '') as owner,
          ${relationshipSql} as relationship,
          min(case when md.current_durability is not null and md.max_durability > 0 then
            greatest(0, least(100, floor(100 * md.current_durability / nullif(md.max_durability, 0))))::int
          else null end) condition_percent,
          (count(*) filter(where md.max_inferred is true and md.current_durability is not null and md.max_durability > 0) > 0) condition_estimated,
          fuel.current_fuel,
          case when cap.fuel_samples >= 2 then cap.max_fuel else null end max_fuel,
          case when cap.fuel_samples >= 2 then
            greatest(0, least(100, floor(100 * fuel.current_fuel / nullif(cap.max_fuel, 0))))::int
          else null end fuel_percent,
          vc.map, vc.partition_id,
          ((vc.transform).location).x::numeric x,
          ((vc.transform).location).y::numeric y,
          ((vc.transform).location).z::numeric z,
          coalesce(jsonb_agg(jsonb_build_object(
            'templateId', md.template_id,
            'condition', md.current_durability,
            'maxCondition', md.max_durability,
            'maxInferred', md.max_inferred,
            'conditionPercent', case when md.current_durability is not null and md.max_durability > 0 then
              greatest(0, least(100, floor(100 * md.current_durability / nullif(md.max_durability, 0))))::int
            else null end
          ) order by md.template_id) filter(where md.id is not null), '[]'::jsonb) modules
        from vehicle_core vc
        left join lateral (
          select coalesce(
            (select ps.character_name
               from dune.permission_actor_rank par
               join dune.actors pa2 on pa2.id=par.player_id
               join dune.player_state ps on ps.account_id=pa2.owner_account_id
               where par.permission_actor_id=vc.id and par.rank=1
               order by ps.character_name limit 1),
            (select ps.character_name
               from dune.player_state ps
               where ps.account_id=vc.owner_account_id
               order by ps.character_name limit 1)
          ) as owner
        ) own on true
        ${viewerJoin}
        left join vehicle_fuel fuel on fuel.vehicle_id=vc.id
        left join fuel_capacity cap on cap.generator_template=fuel.generator_template
        left join module_durability md on md.vehicle_id=vc.id
        ${filterClause}
        group by vc.id, vc.type, vc.clean_name, vc.map, vc.partition_id, vc.transform,
          vc.owner_account_id, own.owner, ${player ? "viewer.rank," : ""} fuel.current_fuel, cap.max_fuel, cap.fuel_samples
      ), totals as (
        select count(*)::int as total_count from matched
      )
      select paged.*, totals.total_count,
        coalesce(shared.entries, '[]'::jsonb) as shared_with
      from totals
      left join lateral (
        select * from matched
        order by ${pagedOrder}
        limit $${limitParamIndex} offset $${offsetParamIndex}
      ) paged on true
      left join lateral (
        select jsonb_agg(jsonb_build_object('name', ps.character_name, 'rank', par.rank)
          order by par.rank asc, ps.character_name asc) as entries
        from dune.permission_actor_rank par
        join dune.actors player_a on player_a.id = par.player_id
        join dune.player_state ps on ps.account_id = player_a.owner_account_id
        where par.permission_actor_id = paged.id
          and par.rank <> 1
          and ps.character_name is distinct from paged.owner
      ) shared on true
      order by ${pagedOrder}`, values);

    const totalsResult = await db.query("select count(*)::int as total_vehicles from dune.vehicles");

    const rows = result.rows
      .filter((row) => row.id !== null && row.id !== undefined)
      .map(({ total_count, ...row }) => ({
        ...row,
        shared_with: (Array.isArray(row.shared_with) ? row.shared_with : []).map((entry) => ({
          name: entry.name,
          rank: entry.rank,
          label: permissionRankLabel(entry.rank)
        })),
        modules: (row.modules || []).map((module) => ({
          ...module,
          name: portalVehicleModuleName(module.templateId)
        }))
      }));
    await attachVehicleRegions(db, rows);

    return {
      capabilities: { vehicles: true },
      totalCount: result.rows[0] ? Number(result.rows[0].total_count) : 0,
      totalVehicles: totalsResult.rows[0] ? Number(totalsResult.rows[0].total_vehicles) : 0,
      rows
    };
  } catch (error) {
    return { ...unsupported("vehicles", requiredTables.map((t) => `dune.${t}`)), totalCount: 0, totalVehicles: 0, reason: `Vehicles query failed: ${error.message}` };
  }
}

export async function portalVehicles(db, playerIds) {
  const result = await db.query(`
    with ${VEHICLE_STATUS_CTES_SQL}
    select v.id::text id, regexp_replace(a.class, '^.*/|\\..*$', '', 'g') type,
      pa.actor_name custom_name,
      min(case when vm.current_durability is not null and vm.max_durability > 0 then
        greatest(0, least(100, floor(100 * vm.current_durability / nullif(vm.max_durability, 0))))::int
      else null end) condition_percent,
      (count(*) filter(where vm.max_inferred is true and vm.current_durability is not null and vm.max_durability > 0) > 0) condition_estimated,
      fuel.current_fuel,
      case when capacity.fuel_samples >= 2 then capacity.max_fuel else null end max_fuel,
      case when capacity.fuel_samples >= 2 then
        greatest(0, least(100, floor(100 * fuel.current_fuel / nullif(capacity.max_fuel, 0))))::int
      else null end fuel_percent,
      coalesce(a.map, '') map, coalesce(a.partition_id, 0)::int partition_id,
      ((a.transform).location).x::numeric x,
      ((a.transform).location).y::numeric y,
      ((a.transform).location).z::numeric z,
      coalesce(jsonb_agg(jsonb_build_object(
        'templateId',vm.template_id,
        'condition',vm.current_durability,
        'maxCondition',vm.max_durability,
        'maxInferred',vm.max_inferred,
        'conditionPercent',case when vm.current_durability is not null and vm.max_durability > 0 then
          greatest(0, least(100, floor(100 * vm.current_durability / nullif(vm.max_durability, 0))))::int
        else null end
      ) order by vm.template_id) filter(where vm.id is not null),'[]'::jsonb) modules
    from dune.vehicles v
    join dune.actors a on a.id=v.id
    left join dune.permission_actor pa on pa.actor_id=v.id
    left join vehicle_fuel fuel on fuel.vehicle_id=v.id
    left join fuel_capacity capacity on capacity.generator_template=fuel.generator_template
    left join dune.permission_actor_rank par on par.permission_actor_id=v.id and par.player_id=any($1::bigint[])
    left join module_durability vm on vm.vehicle_id=v.id
    where par.player_id is not null or a.owner_account_id=any($1::bigint[])
    group by v.id,a.class,a.map,a.partition_id,a.transform,pa.actor_name,fuel.current_fuel,capacity.max_fuel,capacity.fuel_samples
    order by v.id`, [playerIds]);
  return {
    ...result,
    rows: result.rows.map((row) => {
      const { custom_name: customName, ...vehicle } = row;
      return {
        ...vehicle,
        name: portalCustomActorName(customName) || portalVehicleDisplayName(row.type),
        modules: (row.modules || []).map((module) => ({
          ...module,
          name: portalVehicleModuleName(module.templateId)
        }))
      };
    })
  };
}

function portalCustomActorName(value) {
  const name = String(value || "").trim();
  return name && name.toLowerCase() !== "none" && !name.startsWith("##") ? name : "";
}

function portalVehicleModuleName(templateId) {
  const id = String(templateId || "");
  const direct = adminItemMetadata().get(id)?.name;
  if (direct) return direct;
  // Locomotion pieces (ornithopter wings, ground-vehicle treads) are catalogued
  // per vehicle + tier, not per mounting position, so the positional template ids
  // the game actually stores (e.g. BuggyLocomotionBackLeft_5,
  // OrnithopterMediumLocomotionCenterRight_5) have no direct catalog entry. Strip
  // the position, resolve the base name, and append the position for readability.
  // Covers every vehicle class and the Front/Back/Center x Left/Right/Center grid.
  const loco = id.match(/^([A-Za-z]+Locomotion)(Front|Back|Center)(Left|Right|Center)_(\d+)$/i);
  if (loco) {
    const base = adminItemMetadata().get(`${loco[1]}_${loco[4]}`)?.name;
    if (base) return `${base} (${loco[2]} ${loco[3]})`;
  }
  return id || "Vehicle Module";
}

// Derived from the same VEHICLE_TYPE_MAP as VEHICLE_TYPE_SQL, so the portal and
// the admin page always agree on the friendly label. Runs on the path-stripped
// class; unmapped classes pass through unchanged.
export function portalVehicleDisplayName(type) {
  const value = String(type || "").toLowerCase();
  const mapped = VEHICLE_TYPE_MAP.find((entry) => value.includes(entry.match));
  return mapped ? mapped.label : String(type || "Vehicle");
}

// Seconds of runtime per fuel unit, measured from m_FuelBurningDuration on the
// live server (2026-07-26). Burn duration is a property of the fuel item, not of
// the generator burning it — every fuel maps to exactly one duration across all
// generators — so these constants replace reading the component per generator.
// Re-verify after game updates; the measurement query lives in
// docs/console/generator-fuel-burn-rates.md.
const FUEL_BURN_SECONDS = {
  oil: 60 * 60,                   // measured across 69 populated components
  spicedfuelcell: 90 * 60,        // measured — confirmed 2026-07-26 after the
                                   // generator rolled to a fresh burn cycle
  windturbinelubricant1: 60 * 60, // measured across 6 turbines
  windturbinelubricant2: 90 * 60  // measured across 2 turbines
};

// Funcom's 1.4.10.2 hotfix applies a temporary 2x uptime multiplier to
// generators, wind turbines, and their consumables from July 1 through
// August 31, 2026. The persisted m_FuelBurningDuration values above remain at
// their normal rates during the event, so the effective player-facing reserve
// must apply the live-event policy separately. Keep the end exclusive so the
// policy automatically returns to normal at the start of September.
const GENERATOR_UPTIME_EVENTS = [{
  startsAt: "2026-07-01T00:00:00.000Z",
  endsAt: "2026-09-01T00:00:00.000Z",
  multiplier: 2,
  label: "Double generator uptime event"
}];

export function generatorUptimePolicy(now = new Date()) {
  const timestamp = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(timestamp)) return { multiplier: 1, label: "", endsAt: "" };
  const event = GENERATOR_UPTIME_EVENTS.find((candidate) =>
    timestamp >= Date.parse(candidate.startsAt) && timestamp < Date.parse(candidate.endsAt));
  return event
    ? { multiplier: event.multiplier, label: event.label, endsAt: event.endsAt }
    : { multiplier: 1, label: "", endsAt: "" };
}

// Display metadata, accepted fuels, and explicit placeable allowlists per
// generator type. Both mappings are passed into SQL as parameters, so adding a
// supported type or known alias requires changing this object only.
// The `refill` block drives refillBaseGenerators: templateId is the cased id
// written to dune.items (it must appear lower-cased in `fuels`), stackSize is
// the per-row stack the game accepts, and totalCap bounds the whole device
// across at most maxStacks rows.
const GENERATOR_TYPES = {
  fuel: {
    name: "Fuel-Powered Generator",
    fuelName: "Fuel Cell",
    fuels: ["oil"],
    buildingTypes: ["generator_placeable"],
    refill: { templateId: "Oil", stackSize: 499, maxStacks: 1, totalCap: 499 }
  },
  spice: {
    name: "Spice-Powered Generator",
    fuelName: "Spice-infused Fuel Cell",
    fuels: ["spicedfuelcell"],
    buildingTypes: ["spicegenerator_placeable"],
    refill: { templateId: "SpicedFuelCell", stackSize: 499, maxStacks: 1, totalCap: 499 }
  },
  windTurbineOmni: {
    name: "Omnidirectional Wind Turbine",
    fuelName: "Low-grade Lubricant",
    fuels: ["windturbinelubricant1"],
    buildingTypes: ["windturbineomnidirectional_placeable"],
    refill: { templateId: "WindTurbineLubricant1", stackSize: 100, maxStacks: 5, totalCap: 499 }
  },
  windTurbineDirectional: {
    name: "Directional Wind Turbine",
    fuelName: "Industrial-grade Lubricant",
    fuels: ["windturbinelubricant2"],
    buildingTypes: ["windturbinedirectional_placeable"],
    refill: { templateId: "WindTurbineLubricant2", stackSize: 100, maxStacks: 5, totalCap: 499 }
  }
};

const GENERATOR_TYPE_ORDER = ["fuel", "spice", "windTurbineOmni", "windTurbineDirectional"];

// Flattened (generator_type, template_id) pairs and (template_id, seconds) pairs,
// shaped for unnest() so the query never interpolates a fuel name.
const GENERATOR_TYPE_FUEL_PAIRS = GENERATOR_TYPE_ORDER.flatMap(
  (type) => GENERATOR_TYPES[type].fuels.map((template) => [type, template])
);
const GENERATOR_BUILDING_TYPE_PAIRS = GENERATOR_TYPE_ORDER.flatMap(
  (type) => GENERATOR_TYPES[type].buildingTypes.map((buildingType) => [type, buildingType])
);
const FUEL_TEMPLATE_IDS = Object.keys(FUEL_BURN_SECONDS);

// Operators can retune refill caps per generator type without a rebuild, the
// same way runtime/data/admin-items.json is layered over the shipped catalog.
// Values are clamped so a malformed override cannot request a ten-million-item
// insert, and templateId is never overridable — fuel identity is fixed by the
// game, not by configuration.
function refillCaps(repoRoot) {
  const overridePath = resolve(repoRoot || "", "runtime/data/generator-refill-caps.json");
  let overrides = {};
  try {
    if (repoRoot && existsSync(overridePath)) overrides = JSON.parse(readFileSync(overridePath, "utf8")) || {};
  } catch (error) {
    console.warn(`Ignoring unreadable generator refill cap overrides: ${redact(error?.message || "Unexpected error.")}`);
  }
  const caps = {};
  for (const type of GENERATOR_TYPE_ORDER) {
    const defaults = GENERATOR_TYPES[type].refill;
    const merged = { ...defaults, ...(overrides[type] || {}) };
    merged.templateId = defaults.templateId;
    merged.stackSize = clampInt(merged.stackSize, defaults.stackSize, 1, 10000);
    merged.maxStacks = clampInt(merged.maxStacks, defaults.maxStacks, 1, 50);
    merged.totalCap = clampInt(merged.totalCap, defaults.totalCap, 1, merged.stackSize * merged.maxStacks);
    caps[type] = merged;
  }
  return caps;
}

export async function portalGeneratorFuel(db, baseIds, { now = new Date() } = {}) {
  if (!baseIds.length) return new Map();
  const uptimePolicy = generatorUptimePolicy(now);
  const result = await db.query(`
    with requested_claims as (
      select distinct b.id, afe.actor_id
      from dune.buildings b
      join dune.building_instances bi on bi.building_id = b.id
      join dune.actor_fgl_entities afe on afe.entity_id = bi.owner_entity_id
      where b.id = any($1::bigint[])
    ), base_entities as (
      select distinct rc.id, claim_afe.entity_id as owner_entity_id
      from requested_claims rc
      join dune.actor_fgl_entities claim_afe on claim_afe.actor_id = rc.actor_id
    ), fuel_durations as (
      select * from unnest($2::text[], $3::numeric[]) as t(template_id, seconds)
    ), type_fuels as (
      select * from unnest($4::text[], $5::text[]) as t(generator_type, template_id)
    ), generator_types as (
      select * from unnest($6::text[], $7::text[]) as t(generator_type, building_type)
    ), generator_spec as (
      -- Classification is an explicit allowlist. Unknown placeables containing
      -- "generator" must not silently become oil generators and report an
      -- invented empty/zero state.
      select be.id::text base_id, p.id generator_id, gt.generator_type
      from base_entities be
      join dune.placeables p on p.owner_entity_id=be.owner_entity_id
      join generator_types gt on gt.building_type=lower(p.building_type)
    ), generator_state as (
      select gs.base_id, gs.generator_id, gs.generator_type,
        coalesce(stock.stocked_seconds, 0)::numeric stocked_seconds,
        coalesce(stock.total_units, 0)::int fuel_cells
      from generator_spec gs
      left join lateral (
        -- Stock is matched against the fuels the generator type accepts, never
        -- against whatever it reports burning right now. An idle generator
        -- stores the literal string 'None' in m_FuelBurningId.Name rather than
        -- SQL null, and reading that as a fuel id matched no inventory rows —
        -- reporting 0 runtime for generators holding hundreds of cells.
        --
        -- Each generator type has one accepted consumable. Joining through
        -- type_fuels guarantees that an incompatible lubricant placed in a
        -- turbine's inventory contributes nothing to its queued reserve.
        select sum(i.stack_size * fd.seconds)::numeric stocked_seconds,
               sum(i.stack_size)::int total_units
        from dune.inventories inv
        join dune.items i on i.inventory_id=inv.id
        join type_fuels tf on tf.generator_type=gs.generator_type
          and tf.template_id=lower(i.template_id)
        join fuel_durations fd on fd.template_id=tf.template_id
        where inv.actor_id=gs.generator_id
      ) stock on true
    ), generator_runtime as (
      -- This is the verifiable queued fuel reserve shown in the generator's
      -- inventory. It is not an exact live countdown: the active burn marker
      -- and its timestamps can remain stale after restart/base load, so they
      -- cannot safely prove whether a partially consumed unit is still active.
      --
      -- m_FuelBurningInitialTime is deliberately NOT subtracted here. It resets
      -- on server restart / base load — whole cohorts of unrelated placeables
      -- share one value — so time elapsed since it says nothing about fuel
      -- actually consumed. Subtracting it reported well-stocked generators as
      -- empty, because the check tripped on whichever ones held the least fuel.
      select base_id, generator_id, generator_type, fuel_cells,
        stocked_seconds::bigint runtime_seconds,
        (fuel_cells = 0) has_no_queued_fuel
      from generator_state
    )
    select base_id, generator_type, count(*)::int generator_count, sum(fuel_cells)::int fuel_cells,
      -- Excludes generators with no queued fuel: including them dragged the
      -- minimum reserve to 0 even when other generators remained stocked. null
      -- means every generator in the group has no queued fuel.
      min(runtime_seconds) filter (where not has_no_queued_fuel)::bigint runtime_seconds,
      count(*) filter (where has_no_queued_fuel)::int unstocked_count
    from generator_runtime group by base_id, generator_type`, [
      baseIds,
      FUEL_TEMPLATE_IDS,
      FUEL_TEMPLATE_IDS.map((template) => FUEL_BURN_SECONDS[template] * uptimePolicy.multiplier),
      GENERATOR_TYPE_FUEL_PAIRS.map(([type]) => type),
      GENERATOR_TYPE_FUEL_PAIRS.map(([, template]) => template),
      GENERATOR_BUILDING_TYPE_PAIRS.map(([type]) => type),
      GENERATOR_BUILDING_TYPE_PAIRS.map(([, buildingType]) => buildingType)
    ]);
  const byBase = new Map();
  for (const row of result.rows) {
    const baseId = String(row.base_id);
    const type = row.generator_type;
    // row.runtime_seconds is null when every generator of this type has no
    // queued fuel. Keep it null long enough to exclude it from the base-wide
    // minimum reserve.
    const typeRuntimeSeconds = row.runtime_seconds == null ? null : Number(row.runtime_seconds);
    const detail = {
      type,
      name: GENERATOR_TYPES[type].name,
      fuelName: GENERATOR_TYPES[type].fuelName,
      fuelCells: Number(row.fuel_cells) || 0,
      generatorCount: Number(row.generator_count) || 0,
      runtimeSeconds: typeRuntimeSeconds || 0,
      unstockedCount: Number(row.unstocked_count) || 0
    };
    const current = byBase.get(baseId) || {
      fuelCells: 0,
      generatorCount: 0,
      runtimeSeconds: null,
      unstockedCount: 0,
      uptimeMultiplier: uptimePolicy.multiplier,
      uptimeEventLabel: uptimePolicy.label,
      uptimeEventEndsAt: uptimePolicy.endsAt,
      generators: []
    };
    current.fuelCells += detail.fuelCells;
    current.generatorCount += detail.generatorCount;
    current.unstockedCount += detail.unstockedCount;
    if (typeRuntimeSeconds != null) {
      current.runtimeSeconds = current.runtimeSeconds == null
        ? typeRuntimeSeconds
        : Math.min(current.runtimeSeconds, typeRuntimeSeconds);
    }
    current.generators.push(detail);
    current.generators.sort((left, right) =>
      GENERATOR_TYPE_ORDER.indexOf(left.type) - GENERATOR_TYPE_ORDER.indexOf(right.type));
    byBase.set(baseId, current);
  }
  for (const value of byBase.values()) {
    value.allGeneratorsUnstocked = value.generatorCount > 0 && value.unstockedCount >= value.generatorCount;
    value.runtimeSeconds ||= 0;
  }
  return byBase;
}

async function portalGuild(db, identity) {
  const result = await db.query(`
    select g.guild_id::text guild_id,g.guild_name,gm.role_id::text role_id
    from dune.guild_members gm join dune.guilds g on g.guild_id=gm.guild_id
    where gm.player_id=any($1::bigint[]) limit 1`, [[identity.actor_id, identity.controller_id, identity.account_id]]);
  if (!result.rowCount) return null;
  const row = result.rows[0];
  const members = await guildMembers(db, row.guild_id);
  const leadership = await addonLeadershipPlayers(db).catch(() => ({ rows: [] }));
  const statuses = new Map((leadership.rows || []).map((member) => [member.name, member.status]));
  return {
    name: row.guild_name || "Unknown Guild", role: portalGuildRole(row.role_id),
    membershipCount: (members.rows || []).length,
    onlineMembers: (members.rows || []).filter((member) => String(statuses.get(member.character_name) || "").toLowerCase() === "online").map((member) => member.character_name)
  };
}

function portalGuildRole(roleId) {
  const value = Number(roleId);
  if (value >= GUILD_LEADER_ROLE_ID) return "Leader";
  if (value > 1) return "Officer";
  return "Member";
}

export async function completeJourneyNode(db, id, { nodeId }, journeyTagsData = {}) {
  const schema = await journeyIdentitySchema(db);
  await requireCapability(await supportsJourneySchema(db, schema), "Journey completion is unavailable for this game database schema.");
  const safeNodeId = validateJourneyNodeId(nodeId);
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    requireOfflinePlayer(player, "Journey changes");
    const tagIdentityId = playerJourneyIdentity(player, schema.tagIdColumn);
    if (isContractNode(safeNodeId, journeyTagsData)) {
      const tags = contractTagsForNode(safeNodeId, journeyTagsData);
      const removeTags = catalogStrings(journeyTagsData?.contract_remove_tags?.[safeNodeId]);
      const skills = catalogStrings(journeyTagsData?.contract_skill_grants?.[safeNodeId]);
      const tagResult = await applyDirectJourneyTags(tx, player, tags, "add", schema.tagIdColumn, tagIdentityId);
      if (removeTags.length) await applyDirectJourneyTags(tx, player, removeTags, "remove", schema.tagIdColumn, tagIdentityId);
      const skillsGranted = await mutateContractSkills(tx, player.actorId, skills, "add");
      const dismissedContracts = await dismissActiveContracts(tx, player.actorId, contractShortNames(safeNodeId, journeyTagsData));
      const trackedContractCleared = await clearDanglingTrackedContract(tx, player.actorId);
      return { ok: true, player, nodeId: safeNodeId, updatedRows: 0, tagsApplied: tags.length, tagsRemoved: removeTags.length,
        factionBumps: tagResult.factionBumps, skillsGranted, dismissedContracts, trackedContractCleared, contract: true,
        message: "Contract completion was applied and will take effect on the next login." };
    }

    const journeyIdColumn = quoteIdentifier(schema.journeyIdColumn);
    const journeyIdentityId = playerJourneyIdentity(player, schema.journeyIdColumn);
    const updated = await tx.query(`
      update dune.journey_story_node
      set complete_condition_state = 'true'::jsonb, reveal_condition_state = 'true'::jsonb
      where ${journeyIdColumn} = $1
        and (story_node_id = $2 or story_node_id like $2 || '.%')`, [journeyIdentityId, safeNodeId]);
    let updatedRows = Number(updated.rowCount || 0);
    if (updatedRows === 0) {
      const fallback = await tx.query(`
        insert into dune.journey_story_node
          (${journeyIdColumn}, story_node_id, has_pending_reward, complete_condition_state, reveal_condition_state, fail_condition_state, metadata_state, reset_group)
        values ($1, $2, false, 'true'::jsonb, 'true'::jsonb, '{}'::jsonb, '{}'::jsonb, 'Default'::dune.JourneyStoryResetGroup)`, [journeyIdentityId, safeNodeId]);
      updatedRows = Number(fallback.rowCount || 1);
    }
    const tags = tagsForJourneyNodeSubtree(safeNodeId, journeyTagsData);
    if (journeyScopesOverlap(safeNodeId, FIND_FREMEN_JOURNEY_ROOT)) tags.push(FIND_FREMEN_REWARD_TAG);
    const uniqueTags = [...new Set(tags)];
    const tagResult = await applyDirectJourneyTags(tx, player, uniqueTags, "add", schema.tagIdColumn, tagIdentityId);
    let recipesGranted = 0;
    for (const recipe of journeyRewardRecipes(safeNodeId)) {
      if (await grantJourneyTechRecipe(tx, player.actorId, recipe)) recipesGranted += 1;
    }
    const spiceVisionEnabled = journeyScopesOverlap(safeNodeId, FIND_FREMEN_JOURNEY_ROOT)
      ? await enableJourneySpiceVision(tx, player.actorId)
      : false;
    return { ok: true, player, nodeId: safeNodeId, updatedRows, tagsApplied: uniqueTags.length,
      factionBumps: tagResult.factionBumps, recipesGranted, spiceVisionEnabled,
      message: "Journey completion and its known rewards were applied and will take effect on the next login." };
  });
}

export async function resetJourneyNode(db, id, { nodeId }, journeyTagsData = {}) {
  const schema = await journeyIdentitySchema(db);
  await requireCapability(await supportsJourneySchema(db, schema), "Journey reset is unavailable for this game database schema.");
  const safeNodeId = validateJourneyNodeId(nodeId);
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    requireOfflinePlayer(player, "Journey changes");
    const tagIdentityId = playerJourneyIdentity(player, schema.tagIdColumn);
    if (isContractNode(safeNodeId, journeyTagsData)) {
      const tags = contractTagsForNode(safeNodeId, journeyTagsData);
      const skills = catalogStrings(journeyTagsData?.contract_skill_grants?.[safeNodeId]);
      await applyDirectJourneyTags(tx, player, tags, "remove", schema.tagIdColumn, tagIdentityId);
      const skillsRemoved = await mutateContractSkills(tx, player.actorId, skills, "remove");
      return { ok: true, player, nodeId: safeNodeId, updatedRows: 0, tagsRemoved: tags.length, skillsRemoved, contract: true,
        message: "Contract flags were reset for the next login. A contract item already consumed by completion is not recreated." };
    }
    const journeyIdColumn = quoteIdentifier(schema.journeyIdColumn);
    const journeyIdentityId = playerJourneyIdentity(player, schema.journeyIdColumn);
    const updated = await tx.query(`
      update dune.journey_story_node
      set complete_condition_state = 'false'::jsonb, has_pending_reward = false
      where ${journeyIdColumn} = $1 and (story_node_id = $2 or story_node_id like $2 || '.%')`, [journeyIdentityId, safeNodeId]);
    const tags = tagsForJourneyNodeSubtree(safeNodeId, journeyTagsData);
    await applyDirectJourneyTags(tx, player, tags, "remove", schema.tagIdColumn, tagIdentityId);
    return { ok: true, player, nodeId: safeNodeId, updatedRows: Number(updated.rowCount || 0), tagsRemoved: tags.length,
      message: "Journey state and mapped tags were reset for the next login. Previously granted rewards are retained." };
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
  if (Object.prototype.hasOwnProperty.call(values || {}, "max_durability") && values.max_durability !== null && values.max_durability !== "") {
    throw new Error("Maximum durability is read-only because it is determined by the item created in-game");
  }
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

    const hasCurrent = Object.prototype.hasOwnProperty.call(nextValues, "current_durability") && nextValues.current_durability !== null && nextValues.current_durability !== "";
    if (hasCurrent) {
      const stats = owned.rows[0].stats || {};
      const durability = { ...(stats.FItemStackAndDurabilityStats?.[1] || {}) };
      const maxDurability = Number(durability.MaxDurability);
      const storedMaxValue = Number.isFinite(maxDurability) && maxDurability !== 0
        ? durability.MaxDurability
        : durability.DecayedMaxDurability;
      const storedMax = numberParam(storedMaxValue, "stored max durability", 0);
      const nextCurrent = numberParam(nextValues.current_durability, "current durability", 0, storedMax);
      durability.CurrentDurability = nextCurrent;
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
  if (isStandaloneAugmentTemplate(templateId)) {
    const payload = rollPayloads.get(templateId)?.rollData;
    if (!payload) throw new Error(`Cannot build standalone augment payload for: ${templateId}.`);
    stats.FAugmentItemStats = [[], payload];
  }
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
    const standaloneAugment = isStandaloneAugmentTemplate(resolvedTemplate);
    const rollPayloads = await loadAugmentRollPayloads(
      tx,
      standaloneAugment ? [resolvedTemplate] : augmentIds,
      standaloneAugment ? qualityLevel : augmentQualityLevel,
      { sourceTemplateId: resolvedTemplate }
    );
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

// Every power device at a base, with the inventory its fuel lives in. Claim
// resolution mirrors portalGeneratorFuel so both agree on which placeables
// belong to a base, and classification is the same explicit allowlist — an
// unknown placeable is left out entirely rather than assumed to burn oil.
export async function baseGenerators(db, baseId) {
  const target = intParam(baseId, "base id", 1);
  const result = await db.query(`
    with requested_claims as (
      select distinct b.id, afe.actor_id
      from dune.buildings b
      join dune.building_instances bi on bi.building_id = b.id
      join dune.actor_fgl_entities afe on afe.entity_id = bi.owner_entity_id
      where b.id = $1
    ), base_entities as (
      select distinct rc.id, claim_afe.entity_id as owner_entity_id
      from requested_claims rc
      join dune.actor_fgl_entities claim_afe on claim_afe.actor_id = rc.actor_id
    ), generator_types as (
      select * from unnest($2::text[], $3::text[]) as t(generator_type, building_type)
    )
    select distinct p.id::text as placeable_id,
      gt.generator_type,
      inv.id::text as inventory_id,
      coalesce(inv.max_item_count, 0)::int as max_item_count
    from base_entities be
    join dune.placeables p on p.owner_entity_id = be.owner_entity_id
    join generator_types gt on gt.building_type = lower(p.building_type)
    left join lateral (
      select id, max_item_count from dune.inventories where actor_id = p.id order by id limit 1
    ) inv on true
    order by placeable_id`, [
      target,
      GENERATOR_BUILDING_TYPE_PAIRS.map(([type]) => type),
      GENERATOR_BUILDING_TYPE_PAIRS.map(([, buildingType]) => buildingType)
    ]);
  return result.rows;
}

// Per-device fuel level for one base, as a fraction of the same cap
// refillBaseGenerators would fill to. Device discovery goes through
// baseGenerators so the reading and the write share one allowlist and can never
// disagree about what counts as a generator.
//
// This is deliberately per-device rather than reusing portalGeneratorFuel, which
// aggregates by (base_id, generator_type): that shape cannot see a single
// starved device standing among full siblings of the same type, and that device
// is exactly what an automated refill decision turns on.
//
// lowestPercent is null for a base with no recognised devices, not 0 -- "nothing
// to measure" must not read as "empty" to a caller deciding whether to refill.
export async function baseGeneratorFuelLevels(db, repoRoot, baseId) {
  const target = intParam(baseId, "base id", 1);
  const caps = refillCaps(repoRoot);
  const devices = await baseGenerators(db, target);
  const inventoryIds = devices.map((device) => device.inventory_id).filter(Boolean);

  // One grouped read for every device at the base rather than a query per
  // device: this runs for every enrolled base on each scan.
  const stocked = new Map();
  if (inventoryIds.length) {
    const result = await db.query(`
      select inventory_id::text as inventory_id,
        lower(template_id) as template_id,
        sum(stack_size)::int as units
      from dune.items
      where inventory_id = any($1::bigint[])
      group by 1, 2`, [inventoryIds]);
    for (const row of result.rows || []) {
      stocked.set(`${row.inventory_id}:${row.template_id}`, Number(row.units) || 0);
    }
  }

  const entries = [];
  for (const device of devices) {
    const cap = caps[device.generator_type];
    if (!cap) continue;
    // A device with no inventory row cannot hold fuel at all, so it reads as
    // empty -- the same case refillBaseGenerators reports as "no-inventory".
    const units = device.inventory_id
      ? stocked.get(`${device.inventory_id}:${cap.templateId.toLowerCase()}`) || 0
      : 0;
    entries.push({
      placeableId: device.placeable_id,
      generatorType: device.generator_type,
      units,
      cap: cap.totalCap,
      percent: cap.totalCap > 0 ? Math.round((units / cap.totalCap) * 1000) / 10 : 0
    });
  }

  return {
    baseId: target,
    deviceCount: entries.length,
    devices: entries,
    lowestPercent: entries.length ? Math.min(...entries.map((entry) => entry.percent)) : null
  };
}

// Tops every power device at a base up to its configured cap in one
// transaction: partial stacks are filled before new rows are created, so a
// device never ends up with more rows than the game would have made itself.
export async function refillBaseGenerators(db, repoRoot, baseId) {
  await requireCapability(
    await supportsGeneratorRefill(db),
    "Generator refill requires dune.placeables plus compatible dune.inventories and dune.items insert columns."
  );
  const target = intParam(baseId, "base id", 1);
  const caps = refillCaps(repoRoot);

  return db.transaction(async (tx) => {
    const itemColumns = await columnsFor(tx, "items");
    const devices = await baseGenerators(tx, target);
    if (!devices.length) throw new Error("No generators or wind turbines were found at this base");

    const refilled = [];
    for (const device of devices) {
      const type = GENERATOR_TYPES[device.generator_type];
      const cap = caps[device.generator_type];
      if (!type || !cap) continue;
      const summary = {
        placeableId: device.placeable_id,
        type: device.generator_type,
        label: type.name,
        fuelName: type.fuelName
      };
      if (!device.inventory_id) {
        refilled.push({ ...summary, before: 0, after: 0, added: 0, skipped: "no-inventory" });
        continue;
      }

      // Lock the inventory row itself before its fuel rows: FOR UPDATE only
      // locks rows it selects, so a device with zero fuel rows (new, or fully
      // drained) leaves nothing for a concurrent refill to serialize against.
      // The inventory row always exists once inventory_id is set, so locking
      // it first gives concurrent refills of the same device something to
      // queue behind -- same technique as giveItemToStorage/giveItemToPlayer.
      await tx.query("select id from dune.inventories where id = $1 for update", [device.inventory_id]);

      // Lock this device's fuel rows so a concurrent refill cannot double-fill it.
      const existing = await tx.query(`
        select id, stack_size, position_index
        from dune.items
        where inventory_id = $1 and lower(template_id) = lower($2)
        order by position_index
        for update`, [device.inventory_id, cap.templateId]);

      const before = existing.rows.reduce((sum, row) => sum + (Number(row.stack_size) || 0), 0);
      let deficit = Math.max(0, cap.totalCap - before);
      if (deficit === 0) {
        refilled.push({ ...summary, before, after: before, added: 0, capped: false });
        continue;
      }

      for (const row of existing.rows) {
        if (deficit === 0) break;
        const room = cap.stackSize - (Number(row.stack_size) || 0);
        if (room <= 0) continue;
        const add = Math.min(room, deficit);
        await tx.query("update dune.items set stack_size = stack_size + $1 where id = $2", [add, row.id]);
        deficit -= add;
      }

      const slotCount = await tx.query(
        "select count(*)::int as count from dune.items where inventory_id = $1", [device.inventory_id]);
      let freeSlots = device.max_item_count > 0
        ? Math.max(0, device.max_item_count - (Number(slotCount.rows[0]?.count) || 0))
        : Number.MAX_SAFE_INTEGER;
      let stacksAllowed = Math.max(0, cap.maxStacks - existing.rows.length);
      const position = await tx.query(
        "select coalesce(max(position_index), -1)::int + 1 as position_index from dune.items where inventory_id = $1",
        [device.inventory_id]);
      let nextPosition = Number(position.rows[0]?.position_index) || 0;

      while (deficit > 0 && stacksAllowed > 0 && freeSlots > 0) {
        const size = Math.min(cap.stackSize, deficit);
        const insert = itemInsertShape(
          ["inventory_id", "template_id", "stack_size", "quality_level", "position_index", "stats"],
          [device.inventory_id, cap.templateId, size, 0, nextPosition, JSON.stringify({})],
          itemColumns
        );
        await tx.query(`
          insert into dune.items (${insert.columns.join(", ")})
          values (${insert.values.map((_, index) => index === 5 ? `$${index + 1}::jsonb` : `$${index + 1}`).join(", ")})`,
          insert.values);
        deficit -= size;
        nextPosition += 1;
        stacksAllowed -= 1;
        freeSlots -= 1;
      }

      const after = cap.totalCap - deficit;
      refilled.push({ ...summary, before, after, added: after - before, capped: deficit > 0 });
    }

    return {
      ok: true,
      baseId: target,
      devices: refilled,
      totalAdded: refilled.reduce((sum, entry) => sum + (entry.added || 0), 0)
    };
  });
}

// Pending-refill queue. A refill written while the base's map has a live game
// server can be silently overwritten the next time that server flushes its own
// state to Postgres, so a refill aimed at a running map is recorded here and
// applied later, in the window where that map is down (see flushGeneratorRefills).
const PENDING_REFILL_PATH = "runtime/generated/pending-generator-refills.json";
const MAX_PENDING_REFILLS = 500;
const MAX_REFILL_FLUSH_ATTEMPTS = 3;

// Backstops for an entry that can never succeed. The attempt limit only counts
// failures classified as permanent, and that classification is a guess from an
// error string -- a genuinely permanent fault whose message looks transient
// (a dropped table reads as `relation ... does not exist`) would otherwise be
// retried on every tick forever. The age limit bounds the entry's life whatever
// its errors say, and the retry delay keeps a failing entry from being retried
// at the full tick rate in the meantime.
function pendingRefillMaxAgeMs() {
  return clampInt(process.env.ADMIN_REFILL_MAX_AGE_MS, 7 * 24 * 60 * 60 * 1000, 1, Number.MAX_SAFE_INTEGER);
}
function pendingRefillRetryDelayMs() {
  return clampInt(process.env.ADMIN_REFILL_RETRY_DELAY_MS, 60000, 1, Number.MAX_SAFE_INTEGER);
}

function pendingRefillFile(repoRoot) {
  return resolve(repoRoot || "", PENDING_REFILL_PATH);
}

function normalizePendingRefill(entry) {
  const baseId = Math.floor(Number(entry?.baseId));
  if (!Number.isInteger(baseId) || baseId < 1) return null;
  const partitionId = Math.floor(Number(entry?.partitionId));
  return {
    baseId,
    map: String(entry?.map ?? "").slice(0, 120),
    partitionId: Number.isInteger(partitionId) && partitionId > 0 ? partitionId : 0,
    queuedAt: typeof entry?.queuedAt === "string" ? entry.queuedAt.slice(0, 40) : "",
    attempts: clampInt(entry?.attempts, 0, 0, MAX_REFILL_FLUSH_ATTEMPTS),
    nextRetryAt: Number.isFinite(Number(entry?.nextRetryAt)) ? Number(entry.nextRetryAt) : 0,
    lastError: String(entry?.lastError ?? "").slice(0, 300)
  };
}

export function listQueuedGeneratorRefills(repoRoot) {
  const file = pendingRefillFile(repoRoot);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    // One entry per base, so a double-clicked button cannot queue a base twice.
    const seen = new Set();
    return parsed.map(normalizePendingRefill).filter((entry) => {
      if (!entry || seen.has(entry.baseId)) return false;
      seen.add(entry.baseId);
      return true;
    });
  } catch (error) {
    console.warn(`Ignoring unreadable pending generator refill queue: ${redact(error?.message || "Unexpected error.")}`);
    return [];
  }
}

// Deliberately synchronous read-modify-write, matching saveBuybackSchedule in
// addonJobs.js: with no await between read and write, two requests in one
// console process cannot interleave and drop each other's entry. The temp-file
// rename covers crash safety.
function writeQueuedGeneratorRefills(repoRoot, entries) {
  writeJsonAtomic(pendingRefillFile(repoRoot), entries);
  return entries;
}

export function queueGeneratorRefill(repoRoot, { baseId, map = "", partitionId = 0, now = () => new Date() } = {}) {
  const entry = normalizePendingRefill({ baseId, map, partitionId, queuedAt: now().toISOString() });
  if (!entry) throw new Error("Invalid base id");
  const others = listQueuedGeneratorRefills(repoRoot).filter((row) => row.baseId !== entry.baseId);
  if (others.length >= MAX_PENDING_REFILLS) {
    throw new Error(`The pending refill queue already holds ${MAX_PENDING_REFILLS} bases. Restart the affected maps to apply them first.`);
  }
  writeQueuedGeneratorRefills(repoRoot, [...others, entry]);
  return entry;
}

export function cancelQueuedGeneratorRefill(repoRoot, baseId) {
  const target = intParam(baseId, "base id", 1);
  const entries = listQueuedGeneratorRefills(repoRoot);
  const remaining = entries.filter((entry) => entry.baseId !== target);
  if (remaining.length === entries.length) throw new Error("That base has no queued generator refill.");
  writeQueuedGeneratorRefills(repoRoot, remaining);
  return { ok: true, baseId: target, pending: remaining.length };
}

// How long a partition must stay disconnected before a write to its bases is
// considered safe. Absence of a connection is ambiguous in a single sample: a
// restarting map server and a Postgres restart that dropped every connection
// look identical. A reconnecting game server returns in seconds, a restarting
// one stays away for minutes, so requiring the gap to persist tells them apart.
function refillDownDwellMs() {
  return clampInt(process.env.ADMIN_REFILL_DOWN_DWELL_MS, 30000, 1, Number.MAX_SAFE_INTEGER);
}
const partitionDisconnectedSince = new Map();

export function _resetRefillPartitionDwellForTests() {
  partitionDisconnectedSince.clear();
}

// Observes which partitions are safe to write to. Returns null when
// dune.world_partition is absent: without it there is no way to tell a running
// map from a stopped one, so queueing is not offered at all and refills stay
// immediate (see supportsGeneratorRefillQueue).
//
// Connection state is read straight from pg_stat_activity, matching the
// "DuneSandbox - <server_id>" application_name a game server connects under.
// That is the same mechanism as the game's own dune.active_server_ids view, but
// queried directly: pg_stat_activity is a core catalog view present on every
// Postgres, so there is no second, weaker code path to fall back to. Testing
// world_partition.server_id instead would be exactly that weaker path --
// restartService on an always-on map replaces the container without ever
// clearing it, so those partitions would read as permanently live and their
// refills could never flush. This check is also deliberately broader than the
// view, which additionally requires a farm_state row: a server visible here but
// missing from farm_state still counts as connected, which errs toward leaving
// work queued.
//
// Two ways a partition becomes safe:
//   - its server_id is released entirely, which despawn does -- positive
//     evidence the map is gone, trusted immediately so a despawn/spawn pair
//     still gets its short window;
//   - its server_id is still assigned but has had no connection for the whole
//     dwell period, which covers restartService and stop/start, where the
//     assignment lingers.
// Anything else stays unsafe, so a momentary loss of visibility keeps refills
// queued instead of writing them into a live base.
export async function observeRefillPartitions(db, { now = Date.now } = {}) {
  if (!(await tableExists(db, "world_partition"))) return null;
  const result = await db.query(
    `select wp.partition_id,
            nullif(wp.server_id, '') is null as unassigned,
            exists (
              select 1 from pg_stat_activity sa
              where sa.application_name = 'DuneSandbox - ' || nullif(wp.server_id, '')
            ) as connected
     from dune.world_partition wp`);

  const timestamp = now();
  const safe = new Set();
  const known = new Set();
  for (const row of result.rows || []) {
    const partitionId = Number(row.partition_id || 0);
    if (partitionId <= 0) continue;
    known.add(partitionId);
    if (row.connected) {
      partitionDisconnectedSince.delete(partitionId);
      continue;
    }
    if (row.unassigned) {
      partitionDisconnectedSince.delete(partitionId);
      safe.add(partitionId);
      continue;
    }
    const since = partitionDisconnectedSince.get(partitionId) ?? timestamp;
    partitionDisconnectedSince.set(partitionId, since);
    if (timestamp - since >= refillDownDwellMs()) safe.add(partitionId);
  }
  for (const partitionId of [...partitionDisconnectedSince.keys()]) {
    if (!known.has(partitionId)) partitionDisconnectedSince.delete(partitionId);
  }
  return { safe, known };
}

// A base outside any known partition is simulated by nothing, so it is always
// safe; a null observation means the queue is unsupported and writes stay
// immediate, matching the behaviour before the queue existed.
function partitionWriteSafe(observed, partitionId) {
  if (!observed) return true;
  if (partitionId <= 0) return true;
  if (!observed.known.has(partitionId)) return true;
  return observed.safe.has(partitionId);
}

// generatorRefill accepts an already-known flag so a caller that just
// computed supportsGeneratorRefill (e.g. listBases) doesn't pay for a second,
// redundant re-derivation of the same boolean on every call.
export async function supportsGeneratorRefillQueue(db, { generatorRefill } = {}) {
  const supported = generatorRefill !== undefined ? generatorRefill : await supportsGeneratorRefill(db);
  if (!supported) return false;
  return tableExists(db, "world_partition");
}

// dune.actors.map and dune.world_partition.map are different namespaces: a base
// on partition 1 reports the in-game region ("HaggaBasin") while the partition
// itself is "Survival_1", and partition 8 reports "DeepDesert" against
// "DeepDesert_1". Only the world_partition name lines up with the restart
// machinery, so anything choosing a restart target has to resolve it from the
// partition id rather than from whatever the base's actor row says.
export async function partitionRestartTargets(db) {
  if (!(await tableExists(db, "world_partition"))) return new Map();
  const result = await db.query(
    "select partition_id, map, coalesce(dimension_index, 0)::int as dimension_index from dune.world_partition");
  const targets = new Map();
  for (const row of result.rows || []) {
    const partitionId = Number(row.partition_id || 0);
    if (partitionId > 0) targets.set(partitionId, { map: String(row.map || ""), dimensionIndex: Number(row.dimension_index || 0) });
  }
  return targets;
}

// The map and partition a base sits in. Resolved server-side on every request:
// whether a write is safe must never depend on a client-supplied map name.
//
// Left-joined rather than inner-joined so a base whose owner-entity link is
// broken (building_instances.owner_entity_id is nullable, ON DELETE SET NULL
// against fgl_entities) is distinguished from a base that never existed --
// autoRefill.js pattern-matches the "was not found" text specifically to
// decide whether to un-enroll a base, so the two cases must throw different
// messages rather than collapse a broken link into "no longer exists".
// order by prefers a resolved sibling piece the same way basePermissionActor
// does, so a multi-piece base with one orphaned piece still resolves cleanly.
export async function baseMapLocation(db, baseId) {
  const target = intParam(baseId, "base id", 1);
  const result = await db.query(`
    select a.id::text as actor_id,
           coalesce(a.map, '') as map,
           coalesce(a.partition_id, 0)::int as partition_id
    from dune.buildings b
    left join dune.building_instances bi on bi.building_id = b.id
    left join dune.actor_fgl_entities afe on afe.entity_id = bi.owner_entity_id
    left join dune.actors a on a.id = afe.actor_id
    where b.id = $1
    order by (a.id is null) asc, bi.instance_id asc
    limit 1`, [target]);
  const row = result.rows[0];
  if (!row) throw new Error("That base was not found.");
  if (!row.actor_id) throw new Error("This base has no resolvable owner entity, so its map location is unavailable.");
  return { map: String(row.map || ""), partitionId: Number(row.partition_id || 0) };
}

// One probe for the refill route: where the base lives, and whether its map is
// live enough that an immediate write would be at risk.
// `observed` lets a caller looping over many bases in one pass (the auto-refill
// scan) observe the cluster once and reuse it, instead of every base re-running
// the same world_partition/pg_stat_activity query.
export async function baseRefillTarget(db, baseId, { observed } = {}) {
  const resolvedObserved = observed !== undefined ? observed : await observeRefillPartitions(db);
  // Check queue support first. With no way to tell a running map from a stopped
  // one there is nothing to decide, and resolving the base's location would
  // mean querying dune.actors columns an older schema need not have -- which
  // would turn an unsupported queue into a broken refill.
  if (!resolvedObserved) return { map: "", partitionId: 0, queueSupported: false, writeSafeNow: true };
  const location = await baseMapLocation(db, baseId);
  return {
    ...location,
    queueSupported: true,
    writeSafeNow: partitionWriteSafe(resolvedObserved, location.partitionId)
  };
}

// A database that is restarting, or a schema mid-migration, will succeed on a
// later tick. Mirrors the filter runBackgroundTick and the death poller already
// use for the same "the stack is moving, not broken" states.
function isTransientFlushError(message) {
  return /connect|ECONNREFUSED|ECONNRESET|terminated|timeout|does not exist|relation|shutting down|starting up|deadlock|too many clients/i.test(message);
}

// Applies every queued refill whose map is currently down and leaves the rest
// queued. Driven by a background tick rather than by the restart task runner:
// stop-all.sh removes the Postgres container along with the game servers, so
// there is no post-stop moment when the console could still write. The window
// that does exist is on the way back up (start-all.sh brings Postgres up well
// before the map servers) plus any single-map despawn, and polling for "this
// partition has no server" catches both -- including restarts triggered by the
// scheduler, an IP change, or the CLI, none of which run through the console.
export async function flushGeneratorRefills(db, repoRoot, { now = Date.now } = {}) {
  const pending = listQueuedGeneratorRefills(repoRoot);
  if (!pending.length) return { flushed: [], pending: 0 };
  const observed = await observeRefillPartitions(db, { now });
  if (!observed) return { flushed: [], pending: pending.length, unsupported: true };

  const flushed = [];
  const outcomes = new Map();
  const timestamp = now();
  for (const entry of pending) {
    // Age is checked before write-safety: an expired entry should be cleared
    // even for a map that never comes down again.
    const queuedMs = Date.parse(entry.queuedAt);
    if (Number.isFinite(queuedMs) && timestamp - queuedMs >= pendingRefillMaxAgeMs()) {
      const message = `Queued for longer than the ${Math.round(pendingRefillMaxAgeMs() / 3600000)}h limit without being applied.`;
      outcomes.set(entry.baseId, { queuedAt: entry.queuedAt, keep: false });
      flushed.push({ baseId: entry.baseId, map: entry.map, partitionId: entry.partitionId, ok: false, expired: true, dropped: true, error: message });
      continue;
    }
    if (!partitionWriteSafe(observed, entry.partitionId)) continue;
    if (entry.nextRetryAt && timestamp < entry.nextRetryAt) continue;
    try {
      const result = await refillBaseGenerators(db, repoRoot, entry.baseId);
      outcomes.set(entry.baseId, { queuedAt: entry.queuedAt, keep: false });
      flushed.push({
        baseId: entry.baseId,
        map: entry.map,
        partitionId: entry.partitionId,
        ok: true,
        totalAdded: result.totalAdded,
        devices: result.devices
      });
    } catch (error) {
      // A base can be released or deleted while its refill sits queued, so a
      // failure that will never succeed must not be retried on every tick
      // forever. Transient failures do not burn an attempt: start-all.sh runs
      // update-db.sh inside the very window this flush targets, and three
      // strikes at a few seconds apart would otherwise all land inside one
      // migration and silently discard the operator's request.
      const message = String(error?.message || "Unexpected error.").slice(0, 300);
      const attempts = isTransientFlushError(message) ? entry.attempts : entry.attempts + 1;
      const dropped = attempts >= MAX_REFILL_FLUSH_ATTEMPTS;
      const nextRetryAt = timestamp + pendingRefillRetryDelayMs();
      outcomes.set(entry.baseId, { queuedAt: entry.queuedAt, keep: !dropped, attempts, nextRetryAt, lastError: message });
      flushed.push({ baseId: entry.baseId, map: entry.map, partitionId: entry.partitionId, ok: false, attempts, dropped, error: message });
    }
  }
  const remaining = outcomes.size ? reconcileQueuedGeneratorRefills(repoRoot, outcomes) : pending;
  return { flushed, pending: remaining.length };
}

// Applies this flush's outcomes to whatever the queue holds *now*, in one
// synchronous read-modify-write. The loop above awaits a database transaction
// per base, and a refill queued or canceled during one of those awaits would be
// lost if the pre-flush snapshot were written back wholesale.
//
// An entry is only touched when its queuedAt still matches the one that was
// processed, so a base canceled and re-queued mid-flush keeps its new entry.
// Cancelling a base whose refill is already mid-transaction cannot recall the
// write; it only stops the entry coming back.
function reconcileQueuedGeneratorRefills(repoRoot, outcomes) {
  const next = [];
  for (const entry of listQueuedGeneratorRefills(repoRoot)) {
    const outcome = outcomes.get(entry.baseId);
    if (!outcome || outcome.queuedAt !== entry.queuedAt) {
      next.push(entry);
      continue;
    }
    if (outcome.keep) next.push({ ...entry, attempts: outcome.attempts, nextRetryAt: outcome.nextRetryAt, lastError: outcome.lastError });
  }
  writeQueuedGeneratorRefills(repoRoot, next);
  return next;
}

// ---------------------------------------------------------------------------
// Base deletion
//
// Permanently removes a base and everything on it. Like a refill, a delete
// aimed at a live map's rows can be silently overwritten the next time that
// map flushes its own state back to Postgres, so this reuses the exact same
// pending-queue/write-safety machinery as the generator refill queue above --
// see baseRefillTarget, observeRefillPartitions, partitionWriteSafe,
// isTransientFlushError. It diverges from that queue in two ways, both noted
// where they happen: a vanished base is success, not a retryable failure, and
// the mandatory pre-delete safety backup is the caller's responsibility (kept
// out of this file -- it shells out to the `dune` CLI, which duneDb.js never
// does; see flushBaseDeletes's onBeforeApply and server.js's baseDeleteRoute).

const PENDING_BASE_DELETE_PATH = "runtime/generated/pending-base-deletes.json";
// Lower than MAX_PENDING_REFILLS: a large backlog of pending deletes is
// itself a signal worth surfacing early, not silently absorbing.
const MAX_PENDING_BASE_DELETES = 200;
const MAX_DELETE_FLUSH_ATTEMPTS = 3;

function pendingBaseDeleteMaxAgeMs() {
  return clampInt(process.env.ADMIN_BASE_DELETE_MAX_AGE_MS, 7 * 24 * 60 * 60 * 1000, 1, Number.MAX_SAFE_INTEGER);
}
function pendingBaseDeleteRetryDelayMs() {
  return clampInt(process.env.ADMIN_BASE_DELETE_RETRY_DELAY_MS, 60000, 1, Number.MAX_SAFE_INTEGER);
}

function pendingBaseDeleteFile(repoRoot) {
  return resolve(repoRoot || "", PENDING_BASE_DELETE_PATH);
}

// Intent only, like normalizePendingRefill -- no captured actor-id list, so
// flushBaseDeletes re-enumerates fresh at flush time rather than trusting
// what existed when the delete was requested.
function normalizePendingBaseDelete(entry) {
  const baseId = Math.floor(Number(entry?.baseId));
  if (!Number.isInteger(baseId) || baseId < 1) return null;
  const partitionId = Math.floor(Number(entry?.partitionId));
  return {
    baseId,
    map: String(entry?.map ?? "").slice(0, 120),
    partitionId: Number.isInteger(partitionId) && partitionId > 0 ? partitionId : 0,
    queuedAt: typeof entry?.queuedAt === "string" ? entry.queuedAt.slice(0, 40) : "",
    attempts: clampInt(entry?.attempts, 0, 0, MAX_DELETE_FLUSH_ATTEMPTS),
    nextRetryAt: Number.isFinite(Number(entry?.nextRetryAt)) ? Number(entry.nextRetryAt) : 0,
    lastError: String(entry?.lastError ?? "").slice(0, 300)
  };
}

export function listQueuedBaseDeletes(repoRoot) {
  const file = pendingBaseDeleteFile(repoRoot);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    // One entry per base, so a double-clicked button cannot queue it twice.
    const seen = new Set();
    return parsed.map(normalizePendingBaseDelete).filter((entry) => {
      if (!entry || seen.has(entry.baseId)) return false;
      seen.add(entry.baseId);
      return true;
    });
  } catch (error) {
    console.warn(`Ignoring unreadable pending base delete queue: ${redact(error?.message || "Unexpected error.")}`);
    return [];
  }
}

// Deliberately synchronous read-modify-write, matching writeQueuedGeneratorRefills.
function writeQueuedBaseDeletes(repoRoot, entries) {
  writeJsonAtomic(pendingBaseDeleteFile(repoRoot), entries);
  return entries;
}

export function queueBaseDelete(repoRoot, { baseId, map = "", partitionId = 0, now = () => new Date() } = {}) {
  const entry = normalizePendingBaseDelete({ baseId, map, partitionId, queuedAt: now().toISOString() });
  if (!entry) throw new Error("Invalid base id");
  const others = listQueuedBaseDeletes(repoRoot).filter((row) => row.baseId !== entry.baseId);
  if (others.length >= MAX_PENDING_BASE_DELETES) {
    throw new Error(`The pending delete queue already holds ${MAX_PENDING_BASE_DELETES} bases. Restart the affected maps to apply them first.`);
  }
  writeQueuedBaseDeletes(repoRoot, [...others, entry]);
  return entry;
}

export function cancelQueuedBaseDelete(repoRoot, baseId) {
  const target = intParam(baseId, "base id", 1);
  const entries = listQueuedBaseDeletes(repoRoot);
  const remaining = entries.filter((entry) => entry.baseId !== target);
  if (remaining.length === entries.length) throw new Error("That base has no queued delete.");
  writeQueuedBaseDeletes(repoRoot, remaining);
  return { ok: true, baseId: target, pending: remaining.length };
}

// basePermissionActor and baseMapLocation both throw one of these two
// messages for a base that was demolished or never existed, so a flush
// hitting either has already achieved what the queued delete wanted.
// Retrying would either spam a false failure or, worse, wait out the attempt
// limit before dropping an entry that was already done.
function baseDeleteAlreadyGone(message) {
  return /was not found|no resolvable owner entity/i.test(message);
}

// Mirrors flushGeneratorRefills, with two divergences:
//   - deleteBaseCompletely replaces refillBaseGenerators, since there is
//     nothing to recompute an "amount" for -- one delete, not a top-up;
//   - onBeforeApply runs at most once per pass, immediately before the first
//     entry that is actually about to be deleted (not merely queued): a full
//     database backup is not cheap, and several bases can flush in the same
//     pass (e.g. a whole battlegroup restart), so one backup covers the whole
//     batch instead of one per base. If it throws, the entire pass aborts --
//     a failed safety backup is not about any one base, and deleting others
//     without it would defeat the point just the same. Every entry stays
//     queued and is retried, backup included, on the next tick.
export async function flushBaseDeletes(db, repoRoot, { now = Date.now, onBeforeApply } = {}) {
  const pending = listQueuedBaseDeletes(repoRoot);
  if (!pending.length) return { flushed: [], pending: 0 };
  const observed = await observeRefillPartitions(db, { now });
  if (!observed) return { flushed: [], pending: pending.length, unsupported: true };

  const flushed = [];
  const outcomes = new Map();
  const timestamp = now();
  let backedUp = false;
  for (const entry of pending) {
    // Age is checked before write-safety: an expired entry should be cleared
    // even for a map that never comes down again.
    const queuedMs = Date.parse(entry.queuedAt);
    if (Number.isFinite(queuedMs) && timestamp - queuedMs >= pendingBaseDeleteMaxAgeMs()) {
      const message = `Queued for longer than the ${Math.round(pendingBaseDeleteMaxAgeMs() / 3600000)}h limit without being applied.`;
      outcomes.set(entry.baseId, { queuedAt: entry.queuedAt, keep: false });
      flushed.push({ baseId: entry.baseId, map: entry.map, partitionId: entry.partitionId, ok: false, expired: true, dropped: true, error: message });
      continue;
    }
    if (!partitionWriteSafe(observed, entry.partitionId)) continue;
    if (entry.nextRetryAt && timestamp < entry.nextRetryAt) continue;
    if (!backedUp && onBeforeApply) {
      try {
        await onBeforeApply();
        backedUp = true;
      } catch (error) {
        return { flushed: [], pending: pending.length, backupFailed: true, error: String(error?.message || "Unexpected error.").slice(0, 300) };
      }
    }
    try {
      const result = await deleteBaseCompletely(db, entry.baseId);
      outcomes.set(entry.baseId, { queuedAt: entry.queuedAt, keep: false });
      flushed.push({ baseId: entry.baseId, map: entry.map, partitionId: entry.partitionId, ok: true, ...result });
    } catch (error) {
      const message = String(error?.message || "Unexpected error.").slice(0, 300);
      if (baseDeleteAlreadyGone(message)) {
        outcomes.set(entry.baseId, { queuedAt: entry.queuedAt, keep: false });
        flushed.push({ baseId: entry.baseId, map: entry.map, partitionId: entry.partitionId, ok: true, alreadyGone: true });
        continue;
      }
      const attempts = isTransientFlushError(message) ? entry.attempts : entry.attempts + 1;
      const dropped = attempts >= MAX_DELETE_FLUSH_ATTEMPTS;
      const nextRetryAt = timestamp + pendingBaseDeleteRetryDelayMs();
      outcomes.set(entry.baseId, { queuedAt: entry.queuedAt, keep: !dropped, attempts, nextRetryAt, lastError: message });
      flushed.push({ baseId: entry.baseId, map: entry.map, partitionId: entry.partitionId, ok: false, attempts, dropped, error: message });
    }
  }
  const remaining = outcomes.size ? reconcileQueuedBaseDeletes(repoRoot, outcomes) : pending;
  return { flushed, pending: remaining.length };
}

// Mirrors reconcileQueuedGeneratorRefills.
function reconcileQueuedBaseDeletes(repoRoot, outcomes) {
  const next = [];
  for (const entry of listQueuedBaseDeletes(repoRoot)) {
    const outcome = outcomes.get(entry.baseId);
    if (!outcome || outcome.queuedAt !== entry.queuedAt) {
      next.push(entry);
      continue;
    }
    if (outcome.keep) next.push({ ...entry, attempts: outcome.attempts, nextRetryAt: outcome.nextRetryAt, lastError: outcome.lastError });
  }
  writeQueuedBaseDeletes(repoRoot, next);
  return next;
}

// ---------------------------------------------------------------------------
// Water
//
// Water storage lives somewhere fundamentally different from generator fuel:
// the fill level is a JSONB scalar on the placeable's own component
// (FWaterStorageComponent.m_WaterStored), not a stack of discrete inventory
// items. Blood (Blood Purifier / Improved Blood Purifier only) is different
// again -- it isn't a component at all, but a Blueprint-class-keyed property
// on dune.actors.properties (BP_BloodWaterExtractor[_Advanced]_C.m_CurrentAmount).
// Both mechanisms, every building_type, and every capacity below were
// confirmed against a live database rather than inferred from display names.
// ---------------------------------------------------------------------------

const WATER_TYPES = {
  waterCistern: {
    name: "Water Cistern",
    buildingTypes: ["watercistern_placeable"],
    capacity: 5000
  },
  mediumWaterCistern: {
    name: "Medium Water Cistern",
    buildingTypes: ["mediumwatercistern_placeable"],
    capacity: 25000
  },
  largeWaterCistern: {
    name: "Large Water Cistern",
    buildingTypes: ["largewatercistern_placeable"],
    capacity: 100000
  },
  windtrap: {
    name: "Windtrap",
    buildingTypes: ["windtrap_placeable"],
    capacity: 500
  },
  // Displays in-game as "Blood Purifier" / "Improved Blood Purifier" (see
  // runtime/data/admin-items.json's BloodWaterExtraction[Advanced]_Patent
  // entries) -- building_type keeps the game's own internal name.
  bloodWaterExtractor: {
    name: "Blood Purifier",
    buildingTypes: ["bloodwaterextractor_placeable"],
    capacity: 1000,
    bloodPropertyKey: "BP_BloodWaterExtractor_C",
    bloodCapacity: 6000
  },
  bloodWaterExtractorAdvanced: {
    name: "Improved Blood Purifier",
    buildingTypes: ["bloodwaterextractionadvanced_placeable"],
    capacity: 1000,
    bloodPropertyKey: "BP_BloodWaterExtractor_Advanced_C",
    bloodCapacity: 24000
  }
};

const WATER_TYPE_ORDER = [
  "waterCistern", "mediumWaterCistern", "largeWaterCistern",
  "windtrap", "bloodWaterExtractor", "bloodWaterExtractorAdvanced"
];

const WATER_BUILDING_TYPE_PAIRS = WATER_TYPE_ORDER.flatMap(
  (type) => WATER_TYPES[type].buildingTypes.map((buildingType) => [type, buildingType])
);

function waterTypeParams() {
  return [
    WATER_BUILDING_TYPE_PAIRS.map(([type]) => type),
    WATER_BUILDING_TYPE_PAIRS.map(([, buildingType]) => buildingType)
  ];
}

// Every water container at a base, grouped by type -- the Water tab's shape.
// Mirrors portalGeneratorFuel, but for one base rather than many, and reads
// levels straight off each placeable's own row rather than an inventory:
// there is no fuel-cell-style consumable involved.
export async function baseWater(db, baseId) {
  const target = intParam(baseId, "base id", 1);
  // Every table the query below touches, including fgl_entities inside the
  // lateral -- a missing one raises a bare Postgres error otherwise, which the
  // tab could only render as a failed request with a retry that can never
  // succeed. listBases probes four of these, but not placeables or
  // fgl_entities, so a schema can list bases fine and still be unable to
  // answer this: that is exactly the case the capability response is for.
  const required = ["buildings", "building_instances", "actor_fgl_entities", "placeables", "actors", "fgl_entities"];
  // Independent probes, so one round-trip rather than six in series.
  const present = await Promise.all(required.map((table) => tableExists(db, table)));
  const missing = required.filter((_, index) => !present[index]);
  if (missing.length) {
    return {
      supported: false,
      reason: `Unsupported by detected schema. Missing required table(s): ${missing.map((table) => `dune.${table}`).join(", ")}`,
      baseId: target,
      containers: []
    };
  }
  const [types, buildingTypes] = waterTypeParams();
  const bloodKeys = WATER_BUILDING_TYPE_PAIRS.map(([type]) => WATER_TYPES[type].bloodPropertyKey || null);
  const result = await db.query(`
    with requested_claims as (
      select distinct b.id, afe.actor_id
      from dune.buildings b
      join dune.building_instances bi on bi.building_id = b.id
      join dune.actor_fgl_entities afe on afe.entity_id = bi.owner_entity_id
      where b.id = $1
    ), base_entities as (
      select distinct rc.id, claim_afe.entity_id as owner_entity_id
      from requested_claims rc
      join dune.actor_fgl_entities claim_afe on claim_afe.actor_id = rc.actor_id
    ), water_types as (
      select * from unnest($2::text[], $3::text[], $4::text[]) as t(water_type, building_type, blood_property_key)
    ), containers as (
      select p.id as placeable_id, wt.water_type,
        coalesce(state.stored, 0) as water_stored,
        case when wt.blood_property_key is not null
          then (a.properties -> wt.blood_property_key ->> 'm_CurrentAmount')::numeric
          else null
        end as blood_stored
      from base_entities be
      join dune.placeables p on p.owner_entity_id = be.owner_entity_id
      join dune.actors a on a.id = p.id
      join water_types wt on wt.building_type = lower(p.building_type)
      left join lateral (
        -- Guarded + limit 1: some water placeables carry a second
        -- actor_fgl_entities row (slot_name='ContainerInventory') alongside
        -- the one that actually holds FWaterStorageComponent. An unguarded
        -- join fans out and double-counts the container -- confirmed live
        -- against dune2 (a base's Windtrap count read 7 instead of 4).
        select (fe.components->'FWaterStorageComponent'->1->>'m_WaterStored')::int as stored
        from dune.actor_fgl_entities afe
        join dune.fgl_entities fe on fe.entity_id = afe.entity_id
        where afe.actor_id = p.id and fe.components ? 'FWaterStorageComponent'
        limit 1
      ) state on true
    )
    select water_type, count(*)::int as container_count,
      sum(water_stored)::int as water_stored,
      sum(blood_stored)::numeric as blood_stored
    from containers group by water_type`, [target, types, buildingTypes, bloodKeys]);

  const containers = result.rows.map((row) => {
    const type = row.water_type;
    const spec = WATER_TYPES[type];
    const count = Number(row.container_count) || 0;
    const stored = Number(row.water_stored) || 0;
    const capacity = count * spec.capacity;
    const entry = {
      type,
      name: spec.name,
      count,
      stored,
      capacity,
      percent: capacity > 0 ? Math.round((stored / capacity) * 1000) / 10 : 0
    };
    if (spec.bloodCapacity) {
      const bloodStored = Math.round(Number(row.blood_stored) || 0);
      const bloodCapacity = count * spec.bloodCapacity;
      entry.bloodStored = bloodStored;
      entry.bloodCapacity = bloodCapacity;
      entry.bloodPercent = bloodCapacity > 0 ? Math.round((bloodStored / bloodCapacity) * 1000) / 10 : 0;
    }
    return entry;
  }).sort((left, right) => WATER_TYPE_ORDER.indexOf(left.type) - WATER_TYPE_ORDER.indexOf(right.type));

  return { supported: true, baseId: target, containers };
}

// Every water device at a base, individually. Refill and the auto-refill scan
// (like baseGeneratorFuelLevels) need to see and write each one, not just a
// per-type total -- entity_id is resolved here through the same guarded
// lateral used by baseWater, so reading and writing can never disagree about
// which fgl_entities row backs a given placeable.
export async function baseWaterDevices(db, baseId) {
  const target = intParam(baseId, "base id", 1);
  const [types, buildingTypes] = waterTypeParams();
  const result = await db.query(`
    with requested_claims as (
      select distinct b.id, afe.actor_id
      from dune.buildings b
      join dune.building_instances bi on bi.building_id = b.id
      join dune.actor_fgl_entities afe on afe.entity_id = bi.owner_entity_id
      where b.id = $1
    ), base_entities as (
      select distinct rc.id, claim_afe.entity_id as owner_entity_id
      from requested_claims rc
      join dune.actor_fgl_entities claim_afe on claim_afe.actor_id = rc.actor_id
    ), water_types as (
      select * from unnest($2::text[], $3::text[]) as t(water_type, building_type)
    )
    select distinct p.id::text as placeable_id, wt.water_type, entity.entity_id::text as entity_id
    from base_entities be
    join dune.placeables p on p.owner_entity_id = be.owner_entity_id
    join water_types wt on wt.building_type = lower(p.building_type)
    left join lateral (
      select afe.entity_id
      from dune.actor_fgl_entities afe
      join dune.fgl_entities fe on fe.entity_id = afe.entity_id
      where afe.actor_id = p.id and fe.components ? 'FWaterStorageComponent'
      limit 1
    ) entity on true
    order by placeable_id`, [target, types, buildingTypes]);
  return result.rows;
}

export async function supportsWaterRefill(db) {
  if (!(await tableExists(db, "placeables"))) return false;
  if (!(await tableExists(db, "actor_fgl_entities")) || !(await tableExists(db, "fgl_entities"))) return false;
  const placeableColumns = await columnsFor(db, "placeables");
  return ["id", "owner_entity_id", "building_type"].every((column) => placeableColumns.has(column));
}

// Mirrors supportsGeneratorRefillQueue's waterRefill-reuse parameter, for the
// same reason.
export async function supportsWaterRefillQueue(db, { waterRefill } = {}) {
  const supported = waterRefill !== undefined ? waterRefill : await supportsWaterRefill(db);
  if (!supported) return false;
  return tableExists(db, "world_partition");
}

// Tops every water device at a base up to its configured cap, straight into
// FWaterStorageComponent -- one jsonb_set per device, no stack/slot
// bookkeeping like generator fuel needs (water is a scalar, not a stack of
// discrete items). Blood (dune.actors.properties) is never touched here: per
// user decision it's meant to be gathered in-world, not admin-conjured.
export async function refillBaseWater(db, baseId) {
  await requireCapability(await supportsWaterRefill(db),
    "Water refill requires dune.placeables, dune.actor_fgl_entities, and dune.fgl_entities.");
  const target = intParam(baseId, "base id", 1);
  const devices = await baseWaterDevices(db, target);
  if (!devices.length) throw new Error("No water storage was found at this base");

  return db.transaction(async (tx) => {
    const refilled = [];
    for (const device of devices) {
      const spec = WATER_TYPES[device.water_type];
      const summary = { placeableId: device.placeable_id, type: device.water_type, label: spec.name };
      if (!device.entity_id) {
        refilled.push({ ...summary, before: 0, after: 0, added: 0 });
        continue;
      }
      // Lock the entity row before reading it, so a concurrent refill of the
      // same device can't race the read-then-write -- same technique
      // refillBaseGenerators uses for its inventory rows.
      const current = await tx.query(
        `select (components->'FWaterStorageComponent'->1->>'m_WaterStored')::int as stored
         from dune.fgl_entities where entity_id = $1 for update`, [device.entity_id]);
      const before = Number(current.rows[0]?.stored) || 0;
      const cap = spec.capacity;
      if (before >= cap) {
        refilled.push({ ...summary, before, after: before, added: 0 });
        continue;
      }
      await tx.query(
        `update dune.fgl_entities
         set components = jsonb_set(components, '{FWaterStorageComponent,1,m_WaterStored}', to_jsonb($1::int))
         where entity_id = $2`, [cap, device.entity_id]);
      refilled.push({ ...summary, before, after: cap, added: cap - before });
    }
    return {
      ok: true,
      baseId: target,
      devices: refilled,
      totalAdded: refilled.reduce((sum, entry) => sum + (entry.added || 0), 0)
    };
  });
}

// Per-device fill percent for one base, as a fraction of the same cap
// refillBaseWater fills to -- the auto-refill scan's view. Deliberately
// per-device rather than reusing baseWater's per-type aggregate, for the same
// reason baseGeneratorFuelLevels doesn't reuse portalGeneratorFuel: a single
// starved device standing among full siblings of the same type is exactly
// what an automated refill decision turns on.
//
// lowestPercent is null for a base with no recognised devices, not 0 --
// "nothing to measure" must not read as "empty" to a caller deciding whether
// to refill.
export async function baseWaterFuelLevels(db, baseId) {
  const target = intParam(baseId, "base id", 1);
  const devices = await baseWaterDevices(db, target);
  const entityIds = devices.map((device) => device.entity_id).filter(Boolean);

  const stored = new Map();
  if (entityIds.length) {
    const result = await db.query(
      `select entity_id::text as entity_id,
        (components->'FWaterStorageComponent'->1->>'m_WaterStored')::int as stored
       from dune.fgl_entities where entity_id = any($1::bigint[])`, [entityIds]);
    for (const row of result.rows || []) {
      stored.set(row.entity_id, Number(row.stored) || 0);
    }
  }

  const entries = [];
  for (const device of devices) {
    const spec = WATER_TYPES[device.water_type];
    const units = device.entity_id ? (stored.get(device.entity_id) || 0) : 0;
    entries.push({
      placeableId: device.placeable_id,
      waterType: device.water_type,
      units,
      cap: spec.capacity,
      percent: spec.capacity > 0 ? Math.round((units / spec.capacity) * 1000) / 10 : 0
    });
  }

  return {
    baseId: target,
    deviceCount: entries.length,
    devices: entries,
    lowestPercent: entries.length ? Math.min(...entries.map((entry) => entry.percent)) : null
  };
}

// ---------------------------------------------------------------------------
// Base inventory
//
// Classification is an explicit building_type allowlist, for the same reason
// generator_spec's is (see the comment in portalGeneratorFuel): an unknown
// placeable must not silently acquire a group and report an invented fill
// level. Anything not listed here is omitted rather than bucketed.
//
// Grouping does NOT key on dune.inventories.inventory_type even though it
// almost lines up (4 = storage, 12 = refining/crafting, 3 = fuel-and-module).
// Recycler and Repair Station are inventory_type 3, the same as the oil
// generators the Power tab owns -- keying on the type would file a 25-slot
// Recycler holding the most items of anything outside storage under "fuel".
//
// Display names are this console's own: the game stores no type label. Every
// unnamed placeable's dune.permission_actor.actor_name is literally
// '##' || building_type, and a named one holds whatever the player typed
// ("Ore Storage", "Aluminum Refinery"), which is why the '##%' filter below
// mirrors listStorage's.
//
// Where a building_type disagrees with the player-facing name, the catalog
// patent in runtime/data/admin-items.json wins -- it is the same source the
// console already uses for item names. SpiceSilo_Placeable is the one that
// matters: its patent is "Small Storage Container", and the data agrees, since
// 195 of the 198 item rows across 40 of them in the reference dump were not
// spice. "Spice Silo" is the internal blueprint name (BP_SpiceSiloContainer),
// not a label any player sees.
//
// Every label below was read off the in-game build menu. Two were not
// derivable from the data and would have been guessed wrong:
// GenericContainer_Placeable is "Chest" (20 slots), not the "Medium Storage
// Container" its position in the capacity ladder suggests -- that is a real
// but separate 100-slot building. And the fabricators are nine buildings, not
// five: the plain and Advanced variants coexist.
//
// Every building_type string below was verified against the shipped server
// paks on the production host, where each building ships a
// DA_BLD_<building_type>.uasset. That is what caught
// AdvancedVehicleFabricator_Placeable being singular while its own base
// building, VehiclesFabricator_Placeable, is plural.
//
// The reverse does not hold: that extraction is lossy (SpiceSilo_Placeable,
// SmallOreRefinery_Placeable and Fabricator_Placeable all fail to appear in it
// despite being live on the same server), so a type's absence from the paks is
// not evidence against it. An allowlist entry that never matches is inert,
// while a missing one silently hides a container.
const BASE_INVENTORY_TYPES = {
  storage: {
    name: "Storage",
    buildingTypes: {
      storagecontainer_placeable: "Storage Container",
      mediumstoragecontainer_placeable: "Medium Storage Container",
      developer_storagecontainer_placeable: "Developer Storage Container",
      genericcontainer_placeable: "Chest",
      // Two building types display as the same building. SpiceSilo is the
      // legacy name every live placement still carries (48 of them on the
      // production server, 0 of the other); SmallStorageContainer is the
      // asset name shipped in the paks. Both are listed so a rename in a
      // future patch cannot silently empty the tab.
      spicesilo_placeable: "Small Storage Container",
      smallstoragecontainer_placeable: "Small Storage Container"
    }
  },
  refining: {
    name: "Refining",
    buildingTypes: {
      smallorerefinery_placeable: "Small Ore Refinery",
      mediumorerefinery_placeable: "Medium Ore Refinery",
      largeorerefinery_placeable: "Large Ore Refinery",
      smallchemicalrefinery_placeable: "Small Chemical Refinery",
      mediumchemicalrefinery_placeable: "Medium Chemical Refinery",
      // The base spice refinery builds as plain "Spice Refinery" -- Medium and
      // Large are separate buildables, unlike the size-prefixed ore ones.
      spicerefinery_placeable: "Spice Refinery",
      mediumspicerefinery_placeable: "Medium Spice Refinery",
      largespicerefinery_placeable: "Large Spice Refinery"
    }
  },
  crafting: {
    name: "Crafting",
    buildingTypes: {
      // Nine fabricators: a starter "Fabricator" plus four specialisations,
      // each of which has a separate Advanced building. Do not take the
      // catalog at face value here -- SurvivalFabricator_Patent is *named*
      // "Advanced Survival Fabricator Patent" while AdvancedSurvivalFabricator_
      // Patent carries that same display name, so one of the two entries is
      // simply wrong. The build menu has both buildings and they are distinct.
      fabricator_placeable: "Fabricator",
      survivalfabricator_placeable: "Survival Fabricator",
      vehiclesfabricator_placeable: "Vehicles Fabricator",
      weaponsfabricator_placeable: "Weapons Fabricator",
      wearablesfabricator_placeable: "Garment Fabricator",
      advancedsurvivalfabricator_placeable: "Advanced Survival Fabricator",
      // Singular "Vehicle" -- the game is inconsistent here, the base building
      // is VehiclesFabricator_Placeable but the advanced one is
      // AdvancedVehicleFabricator_Placeable. Verified in the shipped paks.
      advancedvehiclefabricator_placeable: "Advanced Vehicle Fabricator",
      advancedweaponsfabricator_placeable: "Advanced Weapons Fabricator",
      advancedwearablesfabricator_placeable: "Advanced Garment Fabricator"
    }
  },
  other: {
    name: "Other",
    buildingTypes: {
      recycler_placeable: "Recycler",
      repairstation_placeable: "Repair Station",
      // The base's own claim structure. Unlike every other entry here it is
      // not a placeable a player builds inside their base -- it *is* the
      // base -- but it carries a real 5-slot dune.inventories row of its own
      // (verified against the kovalt_test.backup dump: 17 totem_placeable
      // and 2 totem_small_placeable rows, each with an inv.actor_id = p.id
      // row, max_item_count 5; base 3438's totem_placeable 3437 held 1 item,
      // qty 83, pulled through this same owner_entity_id join with no
      // special-casing). Names are the catalog patent's, matching every
      // other label in this table: Totem_Small_Patent is "Sub-Fief Console",
      // Totem_Patent is "Advanced Sub-Fief".
      totem_small_placeable: "Sub-Fief Console",
      totem_placeable: "Advanced Sub-Fief"
    }
  }
};

const BASE_INVENTORY_GROUP_ORDER = ["storage", "refining", "crafting", "other"];

const BASE_INVENTORY_TRIPLES = BASE_INVENTORY_GROUP_ORDER.flatMap((group) =>
  Object.entries(BASE_INVENTORY_TYPES[group].buildingTypes).map(
    ([buildingType, typeName]) => [group, buildingType, typeName]));

// Shaped for unnest() so a building_type is never interpolated into the SQL.
function baseInventoryTypeParams() {
  return [
    BASE_INVENTORY_TRIPLES.map(([group]) => group),
    BASE_INVENTORY_TRIPLES.map(([, buildingType]) => buildingType),
    BASE_INVENTORY_TRIPLES.map(([, , typeName]) => typeName)
  ];
}

// Every stored item at a base, rolled up two ways off one query: by item
// template (what does this base hold, and where) and by container (what is in
// this box, and how full is it).
//
// Read-only by design. Item writes have no live-sync path -- no pg_notify
// channel carries them, there are no triggers on dune.items or
// dune.inventories, and the RMQ command bus addresses items by template name
// while every id here is a row id -- so an edit could not reach a running map
// without a relog or a map restart.
export async function baseInventory(db, baseId, { repoRoot = "" } = {}) {
  const target = intParam(baseId, "base id", 1);
  // Every table the query below touches, in the order it reaches them. The
  // LEFT JOINs count too: Postgres resolves a relation at parse time, so a
  // missing permission_actor raises exactly as hard as a missing placeables.
  // permission_actor is the one that matters most here -- listBases probes the
  // first three and actors, so a schema lacking only permission_actor lists
  // bases fine and then fails on this tab alone.
  // Independent probes, so one round-trip rather than seven in series.
  const required = [
    "buildings", "building_instances", "actor_fgl_entities",
    "placeables", "inventories", "permission_actor", "items"
  ];
  const present = await Promise.all(required.map((table) => tableExists(db, table)));
  const missing = required.filter((_, index) => !present[index]);
  // A capability response rather than a throw, matching listBases and the rest
  // of the read paths here: the tab can then say the schema cannot support this
  // instead of rendering a failed request with a retry that can never succeed.
  if (missing.length) {
    return {
      supported: false,
      reason: `Unsupported by detected schema. Missing required table(s): ${missing.map((table) => `dune.${table}`).join(", ")}`,
      baseId: target,
      groups: [],
      containers: [],
      items: [],
      totals: { items: 0, distinct: 0, containers: 0, usedSlots: 0, maxSlots: 0 }
    };
  }
  const [groups, buildingTypes, typeNames] = baseInventoryTypeParams();

  const result = await db.query(`
    with requested_claims as (
      select distinct b.id, afe.actor_id
      from dune.buildings b
      join dune.building_instances bi on bi.building_id = b.id
      join dune.actor_fgl_entities afe on afe.entity_id = bi.owner_entity_id
      where b.id = $1
    ), base_entities as (
      select distinct rc.id, claim_afe.entity_id as owner_entity_id
      from requested_claims rc
      join dune.actor_fgl_entities claim_afe on claim_afe.actor_id = rc.actor_id
    ), inventory_types as (
      select * from unnest($2::text[], $3::text[], $4::text[]) as t(group_key, building_type, type_name)
    ), containers as (
      -- max_item_count >= 0 drops the second inventory every refinery and
      -- fabricator carries. Both are inventory_type 12; the capped one holds
      -- the ore and crafting inputs, while the uncapped one (max_item_count
      -- = -1, dune.actor_inventories.component_name_hash 26344419) was empty
      -- on all 44 of them in the reference dump. Keeping it would also mean
      -- dividing a slot bar by a negative capacity.
      select p.id as placeable_id, inv.id as inventory_id,
             it.group_key, it.type_name, inv.max_item_count,
             coalesce(max(case when pa.actor_name not like '##%' and pa.actor_name <> 'None'
                          then pa.actor_name end), '') as container_name
      from base_entities be
      join dune.placeables p on p.owner_entity_id = be.owner_entity_id
      join inventory_types it on it.building_type = lower(p.building_type)
      join dune.inventories inv on inv.actor_id = p.id and inv.max_item_count >= 0
      left join dune.permission_actor pa on pa.actor_id = p.id
      where p.is_hologram = false
      group by p.id, inv.id, it.group_key, it.type_name, inv.max_item_count
    )
    select c.placeable_id::text as placeable_id,
           c.inventory_id::text as inventory_id,
           c.group_key, c.type_name, c.container_name, c.max_item_count,
           i.template_id, i.stack_size
    from containers c
    left join dune.items i on i.inventory_id = c.inventory_id
    order by c.placeable_id, i.template_id`, [target, groups, buildingTypes, typeNames]);

  const itemMetadata = adminItemMetadata();
  const containersById = new Map();
  const itemsByTemplate = new Map();
  const countedInventories = new Set();
  // Side indexes over the arrays being built: a container's entry for a
  // template, and an item's holder for a placeable. Without them each row
  // rescans everything accumulated so far, which is quadratic in the distinct
  // templates a base holds.
  const containerEntries = new Map();
  const itemHolders = new Map();

  for (const row of result.rows) {
    const placeableId = String(row.placeable_id);
    let container = containersById.get(placeableId);
    if (!container) {
      container = {
        placeableId,
        name: row.container_name || "",
        typeName: row.type_name,
        group: row.group_key,
        usedSlots: 0,
        maxSlots: 0,
        itemCount: 0,
        items: []
      };
      containersById.set(placeableId, container);
    }
    // A placeable can back more than one surviving inventory, so capacity is
    // summed per inventory rather than per row -- every item row repeats it.
    const inventoryId = String(row.inventory_id);
    if (!countedInventories.has(inventoryId)) {
      countedInventories.add(inventoryId);
      container.maxSlots += Math.max(0, Number(row.max_item_count) || 0);
    }

    // The left join emits one all-null item for an empty container.
    const templateId = String(row.template_id || "");
    if (!templateId) continue;
    const quantity = Number(row.stack_size) || 0;
    container.usedSlots += 1;
    container.itemCount += quantity;

    const metadata = itemMetadata.get(templateId);
    const name = metadata?.name || templateId;
    let entries = containerEntries.get(placeableId);
    if (!entries) containerEntries.set(placeableId, entries = new Map());
    const existing = entries.get(templateId);
    if (existing) existing.quantity += quantity;
    else {
      const entry = { templateId, name, quantity };
      entries.set(templateId, entry);
      container.items.push(entry);
    }

    let item = itemsByTemplate.get(templateId);
    if (!item) {
      item = {
        templateId,
        name,
        image: itemImagePath(repoRoot, templateId),
        category: metadata?.category || "",
        quantity: 0,
        containerCount: 0,
        containers: []
      };
      itemsByTemplate.set(templateId, item);
    }
    item.quantity += quantity;
    let holders = itemHolders.get(templateId);
    if (!holders) itemHolders.set(templateId, holders = new Map());
    const holder = holders.get(placeableId);
    if (holder) holder.quantity += quantity;
    else {
      const next = {
        placeableId,
        name: container.name,
        typeName: container.typeName,
        group: container.group,
        quantity
      };
      holders.set(placeableId, next);
      item.containers.push(next);
    }
  }

  const byQuantityDesc = (left, right) => right.quantity - left.quantity || left.name.localeCompare(right.name);
  const containers = [...containersById.values()].sort((left, right) =>
    BASE_INVENTORY_GROUP_ORDER.indexOf(left.group) - BASE_INVENTORY_GROUP_ORDER.indexOf(right.group) ||
    right.itemCount - left.itemCount ||
    left.placeableId.localeCompare(right.placeableId));
  for (const container of containers) container.items.sort(byQuantityDesc);

  const items = [...itemsByTemplate.values()].sort(byQuantityDesc);
  for (const item of items) {
    item.containers.sort(byQuantityDesc);
    item.containerCount = item.containers.length;
  }

  return {
    supported: true,
    baseId: target,
    groups: BASE_INVENTORY_GROUP_ORDER.map((group) => {
      const owned = containers.filter((container) => container.group === group);
      return {
        key: group,
        name: BASE_INVENTORY_TYPES[group].name,
        containerCount: owned.length,
        itemCount: owned.reduce((total, container) => total + container.itemCount, 0)
      };
    }),
    containers,
    items,
    totals: {
      items: containers.reduce((total, container) => total + container.itemCount, 0),
      distinct: items.length,
      containers: containers.length,
      usedSlots: containers.reduce((total, container) => total + container.usedSlots, 0),
      maxSlots: containers.reduce((total, container) => total + container.maxSlots, 0)
    }
  };
}

// The per-slot view of ONE container, kept off baseInventory deliberately.
// Slots roughly triple that response (238KB -> 656KB on the largest base in the
// reference dump, +176%) and it loads on every base expand and auto-refresh,
// while the contents modal only ever shows a single container. So slots are
// fetched per container, on open.
//
// baseInventory's items[] stays template-merged and is unchanged: it backs the
// "N distinct" label and the search filter, both of which mean distinct
// templates rather than stacks. This is the per-slot truth beside it.
//
// Slots hang off an inventory rather than the container because max_item_count
// is summed across every inventory a placeable backs while position_index is
// scoped to one of them -- two inventories would both have a slot 0.
export async function baseContainerSlots(db, baseId, placeableId) {
  const target = intParam(baseId, "base id", 1);
  const container = intParam(placeableId, "container id", 1);
  // Same relations baseInventory probes, minus permission_actor: this query
  // does not resolve display names, so it must not fail on a schema that lacks
  // that table when baseInventory already reported the container.
  const required = [
    "buildings", "building_instances", "actor_fgl_entities",
    "placeables", "inventories", "items"
  ];
  const present = await Promise.all(required.map((table) => tableExists(db, table)));
  const missing = required.filter((_, index) => !present[index]);
  if (missing.length) {
    return {
      supported: false,
      reason: `Unsupported by detected schema. Missing required table(s): ${missing.map((table) => `dune.${table}`).join(", ")}`,
      baseId: target,
      placeableId: String(container),
      inventories: []
    };
  }

  // Probed rather than assumed: a missing column is a parse-time error, not a
  // null, so selecting position_index against a schema without it would 500 a
  // container that used to open. Slots still come back; only the grid degrades,
  // and the frontend falls back to the list when positionIndex is null.
  const itemColumns = await columnsFor(db, "items");
  const hasPositionIndex = itemColumns.has("position_index");
  const hasStats = itemColumns.has("stats");
  const slotSelect = [
    hasPositionIndex ? "i.position_index" : "null::bigint as position_index",
    itemColumns.has("quality_level") ? "i.quality_level" : "0::bigint as quality_level",
    // Lifted verbatim from INVENTORY_ITEM_SELECT so the two paths cannot
    // disagree about where durability lives.
    hasStats
      ? "coalesce((i.stats->'FItemStackAndDurabilityStats'->1->>'CurrentDurability'), null) as current_durability"
      : "null::text as current_durability",
    hasStats
      ? `coalesce(
             nullif((i.stats->'FItemStackAndDurabilityStats'->1->>'MaxDurability')::numeric, 0),
             nullif((i.stats->'FItemStackAndDurabilityStats'->1->>'DecayedMaxDurability')::numeric, 0),
             null
           ) as max_durability`
      : "null::numeric as max_durability",
    // Same jsonb path buildAugmentedItemStats writes on the add side
    // (AppliedAugments[].Name paired positionally with
    // AppliedAugmentQualities) -- read back here rather than duplicated, so
    // the two cannot disagree about where an item's augments live.
    hasStats
      ? "i.stats->'FAugmentedItemStats'->1->'AppliedAugments' as applied_augments"
      : "null::jsonb as applied_augments",
    hasStats
      ? "i.stats->'FAugmentedItemStats'->1->'AppliedAugmentQualities' as applied_augment_qualities"
      : "null::jsonb as applied_augment_qualities"
  ].join(",\n           ");
  const slotOrder = hasPositionIndex ? "i.position_index nulls last, i.id" : "i.id";
  const [groups, buildingTypes, typeNames] = baseInventoryTypeParams();

  // The claim-resolution CTEs are baseInventory's, narrowed to one placeable.
  // The inventory_types join is load-bearing, not tidiness: it is what keeps
  // this off generator and windtrap fuel, which the Power and Water tabs own
  // -- both carry max_item_count = 5, so the >= 0 filter admits them same as
  // any storage container, and only the allowlist join excludes them.
  // is_hologram/max_item_count >= 0 are kept for the other reason baseInventory
  // has them: a hologram preview and a refinery's second (uncapped) inventory
  // are not real storage, so both would otherwise double-count or divide by a
  // negative capacity.
  const result = await db.query(`
    with requested_claims as (
      select distinct b.id, afe.actor_id
      from dune.buildings b
      join dune.building_instances bi on bi.building_id = b.id
      join dune.actor_fgl_entities afe on afe.entity_id = bi.owner_entity_id
      where b.id = $1
    ), base_entities as (
      select distinct rc.id, claim_afe.entity_id as owner_entity_id
      from requested_claims rc
      join dune.actor_fgl_entities claim_afe on claim_afe.actor_id = rc.actor_id
    ), inventory_types as (
      select * from unnest($2::text[], $3::text[], $4::text[]) as t(group_key, building_type, type_name)
    ), containers as (
      select distinct p.id as placeable_id, inv.id as inventory_id,
             it.group_key, it.type_name, inv.max_item_count
      from base_entities be
      join dune.placeables p on p.owner_entity_id = be.owner_entity_id
      join inventory_types it on it.building_type = lower(p.building_type)
      join dune.inventories inv on inv.actor_id = p.id and inv.max_item_count >= 0
      where p.is_hologram = false and p.id = $5
    )
    select c.inventory_id::text as inventory_id,
           c.group_key, c.type_name, c.max_item_count,
           i.id::text as item_id, i.template_id, i.stack_size,
           ${slotSelect}
    from containers c
    left join dune.items i on i.inventory_id = c.inventory_id
    order by c.inventory_id, ${slotOrder}`, [target, groups, buildingTypes, typeNames, container]);

  if (!result.rows.length) {
    return {
      supported: true,
      found: false,
      reason: "That container was not found at the selected base.",
      baseId: target,
      placeableId: String(container),
      inventories: []
    };
  }

  const itemMetadata = adminItemMetadata();
  const inventoriesById = new Map();
  for (const row of result.rows) {
    const inventoryId = String(row.inventory_id);
    let inventory = inventoriesById.get(inventoryId);
    if (!inventory) {
      inventory = {
        inventoryId,
        maxSlots: Math.max(0, Number(row.max_item_count) || 0),
        usedSlots: 0,
        slots: []
      };
      inventoriesById.set(inventoryId, inventory);
    }
    // The left join emits one all-null item row for an empty inventory, which
    // still needs its entry above so the grid can render empty slots.
    const templateId = String(row.template_id || "");
    if (!templateId) continue;
    inventory.usedSlots += 1;
    // AppliedAugments and AppliedAugmentQualities are parallel arrays (see
    // buildAugmentedItemStats, the write side); an item with none has both as
    // null (missing key) rather than empty arrays, and a corrupt row could
    // have mismatched lengths -- read positionally and simply stop pairing
    // past whichever array is shorter, rather than throwing on a display path.
    const appliedAugments = Array.isArray(row.applied_augments) ? row.applied_augments : [];
    const appliedQualities = Array.isArray(row.applied_augment_qualities) ? row.applied_augment_qualities : [];
    const augments = appliedAugments
      .map((entry, index) => {
        const augmentTemplateId = String(entry?.Name || "");
        if (!augmentTemplateId) return null;
        return {
          templateId: augmentTemplateId,
          name: itemMetadata.get(augmentTemplateId)?.name || augmentTemplateId,
          qualityLevel: Number(appliedQualities[index]) || 0
        };
      })
      .filter((augment) => augment !== null);
    inventory.slots.push({
      itemId: String(row.item_id),
      templateId,
      name: itemMetadata.get(templateId)?.name || templateId,
      positionIndex: row.position_index === null || row.position_index === undefined
        ? null
        : Number(row.position_index),
      quantity: Number(row.stack_size) || 0,
      qualityLevel: Number(row.quality_level) || 0,
      currentDurability: row.current_durability === null || row.current_durability === undefined
        ? null
        : Number(row.current_durability),
      maxDurability: row.max_durability === null || row.max_durability === undefined
        ? null
        : Number(row.max_durability),
      augments
    });
  }

  const inventories = [...inventoriesById.values()];
  return {
    supported: true,
    found: true,
    baseId: target,
    placeableId: String(container),
    typeName: result.rows[0].type_name,
    group: result.rows[0].group_key,
    maxSlots: inventories.reduce((total, inventory) => total + inventory.maxSlots, 0),
    usedSlots: inventories.reduce((total, inventory) => total + inventory.usedSlots, 0),
    inventories
  };
}

// Deletes one stored item, or part of its stack, from a base container.
//
// Ownership is the whole job here. The query re-resolves the base's claim from
// scratch rather than trusting the placeable id the caller sent, and keeps
// baseInventory's inventory_types join plus the is_hologram / max_item_count
// filters: together they prove the item sits in an allowlisted container at the
// requested base, which is what stops this reaching a generator or windtrap
// fuel inventory that the Power and Water tabs own. Deliberately NOT the
// giveItemToStorage shape, which only checks that some inventory exists for an
// actor and picks one arbitrarily.
//
// There is no live-sync path for inventory (no pg_notify channel, no triggers
// on dune.items), so the API route refuses this operation unless it can verify
// that the owning map is safely down. This lower layer also restricts deletion
// to plain storage: crafting/refining inventories can have active jobs that
// reference these rows, and deleting an allocated ingredient can corrupt that
// job even while the map is stopped.
export async function deleteBaseContainerItem(db, baseId, placeableId, itemId, { count = null } = {}) {
  await requireCapability(
    await supportsBaseContainerItemDelete(db),
    "Container item delete requires dune.buildings, dune.building_instances, dune.actor_fgl_entities, dune.placeables, dune.inventories, dune.items, and dune.delete_item(bigint)."
  );
  const target = intParam(baseId, "base id", 1);
  const container = intParam(placeableId, "container id", 1);
  const safeItemId = bigintParam(itemId, "item id");
  const requestedCount = count === null || count === undefined ? null : intParam(count, "count", 1);
  const [groups, buildingTypes, typeNames] = baseInventoryTypeParams();

  // Column-probed the same way baseContainerSlots reads them: a missing
  // column is a parse-time error, not a null, so a schema without these would
  // fail a delete that used to work. They exist only to enrich the audit
  // record (below) with what was actually destroyed -- quality and durability
  // in particular, since without them a destroyed pristine legendary logs
  // identically to a broken common of the same template.
  const itemColumns = await columnsFor(db, "items");
  const hasPositionIndex = itemColumns.has("position_index");
  const hasStats = itemColumns.has("stats");
  const stateSelect = [
    hasPositionIndex ? "i.position_index" : "null::bigint as position_index",
    itemColumns.has("quality_level") ? "i.quality_level" : "0::bigint as quality_level",
    hasStats
      ? "coalesce((i.stats->'FItemStackAndDurabilityStats'->1->>'CurrentDurability'), null) as current_durability"
      : "null::text as current_durability",
    hasStats
      ? `coalesce(
             nullif((i.stats->'FItemStackAndDurabilityStats'->1->>'MaxDurability')::numeric, 0),
             nullif((i.stats->'FItemStackAndDurabilityStats'->1->>'DecayedMaxDurability')::numeric, 0),
             null
           ) as max_durability`
      : "null::numeric as max_durability"
  ].join(",\n           ");

  return db.transaction(async (tx) => {
    // Same reason mutateBasePermissions and deleteBaseCompletely set it: the
    // shipped procedures reference their tables unqualified and carry no
    // `SET search_path` of their own (pg_proc.proconfig is null for both
    // dune.delete_item and dune.delete_inventory_item), so they resolve only
    // because the console connects as the `dune` role. Against any other role
    // they raise `relation "items" does not exist`, which aborts the
    // transaction before the raw-delete fallback below can run.
    await tx.query("set local search_path to dune, public");

    // for update OF i, inv -- not a bare `for update`. Postgres cannot lock a
    // CTE reference, so naming the real relations is required, not stylistic.
    // Note inv is reached by an inner join through i, so when the item row is
    // already gone neither relation is locked -- the zero-row result falls to
    // the "not found" throw below, which is the intended outcome.
    const found = await tx.query(`
      with requested_claims as (
        select distinct b.id, afe.actor_id
        from dune.buildings b
        join dune.building_instances bi on bi.building_id = b.id
        join dune.actor_fgl_entities afe on afe.entity_id = bi.owner_entity_id
        where b.id = $1
      ), base_entities as (
        select distinct rc.id, claim_afe.entity_id as owner_entity_id
        from requested_claims rc
        join dune.actor_fgl_entities claim_afe on claim_afe.actor_id = rc.actor_id
      ), inventory_types as (
        select * from unnest($2::text[], $3::text[], $4::text[]) as t(group_key, building_type, type_name)
      ), containers as (
        select distinct p.id as placeable_id, inv.id as inventory_id,
               it.group_key, it.type_name
        from base_entities be
        join dune.placeables p on p.owner_entity_id = be.owner_entity_id
        join inventory_types it on it.building_type = lower(p.building_type)
        join dune.inventories inv on inv.actor_id = p.id and inv.max_item_count >= 0
        where p.is_hologram = false and p.id = $5
      )
      select i.id::text as item_id, i.template_id, i.stack_size, i.inventory_id,
             c.placeable_id::text as placeable_id, c.group_key, c.type_name,
             ${stateSelect}
      from containers c
      join dune.items i on i.inventory_id = c.inventory_id
      join dune.inventories inv on inv.id = i.inventory_id
      where i.id = $6
      for update of i, inv`, [target, groups, buildingTypes, typeNames, container, safeItemId]);

    const item = found.rows[0];
    if (!item) throw new Error("That item was not found in a storage container at the selected base.");
    if (item.group_key !== "storage") {
      throw new Error("Items can only be deleted from Storage containers. Crafting and Refining contents are read-only to protect active jobs.");
    }

    const stackSize = Number(item.stack_size) || 0;
    const inventoryId = item.inventory_id;
    const label = item.template_id || "Item";
    // Captured before the delete, since the row -- and the state that came
    // with it -- is gone once the delete succeeds.
    const destroyedState = {
      positionIndex: item.position_index === null || item.position_index === undefined
        ? null : Number(item.position_index),
      qualityLevel: Number(item.quality_level) || 0,
      currentDurability: item.current_durability === null || item.current_durability === undefined
        ? null : Number(item.current_durability),
      maxDurability: item.max_durability === null || item.max_durability === undefined
        ? null : Number(item.max_durability)
    };

    // An explicit count larger than the stack is refused rather than rounded
    // down to "delete it all". The two are not the same request, and the gap
    // between them is a real race: the caller saw 500, asked for 400, and the
    // stack has since dropped to 300 -- widening that into destroying all 300
    // would remove more than was ever agreed to. Only an omitted count means
    // "the whole slot".
    if (requestedCount !== null && requestedCount > stackSize) {
      throw new Error(`Cannot remove ${requestedCount}: the stack holds ${stackSize}. It may have changed since this view was loaded.`);
    }
    const partial = requestedCount !== null && requestedCount < stackSize;

    if (partial) {
      // Refused rather than widened: silently deleting the whole stack because
      // the schema cannot do a partial removal would destroy more than asked.
      await requireCapability(
        await supportsPartialStackDelete(db),
        "Removing part of a stack requires dune.delete_inventory_item(bigint,bigint)."
      );
      // The shipped procedure returns NULL instead of raising when the count
      // exceeds the stack, so a null result is a failure, not a no-op success.
      const applied = await tx.query(
        "select dune.delete_inventory_item($1::bigint, $2::bigint) as result",
        [safeItemId, requestedCount]
      );
      if (applied.rows[0]?.result === null || applied.rows[0]?.result === undefined) {
        throw new Error("Partial stack removal was rejected by the database. The requested count may exceed the stack.");
      }
      const after = await tx.query("select stack_size from dune.items where id = $1 and inventory_id = $2", [safeItemId, inventoryId]);
      const remaining = after.rows[0] ? Number(after.rows[0].stack_size) || 0 : 0;
      if (remaining !== stackSize - requestedCount) {
        throw new Error("Partial stack removal did not change the stack by the requested amount.");
      }
      return {
        ok: true,
        baseId: target,
        placeableId: item.placeable_id,
        inventoryId: String(inventoryId),
        typeName: item.type_name,
        group: item.group_key,
        partial: true,
        removed: { itemId: item.item_id, templateId: item.template_id, count: requestedCount, remaining, ...destroyedState },
        message: `Removed ${requestedCount} of ${label} from the database, leaving ${remaining}.`
      };
    }

    // Whole slot. Same verify -> raw-delete fallback -> verify shape as
    // deleteInventoryItem: the shipped procedure is preferred for its item
    // tracking log, but the row disappearing is what actually matters.
    await tx.query("select dune.delete_item($1::bigint)", [safeItemId]);
    const stillExists = await tx.query("select exists(select 1 from dune.items where id = $1 and inventory_id = $2) as exists", [safeItemId, inventoryId]);
    if (stillExists.rows[0]?.exists) {
      await tx.query("delete from dune.items where id = $1 and inventory_id = $2", [safeItemId, inventoryId]);
    }
    const deleted = await tx.query("select not exists(select 1 from dune.items where id = $1 and inventory_id = $2) as deleted", [safeItemId, inventoryId]);
    if (!deleted.rows[0]?.deleted) throw new Error("Stored item delete did not remove the item from the database.");

    return {
      ok: true,
      baseId: target,
      placeableId: item.placeable_id,
      inventoryId: String(inventoryId),
      typeName: item.type_name,
      group: item.group_key,
      partial: false,
      removed: { itemId: item.item_id, templateId: item.template_id, count: stackSize, remaining: 0, ...destroyedState },
      message: `${label} was deleted from the database.`
    };
  });
}

// The inverse of deleteBaseContainerItem, and deliberately its neighbour: the
// two share an ownership proof, and keeping them adjacent is what makes a
// drift between the copies visible in a diff.
//
// The parameter surface is giveItemToStorage's verbatim so resolveCatalogItem's
// output drops straight in. What it does NOT take is a slot: placement is
// always max(position_index)+1, and there is no merging into a matching stack,
// so one add is always exactly one new row in one new slot. Both are contracts
// the UI states out loud -- see the placement note in the add panel.
//
// No `set local search_path` here, unlike its sibling above. That line exists
// there because the shipped dune.delete_item/dune.delete_inventory_item carry
// no search_path of their own (pg_proc.proconfig is null for both). This path
// calls no procedure -- it is a plain schema-qualified insert -- so the line
// would be cargo-culted noise. Its absence is meaningful.
export async function addBaseContainerItem(db, baseId, placeableId, {
  itemName = "", itemId = "", templateId = "",
  quantity = 1, quality = 0, augments = [], augmentQuality = 1
} = {}) {
  await requireCapability(
    await supportsBaseContainerItemAdd(db),
    "Container item add requires dune.buildings, dune.building_instances, dune.actor_fgl_entities, dune.placeables, dune.inventories and dune.items with insertable item columns."
  );
  const target = intParam(baseId, "base id", 1);
  const container = intParam(placeableId, "container id", 1);
  const resolvedTemplate = validateTemplateId(templateId || itemId || itemName);
  const stackSize = intParam(quantity, "quantity", 1, 1000000);
  // 0-5, not giveItemToStorage's 0-1000000. That range is an outlier -- every
  // other path and the entire UI treat grade as 0-5 -- and widening it here
  // would let the console write a grade the game has no meaning for.
  const qualityLevel = normalizeStandaloneAugmentQuality(resolvedTemplate, intParam(quality, "grade", 0, 5));
  const augmentIds = validateAugmentIds(augments);
  const augmentQualityLevel = normalizeAugmentQuality(augmentQuality);
  validateAugmentsForTemplate(resolvedTemplate, augmentIds);
  const [groups, buildingTypes, typeNames] = baseInventoryTypeParams();

  return db.transaction(async (tx) => {
    // Ownership is re-proved from the base id, never trusted from the
    // placeable id the caller sent. The inventory_types join is what keeps
    // this off generator and windtrap fuel inventories, which the Power and
    // Water tabs own.
    //
    // for update OF inv -- not a bare `for update`, since Postgres cannot lock
    // a CTE reference. The outer query re-joins dune.inventories purely to
    // have a lockable relation; the copy inside the containers CTE is not one.
    // `select distinct` stays inside the CTE for the same reason: FOR UPDATE is
    // rejected alongside DISTINCT at the locking query level.
    //
    // Taking this lock BEFORE the capacity and position reads below is the
    // whole concurrency argument, not a style choice. See the comment there.
    const found = await tx.query(`
      with requested_claims as (
        select distinct b.id, afe.actor_id
        from dune.buildings b
        join dune.building_instances bi on bi.building_id = b.id
        join dune.actor_fgl_entities afe on afe.entity_id = bi.owner_entity_id
        where b.id = $1
      ), base_entities as (
        select distinct rc.id, claim_afe.entity_id as owner_entity_id
        from requested_claims rc
        join dune.actor_fgl_entities claim_afe on claim_afe.actor_id = rc.actor_id
      ), inventory_types as (
        select * from unnest($2::text[], $3::text[], $4::text[]) as t(group_key, building_type, type_name)
      ), containers as (
        select distinct p.id as placeable_id, inv.id as inventory_id,
               it.group_key, it.type_name
        from base_entities be
        join dune.placeables p on p.owner_entity_id = be.owner_entity_id
        join inventory_types it on it.building_type = lower(p.building_type)
        join dune.inventories inv on inv.actor_id = p.id and inv.max_item_count >= 0
        where p.is_hologram = false and p.id = $5
      )
      select c.placeable_id::text as placeable_id, c.inventory_id,
             c.group_key, c.type_name,
             coalesce(inv.max_item_count, 0)::int as max_item_count
      from containers c
      join dune.inventories inv on inv.id = c.inventory_id
      order by c.inventory_id
      limit 1
      for update of inv`, [target, groups, buildingTypes, typeNames, container]);

    const containerRow = found.rows[0];
    if (!containerRow) throw new Error("That container was not found at the selected base.");
    if (containerRow.group_key !== "storage") {
      throw new Error("Items can only be added to Storage containers. Crafting and Refining contents are read-only to protect active jobs.");
    }

    // One inventory, resolved deterministically rather than chosen by the
    // caller. A placeable can back more than one surviving inventory, but the
    // only shipped type that does is a refinery, which is off the storage
    // allowlist above -- so `limit 1` cannot silently pick the wrong one here.
    // An optional inventoryId parameter is the extension point if that ever
    // changes; it would need its own membership check against `containers`.
    const inventoryId = containerRow.inventory_id;
    const maxItemCount = Number(containerRow.max_item_count) || 0;

    // count(*) counts ROWS, not summed stack sizes -- correct precisely
    // because this never merges, so one add always consumes exactly one slot.
    // A max_item_count of 0 means uncapped, matching giveItemToStorage and
    // giveItemToPlayer; inventing a third convention for it would be worse
    // than the unreachable edge it leaves open.
    const count = await tx.query("select count(*)::int as count from dune.items where inventory_id = $1", [inventoryId]);
    const currentCount = Number(count.rows[0]?.count || 0);
    if (maxItemCount > 0 && currentCount >= maxItemCount) {
      throw new Error(`This container is full: ${currentCount} of ${maxItemCount} slots are used. Delete an item to make room.`);
    }

    // Safe against a concurrent add despite there being no unique constraint
    // on (inventory_id, position_index): db.transaction issues a bare `begin`,
    // so this runs at READ COMMITTED, where the FOR UPDATE above makes a second
    // adder block until the first commits and then re-evaluate rather than
    // abort. These two reads are separate statements taking fresh snapshots, so
    // the waiter sees the committed insert and computes max+1, not the stale
    // value. The delete's `for update of i, inv` -- specifically the inv -- is
    // what serializes a concurrent delete against this; trimming it there would
    // silently break the guarantee here.
    //
    // Worst case if that reasoning ever fails: layoutSlots routes a duplicate
    // index to the overflow list, which still renders with a working delete.
    // Degraded display, never a lost or unreachable row.
    const position = await tx.query("select coalesce(max(position_index), -1)::int + 1 as position_index from dune.items where inventory_id = $1", [inventoryId]);
    const positionIndex = Number(position.rows[0]?.position_index || 0);

    // No explicit durability, deliberately. buildItemStats already gives
    // clothing and weapons a 100/100 fallback, while ore, spice and salvage get
    // an empty stat block -- which is what real resource rows actually look
    // like. Passing giveItemToPlayer's {current:100,max:100} here would stamp
    // MaxDurability onto a stack of ScrapMetal, inventing state the game never
    // wrote and that the read path would then render as a durability bar.
    const standaloneAugment = isStandaloneAugmentTemplate(resolvedTemplate);
    const rollPayloads = await loadAugmentRollPayloads(
      tx,
      standaloneAugment ? [resolvedTemplate] : augmentIds,
      standaloneAugment ? qualityLevel : augmentQualityLevel,
      { sourceTemplateId: resolvedTemplate }
    );
    const stats = buildItemStats({ templateId: resolvedTemplate, augments: augmentIds, rollPayloads });
    const itemColumns = await columnsFor(tx, "items");
    const insert = itemInsertShape(
      ["inventory_id", "template_id", "stack_size", "quality_level", "position_index", "stats"],
      [inventoryId, resolvedTemplate, stackSize, qualityLevel, positionIndex, JSON.stringify(stats)],
      itemColumns
    );
    const inserted = await tx.query(`
      insert into dune.items (${insert.columns.join(", ")})
      values (${insert.values.map((_, index) => index === 5 ? `$${index + 1}::jsonb` : `$${index + 1}`).join(", ")})
      returning id, template_id, stack_size, quality_level, position_index, inventory_id`, insert.values);
    const row = inserted.rows[0];
    if (!row) throw new Error("Stored item add did not insert the item into the database.");

    const label = resolvedTemplate || "Item";
    return {
      ok: true,
      baseId: target,
      placeableId: containerRow.placeable_id,
      inventoryId: String(inventoryId),
      typeName: containerRow.type_name,
      group: containerRow.group_key,
      // Stringified because dune.items.id is bigint and every other id on this
      // API surface is a decimal string. Reporting the slot after the fact is
      // fine; promising one beforehand is what the UI must not do.
      added: {
        itemId: String(row.id),
        templateId: row.template_id,
        quantity: Number(row.stack_size),
        qualityLevel: Number(row.quality_level),
        positionIndex: Number(row.position_index),
        augments: augmentIds.length > 0 ? augmentIds : undefined
      },
      capacity: { usedSlots: currentCount + 1, maxSlots: maxItemCount },
      message: `${label} x${stackSize} was added to ${containerRow.type_name} in slot #${positionIndex}.`
    };
  });
}

// Pending water-refill queue. Same reasoning and shape as the generator
// queue above (a live map can overwrite an immediate write, so a refill
// aimed at one is recorded here and applied once that map is confirmed
// down) -- own file, so the two queues can never collide or cross-count.
const PENDING_WATER_REFILL_PATH = "runtime/generated/pending-water-refills.json";

function pendingWaterRefillFile(repoRoot) {
  return resolve(repoRoot || "", PENDING_WATER_REFILL_PATH);
}

export function listQueuedWaterRefills(repoRoot) {
  const file = pendingWaterRefillFile(repoRoot);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    const seen = new Set();
    return parsed.map(normalizePendingRefill).filter((entry) => {
      if (!entry || seen.has(entry.baseId)) return false;
      seen.add(entry.baseId);
      return true;
    });
  } catch (error) {
    console.warn(`Ignoring unreadable pending water refill queue: ${redact(error?.message || "Unexpected error.")}`);
    return [];
  }
}

function writeQueuedWaterRefills(repoRoot, entries) {
  writeJsonAtomic(pendingWaterRefillFile(repoRoot), entries);
  return entries;
}

export function queueWaterRefill(repoRoot, { baseId, map = "", partitionId = 0, now = () => new Date() } = {}) {
  const entry = normalizePendingRefill({ baseId, map, partitionId, queuedAt: now().toISOString() });
  if (!entry) throw new Error("Invalid base id");
  const others = listQueuedWaterRefills(repoRoot).filter((row) => row.baseId !== entry.baseId);
  if (others.length >= MAX_PENDING_REFILLS) {
    throw new Error(`The pending water refill queue already holds ${MAX_PENDING_REFILLS} bases. Restart the affected maps to apply them first.`);
  }
  writeQueuedWaterRefills(repoRoot, [...others, entry]);
  return entry;
}

export function cancelQueuedWaterRefill(repoRoot, baseId) {
  const target = intParam(baseId, "base id", 1);
  const entries = listQueuedWaterRefills(repoRoot);
  const remaining = entries.filter((entry) => entry.baseId !== target);
  if (remaining.length === entries.length) throw new Error("That base has no queued water refill.");
  writeQueuedWaterRefills(repoRoot, remaining);
  return { ok: true, baseId: target, pending: remaining.length };
}

function reconcileQueuedWaterRefills(repoRoot, outcomes) {
  const next = [];
  for (const entry of listQueuedWaterRefills(repoRoot)) {
    const outcome = outcomes.get(entry.baseId);
    if (!outcome || outcome.queuedAt !== entry.queuedAt) {
      next.push(entry);
      continue;
    }
    if (outcome.keep) next.push({ ...entry, attempts: outcome.attempts, nextRetryAt: outcome.nextRetryAt, lastError: outcome.lastError });
  }
  writeQueuedWaterRefills(repoRoot, next);
  return next;
}

// Applies every queued water refill whose map is currently down and leaves
// the rest queued. Same driver and reasoning as flushGeneratorRefills.
export async function flushWaterRefills(db, repoRoot, { now = Date.now } = {}) {
  const pending = listQueuedWaterRefills(repoRoot);
  if (!pending.length) return { flushed: [], pending: 0 };
  const observed = await observeRefillPartitions(db, { now });
  if (!observed) return { flushed: [], pending: pending.length, unsupported: true };

  const flushed = [];
  const outcomes = new Map();
  const timestamp = now();
  for (const entry of pending) {
    const queuedMs = Date.parse(entry.queuedAt);
    if (Number.isFinite(queuedMs) && timestamp - queuedMs >= pendingRefillMaxAgeMs()) {
      const message = `Queued for longer than the ${Math.round(pendingRefillMaxAgeMs() / 3600000)}h limit without being applied.`;
      outcomes.set(entry.baseId, { queuedAt: entry.queuedAt, keep: false });
      flushed.push({ baseId: entry.baseId, map: entry.map, partitionId: entry.partitionId, ok: false, expired: true, dropped: true, error: message });
      continue;
    }
    if (!partitionWriteSafe(observed, entry.partitionId)) continue;
    if (entry.nextRetryAt && timestamp < entry.nextRetryAt) continue;
    try {
      const result = await refillBaseWater(db, entry.baseId);
      outcomes.set(entry.baseId, { queuedAt: entry.queuedAt, keep: false });
      flushed.push({
        baseId: entry.baseId,
        map: entry.map,
        partitionId: entry.partitionId,
        ok: true,
        totalAdded: result.totalAdded,
        devices: result.devices
      });
    } catch (error) {
      const message = String(error?.message || "Unexpected error.").slice(0, 300);
      const attempts = isTransientFlushError(message) ? entry.attempts : entry.attempts + 1;
      const dropped = attempts >= MAX_REFILL_FLUSH_ATTEMPTS;
      const nextRetryAt = timestamp + pendingRefillRetryDelayMs();
      outcomes.set(entry.baseId, { queuedAt: entry.queuedAt, keep: !dropped, attempts, nextRetryAt, lastError: message });
      flushed.push({ baseId: entry.baseId, map: entry.map, partitionId: entry.partitionId, ok: false, attempts, dropped, error: message });
    }
  }
  const remaining = outcomes.size ? reconcileQueuedWaterRefills(repoRoot, outcomes) : pending;
  return { flushed, pending: remaining.length };
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
    const standaloneAugment = isStandaloneAugmentTemplate(resolvedTemplate);
    const rollPayloads = await loadAugmentRollPayloads(
      tx,
      standaloneAugment ? [resolvedTemplate] : augmentIds,
      standaloneAugment ? qualityLevel : augmentQualityLevel,
      { sourceTemplateId: resolvedTemplate }
    );
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

// Vehicle-module rows in current dedicated-server databases commonly omit
// MaxDurability altogether. Prefer any authoritative stored maximum for the
// exact template; otherwise infer a conservative cap only when at least two
// modules of that template provide a positive current or decayed-cap sample.
// Both repair queries use this CTE so their eligibility and reported counts
// cannot disagree.
const VEHICLE_REPAIR_TEMPLATE_MAXIMA_CTE = `module_samples as (
  select vm.template_id,
         case
           when (durability->>'CurrentDurability') ~ '^[0-9]+(\\.[0-9]+)?$'
             then (durability->>'CurrentDurability')::numeric
         end as current_durability,
         case
           when (durability->>'DecayedMaxDurability') ~ '^[0-9]+(\\.[0-9]+)?$'
             then (durability->>'DecayedMaxDurability')::numeric
         end as decayed_max_durability,
         case
           when (durability->>'MaxDurability') ~ '^[0-9]+(\\.[0-9]+)?$'
             then nullif((durability->>'MaxDurability')::numeric, 0)
         end as stored_max_durability
  from dune.vehicle_modules vm
  cross join lateral (select vm.stats->'FVehicleModuleDurabilityStats'->1 as durability) d
  where jsonb_typeof(vm.stats->'FVehicleModuleDurabilityStats') = 'array'
    and jsonb_array_length(vm.stats->'FVehicleModuleDurabilityStats') >= 2
    and jsonb_typeof(durability) = 'object'
), template_maxima as (
  select template_id,
         coalesce(
           max(stored_max_durability),
           case
             when count(*) filter (
               where coalesce(greatest(current_durability, decayed_max_durability), 0) > 0
             ) >= 2
               then greatest(max(current_durability), max(decayed_max_durability))
           end
         ) as max_durability
  from module_samples
  group by template_id
)`;

export async function repairVehicleDecay(db, id, { thresholdPercent = 50 } = {}) {
  await requireCapability(await supportsRepairVehicleDecay(db), "Repair vehicle decay requires dune.vehicle_modules.stats, dune.vehicle_modules.vehicle_id, and dune.actors.owner_account_id.");
  const threshold = Number(thresholdPercent);
  if (!Number.isFinite(threshold) || threshold < 1 || threshold > 100) throw new Error("Vehicle repair threshold must be between 1 and 100 percent");
  const thresholdRatio = threshold / 100;
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    if (String(player.onlineStatus).toLowerCase() === "online") throw new Error("Repair vehicle decay requires the player to be offline so live state cannot overwrite the DB change");
    const hasPermissionOwnership = await tableExists(tx, "permission_actor_rank");
    const permissionOwnershipClause = hasPermissionOwnership
      ? `or exists (
              select 1 from dune.permission_actor_rank par
              where par.permission_actor_id = vm.vehicle_id
                and par.player_id = $2
                and par.rank = 1
            )`
      : "";
    const ownerValues = hasPermissionOwnership ? [player.accountId, player.controllerId] : [player.accountId];
    const thresholdParam = ownerValues.length + 1;
    const scanned = await tx.query(`
      with ${VEHICLE_REPAIR_TEMPLATE_MAXIMA_CTE}, owned_modules as (
        select vm.vehicle_id,
               vm.stats->'FVehicleModuleDurabilityStats'->1 as durability,
               coalesce(
                 case
                   when (vm.stats->'FVehicleModuleDurabilityStats'->1->>'MaxDurability') ~ '^[0-9]+(\\.[0-9]+)?$'
                     then nullif((vm.stats->'FVehicleModuleDurabilityStats'->1->>'MaxDurability')::numeric, 0)
                 end,
                 tm.max_durability
               ) as effective_max
        from dune.vehicle_modules vm
        join dune.actors a on a.id = vm.vehicle_id
        left join template_maxima tm on tm.template_id = vm.template_id
        where (
            a.owner_account_id = $1
            ${permissionOwnershipClause}
          )
          and vm.stats is not null
          and jsonb_typeof(vm.stats->'FVehicleModuleDurabilityStats') = 'array'
          and jsonb_array_length(vm.stats->'FVehicleModuleDurabilityStats') >= 2
          and jsonb_typeof(vm.stats->'FVehicleModuleDurabilityStats'->1) = 'object'
      )
      select count(*)::int as scanned,
             count(distinct vehicle_id)::int as vehicles,
             count(*) filter (
               where durability ? 'DecayedMaxDurability'
                 and (durability->>'DecayedMaxDurability') ~ '^[0-9]+(\\.[0-9]+)?$'
                 and effective_max > 0
             )::int as comparable,
             count(*) filter (
               where durability ? 'DecayedMaxDurability'
                 and (durability->>'DecayedMaxDurability') ~ '^[0-9]+(\\.[0-9]+)?$'
                 and effective_max is null
             )::int as missing_maximum
      from owned_modules`, ownerValues);
    const repaired = await tx.query(`
      with ${VEHICLE_REPAIR_TEMPLATE_MAXIMA_CTE}, eligible as (
        select vm.id,
               vm.vehicle_id,
               coalesce(
                 case
                   when (durability->>'MaxDurability') ~ '^[0-9]+(\\.[0-9]+)?$'
                     then nullif((durability->>'MaxDurability')::numeric, 0)
                 end,
                 tm.max_durability
               ) as max_durability
        from dune.vehicle_modules vm
        join dune.actors a on a.id = vm.vehicle_id
        left join template_maxima tm on tm.template_id = vm.template_id
        cross join lateral (
          select vm.stats->'FVehicleModuleDurabilityStats'->1 as durability
        ) d
        where (
            a.owner_account_id = $1
            ${permissionOwnershipClause}
          )
          and vm.stats is not null
          and jsonb_typeof(vm.stats->'FVehicleModuleDurabilityStats') = 'array'
          and jsonb_array_length(vm.stats->'FVehicleModuleDurabilityStats') >= 2
          and jsonb_typeof(durability) = 'object'
          and durability ? 'DecayedMaxDurability'
          and (durability->>'DecayedMaxDurability') ~ '^[0-9]+(\\.[0-9]+)?$'
          and coalesce(
                case
                  when (durability->>'MaxDurability') ~ '^[0-9]+(\\.[0-9]+)?$'
                    then nullif((durability->>'MaxDurability')::numeric, 0)
                end,
                tm.max_durability
              ) > 0
          and (durability->>'DecayedMaxDurability')::numeric < (coalesce(
                case
                  when (durability->>'MaxDurability') ~ '^[0-9]+(\\.[0-9]+)?$'
                    then nullif((durability->>'MaxDurability')::numeric, 0)
                end,
                tm.max_durability
              ) * $${thresholdParam})
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
      returning vm.id, vm.vehicle_id`, [...ownerValues, thresholdRatio]);
    const repairedVehicles = new Set(repaired.rows.map((row) => String(row.vehicle_id))).size;
    return {
      ok: true,
      player,
      thresholdPercent: threshold,
      scanned: Number(scanned.rows[0]?.scanned || 0),
      vehicles: Number(scanned.rows[0]?.vehicles || 0),
      comparable: Number(scanned.rows[0]?.comparable || 0),
      missingMaximum: Number(scanned.rows[0]?.missing_maximum || 0),
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
    assignFaction: await supportsPlayerFactionAssignment(db),
    addIntel: await supportsIntelMutation(db),
    craftingRecipes: await supportsCraftingRecipes(db),
    researchItems: await supportsResearchItems(db),
    inventoryDelete: await supportsInventoryDelete(db),
    inventoryEdit: await supportsInventoryEdit(db),
    repairGear: await supportsRepairGear(db),
    repairVehicleDecay: await supportsRepairVehicleDecay(db),
    refuelVehicle: await supportsRefuelVehicle(db),
    vitals: await supportsPlayerVitals(db),
    progression: await supportsPlayerProgression(db),
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

async function supportsPlayerVitals(db) {
  if (!(await tableExists(db, "actors")) || !(await tableExists(db, "player_state")) ||
      !(await tableExists(db, "actor_fgl_entities")) || !(await tableExists(db, "fgl_entities"))) return false;
  const actorColumns = await columnsFor(db, "actors");
  return actorColumns.has("gas_attributes");
}

async function supportsPlayerProgression(db) {
  return (await tableExists(db, "player_state")) && (await tableExists(db, "actor_fgl_entities")) && (await tableExists(db, "fgl_entities"));
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

function validateJourneyNodeId(value) {
  const nodeId = String(value || "").trim();
  if (!nodeId || nodeId.length > 500 || /[\r\n]/.test(nodeId)) throw new Error("Journey node ID is invalid");
  return nodeId;
}

function catalogStrings(value) {
  return Array.isArray(value) ? [...new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean))] : [];
}

function isContractNode(nodeId, journeyTagsData = {}) {
  return Array.isArray(journeyTagsData?.contract_tags?.[nodeId]);
}

function contractTagsForNode(nodeId, journeyTagsData = {}) {
  const tags = catalogStrings(journeyTagsData?.contract_tags?.[nodeId]);
  if (!tags.length) throw new Error(`Contract ${nodeId} was not found in the game data catalog.`);
  return tags;
}

function journeyScopesOverlap(left, right) {
  return left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`);
}

function journeyRewardRecipes(nodeId) {
  return [...JOURNEY_RECIPE_REWARDS.entries()]
    .filter(([rewardNode]) => journeyScopesOverlap(nodeId, rewardNode))
    .map(([, recipe]) => recipe);
}

function contractShortNames(nodeId, journeyTagsData = {}) {
  const aliases = Object.entries(journeyTagsData?.contract_aliases || {})
    .filter(([, fullId]) => fullId === nodeId)
    .map(([shortName]) => shortName);
  return [...new Set([...aliases, nodeId.replace(/^DA_CT_/, "")])];
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
    select $1, incoming.tag from unnest($2::text[]) as incoming(tag)
    where not exists (select 1 from dune.player_tags existing
      where existing.${tagColumn} = $1 and existing.tag = incoming.tag)`, [identityId, tags]);
  return applyJourneyFactionBumps(db, player, tags);
}

async function applyJourneyFactionBumps(db, player, tags) {
  const bumps = factionTierBumps(tags);
  let factionBumps = 0;
  for (const [name, rep] of bumps.entries()) {
    const factionId = factionIdByName(name);
    if (!factionId) continue;
    const current = await db.query(`select coalesce(reputation_amount, 0) as reputation_amount
      from dune.player_faction_reputation where actor_id = $1 and faction_id = $2`, [player.controllerId, factionId]);
    if (Number(current.rows[0]?.reputation_amount || 0) >= rep) continue;
    await db.query("select dune.set_player_faction_reputation($1::bigint, $2::smallint, $3::integer)", [player.controllerId, factionId, rep]);
    factionBumps += 1;
  }
  if (factionBumps > 0) await syncFactionComponent(db, player.controllerId);
  return { factionBumps };
}

async function grantJourneyTechRecipe(db, actorId, recipeId) {
  const current = await db.query(`select properties->'TechKnowledgePlayerComponent'->'m_TechKnowledge'->'m_TechKnowledgeData' as items
    from dune.actors where id = $1 for update`, [actorId]);
  if (!current.rows.length) return false;
  const items = Array.isArray(current.rows[0]?.items) ? current.rows[0].items : [];
  let found = false;
  let changed = false;
  const next = items.map((item) => {
    if (item?.ItemKey !== recipeId) return item;
    found = true;
    if (item.UnlockedState === "Purchased" && item.bIsNewEntry === false) return item;
    changed = true;
    return { ...item, bIsNewEntry: false, UnlockedState: "Purchased" };
  });
  if (!found) {
    changed = true;
    next.push({ ItemKey: recipeId, bIsNewEntry: false, UnlockedState: "Purchased" });
  }
  if (changed) {
    await db.query(`update dune.actors set properties = jsonb_set(
      jsonb_set(jsonb_set(coalesce(properties, '{}'::jsonb), '{TechKnowledgePlayerComponent}', coalesce(properties->'TechKnowledgePlayerComponent', '{}'::jsonb), true),
        '{TechKnowledgePlayerComponent,m_TechKnowledge}', coalesce(properties#>'{TechKnowledgePlayerComponent,m_TechKnowledge}', '{}'::jsonb), true),
      '{TechKnowledgePlayerComponent,m_TechKnowledge,m_TechKnowledgeData}', $2::jsonb, true)
      where id = $1`, [actorId, JSON.stringify(next)]);
  }
  return changed;
}

async function enableJourneySpiceVision(db, actorId) {
  const result = await db.query(`update dune.fgl_entities fe set components = jsonb_set(
      jsonb_set(fe.components, '{FSpiceAddictionComponent,1,SystemStatus}', '"FullyEnabled"'::jsonb, true),
      '{FSpiceAddictionComponent,1,SpiceVisionEnabledStatus}', '"FullyEnabled"'::jsonb, true)
    where fe.entity_id = (select entity_id from dune.actor_fgl_entities where actor_id = $1 and slot_name = 'DuneCharacter')
      and fe.components #> '{FSpiceAddictionComponent,1}' is not null
      and (coalesce(fe.components #>> '{FSpiceAddictionComponent,1,SystemStatus}', '') <> 'FullyEnabled'
        or coalesce(fe.components #>> '{FSpiceAddictionComponent,1,SpiceVisionEnabledStatus}', '') <> 'FullyEnabled')`, [actorId]);
  return Number(result.rowCount || 0) > 0;
}

async function mutateContractSkills(db, actorId, skills, mode) {
  let changed = 0;
  for (const skill of skills) {
    const key = `(TagName="${skill}")`;
    const result = mode === "add"
      ? await db.query(`update dune.fgl_entities fe
          set components = jsonb_set(fe.components, array['FLevelComponent','1','ModuleData',$2], '{"SkillPointsSpent":1}'::jsonb, true)
          where fe.entity_id = (select entity_id from dune.actor_fgl_entities where actor_id = $1 and slot_name = 'DuneCharacter')
            and coalesce((fe.components->'FLevelComponent'->1->'ModuleData'->$2->>'SkillPointsSpent')::int, 0) < 1`, [actorId, key])
      : await db.query(`update dune.fgl_entities fe
          set components = jsonb_set(fe.components, array['FLevelComponent','1','ModuleData'], (fe.components->'FLevelComponent'->1->'ModuleData') - $2)
          where fe.entity_id = (select entity_id from dune.actor_fgl_entities where actor_id = $1 and slot_name = 'DuneCharacter')
            and coalesce((fe.components->'FLevelComponent'->1->'ModuleData'->$2->>'SkillPointsSpent')::int, 0) <= 1`, [actorId, key]);
    changed += Number(result.rowCount || 0);
  }
  return changed;
}

async function dismissActiveContracts(db, actorId, shortNames) {
  const result = await db.query(`delete from dune.items i using dune.inventories inv
    where inv.id = i.inventory_id and inv.actor_id = $1 and inv.inventory_type = 29
      and i.template_id = 'ContractItem'
      and i.stats->'FContractItemStats'->1->'ContractName'->>'Name' = any($2::text[])`, [actorId, shortNames]);
  return Number(result.rowCount || 0);
}

async function clearDanglingTrackedContract(db, actorId) {
  const result = await db.query(`update dune.actors a
    set properties = jsonb_set(a.properties, '{ContractsCoordinatorComponent,m_TrackedContractItemUid}', to_jsonb('!!itm#0'::text), true)
    where a.id = $1 and a.properties ? 'ContractsCoordinatorComponent'
      and coalesce(a.properties->'ContractsCoordinatorComponent'->>'m_TrackedContractItemUid', '!!itm#0') <> '!!itm#0'
      and not exists (select 1 from dune.items item
        where ('!!itm#' || item.id::text) = a.properties->'ContractsCoordinatorComponent'->>'m_TrackedContractItemUid')`, [actorId]);
  return Number(result.rowCount || 0) > 0;
}

function linkedResearchRecipeId(itemKey) {
  const value = String(itemKey || "");
  if (value.startsWith("BLD_") && !value.endsWith("_Patent")) {
    const buildingId = value.slice(4);
    const metadata = adminItemMetadata().get(buildingId);
    if (String(metadata?.category || "").toLowerCase() === "buildings") return buildingId;
  }
  return researchRecipeId(value);
}

async function materializeResearchCraftingRecipe(db, actorId, recipeId) {
  const current = await db.query(`
    select properties->'CraftingRecipesLibraryActorComponent'->'m_KnownItemRecipes' as recipes
    from dune.actors
    where id = $1 and properties ? 'CraftingRecipesLibraryActorComponent'
    for update`, [actorId]);
  if (!current.rows.length) {
    throw new UnsupportedCapabilityError(`CraftingRecipesLibraryActorComponent not found for player ${actorId}; research was not changed.`);
  }
  const recipes = Array.isArray(current.rows[0]?.recipes) ? current.rows[0].recipes : [];
  if (recipes.some((recipe) => recipe?.BaseRecipeId?.Name === recipeId)) {
    return { recipeUnlocked: true, recipeAdded: false };
  }
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
  return { recipeUnlocked: true, recipeAdded: true };
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

async function supportsPlayerFactionAssignment(db) {
  return await tableExists(db, "player_faction") &&
    await functionExists(db, "dune.change_player_faction(bigint,smallint,smallint,timestamp without time zone)");
}

async function supportsInventoryDelete(db) {
  return await tableExists(db, "items") &&
    await tableExists(db, "inventories") &&
    await functionExists(db, "dune.delete_item(bigint)");
}

async function supportsInventoryEdit(db) {
  return await tableExists(db, "items") && await tableExists(db, "inventories");
}

// Every relation deleteBaseContainerItem's ownership query names, not just the
// two it writes through. Postgres resolves a relation at parse time, so a
// missing buildings raises exactly as hard as a missing items -- a partial
// probe would report the capability as present and then fail on use.
// dune.delete_inventory_item is probed separately: it is only needed for a
// partial-stack delete, and a schema without it should still allow whole-slot
// deletes rather than losing the feature entirely.
async function supportsBaseContainerItemDelete(db) {
  const required = [
    "buildings", "building_instances", "actor_fgl_entities",
    "placeables", "inventories", "items"
  ];
  const present = await Promise.all(required.map((table) => tableExists(db, table)));
  if (present.some((exists) => !exists)) return false;
  return functionExists(db, "dune.delete_item(bigint)");
}

async function supportsPartialStackDelete(db) {
  return functionExists(db, "dune.delete_inventory_item(bigint,bigint)");
}

// Same six relations as the delete probe above, and for the same reason: the
// add's ownership query names every one of them, and Postgres resolves a
// relation at parse time, so a partial probe reports the capability as present
// and then fails on use.
//
// No functionExists check -- the add invokes no shipped procedure, which is
// also why it needs no search_path. Two column notes worth keeping:
// placeables.is_hologram is probed because the query filters on it (the delete
// probe does not, a small pre-existing gap left alone here), and
// max_item_volume is deliberately absent -- supportsStorageGiveItem probes for
// it but never reads it, and probing a column this path never selects would
// make the capability narrower than the feature.
async function supportsBaseContainerItemAdd(db) {
  const required = [
    "buildings", "building_instances", "actor_fgl_entities",
    "placeables", "inventories", "items"
  ];
  const present = await Promise.all(required.map((table) => tableExists(db, table)));
  if (present.some((exists) => !exists)) return false;
  const placeableColumns = await columnsFor(db, "placeables");
  const inventoryColumns = await columnsFor(db, "inventories");
  const itemColumns = await columnsFor(db, "items");
  return ["id", "owner_entity_id", "building_type", "is_hologram"].every((column) => placeableColumns.has(column)) &&
    ["id", "actor_id", "max_item_count"].every((column) => inventoryColumns.has(column)) &&
    ["inventory_id", "template_id", "stack_size", "quality_level", "position_index", "stats"].every((column) => itemColumns.has(column));
}

async function supportsStorageGiveItem(db) {
  if (!(await tableExists(db, "items")) || !(await tableExists(db, "inventories"))) return false;
  const inventoryColumns = await columnsFor(db, "inventories");
  const itemColumns = await columnsFor(db, "items");
  return ["id", "actor_id", "max_item_count", "max_item_volume"].every((column) => inventoryColumns.has(column)) &&
    ["inventory_id", "template_id", "stack_size", "quality_level", "position_index", "stats"].every((column) => itemColumns.has(column));
}

// Refill writes the same items/inventories shape a storage grant does, plus it
// has to resolve placeables to classify each device.
export async function supportsGeneratorRefill(db) {
  if (!(await tableExists(db, "placeables"))) return false;
  if (!(await supportsStorageGiveItem(db))) return false;
  const placeableColumns = await columnsFor(db, "placeables");
  return ["id", "owner_entity_id", "building_type"].every((column) => placeableColumns.has(column));
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

function playerNotFoundError() {
  return Object.assign(new Error("Player not found"), { statusCode: 404 });
}

// This is the identity boundary for every player-scoped database operation.
// Actor ids are shared by players, terminals, placeables, vehicles, and many
// other world objects, so an actors row alone must never be treated as proof
// that the caller selected a player.
export async function resolvePlayerTarget(db, id) {
  const actorId = intParam(id, "player id", 1);
  const result = await db.query(`
    select a.id as actor_id,
           coalesce(nullif(ps.account_id, 0), nullif(a.owner_account_id, 0), 0) as account_id,
           coalesce(ps.player_controller_id, 0) as controller_id,
           ps.id as player_state_id,
           coalesce(ps.online_status::text, 'Offline') as online_status
    from dune.actors a
    left join dune.player_state ps on ps.player_pawn_id = a.id
    where a.id = $1
      and a.class ilike '%PlayerCharacter%'
      and ps.id is not null
    limit 1`, [actorId]);
  const row = result.rows[0];
  if (!row) throw playerNotFoundError();
  return {
    actorId: Number(row.actor_id),
    accountId: Number(row.account_id || 0),
    controllerId: Number(row.controller_id || 0),
    playerStateId: Number(row.player_state_id || 0),
    onlineStatus: row.online_status || "Offline"
  };
}

async function resolvePlayerMutationTarget(db, id) {
  return resolvePlayerTarget(db, id);
}

// Short-TTL cache for read-only capability endpoints (factions/progression/intel/vitals) that
// otherwise each independently re-run the same actors/player_state join when the Player Summary
// panel fires them as parallel requests. NOT used for mutation code paths — those must always
// see a fresh onlineStatus for requireOfflinePlayer() to be safe.
export async function resolvePlayerTargetCached(db, id) {
  const key = String(id);
  const cached = playerTargetCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = resolvePlayerMutationTarget(db, id);
  playerTargetCache.set(key, { promise, expiresAt: Date.now() + PLAYER_TARGET_CACHE_TTL_MS });
  promise.catch(() => playerTargetCache.delete(key));
  return promise;
}

export function _resetPlayerTargetCacheForTests() {
  playerTargetCache.clear();
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
  const timestamp = Date.now() / 1000;
  const actor = await db.query(`
    select properties->'FactionPlayerComponent'->'m_FactionDataArray' as faction_data
    from dune.actors
    where id = $1
    for update`, [actorId]);
  const existing = Array.isArray(actor.rows[0]?.faction_data) ? actor.rows[0].faction_data : [];
  const payload = [
    { Faction: { Name: "Atreides" }, timestamp, ReputationAmount: reps.get(1) || 0 },
    { Faction: { Name: "Harkonnen" }, timestamp, ReputationAmount: reps.get(2) || 0 },
    ...existing.filter((entry) => !["Atreides", "Harkonnen"].includes(String(entry?.Faction?.Name || "")))
  ];
  const updated = await db.query(`
    update dune.actors
    set properties = jsonb_set(
      jsonb_set(coalesce(properties, '{}'::jsonb), '{FactionPlayerComponent}', coalesce(properties->'FactionPlayerComponent', '{}'::jsonb), true),
      '{FactionPlayerComponent,m_FactionDataArray}', $1::jsonb, true)
    where id = $2
    returning id`, [JSON.stringify(payload), actorId]);
  if (updated.rowCount === 0) throw new Error(`Faction component actor ${actorId} was not found.`);
  return payload;
}

function factionComponentReputationMap(value) {
  const rows = Array.isArray(value) ? value : [];
  const factionIds = new Map([["Atreides", 1], ["Harkonnen", 2], ["None", 3], ["Smuggler", 4]]);
  const result = new Map();
  for (const row of rows) {
    const factionId = factionIds.get(String(row?.Faction?.Name || ""));
    const reputation = Number(row?.ReputationAmount);
    if (factionId && Number.isFinite(reputation)) result.set(factionId, reputation);
  }
  return result;
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

export async function addonOpsInventorySummary(db) {
  if (!(await tableExists(db, "items")) || !(await tableExists(db, "inventories")) || !(await tableExists(db, "placeables"))) {
    return emptyInventorySummary();
  }

  let totalItems = 0;
  let itemsByTemplate = [];
  try {
    const totals = await db.query(`
      select count(*)::int as total_items
      from dune.items i
      join dune.inventories inv on i.inventory_id = inv.id
      join dune.placeables p on p.id = inv.actor_id
      where p.is_hologram = false and p.owner_entity_id is not null and p.owner_entity_id != 0`);
    totalItems = Number(totals.rows?.[0]?.total_items || 0);

    const byTemplate = await db.query(`
      select i.template_id::text as template_id,
             count(*)::int as count,
             coalesce(sum(i.stack_size), 0)::bigint as total_stack
      from dune.items i
      join dune.inventories inv on i.inventory_id = inv.id
      join dune.placeables p on p.id = inv.actor_id
      where p.is_hologram = false and p.owner_entity_id is not null and p.owner_entity_id != 0
      group by i.template_id
      order by count desc
      limit 50`);
    const metadata = adminItemMetadata();
    itemsByTemplate = (byTemplate.rows || []).map((row) => {
      const meta = metadata.get(row.template_id);
      return { ...row, name: meta?.name || row.template_id, category: meta?.category || "" };
    });
  } catch { }

  let storageUsage = [];
  let totalInventories = 0;
  try {
    const storage = await listStorage(db);
    storageUsage = (storage.rows || []).map((row) => ({ inventoryId: row.id, itemCount: row.item_count, totalStack: null }));
    totalInventories = storageUsage.length;
  } catch { }

  return {
    totalItems,
    totalInventories,
    itemsByTemplate,
    totalCrafted: null,
    storageUsage
  };
}

function emptyInventorySummary() {
  return { totalItems: 0, totalInventories: 0, itemsByTemplate: [], totalCrafted: null, storageUsage: [] };
}

// addonOpsSocSummary: platform-health summary for the OPS observability
// addon's SOC tab. Deliberately does not take a `db` parameter — unlike
// every other addonOps* function, this domain has no aggregate SQL query
// backing it. bridgeRequests/bridgeErrors/bridgeSuccessRate come from an
// in-memory rolling counter (audit.js's getBridgeRequestSummary()),
// updated at audit()-call time whenever an addons.bridge action is
// logged, rather than re-parsing the (potentially large) audit log file
// on every request — see audit.js's own comment for why. Verified against
// this project's own live, running audit log (runtime/generated/
// web-admin-audit.jsonl, 1301 real lines, 485 real addons.bridge entries
// at the time of writing) that the exact detail.ok field shape this
// depends on is correct in production, not just in a mocked test.
export function addonOpsSocSummary() {
  const { requests, errors } = getBridgeRequestSummary();
  const successRate = requests > 0 ? Math.round(((requests - errors) / requests) * 100) : null;
  const platformHealth = requests === 0 ? "Unknown" : errors / requests > 0.1 ? "Degraded" : "Healthy";
  return {
    platformHealth,
    bridgeRequests: requests,
    bridgeErrors: errors,
    bridgeSuccessRate: successRate
  };
}

// addonOpsPrometheusHealth: reports the health of this project's optional,
// opt-in metrics stack (docker-compose.metrics.yml, started via
// `dune metrics start` — NOT running by default). Deliberately takes no
// `db` parameter — this is an HTTP integration against a local Prometheus
// instance, not a SQL query.
//
// Mandatory precondition check, verified live on a real deployment before
// writing this: attempts a short-timeout /-/healthy request first. If
// Prometheus is not reachable (the default, common state — this stack is
// opt-in), returns { status: "planned", domain: "prometheus", reason:
// "metrics_stack_not_running", message, summary: {} } — deliberately
// reusing the exact same { status: "planned", ... } shape
// opsPrometheusProvider's own placeholder already returns (opsProvider.js's
// opsPlaceholder()), which is the shape the addon's own
// fetchLiveOrUnavailable() (web/data-providers.js) already knows how to
// recognize as "unavailable" without requiring any change on the addon
// side. The added `reason: "metrics_stack_not_running"` field distinguishes
// this specific case from a route that's genuinely not implemented at all
// (location, still a bare opsPlaceholder with no reason field) for any
// caller that inspects the raw bridge response directly — e.g. the
// Discord bot, or a future addon version — even though the current addon
// version's fetchLiveOrUnavailable() collapses both into the same
// "not_implemented" SourceResult reason today. This is intentional: Core
// reports the most specific truth it can; it is not Core's job to decide
// how precisely a particular consumer chooses to surface that truth.
//
// avgCpuPercent/avgMemoryMb come from node-exporter host-level metrics
// (100 - idle-cpu-percent; MemTotal - MemAvailable), which were directly
// verified to work correctly against a real, running instance of this
// exact metrics stack. totalRestarts and any per-container breakdown are
// NOT computed here: verified live, on this same real deployment, that
// this stack's cAdvisor (docker-compose.metrics.yml's current
// --docker_only=true / --store_container_labels=false configuration) only
// exposes root-cgroup-aggregate metrics (id="/", no per-container `name`
// label) on this system's Docker/OverlayFS configuration — confirmed via
// cAdvisor's own container logs ("failed to identify the read-write layer
// ID for container ..." for every single running container). This is a
// pre-existing cAdvisor configuration/compatibility issue in
// docker-compose.metrics.yml itself, out of scope for this change to fix,
// and NOT something to work around by fabricating or guessing a
// totalRestarts value — it is returned as null, honestly reflecting that
// per-container metrics are not currently obtainable from this stack as
// configured, distinct from the target simply being reachable (which
// `targets.active`/`targets.total` below correctly reports based on
// Prometheus's own /api/v1/targets `health` field, which does NOT depend
// on cAdvisor's per-container metric quality — a target can be "up"
// (reachable, scraping successfully) while still only exposing an
// incomplete/aggregate metric set).
export async function addonOpsPrometheusHealth(
  promBaseUrl,
  repoRoot = process.env.DUNE_DOCKER_DIR || process.env.RUNTIME_DIR || process.cwd()
) {
  // metricsPrometheus is env-var-only today (not profile-file-backed),
  // so repoRoot doesn't change this specific field's value -- accepted
  // explicitly anyway so this doesn't rely on process.cwd() coincidentally
  // matching config.repoRoot the moment a profile-backed field is ever
  // added here, matching the same fix applied to db.js/server.js.
  promBaseUrl = promBaseUrl || process.env.METRICS_PROMETHEUS_URL || `http://127.0.0.1:${resolvePorts(process.env, repoRoot).metricsPrometheus}`;
  try {
    const healthRes = await fetch(`${promBaseUrl}/-/healthy`, { signal: AbortSignal.timeout(2000) });
    if (!healthRes.ok) return metricsStackNotRunning();
  } catch {
    return metricsStackNotRunning();
  }

  let active = 0;
  let total = 0;
  const services = {};
  try {
    const targetsRes = await fetch(`${promBaseUrl}/api/v1/targets`, { signal: AbortSignal.timeout(3000) });
    const targetsBody = await targetsRes.json();
    const activeTargets = targetsBody?.data?.activeTargets || [];
    total = activeTargets.length;
    for (const t of activeTargets) {
      const job = t.labels?.job || t.labels?.service || "unknown";
      const isUp = t.health === "up";
      if (isUp) active += 1;
      services[job] = isUp ? "up" : "down";
    }
  } catch { }

  const avgCpuPercent = await promScalar(promBaseUrl, `100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[1m])) * 100)`);
  const memUsedBytes = await promScalar(promBaseUrl, `node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes`);

  // Flat shape (not nested under an extra `data` key) — this return value
  // becomes the addon-bridge response's `result` field directly (see
  // server.js's addonBridgeRoute), which becomes exactly what the addon's
  // web/data-providers.js receives as its raw bridge response and wraps
  // in its own SourceResult envelope as `.data`. Matches the shape
  // web/addon.js's renderPrometheus() already expects to read
  // (result.data.healthy / .targets / .summary).
  return {
    healthy: true,
    targets: { active, inactive: total - active, pending: 0, total },
    services,
    summary: {
      avgCpuPercent: avgCpuPercent === null ? null : Math.round(avgCpuPercent * 10) / 10,
      avgMemoryMb: memUsedBytes === null ? null : Math.round(memUsedBytes / (1024 * 1024)),
      // Not computed — see the function-level comment above for the
      // real, verified reason (cAdvisor per-container metrics are not
      // currently obtainable from this stack's configuration on this
      // system). Never estimated from the root-cgroup aggregate or any
      // other proxy.
      totalRestarts: null
    }
  };
}

function metricsStackNotRunning() {
  return {
    status: "planned",
    domain: "prometheus",
    reason: "metrics_stack_not_running",
    message: "The optional Prometheus metrics stack is not running on this deployment. Run `dune metrics start` to enable it.",
    summary: {}
  };
}

async function promScalar(promBaseUrl, query) {
  try {
    const res = await fetch(`${promBaseUrl}/api/v1/query?${new URLSearchParams({ query })}`, { signal: AbortSignal.timeout(3000) });
    const body = await res.json();
    const value = body?.data?.result?.[0]?.value?.[1];
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  } catch {
    return null;
  }
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
