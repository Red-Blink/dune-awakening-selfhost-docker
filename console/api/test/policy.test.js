import assert from "node:assert/strict";
import test from "node:test";
import { actionForRoute } from "../src/actions.js";
import { evaluate, matchAction, resolveAllowedActions, setPolicies } from "../src/policy.js";

test("policy matching supports exact and namespace wildcards", () => {
  assert.equal(matchAction("players:read", "players:read"), true);
  assert.equal(matchAction("players:*", "players:kick"), true);
  assert.equal(matchAction("players:*", "server:read"), false);
});

test("explicit deny overrides allow, including for owner", () => {
  const policies = {
    owner: {
      version: 1,
      tier: "owner",
      statements: [
        { Effect: "Allow", Action: "*" },
        { Effect: "Deny", Action: "database:mutate" }
      ]
    }
  };
  assert.equal(evaluate({ tier: "owner" }, "server:read", policies), true);
  assert.equal(evaluate({ tier: "owner" }, "database:mutate", policies), false);
});

// bases:delete is a separate action from bases:mutate specifically so a
// custom policy can grant routine base mutations (refills, permission
// edits, cancelling a queued refill/delete -- all reversible) without also
// granting the one irreversible action. This proves that separation holds
// through the real evaluate()/matchAction() path, not just at resolution.
test("bases:delete can be withheld independently of bases:mutate", () => {
  const policies = {
    moderator: {
      version: 1,
      tier: "moderator",
      statements: [
        { Effect: "Allow", Action: ["bases:read", "bases:mutate"] },
        { Effect: "Deny", Action: "bases:delete" }
      ]
    }
  };
  assert.equal(evaluate({ tier: "moderator" }, "bases:mutate", policies), true);
  assert.equal(evaluate({ tier: "moderator" }, "bases:delete", policies), false);

  // The reverse also holds: a namespace wildcard (the shipped admin/owner
  // default) still covers the new action without any policy change, so
  // existing installs keep exactly the access they already had.
  const wildcardPolicies = { admin: { version: 1, tier: "admin", statements: [{ Effect: "Allow", Action: "bases:*" }] } };
  assert.equal(evaluate({ tier: "admin" }, "bases:delete", wildcardPolicies), true);
});

// bases:delete-item is separate from bases:mutate for a different reason than
// bases:delete: consent, not blast radius. Base inventory shipped read-only, so
// an operator whose policy already grants bases:mutate agreed to refills and
// permission edits and could not have agreed to item destruction -- folding it
// in would silently widen every existing narrow policy.
test("bases:delete-item can be withheld independently of bases:mutate", () => {
  const policies = {
    owner: { version: 1, tier: "owner", statements: [{ Effect: "Allow", Action: "*" }] },
    moderator: {
      version: 1,
      tier: "moderator",
      statements: [{ Effect: "Allow", Action: ["bases:read", "bases:mutate"] }]
    },
    admin: { version: 1, tier: "admin", statements: [{ Effect: "Allow", Action: "bases:*" }] }
  };
  assert.equal(setPolicies(policies).ok, true);
  // Granting bases:mutate alone must not carry item deletion with it.
  assert.equal(evaluate({ tier: "moderator" }, "bases:mutate", policies), true);
  assert.equal(evaluate({ tier: "moderator" }, "bases:delete-item", policies), false);
  // The shipped wildcard policies are unaffected.
  assert.equal(evaluate({ tier: "admin" }, "bases:delete-item", policies), true);
});

// Same argument as the delete above, read in the other direction: a
// bases:mutate grant predates any ability to put items into a base at all, so
// it cannot be read as consent to fabricate them.
test("bases:add-item can be withheld independently of bases:mutate", () => {
  const policies = {
    owner: { version: 1, tier: "owner", statements: [{ Effect: "Allow", Action: "*" }] },
    moderator: {
      version: 1,
      tier: "moderator",
      statements: [{ Effect: "Allow", Action: ["bases:read", "bases:mutate", "bases:delete-item"] }]
    },
    admin: { version: 1, tier: "admin", statements: [{ Effect: "Allow", Action: "bases:*" }] }
  };
  assert.equal(setPolicies(policies).ok, true);
  // Even a policy that already grants the sibling destructive action does not
  // carry creation with it -- the two are independently grantable.
  assert.equal(evaluate({ tier: "moderator" }, "bases:delete-item", policies), true);
  assert.equal(evaluate({ tier: "moderator" }, "bases:add-item", policies), false);
  assert.equal(evaluate({ tier: "admin" }, "bases:add-item", policies), true);
});

