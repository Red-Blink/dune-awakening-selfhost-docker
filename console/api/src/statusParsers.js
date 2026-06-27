export function parseHomeStatus(text) {
  return {
    population: findPopulation(text),
    database: summarizeDatabase(text),
    rabbitmq: summarizeRabbit(text),
    fls: summarizeFls(text)
  };
}

export function parseReadyRows(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^(OK|WAIT|FAIL)\s+/.test(line) && !/world_partition|partition/i.test(line)).map((line) => ({
    status: line.startsWith("OK") ? "Ready" : line.startsWith("WAIT") ? "Warn" : "Failed",
    label: line.replace(/^(OK|WAIT|FAIL)\s+/, "")
  }));
}

export function parsePortRows(text) {
  const seen = new Set();
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^(OK|WARN|FAIL|WAIT)\s+/.test(line) && /\b(udp|tcp)\b/i.test(line) && /\b\d{2,5}\b/.test(line) && !/advertises|advertised|local bind|private host|in-game ping/i.test(line)).map((line) => {
    const port = line.match(/\b(\d{2,5})(?:\/(udp|tcp))?\b/i)?.[1] || "";
    const protocol = (line.match(/\b\d{2,5}\/(udp|tcp)\b/i)?.[1] || line.match(/\b(udp|tcp)\b/i)?.[1] || "").toUpperCase();
    const name = line.replace(/^(OK|WARN|FAIL|WAIT)\s+/i, "").replace(/\blistening\b.*$/i, "").replace(/\b(on|port)\s+(UDP|TCP)?\s*\d{2,5}\b/i, "").trim();
    const key = `${name}-${port}-${protocol}`;
    if (!port || !protocol || seen.has(key)) return null;
    seen.add(key);
    return { name, port, protocol };
  }).filter(Boolean);
}

