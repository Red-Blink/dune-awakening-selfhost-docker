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
//       { "Effect": "Deny",  "Action": ["bases:delete"] },
//       { "Effect": "Allow", "Action": ["bases:*", "server:read"] }
//     ]}
//
// Every Action here must be a REAL action, or a wildcard matching at least one.
// This example used to read "Deny players:reset-progression" -- a string no
// route resolves to, so it denied nothing while looking like it withheld
// progression resets. The route actually resolves to players:reset.
// setPolicies now refuses such a pattern instead of storing it;
// unknownActions() is the check.
//
// A name the catalog USED to have is a different case, handled by
// REMOVED_ACTION_ALIASES: it keeps its old meaning when evaluated, so an
// upgrade cannot silently re-interpret a policy, but setPolicies still refuses
// it on save so the operator migrates.
//
// Evaluation: for each statement in order,
//   if action matches statement AND Effect=Deny  → DENY immediately
//   if action matches statement AND Effect=Allow → mark ALLOWED
//   if no statement matched                        → DENY (default)

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROUTE_ACTIONS, REGEX_ACTIONS, REGEX_ACTIONS_BY_METHOD, REGEX_ACTIONS_BY_METHOD_PATTERN, CONTENT_CONDITIONAL_ACTIONS, REMOVED_ACTION_ALIASES } from "./actions.js";
import { writeJsonAtomic } from "./jsonStore.js";

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
  // A name this catalog used to have. Checked LAST, so it can never shadow a
  // live action, and it exists so that splitting a coarse action does not
  // silently re-interpret a policy that already named it -- a Deny on
  // players:mutate still denies every action players:mutate used to cover.
  // See REMOVED_ACTION_ALIASES in actions.js for why this is not simply a
  // deletion. setPolicies still refuses these on save.
  const successors = REMOVED_ACTION_ALIASES[pattern];
  if (successors) return successors.includes(action);
  return false;
}

// Patterns naming an action this catalog used to have. Distinct from
// unknownActions: these still MEAN something (matchAction honours them), but an
// operator saving a policy should be told to name the successors explicitly.
export function deprecatedActions(docs) {
  const found = [];
  for (const [tier, document] of Object.entries(docs || {})) {
    for (const statement of document?.statements || []) {
      const patterns = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      for (const pattern of patterns) {
        if (typeof pattern !== "string") continue;
        if (REMOVED_ACTION_ALIASES[pattern]) found.push({ tier, pattern, successors: [...REMOVED_ACTION_ALIASES[pattern]] });
      }
    }
  }
  return found;
}

export function evaluate(session, action, policies = null) {
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

  _allowedActions = {};

  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (validPolicyStore(parsed)) {
        _policies = parsed;
        // Loaded even when it names actions that do not exist, and reported
        // rather than rejected. setPolicies refuses those on save, so a stored
        // file can only acquire one by hand-editing -- and throwing the whole
        // document away would silently revert an operator's entire policy to
        // defaults, a far bigger surprise than the dead pattern itself. The
        // caller logs what is returned here.
        return { source: "file", path: filePath, unknownActions: unknownActions(parsed), deprecatedActions: deprecatedActions(parsed) };
      }
      _policies = DEFAULT_POLICIES;
      return { source: "defaults", path: filePath, invalid: true, unknownActions: [], deprecatedActions: [] };
    } catch {
      _policies = DEFAULT_POLICIES;
      return { source: "defaults", path: filePath, invalid: true, unknownActions: [], deprecatedActions: [] };
    }
  }

  // Hardcoded fallback defaults
  _policies = DEFAULT_POLICIES;
  return { source: "defaults", unknownActions: [], deprecatedActions: [] };
}

let _allowedActions = {};

// A parameterized route (e.g. DELETE /api/bases/{baseId}) has no exact
// ROUTE_ACTIONS entry -- actionForRoute resolves it through one of three
// other tiers instead (see actions.js). bases:delete is the reason this
// enumerates all four: it exists only in REGEX_ACTIONS_BY_METHOD_PATTERN, so
// a version of this that only read ROUTE_ACTIONS would never surface it.
//
// CONTENT_CONDITIONAL_ACTIONS is the fifth source and the only one no route
// resolves to: those actions are decided from the request body inside the
// handler, so nothing in the four route tables above mentions them.
export function allKnownActions() {
  const actions = new Set(Object.values(ROUTE_ACTIONS));
  for (const [, action] of REGEX_ACTIONS) actions.add(action);
  for (const action of Object.values(REGEX_ACTIONS_BY_METHOD)) actions.add(action);
  for (const { action } of REGEX_ACTIONS_BY_METHOD_PATTERN) actions.add(action);
  for (const action of CONTENT_CONDITIONAL_ACTIONS) actions.add(action);
  return actions;
}

