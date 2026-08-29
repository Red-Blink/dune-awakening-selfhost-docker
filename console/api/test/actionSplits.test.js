// players:mutate and guilds:mutate, split by consequence.
//
// One action used to cover all 41 mutating method+path pairs under
// /api/players/ -- kick, ban, wipe a character's progression, delete items out
// of their inventory, mint currency, hand out max-level specializations. There
// was no way to grant kicking without also granting destruction, which is the
// exact argument that had already carved up bases: and vehicles: .
//
// The table below IS the specification. It is written out in full rather than
// derived from actions.js, so that a change to the mapping has to be made
// twice, deliberately -- deriving it from the thing under test would assert
// nothing.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { actionForRoute } from "../src/actions.js";
import { allKnownActions, evaluate } from "../src/policy.js";
import { keyAllows } from "../src/apiKeys.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(join(__dirname, "../src/server.js"), "utf8");

const ID = "12345";
const p = (suffix) => `/api/players/${ID}${suffix}`;

const EXPECTED = [
  ["POST", p("/kick"), "players:moderate"],
  ["POST", p("/ban"), "players:moderate"],
  ["DELETE", p("/ban"), "players:moderate"],

  ["POST", p("/teleport"), "players:teleport"],

  ["POST", p("/give-item"), "players:give-item"],
  ["POST", p("/give-item-id"), "players:give-item"],
  ["POST", p("/give-items"), "players:give-item"],
  ["POST", p("/augment-item"), "players:give-item"],
  ["POST", p("/spawn-vehicle"), "players:give-item"],

  ["POST", p("/add-currency"), "players:grant"],
  ["POST", p("/add-xp"), "players:grant"],
  ["POST", p("/add-intel"), "players:grant"],
  ["POST", p("/add-faction-reputation"), "players:grant"],
  ["POST", p("/faction"), "players:grant"],
  ["POST", p("/set-skill-points"), "players:grant"],
  ["POST", p("/set-skill-module"), "players:grant"],
  ["POST", p("/building-unlocks/grant"), "players:grant"],
  ["POST", p("/customizations/grant"), "players:grant"],
  ["POST", p("/crafting-recipes/unlock"), "players:grant"],
  ["POST", p("/research-items/unlock"), "players:grant"],
  ["POST", p("/specializations/add-xp"), "players:grant"],
  ["POST", p("/specializations/grant-max"), "players:grant"],
  ["POST", p("/specializations/keystones/grant-all"), "players:grant"],
  ["POST", p("/journey/complete"), "players:grant"],
  ["POST", p("/tutorials/complete"), "players:grant"],

  ["POST", p("/reset-progression"), "players:reset"],
  ["POST", p("/clean-inventory"), "players:reset"],
  ["POST", p("/journey/reset"), "players:reset"],
  ["POST", p("/tutorials/reset"), "players:reset"],
  ["POST", p("/specializations/reset"), "players:reset"],
  ["POST", p("/specializations/keystones/reset-all"), "players:reset"],

  ["DELETE", p("/inventory/999"), "players:delete-item"],
  ["PATCH", p("/inventory/999"), "players:edit-item"],

  ["POST", p("/repair-gear"), "players:repair"],
  ["POST", p("/repair-faction-reputation"), "players:repair"],
  ["POST", p("/repair-landsraad-quests"), "players:repair"],
  ["POST", p("/repair-login-queue"), "players:repair"],
  ["POST", p("/repair-vehicle-decay"), "players:repair"],
  ["POST", p("/refuel-vehicle"), "players:repair"],
  ["POST", p("/refill-water"), "players:repair"],

  ["POST", p("/character-recovery"), "players:recover"]
];

// ---- The mapping ----

test("players: every mutation resolves to its own narrow action", () => {
  for (const [method, path, action] of EXPECTED) {
    assert.equal(actionForRoute(path, method), action, `${method} ${path}`);
  }
});

test("players: no mutation falls through to the unclassified catch-all", () => {
  for (const [method, path] of EXPECTED) {
    assert.notEqual(actionForRoute(path, method), "players:unclassified", `${method} ${path} is unclassified`);
  }
});

test("players: the old players:mutate no longer exists", () => {
  // Removed rather than repurposed, so a hand-authored policy still naming it
  // is refused by setPolicies and warned about at startup, instead of quietly
  // continuing to mean something narrower than the operator intended.
  assert.ok(!allKnownActions().has("players:mutate"));
  const resolved = new Set(EXPECTED.map(([m, path]) => actionForRoute(path, m)));
  assert.ok(!resolved.has("players:mutate"));
});

// ---- The catch-all has to stay, and has to fail CLOSED ----

