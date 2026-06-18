#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

const DISCORD_API = "https://discord.com/api/v10";
const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(`Discord discovery failed: ${safeErrorMessage(error)}`);
  process.exit(1);
});

async function main() {
  const auth = readBotAuth(args.authFile || process.env.DISCORD_BOT_TOKEN_FILE);
  const app = await discordGet(auth, "/oauth2/applications/@me");
  const bot = await discordGet(auth, "/users/@me");
  const guilds = await discordGet(auth, "/users/@me/guilds");

  console.log("Discord bot discovery");
  console.log("=====================");
  console.log(`Application: ${app.name || "unknown"} (${app.id})`);
  console.log(`Bot user:    ${bot.username || "unknown"} (${bot.id})`);
  console.log("");
  console.log("Suggested environment:");
  console.log(`export DISCORD_CLIENT_ID=\"${app.id}\"`);

  const guild = selectByName(guilds, args.guild, "guild");
  if (!guild) {
    console.log("");
    console.log("Guilds visible to this bot:");
    for (const item of guilds) console.log(`- ${item.name} (${item.id})`);
    console.log("");
    console.log("Re-run with --guild \"Guild Name\" to list channels and roles.");
    return;
  }

  console.log(`export DISCORD_GUILD_ID=\"${guild.id}\"`);
  console.log("");
  console.log(`Selected guild: ${guild.name} (${guild.id})`);

  const channels = await discordGet(auth, `/guilds/${encodeURIComponent(guild.id)}/channels`);
  const textChannels = channels
    .filter((channel) => [0, 5, 10, 11, 12, 15].includes(channel.type))
    .sort((left, right) => String(left.name || "").localeCompare(String(right.name || "")));
  const selectedChannel = args.channel ? selectByName(textChannels, args.channel.replace(/^#/, ""), "channel") : null;

  if (selectedChannel) {
    console.log(`export DUNE_DISCORD_CHANNEL_ID=\"${selectedChannel.id}\"`);
    console.log(`Selected channel: #${selectedChannel.name} (${selectedChannel.id})`);
  }

  console.log("");
  console.log("Channels:");
  for (const channel of textChannels) console.log(`- #${channel.name} (${channel.id})`);

  const roles = await discordGet(auth, `/guilds/${encodeURIComponent(guild.id)}/roles`);
  const sortedRoles = roles
    .filter((role) => role.name !== "@everyone")
    .sort((left, right) => String(left.name || "").localeCompare(String(right.name || "")));

  console.log("");
  console.log("Roles:");
  for (const role of sortedRoles) console.log(`- ${role.name} (${role.id})`);
}

function selectByName(items, name, label) {
  if (!name) return items.length === 1 ? items[0] : null;
  const normalized = normalizeName(name);
  const exact = items.find((item) => normalizeName(item.name) === normalized);
  if (exact) return exact;
  const partial = items.filter((item) => normalizeName(item.name).includes(normalized));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error(`Multiple ${label}s match '${name}': ${partial.map((item) => item.name).join(", ")}`);
  throw new Error(`No ${label} matches '${name}'.`);
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function readBotAuth(path) {
  if (!path) throw new Error("Set DISCORD_BOT_TOKEN_FILE or pass --auth-file.");
  if (!existsSync(path)) throw new Error(`Auth file does not exist: ${path}`);
  const value = readFileSync(path, "utf8").trim();
  if (!value) throw new Error(`Auth file is empty: ${path}`);
  return value;
}

async function discordGet(auth, path) {
  const response = await fetch(`${DISCORD_API}${path}`, {
    headers: { authorization: `Bot ${auth}` }
  });
  if (!response.ok) throw new Error(`Discord API request failed: ${response.status} ${await response.text()}`);
  return response.json();
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--auth-file" || arg === "--token-file") parsed.authFile = requireValue(argv, ++index, arg);
    else if (arg === "--guild") parsed.guild = requireValue(argv, ++index, arg);
    else if (arg === "--channel") parsed.channel = requireValue(argv, ++index, arg);
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
  console.log(`Usage: node scripts/discord-discover.mjs [options]\n\nOptions:\n  --token-file PATH     Discord bot token file. Defaults to DISCORD_BOT_TOKEN_FILE.\n  --guild NAME         Guild/server name. If omitted and the bot is in one guild, it is selected.\n  --channel NAME       Optional channel name to resolve.\n`);
}

function safeErrorMessage(error) {
  return String(error?.message || error || "Unknown error").replace(/(Bot|Bearer)\s+\S+/g, "$1 [REDACTED]");
}
