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

import { allKnownActions, evaluate, getAllPolicies, matchAction, setPolicies, unknownActions, loadPolicies } from "../src/policy.js";
import { actionForRoute } from "../src/actions.js";

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
  // ...and the route resolves to a real action that the Allow above DOES grant,
  // so the reset stayed reachable. That action was players:mutate when this
  // trap was found; the players:mutate split made it players:reset. Read from
  // actionForRoute rather than hardcoded, so a further split cannot make this
  // test quietly stop describing the live route.
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
  const before = evaluate({ tier: "admin" }, "players:mutate");
  setPolicies(withAdmin([{ Effect: "Deny", Action: ["players:reset-progression"] }]));
  assert.equal(evaluate({ tier: "admin" }, "players:mutate"), before,
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