// This assertion is the only real gate on the new route's IAM entry.
// rbacParity's extractRoutes cannot see a `path.match(...) && req.method`
// route, and an unmatched POST under /api/bases/ falls through to the
// bases:mutate prefix rule -- so a missing pattern entry would be silently
// permissive rather than failing closed.
test("the container item add route resolves to bases:add-item without shadowing its neighbours", () => {
  assert.equal(actionForRoute("/api/bases/5/containers/9/items", "POST"), "bases:add-item");
  // Every other base POST keeps the shared mutate bucket.
  assert.equal(actionForRoute("/api/bases/5/refill-generators", "POST"), "bases:mutate");
  assert.equal(actionForRoute("/api/bases/5/refill-water", "POST"), "bases:mutate");
  assert.equal(actionForRoute("/api/bases/5/permissions", "PUT"), "bases:mutate");
  // The sibling delete is unaffected: its path carries a trailing item id, so
  // the two patterns cannot match the same request.
  assert.equal(actionForRoute("/api/bases/5/containers/9/items/77", "DELETE"), "bases:delete-item");
});

test("the container item delete route resolves to bases:delete-item without shadowing its neighbours", () => {
  assert.equal(actionForRoute("/api/bases/5/containers/9/items/77", "DELETE"), "bases:delete-item");
  // The base delete and the cancellation routes must keep their own actions --
  // the new pattern sits alongside them, it does not swallow them.
  assert.equal(actionForRoute("/api/bases/5", "DELETE"), "bases:delete");
  assert.equal(actionForRoute("/api/bases/5/queued-delete", "DELETE"), "bases:mutate");
  assert.equal(actionForRoute("/api/bases/5/queued-refill", "DELETE"), "bases:mutate");
  // Reading a container's slots stays an ordinary base read.
  assert.equal(actionForRoute("/api/bases/5/containers/9", "GET"), "bases:read");
});

// Same argument as the container routes above: rbacParity only proves an
// action exists, not that it is the right one. Without the explicit
// ROUTE_ACTIONS entry this POST falls through the "POST /api/bases/" prefix
// rule to bases:mutate, which would silently let every per-base-refill grant
// retune the global automation policy.
test("the auto-refill settings routes resolve to their own actions without shadowing their neighbours", () => {
  assert.equal(actionForRoute("/api/bases/auto-refill/settings", "POST"), "bases:write-config");
  assert.equal(actionForRoute("/api/bases/auto-refill/settings", "GET"), "bases:read");
  // The per-base enrollment toggle keeps the shared mutate bucket, and the
  // enrollment read keeps bases:read -- the new paths sit beside them.
  assert.equal(actionForRoute("/api/bases/5/auto-refill", "POST"), "bases:mutate");
  assert.equal(actionForRoute("/api/bases/5/auto-refill-water", "POST"), "bases:mutate");
  assert.equal(actionForRoute("/api/bases/auto-refill", "GET"), "bases:read");
  assert.equal(actionForRoute("/api/bases/auto-refill-water", "GET"), "bases:read");
});

test("bases:write-config is not carried by a bases:mutate grant", () => {
  const policies = {
    moderator: { version: 1, tier: "moderator", statements: [{ Effect: "Allow", Action: ["bases:read", "bases:mutate"] }] }
  };
  // A hand-authored policy that predates the settings surface must not gain it.
  assert.equal(evaluate({ tier: "moderator" }, "bases:mutate", policies), true);
  assert.equal(evaluate({ tier: "moderator" }, "bases:write-config", policies), false);
  // The shipped tiers grant bases:*, so default access is unchanged.
  assert.equal(evaluate({ tier: "admin" }, "bases:write-config"), true);
  assert.equal(evaluate({ tier: "owner" }, "bases:write-config"), true);
});

