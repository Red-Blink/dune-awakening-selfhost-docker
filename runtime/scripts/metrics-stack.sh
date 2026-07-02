#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

command_name="${1:-status}"
compose_file="docker-compose.metrics.yml"
metrics_project_name="${DUNE_METRICS_COMPOSE_PROJECT_NAME:-${DUNE_COMPOSE_PROJECT_NAME:-dune-awakening-selfhost-docker}-metrics}"
prometheus_port="${METRICS_PROMETHEUS_PORT:-}"

if [ -z "$prometheus_port" ] && [ -f .env ]; then
  prometheus_port="$(awk -F= '/^METRICS_PROMETHEUS_PORT=/ {print $2; exit}' .env | sed 's/[[:space:]"]//g' || true)"
fi
prometheus_port="${prometheus_port:-9090}"

compose() {
  COMPOSE_PROJECT_NAME="$metrics_project_name" \
    COMPOSE_IGNORE_ORPHANS=true \
    docker compose -f "$compose_file" "$@"
}

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is not available."
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "Docker is not reachable from this shell."
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    echo "Docker Compose v2 is required."
    exit 1
  fi
}

require_curl_python() {
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required for metrics validation."
    exit 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 is required for metrics validation output parsing."
    exit 1
  fi
}

ensure_compose_file() {
  if [ ! -f "$compose_file" ]; then
    echo "Missing $compose_file."
    exit 1
  fi
}

ensure_network() {
  docker network create dune-net >/dev/null 2>&1 || true
}

print_url() {
  echo "Prometheus: http://127.0.0.1:${prometheus_port}"
}

curl_prometheus() {
  local path="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 3 "http://127.0.0.1:${prometheus_port}${path}"
    return $?
  fi
  return 127
}

query_prometheus() {
  local query="$1"
  curl -fsS --max-time 5 -G "http://127.0.0.1:${prometheus_port}/api/v1/query" \
    --data-urlencode "query=${query}"
}

wait_for_prometheus_targets() {
  local attempt
  [ "${METRICS_SKIP_TARGET_WAIT:-0}" != "1" ] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  command -v python3 >/dev/null 2>&1 || return 0

  for attempt in $(seq 1 10); do
    [ "${METRICS_VERBOSE:-0}" != "1" ] || echo "Waiting for Prometheus targets (${attempt}/10)..."
    if curl_prometheus "/api/v1/targets" >/tmp/dune-prometheus-targets.json 2>/dev/null; then
      if python3 - <<'PY'
import json
from pathlib import Path
payload = json.loads(Path('/tmp/dune-prometheus-targets.json').read_text())
raise SystemExit(0 if payload.get('data', {}).get('activeTargets') else 1)
PY
      then
        rm -f /tmp/dune-prometheus-targets.json
        return 0
      fi
    fi
    sleep 1
  done
  rm -f /tmp/dune-prometheus-targets.json
}

show_targets() {
  if command -v curl >/dev/null 2>&1 && curl_prometheus "/api/v1/targets" >/tmp/dune-prometheus-targets.json 2>/dev/null; then
    if command -v python3 >/dev/null 2>&1; then
      python3 - <<'PY'
import json
from pathlib import Path
payload = json.loads(Path('/tmp/dune-prometheus-targets.json').read_text())
active_targets = payload.get('data', {}).get('activeTargets', [])
print(f"active_targets={len(active_targets)}")
if not active_targets:
    print("No active Prometheus targets reported yet. This is not a passing validation state; re-run status or inspect /api/v1/targets.")
for target in active_targets:
    labels = target.get('labels', {})
    job = labels.get('job', '-')
    instance = labels.get('instance', '-')
    health = target.get('health', '-')
    last_error = target.get('lastError') or ''
    suffix = f" ({last_error})" if last_error else ''
    print(f"{job}\t{instance}\t{health}{suffix}")
PY
    else
      echo "Target API reachable. Install python3 for formatted target output."
    fi
    rm -f /tmp/dune-prometheus-targets.json
  else
    echo "target API unavailable"
  fi
}

show_status() {
  require_docker
  ensure_compose_file

  echo "=== Metrics containers ==="
  docker ps -a \
    --filter "name=dune-prometheus" \
    --filter "name=dune-node-exporter" \
    --filter "name=dune-cadvisor" \
    --filter "name=dune-postgres-exporter" \
    --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" || true

  echo
  echo "=== Prometheus health ==="
  if curl_prometheus "/-/healthy" >/dev/null 2>&1; then
    echo "healthy"
    print_url
  else
    echo "not reachable on 127.0.0.1:${prometheus_port}"
  fi

  echo
  echo "=== Prometheus targets ==="
  show_targets
}

