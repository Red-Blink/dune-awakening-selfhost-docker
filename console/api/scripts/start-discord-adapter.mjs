#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const serverPath = resolve("src/server.js");
let source = readFileSync(serverPath, "utf8");

const importAnchor = 'import { funcomAuthMismatchDetected, matchingFuncomAuthLines, saveFuncomTokenValue as writeFuncomToken, validDockerSince } from "./services/funcomAuth.js";\n';
const imports = [
  'import { handleDiscordAdapterRoute, isDiscordAdapterRoute } from "./integrations/discord/routes.js";\n',
  'import { discordStatusProvider } from "./integrations/discord/statusProvider.js";\n',
  'import { discordReadinessProvider, discordServicesProvider } from "./integrations/discord/readOnlyProviders.js";\n'
];

if (!source.includes(importAnchor)) throw new Error("Server import anchor not found.");
for (const line of imports) {
  if (!source.includes(line)) source = source.replace(importAnchor, `${importAnchor}${line}`);
}

const hookAnchor = '  if (path === "/api/health") return json(res, 200, { ok: true, app: config.appName });\n';
const hook = `\n  if (isDiscordAdapterRoute(path)) {\n    return handleDiscordAdapterRoute({\n      req,\n      res,\n      path,\n      config,\n      readJson,\n      json,\n      statusProvider: ({ diagnostic } = {}) => discordStatusProvider(config, { diagnostic }),\n      readinessProvider: () => discordReadinessProvider(config),\n      servicesProvider: () => discordServicesProvider(config)\n    });\n  }\n`;

if (!source.includes("readinessProvider: () => discordReadinessProvider(config)")) {
  if (source.includes("statusProvider: ({ diagnostic } = {}) => discordStatusProvider(config, { diagnostic })")) {
    source = source.replace(
      "statusProvider: ({ diagnostic } = {}) => discordStatusProvider(config, { diagnostic })",
      "statusProvider: ({ diagnostic } = {}) => discordStatusProvider(config, { diagnostic }),\n      readinessProvider: () => discordReadinessProvider(config),\n      servicesProvider: () => discordServicesProvider(config)"
    );
  } else {
    if (!source.includes(hookAnchor)) throw new Error("Server route anchor not found.");
    source = source.replace(hookAnchor, `${hook}${hookAnchor}`);
  }
}

writeFileSync(serverPath, source, "utf8");

const child = spawn(process.execPath, ["src/server.js"], {
  stdio: "inherit",
  env: { ...process.env, DUNE_DISCORD_ADAPTER_ENABLED: "true" }
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exitCode = code ?? 1;
});
