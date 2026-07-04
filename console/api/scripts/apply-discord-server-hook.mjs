#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const serverPath = resolve("src/server.js");
let source = readFileSync(serverPath, "utf8");

const importLine = 'import { handleDiscordAdapterRoute, isDiscordAdapterRoute } from "./integrations/discord/routes.js";\nimport { discordStatusProvider } from "./integrations/discord/statusProvider.js";\n';
const importAnchor = 'import { funcomAuthMismatchDetected, matchingFuncomAuthLines, saveFuncomTokenValue as writeFuncomToken, validDockerSince } from "./services/funcomAuth.js";\n';

if (!source.includes(importLine)) {
  if (!source.includes(importAnchor)) {
    throw new Error("Import anchor not found. Refusing to modify src/server.js.");
  }
  source = source.replace(importAnchor, `${importAnchor}${importLine}`);
}

const hook = `\n  if (isDiscordAdapterRoute(path)) {\n    return handleDiscordAdapterRoute({\n      req,\n      res,\n      path,\n      config,\n      readJson,\n      json,\n      statusProvider: ({ diagnostic } = {}) => discordStatusProvider(config, { diagnostic })\n    });\n  }\n`;
const hookAnchor = '  if (path === "/api/health") return json(res, 200, { ok: true, app: config.appName });\n';

if (!source.includes(hook)) {
  if (!source.includes(hookAnchor)) {
    throw new Error("Route hook anchor not found. Refusing to modify src/server.js.");
  }
  source = source.replace(hookAnchor, `${hook}${hookAnchor}`);
}

writeFileSync(serverPath, source, "utf8");
console.log("Applied Discord adapter server hook to src/server.js");
