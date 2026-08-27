// Mechanical gate for the API key scope vocabulary, in the spirit of
// rbacParity.test.js: the read/write classifier is only safe to rely on if it
// cannot silently drift as routes are added.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { allKnownActions } from "../src/policy.js";
import {
  EXTRA_READ_ACTIONS,
  KEY_DENIED_NAMESPACES,
  KEY_WRITE_DENIED_NAMESPACES,
  actionsByNamespace,
  isReadAction,
  namespaceHasWriteActions,
  namespaceOf,
  normalizeScopes,
  scopeCatalog,
  selectableNamespaces
} from "../src/apiKeyScopes.js";
import { keyAllows } from "../src/apiKeys.js";

test("every catalog action classifies as exactly one of read or write", () => {
  for (const action of allKnownActions()) {
    const read = isReadAction(action);
    assert.equal(typeof read, "boolean", `${action} did not classify`);
    assert.ok(namespaceOf(action), `${action} has no namespace`);
  }
});

test("EXTRA_READ_ACTIONS contains no action that has left the catalog", () => {
  const known = allKnownActions();
  for (const action of EXTRA_READ_ACTIONS) {
    assert.ok(known.has(action), `${action} is in EXTRA_READ_ACTIONS but not in the IAM catalog — renamed or removed?`);
  }
});

test("actions ending in :read are reads, at any depth", () => {
  assert.equal(isReadAction("bases:read"), true);
  assert.equal(isReadAction("admin:items:read"), true);
  assert.equal(isReadAction("admin:transfer-settings:read"), true);
  assert.equal(isReadAction("bases:mutate"), false);
  assert.equal(isReadAction("admin:motd:write"), false);
  assert.equal(isReadAction(""), false);
  assert.equal(isReadAction(null), false);
});

test("the two POST-shaped read exceptions are reachable by a read grant", () => {
  const exchange = { scopes: { exchange: "read" } };
  assert.equal(keyAllows(exchange, "exchange:read"), true);
  assert.equal(keyAllows(exchange, "exchange:market"), true, "a read-only market dashboard needs exchange:market");
  assert.equal(keyAllows(exchange, "exchange:market-write"), false);
  assert.equal(keyAllows(exchange, "exchange:write-config"), false);

  const updates = { scopes: { updates: "read" } };
  assert.equal(keyAllows(updates, "updates:check"), true, "a monitoring key needs updates:check");
  assert.equal(keyAllows(updates, "updates:apply"), false);
  assert.equal(keyAllows(updates, "updates:repair"), false);
});

test("carepackage:scan is a write despite its verb-shaped name", () => {
  // POST /api/care-package/run actually runs a grant cycle. The counter-case
  // to the two exceptions above: the name is not the test, the route is.
  assert.equal(isReadAction("carepackage:scan"), false);
  assert.equal(keyAllows({ scopes: { carepackage: "read" } }, "carepackage:scan"), false);
  assert.equal(keyAllows({ scopes: { carepackage: "write" } }, "carepackage:scan"), true);
});

test("logs, updates and addons are the only namespaces offering no write level", () => {
  // logs has no write action at all; updates has several but they are denied.
  // Both render a two-segment None/Read control.
  const namespaces = selectableNamespaces();
  const readOnly = new Set(["logs", ...KEY_WRITE_DENIED_NAMESPACES]);
  for (const namespace of readOnly) {
    assert.ok(namespaces.includes(namespace), `${namespace} should still be selectable, just not writable`);
    assert.equal(namespaceHasWriteActions(namespace), false, `${namespace} offers a write level it should not`);
  }
  for (const namespace of namespaces) {
    if (readOnly.has(namespace)) continue;
    assert.equal(namespaceHasWriteActions(namespace), true, `${namespace} reports no write actions`);
  }
});

test("a write-denied namespace cannot be promoted by a hand-edited store", () => {
  // normalizeScopes coerces this on save; keyAllows is the second check, for a
  // record that never went through normalizeScopes.
  const forged = { scopes: { updates: "write" } };
  assert.equal(keyAllows(forged, "updates:read"), true);
  assert.equal(keyAllows(forged, "updates:check"), true, "the monitoring read must survive the write denial");
  assert.equal(keyAllows(forged, "updates:apply"), false);
  assert.equal(keyAllows(forged, "updates:fix"), false);
  assert.equal(keyAllows(forged, "updates:repair"), false);
  assert.equal(keyAllows(forged, "updates:write-config"), false);
  assert.deepEqual(normalizeScopes({ updates: "write" }), { updates: "read" });
});

