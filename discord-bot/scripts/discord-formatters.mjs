const COLORS = {
  ready: 0x2ecc71,
  issue: 0xf1c40f,
  down: 0xe74c3c,
  neutral: 0x95a5a6,
  info: 0x3498db
};

const FOOTER = {
  text: "Read-only Discord adapter • No server mutation commands enabled"
};

const BAD_STATES = /^(issue|missing|down|error|failed|offline|degraded)$/i;

export function formatCommandResponse(command, payload) {
  const clean = redact(payload);
  if (isFailure(clean)) return formatErrorResponse(commandTitle(command), clean);

  if (command === "health") return formatHealthResponse(clean);
  if (command === "status") return formatStatusCard(commandTitle(command), clean, { publicView: true });
  if (command === "statusDetail") return formatStatusCard(commandTitle(command), clean, { diagnostic: true });
  if (command === "readiness") return formatReadinessResponse(clean);
  if (command === "services") return formatServicesResponse(clean);

  return formatStatusCard(commandTitle(command), clean, { diagnostic: true });
}

export function formatDiagnosticJson(title, payload) {
  return formatStatusCard(title, payload, { diagnostic: true }).embeds[0]?.description || "Diagnostic summary unavailable.";
}

function commandTitle(command) {
  if (command === "health") return "Arrakis Control Plane — Adapter Health";
  if (command === "status") return "Arrakis Control Plane — Server Status";
  if (command === "statusDetail") return "Arrakis Control Plane — Detailed Status";
  if (command === "readiness") return "Arrakis Control Plane — Readiness";
  if (command === "services") return "Arrakis Control Plane — Services";
  return "Arrakis Control Plane";
}

function formatHealthResponse(payload) {
  const liveRoutes = Array.isArray(payload.liveRoutes) ? payload.liveRoutes.length : 0;
  const plannedRoutes = Array.isArray(payload.plannedRoutes) ? payload.plannedRoutes.length : 0;
  const policy = payload.rolePolicy || {};
  const roleLines = [
    roleLine("Observer", policy.observerConfigured),
    roleLine("Moderator", policy.moderatorConfigured),
    roleLine("Admin", policy.adminConfigured),
    roleLine("Owner", policy.ownerConfigured)
  ].join("\n");

  return {
    content: "",
    embeds: [baseEmbed({
      title: "Arrakis Control Plane — Adapter Health",
      description: "The Discord adapter is online and operating in read-only mode.",
      color: payload.ok ? COLORS.ready : COLORS.issue,
      fields: compactFields([
        field("Overall", payload.ok ? "ONLINE" : "ISSUE", true),
        field("Mode", payload.experimental ? "EXPERIMENTAL" : "STANDARD", true),
        field("Safety", lines([
          statusLine("Read-only", truthLabel(payload.readOnly)),
          statusLine("Writes", payload.writesEnabled ? "ENABLED" : "DISABLED")
        ]), true),
        field("Routes", `${liveRoutes} live / ${plannedRoutes} planned`, true),
        field("Roles", roleLines || "No role policy returned.", false)
      ])
    })]
  };
}

function formatReadinessResponse(payload) {
  const data = resultData(payload);
  const ready = data.ready ?? data.ok ?? payload.ok;
  const overall = ready ? "READY" : inferOverall(data, payload);
  const services = serviceRows(data);
  const issues = issueLines(data, overall);

  return {
    content: "",
    embeds: [baseEmbed({
      title: "Arrakis Control Plane — Readiness",
      description: ready ? "Server readiness checks are passing." : "Server readiness has one or more blocking issues.",
      color: colorForStatus(overall),
      fields: compactFields([
        field("Overall", statusText(overall), true),
        field("Issues", bulletList(issues, "No issues reported."), false),
        services.length ? field("Services", namedStatusList(services), false) : null,
        field("Checks", namedStatusList(checkRows(data)), false)
      ])
    })]
  };
}

function formatServicesResponse(payload) {
  return formatStatusCard("Arrakis Control Plane — Services", payload, { servicesOnly: true });
}

