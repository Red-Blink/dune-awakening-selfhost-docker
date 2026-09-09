#!/usr/bin/env bash
set -euo pipefail

# The deferred dimension reconcile waits for Survival_1/Overmap to be READY --
# minutes, on a cold start -- and then spawns any Sietch dimension that has no
# server. It used to run as a background job of start-all.sh, inside the console
# container, so `dune console reload` (a docker rm -f on that container) killed
# it mid-wait. A system restore reloads the console seconds after starting the
# stack, so it was killed every time and the second Sietch never spawned.
#
# The first cases pin the shape of the launch: that it is detached from the
# console, that it carries what spawn-server.sh needs, and that a host without
# the console image still gets a reconcile. The last two pin that a step which
# fails says so, rather than being swallowed by a bare `|| true`.

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

project="$test_root/project"
bin_dir="$test_root/bin"
mkdir -p "$project/runtime/scripts" "$project/runtime/generated" "$bin_dir"

cp "$repo_root/runtime/scripts/schedule-deferred-reconcile.sh" "$project/runtime/scripts/"

# Stands in for the real reconcile, which needs Postgres and a live farm.
cat > "$project/runtime/scripts/deferred-reconcile.sh" <<'STUB'
#!/usr/bin/env bash
echo "deferred reconcile ran"
STUB
chmod +x "$project/runtime/scripts/deferred-reconcile.sh"

docker_log="$test_root/docker.log"
cat > "$bin_dir/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${MOCK_DOCKER_LOG:?}"
case "${1:-} ${2:-}" in
  "image inspect")
    # MOCK_IMAGE_PRESENT=0 stands in for a host that has never built the console.
    [ "${MOCK_IMAGE_PRESENT:-1}" = "1" ] || exit 1
    ;;
  "run -d")
    [ "${MOCK_RUN_FAILS:-0}" = "0" ] || exit 1
    printf 'containerid\n'
    ;;
esac
exit 0
EOF
chmod +x "$bin_dir/docker"

fail() {
  echo "FAIL $1"
  shift
  [ "$#" -eq 0 ] || cat "$@"
  exit 1
}

run_schedule() {
  local label="$1"
  shift
  : > "$docker_log"
  (
    cd "$project"
    PATH="$bin_dir:$PATH" MOCK_DOCKER_LOG="$docker_log" \
      DUNE_HOST_REPO_ROOT=/srv/hostrepo DUNE_HOST_UID=1000 DUNE_HOST_GID=1000 \
      DOCKER_SOCKET_GID=103 COMPOSE_PROJECT_NAME=dune-proj \
      env "$@" bash runtime/scripts/schedule-deferred-reconcile.sh
  ) > "$test_root/$label.log" 2>&1
}

# --- Case 1: it runs detached, not as a child of this process --------------
# The whole point: a container the console cannot take down with it.

run_schedule detached || fail "schedule failed" "$test_root/detached.log"
grep -q "^run -d --rm --name dune-deferred-reconcile" "$docker_log" \
  || fail "the reconcile was not started as a detached container" "$docker_log"
grep -q "deferred-reconcile.sh" "$docker_log" \
  || fail "the helper does not run the reconcile" "$docker_log"
echo "PASS deferred-reconcile-runs-detached"

# --- Case 2: it carries what spawn-server.sh refuses to run without --------
# host_path() aborts when DUNE_HOST_REPO_ROOT is unset inside a container, so a
# helper missing it would reach the spawn and fail there instead of here.

for required in "DUNE_HOST_REPO_ROOT=/srv/hostrepo" "DUNE_CONTAINER_REPO_ROOT=/repo" \
  "/srv/hostrepo:/repo" "/var/run/docker.sock:/var/run/docker.sock" "DOCKER_SOCKET_GID=103"; do
  grep -qF -- "$required" "$docker_log" \
    || fail "the helper is missing $required" "$docker_log"
done
echo "PASS deferred-reconcile-carries-host-path-environment"

# --- Case 3: a stale helper is replaced, never duplicated ------------------
# Two waiters would race each other into spawning the same partition twice.

grep -q "^rm -f dune-deferred-reconcile" "$docker_log" \
  || fail "a previous helper is not cleared before starting a new one" "$docker_log"
echo "PASS deferred-reconcile-replaces-a-stale-helper"

# --- Case 4: no console image still gets a reconcile -----------------------
# A host CLI install has no image and no console to be killed by, so the
# in-process job is correct there. Skipping instead would lose the reconcile.

run_schedule noimage MOCK_IMAGE_PRESENT=0 || fail "schedule failed without an image" "$test_root/noimage.log"
if grep -q "^run -d" "$docker_log"; then
  fail "tried to start a helper container without the image present" "$docker_log"
fi
grep -q "in-process" "$test_root/noimage.log" \
  || fail "did not fall back to an in-process reconcile" "$test_root/noimage.log"
echo "PASS deferred-reconcile-falls-back-without-the-image"

# --- Case 5: a failed docker run falls back rather than losing it ----------

run_schedule runfails MOCK_RUN_FAILS=1 || fail "schedule failed when docker run failed" "$test_root/runfails.log"
grep -q "in-process" "$test_root/runfails.log" \
  || fail "a failed helper launch did not fall back" "$test_root/runfails.log"
echo "PASS deferred-reconcile-falls-back-when-the-helper-will-not-start"

# --- Case 6: a failing step is reported, not swallowed --------------------
# Every step is deliberately non-fatal, so one failure does not cost the
# others -- but `|| true` also hid them. A reconcile refusing because Postgres
# is down read exactly like one that ran and found nothing to do.

deferred_project="$test_root/deferred"
mkdir -p "$deferred_project/runtime/scripts" "$deferred_project/runtime/generated"
cp "$repo_root/runtime/scripts/deferred-reconcile.sh" "$deferred_project/runtime/scripts/"

# wait_for_core_ready needs the three core containers up and partitions 1 and 2
# reporting ready; this mock satisfies both so the steps are reached at all.
cat > "$bin_dir/docker" <<'EOF'
#!/usr/bin/env bash
case "${1:-} ${2:-}" in
  "ps --format")
    printf '%s\n' dune-postgres dune-server-survival-1 dune-server-overmap
    ;;
  "exec dune-postgres")
    printf 't\n'
    ;;
esac
exit 0
EOF
chmod +x "$bin_dir/docker"

for stub in spicefield-overrides.sh map-modes.sh publish-sietch-overrides.sh; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$deferred_project/runtime/scripts/$stub"
  chmod +x "$deferred_project/runtime/scripts/$stub"
done
# The one that matters: the Survival_1 reconcile refuses, as it does when
# Postgres is unreachable.
printf '#!/usr/bin/env bash\necho "dune-postgres must be running" >&2\nexit 1\n' \
  > "$deferred_project/runtime/scripts/sietches.sh"
chmod +x "$deferred_project/runtime/scripts/sietches.sh"

deferred_status=0
(
  cd "$deferred_project"
  PATH="$bin_dir:$PATH" bash runtime/scripts/deferred-reconcile.sh
) > "$test_root/deferred.log" 2>&1 || deferred_status=$?

grep -q "Survival_1 dimensions FAILED" "$test_root/deferred.log" \
  || fail "a failing reconcile was not reported" "$test_root/deferred.log"
echo "PASS deferred-reconcile-reports-a-failing-step"

# --- Case 7: one failure does not cost the later steps --------------------

grep -q "sietch override publish ok" "$test_root/deferred.log" \
  || fail "a failure earlier in the sequence stopped the later steps" "$test_root/deferred.log"
echo "PASS deferred-reconcile-continues-past-a-failure"
