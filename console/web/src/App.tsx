import { Fragment, Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { Archive, Database, FileText, Gift, Heart, Home, Landmark, Map as MapIcon, MessageCircle, PackagePlus, RefreshCw, Server, Settings, Shield, Sparkles, Users } from "lucide-react";
import { api, post, setCsrfToken } from "./api/client";
import { serverApi } from "./api/server";
import { updatesApi } from "./api/updates";
import { addonsApi } from "./api/addons";
import { playersApi } from "./api/players";
import { setupApi, type Task } from "./api/setup";
import { SetupWizard } from "./components/SetupWizard";
import { TaskProgress } from "./components/TaskProgress";
import { ConfirmDialog, type ConfirmDialogDetail, type ConfirmDialogRequest } from "./components/common/ConfirmDialog";
import { loadPinnedAddons, savePinnedAddons, type PinnedAddon } from "./features/addons/pinnedAddons";
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

type Tab = "Home" | "Server Control" | "Services" | "Players" | "Guilds" | "Landsraad" | "Admin Tools" | "Live Map" | "Maps" | "Care Package" | "Addons" | "Database" | "Storage" | "Backups" | "Logs" | "Updates" | "Settings";
type SetupState = { files: Record<string, boolean>; config: Record<string, unknown> };
let openConfirmDialog: ((request: ConfirmDialogRequest) => void) | null = null;

const AddonsPanel = lazy(() => import("./features/addons/AddonsPanel").then((module) => ({ default: module.AddonsPanel })));
const AdminToolsPanel = lazy(() => import("./features/adminTools/AdminToolsPanel").then((module) => ({ default: module.AdminToolsPanel })));
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
      resolve
    });
  });
}

function confirmSettingsRestart(kind: "UserEngine" | "UserGame") {
  return confirmDialog(
    `Save ${kind} changes? To apply these changes, the Dune server services need to restart.`,
    {
      title: "Restart Required",
      confirmLabel: "Yes, Save And Restart",
      cancelLabel: "No, Cancel"
    }
  );
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
      { tab: "Settings", icon: <Settings size={18} /> }
    ]
  },
  {
    title: "Arrakis Management",
    items: [
      { tab: "Maps", icon: <MapIcon size={18} /> },
      { tab: "Players", icon: <Users size={18} /> },
      { tab: "Guilds", icon: <Shield size={18} /> },
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
const REDBLINK_DISCORD_URL = "https://discord.gg/9pQqytu6BU";
const REDBLINK_KOFI_URL = "https://ko-fi.com/redblink";

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
      <Heart size={16} fill="currentColor" />
      <span>
        Created with love by RedBlink ·{" "}
        <a href={COMMUNITY_CONTRIBUTORS_URL} target="_blank" rel="noreferrer">Community Contributors</a>
      </span>
    </footer>
  );
}

function LazyTabBoundary({ children, label = "Loading Section" }: { children: React.ReactNode; label?: string }) {
  return <Suspense fallback={<section className="panel loading-panel tab-loading-panel"><span className="spinner" aria-hidden="true" /><strong className="loading-dots">{label}</strong></section>}>
    {children}
  </Suspense>;
}

