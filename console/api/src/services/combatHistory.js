// Native death history. The game table has no event ID, so an immutable event
// fingerprint plus its source multiplicity makes repeated scans idempotent
// without collapsing two identical deaths. No game-table trigger or FK.
const SCHEMA_SQL = `
  CREATE SCHEMA IF NOT EXISTS dune_console_combat;
  CREATE TABLE IF NOT EXISTS dune_console_combat.combat_events (
    event_key text NOT NULL, event_ordinal bigint NOT NULL,
    happened_at timestamptz NOT NULL, map text NOT NULL,
    victim_id text NOT NULL, killer_id text, killer_type text NOT NULL,
    classification text NOT NULL,
    victim_name text, killer_name text,
    PRIMARY KEY(event_key,event_ordinal)
  );
  CREATE INDEX IF NOT EXISTS combat_events_time_idx ON dune_console_combat.combat_events(happened_at DESC);
  CREATE INDEX IF NOT EXISTS combat_events_victim_idx ON dune_console_combat.combat_events(victim_id,happened_at DESC);
  CREATE INDEX IF NOT EXISTS combat_events_killer_idx ON dune_console_combat.combat_events(killer_id,happened_at DESC);
  CREATE TABLE IF NOT EXISTS dune_console_combat.combat_recorder_state (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    started_at timestamptz NOT NULL DEFAULT now(), last_capture timestamptz,
    history_from timestamptz, captured_events bigint NOT NULL DEFAULT 0
  );
  INSERT INTO dune_console_combat.combat_recorder_state(singleton) VALUES(true) ON CONFLICT DO NOTHING;`;

const CAPTURE_SQL = `
  WITH raw AS (
    SELECT encode(sha256(convert_to(jsonb_build_array(
             e.actor_id::text,extract(epoch FROM e.universe_time),e.map,e.partition_id,e.event_type,e.custom_data
           )::text,'UTF8')),'hex') AS event_key,
           e.universe_time AS happened_at,left(coalesce(e.map,''),128) AS map,
           e.actor_id::text AS victim_id,
           substring(e.custom_data->>'m_KillerPlayerId' FROM '^!!act#([1-9][0-9]*)$') AS raw_killer_id,
           left(coalesce(nullif(e.custom_data->>'m_KillerType',''),'Unknown'),64) AS killer_type
    FROM dune.game_events e
    WHERE e.event_type=0 AND e.actor_id IS NOT NULL AND e.universe_time IS NOT NULL
  ), normalized AS (
    SELECT *,CASE WHEN length(raw_killer_id)<19 OR
                    (length(raw_killer_id)=19 AND raw_killer_id COLLATE "C"<='9223372036854775807')
                  THEN raw_killer_id END AS killer_id
    FROM raw
  ), grouped AS (
    SELECT event_key,happened_at,map,victim_id,killer_id,killer_type,count(*) AS copies
    FROM normalized GROUP BY event_key,happened_at,map,victim_id,killer_id,killer_type
  ), players AS MATERIALIZED (
    SELECT DISTINCT ON(player_controller_id) player_controller_id::text AS controller_id,
           left(nullif(character_name,''),256) AS name
    FROM dune.player_state WHERE player_controller_id>0 ORDER BY player_controller_id,id DESC
  )
  INSERT INTO dune_console_combat.combat_events
    (event_key,event_ordinal,happened_at,map,victim_id,killer_id,killer_type,classification,victim_name,killer_name)
  SELECT g.event_key,n.ordinal,g.happened_at,g.map,g.victim_id,g.killer_id,g.killer_type,
         CASE WHEN g.killer_type='Player' AND g.killer_id IS NULL THEN 'unattributed'
              WHEN g.killer_type='Player' AND g.killer_id=g.victim_id THEN 'self'
              WHEN g.killer_type='Player' THEN 'pvp'
              WHEN g.killer_type IN ('Environment','NPC','ShaiHulud','Sandstorm','Quicksand') THEN 'other'
              ELSE 'unknown' END,
         victim.name,killer.name
  FROM grouped g CROSS JOIN LATERAL generate_series(1,g.copies) n(ordinal)
  LEFT JOIN players victim ON victim.controller_id=g.victim_id
  LEFT JOIN players killer ON killer.controller_id=g.killer_id
  ON CONFLICT DO NOTHING`;

const SOURCE_SQL = `SELECT count(*)::integer AS columns
  FROM information_schema.columns WHERE table_schema='dune' AND
  ((table_name='game_events' AND column_name IN ('actor_id','universe_time','map','partition_id','event_type','custom_data'))
   OR (table_name='player_state' AND column_name IN ('id','player_controller_id','character_name')))`;

export function combatScope(requested, ownControllerId = null, selfOnly = false) {
  const value = requested == null || requested === '' ? null : String(requested);
  if (value !== null && (!/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value)>9223372036854775807n)) {
    throw Object.assign(new Error('Choose a valid player.'), { statusCode: 400 });
  }
  if (!selfOnly) return value;
  const own = ownControllerId ? String(ownControllerId) : null;
  if (!own || (value !== null && value !== own)) {
    throw Object.assign(new Error('You can only view your own combat history.'), { statusCode: 403 });
  }
  return own;
}

export function combatRowLimit(value, fallback) {
  if (value == null || value === '') return fallback;
  if (value === 'all') return null;
  if (['10', '20', '50'].includes(String(value))) return Number(value);
  throw Object.assign(new Error('Choose 10, 20, 50 or All rows.'), { statusCode: 400 });
}

