import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Link2, LockKeyhole, Plus, RefreshCw } from "lucide-react";
import { ApiError, api, post } from "../../api/client";
import { HttpsSetup } from "./HttpsSetup";
import { SecretInput } from "../../components/SecretInput";
import { copyText } from "../../lib/clipboard";
import { restartConsoleAndReload } from "../../lib/consoleRestart";

// Guided Discord sign-in setup (docs/rfc-console-auth.md §2.1.1). Reached only
// by the console owner (the admin password was entered to start it), so from
// here the operator AUTHENTICATES with Discord and does not enter the password
// again -- the owner session is the proof. The step is derived from live data,
// never frozen, so returning from the Discord round-trip (or refreshing) always
// resumes at the right place instead of dropping back to the start.

type Guild = { id: string; name: string; owner: boolean };
type Identity = { user: { id: string; username: string; mfaEnabled: boolean }; guilds: Guild[] };
type HostApp = {
  clientId: string;
  redirectUri: string;
  secretSaved: boolean;
  configured: boolean;
  // Distinct from `configured` (DISCORD_OAUTH_CLIENT_ID/SECRET saved): this is
  // discordOAuthConfigured, i.e. guild + role mapping already finalized and
  // Discord sign-in is actually live for other sessions right now. Without
  // this, the wizard could not tell "app credentials saved, mapping still in
  // progress" (the real "authorize" step) apart from "fully active, this
  // session just hasn't signed in with Discord yet" -- see the "active" step
  // below, added after live UAT found the authorize step's "Set up Discord
  // sign-in" / "Continue with Discord" copy rendering for an already-active
  // integration (#676 follow-up UX finding).
  mappingConfigured: boolean;
  adminRoleIds: string;
  moderatorRoleIds: string;
  playerRoleIds: string;
  requireMfa: boolean;
};
// #643: set immediately before navigating to the setup-mode OAuth round-trip
// when embedded, so App.tsx can tell a RECONFIGURATION return (from an
// already-authenticated Settings session) apart from the pre-login first-run
// flow, which lands on the identical "/?discordSetup=done" URL but must keep
// its existing standalone-wizard + forced-logout behavior.
const DISCORD_SETUP_RETURN_MARKER = "dune-console:discord-setup-return";
type Props = {
  onDone: () => void;
  onCancel: () => void;
  onConfigureHttps?: () => void;
  // #643: true when mounted inside Settings (an already-authenticated owner
  // reconfiguring) rather than the standalone pre-login flow. Changes: the
  // OAuth link sets DISCORD_SETUP_RETURN_MARKER first; "done"/restart copy
  // stops claiming the operator is being signed back in (they never left);
  // a "Change Application Credentials" affordance appears once configured,
  // since this is the only reachable path to rotate the secret once §643 has
  // replaced SettingsPanel's old always-editable manual form.
  embedded?: boolean;
};

const SNOWFLAKE = /^\d{17,19}$/;