test("players: an unclassified mutation fails closed, not to players:read", () => {
  // The trap: REGEX_ACTIONS has a method-agnostic "/api/players/" ->
  // players:read fallback beneath the method-aware tier. Delete the method-aware
  // catch-all now that every route is named, and an unclassified POST resolves
  // to players:read -- authorizing a mutation under a READ-ONLY grant.
  for (const method of ["POST", "DELETE", "PATCH"]) {
    const action = actionForRoute(p("/some-route-added-later"), method);
    assert.equal(action, "players:unclassified", `${method} should hit the catch-all`);
    assert.notEqual(action, "players:read", `${method} must never resolve to a read action`);
  }
  // Reads still resolve to reads.
  assert.equal(actionForRoute(p("/ban"), "GET"), "players:read");
  assert.equal(actionForRoute(p("/inventory"), "GET"), "players:read");
});

test("players: no tier below admin can reach the catch-all", () => {
  for (const tier of ["moderator", "player", "observer"]) {
    assert.equal(evaluate({ tier }, "players:unclassified"), false);
  }
});

// ---- New routes cannot be added without classifying them ----

test("players: server.js has no mutation missing from the table", () => {
  // Extracts the dispatch lines rather than trusting the table to be complete.
  // A new POST/DELETE/PATCH route under /api/players/ fails here until it is
  // given an action and listed above.
  const found = new Set();
  const re = /path\.match\(\/\^(.*?)\$?\/\)([^\n]{0,120})/g;
  let m;
  while ((m = re.exec(serverSrc)) !== null) {
    const raw = m[1].split("\\/").join("/");
    if (!raw.startsWith("/api/players/")) continue;
    const method = /req\.method\s*===\s*"([A-Z]+)"/.exec(m[2])?.[1];
    if (!method || !["POST", "DELETE", "PATCH"].includes(method)) continue;
    found.add(`${method} ${raw.split("[^/]+").join("{id}")}`);
  }

  const listed = new Set(EXPECTED.map(([method, path]) =>
    `${method} ${path.replace(ID, "{id}").replace("/inventory/999", "/inventory/{id}")}`));

  // /ban carries no method in its dispatch condition (playerBanRoute switches
  // internally), so it never appears in `found` and is asserted separately.
  listed.delete("POST /api/players/{id}/ban");
  listed.delete("DELETE /api/players/{id}/ban");

  const missing = [...found].filter((route) => !listed.has(route));
  assert.deepEqual(missing, [], `player mutations in server.js with no entry in EXPECTED: ${missing.join(", ")}`);
  // Without this the assertion above passes vacuously if the extraction stops
  // matching -- a damaged escape in the split pattern makes it find zero routes
  // and cover nothing. 39, not 41: /ban carries no method in its dispatch and
  // is asserted separately.
  assert.equal(found.size, 39, "route extraction found an unexpected number of player mutations");
});

test("players: the ban route still multiplexes three methods on one path", () => {
  // If this dispatch ever grows an explicit method, the special-case above is
  // stale and the extraction test would silently stop covering it.
  assert.match(serverSrc, /if \(path\.match\(\/\^\\\/api\\\/players\\\/\[\^\/\]\+\\\/ban\$\/\)\) return playerBanRoute/);
  assert.match(serverSrc, /\["GET", "POST", "DELETE"\]\.includes\(req\.method \|\| "GET"\)/);
});

// ---- Naming (issue #351) ----

test("players: no action is a string prefix of another", () => {
  // policy.js matchAction supports an "X*" style where a pattern matches any
  // action starting with it. Two actions sharing a prefix mean a policy author
  // aiming at the narrower one can silently be granted the broader.
  const actions = [...allKnownActions()].filter((a) => a.startsWith("players:"));
  for (const a of actions) {
    for (const b of actions) {
      if (a === b) continue;
      assert.ok(!b.startsWith(a), `${b} starts with ${a}; a "${a}*" pattern would match both`);
    }
  }
});

// ---- Default policies are unchanged in effect ----

test("players: owner and admin still reach every action", () => {
  for (const action of [...allKnownActions()].filter((a) => a.startsWith("players:"))) {
    assert.equal(evaluate({ tier: "owner" }, action), true, `owner ${action}`);
    assert.equal(evaluate({ tier: "admin" }, action), true, `admin ${action}`);
  }
});

