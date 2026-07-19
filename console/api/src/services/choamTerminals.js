const TERMINAL_CLASS = "/Game/Dune/Systems/DuneExchange/BP_DuneChoamExchangeTerminal.BP_DuneChoamExchangeTerminal_C";
const TERMINAL_PROPERTIES = {
  DEAccessPointComponent: {
    m_ExchangeName: { Name: "HarkoVillage_EX" },
    m_AccessPointName: { Name: "HarkoVillage_AP" },
    m_AutoAccessRange: 20000,
    m_bAllowLocalFulfillment: false
  }
};

export const CHOAM_TRADE_CENTERS = Object.freeze([
  { key: "griffins-reach", name: "Griffin's Reach", transform: { x: 23821.424411240638, y: 227439.2148393366, z: 8462.150017758495, qx: 0, qy: 0, qz: 0.5438738297278864, qw: -0.8391670020544909 } },
  { key: "the-crossroads", name: "The Crossroads", transform: { x: -218903.32254668314, y: -162639.97934556464, z: 7331.373668714201, qx: 0, qy: 0, qz: 0.745993531027832, qw: 0.6659531902954045 } },
  { key: "pinnacle-station", name: "Pinnacle Station", transform: { x: -32232.274005097282, y: -314295.0529503054, z: 11997.194233616301, qx: 0, qy: 0, qz: 0.6719665312138225, qw: 0.7405815153840007 } },
  { key: "the-anvil", name: "The Anvil", transform: { x: 192342.5200698719, y: 3865.962718766717, z: 13459.1495039061, qx: 0, qy: 0, qz: 0.13209216855893113, qw: 0.9912374382585633 } }
]);

const DUPLICATE_RADIUS = 250;

function serviceError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function centerForKey(value) {
  const key = String(value || "").trim().toLowerCase();
  const center = CHOAM_TRADE_CENTERS.find((entry) => entry.key === key);
  if (!center) throw serviceError("Choose a valid Hagga Basin trade center.");
  return center;
}

async function requiredTablesAvailable(db) {
  const result = await db.query(`
    select to_regclass('dune.actors') is not null as actors,
           to_regclass('dune.inventories') is not null as inventories,
           to_regclass('dune.world_partition') is not null as world_partition`);
  const row = result.rows[0] || {};
  return Boolean(row.actors && row.inventories && row.world_partition);
}

async function trackingTableAvailable(db) {
  const result = await db.query("select to_regclass('dune.admin_choam_terminals') is not null as exists");
  return Boolean(result.rows[0]?.exists);
}

async function ensureTrackingTable(tx) {
  await tx.query(`
    create table if not exists dune.admin_choam_terminals (
      trade_center_key text not null,
      trade_center_name text not null,
      dimension_index integer not null,
      partition_id bigint not null,
      actor_id bigint not null references dune.actors(id) on delete cascade,
      source_player_id bigint,
      created_at timestamptz not null default now(),
      primary key (trade_center_key, dimension_index),
      unique (actor_id)
    )`);
}

async function activeSietches(db) {
  const result = await db.query(`
    select partition_id::text,
           dimension_index::int,
           coalesce(nullif(label, ''), 'Sietch ' || (dimension_index + 1)::text) as label
    from dune.world_partition
    where map = 'Survival_1'
      and coalesce(blocked, false) = false
    order by dimension_index, partition_id`);
  return result.rows;
}

export async function choamTerminalOverview(db) {
  if (!(await requiredTablesAvailable(db))) {
    return { supported: false, reason: "CHOAM terminal placement is unavailable for this database schema.", tradeCenters: CHOAM_TRADE_CENTERS, sietches: [], placements: [] };
  }
  const [sietches, hasTracking] = await Promise.all([
    activeSietches(db),
    trackingTableAvailable(db)
  ]);
  let placements = [];
  if (hasTracking) {
    const result = await db.query(`
      select t.trade_center_key,
             t.trade_center_name,
             t.dimension_index::int,
             t.partition_id::text,
             t.actor_id::text,
             t.source_player_id::text,
             t.created_at::text,
             (a.id is not null) as actor_present
      from dune.admin_choam_terminals t
      left join dune.actors a on a.id = t.actor_id
      order by t.trade_center_name, t.dimension_index`);
    placements = result.rows;
  }
  return { supported: true, tradeCenters: CHOAM_TRADE_CENTERS, sietches, placements };
}