export function DiscordSetupWizard({ onDone, onCancel, onConfigureHttps, embedded = false }: Props) {
  const redirectUri = `${window.location.origin}/api/auth/discord/callback`;
  const isHttps = typeof window !== "undefined" && window.location.protocol === "https:";
  const [app, setApp] = useState<HostApp | null>(null);       // what the host already has
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [probed, setProbed] = useState(false);                // both probes have resolved
  const [guildId, setGuildId] = useState("");
  const [adminRoleIds, setAdminRoleIds] = useState("");
  const [moderatorRoleIds, setModeratorRoleIds] = useState("");
  const [playerRoleIds, setPlayerRoleIds] = useState("");
  const [requireMfa, setRequireMfa] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ guild: string; owner: string } | null>(null);
  const [restarting, setRestarting] = useState(false);
  // #641: which path the connect step's guided flow is on. Deliberately NOT
  // derived from server state, unlike everything else in this component --
  // a same-session refresh resets this to "unset", costing one redundant
  // click (both paths converge on the identical form) -- see the design's
  // §4.1 note on why this is an accepted, bounded exception.
  const [appPath, setAppPath] = useState<"unset" | "have-app" | "need-app">("unset");
  const [formClientId, setFormClientId] = useState("");
  const [formClientSecret, setFormClientSecret] = useState("");
  const [savingApp, setSavingApp] = useState(false);
  // The console only reads .env at boot (see restartNow()) -- a successful
  // save is real but invisible until a restart, so this step's own
  // "restart required" prompt is tracked independently of server state.
  const [appSaved, setAppSaved] = useState(false);
  const [returnedFromDiscord, setReturnedFromDiscord] = useState(false);
  // #643 §4.2: forces the connect (credential-entry) form back open from the
  // authorize/map steps, for an operator rotating an already-configured
  // application's credentials -- normal step derivation below has no other
  // way to reach that form once app.configured is true.
  const [forceReconfigure, setForceReconfigure] = useState(false);
  // #676 §8: awareness, not a real proof-gate. At first-time setup the acting
  // session is always password-tier (Discord OAuth can't exist yet), so this
  // is trivially satisfiable there -- its job is making sure the human does
  // not walk into "Tier 1 -> 4 blocked, don't know the password" later,
  // unknowingly. Shown on every reconfiguration too (not just first-time),
  // since it costs nothing and is a fine standing reminder either way.
  const [passwordAwarenessAcknowledged, setPasswordAwarenessAcknowledged] = useState(false);
  // #676 §7: captured ONCE, from the first successful probe only -- whether
  // this was a genuine first-time configuration (unconfigured -> configured)
  // rather than a reconfiguration (e.g. "Change Application Credentials" on
  // an already-fully-configured install). This is the offer step's own
  // trigger condition, alongside secondFactorEnrolledAtMount below; neither
  // is re-derived after the first probe, since by the time finalize()
  // succeeds discordOAuthConfigured is already true either way.
  const wasConfiguredAtMount = useRef<boolean | null>(null);
  const [secondFactorEnrolledAtMount, setSecondFactorEnrolledAtMount] = useState(false);

  // Learn the host's state on mount, and every time it might have changed. Both
  // probes are unconditional -- NOT gated on a URL param -- so a refresh at any
  // point re-derives where we are.
  const probe = useCallback(async () => {
    const [settings, id, me] = await Promise.allSettled([
      api<{ serverConfig?: Record<string, string>; config?: { discordOAuthAppConfigured?: boolean; discordOAuthConfigured?: boolean; discordSetupApplicationReady?: boolean } }>("/api/settings"),
      api<Identity>("/api/setup/discord-identity"),
      wasConfiguredAtMount.current === null ? api<{ secondFactorEnrolled?: boolean }>("/api/auth/me") : Promise.resolve(null),
    ]);
    if (me.status === "fulfilled" && me.value) setSecondFactorEnrolledAtMount(Boolean(me.value.secondFactorEnrolled));
    if (settings.status === "fulfilled" && wasConfiguredAtMount.current === null) {
      wasConfiguredAtMount.current = Boolean(settings.value.config?.discordOAuthConfigured);
    }
    if (settings.status === "fulfilled") {
      const c = settings.value.serverConfig || {};
      setApp({
        clientId: c["DISCORD_OAUTH_CLIENT_ID"] || "",
        redirectUri: c["DISCORD_OAUTH_REDIRECT_URI"] || "",
        secretSaved: Boolean(c["_discordOAuthSecretSaved"]),
        configured: Boolean(settings.value.config?.discordSetupApplicationReady ?? settings.value.config?.discordOAuthAppConfigured),
        mappingConfigured: Boolean(settings.value.config?.discordOAuthConfigured),
        // #643 §4.3: pre-fill from whatever the host already has, matching
        // what SettingsPanel's old manual form did correctly (and this
        // wizard's own map step did NOT -- reopening it from Settings would
        // otherwise silently flip "Require Discord 2FA" back on for an
        // install that has it off, or force re-typing role IDs from memory).
        adminRoleIds: c["DISCORD_CONSOLE_ADMIN_ROLE_IDS"] || "",
        moderatorRoleIds: c["DISCORD_CONSOLE_MODERATOR_ROLE_IDS"] || "",
        playerRoleIds: c["DISCORD_CONSOLE_PLAYER_ROLE_IDS"] || "",
        requireMfa: Boolean(c["DISCORD_OAUTH_REQUIRE_MFA_TIERS"]),
      });
    } else {
      setApp({ clientId: "", redirectUri: "", secretSaved: false, configured: false, mappingConfigured: false, adminRoleIds: "", moderatorRoleIds: "", playerRoleIds: "", requireMfa: true });
    }
    if (id.status === "fulfilled") {
      setIdentity(id.value);
      const owned = id.value.guilds.find((g) => g.owner);
      if (owned && !guildId) setGuildId(owned.id);
    }
    setProbed(true);
    // A stray ?discordSetup marker in the URL has done its job; drop it so a
    // manual refresh is clean.
    if (new URLSearchParams(window.location.search).has("discordSetup")) window.history.replaceState({}, "", "/");
  }, [guildId]);

  useEffect(() => { void probe(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Pre-fill from whatever the host already has (e.g. a Client ID set by a
  // previous, incomplete attempt) once probed -- only if the operator hasn't
  // typed anything yet, so a background re-probe never clobbers live input.
  useEffect(() => {
    if (app?.clientId && !formClientId) setFormClientId(app.clientId);
  }, [app, formClientId]);

  // #643 §4.3: same guard as formClientId above -- pre-fill the map step's
  // role/MFA fields from already-saved config exactly once, never clobbering
  // input the operator has already started typing.
  const [roleFieldsPrefilled, setRoleFieldsPrefilled] = useState(false);
  useEffect(() => {
    if (!app || roleFieldsPrefilled) return;
    setAdminRoleIds(app.adminRoleIds);
    setModeratorRoleIds(app.moderatorRoleIds);
    setPlayerRoleIds(app.playerRoleIds);
    setRequireMfa(app.requireMfa);
    setRoleFieldsPrefilled(true);
  }, [app, roleFieldsPrefilled]);

  // #641: soft, non-blocking "welcome back" signal for the "need-app" path --
  // same-origin window focus, not the child tab's .closed (cross-origin means
  // that's the only readable signal from that side, and it only ever says
  // "closed", never "finished"). This is cosmetic only: the form is fully
  // usable in both paths regardless of whether this listener ever fires
  // (popup blocked, opened in the same tab, a second-device workflow).
  useEffect(() => {
    if (appPath !== "need-app") return;
    const onFocus = () => setReturnedFromDiscord(true);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [appPath]);

  // #641: the connect step's save -- sends ONLY the two keys this step
  // manages, never as blank strings for any other write-oauth-config field.
  // Sending the rest as "" (rather than omitting them) would recreate the
  // exact bug discordSetupFinalize's own comment already documents fixing
  // once (silently clobbering an operator's owner-bootstrap allowlist) --
  // writeOAuthConfig's partial-update safety only holds if untouched keys
  // are genuinely absent from the body, not blank.
  async function saveApp() {
    setSavingApp(true); setError("");
    try {
      const clientId = formClientId.trim();
      if (!clientId) throw new Error("Enter the application's Client ID.");
      if (!formClientSecret.trim() && (!app?.secretSaved || clientId !== app.clientId)) throw new Error("Enter the Client Secret for this Discord application.");
      await post<{ ok: boolean }>("/api/setup/write-oauth-config", {
        DISCORD_OAUTH_CLIENT_ID: clientId,
        DISCORD_OAUTH_REDIRECT_URI: redirectUri,
      });
      if (formClientSecret) {
        await post<{ ok: boolean }>("/api/setup/save-oauth-secret", { secret: formClientSecret, overwrite: Boolean(app?.secretSaved) });
        setFormClientSecret("");
      }
      await probe();
      setAppSaved(true);
      setIdentity(null);
      setForceReconfigure(false);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSavingApp(false); }
  }

  async function finalize() {
    setBusy(true); setError("");
    try {
      if (!SNOWFLAKE.test(guildId)) throw new Error("Choose your Discord server.");
      if (!adminRoleIds.trim()) throw new Error("Map an Admin role, or only you (the server owner) will be able to use the console through Discord.");
      const bad = [adminRoleIds, moderatorRoleIds, playerRoleIds].flatMap((v) => v.split(",").map((x) => x.trim()).filter(Boolean)).filter((x) => !SNOWFLAKE.test(x));
      if (bad.length) throw new Error(`Not a Discord role ID: ${bad.join(", ")}`);
      // Layer 3 audit finding (#676 follow-up): the old manual Discord OAuth
      // form (replaced by this wizard, #643) checked this instantly and
      // locally; the server's own describeRoleTierConflicts (server.js) still
      // enforces it either way, but without this the operator only finds out
      // about a duplicate role mapping after a network round-trip instead of
      // before clicking "Enable Discord Sign In" at all.
      const tierLists: [string, string[]][] = [
        ["Admin", adminRoleIds.split(",").map((x) => x.trim()).filter(Boolean)],
        ["Moderator", moderatorRoleIds.split(",").map((x) => x.trim()).filter(Boolean)],
        ["Player", playerRoleIds.split(",").map((x) => x.trim()).filter(Boolean)],
      ];
      const tiersByRole = new Map<string, string[]>();
      for (const [tier, ids] of tierLists) {
        for (const id of ids) {
          const tiers = tiersByRole.get(id) || [];
          if (!tiers.includes(tier)) tiers.push(tier);
          tiersByRole.set(id, tiers);
        }
      }
      const conflicts = [...tiersByRole.entries()].filter(([, tiers]) => tiers.length > 1);
      if (conflicts.length) {
        throw new Error(`Each Discord role can map to only one access level. ${conflicts.map(([roleId, tiers]) => `role ${roleId} is mapped to ${tiers.join(" and ")}`).join("; ")}.`);
      }
      const res = await post<{ ok: boolean; guild: { name: string }; owner: { username: string } }>("/api/setup/discord-finalize", {
        guildId, adminRoleIds: adminRoleIds.trim(), moderatorRoleIds: moderatorRoleIds.trim(), playerRoleIds: playerRoleIds.trim(), requireMfa
      });
      setDone({ guild: res.guild.name, owner: res.owner.username });
    } catch (err) {
      if (err instanceof ApiError && err.body.requiresAuthorization) {
        setIdentity(null);
        setAppSaved(true);
      }
      setError(err instanceof Error ? err.message : String(err));
    }
    finally { setBusy(false); }
  }

  // Reload only after the new process reports the completed Discord setup.
  async function restartNow() {
    setRestarting(true); setError("");
    try {
      await restartConsoleAndReload((loaded) => loaded.discordOAuthConfigured === true, { onTimeout: setError });
    } catch (error) { setError(error instanceof Error ? error.message : "Could not restart the Console."); }
    finally { setRestarting(false); }
  }

  // Saved application credentials can authorize this owner immediately. Public
  // Discord access loads after the final role selection and one restart.
  const step: "loading" | "connect" | "authorize" | "active" | "map" | "done" =
    done ? "done"
      : !probed ? "loading"
      : forceReconfigure ? "connect"
      : appSaved && !identity ? "authorize"
      : identity ? "map"
      : app?.mappingConfigured ? "active"
      : app?.configured ? "authorize"
      : "connect";
  const chosen = identity?.guilds.find((g) => g.id === guildId) || null;

  // #643: embedded mode drops the full-page "login-screen" chrome -- this
  // renders inside Settings' own accordion body now, not as a standalone
  // page, and a second <h1> on top of the accordion's own heading would be
  // an a11y regression (two level-1 headings on the same page).
  const Heading = embedded ? "h2" : "h1";

  const body = (
    <>
        <Heading>{step === "active" ? "Discord Sign In" : "Set Up Discord Sign In"}</Heading>

        {step === "loading" && <p className="loading-dots">Checking this console&apos;s Discord configuration</p>}

        {(step === "connect" || step === "authorize") && !isHttps && (
          <div className="settings-https-notice">
            <LockKeyhole size={18} aria-hidden="true" />
            <p><strong>Discord sign in requires HTTPS.</strong><span>Connect securely before continuing setup.</span></p>
            {onConfigureHttps ? <button type="button" onClick={onConfigureHttps}>Set Up HTTPS</button> : <HttpsSetup />}
          </div>
        )}
        {step === "connect" && isHttps && !appSaved && appPath === "unset" && (
          <>
            <p className="muted">Connect your Discord application, or create one to get started.</p>
            <div className="discord-setup-paths">
              <button type="button" className="login-primary-button" onClick={() => setAppPath("have-app")}><Link2 size={16} aria-hidden="true" />Existing App</button>
              <button type="button" className="login-secondary-button" onClick={() => setAppPath("need-app")}><Plus size={16} aria-hidden="true" />Create App</button>
            </div>
          </>
        )}
        {step === "connect" && isHttps && !appSaved && appPath !== "unset" && (
          <>
            {appPath === "need-app" && (
              <>
                <p className="muted">On <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">Discord&apos;s Developer Portal</a>:</p>
                <ol className="discord-setup-checklist">
                  <li>Click <strong>New Application</strong>.</li>
                  <li>Give the application your server or Console name so members recognize it.</li>
                  <li>Open the <strong>OAuth2</strong> tab.</li>
                  <li>Copy the <strong>Client ID</strong> and generate/copy a <strong>Client Secret</strong>.</li>
                  <li>Add the redirect URI shown below to the Redirects list.</li>
                </ol>
                {returnedFromDiscord && <p className="muted">Your application is ready. Add its Client ID and Client Secret below to connect it.</p>}
              </>
            )}
            <p className="muted">Choose an application just for your Console so members can recognize its name and icon when they sign in.</p>
            <label htmlFor="wiz-client-id">Client ID<input id="wiz-client-id" name="wiz-client-id" value={formClientId} onChange={(e) => setFormClientId(e.target.value)} placeholder="Discord application client ID" disabled={savingApp} /></label>
            <label htmlFor="wiz-client-secret">Client Secret{app?.secretSaved ? <span className="theme-note"> (saved)</span> : null}<SecretInput id="wiz-client-secret" name="wiz-client-secret" value={formClientSecret} onChange={(e) => setFormClientSecret(e.target.value)} placeholder={app?.secretSaved ? "Paste a new one to replace" : "Client secret"} disabled={savingApp} /></label>
            <label>Redirect URI<input readOnly value={redirectUri} /></label>
            <div className="action-row"><button type="button" onClick={() => { void copyText(redirectUri).catch(() => setError("Could not copy. Select the Redirect URI and copy it manually.")); }}>Copy Redirect URI</button><span className="muted">Add this address to your application&apos;s OAuth2 redirects.</span></div>
            <div className="action-row">
            <button type="button" className="login-primary-button" disabled={savingApp || !formClientId.trim()} onClick={() => { void saveApp(); }}>{savingApp ? "Saving..." : "Save"}</button>
            <button
              type="button"
              className="login-password-toggle"
              onClick={() => {
                // #643 §4.2: reconfigure mode skips the "have an app / need
                // one" chooser entirely (a reconfiguring operator obviously
                // already has one) -- so its own "Back" exits reconfigure
                // back to authorize/map instead of landing on that chooser.
                if (forceReconfigure) { setForceReconfigure(false); setAppPath("unset"); }
                else setAppPath("unset");
              }}
            >Back</button>
            </div>
          </>
        )}
        {step === "active" && (
          <>
            <p className="muted">Members can sign in with Discord. Edit Access opens Discord to verify server ownership before updating the connected server or roles.</p>
            <div className="discord-setup-actions" role="group" aria-label="Discord Settings Actions">
            <a
              className="login-discord-button login-discord-button-secondary"
              href="/api/auth/discord/start?setup=1"
              onClick={() => {
                // #643 §4.1: same marker as the authorize step's own
                // "Continue with Discord" -- this link reaches the identical
                // OAuth round-trip, just reframed for an operator who wants to
                // update guild/role mapping rather than finish first-time setup.
                if (embedded) { try { window.sessionStorage.setItem(DISCORD_SETUP_RETURN_MARKER, "1"); } catch { /* best effort */ } }
              }}
            >Edit Access</a>
            <button type="button" className="settings-link-action" onClick={() => { setAppSaved(false); setAppPath("have-app"); setForceReconfigure(true); }}>Edit App</button>
            <button type="button" className="login-password-toggle" onClick={onCancel}>Cancel</button>
            </div>
          </>
        )}

        {step === "authorize" && isHttps && (
          <>
            {appSaved && <p className="settings-inline-success"><CheckCircle2 size={16} aria-hidden="true" />Application Saved. Continue with Discord to choose your server and access roles.</p>}
            <p className="muted">Authorize Discord to choose a server you own and configure member access. You can also sign in with your Console password.</p>
            <a
              className="login-discord-button login-discord-button-primary"
              href="/api/auth/discord/start?setup=1"
              onClick={() => {
                // #643 §4.1: must complete before the browser processes this
                // navigation -- a synchronous storage write inside a click
                // handler always does, since the handler runs to completion
                // first. Absent when !embedded, so the pre-login flow's
                // standalone-wizard + forced-logout behavior is unaffected.
                if (embedded) { try { window.sessionStorage.setItem(DISCORD_SETUP_RETURN_MARKER, "1"); } catch { /* best effort */ } }
              }}
            >Continue With Discord</a>
            {app?.configured && <button type="button" className="settings-link-action" onClick={() => { setAppSaved(false); setAppPath("have-app"); setForceReconfigure(true); }}>Edit App</button>}
          </>
        )}

        {step === "map" && identity && (
          <>
            <p className="muted">Signed in with Discord as <strong>{identity.user.username}</strong>.{identity.user.mfaEnabled ? "" : " This Discord account has no two-factor authentication; enable it in Discord if you turn on the requirement below."}</p>
            {app?.configured && <button type="button" className="settings-link-action" onClick={() => { setAppSaved(false); setAppPath("have-app"); setForceReconfigure(true); }}>Edit App</button>}

            <h2 className="auth-step-heading">Your Server</h2>
            {identity.guilds.length === 0
              ? <p className="attention-text">Only a Discord server owner can connect their server to this Console. Ask your server owner to complete setup.</p>
              : identity.guilds.length === 1
                ? <p className="muted">Connecting <strong>{identity.guilds[0].name}</strong>, which you own. That makes you the console <strong>Owner</strong>; everyone else&apos;s access comes from the roles below.</p>
                : <label htmlFor="wiz-guild">Choose Your Server<select id="wiz-guild" name="wiz-guild" value={guildId} onChange={(e) => setGuildId(e.target.value)} disabled={busy}>
                    <option value="">Choose…</option>
                    {identity.guilds.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select></label>}

            <h2 className="auth-step-heading">Member Access</h2>
            <p className="muted">Discord identifies the server owner automatically, so no Owner Role ID is needed. Signing in with the Console password also grants Owner access.</p>
            <p className="muted">To copy a role ID, turn on Developer Mode in Discord (User Settings &rarr; Advanced), then right-click the role &rarr; Copy Role ID. To give several roles the same access, separate their IDs with commas.</p>
            <div className="discord-role-fields">
              <label htmlFor="wiz-admin"><span>Admin Role ID <small>(Required)</small></span><input id="wiz-admin" name="wiz-admin" value={adminRoleIds} onChange={(e) => setAdminRoleIds(e.target.value)} placeholder="Discord Role ID" disabled={busy} /></label>
              <label htmlFor="wiz-moderator"><span>Moderator Role ID <small>(Optional)</small></span><input id="wiz-moderator" name="wiz-moderator" value={moderatorRoleIds} onChange={(e) => setModeratorRoleIds(e.target.value)} placeholder="Discord Role ID" disabled={busy} /></label>
              <label htmlFor="wiz-player"><span>Player Role ID <small>(Recommended)</small></span><input id="wiz-player" name="wiz-player" value={playerRoleIds} onChange={(e) => setPlayerRoleIds(e.target.value)} placeholder="Discord Role ID" disabled={busy} /></label>
            </div>
            <label className="discord-mfa-option" htmlFor="wiz-mfa">
              <input id="wiz-mfa" name="wiz-mfa" type="checkbox" checked={requireMfa} onChange={(e) => setRequireMfa(e.target.checked)} disabled={busy} />
              <span className="discord-mfa-text">
                <span className="discord-mfa-title">Require Discord 2FA For Owners And Admins <span className="discord-mfa-tag">Recommended</span></span>
                <span className="muted">Owners and admins must enable two factor authentication on their Discord accounts before they can sign in. Discord performs this check. Your Console password and its authenticator settings are managed separately in Account Security.</span>
              </span>
            </label>

            <label className="discord-mfa-option" htmlFor="wiz-password-awareness">
              <input id="wiz-password-awareness" name="wiz-password-awareness" type="checkbox" checked={passwordAwarenessAcknowledged} onChange={(e) => setPasswordAwarenessAcknowledged(e.target.checked)} disabled={busy} />
              <span className="discord-mfa-text">
                <span className="discord-mfa-title">I know this console&apos;s admin password</span>
                <span className="muted">Keep your Console password available so you can sign in if Discord is unavailable. Confirm that you or your server operator can access it. The initial password is stored in <code>runtime/secrets/admin-web-password.txt</code> on the host.</span>
              </span>
            </label>

            <button type="button" className="login-primary-button" disabled={busy || !guildId || !passwordAwarenessAcknowledged} onClick={() => { void finalize(); }}>{busy ? "Saving..." : "Enable Discord Sign In"}</button>
          </>
        )}

        {step === "done" && done && (
          <section className="discord-setup-result" aria-label="Discord Connected">
            <div className="discord-setup-result-heading"><CheckCircle2 size={20} aria-hidden="true" /><h3>Discord Connected</h3></div>
            <p><strong>{done.guild}</strong> is connected. <strong>{done.owner}</strong> has owner access.</p>
            <p>Restart the Console to show Sign In With Discord on the login page. You can also use your Console password.</p>
            {restarting
              ? <p className="loading-dots" role="status">Rebuilding Console. This page will reconnect when it is ready.</p>
              : <button
                  type="button"
                  className="login-primary-button"
                  onClick={() => {
                    // #676 §7: set ONLY at the moment the restart is actually
                    // invoked (not at finalize() time) -- skipping this
                    // button (e.g. "Back to Settings" instead) must never
                    // set the marker, since the config change it refers to
                    // was never actually applied. Fires for a genuine
                    // first-time configuration with TOTP already enrolled;
                    // App.tsx consumes this once, after the real Discord
                    // login that follows the restart.
                    if (wasConfiguredAtMount.current === false && secondFactorEnrolledAtMount) {
                      try { window.sessionStorage.setItem("dune-console:discord-oauth-just-configured", "1"); } catch { /* best effort */ }
                    }
                    void restartNow();
                  }}
                ><RefreshCw size={16} aria-hidden="true" />Restart Console</button>}
            <details className="discord-setup-terminal"><summary>Restart From Terminal</summary><code>dune console restart</code></details>
          </section>
        )}

        {error && <p className="error" role="alert">{error}</p>}
        {!restarting && step !== "active" && <button type="button" className="login-password-toggle" onClick={done ? onDone : onCancel}>{done ? (embedded ? "Back To Settings" : "Back To Sign In") : "Cancel"}</button>}
    </>
  );

  if (embedded) return <div className="discord-setup-panel discord-setup-panel-embedded">{body}</div>;
  return (
    <main className="login-screen">
      <section className="login-panel discord-setup-panel">{body}</section>
    </main>
  );
}
