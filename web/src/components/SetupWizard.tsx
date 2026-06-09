import { useEffect, useState } from "react";
import { setupApi, type Check, type Task } from "../api/setup";
import { PreflightCheckCard } from "./PreflightCheckCard";
import { SecretInput } from "./SecretInput";
import { TaskProgress } from "./TaskProgress";
import { CommandPreview } from "./CommandPreview";

const steps = ["Welcome", "Host Check", "Docker Setup", "Runtime Location", "Server Identity", "Funcom Token", "Ports", "Review", "Install", "Finish"];
const regions = ["Europe", "North America", "South America", "Asia", "Oceania", "Africa"];
type SetupConfig = { SERVER_TITLE: string; SERVER_REGION: string; SERVER_IP: string; SERVER_IP_MODE: string; SERVER_PROVIDER: string; STEAM_APP_ID: string };

export function SetupWizard({ initialStep = 0, jumpNonce = 0 }: { initialStep?: number; jumpNonce?: number }) {
  const [step, setStep] = useState(initialStep);
  const [checks, setChecks] = useState<Check[]>([]);
  const [task, setTask] = useState<Task | null>(null);
  const [token, setToken] = useState("");
  const [config, setConfig] = useState<SetupConfig>({ SERVER_TITLE: "My Dune Server", SERVER_REGION: "Europe", SERVER_IP: "auto", SERVER_IP_MODE: "public", SERVER_PROVIDER: "dune-docker", STEAM_APP_ID: "4754530" });

  useEffect(() => {
    setStep(Math.max(0, Math.min(initialStep, steps.length - 1)));
  }, [initialStep, jumpNonce]);

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
  }

  return (
    <section className="wizard">
      <div className="stepper">
        {steps.map((label, index) => <button key={label} className={index === step ? "active" : ""} onClick={() => setStep(index)}>{index + 1}. {label}</button>)}
      </div>
      <div className="panel">
        {step === 0 && <>
          <h2>Welcome to Arrakis Server Console</h2>
          <p>This browser interface sets up and controls the RedBlink Docker-native Dune: Awakening server stack. It is an unofficial community self-hosting tool.</p>
          <ul className="requirements">
            <li>Linux host with Docker Engine and Compose plugin</li>
            <li>Funcom self-host token</li>
            <li>AVX/AVX2-capable CPU, enough RAM, disk space, and open game ports</li>
          </ul>
        </>}
        {step === 1 && <>
          <h2>Host Check</h2>
          <p className="muted">If this server is already running, some ports may show as in use by the current stack. Treat that as normal unless the check names an unrelated process.</p>
          <button onClick={runPreflight}>Run Checks</button>
          <div className="check-grid">{checks.map((check) => <PreflightCheckCard key={check.name} check={check} />)}</div>
        </>}
        {step === 2 && <>
          <h2>Docker Setup</h2>
          <p>If Docker is missing, install it manually or start the backend with host bootstrap enabled.</p>
          <CommandPreview>sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin</CommandPreview>
        </>}
        {step === 3 && <>
          <h2>Runtime Location</h2>
          <p>The backend is using the repository path configured by <code>DUNE_DOCKER_DIR</code> or its working directory.</p>
        </>}
        {step === 4 && <>
          <h2>Server Identity</h2>
          <div className="setup-form-grid">
            <label>Server title<input value={config.SERVER_TITLE} onChange={(event) => setConfig({ ...config, SERVER_TITLE: event.target.value })} /></label>
            <label>Region<select value={config.SERVER_REGION} onChange={(event) => setConfig({ ...config, SERVER_REGION: event.target.value })}>{regions.map((region) => <option key={region} value={region}>{region}</option>)}</select></label>
            <label>Install mode<select value={config.SERVER_IP_MODE} onChange={(event) => setConfig({ ...config, SERVER_IP_MODE: event.target.value })}><option value="public">Public</option><option value="local">Local</option></select></label>
            <label>Server IP<input value={config.SERVER_IP} onChange={(event) => setConfig({ ...config, SERVER_IP: event.target.value })} /></label>
            <label>Provider<input value={config.SERVER_PROVIDER} onChange={(event) => setConfig({ ...config, SERVER_PROVIDER: event.target.value })} /></label>
            <label>Steam app ID<input value={config.STEAM_APP_ID} onChange={(event) => setConfig({ ...config, STEAM_APP_ID: event.target.value })} /></label>
          </div>
        </>}
        {step === 5 && <>
          <h2>Funcom Token</h2>
          <p>The token is stored at <code>runtime/secrets/funcom-token.txt</code> with restrictive permissions and redacted from logs.</p>
          <SecretInput value={token} onChange={(event) => setToken(event.target.value)} placeholder="Paste token" />
        </>}
        {step === 6 && <>
          <h2>Ports and Firewall</h2>
          <div className="action-sections">
            <section className="action-section">
              <h4>Admin Panel</h4>
              <p>Arrakis Server Console listens on 8088/tcp by default. Keep it local, VPN-only, or protected by a reverse proxy/firewall.</p>
            </section>
            <section className="action-section">
              <h4>Game Client Ports</h4>
              <p>Game client UDP ports start at 7777 and increment sequentially for each game server/map. Overmap commonly uses 7777 and Survival 1 commonly uses 7778.</p>
            </section>
            <section className="action-section">
              <h4>Server-to-Server / IGW Ports</h4>
              <p>IGW/S2S UDP ports start at 7888 and increment sequentially for each game server/map. These ranges must not overlap with game client ports.</p>
            </section>
            <section className="action-section">
              <h4>Internal Services</h4>
              <p>RabbitMQ Game uses 31982/tcp and 31983/tcp. Postgres and other internal ports should not be exposed publicly unless intentionally configured.</p>
            </section>
          </div>
          <p className="danger-note">Additional deployed maps or sietches may require additional sequential game and IGW ports.</p>
        </>}
        {step === 7 && <>
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
                ["Game UDP", "7777, 7778, 7888, 7889"],
                ["RabbitMQ Game", "31982/tcp"],
                ["RabbitMQ Game HTTP", "31983/tcp"],
                ["Web Admin", "8088/tcp"]
              ]} />
            </section>
            <section className="action-section">
              <h4>Auth / Token</h4>
              <ReviewGrid items={[
                ["Funcom token", token ? "Ready to save" : "Not entered in this session"],
                ["Admin auth", "Enabled unless ADMIN_AUTH_DISABLED is set"],
                ["Secret storage", "runtime/secrets with restrictive permissions"]
              ]} />
            </section>
            <section className="action-section warning-panel">
              <h4>Warnings / Missing Values</h4>
              <ul className="requirements">
                {!token && <li>Funcom token was not entered in this wizard session. Existing token file may still be used if present.</li>}
                {config.SERVER_IP === "auto" && <li>Server IP is set to auto. Confirm Home readiness after setup to verify advertised IP.</li>}
                <li>Initial setup can initialize or reset local world state. Create backups before destructive setup work.</li>
              </ul>
            </section>
          </div>
          <details className="technical-details">
            <summary>Advanced review data</summary>
            <pre className="mini-output">{JSON.stringify(config, null, 2)}</pre>
          </details>
          <p className="danger-note">Initial setup can initialize or reset local world state. Review before continuing.</p>
        </>}
        {step === 8 && <>
          <h2>Install / Initialize / Start</h2>
          <button onClick={init}>Run Existing Dune Init</button>
          <TaskProgress task={task} />
        </>}
        {step === 9 && <>
          <h2>Finish</h2>
          <p>Open the dashboard, check readiness, view logs, create a backup, or manage players.</p>
        </>}
        <div className="wizard-controls">
          <button disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
          <button disabled={step === steps.length - 1} onClick={() => setStep(step + 1)}>Next</button>
        </div>
      </div>
    </section>
  );
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