test("vehicle permission routes resolve to their own read/mutate actions", () => {
  assert.equal(actionForRoute("/api/vehicles/5/permissions", "GET"), "vehicles:read");
  assert.equal(actionForRoute("/api/vehicles/5/permissions", "PUT"), "vehicles:mutate");
  assert.equal(actionForRoute("/api/vehicles/permission-candidates", "GET"), "vehicles:read");
  assert.equal(actionForRoute("/api/vehicles", "GET"), "vehicles:read");
  // Reading a vehicle's cargo hold stays an ordinary vehicle read -- it
  // resolves through the method-agnostic "/api/vehicles/" prefix rule rather
  // than an entry of its own, which is exactly why it is pinned here.
  assert.equal(actionForRoute("/api/vehicles/5/storage", "GET"), "vehicles:read");
});

test("vehicle cargo deletion resolves to its own actions, not vehicles:mutate", () => {
  assert.equal(actionForRoute("/api/vehicles/5/storage/items/77", "DELETE"), "vehicles:delete-item");
  assert.equal(actionForRoute("/api/vehicles/5/storage/items", "DELETE"), "vehicles:bulk-delete-items");
  assert.equal(actionForRoute("/api/vehicles/5/storage/all-items", "DELETE"), "vehicles:bulk-delete-items");
  // Reading the hold is unaffected by its new destructive siblings.
  assert.equal(actionForRoute("/api/vehicles/5/storage", "GET"), "vehicles:read");
  // And whole-vehicle delete still resolves to its own action.
  assert.equal(actionForRoute("/api/vehicles/5", "DELETE"), "vehicles:delete");
});

test("vehicles:delete-item can be withheld independently of vehicles:mutate", () => {
  const policies = {
    moderator: {
      version: 1,
      tier: "moderator",
      statements: [{ Effect: "Allow", Action: ["vehicles:read", "vehicles:mutate"] }]
    }
  };
  // An operator who granted vehicles:mutate for roster edits and refuels never
  // consented to destroying cargo.
  assert.equal(evaluate({ tier: "moderator" }, "vehicles:mutate", policies), true);
  assert.equal(evaluate({ tier: "moderator" }, "vehicles:delete-item", policies), false);
  assert.equal(evaluate({ tier: "moderator" }, "vehicles:bulk-delete-items", policies), false);
});

test("granting single-item cargo delete carries neither bulk delete nor whole-vehicle delete", () => {
  const policies = {
    moderator: {
      version: 1,
      tier: "moderator",
      statements: [{ Effect: "Allow", Action: ["vehicles:read", "vehicles:delete-item"] }]
    }
  };
  assert.equal(evaluate({ tier: "moderator" }, "vehicles:delete-item", policies), true);
  assert.equal(evaluate({ tier: "moderator" }, "vehicles:bulk-delete-items", policies), false);
  // The dangerous direction: item deletion must never imply destroying the
  // whole vehicle.
  assert.equal(evaluate({ tier: "moderator" }, "vehicles:delete", policies), false);
});

test("the vehicle cargo actions share no prefix a -* wildcard could bridge", () => {
  // Issue #351's lesson, mirrored: "vehicles:delete-item*" written to grant
  // single-item delete must not silently grant bulk as well.
  assert.equal(matchAction("vehicles:delete-item*", "vehicles:delete-item"), true);
  assert.equal(matchAction("vehicles:delete-item*", "vehicles:bulk-delete-items"), false);
  assert.equal(matchAction("vehicles:delete-*", "vehicles:delete-item"), true);
  assert.equal(matchAction("vehicles:delete-*", "vehicles:bulk-delete-items"), false);
  // Neither cargo action implies whole-vehicle delete, in either direction.
  assert.equal(matchAction("vehicles:delete-item", "vehicles:delete"), false);
  assert.equal(matchAction("vehicles:delete", "vehicles:delete-item"), false);
  // The admin namespace grant still covers all three, as it must.
  assert.equal(matchAction("vehicles:*", "vehicles:delete-item"), true);
  assert.equal(matchAction("vehicles:*", "vehicles:bulk-delete-items"), true);
});

