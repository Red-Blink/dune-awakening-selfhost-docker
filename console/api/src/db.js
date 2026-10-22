import pg from "pg";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { redact } from "./redact.js";
import { resolvePorts } from "./config.js";

const { Pool } = pg;
const DATABASE_RESTORE_MAINTENANCE_PATH = "runtime/generated/db-restore-maintenance";
const DATABASE_RESTORE_MAINTENANCE_MESSAGE = "Database restore is in progress. Try again after it finishes.";

export function databaseRestoreMaintenanceFile(repoRoot, env = process.env) {
  return resolve(repoRoot || process.cwd(), env.DUNE_DB_RESTORE_MAINTENANCE_FILE || DATABASE_RESTORE_MAINTENANCE_PATH);
}

export function databaseRestoreMaintenanceActive(repoRoot, env = process.env) {
  return existsSync(databaseRestoreMaintenanceFile(repoRoot, env));
}

export function discoverDbConfig(env = process.env, repoRoot = process.cwd()) {
  if (env.ADMIN_DATABASE_URL) {
    return { connectionString: env.ADMIN_DATABASE_URL, source: "ADMIN_DATABASE_URL" };
  }
  return {
    host: env.DUNE_DB_HOST || env.PGHOST || "127.0.0.1",
    // Upstream review finding: this previously preferred
    // DUNE_DB_PORT/PGPORT over resolvePorts().postgres, while
    // resolvePorts() itself prefers POSTGRES_PORT over
    // DUNE_DB_PORT/PGPORT -- if an operator had more than one of these
    // set to different values (a real, reachable misconfiguration, not
    // hypothetical), status/preflight (which reads resolvePorts()
    // directly) could disagree with the actual database connection
    // (which read this function). Always delegate to resolvePorts()
    // instead of re-implementing the precedence chain here, so there is
    // exactly one place this logic can ever drift from itself. postgres
    // is env-var-only (not profile-file-backed), so repoRoot doesn't
    // affect this specific field today -- passed through explicitly
    // anyway so this doesn't silently rely on process.cwd()
    // coincidentally matching config.repoRoot the moment a
    // profile-backed field is ever added here.
    port: resolvePorts(env, repoRoot).postgres,
    database: env.DUNE_DB_NAME || env.PGDATABASE || "dune",
    user: env.DUNE_DB_USER || env.PGUSER || "dune",
    password: env.DUNE_DB_PASSWORD || env.PGPASSWORD || "dune",
    source: "RedBlink defaults"
  };
}

// Table/column existence lookups (tableExists/columnsFor in duneDb.js) run on
// nearly every request and only change on DDL, a Funcom update or a restore.
// Entries are dropped when a statement that looks like DDL runs through this
// pool, while and right after a database restore, and after a TTL. DDL that
// bypasses this process (a function that creates tables, psql, a Funcom
// update) is only picked up when the TTL runs out. Negative results live only
// briefly so a table an addon just created becomes visible quickly. Only the
// pool-backed db object carries a cache; transaction handles do not, so a table
// created inside a transaction is always seen by that transaction.
// DUNE_SCHEMA_CACHE_TTL_MS=0 turns the cache off.
const DDL_PATTERN = /\b(create|alter|drop|truncate|rename)\b/i;
const DEFAULT_SCHEMA_CACHE_TTL_MS = 60000;
const RESTORE_WATCH_INTERVAL_MS = 1000;

export function isDdlStatement(text) {
  return DDL_PATTERN.test(String(text?.text ?? text ?? ""));
}

// An unset, empty or non-numeric value falls back to the default; only an
// explicit 0 disables the cache.
export function parseSchemaCacheTtl(value) {
  if (value === undefined || value === null || String(value).trim() === "") return DEFAULT_SCHEMA_CACHE_TTL_MS;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SCHEMA_CACHE_TTL_MS;
}

