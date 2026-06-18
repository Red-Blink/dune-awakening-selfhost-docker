#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { formatCommandResponse } from "./discord-formatters.mjs";

const DISCORD_API = "https://discord.com/api/v10";
const EPHEMERAL = 1 << 6;

const config = loadConfig();
const discordToken = readSecret(config.discordBotTokenFile, "DISCORD_BOT_TOKEN_FILE");
const duneApiToken = readSecret(config.duneBotApiTokenFile, "DUNE_BOT_API_TOKEN_FILE");
validateRuntimeConfig(config, discordToken, duneApiToken);

await registerGuildCommands();
await startGateway();

async function registerGuildCommands() {
  const url = `${DISCORD_API}/applications/${encodeURIComponent(config.discordClientId)}/guilds/${encodeURIComponent(config.discordGuildId)}/commands`;
  const response = await fetch(url, {
    method: "PUT",
    headers: discordHeaders(),
    body: JSON.stringify(duneCommandDefinition())
  });
  if (!response.ok) {
    throw new Error(`Discord command registration failed: ${response.status} ${await response.text()}`);
  }
  const body = await response.json();
  console.log(JSON.stringify({ service: "dune-discord-companion-bot", event: "slash_commands_registered", count: body.length }));
}

async function startGateway() {
  const gateway = await discordGet("/gateway/bot");
  const gatewayUrl = `${gateway.url}/?v=10&encoding=json`;
  const socket = new WebSocket(gatewayUrl);
  let heartbeatTimer = null;
  let sequence = null;

  socket.addEventListener("open", () => {
    console.log(JSON.stringify({ service: "dune-discord-companion-bot", event: "gateway_open" }));
  });

  socket.addEventListener("message", async (event) => {
    const packet = JSON.parse(String(event.data));
    if (packet.s !== null && packet.s !== undefined) sequence = packet.s;

    if (packet.op === 10) {
      heartbeatTimer = startHeartbeat(socket, packet.d.heartbeat_interval, () => sequence);
      socket.send(JSON.stringify({
        op: 2,
        d: {
          token: discordToken,
          intents: 0,
          properties: {
            os: process.platform,
            browser: "dune-discord-companion-bot",
            device: "dune-discord-companion-bot"
          },
          presence: {
            status: "online",
            since: null,
            afk: false,
            activities: [{ name: "Arrakis status", type: 3 }]
          }
        }
      }));
      return;
    }

    if (packet.op === 11) return;

    if (packet.t === "READY") {
      console.log(JSON.stringify({ service: "dune-discord-companion-bot", event: "gateway_ready", user: packet.d?.user?.username || "unknown" }));
      return;
    }

    if (packet.t === "INTERACTION_CREATE") {
      await handleInteraction(packet.d).catch(async (error) => {
        console.error(JSON.stringify({ service: "dune-discord-companion-bot", event: "interaction_error", error: safeErrorMessage(error) }));
        const failure = { content: "Dune command failed. Check Console adapter logs for details.", ephemeral: true };
        await editDeferredInteraction(packet.d, failure).catch(async () => {
          await replyToInteraction(packet.d, failure).catch(() => undefined);
        });
      });
    }
  });

  socket.addEventListener("close", (event) => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    console.error(JSON.stringify({ service: "dune-discord-companion-bot", event: "gateway_closed", code: event.code, reason: event.reason }));
    process.exitCode = 1;
  });

  socket.addEventListener("error", () => {
    console.error(JSON.stringify({ service: "dune-discord-companion-bot", event: "gateway_error" }));
  });
}

function startHeartbeat(socket, intervalMs, sequenceProvider) {
  const sendHeartbeat = () => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ op: 1, d: sequenceProvider() }));
    }
  };
  sendHeartbeat();
  return setInterval(sendHeartbeat, intervalMs);
}

