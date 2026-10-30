#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

# dune secrets -- Stage 2 wired the two lowest-blast-radius secrets
# (server-login-password-secret, username-server-login-secret) to
# optional age-based at-rest encryption; Stage 3 (dune-awakening-
# selfhost-docker#901) adds discord-hosted-bot-oauth-client-secret --
# the hosted-bot wizard's operator-supplied Discord Application client
# secret (Advanced fallback, console/web's DiscordBotSection.tsx).
# Strictly opt-in -- set DUNE_KEK_FILE and DUNE_AGE_IDENTITY_FILE to a
# generated age identity/wrapped key to use it (see runtime/scripts/lib/
# secrets.sh's own header comment for the exact key-hierarchy and file
# format); do nothing and every existing flat-file secret continues to
# work exactly as before this stage existed.
#
# Deliberately named secrets-cli.sh, NOT secrets.sh, to avoid a
# basename collision with the library itself at
# runtime/scripts/lib/secrets.sh -- two files named "secrets.sh" in
# the same functional area is an avoidable, real source of confusion
# for grep-based reasoning and the shellcheck file list in
# tests/security-pr-checks.sh (both would need to be added by full
# path; easy to add one and believe both are covered). Matches this
# repo's own existing db.sh/db-manager.sh precedent for "two
# related-but-distinct scripts get distinguishable names."
#
# Scope: exactly 3 secrets, hardcoded below, never derived from
# config/user input. This is intentional -- see
# _dune_secrets_require_stage2_name's own comment for why a broader
# allow-list would be a real scope violation, not just tidiness.
# Postgres/Funcom/RabbitMQ remain explicitly out of scope, per the
# real, upstream-maintainer-set boundary Stage 2 was built under -- a
# future stage that legitimately wires more secrets must keep making
# that call deliberately, the same way Stage 3 does here, not treat
# this allow-list as freely extensible.

# shellcheck disable=SC1091
source runtime/scripts/lib/secrets.sh
# shellcheck disable=SC1091
source runtime/scripts/runtime-env.sh

usage() {
  cat <<'EOF'
Usage:
  dune secrets status [<name>]
  dune secrets verify [<name>]
  dune secrets migrate <name> [--dry-run]
  dune secrets cleanup-legacy <name>

Wires exactly 3 secrets to optional age-based at-rest encryption:
server-login-password-secret, username-server-login-secret (Stage 2),
and discord-hosted-bot-oauth-client-secret (Stage 3). Strictly opt-in
-- set both DUNE_KEK_FILE and DUNE_AGE_IDENTITY_FILE to use it; an
operator who does neither sees zero behavior change.

  status            Show migration state for one or more secrets.
  verify            Non-destructively confirm a migrated secret still
                    decrypts (does NOT delete anything -- safe to run
                    repeatedly).
  migrate           Encrypt a secret's current legacy plaintext value.
                    Never deletes the legacy file -- see cleanup-legacy.
  cleanup-legacy    Delete the legacy plaintext file for an already-
                    migrated secret, after re-verifying decryption
                    works. Refuses if verification fails.

Note: discord-hosted-bot-oauth-client-secret is operator-supplied and
optional (the hosted-bot wizard's Advanced fallback) -- if it was
never configured, 'migrate' correctly refuses with "nothing to
migrate," it is not auto-generated the way the other two secrets are.

Scope: PostgreSQL, Funcom, and RabbitMQ secrets are explicitly out of
scope for this stage and are rejected by name.
EOF
}

# _dune_secrets_require_stage2_name <name>
#   Enforces the hardcoded, deliberately-scoped 3-item allow-list. This
#   is IN ADDITION TO (not instead of) the library's own generic
#   _dune_secrets_validate_name filesystem-safety check -- that check
#   accepts any filesystem-safe name, not just these three, and using
#   it alone would let this CLI silently touch Postgres/Funcom/RMQ
#   secrets (e.g. `dune secrets migrate postgres-password` would
#   otherwise succeed), directly conflicting with the upstream
#   maintainer's explicit instruction to keep those three out of this
#   first integration. A future stage that legitimately wires more
#   secrets must extend this allow-list deliberately, not remove it.
#   Name kept as "stage2" rather than renamed to something generic --
#   this function enforces the CUMULATIVE allow-list across every
#   stage shipped so far, not just the stage it was originally named
#   for; renaming it each time a new stage lands would only add
#   git-blame noise for a name that was never meant to describe "which
#   stage," only "the currently enforced scope."
_dune_secrets_require_stage2_name() {
  local name="$1"
  case "$name" in
    server-login-password-secret|username-server-login-secret|discord-hosted-bot-oauth-client-secret)
      return 0
      ;;
    *)
      echo "dune secrets: '$name' is not in scope. Only server-login-password-secret, username-server-login-secret, and discord-hosted-bot-oauth-client-secret are wired so far -- PostgreSQL, Funcom, and RabbitMQ secrets are explicitly out of scope for now." >&2
      return 1
      ;;
  esac
}

