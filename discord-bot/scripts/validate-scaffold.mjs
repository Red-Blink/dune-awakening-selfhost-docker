#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const requiredFiles = [
  "src/index.ts",
  "src/config.ts",
  "src/consoleApi.ts",
  "src/commands.ts",
  "src/security/redaction.ts",
  "src/security/authorization.ts",
  "scripts/command-smoke.mjs",
  "scripts/discord-runtime.mjs",
  "scripts/discord-formatters.mjs",
  "scripts/discord-install-url.mjs",
  "scripts/discord-discover.mjs",
  "scripts/discord-channel-access.mjs",
  "scripts/run-discord-runtime.sh",
  "scripts/run-local-discord-stack.sh",
  "test/redaction.test.mjs",
  "test/discord-formatters.test.mjs",
  "Dockerfile",
  "package-lock.json"
];

const missing = requiredFiles.filter((path) => !existsSync(path));
if (missing.length) {
  console.error(`Missing required scaffold files: ${missing.join(", ")}`);
  process.exit(1);
}

const dockerfile = readFileSync("Dockerfile", "utf8");
if (dockerfile.includes("/var/run/docker.sock")) {
  console.error("Docker socket mount is forbidden for the Discord bot.");
  process.exit(1);
}
if (/privileged:\s*true/i.test(dockerfile)) {
  console.error("Privileged container mode is forbidden for the Discord bot.");
  process.exit(1);
}

const auth = readFileSync("src/security/authorization.ts", "utf8");
const capabilityBlock = auth.match(/export\s+type\s+BotCapability\s*=([\s\S]*?);/);
if (!capabilityBlock) {
  console.error("BotCapability type block not found.");
  process.exit(1);
}

const capabilityLiterals = [...capabilityBlock[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
for (const capability of capabilityLiterals) {
  if (/(^|:)write$|destructive|broadcast|admin/i.test(capability)) {
    console.error(`Forbidden bot capability detected: ${capability}`);
    process.exit(1);
  }
}

for (const file of [
  "scripts/discord-runtime.mjs",
  "scripts/discord-formatters.mjs",
  "scripts/discord-install-url.mjs",
  "scripts/discord-discover.mjs",
  "scripts/discord-channel-access.mjs"
]) {
  const check = spawnSync("node", ["--check", file], { encoding: "utf8", timeout: 30000 });
  if (check.status !== 0) {
    console.error(`Discord syntax validation failed: ${file}`);
    if (check.stdout) console.error(check.stdout);
    if (check.stderr) console.error(check.stderr);
    if (check.error?.message) console.error(check.error.message);
    process.exit(check.status || 1);
  }
}

const runtime = readFileSync("scripts/discord-runtime.mjs", "utf8");
for (const forbidden of ["/var/run/docker.sock", "docker compose", "docker run", "postgres", "backup restore", "backup delete"] ) {
  if (runtime.toLowerCase().includes(forbidden.toLowerCase())) {
    console.error(`Forbidden runtime marker detected: ${forbidden}`);
    process.exit(1);
  }
}

for (const required of ["formatCommandResponse", "embeds", "allowed_mentions", "parse: []", "presence", "Arrakis status"]) {
  if (!runtime.includes(required)) {
    console.error(`Discord runtime missing embed-response marker: ${required}`);
    process.exit(1);
  }
}

const formatter = readFileSync("scripts/discord-formatters.mjs", "utf8");
for (const required of ["formatHealthResponse", "formatStatusCard", "formatReadinessResponse", "formatServicesResponse", "deriveIssues", "redact"]) {
  if (!formatter.includes(required)) {
    console.error(`Discord formatter missing required marker: ${required}`);
    process.exit(1);
  }
}

const installHelper = readFileSync("scripts/discord-install-url.mjs", "utf8");
for (const required of ["bot applications.commands", "oauth2/authorize", "View Channel", "Use Application Commands"]) {
  if (!installHelper.includes(required)) {
    console.error(`Discord install helper missing required marker: ${required}`);
    process.exit(1);
  }
}

const channelHelper = readFileSync("scripts/discord-channel-access.mjs", "utf8");
for (const required of ["--guild", "--channel", "--execute", "permission overwrite", "Use Application Commands"]) {
  if (!channelHelper.includes(required)) {
    console.error(`Discord channel helper missing required marker: ${required}`);
    process.exit(1);
  }
}

const launcher = readFileSync("scripts/run-discord-runtime.sh", "utf8");
for (const required of ["DUNE_DISCORD_ENV_FILE", "discord-bot.env", "DISCORD_BOT_TOKEN_FILE", "exec node scripts/discord-runtime.mjs"]) {
  if (!launcher.includes(required)) {
    console.error(`Discord runtime launcher missing required marker: ${required}`);
    process.exit(1);
  }
}

const stackLauncher = readFileSync("scripts/run-local-discord-stack.sh", "utf8");
for (const required of ["ADMIN_BIND_PORT", "8090", "api/integrations/discord/health", "discord-runtime.mjs"]) {
  if (!stackLauncher.includes(required)) {
    console.error(`Local Discord stack launcher missing required marker: ${required}`);
    process.exit(1);
  }
}

console.log("Discord bot scaffold validation passed.");
