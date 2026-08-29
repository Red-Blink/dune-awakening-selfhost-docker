// API key scopes — the vocabulary a key is granted against.
//
// A key carries one level per namespace ({ "players": "read" }), not a tier or
// a policy document. "read" grants every read-shaped action in the namespace,
// "write" grants all of them, absent grants nothing. Levels are stored rather
// than expanded action lists so a read route added later is covered without
// re-saving every key — which only holds while isReadAction() stays correct,
// hence the catalog sweep in apiKeyScopes.test.js.

import { allKnownActions } from "./policy.js";

// Never reachable, at any level. keyAllows() checks this BEFORE the scope
// lookup, so a hand-edited api-keys.json cannot grant them: `settings` would
// let a key mint further keys, `database` and `setup` sidestep the scope model
// entirely.
export const KEY_DENIED_NAMESPACES = new Set(["settings", "database", "setup"]);

// Offered at None/Read only. `updates` because apply/fix/repair/write-config
// self-update the console. `addons` because POST /api/addons/installed/{id}/bridge
// authorizes against the installed addon's manifest, not the caller — so an
// addon declaring `database: write` would reach arbitrary SQL past the denial
// above (server.js refuses the bridge for key principals too).
//
// Enforced twice: the catalog reports supportsWrite: false, and keyAllows()
// reads a stored "write" here as "read".
export const KEY_WRITE_DENIED_NAMESPACES = new Set(["updates", "addons"]);

// POST-shaped but read-only in effect, so reachable by a "read" grant. Keep
// this tiny: anything unrecognised defaults to "write", which fails closed.
//
//   exchange:market -- GETs plus /buyback/probe, which reads only. Without it
//     `exchange: read` returns almost nothing.
//   updates:check   -- check-game only, and cached. check-stack is a separate
//     write-classified action (see actions.js).
//
// Not carepackage:scan: POST /api/care-package/run runs a real grant cycle.
export const EXTRA_READ_ACTIONS = new Set([
  "exchange:market",
  "updates:check"
]);

export const SCOPE_LEVELS = Object.freeze(["read", "write"]);

// Namespaces the operator sees first. Anything in the catalog but missing
// here still appears, alphabetically, after this list -- a new namespace
// shows up in the UI on its own rather than silently disappearing.
const PREFERRED_ORDER = [
  "players", "bases", "vehicles", "guilds", "storage", "blueprints",
  "exchange", "maps", "sietches", "deepdesert", "landsraad",
  "server", "logs", "backups", "updates", "carepackage", "addons",
  "admin"
];

export function namespaceOf(action) {
  if (typeof action !== "string") return "";
  const index = action.indexOf(":");
  return index > 0 ? action.slice(0, index) : "";
}

export function isReadAction(action) {
  if (typeof action !== "string" || !action) return false;
  if (EXTRA_READ_ACTIONS.has(action)) return true;
  const lastSeparator = action.lastIndexOf(":");
  return lastSeparator > 0 && action.slice(lastSeparator + 1) === "read";
}

// { namespace: { read: [...], write: [...] } } over the whole IAM catalog,
// denied namespaces excluded. Computed once -- the catalog is static for the
// life of the process.
let _byNamespace = null;

export function actionsByNamespace() {
  if (_byNamespace) return _byNamespace;
  const grouped = new Map();
  for (const action of allKnownActions()) {
    const namespace = namespaceOf(action);
    if (!namespace || KEY_DENIED_NAMESPACES.has(namespace)) continue;
    const bucket = isReadAction(action) ? "read" : "write";
    // A write-denied namespace's write actions are not part of what a key can
    // be granted, so they are absent from the catalog rather than listed and
    // unselectable.
    if (bucket === "write" && KEY_WRITE_DENIED_NAMESPACES.has(namespace)) continue;
    if (!grouped.has(namespace)) grouped.set(namespace, { read: [], write: [] });
    grouped.get(namespace)[bucket].push(action);
  }
  for (const entry of grouped.values()) {
    entry.read.sort();
    entry.write.sort();
  }
  _byNamespace = grouped;
  return _byNamespace;
}

