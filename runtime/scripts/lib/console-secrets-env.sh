#!/usr/bin/env bash
set -euo pipefail

# Stage 3 (dune-awakening-selfhost-docker#901) of the age-based secrets
# library rollout -- a resolver for the hosted-bot wizard's Discord
# OAuth client secret, sourced only by runtime/scripts/console.sh's
# own prepare_discord_hosted_bot_oauth_secret(), on the HOST, before
# `docker compose up` starts the console container.
#
# Deliberately resolved on the host, NOT inside the console container's
# own entrypoint.sh: DUNE_KEK_FILE/DUNE_AGE_IDENTITY_FILE point at an
# age identity that lives OUTSIDE the repo by design (see
# docs/security/age-secrets.md's own "keep the age identity outside
# the repository" instruction) and is never bind-mounted into any
# container -- docker-compose.web.yml only mounts
# ${DUNE_HOST_REPO_ROOT}:/repo, /etc/localtime, and the Docker socket.
# The console container genuinely cannot reach that path even if it
# had `age`/python3-cryptography installed. This exactly mirrors how
# Stage 2's own server-login-password-secret/username-server-login-secret
# already work: resolved on the host by runtime-env.sh's own resolvers
# (called from start-server-overmap.sh and friends), never inside a
# container.
#
# Deliberately a SEPARATE, minimal file rather than adding this
# resolver to runtime/scripts/runtime-env.sh: every existing function
# there is game-server-oriented (resolve_login_password_skew_seconds
# and friends, sourced only by the game server's own startup scripts)
# -- console.sh has never sourced runtime-env.sh and has no reason to
# start now, since that file's ~700 lines carry assumptions (memory-
# swap handling, game-server env resolution) that don't apply here.
#
# Depends only on runtime/scripts/lib/secrets.sh, which is itself
# self-contained (sources nothing else) -- safe to source here without
# pulling in anything beyond that. `age`/python3-cryptography are the
# same host-side prerequisites docs/security/age-secrets.md already
# documents for Stage 2 -- no new prerequisite class, just one more
# secret name using it.

DUNE_CONSOLE_SECRETS_ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$DUNE_CONSOLE_SECRETS_ENV_DIR/secrets.sh"

# resolve_discord_hosted_bot_oauth_client_secret
#
# The hosted-bot wizard's own "Client Secret" field (console/web's
# DiscordBotSection.tsx, Advanced fallback) -- typed in by the operator
# from their own Discord Application, persisted server-side to
# runtime/secrets/discord-hosted-bot-oauth-client-secret.txt. Node
# reads it via console/api/src/config.js's readInlineOrFile(), which
# checks process.env.DISCORD_HOSTED_BOT_OAUTH_CLIENT_SECRET first --
# entrypoint.sh exports that env var from this resolver's output,
# requiring zero Node-side code changes.
#
# Deliberately NOT built on the Stage 2 pattern (ensure_secret_file,
# which fabricates a fresh random value when the legacy file is
# absent): that fallback is correct for an auto-generated secret like
# the game server's login password, but would be a real correctness
# bug here -- this secret is never auto-generated, it is either the
# operator's real Discord Application credential or it does not exist
# yet (hosted-bot OAuth simply not configured). Minting a random
# 32-byte string and exporting it as
# DISCORD_HOSTED_BOT_OAUTH_CLIENT_SECRET would make
# hostedBotOAuthConfigured report true for a connection that was never
# actually set up, and silently break every real OAuth exchange
# against Discord's own API with a credential Discord never issued.
resolve_discord_hosted_bot_oauth_client_secret() {
  local name="discord-hosted-bot-oauth-client-secret"
  local legacy_path="runtime/secrets/${name}.txt"

  local value rc=0
  value="$(dune_secrets_read_secret "$name" "$legacy_path")" || rc=$?
  if [ "$rc" = "0" ]; then
    printf '%s' "$value"
    return 0
  fi

  if dune_secrets_has_migration_artifacts "$name"; then
    # Migrated but currently unreadable/undecryptable -- fail closed,
    # exactly like Stage 2. A broken migrated secret must never be
    # silently treated as "not configured."
    return "$rc"
  fi

  # No migration history and no legacy file: genuinely never
  # configured. Print nothing and succeed (rc 0) -- callers must treat
  # empty output as "do not export this env var," not as an error, and
  # must NOT abort console startup/recreation over a hosted-bot OAuth
  # secret that was simply never set up.
  return 0
}

# export_discord_hosted_bot_oauth_client_secret
#
# Shared by every place that starts or recreates the console container
# (dune-awakening-selfhost-docker#901, Layer 2 audit finding on PR
# #902): console.sh's restart_console() and self-update.sh's
# prepare_web_console_rebuild_env() -- the latter covers BOTH
# rebuild_web_console_now() (the real self-update apply flow) and
# recreate_discord_adapter_env() (Settings -> Discord Bot enable/
# role-ID changes), since both call it immediately before their own
# `docker compose ... up --force-recreate`. Originally duplicated
# inline at each call site; extracted here so there is exactly one
# place defining "how to resolve and export this secret," not three
# copies that can silently drift out of sync.
#
# Only exports when the resolver produces a non-empty value, and never
# overrides an already-set env var (an operator who set it directly
# via .env/shell env is left alone, matching config.js's own env-var-
# wins precedence).
export_discord_hosted_bot_oauth_client_secret() {
  if [ -n "${DISCORD_HOSTED_BOT_OAUTH_CLIENT_SECRET:-}" ]; then
    return 0
  fi
  local resolved
  resolved="$(resolve_discord_hosted_bot_oauth_client_secret)"
  if [ -n "$resolved" ]; then
    export DISCORD_HOSTED_BOT_OAUTH_CLIENT_SECRET="$resolved"
  fi
}
