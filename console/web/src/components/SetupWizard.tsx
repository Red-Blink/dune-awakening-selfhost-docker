import { useEffect, useRef, useState } from "react";
import { setupApi, type Check, type Task } from "../api/setup";
import { PreflightCheckCard } from "./PreflightCheckCard";
import { SecretInput } from "./SecretInput";
import { TaskProgress } from "./TaskProgress";

type StepId = "welcome" | "host" | "docker" | "runtime" | "identity" | "token" | "ports" | "review" | "install" | "finish";
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
const regions = ["Europe", "North America", "South America", "Asia", "Oceania", "Africa"];
type SetupConfig = { SERVER_TITLE: string; SERVER_REGION: string; SERVER_IP: string; SERVER_IP_MODE: string; SERVER_PROVIDER: string; STEAM_APP_ID: string };
const terminalStatuses = new Set(["succeeded", "failed", "cancelled"]);
const completionRedirectSeconds = 10;
const deploymentSuccessHoldMs = 3000;
const defaultSetupConfig: SetupConfig = { SERVER_TITLE: "My Dune Server", SERVER_REGION: "Europe", SERVER_IP: "auto", SERVER_IP_MODE: "public", SERVER_PROVIDER: "dune-docker", STEAM_APP_ID: "4754530" };

export function SetupWizard({ initialStep = 0, jumpNonce = 0, mode = "redeploy", onSetupComplete }: { initialStep?: number; jumpNonce?: number; mode?: "first-run" | "redeploy"; onSetupComplete?: () => void }) {
  const steps = mode === "first-run" ? firstRunSteps : redeploySteps;
  const [step, setStep] = useState(initialStep);
  const [maxUnlockedStep, setMaxUnlockedStep] = useState(initialStep);
  const [checks, setChecks] = useState<Check[]>([]);
  const [task, setTask] = useState<Task | null>(null);
  const [redirectCountdown, setRedirectCountdown] = useState<number | null>(null);
  const [token, setToken] = useState("");
  const [existingToken, setExistingToken] = useState(false);
  const [config, setConfig] = useState<SetupConfig>(defaultSetupConfig);
  const onSetupCompleteRef = useRef(onSetupComplete);

  useEffect(() => {
    onSetupCompleteRef.current = onSetupComplete;
  }, [onSetupComplete]);

  useEffect(() => {
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
    setupApi.tasks().then(({ tasks }) => {
      if (cancelled) return;
      const latestInit = tasks.find((item) => item.operation === "init" && !terminalStatuses.has(item.status));
      if (!latestInit) return;
      setTask(latestInit);
      const installStep = stepIndex("install");
      setStep(installStep);
      setMaxUnlockedStep((current) => Math.max(current, installStep));
      if (!terminalStatuses.has(latestInit.status)) void watchInitTask(latestInit.id);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [mode]);

  useEffect(() => {
    if (task?.operation !== "init" || task.status !== "succeeded" || mode !== "first-run") {
      setRedirectCountdown(null);
      return;
    }
    setRedirectCountdown(completionRedirectSeconds);
  }, [mode, task?.id, task?.operation, task?.status]);

  useEffect(() => {
    if (redirectCountdown === null) return;
    if (redirectCountdown <= 0) {
      onSetupCompleteRef.current?.();
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
  const configReady = Boolean(config.SERVER_TITLE.trim() && config.SERVER_REGION && config.SERVER_IP.trim() && config.SERVER_IP_MODE && config.SERVER_PROVIDER.trim() && config.STEAM_APP_ID.trim());
  const checksReady = checks.length > 0 && checks.every((check) => check.status !== "fail");
  const deploymentSucceeded = task?.status === "succeeded";
  const deploymentRunning = Boolean(task && !terminalStatuses.has(task.status));
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
    finish: true
  };
  const activeStep = steps[step]?.id || steps[0].id;
  const activeStepReady = stepReadyById[activeStep];

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
            <li>You will need your Funcom self-host token and a server with enough CPU, memory, disk, and open game ports.</li>
          </ul>
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
            <label>Provider<input value={config.SERVER_PROVIDER} onChange={(event) => setConfig({ ...config, SERVER_PROVIDER: event.target.value })} /></label>
            <label>Steam app ID<input value={config.STEAM_APP_ID} onChange={(event) => setConfig({ ...config, STEAM_APP_ID: event.target.value })} /></label>
          </div>
        </>}
        {activeStep === "token" && <>
          <h2>Funcom Token</h2>
          <p>Paste your Funcom self-host token here. When you continue, the console saves it securely on this server and keeps it out of logs.</p>
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
                <li><strong>UDP 7777-7810</strong> for Dune game server traffic.</li>
                <li><strong>TCP 31982</strong> for RabbitMQ game traffic.</li>
              </ul>
              <p className="muted">This is the port guidance most users need.</p>
            </section>
            <section className="action-section">
              <h4>Admin Panel</h4>
              <p>Dune Docker Console listens on 8088/tcp by default. Do not expose it publicly. Use LAN access, VPN, SSH tunnel, or a protected reverse proxy.</p>
            </section>
            <section className="action-section">
              <h4>Game Map Ports</h4>
              <p>Game UDP ports start at 7777 and increase as maps are started. Overmap commonly uses 7777 and Survival_1 commonly uses 7778. The 7777-7810 range covers normal map growth.</p>
            </section>
            <section className="action-section">
              <h4>Internal Map Traffic</h4>
              <p>IGW/S2S UDP ports start at 7888 for map-to-map traffic inside the console. Do not forward these publicly for a normal single-host Docker setup.</p>
            </section>
            <section className="action-section">
              <h4>Do Not Publicly Expose</h4>
              <p>Keep the web admin, Postgres, Director, TextRouter, RabbitMQ admin, RabbitMQ HTTP, and other internal service ports private.</p>
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
                ["Provider", config.SERVER_PROVIDER],
                ["Steam App ID", config.STEAM_APP_ID]
              ]} />
            </section>
            <section className="action-section">
              <h4>Network / Ports</h4>
              <ReviewGrid items={[
                ["Public Game UDP", "7777-7810/udp"],
                ["Public RabbitMQ Game", "31982/tcp"],
                ["Admin Panel", "8088/tcp private only"],
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
          <p>{mode === "first-run" ? "The server was installed successfully. The full console is ready to open." : "Setup completed successfully. The server has been redeployed and the full console is still available."}</p>
          {mode === "first-run" && <p className="success-note setup-success-countdown">Opening the full console in <strong>{redirectCountdown ?? completionRedirectSeconds}</strong> seconds.</p>}
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

function configFromSetupState(values: Record<string, unknown> | undefined): SetupConfig {
  const next = { ...defaultSetupConfig };
  for (const key of Object.keys(next) as Array<keyof SetupConfig>) {
    const value = values?.[key];
    if (value !== undefined && String(value).trim()) next[key] = String(value);
  }
  return next;
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
