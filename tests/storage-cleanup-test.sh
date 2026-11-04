#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/repo/runtime/generated" "$TEST_ROOT/repo/runtime/scripts"
cp "$REPO_ROOT/runtime/scripts/storage.sh" "$TEST_ROOT/repo/runtime/scripts/storage.sh"
cat > "$TEST_ROOT/repo/runtime/generated/image-tags.env" <<'EOF'
DUNE_WORLD_IMAGE_TAG=current
DUNE_POSTGRES_IMAGE_TAG=pg-current
EOF

cat > "$TEST_ROOT/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${FAKE_DOCKER_LOG:?}"
if [ "${FAKE_NO_CANDIDATES:-0}" = 1 ] && [ "${1:-}" = image ] && [ "${2:-}" = ls ]; then exit 0; fi
if [ "${FAKE_IMAGE_LIST_FAIL:-0}" = 1 ] && [ "${1:-}" = image ] && [ "${2:-}" = ls ]; then exit 1; fi

case "$*" in
  info) exit 0 ;;
  "system df --format {{.Type}}|{{.Reclaimable}}")
    if [ "${FAKE_ACCOUNTING_FAIL:-0}" = 1 ]; then exit 1; fi
    printf 'Build Cache|%s\n' "${FAKE_CACHE_RECLAIMABLE:-0B}"
    printf 'Images|98GB (54%%)\n'
    ;;
  "container ls -aq")
    [ "${FAKE_CONTAINER_LIST_FAIL:-0}" != 1 ] || exit 1
    printf '%s\n' protected-container protected-second ;;
  "inspect --format {{.Image}} protected-container protected-second") printf '%s\n' sha256:used-old sha256:required-console ;;
  "image inspect --format {{.Id}} registry.funcom.com/funcom/self-hosting/seabass-server:current "*)
    printf '%s\n' sha256:current-world sha256:current-postgres sha256:required-orchestrator sha256:required-console ;;
  "image inspect --format {{.Id}} registry.funcom.com/funcom/self-hosting/seabass-server:current")
    printf '%s\n' sha256:current-world ;;
  "image inspect --format {{.Id}} registry.funcom.com/funcom/self-hosting/igw-postgres:pg-current")
    printf '%s\n' sha256:current-postgres ;;
  "image inspect --format {{.Id}} dune-orchestrator:dev")
    printf '%s\n' sha256:required-orchestrator ;;
  "image inspect --format {{.Id}} redblink-dune-docker-console:dev")
    printf '%s\n' sha256:required-console ;;
  "image inspect --format {{range .RepoTags}}{{println .}}{{end}} sha256:old-world")
    if [ "${FAKE_SHARED_IMAGE:-0}" = 1 ]; then
      printf '%s\n' registry.funcom.com/funcom/self-hosting/seabass-server:old unrelated.example/custom:keep
      exit 0
    fi
    if [ "${FAKE_CURRENT_ALIAS:-0}" = 1 ]; then
      printf '%s\n' registry.funcom.com/funcom/self-hosting/seabass-server:old redblink-dune-tanks:current-candidate
      exit 0
    fi
    printf '%s\n' registry.funcom.com/funcom/self-hosting/seabass-server:old redblink-dune-tank-base:old ;;
  "image inspect --format {{range .RepoTags}}{{println .}}{{end}} sha256:old-console")
    exit 0 ;;
  "image inspect --format {{range .RepoTags}}{{println .}}{{end}} sha256:foreign-labeled")
    printf '%s\n' dune-hardening-console:review ;;
  "image inspect --format {{range .RepoTags}}{{println .}}{{end}} sha256:foreign")
    printf '%s\n' unrelated.example/app:old ;;
  image\ inspect\ --format*sha256:required-orchestrator)
    printf '%s\n' orchestrator ;;
  image\ inspect\ --format*sha256:required-console)
    printf '%s\n' console ;;
  image\ inspect\ --format*sha256:old-console)
    printf '%s\n' console ;;
  "image inspect --format "*) exit 1 ;;
  "image ls --no-trunc --format {{.Repository}}|{{.Tag}}|{{.ID}}")
    cat <<'IMAGES'
