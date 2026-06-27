import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";

export function updateEnvFileValue(repoRoot, key, value) {
  const envPath = resolve(repoRoot, ".env");
  const current = existsSync(envPath) ? readFileSync(envPath, "utf8").split(/\r?\n/) : [];
  const normalizedKey = String(key || "").trim();
  const line = `${normalizedKey}=${quoteEnv(String(value))}`;
  let found = false;
  const next = current.map((existing) => {
    if (envLineKey(existing) === normalizedKey) {
      found = true;
      return line;
    }
    return existing;
  });
  if (!found) next.push(line);
  writeFileSync(envPath, `${next.filter((entry, index) => entry !== "" || index < next.length - 1).join("\n")}\n`, { mode: 0o644 });
  try { chmodSync(envPath, 0o644); } catch {}
}

export function quoteEnv(value) {
  if (/^[A-Za-z0-9_.:-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function envLineKey(line) {
  const text = String(line || "").trimStart();
  if (!text || text.startsWith("#")) return "";
  const index = text.indexOf("=");
  return index > 0 ? text.slice(0, index).trim() : "";
}
