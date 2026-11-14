import { PermissionGate } from "../../lib/consoleAccess";
import { useEffect } from "react";
import { serverApi } from "../../api/server";
import type { Task } from "../../api/setup";
import { runGatedRestart, serviceRestartTarget, type RestartGate } from "../server/restartQueueGuard";
import { friendlyServiceName } from "../../lib/serviceDisplay";

type ConfirmAction = (message: string, options?: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }) => Promise<boolean>;

type ServicesPanelProps = {
  services: string;
  setServices: (text: string) => void;
  setTask: (task: Task) => void;
  openLogs: (service: string) => void;
  onError: (text: string) => void;
  confirmAction: ConfirmAction;
  restartGate: RestartGate;
};

export function ServicesPanel({ services, setServices, setTask, openLogs, onError, restartGate }: ServicesPanelProps) {
  const rows = parseServiceRows(services);
  async function load() {
    onError("");
    try { setServices((await serverApi.services()).stdout); } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }
  async function restart(service: string) {
    onError("");
    try {
      const gated = await runGatedRestart({ restartGate, label: friendlyServiceName(service), target: serviceRestartTarget(service), dispatch: (opts) => serverApi.restartService(service, opts) });
      if (gated.outcome === "cancelled") return;
      if (gated.outcome === "queued") { onError("Restart queued — see the Restart Queue panel in Admin Tools."); return; }
      if (gated.task) setTask(gated.task);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }
  useEffect(() => {
    load();
  }, []);
  return (
    <section className="panel">
      <div className="panel-title"><h2>Services</h2><button onClick={load}>Refresh Services</button></div>
      {rows.length === 0 ? <div className="empty">{services ? "No services parsed from the current Docker output." : "Services are loading or unavailable."}</div> : <div className="service-table">
        {rows.map((row) => <article className="service-card" key={row.name}>
          <div><strong>{friendlyServiceName(row.name)}</strong><span>{row.status}</span><span>{row.ports}</span></div>
          <div className="service-actions">
            {serviceActionName(row.name, "restart") && <PermissionGate action="server:restart-service"><button onClick={() => restart(serviceActionName(row.name, "restart") || row.name)}>Restart</button></PermissionGate>}
            <PermissionGate action="logs:read"><button onClick={() => openLogs(serviceActionName(row.name, "logs") || row.name)}>Logs</button></PermissionGate>
          </div>
        </article>)}
      </div>}
    </section>
  );
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
    "dune-autoscaler": "autoscaler",
    "dune-coriolis-coordinator": "coriolis"
  };
  const value = normalized[name] || name;
  if (action === "logs") return value;
  return ["text-router", "director", "gateway", "survival", "survival-1", "overmap"].includes(value) ? value : null;
}