test("setup is denied outright, not merely write-denied", () => {
  // setup:read exposes configuration and setup:write rewrites .env, so unlike
  // updates there is no half of it worth granting.
  assert.ok(!selectableNamespaces().includes("setup"));
  const forged = { scopes: { setup: "read" } };
  assert.equal(keyAllows(forged, "setup:read"), false);
  assert.equal(keyAllows({ scopes: { setup: "write" } }, "setup:write"), false);
});

test("denied namespaces are absent from the selectable catalog entirely", () => {
  const namespaces = selectableNamespaces();
  for (const denied of KEY_DENIED_NAMESPACES) {
    assert.ok(!namespaces.includes(denied), `${denied} must never be offered as a key scope`);
    assert.ok(!actionsByNamespace().has(denied));
  }
  assert.equal(namespaces.length, 18);
});

test("scopeCatalog reports write support for the UI", () => {
  const byName = new Map(scopeCatalog().map((entry) => [entry.namespace, entry]));
  assert.equal(byName.get("logs").supportsWrite, false);
  assert.equal(byName.get("updates").supportsWrite, false);
  assert.equal(byName.get("players").supportsWrite, true);
  // A write-denied namespace lists no write actions at all, rather than
  // listing them as something the UI would have to render and disable.
  assert.deepEqual(byName.get("updates").writeActions, []);
  assert.ok(byName.get("updates").readActions.includes("updates:check"));
  assert.equal(byName.get("setup"), undefined);
  assert.ok(byName.get("players").readActions.includes("players:read"));
  // Individual kicks resolve through the "POST /api/players/" prefix rule to
  // players:mutate; players:kick appears only in an actions.js example comment.
  assert.ok(byName.get("players").writeActions.includes("players:mutate"));
  assert.ok(byName.get("players").writeActions.includes("players:kick-all"));
});

test("normalizeScopes drops rather than coerces anything unrecognised", () => {
  assert.deepEqual(normalizeScopes({ players: "read", bases: "write" }), { players: "read", bases: "write" });
  // A misspelled level must become None, never fall back to read.
  assert.deepEqual(normalizeScopes({ players: "readonly" }), {});
  assert.deepEqual(normalizeScopes({ players: true }), {});
  assert.deepEqual(normalizeScopes({ notARealNamespace: "read" }), {});
  assert.deepEqual(normalizeScopes({ settings: "write", database: "read" }), {});
  assert.deepEqual(normalizeScopes(null), {});
  assert.deepEqual(normalizeScopes([]), {});
  assert.deepEqual(normalizeScopes("players:read"), {});
});

test("a write level on logs stores as read, since no write action exists there", () => {
  assert.deepEqual(normalizeScopes({ logs: "write" }), { logs: "read" });
});

test("the key tier is not operator-controlled", () => {
  // keyAllows reads only `scopes`. A stored record carrying a tier — however
  // it got there — must not widen or narrow what the key can reach, or the
  // "one control" property is gone.
  const scoped = { scopes: { players: "read" } };
  for (const tier of ["owner", "admin", "moderator", "player", "observer", "nonsense"]) {
    const withTier = { ...scoped, tier };
    assert.equal(keyAllows(withTier, "players:read"), true, `tier ${tier} changed a granted read`);
    assert.equal(keyAllows(withTier, "players:mutate"), false, `tier ${tier} widened access`);
    assert.equal(keyAllows(withTier, "server:read"), false, `tier ${tier} widened access`);
  }
});

