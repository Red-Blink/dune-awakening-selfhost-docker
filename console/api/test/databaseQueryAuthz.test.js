// POST /api/database/query authorizes on the SQL it was given, not just on its
// route.
//
// The route resolves to database:query, a read-shaped name the default admin
// policy grants. That same route also accepts UPDATE/DELETE/DROP, so before the
// split it made admin's explicit Deny on database:mutate and
// database:write-config decorative -- the narrow structured cell-edit was
// denied while arbitrary write SQL stayed reachable. Write SQL now needs
// database:execute on top, checked inside the handler once the body is parsed.
//
// server.js starts a listener on import, so handleApi and databaseQuery cannot
// be called from a test; the ordering assertions below are static analysis, the
// precedent set by apiKeyAuthWiring.test.js. The classifier invariant they rest
// on IS executed for real.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isReadOnlySql as gateClassifier } from "../src/runner.js";
import { isReadOnlySql as executionClassifier, hasExecutableStatement } from "../src/db.js";
import { allKnownActions, evaluate } from "../src/policy.js";
import { actionForRoute, CONTENT_CONDITIONAL_ACTIONS } from "../src/actions.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, "../src/server.js"), "utf8");

function functionBody(name) {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\)\\s*\\{`));
  assert.ok(match, `${name} not found in server.js`);
  const start = match.index + match[0].length;
  let depth = 1;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
    if (depth === 0) return source.slice(start, i);
  }
  assert.fail(`${name} body not closed`);
}

// Every assertion below runs against the body with comments REMOVED. Prose is
// not evidence: an ordering check that reads raw source can be satisfied (or
// broken) by a comment that happens to mention the call it is looking for,
// which is exactly what happened while writing this file.
// String-aware, not a pair of regexes: server.js contains
// `new URL(req.url, "http://localhost")`, and treating the // inside a string
// literal as a comment truncates that line and shifts every index after it.
// The bodies stripped here happen to contain no URLs today, so a naive version
// was correct by luck. apiKeyAuthWiring.test.js documents both failure modes
// this guards against, with the reproduction.
function codeOf(text) {
  let out = "";
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      out += ch;
      if (ch === "\\") { out += next ?? ""; i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; out += ch; continue; }
    if (ch === "/" && next === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

const body = codeOf(functionBody("databaseQuery"));
const at = (needle) => {
  const index = body.indexOf(needle);
  assert.ok(index >= 0, `expected to find ${needle} in databaseQuery`);
  return index;
};

// ---- The catalog ----

test("database:execute is in the action catalog", () => {
  // Not reachable from any route table, so allKnownActions has to pick it up
  // from CONTENT_CONDITIONAL_ACTIONS. An action missing from that set is
  // invisible to the API-key scope catalog and to any policy-authoring tool --
  // it could be named in a policy document with nothing to offer or validate it.
  assert.ok(CONTENT_CONDITIONAL_ACTIONS.includes("database:execute"));
  assert.ok(allKnownActions().has("database:execute"));
});

test("no route resolves to database:execute", () => {
  // The whole point of the split: the route stays database:query, and the
  // narrower action is reached only through the in-handler check. If some
  // future route table starts resolving to it, this design note is stale.
  assert.equal(actionForRoute("/api/database/query", "POST"), "database:query");
});

// ---- The default policies ----

test("owner may run write SQL, admin may not", () => {
  assert.equal(evaluate({ tier: "owner" }, "database:execute"), true);
  assert.equal(evaluate({ tier: "admin" }, "database:execute"), false);
});

test("admin keeps read SQL and export", () => {
  // The split must not cost admin the read half it legitimately had.
  assert.equal(evaluate({ tier: "admin" }, "database:query"), true);
  assert.equal(evaluate({ tier: "admin" }, "database:read"), true);
  assert.equal(evaluate({ tier: "admin" }, "database:export"), true);
});

test("the deny survives a widened allow list", () => {
  // The Deny on database:execute is redundant against the shipped admin Allow
  // list, which names database:read/query/export individually -- default-deny
  // already refuses it. Its value is against the tidy-up that collapses those
  // three into database:*. This asserts the Deny still wins in that world, so
  // the line is not dropped later as dead weight.
  const widened = {
    admin: {
      version: 1,
      tier: "admin",
      statements: [
        { Effect: "Allow", Action: ["database:*"] },
        { Effect: "Deny", Action: ["database:execute"] }
      ]
    }
  };
  assert.equal(evaluate({ tier: "admin" }, "database:query", widened), true);
  assert.equal(evaluate({ tier: "admin" }, "database:execute", widened), false);
});

test("the tiers below admin reach no part of the database namespace", () => {
  for (const tier of ["moderator", "player", "observer"]) {
    for (const action of ["database:read", "database:query", "database:execute", "database:export"]) {
      assert.equal(evaluate({ tier }, action), false, `${tier} should not hold ${action}`);
    }
  }
});

// ---- The handler ----

test("write SQL is authorized against database:execute", () => {
  assert.match(body, /if \(!readOnly && !requireAction\(req, res, "database:execute"\)\) return;/);
});

test("the authorization check runs before any side effect", () => {
  // An unauthorized write must not be able to tick the mutation rate limiter
  // (which would let a caller with no write permission starve one who has it)
  // or spawn the pre-write database backup (an unauthenticated-in-effect way to
  // make the host do expensive work on demand).
  const authzAt = at('requireAction(req, res, "database:execute")');
  assert.ok(authzAt < at('applyMutationRateLimit(req, res, "database.query.write")'),
    "the rate limiter must not tick for a caller that is about to be refused");
  assert.ok(authzAt < at('buildDuneArgs("backupCreate")'),
    "an unauthorized write must not trigger a full database backup");
  assert.ok(authzAt < at('audit(config, req, "database.query"'));
  assert.ok(authzAt < at("duneDb.runSql"));
});

test("the SQL is classified once and reused", () => {
  // Two calls could disagree about the same string, letting the authorization
  // answer and the execution answer diverge.
  const calls = body.match(/isReadOnlySql\(/g) || [];
  assert.equal(calls.length, 1, "databaseQuery must classify the query exactly once");
  assert.match(body, /const readOnly = isReadOnlySql\(query\);/);
});

test("a read-only request is executed with writes refused", () => {
  // Previously an unconditional `true`, which meant the read-only path ran with
  // destructive SQL permitted anyway.
  //
  // The classifier is no longer what stands between a SELECT grant and a DROP:
  // review showed `select dune.<fn>(...)` -- the shape every privileged
  // mutation in this app uses -- classifies read-only and sailed through. The
  // real enforcement is `enforceReadOnly`, which runs the read path inside a
  // `set transaction read only` transaction so Postgres refuses the write.
  //
  // This assertion only proves the CALL SHAPE. That the enforcement actually
  // works is proved behaviourally, against a real Postgres, in
  // databaseReadOnlyEnforcement.integration.test.js -- a source-text assertion
  // like this one would pass unchanged if the transaction did nothing.
  assert.match(body, /duneDb\.runSql\(db, query, !readOnly, \{ enforceReadOnly: true \}\)/);
  assert.ok(!/duneDb\.runSql\(db, query, true\)/.test(body),
    "runSql must not be called with an unconditional allowDestructive");
});

test("both caller-supplied SQL routes opt into read-only enforcement", () => {
  // enforceReadOnly defaults to OFF, so a route that forgets it silently gets
  // the old, bypassable behaviour. Internal callers pass server-built SQL and
  // deliberately do not enforce; these two take it from the caller and must.
  const query = codeOf(functionBody("databaseQuery"));
  const bridge = codeOf(functionBody("addonBridgeRoute"));
  for (const [name, fn] of [["databaseQuery", query], ["addonBridgeRoute", bridge]]) {
    assert.match(fn, /enforceReadOnly: true/, `${name} must enforce read-only on the read path`);
  }
});

test("requireAction re-runs both gates and fails closed", () => {
  const helper = codeOf(functionBody("requireAction"));
  assert.match(helper, /!evaluate\(session, action\)/, "the policy engine must be re-run");
  assert.match(helper, /apiKeys\.allows\(req\.authApiKey, action\)/, "the key scope map must be re-run");
  // A handler reached with no session at all must be refused, not waved through.
  assert.match(helper, /if \(!session \|\| !evaluate\(session, action\)\)/);
  assert.match(helper, /return false;/);
  // The gate has to have stashed the key for the second check to find it.
  assert.match(codeOf(source), /req\.authApiKey = bearer\?\.key \|\| null;/);
});

// ---- The invariant the handler's two classifiers rest on ----

test("the gate's classifier is never laxer than the execution classifier", () => {
  // databaseQuery decides with runner.js's isReadOnlySql and then hands
  // `!readOnly` to duneDb.runSql, which re-derives the answer with db.js's.
  // If runner's could ever call something read-only that db.js's calls a write,
  // runSql would throw on a query the route had just authorized. Asserted
  // functionally over a corpus rather than argued from reading the two regexes.
  const corpus = [
    "select 1",
    "SELECT * FROM dune.players",
    "  \n select 1",
    "with x as (select 1) select * from x",
    "show all",
    "explain select 1",
    "SeLeCt 1",
    // comments, the only place the two implementations actually differ
    "/* note */ select 1",
    "-- note\nselect 1",
    "select 1 -- delete",
    "select 1 /* delete from t */",
    "/* delete */ select 1",
    "select 1; -- drop table t",
    // writes
    "delete from dune.players",
    "update dune.players set name = 'x'",
    "drop table dune.players",
    "insert into t values (1)",
    "truncate t",
    "alter table t add column c int",
    "grant all on t to public",
    "copy t from '/tmp/x'",
    "with x as (insert into t values (1) returning *) select * from x",
    "select 1; drop table t",
    // degenerate
    "",
    "   ",
    "not sql at all"
  ];

  for (const query of corpus) {
    if (gateClassifier(query)) {
      assert.equal(
        executionClassifier(query),
        true,
        `gate authorized as read-only but execution would refuse: ${JSON.stringify(query)}`
      );
    }
  }
});

// ---- Input with nothing to execute never reaches the backup ----

test("hasExecutableStatement rejects exactly the inputs with nothing to run", () => {
  for (const empty of ["", "   ", "\n\t ", ";", ";;;", " ; ; ", "-- just a note", "/* commented out */",
                       "/* a */ /* b */", "-- one\n-- two", "/* x */ ; -- y"]) {
    assert.equal(hasExecutableStatement(empty), false, `should have nothing to run: ${JSON.stringify(empty)}`);
  }
  // Anything with a real token survives, including the cases the naive comment
  // stripping mangles but must never reject.
  for (const real of ["select 1", "delete from t", "SELECT '--'", "select '/* not a comment */'",
                      "-- lead\nselect 1", "/* lead */ delete from t", "select 1;", "vacuum", "do $$ begin end $$"]) {
    assert.equal(hasExecutableStatement(real), true, `should be runnable: ${JSON.stringify(real)}`);
  }
});

test("every input with nothing to run would otherwise have been treated as a write", () => {
  // This is the whole point: these classify as NOT read-only, so before the
  // guard they took the write path and spawned a pre-write backup.
  for (const empty of ["", "   ", ";", "-- just a note", "/* commented out */"]) {
    assert.equal(gateClassifier(empty), false);
    assert.equal(hasExecutableStatement(empty), false);
  }
});

test("both SQL routes guard before classifying", () => {
  // databaseQuery and the addon bridge each take a backup on the write path;
  // the guard has to come first in both, not just the one that was reported.
  for (const name of ["databaseQuery", "addonBridgeRoute"]) {
    const fn = codeOf(functionBody(name));
    const guardAt = fn.indexOf("hasExecutableStatement(query)");
    assert.ok(guardAt >= 0, `${name} is missing the empty-statement guard`);
    assert.ok(guardAt < fn.indexOf("isReadOnlySql(query)"), `${name} must guard before classifying`);
    assert.ok(guardAt < fn.indexOf('buildDuneArgs("backupCreate")'), `${name} must guard before the backup`);
  }
});

test("the isReadOnlySql refactor did not change any verdict", () => {
  // stripSqlComments was factored out of db.js's isReadOnlySql to be shared
  // with hasExecutableStatement. That function decides whether runSql permits
  // a write, so its verdicts are pinned here rather than assumed unchanged.
  const expected = [
    ["select 1", true], ["  select 1", true], ["/* c */ select 1", true], ["-- c\nselect 1", true],
    ["select 1 -- delete", true], ["with x as (select 1) select * from x", true],
    ["show all", true], ["explain select 1", true], ["SeLeCt 1", true],
    ["delete from t", false], ["update t set a=1", false], ["drop table t", false],
    ["insert into t values (1)", false], ["truncate t", false], ["alter table t add c int", false],
    ["grant all on t to public", false], ["revoke all on t from public", false],
    ["copy t from '/tmp/x'", false], ["with x as (insert into t values (1) returning *) select * from x", false],
    ["select 1; drop table t", false], ["", false], ["   ", false], ["vacuum", false]
  ];
  for (const [query, verdict] of expected) {
    assert.equal(executionClassifier(query), verdict, `db.js isReadOnlySql changed for ${JSON.stringify(query)}`);
  }
});

test("the corpus actually exercises both verdicts", () => {
  // Guards the test above against passing vacuously if gateClassifier ever
  // started returning false for everything.
  const verdicts = new Set(["select 1", "delete from t"].map((q) => gateClassifier(q)));
  assert.deepEqual([...verdicts].sort(), [false, true]);
});
