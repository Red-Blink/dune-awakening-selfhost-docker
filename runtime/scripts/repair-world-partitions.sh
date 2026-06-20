#!/usr/bin/env bash
set -euo pipefail

POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-dune-postgres}"
POSTGRES_DB="${POSTGRES_DB:-dune}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"

SURVIVAL_PORT="${SURVIVAL_PORT:-7777}"
OVERMAP_PORT="${OVERMAP_PORT:-7778}"

SURVIVAL_PARTITION_ID="${SURVIVAL_PARTITION_ID:-1}"
OVERMAP_PARTITION_ID="${OVERMAP_PARTITION_ID:-2}"

PARTITION_REPAIR_MODE="${PARTITION_REPAIR_MODE:-repair}" # check | repair | watch
REPAIR_INTERVAL="${REPAIR_INTERVAL:-15}"

DEFAULT_PARTITION_DEF='{"box": {"max_x": 1, "max_y": 1, "min_x": 0, "min_y": 0}, "type": "box2d_array"}'

die() {
  echo "[partition-repair] ERROR: $*" >&2
  exit 1
}

log() {
  echo "[partition-repair] $*" >&2
}

require_container() {
  docker ps --format '{{.Names}}' | grep -qx "$POSTGRES_CONTAINER" \
    || die "Postgres container '$POSTGRES_CONTAINER' is not running"
}

psql_quiet() {
  docker exec -i "$POSTGRES_CONTAINER" \
    psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"
}

psql_report() {
  docker exec -i "$POSTGRES_CONTAINER" \
    psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"
}

check_once() {
  require_container

  local result
  result="$(
    psql_quiet <<SQL
SET search_path TO dune, public;

WITH targets(game_port, partition_id, map_name, dimension_index) AS (
  VALUES
    (${SURVIVAL_PORT}::integer, ${SURVIVAL_PARTITION_ID}::bigint, 'Survival_1'::text, 0::integer),
    (${OVERMAP_PORT}::integer, ${OVERMAP_PARTITION_ID}::bigint, 'Overmap'::text, 0::integer)
),
alive_candidates AS (
  SELECT DISTINCT ON (t.game_port)
    t.game_port,
    t.partition_id,
    t.map_name,
    t.dimension_index,
    fs.server_id,
    fs.revision,
    EXISTS (
      SELECT 1
      FROM active_server_ids asi
      WHERE asi.server_id = fs.server_id
    ) AS has_active_db_connection
  FROM targets t
  JOIN farm_state fs
    ON fs.game_port = t.game_port
   AND fs.alive = true
  ORDER BY
    t.game_port,
    has_active_db_connection DESC,
    fs.revision DESC NULLS LAST,
    fs.server_id
),
checks AS (
  SELECT
    (SELECT COUNT(*) FROM farm_state WHERE alive = true) AS alive_count,
    (SELECT COUNT(*) FROM world_partition) AS partition_count,
    (
      SELECT COUNT(*)
      FROM alive_candidates c
      WHERE NOT EXISTS (
        SELECT 1
        FROM world_partition wp
        WHERE wp.server_id = c.server_id
          AND wp.map = c.map_name
          AND wp.dimension_index = c.dimension_index
      )
    ) AS missing_ownership_count
)
SELECT
  CASE
    WHEN alive_count = 0 THEN 'WARN_NO_ALIVE_SERVERS'
    WHEN partition_count = 0 THEN 'FAIL_WORLD_PARTITION_EMPTY'
    WHEN missing_ownership_count > 0 THEN 'FAIL_MISSING_OWNERSHIP'
    ELSE 'OK'
  END
FROM checks;
SQL
  )"

  case "$result" in
    OK)
      log "OK: alive configured servers have valid world_partition ownership"
      log "OK: configured partition rows are present"
      return 0
      ;;
    WARN_NO_ALIVE_SERVERS)
      log "WARN: no alive farm_state rows yet; no repair target is available"
      return 2
      ;;
    FAIL_WORLD_PARTITION_EMPTY)
      log "FAIL: world_partition is empty while alive server rows exist"
      return 1
      ;;
    FAIL_MISSING_OWNERSHIP)
      log "FAIL: one or more alive configured servers lack world_partition ownership"
      return 1
      ;;
    *)
      die "unexpected check result: ${result:-<empty>}"
      ;;
  esac
}

