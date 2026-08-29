// A policy may only name actions that exist.
//
// The trap this closes: a misspelled or invented action in an ALLOW fails
// closed and grants nothing, which is harmless. The same string in a DENY
// withholds nothing while reading exactly like a restriction. policy.js's own
// header documented
//
//     { "Effect": "Deny", "Action": ["players:reset-progression"] }
//
// as the canonical example -- and no route resolves to that string. The route
// resolves to players:reset (players:mutate, before that action was split), so
// an operator following the documented example believed progression resets
// were blocked for admin while they were fully reachable.
//
// Worse, POST /api/settings/iam/policy/test answered allowed:false for it,
// which reads as confirmation that the Deny works. The `known` field exists so
// that answer can be told apart from a real denial.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { allKnownActions, deprecatedActions, evaluate, getAllPolicies, matchAction, setPolicies, unknownActions, loadPolicies } from "../src/policy.js";
import { actionForRoute, REMOVED_ACTION_ALIASES } from "../src/actions.js";
import { normalizeScopes } from "../src/apiKeyScopes.js";
import { keyAllows } from "../src/apiKeys.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const policySrc = readFileSync(join(__dirname, "../src/policy.js"), "utf8");
const serverSrc = readFileSync(join(__dirname, "../src/server.js"), "utf8");

const ownerAllowAll = { version: 1, tier: "owner", statements: [{ Effect: "Allow", Action: "*" }] };
const withAdmin = (statements) => ({
  owner: ownerAllowAll,
  admin: { version: 1, tier: "admin", statements }
});

// Restore the shipped defaults after any test that swaps them in, so ordering
// between this file's tests cannot matter.
function restoreDefaults() {
  loadPolicies(join(__dirname, "__no_such_repo_root__"));
}

// ---- The reported trap, reproduced then closed ----

test("the exact documented example is now refused", () => {
  const result = setPolicies(withAdmin([
    { Effect: "Deny", Action: ["players:reset-progression"] },
    { Effect: "Allow", Action: ["players:*"] }
  ]));
  assert.equal(result.ok, false);
  assert.match(result.error, /do not exist/);
  assert.match(result.error, /players:reset-progression/);
  assert.deepEqual(result.unknownActions, [{ tier: "admin", pattern: "players:reset-progression" }]);
  restoreDefaults();
});

test("the trap was real: that Deny would have withheld nothing", () => {
  // Evaluated directly against the document, bypassing setPolicies, to show
  // what the old code stored. The Deny does not fire and the route's actual
  // action stays allowed -- a policy that looks restrictive and is not.
  const docs = withAdmin([
    { Effect: "Deny", Action: ["players:reset-progression"] },
    { Effect: "Allow", Action: ["players:*"] }
  ]);
  assert.equal(evaluate({ tier: "admin" }, "players:reset-progression", docs), false);
  // ...while the route resolves to a real action the Allow above DOES grant, so
  // the reset stays reachable. Read from actionForRoute rather than hardcoded,
  // so a future split cannot make this test quietly stop describing the live
  // route.
  const realAction = actionForRoute("/api/players/12345/reset-progression", "POST");
  assert.ok(realAction && realAction !== "players:reset-progression");
  assert.equal(evaluate({ tier: "admin" }, realAction, docs), true);
  assert.ok(!allKnownActions().has("players:reset-progression"));
});

test("policy.js no longer documents a nonexistent action", () => {
  assert.ok(!policySrc.includes('"Action": ["players:reset-progression"]'),
    "the header example still shows an action that does not exist");
  // Every quoted namespace:action inside the header block comment must be real
  // (or a wildcard that matches something real) -- a fixed example that drifts
  // is the same bug again.
  const header = policySrc.slice(0, policySrc.indexOf("import "));
  const known = [...allKnownActions()];
  for (const quoted of header.match(/"[a-z][a-z-]*:[a-zA-Z0-9:*-]+"/g) || []) {
    const pattern = quoted.slice(1, -1);
    assert.ok(known.some((action) => matchAction(pattern, action)),
      `policy.js header names ${pattern}, which matches no known action`);
  }
});

// ---- unknownActions ----

