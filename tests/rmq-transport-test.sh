#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

lib="runtime/scripts/lib/rabbitmq.sh"
bash -n "$lib"

# The management port has to actually be published, or the seam can only ever
# fall back. lib/ports.sh owns the default alongside its siblings.
grep -Fq -- '-p "127.0.0.1:${RMQ_ADMIN_HTTP_PORT}:15672/tcp"' runtime/scripts/start-rabbitmq.sh
grep -Fq 'RMQ_ADMIN_HTTP_PORT="$(resolve_rmq_admin_http_port)"' runtime/scripts/start-rabbitmq.sh
grep -Fq 'resolve_rmq_admin_http_port() { port_env_value RMQ_ADMIN_HTTP_PORT 32574; }' runtime/scripts/lib/ports.sh

# Both publishers must route through the seam rather than straight to the exec.
for publisher in publish-deepdesert-overrides.sh publish-sietch-overrides.sh; do
  grep -Fq 'source runtime/scripts/lib/rabbitmq.sh' "runtime/scripts/$publisher"
  grep -Fq 'dune_rmq_http_try "$rmq_user" "$rmq_password" "$@"' "runtime/scripts/$publisher"
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

# A curl that records what it was asked to send and answers 200 with a canned
# body, so the assertions below are about the request the seam builds.
cat > "$work/bin/curl" <<'STUB'
#!/usr/bin/env bash
out=""; url=""; body=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    --data-binary) body="$(cat "${2#@}")"; shift 2 ;;
    http://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
cat > "$CURL_STDIN_CAPTURE"
printf '%s\n' "$url" > "$CURL_URL_CAPTURE"
printf '%s\n' "$body" > "$CURL_BODY_CAPTURE"
[ -n "$out" ] && printf '%s' "${CURL_RESPONSE_BODY:-[]}" > "$out"
printf '%s' "${CURL_HTTP_CODE:-200}"
STUB
chmod +x "$work/bin/curl"
PATH="$work/bin:$PATH"

export CURL_STDIN_CAPTURE="$work/stdin" CURL_URL_CAPTURE="$work/url" CURL_BODY_CAPTURE="$work/body"

# shellcheck source=runtime/scripts/lib/rabbitmq.sh
source "$lib"

fail() { echo "FAIL: $1" >&2; exit 1; }

# --- publish ------------------------------------------------------------------
# A payload with a quote and a backslash: the body is built with json.dumps, so
# this must survive as data rather than breaking the JSON.
payload='{"partitionId":1,"label":"say \"hi\"\\"}'
dune_rmq_http_try user pass publish \
  exchange='dune.filter' \
  routing_key='server_state' \
  properties='{"content_type":"Content","type":"server_state"}' \
  payload="$payload" \
  || fail "publish returned $?"

grep -Fq '/api/exchanges/%2F/dune.filter/publish' "$work/url" \
  || fail "publish URL wrong: $(cat "$work/url")"

RMQ_EXPECT_PAYLOAD="$payload" python3 - "$work/body" <<'PY' || fail "publish body wrong"
import json, os, sys
body = json.load(open(sys.argv[1]))
assert body["routing_key"] == "server_state", body
assert body["payload_encoding"] == "string", body
assert body["payload"] == os.environ["RMQ_EXPECT_PAYLOAD"], body["payload"]
assert body["properties"] == {"content_type": "Content", "type": "server_state"}, body
PY

# Credentials must travel on stdin, never in argv where ps would show them.
grep -Fq 'user = "user:pass"' "$work/stdin" || fail "credentials not passed on stdin"

# --- get ----------------------------------------------------------------------
# raw_json is the response body verbatim, which is what the forwarder parses.
export CURL_RESPONSE_BODY='[{"payload":"{}"}]'
got="$(dune_rmq_http_try user pass --format=raw_json get \
  queue='dune.sietch.filter' count=20 ackmode=ack_requeue_false)" \
  || fail "get returned $?"
[ "$got" = '[{"payload":"{}"}]' ] || fail "get did not return the body verbatim: $got"

grep -Fq '/api/queues/%2F/dune.sietch.filter/get' "$work/url" \
  || fail "get URL wrong: $(cat "$work/url")"

python3 - "$work/body" <<'PY' || fail "get body wrong"
import json, sys
body = json.load(open(sys.argv[1]))
assert body["count"] == 20, body
assert body["ackmode"] == "ack_requeue_false", body
assert body["encoding"] == "auto", body
# A truncated payload would not survive the forwarder's json.loads.
assert "truncate" not in body, body
PY

# --- what the seam deliberately does not translate ----------------------------
expect_unsupported() {
  local label="$1"; shift
  local rc=0
  dune_rmq_http_try user pass "$@" >/dev/null 2>&1 || rc=$?
  [ "$rc" -eq "$RMQ_HTTP_UNSUPPORTED" ] \
    || fail "$label should have been unsupported (got $rc), so the caller cannot fall back"
}

# Route setup runs at most every ROUTE_REFRESH_SECONDS, so it stays on the exec.
# These are turned away by the argument loop, because each carries a key the seam
# does not translate (name=, source=, destination=).
expect_unsupported 'declare exchange' declare exchange name=dune.filter type=direct durable=true
expect_unsupported 'declare binding'  declare binding source=a destination=b destination_type=queue
expect_unsupported 'delete binding'   delete binding source=a destination=b
expect_unsupported 'purge queue'      purge queue name=dune.sietch.filter
# An argument the seam does not understand must never be silently dropped, even
# on a verb it does translate: publishing to the wrong vhost would look like
# success while the message went somewhere else.
expect_unsupported 'unknown argument' publish exchange=x payload=y vhost=/other

# These reach the verb switch itself, every argument having been understood, and
# it is the verb that has to turn them away. Without a case like this the
# switch's default branch is never exercised -- the argument loop rejects the
# route-setup calls above long before the verb is looked at.
expect_unsupported 'list, a verb with no fast leg' list queue=q
# get without raw_json would need rabbitmqadmin's own table rendering.
expect_unsupported 'get, table format' get queue=q count=1 ackmode=ack_requeue_false

# --- failure handling ---------------------------------------------------------
# An HTTP error is a real failure the caller retries with fresh credentials, not
# an unsupported verb -- returning 66 here would exec instead of re-reading them.
rc=0
CURL_HTTP_CODE="401" dune_rmq_http_try user pass publish exchange=x payload=y >/dev/null 2>&1 || rc=$?
[ "$rc" -ne 0 ] || fail "a 401 was treated as success"
[ "$rc" -ne "$RMQ_HTTP_UNSUPPORTED" ] || fail "a 401 was reported as unsupported instead of a failure"

# A refused connection is the deployment lacking the published port: the caller
# must be told to exec.
cat > "$work/bin/curl" <<'STUB'
#!/usr/bin/env bash
cat > /dev/null
exit 7
STUB
chmod +x "$work/bin/curl"
_dune_rmq_transport=""
rc=0
dune_rmq_http_try user pass publish exchange=x payload=y >/dev/null 2>&1 || rc=$?
[ "$rc" -eq "$RMQ_HTTP_UNSUPPORTED" ] \
  || fail "an unreachable management port must fall back to the exec (got $rc)"

# --- pinning ------------------------------------------------------------------
_dune_rmq_transport=""
rc=0
DUNE_RMQ_TRANSPORT="exec" dune_rmq_http_try user pass publish exchange=x payload=y >/dev/null 2>&1 || rc=$?
[ "$rc" -eq "$RMQ_HTTP_UNSUPPORTED" ] || fail "DUNE_RMQ_TRANSPORT=exec did not pin the exec leg"

_dune_rmq_transport=""
DUNE_RMQ_TRANSPORT="nonsense" dune_rmq_transport >/dev/null 2>&1 \
  && fail "an invalid DUNE_RMQ_TRANSPORT was accepted"

# --- the caller can actually honour a failure ---------------------------------
# Everything above tests the library. The contract that matters in production is
# the publishers' rmq_admin wrapper: its comment promises that "a real failure
# retries once with freshly read credentials", and a 401 from stale credentials
# is routine because they are scraped from rotating director logs.
#
# That wrapper runs under `set -euo pipefail` and publish_payload calls it bare
# from a `while read` loop, so any unprotected failing command inside it aborts
# the whole publisher instead of retrying. Testing it through `|| rc=$?` would
# prove nothing: that exemption propagates into the function and suppresses the
# very errexit being tested. So the driver below calls it bare, exactly as
# publish_payload does, and the assertion is on evidence the function left
# behind rather than on the driver's own survival -- the driver is expected to
# die on the final non-zero return, which is the caller's business.
#
# The function text is lifted out of the shipped scripts rather than copied
# here, so this cannot pass against a stale duplicate.

cat > "$work/bin/curl" <<'STUB'
#!/usr/bin/env bash
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cat > /dev/null
[ -n "$out" ] && printf '%s' '{"error":"not_authorised"}' > "$out"
printf '%s' "${CURL_HTTP_CODE:-200}"
STUB
chmod +x "$work/bin/curl"

# A docker that records the fallback exec instead of running one.
cat > "$work/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_CALLS"
exit 1
STUB
chmod +x "$work/bin/docker"

repo_root="$PWD"

for publisher in publish-sietch-overrides.sh publish-deepdesert-overrides.sh; do
  awk '/^rmq_admin\(\) \{/,/^\}/' "runtime/scripts/$publisher" > "$work/rmq_admin.sh"
  grep -Fq 'dune_rmq_http_try' "$work/rmq_admin.sh" \
    || fail "could not lift rmq_admin out of $publisher"

  cat > "$work/driver.sh" <<'DRIVER'
set -euo pipefail
cd "$REPO_ROOT"
# shellcheck source=runtime/scripts/lib/rabbitmq.sh
source runtime/scripts/lib/rabbitmq.sh
RMQ_TIMEOUT_SECONDS=5
RMQ_CREDS_FILE="$WORK/creds-file"
: > "$RMQ_CREDS_FILE"
# Each read is recorded, so the retry is observable from outside.
load_rmq_admin_creds() { printf 'read\n' >> "$CREDS_READS"; printf '%s\n%s\n' user pass; }
source "$WORK/rmq_admin.sh"
# Bare, exactly as publish_payload calls it.
rmq_admin publish exchange=dune.filter routing_key=k payload=p >/dev/null
DRIVER

  # A 401 on a verb the seam translates: two credential reads, and no exec,
  # because an HTTP error is a real failure rather than an unsupported verb.
  : > "$work/creds-reads"
  : > "$work/docker-calls"
  rc=0
  env REPO_ROOT="$repo_root" WORK="$work" \
      CREDS_READS="$work/creds-reads" DOCKER_CALLS="$work/docker-calls" \
      CURL_HTTP_CODE=401 CURL_STDIN_CAPTURE=/dev/null \
      CURL_URL_CAPTURE=/dev/null CURL_BODY_CAPTURE=/dev/null \
      bash "$work/driver.sh" >/dev/null 2>&1 || rc=$?

  reads="$(wc -l < "$work/creds-reads" | tr -d '[:space:]')"
  [ "$reads" -eq 2 ] \
    || fail "$publisher: a 401 must refresh credentials and retry once (credentials read $reads time(s), expected 2)"
  [ ! -s "$work/docker-calls" ] \
    || fail "$publisher: a 401 is a real failure, not an unsupported verb, so it must not exec rabbitmqadmin"
  [ "$rc" -ne 0 ] \
    || fail "$publisher: rmq_admin reported success after two 401s"

  # A verb the seam does not translate must still reach the exec fallback, and
  # that fallback's own failure must not skip the retry either.
  : > "$work/creds-reads"
  : > "$work/docker-calls"
  sed -i 's/^rmq_admin publish .*/rmq_admin declare queue name=q durable=true >\/dev\/null/' "$work/driver.sh"
  rc=0
  env REPO_ROOT="$repo_root" WORK="$work" \
      CREDS_READS="$work/creds-reads" DOCKER_CALLS="$work/docker-calls" \
      CURL_STDIN_CAPTURE=/dev/null CURL_URL_CAPTURE=/dev/null CURL_BODY_CAPTURE=/dev/null \
      bash "$work/driver.sh" >/dev/null 2>&1 || rc=$?

  reads="$(wc -l < "$work/creds-reads" | tr -d '[:space:]')"
  [ "$reads" -eq 2 ] \
    || fail "$publisher: a failing exec fallback must also retry once (credentials read $reads time(s), expected 2)"
  grep -Fq 'rabbitmqadmin' "$work/docker-calls" \
    || fail "$publisher: an untranslated verb did not reach the rabbitmqadmin exec"
  [ "$rc" -ne 0 ] \
    || fail "$publisher: rmq_admin reported success after two failed execs"
done


# --- the game broker's connection list ----------------------------------------
# A separate leg with a separate contract: it needs credentials, it must find
# them without an exec of its own, and every way it can fail has to end in
# RMQ_HTTP_UNSUPPORTED so the caller runs the rabbitmqctl it ran before.

# The loopback management port has to be published, as for the admin broker.
grep -Fq -- '-p "127.0.0.1:${RMQ_GAME_LOCAL_HTTP_PORT}:15672/tcp"' runtime/scripts/start-rabbitmq.sh
grep -Fq 'RMQ_GAME_LOCAL_HTTP_PORT="$(resolve_rmq_game_local_http_port)"' runtime/scripts/start-rabbitmq.sh
grep -Fq 'resolve_rmq_game_local_http_port() { port_env_value RMQ_GAME_LOCAL_HTTP_PORT 15672; }' \
  runtime/scripts/lib/ports.sh

# All three callers must route through the seam and keep the exec behind it. A
# caller that dropped its fallback would go blind wherever the seam declines.
for caller in ready.sh status.sh publish-sietch-overrides.sh; do
  grep -Fq 'source runtime/scripts/lib/rabbitmq.sh' "runtime/scripts/$caller" \
    || fail "$caller does not source the rabbitmq library"
  grep -Fq 'dune_rmq_game_connections' "runtime/scripts/$caller" \
    || fail "$caller does not use the connections seam"
  grep -Fq 'rabbitmqctl list_connections user state' "runtime/scripts/$caller" \
    || fail "$caller dropped its rabbitmqctl fallback"
done

# A curl that answers with a canned connections list. Recorded separately from
# the stub above so the publish assertions keep their own captures.
cat > "$work/bin/curl" <<'STUB'
#!/usr/bin/env bash
out=""; url=""; args=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    --data-urlencode) args="$args $2"; shift 2 ;;
    http://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
