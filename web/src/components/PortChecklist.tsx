type PortRow = { name: string; port: string; protocol: string; status: string; detail: string; kind: string };

export function PortChecklist({ text, statusText = "" }: { text: string; statusText?: string }) {
  const rows = parseStatusPorts(statusText);
  const fallbackRows = rows.length ? rows : parseDiagnosticPorts(text);
  const warnings = parseNetworkWarnings(text);
  return <section className="action-section spaced-section">
    <h4>Ports / Listeners</h4>
    {warnings.map((warning, index) => <article className="info-panel action-section" key={`${warning}-${index}`}>
      <strong>Network Note</strong>
      <p>{warning}</p>
    </article>)}
    {fallbackRows.length ? <div className="table-wrap"><table><thead><tr><th>Name</th><th>Port</th><th>Protocol</th><th>Status</th><th>Details</th></tr></thead><tbody>{fallbackRows.map((row) => <tr key={`${row.name}-${row.port}-${row.protocol}`}><td>{row.name}</td><td>{row.port}</td><td>{row.protocol}</td><td><span className={`badge badge-${row.kind}`}>{row.status}</span></td><td>{row.detail}</td></tr>)}</tbody></table></div> : <p>Run port checks to see listener status.</p>}
  </section>;
}

function parseStatusPorts(text: string): PortRow[] {
  const seen = new Set<string>();
  return sectionLines(text, "Listeners").filter((line) => !/^CHECK\s+PORT\s+STATUS/i.test(line)).map((line) => {
    const match = line.match(/^(.+?)\s+(\d{2,5})\/(tcp|udp)\s+(\S+)/i);
    if (!match) return null;
    const [, rawName, port, protocol, state] = match;
    const key = `${port}/${protocol.toUpperCase()}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const status = /^OK$/i.test(state) ? "Ready" : /missing|fail/i.test(state) ? "Failed" : "Warn";
    return { name: friendlyPortName(rawName, port, protocol), port, protocol: protocol.toUpperCase(), status, detail: status === "Ready" ? "Open" : friendlyPortDetail(state), kind: kindForStatus(status) };
  }).filter(Boolean) as PortRow[];
}

function parseDiagnosticPorts(text: string): PortRow[] {
  const seen = new Set<string>();
  return sectionLines(text, "Local listeners").map((line) => line.trim()).filter((line) => /^(OK|WARN|FAIL|WAIT)\s+/i.test(line) && /\b(udp|tcp)\b/i.test(line) && /\b\d{2,5}\b/.test(line)).map((line) => {
    const portToken = line.match(/\b(UDP|TCP)\s+(\d{2,5})\b/i) || line.match(/\b(\d{2,5})\/(udp|tcp)\b/i);
    if (!portToken) return null;
    const protocol = (portToken[1].length <= 3 ? portToken[1] : portToken[2]).toUpperCase();
    const port = portToken[1].length <= 3 ? portToken[2] : portToken[1];
    const name = friendlyPortName(line.replace(/^(OK|WARN|FAIL|WAIT)\s+/i, ""), port, protocol);
    const key = `${name}-${port}-${protocol}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const status = /^FAIL\s+/i.test(line) ? "Failed" : /^(WARN|WAIT)\s+/i.test(line) ? "Warn" : "Ready";
    return { name, port, protocol, status, detail: status === "Ready" ? "Open" : cleanDetail(line), kind: kindForStatus(status) };
  }).filter(Boolean) as PortRow[];
}

function parseNetworkWarnings(text: string) {
  return stripAnsi(text).split(/\r?\n/).map((line) => line.trim()).filter((line) => /^WARN\s+/i.test(line) && /public mode advertises/i.test(line)).map(() => {
    return "Public server mode detected. Confirm UDP game ports are forwarded if players cannot connect.";
  }).slice(0, 1);
}

function friendlyPortName(raw: string, port: string, protocol: string) {
  const key = `${port}/${protocol.toLowerCase()}`;
  const known: Record<string, string> = {
    "15432/tcp": "Postgres",
    "32573/tcp": "RabbitMQ Admin",
    "31982/tcp": "RabbitMQ Game",
    "31983/tcp": "RabbitMQ Game HTTP",
    "5059/tcp": "Text Router",
    "11717/tcp": "Director",
    "7777/udp": "Overmap Clients",
    "7778/udp": "Survival 1 Clients",
    "7888/udp": "Survival 1 S2S",
    "7889/udp": "Overmap S2S"
  };
  return known[key] || raw.replace(/\bis not listening\b.*$/i, "").replace(/\blistening\b.*$/i, "").replace(/\s+/g, " ").trim();
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

function cleanDetail(line: string) {
  return friendlyPortDetail(line.replace(/^(OK|WARN|WAIT|FAIL)\s+/i, ""));
}

function friendlyPortDetail(value: string) {
  return value
    .replace(/\bmissing\b/gi, "Missing")
    .replace(/\bwait\b/gi, "Wait")
    .replace(/\bready\b/gi, "Ready")
    .replace(/\s+/g, " ")
    .trim();
}

function kindForStatus(status: string) {
  if (status === "Ready") return "pass";
  if (status === "Failed") return "fail";
  return "warn";
}

function stripAnsi(text: string) {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}