export function resolveAllowedActions(tier) {
  if (!tier) return [];
  if (_allowedActions[tier]) return _allowedActions[tier];

  const allActions = allKnownActions();
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

// Every Action pattern that matches NO action in the catalog, as
// [{ tier, pattern }]. Such a pattern is dead weight in an Allow and a silent
// lie in a Deny: "Deny players:reset-progression" looks like it withholds
// progression resets, but no route resolves to that string (the real one is
// players:reset), so it withholds nothing and the policy reads as safe.
//
// A name the catalog used to have is NOT reported here -- matchAction still
// honours it, so it matches successors and is not dead. deprecatedActions()
// reports those separately, because the fix is migration rather than a typo.
//
// Wildcards are legal and must stay legal, so the test is "does this pattern
// match at least one real action", not "is this string in the catalog" --
// evaluated with the same matchAction the engine uses, so a pattern accepted
// here behaves at runtime exactly as it did during validation.
export function unknownActions(docs) {
  const known = [...allKnownActions()];
  const dead = [];
  for (const [tier, document] of Object.entries(docs || {})) {
    for (const statement of document?.statements || []) {
      const patterns = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      for (const pattern of patterns) {
        if (typeof pattern !== "string") continue;
        if (!known.some((action) => matchAction(pattern, action))) dead.push({ tier, pattern });
      }
    }
  }
  return dead;
}

export function setPolicies(docs, repoRoot = null) {
  if (!validPolicyStore(docs)) {
    return { ok: false, error: "Policies must contain valid tier documents and Allow/Deny statements." };
  }
  if (!evaluate({ tier: "owner" }, "settings:write", docs)) {
    return { ok: false, error: "The owner policy must retain settings:write access." };
  }
  // Refused rather than warned about: the dangerous case is a misspelled Deny,
  // and a save that "succeeded with warnings" is exactly how an operator ends
  // up believing a restriction is in force when it is not.
  // Refused on SAVE even though matchAction still honours them at evaluation
  // time. That asymmetry is the whole design: an existing document keeps its
  // meaning through an upgrade, and the operator is pushed to migrate the next
  // time they edit it, rather than being silently re-interpreted OR having the
  // console refuse to start. The message names the successors so the edit is
  // mechanical.
  const deprecated = deprecatedActions(docs);
  if (deprecated.length) {
    const listed = deprecated
      .map(({ tier, pattern, successors }) => `${tier}: ${pattern} (now ${successors.join(", ")})`)
      .join("; ");
    return {
      ok: false,
      error: `These actions were split and no longer exist. Name the actions you actually want instead: ${listed}.`,
      deprecatedActions: deprecated
    };
  }

  const dead = unknownActions(docs);
  if (dead.length) {
    const listed = dead.map(({ tier, pattern }) => `${tier}: ${pattern}`).join(", ");
    return {
      ok: false,
      error: `These actions do not exist and would have no effect: ${listed}. Check GET /api/settings/iam/policies for the full list of valid actions.`,
      unknownActions: dead
    };
  }
  _policies = docs;
  _allowedActions = {};
  if (repoRoot) writeJsonAtomic(resolve(repoRoot, "runtime/generated/iam-policies.json"), docs, 0o600);
  return { ok: true, policies: getAllPolicies() };
}

function validPolicyStore(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const tiers = Object.keys(value);
  if (!tiers.length || tiers.some((tier) => !["owner", "admin", "moderator", "player", "observer"].includes(tier))) return false;
  return tiers.every((tier) => {
    const document = value[tier];
    if (!document || document.tier !== tier || !Array.isArray(document.statements)) return false;
    return document.statements.every((statement) => {
      if (!statement || !["Allow", "Deny"].includes(statement.Effect)) return false;
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      return actions.length > 0 && actions.every((action) => typeof action === "string" && action.trim().length > 0);
    });
  });
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
        "vehicles:*",
        "exchange:*",
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
        // The write half of POST /api/database/query -- the reason the two
        // denials above were decorative: database:query is granted just
        // above, and that one route accepts UPDATE/DELETE/DROP as readily as
        // SELECT, so admin kept arbitrary write access to the whole database
        // through it. See CONTENT_CONDITIONAL_ACTIONS in actions.js.
        //
        // What actually closes that hole is the requireAction("database:execute")
        // call in server.js's databaseQuery, not this line: the Allow list
        // above names database:read/query/export individually rather than
        // database:*, so default-deny already refuses database:execute and
        // removing this line changes nothing today. It is here for the edit
        // that widens the Allow to database:* -- a plausible tidy-up that
        // would otherwise silently hand admin the write half back. Covered by
        // "the deny survives a widened allow list" in databaseQueryAuthz.test.js.
        "database:execute",
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
        "vehicles:read",
        "exchange:read",
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
        "vehicles:read",
        "exchange:read",
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
        "vehicles:read",
        "exchange:read",
        "landsraad:read",
      ]},
    ]
  },
};
