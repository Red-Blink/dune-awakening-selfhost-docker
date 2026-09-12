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
// Every Action must be a REAL action, or a wildcard matching at least one; a
// name matching nothing denies nothing while reading like a restriction.
// setPolicies refuses those (unknownActions). A name the catalog USED to have
// is a separate case: REMOVED_ACTION_ALIASES keeps its old meaning at
// evaluation time, and setPolicies refuses it on save so the operator migrates.
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
    // Only `*` is special. Every other character is matched literally -- a
    // pattern like "players:(*" must never reach RegExp unescaped, where it
    // throws SyntaxError on every evaluate() for that tier (a persisted policy
    // would turn every request by that tier into a 500 until hand-edited).
    // validPolicyStore() refuses such patterns at save time; this is the
    // second line of defence for a hand-edited iam-policies.json.
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    const regex = new RegExp("^" + escaped + "$");
    return regex.test(action);
  }
  // A name this catalog used to have. Checked LAST so it can never shadow a
  // live action. See REMOVED_ACTION_ALIASES in actions.js for why a split
  // cannot simply delete the old name.
  const successors = REMOVED_ACTION_ALIASES[pattern];
  if (successors) return successors.includes(action);
  return false;
}

// Patterns naming an action the catalog used to have. Unlike unknownActions
// these still mean something, but a save should name the successors explicitly.
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

// The IAM action vocabulary: lowercase letters, digits, ':' namespace
// separators, '-' inside a segment, and '*' as the only wildcard. Anything
// else is refused at save time -- see matchAction() for why.
export const ACTION_PATTERN = /^[a-z0-9:*-]+$/;

// First action pattern in the store that is not a valid IAM action pattern,
// or null. Reported by name so the operator is told which string to fix
// instead of a generic "invalid policies".
export function invalidActionPattern(value) {
  if (!value || typeof value !== "object") return null;
  for (const document of Object.values(value)) {
    for (const statement of document?.statements || []) {
      const actions = Array.isArray(statement?.Action) ? statement.Action : [statement?.Action];
      for (const action of actions) {
        if (typeof action === "string" && action.trim().length > 0 && !ACTION_PATTERN.test(action)) return action;
      }
    }
  }
  return null;
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
  const VALID_TIERS = new Set(["owner", "admin", "moderator", "player"]);
  return VALID_TIERS.has(tier) ? tier : "";
}

// Tier names this console used to support but has since retired -- "observer"
// was folded into "player" (ce5c44a2, folding decision: Player already
// covered everything Observer could reach). validPolicyStore() rejects ANY
// unrecognized tier key in the WHOLE document, so a policy file written
// before the fold still carrying its own "observer" document used to make
// the entire file fail validation, silently reverting EVERY tier -- including
// an operator's genuinely customized admin/moderator/player restrictions --
// to the (more permissive) hardcoded defaults on the next boot. Reproduced
// live by the upstream maintainer (review finding, PR #202, 2026-09-06): an
// admin hand-restricted to server:read regained server:stop purely because
// the same file also still had a leftover "observer" document.
// migrateObsoleteTiers() strips just the obsolete document before validation,
// so every OTHER tier's real, operator-authored policy survives the upgrade
// unchanged.
const OBSOLETE_TIERS = new Set(["observer"]);