registry.funcom.com/funcom/self-hosting/seabass-server|current|sha256:current-world
registry.funcom.com/funcom/self-hosting/seabass-server|old|sha256:old-world
redblink-dune-tanks|current-candidate|sha256:current-tanks
registry.funcom.com/funcom/self-hosting/seabass-server-gateway|old|sha256:used-old
registry.funcom.com/funcom/self-hosting/igw-postgres|pg-current|sha256:current-postgres
unrelated.example/app|old|sha256:foreign
dune-hardening-console|review|sha256:foreign-labeled
<none>|<none>|sha256:old-console
IMAGES
    ;;
  "image ls --no-trunc --filter label=io.github.red-blink.dune-selfhost.component=console --format {{.Repository}}|{{.Tag}}|{{.ID}}")
    cat <<'IMAGES'
redblink-dune-docker-console|dev|sha256:required-console
redblink-dune-docker-console|<none>|sha256:old-console
dune-hardening-console|review|sha256:foreign-labeled
IMAGES
    ;;
  "image ls --no-trunc --filter label=io.github.red-blink.dune-selfhost.component=orchestrator --format {{.Repository}}|{{.Tag}}|{{.ID}}")
    printf '%s\n' 'dune-orchestrator|dev|sha256:required-orchestrator' ;;
  "image rm registry.funcom.com/funcom/self-hosting/seabass-server:old redblink-dune-tank-base:old") exit 0 ;;
  "image rm sha256:old-console") exit 0 ;;
  "image rm unrelated.example/app:old"|"image rm dune-hardening-console:review") exit 0 ;;
  "builder prune --force --all") exit 0 ;;
  *) echo "Unexpected fake Docker call: $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$TEST_ROOT/bin/docker"

export PATH="$TEST_ROOT/bin:$PATH"
export FAKE_DOCKER_LOG="$TEST_ROOT/docker.log"
cd "$TEST_ROOT/repo"

dry_output="$(runtime/scripts/storage.sh cleanup --dry-run)"
[ "$(grep -c '^inspect --format {{.Image}}' "$FAKE_DOCKER_LOG")" -eq 1 ]
[ "$(grep -c '^image inspect --format {{.Id}}' "$FAKE_DOCKER_LOG")" -eq 1 ]
if grep -q '^image inspect --format {{index .Config.Labels' "$FAKE_DOCKER_LOG"; then
  echo "Candidate discovery inspected labels per image instead of using Docker filters." >&2
  exit 1
fi
if ! grep -q 'old-console' <<<"$dry_output"; then
  echo "Fake Docker calls:" >&2
  sed 's/^/  /' "$FAKE_DOCKER_LOG" >&2
fi

: > "$FAKE_DOCKER_LOG"
alias_output="$(FAKE_CURRENT_ALIAS=1 runtime/scripts/storage.sh cleanup --dry-run)"
if grep -q 'WOULD REMOVE .*seabass-server:old' <<<"$alias_output"; then
  echo "Dry-run advertised an image with a current tank alias." >&2; exit 1
fi
if grep -q '^image rm .*seabass-server:old' "$FAKE_DOCKER_LOG"; then
  echo "Cleanup attempted to remove an image with a current tank alias." >&2
  exit 1
fi
grep -q 'WOULD REMOVE .*seabass-server:old (sha256:old-world)' <<<"$dry_output"
grep -q 'WOULD REMOVE redblink-dune-docker-console:<none> (sha256:old-console)' <<<"$dry_output"
if grep -Eq 'current-world|current-tanks|used-old|foreign|required-orchestrator|required-console' <<<"$dry_output"; then
  echo "Protected or unrelated image appeared in dry-run output:" >&2
  echo "$dry_output" >&2
  exit 1
fi

runtime/scripts/storage.sh cleanup >/dev/null
grep -qx 'image rm registry.funcom.com/funcom/self-hosting/seabass-server:old redblink-dune-tank-base:old' "$FAKE_DOCKER_LOG"
grep -qx 'image rm sha256:old-console' "$FAKE_DOCKER_LOG"
if grep -Eq 'image rm sha256:(current-world|used-old|foreign|required-orchestrator|required-console)' "$FAKE_DOCKER_LOG"; then
  echo "Cleanup attempted to remove a protected or unrelated image." >&2
  exit 1