export function App() {
  const [auth, setAuth] = useState(false);
  const [password, setPassword] = useState("");
  const [tab, setTab] = useState<Tab>("Home");
  const [pinnedAddons, setPinnedAddons] = useState<PinnedAddon[]>(() => loadPinnedAddons());
  const [selectedPinnedAddonId, setSelectedPinnedAddonId] = useState("");
  const [addonCount, setAddonCount] = useState(0);
  const [onlinePlayerCount, setOnlinePlayerCount] = useState(0);
  const [status, setStatus] = useState("");
  const [readiness, setReadiness] = useState("");
  const [ports, setPorts] = useState("");
  const [doctor, setDoctor] = useState("");
  const [services, setServices] = useState("");
  const [selectedLogService, setSelectedLogService] = useState("gateway");
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

  useEffect(() => {
    savePinnedAddons(pinnedAddons);
  }, [pinnedAddons]);

  useEffect(() => {
    api<{ authenticated: boolean; csrfToken: string | null }>("/api/auth/state").then((state) => {
      setAuth(state.authenticated);
      setCsrfToken(state.csrfToken);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    persistFuncomTokenResult(funcomTokenResult);
  }, [funcomTokenResult]);

  useEffect(() => {
    if (!auth) {
      setSetupState(null);
      setSetupStateLoaded(false);
      setAddonCount(0);
      setOnlinePlayerCount(0);
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
  }, [auth]);

  useEffect(() => {
    if (!auth) return;
    let cancelled = false;
    addonsApi.community()
      .then((result) => {
        if (!cancelled) setAddonCount((result.addons || []).length);
      })
      .catch(() => {
        if (!cancelled) setAddonCount(0);
      });
    return () => { cancelled = true; };
  }, [auth]);

  useEffect(() => {
    if (!auth) return;
    let cancelled = false;
    async function refreshOnlinePlayers() {
      try {
        const result = await playersApi.online();
        if (!cancelled) setOnlinePlayerCount((result.rows || []).length);
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

  function closeConfirmDialog(confirmed: boolean) {
    const request = confirmRequest;
    setConfirmRequest(null);
    request?.resolve(confirmed);
  }

  async function login() {
    const result = await post<{ authenticated: boolean; csrfToken: string }>("/api/auth/login", { password });
    setCsrfToken(result.csrfToken);
    setAuth(result.authenticated);
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

  if (!auth) {
    return (
      <main className="login-screen">
        <form className="login-panel" onSubmit={(event) => { event.preventDefault(); void safe(login); }}>
          <h1>Dune Docker Console</h1>
          <p>Spice Clearance Required</p>
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Admin Password" />
          <button type="submit">Sign In</button>
          {error && <p className="error">{error}</p>}
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

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <button className="sidebar-home-button" type="button" onClick={() => { setRedeploySetupOpen(false); setTab("Home"); }} title="Open Home">
            <h1>Dune Docker Console</h1>
          </button>
          <button className="stack-version-button" title={stackVersionButtonTitle(stackVersionStatus)} aria-label={stackVersionButtonTitle(stackVersionStatus)} onClick={() => { setRedeploySetupOpen(false); setTab("Updates"); }}>{stackVersionButtonLabel(stackVersionStatus)}</button>
        </div>
        <nav className="sidebar-nav">
          {navGroups.map((group) => (
            <section className="sidebar-nav-group" key={group.title} aria-label={group.title}>
              <p className="sidebar-nav-heading">{group.title}</p>
              {group.items.map((item) => (
                <Fragment key={item.tab}>
                  <button className={tab === item.tab && (!selectedPinnedAddonId || item.tab !== "Addons") ? "active" : ""} onClick={() => {
                    setRedeploySetupOpen(false);
                    setSelectedPinnedAddonId("");
                    setTab(item.tab);
                  }}>{item.icon}<span>{item.tab}</span>{item.tab === "Players" && onlinePlayerCount > 0 && <span className="sidebar-nav-count sidebar-nav-count-online">{onlinePlayerCount}</span>}{item.tab === "Addons" && addonCount > 0 && <span className="sidebar-nav-count">{addonCount}</span>}</button>
                  {item.tab === "Addons" && pinnedAddons.length > 0 && <div className="sidebar-addon-children">
                    {pinnedAddons.map((addon) => (
                      <button key={addon.id} className={tab === "Addons" && selectedPinnedAddonId === addon.id ? "active" : ""} onClick={() => {
                        setRedeploySetupOpen(false);
                        setSelectedPinnedAddonId(addon.id);
                        setTab("Addons");
                      }}>{addon.name}</button>
                    ))}
                  </div>}
                </Fragment>
              ))}
              {group.title === "Community" && (
                <a className="sidebar-request-button" href={REDBLINK_DISCORD_URL} target="_blank" rel="noreferrer"><MessageCircle size={18} />Requests</a>
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
            <a className="community-button discord" href={REDBLINK_DISCORD_URL} target="_blank" rel="noreferrer" title="Join Discord"><span>Join Discord</span><DiscordLogo size={19} /></a>
            <a className="community-button support" href={REDBLINK_KOFI_URL} target="_blank" rel="noreferrer" title="Support Project"><span>Support Project</span><KofiLogo size={19} /></a>
          </div>
        </header>
        {error && <div className="error-banner">{error}</div>}
        {redeploySetupOpen && <SetupWizard initialStep={setupJump.step} jumpNonce={setupJump.nonce} mode="redeploy" onSetupComplete={async () => setSetupState(await setupApi.state())} />}
        {!redeploySetupOpen && tab === "Home" && <HomePanel status={status} readiness={readiness} taskResult={homeTaskResult} setTaskResult={setHomeTaskResult} funcomTokenResult={funcomTokenResult} setFuncomTokenResult={setFuncomTokenResult} runningAction={homeRunningAction} restartStartObserved={homeRestartStarted} setRunningAction={setHomeRunningAction} onLoad={loadStackStatus} confirmAction={confirmDialog} />}
        {!redeploySetupOpen && tab === "Server Control" && <ServerPanel setTask={setTask} setStatus={setStatus} status={status} setReadiness={setReadiness} setPorts={setPorts} setDoctor={setDoctor} ports={ports} readiness={readiness} doctor={doctor} taskResult={homeTaskResult} setTaskResult={setHomeTaskResult} funcomTokenResult={funcomTokenResult} setFuncomTokenResult={setFuncomTokenResult} runningAction={homeRunningAction} restartStartObserved={homeRestartStarted} setRunningAction={setHomeRunningAction} onError={setError} confirmAction={confirmDialog} onRedeploy={() => {
          setSetupJump((current) => ({ step: 0, nonce: current.nonce + 1 }));
          setSelectedPinnedAddonId("");
          setRedeploySetupOpen(true);
        }} />}
        {!redeploySetupOpen && tab === "Services" && <LazyTabBoundary label="Loading Services"><ServicesPanel services={services} setServices={setServices} setTask={setTask} openLogs={(service) => { setRedeploySetupOpen(false); setSelectedLogService(service); setTab("Logs"); }} onError={setError} confirmAction={confirmDialog} /></LazyTabBoundary>}
        {!redeploySetupOpen && tab === "Players" && <LazyTabBoundary label="Loading Players"><PlayersPanel onError={setError} renderCharacterAdmin={(props) => <LazyTabBoundary label="Loading Player Details"><CharacterAdminUI {...props} onError={setError} confirmAction={confirmDialog} waitForTask={waitForTaskSilently} formatMutationResult={formatMutationResult} /></LazyTabBoundary>} /></LazyTabBoundary>}
        {!redeploySetupOpen && tab === "Guilds" && <LazyTabBoundary label="Loading Guilds"><GuildsPanel onError={setError} /></LazyTabBoundary>}
        {!redeploySetupOpen && tab === "Landsraad" && <LazyTabBoundary label="Loading Landsraad"><LandsraadPanel onError={setError} confirmAction={confirmDialog} /></LazyTabBoundary>}
        {!redeploySetupOpen && tab === "Admin Tools" && <LazyTabBoundary label="Loading Admin Tools"><AdminToolsPanel onError={setError} confirmAction={confirmDialog} /></LazyTabBoundary>}
        {!redeploySetupOpen && tab === "Live Map" && <LazyTabBoundary label="Loading Live Map"><LiveMapPanel onError={setError} confirmAction={confirmDialog} waitForTask={waitForTaskSilently} taskTechnicalDetails={taskTechnicalDetails} /></LazyTabBoundary>}
        {!redeploySetupOpen && tab === "Maps" && <LazyTabBoundary label="Loading Maps"><MapsPanel onError={setError} confirmAction={confirmDialog} confirmSettingsRestart={confirmSettingsRestart} waitForTaskWithUpdates={waitForTaskWithUpdates} taskTechnicalDetails={taskTechnicalDetails} /></LazyTabBoundary>}
        {!redeploySetupOpen && tab === "Care Package" && <LazyTabBoundary label="Loading Care Package"><CarePackagePanel onError={setError} confirmAction={confirmDialog} /></LazyTabBoundary>}
        {!redeploySetupOpen && tab === "Addons" && <LazyTabBoundary label="Loading Addons"><AddonsPanel pinnedAddons={pinnedAddons} setPinnedAddons={setPinnedAddons} selectedAddonId={selectedPinnedAddonId} clearSelectedAddon={() => setSelectedPinnedAddonId("")} setAddonCount={setAddonCount} confirmAction={confirmDialog} /></LazyTabBoundary>}
        {!redeploySetupOpen && tab === "Database" && <LazyTabBoundary label="Loading Database"><DatabasePanel /></LazyTabBoundary>}
        {!redeploySetupOpen && tab === "Storage" && <LazyTabBoundary label="Loading Storage"><StoragePanel onError={setError} confirmAction={confirmDialog} formatMutationResult={formatMutationResult} /></LazyTabBoundary>}
        {!redeploySetupOpen && tab === "Backups" && <LazyTabBoundary label="Loading Backups"><BackupsPanel
            backupRestoreTask={backupRestoreTask}
            setBackupRestoreTask={setBackupRestoreTask}
            onError={setError}
            confirmAction={confirmDialog}
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
        {!redeploySetupOpen && tab === "Settings" && <LazyTabBoundary label="Loading Settings"><SettingsPanel onPasswordChanged={logoutAfterPasswordChange} /></LazyTabBoundary>}
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
