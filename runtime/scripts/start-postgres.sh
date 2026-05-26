#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

[ -f .env ] && . ./.env
[ -f runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env

[ -f runtime/generated/image-tags.env ] && . runtime/generated/image-tags.env
source runtime/scripts/image-tags.sh
POSTGRES_IMAGE_TAG="$(resolve_postgres_image_tag)"
IMAGE="registry.funcom.com/funcom/self-hosting/igw-postgres:${POSTGRES_IMAGE_TAG}"

mkdir -p runtime/postgres/initdb

cat > runtime/postgres/initdb/01-create-dune-user.sql <<'SQL'
DO
$$
BEGIN
   IF NOT EXISTS (
      SELECT FROM pg_catalog.pg_roles WHERE rolname = 'dune'
   ) THEN
      CREATE ROLE dune LOGIN PASSWORD 'dune';
   END IF;
END
$$;

ALTER DATABASE dune OWNER TO dune;
GRANT ALL PRIVILEGES ON DATABASE dune TO dune;
SQL

docker network create dune-net 2>/dev/null || true

docker rm -f dune-postgres 2>/dev/null || true

docker volume create dune-postgres-data >/dev/null

docker run -d \
  --name dune-postgres \
  --network dune-net \
  --restart unless-stopped \
  -p 127.0.0.1:15432:5432 \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=dune \
  -v dune-postgres-data:/var/lib/postgresql/data \
  -v "$PWD/runtime/postgres/initdb:/docker-entrypoint-initdb.d:ro" \
  "$IMAGE"

echo "Waiting for Postgres..."
ready=0
for i in $(seq 1 60); do
  if docker exec dune-postgres pg_isready -h 127.0.0.1 -p 5432 -U postgres -d dune >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done

if [ "$ready" != "1" ]; then
  echo "Postgres did not become ready in time."
  echo
  echo "=== Postgres logs ==="
  docker logs --tail 200 dune-postgres || true
  exit 1
fi

docker exec dune-postgres pg_isready -h 127.0.0.1 -p 5432 -U postgres -d dune

echo
echo "=== Normalizing dune schema ownership and privileges ==="
docker exec -i dune-postgres psql -h 127.0.0.1 -p 5432 -U postgres -d dune <<'SQL'
ALTER DATABASE dune OWNER TO dune;
ALTER SCHEMA dune OWNER TO dune;
GRANT ALL PRIVILEGES ON DATABASE dune TO dune;
GRANT USAGE, CREATE ON SCHEMA dune TO dune;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA dune TO dune;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA dune TO dune;
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA dune TO dune;
ALTER DEFAULT PRIVILEGES IN SCHEMA dune GRANT ALL PRIVILEGES ON TABLES TO dune;
ALTER DEFAULT PRIVILEGES IN SCHEMA dune GRANT ALL PRIVILEGES ON SEQUENCES TO dune;
ALTER DEFAULT PRIVILEGES IN SCHEMA dune GRANT ALL PRIVILEGES ON FUNCTIONS TO dune;

DO
$$
DECLARE
  obj record;
BEGIN
  FOR obj IN
    SELECT quote_ident(n.nspname) AS schema_name,
           quote_ident(c.relname) AS object_name,
           c.relkind AS relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'dune'
      AND c.relkind IN ('r','p','S','v','m','f')
      AND pg_get_userbyid(c.relowner) <> 'dune'
  LOOP
    EXECUTE format(
      'ALTER %s %s.%s OWNER TO dune',
      CASE obj.relkind
        WHEN 'S' THEN 'SEQUENCE'
        WHEN 'v' THEN 'VIEW'
        WHEN 'm' THEN 'MATERIALIZED VIEW'
        WHEN 'f' THEN 'FOREIGN TABLE'
        ELSE 'TABLE'
      END,
      obj.schema_name,
      obj.object_name
    );
  END LOOP;
END
$$;
SQL

echo
echo "=== Databases ==="
docker exec dune-postgres psql -h 127.0.0.1 -p 5432 -U postgres -d dune -c '\l'

echo
echo "=== Roles ==="
docker exec dune-postgres psql -h 127.0.0.1 -p 5432 -U postgres -d dune -c '\du'

echo
echo "=== Container ==="
docker ps --filter "name=dune-postgres" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
