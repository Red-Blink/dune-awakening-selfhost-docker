#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

const DISCORD_API = "https://discord.com/api/v10";
const DEFAULT_PERMISSIONS = String((1n << 10n) + (1n << 11n) + (1n << 14n) + (1n << 31n));
const DEFAULT_SCOPES = "bot applications.commands";

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(`Discord install URL helper failed: ${safeErrorMessage(error)}`);
  process.exit(1);
});

async function main() {
  const token = readOptionalBotToken(args.tokenFile || process.env.DISCORD_BOT_TOKEN_FILE);
  const app = token ? await discordGet(token, "/oauth2/applications/@me") : null;
  const bot = token ? await discordGet(token, "/users/@me") : null;
  const clientId = args.clientId || process.env.DISCORD_CLIENT_ID || app?.id;

  if (!clientId || !/^\d{15,25}$/.test(clientId)) {
    throw new Error("Missing Discord application/client ID. Set DISCORD_CLIENT_ID, pass --client-id, or provide DISCORD_BOT_TOKEN_FILE so the helper can discover it.");
  }

  const scopes = args.scopes || DEFAULT_SCOPES;
  const permissions = String(args.permissions || DEFAULT_PERMISSIONS);
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", scopes);
  url.searchParams.set("permissions", permissions);

  if (args.guildId) {
    url.searchParams.set("guild_id", args.guildId);
    url.searchParams.set("disable_guild_select", "true");
  }

  console.log("Discord bot install URL");
  console.log("=======================");
  if (app) console.log(`Application: ${app.name || "unknown"} (${app.id})`);
  if (bot) console.log(`Bot user:    ${bot.username || "unknown"} (${bot.id})`);
  console.log(`Scopes:      ${scopes}`);
  console.log(`Permissions: ${permissions}`);
  console.log("");
  console.log(String(url));
  console.log("");
  console.log("Use this URL when the bot is usable through slash commands but is not visible as a guild/channel member. Installing with both 'bot' and 'applications.commands' scopes creates the bot guild member.");

  if (app && !app.icon) {
    console.log("");
    console.log("Warning: the Discord application has no app icon. Upload an icon in Discord Developer Portal > Applications > General Information.");
  }
  if (bot && !bot.avatar) {
    console.log("Warning: the bot user has no avatar. Upload an avatar in Discord Developer Portal > Applications > Bot.");
  }
}

function readOptionalBotToken(path) {
  if (!path) return "";
  if (!existsSync(path)) throw new Error(`DISCORD_BOT_TOKEN_FILE does not exist: ${path}`);
  const token = readFileSync(path, "utf8").trim();
  if (!token) throw new Error(`DISCORD_BOT_TOKEN_FILE is empty: ${path}`);
  return token;
}

async function discordGet(token, path) {
  const response = await fetch(`${DISCORD_API}${path}`, {
    headers: { authorization: `Bot ${token}` }
  });
  if (!response.ok) throw new Error(`Discord API request failed: ${response.status} ${await response.text()}`);
  return response.json();
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--client-id") parsed.clientId = requireValue(argv, ++index, arg);
    else if (arg === "--guild-id") parsed.guildId = requireValue(argv, ++index, arg);
    else if (arg === "--permissions") parsed.permissions = requireValue(argv, ++index, arg);
    else if (arg === "--scopes") parsed.scopes = requireValue(argv, ++index, arg);
    else if (arg === "--token-file") parsed.tokenFile = requireValue(argv, ++index, arg);
    else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/discord-install-url.mjs [options]\n\nOptions:\n  --token-file PATH      Discord bot token file. Defaults to DISCORD_BOT_TOKEN_FILE.\n  --client-id ID        Discord application/client ID. Auto-discovered from bot token when possible.\n  --guild-id ID         Optional guild ID to preselect in the OAuth flow.\n  --permissions BITS    Discord permission bitset. Defaults to minimal read-only command permissions.\n  --scopes TEXT         OAuth scopes. Defaults to "bot applications.commands".\n`);
}

function safeErrorMessage(error) {
  return String(error?.message || error || "Unknown error").replace(/(Bot|Bearer)\s+\S+/g, "$1 [REDACTED]");
}
