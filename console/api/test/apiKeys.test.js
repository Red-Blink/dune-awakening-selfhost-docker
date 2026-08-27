import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  MAX_RATE_LIMIT_PER_MINUTE,
  bearerToken,
  createApiKeyStore,
  hashSecret,
  keyAllows,
  parseKey,
  publicKey
} from "../src/apiKeys.js";
import { selectableNamespaces } from "../src/apiKeyScopes.js";

function withStore(run, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "api-keys-"));
  const file = join(dir, "api-keys.json");
  try {
    return run(createApiKeyStore({ file, ...options }), file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function authHeaders(secret) {
  return { headers: { authorization: `Bearer ${secret}` } };
}

test("a created key round-trips through authenticate", async () => {
  await withStore(async (store) => {
    const created = await store.create({ name: "Grafana", scopes: { players: "read" } });
    const result = store.authenticate(authHeaders(created.secret));
    assert.equal(result.key.id, created.key.id);
    assert.equal(result.session.tier, "owner");
    assert.equal(result.session.apiKeyId, created.key.id);
  });
});

test("the secret is never stored and never leaves in a list response", async () => {
  await withStore(async (store, file) => {
    const created = await store.create({ name: "Grafana", scopes: { players: "read" } });
    const secretPart = parseKey(created.secret).secret;

    const raw = readFileSync(file, "utf8");
    assert.ok(!raw.includes(secretPart), "the raw secret reached disk");
    assert.ok(raw.includes(hashSecret(secretPart)), "the hash was not persisted");

    for (const listed of store.list()) {
      assert.ok(!("hash" in listed), "list() leaked the hash");
      assert.ok(!JSON.stringify(listed).includes(secretPart));
    }
    assert.ok(!("hash" in publicKey({ id: "a", hash: "h", scopes: {} })));
  });
});

test("the store file is written 0600", async () => {
  await withStore(async (store, file) => {
    await store.create({ name: "Grafana", scopes: { players: "read" } });
    const mode = statSync(file).mode & 0o777;
    if (process.platform === "win32") return; // POSIX modes are not meaningful here
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  });
});

test("read grants reach reads only; write grants reach everything in the namespace", async () => {
  await withStore(async (store) => {
    const reader = await store.create({ name: "Reader", scopes: { bases: "read" } });
    const writer = await store.create({ name: "Writer", scopes: { bases: "write" } });
    const r = store.authenticate(authHeaders(reader.secret)).key;
    const w = store.authenticate(authHeaders(writer.secret)).key;

    assert.equal(keyAllows(r, "bases:read"), true);
    assert.equal(keyAllows(r, "bases:mutate"), false);
    assert.equal(keyAllows(r, "bases:delete"), false);
    assert.equal(keyAllows(r, "bases:give-item"), false);

    assert.equal(keyAllows(w, "bases:read"), true);
    assert.equal(keyAllows(w, "bases:mutate"), true);
    assert.equal(keyAllows(w, "bases:delete"), true);

    // A grant on one namespace says nothing about another.
    assert.equal(keyAllows(w, "players:read"), false);
  });
});

test("a hand-edited store granting a denied namespace is still denied", () => {
  // The denied-namespace check runs before the scope lookup precisely so that
  // editing the JSON by hand cannot mint a key that can mint other keys.
  const forged = { scopes: { settings: "write", database: "write", players: "read" } };
  assert.equal(keyAllows(forged, "settings:read"), false);
  assert.equal(keyAllows(forged, "settings:write"), false);
  assert.equal(keyAllows(forged, "settings:change-password"), false);
  assert.equal(keyAllows(forged, "database:read"), false);
  assert.equal(keyAllows(forged, "database:query"), false);
  assert.equal(keyAllows(forged, "database:mutate"), false);
  // The legitimate part of the same record still works.
  assert.equal(keyAllows(forged, "players:read"), true);
});

test("a key created with no scopes reaches nothing, in any namespace", async () => {
  await withStore(async (store) => {
    const created = await store.create({ name: "Fresh" });
    assert.deepEqual(created.key.scopes, {}, "create seeded a default scope");
    const key = store.authenticate(authHeaders(created.secret)).key;

    // Every selectable namespace, not a sample: this is the default-deny claim.
    for (const namespace of selectableNamespaces()) {
      assert.equal(keyAllows(key, `${namespace}:read`), false, `${namespace}:read was reachable with no scopes`);
      assert.equal(keyAllows(key, `${namespace}:write`), false, `${namespace}:write was reachable with no scopes`);
    }
    assert.equal(keyAllows(key, "exchange:market"), false);
    assert.equal(keyAllows(key, "updates:check"), false);
  });
});

test("unrecognised namespaces and levels normalize to none, never to read", async () => {
  await withStore(async (store) => {
    const created = await store.create({
      name: "Typos",
      scopes: { players: "readonly", bases: "READ", notARealNamespace: "read", settings: "write" }
    });
    assert.deepEqual(created.key.scopes, {});
  });
});

test("updating scopes replaces wholesale, so omitting a namespace revokes it", async () => {
  await withStore(async (store) => {
    const created = await store.create({ name: "Multi", scopes: { players: "read", bases: "write", maps: "read" } });
    const updated = await store.update(created.key.id, { scopes: { players: "read" } });
    assert.deepEqual(updated.scopes, { players: "read" }, "a merge left a stale grant behind");

    const key = store.authenticate(authHeaders(created.secret)).key;
    assert.equal(keyAllows(key, "bases:read"), false);
    assert.equal(keyAllows(key, "maps:read"), false);
    assert.equal(keyAllows(key, "players:read"), true);
  });
});

test("an omitted scopes field on update leaves the existing grant alone", async () => {
  await withStore(async (store) => {
    const created = await store.create({ name: "Rename me", scopes: { players: "read" } });
    const updated = await store.update(created.key.id, { name: "Renamed" });
    assert.equal(updated.name, "Renamed");
    assert.deepEqual(updated.scopes, { players: "read" });
  });
});

test("disabled, expired, revoked and unknown keys are all refused", async () => {
  let clock = Date.parse("2026-08-26T00:00:00.000Z");
  await withStore(async (store) => {
    const created = await store.create({ name: "Lifecycle", scopes: { players: "read" } });
    assert.ok(store.authenticate(authHeaders(created.secret)).session);

    await store.update(created.key.id, { enabled: false });
    assert.deepEqual(store.authenticate(authHeaders(created.secret)), { error: "This API key is disabled.", status: 401 });

    await store.update(created.key.id, { enabled: true });
    assert.ok(store.authenticate(authHeaders(created.secret)).session, "re-enabling did not restore access");

    // A future expiry, then advance past it -- setting a past expiry directly is
    // now rejected, since it only ever produced a key that 401s immediately.
    await store.update(created.key.id, { expiresAt: "2026-08-27T00:00:00.000Z" });
    assert.ok(store.authenticate(authHeaders(created.secret)).session, "a future expiry should not expire the key yet");

    clock = Date.parse("2026-08-28T00:00:00.000Z");
    assert.deepEqual(store.authenticate(authHeaders(created.secret)), { error: "This API key has expired.", status: 401 });

    await store.update(created.key.id, { expiresAt: null });
    assert.ok(store.authenticate(authHeaders(created.secret)).session);

    await store.revoke(created.key.id);
    assert.deepEqual(store.authenticate(authHeaders(created.secret)), { error: "Invalid API key.", status: 401 });
  }, { now: () => clock });
});

test("malformed credentials are refused with one generic message", async () => {
  await withStore(async (store) => {
    const created = await store.create({ name: "Real", scopes: { players: "read" } });
    const generic = { error: "Invalid API key.", status: 401 };

    // A valid id with the wrong secret must not be distinguishable from an
    // id that does not exist at all.
    assert.deepEqual(store.authenticate(authHeaders(`dak_${created.key.id}_wrongsecretwrongsecretwrong`)), generic);
    assert.deepEqual(store.authenticate(authHeaders("dak_00000000_anything")), generic);
    assert.deepEqual(store.authenticate(authHeaders("dak_NOTHEX00_anything")), generic);
    assert.deepEqual(store.authenticate(authHeaders("dak_short")), generic);
    assert.deepEqual(store.authenticate(authHeaders("not-a-key")), generic);
  });
});

test("a request with no Authorization header falls through to cookie auth", async () => {
  await withStore(async (store) => {
    await store.create({ name: "Present", scopes: { players: "read" } });
    // null, not an error object: handleApi uses this to mean "not a key
    // request", so the browser session path stays untouched.
    assert.equal(store.authenticate({ headers: {} }), null);
    assert.equal(store.authenticate({ headers: { authorization: "" } }), null);
    assert.equal(store.authenticate({}), null);
    // A non-Bearer scheme is not a malformed key -- it is not a key at all, so
    // it must fall through rather than 401 a browser that sent something odd.
    assert.equal(store.authenticate({ headers: { authorization: "Basic dXNlcjpwYXNz" } }), null);
  });
});

test("the secret survives a reload from disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "api-keys-reload-"));
  const file = join(dir, "api-keys.json");
  try {
    const first = createApiKeyStore({ file });
    const created = await first.create({ name: "Durable", scopes: { players: "read" } });
    // Keys, unlike sessions, must outlive a console restart.
    const second = createApiKeyStore({ file });
    assert.equal(second.authenticate(authHeaders(created.secret)).key.id, created.key.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable store fails closed rather than authenticating anyone", () => {
  const dir = mkdtempSync(join(tmpdir(), "api-keys-corrupt-"));
  const file = join(dir, "api-keys.json");
  try {
    writeFileSync(file, "{ not json");
    const store = createApiKeyStore({ file });
    assert.deepEqual(store.list(), []);
    assert.deepEqual(store.authenticate(authHeaders("dak_00000000_whatever")), { error: "Invalid API key.", status: 401 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("last-used is buffered and flushed through the same queue as writes", async () => {
  let clock = Date.parse("2026-08-26T12:00:00.000Z");
  await withStore(async (store, file) => {
    const created = await store.create({ name: "Used", scopes: { players: "read" } });
    store.recordUse(created.key.id, "10.0.0.4");

    // Not written yet — that is the point of the buffer.
    assert.equal(JSON.parse(readFileSync(file, "utf8")).keys[0].lastUsedAt, null);

    await store.flushLastUsed();
    const persisted = JSON.parse(readFileSync(file, "utf8")).keys[0];
    assert.equal(persisted.lastUsedAt, new Date(clock).toISOString());
    assert.equal(persisted.lastUsedIp, "10.0.0.4");
  }, { now: () => clock, flushMs: 50_000 });
});

test("a buffered use for a revoked key cannot resurrect it", async () => {
  await withStore(async (store, file) => {
    const created = await store.create({ name: "Doomed", scopes: { players: "read" } });
    store.recordUse(created.key.id, "10.0.0.9");
    await store.revoke(created.key.id);
    await store.flushLastUsed();

    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).keys, []);
    assert.deepEqual(store.list(), []);
  }, { flushMs: 50_000 });
});

test("concurrent creates all survive the write queue", async () => {
  await withStore(async (store, file) => {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => store.create({ name: `Key ${index}`, scopes: { players: "read" } }))
    );
    assert.equal(store.list().length, 12);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).keys.length, 12, "a concurrent write was lost");
  });
});

test("name, expiry and rate limit are validated and bounded", async () => {
  await withStore(async (store) => {
    await assert.rejects(() => store.create({ name: "   " }), /Enter a name/);
    await assert.rejects(() => store.create({ name: "x".repeat(65) }), /64 characters or fewer/);
    await assert.rejects(() => store.create({ name: "Bad date", expiresAt: "not-a-date" }), /valid date/);

    const defaults = await store.create({ name: "Defaults" });
    assert.equal(defaults.key.rateLimitPerMinute, DEFAULT_RATE_LIMIT_PER_MINUTE);
    assert.equal(defaults.key.expiresAt, null);

    const clamped = await store.create({ name: "Clamped", rateLimitPerMinute: 9_999_999 });
    assert.equal(clamped.key.rateLimitPerMinute, MAX_RATE_LIMIT_PER_MINUTE);

    const floored = await store.create({ name: "Floored", rateLimitPerMinute: -5 });
    assert.equal(floored.key.rateLimitPerMinute, 1);

    const junk = await store.create({ name: "Junk", rateLimitPerMinute: "abc" });
    assert.equal(junk.key.rateLimitPerMinute, DEFAULT_RATE_LIMIT_PER_MINUTE);
  });
});

test("update and revoke report a missing key rather than throwing", async () => {
  await withStore(async (store) => {
    assert.equal(await store.update("deadbeef", { name: "Nope" }), null);
    assert.equal(await store.revoke("deadbeef"), null);
    assert.equal(store.get("deadbeef"), null);
  });
});

test("bearerToken and parseKey handle the shapes a real caller sends", () => {
  assert.equal(bearerToken("Bearer abc"), "abc");
  assert.equal(bearerToken("bearer abc"), "abc");
  assert.equal(bearerToken("Bearer"), "");
  assert.equal(bearerToken("Bearer a b"), "");
  assert.equal(bearerToken(""), "");

  // The secret is base64url and may itself contain underscores, so the id is
  // taken by fixed length rather than by splitting on "_".
  const parsed = parseKey("dak_0a1b2c3d_se_cret-with_underscores");
  assert.deepEqual(parsed, { id: "0a1b2c3d", secret: "se_cret-with_underscores" });
  assert.equal(parseKey("dak_0a1b2c3d"), null);
  assert.equal(parseKey("dak_0a1b2c3dXsecret"), null);
  assert.equal(parseKey("other_0a1b2c3d_secret"), null);
  assert.equal(parseKey(null), null);
});

test("a record missing rateLimitPerMinute is normalized on load, not left unlimited", async () => {
  // authenticate() hands the RAW record to server.js, which reads
  // rateLimitPerMinute straight off it -- publicKey()'s default never reaches
  // the gate. `count >= undefined` is false, so an unnormalized record meant no
  // rate limit at all.
  const dir = mkdtempSync(join(tmpdir(), "api-keys-normalize-"));
  const file = join(dir, "api-keys.json");
  try {
    const seeded = createApiKeyStore({ file });
    const created = await seeded.create({ name: "Legacy", scopes: { players: "read" } });

    const raw = JSON.parse(readFileSync(file, "utf8"));
    delete raw.keys[0].rateLimitPerMinute;
    delete raw.keys[0].enabled;
    raw.keys[0].scopes = { players: "read", settings: "write", bogus: "read" };
    writeFileSync(file, JSON.stringify(raw));

    const store = createApiKeyStore({ file });
    const authed = store.authenticate({ headers: { authorization: `Bearer ${created.secret}` } });
    assert.equal(authed.key.rateLimitPerMinute, DEFAULT_RATE_LIMIT_PER_MINUTE, "the raw record the gate reads was left without a limit");
    assert.equal(authed.key.enabled, true);
    // Normalizing on load also strips a denied namespace someone hand-added.
    assert.deepEqual(authed.key.scopes, { players: "read" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable store is quarantined instead of being overwritten", () => {
  // load() fails closed and leaves state empty, so the next write would have
  // serialized that empty list straight over bytes an operator could repair.
  const dir = mkdtempSync(join(tmpdir(), "api-keys-corrupt2-"));
  const file = join(dir, "api-keys.json");
  try {
    writeFileSync(file, '{"keys":[{"id":"cccccccc","hash":"deadbeef","name":"precious"}');
    const store = createApiKeyStore({ file });
    assert.deepEqual(store.list(), []);

    const saved = readdirSync(dir).filter((name) => name.startsWith("api-keys.json.corrupt-"));
    assert.equal(saved.length, 1, "the unreadable store was not preserved");
    assert.ok(readFileSync(join(dir, saved[0]), "utf8").includes("precious"), "quarantined copy lost the original bytes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dropping an invalid record is reported rather than done silently", () => {
  // The pruned list is what the next write persists, so a record vanishing from
  // disk with no diagnostic is the failure mode being guarded here.
  const dir = mkdtempSync(join(tmpdir(), "api-keys-drop-"));
  const file = join(dir, "api-keys.json");
  const warnings = [];
  const originalWarn = console.warn;
  try {
    writeFileSync(file, JSON.stringify({ version: 1, keys: [
      { id: "aaaaaaaa", name: "missing a hash" },
      { id: "bbbbbbbb", hash: "beef", name: "fine", scopes: {}, rateLimitPerMinute: 60 }
    ] }));
    console.warn = (message) => warnings.push(String(message));
    const store = createApiKeyStore({ file });
    console.warn = originalWarn;

    assert.equal(store.list().length, 1, "the valid record should still load");
    assert.ok(warnings.some((message) => /ignoring 1 record/i.test(message)),
      `expected a dropped-record warning, got: ${JSON.stringify(warnings)}`);
  } finally {
    console.warn = originalWarn;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a past expiry is refused rather than minting a key that is dead on arrival", async () => {
  const clock = Date.parse("2026-08-27T00:00:00.000Z");
  await withStore(async (store) => {
    await assert.rejects(() => store.create({ name: "Born dead", expiresAt: "2020-01-01" }), /must be in the future/);
    const created = await store.create({ name: "Fine", expiresAt: "2027-01-31" });
    await assert.rejects(() => store.update(created.key.id, { expiresAt: "2020-01-01" }), /must be in the future/);
  }, { now: () => clock });
});

test("a numeric expiry is refused instead of being read as milliseconds", async () => {
  // A caller sending epoch SECONDS previously got a 1970 expiry and HTTP 200.
  await withStore(async (store) => {
    await assert.rejects(() => store.create({ name: "Epoch", expiresAt: 1756684800 }), /date string/);
    await assert.rejects(() => store.create({ name: "Zero", expiresAt: 0 }), /date string/);
  });
});

test("enabled must be a real boolean, not any truthy value", async () => {
  // `patch.enabled === true` used to turn {"enabled":"true"} into DISABLED and
  // report 200 with enabled:false -- the exact opposite of the request.
  await withStore(async (store) => {
    const created = await store.create({ name: "Toggle", scopes: { players: "read" } });
    await assert.rejects(() => store.update(created.key.id, { enabled: "true" }), /true or false/);
    await assert.rejects(() => store.update(created.key.id, { enabled: 1 }), /true or false/);
    assert.equal(store.get(created.key.id).enabled, true, "a rejected update must not have changed anything");

    const disabled = await store.update(created.key.id, { enabled: false });
    assert.equal(disabled.enabled, false);
  });
});

test("key ids are unique across many creates", async () => {
  // byId/revoke both match the first record with an id, so a collision would
  // strand the second key and make a revoke silently spare a live one.
  await withStore(async (store) => {
    const made = await Promise.all(Array.from({ length: 60 }, (_, index) => store.create({ name: `Key ${index}` })));
    const ids = made.map((entry) => entry.key.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate key id generated");
    for (const id of ids) assert.match(id, /^[0-9a-f]{8}$/);
  });
});

test("a rejected update leaves the record completely unchanged", async () => {
  // Fields used to be assigned one at a time, so a later validator throwing
  // left the earlier ones written to the LIVE record -- and authenticate()
  // hands that record to keyAllows(), so a 400 could silently grant or revoke
  // namespaces and then be flushed to disk by the next unrelated persist().
  const clock = Date.parse("2026-08-27T00:00:00.000Z");
  await withStore(async (store, file) => {
    const created = await store.create({ name: "original", scopes: { players: "read" } });
    const rejected = [
      { enabled: "true" },
      { expiresAt: "2020-01-01" },
      { expiresAt: 1756684800 },
      { name: "   " },
      { rateLimitPerMinute: 5, expiresAt: "not-a-date" }
    ];

    for (const bad of rejected) {
      await assert.rejects(() => store.update(created.key.id, { name: "MUTATED", scopes: { bases: "write" }, ...bad }));

      const live = store.authenticate({ headers: { authorization: `Bearer ${created.secret}` } }).key;
      assert.equal(live.name, "original", `name leaked through a rejected ${JSON.stringify(bad)}`);
      assert.deepEqual(live.scopes, { players: "read" }, `scopes leaked through a rejected ${JSON.stringify(bad)}`);
      assert.equal(keyAllows(live, "bases:mutate"), false, "a rejected update granted a namespace");
      assert.equal(keyAllows(live, "players:read"), true, "a rejected update revoked a namespace");
    }

    // An unrelated later write must not flush a partial mutation to disk.
    await store.update(created.key.id, { rateLimitPerMinute: 99 });
    const persisted = JSON.parse(readFileSync(file, "utf8")).keys[0];
    assert.equal(persisted.name, "original");
    assert.deepEqual(persisted.scopes, { players: "read" });
    assert.equal(persisted.rateLimitPerMinute, 99);
  }, { now: () => clock });
});

test("a valid update still applies every field together", async () => {
  await withStore(async (store) => {
    const created = await store.create({ name: "before", scopes: { players: "read" } });
    const updated = await store.update(created.key.id, {
      name: "after", scopes: { bases: "write" }, enabled: false, rateLimitPerMinute: 120
    });
    assert.equal(updated.name, "after");
    assert.deepEqual(updated.scopes, { bases: "write" });
    assert.equal(updated.enabled, false);
    assert.equal(updated.rateLimitPerMinute, 120);
  });
});

test("two same-millisecond quarantines do not overwrite each other", async () => {
  // The target name was ISO-to-milliseconds only, and renameSync overwrites
  // silently, so the second construction destroyed the first preserved copy.
  const clock = Date.parse("2026-08-27T12:00:00.000Z");
  const dir = mkdtempSync(join(tmpdir(), "api-keys-q2-"));
  try {
    for (const payload of ['{"keys":[{"id":"aaaaaaaa","hash":"a","name":"FIRST"}', '{"keys":[{"id":"bbbbbbbb","hash":"b","name":"SECOND"}']) {
      writeFileSync(join(dir, "api-keys.json"), payload);
      createApiKeyStore({ file: join(dir, "api-keys.json"), now: () => clock });
    }
    const saved = readdirSync(dir).filter((name) => name.startsWith("api-keys.json.corrupt-"));
    assert.equal(saved.length, 2, `expected both payloads preserved, got ${saved.length}`);
    const contents = saved.map((name) => readFileSync(join(dir, name), "utf8")).join("");
    assert.ok(contents.includes("FIRST"), "the first quarantined copy was overwritten");
    assert.ok(contents.includes("SECOND"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-finite clock does not take the whole store down on quarantine", async () => {
  // toISOString() throws RangeError on NaN; built outside the try it escaped
  // load() and killed createApiKeyStore() instead of degrading.
  const dir = mkdtempSync(join(tmpdir(), "api-keys-q3-"));
  try {
    writeFileSync(join(dir, "api-keys.json"), "{ not json");
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const store = createApiKeyStore({ file: join(dir, "api-keys.json"), now: () => Number.NaN });
      assert.deepEqual(store.list(), [], "the store should degrade to empty, not throw");
    } finally {
      console.warn = originalWarn;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unparseable stored expiry is treated as expired, not as no expiry", async () => {
  // NaN <= now is false, so a hand-edited or migrated value used to produce a
  // key that never expires -- failing open on the field whose only job is to
  // stop a key working.
  const dir = mkdtempSync(join(tmpdir(), "api-keys-badexp-"));
  const file = join(dir, "api-keys.json");
  try {
    const seeded = createApiKeyStore({ file });
    const created = await seeded.create({ name: "Corrupt expiry", scopes: { players: "read" } });

    // Junk is refused; only a genuinely absent expiry means "no expiry".
    // "" and null are absent (normalizeRecord maps them to null); whitespace is
    // junk, not a way of saying "never".
    for (const [stored, expectation] of [
      ["banana", "expired"],
      ["not-a-date", "expired"],
      ["2026-13-45T99:99:99Z", "expired"],
      ["  ", "expired"],
      ["", "no expiry"],
      [null, "no expiry"]
    ]) {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      raw.keys[0].expiresAt = stored;
      writeFileSync(file, JSON.stringify(raw));

      const store = createApiKeyStore({ file });
      const result = store.authenticate({ headers: { authorization: `Bearer ${created.secret}` } });
      if (expectation === "no expiry") {
        assert.ok(result.session, `expiry ${JSON.stringify(stored)} should mean no expiry, got ${JSON.stringify(result)}`);
      } else {
        assert.deepEqual(result, { error: "This API key has expired.", status: 401 }, `expiry ${JSON.stringify(stored)} authenticated`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed write leaves no phantom key authenticating from memory", async () => {
  // create() pushed before persisting, so a write failure left a key that
  // authenticated for the life of the process while the caller had seen an
  // error and had no secret to trust -- and it vanished on the next restart.
  const dir = mkdtempSync(join(tmpdir(), "api-keys-nowrite-"));
  try {
    // Parent of the store path is a FILE, so writeJsonAtomic cannot mkdir it.
    writeFileSync(join(dir, "blocked"), "not a directory");
    const store = createApiKeyStore({ file: join(dir, "blocked", "api-keys.json") });
    await assert.rejects(() => store.create({ name: "Doomed", scopes: { players: "read" } }));
    assert.deepEqual(store.list(), [], "a key survived a failed write");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed write rolls back an update and a revoke too", async () => {
  // Same class as the create rollback: leaving these applied in memory means a
  // revoke that errored is still denied until restart, then comes back.
  const dir = mkdtempSync(join(tmpdir(), "api-keys-rollback-"));
  const file = join(dir, "api-keys.json");
  try {
    const store = createApiKeyStore({ file });
    const created = await store.create({ name: "original", scopes: { players: "read" } });

    // Make every subsequent write fail by turning the directory into a file.
    rmSync(file);
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, "not a directory");

    await assert.rejects(() => store.update(created.key.id, { name: "renamed", scopes: { bases: "write" } }));
    const afterUpdate = store.get(created.key.id);
    assert.equal(afterUpdate.name, "original", "a failed update stayed applied in memory");
    assert.deepEqual(afterUpdate.scopes, { players: "read" });

    await assert.rejects(() => store.revoke(created.key.id));
    assert.equal(store.list().length, 1, "a failed revoke removed the key from memory anyway");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every key the API returns carries the server's own expiry verdict", async () => {
  // The browser used to re-derive this and had its own copy of the formula,
  // which missed the unparseable-expiry fix -- so the UI showed a key as Active
  // that the API was already refusing. The verdict now travels with the key.
  let clock = Date.parse("2026-08-27T00:00:00.000Z");
  const dir = mkdtempSync(join(tmpdir(), "api-keys-expflag-"));
  const file = join(dir, "api-keys.json");
  try {
    const store = createApiKeyStore({ file, now: () => clock });
    const created = await store.create({ name: "Expiring", scopes: { players: "read" }, expiresAt: "2026-08-28" });
    assert.equal(created.key.expired, false);
    assert.equal(store.list()[0].expired, false);
    assert.equal(store.get(created.key.id).expired, false);

    clock = Date.parse("2026-08-29T00:00:00.000Z");
    assert.equal(store.list()[0].expired, true, "list() did not report the key as expired");
    assert.equal(store.get(created.key.id).expired, true);

    // The flag must agree with what authenticate() actually does.
    const refused = store.authenticate({ headers: { authorization: `Bearer ${created.secret}` } });
    assert.deepEqual(refused, { error: "This API key has expired.", status: 401 });

    // And it must agree for the unparseable case too, which is where the two
    // implementations diverged.
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.keys[0].expiresAt = "banana";
    writeFileSync(file, JSON.stringify(raw));
    const reloaded = createApiKeyStore({ file, now: () => clock });
    assert.equal(reloaded.list()[0].expired, true, "an unparseable expiry was reported as not expired");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed last-used flush keeps the buffer instead of losing it", async () => {
  // The buffer was cleared BEFORE the write, so a failure lost the entries
  // permanently and left memory diverged from disk. It is the last of four
  // persist() sites to get rollback.
  const dir = mkdtempSync(join(tmpdir(), "api-keys-flush-"));
  const file = join(dir, "api-keys.json");
  try {
    const store = createApiKeyStore({ file, flushMs: 50_000 });
    const created = await store.create({ name: "Used", scopes: { players: "read" } });
    const before = JSON.parse(readFileSync(file, "utf8")).keys[0];
    assert.equal(before.lastUsedAt, null);

    store.recordUse(created.key.id, "10.0.0.7");
    rmSync(file);
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, "not a directory");

    await assert.rejects(() => store.flushLastUsed(), "a failed write should surface");
    // Memory must not claim a write that did not happen.
    assert.equal(store.get(created.key.id).lastUsedAt, null, "memory kept a value the disk never received");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a clock that cannot produce a timestamp still preserves the corrupt store", async () => {
  // The stamp is decorative -- randomBytes makes the name unique -- so a
  // RangeError from toISOString() must not cost us the file, which is exactly
  // what quarantine() exists to save.
  const dir = mkdtempSync(join(tmpdir(), "api-keys-q4-"));
  const originalWarn = console.warn;
  try {
    writeFileSync(join(dir, "api-keys.json"), '{"keys":[{"id":"aaaaaaaa","hash":"h","name":"PRECIOUS"}');
    console.warn = () => {};
    const store = createApiKeyStore({ file: join(dir, "api-keys.json"), now: () => Number.NaN });
    console.warn = originalWarn;

    assert.deepEqual(store.list(), [], "the store should still degrade to empty");
    const saved = readdirSync(dir).filter((name) => name.startsWith("api-keys.json.corrupt-"));
    assert.equal(saved.length, 1, "a non-finite clock lost the corrupt store");
    assert.ok(readFileSync(join(dir, saved[0]), "utf8").includes("PRECIOUS"));
  } finally {
    console.warn = originalWarn;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rejected update removes a field it added, not just the ones it changed", async () => {
  // validRecord only requires id and hash, so a hand-edited or migrated record
  // can lack `name`. A shallow-copy rollback restores changed fields but cannot
  // delete one that was absent before.
  const dir = mkdtempSync(join(tmpdir(), "api-keys-addfield-"));
  const file = join(dir, "api-keys.json");
  try {
    const seeded = createApiKeyStore({ file });
    const created = await seeded.create({ name: "orig", scopes: { players: "read" } });
    const raw = JSON.parse(readFileSync(file, "utf8"));
    delete raw.keys[0].name;
    writeFileSync(file, JSON.stringify(raw));

    const store = createApiKeyStore({ file });
    assert.equal(store.get(created.key.id).name, undefined, "fixture should start without a name");

    // Make the write fail so the rollback path runs.
    rmSync(file);
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, "not a directory");

    await assert.rejects(() => store.update(created.key.id, { name: "LEAKED" }));
    assert.equal(store.get(created.key.id).name, undefined, "a rejected update left the added field behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
