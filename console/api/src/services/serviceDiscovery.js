import { buildDuneArgs, runDune } from "../runner.js";

export async function discoverServices(config) {
  const services = new Set(knownServices());
  if (config.mockMode) return [...services].sort();
  try {
    const result = await runDune(config, buildDuneArgs("services"), { timeoutMs: 8000 });
    for (const name of parseServiceNames(result.stdout)) services.add(name);
  } catch {
    // Fall back to the static allowlist when Docker is not reachable.
  }
  return [...services].sort();
}

export function knownServices() {
  return ["postgres", "rmq-admin", "rmq-game", "text-router", "director", "gateway", "survival-1", "overmap", "orchestrator", "autoscaler", "coriolis", "console"];
}

export function parseServiceNames(text) {
  const names = [];
  const aliases = new Map([
    ["dune-postgres", "postgres"],
    ["dune-rmq-admin", "rmq-admin"],
    ["dune-rmq-game", "rmq-game"],
    ["dune-text-router", "text-router"],
    ["dune-director", "director"],
    ["dune-server-gateway", "gateway"],
    ["dune-server-survival-1", "survival-1"],
    ["dune-server-overmap", "overmap"],
    ["dune-orchestrator", "orchestrator"],
    ["dune-autoscaler", "autoscaler"],
    ["dune-coriolis-coordinator", "coriolis"],
    ["redblink-dune-docker-console", "console"]
  ]);
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^names\s+/i.test(trimmed)) continue;
    const name = trimmed.split(/\s+/)[0];
    if (aliases.has(name)) {
      names.push(aliases.get(name));
    } else if (/^dune-server-[a-z0-9-]+$/i.test(name)) {
      names.push(name);
    }
  }
  return names;
}