cat > "$CONN_STDIN_CAPTURE"
printf '%s\n' "$url" > "$CONN_URL_CAPTURE"
printf '%s\n' "$args" > "$CONN_ARGS_CAPTURE"
[ -n "$out" ] && printf '%s' "${CONN_RESPONSE_BODY:-[]}" > "$out"
printf '%s' "${CONN_HTTP_CODE:-200}"
STUB
chmod +x "$work/bin/curl"

# Records every engine call so the assertions can tell the two kinds apart: a
# `docker exec` spawns a conmon pair and is the thing being eliminated, while
# `docker logs` starts no process in the container and is allowed. Serves the
# director log when asked for it, and fails anything else.
cat > "$work/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_CALLS"
if [ "$1" = logs ] && [ "$2" = dune-director ]; then
  cat "${DIRECTOR_LOG_FIXTURE:-/dev/null}" || exit 0
  # Only reached if the reader consumed everything; a reader that stops at the
  # match closes the pipe and kills this cat first.
  printf 'drained-the-whole-log\n' >> "$DOCKER_CALLS"
  exit 0
fi
exit 1
STUB
chmod +x "$work/bin/docker"

# Asserts on the kind of engine call, not the count: `docker logs` is fine here.
no_exec_happened() {
  ! grep -Eq '(^| )exec( |$)' "$work/docker-calls"
}

