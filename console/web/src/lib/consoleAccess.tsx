import { useSyncExternalStore, type ReactNode } from "react";

export type ConsoleUser = { username: string; displayName: string; tier: string };
type ConsoleAccess = {
  phase: "loading" | "ready" | "error";
  user: ConsoleUser | null;
  actions: readonly string[];
  can: (action: string) => boolean;
  any: (actions: readonly string[]) => boolean;
};

function snapshot(phase: ConsoleAccess["phase"], user: ConsoleUser | null, actions: readonly string[]): ConsoleAccess {
  const patterns = [...actions];
  const granted = new Set(patterns);
  // Production responses contain expanded action names. Wildcards also support
  // explicitly scoped callers such as component previews and test fixtures.
  const can = (action: string) => phase === "ready" && (granted.has(action) || granted.has("*") || patterns.some(pattern => pattern.endsWith(":*") && action.startsWith(pattern.slice(0, -1))));
  return { phase, user, actions: patterns, can, any: required => required.some(can) };
}

let current = snapshot("loading", null, []);
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const getSnapshot = () => current;

export function setConsoleAccess(phase: ConsoleAccess["phase"], user: ConsoleUser | null = null, actions: readonly string[] = []) {
  if (phase === current.phase && JSON.stringify(user) === JSON.stringify(current.user) && JSON.stringify(actions) === JSON.stringify(current.actions)) return;
  current = snapshot(phase, user, actions);
  for (const listener of listeners) listener();
}

export function useConsoleAccess(): ConsoleAccess {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function PermissionGate({ action, anyOf, allOf, children }: { action?: string; anyOf?: readonly string[]; allOf?: readonly string[]; children: ReactNode }) {
  const access = useConsoleAccess();
  return (action ? access.can(action) : allOf ? allOf.length > 0 && allOf.every(access.can) : access.any(anyOf || [])) ? <>{children}</> : null;
}

export function PermissionFields({ writeAction, children }: { writeAction: string; children: ReactNode }) {
  const access = useConsoleAccess();
  return <fieldset className="permission-fields" disabled={!access.can(writeAction)}>{children}</fieldset>;
}

export const PAGE_ACTIONS = {
  Home: ["server:read"],
  "Server Control": ["server:start", "server:stop", "server:restart", "server:restart-service", "server:write-config", "server:write-credentials", "server:network-fix"],
  Services: ["server:read"],
  Players: ["players:read"],
  Guilds: ["guilds:read"],
  Bases: ["bases:read", "blueprints:read"],
  Vehicles: ["vehicles:read"],
  Exchange: ["exchange:read"],
  Landsraad: ["landsraad:read"],
  "Admin Tools": ["players:kick-all", "players:give-item", "admin:broadcast", "admin:map-chat", "admin:motd:read", "admin:announcements:read", "admin:transfer-settings:read", "admin:history:read", "server:write-config", "server:write-credentials"],
  "Live Map": ["maps:read"],
  Maps: ["maps:read"],
  "Care Package": ["carepackage:read"],
  Addons: ["addons:read"],
  Language: ["community:suggest-translation", "settings:write"],
  Database: ["database:read"],
  Storage: ["storage:read"],
  Backups: ["backups:read"],
  Logs: ["logs:read"],
  Chat: ["chat:read"],
  Updates: ["updates:read", "updates:check", "updates:self-check"],
  Settings: ["settings:read"],
  "Access Control": ["settings:read"]
} as const;

export function canOpenPage(page: keyof typeof PAGE_ACTIONS, access: ConsoleAccess, discordConfigured = true): boolean {
  return (page !== "Access Control" || discordConfigured) && access.any(PAGE_ACTIONS[page]);
}
