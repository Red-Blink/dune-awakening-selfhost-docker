#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const IGNORED_DIRS = new Set(["node_modules", "dist", ".git"]);
const IGNORED_FILES = new Set(["package-lock.json"]);

const SECRET_PATTERNS = [
  { name: "Discord bot token", pattern: /\b[A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g },
  { name: "Discord MFA token", pattern: /mfa\.[A-Za-z0-9._-]{20,}/gi },
  { name: "Bearer token", pattern: /Bearer\s+[A-Za-z0-9._=-]{24,}/gi },
  { name: "Private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PRIVATE )?PRIVATE KEY-----/g },
  { name: "Postgres URL", pattern: /postgres(?:ql)?:\/\/[^\s"']+/gi },
  { name: "Hardcoded env secret assignment", pattern: /(?:DISCORD_BOT_TOKEN|DUNE_BOT_API_TOKEN|ADMIN_PASSWORD|DUNE_DB_PASSWORD|FUNCOM_TOKEN)\s*=\s*['\"][^'\"]{8,}['\"]/g }
];

let failed = false;

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    const rel = relative(ROOT, path);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path);
      continue;
    }
    if (!stat.isFile() || IGNORED_FILES.has(entry)) continue;
    scanFile(path, rel);
  }
}

function scanFile(path, rel) {
  const text = readFileSync(path, "utf8");
  for (const { name, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match) {
      failed = true;
      console.error(`[secret-scan] ${name} detected in ${rel}`);
    }
  }
}

walk(ROOT);

if (failed) {
  console.error("Secret scan failed. Remove verified secrets and use *_FILE runtime secret paths instead.");
  process.exit(1);
}

console.log("Secret scan passed.");
