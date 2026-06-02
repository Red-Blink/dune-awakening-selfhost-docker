import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Activity, Archive, Database, FileText, Gift, Home, Map, PackagePlus, Play, RefreshCw, Server, Settings, Shield, ShoppingCart, Users } from "lucide-react";
import { api, post, setCsrfToken } from "./api/client";
import { serverApi } from "./api/server";
import { playersApi } from "./api/players";
import { logsApi } from "./api/logs";
import { backupsApi } from "./api/backups";
import { databaseApi } from "./api/database";
import { mapsApi } from "./api/maps";
import { updatesApi } from "./api/updates";
import { worldDataApi } from "./api/worldData";
import { adminApi } from "./api/admin";
import { marketApi } from "./api/market";
import { starterKitApi, type StarterKitConfig } from "./api/starterKit";
import { setupApi, type Task } from "./api/setup";
import { liveMapApi, type LiveMapMarker } from "./api/liveMap";
import { SetupWizard } from "./components/SetupWizard";
import { TaskProgress } from "./components/TaskProgress";
import { LogViewer } from "./components/LogViewer";
import { BackupRestorePanel } from "./components/BackupRestorePanel";
import { PortChecklist } from "./components/PortChecklist";
import { ReadinessTimeline } from "./components/ReadinessTimeline";
import { ServiceHealthCard } from "./components/ServiceHealthCard";

type Tab = "Home" | "Setup" | "Server Control" | "Services" | "Players" | "Admin Tools" | "Live Map" | "Maps" | "Market" | "Starter Kit" | "Database" | "Storage" | "Bases" | "Blueprints" | "Backups" | "Logs" | "Updates" | "Settings";

const nav: { tab: Tab; icon: React.ReactNode }[] = [
  { tab: "Home", icon: <Home size={18} /> },
  { tab: "Setup", icon: <Shield size={18} /> },
  { tab: "Server Control", icon: <Server size={18} /> },
  { tab: "Services", icon: <Activity size={18} /> },
  { tab: "Players", icon: <Users size={18} /> },
  { tab: "Admin Tools", icon: <PackagePlus size={18} /> },
  { tab: "Live Map", icon: <Map size={18} /> },
  { tab: "Maps", icon: <Map size={18} /> },
  { tab: "Market", icon: <ShoppingCart size={18} /> },
  { tab: "Starter Kit", icon: <Gift size={18} /> },
  { tab: "Database", icon: <Database size={18} /> },
  { tab: "Storage", icon: <Archive size={18} /> },
  { tab: "Bases", icon: <Server size={18} /> },
  { tab: "Blueprints", icon: <FileText size={18} /> },
  { tab: "Backups", icon: <Archive size={18} /> },
  { tab: "Logs", icon: <FileText size={18} /> },
  { tab: "Updates", icon: <RefreshCw size={18} /> },
  { tab: "Settings", icon: <Settings size={18} /> }
];

