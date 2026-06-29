const INVENTORY_UNCHANGED_RE = /inventory stack did not increase/i;

export function liveItemGrantWarning(result = {}) {
  const stderr = String(result.stderr || "");
  if (INVENTORY_UNCHANGED_RE.test(stderr)) {
    return "Published to RabbitMQ, but the player's inventory did not change. The game server may have rejected the item.";
  }
  return "";
}

export function liveItemGrantOk(result = {}) {
  return Number(result.code || 0) === 0 && !liveItemGrantWarning(result);
}
