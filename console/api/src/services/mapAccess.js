// Aggregate map responses must respect each underlying resource permission.
// Filtering is per request, after cache reads, so a broader caller's cached
// markers can never be reused as authority for a narrower caller.
export const MAP_LAYER_ACTIONS = Object.freeze({
  player: { action: "players:read", capability: "players" },
  base: { action: "bases:read", capability: "bases" },
  vehicle: { action: "vehicles:read", capability: "vehicles" },
  storage: { action: "storage:read", capability: "storage" },
  service: { action: "server:read", capability: "services" }
});

export function filterMapAccess(payload, can) {
  const capabilities = { ...payload.capabilities };
  const overlays = { ...payload.overlays };
  for (const { action, capability } of Object.values(MAP_LAYER_ACTIONS)) {
    if (!can(action)) {
      capabilities[capability] = false;
      delete overlays[capability];
    }
  }
  return {
    ...payload,
    capabilities,
    ...(payload.overlays ? { overlays } : {}),
    ...(Array.isArray(payload.rows) ? { rows: payload.rows.filter(row => !Object.hasOwn(MAP_LAYER_ACTIONS, row.type) || can(MAP_LAYER_ACTIONS[row.type].action)) } : {})
  };
}
