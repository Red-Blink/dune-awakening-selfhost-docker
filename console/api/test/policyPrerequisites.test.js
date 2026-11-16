// A role may only be given actions in an area it can already open.
//
// Granting server:stop to a role without server:read hands it a control on an
// area whose status it cannot read: the page opens (any one grant opens it) but
// is empty or erroring, and the operator who saved it believes access works.
// setPolicies refuses the save and names the read grant to add first.

import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICIES, evaluate, missingPrerequisites, setPolicies, loadPolicies } from "../src/policy.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const owner = { version: 1, tier: "owner", statements: [{ Effect: "Allow", Action: "*" }] };
const docsFor = (statements) => ({ owner, moderator: { version: 1, tier: "moderator", statements } });
const allow = (...Action) => ({ Effect: "Allow", Action });

test.afterEach(() => { loadPolicies(join(here, "__no_such_repo_root__")); });

test("a write action without its area's read grant is refused, naming the read grant", () => {
  const result = setPolicies(docsFor([allow("server:stop")]));
  assert.equal(result.ok, false);
  assert.match(result.error, /cannot be given actions in an area it cannot open/);
  assert.match(result.error, /moderator: grant server:read first, or remove server:stop/);
  assert.deepEqual(result.missingPrerequisites, [{ tier: "moderator", read: "server:read", actions: ["server:stop"] }]);
});

test("the same grant saves once the role is granted the area first", () => {
  assert.equal(setPolicies(docsFor([allow("server:read", "server:stop")])).ok, true);
});

test("a read grant held through a wildcard satisfies the rule", () => {
  assert.equal(setPolicies(docsFor([allow("guilds:*")])).ok, true);
});

test("an explicit Deny on the read action makes the role's other grants in that area refused", () => {
  const result = setPolicies(docsFor([allow("players:read", "players:moderate"), { Effect: "Deny", Action: ["players:read"] }]));
  assert.equal(result.ok, false);
  assert.match(result.error, /grant players:read first/);
});

test("every area is reported once per tier, with all of its dependent actions", () => {
  const unmet = missingPrerequisites(docsFor([allow("players:moderate", "players:teleport", "bases:read")]));
  assert.equal(unmet.length, 1);
  assert.equal(unmet[0].read, "players:read");
  assert.deepEqual(unmet[0].actions.sort(), ["players:moderate", "players:teleport"]);
});

test("areas that have no read action are not affected", () => {
  assert.equal(setPolicies(docsFor([allow("community:suggest-translation", "admin:broadcast")])).ok, true);
});

test("nested areas require their own read action, not the parent's", () => {
  const result = setPolicies(docsFor([allow("admin:motd:write")]));
  assert.equal(result.ok, false);
  assert.equal(result.missingPrerequisites[0].read, "admin:motd:read");
  assert.equal(setPolicies(docsFor([allow("admin:motd:read", "admin:motd:write")])).ok, true);
});

test("the shipped default tiers satisfy the rule, so no default is refused on re-save", () => {
  assert.deepEqual(missingPrerequisites(DEFAULT_POLICIES), []);
  assert.equal(setPolicies(DEFAULT_POLICIES).ok, true);
});

test("the owner's wildcard grants satisfy the rule", () => {
  assert.deepEqual(missingPrerequisites({ owner }), []);
});

test("a refused save changes nothing, and a stored violating document still evaluates (rule is save-time only)", () => {
  const violating = docsFor([allow("server:stop")]);
  assert.equal(setPolicies(violating).ok, false);
  // The engine itself is unchanged: a document stored before this rule keeps its meaning.
  assert.equal(evaluate({ tier: "moderator" }, "server:stop", violating), true);
});