# Run from a scratch tree, not the checkout: the credential lookup reads
# runtime/text-router/director-current.log relative to the working directory,
# and a developer's real log must not decide whether this passes.
conn_reset() {
  _dune_rmq_transport=""
  _dune_rmq_admin_user=""
  _dune_rmq_admin_password=""
  _dune_rmq_admin_creds_tried=""
  : > "$work/docker-calls"
}

mkdir -p "$work/tree/runtime/text-router"
export CONN_STDIN_CAPTURE="$work/conn-stdin" CONN_URL_CAPTURE="$work/conn-url" \
       CONN_ARGS_CAPTURE="$work/conn-args" DOCKER_CALLS="$work/docker-calls"
conn_log="$work/tree/runtime/text-router/director-current.log"

# Not a real credential: the shape the regex looks for, nothing more.
cat > "$conn_log" <<'LOG'
[info] Director starting up
[info] Generated new admin credentials: bgd.testgroup.admin / EXAMPLEONLYNOTASECRET
[info] bgd.testgroup.admin/EXAMPLEONLYNOTASECRET => allow administrator
LOG

cd "$work/tree"

# --- the happy path -----------------------------------------------------------
conn_reset
export CONN_RESPONSE_BODY='[{"user":"sg.world.7.overmap","state":"running"},{"user":"admin","state":"blocked"}]'
got="$(dune_rmq_game_connections)" || fail "connections returned $?"

