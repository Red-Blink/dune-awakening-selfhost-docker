import type { BotConfig } from "./config.js";
import { callConsoleRoute, getConsoleHealth } from "./consoleApi.js";
import { redactValue } from "./security/redaction.js";
import { actorTier, requireCapability, type DiscordActorContext, type RoleMapping } from "./security/authorization.js";

export type DuneCommandName = "health" | "status" | "statusDetail" | "readiness" | "services";

export type CommandResult = {
  ephemeral: boolean;
  content: string;
};

export function roleMappingFromConfig(config: BotConfig): RoleMapping {
  return {
    observerRoleIds: config.observerRoleIds,
    moderatorRoleIds: config.moderatorRoleIds,
    adminRoleIds: config.adminRoleIds,
    ownerRoleIds: config.ownerRoleIds
  };
}

export async function handleDuneCommand(config: BotConfig, command: DuneCommandName, actor: DiscordActorContext): Promise<CommandResult> {
  const mapping = roleMappingFromConfig(config);
  const tier = actorTier(actor, mapping);

  if (command === "health") {
    requireCapability(actor, mapping, "status:read");
    const response = await getConsoleHealth(config);
    return { ephemeral: tier !== "public", content: formatJsonBlock("Dune adapter health", response) };
  }

  if (command === "status") {
    requireCapability(actor, mapping, "status:read");
    const response = await callConsoleRoute(config, "status", { actor, diagnostic: false });
    return { ephemeral: false, content: formatJsonBlock("Dune status", response) };
  }

  if (command === "statusDetail") {
    requireCapability(actor, mapping, "logs:read");
    const response = await callConsoleRoute(config, "status", { actor, diagnostic: true });
    return { ephemeral: true, content: formatJsonBlock("Dune detailed status", response) };
  }

  if (command === "readiness") {
    requireCapability(actor, mapping, "readiness:read");
    const response = await callConsoleRoute(config, "readiness", { actor });
    return { ephemeral: tier === "public", content: formatJsonBlock("Dune readiness", response) };
  }

  if (command === "services") {
    requireCapability(actor, mapping, "services:read");
    const response = await callConsoleRoute(config, "services", { actor });
    return { ephemeral: tier === "public", content: formatJsonBlock("Dune services", response) };
  }

  throw new Error(`Unsupported command: ${command}`);
}

export function formatJsonBlock(title: string, value: unknown): string {
  const safe = redactValue(value);
  const body = JSON.stringify(safe, null, 2).slice(0, 1800);
  return `**${title}**\n~~~json\n${body}\n~~~`;
}
