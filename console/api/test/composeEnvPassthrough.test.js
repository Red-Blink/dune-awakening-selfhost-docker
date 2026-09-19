import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The console reads process.env inside its container and never parses .env
// itself, so every console variable .env.example documents must be passed
// through docker-compose.web.yml's `environment:` block -- otherwise the
// operator follows the docs, sets it in .env, and the value silently never
// arrives (found by review for DISCORD_OAUTH_CLIENT_SECRET / DISCORD_BOT_HANDOFF_SECRET).
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const envExample = readFileSync(resolve(root, ".env.example"), "utf8");
const compose = readFileSync(resolve(root, "docker-compose.web.yml"), "utf8");

test("every DISCORD_* / CONSOLE_* variable in .env.example is passed through docker-compose.web.yml", () => {
  const documented = [...envExample.matchAll(/^#?\s*((?:DISCORD|CONSOLE)_[A-Z0-9_]+)=/gm)].map((m) => m[1]);
  assert.ok(documented.length >= 12, `expected the documented console/Discord variables, found ${documented.length}`);
  // Accepts both `${KEY:-default}` (empty-or-unset -> default) and
  // `${KEY-default}` (unset-only -> default, no colon) -- DISCORD_PLAYER_ROLE_IDS
  // deliberately uses the no-colon form (nested as
  // `${DISCORD_PLAYER_ROLE_IDS-${DISCORD_OBSERVER_ROLE_IDS-}}`) so an operator
  // who explicitly clears it via the Settings UI doesn't fall back to a
  // stale legacy value just because "" is treated as unset under `:-`
  // (Audit finding #3, adapter.js's matching JS-side fix). Both forms are a
  // real pass-through; only the literal substring check was too narrow.
  const missing = documented.filter((key) => !compose.includes(`\n      ${key}: "\${${key}:-`) && !compose.includes(`\n      ${key}: "\${${key}-`));
  assert.deepEqual(missing, [], `documented in .env.example but not passed into the console container: ${missing.join(", ")}`);
});
