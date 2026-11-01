#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
fixture="$(mktemp -d)"
worker=""
cleanup() {
  if [ -n "$worker" ]; then kill "$worker" 2>/dev/null || true; wait "$worker" 2>/dev/null || true; fi
  rm -rf "$fixture"
}
trap cleanup EXIT
mkdir -p "$fixture/repo/runtime/scripts/lib" "$fixture/bin" "$fixture/state"
for script in console.sh start-coriolis-coordinator.sh compose-project.sh host-paths.sh runtime-env.sh memory-swap-common.sh env-file.sh host-file-ownership.sh lib/secrets.sh lib/ports.sh; do
  cp "$repo_root/runtime/scripts/$script" "$fixture/repo/runtime/scripts/$script"
done
touch "$fixture/repo/docker-compose.web.yml"
printf 'DUNE_COMPOSE_PROJECT_NAME=isolation-test\n' > "$fixture/repo/.env"
export TEST_STATE="$fixture/state"
export DUNE_RUNTIME_PERMISSIONS_REPAIRED=1 DOCKER_SOCKET_GID=1000
export DUNE_CORIOLIS_COORDINATOR_ENABLED=1
export DUNE_COMPOSE_PROJECT_NAME=isolation-test DUNE_WEB_COMPOSE_PROJECT_NAME=isolation-test
export DUNE_HOST_REPO_ROOT="$fixture/repo"
unset DUNE_CONTAINER_REPO_ROOT

cat > "$fixture/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$TEST_STATE/docker.log"
case "$1 ${2:-}" in
  "ps --format") cat "$TEST_STATE/running" ;;
  "compose -f")
    case " $* " in
      *" build "*) touch "$TEST_STATE/built" ;;
      *" up "*) touch "$TEST_STATE/console-up" ;;
    esac
    ;;
  "image inspect")
    if [[ "$*" == *'{{.Id}}'* ]]; then
      if [ -f "$TEST_STATE/built" ]; then echo console-new; else echo console-old; fi
    fi
    ;;
  "image rm") ;;
  "rm -f")
    case "$3" in
      redblink-dune-docker-console) touch "$TEST_STATE/console-removed" ;;
      dune-coriolis-coordinator)
        touch "$TEST_STATE/recovery-interrupted"
        grep -vx dune-coriolis-coordinator "$TEST_STATE/running" > "$TEST_STATE/next" || true
        mv "$TEST_STATE/next" "$TEST_STATE/running"
        ;;
      *) echo "Unexpected service removal: $3" >&2; exit 1 ;;
    esac
    ;;
  "run -d")
    echo dune-coriolis-coordinator >> "$TEST_STATE/running"
    ;;
  *) echo "Unexpected Docker command: $*" >&2; exit 1 ;;
esac
MOCK
chmod +x "$fixture/bin/docker"
export PATH="$fixture/bin:$PATH"

for operation in restart reload; do
  rm -f "$TEST_STATE"/*
  printf '%s\n' dune-director dune-server-survival-1 dune-coriolis-coordinator > "$TEST_STATE/running"
  # Model the real recovery worker holding the shared lifecycle lock while
  # executing inside the coordinator. Console operations must not interrupt it.
  (
    flock -x 9
    touch "$TEST_STATE/recovery-ready"
    while [ ! -f "$TEST_STATE/release" ]; do sleep 0.05; done
    [ ! -f "$TEST_STATE/recovery-interrupted" ]
    touch "$TEST_STATE/recovery-completed"
  ) 9> "$fixture/repo/runtime/generated-lifecycle.lock" &
  worker=$!
  for ((attempt=0; attempt<100; attempt++)); do
    [ ! -f "$TEST_STATE/recovery-ready" ] || break
    sleep 0.05
  done
  [ -f "$TEST_STATE/recovery-ready" ]
  bash "$fixture/repo/runtime/scripts/console.sh" "$operation" > "$TEST_STATE/console.log" 2>&1
  if grep -qi 'Warning:' "$TEST_STATE/console.log"; then cat "$TEST_STATE/console.log" >&2; exit 1; fi
  [ -f "$TEST_STATE/console-up" ]
  [ -f "$TEST_STATE/console-removed" ]
  if [ -f "$TEST_STATE/recovery-interrupted" ]; then
    echo "Console $operation interrupted an active game-farm recovery." >&2; exit 1
  fi
  if grep -Eq '^rm -f dune-|^run -d' "$TEST_STATE/docker.log"; then
    echo "Console $operation replaced a game service." >&2; exit 1
  fi
  touch "$TEST_STATE/release"
  wait "$worker"
  worker=""
  [ -f "$TEST_STATE/recovery-completed" ]
done

# Ensure the upgrade path still supplies a missing coordinator to an active
# stack, but does not start it when the stack is stopped.
for stack in active stopped; do
  rm -f "$TEST_STATE"/*
  if [ "$stack" = active ]; then echo dune-director > "$TEST_STATE/running"; else : > "$TEST_STATE/running"; fi
  bash "$fixture/repo/runtime/scripts/console.sh" restart > "$TEST_STATE/console.log" 2>&1
  if grep -qi 'Warning:' "$TEST_STATE/console.log"; then cat "$TEST_STATE/console.log" >&2; exit 1; fi
  if [ "$stack" = active ]; then
    grep -q '^run -d .*--name dune-coriolis-coordinator' "$TEST_STATE/docker.log"
  elif grep -q '^run -d' "$TEST_STATE/docker.log"; then
    echo "Console restart started game coordination for a stopped stack." >&2; exit 1
  fi
done
echo "Console restart/reload preserve an active recovery; coordinator startup compatibility passed."
