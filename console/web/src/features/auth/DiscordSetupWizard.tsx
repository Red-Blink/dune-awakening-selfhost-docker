import { useCallback, useEffect, useRef, useState } from "react";
import { api, post } from "../../api/client";
import { getAdminPort } from "../../api/serverPorts";
import { SecretInput } from "../../components/SecretInput";

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
  // #643: true when mounted inside Settings (an already-authenticated owner
  // reconfiguring) rather than the standalone pre-login flow. Changes: the
  // OAuth link sets DISCORD_SETUP_RETURN_MARKER first; "done"/restart copy
  // stops claiming the operator is being signed back in (they never left);
  // a "Change application credentials" affordance appears once configured,
  // since this is the only reachable path to rotate the secret once §643 has
  // replaced SettingsPanel's old always-editable manual form.
  embedded?: boolean;
};

const SNOWFLAKE = /^\d{17,19}$/;

export function DiscordSetupWizard({ onDone, onCancel, embedded = false }: Props) {
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
  // rather than a reconfiguration (e.g. "Change application credentials" on
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
      api<{ serverConfig?: Record<string, string>; config?: { discordOAuthAppConfigured?: boolean; discordOAuthConfigured?: boolean } }>("/api/settings"),
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
        configured: Boolean(settings.value.config?.discordOAuthAppConfigured),
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
      // before clicking "Turn on Discord sign-in" at all.
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
        throw new Error(`Each Discord role can map to only one access level -- ${conflicts.map(([roleId, tiers]) => `role ${roleId} is mapped to ${tiers.join(" and ")}`).join("; ")}.`);
      }
      const res = await post<{ ok: boolean; guild: { name: string }; owner: { username: string } }>("/api/setup/discord-finalize", {
        guildId, adminRoleIds: adminRoleIds.trim(), moderatorRoleIds: moderatorRoleIds.trim(), playerRoleIds: playerRoleIds.trim(), requireMfa
      });
      setDone({ guild: res.guild.name, owner: res.owner.username });
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  // waitFor picks which live config flag proves the NEW process has loaded
  // the just-written .env: discordOAuthConfigured (the default, used by the
  // "done" step below) also requires a home guild, which isn't set yet right
  // after the connect step's own save -- that step polls discordOAuthAppConfigured
  // instead, since that's the flag its own "configured" gate depends on.
  async function restartNow(waitFor: "discordOAuthConfigured" | "discordOAuthAppConfigured" = "discordOAuthConfigured") {
    setRestarting(true); setError("");
    try {
      await post("/api/setup/discord-restart", {});
    } catch { /* the container may drop the connection mid-response; that is expected */ }
    // Poll /api/auth/state until the NEW process reports the flag, then
    // reload. Keying on it (not on the connection dropping) is what makes
    // this robust behind a reverse proxy/tunnel: while the container
    // recreates, the proxy returns 502 *responses* (fetch resolves, never
    // throws), so a "did we see it go down" gate would never fire. The
    // pre-restart process reports the flag false; only the restarted one
    // reports true, so this cannot reload early.
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const res = await fetch("/api/auth/state", { cache: "no-store" });
        if (res.ok && (await res.json()).config?.[waitFor]) { window.location.replace("/"); return; }
      } catch { /* container mid-recreate; keep polling */ }
    }
    setRestarting(false);
    setError("The console is taking longer than expected to restart. Give it another minute and reload this page, or run `dune console restart` on the host.");
  }

  // Derived step -- the fix for the loop. identity present => map; else
  // mapping already finalized (active for everyone else, just not this
  // session) => active; else app ready but mapping not finished => authorize;
  // else connect the application. forceReconfigure (#643 §4.2) overrides this
  // to "connect" regardless, for an operator rotating an already-configured
  // application's credentials -- but never once "done" is reached, since that
  // outcome is final for this mount.
  //
  // appSaved is checked right after forceReconfigure, ahead of
  // identity/mappingConfigured/configured -- Layer 2 audit finding (Software
  // Architect hat, HIGH): saveApp() sets appSaved=true and forceReconfigure=
  // false, but app.mappingConfigured/app.configured are boot-time snapshots
  // that DON'T change from a save alone (the console only reads .env at
  // boot -- see restartNow()'s own comment). For an operator reconfiguring an
  // ALREADY-active install (mappingConfigured was already true before this
  // save started, and stays true until an actual restart), the step would
  // otherwise re-derive straight back to "active"/"authorize", silently
  // skipping the "Saved. ...a restart is needed" card -- and a subsequent
  // "Continue with Discord" click would authorize against the stale,
  // pre-rotation credentials still resident in the running process. appSaved
  // is reset by the full page reload restartNow() does on success, so it
  // cannot linger and block a later identity/map transition.
  const step: "loading" | "connect" | "authorize" | "active" | "map" | "done" =
    done ? "done"
      : !probed ? "loading"
      : forceReconfigure ? "connect"
      : appSaved ? "connect"
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
        <Heading>{step === "active" ? "Discord Sign-In" : "Set up Discord sign-in"}</Heading>

        {step === "loading" && <p className="loading-dots">Checking this console&apos;s Discord configuration</p>}

        {step === "connect" && !isHttps && (
          <>
            <p className="attention-text"><strong>Discord sign-in requires HTTPS.</strong> This page is not currently loaded over HTTPS, so the rest of this setup can&apos;t proceed yet. An <code>http://</code> callback is silently dropped by the browser, so this isn&apos;t a security-boundary check &mdash; it&apos;s here to stop a doomed attempt before it starts.</p>
            <ul className="discord-setup-https-options">
              <li>
                <strong>Cloudflare Tunnel</strong> (recommended) &mdash; a &ldquo;quick tunnel&rdquo; needs no account: run <code>cloudflared tunnel --url http://localhost:{getAdminPort()}</code> for an instant <code>*.trycloudflare.com</code> HTTPS address. Fine for finishing this setup, but its address changes every restart &mdash; for day-to-day reliability, move to a named tunnel (needs a Cloudflare account + a domain in their DNS) afterward.
              </li>
              <li>
                <strong>Tailscale HTTPS certificate</strong> &mdash; if the console is already reached over Tailscale, <code>tailscale cert</code> issues a real HTTPS certificate for the tailnet-only address, with no public exposure at all. Tailscale <strong>Funnel</strong> (a different feature, public exposure) is only needed if someone outside your tailnet must sign in too.
              </li>
              <li>
                <strong>ngrok</strong> &mdash; free tier works, but requires creating an ngrok account and configuring a personal authtoken first; the URL changes on restart unless paid.
              </li>
            </ul>
            <p className="muted">These are independent third-party services; this project doesn&apos;t operate, endorse, or provide support for them.</p>
            <p className="muted">Still not working after trying one of these? Reloading this page re-checks &mdash; there&apos;s nothing more to configure here until it reports HTTPS.</p>
          </>
        )}
        {step === "connect" && isHttps && appSaved && (
          <>
            <p className="attention-text">Saved. The console only reads <code>.env</code> at startup, so a restart is needed before Discord sign-in can continue.</p>
            {embedded && <p className="muted">This will end your current session — you&apos;ll need to sign back in after the restart.</p>}
            {restarting
              ? <p className="loading-dots">Restarting the console — this page will reconnect shortly</p>
              : <button type="button" className="login-primary-button" onClick={() => { void restartNow("discordOAuthAppConfigured"); }}>Restart the console now</button>}
            <p className="muted">Prefer to do it yourself? Run <code>dune console restart</code> on the host instead.</p>
          </>
        )}
        {step === "connect" && isHttps && !appSaved && appPath === "unset" && (
          <>
            <p className="muted">Discord sign-in is not set up on this server yet. Connecting the server to a Discord application is a one-time deployment step done by whoever runs the server &mdash; not something you do here, and not something a person signing in ever sees.</p>
            <button type="button" className="login-primary-button" onClick={() => setAppPath("have-app")}>I already have a Discord application</button>
            <button type="button" className="login-secondary-button" onClick={() => setAppPath("need-app")}>I need to create one</button>
          </>
        )}
        {step === "connect" && isHttps && !appSaved && appPath !== "unset" && (
          <>
            {appPath === "need-app" && (
              <>
                <p className="muted">On <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">Discord&apos;s Developer Portal</a>:</p>
                <ol className="discord-setup-checklist">
                  <li>Click <strong>New Application</strong>.</li>
                  <li>Name it for your server or console &mdash; not your bot.</li>
                  <li>Open the <strong>OAuth2</strong> tab.</li>
                  <li>Copy the <strong>Client ID</strong> and generate/copy a <strong>Client Secret</strong>.</li>
                  <li>Add the redirect URI shown below to the Redirects list.</li>
                </ol>
                {returnedFromDiscord && <p className="muted">Welcome back &mdash; paste your new application&apos;s Client ID and Secret below.</p>}
              </>
            )}
            <p className="muted">Tip: use a <strong>dedicated</strong> Discord application for the console, not your bot&apos;s. The application&apos;s <strong>name and icon are what people see on the Discord sign-in screen</strong>, so name it for your server or console and give it an icon &mdash; reusing the bot&apos;s application makes sign-in look like logging into the bot.</p>
            <label htmlFor="wiz-client-id">Client ID<input id="wiz-client-id" name="wiz-client-id" value={formClientId} onChange={(e) => setFormClientId(e.target.value)} placeholder="Discord application client ID" disabled={savingApp} /></label>
            <label htmlFor="wiz-client-secret">Client Secret{app?.secretSaved ? <span className="theme-note"> (saved)</span> : null}<SecretInput id="wiz-client-secret" name="wiz-client-secret" value={formClientSecret} onChange={(e) => setFormClientSecret(e.target.value)} placeholder={app?.secretSaved ? "Paste a new one to replace" : "Client secret"} disabled={savingApp} /></label>
            <p className="muted">Redirect URI: <code>{redirectUri}</code> <button type="button" className="login-password-toggle" onClick={() => { void navigator.clipboard?.writeText(redirectUri); }}>copy</button> &mdash; must also be added to the application&apos;s OAuth2 redirect list.</p>
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
          </>
        )}
        {step === "active" && (
          <>
            <p className="muted">Discord sign-in is connected and active for this server &mdash; people are already signing in with it. This browser session doesn&apos;t need to sign in with Discord again just to see this.</p>
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
            >Sign in with Discord to update server or role mapping</a>
            <button type="button" className="login-password-toggle" onClick={() => { setAppPath("have-app"); setForceReconfigure(true); }}>Change application credentials</button>
          </>
        )}

        {step === "authorize" && (
          <>
            <p className="muted">Sign in with Discord. The console will learn who you are and which servers you are in; the server you own makes you its Owner. Your admin password is not needed again — it stays as the way back in if Discord is ever unavailable.</p>
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
            >Continue with Discord</a>
            {app?.configured && <button type="button" className="login-password-toggle" onClick={() => { setAppPath("have-app"); setForceReconfigure(true); }}>Change application credentials</button>}
          </>
        )}

        {step === "map" && identity && (
          <>
            <p className="muted">Signed in with Discord as <strong>{identity.user.username}</strong>.{identity.user.mfaEnabled ? "" : " This Discord account has no two-factor authentication; enable it in Discord if you turn on the requirement below."}</p>
            {app?.configured && <button type="button" className="login-password-toggle" onClick={() => { setAppPath("have-app"); setForceReconfigure(true); }}>Change application credentials</button>}

            <h2 className="auth-step-heading">Your server</h2>
            {identity.guilds.length === 0
              ? <p className="attention-text">You do not own any Discord server. Only a server&apos;s owner can connect it to this console &mdash; ownership is what makes you the console Owner.</p>
              : identity.guilds.length === 1
                ? <p className="muted">Connecting <strong>{identity.guilds[0].name}</strong>, which you own. That makes you the console <strong>Owner</strong>; everyone else&apos;s access comes from the roles below.</p>
                : <label htmlFor="wiz-guild">Which of your servers<select id="wiz-guild" name="wiz-guild" value={guildId} onChange={(e) => setGuildId(e.target.value)} disabled={busy}>
                    <option value="">Choose…</option>
                    {identity.guilds.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select></label>}

            <h2 className="auth-step-heading">Who gets which access</h2>
            <p className="muted">Copy role IDs from Discord with Developer Mode on (User Settings &rarr; Advanced), then right-click a role &rarr; Copy Role ID. One or more per field, comma-separated. Owner is not a role — it is you, the server&apos;s owner.</p>
            <label htmlFor="wiz-admin">Admin Role <em>(required)</em><input id="wiz-admin" name="wiz-admin" value={adminRoleIds} onChange={(e) => setAdminRoleIds(e.target.value)} placeholder="Discord role ID" disabled={busy} /></label>
            <label htmlFor="wiz-moderator">Moderator Role <em>(optional)</em><input id="wiz-moderator" name="wiz-moderator" value={moderatorRoleIds} onChange={(e) => setModeratorRoleIds(e.target.value)} placeholder="Discord role ID" disabled={busy} /></label>
            <label htmlFor="wiz-player">Player Role <em>(recommended)</em><input id="wiz-player" name="wiz-player" value={playerRoleIds} onChange={(e) => setPlayerRoleIds(e.target.value)} placeholder="Discord role ID" disabled={busy} /></label>
            <label className="discord-mfa-option" htmlFor="wiz-mfa">
              <input id="wiz-mfa" name="wiz-mfa" type="checkbox" checked={requireMfa} onChange={(e) => setRequireMfa(e.target.checked)} disabled={busy} />
              <span className="discord-mfa-text">
                <span className="discord-mfa-title">Require <strong>Discord</strong> two-factor for Owner and Admin <span className="discord-mfa-tag">recommended</span></span>
                <span className="muted">Requires each person&apos;s <strong>Discord account</strong> to have two-factor enabled &mdash; it reuses Discord&apos;s own 2FA, and does <strong>not</strong> add a separate code the console asks for (that is the password tier&apos;s console 2FA, a different thing). An Owner or Admin whose Discord account has 2FA off is refused.</span>
              </span>
            </label>

            <label className="discord-mfa-option" htmlFor="wiz-password-awareness">
              <input id="wiz-password-awareness" name="wiz-password-awareness" type="checkbox" checked={passwordAwarenessAcknowledged} onChange={(e) => setPasswordAwarenessAcknowledged(e.target.checked)} disabled={busy} />
              <span className="discord-mfa-text">
                <span className="discord-mfa-title">I know this console&apos;s admin password</span>
                <span className="muted">This console also has a separate admin password &mdash; a break-glass fallback if Discord sign-in is ever unavailable. Confirm you (or your server operator) know it before continuing: it&apos;s in <code>runtime/secrets/admin-web-password.txt</code> on the host.</span>
              </span>
            </label>

            <button type="button" className="login-primary-button" disabled={busy || !guildId || !passwordAwarenessAcknowledged} onClick={() => { void finalize(); }}>{busy ? "Saving..." : "Turn on Discord sign-in"}</button>
          </>
        )}

        {step === "done" && done && (
          <>
            <p className="attention-text">
              Done. <strong>{done.guild}</strong> is connected and <strong>{done.owner}</strong> is the Owner. One restart applies it
              {embedded
                ? " — you'll need to sign back in afterward, with the admin password beneath it as the way back in if Discord is ever unavailable."
                : " — then the sign-in page shows "}
              {!embedded && <><strong>Sign in with Discord</strong>, with the admin password beneath it as the way back in.</>}
            </p>
            {restarting
              ? <p className="loading-dots">Restarting the console — this page will reconnect shortly</p>
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
                >Restart the console now</button>}
            <p className="muted">Prefer to do it yourself? Run <code>dune console restart</code> on the host instead.</p>
          </>
        )}

        {error && <p className="error">{error}</p>}
        {!restarting && <button type="button" className="login-password-toggle" onClick={done ? onDone : onCancel}>{done ? (embedded ? "Back to Settings" : "Back to sign in") : "Cancel"}</button>}
    </>
  );

  if (embedded) return <div className="discord-setup-panel discord-setup-panel-embedded">{body}</div>;
  return (
    <main className="login-screen">
      <section className="login-panel discord-setup-panel">{body}</section>
    </main>
  );
}