test("players: the split did not widen any tier below admin", () => {
  // moderator/player/observer held players:read (+ players:kick-all for
  // moderator) before the split and must hold exactly that after it. A refactor
  // of the vocabulary must not hand anyone a new capability.
  const playerActions = [...allKnownActions()].filter((a) => a.startsWith("players:"));
  const reachable = (tier) => playerActions.filter((a) => evaluate({ tier }, a)).sort();
  assert.deepEqual(reachable("moderator"), ["players:kick-all", "players:read"]);
  assert.deepEqual(reachable("player"), ["players:read"]);
  assert.deepEqual(reachable("observer"), ["players:read"]);
});

test("players: the narrow actions are independently grantable", () => {
  // The point of the whole change: kicking without destroying.
  const docs = {
    owner: { version: 1, tier: "owner", statements: [{ Effect: "Allow", Action: "*" }] },
    moderator: {
      version: 1,
      tier: "moderator",
      statements: [{ Effect: "Allow", Action: ["players:read", "players:moderate", "players:repair"] }]
    }
  };
  const can = (action) => evaluate({ tier: "moderator" }, action, docs);
  assert.equal(can("players:moderate"), true);
  assert.equal(can("players:repair"), true);
  for (const withheld of ["players:reset", "players:delete-item", "players:edit-item",
                          "players:give-item", "players:grant", "players:recover",
                          "players:teleport", "players:unclassified"]) {
    assert.equal(can(withheld), false, `${withheld} must not ride along`);
  }
});

// ============================ guilds ============================
//
// DELETE /api/guilds/{guildId} is DISBAND -- it destroys the guild -- and it
// shared guilds:mutate with promoting a member. No way to let someone fix a
// roster without also letting them delete the guild.

const G = "guild-77";
const P = "player-42";

const GUILD_EXPECTED = [
  ["DELETE", `/api/guilds/${G}`, "guilds:disband"],
  ["POST", `/api/guilds/${G}/members`, "guilds:membership"],
  ["DELETE", `/api/guilds/${G}/members/${P}`, "guilds:membership"],
  ["POST", `/api/guilds/${G}/members/${P}/promote`, "guilds:rank"],
  ["POST", `/api/guilds/${G}/members/${P}/demote`, "guilds:rank"]
];

test("guilds: every mutation resolves to its own narrow action", () => {
  for (const [method, path, action] of GUILD_EXPECTED) {
    assert.equal(actionForRoute(path, method), action, `${method} ${path}`);
  }
});

test("guilds: disband is distinguished from removing one member", () => {
  // Both are DELETE under /api/guilds/, and the variable segment comes BEFORE
  // the part that tells them apart -- so a startsWith prefix rule cannot
  // separate them and anchored regexes are required. Same shape as bases:delete.
  assert.equal(actionForRoute(`/api/guilds/${G}`, "DELETE"), "guilds:disband");
  assert.equal(actionForRoute(`/api/guilds/${G}/members/${P}`, "DELETE"), "guilds:membership");
  assert.notEqual(actionForRoute(`/api/guilds/${G}`, "DELETE"),
    actionForRoute(`/api/guilds/${G}/members/${P}`, "DELETE"));
});

test("guilds: the old guilds:mutate no longer exists", () => {
  assert.ok(!allKnownActions().has("guilds:mutate"));
  const resolved = new Set(GUILD_EXPECTED.map(([m, path]) => actionForRoute(path, m)));
  assert.ok(!resolved.has("guilds:mutate"));
});

test("guilds: an unclassified mutation fails closed, not to guilds:read", () => {
  for (const method of ["POST", "DELETE"]) {
    const action = actionForRoute(`/api/guilds/${G}/some-route-added-later`, method);
    assert.equal(action, "guilds:unclassified", `${method} should hit the catch-all`);
    assert.notEqual(action, "guilds:read", `${method} must never resolve to a read action`);
  }
  assert.equal(actionForRoute(`/api/guilds/${G}/members`, "GET"), "guilds:read");
  assert.equal(actionForRoute(`/api/guilds/${G}`, "GET"), "guilds:read");
});

test("guilds: server.js has no mutation missing from the table", () => {
  const found = new Set();
  const re = /path\.match\(\/\^(.*?)\$?\/\)([^\n]{0,120})/g;
  let m;
  while ((m = re.exec(serverSrc)) !== null) {
    const raw = m[1].split("\\/").join("/");
    if (!raw.startsWith("/api/guilds/")) continue;
    const method = /req\.method\s*===\s*"([A-Z]+)"/.exec(m[2])?.[1];
    if (!method || !["POST", "DELETE", "PATCH", "PUT"].includes(method)) continue;
    found.add(`${method} ${raw.split("[^/]+").join("{id}")}`);
  }
  const listed = new Set(GUILD_EXPECTED.map(([method, path]) =>
    `${method} ${path.split(G).join("{id}").split(P).join("{id}")}`));
  const missing = [...found].filter((route) => !listed.has(route));
  assert.deepEqual(missing, [], `guild mutations in server.js with no entry: ${missing.join(", ")}`);
  assert.equal(found.size, 5, "expected exactly 5 mutating guild routes");
});