validate_metrics() {
  require_docker
  require_curl_python
  ensure_compose_file

  local fail=0
  local tmp_targets tmp_rules tmp_up tmp_pg
  tmp_targets="$(mktemp)"
  tmp_rules="$(mktemp)"
  tmp_up="$(mktemp)"
  tmp_pg="$(mktemp)"

  echo "=== Metrics validation ==="
  print_url

  echo
  echo "Checking Prometheus health..."
  if curl_prometheus "/-/healthy" >/dev/null 2>&1; then
    echo "OK   Prometheus health"
  else
    echo "FAIL Prometheus is not healthy on 127.0.0.1:${prometheus_port}"
    fail=1
  fi

  echo
  echo "Checking Prometheus targets..."
  if curl_prometheus "/api/v1/targets" >"$tmp_targets" 2>/dev/null; then
    if ! python3 - "$tmp_targets" <<'PY'
import json
import sys
from pathlib import Path
payload = json.loads(Path(sys.argv[1]).read_text())
targets = payload.get('data', {}).get('activeTargets', [])
expected = {'dune-prometheus', 'dune-node', 'dune-cadvisor', 'dune-postgres'}
seen = {target.get('labels', {}).get('job') for target in targets}
missing = sorted(expected - seen)
print(f"active_targets={len(targets)}")
for target in targets:
    labels = target.get('labels', {})
    job = labels.get('job', '-')
    instance = labels.get('instance', '-')
    health = target.get('health', '-')
    last_error = target.get('lastError') or ''
    suffix = f" ({last_error})" if last_error else ''
    print(f"{job}\t{instance}\t{health}{suffix}")
if missing:
    print("Missing required jobs: " + ", ".join(missing))
    raise SystemExit(1)
if not targets:
    print("No active targets returned.")
    raise SystemExit(1)
PY
    then
      fail=1
    fi
  else
    echo "FAIL target API unavailable"
    fail=1
  fi

  echo
  echo "Checking Prometheus rules..."
  if curl_prometheus "/api/v1/rules" >"$tmp_rules" 2>/dev/null; then
    if ! python3 - "$tmp_rules" <<'PY'
import json
import sys
from pathlib import Path
payload = json.loads(Path(sys.argv[1]).read_text())
groups = payload.get('data', {}).get('groups', [])
print(f"rule_groups={len(groups)}")
for group in groups:
    name = group.get('name', '-')
    rules = group.get('rules', [])
    print(f"{name}\trules={len(rules)}")
if not groups:
    print("No rule groups returned.")
    raise SystemExit(1)
PY
    then
      fail=1
    fi
  else
    echo "FAIL rules API unavailable"
    fail=1
  fi

  echo
  echo "Checking scrape health with query: up"
  if query_prometheus "up" >"$tmp_up" 2>/dev/null; then
    if ! python3 - "$tmp_up" <<'PY'
import json
import sys
from pathlib import Path
payload = json.loads(Path(sys.argv[1]).read_text())
results = payload.get('data', {}).get('result', [])
if not results:
    print("No up results returned.")
    raise SystemExit(1)
failed = []
for result in results:
    metric = result.get('metric', {})
    job = metric.get('job', '-')
    instance = metric.get('instance', '-')
    value = result.get('value', [None, '0'])[1]
    print(f"{job}\t{instance}\tup={value}")
    if value != '1':
        failed.append(f"{job}/{instance}={value}")
if failed:
    print("Unhealthy scrape targets: " + ", ".join(failed))
    raise SystemExit(1)
PY
    then
      fail=1
    fi
  else
    echo "FAIL Prometheus query failed: up"
    fail=1
  fi

  echo
  echo "Checking Postgres exporter with query: pg_up"
  if query_prometheus "pg_up" >"$tmp_pg" 2>/dev/null; then
    if ! python3 - "$tmp_pg" <<'PY'
import json
import sys
from pathlib import Path
payload = json.loads(Path(sys.argv[1]).read_text())
results = payload.get('data', {}).get('result', [])
if not results:
    print("No pg_up results returned.")
    raise SystemExit(1)
failed = []
for result in results:
    metric = result.get('metric', {})
    job = metric.get('job', '-')
    instance = metric.get('instance', '-')
    value = result.get('value', [None, '0'])[1]
    print(f"{job}\t{instance}\tpg_up={value}")
    if value != '1':
        failed.append(f"{job}/{instance}={value}")
if failed:
    print("Postgres exporter connectivity failed: " + ", ".join(failed))
    raise SystemExit(1)
PY
    then
      fail=1
    fi
  else
    echo "FAIL Prometheus query failed: pg_up"
    fail=1
  fi

  rm -f "$tmp_targets" "$tmp_rules" "$tmp_up" "$tmp_pg"

  echo
  if [ "$fail" -eq 0 ]; then
    echo "READY: metrics validation passed."
  else
    echo "FAIL: metrics validation failed."
  fi
  return "$fail"
}

case "$command_name" in
  start|up)
    require_docker
    ensure_compose_file
    ensure_network
    echo "Starting Dune metrics stack..."
    compose up -d
    wait_for_prometheus_targets || true
    echo
    show_status
    ;;

  stop|down)
    require_docker
    ensure_compose_file
    echo "Stopping Dune metrics stack..."
    compose down
    ;;

  restart)
    require_docker
    ensure_compose_file
    ensure_network
    echo "Restarting Dune metrics stack..."
    compose down
    compose up -d
    wait_for_prometheus_targets || true
    echo
    show_status
    ;;

  status|ps)
    show_status
    ;;

  validate|check)
    validate_metrics
    ;;

  logs)
    require_docker
    ensure_compose_file
    shift || true
    compose logs "$@"
    ;;

  config)
    require_docker
    ensure_compose_file
    compose config
    ;;

  pull)
    require_docker
    ensure_compose_file
    compose pull
    ;;

  help|--help|-h)
    cat <<EOF
Usage:
  dune metrics start
  dune metrics stop
  dune metrics restart
  dune metrics status
  dune metrics validate
  dune metrics logs [service]
  dune metrics config
  dune metrics pull

The metrics stack is opt-in and independent from the game stack.
Prometheus binds to 127.0.0.1:${prometheus_port} by default.
Metrics compose project: ${metrics_project_name}
EOF
    ;;

  *)
    echo "Unknown metrics command: $command_name"
    echo "Run: dune metrics --help"
    exit 1
    ;;
esac
