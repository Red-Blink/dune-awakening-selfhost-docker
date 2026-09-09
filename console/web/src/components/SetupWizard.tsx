import { useEffect, useRef, useState } from "react";
import { setupApi, type Check, type Task } from "../api/setup";
import { PreflightCheckCard } from "./PreflightCheckCard";
import { SecretInput } from "./SecretInput";
import { TaskProgress } from "./TaskProgress";
import { RestoreChecklist, buildRestoreRows, imageLoadProgress, installedAssetsSize, type RestoreStepId } from "./RestoreChecklist";
import { getServerPorts, getAdminPort } from "../api/serverPorts";
import { backupsApi } from "../api/backups";
import { serverApi } from "../api/server";
import { updatesApi } from "../api/updates";
import { apiUpload } from "../api/client";

type StepId = "welcome" | "host" | "docker" | "runtime" | "identity" | "token" | "ports" | "review" | "install" | "archive" | "passphrase" | "restore" | "finish";
type SetupPath = "deploy" | "restore";
const firstRunSteps: { id: StepId; label: string }[] = [
  { id: "welcome", label: "Welcome" },
  { id: "host", label: "Host Check" },
  { id: "docker", label: "Docker Setup" },
  { id: "runtime", label: "Runtime Location" },
  { id: "identity", label: "Server Identity" },
  { id: "token", label: "Funcom Token" },
  { id: "ports", label: "Ports" },
  { id: "review", label: "Review" },
  { id: "install", label: "Install" },
  { id: "finish", label: "Finish" }
];
const redeploySteps: { id: StepId; label: string }[] = [
  { id: "identity", label: "Server Identity" },
  { id: "token", label: "Funcom Token" },
  { id: "review", label: "Review" },
  { id: "install", label: "Install" },
  { id: "finish", label: "Finish" }
];
// The restore path shares the informational steps and then diverges: identity,
// token, ports and review all collect things the archive already carries, so
// asking for them would mean typing values the restore overwrites minutes later.
const restoreSteps: { id: StepId; label: string }[] = [
  { id: "welcome", label: "Welcome" },
  { id: "host", label: "Host Check" },
  { id: "docker", label: "Docker Setup" },
  { id: "runtime", label: "Runtime Location" },
  { id: "archive", label: "Backup Archive" },
  { id: "passphrase", label: "Passphrase" },
  { id: "restore", label: "Restore" },
  { id: "finish", label: "Finish" }
];
// Survives a reload so a refresh mid-restore comes back to the wizard rather
// than to whichever screen the console decides to show. Deliberately holds no
// passphrase: that is asked for again if the sequence has not reached apply.
const RESTORE_PROGRESS_KEY = "arrakis.setupRestore";
const restoreOperations = new Set(["updateInstallAssets", "backupSystemRestore"]);
const restoreStageLabels: Record<RestoreStepId, string> = {
  assets: "Installing game files",
  verify: "Checking the archive",
  apply: "Restoring",
  start: "Starting the Battlegroup",
  reload: "Restarting the console"
};

function restoreStageLabel(stage: RestoreStepId) {
  return restoreStageLabels[stage];
}

function stepForOperation(operation: string): RestoreStepId | null {
  return operation === "updateInstallAssets" ? "assets" : null;
}

function storedRestoreStep(stage: string | undefined): RestoreStepId | null {
  return stage && stage in restoreStageLabels ? stage as RestoreStepId : null;
}

function restoreChecklistTitle(step: RestoreStepId | null, done: boolean, failed: boolean) {
  if (done) return "Restore complete";
  if (failed) return "Restore stopped";
  return step ? "Restoring" : "Restore steps";
}
const regions = ["Europe", "North America", "South America", "Asia", "Oceania", "Africa"];
type SetupConfig = { SERVER_TITLE: string; SERVER_REGION: string; SERVER_IP: string; SERVER_IP_MODE: string; HOST_DATACENTER_ID: string; STEAM_APP_ID: string };
const terminalStatuses = new Set(["succeeded", "failed", "cancelled"]);
// The restore ends by restarting the console, which takes the page away, so
// this is the window the operator has to read the result at all.
const completionRedirectSeconds = 15;
const deploymentSuccessHoldMs = 3000;
const defaultSetupConfig: SetupConfig = { SERVER_TITLE: "My Dune Server", SERVER_REGION: "Europe", SERVER_IP: "auto", SERVER_IP_MODE: "public", HOST_DATACENTER_ID: "dune-docker", STEAM_APP_ID: "4754530" };
const datacenterIdPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
export const DATACENTER_ID_GUIDANCE = "Recommended for server-browser ping: enter a hostname whose IPv4 A record points directly to the Server IP. Enter only the hostname—without https://, a port, or a path. Short IDs remain supported, but may not give Funcom a resolvable ping target. A Battlegroup restart applies this change; Funcom may still display ping intermittently.";
export const DIRECT_LISTING_PING_GUIDANCE = "To let DuneDocker.app measure your server directly, allow or forward UDP 32000–32015 to this Docker host through the host firewall and any internet-to-DMZ firewall or router. This is optional: if the range is closed, the public listing automatically uses the ping relay instead.";