expected="$(printf 'sg.world.7.overmap\trunning\nadmin\tblocked')"
[ "$got" = "$expected" ] \
  || fail "connections did not render rabbitmqctl's two columns: $(printf '%q' "$got")"

# No header row: rabbitmqctl prints one, and status.sh filters it, but ready.sh
# would happily match a server named `user`. Emitting none is the safe shape.
printf '%s\n' "$got" | grep -qv '^user[[:space:]]' || fail "connections emitted a header row"

# The callers' awk has to work on this verbatim -- that is the whole contract.
printf '%s\n' "$got" \
  | awk '$1 ~ /^sg[.]/ && $2 == "running" { found=1 } END { exit(found ? 0 : 1) }' \
  || fail "ready.sh's awk does not match the rendered output"

grep -Fq "/api/connections" "$work/conn-url" || fail "connections URL wrong: $(cat "$work/conn-url")"
grep -Fq "127.0.0.1:15672" "$work/conn-url" \
  || fail "connections did not use the loopback management port: $(cat "$work/conn-url")"
grep -Fq "columns=user,state" "$work/conn-args" \
  || fail "connections did not narrow the response to the two columns it needs"

# Credentials on stdin, as everywhere else in this seam.
grep -Fq 'user = "bgd.testgroup.admin:EXAMPLEONLYNOTASECRET"' "$work/conn-stdin" \
  || fail "connections did not read credentials from the director log, or passed them in argv"