repair_once() {
  require_container

  log "checking world partition state in container=$POSTGRES_CONTAINER db=$POSTGRES_DB user=$POSTGRES_USER"

  local repair_result
  repair_result="$(
    psql_quiet <<SQL
SET search_path TO dune, public;
SET client_min_messages TO warning;

CREATE TEMP TABLE _partition_targets (
  game_port integer NOT NULL,
  partition_id bigint NOT NULL,
  map_name text NOT NULL,
  dimension_index integer NOT NULL DEFAULT 0
) ON COMMIT DROP;

INSERT INTO _partition_targets(game_port, partition_id, map_name, dimension_index)
VALUES
  (${SURVIVAL_PORT}, ${SURVIVAL_PARTITION_ID}, 'Survival_1', 0),
  (${OVERMAP_PORT}, ${OVERMAP_PARTITION_ID}, 'Overmap', 0);

CREATE TEMP TABLE _partition_candidates AS
SELECT DISTINCT ON (t.game_port)
  t.game_port,
  t.partition_id,
  t.map_name,
  t.dimension_index,
  fs.server_id,
  fs.revision,
  EXISTS (
    SELECT 1
    FROM active_server_ids asi
    WHERE asi.server_id = fs.server_id
  ) AS has_active_db_connection
FROM _partition_targets t
JOIN farm_state fs
  ON fs.game_port = t.game_port
 AND fs.alive = true
ORDER BY
  t.game_port,
  has_active_db_connection DESC,
  fs.revision DESC NULLS LAST,
  fs.server_id;

CREATE TEMP TABLE _repair_actions (
  action text NOT NULL,
  partition_id bigint,
  server_id text,
  map_name text,
  detail text
) ON COMMIT DROP;

BEGIN;

DO \$\$
DECLARE
  r record;
  existing_partition_for_server bigint;
  existing_pid_server text;
  existing_pid_active boolean;
  candidate_count integer;
BEGIN
  SELECT COUNT(*) INTO candidate_count FROM _partition_candidates;

  IF candidate_count = 0 THEN
    INSERT INTO _repair_actions(action, detail)
    VALUES ('NO_ALIVE_SERVERS', 'No alive farm_state rows matched configured ports');
    RETURN;
  END IF;

  FOR r IN
    SELECT *
    FROM _partition_candidates
    ORDER BY game_port
  LOOP
    SELECT wp.partition_id
    INTO existing_partition_for_server
    FROM world_partition wp
    WHERE wp.server_id = r.server_id
      AND wp.map = r.map_name
      AND wp.dimension_index = r.dimension_index
    LIMIT 1;

    IF existing_partition_for_server IS NOT NULL THEN
      UPDATE world_partition
      SET
        partition_definition = '${DEFAULT_PARTITION_DEF}'::jsonb,
        blocked = false
      WHERE partition_id = existing_partition_for_server
        AND (
          partition_definition IS DISTINCT FROM '${DEFAULT_PARTITION_DEF}'::jsonb
          OR blocked IS DISTINCT FROM false
        );

      IF FOUND THEN
        INSERT INTO _repair_actions(action, partition_id, server_id, map_name, detail)
        VALUES (
          'NORMALIZED_EXISTING',
          existing_partition_for_server,
          r.server_id,
          r.map_name,
          'Existing server partition needed normalization'
        );
      ELSE
        INSERT INTO _repair_actions(action, partition_id, server_id, map_name, detail)
        VALUES (
          'OK_EXISTING',
          existing_partition_for_server,
          r.server_id,
          r.map_name,
          'Existing partition is healthy'
        );
      END IF;

      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM world_partition wp
      WHERE wp.partition_id = r.partition_id
    ) THEN
      SELECT
        wp.server_id,
        EXISTS (
          SELECT 1
          FROM active_server_ids asi
          WHERE asi.server_id = wp.server_id
        )
      INTO existing_pid_server, existing_pid_active
      FROM world_partition wp
      WHERE wp.partition_id = r.partition_id;

      IF existing_pid_server IS NULL OR existing_pid_active IS FALSE THEN
        UPDATE world_partition
        SET
          server_id = r.server_id,
          map = r.map_name,
          partition_definition = '${DEFAULT_PARTITION_DEF}'::jsonb,
          dimension_index = r.dimension_index,
          blocked = false
        WHERE partition_id = r.partition_id;

        INSERT INTO _repair_actions(action, partition_id, server_id, map_name, detail)
        VALUES (
          'CLAIMED_EXISTING',
          r.partition_id,
          r.server_id,
          r.map_name,
          'Preferred partition_id existed and was free/stale'
        );
      ELSE
        INSERT INTO _repair_actions(action, partition_id, server_id, map_name, detail)
        VALUES (
          'SKIPPED_ACTIVE_OWNER',
          r.partition_id,
          r.server_id,
          r.map_name,
          'Preferred partition_id is owned by an active server; not overwriting'
        );
      END IF;

      CONTINUE;
    END IF;

    INSERT INTO world_partition (
      partition_id,
      server_id,
      map,
      partition_definition,
      dimension_index,
      blocked
    )
    VALUES (
      r.partition_id,
      r.server_id,
      r.map_name,
      '${DEFAULT_PARTITION_DEF}'::jsonb,
      r.dimension_index,
      false
    );

    INSERT INTO _repair_actions(action, partition_id, server_id, map_name, detail)
    VALUES (
      'INSERTED_MISSING',
      r.partition_id,
      r.server_id,
      r.map_name,
      'Preferred partition_id did not exist and was inserted'
    );
  END LOOP;