export function parseStatusListenerRows(text) {
  const seen = new Set();
  return sectionLines(text, "Listeners").filter((line) => !/^CHECK\s+PORT\s+STATUS/i.test(line)).map((line) => {
    const match = line.match(/^(.+?)\s+(\d{2,5})\/(tcp|udp)\s+(\S+)/i);
    if (!match) return null;
    const [, name, port, protocol, state] = match;
    const key = `${port}/${protocol.toUpperCase()}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return { name: name.trim(), port, protocol: protocol.toUpperCase(), state };
  }).filter(Boolean);
}

export function parseStatusGameServers(text) {
  return sectionLines(text, "Game servers").filter((line) => !/^MAP\s+STATE\s+UPTIME/i.test(line) && !/^Note:/i.test(line)).map((line) => {
    const match = line.match(/^(\S+)\s+(.+?)\s{2,}(.+)$/);
    if (!match) return null;
    return { map: match[1], state: match[2].trim(), uptime: match[3].trim() };
  }).filter(Boolean);
}

export function parseRabbitConnections(text) {
  return Object.fromEntries(sectionLines(text, "RabbitMQ game connections").map((line) => line.split(":").map((part) => part.trim())).filter((parts) => parts.length === 2));
}

export function parseFlsSummary(text) {
  return Object.fromEntries(sectionLines(text, "Funcom/FLS summary").filter(isFlsSummaryLine).map((line) => line.split(":").map((part) => part.trim())).filter((parts) => parts.length === 2));
}

export function parseDoctorWarnings(text, readinessText = "") {
  const readinessHealthy = /^READY:/m.test(readinessText);
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^WARN\s+/i.test(line)).filter((line) => {
    if (!readinessHealthy) return true;
    return !/Director heartbeat not seen in recent logs|Gateway DB monitoring not seen in recent logs/i.test(line);
  });
}

export function parseSkillModules(text) {
  const rows = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const header = line.match(/^(.+?)\s+\[([^\]]+)\]$/);
    if (header) {
      if (current) rows.push(current);
      current = { skillModule: header[1].trim(), category: header[2].trim(), id: "", maxLevel: "" };
      continue;
    }
    if (!current) continue;
    const id = line.match(/^id:\s*(.+)$/i);
    if (id) {
      current.id = id[1].trim();
      continue;
    }
    const max = line.match(/^max level:\s*(.+)$/i);
    if (max) current.maxLevel = max[1].trim();
  }
  if (current) rows.push(current);
  return rows;
}

export function parseMapListRows(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => /\bCurrent:\s*(dynamic|always-on|overmap-active|disabled)\b/i.test(line)).map((line) => {
    const map = line.split(/\s+/)[0];
    return {
      map,
      mode: friendlyMode(line.match(/\bCurrent:\s*(dynamic|always-on|overmap-active|disabled)\b/i)?.[1] || ""),
      partitions: line.match(/\bPartitions:\s*(\d+)/i)?.[1] || "",
      assigned: line.match(/\bAssigned:\s*(\d+)/i)?.[1] || ""
    };
  }).filter((row) => row.map);
}

export function parseMemoryStatusRows(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^===|^Default memory|^MAP\s+MEMORY/i.test(line)).map((line) => {
    const match = line.match(/^(.+?)\s{2,}(.+)$/);
    if (!match) return null;
    return { map: match[1].trim(), memory: formatMemoryValue(match[2].trim()) };
  }).filter(Boolean);
}

export function parseBackupListRows(text) {
  return text.split(/\r?\n/)
    .map((line) => parseBackupLine(line))
    .filter(Boolean)
    .sort((a, b) => Number(b.createdSort || 0) - Number(a.createdSort || 0));
}

export function parseBackupAutoStatus(result = {}) {
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  const values = {};
  for (const rawLine of stdout.split(/\r?\n/)) {
    const match = rawLine.trim().match(/^([^:]{2,80}):\s*(.*)$/);
    if (!match) continue;
    values[match[1].trim().toLowerCase().replace(/\s+/g, "_")] = match[2].trim();
  }
  const retentionRaw = values.retention || "";
  return {
    ok: Number(result.exitCode || 0) === 0,
    enabled: /^true|1$/i.test(values.enabled || ""),
    backupTime: values.backup_time || "",
    intervalHours: values.interval_hours || "",
    retentionDays: retentionRaw.match(/(\d+)/)?.[1] || "0",
    retentionLabel: retentionRaw && !/^off$/i.test(retentionRaw) ? titleDays(retentionRaw.match(/(\d+)/)?.[1] || "") : "No Retention Limit",
    timer: values.systemd_timer || "",
    backupDirectory: values.backup_directory || "",
    reason: Number(result.exitCode || 0) === 0 ? "" : conciseBackupError(stderr || stdout)
  };
}

function parseBackupLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return null;
  const name = trimmed.match(/([A-Za-z0-9_.-]+(?:\.backup|\.dump|\.sql))/)?.[1];
  if (!name) return null;
  const listTimestamp = trimmed.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?::(\d{2}))?\b/);
  const filenameTimestamp = name.match(/(\d{8}-\d{6})/)?.[1] || "";
  const created = listTimestamp ? `${listTimestamp[1]} ${listTimestamp[2]}:${listTimestamp[3] || "00"}` : formatBackupTimestamp(filenameTimestamp);
  const createdSort = listTimestamp ? backupDisplayTimestampSort(created) : backupTimestampSort(filenameTimestamp);
  return {
    name,
    backupName: name,
    created,
    createdSort,
    type: friendlyBackupType(name, trimmed),
    source: backupSource(name)
  };
}

function backupTimestampSort(value) {
  const match = String(value || "").match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!match) return 0;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
}

function backupDisplayTimestampSort(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return 0;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])).getTime();
}

function formatBackupTimestamp(value) {
  const match = String(value || "").match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!match) return "Unknown";
  return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
}

function friendlyBackupType(name, line) {
  if (/auto|scheduled/i.test(name) || /auto|scheduled/i.test(line)) return "Automatic Backup";
  if (/restore[-_ ]?safety/i.test(name) || /restore[-_ ]?safety/i.test(line)) return "Restore Safety Backup";
  if (/pre[-_ ]?update/i.test(name) || /pre[-_ ]?update/i.test(line)) return "Pre-update Backup";
  if (/import/i.test(name) || /import/i.test(line)) return "Imported Backup";
  if (/\.(backup|dump|sql)$/i.test(name)) return "Manual Backup";
  return "Unknown";
}

function backupSource(name) {
  if (/import/i.test(name)) return "External";
  if (name.includes("__")) return name.split("__")[0].replace(/^dune-db-/, "") || "Unknown";
  return "Local";
}

function titleDays(value) {
  return value ? `${value} ${Number(value) === 1 ? "Day" : "Days"}` : "No Retention Limit";
}

function conciseBackupError(text) {
  const line = String(text || "").split(/\r?\n/).map((part) => part.trim()).filter(Boolean).find(Boolean) || "Backup status unavailable";
  if (/permission denied/i.test(line)) return "Backup scheduler status file is not readable by the web admin user.";
  return line.replace(/^.*runtime\/scripts\/db\.sh:\s*/i, "");
}

export function parseServerPartitionRows(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\d+\s*\|/.test(line)).map((line) => {
    const parts = line.split("|").map((part) => part.trim());
    if (parts.length < 9) return null;
    const [partitionId, map, dimension, label, assignedServer, gamePort, igwPort, ready, alive] = parts;
    return {
      partitionId,
      map,
      dimension,
      label,
      assignedServer,
      gamePort,
      igwPort,
      ready,
      alive,
      status: mapRuntimeStatus({ assignedServer, ready, alive })
    };
  }).filter(Boolean);
}

function findPopulation(text) {
  const line = text.split(/\r?\n/).find((candidate) => /population/i.test(candidate)) || "";
  const match = line.match(/\b(\d+|\?|unknown)\s*\/\s*(\d+|\?|unknown)\b/i);
  if (!match) return "";
  const current = /^unknown$/i.test(match[1]) ? "?" : match[1];
  const max = /^unknown$/i.test(match[2]) ? "?" : match[2];
  if (current === "?" && max === "?") return "";
  return `${current}/${max}`;
}

function summarizeDatabase(text) {
  const section = sectionLines(text, "Database").join("\n");
  const value = section.match(/World partitions:\s*(\d+)/i)?.[1] || "";
  return Number(value) > 0 ? "Ready" : "Warn";
}

function summarizeRabbit(text) {
  const lines = sectionLines(text, "RabbitMQ game connections");
  if (lines.some((line) => /checking/i.test(line))) return "Ready";
  const director = numberAfterLabel(lines, "Director connections");
  const game = numberAfterLabel(lines, "Game server connections");
  return director >= 1 && game >= 1 ? "Ready" : "Warn";
}

function summarizeFls(text) {
  const lines = sectionLines(text, "Funcom/FLS summary").filter(isFlsSummaryLine);
  return lines.length && lines.every((line) => /:\s*OK$/i.test(line)) ? "Ready" : "Warn";
}

function isFlsSummaryLine(line) {
  return /^(Director heartbeat|Population declaration|Max capacity declaration|Gateway DB monitoring)\s*:/i.test(line);
}

function friendlyMode(value) {
  if (value === "dynamic") return "Dynamic";
  if (value === "always-on") return "Always On";
  if (value === "overmap-active") return "Overmap Active";
  if (value === "disabled") return "Disabled";
  return value || "Not Available";
}

function formatMemoryValue(value) {
  const text = String(value || "").trim();
  const isDefault = /\bdefault\b/i.test(text);
  const match = text.match(/(\d+(?:\.\d+)?)\s*(GiB?|GB|MiB?|MB|[gGmM])?/i);
  if (!match) return text || "Not Available";
  const unit = (match[2] || "GB").toLowerCase();
  return `${match[1]} ${unit.startsWith("m") ? "MB" : "GB"}${isDefault ? " (Default)" : ""}`;
}

function mapRuntimeStatus(row) {
  const assigned = Boolean(String(row.assignedServer || "").trim());
  const ready = isTruthyDbValue(row.ready);
  const alive = isTruthyDbValue(row.alive);
  if (ready && alive) return "Ready";
  if (alive) return "Loading";
  if (assigned) return "Starting";
  return "Not Running";
}

function isTruthyDbValue(value) {
  return /^(true|t|1|yes|y)$/i.test(String(value || "").trim());
}

function sectionLines(text, section) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `=== ${section.toLowerCase()} ===`);
  if (start < 0) return [];
  const result = [];
  for (const line of lines.slice(start + 1)) {
    if (/^=== .+ ===$/.test(line.trim())) break;
    if (line.trim()) result.push(line.trim());
  }
  return result;
}

function numberAfterLabel(lines, label) {
  const line = lines.find((candidate) => candidate.toLowerCase().startsWith(label.toLowerCase())) || "";
  return Number(line.match(/(-?\d+)/)?.[1] || "0");
}