export function App() {
  const [auth, setAuth] = useState(false);
  const [password, setPassword] = useState("");
  const [tab, setTab] = useState<Tab>("Home");
  const [status, setStatus] = useState("");
  const [readiness, setReadiness] = useState("");
  const [ports, setPorts] = useState("");
  const [doctor, setDoctor] = useState("");
  const [services, setServices] = useState("");
  const [selectedLogService, setSelectedLogService] = useState("gateway");
  const [logs, setLogs] = useState("");
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ authenticated: boolean; csrfToken: string | null }>("/api/auth/state").then((state) => {
      setAuth(state.authenticated);
      setCsrfToken(state.csrfToken);
    }).catch(() => undefined);
  }, []);

  async function login() {
    const result = await post<{ authenticated: boolean; csrfToken: string }>("/api/auth/login", { password });
    setCsrfToken(result.csrfToken);
    setAuth(result.authenticated);
  }

  async function safe(action: () => Promise<void>) {
    setError("");
    try { await action(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }

  if (!auth) {
    return (
      <main className="login-screen">
        <section className="login-panel">
          <h1>Arrakis Server Console</h1>
          <p>Sign in with the local admin password from <code>runtime/secrets/admin-web-password.txt</code>.</p>
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Admin password" />
          <button onClick={() => safe(login)}>Sign In</button>
          {error && <p className="error">{error}</p>}
        </section>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <h1>Arrakis Server Console</h1>
        <nav>{nav.map((item) => <button key={item.tab} className={tab === item.tab ? "active" : ""} onClick={() => setTab(item.tab)}>{item.icon}{item.tab}</button>)}</nav>
      </aside>
      <main>
        <header className="topbar">
          <div>
            <strong>{tab}</strong>
            <span>Docker-native control for RedBlink Dune self-hosting</span>
          </div>
          <button onClick={() => safe(async () => setStatus((await serverApi.status()).stdout))}><Activity size={16} /> Refresh</button>
        </header>
        {error && <div className="error-banner">{error}</div>}
        {tab === "Home" && <HomePanel status={status} readiness={readiness} setTask={setTask} onLoad={() => safe(async () => {
          setStatus((await serverApi.status()).stdout);
          setReadiness((await serverApi.readiness()).stdout);
        })} />}
        {tab === "Setup" && <SetupWizard />}
        {tab === "Server Control" && <ServerPanel setTask={setTask} setStatus={setStatus} setReadiness={setReadiness} setPorts={setPorts} setDoctor={setDoctor} ports={ports} readiness={readiness} doctor={doctor} onError={setError} />}
        {tab === "Services" && <ServicesPanel services={services} setServices={setServices} setTask={setTask} openLogs={(service) => { setSelectedLogService(service); setTab("Logs"); }} onError={setError} />}
        {tab === "Players" && <PlayersPanel setTask={setTask} onError={setError} />}
        {tab === "Admin Tools" && <AdminToolsPanel setTask={setTask} onError={setError} />}
        {tab === "Live Map" && <LiveMapPanel onError={setError} />}
        {tab === "Maps" && <MapsPanel setTask={setTask} onError={setError} />}
        {tab === "Market" && <MarketPanel onError={setError} />}
        {tab === "Starter Kit" && <StarterKitPanel onError={setError} />}
        {tab === "Database" && <DatabasePanel setTask={setTask} />}
        {tab === "Storage" && <StoragePanel onError={setError} />}
        {tab === "Bases" && <WorldListPanel title="Bases" load={worldDataApi.bases} exportUrl={(id) => worldDataApi.baseExportUrl(id)} exportLabel="Export Blueprint JSON" blockedText="Base import and delete remain blocked until ownership, position, entity ID remapping, and full object graph deletion rules are verified." onError={setError} />}
        {tab === "Blueprints" && <WorldListPanel title="Blueprints" load={worldDataApi.blueprints} exportUrl={(id) => worldDataApi.blueprintExportUrl(id)} exportLabel="Export Full JSON" blockedText="Blueprint import, clone, and delete remain blocked until offline-player inventory ownership, blueprint item stat wiring, and ID remapping rules are verified." onError={setError} />}
        {tab === "Backups" && <BackupsPanel setTask={setTask} onError={setError} />}
        {tab === "Logs" && <LogsPanel selectedService={selectedLogService} setSelectedService={setSelectedLogService} text={logs} setText={setLogs} onError={setError} />}
        {tab === "Updates" && <UpdatesPanel setTask={setTask} />}
        {tab === "Settings" && <SettingsPanel />}
        <TaskProgress task={task} />
      </main>
    </div>
  );
}

function HomePanel({ status, readiness, setTask, onLoad }: { status: string; readiness: string; setTask: (task: Task) => void; onLoad: () => void }) {
  return (
    <section className="grid">
      <article className="hero-panel">
        <h2>Server Overview</h2>
        <p>Use this dashboard for setup, service health, logs, backups, updates, and player admin actions.</p>
        <div className="action-row">
          <button onClick={onLoad}>Load Status</button>
          <button onClick={async () => setTask((await serverApi.start()).task)}><Play size={16} /> Start</button>
          <button onClick={async () => window.confirm("Stop the Dune server stack?") && setTask((await serverApi.stop()).task)}>Stop</button>
          <button onClick={async () => window.confirm("Restart the Dune server stack?") && setTask((await serverApi.restart()).task)}>Restart</button>
        </div>
      </article>
      <ServiceHealthCard name="Runtime" status={status ? "checked" : "unknown"} />
      <ServiceHealthCard name="Readiness" status={readiness ? "checked" : "unknown"} />
      <pre className="mini-output wide">{status || "Status has not been loaded."}</pre>
    </section>
  );
}

function ServerPanel(props: { setTask: (task: Task) => void; setStatus: (text: string) => void; setReadiness: (text: string) => void; setPorts: (text: string) => void; setDoctor: (text: string) => void; ports: string; readiness: string; doctor: string; onError: (text: string) => void }) {
  const [service, setService] = useState("gateway");
  async function run(action: () => Promise<unknown>) {
    props.onError("");
    try { await action(); } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
  }
  return (
    <section className="panel">
      <h2>Server Controls</h2>
      <div className="action-row">
        <button onClick={() => run(async () => props.setTask((await serverApi.start()).task))}><Play size={16} /> Start</button>
        <button onClick={() => run(async () => { if (window.confirm("Stop the Dune server stack?")) props.setTask((await serverApi.stop()).task); })}>Stop</button>
        <button onClick={() => run(async () => { if (window.confirm("Restart the Dune server stack?")) props.setTask((await serverApi.restart()).task); })}>Restart</button>
        <button onClick={() => run(async () => props.setStatus((await serverApi.services()).stdout))}>Services</button>
        <button onClick={() => run(async () => props.setReadiness((await serverApi.readiness()).stdout))}>Readiness</button>
        <button onClick={() => run(async () => props.setPorts((await serverApi.ports()).stdout))}>Ports</button>
        <button onClick={() => run(async () => props.setDoctor((await serverApi.doctor()).stdout))}>Doctor</button>
      </div>
      <div className="action-row">
        <input value={service} onChange={(event) => setService(event.target.value)} aria-label="Service name" />
        <button onClick={() => run(async () => { if (window.confirm(`Restart ${service}?`)) props.setTask((await serverApi.restartService(service)).task); })}>Restart Service</button>
      </div>
      <ReadinessTimeline text={props.readiness} />
      <PortChecklist text={props.ports} />
      <pre className="mini-output">{props.doctor || "Run Doctor to show diagnostics."}</pre>
    </section>
  );
}

function ServicesPanel({ services, setServices, setTask, openLogs, onError }: { services: string; setServices: (text: string) => void; setTask: (task: Task) => void; openLogs: (service: string) => void; onError: (text: string) => void }) {
  const rows = parseServiceRows(services);
  async function load() {
    onError("");
    try { setServices((await serverApi.services()).stdout); } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }
  async function restart(service: string) {
    onError("");
    try {
      if (window.confirm(`Restart ${service}?`)) setTask((await serverApi.restartService(service)).task);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }
  return (
    <section className="panel">
      <div className="panel-title"><h2>Services</h2><button onClick={load}>Load Services</button></div>
      {rows.length === 0 ? <pre className="mini-output">{services || "Load services to show Docker containers."}</pre> : <div className="service-table">
        {rows.map((row) => <article className="service-card" key={row.name}>
          <div><strong>{row.name}</strong><span>{row.status}</span><span>{row.ports}</span></div>
          <div className="service-actions">
            {serviceActionName(row.name, "restart") && <button onClick={() => restart(serviceActionName(row.name, "restart") || row.name)}>Restart</button>}
            <button onClick={() => openLogs(serviceActionName(row.name, "logs") || row.name)}>Logs</button>
          </div>
        </article>)}
      </div>}
    </section>
  );
}

function AdminToolsPanel({ setTask, onError }: { setTask: (task: Task) => void; onError: (text: string) => void }) {
  const [playerId, setPlayerId] = useState("");
  const [itemName, setItemName] = useState("");
  const [itemId, setItemId] = useState("");
  const [search, setSearch] = useState("");
  const [catalog, setCatalog] = useState("");
  const [xp, setXp] = useState("1000");
  const [message, setMessage] = useState("");
  const [history, setHistory] = useState("");
  async function run(action: () => Promise<unknown>) {
    onError("");
    try { await action(); } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }
  return (
    <section className="panel">
      <h2>Admin Tools</h2>
      <label>Player FLS ID<input value={playerId} onChange={(event) => setPlayerId(event.target.value)} /></label>
      <div className="two-col">
        <label>Item Name<input value={itemName} onChange={(event) => setItemName(event.target.value)} placeholder="Ornithopter part" /></label>
        <button onClick={() => run(async () => window.confirm(`Give 1 x ${itemName} to ${playerId}?`) && setTask((await playersApi.giveItem(playerId, { itemName, quantity: 1, durability: 1 })).task))}>Give Item</button>
        <label>Raw Item ID<input value={itemId} onChange={(event) => setItemId(event.target.value)} placeholder="ItemTemplate_5" /></label>
        <button onClick={() => run(async () => window.confirm(`Give item id ${itemId} to ${playerId}?`) && setTask((await playersApi.giveItemId(playerId, { itemId, quantity: 1, durability: 1 })).task))}>Give Item by ID</button>
        <label>XP Amount<input value={xp} onChange={(event) => setXp(event.target.value)} /></label>
        <button onClick={() => run(async () => window.confirm(`Add ${xp} XP to ${playerId}?`) && setTask((await playersApi.addXp(playerId, Number(xp))).task))}>Add XP</button>
        <button onClick={() => run(async () => window.confirm(`Refill water for ${playerId}?`) && setTask((await playersApi.refillWater(playerId)).task))}>Refill Water</button>
        <button onClick={() => run(async () => window.confirm(`Give Scout Ornithopter Mk6 parts to ${playerId}?`) && setTask((await playersApi.giveTemplate(playerId)).task))}>Give Multiple Items</button>
        <button className="danger" onClick={() => run(async () => window.confirm(`Kick ${playerId} from the server?`) && setTask((await playersApi.kick(playerId)).task))}>Kick Player</button>
      </div>
      <h3>Catalogs</h3>
      <div className="action-row">
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search items, vehicles, or skill modules" />
        <button onClick={() => run(async () => setCatalog((await adminApi.itemSearch(search)).stdout))}>Item Search</button>
        <button onClick={() => run(async () => setCatalog((await adminApi.itemList()).stdout))}>Item List</button>
        <button onClick={() => run(async () => setCatalog((await adminApi.vehicles(search)).stdout))}>Vehicle List</button>
        <button onClick={() => run(async () => setCatalog((await adminApi.skillModules(search)).stdout))}>Skill Module List</button>
      </div>
      <pre className="mini-output">{catalog || "Use the catalog tools to find item names, raw item IDs, vehicles, and skill modules."}</pre>
      <h3>Global Live Tools</h3>
      <div className="action-row">
        <button className="danger" onClick={() => run(async () => window.confirm("Kick every online player? This publishes PlayerId='*'.") && setTask((await adminApi.kickAllOnline("KICK ALL ONLINE PLAYERS")).task))}>Kick All Online Players</button>
        <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Broadcast or whisper message" />
        <button onClick={() => run(async () => setCatalog(JSON.stringify(await adminApi.broadcast(message, 30), null, 2)))}>Broadcast</button>
        <button className="danger" onClick={() => run(async () => window.confirm("Send shutdown broadcast?") && setCatalog(JSON.stringify(await adminApi.shutdownBroadcast({ confirmation: "SHUTDOWN BROADCAST", delayMinutes: 15, shutdownType: "Restart" }), null, 2)))}>Shutdown Broadcast</button>
        <button onClick={() => run(async () => setCatalog(JSON.stringify(await adminApi.whisper(playerId, message), null, 2)))}>Whisper</button>
      </div>
      <h3>Command History</h3>
      <button onClick={() => run(async () => setHistory((await adminApi.history()).stdout))}>Load Command History</button>
      <pre className="mini-output">{history || "History comes from runtime/generated/admin-command-history.tsv."}</pre>
    </section>
  );
}

function PlayersPanel({ setTask, onError }: { setTask: (task: Task) => void; onError: (text: string) => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [tab, setTab] = useState("inventory");
  async function load(online = false) {
    onError("");
    try {
      const result = online ? await playersApi.online() : await playersApi.list(q);
      setRows(result.rows || []);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }
  async function open(row: Record<string, unknown>) {
    const id = String(row.actor_id || row.id || "");
    setSelected(row);
    setDetail(await playersApi.profile(id));
  }
  return (
    <section className="panel">
      <div className="panel-title"><h2>Players</h2><div className="action-row"><button onClick={() => load(false)}>Load Players</button><button onClick={() => load(true)}>Online Only</button></div></div>
      <div className="action-row"><input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search character, FLS ID, or actor id" /><button onClick={() => load(false)}>Search</button></div>
      <DataTable rows={rows} columns={["actor_id", "character_name", "account_id", "online_status", "map", "fls_id"]} onRowClick={open} />
      {selected && <section className="drawer">
        <div className="panel-title"><h3>{String(selected.character_name || selected.actor_id)}</h3><button onClick={() => setSelected(null)}>Close</button></div>
        <pre className="mini-output">{JSON.stringify(detail, null, 2)}</pre>
        <div className="action-row">{["inventory", "currency", "factions", "specs", "position", "progression", "events", "stats", "history"].map((name) => <button key={name} className={tab === name ? "active" : ""} onClick={() => setTab(name)}>{name}</button>)}</div>
        <PlayerDetailTab playerId={String(selected.actor_id)} tab={tab} onError={onError} />
        <PlayerActions playerId={String(selected.actor_id)} setTask={setTask} onError={onError} onRefresh={() => open(selected)} />
      </section>}
    </section>
  );
}

function PlayerActions({ playerId, setTask, onError, onRefresh }: { playerId: string; setTask: (task: Task) => void; onError: (text: string) => void; onRefresh: () => void }) {
  const [itemName, setItemName] = useState("");
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [multiItems, setMultiItems] = useState("");
  const [xp, setXp] = useState("1000");
  const [points, setPoints] = useState("0");
  const [module, setModule] = useState("");
  const [level, setLevel] = useState("1");
  const [coords, setCoords] = useState({ x: "", y: "", z: "", yaw: "0" });
  const [vehicleId, setVehicleId] = useState("");
  const [vehicleTemplate, setVehicleTemplate] = useState("");
  const [currency, setCurrency] = useState({ currencyId: "0", amount: "1" });
  const [faction, setFaction] = useState({ factionId: "1", amount: "1" });
  const [refuelVehicleId, setRefuelVehicleId] = useState("");
  const [result, setResult] = useState("");
  async function run(action: () => Promise<unknown>) {
    onError("");
    setResult("");
    try { await action(); } catch (error) { const text = error instanceof Error ? error.message : String(error); setResult(text); onError(text); }
  }
  async function runTask(action: () => Promise<{ task: Task }>) {
    const response = await action();
    const final = await waitForTask(response.task, setTask);
    if (final.status === "succeeded") onRefresh();
    else throw new Error(final.errorMessage || final.progressMessage || `Task ${final.status}`);
  }
  async function runDirect(action: () => Promise<unknown>) {
    const response = await action();
    setResult(JSON.stringify(response, null, 2));
    onRefresh();
  }
  function parsedMultiItems() {
    return multiItems.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const [nameOrId, qty = "1", durability = "1"] = line.split(",").map((part) => part.trim());
      const item = /^[A-Za-z0-9_./:-]{16,}$/.test(nameOrId) ? { itemId: nameOrId } : { itemName: nameOrId };
      return { ...item, quantity: Number(qty), durability: Number(durability) };
    });
  }
  return <section className="action-panel">
    <h3>Player Actions</h3>
    {result && <p className="danger-note">{result}</p>}
    <div className="actions-grid">
      <label>Item Name<input value={itemName} onChange={(event) => setItemName(event.target.value)} /></label>
      <label>Quantity<input value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
      <button onClick={() => run(async () => { if (window.confirm(`Give ${quantity} x ${itemName} to player ${playerId}?`)) await runTask(() => playersApi.giveItem(playerId, { itemName, quantity: Number(quantity), durability: 1 })); })}>Give Item</button>
      <label>Raw Item ID<input value={itemId} onChange={(event) => setItemId(event.target.value)} /></label>
      <button onClick={() => run(async () => { if (window.confirm(`Give raw item id ${itemId} to player ${playerId}?`)) await runTask(() => playersApi.giveItemId(playerId, { itemId, quantity: Number(quantity), durability: 1 })); })}>Give Item by ID</button>
      <textarea value={multiItems} onChange={(event) => setMultiItems(event.target.value)} placeholder="One item per line: name or raw id, quantity, durability" rows={4} />
      <button onClick={() => run(async () => { const items = parsedMultiItems(); if (window.confirm(`Give ${items.length} item entries to player ${playerId}?`)) await runDirect(() => playersApi.giveItems(playerId, items)); })}>Give Multiple Items</button>
      <label>XP Amount<input value={xp} onChange={(event) => setXp(event.target.value)} /></label>
      <button onClick={() => run(async () => { if (window.confirm(`Add ${xp} XP to player ${playerId}?`)) await runTask(() => playersApi.addXp(playerId, Number(xp))); })}>Add XP</button>
      <label>Skill Points<input value={points} onChange={(event) => setPoints(event.target.value)} /></label>
      <button onClick={() => run(async () => { if (window.confirm(`Set player ${playerId} to ${points} unspent skill points?`)) await runTask(() => playersApi.setSkillPoints(playerId, Number(points))); })}>Set Skill Points</button>
      <label>Skill Module<input value={module} onChange={(event) => setModule(event.target.value)} /></label>
      <label>Level<input value={level} onChange={(event) => setLevel(event.target.value)} /></label>
      <button onClick={() => run(async () => { if (window.confirm(`Set ${module} to level ${level} for player ${playerId}?`)) await runTask(() => playersApi.setSkillModule(playerId, { module, level: Number(level) })); })}>Set Skill Module</button>
      <button onClick={() => run(async () => { if (window.confirm(`Refill water for player ${playerId}?`)) await runTask(() => playersApi.refillWater(playerId)); })}>Refill Water</button>
      <label>X<input value={coords.x} onChange={(event) => setCoords({ ...coords, x: event.target.value })} /></label>
      <label>Y<input value={coords.y} onChange={(event) => setCoords({ ...coords, y: event.target.value })} /></label>
      <label>Z<input value={coords.z} onChange={(event) => setCoords({ ...coords, z: event.target.value })} /></label>
      <label>Yaw<input value={coords.yaw} onChange={(event) => setCoords({ ...coords, yaw: event.target.value })} /></label>
      <button onClick={() => run(async () => { if (window.confirm(`Teleport player ${playerId} to X=${coords.x} Y=${coords.y} Z=${coords.z}?`)) await runTask(() => playersApi.teleport(playerId, { x: Number(coords.x), y: Number(coords.y), z: Number(coords.z), yaw: Number(coords.yaw) })); })}>Teleport</button>
      <label>Vehicle ID<input value={vehicleId} onChange={(event) => setVehicleId(event.target.value)} /></label>
      <label>Vehicle Template<input value={vehicleTemplate} onChange={(event) => setVehicleTemplate(event.target.value)} /></label>
      <button onClick={() => run(async () => { if (window.confirm(`Spawn ${vehicleId}/${vehicleTemplate} in front of player ${playerId}?`)) await runTask(() => playersApi.spawnVehicle(playerId, { vehicleId, template: vehicleTemplate, offset: 400 })); })}>Spawn Vehicle</button>
      <button className="danger" onClick={() => run(async () => { if (window.confirm(`Kick player ${playerId}?`)) await runTask(() => playersApi.kick(playerId)); })}>Kick Player</button>
      <button className="danger" onClick={() => run(async () => { if (window.confirm(`Clean inventory for player ${playerId}? This removes carried items.`)) await runTask(() => playersApi.cleanInventory(playerId, "CLEAN INVENTORY")); })}>Clean Inventory</button>
      <button className="danger" onClick={() => run(async () => { if (window.confirm(`Reset progression for player ${playerId}?`)) await runTask(() => playersApi.resetProgression(playerId, "RESET PROGRESSION")); })}>Reset Progression</button>
      <label>Currency ID<input value={currency.currencyId} onChange={(event) => setCurrency({ ...currency, currencyId: event.target.value })} /></label>
      <label>Currency Amount<input value={currency.amount} onChange={(event) => setCurrency({ ...currency, amount: event.target.value })} /></label>
      <button onClick={() => run(async () => { if (window.confirm(`Add ${currency.amount} currency ${currency.currencyId || "Solaris"} to player ${playerId}? A backup will be created first.`)) await runDirect(() => playersApi.addCurrency(playerId, { currencyId: Number(currency.currencyId || 0), amount: Number(currency.amount), confirmation: "ADD CURRENCY" })); })}>Add Currency</button>
      <label>Faction ID<input value={faction.factionId} onChange={(event) => setFaction({ ...faction, factionId: event.target.value })} /></label>
      <label>Reputation Amount<input value={faction.amount} onChange={(event) => setFaction({ ...faction, amount: event.target.value })} /></label>
      <button onClick={() => run(async () => { if (window.confirm(`Add ${faction.amount} reputation for faction ${faction.factionId} to player ${playerId}? A backup will be created first.`)) await runDirect(() => playersApi.addFactionReputation(playerId, { factionId: Number(faction.factionId), amount: Number(faction.amount), confirmation: "ADD FACTION REPUTATION" })); })}>Add Faction Reputation</button>
      <button onClick={() => run(async () => { if (window.confirm(`Repair gear for offline player ${playerId}? A backup will be created first.`)) await runDirect(() => playersApi.repairGear(playerId, "REPAIR GEAR")); })}>Repair Gear</button>
      <label>Refuel Vehicle Actor ID<input value={refuelVehicleId} onChange={(event) => setRefuelVehicleId(event.target.value)} /></label>
      <button onClick={() => run(async () => { if (window.confirm(`Refuel vehicle ${refuelVehicleId} owned by player ${playerId}? A backup will be created first.`)) await runDirect(() => playersApi.refuelVehicle(playerId, { vehicleId: refuelVehicleId, confirmation: "REFUEL VEHICLE" })); })}>Refuel Vehicle</button>
    </div>
  </section>;
}

async function waitForTask(task: Task, setTask: (task: Task) => void) {
  let current = task;
  setTask(current);
  for (let i = 0; i < 180 && !["succeeded", "failed", "cancelled"].includes(current.status); i += 1) {
    await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 1000));
    current = (await setupApi.task(current.id)).task;
    setTask(current);
  }
  return current;
}

function PlayerDetailTab({ playerId, tab, onError }: { playerId: string; tab: string; onError: (text: string) => void }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [message, setMessage] = useState("");
  async function loadTab() {
    const loaders: Record<string, () => Promise<Record<string, unknown>>> = {
      inventory: () => playersApi.inventory(playerId),
      currency: () => playersApi.currency(playerId),
      factions: () => playersApi.factions(playerId),
      specs: () => playersApi.specs(playerId),
      position: () => playersApi.position(playerId),
      progression: () => playersApi.progression(playerId),
      events: () => playersApi.events(playerId),
      stats: () => playersApi.stats(playerId),
      history: () => playersApi.history(playerId)
    };
    setData(null);
    setMessage("");
    await loaders[tab]?.().then(setData).catch((error) => onError(error instanceof Error ? error.message : String(error)));
  }
  useEffect(() => {
    loadTab();
  }, [playerId, tab]);
  async function deleteItem(row: Record<string, unknown>) {
    const itemId = String(row.id || "");
    if (!window.confirm(`Delete item ${itemId} (${String(row.template_id || "")}) from player ${playerId}? A database backup will be created first.`)) return;
    try {
      const response = await playersApi.deleteInventoryItem(playerId, itemId, "DELETE ITEM");
      setMessage(JSON.stringify(response, null, 2));
      await loadTab();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessage(text);
      onError(text);
    }
  }
  const rows = Array.isArray(data?.rows) ? data.rows as Record<string, unknown>[] : data?.position ? [data.position as Record<string, unknown>] : [];
  return <div>{data?.reason ? <p className="danger-note">{String(data.reason)}</p> : null}{message && <p className="danger-note">{message}</p>}<DataTable rows={rows} action={tab === "inventory" ? (row) => <button className="danger" onClick={(event) => { event.stopPropagation(); deleteItem(row); }}>Delete Item</button> : undefined} /></div>;
}

function LogsPanel({ selectedService, setSelectedService, text, setText, onError }: { selectedService: string; setSelectedService: (service: string) => void; text: string; setText: Dispatch<SetStateAction<string>>; onError: (text: string) => void }) {
  const [services, setServices] = useState<string[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  useEffect(() => {
    logsApi.services().then((result) => setServices(result.services)).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!streaming) return;
    const source = new EventSource(logsApi.streamUrl(selectedService), { withCredentials: true });
    source.onmessage = (event) => {
      if (paused) return;
      const data = JSON.parse(event.data) as { line: string };
      setText((current) => `${current}${data.line}`);
    };
    source.onerror = () => source.close();
    return () => source.close();
  }, [streaming, paused, selectedService]);
  const shown = filter ? text.split(/\r?\n/).filter((line) => line.toLowerCase().includes(filter.toLowerCase())).join("\n") : text;
  return (
    <section className="panel">
      <h2>Logs</h2>
      <div className="action-row">
        <select value={selectedService} onChange={(event) => setSelectedService(event.target.value)}>
          {services.map((service) => <option key={service} value={service}>{service}</option>)}
        </select>
        <input value={selectedService} onChange={(event) => setSelectedService(event.target.value)} />
        <button onClick={async () => { onError(""); try { setText((await logsApi.get(selectedService)).stdout); } catch (error) { onError(error instanceof Error ? error.message : String(error)); } }}>Load Logs</button>
        <button onClick={() => setStreaming(!streaming)}>{streaming ? "Stop Stream" : "Live Stream"}</button>
        <button onClick={() => setPaused(!paused)}>{paused ? "Resume" : "Pause"}</button>
        <a className="button-link" href={logsApi.downloadUrl(selectedService)}>Download</a>
      </div>
      <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search logs" />
      <LogViewer text={shown} />
    </section>
  );
}

function DatabasePanel({ setTask }: { setTask: (task: Task) => void }) {
  const [schema, setSchema] = useState("dune");
  const [tables, setTables] = useState<Record<string, unknown>[]>([]);
  const [selected, setSelected] = useState("");
  const [preview, setPreview] = useState<{ columns?: { name: string }[]; rows?: Record<string, unknown>[] } | null>(null);
  const [columns, setColumns] = useState<Record<string, unknown>[]>([]);
  const [count, setCount] = useState("");
  const [sql, setSql] = useState("select * from dune.player_state limit 25");
  const [confirmation, setConfirmation] = useState("");
  const [queryResult, setQueryResult] = useState<{ columns?: { name: string }[]; rows?: Record<string, unknown>[] } | null>(null);
  const [search, setSearch] = useState("");
  const [searchRows, setSearchRows] = useState<Record<string, unknown>[]>([]);
  async function loadTables() { setTables(await databaseApi.tables(schema)); }
  async function open(table: string) {
    setSelected(table);
    const [nextPreview, nextColumns, nextCount] = await Promise.all([
      databaseApi.preview(schema, table, 50, 0),
      databaseApi.columns(schema, table),
      databaseApi.count(schema, table)
    ]);
    setPreview(nextPreview);
    setColumns(nextColumns);
    setCount(String(nextCount.count));
  }
  return <section className="panel">
    <h2>Database Browser</h2>
    <div className="action-row"><input value={schema} onChange={(event) => setSchema(event.target.value)} /><button onClick={loadTables}>Load Tables</button><button onClick={async () => setQueryResult(await databaseApi.status() as never)}>Status</button></div>
    <DataTable rows={tables} columns={["schema", "name", "estimated_rows"]} onRowClick={(row) => open(String(row.name))} />
    <h3>{selected ? `${schema}.${selected} (${count} rows)` : "Table Preview"}</h3>
    <DataTable rows={columns} />
    <DataTable rows={preview?.rows || []} columns={preview?.columns?.map((column) => column.name)} />
    <h3>Search Columns</h3>
    <div className="action-row"><input value={search} onChange={(event) => setSearch(event.target.value)} /><button onClick={async () => setSearchRows(await databaseApi.search(search))}>Search</button></div>
    <DataTable rows={searchRows} />
    <h3>Advanced SQL Console</h3>
    <textarea value={sql} onChange={(event) => setSql(event.target.value)} rows={5} />
    <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="RUN DESTRUCTIVE SQL for write queries" />
    <div className="action-row"><button onClick={async () => setQueryResult(await databaseApi.query(sql, confirmation))}>Run Query</button><button onClick={async () => setQueryResult(await databaseApi.export(sql))}>Export Query JSON</button><BackupRestorePanel onTask={setTask} /></div>
    <DataTable rows={queryResult?.rows || []} columns={queryResult?.columns?.map((column) => column.name)} />
  </section>;
}

function MarketPanel({ onError }: { onError: (text: string) => void }) {
  const [q, setQ] = useState("");
  const [view, setView] = useState("items");
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);
  const [info, setInfo] = useState<Record<string, unknown> | null>(null);
  const [message, setMessage] = useState("");

  async function run(action: () => Promise<void>) {
    onError("");
    setMessage("");
    try {
      await action();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessage(text);
      onError(text);
    }
  }

  function clearResult(nextView: string) {
    setView(nextView);
    setRows([]);
    setStats(null);
    setInfo(null);
  }

  async function load(nextView = view) {
    clearResult(nextView);

    if (nextView === "items") {
      const result = await marketApi.items(q);
      setRows(result.rows || []);
    } else if (nextView === "listings") {
      const result = await marketApi.listings(q);
      setRows(result.rows || []);
    } else if (nextView === "sales") {
      const result = await marketApi.sales();
      setRows(result.rows || []);
    } else if (nextView === "catalog") {
      const result = await marketApi.catalog(q);
      setRows(result.rows || []);
    } else if (nextView === "categories") {
      const result = await marketApi.categories();
      setRows((result.categories || []).map((category) => ({ category })));
    } else if (nextView === "stats") {
      const result = await marketApi.stats();
      setStats(result.stats || {});
    }
  }

  async function loadCapabilities() {
    clearResult("capabilities");
    setInfo(await marketApi.capabilities());
  }

  async function loadAutomationStatus() {
    clearResult("automation");
    setInfo(await marketApi.automationStatus());
  }

  const title = view === "capabilities"
    ? "Market Capabilities"
    : view === "automation"
      ? "Market Automation Status"
      : `Market ${view.charAt(0).toUpperCase()}${view.slice(1)}`;

  return <section className="panel">
    <div className="panel-title">
      <h2>Market</h2>
      <button onClick={() => run(loadCapabilities)}>Load Capabilities</button>
    </div>

    <div className="action-row">
      <input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Template id, item name, or category" />
      <button className={view === "items" ? "active" : ""} onClick={() => run(() => load("items"))}>Items</button>
      <button className={view === "listings" ? "active" : ""} onClick={() => run(() => load("listings"))}>Listings</button>
      <button className={view === "sales" ? "active" : ""} onClick={() => run(() => load("sales"))}>Sales</button>
      <button className={view === "stats" ? "active" : ""} onClick={() => run(() => load("stats"))}>Stats</button>
      <button className={view === "categories" ? "active" : ""} onClick={() => run(() => load("categories"))}>Categories</button>
      <button className={view === "catalog" ? "active" : ""} onClick={() => run(() => load("catalog"))}>Catalog</button>
    </div>

    <div className="action-row">
      <button className={view === "automation" ? "active" : ""} onClick={() => run(loadAutomationStatus)}>Automation Status</button>
      <button disabled onClick={() => undefined}>Start Automation</button>
      <button disabled onClick={() => undefined}>Stop Automation</button>
      <button disabled onClick={() => undefined}>Run Once</button>
      <button disabled onClick={() => undefined}>Cleanup</button>
    </div>

    {message && <p className="danger-note">{message}</p>}

    <h3>{title}</h3>
    {info && <pre className="mini-output">{JSON.stringify(info, null, 2)}</pre>}
    {stats && <pre className="mini-output">{JSON.stringify(stats, null, 2)}</pre>}
    {!info && !stats && <DataTable rows={rows} />}
  </section>;
}

