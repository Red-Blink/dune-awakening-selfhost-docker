import { intParam } from "./db.js";

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
  return `{"FCustomizationStats":[[],{}],"FBuildingBlueprintItemStats":[[],{"PlayerBlueprintId":"!!bbp#${blueprintId}"${nameJson}}],"FItemStackAndDurabilityStats":[[],{"DecayedMaxDurability":0.0}]}`;
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
    throw new Error("Blueprint import requires the player to be offline so live state cannot overwrite the DB change");
  }
}

function resolveImportInstance(inst) {
  const transform = `{${inst.x},${inst.y},${inst.z},${inst.rotation}}`;
  const instanceId = inst.instance_id != null ? inst.instance_id : 0;
  const stability = inst.provides_stability != null ? inst.provides_stability : isStructuralBuilding(inst.building_type);
  return { instanceId, transform, stability };
}

function resolveImportPlaceable(pl) {
  const transform = `{${pl.x},${pl.y},${pl.z},${pl.rx ?? 0},${pl.ry ?? 0},${pl.rz ?? 0}}`;
  const placeableId = pl.placeable_id != null ? pl.placeable_id : 0;
  return { placeableId, transform };
}

async function insertBuildingInstances(tx, blueprintId, instances) {
  for (let start = 0; start < instances.length; start += BLUEPRINT_IMPORT_BATCH_SIZE) {
    const batch = instances.slice(start, start + BLUEPRINT_IMPORT_BATCH_SIZE);
    for (let i = 0; i < batch.length; i++) {
      const inst = batch[i];
      const { instanceId, transform, stability } = resolveImportInstance(inst);
      await tx.query(`
        insert into dune.building_blueprint_instances
          (building_blueprint_id, instance_id, building_type, transform, hologram, provides_stability, health)
        values ($1, $2, $3, $4::real[], true, $5, 0)`,
        [blueprintId, instanceId > 0 ? instanceId : start + i + 1, inst.building_type, transform, stability]
      );
    }
  }
}

async function insertBuildingPlaceables(tx, blueprintId, placeables) {
  for (let start = 0; start < placeables.length; start += BLUEPRINT_IMPORT_BATCH_SIZE) {
    const batch = placeables.slice(start, start + BLUEPRINT_IMPORT_BATCH_SIZE);
    for (let i = 0; i < batch.length; i++) {
      const pl = batch[i];
      const { placeableId, transform } = resolveImportPlaceable(pl);
      await tx.query(`
        insert into dune.building_blueprint_placeables
          (building_blueprint_id, placeable_id, building_type, transform, hologram)
        values ($1, $2, $3, $4::real[], true)`,
        [blueprintId, placeableId > 0 ? placeableId : start + i + 1, pl.building_type, transform]
      );
    }
  }
}

async function insertBuildingPentashields(tx, blueprintId, pentashields) {
  for (const ps of pentashields) {
    const s = ps.scale;
    if (!Array.isArray(s) || s.length < 3) continue;
    await tx.query(`
      insert into dune.building_blueprint_pentashields
        (building_blueprint_id, placeable_id, scale)
      values ($1, $2, ARRAY[$3,$4,$5]::smallint[])`,
      [blueprintId, ps.placeable_id ?? 0, s[0], s[1], s[2]]
    );
  }
}

