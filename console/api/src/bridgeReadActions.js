// Bridge actions that only read. Single source of truth for two decisions that
// must agree: audit.js may batch the audit row of one of these, and server.js
// lets concurrent identical calls share one database round trip. Every other
// action (including any new one) takes the safe path: a synchronous audit row
// and a fresh in-flight generation. Add an action here only if it cannot change
// state.
export const READ_ONLY_BRIDGE_ACTIONS = new Set([
  "leadership.players.list",
  "players.summary.list",
  "players.identity.list",
  "players.progression.get",
  "addon.storage.get",
  "addon.storage.list",
  "rewards.status",
  "rewards.list",
  "players.message.status",
  "players.message.list",
  "server.hardware.status",
  "ops.health.summary",
  "ops.health.players",
  "ops.health.farms",
  "ops.health.summary.v2",
  "ops.health.containers",
  "ops.activity.summary",
  "ops.resources.summary",
  "ops.combat.deaths",
  "ops.economy.summary",
  "realtime.health",
  "realtime.objects"
]);

// True when the bridge call may change state, so concurrent read sharing must
// not carry a read that started before it over to requests that arrive after.
export function bridgeActionStartsNewGeneration(action) {
  return !READ_ONLY_BRIDGE_ACTIONS.has(action);
}