function StarterKitPanel({ onError }: { onError: (text: string) => void }) {
  const [config, setConfig] = useState<StarterKitConfig>({ enabled: false, version: "starter-kit-v1", items: [], xp: 0, allowRepeatGrants: false });
  const [itemsText, setItemsText] = useState("");
  const [playerId, setPlayerId] = useState("");
  const [grantId, setGrantId] = useState("");
  const [history, setHistory] = useState<Record<string, unknown>[]>([]);
  const [output, setOutput] = useState("");
  async function run(action: () => Promise<void>) {
    onError("");
    setOutput("");
    try { await action(); } catch (error) { const text = error instanceof Error ? error.message : String(error); setOutput(text); onError(text); }
  }
  async function load() {
    const next = await starterKitApi.config();
    setConfig(next);
    setItemsText(next.items.map((item) => `${item.itemId || item.itemName || ""},${item.quantity},${item.durability}`).join("\n"));
    setHistory((await starterKitApi.history()).rows || []);
  }
  function nextConfig(): StarterKitConfig {
    return {
      ...config,
      items: itemsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
        const [nameOrId, qty = "1", durability = "1"] = line.split(",").map((part) => part.trim());
        const item = /^[A-Za-z0-9_./:-]{16,}$/.test(nameOrId) ? { itemId: nameOrId } : { itemName: nameOrId };
        return { ...item, quantity: Number(qty), durability: Number(durability) };
      })
    };
  }
  return <section className="panel">
    <div className="panel-title"><h2>Starter Kit</h2><button onClick={() => run(load)}>Load Starter Kit</button></div>
    <p className="danger-note">Automatic new-player scanning is disabled in this web implementation. Manual grants use existing RedBlink admin CLI commands and require confirmation.</p>
    <div className="two-col">
      <label>Version<input value={config.version} onChange={(event) => setConfig({ ...config, version: event.target.value })} /></label>
      <label>XP<input value={String(config.xp)} onChange={(event) => setConfig({ ...config, xp: Number(event.target.value) })} /></label>
      <label><input type="checkbox" checked={config.allowRepeatGrants} onChange={(event) => setConfig({ ...config, allowRepeatGrants: event.target.checked })} /> Allow repeat manual grants</label>
      <button onClick={() => run(async () => { if (window.confirm("Save Starter Kit config?")) setConfig(await starterKitApi.saveConfig(nextConfig(), "SAVE STARTER KIT")); })}>Save Config</button>
      <button onClick={() => run(async () => { if (window.confirm("Enable Starter Kit config? Manual grants remain confirmation-gated.")) setConfig(await starterKitApi.enable("ENABLE STARTER KIT")); })}>Enable</button>
      <button className="danger" onClick={() => run(async () => { if (window.confirm("Disable Starter Kit?")) setConfig(await starterKitApi.disable("DISABLE STARTER KIT")); })}>Disable</button>
    </div>
    <label>Items<textarea value={itemsText} onChange={(event) => setItemsText(event.target.value)} placeholder="One per line: item name or raw id, quantity, durability" /></label>
    <div className="action-row">
      <input value={playerId} onChange={(event) => setPlayerId(event.target.value)} placeholder="Player FLS ID or actor id" />
      <button onClick={() => run(async () => { if (window.confirm(`Grant Starter Kit to ${playerId}?`)) setOutput(JSON.stringify(await starterKitApi.grant(playerId, "GRANT STARTER KIT"), null, 2)); })}>Grant Starter Kit</button>
      <input value={grantId} onChange={(event) => setGrantId(event.target.value)} placeholder="Failed grant id" />
      <button onClick={() => run(async () => { if (window.confirm(`Retry Starter Kit grant ${grantId}?`)) setOutput(JSON.stringify(await starterKitApi.retry(grantId, "RETRY STARTER KIT"), null, 2)); })}>Retry Failed Grant</button>
      <button onClick={() => run(async () => setHistory((await starterKitApi.history()).rows || []))}>Load History</button>
    </div>
    {output && <pre className="mini-output">{output}</pre>}
    <pre className="mini-output">{JSON.stringify(config, null, 2)}</pre>
    <DataTable rows={history} />
  </section>;
}

