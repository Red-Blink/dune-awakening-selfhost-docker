import { intParam } from "./db.js";
import { isFiefClaimPlaceable, partitionFiefClaimPlaceables } from "./blueprintSafety.js";

const BLUEPRINT_IMPORT_BATCH_SIZE = 50;

const STRUCTURAL_BUILDING_TYPES = new Set([
  "Atreides_Outpost_Column",
  "Atreides_Outpost_Column_Corner",
  "Atreides_Outpost_Foundation",
  "Atreides_Outpost_Foundation_Round_Corner",
  "Atreides_Outpost_Foundation_Wedge",
  "Atreides_Outpost_Pillar_Bottom",
  "Atreides_Outpost_Pillar_Middle",
  "Atreides_Outpost_Pillar_Top",
  "Choam_Level2_Column",
  "Choam_Level2_Foundation",
  "Choam_Level2_Pillar_Bottom",
  "Choam_Shelter_Column_Corner_New",
  "Choam_Shelter_Column_New",
  "Harkonnen_Outpost_Column",
  "Harkonnen_Outpost_Foundation",
  "MTX_Neut_DesertMechanic_Center_Column",
  "MTX_Neut_DesertMechanic_Corner_Column",
  "MTX_Neut_DesertMechanic_Foundation",
  "MTX_Neut_DesertMechanic_Foundation_Wedge",
  "MTX_Neut_Gunner_Foundation",
  "MTX_Smug_Foundation",
  "MTX_Smug_Foundation_Full",
  "MTX_Smug_Foundation_Half",
  "MTX_Smug_Foundation_Quarter",
  "MTX_Smug_Foundation_Round_Corner",
  "MTX_Smug_Foundation_Wedge",
  "MTX_Smug_Pillar_Bottom",
  "MTX_Smug_Pillar_Middle",
  "MTX_Smug_Pillar_Top",
  "MTX_Smug_Column",
  "MTX_Smug_Corner_Column",
  "Watershippers_Foundation",
  "Watershippers_Foundation_Round_Corner",
  "Watershippers_Pillar_Bottom",
  "Watershippers_Pillar_Middle",
  "Watershippers_Pillar_Top",
  "Atre_Foundation_Full",
  "Hark_Foundation_Full",
  "Choam_Foundation_Full"
]);

function isStructuralBuilding(buildingType) {
  return STRUCTURAL_BUILDING_TYPES.has(buildingType);
}

function blueprintItemStatsJSON(blueprintId, name) {
  const nameJson = name ? `,"BuildingBlueprintName":${JSON.stringify(name)}` : "";
  return `{"FCustomizationStats":[[],{}],"FBuildingBlueprintItemStats":[[],{"PlayerBlueprintId":"!!bbp#${blueprintId}"${nameJson},"PlayerBaseBackupId":{}}],"FItemStackAndDurabilityStats":[[],{"DecayedMaxDurability":0.0}]}`;
}

export async function blueprintCapabilities(db) {
  const tables = ["building_blueprints", "building_blueprint_instances", "building_blueprint_placeables", "building_blueprint_pentashields", "items", "inventories"];
  const allExist = await Promise.all(tables.map((t) => tableExistsGeneric(db, t)));
  return allExist.every(Boolean);
}

async function tableExistsGeneric(db, name) {
  try {
    const r = await db.query("select to_regclass($1) is not null as exists", [`dune.${name}`]);
    return Boolean(r.rows[0]?.exists);
  } catch {
    return false;
  }
}

function requireBlueprintCapability(ok, msg = "Blueprint operations require dune.building_blueprint tables") {
  if (!ok) {
    const err = new Error(msg);
    err.unsupported = true;
    throw err;
  }
}

async function ensureOfflinePlayer(db, playerPawnId) {
  const row = await db.query(`
    select coalesce(online_status::text, 'Offline') as status
    from dune.player_state
    where player_pawn_id = $1
    limit 1`, [playerPawnId]);
  if (!row.rows[0]) throw new Error(`Player pawn ${playerPawnId} not found`);
  if (String(row.rows[0].status).toLowerCase() === "online") {
    return { online: true, warning: "Player is online — a relog is required to see the imported blueprint." };
  }
  return { online: false, warning: "" };
}

function resolveImportInstance(inst) {
  // Console imports used ordinary PostgreSQL arrays before v1.4.26 and were
  // verified in game. Keep that import contract: the game-side copy path is
  // distinct from native rows and preserves the caller's declared bounds.
  const transform = `{${inst.x},${inst.y},${inst.z},${inst.rotation}}`;
  const stability = inst.provides_stability != null ? inst.provides_stability : isStructuralBuilding(inst.building_type);
  return { transform, stability };
}