// Returns { migrated, removedTiers }: a shallow copy of `value` with any
// obsolete tier document removed (removedTiers lists which), or `value`
// itself unchanged when nothing needed migrating. Never mutates the input.
// Deliberately tolerant of a non-object/array `value` here -- validPolicyStore
// still rejects those; this function only needs to not throw on them so it
// can sit unconditionally in front of that check.
function migrateObsoleteTiers(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { migrated: value, removedTiers: [] };
  const removedTiers = Object.keys(value).filter((tier) => OBSOLETE_TIERS.has(tier));
  if (!removedTiers.length) return { migrated: value, removedTiers };
  const migrated = { ...value };
  for (const tier of removedTiers) delete migrated[tier];
  return { migrated, removedTiers };
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
      const { migrated: parsed, removedTiers: migratedTiers } = migrateObsoleteTiers(JSON.parse(raw));
      if (validPolicyStore(parsed)) {
        // #711: setPolicies() refuses to ever SAVE a crown-jewel leak, but a
        // file written before that backstop existed (or hand-edited around
        // it) was trusted here with no check at all. Apply the identical
        // backstop at load time.
        //
        // SURGICAL, not wholesale (review finding, before this ever shipped):
        // an earlier version of this fix fell back to DEFAULT_POLICIES
        // entirely the moment ANY ONE tier leaked -- silently discarding
        // EVERY tier's stored customization, including tiers with no leak at
        // all. That is exactly the "whole document destroyed by one bad
        // tier" failure mode migrateObsoleteTiers() above already exists to
        // avoid for a different cause (an obsolete tier document), and the
        // same "discarding the document is a bigger surprise than the
        // narrow problem" reasoning the unknownActions() report below
        // already follows. An operator who saved policies under older,
        // pre-crown-jewel-protection defaults (this fork's own upgrade
        // guide documents that the shipped Admin default used to grant
        // server:*/backups:*/players:* wildcards) would have lost their
        // moderator/player customizations too, not just admin's. Reset ONLY
        // the leaking tier(s) to their default document; every other tier's
        // stored policy is preserved exactly as authored.
        const crownJewelLeaks = crownJewelLeakingTiers(parsed);
        for (const { tier } of crownJewelLeaks) parsed[tier] = DEFAULT_POLICIES[tier];
        for (const { tier, action } of crownJewelLeaks) {
          console.warn(
            `Stored IAM policy at ${filePath} grants "${action}" to the "${tier}" tier, a crown-jewel action reserved for owner -- ` +
            `resetting ONLY the "${tier}" tier to its default policy (every other tier's stored policy is unaffected). This tier's document likely ` +
            "predates crown-jewel protection (or was hand-edited around it) and still carries a wildcard/legacy grant. Review Access Control and " +
            `re-save the "${tier}" tier after this restart if it had intentional customizations.`
          );
        }
        _policies = parsed;
        if (migratedTiers.length || crownJewelLeaks.length) {
          // Fixed on disk too, not just in memory -- otherwise the same
          // stale document reappears (and re-logs this notice) on every
          // restart until an operator happens to re-save via Access Control.
          // Best-effort: if the write fails, this boot is still correct
          // (parsed already has the fix applied), just not yet durable.
          try { writeJsonAtomic(filePath, parsed, 0o600); } catch (err) {
            console.warn(`Could not persist the fixed IAM policy at ${filePath}: ${err instanceof Error ? err.message : "unknown error"}. It will be re-fixed (harmlessly) on the next restart.`);
          }
        }
        // Reported, not rejected: discarding the document would silently
        // revert the operator's whole policy to defaults, a bigger surprise
        // than the dead pattern. setPolicies refuses these on save, so a stored
        // file can only acquire one by hand-editing. The caller logs this.
        return { source: "file", path: filePath, unknownActions: unknownActions(parsed), deprecatedActions: deprecatedActions(parsed), migratedTiers, crownJewelLeaks };
      }
      _policies = DEFAULT_POLICIES;
      // A stored file that fails validation (e.g. an action pattern that
      // predates the ACTION_PATTERN tightening) used to fall through to the
      // defaults with no trace of it happening -- an operator's hand-authored
      // policy could be silently discarded on upgrade, replaced by whatever
      // this version's defaults are, and nothing would say so (review
      // finding). Fail loud, not silent.
      console.warn(
        `Stored IAM policy at ${filePath} failed validation and was NOT loaded -- ` +
        "falling back to the default policies. This usually means an action pattern " +
        "in the file predates a schema change (only lowercase letters, digits, ':', " +
        "'-' and '*' are valid). Check Access Control after this restart."
      );
      return { source: "defaults", path: filePath, invalid: true, unknownActions: [], deprecatedActions: [], migratedTiers: [] };
    } catch (err) {
      _policies = DEFAULT_POLICIES;
      const reason = err instanceof Error ? err.message : "unreadable or malformed";
      console.warn(
        `Stored IAM policy at ${filePath} could not be read (${reason}) -- ` +
        "falling back to the default policies. Check Access Control after this restart."
      );
      return { source: "defaults", path: filePath, invalid: true, unknownActions: [], deprecatedActions: [], migratedTiers: [] };
    }
  }

  // Hardcoded fallback defaults
  _policies = DEFAULT_POLICIES;
  return { source: "defaults", unknownActions: [], deprecatedActions: [], migratedTiers: [] };
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
// [{ tier, pattern }]. Dead weight in an Allow; a silent lie in a Deny.
// "Deny players:reset-progression" is the shape -- no route resolves to it
// (players:reset does), so it withholds nothing while the policy reads as safe.
//
// Removed names are NOT reported here: matchAction still honours them, so they
// are not dead. deprecatedActions() reports those, since the fix is migration
// rather than a typo.
//
// The test is "does this pattern match at least one real action", not "is this
// string in the catalog", so wildcards stay legal -- and it runs through the
// same matchAction the engine uses, so validation and runtime cannot disagree.
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
  const badPattern = invalidActionPattern(docs);
  if (badPattern !== null) {
    return { ok: false, error: `Action pattern "${badPattern}" is not valid: use lowercase letters, digits, ':' and '-', with '*' as the only wildcard.` };
  }
  // Checked BEFORE validPolicyStore() (adversarial review finding, upstream
  // PR #202 follow-up, 2026-09-06): loadPolicies() migrates an obsolete tier
  // out of a STORED file automatically (an operator never asked for that
  // load to happen, so silently dropping the dead document is the least
  // surprising behavior) -- but setPolicies() is a deliberate, operator-
  // initiated SAVE, most plausibly reached by pasting raw JSON from an old
  // export/backup into the IAM editor's JSON tab. Silently stripping data
  // out from under an explicit save would be its own surprise; instead,
  // refuse with a specific, actionable message -- mirroring the existing
  // deprecatedActions() pattern below -- instead of validPolicyStore()'s
  // generic "must contain valid tier documents", which names nothing an
  // operator could act on.
  const obsoleteTiers = docs && typeof docs === "object" && !Array.isArray(docs)
    ? Object.keys(docs).filter((tier) => OBSOLETE_TIERS.has(tier))
    : [];
  if (obsoleteTiers.length) {
    return {
      ok: false,
      error: `The "${obsoleteTiers.join('", "')}" tier is no longer recognized (folded into "player"). Remove it from the document before saving.`,
      obsoleteTiers,
    };
  }
  if (!validPolicyStore(docs)) {
    return { ok: false, error: "Policies must contain valid tier documents and Allow/Deny statements." };
  }
  // settings:read gates GET /api/settings and GET /api/settings/iam/policies --
  // an owner document that kept settings:write but lost settings:read would
  // pass the check above yet be unable to load the IAM editor or Settings
  // panel at all to fix its own mistake (found by review).
  if (!evaluate({ tier: "owner" }, "settings:write", docs) || !evaluate({ tier: "owner" }, "settings:read", docs)) {
    return { ok: false, error: "The owner policy must retain settings:read and settings:write access." };
  }
  // Both checks REFUSE rather than warn. A save that "succeeded with warnings"
  // is how an operator ends up believing a restriction is in force when it is
  // not.
  //
  // Deprecated names are refused on save even though matchAction still honours
  // them at evaluation time. That asymmetry is deliberate: a stored document
  // keeps its meaning through an upgrade, and the operator migrates on their
  // next edit instead of the console refusing to start. The message names the
  // successors so the edit is mechanical.
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

  // Crown-jewel actions (settings:*, database mutation/export, updates:apply,
  // backups:restore/import, addons:install/update, players:mutate, the
  // economy actions, etc. -- see CROWN_JEWEL_DENY_ACTIONS) must never resolve
  // to allowed for any tier but owner, no matter how the JSON got there --
  // an Allow that reaches one, a removed Deny, or both at once. Only owner
  // can save policies at all (settings:write is itself a crown jewel), so
  // this is specifically a backstop against an owner *accidentally* granting
  // one to a lower tier while hand-editing the JSON tab.
  //
  // CROWN_JEWEL_DENY_ACTIONS entries are PATTERNS (one of them, "settings:*",
  // is a wildcard), not necessarily real, concrete actions -- evaluate()
  // expects a concrete action to test against a tier's own patterns, so
  // calling evaluate({tier}, "settings:*", docs) directly checks whether the
  // tier's OWN statements contain a pattern matching the literal string
  // "settings:*" (they never do), not whether the tier can reach any real
  // settings:* action. That silently let a tier through if it was granted a
  // specific concrete action under a wildcard crown-jewel entry (e.g. a bare
  // "settings:write" Allow, with no wildcard anywhere in sight) -- found by
  // Eight Hats Layer 1 review of #634's design doc, empirically confirmed.
  // Fix: expand every crown-jewel PATTERN against the real action catalog
  // first, then evaluate() each matched CONCRETE action -- mirroring the
  // same expand-then-evaluate shape resolveAllowedActions() already uses.
  const leak = crownJewelLeak(docs);
  if (leak) {
    return { ok: false, error: `The ${leak.tier} policy would grant "${leak.action}", a crown-jewel action reserved for owner. Add an explicit Deny for it, or remove the Allow that reaches it.` };
  }
  _policies = docs;
  _allowedActions = {};
  if (repoRoot) writeJsonAtomic(resolve(repoRoot, "runtime/generated/iam-policies.json"), docs, 0o600);
  return { ok: true, policies: getAllPolicies() };
}