function formatStatusCard(title, payload, _options = {}) {
  const data = resultData(payload);
  const overall = inferOverall(data, payload);
  const services = serviceRows(data);
  const listeners = listenerRows(data, services);
  const checks = checkRows(data);
  const issues = issueLines(data, overall).filter((issue) => !/^Overall status is /i.test(issue) || issueLines(data, overall).length === 1);
  const serviceSummary = services.length ? serviceHealthSummary(services) : null;

  return {
    content: "",
    embeds: [baseEmbed({
      title: data.title || title,
      description: cardDescription(overall, issues, services),
      color: colorForStatus(overall),
      fields: compactFields([
        field("Overall", statusText(overall), true),
        optionalField("Region", data.region || data.shardRegion, true),
        optionalField("Population", data.population ?? data.playerCount, true),
        serviceSummary ? field("Summary", serviceSummary, false) : null,
        issues.length ? field("Issues", bulletList(issues, "No issues reported."), false) : null,
        services.length ? field("Services", namedStatusList(services), false) : null,
        listeners.length ? field("Listeners", namedStatusList(listeners), false) : null,
        checks.length ? field("Checks", namedStatusList(checks), false) : null
      ])
    })]
  };
}

function cardDescription(overall, issues, services) {
  if (issues.length) return `${issues.length} issue${issues.length === 1 ? "" : "s"} detected.`;
  if (services.length && services.every((service) => /^(UP|READY|OK|ONLINE|HEALTHY)$/i.test(service.status))) {
    return "All monitored services are online.";
  }
  if (/^(OK|READY|UP|ONLINE|HEALTHY)$/i.test(statusText(overall))) return "No issues reported.";
  return "Status requires review.";
}

function serviceHealthSummary(services) {
  const up = services.filter((service) => /^(UP|READY|OK|ONLINE|HEALTHY)$/i.test(service.status)).length;
  return `${up} / ${services.length} services reporting UP`;
}

function formatErrorResponse(title, payload) {
  const error = payload.payload?.error || payload.error || payload.message || "Command failed.";
  const code = payload.payload?.code || payload.code || "unknown";
  const status = payload.status ?? "unknown";

  return {
    content: "",
    embeds: [baseEmbed({
      title: `${title} — Command Failed`,
      description: safeValue(error),
      color: status === 403 || code === "not_authorized" ? COLORS.issue : COLORS.down,
      fields: compactFields([
        field("Status", String(status), true),
        field("Code", safeValue(code), true)
      ])
    })]
  };
}

function resultData(payload) {
  return payload?.result || payload?.payload?.result || payload || {};
}

function inferOverall(data, payload) {
  return data.overall || data.status || data.state || (payload?.ok ? "READY" : "ISSUE");
}

function serviceRows(data) {
  return asArray(data.services || data.maps || data.instances).map((item) => normalizeRow(item, "Service"));
}

function listenerRows(data, services = []) {
  const direct = asArray(data.listeners).map((item) => normalizeRow(item, "Listener"));
  const nested = services.flatMap((service) => asArray(service.raw?.listeners).map((listener) => normalizeRow(listener, `${service.name} listener`)));
  return [...direct, ...nested];
}

function checkRows(data) {
  return asArray(data.checks || data.readiness || data.healthChecks).map((item) => normalizeRow(item, "Check"));
}

function normalizeRow(item, fallbackName) {
  if (typeof item === "string") return { name: item, status: "UNKNOWN", raw: item };
  const raw = item || {};
  return {
    name: raw.name || raw.service || raw.map || raw.id || raw.check || fallbackName,
    status: statusText(raw.status || raw.state || raw.overall || raw.ok === true && "READY" || raw.ok === false && "ISSUE" || "UNKNOWN"),
    raw
  };
}

function issueLines(data, overall) {
  const explicit = asArray(data.issues || data.errors || data.failures || data.blockingIssues).map((item) => {
    if (typeof item === "string") return item;
    return item.message || item.error || item.name || JSON.stringify(item);
  });
  const derived = deriveIssues(data, overall);
  return dedupe([...explicit, ...derived]).slice(0, 12);
}

function deriveIssues(data, overall) {
  const rows = [];
  if (BAD_STATES.test(statusText(overall))) rows.push(`Overall status is ${statusText(overall)}`);
  collectBadStateIssues(data, [], "", rows);
  return rows;
}