# The point of the exercise: no exec on the fast path. A credential lookup that
# ran ensure_text_router_log -- a `docker exec` -- would trade one exec for
# another and save nothing. Here the maintained log hits, so nothing at all is
# asked of the engine.
[ ! -s "$work/docker-calls" ] \
  || fail "the connections seam called docker although the log had credentials: $(cat "$work/docker-calls")"

# An empty list is a successful answer -- no game server has connected yet --
# not a reason to exec.
conn_reset
# Both halves are assignments, so this sets CONN_RESPONSE_BODY for good rather
# than for one command; the cases below restore it deliberately.
CONN_RESPONSE_BODY='[]' got="$(dune_rmq_game_connections)" || fail "an empty connection list was treated as a failure"
[ -z "$got" ] || fail "an empty list rendered something: $(printf '%q' "$got")"
CONN_RESPONSE_BODY='[{"user":"sg.world.7.overmap","state":"running"}]'

# --- every way it declines ----------------------------------------------------
expect_conn_unsupported() {
  local label="$1"
  local rc=0
  dune_rmq_game_connections >/dev/null 2>&1 || rc=$?
  [ "$rc" -eq "$RMQ_HTTP_UNSUPPORTED" ] \
    || fail "$label should have been unsupported (got $rc), so the caller cannot fall back"
}

