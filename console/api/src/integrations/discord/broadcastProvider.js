// Broadcast Provider — sends in-game messages via dune CLI.
// Wraps dune admin broadcast-restart-warning for now; extendable
// to full message broadcast when game server integration supports it.

import { buildDuneArgs, runDune } from "../../runner.js";
import { sanitizeDiscordValue } from "./sanitize.js";

export async function broadcastProvider(config, { message } = {}) {
  if (!message) {
    return { ok: false, error: "Broadcast message is required." };
  }

  try {
    // Use the admin-broadcast operation
    const args = ["admin", "broadcast-restart-warning", String(message).slice(0, 100)];
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
