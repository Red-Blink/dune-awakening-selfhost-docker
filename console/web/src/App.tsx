import { Fragment, lazy, useCallback, useEffect, useRef, useState } from "react";
import { Archive, Bug, Building2, Car, CircleHelp, Database, Download, ExternalLink, FileText, Gift, Heart, Home, Landmark, LogOut, Map as MapIcon, Menu, MessageCircle, PackagePlus, RefreshCw, Server, Settings, Shield, ShieldCheck, Sparkles, Store, UserRound, Users, X } from "lucide-react";
import { api, AUTH_SESSION_EXPIRED_EVENT, AUTH_SESSION_EXPIRED_MESSAGE, loginRequest, post, setCsrfToken } from "./api/client";
import { TotpSetupScreen } from "./features/auth/TotpSetupScreen";
import { DiscordMigrationOffer } from "./features/auth/DiscordMigrationOffer";
import { DiscordSetupWizard } from "./features/auth/DiscordSetupWizard";
import { setServerPorts, setAdminPort, type ServerPorts } from "./api/serverPorts";
import { serverApi, type RestartQueueTarget } from "./api/server";
import { updatesApi } from "./api/updates";
import { addonsApi } from "./api/addons";
import { playersApi } from "./api/players";
import { setupApi, type Task } from "./api/setup";
import { SetupWizard } from "./components/SetupWizard";
import { TaskProgress } from "./components/TaskProgress";
import { ConfirmDialog, type ConfirmDialogDetail, type ConfirmDialogOutcome, type ConfirmDialogRequest } from "./components/common/ConfirmDialog";
import { LazyTabBoundary } from "./components/common/LazyTabBoundary";
import type { RestartGateChoice } from "./features/server/restartQueueGuard";
import { loadPinnedAddons, savePinnedAddons, type PinnedAddon } from "./features/addons/pinnedAddons";
import { hasAddonUpdates } from "./features/addons/addonVersions";
import { preloadPlayerAdminIconRailAssets } from "./features/players/PlayerCategoryIconRail";
import {
  HomePanel,
  ServerPanel,
  loadPersistedFuncomTokenResult,
  persistFuncomTokenResult,
  taskTechnicalDetails,
  isSettingsRestartHandoffTask,
  isHomeActionComplete,
  isHomeStopComplete,
  advanceRestartLifecycle,
  createRestartLifecycleState,
  isRestartLifecycleReady,
  stackActionPendingResult,
  type HomeLoadResult,
  type HomeTaskResult,
  type RestartLifecycleState
} from "./features/server/ServerPanels";
import { parseUpdateTask, stackVersionButtonLabel, stackVersionButtonTitle } from "./features/updates/updateUtils";
import { formatUiSentence, stripAnsi, summarizeCommandText, titleCase } from "./lib/display";
import { useStaleBuildWatcher } from "./lib/staleBuildWatcher";

// The array is the source of truth (not just a type-level union) so restoring
// a persisted tab (see loadPersistedTab below) can validate against the real,
// current list at runtime instead of a hand-duplicated copy that could drift.
export const ALL_TABS = ["Home", "Server Control", "Services", "Players", "Guilds", "Bases", "Vehicles", "Exchange", "Landsraad", "Admin Tools", "Live Map", "Maps", "Care Package", "Addons", "Database", "Storage", "Backups", "Logs", "Updates", "Settings", "Access Control"] as const;
type Tab = typeof ALL_TABS[number];
const ACTIVE_TAB_STORAGE_KEY = "dune-console:active-tab";

// Persisted in sessionStorage, not localStorage: it should survive the
// automatic reload LazyTabBoundary triggers after a stale chunk load (so the
// user lands back on the tab they were opening, not Home), but should not
// stick around and surprise someone who opens the console again days later
// in a fresh tab.
function isTab(value: string): value is Tab {
  return (ALL_TABS as readonly string[]).includes(value);
}

export function loadPersistedTab(): Tab {
  if (typeof window === "undefined") return "Home";
  try {
    const raw = window.sessionStorage.getItem(ACTIVE_TAB_STORAGE_KEY) || "";
    return isTab(raw) ? raw : "Home";
  } catch {
    return "Home";
  }
}

export function persistActiveTab(tab: Tab) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(ACTIVE_TAB_STORAGE_KEY, tab);
  } catch {
    // The tab still switches in-memory if sessionStorage is unavailable.
  }
}

// Persist before scheduling the render. LazyTabBoundary reloads from
// componentDidCatch, which runs before passive effects, so writing from a
// useEffect would still lose the destination tab during the exact recovery
// path this state exists to support.
export function useActiveTab() {
  const [tab, setTabState] = useState<Tab>(() => loadPersistedTab());
  const setTab = useCallback((nextTab: Tab) => {
    persistActiveTab(nextTab);
    setTabState(nextTab);
  }, []);
  return [tab, setTab] as const;
}
type SetupState = { files: Record<string, boolean>; config: Record<string, unknown> };
type PublicDirectoryStatus = {
  mode?: string;
  serverId?: string | null;
  remoteListed?: boolean;
  listingClaimed?: boolean;
};
let openConfirmDialog: ((request: ConfirmDialogRequest) => void) | null = null;

const AddonsPanel = lazy(() => import("./features/addons/AddonsPanel").then((module) => ({ default: module.AddonsPanel })));
const AdminToolsPanel = lazy(() => import("./features/adminTools/AdminToolsPanel").then((module) => ({ default: module.AdminToolsPanel })));
const IamPolicyEditor = lazy(() => import("./features/settings/IamPolicyEditor").then((module) => ({ default: module.IamPolicyEditor })));
const BasesPanel = lazy(() => import("./features/bases/BasesPanel").then((module) => ({ default: module.BasesPanel })));
const BackupsPanel = lazy(() => import("./features/backups/BackupsPanel").then((module) => ({ default: module.BackupsPanel })));
const CarePackagePanel = lazy(() => import("./features/carePackage/CarePackagePanel").then((module) => ({ default: module.CarePackagePanel })));
const DatabasePanel = lazy(() => import("./features/database/DatabasePanel").then((module) => ({ default: module.DatabasePanel })));
const GuildsPanel = lazy(() => import("./features/guilds/GuildsPanel").then((module) => ({ default: module.GuildsPanel })));
const LogsPanel = lazy(() => import("./features/logs/LogsPanel").then((module) => ({ default: module.LogsPanel })));
const LiveMapPanel = lazy(() => import("./features/liveMap/LiveMapPanel").then((module) => ({ default: module.LiveMapPanel })));
const LandsraadPanel = lazy(() => import("./features/landsraad/LandsraadPanel").then((module) => ({ default: module.LandsraadPanel })));
const MapsPanel = lazy(() => import("./features/maps/MapsPanel").then((module) => ({ default: module.MapsPanel })));
const CharacterAdminUI = lazy(() => import("./features/players/CharacterAdminUI").then((module) => ({ default: module.CharacterAdminUI })));
const PlayersPanel = lazy(() => import("./features/players/PlayersPanel").then((module) => ({ default: module.PlayersPanel })));
const ServicesPanel = lazy(() => import("./features/services/ServicesPanel").then((module) => ({ default: module.ServicesPanel })));
const SettingsPanel = lazy(() => import("./features/settings/SettingsPanel").then((module) => ({ default: module.SettingsPanel })));
const StoragePanel = lazy(() => import("./features/storage/StoragePanel").then((module) => ({ default: module.StoragePanel })));
const UpdatesPanel = lazy(() => import("./features/updates/UpdatesPanel").then((module) => ({ default: module.UpdatesPanel })));
const VehiclesPanel = lazy(() => import("./features/vehicles/VehiclesPanel").then((module) => ({ default: module.VehiclesPanel })));
const ExchangePanel = lazy(() => import("./features/exchange/ExchangePanel").then((module) => ({ default: module.ExchangePanel })));

function confirmDialog(message: string, options: Partial<Omit<ConfirmDialogRequest, "message" | "resolve">> = {}) {
  return new Promise<boolean>((resolve) => {
    const danger = options.danger ?? /delete|remove|reset|restore|wipe|kick|stop|disable|despawn|destructive|cannot be undone/i.test(message);
    if (!openConfirmDialog) {
      resolve(false);
      return;
    }
    openConfirmDialog({
      title: options.title || (danger ? "Confirm Action" : "Continue?"),
      message,
      confirmLabel: options.confirmLabel || "Yes",
      cancelLabel: options.cancelLabel || "No",
      danger,
      details: options.details,
      warning: options.warning,
      resolve: (outcome) => resolve(outcome === "confirm")
    });
  });
}

type BackupIdentityChoice = "adopt-backup" | "keep-current" | "cancel";

