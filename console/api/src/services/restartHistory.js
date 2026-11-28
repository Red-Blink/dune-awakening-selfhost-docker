import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MAX_ROWS = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export function restartDescriptor(operation, payload = {}) {
  if (operation === "restartAll" || payload.restartMode === "stack") {
    return { scope: "battlegroup", target: "Battlegroup", map: "", partitionId: "", reason: restartReason(operation) };
  }
  if (operation === "sietchesRestart") {
    return { scope: "map", target: payload.restartLabel || payload.mapLabel || `Sietch Partition ${payload.partitionId}`, map: "Survival_1", partitionId: String(payload.partitionId || ""), reason: "Sietch restart" };
  }
  if (operation === "mapsRespawn" || payload.restartMode === "respawn") {
    return { scope: "map", target: payload.restartLabel || payload.map || `Partition ${payload.target}`, map: String(payload.map || ""), partitionId: String(payload.partitionId || payload.target || ""), reason: restartReason(operation) };
  }
  if (operation === "restartService" || payload.restartMode === "service") {
    const service = String(payload.service || "Service");
    const mapService = ["survival", "survival-1", "overmap"].includes(service.toLowerCase());
    const map = ["survival", "survival-1"].includes(service.toLowerCase()) ? "Survival_1" : service.toLowerCase() === "overmap" ? "Overmap" : "";
    return { scope: mapService ? "map" : "service", target: payload.restartLabel || friendlyTarget(service), map, partitionId: String(payload.partitionId || ""), reason: restartReason(operation) };
  }
  return null;
}

export function recordTaskRestart(config, task, payload = {}) {
  const descriptor = restartDescriptor(task.operation, payload);
  if (!descriptor || !task.finishedAt || !config?.restartHistoryFile) return null;
  const row = {
    id: task.id,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    durationSeconds: Math.max(0, Math.round((Date.parse(task.finishedAt) - Date.parse(task.startedAt)) / 1000)),
    ...descriptor,
    source: "Console",
    result: task.status === "succeeded" ? "Succeeded" : "Failed"
  };
  appendRestartHistory(config.restartHistoryFile, row);
  return row;
}

export function appendRestartHistory(file, row) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(normalizeRow(row))}\n`, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch {}
  if (statSync(file).size <= MAX_FILE_BYTES) return;
  const rows = readRows(file).slice(-MAX_ROWS);
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, rows.map((entry) => JSON.stringify(entry)).join("\n") + (rows.length ? "\n" : ""), { mode: 0o600 });
  renameSync(temp, file);
}

export function readRestartHistory(config, { limit = 100 } = {}) {
  const allRows = readRows(config.restartHistoryFile).slice(-MAX_ROWS).reverse();
  const rows = allRows.slice(0, Math.max(1, Math.min(MAX_ROWS, Number(limit) || 100)));
  return {
    rows,
    lastBattlegroupRestart: allRows.find((row) => row.scope === "battlegroup" && row.result === "Succeeded") || null
  };
}

function restartRowKey(row) {
  return `${row.id}|${row.finishedAt}`;
}

// Incremental reader for consumers that follow the journal (webhooks). The
// shell scripts append from outside this process, so following the file is
// the one mechanism that sees every restart. The cursor holds the last row's
// key plus the file's size and mtime: an unchanged file is not re-read, and a
// trim (appendRestartHistory rewrites the newest MAX_ROWS in place) is handled
// by locating the last key rather than a byte offset. A first call returns no
// rows, so a new consumer never replays history.
export function readRestartRowsSince(file, cursor = {}, { maxRows = 20 } = {}) {
  let size = 0;
  let mtimeMs = 0;
  try { ({ size, mtimeMs } = statSync(file)); } catch {}
  if (typeof cursor.lastKey === "string" && cursor.size === size && cursor.mtimeMs === mtimeMs) return { rows: [], cursor };
  const all = readRows(file);
  const next = { lastKey: all.length ? restartRowKey(all[all.length - 1]) : "", size, mtimeMs };
  if (typeof cursor.lastKey !== "string") return { rows: [], cursor: next };
  let rows = all;
  if (cursor.lastKey) {
    const index = all.findLastIndex((row) => restartRowKey(row) === cursor.lastKey);
    rows = index >= 0 ? all.slice(index + 1) : [];
  }
  return { rows: rows.slice(-maxRows), cursor: next };
}

function readRows(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [normalizeRow(JSON.parse(line))]; } catch { return []; }
  });
}

function normalizeRow(row = {}) {
  return {
    id: safe(row.id, 100),
    startedAt: safe(row.startedAt, 40),
    finishedAt: safe(row.finishedAt, 40),
    durationSeconds: Math.max(0, Math.min(86400, Number(row.durationSeconds) || 0)),
    scope: ["battlegroup", "map", "service"].includes(row.scope) ? row.scope : "service",
    target: safe(row.target, 160) || "Unknown",
    map: safe(row.map, 100),
    partitionId: safe(row.partitionId, 30),
    source: safe(row.source, 80) || "Unknown",
    reason: safe(row.reason, 160) || "Restart",
    result: row.result === "Succeeded" ? "Succeeded" : "Failed"
  };
}

function safe(value, max) {
  return String(value || "").replace(/[\r\n\t]/g, " ").slice(0, max);
}

function restartReason(operation) {
  if (/Settings|Apply/.test(operation)) return "Settings applied with restart";
  return operation === "restartAll" ? "Battlegroup restart" : "Manual restart";
}

function friendlyTarget(value) {
  return String(value || "Service").replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