function resolveImportPlaceable(pl) {
  // The game applies the three rotation slots as Pitch, Yaw, Roll when it
  // projects the Solido. A heading in the first slot tilts the equipment.
  const transform = `{${pl.x},${pl.y},${pl.z},${pl.rx ?? 0},${pl.ry ?? 0},${pl.rz ?? 0}}`;
  return { transform };
}

function normalizeLegacyPlaceableRotations(placeables) {
  if (!Array.isArray(placeables) || placeables.length === 0) return placeables;

  const nearZero = (value) => Math.abs(Number(value) || 0) < 0.0001;
  // Live-base exports produced before the placeable-axis fix put every yaw in
  // rz while forcing rx/ry to zero. Native Solido archives store horizontal
  // placeable rotation in ry; preserve any archive that contains meaningful
  // rx/ry data instead of guessing per row.
  const legacyAxisLayout = placeables.every((pl) => nearZero(pl?.rx) && nearZero(pl?.ry))
    && placeables.some((pl) => !nearZero(pl?.rz));
  if (!legacyAxisLayout) return placeables;

  return placeables.map((pl) => ({ ...pl, ry: pl.rz ?? 0, rz: 0 }));
}

function optionalNonnegativeInteger(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function resolveImportIds(rows, key, label) {
  const sourceIds = rows.map((row) => {
    return optionalNonnegativeInteger(row[key]);
  });
  const offset = sourceIds.includes(0) ? 1 : 0;
  const reserved = new Set();
  const sourceToId = new Map();

  for (const sourceId of sourceIds) {
    if (sourceId == null) continue;
    const resolvedId = sourceId + offset;
    if (reserved.has(resolvedId)) throw new Error(`Blueprint contains duplicate ${label} ID ${sourceId}`);
    reserved.add(resolvedId);
    sourceToId.set(sourceId, resolvedId);
  }

  let nextId = 1;
  const ids = sourceIds.map((sourceId) => {
    if (sourceId != null) return sourceId + offset;
    while (reserved.has(nextId)) nextId++;
    const resolvedId = nextId++;
    reserved.add(resolvedId);
    return resolvedId;
  });

  return { ids, sourceToId };
}

async function insertBuildingInstances(tx, blueprintId, instances) {
  const { ids } = resolveImportIds(instances, "instance_id", "instance");
  for (let start = 0; start < instances.length; start += BLUEPRINT_IMPORT_BATCH_SIZE) {
    const batch = instances.slice(start, start + BLUEPRINT_IMPORT_BATCH_SIZE);
    for (let i = 0; i < batch.length; i++) {
      const inst = batch[i];
      const { transform, stability } = resolveImportInstance(inst);
      await tx.query(`
        insert into dune.building_blueprint_instances
          (building_blueprint_id, instance_id, building_type, transform, hologram, provides_stability, health)
        values ($1, $2, $3, $4::real[], true, $5, 0)`,
        [blueprintId, ids[start + i], inst.building_type, transform, stability]
      );
    }
  }
}

async function insertBuildingPlaceables(tx, blueprintId, placeables) {
  const { ids, sourceToId } = resolveImportIds(placeables, "placeable_id", "placeable");
  for (let start = 0; start < placeables.length; start += BLUEPRINT_IMPORT_BATCH_SIZE) {
    const batch = placeables.slice(start, start + BLUEPRINT_IMPORT_BATCH_SIZE);
    for (let i = 0; i < batch.length; i++) {
      const pl = batch[i];
      const { transform } = resolveImportPlaceable(pl);
      await tx.query(`
        insert into dune.building_blueprint_placeables
          (building_blueprint_id, placeable_id, building_type, transform, hologram)
        values ($1, $2, $3, $4::real[], true)`,
        [blueprintId, ids[start + i], pl.building_type, transform]
      );
    }
  }
  return sourceToId;
}

async function ensurePlaceableRotationTable(tx) {
  // Keep provenance separate from Funcom's Solido item and geometry records.
  // The lock serializes creation if the first imports run concurrently.
  if (!(await tableExistsGeneric(tx, "console_blueprint_pitch_first"))) {
    await tx.query("select pg_advisory_xact_lock(hashtext('dune.console_blueprint_pitch_first'))");
    await tx.query(`
      create table if not exists dune.console_blueprint_pitch_first (
        blueprint_id bigint primary key,
        item_id bigint not null
      )`);
  }
}

async function insertBuildingPentashields(tx, blueprintId, pentashields, placeableIdMap = new Map()) {
  for (const ps of pentashields) {
    const s = ps.scale;
    if (!Array.isArray(s) || s.length < 3) continue;
    const sourcePlaceableId = Number(ps.placeable_id);
    const placeableId = placeableIdMap.get(sourcePlaceableId) ?? (Number.isInteger(sourcePlaceableId) ? sourcePlaceableId : 0);
    await tx.query(`
      insert into dune.building_blueprint_pentashields
        (building_blueprint_id, placeable_id, scale)
      values ($1, $2, ARRAY[$3,$4,$5]::smallint[])`,
      [blueprintId, placeableId, s[0], s[1], s[2]]
    );
  }
}

export async function importBlueprint(db, playerPawnId, blueprintFile, fallbackName = "") {
  const capable = await blueprintCapabilities(db);
  requireBlueprintCapability(capable);

  const { online, warning } = await ensureOfflinePlayer(db, playerPawnId);

  const bf = blueprintFile;
  const bfName = fallbackName.replace(/\.json$/i, "").replace(/[_\.]/g, " ").trim().replace(/\s+/g, " ") || null;
  const rawName = bf.name || bf.Name || bf.blueprint_name || bfName || (bf.instances && bf.instances[0]?.building_type) || "Imported Blueprint";
  let blueprintName = String(rawName).replace(/[_\.\\]/g, " ").trim().replace(/\s+/g, " ");

  if (!Array.isArray(bf.instances) && !Array.isArray(bf.placeables) && !Array.isArray(bf.pentashields)) {
    throw new Error("Blueprint must be an object with instances, placeables, or pentashields array");
  }
  const instances = Array.isArray(bf.instances) ? bf.instances : [];
  const inputPlaceables = Array.isArray(bf.placeables) ? bf.placeables : [];
  const { safe: placeables, removed: removedClaimConsoles } = partitionFiefClaimPlaceables(inputPlaceables);
  const removedPlaceableIds = new Set(removedClaimConsoles
    .map((placeable) => optionalNonnegativeInteger(placeable?.placeable_id))
    .filter((id) => id != null));
  const inputPentashields = Array.isArray(bf.pentashields) ? bf.pentashields : [];
  // A pentashield row references a blueprint placeable id. If an unsafe claim
  // console carried one, do not leave an orphaned shield row pointing at the
  // removed console (or, worse, at a different remapped placeable).
  const pentashields = inputPentashields.filter((pentashield) => {
    const placeableId = optionalNonnegativeInteger(pentashield?.placeable_id);
    return placeableId == null || !removedPlaceableIds.has(placeableId);
  });
  const removedPentashields = inputPentashields.length - pentashields.length;
  const hasInstances = instances.length > 0;
  const hasPlaceables = placeables.length > 0;
  const hasPentashields = pentashields.length > 0;
  if (!hasInstances && !hasPlaceables && !hasPentashields) {
    if (removedClaimConsoles.length > 0) {
      throw new Error("Blueprint contains only a Sub-Fief claim console, which cannot be imported as Solido content");
    }
    throw new Error("Blueprint has no instances, placeables, or pentashields");
  }

  const safetyWarning = removedClaimConsoles.length > 0
    ? `Removed ${removedClaimConsoles.length} Sub-Fief claim console${removedClaimConsoles.length === 1 ? "" : "s"} from the blueprint for safety.${removedPentashields ? ` Removed ${removedPentashields} linked pentashield row${removedPentashields === 1 ? "" : "s"}.` : ""}`
    : "";
  const warnings = [online ? warning : "", safetyWarning].filter(Boolean);
  const combinedWarning = warnings.join(" ");

  return db.transaction(async (tx) => {
    if (hasPlaceables) await ensurePlaceableRotationTable(tx);
    const baseName = blueprintName.replace(/\s*\(\d+\)\s*$/, " ").trim();
    let candidate = baseName;
    let dedupeIdx = 1;
    while (true) {
      const existing = await tx.query(
        `select 1 from dune.items i
         join dune.building_blueprints bb on bb.item_id = i.id
         where bb.player_id = $1
           and i.stats->'FBuildingBlueprintItemStats'->1->>'BuildingBlueprintName' = $2
         limit 1`,
        [playerPawnId, candidate]
      );
      if (!existing.rows[0]) break;
      dedupeIdx++;
      candidate = `${baseName} (${dedupeIdx})`;
    }
    blueprintName = candidate;

    const invRow = await tx.query(`
      select id, max_item_count, max_item_volume from dune.inventories
      where actor_id = $1 and inventory_type = 0
      order by id limit 1
      for update`, [playerPawnId]);
    if (!invRow.rows[0]) throw new Error(`Inventory not found for player pawn ${playerPawnId}`);

    const invId = invRow.rows[0].id;
    const maxSlots = Number(invRow.rows[0].max_item_count) || 40;

    const usageRow = await tx.query(`
      select count(*)::int as cnt from dune.items where inventory_id = $1`, [invId]);
    const usedSlots = usageRow.rows[0]?.cnt ?? 0;

    if (usedSlots >= maxSlots) {
      throw new Error(`Inventory full (${usedSlots}/${maxSlots} slots). Cannot import blueprint.`);
    }

    const posRow = await tx.query(`
      select coalesce(max(position_index), -1) + 1 as next_pos
      from dune.items where inventory_id = $1`, [invId]);
    const nextPos = Number(posRow.rows[0]?.next_pos ?? 0);

    const itemRow = await tx.query(`
      insert into dune.items
        (inventory_id, stack_size, position_index, template_id, quality_level, stats)
      values ($1, 1, $2, 'BuildingBlueprint_CopyDevice', 0, $3::jsonb)
      returning id`,
      [invId, nextPos, blueprintItemStatsJSON(0, blueprintName)]
    );
    const itemId = itemRow.rows[0].id;

    const bpRow = await tx.query(`
      insert into dune.building_blueprints (item_id, player_id, building_blueprint_map)
      values ($1, $2, '')
      returning id`, [itemId, playerPawnId]);
    const blueprintId = bpRow.rows[0].id;

    await tx.query("update dune.items set stats = $1::jsonb where id = $2",
      [blueprintItemStatsJSON(blueprintId, blueprintName), itemId]);

    if (instances.length > 0) {
      await insertBuildingInstances(tx, blueprintId, instances);
    }
    let placeableIdMap = new Map();
    if (placeables.length > 0) {
      const normalizedPlaceables = bf.designer?.placeableRotationConvention === "native-yaw-y"
        ? placeables
        : normalizeLegacyPlaceableRotations(placeables);
      placeableIdMap = await insertBuildingPlaceables(tx, blueprintId, normalizedPlaceables);
      await tx.query(`
        insert into dune.console_blueprint_pitch_first (blueprint_id, item_id) values ($1, $2)
        on conflict (blueprint_id) do update set item_id = excluded.item_id`, [blueprintId, itemId]);
    }
    if (pentashields.length > 0) {
      await insertBuildingPentashields(tx, blueprintId, pentashields, placeableIdMap);
    }

    return {
      ok: true,
      online,
      warning: combinedWarning || undefined,
      message: `Imported ${instances.length} pieces + ${placeables.length} placeables + ${pentashields.length} pentashields -> ${blueprintName} (#${blueprintId}, item ${itemId}) in player inventory${combinedWarning ? " " + combinedWarning : ""}`,
      blueprintName,
      blueprintId,
      itemId,
      pieces: instances.length,
      placeables: placeables.length,
      pentashields: pentashields.length,
      removedClaimConsoles: removedClaimConsoles.length,
      removedPentashields
    };
  });
}

export async function exportBlueprint(db, blueprintId) {
  const capable = await blueprintCapabilities(db);
  requireBlueprintCapability(capable);

  const nameRow = await db.query(`
    select bb.item_id, coalesce(i.stats->'FBuildingBlueprintItemStats'->1->>'BuildingBlueprintName', '') as name
    from dune.building_blueprints bb
    join dune.items i on i.id = bb.item_id
    where bb.id = $1`, [blueprintId]);
  const name = nameRow.rows[0]?.name || "";
  const itemId = nameRow.rows[0]?.item_id;
  const pitchFirst = itemId != null
    && await tableExistsGeneric(db, "console_blueprint_pitch_first")
    && Boolean((await db.query(
      "select 1 from dune.console_blueprint_pitch_first where blueprint_id = $1 and item_id = $2", [blueprintId, itemId]
    )).rows[0]);

  const instRows = await db.query(`
    select instance_id, building_type, transform, provides_stability
    from dune.building_blueprint_instances
    where building_blueprint_id = $1
    order by instance_id`, [blueprintId]);

  const instances = instRows.rows.map((row) => {
    const t = row.transform || [];
    return {
      instance_id: row.instance_id,
      building_type: row.building_type,
      x: t[0] || 0,
      y: t[1] || 0,
      z: t[2] || 0,
      rotation: t[3] || 0,
      provides_stability: row.provides_stability
    };
  });

  const placRows = await db.query(`
    select placeable_id, building_type, transform
    from dune.building_blueprint_placeables
    where building_blueprint_id = $1
    order by placeable_id`, [blueprintId]);

  const removedClaimPlaceableIds = new Set(placRows.rows
    .filter((row) => isFiefClaimPlaceable(row.building_type))
    .map((row) => optionalNonnegativeInteger(row.placeable_id))
    .filter((id) => id != null));
  const placeables = placRows.rows.filter((row) => !isFiefClaimPlaceable(row.building_type)).map((row) => {
    const t = row.transform || [];
    return {
      placeable_id: row.placeable_id,
      building_type: row.building_type,
      x: t[0] || 0,
      y: t[1] || 0,
      z: t[2] || 0,
      rx: t[pitchFirst ? 3 : 4] || 0,
      ry: t[pitchFirst ? 4 : 3] || 0,
      rz: t[5] || 0
    };
  });

  const pentashieldRows = await db.query(`
    select placeable_id, scale
    from dune.building_blueprint_pentashields
    where building_blueprint_id = $1
    order by placeable_id`, [blueprintId]);

  const pentashields = pentashieldRows.rows.filter((row) => {
    const placeableId = optionalNonnegativeInteger(row.placeable_id);
    return placeableId == null || !removedClaimPlaceableIds.has(placeableId);
  }).map((row) => {
    const s = row.scale || [];
    return {
      placeable_id: row.placeable_id,
      scale: [s[0] || 0, s[1] || 0, s[2] || 0]
    };
  });

  return {
    name,
    designer: { coordinateConvention: "game-v1", placeableRotationConvention: "native-yaw-y" },
    instances,
    placeables,
    pentashields: pentashields.length > 0 ? pentashields : undefined
  };
}

export async function listBlueprints(db) {
  const capable = await blueprintCapabilities(db);
  requireBlueprintCapability(capable);

  const rows = await db.query(`
    select bb.id,
           coalesce(bb.player_id::text, '') as owner_id,
           coalesce(ps.character_name, '') as owner_name,
           coalesce(bb.item_id, 0) as item_id,
           coalesce(inst.cnt, 0) as pieces,
           coalesce(plac.cnt, 0) as placeables,
           coalesce(i.stats->'FBuildingBlueprintItemStats'->1->>'BuildingBlueprintName', '') as name
    from dune.building_blueprints bb
    left join dune.items i on i.id = bb.item_id
    left join lateral (
      select count(*) as cnt from dune.building_blueprint_instances
      where building_blueprint_id = bb.id
    ) inst on true
    left join lateral (
      select count(*) as cnt from dune.building_blueprint_placeables
      where building_blueprint_id = bb.id
    ) plac on true
    left join dune.player_state ps on ps.player_pawn_id = bb.player_id
    order by bb.id desc`, []);
  return rows.rows;
}

export async function deleteBlueprint(db, blueprintId) {
  const capable = await blueprintCapabilities(db);
  requireBlueprintCapability(capable);

  return db.transaction(async (tx) => {
    const bpRow = await tx.query("select item_id from dune.building_blueprints where id = $1 for update", [blueprintId]);
    if (!bpRow.rows[0]) return { ok: false, error: "Blueprint not found" };

    const itemId = bpRow.rows[0].item_id;

    if (await tableExistsGeneric(tx, "console_blueprint_pitch_first")) {
      await tx.query("delete from dune.console_blueprint_pitch_first where blueprint_id = $1 and item_id = $2", [blueprintId, itemId]);
    }
    await tx.query("delete from dune.building_blueprint_pentashields where building_blueprint_id = $1", [blueprintId]);
    await tx.query("delete from dune.building_blueprint_placeables where building_blueprint_id = $1", [blueprintId]);
    await tx.query("delete from dune.building_blueprint_instances where building_blueprint_id = $1", [blueprintId]);
    await tx.query("delete from dune.building_blueprints where id = $1", [blueprintId]);

    if (itemId) {
      await tx.query("delete from dune.items where id = $1", [itemId]);
    }

    return { ok: true };
  });
}
