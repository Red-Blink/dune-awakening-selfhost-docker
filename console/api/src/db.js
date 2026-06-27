import pg from "pg";
import { redact } from "./redact.js";

const { Pool } = pg;

export function discoverDbConfig(env = process.env) {
  if (env.ADMIN_DATABASE_URL) {
    return { connectionString: env.ADMIN_DATABASE_URL, source: "ADMIN_DATABASE_URL" };
  }
  return {
    host: env.DUNE_DB_HOST || env.PGHOST || "127.0.0.1",
    port: Number(env.DUNE_DB_PORT || env.PGPORT || 15432),
    database: env.DUNE_DB_NAME || env.PGDATABASE || "dune",
    user: env.DUNE_DB_USER || env.PGUSER || "dune",
    password: env.DUNE_DB_PASSWORD || env.PGPASSWORD || "dune",
    source: "RedBlink defaults"
  };
}

export function createDb(config) {
  const dbConfig = discoverDbConfig();
  const pool = new Pool({
    ...dbConfig,
    max: Number(process.env.ADMIN_DB_POOL_SIZE || 5),
    connectionTimeoutMillis: Number(process.env.ADMIN_DB_CONNECT_TIMEOUT_MS || 3000),
    idleTimeoutMillis: Number(process.env.ADMIN_DB_IDLE_TIMEOUT_MS || 10000),
    query_timeout: Number(process.env.ADMIN_DB_QUERY_TIMEOUT_MS || 15000),
    statement_timeout: Number(process.env.ADMIN_DB_STATEMENT_TIMEOUT_MS || 15000)
  });
  pool.on("error", (error) => {
    console.warn(`Database connection interrupted: ${redactDbError(error)}`);
  });

  async function query(text, values = []) {
    try {
      return await pool.query(text, values);
    } catch (error) {
      throw new Error(redactDbError(error));
    }
  }

  async function transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const tx = {
        config: publicDbConfig(dbConfig),
        query: (text, values = []) => client.query(text, values)
      };
      const result = await fn(tx);
      await client.query("commit");
      return result;
    } catch (error) {
      try { await client.query("rollback"); } catch {}
      throw new Error(redactDbError(error));
    } finally {
      client.release();
    }
  }

  return {
    config: publicDbConfig(dbConfig),
    query,
    transaction,
    close: () => pool.end()
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
  return redact(String(error?.message || error)
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

export function isReadOnlySql(query) {
  const stripped = String(query || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim();
  return /^(select|with|show|explain)\b/i.test(stripped) &&
    !/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy\s+.*\s+from)\b/i.test(stripped);
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
