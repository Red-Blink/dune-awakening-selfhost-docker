import { readFileSync } from "node:fs";
import type { BotConfig } from "./config.js";
import type { DiscordActorContext } from "./security/authorization.js";

export type ConsoleRoute = "status" | "readiness" | "services";

export type ConsoleCommandPayload = {
  actor: DiscordActorContext;
  diagnostic?: boolean;
};

export type ConsoleResponse = {
  ok: boolean;
  result?: unknown;
  code?: string;
  error?: string;
};

const ROUTES: Record<ConsoleRoute, string> = {
  status: "/api/integrations/discord/status",
  readiness: "/api/integrations/discord/readiness",
  services: "/api/integrations/discord/services"
};

export async function callConsoleRoute(config: BotConfig, route: ConsoleRoute, payload: ConsoleCommandPayload): Promise<ConsoleResponse> {
  const apiToken = readFileSync(config.duneBotApiTokenFile, "utf8").trim();
  const url = new URL(ROUTES[route], config.duneConsoleApiUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({ ok: false, code: "invalid_response", error: "Console returned a non-JSON response." }));
  if (!response.ok) return body as ConsoleResponse;
  return body as ConsoleResponse;
}

export async function getConsoleHealth(config: BotConfig): Promise<ConsoleResponse> {
  const apiToken = readFileSync(config.duneBotApiTokenFile, "utf8").trim();
  const url = new URL("/api/integrations/discord/health", config.duneConsoleApiUrl);
  const response = await fetch(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${apiToken}`
    }
  });
  const body = await response.json().catch(() => ({ ok: false, code: "invalid_response", error: "Console returned a non-JSON response." }));
  return body as ConsoleResponse;
}
