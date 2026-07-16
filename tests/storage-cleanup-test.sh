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

case "$*" in
  info) exit 0 ;;
  "container ls -aq") printf '%s\n' protected-container ;;
  "inspect --format {{.Image}} protected-container") printf '%s\n' sha256:used-old ;;
  "image inspect --format {{.Id}} registry.funcom.com/funcom/self-hosting/seabass-server:current")
    printf '%s\n' sha256:current-world ;;
  "image inspect --format {{.Id}} registry.funcom.com/funcom/self-hosting/igw-postgres:pg-current")
    printf '%s\n' sha256:current-postgres ;;
  image\ inspect\ --format*sha256:old-console)
    printf '%s\n' console ;;
  "image inspect --format "*) exit 1 ;;
  "image ls --no-trunc --format {{.Repository}}|{{.Tag}}|{{.ID}}")
    cat <<'IMAGES'
registry.funcom.com/funcom/self-hosting/seabass-server|current|sha256:current-world
registry.funcom.com/funcom/self-hosting/seabass-server|old|sha256:old-world
registry.funcom.com/funcom/self-hosting/seabass-server-gateway|old|sha256:used-old
registry.funcom.com/funcom/self-hosting/igw-postgres|pg-current|sha256:current-postgres
unrelated.example/app|old|sha256:foreign
IMAGES
    ;;
  "image ls --no-trunc --filter label=io.github.red-blink.dune-selfhost.component --format {{.Repository}}|{{.Tag}}|{{.ID}}")
    printf '%s\n' 'redblink-dune-docker-console|<none>|sha256:old-console'
    ;;
  "image rm sha256:old-world") exit 0 ;;
  "image rm sha256:old-console") exit 0 ;;
  "builder prune --force --all") exit 0 ;;
  *) echo "Unexpected fake Docker call: $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$TEST_ROOT/bin/docker"

export PATH="$TEST_ROOT/bin:$PATH"
export FAKE_DOCKER_LOG="$TEST_ROOT/docker.log"
cd "$TEST_ROOT/repo"

dry_output="$(runtime/scripts/storage.sh cleanup --dry-run)"
if ! grep -q 'old-console' <<<"$dry_output"; then
  echo "Fake Docker calls:" >&2
  sed 's/^/  /' "$FAKE_DOCKER_LOG" >&2
fi
grep -q 'WOULD REMOVE .*seabass-server:old (sha256:old-world)' <<<"$dry_output"
grep -q 'WOULD REMOVE redblink-dune-docker-console:<none> (sha256:old-console)' <<<"$dry_output"
if grep -Eq 'current-world|used-old|foreign' <<<"$dry_output"; then
  echo "Protected or unrelated image appeared in dry-run output:" >&2
  echo "$dry_output" >&2
  exit 1
fi

runtime/scripts/storage.sh cleanup >/dev/null
grep -qx 'image rm sha256:old-world' "$FAKE_DOCKER_LOG"
grep -qx 'image rm sha256:old-console' "$FAKE_DOCKER_LOG"
if grep -Eq 'image rm sha256:(current-world|used-old|foreign)' "$FAKE_DOCKER_LOG"; then
  echo "Cleanup attempted to remove a protected or unrelated image." >&2
  exit 1
fi

cache_output="$(runtime/scripts/storage.sh cleanup --dry-run --build-cache)"
grep -q 'WOULD RUN docker builder prune --force --all' <<<"$cache_output"
if grep -q '^builder prune ' "$FAKE_DOCKER_LOG"; then
  echo "Dry-run unexpectedly pruned build cache." >&2
  exit 1
fi

echo "storage cleanup safety tests passed"
