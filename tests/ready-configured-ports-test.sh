#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

mkdir -p "$test_root/project/runtime/scripts" "$test_root/bin"
cp "$repo_root/runtime/scripts/ready.sh" "$test_root/project/runtime/scripts/ready.sh"
cp "$repo_root/runtime/scripts/runtime-env.sh" "$test_root/project/runtime/scripts/runtime-env.sh"
cp "$repo_root/runtime/scripts/fls-signals.sh" "$test_root/project/runtime/scripts/fls-signals.sh"

cat > "$test_root/project/.env" <<'EOF'
POSTGRES_PORT=16432
RMQ_ADMIN_PORT=33573
RMQ_GAME_PORT=32982
RMQ_GAME_HTTP_PORT=32983
TEXT_ROUTER_PORT=5159
DIRECTOR_PORT=12717
EOF

cat > "$test_root/bin/timeout" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == --kill-after=* ]]; then
  shift
fi
shift
exec "$@"
EOF

cat > "$test_root/bin/docker" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "inspect" ] && [ "${2:-}" = "-f" ]; then
  printf 'false\n'
fi
exit 1
EOF

cat > "$test_root/bin/ss" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  -lntp)
    printf 'LISTEN 0 128 127.0.0.1:16432 0.0.0.0:*\n'
    printf 'LISTEN 0 128 127.0.0.1:33573 0.0.0.0:*\n'
    printf 'LISTEN 0 128 0.0.0.0:32982 0.0.0.0:*\n'
    printf 'LISTEN 0 128 0.0.0.0:32983 0.0.0.0:*\n'
    printf 'LISTEN 0 128 127.0.0.1:5159 0.0.0.0:*\n'
    printf 'LISTEN 0 128 127.0.0.1:12717 0.0.0.0:*\n'
    ;;
  -lnup)
    printf 'UNCONN 0 0 0.0.0.0:7780 0.0.0.0:*\n'
    printf 'UNCONN 0 0 0.0.0.0:7781 0.0.0.0:*\n'
    printf 'UNCONN 0 0 0.0.0.0:7890 0.0.0.0:*\n'
    printf 'UNCONN 0 0 0.0.0.0:7891 0.0.0.0:*\n'
    ;;
esac
EOF

chmod +x "$test_root/bin/timeout" "$test_root/bin/docker" "$test_root/bin/ss"

set +e
output="$(cd "$test_root/project" && PATH="$test_root/bin:$PATH" bash runtime/scripts/ready.sh 2>&1)"
set -e

for expected in \
  'OK   TCP 16432 Postgres localhost' \
  'OK   TCP 33573 RabbitMQ admin localhost' \
  'OK   TCP 32982 RabbitMQ game public' \
  'OK   TCP 32983 RabbitMQ game HTTP public' \
  'OK   TCP 5159 TextRouter localhost' \
  'OK   TCP 12717 Director localhost'; do
  if ! grep -Fq "$expected" <<<"$output"; then
    printf 'Missing configured-port readiness result: %s\n\n%s\n' "$expected" "$output" >&2
    exit 1
  fi
done

if grep -Eq 'TCP (15432|32573|31982|31983|5059|11717) ' <<<"$output"; then
  printf 'Readiness unexpectedly used a default service port.\n\n%s\n' "$output" >&2
  exit 1
fi

echo "ready.sh honors configured service ports"