function validPolicyStore(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const tiers = Object.keys(value);
  if (!tiers.length || tiers.some((tier) => !["owner", "admin", "moderator", "player"].includes(tier))) return false;
  return tiers.every((tier) => {
    const document = value[tier];
    if (!document || document.tier !== tier || !Array.isArray(document.statements)) return false;
    return document.statements.every((statement) => {
      if (!statement || !["Allow", "Deny"].includes(statement.Effect)) return false;
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      return actions.length > 0 && actions.every((action) => typeof action === "string" && ACTION_PATTERN.test(action));
    });
  });
}

// ---- Default policies (mirror the CAPABILITY_BY_TIER ladder) ----

// "Crown jewel" actions that must stay unreachable by every tier below Owner,
// even if that tier's own Allow list is edited/widened later via the Access
// Control UI. Originally only Admin carried this Deny block (Admin's own Allow
// list is broad enough that a future widening edit is plausible); Moderator/
// Player's Allow lists don't touch any of these today either, but
// nothing stops an operator from widening THEIR Allow list too -- and unlike
// Admin, they had no backstop if that happened. Every non-owner tier now
// carries the identical Deny, purely as defense-in-depth: a no-op today
// against each tier's current Allow list, protective if one is ever widened.
const CROWN_JEWEL_DENY_ACTIONS = [
  "settings:*",                                     // IAM policies, admin password, port, recovery codes
  "server:write-credentials",                       // Funcom game-server token + server IP change
  "database:write-config", "database:mutate",       // DB password + direct table edits
  // The write half of POST /api/database/query, without which the two
  // denials above are decorative: database:query is granted just above
  // and that route takes UPDATE/DELETE/DROP as readily as SELECT.
  //
  // Redundant today -- the Allow list names database:read/query/export
  // individually, so default-deny already refuses this. It is here for
  // the plausible tidy-up that widens the Allow to database:*, which
  // would otherwise hand the write half back. Pinned by "the deny
  // survives a widened allow list" in databaseQueryAuthz.test.js.
  "database:execute",
  "database:export",                                // full DB dump = whole-database exfiltration
  "admin:transfer-settings:write",                  // character/server-transfer policy (identity + economy)
  "updates:apply", "updates:fix", "updates:repair", // deploying / altering the running code
  "backups:restore", "backups:import",              // irreversible DB overwrite / untrusted import
  "addons:install", "addons:update",                // third-party code into the console process
  "setup:write",                                    // first-run provisioning
  // The economy/progression successors of the old players:mutate bucket --
  // NOT the bare "players:mutate" alias itself, which would also catch
  // players:moderate/players:teleport via REMOVED_ACTION_ALIASES successor
  // matching (matchAction()) and deny admin/moderator the individual-player
  // moderation both are explicitly granted above.
  "players:give-item", "players:grant", "players:reset",
  "players:delete-item", "players:edit-item", "players:repair", "players:recover",
  // The fail-closed catch-all sentinel itself (see actions.js's *:unclassified
  // sentinels) -- also a crown jewel: an unnamed future players route must
  // stay owner-only even if a lower tier's Allow is later widened.
  "players:unclassified",
  "carepackage:grant", "carepackage:write-config",  // minting in-game value
  // #710 follow-up: this used to also list the bare "exchange:market" pattern
  // alongside "exchange:market-write" under one "seeding the market economy"
  // comment -- but exchange:market is read-only (actions.js: every route it
  // resolves is a GET, plus one explicitly read-only POST .../buyback/probe;
  // apiKeyScopes.js's own EXTRA_READ_ACTIONS already documents this and grants
  // it to a key's exchange:"read" scope). Found when reconciling this list
  // with apiKeyScopes.js for #710: enforcing the (until-then-latent) crown-jewel
  // check universally broke exchange:market's own documented, tested,
  // deliberately-read-reachable design. Only the actual write/economy-seeding
  // half stays owner-only.
  "exchange:market-write",
  // #711 follow-up: omitted despite apiKeyScopes.js's parallel KEY_DENIED_ACTIONS
  // already treating backups:restore/import/delete as owner-only-equivalent for
  // API keys. Without it, an owner who later widens a non-owner tier's Allow to
  // "backups:*" (a plausible tidy-up this file's own comments warn against for
  // other entries) would silently gain mass-deletion of every backup.
  "backups:delete",
];

