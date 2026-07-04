#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

test_no=0

note() {
  printf '# %s\n' "$*"
}

ok() {
  test_no=$((test_no + 1))
  printf 'ok %02d - %s\n' "$test_no" "$*"
}

fail() {
  test_no=$((test_no + 1))
  printf 'not ok %02d - %s\n' "$test_no" "$*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local expected="$2"
  local label="$3"

  if grep -Fq -- "$expected" "$file"; then
    ok "$label"
    return 0
  fi

  echo "Expected to find: $expected" >&2
  echo "--- output ---" >&2
  cat "$file" >&2
  echo "--------------" >&2
  fail "$label"
}

assert_command_fails() {
  local output_file="$1"
  local label="$2"
  shift 2

  if "$@" >"$output_file" 2>&1; then
    echo "--- unexpected success output ---" >&2
    cat "$output_file" >&2
    echo "-------------------------------" >&2
    fail "$label"
  fi

  ok "$label"
}

show_output_block() {
  local title="$1"
  local file="$2"

  note "$title"
  sed 's/^/#   /' "$file"
}

echo "TAP version 13"
note "metrics-stack unit tests"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
mkdir -p "$tmpdir/bin"
ok "created isolated test harness directory"

cat >"$tmpdir/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  info)
    exit 0
    ;;
  compose)
    shift || true
    case "${1:-}" in
      version)
        echo "Docker Compose version v2.test"
        exit 0
        ;;
      -f)
        # Support: docker compose -f docker-compose.metrics.yml config
        if [ "${3:-}" = "config" ]; then
          echo "services: {}"
          exit 0
        fi
        ;;
    esac
    echo "unexpected docker compose args: $*" >&2
    exit 1
    ;;
  ps)
    cat <<'PS'
NAMES                    STATUS                    PORTS
dune-prometheus          Up 1 minute               127.0.0.1:9090->9090/tcp
dune-cadvisor            Up 1 minute (healthy)     8080/tcp
dune-node-exporter       Up 1 minute               9100/tcp
dune-postgres-exporter   Up 1 minute               9187/tcp
PS
    exit 0
    ;;
  network)
    exit 0
    ;;
  *)
    echo "unexpected docker args: $*" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$tmpdir/bin/docker"
ok "installed fake docker command"

cat >"$tmpdir/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"${FAKE_CURL_LOG:?FAKE_CURL_LOG is required}"
args=" $* "
mode="${FAKE_PROMETHEUS_MODE:-ok}"

if [[ "$args" == *"/-/healthy"* ]]; then
  echo "healthy"
  exit 0
fi

if [[ "$args" == *"/api/v1/targets"* ]]; then
  if [ "$mode" = "missing-target" ]; then
    cat <<'JSON'
{"status":"success","data":{"activeTargets":[
  {"labels":{"job":"dune-prometheus","instance":"dune-prometheus:9090"},"health":"up"},
  {"labels":{"job":"dune-cadvisor","instance":"dune-cadvisor:8080"},"health":"up"},
  {"labels":{"job":"dune-postgres","instance":"dune-postgres-exporter:9187"},"health":"up"}
]}}
JSON
  else
    cat <<'JSON'
{"status":"success","data":{"activeTargets":[
  {"labels":{"job":"dune-prometheus","instance":"dune-prometheus:9090"},"health":"up"},
  {"labels":{"job":"dune-node","instance":"dune-node-exporter:9100"},"health":"up"},
  {"labels":{"job":"dune-cadvisor","instance":"dune-cadvisor:8080"},"health":"up"},
  {"labels":{"job":"dune-postgres","instance":"dune-postgres-exporter:9187"},"health":"up"},
  {"labels":{"job":"dune-rabbitmq-admin","instance":"dune-rmq-admin:15692"},"health":"up"},
  {"labels":{"job":"dune-rabbitmq-game","instance":"dune-rmq-game:15692"},"health":"up"}
]}}
JSON
  fi
  exit 0
fi

