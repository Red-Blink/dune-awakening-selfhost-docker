type CheckRow = {
  name: string;
  detail: string;
  status: "Ready" | "Warn" | "Failed" | "Info" | "Unknown";
  kind: "pass" | "warn" | "fail" | "info";
};

type GroupedCheckRow = CheckRow & { group: string };

const CONTAINER_LABELS: Record<string, string> = {
  "dune-postgres": "Dune Postgres",
  "dune-rmq-admin": "RabbitMQ Admin",
  "dune-rmq-game": "RabbitMQ Game",
  "dune-text-router": "Text Router",
  "dune-director": "Dune Director",
  "dune-server-gateway": "Gateway",
  "dune-server-survival-1": "Survival 1",
  "dune-server-overmap": "Overmap",
  "dune-orchestrator": "Orchestrator"
};

export function ReadinessTimeline({ text, statusText = "" }: { text: string; statusText?: string }) {
  const groups = buildReadinessGroups(text, statusText);
  const hasRows = Object.values(groups).some((rows) => rows.length);
  return <section className="action-section spaced-section">
    <h4>Readiness Checklist</h4>
    {hasRows ? <div className="readiness-groups">{Object.entries(groups).map(([group, rows]) => rows.length ? <section className="readiness-group" key={group}>
      <h5>{group}</h5>
      <div className="check-grid">{rows.map((check, index) => <article className="check-card" key={`${group}-${check.name}-${index}`}>
        <div><strong>{check.name}</strong>{check.detail && <p>{check.detail}</p>}</div>
        <span className={`badge badge-${check.kind}`}>{check.status}</span>
      </article>)}</div>
    </section> : null)}</div> : <p>Readiness has not been checked yet.</p>}
  </section>;
}

function buildReadinessGroups(readyText: string, statusText: string) {
  const statusContainers = parseStatusContainers(statusText);
  const readyRows = parseReadyRows(readyText);
  const statusListeners = parseStatusListeners(statusText);
  const readyListeners = readyRows.filter((row) => row.group === "Listener Checks");
  const gameRows = parseStatusGameServers(statusText, readyRows);
  const rabbitRows = parseStatusRabbit(statusText, readyRows);
  const flsRows = parseStatusFls(statusText, readyRows);
  return {
    "Container Checks": statusContainers.length ? statusContainers : readyRows.filter((row) => row.group === "Container Checks").map(({ group: _group, ...row }) => row),
    "Listener Checks": statusListeners.length ? statusListeners : readyListeners.map(({ group: _group, ...row }) => row),
    "Game Server Checks": gameRows,
    "RabbitMQ Game Connections": rabbitRows,
    "Funcom/FLS Summary": flsRows,
    "Dynamic Game Map": readyRows.filter((row) => row.group === "Dynamic Game Map").map(({ group: _group, ...row }) => row)
  };
}

function parseReadyRows(text: string): GroupedCheckRow[] {
  return stripAnsi(text).split(/\r?\n/).map((line) => line.trim()).filter((line) => /^(OK|WAIT|FAIL)\s+/i.test(line)).map((line) => {
    const raw = line.replace(/^(OK|WAIT|FAIL)\s+/i, "").trim();
    const status: CheckRow["status"] = /^FAIL\s+/i.test(line) ? "Failed" : /^WAIT\s+/i.test(line) && /warming/i.test(raw) ? "Info" : /^WAIT\s+/i.test(line) ? "Warn" : "Ready";
    const group = readyGroupFor(raw);
    const name = friendlyReadyName(raw);
    return { name, detail: detailForReady(raw, name, status), status, kind: kindForStatus(status), group };
  }).filter((row) => row.group && row.name && !/world_partition|partition rows/i.test(row.name));
}

function readyGroupFor(raw: string) {
  if (/^container\s+/i.test(raw)) return "Container Checks";
  if (/^(TCP|UDP)\s+\d+/i.test(raw)) return "Listener Checks";
  if (/^no dynamic|dynamic game/i.test(raw)) return "Dynamic Game Map";
  if (/rmq|connections/i.test(raw)) return "RabbitMQ Game Connections";
  if (/fls|population|gateway monitoring/i.test(raw)) return "Funcom/FLS Summary";
  if (/survival_1|overmap/i.test(raw)) return "Game Server Checks";
  return "";
}