export function selectableNamespaces() {
  const present = actionsByNamespace();
  const preferred = PREFERRED_ORDER.filter((namespace) => present.has(namespace));
  const remainder = [...present.keys()].filter((namespace) => !PREFERRED_ORDER.includes(namespace)).sort();
  return [...preferred, ...remainder];
}

// False for `logs`, which has logs:read and nothing else, and for `updates`,
// whose write actions are denied above. The UI renders a two-segment control
// (None / Read) for such a namespace rather than a third option that would
// change nothing. Driven off the catalog, so a future logs:purge route makes
// the third segment appear without a UI edit.
export function namespaceHasWriteActions(namespace) {
  const entry = actionsByNamespace().get(namespace);
  return Boolean(entry && entry.write.length);
}

// The catalog the Settings UI renders its scope grid from.
export function scopeCatalog() {
  const byNamespace = actionsByNamespace();
  return selectableNamespaces().map((namespace) => {
    const entry = byNamespace.get(namespace);
    return {
      namespace,
      readActions: entry.read,
      writeActions: entry.write,
      supportsWrite: entry.write.length > 0
    };
  });
}

// Every namespace defaults to None. This drops -- never coerces -- anything
// it does not recognise: an unknown namespace, a denied namespace, and a
// misspelled level ("readonly") all become None rather than falling back to
// read. There is no default level and no merge with a previous value; the
// caller passes the complete desired map, so removing a namespace revokes it.
// Every action a namespace can be granted, read and write buckets together.
// Write-denied namespaces contribute no write actions, because
// actionsByNamespace() already omits them from the catalog -- so membership in
// this set is the only check an explicit action list needs.
export function grantableActions(namespace) {
  const entry = actionsByNamespace().get(namespace);
  if (!entry) return [];
  return [...entry.read, ...entry.write];
}

export function normalizeScopes(input) {
  const scopes = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return scopes;
  const allowed = new Set(selectableNamespaces());
  for (const [namespace, value] of Object.entries(input)) {
    if (!allowed.has(namespace)) continue;

    // An explicit action list -- the precise form. `players: "write"` hands
    // over all twelve player actions at once, which is what the splits exist to
    // avoid; a list can grant exactly players:read and players:moderate.
    //
    // The trade: a level auto-covers actions added in a later release (see the
    // file header), a list does not. A list therefore needs revisiting when the
    // catalog grows, and levels stay the right default for broad, trusted keys.
    if (Array.isArray(value)) {
      const grantable = new Set(grantableActions(namespace));
      const actions = [...new Set(value.filter((action) => grantable.has(action)))].sort();
      // Nothing recognised means None, never a fallback to a level -- same
      // drop-rather-than-coerce rule the level branch below follows.
      if (actions.length) scopes[namespace] = actions;
      continue;
    }

    if (!SCOPE_LEVELS.includes(value)) continue;
    if (value === "write" && !namespaceHasWriteActions(namespace)) {
      // logs has no write action, and updates' writes are denied. In both
      // cases store read rather than a level that resolves to the same thing.
      scopes[namespace] = "read";
      continue;
    }
    scopes[namespace] = value;
  }
  return scopes;
}

// Does this stored scope value reach this action? The single place the two
// scope forms are interpreted, so keyAllows() and any UI preview cannot drift.
export function scopeAllowsAction(namespace, value, action) {
  if (Array.isArray(value)) {
    if (!value.includes(action)) return false;
    // Defensive, for a hand-edited api-keys.json that lists a write action in
    // a write-denied namespace: normalizeScopes drops those on save, and this
    // is the check that also covers a file edited behind its back.
    return !KEY_WRITE_DENIED_NAMESPACES.has(namespace) || isReadAction(action);
  }
  if (value !== "read" && value !== "write") return false;
  if (value === "write" && !KEY_WRITE_DENIED_NAMESPACES.has(namespace)) return true;
  return isReadAction(action);
}

export function scopesGrantAnything(scopes) {
  return Boolean(scopes && Object.keys(scopes).length);
}
