#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

PID_FILE="runtime/generated/autoscaler.pid"
LOG_FILE="runtime/logs/autoscaler.log"

mkdir -p runtime/generated runtime/logs

if [ -f "$PID_FILE" ]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
    echo "Autoscaler already running: pid $old_pid"
    exit 0
  fi
fi

if ! docker ps --format '{{.Names}}' | grep -qx dune-director; then
  echo "Cannot start autoscaler: dune-director is not running."
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -qx dune-postgres; then
  echo "Cannot start autoscaler: dune-postgres is not running."
  exit 1
fi

echo "Starting autoscaler..."
nohup runtime/scripts/autoscaler.sh >> "$LOG_FILE" 2>&1 &
pid="$!"

echo "$pid" > "$PID_FILE"

echo "Autoscaler started: pid $pid"
echo "Log: $LOG_FILE"