# --- the second credential source ---------------------------------------------
# The maintained log is a `tail -n 4000` of a log inside dune-text-router and
# the credentials are announced once at director startup, so on a live host it
# almost never has them: measured zero matches eight minutes after boot. That
# made the first version of this seam decline every single time while the
# callers execed exactly as before, which is the failure these two cases exist
# to catch. `docker logs` is the fallback because it starts no process in the
# container -- it is not the `docker exec` the seam is here to remove.
export DIRECTOR_LOG_FIXTURE="$work/director-container.log"
cat > "$DIRECTOR_LOG_FIXTURE" <<'LOG'
[info] Director starting up
[info] Generated new admin credentials: bgd.fromlogs.admin / LOGSONLYNOTASECRET
[info] steady state
LOG

conn_reset
mv "$conn_log" "$conn_log.saved"
got="$(dune_rmq_game_connections)" \
  || fail "the seam declined although docker logs could supply credentials (rc=$?)"
[ -n "$got" ] || fail "the docker logs path produced no connections"
grep -Fq 'user = "bgd.fromlogs.admin:LOGSONLYNOTASECRET"' "$work/conn-stdin" \
  || fail "credentials did not come from the director container log"
grep -Fq 'logs dune-director' "$work/docker-calls" \
  || fail "the seam did not fall through to docker logs"
no_exec_happened \
  || fail "the credential lookup used an exec: $(cat "$work/docker-calls")"

# The read has to stop at the match rather than drain the log. On a live host
# that log was 191 KB eight minutes in and grows all day, while the credentials
# are on line nineteen -- the difference between a 24 ms read and an unbounded
# one, on the branch whose whole subject is I/O. The fixture is big enough that
# a reader which does not stop is obvious.
conn_reset
{
  printf '[info] Director starting up\n'
  printf '[info] Generated new admin credentials: bgd.early.admin / EARLYNOTASECRET\n'
  # ~2 MB of what comes after, which must never be read.
  for _ in $(seq 1 20000); do
    printf '[info] steady state chatter that the reader must never reach %s\n' "$_"
  done
} > "$DIRECTOR_LOG_FIXTURE"

dune_rmq_game_connections >/dev/null || fail "the early-exit case declined"
grep -Fq 'user = "bgd.early.admin:EARLYNOTASECRET"' "$work/conn-stdin" \
  || fail "the early-exit case did not read the credentials"
! grep -Fq 'drained-the-whole-log' "$work/docker-calls" \
  || fail "the credential lookup read the whole container log instead of stopping at the match"

# Neither source has them: now it is a genuine miss and the caller execs.
conn_reset
: > "$DIRECTOR_LOG_FIXTURE"
expect_conn_unsupported 'no credentials in either source'
no_exec_happened \
  || fail "a credential miss made the seam exec to go looking: $(cat "$work/docker-calls")"

# The maintained log wins when it does have them, so the common case stays free.
conn_reset
mv "$conn_log.saved" "$conn_log"
printf '[info] Generated new admin credentials: bgd.fromfile.admin / FILEONLYNOTASECRET\n' > "$conn_log"
dune_rmq_game_connections >/dev/null || fail "the file source stopped working"
grep -Fq 'user = "bgd.fromfile.admin:FILEONLYNOTASECRET"' "$work/conn-stdin" \
  || fail "the director container log overrode the maintained file"
