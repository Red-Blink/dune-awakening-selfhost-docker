#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

require_literal() {
  local needle="$1"
  local file="$2"
  if ! grep -Fq "$needle" "$file"; then
    echo "Missing expected hardening in $file: $needle" >&2
    exit 1
  fi
}

reject_literal() {
  local needle="$1"
  local file="$2"
  if grep -Fq "$needle" "$file"; then
    echo "Found deprecated predictable file pattern in $file: $needle" >&2
    exit 1
  fi
}

require_literal 'chmod 600 runtime/rabbitmq-game/certs/key.pem' runtime/scripts/start-rabbitmq.sh
reject_literal 'chmod 644 runtime/rabbitmq-game/certs/*.pem' runtime/scripts/start-rabbitmq.sh

require_literal 'mktemp "${TMPDIR:-/tmp}/dune-deepdesert-progress.XXXXXX"' runtime/scripts/autoscaler.sh
reject_literal '/tmp/deepdesert-progress.json' runtime/scripts/autoscaler.sh

require_literal 'mktemp "${TMPDIR:-/tmp}/dune-appinfo-${APP_ID}.XXXXXX"' runtime/scripts/update.sh
require_literal 'mktemp "${TMPDIR:-/tmp}/dune-appmanifest-${app_id}.XXXXXX"' runtime/scripts/version.sh
require_literal 'docker exec dune-postgres mktemp "/tmp/${artifact_id}.XXXXXX.backup"' runtime/scripts/db.sh
require_literal 'docker exec dune-postgres mktemp "/tmp/dune-db-import.XXXXXX.$ext"' runtime/scripts/db.sh

require_literal 'chmod 600 "$ADMIN_HISTORY_TSV" "$ADMIN_AUDIT_JSONL"' runtime/scripts/admin-tools.sh

echo "Runtime file hygiene checks passed."