let _crownJewelActionSet = null;

// The real, concrete actions from the catalog that CROWN_JEWEL_DENY_ACTIONS'
// patterns match. Memoized like apiKeyScopes.js's actionsByNamespace() cache
// -- the catalog is static for the life of the process, and every caller
// below needs this same expand-then-evaluate result (see setPolicies()'s own
// comment for why a pattern cannot be checked directly).
function crownJewelActionSet() {
  if (_crownJewelActionSet) return _crownJewelActionSet;
  _crownJewelActionSet = new Set(
    [...allKnownActions()].filter((action) =>
      CROWN_JEWEL_DENY_ACTIONS.some((pattern) => matchAction(pattern, action))
    )
  );
  return _crownJewelActionSet;
}

// Exported so any OTHER principal type with its own deny list -- API keys
// (apiKeyScopes.js's KEY_DENIED_ACTIONS) are the current example -- can be
// checked against this same authoritative catalog instead of maintaining an
// independently-drifting copy. #710 found API-key scopes had never been
// reconciled with this list at all: a key scoped `players: "write"` could
// reach players:give-item/reset/recover, denied even to a human admin session.
export function isCrownJewelAction(action) {
  return crownJewelActionSet().has(action);
}

// The first crown-jewel action a non-owner tier's OWN statements resolve to
// allowed, or null. Shared by setPolicies() (an operator-initiated save) and
// loadPolicies() (an operator-authored file trusted as-is at boot) so the two
// checks cannot drift -- #711 found loadPolicies() skipping this entirely: a
// pre-existing iam-policies.json written before crown-jewel protection
// existed was trusted at boot with zero check, silently reviving old
// wildcard admin grants (backups:restore, players:give-item, etc.) on every
// restart until an operator happened to diff the file or attempt a save.
function crownJewelLeak(docs) {
  for (const tier of ["admin", "moderator", "player"]) {
    if (!docs[tier]) continue;
    for (const action of crownJewelActionSet()) {
      if (evaluate({ tier }, action, docs)) return { tier, action };
    }
  }
  return null;
}

