#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
test_root="$(mktemp -d)"
fake_bin="$test_root/bin"
mkdir -p "$fake_bin"

cleanup() {
  rm -rf "$test_root"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cat > "$fake_bin/docker" <<'SH'
#!/bin/sh
set -eu

if [ "${1:-}" = "inspect" ]; then
  target="${4:-}"
  case "$target" in
    dune-orchestrator)
      [ -n "${FAKE_ORCHESTRATOR_PROJECT:-}" ] || exit 1
      printf '%s\n' "$FAKE_ORCHESTRATOR_PROJECT"
      ;;
    redblink-dune-docker-console)
      [ -n "${FAKE_CONSOLE_PROJECT:-}" ] || exit 1
      printf 'DUNE_COMPOSE_PROJECT_NAME=%s\nCOMPOSE_PROJECT_NAME=%s\n' \
        "$FAKE_CONSOLE_PROJECT" "$FAKE_CONSOLE_PROJECT"
      ;;
    generated-orchestrator-id)
      [ -n "${FAKE_GENERATED_ORCHESTRATOR_PROJECT:-}" ] || exit 1
      printf '%s\n' "$FAKE_GENERATED_ORCHESTRATOR_PROJECT"
      ;;
    *) exit 1 ;;
  esac
  exit 0
fi

if [ "${1:-}" = "ps" ]; then
  case "$*" in
    *"label=com.docker.compose.project=${FAKE_GENERATED_ORCHESTRATOR_PROJECT:-__unset__}"*"label=com.docker.compose.service=orchestrator"*"label=com.docker.compose.container-number"*"label=com.docker.compose.oneoff=False"*"{{.Names}}"*)
      [ -n "${FAKE_GENERATED_ORCHESTRATOR_NAME:-}" ] \
        && printf '%s\n' "$FAKE_GENERATED_ORCHESTRATOR_NAME"
      ;;
    *"label=com.docker.compose.project=${FAKE_GENERATED_ORCHESTRATOR_PROJECT:-__unset__}"*"label=com.docker.compose.service=orchestrator"*"{{.Names}}"*)
      [ -n "${FAKE_GENERATED_ORCHESTRATOR_NAME:-}" ] \
        && printf '%s\n%s\n' "$FAKE_GENERATED_ORCHESTRATOR_NAME" inherited-image-helper
      ;;
    *"label=com.docker.compose.service=orchestrator"*"label=com.docker.compose.container-number"*"label=com.docker.compose.oneoff=False"*"{{.ID}}"*)
      [ -n "${FAKE_GENERATED_ORCHESTRATOR_PROJECT:-}" ] \
        && printf '%s\n' generated-orchestrator-id
      ;;
    *"label=com.docker.compose.service=orchestrator"*"{{.ID}}"*)
      [ -n "${FAKE_GENERATED_ORCHESTRATOR_PROJECT:-}" ] \
        && printf '%s\n%s\n' generated-orchestrator-id inherited-image-helper-id
      ;;
  esac
  exit 0
fi

if [ "${1:-}" = "volume" ] && [ "${2:-}" = "ls" ]; then
  old_ifs="$IFS"
  IFS=,
  for project in ${FAKE_VOLUME_PROJECTS:-}; do
    [ -n "$project" ] && printf '%s_dune-server\n' "$project"
  done
  IFS="$old_ifs"
  exit 0
fi

if [ "${1:-}" = "volume" ] && [ "${2:-}" = "inspect" ]; then
  volume="${3:-}"
  old_ifs="$IFS"
  IFS=,
  for project in ${FAKE_VOLUME_PROJECTS:-}; do
    case "$volume" in
      "${project}_dune-server"|"${project}_dune-steam"|"${project}_dune-cache"|"${project}_dune-generated"|"${project}_dune-work")
        IFS="$old_ifs"
        exit 0
        ;;
    esac
  done
  IFS="$old_ifs"
  exit 1
fi

exit 1
SH
chmod +x "$fake_bin/docker"

