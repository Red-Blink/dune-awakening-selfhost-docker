#!/usr/bin/env bash
set -euo pipefail

# Emit the idempotent cluster bootstrap that start-postgres.sh applies after
# PostgreSQL is ready. Keeping this out of /docker-entrypoint-initdb.d avoids a
# one-time initialization dependency when an existing or partially initialized
# data volume is reused.
dune_db_password="${DUNE_DB_PASSWORD:-dune}"
dune_db_password_sql="$(printf '%s' "$dune_db_password" | sed "s/'/''/g")"

cat <<SQL
DO
\$\$
BEGIN
   IF NOT EXISTS (
      SELECT FROM pg_catalog.pg_roles WHERE rolname = 'dune'
   ) THEN
      CREATE ROLE dune LOGIN;
   END IF;
END
\$\$;

ALTER ROLE dune WITH LOGIN PASSWORD '$dune_db_password_sql';

SELECT 'CREATE DATABASE dune OWNER dune'
WHERE NOT EXISTS (
  SELECT FROM pg_catalog.pg_database WHERE datname = 'dune'
) \gexec

ALTER DATABASE dune OWNER TO dune;
GRANT ALL PRIVILEGES ON DATABASE dune TO dune;
SQL