_dune_secrets_stage2_names() {
  printf '%s\n%s\n%s\n' server-login-password-secret username-server-login-secret discord-hosted-bot-oauth-client-secret
}

# _dune_secrets_stage2_state <name>
#   Prints one of: not-migrated | migrated | broken
#   "broken" means migration history exists but the encrypted payload
#   cannot currently be used. Artifact existence is checked before
#   backend configuration so losing environment variables after
#   migration is reported as broken, never as an unconfigured legacy
#   installation.
_dune_secrets_stage2_state() {
  local name="$1"
  local enc_path

  enc_path="$(dune_secrets_encrypted_path "$name" 2>/dev/null || true)"
  if dune_secrets_has_migration_artifacts "$name"; then
    if dune_secrets_backend_configured && [ -r "$enc_path" ]; then
      printf 'migrated\n'
    else
      printf 'broken\n'
    fi
    return 0
  fi

  if ! dune_secrets_backend_configured; then
    printf 'backend-not-configured\n'
    return 0
  fi

  printf 'not-migrated\n'
}

cmd_status() {
  local target="${1:-}"
  local names
  if [ -n "$target" ]; then
    _dune_secrets_require_stage2_name "$target" || return 1
    names="$target"
  else
    names="$(_dune_secrets_stage2_names)"
  fi

  local name state
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    state="$(_dune_secrets_stage2_state "$name")"
    case "$state" in
      backend-not-configured)
        echo "$name: backend not configured"
        echo "  Next: follow docs/security/age-secrets.md to create an age identity + KEK and configure both paths"
        ;;
      not-migrated)
        echo "$name: not migrated (legacy plaintext)"
        echo "  Next: run 'dune secrets migrate $name'"
        ;;
      migrated)
        echo "$name: migrated (encrypted)"
        echo "  Next: run 'dune secrets verify $name' to confirm decryption still works, then 'dune secrets cleanup-legacy $name' when ready"
        ;;
      broken)
        echo "$name: migrated but currently unreadable/broken"
        echo "  Next: run 'dune secrets verify $name' for details, or restore the .enc file from backup"
        ;;
    esac
  done <<< "$names"
}

cmd_verify() {
  local target="${1:-}"
  local names
  if [ -n "$target" ]; then
    _dune_secrets_require_stage2_name "$target" || return 1
    names="$target"
  else
    names="$(_dune_secrets_stage2_names)"
  fi

  local name legacy_path rc=0
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    legacy_path="runtime/secrets/${name}.txt"
    if ! dune_secrets_backend_configured; then
      echo "$name: backend not configured -- nothing to verify"
      continue
    fi
    local state
    state="$(_dune_secrets_stage2_state "$name")"
    if [ "$state" = "not-migrated" ]; then
      echo "$name: not migrated yet -- nothing to verify"
      continue
    fi
    if dune_secrets_read_secret "$name" "$legacy_path" >/dev/null; then
      echo "$name: OK -- decrypts successfully"
    else
      echo "$name: FAILED -- see error above" >&2
      rc=1
    fi
  done <<< "$names"
  return "$rc"
}