resolve_project() {
  local root="$1"
  shift
  env -u DUNE_COMPOSE_PROJECT_NAME -u COMPOSE_PROJECT_NAME \
    PATH="$fake_bin:$PATH" "$@" \
    sh -c '. "$1/runtime/scripts/compose-project.sh"; dune_resolve_compose_project_name "$2"' \
    sh "$repo_root" "$root"
}

fresh_root="$test_root/Fresh Dune.Server"
mkdir -p "$fresh_root"
actual="$(resolve_project "$fresh_root" env)"
[ "$actual" = "freshduneserver" ] || fail "fresh directory normalized to '$actual'"

explicit_root="$test_root/explicit"
mkdir -p "$explicit_root"
actual="$(PATH="$fake_bin:$PATH" FAKE_ORCHESTRATOR_PROJECT=container-project \
  DUNE_COMPOSE_PROJECT_NAME=operator-choice sh -c \
  '. "$1/runtime/scripts/compose-project.sh"; dune_resolve_compose_project_name "$2"' \
  sh "$repo_root" "$explicit_root")"
[ "$actual" = "operator-choice" ] || fail "explicit override did not win: $actual"

actual="$(PATH="$fake_bin:$PATH" COMPOSE_PROJECT_NAME=standard-override sh -c \
  '. "$1/runtime/scripts/compose-project.sh"; dune_resolve_compose_project_name "$2"' \
  sh "$repo_root" "$explicit_root")"
[ "$actual" = "standard-override" ] || fail "standard Compose override was not honored: $actual"

env_root="$test_root/env"
mkdir -p "$env_root"
printf 'DUNE_COMPOSE_PROJECT_NAME=preserved-install\n' > "$env_root/.env"
actual="$(resolve_project "$env_root" env FAKE_ORCHESTRATOR_PROJECT=container-project)"
[ "$actual" = "preserved-install" ] || fail ".env did not win over the container label: $actual"

container_root="$test_root/container"
mkdir -p "$container_root"
actual="$(resolve_project "$container_root" env FAKE_ORCHESTRATOR_PROJECT=legacy-stack)"
[ "$actual" = "legacy-stack" ] || fail "orchestrator label was not discovered: $actual"

generated_root="$test_root/generated-container-name"
mkdir -p "$generated_root"
actual="$(resolve_project "$generated_root" env FAKE_GENERATED_ORCHESTRATOR_PROJECT=numbers)"
[ "$actual" = "numbers" ] || fail "generated-name orchestrator project was not discovered: $actual"

actual="$(PATH="$fake_bin:$PATH" FAKE_GENERATED_ORCHESTRATOR_PROJECT=numbers \
  FAKE_GENERATED_ORCHESTRATOR_NAME=numbers_orchestrator_1 sh -c \
  '. "$1/runtime/scripts/compose-project.sh"; dune_compose_running_service_container numbers orchestrator' \
  sh "$repo_root")"
[ "$actual" = "numbers_orchestrator_1" ] \
  || fail "generated orchestrator container name was not resolved: $actual"

console_root="$test_root/console"
mkdir -p "$console_root"
actual="$(resolve_project "$console_root" env FAKE_CONSOLE_PROJECT=console-preserved)"
[ "$actual" = "console-preserved" ] || fail "Console main-project environment was not discovered: $actual"

volume_root="$test_root/volumes"
mkdir -p "$volume_root"
actual="$(resolve_project "$volume_root" env FAKE_VOLUME_PROJECTS=dune-awakening)"
[ "$actual" = "dune-awakening" ] || fail "single complete legacy volume set was not discovered: $actual"

ambiguous_root="$test_root/ambiguous"
mkdir -p "$ambiguous_root"
if resolve_project "$ambiguous_root" env \
  FAKE_VOLUME_PROJECTS=dune-awakening,dune-awakening-selfhost-docker \
  >"$test_root/ambiguous.out" 2>"$test_root/ambiguous.err"; then
  fail "ambiguous volume sets were accepted"
