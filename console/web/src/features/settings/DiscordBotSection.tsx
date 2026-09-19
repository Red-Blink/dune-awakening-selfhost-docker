import { useEffect, useRef, useState } from "react";
import { discordAdapterSettingsApi, type DiscordBotSettingsState } from "../../api/discordAdapterSettings";
import { discordHostedBotApi, type OwnedDiscordGuild } from "../../api/discordHostedBotApi";
import { updatesApi } from "../../api/updates";
import { persistUpdateTask, loadPersistedUpdateTask } from "../updates/updateUtils";
import { ConfirmDialog, type ConfirmDialogRequest, type ConfirmDialogOutcome } from "../../components/common/ConfirmDialog";
import { copyText } from "../../lib/clipboard";
import { SecretInput } from "../../components/SecretInput";

const TASK_KEY = "arrakis.discordAdapterEnableTask";
// GitHub automated-review finding on this PR's own first remediation
// attempt (dune-awakening-selfhost-docker#872): an in-memory `attempts`
// counter inside the polling effect bounds per-*mount*, not per-task --
// SettingsPanel.tsx renders this component conditionally
// (`{discordBotOpen && <DiscordBotSection />}`), so collapsing/re-expanding
// that accordion while phase is "enabling" unmounts/remounts this
// component, tearing down and recreating the effect with attempts reset to
// 0. runId/phase resume correctly from TASK_KEY, but the timeout budget
// re-arms in full every time -- a genuinely stuck task (the exact case this
// fix targets) could be kept hung forever by anyone toggling that section.
// Fixed by persisting the deadline itself (a wall-clock timestamp), not an
// in-memory tick count -- surviving remounts the same way runId/phase
// already do.
const POLL_DEADLINE_KEY = "arrakis.discordAdapterEnableTaskDeadline";
const CHOICE_KEY = "arrakis.discordAdapterChoice";
const POLL_INTERVAL_MS = 2000;
// dune-awakening-selfhost-docker#872 (automated review finding on
// already-merged #748): the enable/save-role-ids polling effect below
// only ever branched on state === "succeeded"/"failed" from
// updatesApi.stackProgress(), with no bound -- if runDiscordAdapterApplyTask
// throws before its shell helper ever writes a status file (a real,
// reachable path: cleanupStaleSelfUpdateHelpers's own "already running"
// contention error, or a docker command rejection), readSelfUpdateStatus's
// ENOENT branch returns {state:"pending"} with HTTP 200 forever, and this
// effect's own catch block swallows transient fetch errors as "keep
// polling" -- so the UI was stuck on phase === "enabling" permanently,
// with no error and no way forward except manually clearing localStorage.
// 3 minutes is generous for a real discordAdapterApply restart (which
// normally completes in well under a minute) while still bounding the wait
// to something finite.
const POLL_TIMEOUT_BUDGET_MS = 3 * 60 * 1000;

function persistPollDeadline(deadline: number | null) {
  if (typeof window === "undefined") return;
  try {
    if (deadline === null) window.localStorage.removeItem(POLL_DEADLINE_KEY);
    else window.localStorage.setItem(POLL_DEADLINE_KEY, String(deadline));
  } catch {
    // The visible page state still works if localStorage is unavailable --
    // the in-effect fallback below covers this case too.
  }
}

function loadPollDeadline(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(POLL_DEADLINE_KEY);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Round 4 (dune-awakening-selfhost-docker#876, design doc §13, issue #880):
// the confirmation-status poll needs its own persisted state, mirroring
// POLL_DEADLINE_KEY's own pattern above -- without this, collapsing the
// settings accordion (a genuine unmount, per SettingsPanel.tsx's
// `{discordBotOpen && <DiscordBotSection />}`) or a page reload during the
// up-to-~20-minute owner-confirmation wait would silently revert to
// "idle," inviting a duplicate registration attempt for a request that may
// still resolve server-side. Stores BOTH confirmationId and the poll's own
// deadline together (as one JSON blob) since they're only ever meaningful
// as a pair.
const CONFIRMATION_POLL_KEY = "arrakis.discordAutoInviteConfirmationPoll";

function persistConfirmationPoll(value: { confirmationId: string; deadline: number } | null) {
  if (typeof window === "undefined") return;
  try {
    if (value === null) window.localStorage.removeItem(CONFIRMATION_POLL_KEY);
    else window.localStorage.setItem(CONFIRMATION_POLL_KEY, JSON.stringify(value));
  } catch {
    // The visible page state still works if localStorage is unavailable.
  }
}

function loadConfirmationPoll(): { confirmationId: string; deadline: number } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CONFIRMATION_POLL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.confirmationId !== "string" || !parsed.confirmationId || typeof parsed?.deadline !== "number" || !Number.isFinite(parsed.deadline)) return null;
    return { confirmationId: parsed.confirmationId, deadline: parsed.deadline };
  } catch {
    return null;
  }
}

