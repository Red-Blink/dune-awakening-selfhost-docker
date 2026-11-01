#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# The shipped Compose file keeps the agent as narrow as it can be while it still
# reads game process memory: nothing but ptrace/DAC override, read-only, loopback.
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  python3 - "$repo_root" <<'PY'
import json
import subprocess
import sys
from pathlib import Path

repo = Path(sys.argv[1])
result = subprocess.run([
    'docker', 'compose', '--project-directory', str(repo), '--env-file', '/dev/null',
    '-f', str(repo / 'docker-compose.realtime-agent.yml'), 'config', '--format', 'json',
], capture_output=True, text=True, check=True)
service = json.loads(result.stdout)['services']['dune-realtime-agent']
assert service['pid'] == 'host', service
assert service['network_mode'] == 'host', service
assert service['read_only'] and not service.get('privileged', False), service
assert service['cap_drop'] == ['ALL'], service
assert sorted(service['cap_add']) == ['DAC_OVERRIDE', 'SYS_PTRACE'], service
assert 'no-new-privileges:true' in service['security_opt'], service
assert not service.get('volumes'), 'the agent needs no mounts'
assert not service.get('ports'), 'host networking publishes nothing by itself'
assert '-addr=127.0.0.1:8796' in service['command'], service['command']
assert '-players=false' in service['command'], 'players are off by default'
assert service['build']['args']['MV_COMMIT'] == '7e1a73044023da89d42c9ea3ab3dba133904e8c1', service['build']
print('PASS: agent Compose definition is as narrow as expected')
PY
else
  echo "SKIP: docker compose not available, Compose definition not checked"
fi

grep -Fq 'git -C /src rev-parse HEAD' "$repo_root/runtime/realtime-agent/Dockerfile" || fail "Dockerfile does not verify the source commit"
grep -Eq '@sha256:[0-9a-f]{64}' "$repo_root/runtime/realtime-agent/Dockerfile" || fail "base images are not pinned by digest"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/runtime/scripts" "$work/bin"
cp "$repo_root/runtime/scripts/realtime-agent.sh" "$work/runtime/scripts/"
cp "$repo_root/docker-compose.realtime-agent.yml" "$work/"

calls="$work/docker-calls"
: >"$calls"
running="$work/container-running"
cat >"$work/bin/docker" <<'MOCK'
#!/bin/sh
echo "docker $*" >>"$MOCK_CALLS"
case "$1" in
  ps)
    if [ -e "$MOCK_RUNNING" ]; then echo dune-realtime-agent; fi
    ;;
  compose)
    case " $* " in
      *" up "*) : >"$MOCK_RUNNING" ;;
      *" down "*) rm -f "$MOCK_RUNNING" ;;
    esac
    ;;
  inspect)
    if [ -e "$MOCK_EXITED" ]; then echo "State: exited"; else echo "State: running"; fi
    ;;
esac
MOCK
cat >"$work/bin/curl" <<'MOCK'
#!/bin/sh
# the agent answers unless the test marks it as down
[ ! -e "$MOCK_AGENT_DOWN" ]
MOCK
chmod +x "$work/bin/docker" "$work/bin/curl"
export MOCK_CALLS="$calls" MOCK_RUNNING="$running" MOCK_EXITED="$work/container-exited" MOCK_AGENT_DOWN="$work/agent-down"
export PATH="$work/bin:$PATH"

run() { (cd "$work" && ./runtime/scripts/realtime-agent.sh "$@"); }

out="$(run status)"
grep -Fq 'State: disabled' <<<"$out" || fail "fresh status is not 'disabled': $out"

out="$(run enable)"
grep -Fq 'DUNE_REALTIME_AGENT_ENABLED=true' "$work/runtime/generated/realtime-agent.env" || fail "enable did not persist the choice"
[ "$(stat -c %a "$work/runtime/generated/realtime-agent.env" 2>/dev/null || stat -f %Lp "$work/runtime/generated/realtime-agent.env")" = "600" ] || fail "env file is not private"
grep -Fq 'docker compose -f docker-compose.realtime-agent.yml build dune-realtime-agent' "$calls" || fail "image was not built"
grep -Fq 'docker compose -f docker-compose.realtime-agent.yml up -d --force-recreate' "$calls" || fail "agent was not started"
grep -Fq 'State: running' <<<"$out" || fail "status after enable: $out"

# A start whose agent never answers is a failure: non-zero exit, and the state is shown
: >"$work/agent-down"
: >"$work/container-exited"
set +e
out="$(DUNE_REALTIME_AGENT_WAIT_SECONDS=2 run enable 2>&1)"
code=$?
set -e
[ "$code" -ne 0 ] || fail "enable reported success although the agent never answered: $out"
grep -Fq 'did not answer' <<<"$out" || fail "enable gave no reason for the failure: $out"
grep -Fq 'State: exited' <<<"$out" || fail "enable did not show the container state: $out"
rm -f "$work/agent-down" "$work/container-exited"
# a non-numeric wait falls back to the default instead of failing the arithmetic
out="$(DUNE_REALTIME_AGENT_WAIT_SECONDS=abc run enable 2>&1)"
grep -Fq 'State: running' <<<"$out" || fail "bad wait value broke enable: $out"

: >"$calls"
run reconcile
grep -Fq ' up -d' "$calls" || fail "reconcile did not start an enabled agent"

: >"$calls"
run disable >/dev/null
grep -Fq 'DUNE_REALTIME_AGENT_ENABLED=false' "$work/runtime/generated/realtime-agent.env" || fail "disable did not persist the choice"
grep -Fq ' down ' "$calls" || fail "disable did not stop the container"
grep -Fq 'docker image rm dune-realtime-agent:dev' "$calls" || fail "disable did not remove the image"
: >"$calls"
run reconcile
if grep -Fq ' up -d' "$calls"; then fail "reconcile started a disabled agent"; fi

if run frobnicate >/dev/null 2>&1; then fail "unknown command accepted"; fi

echo "realtime-agent.sh tests passed"