function StoragePanel({ onError }: { onError: (text: string) => void }) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [itemName, setItemName] = useState("");
  const [canGiveItem, setCanGiveItem] = useState(false);
  const [storageResult, setStorageResult] = useState("Give Item to Storage creates a DB backup first and runs only when the backend verifies the storage schema.");
  async function load() {
    onError("");
    try {
      const result = await worldDataApi.storage();
      setRows(result.rows || []);
      setCanGiveItem(Boolean(result.capabilities?.storageGiveItem));
      if (!result.capabilities?.storageGiveItem) setStorageResult("Storage give-item is unsupported until this database exposes compatible dune.inventories and dune.items insert columns.");
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }
  async function open(row: Record<string, unknown>) {
    setSelected(row);
    setItems((await worldDataApi.storageItems(String(row.id))).rows || []);
  }
  async function giveStorageItem() {
    if (!selected) return;
    onError("");
    try {
      if (!window.confirm(`Give 1 x ${itemName} to storage ${String(selected.id)}? A database backup will be created first.`)) return;
      const response = await worldDataApi.storageGiveItem(String(selected.id), { itemName, quantity: 1, confirmation: "GIVE ITEM TO STORAGE" });
      setStorageResult(JSON.stringify(response, null, 2));
      setItems((await worldDataApi.storageItems(String(selected.id))).rows || []);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setStorageResult(text);
      onError(text);
    }
  }
  return <section className="panel"><div className="panel-title"><h2>Storage</h2><button onClick={load}>Load Storage</button></div><p className="danger-note">{storageResult}</p><DataTable rows={rows} onRowClick={open} />{selected && <section className="drawer"><h3>Storage {String(selected.id)}</h3><div className="action-row"><a className="button-link" href={worldDataApi.storageExportUrl(String(selected.id))}>Export JSON</a><input value={itemName} onChange={(event) => setItemName(event.target.value)} placeholder="Item name" /><button disabled={!canGiveItem} onClick={giveStorageItem}>Give Item to Storage</button></div><DataTable rows={items} /></section>}</section>;
}