export function createSchemaCache({ ttlMs = DEFAULT_SCHEMA_CACHE_TTL_MS, negativeTtlMs = 5000, isPaused = () => false, now = () => Date.now() } = {}) {
  const entries = new Map();
  let generation = 0;
  let wasPaused = false;
  const cache = {
    enabled: ttlMs > 0,
    // Samples the restore flag. Called by createDb's watcher (not per lookup, so
    // a cache hit costs no syscall) and by db.query when it refuses a statement.
    // Clears the cache while a restore runs and once more after it ended, so a
    // restore that finished between two samples still drops the old schema.
    refresh() {
      const paused = isPaused();
      if (paused || wasPaused) cache.invalidate();
      wasPaused = paused;
      return paused;
    },
    async get(key, load, isNegative = () => false) {
      if (ttlMs <= 0) return load();
      if (wasPaused) return load();
      const hit = entries.get(key);
      if (hit && hit.expires > now()) return hit.value;
      const started = generation;
      const value = await load();
      // A DDL statement that ran while this lookup was in flight may have made
      // the loaded value stale; do not store it.
      if (generation === started) {
        entries.set(key, { value, expires: now() + (isNegative(value) ? Math.min(negativeTtlMs, ttlMs) : ttlMs) });
      }
      return value;
    },
    invalidate() {
      generation += 1;
      entries.clear();
    },
    noteStatement(text) {
      if (isDdlStatement(text)) cache.invalidate();
    }
  };
  return cache;
}

// One timer samples the restore flag for every live schema cache, so the cost
// does not grow with the number of createDb() calls. Caches are held weakly: a
// db that is dropped without close() is collected, and the timer stops once no
// cache is left.
const watchedCaches = new Set();
let restoreWatchTimer = null;

function watchRestoreFlag(cache) {
  const ref = new WeakRef(cache);
  watchedCaches.add(ref);
  if (!restoreWatchTimer) {
    restoreWatchTimer = setInterval(() => {
      for (const watched of [...watchedCaches]) {
        const live = watched.deref();
        if (live) live.refresh();
        else watchedCaches.delete(watched);
      }
      if (!watchedCaches.size) {
        clearInterval(restoreWatchTimer);
        restoreWatchTimer = null;
      }
    }, RESTORE_WATCH_INTERVAL_MS);
    restoreWatchTimer.unref?.();
  }
  return () => {
    watchedCaches.delete(ref);
    if (!watchedCaches.size && restoreWatchTimer) {
      clearInterval(restoreWatchTimer);
      restoreWatchTimer = null;
    }
  };
}

export function createDb(config) {
  const dbConfig = discoverDbConfig(process.env, config?.repoRoot);
  const repoRoot = config?.repoRoot || process.cwd();
  const pool = new Pool({
    ...dbConfig,
    max: Number(process.env.ADMIN_DB_POOL_SIZE || 5),
    connectionTimeoutMillis: Number(process.env.ADMIN_DB_CONNECT_TIMEOUT_MS || 3000),
    idleTimeoutMillis: Number(process.env.ADMIN_DB_IDLE_TIMEOUT_MS || 10000),
    query_timeout: Number(process.env.ADMIN_DB_QUERY_TIMEOUT_MS || 15000),
    statement_timeout: Number(process.env.ADMIN_DB_STATEMENT_TIMEOUT_MS || 15000)
  });
  const schemaCache = createSchemaCache({
    ttlMs: parseSchemaCacheTtl(process.env.DUNE_SCHEMA_CACHE_TTL_MS),
    isPaused: () => databaseRestoreMaintenanceActive(repoRoot)
  });
  // Notices the end of a restore even when nothing queries the database in the
  // meantime.
  const stopRestoreWatch = schemaCache.enabled ? watchRestoreFlag(schemaCache) : null;
  pool.on("error", (error) => {
    console.warn(`Database connection interrupted: ${redactDbError(error)}`);
  });

  async function query(text, values = []) {
    if (databaseRestoreMaintenanceActive(repoRoot)) {
      schemaCache.refresh();
      throw new Error(DATABASE_RESTORE_MAINTENANCE_MESSAGE);
    }
    try {
      return await pool.query(text, values);
    } catch (error) {
      throw new Error(redactDbError(error));
    } finally {
      schemaCache.noteStatement(text);
    }
  }

  // options.queryTimeoutMs replaces the pool's client-side query_timeout for the
  // statements of this one transaction (node-pg takes it per query). Work that
  // legitimately outlasts the 15 s pool default, such as a large base export,
  // sets its own bound instead of loosening it for every console query.
  async function transaction(fn, options = {}) {
    if (databaseRestoreMaintenanceActive(repoRoot)) throw new Error(DATABASE_RESTORE_MAINTENANCE_MESSAGE);
    const queryTimeoutMs = Number(options?.queryTimeoutMs);
    const client = await pool.connect();
    let ranDdl = false;
    try {
      await client.query("begin");
      const runQuery = Number.isFinite(queryTimeoutMs) && queryTimeoutMs > 0
        ? (text, values = []) => client.query({ text, values, query_timeout: queryTimeoutMs })
        : (text, values = []) => client.query(text, values);
      const tx = {
        config: publicDbConfig(dbConfig),
        query: (text, values = []) => {
          if (isDdlStatement(text)) ranDdl = true;
          return runQuery(text, values);
        }
      };
      const result = await fn(tx);
      await client.query("commit");
      if (ranDdl) schemaCache.invalidate();
      return result;
    } catch (error) {
      try { await client.query("rollback"); } catch {}
      if (ranDdl) schemaCache.invalidate();
      throw new Error(redactDbError(error));
    } finally {
      client.release();
    }
  }

  return {
    config: publicDbConfig(dbConfig),
    schemaCache,
    query,
    transaction,
    close: () => {
      stopRestoreWatch?.();
      return pool.end();
    }
  };
}