[ ! -s "$work/docker-calls" ] \
  || fail "the seam called docker although the file had credentials"

conn_reset
printf '[info] nothing useful here\n' > "$conn_log"
: > "$DIRECTOR_LOG_FIXTURE"
expect_conn_unsupported 'a director log with no credentials'
cat > "$conn_log" <<'LOG'
[info] Director starting up
[info] Generated new admin credentials: bgd.testgroup.admin / EXAMPLEONLYNOTASECRET
[info] bgd.testgroup.admin/EXAMPLEONLYNOTASECRET => allow administrator
LOG

# A 401 means the credentials in the log have been rotated out from under us.
# Unlike dune_rmq_http_try, where the caller refreshes and retries, there is
# nothing fresher to read here -- so this must fall back rather than fail, since
# rabbitmqctl authenticates with the Erlang cookie and still works.
conn_reset
CONN_HTTP_CODE=401 expect_conn_unsupported 'a 401 from rotated credentials'

conn_reset
CONN_HTTP_CODE=500 expect_conn_unsupported 'a broken management plugin'

# An unreachable port must fall back -- and must not demote the shared
# transport, because the publishers reach a different broker on a different port
# and would otherwise be pushed back onto the exec by this call.
conn_reset
cat > "$work/bin/curl" <<'STUB'
#!/usr/bin/env bash
cat > /dev/null
exit 7
STUB
chmod +x "$work/bin/curl"
dune_rmq_transport >/dev/null
expect_conn_unsupported 'an unreachable loopback management port'
[ "$(dune_rmq_transport)" = http ] \
  || fail "an unreachable game management port demoted the admin broker's transport too"

# Pinning the exec leg has to turn this off as well.
conn_reset
rc=0
DUNE_RMQ_TRANSPORT="exec" dune_rmq_game_connections >/dev/null 2>&1 || rc=$?
[ "$rc" -eq "$RMQ_HTTP_UNSUPPORTED" ] || fail "DUNE_RMQ_TRANSPORT=exec did not pin the exec leg for connections"

# --- hermetic start-rabbitmq.sh launch-argument regression --------------------
# Verify the actual docker run arguments constructed by start-rabbitmq.sh without
# touching a real broker: default public game HTTP binding, separate localhost
# shortcut, custom game HTTP port profiles, and opt-in RMQ_GAME_HTTP_BIND_IP.
launch_repo="$work/launch-repo"
mkdir -p "$launch_repo/runtime/rabbitmq-game/certs"
cp -R "$repo_root/runtime/scripts" "$launch_repo/runtime/scripts"
touch "$launch_repo/runtime/rabbitmq-game/certs/key.pem" \
      "$launch_repo/runtime/rabbitmq-game/certs/cert.pem" \
      "$launch_repo/runtime/rabbitmq-game/certs/cacert.pem"

cat > "$work/bin/sleep" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$work/bin/sleep"

cat > "$work/bin/docker" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = "run" ]; then
  container=""
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "--name" ]; then
      container="$arg"
      break
    fi
    prev="$arg"
  done
  printf '%s\n' "$*" > "${DOCKER_RUN_CAPTURE_DIR}/${container}.args"
fi
exit 0
STUB
chmod +x "$work/bin/docker"

run_start_rabbitmq_stub() {
  rm -rf "$work/run-captures"
  mkdir -p "$work/run-captures"
  DOCKER_RUN_CAPTURE_DIR="$work/run-captures" "$@" bash "$launch_repo/runtime/scripts/start-rabbitmq.sh" >/dev/null
}