END
\$\$;

SELECT setval(
  'world_partition_partition_id_seq',
  GREATEST(
    (SELECT COALESCE(MAX(partition_id), 1) FROM world_partition),
    1
  ),
  true
);

DO \$\$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'dune'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'dune'
      AND table_name = 'network_address_config'
  ) THEN
    GRANT USAGE ON SCHEMA dune TO dune;
    GRANT SELECT ON TABLE network_address_config TO dune;
  END IF;
END
\$\$;

COMMIT;

SELECT CASE
  WHEN EXISTS (
    SELECT 1
    FROM _repair_actions
    WHERE action IN ('INSERTED_MISSING', 'CLAIMED_EXISTING', 'NORMALIZED_EXISTING')
  )
  THEN 'changed'
  WHEN EXISTS (
    SELECT 1
    FROM _repair_actions
    WHERE action = 'NO_ALIVE_SERVERS'
  )
  THEN 'no_alive_servers'
  ELSE 'ok'
END;
SQL
  )"

  repair_result="$(echo "$repair_result" | awk '/^(changed|ok|no_alive_servers)$/ {print $1}' | tail -n 1)"

  case "$repair_result" in
    changed)
      log "changes were made; reporting SQL state"

      psql_report <<SQL
SET search_path TO dune, public;

CREATE TEMP TABLE _partition_targets (
  game_port integer NOT NULL,
  partition_id bigint NOT NULL,
  map_name text NOT NULL,
  dimension_index integer NOT NULL DEFAULT 0
) ON COMMIT DROP;

INSERT INTO _partition_targets(game_port, partition_id, map_name, dimension_index)
VALUES
  (${SURVIVAL_PORT}, ${SURVIVAL_PARTITION_ID}, 'Survival_1', 0),
  (${OVERMAP_PORT}, ${OVERMAP_PARTITION_ID}, 'Overmap', 0);

CREATE TEMP TABLE _partition_candidates AS
SELECT DISTINCT ON (t.game_port)
  t.game_port,
  t.partition_id,
  t.map_name,
  t.dimension_index,
  fs.server_id,
  fs.revision,
  EXISTS (
    SELECT 1
    FROM active_server_ids asi
    WHERE asi.server_id = fs.server_id
  ) AS has_active_db_connection
FROM _partition_targets t
JOIN farm_state fs
  ON fs.game_port = t.game_port
 AND fs.alive = true
ORDER BY
  t.game_port,
  has_active_db_connection DESC,
  fs.revision DESC NULLS LAST,
  fs.server_id;

\echo '[partition-repair] selected alive server candidates'
SELECT *
FROM _partition_candidates
ORDER BY game_port;

\echo '[partition-repair] world_partition after repair'
SELECT partition_id, server_id, map, dimension_index, blocked, label
FROM world_partition
ORDER BY partition_id;

\echo '[partition-repair] ownership validation'
SELECT
  c.map_name,
  c.server_id,
  c.dimension_index,
  c.partition_id AS expected_partition_id,
  CASE WHEN wp.partition_id IS NULL THEN 'missing' ELSE 'owned' END AS ownership_state,
  wp.partition_id AS actual_partition_id
FROM _partition_candidates c
LEFT JOIN world_partition wp
  ON wp.server_id = c.server_id
 AND wp.map = c.map_name
 AND wp.dimension_index = c.dimension_index
ORDER BY
  c.partition_id;
SQL
      ;;
    ok)
      log "OK: no partition repair changes needed"
      check_once || true
      ;;
    no_alive_servers)
      log "WARN: no alive configured servers found; no partition repair target is available"
      ;;
    *)
      die "unexpected repair result: ${repair_result:-<empty>}"
      ;;
  esac
}

case "$PARTITION_REPAIR_MODE" in
  check)
    check_once
    ;;
  repair)
    repair_once
    ;;
  watch)
    log "watch mode enabled, interval=${REPAIR_INTERVAL}s"
    while true; do
      repair_once || true
      sleep "$REPAIR_INTERVAL"
    done
    ;;
  *)
    die "unsupported PARTITION_REPAIR_MODE=$PARTITION_REPAIR_MODE; expected check, repair, or watch"
    ;;
esac
