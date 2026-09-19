#!/usr/bin/env bash
# Regression test: CONSOLE_TOTP_ENABLED (RFC docs/rfc-console-auth.md
# §2.3/§4, #407) is documented as an operator-facing flag in .env.example
# but was never wired into docker-compose.web.yml's console service
# environment block -- despite six merged Tier 3 implementation phases, the
# flag was unreachable in any real docker-compose deployment regardless of
# what an operator set in .env. Found while E2E-testing #482/#484 on
# dune-dev. This does not need Docker -- it just checks the compose YAML
# text directly, so it runs anywhere this repo's tests already run.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
compose_file="$repo_root/docker-compose.web.yml"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -f "$compose_file" ] || fail "$compose_file not found"

grep -qE '^\s*CONSOLE_TOTP_ENABLED:\s*"\$\{CONSOLE_TOTP_ENABLED:-' "$compose_file" \
  || fail "CONSOLE_TOTP_ENABLED is not passed through to the console service in docker-compose.web.yml -- an operator setting it in .env has no effect on the running container"

echo "PASS: CONSOLE_TOTP_ENABLED is wired into docker-compose.web.yml's console environment"

# Hosted-bot console-initiated OAuth registration (#739): the exact same bug
# class as CONSOLE_TOTP_ENABLED above, found during the final-review
# re-review pass -- these 4 keys were implemented (Tasks 2/3/6, plus the
# round-1 persisted-connection fix) but never added to this allowlist, so
# they were unreachable in any real docker-compose deployment regardless of
# .env: deploymentChoice always read null (permanently fail-closing
# /oauth/start), the hosted-bot redirect URI never reached
# buildAuthorizeUrl() (it has no secrets-file fallback, unlike
# DISCORD_OAUTH_CLIENT_SECRET, so it's env-only), and a successful
# registration's persisted "Connected" status never survived the very
# container recreate "Save Role IDs" itself triggers.
for hosted_bot_var in \
  DUNE_DISCORD_ADAPTER_DEPLOYMENT_CHOICE \
  DISCORD_HOSTED_BOT_OAUTH_REDIRECT_URI \
  DISCORD_HOSTED_BOT_OAUTH_CLIENT_ID \
  DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_ID \
  DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_NAME; do
  grep -qE "^\\s*${hosted_bot_var}:\\s*\"\\\$\\{${hosted_bot_var}:-" "$compose_file" \
    || fail "$hosted_bot_var is not passed through to the console service in docker-compose.web.yml -- an operator's hosted-bot Discord OAuth registration would be unreachable in any real deployment regardless of .env"
done

echo "PASS: hosted-bot OAuth registration's env vars are wired into docker-compose.web.yml's console environment"
