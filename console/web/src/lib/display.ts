export function formatUiSentence(value: unknown, pending = false) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const clean = text.replace(/(?:\s*\.\s*){2,}$/g, "").replace(/\s+[.!?]$/g, "").trim();
  const capitalized = clean.charAt(0).toUpperCase() + clean.slice(1);
  if (pending) return capitalized.replace(/[.!?]+$/g, "");
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

export function normalizeStatus(value: string) {
  const text = String(value || "").trim();
  if (/^ready$/i.test(text)) return "pass";
  if (/^not running$/i.test(text)) return "fail";
  if (/^starting$/i.test(text)) return "warn";
  if (/^loading$/i.test(text)) return "warn";
  if (/failed|failure|error|fatal|unhealthy|down|missing|blocked|disabled/i.test(value)) return "fail";
  if (/attention|warning|warn|not ready|loading|starting|waiting|partial|unverified|experimental|unavailable|checking/i.test(value)) return "warn";
  if (/ready|ok|healthy|running|up|succeeded|success|checked|found|available|enabled|connected|saved/i.test(value)) return "pass";
  return "info";
}

export function formatDisplayValue(value: unknown) {
  const text = String(value);
  if (/^stopped$/.test(text)) return "Stopped";
  if (/^unset$/.test(text)) return "Unset";
  return text;
}

export function titleCase(value: string) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

export function firstDefined(...values: unknown[]) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

export function stripAnsi(text: string) {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

export function summarizeCommandText(text: string) {
  if (/^\s*(\{\}|\[\]|null|undefined)\s*$/i.test(text)) return "Action completed.";
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return "No output.";
  const important = lines.filter((line) => /local build|remote build|current stack version|latest release|update available|no update|already latest|up to date|ok|ready|warning|error|failed|success|blocked|unsupported|publish/i.test(line));
  return (important[0] || lines[0]).slice(0, 240);
}

export function formatCell(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return formatDisplayValue(value);
}

export function friendlyColumnName(value: string) {
  const labels: Record<string, string> = {
    actor_id: "Actor ID",
    character_name: "Character Name",
    account_id: "Account ID",
    action_player_id: "Admin Action ID",
    last_seen: "Last Online",
    online_status: "Status",
    fls_id: "FLS ID",
    display_name: "Name",
    category: "Category",
    id: "ID",
    raw_name: "Raw Name",
    backupName: "Backup Name",
    battlegroupId: "Battlegroup ID",
    size: "Size",
    sizeBytes: "Size Bytes",
    vehicle: "Vehicle",
    actor: "Actor",
    templates: "Templates",
    skillModule: "Skill Module",
    maxLevel: "Max Level",
    itemName: "Item Name",
    itemId: "Item ID",
    stack_size: "Quantity",
    quantity: "Quantity",
    durability: "Durability",
    created: "Created",
    name: "Name",
    row_count: "Rows",
    estimated_rows: "Estimated Rows",
    type: "Type",
    source: "Source",
    time: "Time",
    action: "Action",
    target: "Player",
    status: "Status",
    summary: "Summary",
    recipeName: "Recipe",
    researchName: "Research",
    recipeId: "Recipe ID",
    quality_level: "Grade",
    qualityLevel: "Grade",
    itemKey: "Item Key",
    productGroup: "Product Group"
  };
  return labels[value] || value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