function WorldListPanel({ title, load, exportUrl, exportLabel = "Export", blockedText = "", onError }: { title: string; load: () => Promise<{ rows: Record<string, unknown>[]; reason?: string }>; exportUrl: (id: string) => string; exportLabel?: string; blockedText?: string; onError: (text: string) => void }) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [reason, setReason] = useState("");
  async function refresh() {
    onError("");
    try {
      const result = await load();
      setRows(result.rows || []);
      setReason(result.reason || "");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }
  return <section className="panel"><div className="panel-title"><h2>{title}</h2><button onClick={refresh}>Load {title}</button></div>{reason && <p className="danger-note">{reason}</p>}{blockedText && <p className="danger-note">{blockedText}</p>}<DataTable rows={rows} action={(row) => <a className="button-link" href={exportUrl(String(row.id))}>{exportLabel}</a>} /></section>;
}

function BackupsPanel({ setTask, onError }: { setTask: (task: Task) => void; onError: (text: string) => void }) {
  const [text, setText] = useState("");
  const [backup, setBackup] = useState("");
  async function run(action: () => Promise<void>) {
    onError("");
    try { await action(); } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }
  return (
    <section className="panel">
      <h2>Backups</h2>
      <div className="action-row">
        <button onClick={() => run(async () => setText((await backupsApi.list()).stdout))}>List Backups</button>
        <button onClick={() => run(async () => setTask((await backupsApi.create()).task))}>Create Backup</button>
      </div>
      <label>Backup file name<input value={backup} onChange={(event) => setBackup(event.target.value)} placeholder="dune-db-....backup" /></label>
      <div className="action-row">
        <button className="danger" onClick={() => run(async () => { if (window.confirm(`Restore backup ${backup}? This changes database state.`)) setTask((await backupsApi.restore(backup)).task); })}>Restore Backup</button>
        <button className="danger" onClick={() => run(async () => { if (window.confirm(`Delete backup ${backup}?`)) setTask((await backupsApi.delete(backup)).task); })}>Delete Backup</button>
      </div>
      <pre className="mini-output">{text || "List backups to see available files."}</pre>
    </section>
  );
}