// Every tier with at least one crown-jewel leak, as [{ tier, action }] (one
// example action per tier, not every leaking action). Used by loadPolicies()
// to reset ONLY the affected tier(s) -- see its own comment for why a leak in
// one tier must not discard every other tier's genuine customization.
function crownJewelLeakingTiers(docs) {
  const leaks = [];
  for (const tier of ["admin", "moderator", "player"]) {
    if (!docs[tier]) continue;
    for (const action of crownJewelActionSet()) {
      if (evaluate({ tier }, action, docs)) {
        leaks.push({ tier, action });
        break;
      }
    }
  }
  return leaks;
}

const DEFAULT_POLICIES = {
  owner: {
    version: 1,
    tier: "owner",
    statements: [
      { Effect: "Allow", Action: "*" }
    ]
  },

  // ADMIN -- "operate the live server and moderate players; change nothing
  // persistent." Deliberately over-restrictive: admin holds an EXPLICIT allow
  // list, so any capability added to the catalog later defaults to owner-only
  // until an operator grants it; and a Deny block keeps the crown-jewel actions
  // unreachable even if a future edit widens the allow list. Everything an admin
  // lacks -- all *:write-config, credentials, update/addon deployment,
  // destructive backup/data ops, and the economy -- is owner-only by design.
  // Loosen per-deployment via the Access Control editor (tracked for revision).
  admin: {
    version: 1,
    tier: "admin",
    statements: [
      { Effect: "Allow", Action: [
        // Server lifecycle -- transient operations, no persistent config write
        "server:read", "server:start", "server:stop", "server:restart",
        "server:restart-service", "server:network-fix", "server:storage-cleanup",
        // Player moderation -- act on an individual griefer + mass kick
        "players:read", "players:kick-all", "players:moderate", "players:teleport",
        // Live-ops -- bring a map shard up/down + in-world moderation movement
        "maps:read", "maps:spawn", "maps:despawn", "maps:teleport", "maps:restart", "maps:reconcile",
        // Communications / moderation tooling
        "admin:broadcast", "admin:broadcast-shutdown", "admin:map-chat",
        "admin:motd:read", "admin:motd:write",
        "admin:announcements:read", "admin:announcements:write",
        "admin:history:read", "admin:history:clear",
        "admin:transfer-settings:read", "admin:items:read",
        "admin:vehicles:read", "admin:skills:read",
        // Read-only visibility across the console
        "logs:read",
        "bases:read", "blueprints:read", "carepackage:read", "deepdesert:read", "exchange:read",
        "guilds:read", "landsraad:read", "sietches:read", "storage:read", "vehicles:read",
        "database:read", "database:query",   // query is read-only-enforced in the handler
        "updates:check", "updates:read", "updates:self-check",
        "backups:create", "backups:read",
        "setup:read",
        "addons:read",
      ]},
      { Effect: "Deny", Action: CROWN_JEWEL_DENY_ACTIONS }
    ]
  },

  // MODERATOR -- live moderation only: read everything, talk to players, and act
  // on individual griefers (kick/ban/teleport). No config, no economy, nothing
  // destructive or persistent.
  moderator: {
    version: 1,
    tier: "moderator",
    statements: [
      { Effect: "Allow", Action: [
        "server:read", "maps:read", "sietches:read", "deepdesert:read",
        "players:read", "players:kick-all", "players:moderate", "players:teleport",
        "guilds:read", "bases:read", "storage:read", "blueprints:read",
        "vehicles:read", "exchange:read", "logs:read", "landsraad:read",
        "admin:broadcast", "admin:map-chat",
      ]},
      { Effect: "Deny", Action: CROWN_JEWEL_DENY_ACTIONS }
    ]
  },

  // PLAYER -- a tight read-only self-service view. Only Home (server health),
  // Players, Guilds, and the Live Map. Deliberately does NOT include the broad
  // game-world reads (bases/storage/blueprints/vehicles/exchange/landsraad/
  // sietches/deepdesert) an operator does not want ordinary players browsing.
  // NOTE: these grants are still tier-wide (players:read = all players); scoping
  // a player to *their own* player/guild is ownership-based access tracked
  // separately (follow-up), as is hiding the tabs a player cannot use.
  player: {
    version: 1,
    tier: "player",
    statements: [
      { Effect: "Allow", Action: [
        "server:read",   // Home: performance / readiness / health
        "players:read",  // Players (own-only scoping is a follow-up)
        "guilds:read",   // Guilds (own-only scoping is a follow-up)
        "maps:read",     // Live Map
      ]},
      { Effect: "Deny", Action: CROWN_JEWEL_DENY_ACTIONS }
    ]
  },
};
