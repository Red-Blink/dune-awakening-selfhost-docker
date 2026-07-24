#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

mkdir -p "$test_root/project/runtime/scripts" "$test_root/bin" "$test_root/state"
cp "$repo_root/runtime/scripts/update.sh" "$test_root/project/runtime/scripts/update.sh"
cp "$repo_root/runtime/scripts/runtime-env.sh" "$test_root/project/runtime/scripts/runtime-env.sh"
cp "$repo_root/runtime/scripts/steamcmd-signals.sh" "$test_root/project/runtime/scripts/steamcmd-signals.sh"

cat > "$test_root/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
command_name="${1:-}"
unit="${2:-}"
case "$command_name" in
  show)
    property=""
    for argument in "$@"; do
      case "$argument" in
        --property=*) property="${argument#--property=}" ;;
      esac
    done
    case "$property" in
      LoadState) echo loaded ;;
      WorkingDirectory) echo "${MOCK_WORKDIR:?}" ;;
      ExecStart) echo "{ path=${MOCK_WORKDIR:?}/runtime/scripts/update.sh ; argv[]=${MOCK_WORKDIR:?}/runtime/scripts/update.sh auto run ; }" ;;
    esac
    ;;
  is-active) echo active ;;
  is-enabled) echo enabled ;;
  list-timers) echo "mock timer listing for $unit" ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$test_root/bin/systemctl"

state_file="$test_root/state/update-auto.env"
cat > "$state_file" <<'EOF'
DUNE_AUTO_UPDATE_ENABLED=0
DUNE_AUTO_UPDATE_INTERVAL_MINUTES=60
DUNE_AUTO_UPDATE_TIMER_INSTALLED=1
EOF

run_status() {
  (
    cd "$test_root/project"
    PATH="$test_root/bin:$PATH" \
      MOCK_WORKDIR="$1" \
      DUNE_HOST_REPO_ROOT="$test_root/project" \
      DUNE_AUTO_UPDATE_STATE_FILE="$state_file" \
      bash runtime/scripts/update.sh auto status
  )
}

output="$(run_status "$test_root/project")"
grep -Fq "Systemd timer: active" <<<"$output"
grep -Fq "WARN Auto-update timer is active while auto updates are disabled in this checkout." <<<"$output"

sed -i 's/DUNE_AUTO_UPDATE_ENABLED=0/DUNE_AUTO_UPDATE_ENABLED=1/' "$state_file"
output="$(run_status /home/old/dune-work/e2e-ops-health)"
grep -Fq "Systemd timer: active" <<<"$output"
grep -Fq "WARN Auto-update service uses WorkingDirectory=/home/old/dune-work/e2e-ops-health; expected $test_root/project." <<<"$output"
grep -Fq "WARN Auto-update service ExecStart does not use the current checkout: $test_root/project." <<<"$output"

output="$(run_status "$test_root/project")"
if grep -q '^WARN ' <<<"$output"; then
  printf 'Healthy timer unexpectedly reported a warning:\n%s\n' "$output" >&2
  exit 1
fi

echo "auto-update status detects disabled and stale systemd timers"
