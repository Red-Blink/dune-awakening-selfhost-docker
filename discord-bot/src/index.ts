import { loadConfig, validateConfig } from "./config.js";
import { redactValue, safeErrorMessage } from "./security/redaction.js";
import { allBotCapabilities } from "./security/authorization.js";

async function main(): Promise<void> {
  const config = loadConfig();
  validateConfig(config);

  // The network Discord client is intentionally deferred until the protected
  // Console adapter contract is stable. Command handlers and route calls are
  // implemented and can be exercised with scripts/command-smoke.mjs.
  console.log(JSON.stringify({
    service: "dune-discord-companion-bot",
    status: "read-only-command-layer-ready",
    commands: [
      "/dune health",
      "/dune status",
      "/dune status detail",
      "/dune readiness",
      "/dune services"
    ],
    capabilities: allBotCapabilities(),
    writesEnabled: false,
    config: redactValue({
      duneConsoleApiUrl: config.duneConsoleApiUrl,
      discordGuildId: config.discordGuildId,
      discordBotTokenFile: config.discordBotTokenFile,
      duneBotApiTokenFile: config.duneBotApiTokenFile
    })
  }));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    service: "dune-discord-companion-bot",
    status: "fatal",
    error: safeErrorMessage(error)
  }));
  process.exitCode = 1;
});