async function nearbyTerminal(tx, partitionId, dimensionIndex, transform) {
  const result = await tx.query(`
    select id::text
    from dune.actors
    where class = $1
      and map = 'HaggaBasin'
      and partition_id = $2::bigint
      and dimension_index = $3::integer
      and transform is not null
      and power(((transform).location).x - $4::float8, 2)
        + power(((transform).location).y - $5::float8, 2)
        + power(((transform).location).z - $6::float8, 2) <= $7::float8
    limit 1`, [TERMINAL_CLASS, partitionId, dimensionIndex, transform.x, transform.y, transform.z, DUPLICATE_RADIUS * DUPLICATE_RADIUS]);
  return result.rows[0]?.id || "";
}

export async function installChoamTerminals(db, { tradeCenterKey } = {}) {
  const center = centerForKey(tradeCenterKey);
  if (!(await requiredTablesAvailable(db))) throw serviceError("CHOAM terminal placement is unavailable for this database schema.", 409);

  return db.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtext('dune-docker-choam-terminals'))");
    await ensureTrackingTable(tx);
    const existingResult = await tx.query(`
      select t.dimension_index::int
      from dune.admin_choam_terminals t
      where t.trade_center_key = $1
      order by t.dimension_index`, [center.key]);
    const installedDimensions = new Set(existingResult.rows.map((row) => Number(row.dimension_index)));
    const transform = center.transform;
    const sietches = await activeSietches(tx);
    if (!sietches.length) throw serviceError("No active Hagga Basin sietches were found.", 409);
    const created = [];
    for (const sietch of sietches) {
      const dimensionIndex = Number(sietch.dimension_index);
      if (installedDimensions.has(dimensionIndex)) continue;
      const nearbyActorId = await nearbyTerminal(tx, sietch.partition_id, dimensionIndex, transform);
      if (nearbyActorId) {
        throw serviceError(`A CHOAM terminal already exists near this position in ${sietch.label}. Remove or move it before installing another.`, 409);
      }
      const actorResult = await tx.query(`
        insert into dune.actors
          (class, map, transform, partition_id, dimension_index, properties, serial)
        values
          ($1, 'HaggaBasin',
           ROW(ROW($2::float8,$3::float8,$4::float8)::dune.vector, ROW($5::float8,$6::float8,$7::float8,$8::float8)::dune.quaternion)::dune.transform,
           $9::bigint, $10::integer, $11::jsonb, 1)
        returning id::text`, [
        TERMINAL_CLASS,
        transform.x, transform.y, transform.z,
        transform.qx, transform.qy, transform.qz, transform.qw,
        sietch.partition_id, dimensionIndex, JSON.stringify(TERMINAL_PROPERTIES)
      ]);
      const terminalActorId = actorResult.rows[0]?.id;
      if (!terminalActorId) throw serviceError("The game database did not return the new terminal actor ID.", 500);
      await tx.query(`
        insert into dune.inventories (actor_id, inventory_type, max_item_count, max_item_volume)
        values ($1::bigint, 0, -1, 0)`, [terminalActorId]);
      await tx.query(`
        insert into dune.admin_choam_terminals
          (trade_center_key, trade_center_name, dimension_index, partition_id, actor_id)
        values ($1, $2, $3::integer, $4::bigint, $5::bigint)`, [
        center.key, center.name, dimensionIndex, sietch.partition_id, terminalActorId
      ]);
      created.push({ dimensionIndex, partitionId: sietch.partition_id, actorId: terminalActorId, label: sietch.label });
    }
    return {
      ok: true,
      tradeCenter: center,
      created,
      unchanged: sietches.length - created.length,
      position: { x: transform.x, y: transform.y, z: transform.z },
      restartRequired: created.length > 0
    };
  });
}

export async function removeChoamTerminals(db, { tradeCenterKey } = {}) {
  const center = centerForKey(tradeCenterKey);
  if (!(await trackingTableAvailable(db))) return { ok: true, tradeCenter: center, removed: 0, restartRequired: false };
  return db.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtext('dune-docker-choam-terminals'))");
    const result = await tx.query(`
      select actor_id::text
      from dune.admin_choam_terminals
      where trade_center_key = $1
      for update`, [center.key]);
    const ids = result.rows.map((row) => row.actor_id).filter(Boolean);
    if (ids.length) await tx.query("delete from dune.actors where id = any($1::bigint[])", [ids]);
    await tx.query("delete from dune.admin_choam_terminals where trade_center_key = $1", [center.key]);
    return { ok: true, tradeCenter: center, removed: ids.length, restartRequired: ids.length > 0 };
  });
}

export const choamTerminalInternals = Object.freeze({
  terminalClass: TERMINAL_CLASS,
  terminalProperties: TERMINAL_PROPERTIES,
  duplicateRadius: DUPLICATE_RADIUS
});
