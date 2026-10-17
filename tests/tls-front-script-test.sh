#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# A scratch installation with the real script and a docker mock that records its calls.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/runtime/scripts" "$work/runtime/tls-front" "$work/bin"
cp "$repo_root/runtime/scripts/tls-front.sh" "$work/runtime/scripts/"
cp "$repo_root/runtime/scripts/tls-front-config.py" "$work/runtime/scripts/"
cp "$repo_root/docker-compose.tls-front.yml" "$work/"
cp "$repo_root/runtime/tls-front/Dockerfile" "$repo_root/runtime/tls-front/go.mod" "$repo_root/runtime/tls-front/main.go" "$work/runtime/tls-front/"

# sha256sum is not on every development machine; the script only needs a stable hash.
if ! command -v sha256sum >/dev/null 2>&1; then
  printf '#!/bin/sh\nshasum -a 256 "$@"\n' >"$work/bin/sha256sum"
  chmod +x "$work/bin/sha256sum"
fi

calls="$work/docker-calls"
: >"$calls"
running="$work/container-running"
cat >"$work/bin/docker" <<'MOCK'
#!/bin/sh
echo "docker $*" >>"$MOCK_CALLS"
echo "upstream=${DUNE_TLS_FRONT_UPSTREAM:-}" >>"$MOCK_CALLS"
case "$1" in
  ps)
    if [ -e "$MOCK_RUNNING" ]; then echo dune-tls-front; fi
    ;;
  image) exit 1 ;;   # not built yet
  compose)
    case " $* " in
      *" up "*) : >"$MOCK_RUNNING"; mkdir -p "$MOCK_STATE"; : >"$MOCK_STATE/front-cert.pem" ;;
      *" down "*) rm -f "$MOCK_RUNNING" ;;
    esac
    ;;
  exec) echo "sha256/MOCKFINGERPRINTMOCKFINGERPRINTMOCKFINGERPRI" ;;
  inspect) echo "State: running health=healthy" ;;
esac
MOCK
chmod +x "$work/bin/docker"
export MOCK_CALLS="$calls" MOCK_RUNNING="$running" MOCK_STATE="$work/runtime/generated/tls-front"
export PATH="$work/bin:$PATH"

run() { (cd "$work" && ./runtime/scripts/tls-front.sh "$@"); }

# nothing configured: disabled, and no fingerprint is invented
out="$(run status)"
grep -Fq 'State: disabled' <<<"$out" || fail "fresh status is not 'disabled': $out"
if run fingerprint 2>/dev/null; then fail "fingerprint printed although the front door never ran"; fi

# enable: writes the env file, builds, starts, shows the fingerprint
out="$(run enable)"
grep -Fq 'DUNE_TLS_FRONT_ENABLED=true' "$work/runtime/generated/tls-front.env" || fail "enable did not persist the choice"
[ "$(stat -c %a "$work/runtime/generated/tls-front.env" 2>/dev/null || stat -f %Lp "$work/runtime/generated/tls-front.env")" = "600" ] || fail "env file is not private"
grep -Fq 'docker compose -f docker-compose.tls-front.yml build dune-tls-front' "$calls" || fail "image was not built"
grep -Fq 'docker compose -f docker-compose.tls-front.yml up -d --force-recreate' "$calls" || fail "front door was not started"
grep -Fq 'Fingerprint: sha256/MOCKFINGERPRINT' <<<"$out" || fail "status after enable lacks the fingerprint: $out"
fp="$(run fingerprint)"
[ "$fp" = "sha256/MOCKFINGERPRINTMOCKFINGERPRINTMOCKFINGERPRI" ] || fail "fingerprint command output: $fp"
[ -d "$work/runtime/generated/tls-front" ] || fail "state directory missing"

# reconcile keeps the operator's choice
printf 'DUNE_TLS_FRONT_ENABLED=true\nDUNE_TLS_FRONT_PORT=8797\nDUNE_TLS_FRONT_NAMES="one.example two.example"\nDUNE_TLS_FRONT_ALLOW="192.168.1.0/24 10.0.0.0/8"\n' >"$work/runtime/generated/tls-front.env"
run enable >/dev/null
# Re-reading persisted values with spaces must not try to execute them.
: >"$calls"
run reconcile
grep -Fq ' up -d' "$calls" || fail "reconcile did not start an enabled front door"

# disable: persists, stops
# A custom binding/port is used, and changing it is reconciled without BG operations.
printf 'ADMIN_BIND_HOST="192.168.1.20"\nADMIN_BIND_PORT=8099\n' >"$work/.env"
: >"$calls"
run reconcile
grep -Fq 'upstream=http://192.168.1.20:8099' "$calls" || fail "custom Console endpoint was not used"
printf 'ADMIN_BIND_HOST="192.168.1.20"\nADMIN_BIND_PORT=8100\n' >"$work/.env"
: >"$calls"
run reconcile
grep -Fq 'upstream=http://192.168.1.20:8100' "$calls" || fail "changed Console port was not used"
: >"$calls"
run disable >/dev/null
grep -Fq 'DUNE_TLS_FRONT_ENABLED=false' "$work/runtime/generated/tls-front.env" || fail "disable did not persist the choice"
grep -Fq ' down ' "$calls" || fail "disable did not stop the container"
: >"$calls"
run reconcile
if grep -Fq ' up -d' "$calls"; then fail "reconcile started a disabled front door"; fi

# a bad port in the env file is refused, never passed on
printf 'DUNE_TLS_FRONT_ENABLED=true\nDUNE_TLS_FRONT_PORT=80;rm\n' >"$work/runtime/generated/tls-front.env"
if run status >/dev/null 2>&1; then fail "invalid port accepted"; fi

# a request for an unknown command fails
if run frobnicate >/dev/null 2>&1; then fail "unknown command accepted"; fi

echo "tls-front.sh tests passed"
