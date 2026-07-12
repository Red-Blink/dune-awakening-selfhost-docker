// Broadcast Provider — sends in-game messages via the console's existing RabbitMQ broadcast path.
// Uses buildBroadcastCommand + publishServerCommand from rmq.js (same path as web console broadcast).
// Gate: requires DUNE_DISCORD_WRITES_ENABLED and admin/owner BROADCAST_SEND capability.

import { buildBroadcastCommand, publishServerCommand } from "../../rmq.js";
import { sanitizeDiscordValue } from "./sanitize.js";

export async function broadcastProvider(config, { message } = {}) {
  if (!message || !String(message).trim()) {
    return { ok: false, error: "Broadcast message is required." };
  }

  try {
    const command = buildBroadcastCommand({
      message: String(message).slice(0, 200),
      title: "Discord Broadcast",
      durationSec: 30
    });

    const result = config.mockMode
      ? { code: 0, stdout: "mock broadcast\n", stderr: "", args: [] }
      : await publishServerCommand(config, command, "discord-broadcast");

    return {
      ok: Number(result.code || 0) === 0,
      result: {
        output: sanitizeDiscordValue(String(result.stdout || "").slice(0, 1000)),
        sent: Number(result.code || 0) === 0
      }
    };
  } catch (error) {
    return {
      ok: false,
      error: sanitizeDiscordValue(error.message || "Broadcast failed.")
    };
  }
}