// Total wall-clock budget for the confirmation-status poll: mentat's own
// pendingOwnerConfirmations window (15 minutes) plus its 5-minute
// post-resolution grace window (mentat#356) -- see design doc §13.3.
const CONFIRMATION_POLL_INTERVAL_MS = 10 * 1000;
const CONFIRMATION_POLL_BUDGET_MS = 20 * 60 * 1000;
// Real UAT finding: the existing "this will restart the console" confirm
// dialog is a single click, and the moment it's confirmed the actual
// restart fires immediately with no further warning -- it felt abrupt and
// uncontrolled. Mirrors this codebase's own game-server restart queue
// pattern (AdminToolsPanel's "Restart Now" button skipping a countdown),
// scaled down for a console self-restart: a short, visible countdown with
// an explicit "Restart Now" to skip the wait, rather than either an
// instant restart or a mandatory full wait.
const RESTART_COUNTDOWN_SECONDS = 10;
// Real UAT finding (2026-09-09): nothing in this wizard ever told the
// operator that inviting the hosted bot (Sahir Venn) to their own Discord
// server is a separate, required, external step -- "Connect to hosted
// bot" below only verifies guild ownership and registers with mentat, it
// can never add the bot to a guild itself (Discord's OAuth `bot` scope
// consent is the only mechanism that does that, and it's a completely
// different flow from the `identify guilds` scope this component's own
// OAuth round trip uses). This is the exact same invite link mentat-link's
// own marketing/docs site already uses -- same client ID, same scope,
// same fixed permissions=128 -- so an operator who already knows to visit
// mentat-link doesn't get a different link/flow than one who never leaves
// the console.
//
// Real correctness bug (dune-awakening-selfhost-docker#903): this used to
// be a bare hardcoded string. The backend's own client_id
// (config.autoInviteDiscordClientId, what the NEW auto-invite flow's OAuth
// screen actually authorizes against) is now env-overridable -- a self-
// hoster who overrides it would otherwise have this OLD/Advanced flow's
// button silently keep inviting Sahir Venn regardless, a real, confusing
// mismatch between the two flows' bots. Built from the fetched settings
// state's own autoInviteDiscordClientId instead, falling back to Sahir
// Venn's client_id only for the brief window before that fetch resolves
// (same default the backend itself falls back to when unconfigured) --
// never leaves this button non-functional while state is loading.
const DEFAULT_AUTO_INVITE_DISCORD_CLIENT_ID = "1546203607807041697";
function buildMentatBotInviteUrl(clientId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&scope=bot%20applications.commands&permissions=128`;
}

const DISCORD_POPUP_WIDTH = 500;
const DISCORD_POPUP_HEIGHT = 800;

// Real UAT finding (2026-09-11): with no left/top given, browsers place a
// new popup wherever they see fit (often flush to a screen corner, not
// relative to the browser window the operator is actually looking at) --
// centers it within the CURRENT browser window instead (screenX/screenY +
// outerWidth/outerHeight, not the whole monitor, so it lands where the
// operator's eyes already are on a multi-monitor setup too). Shared by
// both window.open() call sites below rather than duplicated.
function centeredPopupFeatures(width: number, height: number): string {
  const left = window.screenX + Math.max(0, (window.outerWidth - width) / 2);
  const top = window.screenY + Math.max(0, (window.outerHeight - height) / 2);
  return `width=${width},height=${height},left=${Math.round(left)},top=${Math.round(top)}`;
}

// openBotInviteWindow: a popup, not a full-page navigation, so the
// operator never loses their place in this wizard. Discord's own
// bot-invite consent flow needs no redirect_uri at all -- approving (or
// cancelling) lands on Discord's own confirmation page inside the popup,
// which the operator closes themselves. Polling `.closed` (there is no
// cross-origin way to observe the popup's own navigation or get a
// postMessage from Discord's page) is what lets the wizard notice the
// operator is back without requiring them to click anything else here.
function openBotInviteWindow(clientId: string, onClosed: () => void) {
  const popup = window.open(buildMentatBotInviteUrl(clientId), "discord-bot-invite", centeredPopupFeatures(DISCORD_POPUP_WIDTH, DISCORD_POPUP_HEIGHT));
  if (!popup) return; // popup blocked -- the link below still works as a normal click-through
  const timer = window.setInterval(() => {
    if (popup.closed) {
      window.clearInterval(timer);
      onClosed();
    }
  }, 500);
}

type Choice = "hosted" | "self-hosted" | null;
type Phase = "loading" | "disabled" | "enabling" | "enabled" | "failed";
// The first-time setup wizard's own step, independent of Phase above.
// Only meaningful while phase === "disabled" -- once genuinely enabled,
// the operator is in the ongoing-management view (existing Save Role
// IDs / Regenerate Token / hosted-connect UI below), not the wizard.
// Real UAT feedback (2026-09-09): the previous single flat form asked
// for Role IDs before any bot was even configured, with no guidance on
// what either choice meant until well after clicking Enable -- this
// wizard exists specifically to sequence those concerns instead of
// showing everything at once with no context.
type WizardStep = 1 | 2 | 3;

// Same shape as loadPersistedUpdateTask/persistUpdateTask in updateUtils.ts
// (typeof-window guard, try/catch around localStorage access), just for a
// plain string value instead of a Task -- there's no shared helper for that
// shape, so this is a small, deliberately parallel pair rather than forcing
// `choice` through the Task-specific helpers.
function loadPersistedChoice(): Choice {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CHOICE_KEY);
    return raw === "hosted" || raw === "self-hosted" ? raw : null;
  } catch {
    return null;
  }
}

function persistChoice(value: Choice) {
  if (typeof window === "undefined") return;
  try {
    if (value) window.localStorage.setItem(CHOICE_KEY, value);
    else window.localStorage.removeItem(CHOICE_KEY);
  } catch {
    // The visible page state still works if localStorage is unavailable.
  }
}

export function DiscordBotSection() {
  const [state, setState] = useState<DiscordBotSettingsState | null>(null);
  // Seed runId/phase synchronously from localStorage, the same way
  // UpdatesPanel.tsx's gameUpdateTask/stackUpdateTask state does
  // (`useState<Task | null>(() => loadPersistedUpdateTask(...))`), instead of
  // setting them from inside the mount effect below. This closes a real
  // mount-time race (Layer 2 review finding, 2026-09-08): refresh() suspends
  // at its first await, yields back to the effect body, and its continuation
  // used to land *after* the effect body had already set phase="enabling",
  // unconditionally overwriting it with whatever the live GET reported at
  // that instant -- silently dropping reload-recovery (audit finding #9)
  // whenever the initial GET happened to succeed before the persisted task
  // finished. Seeding here means a persisted in-flight task is already
  // reflected in state before refresh() is even called (see the mount
  // effect below, which now skips refresh() entirely when runId is already
  // set on the first render).
  const [runId, setRunId] = useState<string | null>(() => loadPersistedUpdateTask(TASK_KEY)?.id ?? null);
  const [phase, setPhase] = useState<Phase>(() => (loadPersistedUpdateTask(TASK_KEY)?.id ? "enabling" : "loading"));
  // Seeded synchronously from localStorage, same convention as runId/phase
  // above -- otherwise the hosted/self-hosted token-destination instructions
  // (gated on `choice`) would vanish on every visit after the very first
  // Enable, since the backend's getState() never returns this (finding #1,
  // Layer 3 review).
  const [choice, setChoice] = useState<Choice>(() => loadPersistedChoice());
  // Real UAT finding (2026-09-09): an earlier version of this component
  // auto-skipped straight to step 2 whenever a choice was already
  // persisted from an earlier visit, on the theory that reloading
  // mid-setup shouldn't force re-picking hosted/self-hosted. In practice
  // this was actively confusing -- the operator never saw step 1 at all
  // and had no idea which choice, or why, had already been made for
  // them. The wizard now ALWAYS starts at step 1 on every fresh mount,
  // with no silent skip for any reason -- choice/role-ID VALUES are
  // still preserved across a reload (see loadPersistedChoice() above and
  // preserveInputs in refresh() below), only the wizard's own on-screen
  // step position is not.
  const [wizardStep, setWizardStep] = useState<WizardStep>(1);
  const [playerRoleIds, setPlayerRoleIds] = useState("");
  const [moderatorRoleIds, setModeratorRoleIds] = useState("");
  const [adminRoleIds, setAdminRoleIds] = useState("");
  const [error, setError] = useState("");
  const [confirmRequest, setConfirmRequest] = useState<ConfirmDialogRequest | null>(null);
  // Transient, in-memory only -- never persisted to localStorage or logged
  // (Requirement 24). Holds the plaintext token exactly once, immediately
  // after Enable/Regenerate, since the backend never returns it again on
  // a later GET (Design §3.1's "masked, with reveal/copy" requirement).
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [tokenCopyResult, setTokenCopyResult] = useState("");
  // Shared "any action in flight" guard (finding #5, Layer 3 review) --
  // Enable/Save Role IDs/Regenerate Token never render at the same time as
  // each other except Save Role IDs and Regenerate Token, which is fine to
  // share since both mutate the same adapter config and shouldn't overlap
  // anyway.
  const [submitting, setSubmitting] = useState(false);
  // Task 8 (hosted-bot console-initiated OAuth registration): seeded once,
  // synchronously, from sessionStorage -- the OAuth callback redirect back
  // to this page is expected to have stashed the operator's owned-guild
  // list there before this component mounts (see hostedBotOAuth.js's
  // hostedBotOAuthReturnPage(), and discordHostedBotApi.readOwnedGuilds(),
  // renamed from readOwnedGuildsFromWindow -- final integration review,
  // CRITICAL -- since a plain `window` property never actually survives the
  // callback page's own full-document `window.location.replace("/")`
  // navigation into this SPA's brand-new window; sessionStorage is scoped
  // to the origin, not to a `window` instance, so it does).
  // readOwnedGuilds() deletes the sessionStorage key as it reads it, which
  // makes the useState initializer below impure -- React.StrictMode
  // (main.tsx) deliberately double-invokes an impure lazy-initializer
  // function to surface exactly this hazard. Verified directly (fix-round-1
  // review, when this still read from `window`): a naive
  // `useState(() => readOwnedGuildsFromWindow())` genuinely calls the reader
  // TWICE per mount under StrictMode -- in the installed React 19 build the
  // DOM still happened to render the real guild list either way (which
  // call's result React keeps turned out to be an unspecified
  // implementation detail this component must not rely on), but the
  // destructive read/delete itself still fired twice, which is the real
  // defect: a second, silent, no-op read of a resource that's supposed to
  // be consumed exactly once. Cache the outcome of the *first* call in a
  // ref (created once; empirically confirmed to keep its mutated value
  // across both StrictMode invocations of this fiber's render) so the
  // underlying read only ever happens once, and every invocation of the
  // initializer -- however many times React makes it -- returns the same,
  // cached value. Same hazard class BaseWaterTab.tsx/BaseInventoryTab.tsx
  // guard against for their load effects (a ref-guard against StrictMode's
  // double-invoke), adapted here for a lazy initializer rather than an
  // effect. Covered by the "reads owned guilds exactly once under a
  // StrictMode double-invoke" test below, which asserts the call count
  // directly rather than relying on the DOM output that happens to look
  // correct either way.
  const ownedGuildsFromStorageRef = useRef<OwnedDiscordGuild[] | null | undefined>(undefined);
  const [ownedGuilds, setOwnedGuilds] = useState<OwnedDiscordGuild[] | null>(() => {
    if (ownedGuildsFromStorageRef.current === undefined) {
      const fromStorage = discordHostedBotApi.readOwnedGuilds();
      ownedGuildsFromStorageRef.current = fromStorage.length > 0 ? fromStorage : null;
    }
    return ownedGuildsFromStorageRef.current;
  });
  const [pickedGuild, setPickedGuild] = useState<OwnedDiscordGuild | null>(null);
  const [connectedGuildName, setConnectedGuildName] = useState<string | null>(null);
  // GitHub automated review finding (round 4, #891): the OLD flow's own
  // invite-acknowledgement checkbox below is gated on connectedGuildName
  // alone, on the assumption (stated in that checkbox's own comment) that
  // only the OLD flow's handleRegisterGuild() ever sets it. The new
  // auto-invite poll effect's confirmed branch also sets connectedGuildName
  // (so the "already connected" banner above renders correctly even while
  // "Advanced" stays open and wizardStep never advances) -- without this
  // flag that broke the checkbox's own invariant, showing the OLD flow's
  // "confirm you've invited the bot" checkbox/copy for a connection that
  // was never a manual invite.
  const [connectedViaAutoInvite, setConnectedViaAutoInvite] = useState(false);
  // Set once the "Add to Discord" popup closes (see openBotInviteWindow
  // above) -- purely a UI acknowledgement so the operator gets some
  // feedback that they're back, since there's no reliable cross-origin
  // way to confirm the invite actually succeeded from here.
  const [botInviteWindowClosed, setBotInviteWindowClosed] = useState(false);
  // Independent UI/UX review (HIGH H1): "Add to Discord" (invites the bot)
  // and "Connect to hosted bot" (verifies guild ownership + registers) are
  // fully independent -- an operator can skip the invite entirely, still
  // successfully register a guild, and finish the whole wizard with a
  // registered-but-never-invited, non-functional bot integration, with
  // nothing anywhere telling them. This can't be verified for real from
  // here (no reliable cross-origin signal that the invite popup actually
  // completed, see openBotInviteWindow's own comment) -- an explicit
  // acknowledgement is the honest, lightweight mitigation: it doesn't
  // guarantee correctness, but it forces the operator to consciously
  // confirm the step rather than silently skip past it.
  const [botInviteAcknowledged, setBotInviteAcknowledged] = useState(false);
  // Real UAT finding (2026-09-09): "Connect to hosted bot" needs its own,
  // independent Discord Application -- deliberately separate from Settings
  // -> Discord OAuth's console-sign-in credentials ("we have OAuth without
  // bot and bot without OAuth"). oauthClientId/oauthRedirectUri are
  // pre-filled from refresh()'s fetched state (non-secret, safe to show
  // back); oauthSecret is always blank -- the server never returns it.
  const [oauthClientId, setOAuthClientId] = useState("");
  const [oauthRedirectUri, setOAuthRedirectUri] = useState("");
  const [oauthSecret, setOAuthSecret] = useState("");
  const [oauthConfigured, setOAuthConfigured] = useState(false);
  const [oauthSaving, setOAuthSaving] = useState(false);
  const [oauthSaveResult, setOAuthSaveResult] = useState("");
  // Real UAT finding (2026-09-10): 3-step wizard redesign -- "Add bot to
  // Discord" is now step 1, ahead of role config and the restart, but
  // registering a guild with mentat requires the console's own adapter
  // token to already exist (tokenConfigured). Picking "Hosted bot" now
  // silently mints that token in the background (enable() already does
  // this without restarting, unchanged from the earlier fix) -- this
  // just gates step 1's Discord-connection UI behind that finishing,
  // instead of asking the operator to click a separate "Enable" first.
  const [silentEnabling, setSilentEnabling] = useState(false);
  // Real UAT finding (2026-09-09): handleEnable()/handleUpdateRoleIds()
  // used to fire their restart-triggering API call the instant the
  // ConfirmDialog above was confirmed, with no further warning -- the
  // console just went unreachable a moment later with no acknowledgement.
  // waitForRestartCountdown() adds a visible pause between confirmation
  // and the actual restart: a countdown notice with a "Restart Now"
  // button to skip the wait. It resolves either when the countdown
  // reaches zero (the ticking effect below) or when the operator clicks
  // "Restart Now" (finishRestartCountdown()), whichever comes first. The
  // resolver is stashed in a ref rather than state since it's a function,
  // not a value the render needs to read.
  const restartCountdownResolveRef = useRef<(() => void) | null>(null);
  const [restartCountdownSeconds, setRestartCountdownSeconds] = useState<number | null>(null);

  // Phase 6 (dune-awakening-selfhost-docker#832/#865): the fully-automated
  // auto-invite flow, shipped ALONGSIDE renderHostedBotConnection() below
  // (unchanged, not modified), per the design doc's §9 Option B rollout --
  // the old independent-Discord-Application flow is only removed once this
  // new flow is confirmed working end-to-end (a later, separate change),
  // not in this one.
  //
  // "idle": nothing started yet, or the operator abandoned a popup mid-flow
  //   (design doc §6 -- "no error, not a dead end", so this state is also
  //   what an abandoned attempt resets back to, not "failed").
  // "awaiting-popup": popup open, no outcome yet.
  // "waiting-for-owner": the popup reported ok:true and self-closed -- this
  //   means "staged, verified owner notified," NOT "connected" (mentat's
  //   own signedRedirect fires at staging time, not at Confirm time -- see
  //   mentat/src/setupServer.js's own documented reinterpretation of the
  //   design doc's sequence diagram). Core has no live signal for when/if
  //   the owner actually confirms -- that mechanism is explicitly deferred
  //   (server.js's own /auto-invite/complete comment) -- so this state is
  //   terminal from this component's own point of view until the operator
  //   reloads or starts over.
  // "failed": the popup reported ok:false, with a reason code to explain.
  // Round 4 (issue #880): seeded from the persisted confirmation-status
  // poll, the same way runId/phase above are seeded from TASK_KEY --
  // without this, autoInviteStatus always starts "idle" on a fresh mount
  // regardless of a still-valid, in-progress poll in localStorage, so a
  // reload or accordion collapse/reopen would never resume polling at all.
  const [autoInviteStatus, setAutoInviteStatus] = useState<"idle" | "awaiting-popup" | "waiting-for-owner" | "failed">(() => {
    const persisted = loadConfirmationPoll();
    return persisted && persisted.deadline > Date.now() ? "waiting-for-owner" : "idle";
  });
  const [autoInviteReclaimed, setAutoInviteReclaimed] = useState(false);
  const [autoInviteFailureReason, setAutoInviteFailureReason] = useState("");
  const [autoInvitePopupBlockedUrl, setAutoInvitePopupBlockedUrl] = useState<string | null>(null);
  const autoInvitePopupRef = useRef<Window | null>(null);
  // Round 4 (dune-awakening-selfhost-docker#876, design doc §13, issue
  // #888): the confirmation-status poll auto-advances the wizard on
  // success -- this ref lets that logic check whether the operator has the
  // "Advanced: connect manually instead" disclosure open
  // before yanking them to step 2 out from under it.
  const advancedDetailsRef = useRef<HTMLDetailsElement | null>(null);
  // The confirmation-status poll's own elapsed-time-aware wait copy (issue
  // #888) -- ticks once per poll interval while a poll is active.
  const [confirmationPollElapsedMs, setConfirmationPollElapsedMs] = useState(0);
  // The poll's own terminal outcome, distinct from autoInviteStatus's
  // "waiting-for-owner" (which only ever meant "request sent," never
  // "confirmed") -- drives the wizard auto-advance and status-specific
  // copy (issue #888).
  const [confirmationPollOutcome, setConfirmationPollOutcome] = useState<"" | "denied" | "owner_changed" | "timed_out" | "gave_up">("");
  // Automated review finding (PR #868): a real backend request can still
  // be outstanding on mentat's side even after the operator clicks "Start
  // over" (which only resets the VISIBLE autoInviteStatus back to "idle"
  // client-side -- there is no cancel endpoint to actually tell mentat to
  // discard the staged pendingOwnerConfirmation). Gating the guard below
  // purely on autoInviteStatus meant "Start over" silently re-armed
  // Regenerate Token/Disable/Save Role IDs while mentat could still
  // complete registration later using a now-stale adapter token -- the
  // exact desync this guard exists to prevent. autoInviteBlockUntil is a
  // separate timestamp, set only when a request is genuinely staged
  // (never cleared by "Start over"), that self-expires after mentat's own
  // pendingOwnerConfirmations TTL (15 minutes, design doc §4.5) -- past
  // that point mentat has itself discarded the pending record on timeout
  // (§4.2 Path F), so continuing to block is no longer protecting
  // anything real.
  const AUTO_INVITE_BLOCK_MS = 15 * 60 * 1000;
  // Seeded from the same persisted poll as autoInviteStatus above (issue
  // #880/#881) -- without this, a remount that resumes "waiting-for-owner"
  // would leave Regenerate Token/Disable/Save Role IDs briefly unguarded
  // until the first poll tick (up to CONFIRMATION_POLL_INTERVAL_MS later)
  // re-derives the real deadline.
  const [autoInviteBlockUntil, setAutoInviteBlockUntil] = useState<number | null>(() => {
    const persisted = loadConfirmationPoll();
    return persisted && persisted.deadline > Date.now() ? persisted.deadline : null;
  });
  useEffect(() => {
    if (autoInviteBlockUntil === null) return undefined;
    const remaining = autoInviteBlockUntil - Date.now();
    if (remaining <= 0) { setAutoInviteBlockUntil(null); return undefined; }
    const timer = window.setTimeout(() => setAutoInviteBlockUntil(null), remaining);
    return () => window.clearTimeout(timer);
  }, [autoInviteBlockUntil]);
  // Layer 2 audit finding (HIGH, PR #868): a request is genuinely in
  // flight -- either the popup is open, or mentat has staged the
  // registration and is waiting on the owner's Discord confirmation --
  // for as long as this is true. The adapter token this component just
  // sent to mentat as part of that request must not be invalidated (by
  // Regenerate Token or Disable) or have the console restarted out from
  // under it (by Save Role IDs) while it's still relying on that exact
  // token/liveness -- mentat's own pending records hold a COPY of the
  // token captured at staging time, so regenerating it afterward silently
  // desyncs mentat's copy from Core's real, live value. Also applied to
  // the OLD, advanced flow's own Connect/Register buttons below (a narrow,
  // audit-required exception to renderHostedBotConnection() otherwise
  // being left unchanged) -- running both flows concurrently for the same
  // guild is never a safe combination.
  const autoInvitePending = autoInviteStatus === "awaiting-popup" || autoInviteBlockUntil !== null;

  // Listens for the popup's own autoInviteCompletePage() postMessage
  // (autoInvite.js, Core's /auto-invite/complete route) -- targetOrigin is
  // always window.location.origin there (never "*"), so this handler only
  // ever needs to trust same-origin messages, matching that page's own
  // documented contract.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; result?: { ok?: boolean; guildName?: string; reason?: string; reclaimed?: boolean; confirmationId?: string } } | null;
      if (!data || data.type !== "hosted-bot-auto-invite-complete" || !data.result) return;
      if (data.result.ok) {
        setAutoInviteStatus("waiting-for-owner");
        setAutoInviteReclaimed(Boolean(data.result.reclaimed));
        setAutoInviteBlockUntil(Date.now() + AUTO_INVITE_BLOCK_MS);
        setConfirmationPollOutcome("");
        setConfirmationPollElapsedMs(0);
        // Round 4 (issue #879, hop 3 of 3): confirmationId arrives here via
        // the popup's own postMessage payload -- the popup itself is gone
        // ~1.2s after loading, so this is the only place the opener can
        // ever pick it up. Without it, there is nothing to poll with.
        // Layer 2 audit finding: always clear any STALE prior poll entry
        // first, unconditionally -- without this, a genuine new attempt
        // whose payload is somehow missing confirmationId (version skew
        // between Core and mentat-link) would silently resume polling an
        // OLD, unrelated confirmationId left over from an earlier attempt,
        // instead of either polling nothing or clearly having nothing to
        // poll with.
        persistConfirmationPoll(null);
        const confirmationId = String(data.result.confirmationId || "");
        if (confirmationId) {
          persistConfirmationPoll({ confirmationId, deadline: Date.now() + CONFIRMATION_POLL_BUDGET_MS });
        }
      } else {
        setAutoInviteStatus("failed");
        setAutoInviteFailureReason(data.result.reason || "");
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Detects the operator closing the popup themselves before any outcome
  // ever arrives (design doc §6: "normal abandonment, not a failure") --
  // the postMessage listener above can't distinguish "still working" from
  // "gave up," so this is the only signal for that case, mirroring
  // openBotInviteWindow's own existing `.closed`-poll pattern.
  useEffect(() => {
    if (autoInviteStatus !== "awaiting-popup") return undefined;
    const timer = window.setInterval(() => {
      if (autoInvitePopupRef.current?.closed) {
        window.clearInterval(timer);
        setAutoInviteStatus((prev) => (prev === "awaiting-popup" ? "idle" : prev));
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [autoInviteStatus]);

  // Round 4 (dune-awakening-selfhost-docker#876, design doc §13): the
  // completion-signal poll itself. Before this existed, "waiting-for-owner"
  // was a genuine dead end -- Core had no way to ever learn whether/when
  // the Discord owner confirmed. Every requirement here mirrors the
  // settings-apply poll a few hundred lines below (issues #872/#874's own
  // bounded-poll fix), per issue #884's explicit instruction not to
  // reintroduce that bug class in a new location:
  //  - persisted state (confirmationId + deadline) survives reload/unmount
  //    (issue #880), read fresh on every mount rather than assumed absent.
  //  - `stopped`/`inFlight` guards prevent overlapping ticks if a call
  //    takes longer than the interval (issue #884).
  //  - bounded to CONFIRMATION_POLL_BUDGET_MS, never polls forever.
  useEffect(() => {
    if (autoInviteStatus !== "waiting-for-owner") return undefined;
    const persisted = loadConfirmationPoll();
    if (!persisted) return undefined; // nothing to poll -- e.g. an old session predating this feature
    const { confirmationId, deadline } = persisted;
    let stopped = false;
    let inFlight = false;
    // GitHub automated review finding (round 4, #891): deriving startedAt
    // from Date.now() here reset the elapsed-time display to 0 on every
    // remount (e.g. collapsing/reopening the "Advanced" accordion) --
    // exactly the reload/remount scenario issue #880's persisted-poll fix
    // above was meant to survive. `deadline` is persisted alongside
    // confirmationId (loadConfirmationPoll(), read fresh every mount) and
    // was always set to the real start time plus the fixed
    // CONFIRMATION_POLL_BUDGET_MS, so it can be inverted back to the real
    // start time instead of assuming "now" is when polling began.
    const startedAt = deadline - CONFIRMATION_POLL_BUDGET_MS;
    setConfirmationPollElapsedMs(Date.now() - startedAt);
    const interval = window.setInterval(async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      setConfirmationPollElapsedMs(Date.now() - startedAt);
      try {
        const result = await discordHostedBotApi.pollConfirmationStatus(confirmationId);
        if (stopped) return;
        if (result.status === "confirmed") {
          stopped = true;
          window.clearInterval(interval);
          persistConfirmationPoll(null);
          setAutoInviteBlockUntil(null);
          setConnectedGuildName(result.guildName || "");
          setConnectedViaAutoInvite(true);
          // UI/UX finding (issue #888): don't yank the operator away from
          // the "Advanced" fallback form if they have it open.
          if (wizardStep === 1 && !advancedDetailsRef.current?.open) {
            setWizardStep(2);
          }
          return;
        }
        if (result.status === "denied" || result.status === "owner_changed" || result.status === "timed_out") {
          stopped = true;
          window.clearInterval(interval);
          persistConfirmationPoll(null);
          setAutoInviteBlockUntil(null);
          setConfirmationPollOutcome(result.status);
          return;
        }
        // "pending" or "not_found" (the latter only past mentat's own
        // retention window, indistinguishable from "expired" by design) --
        // keep polling until the budget below is exhausted. Issue #881:
        // re-derive autoInviteBlockUntil FROM this poll's own real deadline
        // on every still-pending tick, rather than leaving it as an
        // independent, decoupled 15-minute clock -- the poll's own budget
        // (up to ~20 minutes) is authoritative for as long as polling is
        // genuinely still active, closing the 0-5 minute window where the
        // old fixed timer could re-enable Regenerate Token/Disable/Save
        // Role IDs while a confirmation might still resolve.
        setAutoInviteBlockUntil(deadline);
      } catch {
        // Transient network/mentat-link hiccup -- keep polling, matching
        // the settings-apply poll's own established convention.
      } finally {
        inFlight = false;
      }
      if (stopped) return;
      if (Date.now() >= deadline) {
        stopped = true;
        window.clearInterval(interval);
        persistConfirmationPoll(null);
        setAutoInviteBlockUntil(null);
        setConfirmationPollOutcome("gave_up");
      }
    }, CONFIRMATION_POLL_INTERVAL_MS);
    return () => { stopped = true; window.clearInterval(interval); };
  }, [autoInviteStatus, wizardStep]);

  function autoInviteFailureMessage(reason: string) {
    switch (reason) {
      case "denied": return "You cancelled on Discord's consent screen — try again whenever you're ready.";
      case "not_owner": return "Discord says you don't own this server — only the server owner can connect it.";
      case "expired": return "This connection attempt expired — try again.";
      case "discord_unreachable": return "Could not reach Discord — try again in a moment.";
      default: return "Could not connect — try again, or use the advanced setup below.";
    }
  }

  async function handleStartAutoInvite() {
    if (submitting) return;
    setSubmitting(true);
    setError("");
    setAutoInvitePopupBlockedUrl(null);
    // Layer 2 audit finding (MEDIUM, PR #868): clear any previous
    // failed-attempt state before a retry -- otherwise a first attempt
    // that failed, followed by a second attempt whose popup gets
    // blocked, would render both the old failure message AND the new
    // popup-blocked message at once, contradicting each other.
    setAutoInviteStatus("idle");
    setAutoInviteFailureReason("");
    // Automated review finding (PR #868): window.open() must be called
    // SYNCHRONOUSLY inside this click handler, before any await -- once a
    // promise is awaited first, the call loses the click's own "transient
    // activation" and browsers treat it as programmatic, not user-
    // initiated (Safari always blocks it this way; Chrome/Firefox once the
    // network round trip exceeds a few seconds). Opening a blank popup
    // now and setting its location once startAutoInvite() resolves
    // preserves activation, unlike the old (buggy) ordering that opened
    // the popup only after the await.
    const popup = window.open("", "discord-auto-invite", centeredPopupFeatures(DISCORD_POPUP_WIDTH, DISCORD_POPUP_HEIGHT));
    try {
      const { authorizeUrl } = await discordHostedBotApi.startAutoInvite(window.location.origin);
      if (!popup || popup.closed) {
        // Popup blocked -- same failure mode openBotInviteWindow() already
        // handles for the old flow (design doc §6); a plain link the
        // operator can click through manually is the fallback here too.
        setAutoInvitePopupBlockedUrl(authorizeUrl);
        return;
      }
      popup.location.href = authorizeUrl;
      autoInvitePopupRef.current = popup;
      setAutoInviteStatus("awaiting-popup");
    } catch (err) {
      popup?.close();
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function waitForRestartCountdown(seconds: number) {
    return new Promise<void>((resolve) => {
      restartCountdownResolveRef.current = resolve;
      setRestartCountdownSeconds(seconds);
    });
  }

  function finishRestartCountdown() {
    restartCountdownResolveRef.current?.();
    restartCountdownResolveRef.current = null;
    setRestartCountdownSeconds(null);
  }

  useEffect(() => {
    if (restartCountdownSeconds === null) return;
    if (restartCountdownSeconds <= 0) {
      finishRestartCountdown();
      return;
    }
    const timer = setTimeout(() => {
      setRestartCountdownSeconds((seconds) => (seconds === null ? null : seconds - 1));
    }, 1000);
    return () => clearTimeout(timer);
  }, [restartCountdownSeconds]);

  // dune-awakening-selfhost-docker#870 (automated review finding on #801,
  // real/normal severity): if this component unmounts while a restart
  // countdown is in flight -- e.g. the operator collapses the Settings
  // accordion that conditionally renders DiscordBotSection -- the ticking
  // effect's own cleanup above only clears its setTimeout; it never
  // resolves the Promise waitForRestartCountdown() handed back to
  // handleDisable()/handleEnable()/handleUpdateRoleIds(). Those handlers
  // keep running after unmount (an already-invoked async function is not
  // tied to component lifecycle), but with the Promise never settling
  // they never reach their own restart() call. For Disable specifically
  // this is a real security gap, not just a stuck spinner: disable()
  // already wiped the adapter token server-side (its own confirm dialog
  // says "cannot be undone"), but the restart that's supposed to make
  // that live never fires, so the "invalidated" token's bot process keeps
  // running indefinitely. A mount-once effect whose cleanup only runs on
  // true unmount guarantees the countdown always resolves, regardless of
  // which handler is waiting on it.
  useEffect(() => {
    return () => {
      restartCountdownResolveRef.current?.();
      restartCountdownResolveRef.current = null;
    };
  }, []);

  function updateChoice(value: Choice) {
    setChoice(value);
    persistChoice(value);
  }

  // Layer 3 audit finding (HIGH): the "enabled" management view's own
  // choice toggle (below) used to call plain updateChoice(), which only
  // ever touches local state/localStorage -- never the server. But the
  // "Connect to hosted bot" UI (the auto-invite flow and the Advanced
  // manual-connect disclosure) renders based on that same local `choice`
  // value, appearing immediately on click, well before deploymentChoice is
  // actually persisted server-side (only "Save Role IDs" does that, via
  // handleUpdateRoleIds). An operator who clicked "Connect to hosted bot"
  // in that window hit a real 403 from /oauth/start's server-side
  // deploymentChoice gate (server.js), which reads the real, saved value,
  // not what the button just showed. Mirrors chooseAndAdvance()'s own
  // already-established, already-audited pattern (used by the wizard's
  // step-1 picker) -- persist immediately, so the UI is never ahead of
  // what the server will actually accept.
  async function updateChoiceAndPersist(value: Choice) {
    updateChoice(value);
    setError("");
    try {
      await discordAdapterSettingsApi.setChoice(value === "hosted" ? "hosted" : "self-hosted");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Picking a choice on the wizard's first step records it and, for
  // self-hosted, advances straight to role config -- unchanged. The choice
  // buttons in the ongoing-management view (phase === "enabled") use plain
  // updateChoice() instead, since that view isn't part of the step-1..3
  // wizard at all.
  //
  // Real UAT finding (2026-09-10): "Hosted bot" now STAYS on step 1 --
  // step 1's own content switches from the picker to "Add bot to Discord"
  // (see the render below), matching the operator's own requested step
  // order (add bot -> configure roles -> restart) instead of the previous
  // order (choice -> roles -> enable, with the Discord connection buried
  // in the post-enable management view). Persists deploymentChoice
  // server-side immediately (the hosted-bot OAuth routes' gate needs it)
  // and silently mints the adapter token in the background (Register
  // needs tokenConfigured -- see enable()'s own comment for why this
  // doesn't trigger a restart) so every button in step 1's Discord-connect
  // flow is immediately usable, with no separate "Enable" click first.
  async function chooseAndAdvance(value: Choice) {
    updateChoice(value);
    if (value === "self-hosted") {
      setWizardStep(2);
    }
    setError("");
    try {
      await discordAdapterSettingsApi.setChoice(value === "hosted" ? "hosted" : "self-hosted");
      if (value === "hosted" && !state?.tokenConfigured) {
        setSilentEnabling(true);
        // Independent UI/UX review (CRITICAL C2): this used to also call
        // setRevealedToken(), surfacing the full "copy this now, it will
        // never be shown again" one-time-secret banner the instant the
        // operator clicked a picker button -- alarming and unexplained,
        // with none of the self-hosted path's own handoff panel telling
        // them why. The hosted path never needs the operator to manually
        // handle this token at all (mentat's own registration call
        // forwards it server-side) -- deliberately discarded here rather
        // than revealed, unlike every other mint in this file.
        await discordAdapterSettingsApi.enable({
          playerRoleIds: "",
          moderatorRoleIds: "",
          adminRoleIds: "",
          deploymentChoice: "hosted"
        });
        // Deliberately NOT calling refresh() here -- the server genuinely
        // does report enabled: true now, and refresh() unconditionally
        // sets phase to match (see its own comment below), which would
        // drop straight to the post-setup management view before the
        // operator has even seen step 1's "Add bot to Discord" content.
        // Patch just the one field this step actually needs -- the rest
        // of the wizard's state (oauthConfigured, connectedGuildName,
        // ownedGuilds) already came from the real mount-time refresh()
        // and this silent enable doesn't touch any of it.
        setState((prev) => (prev ? { ...prev, enabled: true, tokenConfigured: true } : prev));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSilentEnabling(false);
    }
  }

  async function refresh(options?: { preserveInputs?: boolean }) {
    const nextState = await discordAdapterSettingsApi.getState();
    setState(nextState);
    // The backend's persisted deploymentChoice (Task 2) is now authoritative
    // once available -- but only overwrite the localStorage-seeded choice
    // when the backend actually has a value; a null/undefined response
    // (nothing ever persisted server-side yet) must not clobber a value an
    // operator already set before this change shipped, or one already
    // selected in this session that hasn't been submitted yet.
    if (nextState.deploymentChoice) setChoice(nextState.deploymentChoice);
    // Final integration review (Important #5): the persisted hosted-bot
    // connection (adapterSettings.js's persistHostedBotConnectedGuild(),
    // written by the /register route on a successful mentat response) is
    // now the source of truth for "Connected to hosted bot for {name}"
    // across a page reload -- previously this was pure in-memory React
    // state, so a reload silently showed "Connect to hosted bot" again as
    // if the registration had never happened.
    //
    // Fix round 2 (Priority 2): unlike deploymentChoice/role IDs above,
    // this is unconditionally synced from the server on every refresh(),
    // not just set-when-truthy. handleRegisterGuild() sets it directly and
    // never goes through refresh() itself, so there's no "unsubmitted local
    // draft" here to protect the way there is for a text input or an
    // as-yet-unsaved choice toggle -- the server's value (persisted-or-
    // cleared) is always authoritative wherever refresh() IS called. This
    // matters concretely for handleRegenerate()'s own refresh() call: the
    // backend now clears the persisted connection when the token is
    // regenerated (adapterSettings.js's clearHostedBotConnectedGuild()),
    // and without syncing the "now empty" case here too, this component
    // would keep showing "Connected to hosted bot for {name}" using a
    // stale local value forever, with the Connect button permanently
    // hidden behind it.
    setConnectedGuildName(nextState.hostedBotConnectedGuildName || null);
    // On a failed-attempt Retry, don't clobber role IDs the operator already
    // typed with the (still-disabled) server's stale values (finding #4,
    // Layer 3 review) -- only a genuine fresh mount-time load, or a refresh
    // after a confirmed success, should repopulate these fields.
    if (!options?.preserveInputs) {
      setPlayerRoleIds(nextState.roleIds.player.join(", "));
      setModeratorRoleIds(nextState.roleIds.moderator.join(", "));
      setAdminRoleIds(nextState.roleIds.admin.join(", "));
      // Real UAT finding (2026-09-09): same reasoning as role IDs above --
      // don't clobber an in-progress edit of the hosted-bot connection's
      // own OAuth config on an unrelated refresh(). The client secret
      // itself is never returned by the server, so there's nothing to
      // repopulate there regardless.
      setOAuthClientId(nextState.hostedBotOAuthClientId || "");
      // Real UAT finding (2026-09-10): "why are we asking for Redirect URI
      // -- we're hosting the bot, we know the redirect URL." The PATH is
      // fixed by this route's own code; only the domain varies per
      // self-hosted install, and the browser's current origin already is
      // that domain in the overwhelming common case. Pre-fill with the
      // computed value instead of leaving this blank with just a
      // placeholder hint -- still a real, editable field (not hardcoded
      // outright), since an operator behind a reverse proxy or reachable
      // at a different public hostname than their browser's current
      // origin genuinely does need to override it, same as the existing
      // Settings -> Discord OAuth sign-in redirect URI field already
      // requires for the identical reason. Only defaults when nothing is
      // saved yet (hostedBotOAuthRedirectUri falsy) -- never overwrites a
      // real, already-configured value, including one that was
      // deliberately overridden away from this same computed default.
      setOAuthRedirectUri(nextState.hostedBotOAuthRedirectUri || `${window.location.origin}/api/integrations/discord/hosted-bot/oauth/callback`);
    }
    setOAuthConfigured(Boolean(nextState.hostedBotOAuthConfigured));
    // Never assume "never configured" -- always reflect real state
    // (Layer 1 audit finding #7, converged on by 3 independent hats).
    setPhase(nextState.enabled ? "enabled" : "disabled");
    // Landing back in the Disabled wizard via this refresh() -- a genuine
    // fresh mount, or a Retry after a failed enable -- always resets to
    // wizard step 1. An earlier version of this tried to skip ahead to
    // step 2 when a choice was already known, on the theory that it saved
    // a click on Retry -- real UAT found that same skip-ahead logic (also
    // present in the wizardStep useState initializer, see its own comment)
    // was confusing on a genuine fresh mount, so it's removed everywhere,
    // not just there, for one consistent, predictable rule: the wizard
    // always starts at step 1. `choice`/role-ID VALUES are still preserved
    // (see loadPersistedChoice()/preserveInputs above) -- an operator who
    // already picked "hosted" sees it already highlighted the moment they
    // reach step 1 again, they just aren't skipped past seeing it.
    if (!nextState.enabled) setWizardStep(1);
  }

  useEffect(() => {
    // A persisted in-flight task is already reflected in phase/runId via the
    // useState initializers above -- don't call refresh() here too, or its
    // async continuation would overwrite "enabling" with a stale
    // disabled/enabled snapshot the moment the initial GET resolves (see the
    // comment on the runId/phase state above). The polling effect below owns
    // this task from here: only its own completion handler clears the
    // persisted entry and calls refresh().
    if (!runId) {
      refresh().catch(() => {
        setError("Could not load Discord Bot settings.");
        // Without this, phase stays stuck at "loading" forever -- there is
        // no render branch for it and no way forward short of a full page
        // reload (finding #2, Layer 3 review). Scoped to this specific
        // initial-mount-load failure only: the persisted-in-flight-task
        // recovery path above skips this call entirely (runId is already
        // set), so it can never be overridden to "failed" by this catch.
        setPhase("failed");
      });
    }
  }, []);

  useEffect(() => {
    if (phase !== "enabling" || !runId) return undefined;
    // A deadline may already be persisted (a task started before this
    // component last mounted, or before a page reload). If not -- a fresh
    // task, or one persisted by an older build that predates this fix --
    // start a fresh budget from now rather than treating it as already
    // expired.
    let deadline = loadPollDeadline();
    if (deadline === null) {
      deadline = Date.now() + POLL_TIMEOUT_BUDGET_MS;
      persistPollDeadline(deadline);
    }
    // Code-review finding on the timeout fix above (dune-awakening-selfhost-docker#872
    // fix PR): stackProgress() can occasionally take longer than
    // POLL_INTERVAL_MS to resolve (the console is "briefly unreachable"
    // during a real recreate, per the catch block below). Without a guard,
    // an overlapping tick could still be in flight when a later tick hits
    // the deadline and sets phase "failed" -- if the slow call then
    // resolves "succeeded" afterward, whichever setState lands last wins,
    // silently overwriting the other outcome. `stopped` is checked
    // immediately after every await so a call whose result is already moot
    // never applies it; `inFlight` skips starting an overlapping tick at all.
    let stopped = false;
    let inFlight = false;
    const interval = setInterval(async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const progress = await updatesApi.stackProgress(runId);
        if (stopped) return;
        if (progress.state === "succeeded") {
          stopped = true;
          clearInterval(interval);
          persistUpdateTask(TASK_KEY, null);
          persistPollDeadline(null);
          setRunId(null);
          if (progress.discordHealthOk === false) {
            setPhase("failed");
            setError("The console restarted, but the Discord adapter did not respond to a health check. Check the console's logs.");
          } else {
            await refresh();
          }
          return;
        } else if (progress.state === "failed") {
          stopped = true;
          clearInterval(interval);
          persistUpdateTask(TASK_KEY, null);
          persistPollDeadline(null);
          setRunId(null);
          setPhase("failed");
          setError(progress.message || "Applying Discord Bot settings failed.");
          return;
        }
      } catch {
        // The console is mid-recreate and briefly unreachable -- keep polling.
      } finally {
        inFlight = false;
      }
      if (stopped) return;
      // dune-awakening-selfhost-docker#872 (automated review finding on
      // already-merged #748): if runDiscordAdapterApplyTask throws before
      // its shell helper ever writes a status file (e.g.
      // cleanupStaleSelfUpdateHelpers's own "already running" contention
      // error, or a docker command rejection), stackProgress() keeps
      // returning state:"pending" forever, and a transient fetch error
      // above is deliberately swallowed as "keep polling" -- neither path
      // ever reached the succeeded/failed branches above to clear this
      // interval. Without a bound, this left phase stuck on "enabling"
      // permanently, with no error and no way forward except manually
      // clearing localStorage. Checked against the persisted `deadline`
      // (wall-clock, see POLL_DEADLINE_KEY's comment above) rather than an
      // in-memory tick count, so the budget survives this component
      // unmounting/remounting (e.g. the Discord Bot accordion being
      // collapsed and reopened) instead of re-arming every time.
      if (Date.now() >= deadline) {
        stopped = true;
        clearInterval(interval);
        persistUpdateTask(TASK_KEY, null);
        persistPollDeadline(null);
        setRunId(null);
        setPhase("failed");
        setError("Applying Discord Bot settings is taking much longer than expected. Check the console's logs, then Retry.");
      }
    }, POLL_INTERVAL_MS);
    return () => { stopped = true; clearInterval(interval); };
  }, [phase, runId]);

  async function handleEnable() {
    // In-flight guard (finding #5, Layer 3 review): a rapid double-click
    // could otherwise fire two overlapping /enable calls, each independently
    // minting a token / queuing a task. Guard the whole handler, including
    // the confirm-dialog wait, not just the API call, so the trigger button
    // is disabled from the very first click.
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const outcome = await new Promise<ConfirmDialogOutcome>((resolve) => {
        setConfirmRequest({
          title: "Enable Discord Bot Integration",
          message: "The console will restart to apply this change. It will be briefly unreachable.",
          confirmLabel: "Enable",
          cancelLabel: "Cancel",
          danger: false,
          resolve
        });
      });
      setConfirmRequest(null);
      if (outcome !== "confirm") return;

      // Real UAT finding (2026-09-09): persist config and reveal the
      // one-time token FIRST -- before the restart countdown, not after --
      // so the operator actually has a window to copy it while the console
      // is still fully reachable. enable() no longer triggers the restart
      // itself (see its own comment in discordAdapterSettings.ts); restart()
      // below is the explicit, separate call for that, made only once the
      // countdown resolves (by timeout or "Restart Now").
      const { token } = await discordAdapterSettingsApi.enable({
        playerRoleIds,
        moderatorRoleIds,
        adminRoleIds,
        deploymentChoice: choice
      });
      // token is absent (not just falsy) on the already-enabled/role-ids-
      // only path -- see the type's own comment in discordAdapterSettings.ts.
      // Don't overwrite a still-relevant earlier reveal with undefined here;
      // there is nothing new to show, so leave revealedToken as it was.
      if (token) {
        setRevealedToken(token);
        setTokenCopyResult("");
      }

      await waitForRestartCountdown(RESTART_COUNTDOWN_SECONDS);

      const { task } = await discordAdapterSettingsApi.restart();
      persistUpdateTask(TASK_KEY, task);
      persistPollDeadline(Date.now() + POLL_TIMEOUT_BUDGET_MS);
      setRunId(task.id);
      setPhase("enabling");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  // Save Role IDs, for an already-enabled adapter: a distinct handler and
  // route from handleEnable/enable() above -- see updateDiscordBotRoleIds()
  // in Task 8 for why sharing the enable path here would be a real bug
  // (silently rotating the live token on every role-ID edit). Now routed
  // through the same restart-warning ConfirmDialog Enable already uses
  // (finding #3, Layer 3 review) -- this also recreates/restarts the
  // console exactly like Enable does, and previously did so with zero
  // warning.
  async function handleUpdateRoleIds() {
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const outcome = await new Promise<ConfirmDialogOutcome>((resolve) => {
        setConfirmRequest({
          title: "Save Discord Bot Role IDs",
          message: "The console will restart to apply this change. It will be briefly unreachable.",
          confirmLabel: "Save",
          cancelLabel: "Cancel",
          danger: false,
          resolve
        });
      });
      setConfirmRequest(null);
      if (outcome !== "confirm") return;

      await waitForRestartCountdown(RESTART_COUNTDOWN_SECONDS);

      const { task } = await discordAdapterSettingsApi.updateRoleIds({
        playerRoleIds,
        moderatorRoleIds,
        adminRoleIds,
        deploymentChoice: choice
      });
      persistUpdateTask(TASK_KEY, task);
      persistPollDeadline(Date.now() + POLL_TIMEOUT_BUDGET_MS);
      setRunId(task.id);
      setPhase("enabling");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  // Real UAT finding (2026-09-09): "I see no path to remove the bot" --
  // this feature shipped Enable/Save Role IDs/Regenerate Token but no way
  // back to "never configured." Same countdown-before-restart pattern as
  // handleUpdateRoleIds() above (no token to reveal here, so no need for
  // Enable's reveal-before-restart split) -- disable() persists the reset,
  // then restart() (the same shared trigger Enable now uses) actually
  // recreates the console once the operator has acknowledged it.
  async function handleDisable() {
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const outcome = await new Promise<ConfirmDialogOutcome>((resolve) => {
        setConfirmRequest({
          title: "Disable Discord Bot Integration",
          message: "This invalidates the current adapter token and clears your saved role mappings and hosted/self-hosted choice -- you'll go through setup again to re-enable it. The console will restart to apply this change. This cannot be undone.",
          confirmLabel: "Disable",
          cancelLabel: "Cancel",
          danger: true,
          resolve
        });
      });
      setConfirmRequest(null);
      if (outcome !== "confirm") return;

      await discordAdapterSettingsApi.disable();
      // Real UAT finding (2026-09-10): disable() clears deploymentChoice
      // server-side, but refresh()'s own sync deliberately never clobbers
      // this client-side value with a null/empty server response (that
      // protection exists to avoid wiping an unsaved in-progress choice
      // elsewhere) -- without resetting it here too, the next visit to
      // wizard step 1 would skip straight to "Add bot to Discord" (still
      // choice === "hosted" locally) instead of genuinely starting over
      // at the picker, even though the adapter really is back to
      // never-configured.
      updateChoice(null);

      await waitForRestartCountdown(RESTART_COUNTDOWN_SECONDS);

      const { task } = await discordAdapterSettingsApi.restart();
      persistUpdateTask(TASK_KEY, task);
      persistPollDeadline(Date.now() + POLL_TIMEOUT_BUDGET_MS);
      setRunId(task.id);
      setPhase("enabling");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  // Real UAT finding (2026-09-09): "we have OAuth without bot and bot
  // without OAuth" -- the hosted-bot connection's own, independent Discord
  // Application config, deliberately not routed through the restart-
  // countdown machinery above: this only takes effect after a restart
  // regardless (same convention as Settings -> Discord OAuth's own save
  // flow), but there's no live secret to reveal and no immediate outage to
  // warn about from this call alone -- the operator triggers the actual
  // restart separately, whenever they next Enable/Save Role IDs/Disable.
  async function handleSaveOAuthConfig() {
    setOAuthSaving(true);
    setOAuthSaveResult("");
    setError("");
    try {
      await discordAdapterSettingsApi.saveOAuthConfig({ clientId: oauthClientId, redirectUri: oauthRedirectUri });
      if (oauthSecret) {
        await discordAdapterSettingsApi.saveOAuthSecret(oauthSecret);
        setOAuthSecret("");
      }
      setOAuthSaveResult("Saved. Restart the console (Enable, Save Role IDs, or Disable will trigger one) for this to take effect.");
      await refresh({ preserveInputs: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOAuthSaving(false);
    }
  }

  async function handleRegenerate() {
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const outcome = await new Promise<ConfirmDialogOutcome>((resolve) => {
        setConfirmRequest({
          title: "Regenerate Discord Bot Token",
          message: "This immediately invalidates the current token. Your bot will stop working until you paste the new token wherever it's configured. This cannot be undone.",
          confirmLabel: "Regenerate",
          cancelLabel: "Cancel",
          danger: true,
          resolve
        });
      });
      setConfirmRequest(null);
      if (outcome !== "confirm") return;

      const { token } = await discordAdapterSettingsApi.regenerateToken();
      setRevealedToken(token);
      setTokenCopyResult("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function copyRevealedToken() {
    if (!revealedToken) return;
    try {
      await copyText(revealedToken);
      setTokenCopyResult("Copied");
    } catch {
      setTokenCopyResult("Copy failed. Select the token manually.");
    }
  }

  // Same in-flight guard and ConfirmDialog promise pattern as
  // handleEnable/handleUpdateRoleIds/handleRegenerate above -- a real
  // confirm-before-navigate step, not an instant redirect, since this
  // hands the operator's Discord authorization off to an external OAuth
  // flow and there's no way back from that click short of the browser's
  // own back button.
  async function handleConnectToHostedBot() {
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const outcome = await new Promise<ConfirmDialogOutcome>((resolve) => {
        setConfirmRequest({
          title: "Connect to hosted bot",
          message: "Your Discord authorization will be used once to verify you own this server, then sent to and independently verified by the hosted bot service (mentat), and discarded -- it is never stored.",
          confirmLabel: "Connect",
          cancelLabel: "Cancel",
          danger: false,
          resolve
        });
      });
      setConfirmRequest(null);
      if (outcome !== "confirm") return;
      window.location.href = discordHostedBotApi.startOAuthUrl();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRegisterGuild() {
    if (!pickedGuild || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await discordHostedBotApi.register(pickedGuild.id, pickedGuild.name, window.location.origin);
      setConnectedGuildName(pickedGuild.name);
      // If a prior auto-invite attempt (possibly for a different guild)
      // had already confirmed, this manual OLD-flow registration now
      // supersedes it -- restore the invite-acknowledgement checkbox
      // instead of leaving it hidden for a connection this call never made.
      setConnectedViaAutoInvite(false);
      setOwnedGuilds(null);
      setPickedGuild(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Final integration review (Important #6): on failure (needsReauth,
      // a 502 from mentat, etc.), clear the picker too -- otherwise the
      // operator is stuck looking at a guild picker with an error message
      // telling them to "connect again," with no way to actually restart
      // the flow, since the "Connect to hosted bot" button only renders
      // when ownedGuilds is null.
      setOwnedGuilds(null);
      setPickedGuild(null);
    } finally {
      setSubmitting(false);
    }
  }

  // Phase 6 (dune-awakening-selfhost-docker#832/#865): the new, primary
  // hosted-bot connection UI -- one button, one Discord consent screen,
  // covering both bot-install and ownership verification (design doc G1).
  // Shared between wizard step 1 and the enabled-phase management view,
  // same convention as renderHostedBotConnection() below.
  function confirmationPollOutcomeMessage(outcome: "denied" | "owner_changed" | "timed_out" | "gave_up") {
    // Round 4 (issue #888): distinct copy per terminal status, matching
    // this design's own established discipline elsewhere (§6's failure-mode
    // table) of never collapsing meaningfully different outcomes into one
    // generic message.
    switch (outcome) {
      case "denied": return "The server owner denied the request on Discord. Click Start over to try again.";
      case "owner_changed": return "This server's ownership changed on Discord since the request was sent. Click Start over to try again.";
      case "timed_out": return "The server owner didn't respond in time. Click Start over to try again.";
      case "gave_up": return "Didn't hear back in time. Check Discord directly, or click Start over to try again.";
    }
  }

  function renderAutoInviteConnection() {
    if (autoInviteStatus === "waiting-for-owner") {
      if (confirmationPollOutcome) {
        return (
          <div className="settings-auto-invite-waiting" role="status">
            <p>{confirmationPollOutcomeMessage(confirmationPollOutcome)}</p>
            <button type="button" onClick={() => { persistConfirmationPoll(null); setAutoInviteStatus("idle"); setConfirmationPollOutcome(""); }}>Start over</button>
          </div>
        );
      }
      // Issue #888: elapsed-time-aware copy so a wait that can genuinely
      // run up to ~20 minutes doesn't look identical to "silently broken"
      // -- a static, unchanging message was the original finding here.
      const elapsedMinutes = Math.floor(confirmationPollElapsedMs / 60000);
      const waitingCopy = elapsedMinutes > 0
        ? `Request sent — check Discord to confirm the connection. Still waiting (${elapsedMinutes} minute${elapsedMinutes === 1 ? "" : "s"})…`
        : "Request sent — check Discord to confirm the connection. This can take a few minutes.";
      return (
        <div className="settings-auto-invite-waiting" role="status">
          <p>{waitingCopy}</p>
          {autoInviteReclaimed && (
            <p className="muted">This server was previously connected to a different console — that connection has been replaced, and role configuration was reset. Please reconfigure roles in the next step.</p>
          )}
          {/* Layer 2 audit finding (round 4, PR #891): "Start over" must
              also clear the persisted confirmation poll (issue found on
              this PR's own diff) -- otherwise a later reload/accordion
              collapse-reopen would silently resurrect "waiting-for-owner"
              for a request the operator explicitly asked to abandon on
              screen. autoInviteBlockUntil (the token-safety guard) is
              deliberately NOT cleared here -- that's a different concern,
              already covered by the note below. */}
          <button type="button" onClick={() => { persistConfirmationPoll(null); setAutoInviteStatus("idle"); }}>Start over</button>
          {/* Automated review finding, PR #868: "Start over" only resets
              this VISIBLE state -- there is no way to cancel the request
              already staged on mentat's side, which can still complete if
              the owner confirms later. Token/role actions elsewhere on
              this page stay guarded (autoInviteBlockUntil) regardless of
              this button, so this note explains why they may still look
              disabled after clicking it. */}
          <p className="muted">"Start over" only resets this screen -- the request already sent may still complete if the server owner confirms it later.</p>
        </div>
      );
    }
    return (
      <div className="settings-auto-invite">
        <button type="button" disabled={submitting || autoInviteStatus === "awaiting-popup"} onClick={() => { void handleStartAutoInvite(); }}>
          {autoInviteStatus === "awaiting-popup" ? "Waiting for Discord…" : "Add & Connect Bot"}
        </button>
        {autoInviteStatus === "awaiting-popup" && <p className="muted" role="status">Finish in the Discord popup, then come back here.</p>}
        {autoInviteStatus === "failed" && <p className="muted" role="status">{autoInviteFailureMessage(autoInviteFailureReason)}</p>}
        {autoInvitePopupBlockedUrl && (
          <p className="muted" role="status">
            Your browser blocked the popup.{" "}
            <a href={autoInvitePopupBlockedUrl} target="_blank" rel="noopener noreferrer">Click here to continue in a new tab</a>.
          </p>
        )}
      </div>
    );
  }

  // Real UAT finding (2026-09-10): shared between wizard step 1 ("Add bot
  // to Discord", first-time setup) and the post-setup management view
  // (phase === "enabled") -- operators need to redo this after initial
  // setup too (re-invite after being kicked, reconnect after
  // Regenerate Token clears the connection, change the Discord
  // Application's credentials). One rendering, two call sites, so they
  // can never drift out of sync with each other.
  //
  // Phase 6 (#832/#865): kept fully unchanged, own its own -- no longer the
  // default step-1 UI (renderAutoInviteConnection() above is), reachable
  // instead via an "Advanced: use my own Discord Application" disclosure
  // (design doc §9 Option B's rollout: not removed yet, no longer the
  // primary path either). This directly addresses the real UAT complaint
  // that drove this whole redesign ("showing additional not required
  // fields and info") -- this form no longer renders by default.
  function renderHostedBotConnection() {
    return (
      <>
        <div className="settings-hosted-bot-oauth-config">
          {/* Real UAT finding (2026-09-09): "we have OAuth without bot
              and bot without OAuth" -- this Discord Application is
              specific to the hosted-bot connection and deliberately
              independent of Settings -> Discord OAuth's console-sign-in
              app. Neither requires the other to be configured. */}
          <p className="muted">
            {oauthConfigured ? "Hosted bot connection: configured." : "Hosted bot connection: not yet configured."}{" "}
            This is its own Discord Application, separate from console sign-in (Settings → Discord OAuth) — you don't need one configured to use the other.
          </p>
          <label>Client ID<input disabled={oauthSaving} value={oauthClientId} onChange={(event) => setOAuthClientId(event.target.value)} placeholder="Discord application client ID" /></label>
          <label>Client Secret<SecretInput disabled={oauthSaving} value={oauthSecret} onChange={(event) => setOAuthSecret(event.target.value)} placeholder={oauthConfigured ? "Paste new to replace" : "Discord application client secret"} /></label>
          <label>
            Redirect URI
            <input disabled={oauthSaving} value={oauthRedirectUri} onChange={(event) => setOAuthRedirectUri(event.target.value)} />
          </label>
          <p className="muted">Pre-filled from this page's own address — register this exact value in your Discord Application's OAuth settings. Only change it if this console is reachable at a different public address than the one you're using right now (e.g. behind a reverse proxy).</p>
          <button type="button" disabled={oauthSaving} onClick={() => { void handleSaveOAuthConfig(); }}>{oauthSaving ? "Saving..." : "Save Hosted Bot Connection"}</button>
          {oauthSaveResult && <p className="muted" role="status">{oauthSaveResult}</p>}
        </div>
        {!ownedGuilds && !connectedGuildName && (
          <>
            <button type="button" onClick={() => openBotInviteWindow(state?.autoInviteDiscordClientId || DEFAULT_AUTO_INVITE_DISCORD_CLIENT_ID, () => setBotInviteWindowClosed(true))}>Add to Discord</button>
            <button disabled={submitting || autoInvitePending} onClick={() => { void handleConnectToHostedBot(); }}>Connect to hosted bot</button>
            {botInviteWindowClosed && <p className="muted" role="status">Welcome back — click Connect to hosted bot once you've invited the bot.</p>}
          </>
        )}
        {connectedGuildName && <p>Connected to hosted bot for {connectedGuildName}.</p>}
        {ownedGuilds && (
          <div className="settings-hosted-guild-picker">
            <p>Which server is this for?</p>
            <ul>
              {ownedGuilds.map((guild) => (
                <li key={guild.id}>
                  <button
                    className={pickedGuild?.id === guild.id ? "active" : ""}
                    aria-pressed={pickedGuild?.id === guild.id}
                    onClick={() => setPickedGuild(guild)}
                  >
                    {guild.name}
                  </button>
                </li>
              ))}
            </ul>
            {pickedGuild && <button disabled={submitting || autoInvitePending} onClick={() => { void handleRegisterGuild(); }}>Register</button>}
          </div>
        )}
      </>
    );
  }

  return (
    <div className="playerAdmin_toggleBody">
      <p className="muted">For bot commands and in-game data access — not console admin sign-in, see the Discord OAuth section above.</p>
      {error && <div className="confirm-modal-warning">{error}</div>}

      {/* Finding 4 (final review): hoisted above the phase-specific
          branches below so it renders whenever a token was just revealed,
          regardless of which phase the component is currently in --
          previously this only rendered inside phase === "enabled", so an
          Enable that succeeded but then failed its post-recreate health
          check (phase moves to "failed") left the one-time token
          permanently unreachable: Regenerate Token is owner-only, the
          token is never persisted (deliberate, Requirement 24), and a
          page reload discards it entirely. */}
      {revealedToken && (
        <div className="settings-token-reveal">
          <label>
            Your new token (copy it before leaving this page)
            <input readOnly type="text" value={revealedToken} />
            <button type="button" onClick={() => { void copyRevealedToken(); }}>Copy</button>
          </label>
          <p className="muted">Copy this now — it won't be shown again. Use Regenerate Token to get a new one if you lose it.</p>
          {tokenCopyResult && <span className="muted" role="status">{tokenCopyResult}</span>}
        </div>
      )}

      {/* Hoisted for the same reason as revealedToken above -- this must
          render regardless of which phase-specific branch is active,
          since handleUpdateRoleIds() fires from phase === "enabled" while
          handleEnable() fires from phase === "disabled". */}
      {restartCountdownSeconds !== null && (
        <div className="settings-restart-countdown" role="status">
          <p>
            Restarting the console in <strong>{restartCountdownSeconds}s</strong> to apply this change. It will be briefly unreachable.
          </p>
          <button type="button" onClick={finishRestartCountdown}>Restart Now</button>
        </div>
      )}

      {phase === "disabled" && (
        <div className="settings-wizard">
          <p className="settings-wizard-step-indicator">Step {wizardStep} of 3</p>
          {/* Real UAT finding: landing directly on step 2 (a choice
              persisted from an earlier visit skips step 1 entirely, see
              the wizardStep useState initializer) gave no indication
              anywhere on this page of which choice was actually active --
              only the Back button on step 3's own "generates a token for
              your own bot" sentence hinted at it. Shown whenever a choice
              is active so it's never ambiguous which path is selected --
              including on step 1 itself once "Hosted bot" is picked
              (independent UI/UX review, CRITICAL C1): step 1's own content
              switches away from the picker the instant "Hosted bot" is
              picked (see below), with no other way back to it otherwise --
              an operator who picked it by mistake, or just wants to look
              at the other option, was stuck unless they completed a real
              Discord OAuth authorization just to escape. "Change" resets
              `choice` (not just wizardStep, which is already 1 here) so
              the picker genuinely re-renders regardless of which step
              this indicator appears on. */}
          {/* Suppressed specifically when the raw picker itself is what's
              on screen (self-hosted's step 1, which already shows both
              buttons with this one highlighted) -- redundant there, not
              wrong, but hosted's step 1 has no picker to fall back on
              (see above), which is exactly why this can't stay gated on
              wizardStep > 1 alone. */}
          {choice && !(wizardStep === 1 && choice === "self-hosted") && (
            <p className="settings-wizard-current-choice">
              Setting up: <strong>{choice === "hosted" ? "Hosted bot" : "Self-hosting"}</strong>{" "}
              <button type="button" onClick={() => { updateChoice(null); setWizardStep(1); }}>Change</button>
            </p>
          )}

          {/* Real UAT finding (2026-09-10): "wizard steps: 1) add bot to
              discord, 2) configure roles, 3) restart" -- step 1's own
              content now depends on `choice`, not just `wizardStep`:
              nothing picked yet shows the original picker; "Hosted bot"
              stays on step 1 and switches to the Discord-connection flow
              (chooseAndAdvance() above silently mints the adapter token in
              the background so every button here works immediately);
              "Self-hosting" has no bot to invite, so it still advances
              straight to step 2 as before. */}
          {wizardStep === 1 && choice !== "hosted" && (
            <div className="settings-wizard-step">
              <p>Which are you using?</p>
              <div className="settings-choice">
                {/* Never active/pressed in this branch -- reaching it at
                    all means choice !== "hosted" (see the outer condition
                    above); once "Hosted bot" is picked, the wizard step 1
                    && choice === "hosted" branch below takes over instead
                    of this picker re-rendering with it highlighted. */}
                <button aria-pressed={false} onClick={() => { void chooseAndAdvance("hosted"); }}>Hosted bot</button>
                <p className="muted">We run the bot for you. Invite it to your Discord server, connect it, then configure roles — no separate bot process to run.</p>
                <button className={choice === "self-hosted" ? "active" : ""} aria-pressed={choice === "self-hosted"} onClick={() => { void chooseAndAdvance("self-hosted"); }}>Self-hosting</button>
                <p className="muted">Run your own bot instance under your own Discord Application. We generate a secure adapter token for it; you deploy the bot itself.</p>
              </div>
            </div>
          )}

          {wizardStep === 1 && choice === "hosted" && (
            <div className="settings-wizard-step">
              <p>Add bot to Discord</p>
              {silentEnabling ? (
                <p className="muted">Setting up your console's connection…</p>
              ) : (
                <>
                  {/* Phase 6 (#832/#865): the new auto-invite flow covers
                      bot-install + ownership verification in a single
                      Discord consent screen -- neither button names the
                      bot up front (Independent UI/UX review, MEDIUM M4),
                      an operator learns what they're authorizing once
                      already inside Discord's own consent screen. */}
                  <p className="muted">Invite Sahir Venn, the hosted bot, to your Discord server and connect it to this console — one click, one Discord screen.</p>
                  {/* Layer 2 audit finding (HIGH, PR #868): don't show the
                      new flow's primary CTA as if nothing is connected when
                      a guild is already connected (e.g. via the advanced
                      flow, then "Change" back to step 1) -- same reasoning
                      as the enabled-phase management view below. */}
                  {connectedGuildName ? <p className="settings-auto-invite-already-connected">This server is already connected: <strong>{connectedGuildName}</strong>.</p> : renderAutoInviteConnection()}
                  {/* Design doc §9 Option B: the old, independent-Discord-
                      Application flow is not removed yet -- kept reachable
                      here as an opt-in fallback, no longer the default
                      (real UAT finding: it was previously shown
                      unconditionally, with fields most operators never
                      needed). */}
                  <details className="settings-hosted-bot-advanced" ref={advancedDetailsRef}>
                    <summary>Advanced: connect manually instead</summary>
                    <p className="muted">Still uses the same hosted bot (Sahir Venn) above -- this is only a different way to prove you own the Discord server, using your own Discord Application's OAuth credentials instead of the one-click screen. It does not run a separate bot. Only use this if "Add &amp; Connect Bot" above doesn't work for you.</p>
                    {renderHostedBotConnection()}
                  </details>
                </>
              )}
              {/* Independent UI/UX review (HIGH H1): "Add to Discord" and
                  "Connect to hosted bot"/Register are fully independent --
                  an operator could register a guild without ever inviting
                  the bot to it, finish this wizard, and end up with a
                  registered-but-non-functional integration with no error
                  anywhere. There's no reliable way to verify the invite
                  actually completed from here (see openBotInviteWindow's
                  own comment) -- this is a lightweight, honest mitigation:
                  it doesn't guarantee correctness, but it stops Continue
                  from being reachable without a conscious confirmation.
                  Only relevant to the OLD, advanced flow above (renders
                  when connectedGuildName is set, which only that flow's
                  own handleRegisterGuild() ever sets) -- the new
                  auto-invite flow's single consent screen already covers
                  both actions at once, so it has no separate checkbox. */}
              {connectedGuildName && !connectedViaAutoInvite && (
                <label className="settings-wizard-invite-ack">
                  <input type="checkbox" checked={botInviteAcknowledged} onChange={(event) => setBotInviteAcknowledged(event.target.checked)} />
                  {" "}I've invited the bot to this Discord server
                </label>
              )}
              <button disabled={!(autoInviteStatus === "waiting-for-owner" || connectedViaAutoInvite || (connectedGuildName && botInviteAcknowledged))} onClick={() => setWizardStep(2)}>Continue</button>
              {autoInviteStatus !== "waiting-for-owner" && !connectedGuildName && !silentEnabling && <p className="muted" role="status">Continue unlocks once the bot is connected above.</p>}
              {connectedGuildName && !connectedViaAutoInvite && !botInviteAcknowledged && <p className="muted" role="status">Continue unlocks once you confirm you've invited the bot.</p>}
            </div>
          )}

          {wizardStep === 2 && (
            <div className="settings-wizard-step">
              <p>Configure roles</p>
              <p className="muted">Map Discord roles to console permission tiers (optional). You can skip this now and set it up later from this same page.</p>
              <label>Player role IDs (optional)<input value={playerRoleIds} onChange={(event) => setPlayerRoleIds(event.target.value)} placeholder="Comma-separated Discord role IDs" /></label>
              <label>Moderator role IDs (optional)<input value={moderatorRoleIds} onChange={(event) => setModeratorRoleIds(event.target.value)} placeholder="Comma-separated Discord role IDs" /></label>
              <label>Admin role IDs (optional)<input value={adminRoleIds} onChange={(event) => setAdminRoleIds(event.target.value)} placeholder="Comma-separated Discord role IDs" /></label>
              <button onClick={() => setWizardStep(1)}>Back</button>
              <button onClick={() => setWizardStep(3)}>Continue</button>
            </div>
          )}

          {wizardStep === 3 && choice === "hosted" && (
            <div className="settings-wizard-step">
              <p>Restart</p>
              {/* Independent UI/UX review (LOW L2): nothing on screen told
                  the operator why this step is worded differently from
                  the self-hosted path's "Enable Discord Bot Integration"
                  below -- the asymmetry could read as inconsistency
                  rather than the deliberate difference it is (the adapter
                  was already silently enabled back in step 1). */}
              <p className="muted">Your adapter and Discord connection were already set up in step 1 -- this just saves your role mappings and briefly restarts the console to apply them.</p>
              <button onClick={() => setWizardStep(2)}>Back</button>
              <button disabled={submitting} onClick={() => { void handleUpdateRoleIds(); }}>Save &amp; Restart</button>
            </div>
          )}

          {wizardStep === 3 && choice !== "hosted" && (
            <div className="settings-wizard-step">
              <p>Restart</p>
              <p className="muted">This generates a secure adapter token for your own bot to use and briefly restarts the console to apply it.</p>
              <button onClick={() => setWizardStep(2)}>Back</button>
              <button disabled={!choice || submitting} onClick={() => { void handleEnable(); }}>Enable Discord Bot Integration</button>
            </div>
          )}
        </div>
      )}

      {phase === "enabling" && <p>Applying settings and restarting the console…</p>}

      {/* On a failed-attempt Retry (task/enable failure), state is already
          non-null from an earlier successful load -- preserve whatever the
          operator typed rather than re-fetching stale server values over it
          (finding #4). On a genuine initial-mount-load failure, state is
          still null and there's nothing typed yet to preserve, so this
          Retry does a real fresh load (finding #2). */}
      {phase === "failed" && <button onClick={() => { void refresh({ preserveInputs: state !== null }); }}>Retry</button>}

      {phase === "enabled" && state && (
        <>
          <p>Enabled.</p>
          {/* Final integration review (Important #2): this toggle used to
              render only in phase === "disabled", so a console that was
              already enabled before this branch shipped had no UI to ever
              set deploymentChoice server-side -- the client's `choice`
              state fell back to localStorage (which may be empty), and the
              server-side /oauth/start, /oauth/callback, and /register gates
              stayed closed forever unless the operator happened to also
              touch "Save Role IDs" with a `choice` already set some other
              way. Rendering it here too, wired to the same Save Role IDs
              submit (handleUpdateRoleIds already sends `deploymentChoice:
              choice`), lets an already-enabled operator set it
              retroactively and immediately see "Connect to hosted bot"
              appear once it's persisted as "hosted". */}
          <div className="settings-choice">
            <p>Which are you using?</p>
            <button className={choice === "hosted" ? "active" : ""} aria-pressed={choice === "hosted"} onClick={() => { void updateChoiceAndPersist("hosted"); }}>Hosted bot</button>
            <button className={choice === "self-hosted" ? "active" : ""} aria-pressed={choice === "self-hosted"} onClick={() => { void updateChoiceAndPersist("self-hosted"); }}>Self-hosting</button>
          </div>
          {/* The real, one-time reveal (plaintext value + Copy button) now
              lives in the hoisted block above, so it also survives a
              transition into phase === "failed" (Finding 4). This masked
              placeholder only covers the ordinary case: a normal page
              view/reload where nothing was revealed in this browser
              session, but the adapter does have a token configured. */}
          {!revealedToken && (
            <label>
              Token
              <input readOnly type="password" value="••••••••••••••••••••••••••••••••" />
            </label>
          )}
          <label>Player role IDs<input value={playerRoleIds} onChange={(event) => setPlayerRoleIds(event.target.value)} /></label>
          <label>Moderator role IDs<input value={moderatorRoleIds} onChange={(event) => setModeratorRoleIds(event.target.value)} /></label>
          <label>Admin role IDs<input value={adminRoleIds} onChange={(event) => setAdminRoleIds(event.target.value)} /></label>
          <button disabled={submitting || autoInvitePending} onClick={() => { void handleUpdateRoleIds(); }}>Save Role IDs</button>
          <button disabled={submitting || autoInvitePending} onClick={() => { void handleRegenerate(); }}>Regenerate Token</button>
          <button disabled={submitting || autoInvitePending} onClick={() => { void handleDisable(); }}>Disable Discord Bot Integration</button>
          {autoInvitePending && <p className="muted" role="status">Role/token actions are paused while a Discord connection request is in progress.</p>}
          {choice === "hosted" && (
            <>
              {/* Layer 2 audit finding (HIGH, PR #868): must not show the
                  new flow's "Add & Connect Bot" as the primary action when
                  a guild is already connected (via the old, advanced
                  flow's own handleRegisterGuild()) -- that previously
                  rendered an unconditional, misleading CTA suggesting
                  nothing was connected, with the real "Connected to X"
                  status hidden behind the collapsed Advanced disclosure. */}
              {connectedGuildName ? <p className="settings-auto-invite-already-connected">This server is already connected: <strong>{connectedGuildName}</strong>.</p> : renderAutoInviteConnection()}
              <details className="settings-hosted-bot-advanced">
                <summary>Advanced: connect manually instead</summary>
                <p className="muted">Still uses the same hosted bot (Sahir Venn) -- this is only a different way to prove you own the Discord server, using your own Discord Application's OAuth credentials instead of the one-click screen. It does not run a separate bot.</p>
                {renderHostedBotConnection()}
              </details>
            </>
          )}
          {choice === "self-hosted" && (
            <div className="settings-self-hosted-handoff">
              <p>Your console side is ready. To finish, deploy your own bot instance under your own Discord Application:</p>
              <ol>
                <li>Create a Discord Application and bot at the <a href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer">Discord Developer Portal</a> (if you haven't already)</li>
                <li>Deploy the bot software — see the <a href="https://github.com/Project-Arrakis/mentat/blob/main/docs/installation-guide.md" target="_blank" rel="noopener noreferrer">Installation Guide</a></li>
                <li>Configure it with:
                  <ul>
                    <li>Console URL: <code>{window.location.origin}</code></li>
                    <li>Adapter Token: the value shown above (use Regenerate Token if you need a fresh one)</li>
                  </ul>
                </li>
              </ol>
            </div>
          )}
        </>
      )}

      <ConfirmDialog request={confirmRequest} onClose={(outcome) => confirmRequest?.resolve(outcome)} />
    </div>
  );
}
