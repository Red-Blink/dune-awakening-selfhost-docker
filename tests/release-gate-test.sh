#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

TEST_ROOT="$(mktemp -d)"
cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

pass() {
  printf 'PASS %s\n' "$1"
}

fail() {
  printf 'FAIL %s\n' "$1" >&2
  exit 1
}

version="$(tr -d '[:space:]' < VERSION)"
if [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]]; then
  pass "VERSION uses a supported release format: $version"
else
  fail "VERSION must look like v1.2.3 or v1.2.3-rc.1, got: $version"
fi

expected_version="${EXPECTED_RELEASE_VERSION:-}"
if [ -z "$expected_version" ] && [ "${GITHUB_REF_TYPE:-}" = "tag" ]; then
  expected_version="${GITHUB_REF_NAME:-}"
fi
if [ -n "$expected_version" ] && [ "$version" != "$expected_version" ]; then
  fail "VERSION $version does not match expected release $expected_version"
fi
pass "VERSION matches the requested release context"

shell_count=0
while IFS= read -r -d '' script; do
  bash -n "$script"
  shell_count=$((shell_count + 1))
done < <(git ls-files -z '*.sh')
bash -n runtime/scripts/dune
pass "shell syntax is valid for $shell_count scripts and the dune CLI"

non_executable="$(git ls-files -s '*.sh' | awk '$1 != "100755" { print $4 }')"
if [ -n "$non_executable" ]; then
  printf '%s\n' "$non_executable" >&2
  fail "tracked shell scripts must be executable"
fi
for entrypoint in install.sh runtime/scripts/dune console/api/entrypoint.sh orchestrator/entrypoint.sh; do
  [ -x "$entrypoint" ] || fail "required entrypoint is not executable: $entrypoint"
done
pass "tracked shell scripts and required entrypoints are executable"

json_count=0
while IFS= read -r -d '' json_file; do
  python3 -m json.tool "$json_file" >/dev/null
  json_count=$((json_count + 1))
done < <(git ls-files -z '*.json')
pass "all $json_count tracked JSON files are valid"

archive="$TEST_ROOT/release.tar.gz"
prefix="dune-awakening-selfhost-docker-${version#v}/"
git archive --format=tar.gz --prefix="$prefix" -o "$archive" HEAD
tar -tzf "$archive" > "$TEST_ROOT/archive-files.txt"

if grep -Eq '(^|/)(\.git|\.env)(/|$)|(^|/)runtime/(generated|backups|secrets|game)(/|$)' "$TEST_ROOT/archive-files.txt"; then
  fail "release archive contains local Git, configuration, secret, backup, or game state"
fi
pass "release archive excludes local configuration and runtime state"

tar -xzf "$archive" -C "$TEST_ROOT"
fresh_root="$TEST_ROOT/${prefix%/}"
[ -d "$fresh_root" ] || fail "release archive did not extract into the expected directory"

for required in \
  VERSION \
  install.sh \
  docker-compose.yml \
  docker-compose.web.yml \
  docker-compose.metrics.yml \
  console/api/Dockerfile \
  console/api/src/server.js \
  console/web/package.json \
  orchestrator/Dockerfile \
  orchestrator/dune_orchestrator.py \
  orchestrator/entrypoint.sh \
  runtime/scripts/compose-project.sh \
  runtime/scripts/env-file.sh \
  runtime/scripts/battlegroup-identity.sh \
  runtime/scripts/dune \
  runtime/scripts/self-update.sh
do
  [ -e "$fresh_root/$required" ] || fail "release archive is missing $required"
done
[ "$(tr -d '[:space:]' < "$fresh_root/VERSION")" = "$version" ] \
  || fail "fresh archive VERSION does not match the source commit"
pass "fresh extraction contains every required install and update file"

self_update_script="runtime/scripts/self-update.sh"
grep -Fq 'if [ "$repo" = "$DEFAULT_SELF_UPDATE_REPO" ]; then' "$self_update_script" \
  || fail "self-update does not force the public project through its anonymous HTTPS remote"
git_fetch_count="$(grep -Ec '(^|[[:space:]])git fetch([[:space:]]|$)' "$self_update_script")"
noninteractive_git_fetch_count="$(grep -Ec '(^|[[:space:]])(env[[:space:]]+)?GIT_TERMINAL_PROMPT=0[[:space:]]+git fetch([[:space:]]|$)' "$self_update_script")"
if [ "$git_fetch_count" -eq 0 ] || [ "$noninteractive_git_fetch_count" -ne "$git_fetch_count" ]; then
  fail "every self-update git fetch must disable interactive credential prompts"
fi
pass "self-update uses anonymous public release fetches without credential prompts"

(
  cd "$fresh_root"
  export SERVER_IP=127.0.0.1
  export SERVER_TITLE="Release Gate"
  export SERVER_REGION=Europe
  export DUNE_HOST_REPO_ROOT="$fresh_root"
  export DUNE_HOST_UID="$(id -u)"
  export DUNE_HOST_GID="$(id -g)"
  export DOCKER_SOCKET_GID=0
  docker compose -f docker-compose.yml config --quiet
  docker compose -f docker-compose.web.yml config --quiet
  docker compose -f docker-compose.metrics.yml config --quiet
)
pass "all Compose configurations validate from a fresh release archive"

printf '\nRelease package validation passed for %s.\n' "$version"
