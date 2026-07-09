// Broadcast Provider — sends in-game messages via dune CLI.
// Uses dune admin broadcast for in-game server messages.
// Gate: requires DUNE_DISCORD_WRITES_ENABLED and admin capability.

import { buildDuneArgs, runDune } from "../../runner.js";
import { sanitizeDiscordValue } from "./sanitize.js";

export async function broadcastProvider(config, { message } = {}) {
  if (!message || !String(message).trim()) {
    return { ok: false, error: "Broadcast message is required." };
  }

  try {
    const args = ["admin", "broadcast", String(message).slice(0, 200)];
    const result = await runDune(config, args, {
      timeoutMs: 30000,
      allowedExitCodes: [0]
    });

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