fi
grep -q 'Multiple existing Dune Compose volume sets were found' "$test_root/ambiguous.err" \
  || fail "ambiguous volume error was not actionable"

if resolve_project "$ambiguous_root" env \
  FAKE_ORCHESTRATOR_PROJECT=dune-awakening-selfhost-docker \
  FAKE_VOLUME_PROJECTS=dune-awakening,dune-awakening-selfhost-docker \
  >"$test_root/active-ambiguous.out" 2>"$test_root/active-ambiguous.err"; then
  fail "an active container hid ambiguous duplicate volume sets"
fi
grep -q "active containers report Compose project 'dune-awakening-selfhost-docker'" "$test_root/active-ambiguous.err" \
  || fail "active duplicate-volume error did not identify the reported project"

persist_root="$test_root/persist"
mkdir -p "$persist_root"
printf 'DUNE_DB_PASSWORD="quoted password"\nDUNE_COMPOSE_PROJECT_NAME=old-name\n' > "$persist_root/.env"
chmod 640 "$persist_root/.env"
persist_owner_before="$(stat -c '%u:%g' "$persist_root/.env")"
sh -c '. "$1/runtime/scripts/compose-project.sh"; dune_persist_compose_project_name "$2" corrected-name' \
  sh "$repo_root" "$persist_root"
grep -qx 'DUNE_COMPOSE_PROJECT_NAME=corrected-name' "$persist_root/.env" \
  || fail "resolved project name was not persisted"
grep -qx 'COMPOSE_PROJECT_NAME=corrected-name' "$persist_root/.env" \
  || fail "standard Compose project name was not persisted for direct Docker Compose commands"
grep -qx 'DUNE_DB_PASSWORD="quoted password"' "$persist_root/.env" \
  || fail "persisting the project name changed another config value"
[ "$(stat -c '%u:%g' "$persist_root/.env")" = "$persist_owner_before" ] \
  || fail "persisting the project name changed .env ownership"
[ "$(stat -c '%a' "$persist_root/.env")" = "640" ] \
  || fail "persisting the project name changed .env permissions"

persist_inode_before="$(stat -c '%i' "$persist_root/.env")"
persist_mtime_before="$(stat -c '%Y' "$persist_root/.env")"
sh -c '. "$1/runtime/scripts/compose-project.sh"; dune_persist_compose_project_name "$2" corrected-name' \
  sh "$repo_root" "$persist_root"
[ "$(stat -c '%i' "$persist_root/.env")" = "$persist_inode_before" ] \
  || fail "persisting an unchanged project name replaced .env"
[ "$(stat -c '%Y' "$persist_root/.env")" = "$persist_mtime_before" ] \
  || fail "persisting an unchanged project name touched .env"

grep -q 'chown "\$dune_compose_ref_owner" "\$dune_compose_tmp_file"' \
  "$repo_root/runtime/scripts/compose-project.sh" \
  || fail "atomic .env replacement does not explicitly preserve ownership"
if grep -q -- '--reference=' "$repo_root/runtime/scripts/compose-project.sh"; then
  fail "atomic .env replacement uses a GNU-coreutils-only chmod/chown flag BusyBox does not support"
fi

compose_json="$(cd "$repo_root" && \
  DUNE_COMPOSE_PROJECT_NAME=legacy-main \
  COMPOSE_PROJECT_NAME=dune-awakening-selfhost-docker \
  docker compose -f docker-compose.web.yml config --format json)"
python3 -c '
import json, sys
data = json.load(sys.stdin)
env = data["services"]["redblink-dune-docker-console"]["environment"]
assert env["DUNE_COMPOSE_PROJECT_NAME"] == "legacy-main", env
assert env["COMPOSE_PROJECT_NAME"] == "legacy-main", env
' <<<"$compose_json" || fail "Web Console did not receive the resolved main project"

echo "PASS: Compose project discovery preserves existing volume namespaces"