test("unknownActions flags dead patterns and leaves real ones alone", () => {
  const dead = unknownActions(withAdmin([
    { Effect: "Allow", Action: ["players:read", "player:*", "bases:*", "bases:delete-nonsense"] },
    { Effect: "Deny", Action: "totally:invented" }
  ]));
  assert.deepEqual(dead.map((entry) => entry.pattern).sort(),
    ["bases:delete-nonsense", "player:*", "totally:invented"]);
  assert.ok(dead.every((entry) => entry.tier === "admin"));
});

test("wildcards stay legal, including the prefix-star style", () => {
  // The validator asks "does this match at least one real action", not "is this
  // string in the catalog" -- otherwise it would reject every wildcard policy,
  // including the shipped ones.
  for (const pattern of ["*", "players:*", "bases:delete-*", "bases:delete-item*", "database:*"]) {
    assert.deepEqual(unknownActions(withAdmin([{ Effect: "Allow", Action: pattern }])), [],
      `${pattern} should be accepted`);
  }
});

test("a wildcard that matches nothing is still refused", () => {
  // The dangerous near-miss: plausible shape, no matches.
  for (const pattern of ["player:*", "base:*", "players:reset-*", "settings:*:write"]) {
    const dead = unknownActions(withAdmin([{ Effect: "Deny", Action: pattern }]));
    assert.deepEqual(dead, [{ tier: "admin", pattern }], `${pattern} should be refused`);
  }
});

test("every shipped default policy passes its own validator", () => {
  restoreDefaults();
  assert.deepEqual(unknownActions(getAllPolicies()), []);
});

// ---- setPolicies ----

test("a valid policy still saves, and the structural checks still run first", () => {
  assert.equal(setPolicies(withAdmin([{ Effect: "Allow", Action: ["players:read", "bases:*"] }])).ok, true);
  // An unknown action must not mask the two older failures.
  assert.match(setPolicies({ owner: { tier: "owner", statements: [{ Effect: "Maybe", Action: "nope:nope" }] } }).error,
    /valid tier documents/);
  assert.match(setPolicies({ owner: { tier: "owner", statements: [{ Effect: "Deny", Action: "settings:write" }] } }).error,
    /settings:write/);
  restoreDefaults();
});

test("a refused save does not change the active policy", () => {
  restoreDefaults();
  // Probes a live catalog action, not players:mutate: that name is now a
  // removed-action alias, so evaluating it measures alias resolution rather
  // than the active document this test is about.
  const before = evaluate({ tier: "admin" }, "players:reset");
  setPolicies(withAdmin([{ Effect: "Deny", Action: ["players:reset-progression"] }]));
  assert.equal(evaluate({ tier: "admin" }, "players:reset"), before,
    "a rejected document must not be partially applied");
  restoreDefaults();
});

// ---- loadPolicies ----

function writePolicyFile(docs) {
  const root = mkdtempSync(join(tmpdir(), "iam-policies-"));
  mkdirSync(join(root, "runtime", "generated"), { recursive: true });
  writeFileSync(join(root, "runtime/generated/iam-policies.json"), JSON.stringify(docs));
  return root;
}

test("a hand-edited file with a dead pattern loads, and says so", () => {
  // Reported, NOT discarded. setPolicies refuses these on save, so a stored
  // file can only acquire one by hand-editing -- and throwing the whole
  // document away would silently revert the operator's entire policy to
  // defaults, a far bigger surprise than the dead pattern itself.
  const root = writePolicyFile(withAdmin([
    { Effect: "Deny", Action: ["players:reset-progression"] },
    { Effect: "Allow", Action: ["players:read", "bases:*"] }
  ]));
  try {
    const result = loadPolicies(root);
    assert.equal(result.source, "file", "the operator's document must still be in force");
    assert.deepEqual(result.unknownActions, [{ tier: "admin", pattern: "players:reset-progression" }]);
    // The rest of their policy really is applied, not replaced by defaults.
    assert.equal(evaluate({ tier: "admin" }, "players:read"), true);
    assert.equal(evaluate({ tier: "admin" }, "settings:write"), false,
      "the file's admin policy is active, not the built-in default");
  } finally {
    rmSync(root, { recursive: true, force: true });
    restoreDefaults();
  }
});

