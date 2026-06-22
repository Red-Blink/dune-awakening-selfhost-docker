#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local pattern="$2"

  grep -Fq -- "$pattern" "$file" || fail "$file missing: $pattern"
}

assert_not_contains() {
  local file="$1"
  local pattern="$2"

  ! grep -Fq -- "$pattern" "$file" || fail "$file must not contain: $pattern"
}

assert_contains runtime/scripts/start-rabbitmq.sh 'RMQ_GAME_HTTP_BIND="${RMQ_GAME_HTTP_BIND:-127.0.0.1}"'
assert_contains runtime/scripts/start-rabbitmq.sh '-p "${RMQ_GAME_HTTP_BIND}:31983:15672/tcp"'
assert_not_contains runtime/scripts/start-rabbitmq.sh '-p 31983:15672/tcp'

assert_contains runtime/scripts/ready.sh 'RabbitMQ game HTTP local'
assert_contains runtime/scripts/status.sh 'RabbitMQ game HTTP local'
assert_contains runtime/scripts/doctor.sh 'RabbitMQ game HTTP local'
assert_not_contains runtime/scripts/init.sh 'Open or forward TCP 31983.'
assert_not_contains runtime/scripts/doctor.sh 'TCP 31982, TCP 31983'
assert_not_contains runtime/scripts/local-loopback-optimize.sh '--dport 31983'
assert_not_contains runtime/scripts/ping-diagnostics.sh 'Gateway advertises RMQ HTTP'
assert_contains .env.example 'RMQ_GAME_HTTP_BIND=127.0.0.1'

echo "PASS: RabbitMQ management HTTP is localhost-bound by default"