async function handleInteraction(interaction) {
  if (interaction.type !== 2 || interaction.data?.name !== "dune") return;
  const parsed = parseDuneInteraction(interaction);
  const actor = actorFromInteraction(interaction, parsed.commandLabel);
  await deferInteraction(interaction, { ephemeral: commandStartsEphemeral(parsed.command) });

  if (parsed.command === "help") {
    await editDeferredInteraction(interaction, {
      ephemeral: true,
      content: "**Dune bot help**\n`/dune health` - adapter health\n`/dune status public` - public redacted status\n`/dune status detail` - admin-only diagnostics\n`/dune readiness` - readiness summary\n`/dune services` - service summary\n`/dune version` - bot/runtime version"
    });
    return;
  }

  if (parsed.command === "version") {
    await editDeferredInteraction(interaction, {
      ephemeral: true,
      content: "**Dune bot version**\n`0.1.0`\nRead-only Discord companion runtime."
    });
    return;
  }

  const result = await callDuneCommand(parsed.command, actor);
  await editDeferredInteraction(interaction, result);
}

function commandStartsEphemeral(command) {
  return command !== "status";
}

function parseDuneInteraction(interaction) {
  const first = interaction.data?.options?.[0];
  if (!first) return { command: "help", commandLabel: "/dune help" };

  if (first.name === "health") return { command: "health", commandLabel: "/dune health" };
  if (first.name === "readiness") return { command: "readiness", commandLabel: "/dune readiness" };
  if (first.name === "services") return { command: "services", commandLabel: "/dune services" };
  if (first.name === "help") return { command: "help", commandLabel: "/dune help" };
  if (first.name === "version") return { command: "version", commandLabel: "/dune version" };

  if (first.name === "status") {
    const second = first.options?.[0];
    if (second?.name === "detail") return { command: "statusDetail", commandLabel: "/dune status detail" };
    return { command: "status", commandLabel: "/dune status public" };
  }

  return { command: "help", commandLabel: "/dune help" };
}

function actorFromInteraction(interaction, commandName) {
  const member = interaction.member || {};
  const user = member.user || interaction.user || {};
  return {
    guildId: interaction.guild_id || config.discordGuildId,
    channelId: interaction.channel_id || "unknown-channel",
    userId: user.id || "unknown-user",
    username: user.username || user.global_name || "unknown-user",
    roleIds: Array.isArray(member.roles) ? member.roles : [],
    interactionId: interaction.id,
    commandName
  };
}

async function callDuneCommand(command, actor) {
  if (command === "health") {
    const response = await callConsole("GET", "/api/integrations/discord/health");
    return { ephemeral: true, ...formatCommandResponse("health", response) };
  }
  if (command === "status") {
    const response = await callConsole("POST", "/api/integrations/discord/status", { actor, diagnostic: false });
    return { ephemeral: false, ...formatCommandResponse("status", response) };
  }
  if (command === "statusDetail") {
    const response = await callConsole("POST", "/api/integrations/discord/status", { actor, diagnostic: true });
    return { ephemeral: true, ...formatCommandResponse("statusDetail", response) };
  }
  if (command === "readiness") {
    const response = await callConsole("POST", "/api/integrations/discord/readiness", { actor });
    return { ephemeral: true, ...formatCommandResponse("readiness", response) };
  }
  if (command === "services") {
    const response = await callConsole("POST", "/api/integrations/discord/services", { actor });
    return { ephemeral: true, ...formatCommandResponse("services", response) };
  }
  throw new Error(`Unsupported Dune command: ${command}`);
}

async function callConsole(method, path, body) {
  const url = `${config.duneConsoleApiUrl.replace(/\/$/, "")}${path}`;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${duneApiToken}`,
        ...(body ? { "content-type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      payload: {
        code: "console_unreachable",
        error: "Discord bot could not reach the Console adapter URL.",
        url,
        cause: safeErrorMessage(error)
      }
    };
  }
  const payload = await response.json().catch(() => ({ ok: false, code: "invalid_response", error: "Console returned non-JSON output." }));
  if (!response.ok) {
    return { ok: false, status: response.status, payload };
  }
  return payload;
}

async function deferInteraction(interaction, result) {
  const response = await fetch(`${DISCORD_API}/interactions/${interaction.id}/${interaction.token}/callback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: 5,
      data: {
        flags: result.ephemeral ? EPHEMERAL : undefined
      }
    })
  });
  if (!response.ok) {
    throw new Error(`Discord interaction defer failed: ${response.status} ${await response.text()}`);
  }
}