function LiveMapPanel({ onError }: { onError: (text: string) => void }) {
  const [map, setMap] = useState("");
  const [markers, setMarkers] = useState<LiveMapMarker[]>([]);
  const [overlays, setOverlays] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<LiveMapMarker | null>(null);
  const [filters, setFilters] = useState<Record<string, boolean>>({ player: true, vehicle: true, base: true, storage: true, service: true });
  const [autoRefresh, setAutoRefresh] = useState(false);
  async function load() {
    onError("");
    try {
      const result = await liveMapApi.markers(map);
      setMarkers(result.rows || []);
      setOverlays(result.overlays || {});
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }
  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(load, 30000);
    return () => window.clearInterval(id);
  }, [autoRefresh, map]);
  const visible = markers.filter((marker) => filters[String(marker.type)] !== false);
  const plotted = visible.filter((marker) => Number.isFinite(Number(marker.x)) && Number.isFinite(Number(marker.y)));
  const bounds = markerBounds(plotted);
  return <section className="panel">
    <div className="panel-title"><h2>Live Map</h2><div className="action-row"><button onClick={load}>Refresh</button><label><input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} /> Auto-refresh</label></div></div>
    <div className="action-row"><input value={map} onChange={(event) => setMap(event.target.value)} placeholder="Optional map filter, e.g. Survival_1" />{Object.keys(filters).map((key) => <label key={key}><input type="checkbox" checked={filters[key]} onChange={(event) => setFilters({ ...filters, [key]: event.target.checked })} /> {key}</label>)}</div>
    {Object.entries(overlays).filter(([, reason]) => reason).map(([key, reason]) => <p className="danger-note" key={key}>{key}: {reason}</p>)}
    <div style={{ position: "relative", height: 420, border: "1px solid var(--border)", background: "#10151d", overflow: "hidden" }}>
      {plotted.length === 0 && <div className="empty">No plottable markers. Raw marker rows are shown below when available.</div>}
      {plotted.map((marker, index) => {
        const point = markerPoint(marker, bounds);
        return <button key={`${marker.type}-${marker.id}-${index}`} title={`${marker.type}: ${marker.name || marker.id}`} onClick={() => setSelected(marker)} style={{ position: "absolute", left: `${point.x}%`, top: `${point.y}%`, transform: "translate(-50%, -50%)", width: 12, height: 12, borderRadius: "50%", border: "1px solid white", background: markerColor(String(marker.type)), cursor: "pointer" }} />;
      })}
    </div>
    <p className="danger-note">Coordinates use raw Dune world positions from actor transforms. Exact image/world calibration is not verified, so this plot is for relative position and inspection.</p>
    {selected && <section className="drawer"><div className="panel-title"><h3>{String(selected.name || selected.id)}</h3><button onClick={() => setSelected(null)}>Close</button></div><pre className="mini-output">{JSON.stringify(selected, null, 2)}</pre></section>}
    <DataTable rows={visible as Record<string, unknown>[]} />
  </section>;
}

