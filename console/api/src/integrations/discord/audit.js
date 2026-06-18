import { redactValue } from "../../redact.js";

export const DISCORD_AUDIT_EVIDENCE_MARKER = "audit event";

export function discordAuditEvent({ actor, action, capability, risk = "low", targetType = "none", targetId = "", confirmationRequired = false, confirmationPassed = false, result = "unknown", detail = {} } = {}) {
  return redactValue({
    source: "discord",
    discordGuildId: actor?.guildId || "",
    discordChannelId: actor?.channelId || "",
    discordUserId: actor?.userId || "",
    discordUsername: actor?.username || "",
    command: actor?.commandName || "",
    action: String(action || ""),
    capability: String(capability || ""),
    risk: String(risk || "low"),
    targetType: String(targetType || "none"),
    targetId: String(targetId || ""),
    confirmationRequired: Boolean(confirmationRequired),
    confirmationPassed: Boolean(confirmationPassed),
    result: String(result || "unknown"),
    detail
  });
}

export function discordBlockedAuditEvent({ actor, action, capability, reason, detail = {} } = {}) {
  return discordAuditEvent({
    actor,
    action,
    capability,
    risk: "medium",
    result: "blocked",
    detail: {
      reason: String(reason || "blocked"),
      ...detail
    }
  });
}