export function SetupWizard({ initialStep = 0, jumpNonce = 0, mode = "redeploy", onSetupComplete }: { initialStep?: number; jumpNonce?: number; mode?: "first-run" | "redeploy"; onSetupComplete?: () => void }) {
  const [path, setPath] = useState<SetupPath>("deploy");
  const steps = mode !== "first-run" ? redeploySteps : path === "restore" ? restoreSteps : firstRunSteps;
  // Real, resolved ports for this instance (see api/serverPorts.ts) --
  // never hardcode Instance-1 stock values here, they'll be wrong on
  // any deployment running non-default configured ports.
  const wizardPorts = getServerPorts();
  const adminPort = getAdminPort();
  const [step, setStep] = useState(initialStep);
  const [maxUnlockedStep, setMaxUnlockedStep] = useState(initialStep);
  const [checks, setChecks] = useState<Check[]>([]);
  const [task, setTask] = useState<Task | null>(null);
  const [redirectCountdown, setRedirectCountdown] = useState<number | null>(null);
  const [token, setToken] = useState("");
  const [existingToken, setExistingToken] = useState(false);
  const [config, setConfig] = useState<SetupConfig>(defaultSetupConfig);
  const [archiveName, setArchiveName] = useState("");
  const [archiveError, setArchiveError] = useState("");
  const [uploadPercent, setUploadPercent] = useState(-1);
  const [passphrase, setPassphrase] = useState("");
  const [restoreStep, setRestoreStep] = useState<RestoreStepId | null>(null);
  const [restoreError, setRestoreError] = useState("");
  const [restoreDone, setRestoreDone] = useState(false);
  const [assetsSize, setAssetsSize] = useState("");
  const [startWarning, setStartWarning] = useState("");
  const onSetupCompleteRef = useRef(onSetupComplete);
  // Set once a restore has been resumed, so the step clamp above stops steering.
  const resumedRef = useRef(false);

  useEffect(() => {
    onSetupCompleteRef.current = onSetupComplete;
  }, [onSetupComplete]);

  useEffect(() => {
    // Choosing the restore path changes steps.length, which re-fires this and
    // would otherwise throw away the position a resumed restore just set.
    if (resumedRef.current) {
      setStep((current) => Math.min(current, steps.length - 1));
      return;
    }
    const next = Math.max(0, Math.min(initialStep, steps.length - 1));
    setStep(next);
    setMaxUnlockedStep((current) => Math.max(current, next));
  }, [initialStep, jumpNonce, steps.length]);

  useEffect(() => {
    let cancelled = false;
    setupApi.state().then((state) => {
      if (cancelled) return;
      setExistingToken(Boolean(state.files?.token));
      setConfig(configFromSetupState(state.serverConfig));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { tasks } = await setupApi.tasks();
      if (cancelled) return;
      // A refresh mid-restore must come back here, not to the full console.
      const latestRestore = tasks.find((item) => restoreOperations.has(item.operation) && !terminalStatuses.has(item.status));
      let storedRestore: { archive?: string; stage?: string } | null = null;
      try {
        storedRestore = JSON.parse(window.localStorage.getItem(RESTORE_PROGRESS_KEY) || "null");
      } catch {
        storedRestore = null;
      }
      // The hint lives in the browser, so it outlives the host it describes:
      // a rebuilt server, or one whose archive was deleted, still had it and
      // dropped the operator onto the passphrase step of a restore that could
      // not happen -- past the welcome step where the path is chosen. A running
      // task is proof on its own; a bare hint has to name an archive that is
      // still there.
      if (!latestRestore && storedRestore?.archive && !(await archiveStillExists(storedRestore.archive))) {
        clearRestoreProgress();
        storedRestore = null;
      }
      if (cancelled) return;
      // Only first-run setup has a restore path. A redeploy renders a shorter,
      // different step list, so resuming into restoreSteps there sets a step
      // index past its end: no stepper entry is active and Next is inert, which
      // reads as a broken wizard rather than a stale hint.
      if (mode === "first-run" && (latestRestore || storedRestore?.archive)) {
        resumedRef.current = true;
        setPath("restore");
        if (storedRestore?.archive) setArchiveName(storedRestore.archive);
        const resumeStep = restoreSteps.findIndex((item) => item.id === (latestRestore ? "restore" : "passphrase"));
        if (resumeStep >= 0) {
          setStep(resumeStep);
          setMaxUnlockedStep((current) => Math.max(current, resumeStep));
        }
        if (latestRestore) {
          setTask(latestRestore);
          // Dry run and apply share an operation, so only the stored stage
          // can tell them apart.
          setRestoreStep(stepForOperation(latestRestore.operation) || storedRestoreStep(storedRestore?.stage) || "apply");
          // A rejected poll would otherwise kill this loop silently, leaving the
          // step spinning with no error and no further updates. The sequence's
          // own call is inside a try/catch; this one is not.
          void watchTaskToEnd(latestRestore.id).catch((error) => {
            setRestoreError(error instanceof Error ? error.message : String(error));
          });
        }
        return;
      }
      const latestInit = tasks.find((item) => item.operation === "init" && !terminalStatuses.has(item.status));
      if (!latestInit) return;
      setTask(latestInit);
      const installStep = stepIndex("install");
      setStep(installStep);
      setMaxUnlockedStep((current) => Math.max(current, installStep));
      if (!terminalStatuses.has(latestInit.status)) void watchInitTask(latestInit.id);
    })().catch(() => undefined);
    return () => { cancelled = true; };
  }, [mode]);

  useEffect(() => {
    // The restore starts its own countdown and its final task is not an init,
    // so the branch below would otherwise cancel it.
    if (restoreDone) return;
    if (task?.operation !== "init" || task.status !== "succeeded" || mode !== "first-run") {
      setRedirectCountdown(null);
      return;
    }
    setRedirectCountdown(completionRedirectSeconds);
  }, [mode, restoreDone, task?.id, task?.operation, task?.status]);

  useEffect(() => {
    if (redirectCountdown === null) return;
    if (redirectCountdown <= 0) {
      // A restore restarts the console instead of opening it: the restored
      // .env is only read at startup.
      if (restoreDone) void serverApi.reloadConsole().catch(() => undefined);
      else onSetupCompleteRef.current?.();
      return;
    }
    const id = window.setTimeout(() => setRedirectCountdown((current) => current === null ? null : current - 1), 1000);
    return () => window.clearTimeout(id);
  }, [redirectCountdown]);

  async function runPreflight() {
    const result = await setupApi.preflight();
    setChecks(result.checks);
  }

  async function saveConfig() {
    await setupApi.writeConfig(config);
    if (token) await setupApi.saveToken(token);
  }

  async function init() {
    await saveConfig();
    const result = await setupApi.init();
    setTask(result.task);
    void watchInitTask(result.task.id);
  }

  // The server is the real gate, reading the archive's OpenPGP packet. This
  // only explains the refusal before a possibly large upload rather than after.
  function rejectReasonForArchive(file: File) {
    if (/\.(backup|dump|sql)$/i.test(file.name)) {
      return "That is a Funcom database backup, not a system backup. It restores game data onto a server that already exists, so it cannot set this host up. Look for dune-system-*.tar on the old server's Backups page, under System Backups (Encrypted).";
    }
    if (!/\.(tar|enc)$/i.test(file.name)) {
      return "Expected the .tar downloaded from the old server's System Backups, or its .tar.gz.enc archive.";
    }
    return "";
  }

  async function uploadArchive(file: File) {
    const reason = rejectReasonForArchive(file);
    if (reason) {
      setArchiveError(reason);
      setArchiveName("");
      return;
    }
    setArchiveError("");
    setUploadPercent(0);
    try {
      // Always rename on a name collision: the first-run shell renders no
      // confirm dialog, so there is nothing to ask the operator with.
      const result = await apiUpload(backupsApi.importSystemUrl(file.name, "rename"), file, { onProgress: setUploadPercent });
      if (result.status !== 200) {
        setArchiveError(String(result.body.error || `Upload failed (${result.status}).`));
        setArchiveName("");
        return;
      }
      // The name to restore by is the one the server stored it under, not the
      // one on this machine: import renames anything that does not match the
      // dune-system-*.tar.gz.enc shape every later route validates, and a .tar
      // bundle is unwrapped into that archive.
      const stored = String(result.body.backup || "");
      if (!stored) {
        setArchiveError("The upload succeeded but the server did not name the stored archive.");
        setArchiveName("");
        return;
      }
      setArchiveName(stored);
      persistRestoreProgress(stored, "uploaded");
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : String(error));
      setArchiveName("");
    } finally {
      setUploadPercent(-1);
    }
  }

  // Unreachable listing (no session yet, the API down) returns true: refusing
  // to resume because the check itself failed would be worse than resuming.
  async function archiveStillExists(archive: string) {
    try {
      const { rows } = await backupsApi.listSystem();
      return rows.some((row) => row.name === archive);
    } catch {
      return true;
    }
  }

  function persistRestoreProgress(archive: string, stage: string) {
    try {
      window.localStorage.setItem(RESTORE_PROGRESS_KEY, JSON.stringify({ archive, stage }));
    } catch {
      // A restore still works without a resume hint.
    }
  }

  function clearRestoreProgress() {
    try {
      window.localStorage.removeItem(RESTORE_PROGRESS_KEY);
    } catch {
      // Nothing to clean up if storage is unavailable.
    }
  }

  async function runRestoreTask(stage: RestoreStepId, start: () => Promise<{ task: Task }>) {
    setRestoreStep(stage);
    persistRestoreProgress(archiveName, stage);
    const started = (await start()).task;
    setTask(started);
    const final = await watchTaskToEnd(started.id);
    if (final.status !== "succeeded") {
      throw new Error(final.errorMessage || `${restoreStageLabel(stage)} did not finish.`);
    }
    return final;
  }

  // The dry run is a step rather than an implementation detail: it is what
  // stops a wrong passphrase reaching anything destructive.
  async function runRestoreSequence() {
    setRestoreError("");
    try {
      const assets = await runRestoreTask("assets", () => updatesApi.installAssets());
      setAssetsSize(installedAssetsSize((assets.logLines || []).map((row) => row.line)));
      await runRestoreTask("verify", () => backupsApi.restoreSystem(archiveName, { passphrase, apply: false }));
      await runRestoreTask("apply", () => backupsApi.restoreSystem(archiveName, {
        passphrase,
        apply: true,
        identityMode: "adopt-backup",
        auditLogMode: "adopt-backup"
      }));

      // The restore is already done at this point, so a Battlegroup that will
      // not come up is reported rather than thrown: it is recoverable from Home,
      // and failing the whole restore over it would misdescribe what happened.
      try {
        await runRestoreTask("start", () => serverApi.start());
      } catch (error) {
        setStartWarning(error instanceof Error ? error.message : String(error));
      }
      setRestoreStep("reload");
      setRestoreDone(true);
      clearRestoreProgress();
      const finishStep = stepIndex("finish");
      setMaxUnlockedStep((value) => Math.max(value, finishStep));
      setStep(finishStep);
      // Deferred to the countdown so the finish screen is readable.
      setRedirectCountdown(completionRedirectSeconds);
    } catch (error) {
      // Keep the failed step: the checklist row is what says where it stopped.
      setRestoreError(error instanceof Error ? error.message : String(error));
    }
  }

  async function watchTaskToEnd(taskId: string) {
    let current = (await setupApi.task(taskId)).task;
    setTask(current);
    while (!terminalStatuses.has(current.status)) {
      await new Promise((resolve) => window.setTimeout(resolve, 2500));
      current = (await setupApi.task(current.id)).task;
      setTask(current);
    }
    return current;
  }

  async function watchInitTask(taskId: string) {
    let current = (await setupApi.task(taskId)).task;
    setTask(current);
    while (!["succeeded", "failed", "cancelled"].includes(current.status)) {
      await new Promise((resolve) => window.setTimeout(resolve, 2500));
      current = (await setupApi.task(current.id)).task;
      setTask(current);
    }
    if (current.status === "succeeded") {
      await new Promise((resolve) => window.setTimeout(resolve, deploymentSuccessHoldMs));
      const finishStep = stepIndex("finish");
      setMaxUnlockedStep((value) => Math.max(value, finishStep));
      setStep(finishStep);
    }
  }

  const hasToken = Boolean(token.trim() || existingToken);
  const datacenterIdValid = validDatacenterId(config.HOST_DATACENTER_ID);
  const configReady = Boolean(config.SERVER_TITLE.trim() && config.SERVER_REGION && config.SERVER_IP.trim() && config.SERVER_IP_MODE && datacenterIdValid && config.STEAM_APP_ID.trim());
  const checksReady = checks.length > 0 && checks.every((check) => check.status !== "fail");
  const deploymentSucceeded = task?.status === "succeeded";
  const deploymentRunning = Boolean(task && !terminalStatuses.has(task.status));
  // Mirrors the route's own rule, so a passphrase that cannot work never
  // starts a multi-gigabyte install.
  const passphraseReady = passphrase.length >= 12 && new Set(passphrase).size >= 5;
  const taskLogLines = (task?.logLines || []).map((row) => row.line);
  const stepReadyById: Record<StepId, boolean> = {
    welcome: true,
    host: checksReady,
    docker: true,
    runtime: true,
    identity: configReady,
    token: hasToken,
    ports: true,
    review: configReady && hasToken,
    install: deploymentSucceeded,
    archive: Boolean(archiveName),
    passphrase: passphraseReady,
    restore: restoreDone,
    finish: true
  };
  const activeStep = steps[step]?.id || steps[0].id;
  const activeStepReady = stepReadyById[activeStep];

  // The two paths are different step lists, so progress through one says
  // nothing about the other: without re-locking, walking the restore path and
  // then switching unlocked a deploy step that was never satisfied.
  function choosePath(next: SetupPath) {
    if (next !== path) setMaxUnlockedStep(step);
    setPath(next);
    // Choosing to deploy is the operator saying what they want; the stored
    // restore hint must not drag them back here after a reload.
    if (next === "deploy") clearRestoreProgress();
  }

  function stepIndex(id: StepId) {
    return Math.max(0, steps.findIndex((item) => item.id === id));
  }

  function nextStep() {
    if (!activeStepReady || step >= steps.length - 1) return;
    const next = step + 1;
    setMaxUnlockedStep((current) => Math.max(current, next));
    setStep(next);
  }

  return (
    <section className="wizard">
      <div className="stepper">
        {steps.map((item, index) => <button key={item.id} className={index === step ? "active" : ""} disabled={index > maxUnlockedStep} onClick={() => setStep(index)}>{index + 1}. {item.label}</button>)}
      </div>
      <div className="panel">
        {activeStep === "welcome" && <>
          <h2>Welcome to Dune Docker Console</h2>
          <p>Run and manage your Dune: Awakening self-hosted Docker server from a browser. The console guides the first setup, then gives you the tools to manage maps, players, updates, backups, and admin work in one place.</p>
          <ul className="requirements">
            <li>Best experience: run it directly on a Linux server.</li>
            <li>Also possible: Docker Desktop on Windows/WSL2 or a virtual machine.</li>
            <li>You will need your <a href="https://account.duneawakening.com/" target="_blank" rel="noreferrer noopener">Funcom self-host token</a> and a server with enough CPU, memory, disk, and open game ports.</li>
          </ul>
          {mode === "first-run" && <div className="setup-path-choice">
            <h4>What should this host do?</h4>
            <div className="setup-path-options">
              <button type="button" className={`setup-path-option${path === "deploy" ? " selected" : ""}`} aria-pressed={path === "deploy"} onClick={() => choosePath("deploy")}>
                <strong>Deploy a new server</strong>
                <span>Creates a fresh world and a new Battlegroup identity.</span>
              </button>
              <button type="button" className={`setup-path-option${path === "restore" ? " selected" : ""}`} aria-pressed={path === "restore"} onClick={() => choosePath("restore")}>
                <strong>Restore a Dune Docker system backup</strong>
                <span>Moves an existing server here with its configuration, secrets and database. Encrypted archive named dune-system-*.tar.</span>
              </button>
            </div>
          </div>}
        </>}
        {activeStep === "archive" && <>
          <h2>Backup Archive</h2>
          <p className="muted">The encrypted archive this console produced on the old server, downloaded from its Backups page.</p>
          <p className="danger-note">A Funcom database backup (.backup) is a different thing and cannot be restored here: it holds the game database only, with no configuration and no credentials. Import one from Backups after setup finishes.</p>
          <input type="file" accept=".tar,.enc,.gz" aria-label="System backup archive" disabled={uploadPercent >= 0} onChange={(event) => {
            const file = event.target.files?.[0];
            // Clear the input, or picking the same file again after a rejection
            // fires no change event at all and the step looks frozen.
            event.target.value = "";
            if (file) void uploadArchive(file);
          }} />
          {uploadPercent >= 0 && <p className="muted">Uploading... {uploadPercent}%</p>}
          {archiveName && <p>Stored as <code>{archiveName}</code>. Nothing is applied until you confirm.</p>}
          {archiveError && <p className="danger-note">{archiveError}</p>}
        </>}
        {activeStep === "passphrase" && <>
          <h2>Passphrase</h2>
          <p className="muted">The passphrase set when this archive was created. There is no way to open it without that passphrase.</p>
          <SecretInput value={passphrase} onChange={(event) => setPassphrase(event.target.value)} placeholder="Archive passphrase" aria-label="Archive passphrase" />
          {passphrase.length > 0 && !passphraseReady && <p className="danger-note">At least 12 characters and 5 different characters.</p>}
        </>}
        {activeStep === "restore" && <>
          <h2>Restore</h2>
          <p className="muted">Installs the game files this host is missing, checks the passphrase, then replaces this host's configuration, credentials and database with the archive's.</p>
          {!restoreStep && !restoreDone && <button className="update-action" disabled={!archiveName || !passphraseReady} onClick={() => void runRestoreSequence()}>Start Restore</button>}
          {/* Rendered before the run too, so the four tasks and their order are
              known going in rather than revealed one line at a time. */}
          <RestoreChecklist
            title={restoreChecklistTitle(restoreStep, restoreDone, Boolean(restoreError))}
            rows={buildRestoreRows({
              current: restoreStep,
              finished: restoreDone,
              failed: Boolean(restoreError),
              // Counting while it runs, total size once it is done.
              details: { assets: restoreStep === "assets" ? imageLoadProgress(taskLogLines) : assetsSize }
            })}
            note="The archive's admin password replaces this one. You may need to sign in again."
          />
          {restoreError && <p className="danger-note">{restoreError}</p>}
          {task && <TaskProgress task={task} />}
        </>}
        {activeStep === "host" && <>
          <h2>Host Check</h2>
          <p className="muted">Run a quick check before setup starts. Some items are expected to be created later by the wizard, so they will be shown as setup items instead of problems.</p>
          <button onClick={runPreflight}>Run Checks</button>
          {checks.length > 0 && !checksReady && <p className="danger-note">Fix the failed checks before continuing.</p>}
          <div className="check-grid">{checks.map((check) => <PreflightCheckCard key={check.name} check={check} />)}</div>
        </>}
        {activeStep === "docker" && <>
          <h2>Docker Setup</h2>
          <p>The installer takes care of the Docker check before you get here. If anything was missing on a supported Linux server, it was installed and started for you so you can continue in the browser.</p>
        </>}
        {activeStep === "runtime" && <>
          <h2>Runtime Location</h2>
          <p>The backend is using the repository path configured by <code>DUNE_DOCKER_DIR</code> or its working directory.</p>
        </>}
        {activeStep === "identity" && <>
          <h2>Server Identity</h2>
          <div className="setup-form-grid">
            <label>Server Title<input value={config.SERVER_TITLE} onChange={(event) => setConfig({ ...config, SERVER_TITLE: event.target.value })} /></label>
            <label>Region<select value={config.SERVER_REGION} onChange={(event) => setConfig({ ...config, SERVER_REGION: event.target.value })}>{regions.map((region) => <option key={region} value={region}>{region}</option>)}</select></label>
            <label>Install mode<select value={config.SERVER_IP_MODE} onChange={(event) => setConfig({ ...config, SERVER_IP_MODE: event.target.value })}><option value="public">Public</option><option value="local">Local</option></select></label>
            <label>Server IP<input value={config.SERVER_IP} onChange={(event) => setConfig({ ...config, SERVER_IP: event.target.value })} /></label>
            <label>Server Hostname (Datacenter ID)<input placeholder="game.example.com" value={config.HOST_DATACENTER_ID} onChange={(event) => setConfig({ ...config, HOST_DATACENTER_ID: event.target.value })} /></label>
            <label>Steam app ID<input value={config.STEAM_APP_ID} onChange={(event) => setConfig({ ...config, STEAM_APP_ID: event.target.value })} /></label>
          </div>
          <p className="muted">{DATACENTER_ID_GUIDANCE}</p>
          {!datacenterIdValid && <p className="danger-note">Enter a valid hostname or short ID using only letters, numbers, dots, and hyphens.</p>}
        </>}
        {activeStep === "token" && <>
          <h2>Funcom Token</h2>
          <p>Paste your Funcom self-host token here. When you continue, the console saves it securely on this server and keeps it out of logs.</p>
          <p className="muted">Create or copy one at <a href="https://account.duneawakening.com/" target="_blank" rel="noreferrer noopener">account.duneawakening.com</a>.</p>
          {existingToken && !token && <p className="muted">An existing token is already saved. Paste a new one only if you want to replace it.</p>}
          <SecretInput value={token} onChange={(event) => setToken(event.target.value)} placeholder="Paste token" />
          {!hasToken && <p className="theme-note">Paste your Funcom self-host token to continue to deployment.</p>}
        </>}
        {activeStep === "ports" && <>
          <h2>Ports and Firewall</h2>
          <div className="action-sections">
            <section className="action-section success-panel">
              <h4>Public Router Forwarding</h4>
              <p>For a normal public server, forward these ports from your router/firewall to this Docker host:</p>
              <ul className="requirements">
                <li><strong>UDP {wizardPorts.clientBase}-{wizardPorts.clientBase + 33}</strong> for Dune game server traffic.</li>
                <li><strong>TCP {wizardPorts.rmqGame}</strong> for the RabbitMQ Game Messaging Endpoint.</li>
                <li><strong>TCP {wizardPorts.rmqGameHttp}</strong> for the RabbitMQ Game HTTP Endpoint.</li>
              </ul>
              <p className="muted">This is the port guidance most users need.</p>
            </section>
            <section className="action-section">
              <h4>Admin Panel</h4>
              <p>Dune Docker Console listens on {adminPort}/tcp by default. Do not expose it publicly. Use LAN access, VPN, SSH tunnel, or a protected reverse proxy.</p>
            </section>
            <section className="action-section">
              <h4>Game Map Ports</h4>
              <p>Game UDP ports start at {wizardPorts.clientBase} and increase as maps are started. Overmap commonly uses {wizardPorts.clientBase} and Survival_1 commonly uses {wizardPorts.clientBaseSecondary}. The {wizardPorts.clientBase}-{wizardPorts.clientBase + 33} range covers normal map growth.</p>
            </section>
            <section className="action-section">
              <h4>Optional Direct Listing Ping</h4>
              <p>{DIRECT_LISTING_PING_GUIDANCE}</p>
            </section>
            <section className="action-section">
              <h4>Internal Map Traffic</h4>
              <p>IGW/S2S UDP ports start at {wizardPorts.igwBase} for map-to-map traffic inside the console. Do not forward these publicly for a normal single-host Docker setup.</p>
            </section>
            <section className="action-section">
              <h4>Do Not Publicly Expose</h4>
              <p>Keep the web admin, Postgres, Director, TextRouter, RabbitMQ Admin, the local RabbitMQ management mirror, and other internal service ports private.</p>
            </section>
          </div>
        </>}
        {activeStep === "review" && <>
          <h2>Review</h2>
          <div className="action-sections">
            <section className="action-section">
              <h4>Server Identity</h4>
              <ReviewGrid items={[
                ["Title", config.SERVER_TITLE],
                ["Region", config.SERVER_REGION],
                ["Mode", titleCase(config.SERVER_IP_MODE)],
                ["Server IP", config.SERVER_IP],
                ["Server Hostname (Datacenter ID)", config.HOST_DATACENTER_ID],
                ["Steam App ID", config.STEAM_APP_ID]
              ]} />
            </section>
            <section className="action-section">
              <h4>Network / Ports</h4>
              <ReviewGrid items={[
                ["Public Game UDP", `${wizardPorts.clientBase}-${wizardPorts.clientBase + 33}/udp`],
                ["Public RabbitMQ Game", `${wizardPorts.rmqGame}/tcp`],
                ["Public RabbitMQ Game HTTP", `${wizardPorts.rmqGameHttp}/tcp`],
                ["Optional Direct Listing Ping", "32000–32015/udp"],
                ["Admin Panel", `${adminPort}/tcp private only`],
                ["Internal Services", "Do not expose publicly"]
              ]} />
            </section>
            <section className="action-section">
              <h4>Auth / Token</h4>
              <ReviewGrid items={[
                ["Funcom token", token ? "Ready to save" : "Not entered in this session"],
                ["Admin auth", "Enabled unless ADMIN_AUTH_DISABLED is set"],
                ["Secret storage", "Saved privately on this server"]
              ]} />
            </section>
            <section className="action-section warning-panel">
              <h4>Warnings / Missing Values</h4>
              <ul className="requirements">
                {!token && <li>Funcom token was not entered in this wizard session. Existing token file may still be used if present.</li>}
                {config.SERVER_IP === "auto" && <li>Server IP is set to auto. Confirm Home readiness after setup to verify advertised IP.</li>}
                <li>Deployment starts a fresh local world and keeps a backup of existing local setup files when they exist.</li>
              </ul>
            </section>
          </div>
          <details className="technical-details">
            <summary>Advanced review data</summary>
            <pre className="mini-output">{JSON.stringify(config, null, 2)}</pre>
          </details>
        </>}
        {activeStep === "install" && <>
          <h2>{mode === "first-run" ? "Deploy Server" : "Redeploy Server"}</h2>
          <p>{mode === "first-run"
            ? "This starts the Dune Docker deployment. The console will prepare local settings, download required server assets, update the database, and start the game services. First-time deployment can take a while, so keep this page open while the progress updates."
            : "This reapplies your server identity and Funcom token settings, then restarts the deployment flow so the console uses the updated values. Keep this page open while the progress updates."}</p>
          <button disabled={deploymentRunning || deploymentSucceeded} onClick={init}>
            {deploymentSucceeded
              ? mode === "first-run" ? "Deployment Complete" : "Redeploy Complete"
              : deploymentRunning
                ? mode === "first-run" ? "Deploying..." : "Redeploying..."
                : mode === "first-run" ? "Start Deployment" : "Start Redeploy"}
          </button>
          <TaskProgress task={task} />
          {deploymentSucceeded && <p className="success-note">{mode === "first-run" ? "Deployment was successful." : "Redeploy was successful."} Opening the finish step.</p>}
        </>}
        {activeStep === "finish" && <>
          <div className="setup-finish-celebration" aria-hidden="true"><span /><span /><span /><span /><span /></div>
          <h2>Congratulations</h2>
          <p>{restoreDone
            ? "The system backup was restored. This host now carries the archive's configuration, credentials and database."
            : mode === "first-run" ? "The server was installed successfully. The full console is ready to open." : "Setup completed successfully. The server has been redeployed and the full console is still available."}</p>
          {mode === "first-run" && <p className="success-note setup-success-countdown">{restoreDone ? "Restarting the console in " : "Opening the full console in "}<strong>{redirectCountdown ?? completionRedirectSeconds}</strong> seconds.</p>}
          {restoreDone && <p className="muted">The archive's admin password is now this host's, so you may be asked to sign in again.</p>}
          {startWarning && <p className="danger-note">The Battlegroup did not start: {startWarning} Start it from Home once the console is back.</p>}
          <p className="muted">Game services can take several minutes to warm up, and the in-game browser can take a little longer to show the server.</p>
        </>}
        <div className="wizard-controls">
          <button disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
          <button disabled={step === steps.length - 1 || !activeStepReady} onClick={nextStep}>Next</button>
        </div>
      </div>
    </section>
  );
}

export function configFromSetupState(values: Record<string, unknown> | undefined): SetupConfig {
  const next = { ...defaultSetupConfig };
  for (const key of Object.keys(next) as Array<keyof SetupConfig>) {
    const value = values?.[key];
    if (value !== undefined && String(value).trim()) next[key] = String(value);
  }
  if (values?.HOST_DATACENTER_ID === undefined && String(values?.SERVER_PROVIDER || "").trim()) {
    next.HOST_DATACENTER_ID = String(values?.SERVER_PROVIDER);
  }
  return next;
}

export function validDatacenterId(value: string) {
  return value.length <= 253 && datacenterIdPattern.test(value);
}

function ReviewGrid({ items }: { items: [string, string][] }) {
  return <div className="key-value-grid">{items.map(([label, value]) => <div className="key-value-item" key={label}>
    <span>{label}</span>
    <strong>{value || "Not set"}</strong>
  </div>)}</div>;
}

function titleCase(value: string) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}