async function editDeferredInteraction(interaction, result) {
  const applicationId = interaction.application_id || config.discordClientId;
  const response = await fetch(`${DISCORD_API}/webhooks/${applicationId}/${interaction.token}/messages/@original`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(discordMessagePayload(result))
  });
  if (!response.ok) {
    throw new Error(`Discord deferred interaction edit failed: ${response.status} ${await response.text()}`);
  }
}

async function replyToInteraction(interaction, result) {
  const response = await fetch(`${DISCORD_API}/interactions/${interaction.id}/${interaction.token}/callback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: 4,
      data: {
        ...discordMessagePayload(result),
        flags: result.ephemeral ? EPHEMERAL : undefined
      }
    })
  });
  if (!response.ok) {
    throw new Error(`Discord interaction reply failed: ${response.status} ${await response.text()}`);
  }
}

function discordMessagePayload(result) {
  return {
    content: truncateDiscordMessage(result.content || ""),
    embeds: Array.isArray(result.embeds) ? result.embeds.slice(0, 10) : [],
    allowed_mentions: { parse: [] }
  };
}

async function discordGet(path) {
  const response = await fetch(`${DISCORD_API}${path}`, { headers: discordHeaders() });
  if (!response.ok) throw new Error(`Discord API request failed: ${response.status} ${await response.text()}`);
  return response.json();
}

function discordHeaders() {
  return {
    authorization: `Bot ${discordToken}`,
    "content-type": "application/json"
  };
}

function duneCommandDefinition() {
  return [{
    name: "dune",
    description: "Read-only Dune server visibility commands.",
    dm_permission: false,
    options: [
      { type: 1, name: "health", description: "Show Discord adapter health." },
      {
        type: 2,
        name: "status",
        description: "Show server status.",
        options: [
          { type: 1, name: "public", description: "Show public redacted server status." },
          { type: 1, name: "detail", description: "Show admin-only detailed status." }
        ]
      },
      { type: 1, name: "readiness", description: "Show server readiness summary." },
      { type: 1, name: "services", description: "Show service summary." },
      { type: 1, name: "help", description: "Show safe command help." },
      { type: 1, name: "version", description: "Show bot version." }
    ]
  }];
}

function truncateDiscordMessage(value) {
  const text = String(value || "");
  return text.length > 1900 ? `${text.slice(0, 1880)}\n…truncated` : text;
}

function loadConfig() {
  return {
    discordBotTokenFile: requiredEnv("DISCORD_BOT_TOKEN_FILE"),
    duneBotApiTokenFile: requiredEnv("DUNE_BOT_API_TOKEN_FILE"),
    duneConsoleApiUrl: requiredEnv("DUNE_CONSOLE_API_URL"),
    discordClientId: requiredDiscordSnowflakeEnv("DISCORD_CLIENT_ID"),
    discordGuildId: requiredDiscordSnowflakeEnv("DISCORD_GUILD_ID")
  };
}

function validateRuntimeConfig(config, discordToken, duneApiToken) {
  const url = new URL(config.duneConsoleApiUrl);
  if (!/^https?:$/.test(url.protocol)) throw new Error("DUNE_CONSOLE_API_URL must use http or https.");
  if (!looksLikeDiscordBotToken(discordToken)) throw new Error("DISCORD_BOT_TOKEN_FILE does not contain a Discord bot token-shaped value.");
  if (!duneApiToken || duneApiToken.length < 12) throw new Error("DUNE_BOT_API_TOKEN_FILE is empty or too short.");
}

function requiredDiscordSnowflakeEnv(name) {
  const value = requiredEnv(name);
  if (!/^\d{15,25}$/.test(value)) {
    throw new Error(`${name} must be a numeric Discord ID. Replace the placeholder value with the real ID from Discord.`);
  }
  return value;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  if (/^your-|^role-/i.test(value)) throw new Error(`${name} is still a placeholder: ${value}`);
  return value;
}

function readSecret(path, name) {
  if (/^your-|^role-/i.test(path)) throw new Error(`${name} points to a placeholder path: ${path}`);
  if (!existsSync(path)) throw new Error(`${name} file does not exist: ${path}`);
  return readFileSync(path, "utf8").trim();
}

function looksLikeDiscordBotToken(value) {
  return /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}$/.test(value);
}

function safeErrorMessage(error) {
  return String(error?.message || error || "Unknown error").replace(/(Bot|Bearer)\s+\S+/g, "$1 [REDACTED]");
}