test("a vehicles:read-only policy denies vehicles:mutate", () => {
  const policies = {
    observer: {
      version: 1,
      tier: "observer",
      statements: [{ Effect: "Allow", Action: ["vehicles:read"] }]
    }
  };
  assert.equal(evaluate({ tier: "observer" }, "vehicles:read", policies), true);
  assert.equal(evaluate({ tier: "observer" }, "vehicles:mutate", policies), false);
});

test("persisting a refreshed buyback log requires market write permission", () => {
  assert.equal(actionForRoute("/api/exchange/market/buyback/log", "GET"), "exchange:market");
  assert.equal(actionForRoute("/api/exchange/market/buyback/log", "POST"), "exchange:market-write");
});

test("removing the bot's NPC listings (unseed) requires market write permission", () => {
  assert.equal(actionForRoute("/api/exchange/market/seed/clear", "POST"), "exchange:market-write");
});

test("named seed-plan CSV import/export and active-plan changes require market write permission", () => {
  assert.equal(actionForRoute("/api/exchange/market/plans/csv", "GET"), "exchange:market");
  assert.equal(actionForRoute("/api/exchange/market/plans/csv", "POST"), "exchange:market-write");
  assert.equal(actionForRoute("/api/exchange/market/plans/active", "POST"), "exchange:market-write");
  assert.equal(actionForRoute("/api/exchange/market/plans/name", "POST"), "exchange:market-write");
});

// bases:give-item, bases:fill-item, and bases:bulk-delete-items follow the exact
// same consent precedent as bases:delete-item above: base inventory shipped
// read-only, so bases:mutate was never agreed to cover item creation or
// bulk/delete-all destruction either. Each gets its own action for the same
// reason -- a policy author narrowing one action must not implicitly narrow
// (or grant) the others.
test("bases:give-item, bases:fill-item, and bases:bulk-delete-items can each be withheld independently of bases:mutate", () => {
  const policies = {
    owner: { version: 1, tier: "owner", statements: [{ Effect: "Allow", Action: "*" }] },
    moderator: {
      version: 1,
      tier: "moderator",
      statements: [{ Effect: "Allow", Action: ["bases:read", "bases:mutate", "bases:delete-item"] }]
    },
    admin: { version: 1, tier: "admin", statements: [{ Effect: "Allow", Action: "bases:*" }] }
  };
  assert.equal(setPolicies(policies).ok, true);
  // Granting bases:mutate (and even bases:delete-item) alone must not carry
  // give/fill/bulk-delete with it -- each is deliberately its own grant.
  assert.equal(evaluate({ tier: "moderator" }, "bases:mutate", policies), true);
  assert.equal(evaluate({ tier: "moderator" }, "bases:delete-item", policies), true);
  assert.equal(evaluate({ tier: "moderator" }, "bases:give-item", policies), false);
  assert.equal(evaluate({ tier: "moderator" }, "bases:fill-item", policies), false);
  assert.equal(evaluate({ tier: "moderator" }, "bases:bulk-delete-items", policies), false);
  // The shipped wildcard policies are unaffected.
  assert.equal(evaluate({ tier: "admin" }, "bases:give-item", policies), true);
  assert.equal(evaluate({ tier: "admin" }, "bases:fill-item", policies), true);
  assert.equal(evaluate({ tier: "admin" }, "bases:bulk-delete-items", policies), true);
});