export function createCombatHistory(db, { mockMode = false, now = Date.now, intervalMs = 30_000 } = {}) {
  let pending = null;
  let lastAttempt = -Infinity;
  let initialized = false;
  let state = { supported: false, status: 'starting', reason: 'Combat history is starting.' };

  async function capture() {
    if (mockMode) {
      state = { supported: false, status: 'unavailable', reason: 'Combat history needs a game database.' };
      return;
    }
    try {
      const outcome = await db.transaction(async tx => {
        await tx.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='250ms'");
        const lock = await tx.query('SELECT pg_try_advisory_xact_lock(714032,283) AS locked');
        if (!lock.rows[0]?.locked) return;
        const existing = await tx.query(`SELECT to_regclass('dune_console_combat.combat_events') IS NOT NULL
          AND to_regclass('dune_console_combat.combat_recorder_state') IS NOT NULL AS present`);
        if (existing.rows[0]?.present) initialized = true;
        const source = await tx.query(SOURCE_SQL);
        if (Number(source.rows[0]?.columns) !== 9) {
          return { supported: initialized, status: 'unavailable', reason: 'The game database does not provide the required death history.' };
        }
        await tx.query(SCHEMA_SQL);
        const result = await tx.query(CAPTURE_SQL);
        await tx.query(`UPDATE dune_console_combat.combat_recorder_state SET last_capture=now(),
          captured_events=captured_events+$1,
          history_from=(SELECT min(happened_at) FROM dune_console_combat.combat_events)
          WHERE singleton`, [result.rowCount || 0]);
        return { supported: true, status: 'recording', reason: '' };
      });
      if (outcome) { state = outcome; if (outcome.status === 'recording') initialized = true; }
    } catch {
      // Never expose SQL, names or payloads in logs/errors. This independent
      // transaction cannot reject or roll back a game's own transaction.
      state = { supported: initialized, status: 'paused', reason: 'Combat recording is paused. It will retry automatically.' };
    }
  }

  function tick({ force = false } = {}) {
    if (pending) return pending;
    if (!force && now()-lastAttempt<intervalMs) return Promise.resolve();
    lastAttempt = now();
    pending = capture().finally(() => { pending = null; });
    return pending;
  }

  async function read({ controllerId = null, selfOnly = false, leaderboardLimit, killsLimit } = {}) {
    controllerId = combatScope(controllerId, controllerId, selfOnly);
    const playerRows = combatRowLimit(leaderboardLimit, 100);
    const killRows = combatRowLimit(killsLimit, 50);
    const base = { ...state, selfOnly, recordingStartedAt: null, recordedSince: null, lastCapturedAt: null, leaderboard: [], recentKills: [] };
    if (!initialized) return base;
    try {
      return await db.transaction(async tx => {
        await tx.query("SET TRANSACTION READ ONLY; SET LOCAL statement_timeout='5s'");
        const meta = (await tx.query('SELECT started_at,history_from,last_capture FROM dune_console_combat.combat_recorder_state WHERE singleton')).rows[0];
        const stats = await tx.query(`WITH scoped AS (
          SELECT * FROM dune_console_combat.combat_events WHERE $1::text IS NULL OR victim_id=$1 OR killer_id=$1
        ), contributions AS (
          SELECT victim_id AS player_id,victim_name AS name,0 AS kills,
                 (classification='pvp')::integer AS deaths,(classification='self')::integer AS self_deaths,
                 (classification='other')::integer AS other_deaths,
                 (classification IN ('unknown','unattributed'))::integer AS unknown_deaths
          FROM scoped
          UNION ALL
          SELECT killer_id,killer_name,1,0,0,0,0 FROM scoped WHERE classification='pvp'
        )
        SELECT player_id AS "controllerId",coalesce(max(name),'Unknown Player') AS name,
               sum(kills)::integer AS kills,sum(deaths)::integer AS deaths,
               sum(self_deaths)::integer AS "selfDeaths",sum(other_deaths)::integer AS "otherDeaths",
               sum(unknown_deaths)::integer AS "unknownDeaths",
               round(sum(kills)::numeric/nullif(sum(deaths),0),2)::double precision AS kd
        FROM contributions WHERE $1::text IS NULL OR player_id=$1
        GROUP BY player_id ORDER BY kills DESC,deaths ASC,player_id LIMIT $2::integer`, [controllerId, playerRows]);
        const recent = await tx.query(`SELECT event_key||':'||event_ordinal::text AS id,
          happened_at AS time,map,killer_id AS "killerId",victim_id AS "victimId",
          coalesce(killer_name,'Unknown Player') AS killer,coalesce(victim_name,'Unknown Player') AS victim
          FROM dune_console_combat.combat_events WHERE classification='pvp'
            AND ($1::text IS NULL OR victim_id=$1 OR killer_id=$1)
          ORDER BY happened_at DESC,event_key,event_ordinal DESC LIMIT $2::integer`, [controllerId, killRows]);
        return { ...base, recordingStartedAt: meta?.started_at || null,
          recordedSince: meta?.history_from || null, lastCapturedAt: meta?.last_capture || null,
          leaderboard: stats.rows, recentKills: recent.rows.map(row => selfOnly ? {
            ...row, killerId: row.killerId===controllerId ? row.killerId : null,
            victimId: row.victimId===controllerId ? row.victimId : null,
            killer: row.killerId===controllerId ? row.killer : 'Another Player',
            victim: row.victimId===controllerId ? row.victim : 'Another Player'
          } : row) };
      });
    } catch {
      return { ...base, status: 'paused', reason: 'Combat history is temporarily unavailable.' };
    }
  }

  return { tick, read };
}