export async function importBlueprint(db, playerPawnId, blueprintFile) {
  const capable = await blueprintCapabilities(db);
  requireBlueprintCapability(capable);

  await ensureOfflinePlayer(db, playerPawnId);

  const bf = blueprintFile;
  if (!Array.isArray(bf.instances) && !Array.isArray(bf.placeables) && !Array.isArray(bf.pentashields)) {
    throw new Error("Blueprint must be an object with instances, placeables, or pentashields array");
  }
  const hasInstances = Array.isArray(bf.instances) && bf.instances.length > 0;
  const hasPlaceables = Array.isArray(bf.placeables) && bf.placeables.length > 0;
  const hasPentashields = Array.isArray(bf.pentashields) && bf.pentashields.length > 0;
  if (!hasInstances && !hasPlaceables && !hasPentashields) {
    throw new Error("Blueprint has no instances, placeables, or pentashields");
  }

  return db.transaction(async (tx) => {
    const invRow = await tx.query(`
      select id from dune.inventories
      where actor_id = $1 and inventory_type = 0
      order by id limit 1
      for update`, [playerPawnId]);
    if (!invRow.rows[0]) throw new Error(`Inventory not found for player pawn ${playerPawnId}`);

    const invId = invRow.rows[0].id;

    const posRow = await tx.query(`
      select coalesce(max(position_index), -1) + 1 as next_pos
      from dune.items where inventory_id = $1`, [invId]);
    const nextPos = Number(posRow.rows[0]?.next_pos ?? 0);

    const itemRow = await tx.query(`
      insert into dune.items
        (inventory_id, stack_size, position_index, template_id, quality_level, stats)
      values ($1, 1, $2, 'BuildingBlueprint_CopyDevice', 0, $3::jsonb)
      returning id`,
      [invId, nextPos, blueprintItemStatsJSON(0, bf.name)]
    );
    const itemId = itemRow.rows[0].id;

    const bpRow = await tx.query(`
      insert into dune.building_blueprints (item_id, player_id, building_blueprint_map)
      values ($1, null, '')
      returning id`, [itemId]);
    const blueprintId = bpRow.rows[0].id;

    await tx.query("update dune.items set stats = $1::jsonb where id = $2",
      [blueprintItemStatsJSON(blueprintId, bf.name), itemId]);

    if (bf.instances && bf.instances.length > 0) {
      await insertBuildingInstances(tx, blueprintId, bf.instances);
    }
    if (bf.placeables && bf.placeables.length > 0) {
      await insertBuildingPlaceables(tx, blueprintId, bf.placeables);
    }
    if (bf.pentashields && bf.pentashields.length > 0) {
      await insertBuildingPentashields(tx, blueprintId, bf.pentashields);
    }

    return {
      ok: true,
      message: `Imported ${bf.instances?.length || 0} pieces + ${bf.placeables?.length || 0} placeables + ${bf.pentashields?.length || 0} pentashields -> blueprint #${blueprintId} (item ${itemId}) in player inventory`,
      blueprintId,
      itemId,
      pieces: bf.instances?.length || 0,
      placeables: bf.placeables?.length || 0,
      pentashields: bf.pentashields?.length || 0
    };
  });
}

export async function exportBlueprint(db, blueprintId) {
  const capable = await blueprintCapabilities(db);
  requireBlueprintCapability(capable);

  const nameRow = await db.query(`
    select coalesce(i.stats->'FBuildingBlueprintItemStats'->1->>'BuildingBlueprintName', '') as name
    from dune.building_blueprints bb
    join dune.items i on i.id = bb.item_id
    where bb.id = $1`, [blueprintId]);
  const name = nameRow.rows[0]?.name || "";

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

  const placeables = placRows.rows.map((row) => {
    const t = row.transform || [];
    return {
      placeable_id: row.placeable_id,
      building_type: row.building_type,
      x: t[0] || 0,
      y: t[1] || 0,
      z: t[2] || 0,
      rx: t[3] || 0,
      ry: t[4] || 0,
      rz: t[5] || 0
    };
  });

  const pentashieldRows = await db.query(`
    select placeable_id, scale
    from dune.building_blueprint_pentashields
    where building_blueprint_id = $1
    order by placeable_id`, [blueprintId]);

  const pentashields = pentashieldRows.rows.map((row) => {
    const s = row.scale || [];
    return {
      placeable_id: row.placeable_id,
      scale: [s[0] || 0, s[1] || 0, s[2] || 0]
    };
  });

  return {
    name,
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