// Issue #351 (found during PR #349's own Layer 3 audit, Architect hat):
// matchAction() supports a "prefix-*" wildcard style where "X-*" matches any
// action starting with "X-". bases:delete-item and the old bases:delete-items
// name shared that exact string prefix, so "bases:delete-item*" matched
// BOTH -- a hand-authored policy using that wildcard style near
// bases:delete-item would have silently and non-obviously also granted
// bulk/delete-all destruction. Renamed to bases:bulk-delete-items, which
// shares no prefix with bases:delete-item, closing the gap. This test
// exists so a future rename cannot silently reopen it.
test("bases:delete-item and bases:bulk-delete-items share no string prefix a -* wildcard could collide on", () => {
  // Direct regression lock: this is the exact false-positive matchAction()
  // returned before the rename (verified against the old name during
  // investigation of issue #351).
  assert.equal(matchAction("bases:delete-item*", "bases:bulk-delete-items"), false);
  assert.equal(matchAction("bases:delete-item*", "bases:delete-item"), true, "the intended target of that wildcard must still match");

  // General form of the same guarantee: no "-*" wildcard built from either
  // action's own name can match the other -- proves this holds structurally,
  // not just for the one wildcard string above.
  const prefixWildcard = (action) => `${action.slice(0, -1)}*`;
  assert.equal(matchAction(prefixWildcard("bases:delete-item"), "bases:bulk-delete-items"), false);
  assert.equal(matchAction(prefixWildcard("bases:bulk-delete-items"), "bases:delete-item"), false);
});

test("base container give/fill/bulk-delete routes resolve to their own actions without shadowing their neighbours", () => {
  assert.equal(actionForRoute("/api/bases/5/containers/9/give-item", "POST"), "bases:give-item");
  assert.equal(actionForRoute("/api/bases/5/containers/9/give-items", "POST"), "bases:give-item");
  assert.equal(actionForRoute("/api/bases/5/containers/9/fill-item", "POST"), "bases:fill-item");
  assert.equal(actionForRoute("/api/bases/5/containers/9/items", "DELETE"), "bases:bulk-delete-items");
  assert.equal(actionForRoute("/api/bases/5/containers/9/all-items", "DELETE"), "bases:bulk-delete-items");
  // The existing single-item delete route and other base routes must be
  // unaffected by these new sibling patterns.
  assert.equal(actionForRoute("/api/bases/5/containers/9/items/77", "DELETE"), "bases:delete-item");
  assert.equal(actionForRoute("/api/bases/5", "DELETE"), "bases:delete");
  assert.equal(actionForRoute("/api/bases/5/containers/9", "GET"), "bases:read");
});

// resolveAllowedActions has no caller yet (planned for a future policy-editor
// UI), but it must already surface every action actionForRoute can resolve,
// not just the ones with an exact ROUTE_ACTIONS entry -- bases:delete only
// exists via the REGEX_ACTIONS_BY_METHOD_PATTERN tier (see actions.js), so
// this is the case an implementation reading ROUTE_ACTIONS alone would miss.
test("resolveAllowedActions surfaces an action that only exists via the regex-pattern resolution tier", () => {
  const policies = {
    owner: { version: 1, tier: "owner", statements: [{ Effect: "Allow", Action: "*" }] },
    moderator: {
      version: 1,
      tier: "moderator",
      statements: [
        { Effect: "Allow", Action: ["bases:read", "bases:mutate"] },
        { Effect: "Deny", Action: "bases:delete" }
      ]
    },
    admin: { version: 1, tier: "admin", statements: [{ Effect: "Allow", Action: "bases:*" }] }
  };
  assert.equal(setPolicies(policies).ok, true);

  const moderatorActions = resolveAllowedActions("moderator");
  assert.ok(moderatorActions.includes("bases:mutate"));
  assert.ok(!moderatorActions.includes("bases:delete"), "bases:delete is explicitly denied for moderator");

  // Confirms the wildcard-covered case reaches an action with no exact
  // ROUTE_ACTIONS entry at all -- not just an explicit grant/deny of it.
  const adminActions = resolveAllowedActions("admin");
  assert.ok(adminActions.includes("bases:delete"));
});

test("policy updates validate documents and preserve owner recovery access", () => {
  assert.equal(setPolicies({ owner: { tier: "owner", statements: [{ Effect: "Allow", Action: "*" }] } }).ok, true);
  assert.equal(setPolicies({ owner: { tier: "owner", statements: [{ Effect: "Maybe", Action: "*" }] } }).ok, false);
  assert.equal(setPolicies({ owner: { tier: "owner", statements: [{ Effect: "Deny", Action: "settings:write" }] } }).ok, false);
});