cmd_migrate() {
  # Accepts --dry-run in either position (before or after <name>) --
  # an earlier version required it strictly after the name, matching
  # the design doc's own usage-string ordering, but that's a
  # plausible, easy operator mistake (most CLI tools accept flags in
  # either position) with a confusing "unknown option" error pointing
  # at the *name* itself if guessed wrong. Collect all positional args
  # and flags in one pass instead of assuming position.
  local name="" dry_run=0
  local arg
  for arg in "$@"; do
    case "$arg" in
      --dry-run) dry_run=1 ;;
      --*) echo "dune secrets migrate: unknown option '$arg'" >&2; return 2 ;;
      *)
        if [ -n "$name" ]; then
          echo "dune secrets migrate: unexpected extra argument '$arg'" >&2
          return 2
        fi
        name="$arg"
        ;;
    esac
  done

  if [ -z "$name" ]; then
    echo "dune secrets migrate: <name> is required." >&2
    usage
    return 2
  fi
  _dune_secrets_require_stage2_name "$name" || return 1

  if ! dune_secrets_backend_configured; then
    echo "dune secrets migrate: backend not configured -- set DUNE_KEK_FILE and DUNE_AGE_IDENTITY_FILE first." >&2
    return 1
  fi

  local legacy_path="runtime/secrets/${name}.txt"
  if [ ! -r "$legacy_path" ]; then
    echo "dune secrets migrate: '$legacy_path' does not exist or is not readable -- nothing to migrate." >&2
    return 1
  fi

  local enc_path marker_path
  enc_path="$(dune_secrets_encrypted_path "$name")"
  marker_path="$(dune_secrets_migration_marker_path "$name")"

  if [ "$dry_run" = "1" ]; then
    echo "DRY RUN: would read plaintext from $legacy_path"
    echo "DRY RUN: would write encrypted secret to $enc_path"
    echo "DRY RUN: would write migration marker to $marker_path"
    echo "DRY RUN: would NOT touch or delete $legacy_path"
    return 0
  fi

  # The plaintext value is read from the legacy file directly into a
  # local shell variable and passed to dune_secrets_write_secret as a
  # plain function argument in this same process -- it is never
  # interpolated into a subprocess command string and never appears
  # in argv anywhere in this script, matching the project's own
  # GHSA-fc89-h24v-6j3x precedent and the library's own stdin-only
  # protocol for secrets_aead.py.
  local plaintext
  plaintext="$(tr -d '\r\n' < "$legacy_path")"

  if dune_secrets_write_secret "$name" "$plaintext"; then
    echo "$name: migrated. Legacy file at $legacy_path was NOT deleted -- run 'dune secrets cleanup-legacy $name' once you've verified the new path works."
  else
    echo "dune secrets migrate: failed to migrate '$name' -- see error above." >&2
    return 1
  fi
}

cmd_cleanup_legacy() {
  local name="${1:-}"
  if [ -z "$name" ]; then
    echo "dune secrets cleanup-legacy: <name> is required." >&2
    usage
    return 2
  fi
  _dune_secrets_require_stage2_name "$name" || return 1

  local legacy_path="runtime/secrets/${name}.txt"
  if [ ! -e "$legacy_path" ]; then
    echo "$name: no legacy file at $legacy_path -- nothing to clean up."
    return 0
  fi

  if ! dune_secrets_backend_configured; then
    echo "dune secrets cleanup-legacy: backend not configured -- refusing to delete the only remaining copy of '$name'." >&2
    return 1
  fi

  local state
  state="$(_dune_secrets_stage2_state "$name")"
  if [ "$state" != "migrated" ]; then
    echo "dune secrets cleanup-legacy: '$name' is not currently in a verified-migrated state ($state) -- refusing to delete $legacy_path. Run 'dune secrets verify $name' for details." >&2
    return 1
  fi

  # Re-verify decryption immediately before deleting -- not relying on
  # the state check above alone, which could theoretically be stale
  # by the time we act on it. This is the one destructive step in this
  # entire command surface; it must re-confirm right before acting.
  if ! dune_secrets_read_secret "$name" "$legacy_path" >/dev/null; then
    echo "dune secrets cleanup-legacy: re-verification failed immediately before deletion -- refusing to delete $legacy_path. Run 'dune secrets verify $name' for details." >&2
    return 1
  fi

  rm -f "$legacy_path"
  echo "$name: legacy file $legacy_path removed. Encrypted form is now the sole copy."
}

cmd="${1:-}"
shift || true
case "$cmd" in
  status) cmd_status "$@" ;;
  verify) cmd_verify "$@" ;;
  migrate) cmd_migrate "$@" ;;
  cleanup-legacy) cmd_cleanup_legacy "$@" ;;
  help|--help|-h|"") usage ;;
  *) echo "Unknown secrets command: $cmd" >&2; usage; exit 2 ;;
esac