function chooseBackupIdentity(meta: { backup: string; currentBattlegroupId: string; backupBattlegroupId: string }): Promise<BackupIdentityChoice> {
  return new Promise((resolve) => {
    if (!openConfirmDialog) {
      resolve("cancel");
      return;
    }
    openConfirmDialog({
      title: "Choose Battlegroup Identity",
      message: "This backup belongs to a different Battlegroup. Adopt the backup identity when moving the same server to new hardware. Keep the current identity only when intentionally importing data into this different server.",
      confirmLabel: "Adopt Backup ID",
      tertiaryLabel: "Keep Current ID",
      cancelLabel: "Cancel Restore",
      danger: true,
      warning: "Choosing the wrong identity can make restored characters unavailable in game. Adoption will be blocked unless the current Funcom token matches the backup Battlegroup.",
      details: [
        { label: "Backup", value: meta.backup, tone: "accent" },
        { label: "Current ID", value: meta.currentBattlegroupId, tone: "danger" },
        { label: "Backup ID", value: meta.backupBattlegroupId, tone: "success" }
      ],
      resolve: (outcome) => resolve(outcome === "confirm" ? "adopt-backup" : outcome === "tertiary" ? "keep-current" : "cancel")
    });
  });
}

// The single confirmation dialog for a gated restart. Always shown (it is the
// sole confirm for the action): when the queue is off, or on with nobody
// online, it is a plain confirm that the restart runs now; when the queue is on
// and players are online it offers Queue / Restart Immediately / Cancel.
// Returns "immediate" only when the dialog cannot open, so the restart still
// works headless.
function restartGateChoice(meta: { label: string; enabled: boolean; playersOnline: number | null; battlegroupPlayersOnline: number | null; mapScoped: boolean; countdownMinutes: number; note?: string; details?: ConfirmDialogDetail[]; manualLabel?: string }): Promise<RestartGateChoice> {
  return new Promise((resolve) => {
    if (!openConfirmDialog) {
      resolve("immediate");
      return;
    }
    const online = meta.playersOnline ?? 0;
    const minutes = Math.max(1, Math.round(meta.countdownMinutes));
    const queued = meta.enabled && online > 0;
    // Only worth mentioning when this restart is scoped to a map/partition
    // and that count actually differs from the battlegroup-wide figure --
    // for a battlegroup-wide restart the two are always the same query.
    const battlegroupOnline = meta.battlegroupPlayersOnline;
    const showBattlegroupContext = meta.mapScoped && battlegroupOnline !== null && battlegroupOnline !== online;
    const battlegroupClause = showBattlegroupContext
      ? ` (${battlegroupOnline} online battlegroup-wide)`
      : "";
    const scopeClause = meta.mapScoped ? `on ${meta.label}` : "in the battlegroup";
    // With a 4th ("Restart later") choice on offer, no single sentence can
    // presume the outcome -- 3 of the 4 choices don't restart on the spot --
    // so the message stays neutral and the buttons carry the decision.
    const resolveQuaternary = (outcome: ConfirmDialogOutcome) => outcome === "quaternary" ? "manual" as const : outcome;
    if (!queued) {
      openConfirmDialog({
        title: "Confirm restart",
        message: meta.enabled
          ? meta.manualLabel
            ? `No players are online ${scopeClause}${battlegroupClause}. The changes save now — choose when the restart that applies them should happen.`
            : `No players are online ${scopeClause}${battlegroupClause}, so this restart will run immediately.`
          : `Restart ${meta.label}? Anyone connected will be disconnected.`,
        confirmLabel: "Restart Now",
        cancelLabel: "Cancel",
        quaternaryLabel: meta.manualLabel,
        danger: true,
        warning: meta.note,
        details: meta.details,
        resolve: (outcome) => resolve(resolveQuaternary(outcome) === "confirm" ? "immediate" : resolveQuaternary(outcome) === "manual" ? "manual" : "cancel")
      });
      return;
    }
    openConfirmDialog({
      title: "Players are online",
      message: meta.manualLabel
        ? `${online} ${online === 1 ? "player is" : "players are"} online ${scopeClause}${battlegroupClause}. The changes save now — choose when the restart that applies them should happen.`
        : `${online} ${online === 1 ? "player is" : "players are"} online ${scopeClause}${battlegroupClause}. This restart will start a ${minutes}-minute countdown with in-game warnings at each checkpoint.`,
      confirmLabel: `Queue Restart (${minutes} min)`,
      cancelLabel: "Cancel",
      tertiaryLabel: "Restart Immediately",
      quaternaryLabel: meta.manualLabel,
      danger: false,
      warning: meta.note,
      details: meta.details ?? [{ label: "Players online", value: String(online), tone: "accent" }],
      resolve: (outcome) => {
        const resolved = resolveQuaternary(outcome);
        resolve(resolved === "confirm" ? "queue" : resolved === "tertiary" ? "immediate" : resolved === "manual" ? "manual" : "cancel");
      }
    });
  });
}

// Settings saves in Maps -> Interactive Modifiers and -> Advanced always
// restart the affected server(s) to apply. This routes that restart through
// the same queue interception as every other restart control: a plain
// confirm when the queue is off (or nobody relevant is online), or the
// Queue/Restart Immediately/Cancel choice -- with players-online context --
// when it's on. `target` scopes the online check to the map/partition this
// save actually restarts; omit it for a stack-wide (all game services) save.
async function confirmSettingsRestart(kind: "UserEngine" | "UserGame", target?: RestartQueueTarget): Promise<RestartGateChoice> {
  let status: Awaited<ReturnType<typeof serverApi.restartQueue>> | null = null;
  try {
    status = await serverApi.restartQueue(target);
  } catch {
    status = null;
  }
  // Name the actual map/partition being restarted when this save is scoped
  // to one, rather than the generic "UserEngine/UserGame settings" label --
  // that generic label is only accurate for a stack-wide (no target) save.
  const label = target?.map
    ? target.map
    : target?.partitionId
      ? `partition ${target.partitionId}`
      : kind === "UserEngine" ? "UserEngine settings" : "UserGame settings";
  return restartGateChoice({
    label,
    enabled: status?.settings.enabled ?? false,
    playersOnline: status?.playersOnline ?? null,
    battlegroupPlayersOnline: status?.battlegroupPlayersOnline ?? status?.playersOnline ?? null,
    mapScoped: Boolean(target),
    countdownMinutes: status?.settings.defaultCountdownMinutes ?? 15,
    manualLabel: "Restart later",
    note: "Restart later leaves the servers running as-is; the change applies at the next battlegroup restart, manual or automatic."
  });
}

function formatResultTitle(value: unknown, pending = false) {
  return formatUiSentence(value, pending);
}

function formatResultMessage(value: unknown) {
  return formatUiSentence(value, false);
}

const navGroups: { title: string; items: { tab: Tab; icon: React.ReactNode }[] }[] = [
  {
    title: "Server Operations",
    items: [
      { tab: "Home", icon: <Home size={18} /> },
      { tab: "Server Control", icon: <Server size={18} /> },
      { tab: "Backups", icon: <Archive size={18} /> },
      { tab: "Database", icon: <Database size={18} /> },
      { tab: "Updates", icon: <RefreshCw size={18} /> },
      { tab: "Logs", icon: <FileText size={18} /> },
      { tab: "Settings", icon: <Settings size={18} /> },
      { tab: "Access Control", icon: <Shield size={18} /> }
    ]
  },
  {
    title: "Arrakis Management",
    items: [
      { tab: "Maps", icon: <MapIcon size={18} /> },
      { tab: "Players", icon: <Users size={18} /> },
      { tab: "Guilds", icon: <Shield size={18} /> },
      { tab: "Bases", icon: <Building2 size={18} /> },
      { tab: "Vehicles", icon: <Car size={18} /> },
      { tab: "Exchange", icon: <Store size={18} /> },
      { tab: "Live Map", icon: <MapIcon size={18} /> },
      { tab: "Landsraad", icon: <Landmark size={18} /> },
      { tab: "Admin Tools", icon: <PackagePlus size={18} /> },
      { tab: "Care Package", icon: <Gift size={18} /> }
    ]
  },
  {
    title: "Community",
    items: [
      { tab: "Addons", icon: <Sparkles size={18} /> }
    ]
  }
];

const COMMUNITY_CONTRIBUTORS_URL = "https://github.com/Red-Blink/dune-awakening-selfhost-docker/graphs/contributors";
const DUNE_DOCKER_WEBSITE_URL = "https://dunedocker.app/";
const DUNE_DOCKER_DOCS_URL = "https://docs.dunedocker.app/";

function publicServerListingUrl(serverId: string) {
  return `${DUNE_DOCKER_WEBSITE_URL}server.html?id=${encodeURIComponent(serverId)}`;
}
const REDBLINK_DISCORD_URL = "https://discord.gg/duneawakeningdocker";
const REDBLINK_KOFI_URL = "https://ko-fi.com/redblink";

