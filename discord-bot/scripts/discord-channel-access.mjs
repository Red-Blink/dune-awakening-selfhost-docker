#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

const DISCORD_API = "https://discord.com/api/v10";
const ALLOW_BITS = String((1n << 10n) + (1n << 11n) + (1n << 14n) + (1n << 31n));
const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(`Discord channel access helper failed: ${safeErrorMessage(error)}`);
  process.exit(1);
});

async function main() {
  const auth = readBotAuth(args.authFile || process.env.DISCORD_BOT_TOKEN_FILE);
  const bot = await discordGet(auth, "/users/@me");
  const guilds = await discordGet(auth, "/users/@me/guilds");
  const guild = selectByName(guilds, args.guild, "guild");
  if (!guild) {
    console.log("Guilds visible to this bot:");
    for (const item of guilds) console.log(`- ${item.name} (${item.id})`);
    throw new Error("Pass --guild with one of the guild names above.");
  }

  const channels = await discordGet(auth, `/guilds/${encodeURIComponent(guild.id)}/channels`);
  const textChannels = channels.filter((channel) => [0, 5, 10, 11, 12, 15].includes(channel.type));
  const channel = selectByName(textChannels, String(args.channel || "").replace(/^#/, ""), "channel");
  if (!channel) {
    console.log(`Channels visible in ${guild.name}:`);
    for (const item of textChannels) console.log(`- #${item.name} (${item.id})`);
    throw new Error("Pass --channel with one of the channel names above.");
  }

  console.log("Discord channel access selection");
  console.log("================================");
  console.log(`Guild:   ${guild.name} (${guild.id})`);
  console.log(`Channel: #${channel.name} (${channel.id})`);
  console.log(`Bot:     ${bot.username || "unknown"} (${bot.id})`);
  console.log(`Allow:   ${ALLOW_BITS} (View Channel, Send Messages, Embed Links, Use Application Commands)`);

  if (!args.execute) {
    console.log("");
    console.log("Dry run only. Re-run with --execute to create/update the channel permission overwrite for the bot user.");
    return;
  }

  const response = await fetch(`${DISCORD_API}/channels/${encodeURIComponent(channel.id)}/permissions/${encodeURIComponent(bot.id)}`, {
    method: "PUT",
    headers: {
      authorization: `Bot ${auth}`,
      "content-type": "application/json",
      "x-audit-log-reason": encodeURIComponent("Grant Dune read-only Discord bot channel access")
    },
    body: JSON.stringify({
      type: 1,
      allow: ALLOW_BITS,
      deny: "0"
    })
  });

  if (!response.ok) {
    throw new Error(`Unable to update channel permissions: ${response.status} ${await response.text()}. The bot role likely needs Manage Channels, or you can grant View Channel, Send Messages, Embed Links, and Use Application Commands manually in Discord channel settings.`);
  }

  console.log("");
  console.log("Channel permission overwrite created/updated.");
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
  const parsed = { execute: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--auth-file" || arg === "--token-file") parsed.authFile = requireValue(argv, ++index, arg);
    else if (arg === "--guild") parsed.guild = requireValue(argv, ++index, arg);
    else if (arg === "--channel") parsed.channel = requireValue(argv, ++index, arg);
    else if (arg === "--execute") parsed.execute = true;
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
  console.log(`Usage: node scripts/discord-channel-access.mjs --guild NAME --channel NAME [--execute]\n\nOptions:\n  --token-file PATH     Discord bot token file. Defaults to DISCORD_BOT_TOKEN_FILE.\n  --guild NAME         Guild/server name.\n  --channel NAME       Channel name, with or without leading #.\n  --execute            Update the Discord channel permission overwrite. Omit for dry-run.\n`);
}

function safeErrorMessage(error) {
  return String(error?.message || error || "Unknown error").replace(/(Bot|Bearer)\s+\S+/g, "$1 [REDACTED]");
}