function collectBadStateIssues(value, path, parentName, rows) {
  if (value === null || value === undefined) return;

  if (typeof value !== "object") {
    const leaf = path[path.length - 1] || "";
    const isTopLevelStatus = path.length <= 1 && /^(overall|state|status)$/i.test(leaf);
    if (isTopLevelStatus) return;

    const state = statusText(value);
    if (BAD_STATES.test(state)) rows.push(`${pathLabel(path, parentName)} is ${state}`);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectBadStateIssues(item, [...path, String(index)], parentName, rows));
    return;
  }

  const contextName = value.name || value.service || value.map || value.id || value.check || parentName;
  for (const [key, item] of Object.entries(value)) {
    collectBadStateIssues(item, [...path, key], contextName, rows);
  }
}

function pathLabel(path, parentName) {
  const parts = path
    .filter((part) => !/^\d+$/.test(part))
    .filter((part) => !/^(result|payload|services|maps|instances|checks|listeners|state|status|overall)$/i.test(part));

  const tail = labelCase(parts.slice(-1).join(" ") || "Status");
  return labelCase([parentName, tail].filter(Boolean).join(" "));
}

function namedStatusList(rows) {
  const lines = rows.map((row) => `**${escapeMarkdown(row.name)}** : ${escapeMarkdown(row.status)}`);
  return truncateEmbedText(lines.length ? lines.join("\n") : "None reported.", 1024);
}

function bulletList(rows, fallback) {
  return truncateEmbedText(rows.length ? rows.map((row) => `• ${escapeMarkdown(row)}`).join("\n") : fallback, 1024);
}

function baseEmbed({ title, description, color, fields }) {
  return {
    title: truncateEmbedText(title, 256),
    description: truncateEmbedText(description || "", 4096),
    color: color || COLORS.neutral,
    fields: compactFields(fields).slice(0, 25),
    footer: FOOTER,
    timestamp: new Date().toISOString()
  };
}

function field(name, value, inline = false) {
  if (value === null || value === undefined || value === "") return null;
  return {
    name: truncateEmbedText(name, 256),
    value: truncateEmbedText(String(value), 1024),
    inline
  };
}

function optionalField(name, value, inline = false) {
  return value === null || value === undefined || value === "" ? null : field(name, safeValue(value), inline);
}

function compactFields(fields) {
  return (fields || []).filter(Boolean);
}

function statusLine(label, value) {
  return `**${escapeMarkdown(label)}:** ${escapeMarkdown(value)}`;
}

function roleLine(label, configured) {
  return `${configured ? "Configured" : "Missing"} — ${escapeMarkdown(label)}`;
}

function truthLabel(value) {
  return value ? "YES" : "NO";
}

function statusText(value) {
  return String(value || "UNKNOWN").toUpperCase();
}

function colorForStatus(value) {
  const text = statusText(value);
  if (/ready|online|ok|healthy|pass/.test(text.toLowerCase())) return COLORS.ready;
  if (/down|failed|error|offline|stopped/.test(text.toLowerCase())) return COLORS.down;
  if (/issue|degraded|missing|warn|unknown/.test(text.toLowerCase())) return COLORS.issue;
  return COLORS.neutral;
}

function isFailure(payload) {
  return payload?.ok === false || (Number(payload?.status) >= 400);
}

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object") return Object.entries(value).map(([name, item]) => ({ name, ...(typeof item === "object" && item !== null ? item : { status: item }) }));
  return [value];
}

function lines(values) {
  return values.filter(Boolean).join("\n");
}

function safeValue(value) {
  return escapeMarkdown(String(value ?? "Unknown"));
}

function labelCase(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/\bS2s\b/g, "S2S")
    .replace(/\bApi\b/g, "API")
    .replace(/\bDb\b/g, "DB")
    .replace(/\bCpu\b/g, "CPU")
    .replace(/\bRam\b/g, "RAM");
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value)))];
}

function escapeMarkdown(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/~/g, "\\~")
    .replace(/\|/g, "\\|")
    .replace(/>/g, "\\>");
}

function truncateEmbedText(value, max) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, Math.max(0, max - 12))}\n…truncated` : text;
}

function redact(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (/token|secret|password|authorization|cookie|api[-_]?key/i.test(key)) return "[REDACTED]";
    if (typeof item === "string" && /(Bearer\s+|Bot\s+|[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,})/.test(item)) return "[REDACTED]";
    return item;
  }));
}