export function SidebarNavIndicators({ item, onlinePlayerCount, addonUpdatesAvailable }: { item: Tab; onlinePlayerCount: number; addonUpdatesAvailable: boolean }) {
  const visibleOnlinePlayerCount = Math.max(0, Math.floor(Number(onlinePlayerCount) || 0));
  if (item === "Players" && visibleOnlinePlayerCount > 0) {
    const label = `${visibleOnlinePlayerCount} player${visibleOnlinePlayerCount === 1 ? "" : "s"} online`;
    return <span className="sidebar-nav-indicators"><span className="sidebar-nav-count sidebar-nav-count-online" title={label} aria-label={label}>{visibleOnlinePlayerCount}</span></span>;
  }
  if (item === "Addons" && addonUpdatesAvailable) {
    return <span className="sidebar-nav-indicators"><span className="sidebar-nav-update-icon" title="Addon Update Available" aria-label="Addon Update Available"><Download size={14} strokeWidth={2.4} aria-hidden="true" /></span></span>;
  }
  return null;
}

function DiscordLogo({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path fill="currentColor" d="M20.3 4.4A18.4 18.4 0 0 0 15.8 3l-.2.4a13.1 13.1 0 0 1 4 2 14.2 14.2 0 0 0-5-1.5 14.8 14.8 0 0 0-5.2 0 14.2 14.2 0 0 0-5 1.5 13.1 13.1 0 0 1 4-2L8.2 3a18.4 18.4 0 0 0-4.5 1.4C.9 8.5.1 12.5.5 16.5A18.7 18.7 0 0 0 6 19.2l.7-.9a11.6 11.6 0 0 1-1.8-.9l.4-.3a13.2 13.2 0 0 0 13.4 0l.4.3a11.6 11.6 0 0 1-1.8.9l.7.9a18.7 18.7 0 0 0 5.5-2.7c.5-4.6-.8-8.5-3.2-12.1ZM8.4 14.2c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Zm7.2 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Z" />
  </svg>;
}

function KofiLogo({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path fill="currentColor" d="M4.2 6.1h12.5c1.7 0 3 1.3 3 3v.3h.5a3.3 3.3 0 0 1 0 6.6h-.8a6.6 6.6 0 0 1-6 3.9H7.7A6.7 6.7 0 0 1 1 13.2V9.3c0-1.8 1.4-3.2 3.2-3.2Zm15.5 7.5h.5a1 1 0 0 0 0-2h-.5v2ZM8.6 9.4c-.8 0-1.5.6-1.5 1.5 0 2 3.5 4 3.8 4.1.3-.1 3.8-2.1 3.8-4.1 0-.9-.7-1.5-1.5-1.5-.8 0-1.5.5-2.3 1.4-.8-.9-1.5-1.4-2.3-1.4Z" />
  </svg>;
}

function AppFooter() {
  return (
    <footer className="app-footer">
      <div className="app-footer-credit">
        <Heart size={16} fill="currentColor" />
        <span>
          Created with love by RedBlink ·{" "}
          <a href={COMMUNITY_CONTRIBUTORS_URL} target="_blank" rel="noreferrer">Community Contributors</a>
        </span>
      </div>
      <div className="app-footer-directory">
        <a href={DUNE_DOCKER_DOCS_URL} target="_blank" rel="noreferrer">Documentation</a>
        <span aria-hidden="true">·</span>
        <a href={DUNE_DOCKER_WEBSITE_URL} target="_blank" rel="noreferrer">Public Server Directory</a>
      </div>
    </footer>
  );
}

export function App() {
  const [auth, setAuth] = useState(false);
  const [password, setPassword] = useState("");
  // Tier 3 second factor (RFC §2.3/§4). All inert unless the server actually
  // asks for a code, so a console with CONSOLE_TOTP_ENABLED unset renders the
  // same single password field it always has.
  const [totpCode, setTotpCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [totpRequired, setTotpRequired] = useState(false);
  const [recoveryAvailable, setRecoveryAvailable] = useState(false);
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [setupMode, setSetupMode] = useState<"enroll" | "resetup" | null>(null);
  // Tier 1 (Discord sign-in). Available only when the server reports the
  // OAuth application is fully configured; the button is otherwise absent.
  const [discordSignInAvailable, setDiscordSignInAvailable] = useState(false);
  const [discordPendingRestart, setDiscordPendingRestart] = useState(false);
  // #643: an operator RECONFIGURING Discord from an already-authenticated
  // Settings session sets this sessionStorage marker immediately before
  // navigating to the setup-mode OAuth round-trip -- distinguishing that
  // return from the pre-login first-run flow below, which also lands back on
  // "/?discordSetup=done" but must keep its existing standalone-wizard +
  // forced-logout behavior unchanged. Read (and removed) at most once per
  // mount, via this lazy initializer -- never re-checked afterward, so a
  // later reload of "/" after the marker's own consumption cannot re-trigger it.
  const [discordSetupReturnMarker] = useState(() => {
    try {
      const value = window.sessionStorage.getItem("dune-console:discord-setup-return");
      if (value) window.sessionStorage.removeItem("dune-console:discord-setup-return");
      return value;
    } catch { return null; }
  });
  // Guided first-run setup: opened from the sign-in page (after the password),
  // or automatically when returning from the setup-mode Discord round-trip --
  // but NOT when discordSetupReturnMarker is set, since that return belongs to
  // the embedded-in-Settings reconfiguration path instead (see autoOpenDiscordSetup below).
  const [discordSetupOpen, setDiscordSetupOpen] = useState(() => !discordSetupReturnMarker && new URLSearchParams(window.location.search).has("discordSetup"));
  const [wantDiscordSetup, setWantDiscordSetup] = useState(() => !discordSetupReturnMarker && new URLSearchParams(window.location.search).has("discordSetup"));
  // #643: read once (see discordSetupReturnMarker above), passed to SettingsPanel
  // to auto-expand its embedded Discord wizard on mount; SettingsPanel calls
  // onDiscordSetupAutoOpened() once it has, so a later remount (navigate away
  // from Settings and back) never re-triggers the auto-open.
  const [autoOpenDiscordSetup, setAutoOpenDiscordSetup] = useState(() => Boolean(discordSetupReturnMarker));
  const [showPasswordLogin, setShowPasswordLogin] = useState(false);
  // Focuses the admin-password field the moment "Set up Discord sign-in" is
  // clicked (issue #666 -- live-testing feedback: the instruction that follows
  // says "enter the admin password above", but nothing ever drew the eye or
  // the cursor there).
  const discordSetupPasswordRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (wantDiscordSetup) discordSetupPasswordRef.current?.focus();
  }, [wantDiscordSetup]);
  // What the policy engine will allow this session. Used only to hide the
  // Settings tab from Discord tiers a 403 would refuse anyway; enforcement
  // stays server-side, and an empty answer (read failed) hides nothing.
  const [allowedActions, setAllowedActions] = useState<string[]>([]);
  // True once /api/auth/me has answered (success or failure). The first-run
  // setup gate below must not run before it: a tier without setup:read gets a
  // 403 from /api/setup/state, and treating that as "setup incomplete" traps
  // the session in a wizard it cannot use and cannot leave.
  const [meLoaded, setMeLoaded] = useState(false);
  // True when /api/auth/me itself failed (transient network blip, 500) rather
  // than answered with zero actions (review finding). allowedActions.length is
  // 0 in BOTH cases, so the setup-gate effect below cannot tell "we know this
  // tier can reach nothing" from "we don't know anything" without this flag --
  // conflating them fell through to calling setupApi.state() blindly on a
  // read failure, 403'ing for exactly the moderator/player tiers the
  // known-empty-actions branch exists to protect from that same trap.
  const [meFetchFailed, setMeFetchFailed] = useState(false);
  const [userInfo, setUserInfo] = useState<{ username: string; displayName: string; tier: string } | null>(null);
  // #676 §7: the guided offer screen. Shown at most once, consumed the
  // moment a real Discord login (not password) lands with the marker
  // DiscordSetupWizard's own "done" step set right before its restart --
  // see the /api/auth/me effect below for where this actually fires.
  const [discordOfferMode, setDiscordOfferMode] = useState(false);
  const [autoOpenTwoFactorSetting, setAutoOpenTwoFactorSetting] = useState(false);
  const [tab, setTab] = useActiveTab();
  // #643: the one-shot Settings redirect for a reconfiguration Discord round-trip
  // (see discordSetupReturnMarker above) -- must run after useActiveTab so setTab
  // is already defined; deliberately outside any other effect's deps.
  useEffect(() => {
    if (discordSetupReturnMarker) setTab("Settings");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot on mount
  }, []);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [pinnedAddons, setPinnedAddons] = useState<PinnedAddon[]>(() => loadPinnedAddons());
  const [selectedPinnedAddonId, setSelectedPinnedAddonId] = useState("");
  const [addonUpdatesAvailable, setAddonUpdatesAvailable] = useState(false);
  const [onlinePlayerCount, setOnlinePlayerCount] = useState(0);
  const [status, setStatus] = useState("");
  const [readiness, setReadiness] = useState("");
  const [ports, setPorts] = useState("");
  const [doctor, setDoctor] = useState("");
  const [services, setServices] = useState("");
  const [selectedLogService, setSelectedLogService] = useState("gateway");
  const [baseFocusRequest, setBaseFocusRequest] = useState({ baseId: "", nonce: 0 });
  const [vehicleFocusRequest, setVehicleFocusRequest] = useState({ vehicleId: "", nonce: 0 });
  const [logs, setLogs] = useState("");
  const [task, setTask] = useState<Task | null>(null);
  const [backupRestoreTask, setBackupRestoreTask] = useState<Task | null>(null);
  const [homeTaskResult, setHomeTaskResult] = useState<HomeTaskResult | null>(null);
  const [funcomTokenResult, setFuncomTokenResult] = useState<HomeTaskResult | null>(() => loadPersistedFuncomTokenResult());
  const [homeRunningAction, setHomeRunningAction] = useState<"start" | "stop" | "restart" | "">("");
  const [homeRestartStarted, setHomeRestartStarted] = useState(false);
  const [stackVersionStatus, setStackVersionStatus] = useState<Record<string, string>>({ status: "Checking", current: "", latest: "" });
  const stackActionStartedAt = useRef(0);
  const stackActionReadyPolls = useRef(0);
  const stackRestartLifecycle = useRef<RestartLifecycleState>(createRestartLifecycleState());
  const stackRestartSuccessAnnounced = useRef(false);
  const stackStatusLoadRef = useRef<Promise<HomeLoadResult> | null>(null);
  const [setupState, setSetupState] = useState<SetupState | null>(null);
  const [publicDirectoryStatus, setPublicDirectoryStatus] = useState<PublicDirectoryStatus | null>(null);
  const [setupStateLoaded, setSetupStateLoaded] = useState(false);
  const [setupJump, setSetupJump] = useState({ step: 0, nonce: 0 });
  const [redeploySetupOpen, setRedeploySetupOpen] = useState(false);
  const [error, setError] = useState("");
  const [confirmRequest, setConfirmRequest] = useState<ConfirmDialogRequest | null>(null);
  const setupComplete = Boolean(setupState?.files?.complete ?? (setupState?.files?.env && setupState?.files?.token && setupState?.files?.battlegroup));
  const firstRunSetup = auth && setupStateLoaded && !setupComplete;

  useEffect(() => {
    preloadPlayerAdminIconRailAssets();
  }, []);

  // /api/auth/state exposes the public build version without requiring a
  // session. Keep watching through the logged-out state too: a Console
  // rebuild clears the in-memory session, and disabling the watcher at that
  // moment would let the old bundle survive through the next login.
  useStaleBuildWatcher();

  useEffect(() => {
    if (!auth) { setAllowedActions([]); setUserInfo(null); setMeLoaded(false); setMeFetchFailed(false); return; }
    let cancelled = false;
    setMeFetchFailed(false);
    api<{ user: { id: string; username: string; displayName: string; tier: string; guildId: string }; allowedActions: string[] }>("/api/auth/me")
      .then((res) => {
        if (cancelled) return;
        setAllowedActions(res.allowedActions || []);
        setUserInfo({ username: res.user.username, displayName: res.user.displayName || res.user.username, tier: res.user.tier });
        setMeLoaded(true);
        // #676 §7: consumed at most once, the first time a session lands
        // here with the marker present. "local-owner" is the server's own
        // literal fallback for a password/TOTP session's empty userId
        // (server.js /api/auth/me route) -- anything else is a real Discord
        // sign-in, which is what this offer specifically needs to have just
        // verified. A password login while the marker happens to be present
        // (an operator skipped Discord and used the fallback instead) just
        // silently consumes and drops it -- the offer would make no sense
        // there, since nothing about Discord was actually just proven live.
        try {
          const hasOfferMarker = window.sessionStorage.getItem("dune-console:discord-oauth-just-configured");
          if (hasOfferMarker) {
            window.sessionStorage.removeItem("dune-console:discord-oauth-just-configured");
            if (res.user.id && res.user.id !== "local-owner") setDiscordOfferMode(true);
          }
        } catch { /* sessionStorage unavailable -- the offer just never fires, no functional loss */ }
      })
      .catch(() => { if (!cancelled) { setMeFetchFailed(true); setMeLoaded(true); } /* a failed read leaves the UI ungated; the server still enforces */ });
    return () => { cancelled = true; };
  }, [auth]);

  useEffect(() => {
    const handleSessionExpired = () => {
      setCsrfToken(null);
      setAuth(false);
      setPassword("");
      setTab("Home");
      setMobileNavOpen(false);
      setRedeploySetupOpen(false);
      setConfirmRequest(null);
      setError(AUTH_SESSION_EXPIRED_MESSAGE);
      // Without this, an expiry landing while totpRequired/setupMode is set
      // leaves the login screen stuck -- no password field (totpRequired keeps
      // rendering the code/recovery field), or a dead-end setup screen with no
      // way back to plain login.
      setTotpRequired(false);
      setTotpCode("");
      setRecoveryCode("");
      setUseRecoveryCode(false);
      setRecoveryAvailable(false);
      setSetupMode(null);
    };
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, handleSessionExpired);
  }, []);

  useEffect(() => {
    savePinnedAddons(pinnedAddons);
  }, [pinnedAddons]);

  useEffect(() => {
    api<{ authenticated: boolean; csrfToken: string | null; scope?: string | null; config?: { discordOAuthConfigured?: boolean; discordSetupPendingRestart?: boolean; ports?: Partial<ServerPorts>; port?: number } }>("/api/auth/state").then((state) => {
      // A reload or second tab during two-factor setup: the enrollment-scope
      // session is "authenticated" but can reach nothing except the setup
      // routes, so resume the setup screen instead of rendering a console
      // where every call is refused.
      if (state.authenticated && (state.scope === "enroll" || state.scope === "resetup")) {
        setCsrfToken(state.csrfToken);
        setSetupMode(state.scope);
        setServerPorts(state.config?.ports);
        setAdminPort(state.config?.port);
        return;
      }
      setAuth(state.authenticated);
      setDiscordSignInAvailable(Boolean(state.config?.discordOAuthConfigured));
      setDiscordPendingRestart(Boolean(state.config?.discordSetupPendingRestart));
      setCsrfToken(state.csrfToken);
      setServerPorts(state.config?.ports);
      setAdminPort(state.config?.port);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    persistFuncomTokenResult(funcomTokenResult);
  }, [funcomTokenResult]);

  useEffect(() => {
    if (!auth) {
      setSetupState(null);
      setSetupStateLoaded(false);
      setAddonUpdatesAvailable(false);
      setOnlinePlayerCount(0);
      setPublicDirectoryStatus(null);
      return;
    }
    if (!meLoaded) return;
    // meFetchFailed means /api/auth/me itself failed, so allowedActions is [] as
    // "we don't know", not as "this tier really has zero actions" (review
    // finding) -- calling setupApi.state() on that unknown state 403'd for
    // exactly the moderator/player tiers the branch below exists to
    // protect from this trap. Treat a failed read the same as a tier with no
    // setup access: render the console rather than risk a 403 dead end.
    if (meFetchFailed || (allowedActions.length > 0 && !allowedActions.includes("setup:read"))) {
      // This tier can neither read nor run first-run setup (every /api/setup/*
      // route would 403), so there is nothing to gate on: treat setup as done
      // and render the console. The owner still sees the wizard on a fresh
      // install because owner holds setup:read.
      setSetupState({ files: { complete: true }, config: {} });
      setSetupStateLoaded(true);
      return;
    }
    let cancelled = false;
    setSetupStateLoaded(false);
    setupApi.state().then((state) => {
      if (cancelled) return;
      setSetupState(state);
      setSetupStateLoaded(true);
    }).catch((err) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : String(err));
      setSetupStateLoaded(true);
    });
    return () => { cancelled = true; };
  }, [auth, meLoaded, meFetchFailed, allowedActions]);

  useEffect(() => {
    if (!auth) return;
    let cancelled = false;
    const refreshDirectoryStatus = async () => {
      try {
        const next = await api<PublicDirectoryStatus>("/api/public-directory/status");
        if (!cancelled) setPublicDirectoryStatus(next);
      } catch {
        if (!cancelled) setPublicDirectoryStatus(null);
      }
    };
    void refreshDirectoryStatus();
    const timer = window.setInterval(refreshDirectoryStatus, 30000);
    window.addEventListener("public-directory-claim-changed", refreshDirectoryStatus);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("public-directory-claim-changed", refreshDirectoryStatus);
    };
  }, [auth]);

  useEffect(() => {
    if (!auth) return;
    let cancelled = false;
    const refreshAddonUpdates = async () => {
      try {
        const [catalog, installed] = await Promise.all([addonsApi.community(), addonsApi.installed()]);
        if (!cancelled) setAddonUpdatesAvailable(hasAddonUpdates(catalog.addons || [], installed.addons || []));
      } catch {
        if (!cancelled) setAddonUpdatesAvailable(false);
      }
    };
    void refreshAddonUpdates();
    const timer = window.setInterval(refreshAddonUpdates, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [auth]);

  useEffect(() => {
    if (!auth) return;
    let cancelled = false;
    async function refreshOnlinePlayers() {
      try {
        const count = await playersApi.onlineCount();
        if (!cancelled) setOnlinePlayerCount(count);
      } catch {
        if (!cancelled) setOnlinePlayerCount(0);
      }
    }
    void refreshOnlinePlayers();
    const id = window.setInterval(refreshOnlinePlayers, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [auth]);

  useEffect(() => {
    openConfirmDialog = (request) => setConfirmRequest(request);
    return () => {
      openConfirmDialog = null;
    };
  }, []);

  function closeConfirmDialog(outcome: ConfirmDialogOutcome) {
    const request = confirmRequest;
    setConfirmRequest(null);
    request?.resolve(outcome);
  }

  // Uses loginRequest, not post(), because every status this route returns
  // (200 authenticated/enrollmentRequired/resetupRequired, 401 wrong-password/
  // totpRequired/recoveryFailed, 429 rate-limited) is a real outcome to branch
  // on -- there is no session yet at login time, so the shared
  // session-expiry-on-401 handling used elsewhere would misrepresent all of them.
  async function login() {
    const body: Record<string, string> = { password };
    let codeAttempted = false;
    if (useRecoveryCode && recoveryCode) { body.recoveryCode = recoveryCode; codeAttempted = true; }
    else if (totpRequired && totpCode) { body.totpCode = totpCode; codeAttempted = true; }
    const { status, body: result } = await loginRequest(body);

    if (status === 200 && result.authenticated) {
      setCsrfToken(String(result.csrfToken || ""));
      setAuth(true);
      if (wantDiscordSetup) { setWantDiscordSetup(false); setDiscordSetupOpen(true); }
      setTotpRequired(false);
      setTotpCode("");
      setRecoveryCode("");
      setUseRecoveryCode(false);
      setRecoveryAvailable(false);
      return;
    }
    if (status === 200 && (result.enrollmentRequired || result.resetupRequired)) {
      setCsrfToken(String(result.csrfToken || ""));
      setSetupMode(result.enrollmentRequired ? "enroll" : "resetup");
      return;
    }
    if (status === 401 && result.totpRequired) {
      setTotpRequired(true);
      setRecoveryAvailable(Boolean(result.recoveryAvailable));
      // The server returns this identical shape both right after a correct
      // password (no code submitted yet -- not a failure, just one more
      // step) and after a WRONG code is submitted (a real failure) -- the
      // only way to tell them apart is whether THIS request actually
      // included a code. Throwing unconditionally rendered both through the
      // same shared, red-styled .error paragraph used for genuine failures,
      // which at a glance looked identical to the password having been
      // rejected (live-testing finding). Only throw for the real failure;
      // the neutral first-time prompt is shown by the login-totp-hint
      // paragraph below instead.
      if (codeAttempted) throw new Error(String(result.error || "That code was not accepted."));
      setError("");
      return;
    }
    if (status === 401 && result.recoveryFailed) {
      throw new Error(String(result.error || "That recovery code was not accepted."));
    }
    throw new Error(String(result.error || "Sign-in failed."));
  }

  // After enrollment/re-setup the server invalidates that session and requires a
  // fresh, normal password+TOTP login (RFC §4) -- return to the plain login form
  // rather than assuming success.
  function afterTotpSetup() {
    // Also used as onCancel ("Back to sign in"): every OTHER terminal branch
    // of this flow (a confirmed enrollment, a 409 already-configured) ends the
    // server-side enrollment session; leaving via Cancel used to skip that,
    // so the session (and any pending secret on it) stayed live for the rest
    // of its TTL (review finding).
    void post("/api/auth/logout").catch(() => { /* best effort -- proceed to login either way */ });
    setSetupMode(null);
    setPassword("");
    setTotpCode("");
    setRecoveryCode("");
    setTotpRequired(false);
    setUseRecoveryCode(false);
    setCsrfToken(null);
    // Owner-initiated enrollment (Settings -> Two-Factor Authentication, issue
    // #665) reaches this function while `auth` is still true from the normal
    // session it started in -- forced first-login enrollment never had this
    // problem (auth was always false at this point). Without this, cancelling
    // or completing setup left the app trying to render the authenticated
    // shell against a session the server just invalidated above.
    setAuth(false);
  }

  async function doLogout() {
    try {
      await post("/api/auth/logout");
    } catch {
      // Return to the sign-in screen even if server-side session cleanup fails.
    }
    setCsrfToken(null);
    setAuth(false);
    setUserInfo(null);
    setPassword("");
    setTab("Home");
    setMobileNavOpen(false);
  }

  async function logoutAfterPasswordChange() {
    try {
      await post("/api/auth/logout");
    } catch {
      // The password already changed; return to login even if session cleanup fails.
    }
    setCsrfToken(null);
    setAuth(false);
    setPassword("");
    setTab("Home");
  }

  async function safe(action: () => Promise<void>) {
    setError("");
    try { await action(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }

  const loadStackStatus = useCallback(async () => {
    if (stackStatusLoadRef.current) return stackStatusLoadRef.current;
    stackStatusLoadRef.current = (async () => {
      setError("");
      const [nextStatus, nextReadiness] = await Promise.allSettled([
        withTimeout(serverApi.status(), 90000, "Server status check timed out."),
        withTimeout(serverApi.readiness(), 90000, "Readiness check timed out.")
      ]);
      const result: HomeLoadResult = { statusLoaded: false, readinessLoaded: false, statusError: "", readinessError: "", statusText: "", readinessText: "" };
      if (nextStatus.status === "fulfilled") {
        setStatus(nextStatus.value.stdout);
        result.statusText = nextStatus.value.stdout;
        result.statusLoaded = true;
      } else {
        result.statusError = nextStatus.reason instanceof Error ? nextStatus.reason.message : String(nextStatus.reason);
      }
      if (nextReadiness.status === "fulfilled") {
        const readinessText = nextReadiness.value.stdout || nextReadiness.value.stderr || "";
        result.readinessText = readinessText;
        setReadiness(readinessText);
        result.readinessLoaded = Number(nextReadiness.value.exitCode || 0) === 0;
        if (!result.readinessLoaded) result.readinessError = nextReadiness.value.stderr || nextReadiness.value.stdout || "Readiness checks are not ready yet.";
      } else {
        result.readinessError = nextReadiness.reason instanceof Error ? nextReadiness.reason.message : String(nextReadiness.reason);
      }
      return result;
    })().finally(() => {
      stackStatusLoadRef.current = null;
    });
    return stackStatusLoadRef.current;
  }, []);

  useEffect(() => {
    if (!homeRunningAction) return;
    stackActionStartedAt.current = Date.now();
    stackActionReadyPolls.current = 0;
    stackRestartLifecycle.current = createRestartLifecycleState();
    stackRestartSuccessAnnounced.current = false;
    setHomeRestartStarted(false);
    let active = true;
    async function refreshRunningAction() {
      const result = await loadStackStatus().catch(() => null);
      if (!active || !result) return;
      const statusText = result.statusText;
      const readinessText = result.readinessText;
      const elapsedMs = Date.now() - stackActionStartedAt.current;
      if (homeRunningAction === "restart") {
        stackRestartLifecycle.current = advanceRestartLifecycle(stackRestartLifecycle.current, statusText, readinessText);
      }
      const restartReady = isRestartLifecycleReady(homeRunningAction, stackRestartLifecycle.current);
      if (homeRunningAction === "stop" && isHomeStopComplete(statusText, readinessText)) {
        setHomeTaskResult({ status: "stopped", title: "Battlegroup Stopped" });
        setHomeRunningAction("");
      } else if (homeRunningAction === "restart" && restartReady) {
        setHomeRestartStarted(true);
        if (!stackRestartSuccessAnnounced.current) {
          stackRestartSuccessAnnounced.current = true;
          setHomeTaskResult({ status: "succeeded", title: "Battlegroup Restarted Successfully" });
        }
        if (isHomeActionComplete(statusText, readinessText)) setHomeRunningAction("");
      } else if (homeRunningAction === "start" && elapsedMs >= 8000 && isHomeActionComplete(statusText, readinessText)) {
        stackActionReadyPolls.current += 1;
        if (stackActionReadyPolls.current >= 2) {
          setHomeTaskResult({ status: "succeeded", title: "Battlegroup Started Successfully" });
          setHomeRunningAction("");
        } else {
          setHomeTaskResult(stackActionPendingResult(homeRunningAction, "confirming"));
        }
      } else if (homeRunningAction === "start" || homeRunningAction === "restart") {
        stackActionReadyPolls.current = 0;
      }
    }
    const id = window.setInterval(refreshRunningAction, 3000);
    refreshRunningAction();
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [homeRunningAction, loadStackStatus]);

  useEffect(() => {
    if (homeRunningAction !== "restart") setHomeRestartStarted(false);
  }, [homeRunningAction]);

  useEffect(() => {
    if (!homeTaskResult || homeTaskResult.status === "running") return;
    const id = window.setTimeout(() => setHomeTaskResult(null), 10400);
    return () => window.clearTimeout(id);
  }, [homeTaskResult?.status, homeTaskResult?.title]);

  useEffect(() => {
    if (homeTaskResult?.status === "succeeded" && /restart/i.test(homeTaskResult.title || "")) {
      stackRestartSuccessAnnounced.current = true;
    }
  }, [homeTaskResult?.status, homeTaskResult?.title]);

  useEffect(() => {
    if (!auth || !setupComplete) return;
    let cancelled = false;
    void (async () => {
      try {
        const final = await waitForTaskSilently((await updatesApi.checkStack()).task);
        if (!cancelled) setStackVersionStatus(parseUpdateTask(final));
      } catch {
        if (!cancelled) setStackVersionStatus({ status: "Unavailable", current: "", latest: "" });
      }
    })();
    return () => { cancelled = true; };
  }, [auth, setupComplete]);

  if (setupMode) {
    return <TotpSetupScreen mode={setupMode} onComplete={afterTotpSetup} onCancel={afterTotpSetup} />;
  }

  if (auth && discordSetupOpen) {
    return <DiscordSetupWizard onDone={() => { setDiscordSetupOpen(false); setWantDiscordSetup(false); setShowPasswordLogin(false); void post("/api/auth/logout").catch(() => {}); setCsrfToken(null); setAuth(false); setPassword(""); }} onCancel={() => { setDiscordSetupOpen(false); setWantDiscordSetup(false); setShowPasswordLogin(false); }} />;
  }

  if (auth && discordOfferMode) {
    return <DiscordMigrationOffer
      onReview={() => { setDiscordOfferMode(false); setTab("Settings"); setAutoOpenTwoFactorSetting(true); }}
      onDismiss={() => setDiscordOfferMode(false)}
    />;
  }

  if (!auth) {
    const passwordFields = totpRequired ? (
      <div className="login-password-fields">
        {!error && (
          <p className="login-totp-hint muted">
            {useRecoveryCode ? "Enter one of your saved recovery codes." : "Password accepted — enter your authenticator code."}
          </p>
        )}
        {useRecoveryCode ? (
          <input
            type="text"
            id="login-recovery-code"
            name="login-recovery-code"
            aria-label="Recovery code"
            autoComplete="one-time-code"
            value={recoveryCode}
            onChange={(event) => setRecoveryCode(event.target.value)}
            placeholder="Recovery code"
            autoFocus
          />
        ) : (
          <input
            type="text"
            id="login-totp-code"
            name="login-totp-code"
            aria-label="Authenticator code"
            autoComplete="one-time-code"
            inputMode="numeric"
            value={totpCode}
            onChange={(event) => setTotpCode(event.target.value)}
            placeholder="Authenticator code"
            autoFocus
          />
        )}
        <button type="submit" className="login-primary-button">Sign In</button>
        {recoveryAvailable && (
          <button
            type="button"
            className="login-password-toggle"
            onClick={() => { setUseRecoveryCode(!useRecoveryCode); setTotpCode(""); setRecoveryCode(""); }}
          >
            {useRecoveryCode ? "Use your authenticator instead" : "Lost access to your authenticator?"}
          </button>
        )}
      </div>
    ) : (
      <div className="login-password-fields">
        <input ref={discordSetupPasswordRef} type="password" id="login-admin-password" name="login-admin-password" aria-label="Admin password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Admin Password" />
        <button type="submit" className="login-primary-button">Sign In</button>
      </div>
    );
    return (
      <main className="login-screen">
        <form className="login-panel" onSubmit={(event) => { event.preventDefault(); void safe(login); }}>
          <h1>Dune Docker Console</h1>
          <img className="login-logo" src="/dune-docker-logo.png" alt="Dune Docker Console logo" />
          <p>Beyond the Dunes, Every Choice Shapes the Future</p>
          {/* Predominance flips by state. While Discord is opt-in and not yet
              configured, the password leads and Discord is a secondary "set it
              up" option. Once configured, Discord is the primary sign-in (most
              people have only Discord) and the password becomes the secondary,
              break-glass path -- revealed on demand, never a second factor on
              top of Discord. */}
          {discordSignInAvailable && !totpRequired ? (
            <>
              <a className="login-discord-button login-discord-button-primary" href="/api/auth/discord/start">
                <DiscordLogo size={19} aria-hidden="true" /> Sign in with Discord
              </a>
              <button type="button" className="login-password-toggle" onClick={() => setShowPasswordLogin(!showPasswordLogin)}>
                {showPasswordLogin ? "Hide the admin password" : "Use the admin password instead"}
              </button>
              {showPasswordLogin && passwordFields}
            </>
          ) : (
            <>
              {passwordFields}
              {!totpRequired && (
                discordPendingRestart ? (
                  <p className="muted">Discord sign-in is set up — restart the console to switch it on.</p>
                ) : wantDiscordSetup ? (
                  <p className="muted">Type your admin password above, then select <strong>Sign In</strong> to continue setting up Discord sign-in. <button type="button" className="login-password-toggle" onClick={() => setWantDiscordSetup(false)}>cancel</button></p>
                ) : (
                  <button type="button" className="login-discord-button login-discord-button-secondary" onClick={() => setWantDiscordSetup(true)}>
                    <DiscordLogo size={17} aria-hidden="true" /> Set up Discord sign-in
                  </button>
                )
              )}
            </>
          )}
          {error && <p className="error">{error === AUTH_SESSION_EXPIRED_MESSAGE
            ? <>Your browser login session expired.<br />Sign in again to continue.</>
            : error}</p>}
        </form>
      </main>
    );
  }

  if (!setupStateLoaded) {
    return (
      <main className="login-screen">
        <section className="login-panel">
          <h1>Dune Docker Console</h1>
          <p className="loading-dots">Loading setup</p>
        </section>
      </main>
    );
  }

  if (firstRunSetup) {
    return (
      <div className="app-shell setup-only-shell">
        <main className="home-main setup-main">
          <div className="home-backdrop" aria-hidden="true">
            <span className="home-sand-fine" />
            <span className="home-sand-near" />
          </div>
          <header className="topbar">
            <div>
              <strong>Setup</strong>
              <span>Finish the first-time setup to unlock the console.</span>
            </div>
          </header>
          {error && <div className="error-banner">{error}</div>}
          <SetupWizard
            initialStep={setupJump.step}
            jumpNonce={setupJump.nonce}
            mode="first-run"
            onSetupComplete={async () => {
              const state = await setupApi.state();
              setSetupState(state);
              if (state.files?.complete ?? (state.files?.env && state.files?.token && state.files?.battlegroup)) setTab("Home");
            }}
          />
          <AppFooter />
        </main>
      </div>
    );
  }

  const visibleTitle = redeploySetupOpen ? "Redeploy" : tab;
  const visibleSubtitle = redeploySetupOpen
    ? "Update setup values and redeploy your Dune server."
    : "Run and manage your self-hosted Dune server from the browser.";

  const closeMobileNav = () => setMobileNavOpen(false);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <button className="sidebar-home-button" type="button" onClick={() => { setRedeploySetupOpen(false); setTab("Home"); closeMobileNav(); }} title="Open Home">
            <h1>Dune Docker Console</h1>
          </button>
          <button className="stack-version-button" title={stackVersionButtonTitle(stackVersionStatus)} aria-label={stackVersionButtonTitle(stackVersionStatus)} onClick={() => { setRedeploySetupOpen(false); setTab("Updates"); closeMobileNav(); }}>{stackVersionButtonLabel(stackVersionStatus)}</button>
          <button
            className="sidebar-menu-toggle"
            type="button"
            aria-controls="console-navigation"
            aria-expanded={mobileNavOpen}
            aria-label={mobileNavOpen ? "Close navigation" : "Open navigation"}
            onClick={() => setMobileNavOpen((open) => !open)}
          >{mobileNavOpen ? <X size={20} /> : <Menu size={20} />}</button>
        </div>
        {userInfo && (
          <div className="sidebar-user">
            <span className="sidebar-user-identity">
              <ShieldCheck size={16} aria-hidden="true" />
              <span className="sidebar-user-name" title={userInfo.username}>{userInfo.displayName}</span>
            </span>
            <div className="sidebar-user-meta">
              <span className={`sidebar-user-tier tier-${userInfo.tier}`} title={`Console access tier: ${userInfo.tier}`}>{userInfo.tier}</span>
              <button className="sidebar-logout" type="button" onClick={() => { void doLogout(); }} title="Log out">
                <LogOut size={14} aria-hidden="true" /><span>Logout</span>
              </button>
            </div>
          </div>
        )}
        <nav id="console-navigation" className={`sidebar-nav ${mobileNavOpen ? "mobile-open" : ""}`}>
          {navGroups.map((group) => (
            <section className="sidebar-nav-group" key={group.title} aria-label={group.title}>
              <p className="sidebar-nav-heading">{group.title}</p>
              {group.items.filter((item) => {
                if (item.tab !== "Settings" && item.tab !== "Access Control") return true;
                const hasSettingsAccess = allowedActions.length === 0 || allowedActions.some((a) => a.startsWith("settings:"));
                if (!hasSettingsAccess) return false;
                // Access Control configures what admin/moderator/player tiers
                // (reachable only via Discord role mapping) can do. With no
                // Discord OAuth configured at all, a password/TOTP session is
                // always owner (no role concept in that tier), owner already
                // has every permission, and no other tier is reachable by
                // anyone -- the editor would be real UI with nothing real to
                // configure (live-testing finding). Settings itself must stay
                // visible regardless -- it's where Discord OAuth gets set up.
                if (item.tab === "Access Control" && !discordSignInAvailable) return false;
                return true;
              }).map((item) => (
                <Fragment key={item.tab}>
                  <button className={tab === item.tab && (!selectedPinnedAddonId || item.tab !== "Addons") ? "active" : ""} onClick={() => {
                    setRedeploySetupOpen(false);
                    setSelectedPinnedAddonId("");
                    setTab(item.tab);
                    closeMobileNav();
                  }}><span className="sidebar-nav-main">{item.icon}<span>{item.tab}</span></span><SidebarNavIndicators item={item.tab} onlinePlayerCount={onlinePlayerCount} addonUpdatesAvailable={addonUpdatesAvailable} /></button>
                  {item.tab === "Addons" && pinnedAddons.length > 0 && <div className="sidebar-addon-children">
                    {pinnedAddons.map((addon) => (
                      <button key={addon.id} className={tab === "Addons" && selectedPinnedAddonId === addon.id ? "active" : ""} onClick={() => {
                        setRedeploySetupOpen(false);
                        setSelectedPinnedAddonId(addon.id);
                        setTab("Addons");
                        closeMobileNav();
                      }}>{addon.name}</button>
                    ))}
                  </div>}
                </Fragment>
              ))}
              {group.title === "Community" && (
                <>
                  <a className="sidebar-request-button" href={REDBLINK_DISCORD_URL} target="_blank" rel="noreferrer"><MessageCircle size={18} />Requests</a>
                  <a className="sidebar-request-button" href={REDBLINK_DISCORD_URL} target="_blank" rel="noreferrer"><Bug size={18} />Report Issues</a>
                  <a className="sidebar-request-button" href={REDBLINK_DISCORD_URL} target="_blank" rel="noreferrer"><CircleHelp size={18} />Get Help</a>
                </>
              )}
            </section>
          ))}
        </nav>
      </aside>
      <main className={!redeploySetupOpen && tab === "Home" ? "home-main" : undefined}>
        {!redeploySetupOpen && tab === "Home" && (
          <div className="home-backdrop" aria-hidden="true">
            <span className="home-sand-fine" />
            <span className="home-sand-near" />
          </div>
        )}
        <header className="topbar">
          <div>
            <strong>{visibleTitle}</strong>
            <span>{visibleSubtitle}</span>
          </div>
          <div className="topbar-links" aria-label="Community links">
            {publicDirectoryStatus?.mode === "public" && publicDirectoryStatus.serverId && <a
              className={`listing-claim-badge ${publicDirectoryStatus.listingClaimed ? "claimed" : "unclaimed"}`}
              href={publicServerListingUrl(publicDirectoryStatus.serverId)}
              target="_blank"
              rel="noreferrer"
              title="Open Public Server Listing"
            >{publicDirectoryStatus.listingClaimed ? "Claimed Listing" : "Unclaimed Listing"}</a>}
            <a className="community-button discord" href={REDBLINK_DISCORD_URL} target="_blank" rel="noreferrer" title="Join Discord"><span>Join Discord</span><DiscordLogo size={19} /></a>
            <a className="community-button support" href={REDBLINK_KOFI_URL} target="_blank" rel="noreferrer" title="Support Project"><span>Support Project</span><KofiLogo size={19} /></a>
          </div>
        </header>
        {error && <div className="error-banner">{error}</div>}
        {redeploySetupOpen && <SetupWizard initialStep={setupJump.step} jumpNonce={setupJump.nonce} mode="redeploy" onSetupComplete={async () => setSetupState(await setupApi.state())} />}
        {!redeploySetupOpen && tab === "Home" && <HomePanel status={status} readiness={readiness} taskResult={homeTaskResult} setTaskResult={setHomeTaskResult} funcomTokenResult={funcomTokenResult} setFuncomTokenResult={setFuncomTokenResult} runningAction={homeRunningAction} restartStartObserved={homeRestartStarted} setRunningAction={setHomeRunningAction} onLoad={loadStackStatus} confirmAction={confirmDialog} restartGate={restartGateChoice} />}
        {!redeploySetupOpen && tab === "Server Control" && <ServerPanel setTask={setTask} setStatus={setStatus} status={status} setReadiness={setReadiness} setPorts={setPorts} setDoctor={setDoctor} ports={ports} readiness={readiness} doctor={doctor} taskResult={homeTaskResult} setTaskResult={setHomeTaskResult} funcomTokenResult={funcomTokenResult} setFuncomTokenResult={setFuncomTokenResult} runningAction={homeRunningAction} restartStartObserved={homeRestartStarted} setRunningAction={setHomeRunningAction} onError={setError} confirmAction={confirmDialog} restartGate={restartGateChoice} onRedeploy={() => {
          setSetupJump((current) => ({ step: 0, nonce: current.nonce + 1 }));
          setSelectedPinnedAddonId("");
          setRedeploySetupOpen(true);
        }} />}
        {!redeploySetupOpen && tab === "Services" && <LazyTabBoundary label="Loading Services"><ServicesPanel services={services} setServices={setServices} setTask={setTask} openLogs={(service) => { setRedeploySetupOpen(false); setSelectedLogService(service); setTab("Logs"); }} onError={setError} confirmAction={confirmDialog} restartGate={restartGateChoice} /></LazyTabBoundary>}
        {!redeploySetupOpen && tab === "Players" && <LazyTabBoundary label="Loading Players"><PlayersPanel onError={setError} renderCharacterAdmin={(props) => <LazyTabBoundary label="Loading Player Details"><CharacterAdminUI {...props} onError={setError} confirmAction={confirmDialog} waitForTask={waitForTaskSilently} formatMutationResult={formatMutationResult} restartGate={restartGateChoice} /></LazyTabBoundary>} /></LazyTabBoundary>}
        {!redeploySetupOpen && tab === "Guilds" && <LazyTabBoundary label="Loading Guilds"><GuildsPanel onError={setError} confirmAction={confirmDialog} /></LazyTabBoundary>}
        {!redeploySetupOpen && tab === "Bases" && <LazyTabBoundary label="Loading Bases"><BasesPanel onError={setError} confirmAction={confirmDialog} restartGate={restartGateChoice} formatMutationResult={formatMutationResult} focusRequest={baseFocusRequest} /></LazyTabBoundary>}
        {!redeploySetupOpen && tab === "Vehicles" && <LazyTabBoundary label="Loading Vehicles"><VehiclesPanel onError={setError} confirmAction={confirmDialog} formatMutationResult={formatMutationResult} focusRequest={vehicleFocusRequest} /></LazyTabBoundary>}
        {!redeploySetupOpen && tab === "Exchange" && <LazyTabBoundary label="Loading Market Board"><ExchangePanel onError={setError} confirmAction={confirmDialog} formatMutationResult={formatMutationResult} /></LazyTabBoundary>}
        {!redeploySetupOpen && tab === "Landsraad" && <LazyTabBoundary label="Loading Landsraad"><LandsraadPanel onError={setError} confirmAction={confirmDialog} restartGate={restartGateChoice} /></LazyTabBoundary>}
        {!redeploySetupOpen && tab === "Admin Tools" && <LazyTabBoundary label="Loading Admin Tools"><AdminToolsPanel onError={setError} confirmAction={confirmDialog} /></LazyTabBoundary>}
        {!redeploySetupOpen && tab === "Live Map" && <LazyTabBoundary label="Loading Live Map"><LiveMapPanel onError={setError} confirmAction={confirmDialog} waitForTask={waitForTaskSilently} taskTechnicalDetails={taskTechnicalDetails} onOpenBase={(baseId) => { setBaseFocusRequest((current) => ({ baseId, nonce: current.nonce + 1 })); setTab("Bases"); }} onOpenVehicle={(vehicleId) => { setVehicleFocusRequest((current) => ({ vehicleId, nonce: current.nonce + 1 })); setTab("Vehicles"); }} /></LazyTabBoundary>}
        {!redeploySetupOpen && tab === "Maps" && <LazyTabBoundary label="Loading Maps"><MapsPanel onError={setError} confirmAction={confirmDialog} restartGate={restartGateChoice} confirmSettingsRestart={confirmSettingsRestart} waitForTaskWithUpdates={waitForTaskWithUpdates} taskTechnicalDetails={taskTechnicalDetails} /></LazyTabBoundary>}
        {!redeploySetupOpen && tab === "Care Package" && <LazyTabBoundary label="Loading Care Package"><CarePackagePanel onError={setError} confirmAction={confirmDialog} /></LazyTabBoundary>}
        {!redeploySetupOpen && tab === "Addons" && <LazyTabBoundary label="Loading Addons"><AddonsPanel pinnedAddons={pinnedAddons} setPinnedAddons={setPinnedAddons} selectedAddonId={selectedPinnedAddonId} clearSelectedAddon={() => setSelectedPinnedAddonId("")} setAddonUpdateAvailable={setAddonUpdatesAvailable} confirmAction={confirmDialog} /></LazyTabBoundary>}
        {!redeploySetupOpen && tab === "Database" && <LazyTabBoundary label="Loading Database"><DatabasePanel /></LazyTabBoundary>}
        {!redeploySetupOpen && tab === "Storage" && <LazyTabBoundary label="Loading Storage"><StoragePanel onError={setError} confirmAction={confirmDialog} formatMutationResult={formatMutationResult} /></LazyTabBoundary>}
        {!redeploySetupOpen && tab === "Backups" && <LazyTabBoundary label="Loading Backups"><BackupsPanel
            backupRestoreTask={backupRestoreTask}
            setBackupRestoreTask={setBackupRestoreTask}
            onError={setError}
            confirmAction={confirmDialog}
            chooseBackupIdentity={chooseBackupIdentity}
            waitForTask={waitForTaskSilently}
            waitForTaskWithUpdates={waitForTaskWithUpdates}
            withTimeout={withTimeout}
            toHourMinuteTime={toHourMinuteTime}
            sanitizeTimeInput={sanitizeTimeInput}
            isValidHourMinuteTime={isValidHourMinuteTime}
            commandStatusSummary={commandStatusSummary}
            taskTechnicalDetails={taskTechnicalDetails}
            isTerminalTask={isTerminalTask}
          /></LazyTabBoundary>}
        {!redeploySetupOpen && tab === "Logs" && <LazyTabBoundary label="Loading Logs"><LogsPanel selectedService={selectedLogService} setSelectedService={setSelectedLogService} text={logs} setText={setLogs} onError={setError} /></LazyTabBoundary>}
        {!redeploySetupOpen && tab === "Updates" && <LazyTabBoundary label="Loading Updates"><UpdatesPanel
            confirmAction={confirmDialog}
            waitForTask={waitForTaskSilently}
            parseKeyValueText={parseKeyValueText}
            formatTimerStatus={formatTimerStatus}
            commandStatusSummary={commandStatusSummary}
            taskTechnicalDetails={taskTechnicalDetails}
            formatResultTitle={formatResultTitle}
            formatResultMessage={formatResultMessage}
          /></LazyTabBoundary>}
        {!redeploySetupOpen && tab === "Access Control" && <LazyTabBoundary label="Loading Access Control"><IamPolicyEditor /></LazyTabBoundary>}
        {!redeploySetupOpen && tab === "Settings" && <LazyTabBoundary label="Loading Settings"><SettingsPanel
          onPasswordChanged={logoutAfterPasswordChange}
          publicListingUrl={publicDirectoryStatus?.serverId ? publicServerListingUrl(publicDirectoryStatus.serverId) : undefined}
          confirmAction={confirmDialog}
          onTotpEnrollmentStarted={() => setSetupMode("enroll")}
          autoOpenDiscordSetup={autoOpenDiscordSetup}
          onDiscordSetupAutoOpened={() => setAutoOpenDiscordSetup(false)}
          autoOpenTwoFactor={autoOpenTwoFactorSetting}
          onTwoFactorAutoOpened={() => setAutoOpenTwoFactorSetting(false)}
        /></LazyTabBoundary>}
        {!redeploySetupOpen && tab !== "Maps" && <TaskProgress task={task} onDismiss={() => setTask(null)} />}
        <AppFooter />
      </main>
      <ConfirmDialog request={confirmRequest} onClose={closeConfirmDialog} />
    </div>
  );
}

async function waitForTask(task: Task, setTask: (task: Task) => void) {
  let current = task;
  setTask(current);
  for (let i = 0; i < 180 && !["succeeded", "failed", "cancelled"].includes(current.status); i += 1) {
    await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 1000));
    try {
      current = (await setupApi.task(current.id)).task;
    } catch (error) {
      throw normalizeTaskPollError(error);
    }
    setTask(current);
  }
  return current;
}

async function waitForTaskSilently(task: Task) {
  let current = task;
  for (let i = 0; i < 180 && !["succeeded", "failed", "cancelled"].includes(current.status); i += 1) {
    await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 1000));
    try {
      current = (await setupApi.task(current.id)).task;
    } catch (error) {
      throw normalizeTaskPollError(error);
    }
  }
  return current;
}

async function waitForTaskWithUpdates(task: Task, onUpdate: (task: Task) => void) {
  let current = task;
  onUpdate(current);
  for (let i = 0; i < 3600 && !isTerminalTask(current.status); i += 1) {
    await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 1000));
    try {
      current = (await setupApi.task(current.id)).task;
    } catch (error) {
      throw normalizeTaskPollError(error);
    }
    onUpdate(current);
  }
  return current;
}