export function publicDbConfig(config) {
  if (config.connectionString) return { source: config.source, connectionString: "<redacted>" };
  return {
    source: config.source,
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: "<redacted>"
  };
}

export function redactDbError(error) {
  return redact(String(error?.message || "Unexpected error.")
    .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, "postgres://<redacted>@")
    .replace(/password=[^&\s]+/gi, "password=<redacted>"));
}

export function assertIdentifier(value, label = "identifier") {
  const raw = String(value || "");
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) return raw;
  throw new Error(`Invalid ${label}`);
}

export function quoteIdentifier(value) {
  return `"${assertIdentifier(value).replaceAll('"', '""')}"`;
}

export function quoteQualified(schema, table) {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

export function intParam(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${label}`);
  return n;
}

// PostgreSQL bigint identifiers must stay as decimal strings. Converting one
// to Number first silently rounds values above Number.MAX_SAFE_INTEGER and can
// make a destructive request target a different row.
export function bigintParam(value, label, min = 1n, max = 9223372036854775807n) {
  const raw = String(value ?? "").trim();
  if (!/^[0-9]+$/.test(raw)) throw new Error(`Invalid ${label}`);
  const n = BigInt(raw);
  if (n < min || n > max) throw new Error(`Invalid ${label}`);
  return n.toString();
}

export function stripSqlComments(query) {
  return String(query || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim();
}

export function isReadOnlySql(query) {
  const stripped = stripSqlComments(query);
  return /^(select|with|show|explain)\b/i.test(stripped) &&
    !/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy\s+.*\s+from)\b/i.test(stripped);
}

// True when there is something here Postgres would actually run.
//
// isReadOnlySql answers "does this START with a read keyword", so "", "   ",
// ";" and a fully commented-out block all answer NO and classify as WRITES --
// down the write path, which takes a full pre-write backup. Callers check this
// first so obviously-empty input is a 400 rather than a pg_dump.
//
// The comment stripping is naive about string literals, and it can remove real
// SQL: `SELECT '/*' as a, '*/' as b` strips to `select ' ' as b`. That is safe
// here only because this decides whether ANYTHING remains, and every such case
// still leaves a non-empty string. Do not reuse it where the stripped text
// itself matters. The corpus in databaseQueryAuthz.test.js pins the cases tried.
export function hasExecutableStatement(query) {
  return stripSqlComments(query).replace(/;/g, "").trim().length > 0;
}

function normalizeQueryResult(result) {
  if (!Array.isArray(result)) return result;
  return [...result].reverse().find((entry) => Array.isArray(entry?.fields) && entry.fields.length) ||
    [...result].reverse().find((entry) => Array.isArray(entry?.rows)) ||
    result[result.length - 1] ||
    { fields: [], rows: [], rowCount: 0, command: "" };
}

export function rowsResult(result) {
  const normalized = normalizeQueryResult(result);
  const fields = Array.isArray(normalized?.fields) ? normalized.fields : [];
  const rows = Array.isArray(normalized?.rows) ? normalized.rows : [];
  return {
    columns: fields.map((field) => ({ name: field.name, dataTypeId: field.dataTypeID })),
    rows,
    rowCount: normalized?.rowCount ?? rows.length,
    command: normalized?.command || ""
  };
}