test("guilds: no action is a string prefix of another", () => {
  // guilds:rank and guilds:read share "guilds:r" but neither prefixes the
  // other, so no "guilds:r*" pattern can be written aiming at one and silently
  // catch both by prefix matching.
  const actions = [...allKnownActions()].filter((a) => a.startsWith("guilds:"));
  for (const a of actions) {
    for (const b of actions) {
      if (a === b) continue;
      assert.ok(!b.startsWith(a), `${b} starts with ${a}`);
    }
  }
});

test("guilds: the split did not widen any tier below admin", () => {
  const guildActions = [...allKnownActions()].filter((a) => a.startsWith("guilds:"));
  const reachable = (tier) => guildActions.filter((a) => evaluate({ tier }, a)).sort();
  for (const tier of ["moderator", "player", "observer"]) {
    assert.deepEqual(reachable(tier), ["guilds:read"], tier);
  }
  for (const action of guildActions) {
    assert.equal(evaluate({ tier: "owner" }, action), true, `owner ${action}`);
    assert.equal(evaluate({ tier: "admin" }, action), true, `admin ${action}`);
  }
});

test("guilds: roster management is grantable without disbanding", () => {
  // The point of the change.
  const docs = {
    owner: { version: 1, tier: "owner", statements: [{ Effect: "Allow", Action: "*" }] },
    moderator: {
      version: 1,
      tier: "moderator",
      statements: [{ Effect: "Allow", Action: ["guilds:read", "guilds:membership", "guilds:rank"] }]
    }
  };
  const can = (action) => evaluate({ tier: "moderator" }, action, docs);
  assert.equal(can("guilds:membership"), true);
  assert.equal(can("guilds:rank"), true);
  assert.equal(can("guilds:disband"), false, "disband must not ride along with roster edits");
  assert.equal(can("guilds:unclassified"), false);
});

// ============================ blueprints ============================
//
// blueprints:mutate covered bulk export (a read), import (creation) and delete
// (destruction) with one grant.

const B = "bp-9";

const BLUEPRINT_EXPECTED = [
  ["POST", "/api/blueprints/export", "blueprints:export"],
  ["POST", "/api/blueprints/import", "blueprints:import"],
  ["DELETE", `/api/blueprints/${B}`, "blueprints:delete"]
];

test("blueprints: every mutation resolves to its own narrow action", () => {
  for (const [method, path, action] of BLUEPRINT_EXPECTED) {
    assert.equal(actionForRoute(path, method), action, `${method} ${path}`);
  }
  assert.ok(!allKnownActions().has("blueprints:mutate"));
});

test("blueprints: bulk export is not folded into the read grant", () => {
  // blueprintBulkExportRoute only reads (exportBlueprint per id, zipped), so it
  // was wrong to call it a mutation -- but one call pulls up to 500 blueprints,
  // so it is not blueprints:read either. Its own action, and blueprints:read
  // stays exactly as wide as it was.
  assert.equal(actionForRoute("/api/blueprints/export", "POST"), "blueprints:export");
  assert.notEqual(actionForRoute("/api/blueprints/export", "POST"), "blueprints:read");
  const docs = {
    owner: { version: 1, tier: "owner", statements: [{ Effect: "Allow", Action: "*" }] },
    player: { version: 1, tier: "player", statements: [{ Effect: "Allow", Action: ["blueprints:read"] }] }
  };
  assert.equal(evaluate({ tier: "player" }, "blueprints:export", docs), false,
    "a read-only grant must not gain bulk extraction");
  // The single-blueprint export stays a read, as it already was.
  assert.equal(actionForRoute(`/api/blueprints/${B}/export`, "GET"), "blueprints:read");
});

test("blueprints: delete is distinguished from a sub-resource path", () => {
  assert.equal(actionForRoute(`/api/blueprints/${B}`, "DELETE"), "blueprints:delete");
  assert.equal(actionForRoute(`/api/blueprints/${B}/parts/p1`, "DELETE"), "blueprints:unclassified");
});

test("blueprints: an unclassified mutation fails closed, not to blueprints:read", () => {
  for (const method of ["POST", "DELETE"]) {
    const action = actionForRoute(`/api/blueprints/${B}/added-later`, method);
    assert.equal(action, "blueprints:unclassified");
    assert.notEqual(action, "blueprints:read");
  }
});

