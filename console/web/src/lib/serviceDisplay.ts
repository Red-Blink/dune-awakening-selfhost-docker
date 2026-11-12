const SERVICE_LABELS: Record<string, string> = {
  postgres: "Postgres",
  "rmq-admin": "RabbitMQ Admin",
  "rmq-game": "RabbitMQ Game",
  "text-router": "Text Router",
  director: "Dune Director",
  gateway: "Gateway",
  survival: "Survival",
  "survival-1": "Survival 1",
  overmap: "Overmap",
  orchestrator: "Orchestrator",
  autoscaler: "Autoscaler",
  coriolis: "Coriolis Coordinator",
  console: "Console",
  "redblink-dune-docker-console": "Console",
  "dune-postgres": "Postgres",
  "dune-rmq-admin": "RabbitMQ Admin",
  "dune-rmq-game": "RabbitMQ Game",
  "dune-text-router": "Text Router",
  "dune-director": "Dune Director",
  "dune-server-gateway": "Gateway",
  "dune-server-survival-1": "Survival 1",
  "dune-server-overmap": "Overmap",
  "dune-orchestrator": "Orchestrator",
  "dune-autoscaler": "Autoscaler",
  "dune-coriolis-coordinator": "Coriolis Coordinator"
};

export function friendlyServiceName(name: string) {
  if (/^dune-server-[a-z0-9-]+$/i.test(name)) return friendlyDynamicServerName(name);
  return SERVICE_LABELS[name] || SERVICE_LABELS[name.replace(/^dune-/, "")] || name.replace(/^dune-server-/, "").replace(/^dune-/, "").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function friendlyDynamicServerName(name: string) {
  const value = name.replace(/^dune-server-/i, "").replaceAll("-", " ");
  return value.replace(/\b(sh|pve|pvp|s2s)\b/gi, (part) => part.toUpperCase()).replace(/\b\w/g, (letter) => letter.toUpperCase());
}