fi

: > "$FAKE_DOCKER_LOG"
shared_output="$(FAKE_SHARED_IMAGE=1 runtime/scripts/storage.sh cleanup --dry-run)"
if grep -q 'WOULD REMOVE .*seabass-server:old' <<<"$shared_output"; then
  echo "Dry-run advertised a shared image that cleanup protects." >&2; exit 1
fi
if grep -q '^image rm .*seabass-server:old' "$FAKE_DOCKER_LOG"; then
  echo "Cleanup attempted to untag an image shared with another project." >&2
  exit 1
fi

cache_output="$(runtime/scripts/storage.sh cleanup --dry-run --build-cache)"
grep -q 'WOULD RUN docker builder prune --force --all' <<<"$cache_output"
if grep -q '^builder prune ' "$FAKE_DOCKER_LOG"; then
  echo "Dry-run unexpectedly pruned build cache." >&2
  exit 1
fi

echo "storage cleanup safety tests passed"

unused="$(runtime/scripts/storage.sh cleanup --dry-run --unused-images)"
[ "$(grep -c '^WOULD REMOVE ' <<<"$unused")" -eq 4 ]
grep -q 'WOULD REMOVE unrelated.example/app:old' <<<"$unused"
grep -q 'WOULD REMOVE <none>:<none>' <<<"$unused"
grep -q 'WOULD REMOVE dune-hardening-console:review' <<<"$unused"
if grep -Eq 'current-world|current-tanks|used-old|required-orchestrator|required-console' <<<"$unused"; then
  echo "Host-wide cleanup advertised a protected image." >&2; exit 1
fi
runtime/scripts/storage.sh cleanup --unused-images >/dev/null
grep -qx 'image rm unrelated.example/app:old' "$FAKE_DOCKER_LOG"
grep -qx 'image rm dune-hardening-console:review' "$FAKE_DOCKER_LOG"
if grep -Eq 'image rm.*(current-world|current-tanks|used-old|required-orchestrator|required-console)|image prune|image rm.*--force' "$FAKE_DOCKER_LOG"; then
  echo "Host-wide cleanup bypassed image protections." >&2; exit 1
fi
if FAKE_CONTAINER_LIST_FAIL=1 runtime/scripts/storage.sh cleanup --unused-images >/dev/null 2>&1; then
  echo "Cleanup proceeded without knowing which containers use images." >&2; exit 1
fi
report="$(runtime/scripts/storage.sh diagnostics)"
grep -q '^WARN Docker has 4 unused image(s)' <<<"$report"
grep -q 'up to 98GB' <<<"$report"
grep -q '^OK   Reclaimable Docker build cache: 0B' <<<"$report"
report="$(FAKE_CACHE_RECLAIMABLE='11.05GB' runtime/scripts/storage.sh diagnostics)"
grep -q '^WARN Docker has 11.05GB of reclaimable build cache' <<<"$report"
report="$(FAKE_CACHE_RECLAIMABLE='3.88GB' runtime/scripts/storage.sh diagnostics)"
grep -q '^OK   Reclaimable Docker build cache: 3.88GB' <<<"$report"
report="$(runtime/scripts/storage.sh cleanup --build-cache)"
grep -q '^STORAGE_RESULT OK   Reclaimable Docker build cache: 0B' <<<"$report"
report="$(FAKE_NO_CANDIDATES=1 runtime/scripts/storage.sh cleanup)"
grep -q '^STORAGE_RESULT OK   No unused Docker images eligible for cleanup' <<<"$report"
if FAKE_ACCOUNTING_FAIL=1 runtime/scripts/storage.sh cleanup >/dev/null 2>&1; then
  echo "Cleanup reported success without verified storage accounting." >&2; exit 1
fi
if FAKE_IMAGE_LIST_FAIL=1 runtime/scripts/storage.sh diagnostics >/dev/null 2>&1; then
  echo "Diagnostics reported clean storage without an image inventory." >&2; exit 1
fi
echo "storage cleanup reporting tests passed"