// Documentation parity. The scope table in docs/console/api-keys.md is the
// surface an operator reads to decide what to grant, and it has drifted from
// the catalog three times -- `players:kick`, `bases:delete-items` and
// `bases:refill-generators` were all written into it while existing only in an
// actions.js header comment. Nothing about a hand-maintained table stops that,
// so this asserts the shipped doc against scopeCatalog() directly.
test("the documented scope table matches the actual catalog", () => {
  const docPath = join(dirname(fileURLToPath(import.meta.url)), "../../../docs/console/api-keys.md");
  const doc = readFileSync(docPath, "utf8");

  const rows = [...doc.matchAll(/^\| `([a-z]+)` \| (.+?) \| (.+?) \|$/gm)]
    .map(([, namespace, read, write]) => ({ namespace, read, write }));
  assert.ok(rows.length > 0, "no scope table rows found in the doc — did the format change?");

  const catalog = scopeCatalog();
  assert.deepEqual(
    rows.map((row) => row.namespace),
    catalog.map((entry) => entry.namespace),
    "documented namespaces differ from scopeCatalog(), in content or order"
  );

  const cells = (value) => [...value.matchAll(/`([^`]+)`/g)].map(([, action]) => action);

  for (const [index, row] of rows.entries()) {
    const entry = catalog[index];
    assert.deepEqual(cells(row.read).sort(), [...entry.readActions].sort(),
      `documented read actions for ${row.namespace} do not match the catalog`);
    // Write cells are namespace-stripped in the doc for readability.
    const documentedWrites = cells(row.write).map((action) => `${row.namespace}:${action}`).sort();
    assert.deepEqual(documentedWrites, [...entry.writeActions].sort(),
      `documented write actions for ${row.namespace} do not match the catalog`);
  }
});

test("every action named anywhere in the API keys doc exists in the catalog", () => {
  // Catches an invented action outside the table too -- the prose sections name
  // actions as well.
  const docPath = join(dirname(fileURLToPath(import.meta.url)), "../../../docs/console/api-keys.md");
  const doc = readFileSync(docPath, "utf8");
  const known = allKnownActions();

  // Table rows are excluded: the previous test validates them properly, and
  // their write cells are deliberately namespace-stripped for readability
  // ("announcements:write" for admin:announcements:write), which would look
  // like an unknown action here.
  const prose = doc.split(/\r?\n/).filter((line) => !line.trimStart().startsWith("|")).join("\n");
  const named = new Set([...prose.matchAll(/`([a-z]+:[a-z0-9:-]+)`/g)].map(([, action]) => action));
  for (const action of named) {
    if (action.endsWith(":*")) continue;                 // wildcard prose, e.g. `settings:*`
    assert.ok(known.has(action), `${action} is named in docs/console/api-keys.md but is not a real action`);
  }

  // The scan above requires a colon, so a namespace-stripped name in prose --
  // `apply`, `fix`, `repair` -- went unchecked entirely. That is the same shape
  // as the three invented names that already shipped. Any bare backticked
  // lowercase token that pairs with a real namespace to form a real action is
  // treated as an action reference and verified; anything that pairs with
  // nothing is ordinary prose and ignored.
  const namespaces = new Set([...known].map((action) => action.split(":")[0]));
  const bare = new Set([...prose.matchAll(/`([a-z][a-z0-9-]*)`/g)].map(([, word]) => word));
  for (const word of bare) {
    if (namespaces.has(word)) continue;                  // a namespace, not an action suffix
    const couldBeAction = [...namespaces].some((ns) => known.has(`${ns}:${word}`));
    const isRealSuffix = [...known].some((action) => action.slice(action.indexOf(":") + 1) === word);
    assert.ok(!couldBeAction || isRealSuffix,
      `\`${word}\` reads as an action suffix in docs/console/api-keys.md but matches no real action`);
  }
});

test("no key can reach the addon bridge, which authorizes against the addon not the caller", () => {
  // POST /api/addons/installed/{id}/bridge resolves to addons:mutate, and the
  // handler checks the INSTALLED ADDON'S manifest permission. A key holding
  // addons:write could install an addon declaring `database: write` and run
  // arbitrary SQL through it, straight past KEY_DENIED_NAMESPACES.
  for (const level of ["read", "write"]) {
    const key = { scopes: { addons: level } };
    assert.equal(keyAllows(key, "addons:read"), level === "read" || level === "write");
    assert.equal(keyAllows(key, "addons:mutate"), false, `addons: ${level} reached the bridge`);
    assert.equal(keyAllows(key, "addons:install"), false, `addons: ${level} could install an addon`);
    assert.equal(keyAllows(key, "addons:update"), false);
  }
  assert.equal(namespaceHasWriteActions("addons"), false);
  assert.deepEqual(normalizeScopes({ addons: "write" }), { addons: "read" });
});

test("the uncached self-update check is out of reach of every key", () => {
  // updates:check is in EXTRA_READ_ACTIONS so a monitoring key can ask "is a
  // game update available" -- that route is absorbed by updateCheckCache.
  // check-stack runs selfUpdateCheck, which has no cache, so every call spawns
  // a subprocess. It gets its own write-classified action.
  assert.equal(isReadAction("updates:self-check"), false);
  for (const level of ["read", "write"]) {
    assert.equal(keyAllows({ scopes: { updates: level } }, "updates:self-check"), false,
      `updates: ${level} reached the uncached self-update check`);
  }
  // The cached game check stays reachable -- that is the point of the grant.
  assert.equal(keyAllows({ scopes: { updates: "read" } }, "updates:check"), true);
});
