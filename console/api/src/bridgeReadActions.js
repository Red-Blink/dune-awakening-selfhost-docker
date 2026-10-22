// Bridge actions that only read. audit.js may batch the audit row of one of
// these. Every other action (including any new one) takes the safe path: a
// synchronous audit row. Add an action here only if it cannot change state.
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
  "ops.economy.summary"
]);
