// Console IAM — AWS IAM-style policy evaluation engine.
//
// Implements: Deny > Allow > default Deny with wildcard matching.
// Policies are loaded from runtime/generated/iam-policies.json at
// startup; if the file is missing or invalid, hardcoded defaults
// (equivalent to the current CAPABILITY_BY_TIER model) are used.
//
// Policy document format (per tier):
//   { "version": 1, "tier": "moderator",
//     "statements": [
//       { "Effect": "Deny",  "Action": ["players:reset-progression"] },
//       { "Effect": "Allow", "Action": ["players:*", "server:read"] }
//     ]}
//
// Evaluation: for each statement in order,
//   if action matches statement AND Effect=Deny  → DENY immediately
//   if action matches statement AND Effect=Allow → mark ALLOWED
//   if no statement matched                        → DENY (default)

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROUTE_ACTIONS } from "./actions.js";

// ---- Policy evaluation ----

export const WILDCARD = "*";

export function matchAction(pattern, action) {
  if (pattern === WILDCARD) return true;
  if (pattern.endsWith(":*")) {
    const ns = pattern.slice(0, -2);
    return action === ns || action.startsWith(ns + ":");
  }
  if (pattern.endsWith("-*")) {
    const prefix = pattern.slice(0, -1);
    return action.startsWith(prefix);
  }
  // Exact match or wildcard segment
  if (pattern === action) return true;
  if (pattern.includes("*")) {
    const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
    return regex.test(action);
  }
  return false;
}

export function evaluate(session, action, policies = null) {
  // Owner always passes — optimization, not a policy rule
  if (session && session.tier === "owner") return true;

  // No action to check — public route
  if (!action) return true;

  const tier = resolveSessionTier(session);
  if (!tier) return false;

  const policy = getPolicy(tier, policies);
  if (!policy) return false;

  let allowed = false;

  for (const stmt of policy.statements || []) {
    const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
    const effect = stmt.Effect;

    for (const pattern of actions) {
      if (matchAction(pattern, action)) {
        if (effect === "Deny") return false;
        if (effect === "Allow") allowed = true;
      }
    }
  }

  return allowed;
}

export function resolveSessionTier(session) {
  if (!session) return "";
  const tier = typeof session.tier === "string" ? session.tier : "";
  const VALID_TIERS = new Set(["owner", "admin", "moderator", "player", "observer"]);
  return VALID_TIERS.has(tier) ? tier : "";
}

// ---- Policy store ----

let _policies = null;

export function loadPolicies(repoRoot = null) {
  const filePath = repoRoot
    ? resolve(repoRoot, "runtime/generated/iam-policies.json")
    : resolve(process.cwd(), "../..", "runtime/generated/iam-policies.json");

  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        _policies = parsed;
        return;
      }
    } catch {
      // Fall through to defaults
    }
  }

  // Hardcoded fallback defaults
  _policies = DEFAULT_POLICIES;
}

let _allowedActions = {};

export function resolveAllowedActions(tier) {
  if (!tier) return [];
  if (_allowedActions[tier]) return _allowedActions[tier];

  const allActions = new Set(Object.values(ROUTE_ACTIONS));
  const mockSession = { tier };
  const allowed = [];

  for (const action of allActions) {
    if (evaluate(mockSession, action)) {
      allowed.push(action);
    }
  }

  _allowedActions[tier] = allowed;
  return allowed;
}

export function getPolicy(tier, policies = null) {
  const store = policies || _policies || DEFAULT_POLICIES;
  return store[tier] || null;
}

export function getAllPolicies(policies = null) {
  const store = policies || _policies || DEFAULT_POLICIES;
  return { ...store };
}

export function setPolicies(docs) {
  _policies = docs;
}

// ---- Default policies (mirror the CAPABILITY_BY_TIER ladder) ----

const DEFAULT_POLICIES = {
  owner: {
    version: 1,
    tier: "owner",
    statements: [
      { Effect: "Allow", Action: "*" }
    ]
  },
  admin: {
    version: 1,
    tier: "admin",
    statements: [
      { Effect: "Allow", Action: [
        "setup:*",
        "server:*",
        "logs:*",
        "backups:*",
        "database:read",
        "database:query",
        "database:export",
        "updates:*",
        "players:*",
        "guilds:*",
        "bases:*",
        "storage:*",
        "blueprints:*",
        "maps:*",
        "sietches:*",
        "deepdesert:*",
        "admin:*",
        "landsraad:*",
        "addons:*",
        "carepackage:*",
      ]},
      { Effect: "Deny", Action: [
        "settings:*",
        "database:write-config",
        "database:mutate",
      ]}
    ]
  },
  moderator: {
    version: 1,
    tier: "moderator",
    statements: [
      { Effect: "Allow", Action: [
        "server:read",
        "maps:read",
        "sietches:read",
        "deepdesert:read",
        "players:read",
        "players:kick-all",
        "guilds:read",
        "bases:read",
        "storage:read",
        "blueprints:read",
        "logs:*",
        "landsraad:read",
        "admin:broadcast",
        "admin:map-chat",
      ]},
    ]
  },
  player: {
    version: 1,
    tier: "player",
    statements: [
      { Effect: "Allow", Action: [
        "server:read",
        "maps:read",
        "sietches:read",
        "deepdesert:read",
        "players:read",
        "guilds:read",
        "bases:read",
        "storage:read",
        "blueprints:read",
        "landsraad:read",
      ]},
    ]
  },
  observer: {
    version: 1,
    tier: "observer",
    statements: [
      { Effect: "Allow", Action: [
        "server:read",
        "maps:read",
        "sietches:read",
        "deepdesert:read",
        "players:read",
        "guilds:read",
        "bases:read",
        "storage:read",
        "blueprints:read",
        "landsraad:read",
      ]},
    ]
  },
};