# 1. Default public game binding + separate localhost shortcut + loopback admin broker
run_start_rabbitmq_stub env -u RMQ_GAME_HTTP_BIND_IP -u RMQ_GAME_HTTP_PORT -u RMQ_GAME_LOCAL_HTTP_PORT -u RMQ_GAME_PORT
admin_args="$(cat "$work/run-captures/dune-rmq-admin.args")"
game_args="$(cat "$work/run-captures/dune-rmq-game.args")"
printf '%s\n' "$admin_args" | grep -Fq -- '-p 127.0.0.1:32573:5672' \
  || fail "admin broker AMQP port was not bound to loopback: $admin_args"
printf '%s\n' "$admin_args" | grep -Fq -- '-p 127.0.0.1:32574:15672/tcp' \
  || fail "admin broker HTTP port was not bound to loopback: $admin_args"
printf '%s\n' "$game_args" | grep -Fq -- '-p 31982:5672/tcp' \
  || fail "game broker AMQPS port missing default public binding: $game_args"
printf '%s\n' "$game_args" | grep -Fq -- '-p 127.0.0.1:15672:15672/tcp' \
  || fail "game broker missing separate localhost HTTP shortcut: $game_args"
printf '%s\n' "$game_args" | grep -Fq -- '-p 31983:15672/tcp' \
  || fail "game broker HTTP port must be published publicly on 31983 by default: $game_args"
! printf '%s\n' "$game_args" | grep -Fq -- '127.0.0.1:31983:15672/tcp' \
  || fail "game broker public HTTP port 31983 must not default to loopback: $game_args"

# 2. Custom game HTTP port and localhost shortcut profile via environment / .env
printf 'RMQ_GAME_PORT=32982\nRMQ_GAME_HTTP_PORT=32983\nRMQ_GAME_LOCAL_HTTP_PORT=16672\n' > "$launch_repo/.env"
run_start_rabbitmq_stub env -u RMQ_GAME_HTTP_BIND_IP -u RMQ_GAME_HTTP_PORT -u RMQ_GAME_LOCAL_HTTP_PORT -u RMQ_GAME_PORT
game_args="$(cat "$work/run-captures/dune-rmq-game.args")"
printf '%s\n' "$game_args" | grep -Fq -- '-p 32982:5672/tcp' \
  || fail "custom RMQ_GAME_PORT was not applied: $game_args"
printf '%s\n' "$game_args" | grep -Fq -- '-p 127.0.0.1:16672:15672/tcp' \
  || fail "custom RMQ_GAME_LOCAL_HTTP_PORT was not bound to loopback: $game_args"
printf '%s\n' "$game_args" | grep -Fq -- '-p 32983:15672/tcp' \
  || fail "custom RMQ_GAME_HTTP_PORT must preserve public binding by default: $game_args"

# 3. Explicit opt-in restricted bind IP (with custom and stock port profiles)
run_start_rabbitmq_stub env RMQ_GAME_HTTP_BIND_IP=192.0.2.10
game_args="$(cat "$work/run-captures/dune-rmq-game.args")"
printf '%s\n' "$game_args" | grep -Fq -- '-p 127.0.0.1:16672:15672/tcp' \
  || fail "opt-in RMQ_GAME_HTTP_BIND_IP must not clobber the localhost shortcut: $game_args"
printf '%s\n' "$game_args" | grep -Fq -- '-p 192.0.2.10:32983:15672/tcp' \
  || fail "opt-in RMQ_GAME_HTTP_BIND_IP did not bind custom RMQ_GAME_HTTP_PORT: $game_args"

rm -f "$launch_repo/.env"
run_start_rabbitmq_stub env RMQ_GAME_HTTP_BIND_IP=127.0.0.1 RMQ_GAME_HTTP_PORT=31983
game_args="$(cat "$work/run-captures/dune-rmq-game.args")"
printf '%s\n' "$game_args" | grep -Fq -- '-p 127.0.0.1:31983:15672/tcp' \
  || fail "explicit RMQ_GAME_HTTP_BIND_IP=127.0.0.1 opt-in was not applied: $game_args"

cd "$repo_root"

echo "rabbitmq seam translates publish and get to the management API and falls back for everything else"