function parseStatusContainers(text: string): CheckRow[] {
  return sectionLines(text, "Containers").filter((line) => !/^SERVICE\s+STATUS/i.test(line)).map((line) => {
    const match = line.match(/^(\S+)\s+(.+)$/);
    if (!match) return null;
    const [, id, state] = match;
    return {
      name: CONTAINER_LABELS[id] || friendlyName(id),
      detail: friendlyCheckDetail(state),
      status: /up\b/i.test(state) ? "Ready" : /missing|exited|stopped|dead/i.test(state) ? "Failed" : "Warn",
      kind: kindForStatus(/up\b/i.test(state) ? "Ready" : /missing|exited|stopped|dead/i.test(state) ? "Failed" : "Warn")
    };
  }).filter(Boolean) as CheckRow[];
}

function parseStatusListeners(text: string): CheckRow[] {
  const seen = new Set<string>();
  return sectionLines(text, "Listeners").filter((line) => !/^CHECK\s+PORT\s+STATUS/i.test(line)).map((line) => {
    const match = line.match(/^(.+?)\s+(\d{2,5})\/(tcp|udp)\s+(\S+)/i);
    if (!match) return null;
    const [, name, port, protocol, state] = match;
    const key = `${port}/${protocol.toUpperCase()}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return {
      name: friendlyListenerName(name.trim(), port, protocol),
      detail: `${port}/${protocol.toUpperCase()}`,
      status: /^OK$/i.test(state) ? "Ready" : /missing|fail/i.test(state) ? "Failed" : "Warn",
      kind: kindForStatus(/^OK$/i.test(state) ? "Ready" : /missing|fail/i.test(state) ? "Failed" : "Warn")
    };
  }).filter(Boolean) as CheckRow[];
}

function parseStatusGameServers(text: string, readyRows: ReturnType<typeof parseReadyRows>): CheckRow[] {
  const rows = sectionLines(text, "Game servers").filter((line) => !/^MAP\s+STATE\s+UPTIME/i.test(line) && !/^Note:/i.test(line)).map((line) => {
    const match = line.match(/^(\S+)\s+(.+?)\s{2,}(.+)$/);
    if (!match) return null;
    const [, map, state, uptime] = match;
    const status: CheckRow["status"] = /ready/i.test(state) ? "Ready" : /not running|missing/i.test(state) ? "Failed" : /warming/i.test(state) ? "Info" : "Warn";
    return { name: friendlyName(map), detail: `${friendlyCheckDetail(state)} - ${formatGameUptime(uptime)}`, status, kind: kindForStatus(status) };
  }).filter(Boolean) as CheckRow[];
  return rows.length ? rows : readyRows.filter((row) => row.group === "Game Server Checks").map(({ group: _group, ...row }) => row);
}

function parseStatusRabbit(text: string, readyRows: ReturnType<typeof parseReadyRows>): CheckRow[] {
  const section = sectionLines(text, "RabbitMQ game connections");
  if (!section.length) return readyRows.filter((row) => row.group === "RabbitMQ Game Connections").map(({ group: _group, ...row }) => row);
  if (section.some((line) => /not running|missing|failed/i.test(line))) {
    return [{ name: "RabbitMQ Game", detail: friendlyCheckDetail(friendlyIssue(section[0])), status: "Failed", kind: "fail" }];
  }
  const readyFailed = readyRows.find((row) => row.group === "RabbitMQ Game Connections" && row.status !== "Ready");
  return section.map((line) => {
    const [name, value = ""] = line.split(":").map((part) => part.trim());
    const status: CheckRow["status"] = readyFailed ? readyFailed.status : "Ready";
    return { name: friendlyName(name), detail: friendlyCheckDetail(value), status, kind: kindForStatus(status) };
  });
}

function parseStatusFls(text: string, readyRows: ReturnType<typeof parseReadyRows>): CheckRow[] {
  const section = sectionLines(text, "Funcom/FLS summary").filter((line) => /^(Director heartbeat|Population declaration|Max capacity declaration|Gateway DB monitoring)\s*:/i.test(line));
  if (!section.length) return readyRows.filter((row) => row.group === "Funcom/FLS Summary").map(({ group: _group, ...row }) => row);
  return section.map((line) => {
    const [name, value = ""] = line.split(":").map((part) => part.trim());
    const status: CheckRow["status"] = /^OK$/i.test(value) ? "Ready" : /fail|error/i.test(value) ? "Failed" : "Warn";
    return { name: friendlyName(name), detail: friendlyCheckDetail(value), status, kind: kindForStatus(status) };
  });
}

function friendlyReadyName(raw: string) {
  return raw
    .replace(/^container\s+/i, "")
    .replace(/^TCP\s+(\d+)\s+/i, "TCP $1 ")
    .replace(/^UDP\s+(\d+)\s+/i, "UDP $1 ")
    .replace(/^no dynamic game maps currently running$/i, "No Active Maps")
    .replace(/dune-postgres/gi, "Dune Postgres")
    .replace(/dune-rmq-admin/gi, "RabbitMQ Admin")
    .replace(/dune-rmq-game/gi, "RabbitMQ Game")
    .replace(/dune-text-router/gi, "Text Router")
    .replace(/dune-director/gi, "Dune Director")
    .replace(/dune-server-gateway/gi, "Gateway")
    .replace(/dune-server-survival-1/gi, "Survival 1")
    .replace(/dune-server-overmap/gi, "Overmap")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detailForReady(raw: string, name: string, status: string) {
  if (status === "Ready") return "";
  const clean = friendlyCheckDetail(friendlyIssue(raw));
  return clean === name ? "Attention needed" : clean;
}

function friendlyListenerName(name: string, port: string, protocol: string) {
  const key = `${port}/${protocol.toLowerCase()}`;
  const known: Record<string, string> = {
    "15432/tcp": "Postgres localhost",
    "32573/tcp": "RabbitMQ Admin",
    "31982/tcp": "RabbitMQ Game",
    "31983/tcp": "RabbitMQ Game HTTP",
    "5059/tcp": "Text Router",
    "11717/tcp": "Director",
    "7777/udp": "Overmap clients",
    "7778/udp": "Survival 1 clients",
    "7888/udp": "Survival 1 S2S",
    "7889/udp": "Overmap S2S"
  };
  return known[key] || friendlyName(name);
}

function formatGameUptime(value: string) {
  const clean = value.trim().replace(/^up\s+/i, "").replace(/^about\s+/i, "");
  const number = clean.match(/\b(\d+)\s*(second|minute|hour|day|week|month|year)s?\b/i);
  if (number) return `Up ${number[1]}${timeUnitShort(number[2])} ago`;
  if (/^an?\s+hour$/i.test(clean)) return "Up 1h ago";
  if (/^an?\s+minute$/i.test(clean)) return "Up 1m ago";
  if (/^an?\s+second$/i.test(clean)) return "Up 1s ago";
  if (/^a\s+day$/i.test(clean)) return "Up 1d ago";
  if (/^less than a minute$/i.test(clean)) return "Up 1m ago";
  return normalizeDisplayText(value.trim());
}

function timeUnitShort(value: string) {
  if (/second/i.test(value)) return "s";
  if (/minute/i.test(value)) return "m";
  if (/hour/i.test(value)) return "h";
  if (/day/i.test(value)) return "d";
  if (/week/i.test(value)) return "w";
  if (/month/i.test(value)) return "mo";
  return "y";
}

function sectionLines(text: string, section: string) {
  const lines = stripAnsi(text).split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `=== ${section.toLowerCase()} ===`);
  if (start < 0) return [];
  const result: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^=== .+ ===$/.test(line.trim())) break;
    if (line.trim()) result.push(line.trim());
  }
  return result;
}

function friendlyName(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()).replace("FlS", "FLS").replace("Rmq", "RMQ");
}

function friendlyIssue(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function friendlyCheckDetail(value: string) {
  return normalizeDisplayText(value
    .replace(/\bmissing\b/gi, "Missing")
    .replace(/\bwait\b/gi, "Wait")
    .replace(/\bnot running\b/gi, "Not Running")
    .replace(/\bwarming\b/gi, "Warming")
    .replace(/\bready\b/gi, "Ready")
    .replace(/\bRestarting\s+\(\d+\)\s+\d+\s+seconds?\s+ago\b/i, "Restarting")
    .replace(/\s+/g, " ")
    .trim());
}

function normalizeDisplayText(value: string) {
  return value
    .replace(/\bRabbitMQ game\b/g, "RabbitMQ Game")
    .replace(/\bRabbitMQ Game is Not Running\b/g, "RabbitMQ Game is not running")
    .replace(/\bNot Running\s+-\s+missing\b/gi, "Not Running - Missing")
    .replace(/^Up\s+About\b/, "Up about");
}

function kindForStatus(status: string): CheckRow["kind"] {
  if (status === "Ready") return "pass";
  if (status === "Failed") return "fail";
  if (status === "Info") return "info";
  return "warn";
}

function stripAnsi(text: string) {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}
