// Static analysis of server.js's auth gate. server.js starts a listener on
// import, so handleApi cannot be called from a test -- the precedent for
// asserting its shape is baseRouteStatus.test.js.
//
// The logic itself is unit-tested in apiKeys.test.js. What can only be checked
// here is the ORDERING, and ordering is the part that is silently exploitable
// if it regresses: a bearer request that reaches requireAuth is rejected on a
// missing CSRF token, and a bearer request that skips the scope check runs with
// full owner access.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rawSource = readFileSync(join(__dirname, "../src/server.js"), "utf8");

// Every assertion in this file reads server.js as TEXT, so a comment that
// happens to mention a call reads to indexOf exactly like the call itself.
// Both failure modes were reproduced against this file before it was changed:
//
//   false FAILURE  adding a comment above the gate that names
//                  apiKeys.allows(bearer.key, action) broke the ordering test
//                  while the code was still correct.
//   false PASS     deleting the isDiscordAdapterRoute(path) fork and leaving a
//                  comment that names it kept "the gate sits after ... the
//                  Discord adapter fork" green -- the test went on asserting a
//                  property that no longer existed.
//
// The second is the dangerous one, so comments are removed before anything is
// matched. String-aware on purpose: handleApi contains
// `new URL(req.url, "http://localhost")`, and a naive //-stripper truncates
// that line mid-body and shifts every index after it.
function stripComments(text) {
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

const source = stripComments(rawSource);

function handleApiBody() {
  const match = source.match(/async function handleApi\(req,\s*res\)\s*\{/);
  assert.ok(match, "handleApi not found in server.js");
  const start = match.index + match[0].length;
  let depth = 1;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
    if (depth === 0) return source.slice(start, i);
  }
  assert.fail("handleApi body not closed");
}

const body = handleApiBody();
const at = (needle) => {
  const index = body.indexOf(needle);
  assert.ok(index >= 0, `expected to find ${needle} in handleApi`);
  return index;
};

// The main gate, anchored on its full expression. handleApi calls
// auth.requireAuth twice -- the logout route above the gate uses it too -- so
// a bare indexOf("auth.requireAuth") would match the wrong one and make these
// ordering assertions pass vacuously.
const GATE = "const session = bearer?.session || auth.requireAuth(req, res);";

test("the comment stripper this file depends on actually works", () => {
  // Everything below asserts against stripped text, so a stripper that quietly
  // mangles server.js would degrade every other test in this file into
  // something weaker without failing. Checked against the real source, not a
  // toy string.
  assert.ok(rawSource.includes('new URL(req.url, "http://localhost")'), "precondition: the URL line exists");
  assert.ok(source.includes('new URL(req.url, "http://localhost")'),
    "a // inside a string literal was treated as a comment");
  assert.ok(rawSource.includes("// The main gate") || rawSource.includes("// Stashed for requireAction"),
    "precondition: server.js has line comments");
  assert.ok(!source.includes("// Stashed for requireAction"), "line comments are not removed");
  assert.ok(!/\/\*[\s\S]*?\*\//.test(source), "block comments are not removed");
  // Code either side of a stripped comment must survive intact.
  assert.ok(source.includes("req.authApiKey = bearer?.key || null;"));
  assert.ok(source.includes(GATE));

  const sample = stripComments([
    'const a = "http://x"; // trailing',
    "/* block */ const b = `t${1}`;",
    "const c = 'it\\'s';"
  ].join("\n"));
  assert.ok(sample.includes('const a = "http://x";'));
  assert.ok(!sample.includes("trailing"));
  assert.ok(!sample.includes("block"));
  assert.ok(sample.includes("const b = `t${1}`;"));
  assert.ok(sample.includes("const c = 'it\\'s';"), "an escaped quote ended the string early");
});

test("api key authentication runs before the session/CSRF gate", () => {
  assert.ok(
    at("apiKeys.authenticate(req)") < at(GATE),
    "requireAuth would reject a cookie-less bearer request on CSRF"
  );
});

test("an invalid bearer credential stops the request instead of falling through", () => {
  // Falling through to cookie auth would let a revoked or expired key ride a
  // logged-in browser session on the same machine.
  // The error branch now also counts and audits the failure, so this asserts
  // the property -- it returns before the gate -- rather than one exact line.
  assert.ok(body.includes("if (bearer?.error) {"), "the failed-credential branch is missing");
  assert.ok(body.includes("return json(res, bearer.status, { error: bearer.error })"), "the 401 return is missing");
  assert.ok(at("bearer?.error") < at(GATE));
  assert.ok(at("return json(res, bearer.status, { error: bearer.error })") < at(GATE),
    "the failed credential must return before requireAuth is reached");
});

test("the session is the bearer's when present, otherwise the cookie's", () => {
  assert.ok(body.includes(GATE));
  assert.match(body, /if \(!session\) return;/);
});

test("both the policy engine and the key scope gate the request", () => {
  const evaluateAt = at("!evaluate(session, action)");
  const scopeAt = at("apiKeys.allows(bearer.key, action)");
  assert.ok(at("actionForRoute(path, req.method)") < evaluateAt);
  assert.ok(evaluateAt < scopeAt, "the scope check must run after the action is resolved");
  assert.match(body, /if \(!apiKeys\.allows\(bearer\.key, action\)\) \{\s*\n\s*return json\(res, 403/);
});

test("key-authenticated requests are rate limited before doing any work", () => {
  const limitAt = at("apiKeyRateLimiter.record(bearer.key.id");
  assert.ok(limitAt < at(GATE));
  assert.match(body, /return json\(res, 429, \{ error: "This API key has exceeded[^"]*" \}, \{ "retry-after"/);
});

test("the gate sits after the public routes and the Discord adapter fork", () => {
  // Health, auth state, login and logout must stay reachable without a key,
  // and the Discord adapter keeps its own bearer scheme.
  assert.ok(at('path === "/api/health"') < at("apiKeys.authenticate(req)"));
  assert.ok(at('path === "/api/auth/login"') < at("apiKeys.authenticate(req)"));
  assert.ok(at("isDiscordAdapterRoute(path)") < at("apiKeys.authenticate(req)"));
});

test("api key management routes are registered and dispatched by prefix", () => {
  assert.match(body, /path === "\/api\/settings\/api-keys" && req\.method === "GET"/);
  assert.match(body, /path === "\/api\/settings\/api-keys" && req\.method === "POST"/);
  assert.match(body, /path === "\/api\/settings\/api-keys\/catalog" && req\.method === "GET"/);
  // startsWith, not path.match: rbacParity.test.js extracts the former.
  assert.match(body, /path\.startsWith\("\/api\/settings\/api-keys\/"\)/);
});

test("the catalog route is matched before the parameterized prefix", () => {
  assert.ok(
    at('path === "/api/settings/api-keys/catalog"') < at('path.startsWith("/api/settings/api-keys/")'),
    "the prefix dispatcher would swallow /catalog"
  );
});

test("key mutations are audited without key material", () => {
  for (const action of ["settings.api-key-create", "settings.api-key-update", "settings.api-key-revoke"]) {
    assert.ok(source.includes(action), `missing audit event ${action}`);
  }
  const auditCalls = source.match(/audit\(config, req, "settings\.api-key-[a-z]+", \{[^}]*\}/g) || [];
  assert.equal(auditCalls.length, 3);
  for (const call of auditCalls) {
    assert.ok(!/secret|hash/i.test(call), `audit call logs key material: ${call}`);
  }
});

test("a failed bearer credential is rate limited and audited", () => {
  // Previously the limiter sat inside `if (bearer)`, past the error return, and
  // no audit call existed on the 401 path -- a failed credential produced no
  // signal at all.
  assert.ok(body.includes("auth.api-key-failed"), "no audit event on the failed-credential path");
  const failAt = at("apiKeyAuthFailureLimiter.record(failureKey");
  const errorReturnAt = at("return json(res, bearer.status, { error: bearer.error })");
  assert.ok(failAt < errorReturnAt, "the failure must be counted before the 401 is returned");
  assert.match(body, /Too many failed API key attempts/);
});

test("a malformed key id returns 404 rather than throwing a 500", () => {
  // decodeURIComponent throws URIError on "%ZZ"; that surfaced as a 500 from an
  // authenticated admin route rather than the 404 the path already intends.
  const decodeAt = source.indexOf("id = decodeURIComponent(path.slice");
  assert.ok(decodeAt > 0, "the id decode was not found");
  const guarded = source.slice(decodeAt - 200, decodeAt + 300);
  assert.ok(guarded.includes("try {"), "the decode is not inside a try");
  assert.ok(guarded.includes("} catch {"), "the decode has no catch");
  assert.ok(guarded.includes("That API key no longer exists."), "the catch does not fall back to 404");
});

test("an api key cannot force a fresh update check", () => {
  // `fresh` bypasses the dedupe cache and spawns a subprocess per call, and
  // updates:check is reachable at READ level.
  assert.match(body, /const fresh = body\.fresh === true && !req\.authSession\?\.apiKeyId;/);
});

test("the addon bridge refuses an api key principal", () => {
  // Second lock behind the addons write-denial: the bridge authorizes against
  // the installed addon's manifest, never the caller, so relaxing that denial
  // must not silently reopen an arbitrary-SQL path.
  const bridgeAt = source.indexOf("async function addonBridgeRoute");
  assert.ok(bridgeAt > 0, "addonBridgeRoute not found");
  const head = source.slice(bridgeAt, bridgeAt + 900);
  assert.ok(head.includes("req.authSession?.apiKeyId"), "the bridge does not check for a key principal");
  assert.ok(head.includes("API keys cannot use the addon bridge"), "the bridge does not refuse key principals");
  // The guard must precede any addon work.
  assert.ok(head.indexOf("req.authSession?.apiKeyId") < head.indexOf("decodeURIComponent"),
    "the key-principal guard runs after the bridge has started work");
});

test("failed bearer attempts use their own limiter, and the per-attempt row stops at the cap", () => {
  // Counting failures in the per-key limiter let an unauthenticated caller
  // drain the shared ceiling and 429 every legitimate key. And auditing before
  // the 429 guard meant every attempt did a synchronous appendFileSync, which
  // is an unbounded disk write for anyone who can reach the port.
  assert.ok(source.includes("const apiKeyAuthFailureLimiter = createApiKeyRateLimiter("),
    "failed auth does not have its own limiter");
  assert.ok(body.includes("apiKeyAuthFailureLimiter.record(failureKey"),
    "the failure path still records into the per-key limiter");
  assert.ok(!body.includes("apiKeyRateLimiter.record(failureKey"),
    "the failure path shares the per-key limiter");

  // Two audit calls exist on this path now: a bounded throttle notice inside the
  // refused branch, and the per-attempt row on the allowed path. Only the second
  // must sit behind the guard, so name it exactly rather than matching the first.
  const guardAt = at('return json(res, 429, { error: "Too many failed API key attempts');
  const perAttemptAt = at('audit(config, req, "auth.api-key-failed", { reason: bearer.error });');
  assert.ok(guardAt < perAttemptAt, "the per-attempt audit runs before the 429 guard, so a capped caller keeps writing a row each time");
});

test("a throttled attacker still leaves a bounded audit trace", () => {
  // Returning before audit() bounded the disk write but made a sustained
  // attacker invisible for as long as they kept trying -- and since remoteIpOf
  // has no X-Forwarded-For, behind a proxy that is one bucket for everyone.
  assert.ok(source.includes("function shouldNoteApiKeyAuthThrottle"),
    "no throttle-notice gate: a capped bucket goes silent");
  assert.match(body, /if \(shouldNoteApiKeyAuthThrottle\(failureKey\)\) \{/);
  assert.match(body, /throttled: true/);

  // The notice must still sit inside the refused branch, before the 429.
  const noticeAt = at("shouldNoteApiKeyAuthThrottle(failureKey)");
  const refuseAt = at('return json(res, 429, { error: "Too many failed API key attempts');
  assert.ok(noticeAt < refuseAt, "the throttle notice must be emitted before the 429 returns");

  // And the per-attempt audit must remain on the allowed path only.
  const perAttemptAt = at('audit(config, req, "auth.api-key-failed", { reason: bearer.error });');
  assert.ok(refuseAt < perAttemptAt, "the per-attempt audit is still ahead of the 429 guard");
});

test("the throttle-notice map cannot grow without bound", () => {
  // The key space is attacker-controlled (one entry per source address).
  assert.match(source, /if \(apiKeyAuthThrottleNotices\.size > \d+\) \{/);
  assert.match(source, /apiKeyAuthThrottleNotices\.delete\(key\)/);
});