if [[ "$args" == *"/api/v1/rules"* ]]; then
  cat <<'JSON'
{"status":"success","data":{"groups":[
  {"name":"dune-host","rules":[{"name":"DuneHostHighCpu"}]},
  {"name":"dune-containers","rules":[{"name":"DuneContainerMetricsMissing"}]},
  {"name":"dune-postgres","rules":[{"name":"DunePostgresDown"}]},
  {"name":"dune-rabbitmq","rules":[{"name":"DuneRabbitmqDown"}]},
  {"name":"dune-stack","rules":[]}
]}}
JSON
  exit 0
fi

if [[ "$args" == *"query=pg_up"* ]]; then
  cat <<'JSON'
{"status":"success","data":{"resultType":"vector","result":[
  {"metric":{"job":"dune-postgres","instance":"dune-postgres-exporter:9187"},"value":[1782798595.497,"1"]}
]}}
JSON
  exit 0
fi

if [[ "$args" == *"query=up"* ]]; then
  cat <<'JSON'
{"status":"success","data":{"resultType":"vector","result":[
  {"metric":{"job":"dune-postgres","instance":"dune-postgres-exporter:9187"},"value":[1782798595.478,"1"]},
  {"metric":{"job":"dune-cadvisor","instance":"dune-cadvisor:8080"},"value":[1782798595.478,"1"]},
  {"metric":{"job":"dune-rabbitmq-admin","instance":"dune-rmq-admin:15692"},"value":[1782798595.478,"1"]},
  {"metric":{"job":"dune-rabbitmq-game","instance":"dune-rmq-game:15692"},"value":[1782798595.478,"1"]},
  {"metric":{"job":"dune-prometheus","instance":"dune-prometheus:9090"},"value":[1782798595.478,"1"]},
  {"metric":{"job":"dune-node","instance":"dune-node-exporter:9100"},"value":[1782798595.478,"1"]}
]}}
JSON
  exit 0
fi

echo "unexpected curl args: $*" >&2
exit 1
EOF
chmod +x "$tmpdir/bin/curl"
ok "installed fake curl/Prometheus command"

export PATH="$tmpdir/bin:$PATH"
export FAKE_CURL_LOG="$tmpdir/curl.log"
ok "wired fake commands into PATH"

note "running happy-path metrics validation"
pass_output="$tmpdir/pass.out"
: >"$FAKE_CURL_LOG"
METRICS_PROMETHEUS_PORT=9090 bash runtime/scripts/metrics-stack.sh validate >"$pass_output"
show_output_block "happy-path validator output" "$pass_output"
assert_contains "$pass_output" "OK   Prometheus health" "validator reports Prometheus health"
assert_contains "$pass_output" "active_targets=6" "validator counts all six active targets"
assert_contains "$pass_output" "dune-rabbitmq-admin" "validator includes RabbitMQ admin target"
assert_contains "$pass_output" "dune-rabbitmq-game" "validator includes RabbitMQ game target"
assert_contains "$pass_output" "rule_groups=5" "validator reports loaded rule groups"
assert_contains "$pass_output" "pg_up=1" "validator confirms Postgres exporter connectivity"
assert_contains "$pass_output" "READY: metrics validation passed." "validator returns READY on healthy fixtures"
assert_contains "$FAKE_CURL_LOG" "--data-urlencode query=up" "validator URL-encodes the up query"
assert_contains "$FAKE_CURL_LOG" "--data-urlencode query=pg_up" "validator URL-encodes the pg_up query"

note "running required-target failure validation"
missing_output="$tmpdir/missing.out"
assert_command_fails "$missing_output" "validator fails when required target is missing" \
  env FAKE_PROMETHEUS_MODE=missing-target METRICS_PROMETHEUS_PORT=9090 bash runtime/scripts/metrics-stack.sh validate
show_output_block "missing-target validator output" "$missing_output"
assert_contains "$missing_output" "Missing required jobs: dune-node" "validator names missing required target"
assert_contains "$missing_output" "FAIL: metrics validation failed." "validator prints failure summary"

echo "1..$test_no"
note "metrics-stack unit tests completed"
