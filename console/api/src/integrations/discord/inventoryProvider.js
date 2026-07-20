import {
  playerInventory,
  playerOwnedStorageQuery,
  guildStorageQuery,
  searchItemsInContainers,
  searchItemsInPlayerInventory
} from "../../duneDb.js";

export function groupByMap(items) {
  const map = new Map();
  for (const item of items) {
    const key = item.template_id || item.templateId || "unknown";
    if (!map.has(key)) {
      map.set(key, {
        template_id: key,
        total_count: 0,
        items: []
      });
    }
    const entry = map.get(key);
    entry.total_count += Number(item.stack_size || item.quantity || 1);
    entry.items.push(item);
  }
  return Array.from(map.values());
}

export function groupByContainer(items, containerField = "container_id") {
  const map = new Map();
  for (const item of items) {
    const key = item[containerField] || "unknown";
    if (!map.has(key)) {
      map.set(key, {
        container_id: key,
        container_name: item.container_name || item.name || "",
        item_count: 0,
        items: []
      });
    }
    const entry = map.get(key);
    entry.item_count += 1;
    entry.items.push(item);
  }
  return Array.from(map.values());
}

export async function playerInventoryProvider(db, { playerPawnId, characterName } = {}) {
  const result = await playerInventory(db, playerPawnId);
  const rows = result.rows || [];
  return {
    ok: true,
    characterName: characterName || `Player ${playerPawnId}`,
    capabilities: result.capabilities || {},
    grouped: groupByMap(rows),
    rows,
    count: rows.length
  };
}

export async function playerStorageProvider(db, { playerControllerId, scope = "owned" }) {
  if (scope === "owned") {
    const result = await playerOwnedStorageQuery(db, playerControllerId);
    const rows = result.rows || [];
    return {
      ok: true,
      scope: "owned",
      grouped: groupByContainer(rows, "id"),
      rows,
      count: rows.length
    };
  }
  if (scope === "guild") {
    const result = await guildStorageQuery(db, playerControllerId);
    const rows = result.rows || [];
    return {
      ok: true,
      scope: "guild",
      grouped: groupByContainer(rows, "id"),
      rows,
      count: rows.length
    };
  }
  throw new Error(`Unsupported storage scope: ${scope}. Use "owned" or "guild".`);
}

export async function itemSearchProvider(db, { playerControllerId, query, scope = "owned" }) {
  if (!query || !String(query).trim()) {
    throw new Error("Search query is required.");
  }
  const result = await searchItemsInContainers(db, {
    playerControllerId,
    query: String(query).trim(),
    scope
  });
  const rows = result.rows || [];
  return {
    ok: true,
    scope,
    query,
    grouped: groupByMap(rows),
    rows,
    count: rows.length
  };
}

export async function inventorySearchProvider(db, { playerPawnId, query }) {
  if (!query || !String(query).trim()) {
    throw new Error("Search query is required.");
  }
  const result = await searchItemsInPlayerInventory(db, playerPawnId, String(query).trim());
  const rows = result.rows || [];
  return {
    ok: true,
    query,
    grouped: groupByMap(rows),
    rows,
    count: rows.length
  };
}