function MapsPanel({ setTask, onError }: { setTask: (task: Task) => void; onError: (text: string) => void }) {
  const [text, setText] = useState("");
  const [map, setMap] = useState("");
  const [mode, setMode] = useState("dynamic");
  const [target, setTarget] = useState("");
  const [memory, setMemory] = useState("8g");
  const [partitionId, setPartitionId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [count, setCount] = useState("1");
  async function run(action: () => Promise<unknown>) {
    onError("");
    try { await action(); } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }
  async function runTask(action: () => Promise<{ task: Task }>) {
    const response = await action();
    setTask(response.task);
  }
  return <section className="panel">
    <h2>Maps & Sietches</h2>
    <div className="action-row">
      <button onClick={() => run(async () => setText((await mapsApi.maps()).stdout))}>Maps</button>
      <button onClick={() => run(async () => setText((await mapsApi.mode(map)).stdout))}>Map Mode</button>
      <button onClick={() => run(async () => setText(JSON.stringify(await mapsApi.status(), null, 2)))}>Map Status</button>
      <button onClick={() => run(async () => setText((await mapsApi.autoscaler()).stdout))}>Autoscaler</button>
      <button onClick={() => run(async () => setText((await mapsApi.memory()).stdout))}>Memory</button>
      <button onClick={() => run(async () => setText((await mapsApi.sietches()).stdout))}>Sietches</button>
      <button onClick={() => run(async () => setText((await mapsApi.deepdesert()).stdout))}>Deep Desert</button>
    </div>
    <div className="two-col">
      <label>Map<input value={map} onChange={(event) => setMap(event.target.value)} placeholder="DeepDesert_1" /></label>
      <label>Mode<select value={mode} onChange={(event) => setMode(event.target.value)}><option value="dynamic">dynamic</option><option value="always-on">always-on</option></select></label>
      <button onClick={() => run(async () => { if (window.confirm(`Set ${map} to ${mode}? This can spawn or affect map services.`)) await runTask(() => mapsApi.setMode({ map, mode, confirmation: "SET MAP MODE" })); })}>Set Map Mode</button>
      <button className="danger" onClick={() => run(async () => { if (window.confirm("Reconcile all always-on maps now?")) await runTask(() => mapsApi.reconcile("RECONCILE MAPS")); })}>Reconcile Maps</button>
      <label>Spawn/Despawn Target<input value={target} onChange={(event) => setTarget(event.target.value)} placeholder="Map name or partition id" /></label>
      <button onClick={() => run(async () => { if (window.confirm(`Spawn ${target}?`)) await runTask(() => mapsApi.spawn(target, "SPAWN MAP")); })}>Spawn</button>
      <button className="danger" onClick={() => run(async () => { if (window.confirm(`Despawn ${target}?`)) await runTask(() => mapsApi.despawn(target, "DESPAWN MAP")); })}>Despawn</button>
      <button onClick={() => run(async () => { if (window.confirm("Start autoscaler?")) await runTask(() => mapsApi.autoscalerAction("start", "AUTOSCALER CHANGE")); })}>Start Autoscaler</button>
      <button className="danger" onClick={() => run(async () => { if (window.confirm("Stop autoscaler?")) await runTask(() => mapsApi.autoscalerAction("stop", "AUTOSCALER CHANGE")); })}>Stop Autoscaler</button>
      <button onClick={() => run(async () => { if (window.confirm("Restart autoscaler?")) await runTask(() => mapsApi.autoscalerAction("restart", "AUTOSCALER CHANGE")); })}>Restart Autoscaler</button>
      <label>Memory<input value={memory} onChange={(event) => setMemory(event.target.value)} placeholder="8g" /></label>
      <button onClick={() => run(async () => { if (window.confirm(`Set memory for ${map || "default"} to ${memory}? Running maps may need restart.`)) await runTask(() => mapsApi.setMemory({ map: map || "default", memory, confirmation: "SET MAP MEMORY" })); })}>Set Memory</button>
      <button className="danger" onClick={() => run(async () => { if (window.confirm(`Remove memory override for ${map || "default"}?`)) await runTask(() => mapsApi.unsetMemory({ map: map || "default", confirmation: "UNSET MAP MEMORY" })); })}>Unset Memory</button>
      <label>Dimension Count<input value={count} onChange={(event) => setCount(event.target.value)} /></label>
      <button onClick={() => run(async () => runTask(() => mapsApi.updateSietches({ action: "set-max", map, count: Number(count) })))}>Set Max Sietches</button>
      <button className="danger" onClick={() => run(async () => { if (window.confirm(`Set active dimensions for ${map} to ${count}? This reconciles services.`)) await runTask(() => mapsApi.updateSietches({ action: "set-active", map, count: Number(count), confirmation: "UPDATE SIETCHES" })); })}>Set Active Sietches</button>
      <label>Partition ID<input value={partitionId} onChange={(event) => setPartitionId(event.target.value)} /></label>
      <label>Display Name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
      <button onClick={() => run(async () => { if (window.confirm(`Update display name for partition ${partitionId}?`)) await runTask(() => mapsApi.updateSietches({ action: "set-display", partitionId, displayName, confirmation: "UPDATE SIETCHES" })); })}>Set Sietch Display</button>
      <label>Password<input value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <button className="danger" onClick={() => run(async () => { if (window.confirm(`Update password for partition ${partitionId}? Running services may need restart.`)) await runTask(() => mapsApi.updateSietches({ action: "set-password", partitionId, password, confirmation: "UPDATE SIETCHES" })); })}>Set Sietch Password</button>
      <button onClick={() => run(async () => runTask(() => mapsApi.updateSietches({ action: "sync" })))}>Sync Sietches</button>
      <button onClick={() => run(async () => runTask(() => mapsApi.updateSietches({ action: "validate" })))}>Validate Sietches</button>
      <button className="danger" onClick={() => run(async () => { if (window.confirm(`Reconcile sietches for ${map}?`)) await runTask(() => mapsApi.updateSietches({ action: "reconcile", map, confirmation: "UPDATE SIETCHES" })); })}>Reconcile Sietches</button>
      <button onClick={() => run(async () => { if (window.confirm("Enable Dual Deep Desert?")) await runTask(() => mapsApi.updateDeepdesert({ action: "enable", confirmation: "UPDATE DEEP DESERT" })); })}>Enable Dual Deep Desert</button>
      <button className="danger" onClick={() => run(async () => { if (window.confirm("Disable Dual Deep Desert?")) await runTask(() => mapsApi.updateDeepdesert({ action: "disable", confirmation: "UPDATE DEEP DESERT" })); })}>Disable Dual Deep Desert</button>
      <button onClick={() => run(async () => runTask(() => mapsApi.updateDeepdesert({ action: "repair", confirmation: "UPDATE DEEP DESERT" })))}>Repair Deep Desert</button>
      <button onClick={() => run(async () => { if (window.confirm("Bootstrap Dual Deep Desert?")) await runTask(() => mapsApi.updateDeepdesert({ action: "bootstrap", confirmation: "UPDATE DEEP DESERT" })); })}>Bootstrap Deep Desert</button>
    </div>
    <p className="danger-note">Map mode, spawn/despawn, autoscaler, active Sietch dimensions, passwords, and Deep Desert changes can affect live services and require backend confirmation.</p>
    <pre className="mini-output">{text || "Load map, autoscaler, memory, Sietch, or Deep Desert state."}</pre>
  </section>;
}

function markerBounds(markers: LiveMapMarker[]) {
  const xs = markers.map((marker) => Number(marker.x)).filter(Number.isFinite);
  const ys = markers.map((marker) => Number(marker.y)).filter(Number.isFinite);
  return {
    minX: xs.length ? Math.min(...xs) : 0,
    maxX: xs.length ? Math.max(...xs) : 1,
    minY: ys.length ? Math.min(...ys) : 0,
    maxY: ys.length ? Math.max(...ys) : 1
  };
}

function markerPoint(marker: LiveMapMarker, bounds: { minX: number; maxX: number; minY: number; maxY: number }) {
  const spanX = Math.max(1, bounds.maxX - bounds.minX);
  const spanY = Math.max(1, bounds.maxY - bounds.minY);
  return {
    x: 5 + ((Number(marker.x) - bounds.minX) / spanX) * 90,
    y: 95 - ((Number(marker.y) - bounds.minY) / spanY) * 90
  };
}

function markerColor(type: string) {
  return { player: "#3b82f6", vehicle: "#22c55e", base: "#f59e0b", storage: "#a855f7", service: "#e5e7eb" }[type] || "#e5e7eb";
}

function UpdatesPanel({ setTask }: { setTask: (task: Task) => void }) {
  return <section className="panel"><h2>Updates</h2><div className="action-row"><button onClick={async () => setTask((await updatesApi.checkGame()).task)}>Check Game Update</button><button onClick={async () => window.confirm("Apply the game server update now?") && setTask((await updatesApi.applyGame()).task)}>Apply Game Update</button><button onClick={async () => setTask((await updatesApi.checkStack()).task)}>Check Stack Update</button><button onClick={async () => window.confirm("Apply the latest RedBlink stack update now?") && setTask((await updatesApi.applyStack()).task)}>Apply Stack Update</button></div></section>;
}

function SettingsPanel() {
  const [text, setText] = useState("");
  return <section className="panel"><h2>Settings</h2><button onClick={async () => setText(JSON.stringify(await api("/api/settings"), null, 2))}>Load Runtime Settings</button><pre className="mini-output">{text}</pre></section>;
}

function OutputPanel({ title, text, action, onAction }: { title: string; text: string; action: string; onAction: () => void }) {
  return <section className="panel"><h2>{title}</h2><button onClick={onAction}>{action}</button><pre className="mini-output">{text}</pre></section>;
}

function DataTable({ rows, columns, onRowClick, action }: { rows: Record<string, unknown>[]; columns?: string[]; onRowClick?: (row: Record<string, unknown>) => void; action?: (row: Record<string, unknown>) => React.ReactNode }) {
  const cols = columns?.length ? columns : Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).slice(0, 8);
  if (!rows.length) return <div className="empty">No rows.</div>;
  return <div className="table-wrap"><table><thead><tr>{cols.map((col) => <th key={col}>{col}</th>)}{action && <th>Actions</th>}</tr></thead><tbody>{rows.map((row, index) => <tr key={index} onClick={() => onRowClick?.(row)} className={onRowClick ? "clickable" : ""}>{cols.map((col) => <td key={col}>{formatCell(row[col])}</td>)}{action && <td>{action(row)}</td>}</tr>)}</tbody></table></div>;
}

function formatCell(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function parseServiceRows(text: string) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).filter((line) => !/^names\s+/i.test(line)).map((line) => {
    const [name, ...rest] = line.split(/\s{2,}|\t/).filter(Boolean);
    return { name, status: rest[0] || "", ports: rest.slice(1).join(" ") };
  }).filter((row) => row.name);
}

function serviceActionName(name: string, action: "logs" | "restart") {
  const normalized: Record<string, string> = {
    "dune-postgres": "postgres",
    "dune-rmq-admin": "rmq-admin",
    "dune-rmq-game": "rmq-game",
    "dune-text-router": "text-router",
    "dune-director": "director",
    "dune-server-gateway": "gateway",
    "dune-server-survival-1": "survival-1",
    "dune-server-overmap": "overmap",
    "dune-orchestrator": "orchestrator",
    "dune-autoscaler": "autoscaler"
  };
  const value = normalized[name] || name;
  if (action === "logs") return value;
  return ["text-router", "director", "gateway", "survival", "survival-1", "overmap"].includes(value) ? value : null;
}
