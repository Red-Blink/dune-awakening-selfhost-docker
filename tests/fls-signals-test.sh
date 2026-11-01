#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
source "$repo_root/runtime/scripts/fls-signals.sh"

expect_ready() {
  local name="$1"
  local logs="$2"

  if ! director_fls_logs_ready "$logs"; then
    printf 'Expected FLS logs to be ready: %s\n' "$name" >&2
    exit 1
  fi
}

expect_wait() {
  local name="$1"
  local logs="$2"

  if director_fls_logs_ready "$logs"; then
    printf 'Expected FLS logs to remain pending: %s\n' "$name" >&2
    exit 1
  fi
}

valid='Population declaration: {"BattlegroupMaxPlayerCapacity":60,"IsLocked":false}'
zero='Population declaration: {"BattlegroupMaxPlayerCapacity":0,"IsLocked":false}'
error='[ERR FLSAPI] HTTP Request Error: Response status code does not indicate success: 500'

expect_wait "heartbeat initiation only" "RMQ connection successful. Initiating heartbeat."
expect_wait "zero capacity" "$zero"
expect_wait "locked declaration invalidates older readiness" "$valid
$valid
Population declaration: {\"BattlegroupMaxPlayerCapacity\":60,\"IsLocked\":true}"
expect_wait "zero capacity invalidates older healthy declarations" "$valid
$valid
$zero"
expect_wait "heartbeat success cannot hide latest zero capacity" "$valid
$valid
$zero
Battlegroups_SendBattlegroupHeartbeat Request successful"
expect_wait "one recovery declaration remains unconfirmed" "$valid
$valid
$zero
$valid"
expect_ready "two recovery declarations restore readiness" "$valid
$valid
$zero
$valid
$valid"
expect_wait "one unconfirmed declaration" "$valid"
expect_wait "one declaration after an error" "$valid
$error
$valid"
expect_ready "two declarations after an error" "$valid
$error
$valid
$valid"
expect_ready "explicit request success" "Battlegroups_SendBattlegroupHeartbeat Request successful"
expect_wait "error after explicit success" "Battlegroups_SendBattlegroupHeartbeat Request successful
$error"

echo "FLS readiness signals distinguish attempts, failures, and sustained publication"
