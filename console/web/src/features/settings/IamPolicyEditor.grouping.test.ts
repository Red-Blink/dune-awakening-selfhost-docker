import { describe, it, expect } from "vitest";

import { resolvedAllowedActions, nsFromAction, iamActionAllowed, actionGrantedByStatements, type PolicyStatement } from "./iamPolicy";

// Pins the two rules the IAM editor must mirror from console/api/src/policy.js
//: explicit Deny beats Allow, and grouping follows the IAM action's
// namespace rather than the URL path.
//
// These import the REAL helpers. The first draft re-implemented them here,
// which would have passed happily while the component drifted -- the exact
// tests-a-copy-not-the-code failure this session has been unpicking elsewhere.

const REGENERATE = "POST /api/auth/2fa/recovery-codes/regenerate";
const actionMap: Record<string, string> = {
  [REGENERATE]: "settings:regenerate-recovery-codes",
  "POST /api/settings/admin-password": "settings:change-password",
  "GET /api/care-package/capabilities": "carepackage:read",
};

describe("IAM editor mirrors the server's policy decision", () => {
  // This is the default admin policy's actual shape.
  const adminLike: PolicyStatement[] = [
    { Effect: "Allow", Action: ["setup:*", "server:*", "players:*"] },
    { Effect: "Deny", Action: ["settings:*"] },
  ];

  it("does not show a Deny'd action as granted", () => {
    const allowed = resolvedAllowedActions(
      ([{ Effect: "Allow", Action: ["*"] }, ...adminLike.filter((s) => s.Effect === "Deny")] as PolicyStatement[]),
      actionMap
    );
    expect(allowed.has(REGENERATE)).toBe(false);
    expect(allowed.has("POST /api/settings/admin-password")).toBe(false);
  });

  it("still grants what Allow covers and Deny does not", () => {
    const allowed = resolvedAllowedActions(adminLike, actionMap);
    expect(allowed.has("GET /api/care-package/capabilities")).toBe(false); // not in Allow
    expect(resolvedAllowedActions([{ Effect: "Allow", Action: ["carepackage:*"] }] as PolicyStatement[], actionMap)
      .has("GET /api/care-package/capabilities")).toBe(true);
  });

  it("owner's Allow * grants everything when nothing denies", () => {
    const allowed = resolvedAllowedActions([{ Effect: "Allow", Action: ["*"] }] as PolicyStatement[], actionMap);
    expect(allowed.has(REGENERATE)).toBe(true);
  });

  // The regression that put an owner-only credential permission under a card
  // headed "Care-package": the route's path segment is `auth`, its namespace is
  // `settings`, and only the latter is what policy.js evaluates.
  it("groups by the IAM action's namespace, not the URL path", () => {
    expect(nsFromAction(REGENERATE, actionMap)).toBe("settings");
    expect(nsFromAction(REGENERATE)).toBe("auth"); // the old, wrong derivation
    expect(nsFromAction("POST /api/settings/admin-password", actionMap)).toBe("settings");
  });
});

describe("iamActionAllowed mirrors the server matchAction wildcard forms", () => {
  it("matches the `-*` prefix form the server supports (regression: was rendered as un-matched)", () => {
    // players:reset-* is a documented server pattern. Before the fix the client
    // matcher ignored `-*`, so a Deny [players:reset-*] never applied in the grid.
    expect(iamActionAllowed("players:reset-progression", ["players:reset-*"])).toBe(true);
    expect(iamActionAllowed("players:kick", ["players:reset-*"])).toBe(false);
  });
  it("matches an embedded `*` via the same regex transform as the server", () => {
    expect(iamActionAllowed("bases:delete-item", ["bases:*-item"])).toBe(true);
    expect(iamActionAllowed("bases:delete", ["bases:*-item"])).toBe(false);
  });
  it("matches a bare namespace against `ns:*` (server: action === ns || startsWith(ns+':'))", () => {
    expect(iamActionAllowed("server", ["server:*"])).toBe(true);
    expect(iamActionAllowed("server:read", ["server:*"])).toBe(true);
    expect(iamActionAllowed("servers:read", ["server:*"])).toBe(false);
  });
  it("still handles `*`, exact, and non-matches", () => {
    expect(iamActionAllowed("anything:here", ["*"])).toBe(true);
    expect(iamActionAllowed("players:read", ["players:read"])).toBe(true);
    expect(iamActionAllowed("players:read", ["bases:read"])).toBe(false);
  });
});

// toggleAction's branch decision (grant vs. revoke) must be computed from the
// SAME statement list its text mutation operates on -- not a memo from the
// last completed render (review finding: after the first fix moved the text
// mutation itself to a functional setJsonText updater, the branch decision
// still read the outer, potentially-stale `allowedActions` memo. Two toggles
// of the same action fired before React re-renders between them -- e.g. a
// future bulk/"select all" loop -- would both branch on the same stale
// grant/deny state and could re-grant an action just revoked, or vice versa,
// instead of netting out correctly). actionGrantedByStatements is the single
// function both the grid's `allowedActions` memo and toggleAction's branch
// decision now share.
describe("actionGrantedByStatements reflects a specific statement list, not stale outer state", () => {
  it("is false, then true, as the SAME action is granted across two statement lists in sequence -- simulating chained toggles", () => {
    const before: PolicyStatement[] = [{ Effect: "Allow", Action: ["server:read"] }];
    expect(actionGrantedByStatements(before, "players:kick")).toBe(false);
    // A first toggle's mutation result: players:kick added to the Allow list.
    const afterFirstToggle: PolicyStatement[] = [{ Effect: "Allow", Action: ["server:read", "players:kick"] }];
    // A second toggle chained onto the first's result must see it as GRANTED
    // now (so it takes the revoke branch), not stale-false (which would
    // re-take the grant branch and leave it stuck granted).
    expect(actionGrantedByStatements(afterFirstToggle, "players:kick")).toBe(true);
  });

  it("an explicit Deny wins over an Allow in the same statement list", () => {
    const stmts: PolicyStatement[] = [
      { Effect: "Allow", Action: ["settings:*"] },
      { Effect: "Deny", Action: ["settings:write"] },
    ];
    expect(actionGrantedByStatements(stmts, "settings:write")).toBe(false);
    expect(actionGrantedByStatements(stmts, "settings:read")).toBe(true);
  });
});