test("a structurally invalid file falls back to defaults and reports it", () => {
  const root = writePolicyFile({ owner: { tier: "owner", statements: [{ Effect: "Maybe", Action: "*" }] } });
  try {
    const result = loadPolicies(root);
    assert.equal(result.source, "defaults");
    assert.equal(result.invalid, true);
    assert.equal(evaluate({ tier: "owner" }, "settings:write"), true, "defaults must be in force");
  } finally {
    rmSync(root, { recursive: true, force: true });
    restoreDefaults();
  }
});

test("a clean file loads with nothing to report", () => {
  const root = writePolicyFile(withAdmin([{ Effect: "Allow", Action: ["players:read", "bases:*"] }]));
  try {
    const result = loadPolicies(root);
    assert.equal(result.source, "file");
    assert.deepEqual(result.unknownActions, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    restoreDefaults();
  }
});

test("a missing policy file reports defaults and no dead patterns", () => {
  const result = loadPolicies(join(__dirname, "__no_such_repo_root__"));
  assert.equal(result.source, "defaults");
  assert.deepEqual(result.unknownActions, []);
});

test("server.js warns about every dead pattern at startup", () => {
  assert.match(serverSrc, /const policyLoad = loadPolicies\(config\.repoRoot\);/);
  assert.match(serverSrc, /for \(const \{ tier, pattern \} of policyLoad\.unknownActions\)/);
  assert.match(serverSrc, /matches no known action and has no effect/);
});

// ---- The endpoints ----

test("the policy test endpoint reports whether the action is real", () => {
  const handler = serverSrc.slice(serverSrc.indexOf('path === "/api/settings/iam/policy/test"'));
  const body = handler.slice(0, handler.indexOf("\n  }\n"));
  assert.match(body, /known: allKnownActions\(\)\.has\(testAction\)/,
    "allowed:false alone cannot distinguish a denial from a typo");
});

test("the policies endpoint hands back the vocabulary", () => {
  const handler = serverSrc.slice(serverSrc.indexOf('path === "/api/settings/iam/policies"'));
  const body = handler.slice(0, handler.indexOf("\n  }\n"));
  assert.match(body, /actions: \[\.\.\.allKnownActions\(\)\]\.sort\(\)/);
});

// ---- Removed action aliases ----
//
// Splitting the coarse *:mutate actions is not a no-op for a policy that
// already named one. Deleting the name outright turned the idiom this file's
// header teaches inside out: `Deny players:mutate` + `Allow players:*` went
// from "no player mutations" to "every player mutation", because the Deny
// matched nothing and the wildcard matched all ten successors. Review measured
// a tier GAINING 22 actions and losing none, silently, on upgrade.

const escalationDoc = () => ({
  owner: ownerAllowAll,
  moderator: {
    version: 1,
    tier: "moderator",
    statements: [
      { Effect: "Deny", Action: ["players:mutate", "guilds:mutate", "addons:mutate", "blueprints:mutate"] },
      { Effect: "Allow", Action: ["players:*", "guilds:*", "addons:*", "blueprints:*"] }
    ]
  }
});

test("a Deny on a removed action still denies everything it used to", () => {
  // The regression this exists to prevent, asserted over every successor of
  // every alias rather than a sample.
  const docs = escalationDoc();
  for (const [alias, successors] of Object.entries(REMOVED_ACTION_ALIASES)) {
    for (const action of successors) {
      assert.equal(evaluate({ tier: "moderator" }, action, docs), false,
        `${action} leaked past a Deny on ${alias}`);
    }
  }
});

test("an Allow on a removed action still grants everything it used to", () => {
  for (const [alias, successors] of Object.entries(REMOVED_ACTION_ALIASES)) {
    const docs = {
      owner: ownerAllowAll,
      moderator: { version: 1, tier: "moderator", statements: [{ Effect: "Allow", Action: [alias] }] }
    };
    for (const action of successors) {
      assert.equal(evaluate({ tier: "moderator" }, action, docs), true, `${alias} should still grant ${action}`);
    }
  }
});

test("an alias sweeps in no more than it used to cover", () => {
  // players:kick-all was ALREADY its own action before the split (an exact
  // ROUTE_ACTIONS entry for POST /api/players/kick-all-online), so it was never
  // part of players:mutate. An alias that over-reaches would silently widen the
  // very policies it exists to preserve.
  assert.ok(!REMOVED_ACTION_ALIASES["players:mutate"].includes("players:kick-all"));
  const docs = {
    owner: ownerAllowAll,
    moderator: { version: 1, tier: "moderator", statements: [{ Effect: "Allow", Action: ["players:mutate"] }] }
  };
  assert.equal(evaluate({ tier: "moderator" }, "players:kick-all", docs), false);
  assert.equal(evaluate({ tier: "moderator" }, "players:read", docs), false, "an alias must not grant reads either");
});

test("every alias names only real, current actions", () => {
  const known = allKnownActions();
  for (const [alias, successors] of Object.entries(REMOVED_ACTION_ALIASES)) {
    assert.ok(successors.length, `${alias} has no successors`);
    for (const action of successors) {
      assert.ok(known.has(action), `${alias} points at ${action}, which is not in the catalog`);
    }
    assert.ok(!known.has(alias), `${alias} is still in the catalog, so it is not actually removed`);
  }
});

test("an alias cannot shadow a live action", () => {
  // matchAction consults aliases LAST. If a future split reused a name that is
  // both an alias and a live action, the live meaning must win.
  for (const action of allKnownActions()) {
    assert.ok(!REMOVED_ACTION_ALIASES[action], `${action} is both live and an alias`);
  }
  // And an alias pattern matches nothing outside its own successor list.
  assert.equal(matchAction("players:mutate", "bases:delete"), false);
  assert.equal(matchAction("players:mutate", "players:read"), false);
});

test("setPolicies refuses a removed action and names its successors", () => {
  const result = setPolicies(escalationDoc());
  assert.equal(result.ok, false);
  assert.match(result.error, /were split and no longer exist/);
  assert.match(result.error, /players:mutate \(now players:moderate/);
  assert.ok(result.deprecatedActions.some((entry) => entry.pattern === "players:mutate"));
  restoreDefaults();
});

test("a removed action is reported separately from one that never existed", () => {
  // Different problems, different fixes: one needs migrating, the other is a
  // typo that has never done anything.
  const docs = withAdmin([{ Effect: "Deny", Action: ["players:mutate", "players:reset-progression"] }]);
  assert.deepEqual(deprecatedActions(docs).map((e) => e.pattern), ["players:mutate"]);
  assert.deepEqual(unknownActions(docs).map((e) => e.pattern), ["players:reset-progression"]);
});

test("a stored policy naming a removed action loads, keeps its meaning, and says so", () => {
  // The upgrade path: accepted on load (so the operator's document is not
  // thrown away and not re-interpreted), refused on save (so they migrate).
  const root = writePolicyFile(escalationDoc());
  try {
    const result = loadPolicies(root);
    assert.equal(result.source, "file");
    assert.deepEqual(result.unknownActions, [], "a removed action is not an unknown action");
    assert.ok(result.deprecatedActions.some((e) => e.pattern === "guilds:mutate"));
    assert.ok(result.deprecatedActions[0].successors.length, "the notice must carry the successors");
    // Still enforced with its original meaning, from the file on disk.
    assert.equal(evaluate({ tier: "moderator" }, "guilds:disband"), false);
    assert.equal(evaluate({ tier: "moderator" }, "players:reset"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    restoreDefaults();
  }
});

test("server.js reports removed actions at startup", () => {
  assert.match(serverSrc, /for \(const \{ tier, pattern, successors \} of policyLoad\.deprecatedActions \|\| \[\]\)/);
  assert.match(serverSrc, /which was split into/);
});

test("an alias cannot be granted to an API key", () => {
  // Aliases live outside the catalog on purpose, so the key scope model never
  // offers one and normalizeScopes drops it.
  for (const alias of Object.keys(REMOVED_ACTION_ALIASES)) {
    assert.deepEqual(normalizeScopes({ [alias.split(":")[0]]: [alias] }), {}, alias);
    assert.equal(keyAllows({ scopes: { players: [alias] } }, "players:reset"), false);
  }
});