function normalizeTaskPollError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/session expired|console restarted|failed to fetch|networkerror|load failed/i.test(message)) {
    return new Error("The console connection was interrupted while the operation was running. Refresh the page and check the latest status before trying again.");
  }
  return error instanceof Error ? error : new Error(message);
}


function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then((value) => {
      window.clearTimeout(id);
      resolve(value);
    }).catch((error) => {
      window.clearTimeout(id);
      reject(error);
    });
  });
}

function toHourMinuteTime(value: unknown) {
  const text = String(value || "").trim();
  if (!text || /^unset$/i.test(text)) return "Unset";
  const match = text.match(/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  return match ? `${match[1]}:${match[2]}` : text;
}

function sanitizeTimeInput(value: string) {
  return value.replace(/[^\d:]/g, "").slice(0, 5);
}

function isValidHourMinuteTime(value: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}





function parseKeyValueText(text: string) {
  const out: Record<string, string> = {};
  for (const rawLine of stripAnsi(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^([^:=]{2,80}):\s*(.*)$/);
    if (!match) continue;
    out[match[1].trim().toLowerCase().replace(/\s+/g, "_")] = match[2].trim();
  }
  return out;
}

function commandStatusSummary(result: { stdout?: string; stderr?: string; exitCode?: number } | null) {
  if (!result) return { status: "Loading", reason: "" };
  if (Number(result.exitCode || 0) === 0) return { status: "Checked", reason: "" };
  return { status: "Check Failed", reason: result.stderr || result.stdout || "Command failed" };
}

function formatMutationResult(result: unknown) {
  const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
  if (!result || (typeof result === "object" && !Array.isArray(result) && Object.keys(record).length === 0)) return "Action completed.";
  if (record.supported === false) return `Unsupported: ${String(record.reason || record.error || "This action is not available.")}`;
  if (record.ok === false) return `Failed: ${String(record.error || record.reason || "The action did not complete.")}`;
  if (record.message) return String(record.message);
  const nested = record.result && typeof record.result === "object" ? record.result as Record<string, unknown> : {};
  if (nested.message) return String(nested.message);
  if (record.summary) return String(record.summary);
  if (record.status) return `Action status: ${String(record.status)}`;
  if (record.backup) return "Action completed after creating a database backup.";
  if (record.ok === true) return "Action completed.";
  return summarizeCommandText(JSON.stringify(record || result) || "");
}

function formatTimerStatus(value: string) {
  const text = String(value || "").trim();
  if (/^not installed$/i.test(text)) return "Not Installed";
  return titleCase(text);
}

function isTerminalTask(status: string) {
  return ["succeeded", "failed", "cancelled"].includes(status);
}