// ============================ addons ============================
//
// addons:mutate covered uninstalling, enabling/disabling, AND the bridge --
// the route that runs whatever the addon's manifest declares, including SQL.

const A = "addon-x";

const ADDON_EXPECTED = [
  ["DELETE", `/api/addons/installed/${A}`, "addons:remove"],
  ["POST", `/api/addons/installed/${A}/bridge`, "addons:bridge"],
  ["POST", `/api/addons/installed/${A}/enable`, "addons:toggle"],
  ["POST", `/api/addons/installed/${A}/disable`, "addons:toggle"]
];

test("addons: every mutation resolves to its own narrow action", () => {
  for (const [method, path, action] of ADDON_EXPECTED) {
    assert.equal(actionForRoute(path, method), action, `${method} ${path}`);
  }
  assert.ok(!allKnownActions().has("addons:mutate"));
});

test("addons: the bridge is withheld separately from lifecycle control", () => {
  // The bridge authorizes against the installed addon's declared permission
  // rather than the caller, so "may enable an addon" must not imply "may run
  // whatever that addon declared".
  const docs = {
    owner: { version: 1, tier: "owner", statements: [{ Effect: "Allow", Action: "*" }] },
    admin: {
      version: 1,
      tier: "admin",
      statements: [{ Effect: "Allow", Action: ["addons:read", "addons:toggle", "addons:remove"] }]
    }
  };
  assert.equal(evaluate({ tier: "admin" }, "addons:toggle", docs), true);
  assert.equal(evaluate({ tier: "admin" }, "addons:remove", docs), true);
  assert.equal(evaluate({ tier: "admin" }, "addons:bridge", docs), false, "the bridge must not ride along");
});

test("addons: install and update keep their existing actions", () => {
  assert.equal(actionForRoute("/api/addons/community/install", "POST"), "addons:install");
  assert.equal(actionForRoute("/api/addons/community/update", "POST"), "addons:update");
});

test("addons: an unclassified mutation fails closed, not to addons:read", () => {
  for (const method of ["POST", "DELETE"]) {
    const action = actionForRoute(`/api/addons/installed/${A}/added-later`, method);
    assert.equal(action, "addons:unclassified");
    assert.notEqual(action, "addons:read");
  }
  assert.equal(actionForRoute(`/api/addons/installed/${A}/content/app.js`, "GET"), "addons:read");
});

test("addons: no key can reach any addon write, bridge included", () => {
  // `addons` is write-denied for keys, so none of the new actions are grantable
  // to one. Asserted here so a future split cannot quietly open that door.
  for (const [, , action] of ADDON_EXPECTED) {
    assert.equal(keyAllows({ scopes: { addons: "write" } }, action), false, action);
  }
  assert.equal(keyAllows({ scopes: { addons: "read" } }, "addons:read"), true);
});

// ---- Shared invariants across every split namespace ----

test("no action in a split namespace is a string prefix of another", () => {
  for (const ns of ["players", "guilds", "blueprints", "addons"]) {
    const actions = [...allKnownActions()].filter((a) => a.startsWith(`${ns}:`));
    for (const a of actions) {
      for (const b of actions) {
        if (a === b) continue;
        assert.ok(!b.startsWith(a), `${b} starts with ${a}`);
      }
    }
  }
});

test("every split namespace kept its unclassified sentinel out of the lower tiers", () => {
  for (const ns of ["players", "guilds", "blueprints", "addons"]) {
    for (const tier of ["moderator", "player", "observer"]) {
      assert.equal(evaluate({ tier }, `${ns}:unclassified`), false, `${tier} ${ns}`);
    }
    assert.equal(evaluate({ tier: "owner" }, `${ns}:unclassified`), true, `owner ${ns}`);
  }
});

test("no *:mutate action survives anywhere in the catalog", () => {
  // The four remaining :mutate actions are listed explicitly rather than
  // asserting "none", so this cannot pass by accident if a split regresses.
  // Each is a deliberate bucket, not an un-split leftover:
  //   bases:mutate     refills and permission edits; every destructive base
  //                    operation is already carved out around it
  //   vehicles:mutate  roster/custodian/refuel/repair; delete and item removal
  //                    are already separate
  //   database:mutate  the structured single-cell row edit, distinct from the
  //                    raw-SQL database:query / database:execute pair
  //   storage:mutate   POST /api/storage/{id}/give-item, the only storage write
  const mutates = [...allKnownActions()].filter((a) => a.endsWith(":mutate")).sort();
  assert.deepEqual(mutates, ["bases:mutate", "database:mutate", "storage:mutate", "vehicles:mutate"]);
});
