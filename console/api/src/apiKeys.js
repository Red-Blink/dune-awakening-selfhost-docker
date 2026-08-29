// API keys — a second principal type alongside the browser session cookie.
//
// A key authenticates with `Authorization: Bearer dak_<id>_<secret>` and is
// authorized by its own per-namespace scope map (see apiKeyScopes.js), NOT by
// an IAM tier. Only a SHA-256 hash of the secret is stored; the full key is
// returned exactly once, at creation, and cannot be recovered afterwards.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { clampInt, writeJsonAtomic } from "./jsonStore.js";
import {
  KEY_DENIED_NAMESPACES,
  KEY_WRITE_DENIED_NAMESPACES,
  isReadAction,
  namespaceOf,
  normalizeScopes,
  scopeAllowsAction,
  scopesGrantAnything
} from "./apiKeyScopes.js";

export const KEY_PREFIX = "dak_";
const KEY_ID_LENGTH = 8;
const SECRET_BYTES = 32;

// Domain separator, following docs/rfc-console-auth.md 2.3, which rejects
// password KDFs for high-entropy bearer tokens in favour of a plain
// SHA-256 over a separated input. Never change this string without a
// migration -- every stored hash is derived through it.
const HASH_DOMAIN = "dune-console-api-key-v1:";

export const MAX_NAME_LENGTH = 64;
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;
export const MIN_RATE_LIMIT_PER_MINUTE = 1;
export const MAX_RATE_LIMIT_PER_MINUTE = 10000;

// The shared ceiling across ALL keys. Must stay strictly above the per-key
// maximum: at 6000 against a per-key max of 10000, one key configured at its
// documented limit could exhaust the shared bucket on its own and 429 every
// other key -- the per-key bucket is checked first, so the noisy key kept
// passing while everyone else was refused. The global is a backstop for many
// keys misbehaving together, not a second per-key limit.
export const GLOBAL_RATE_LIMIT_PER_MINUTE = MAX_RATE_LIMIT_PER_MINUTE * 2;

// How long last-used data may sit in memory before reaching disk. Writing on
// every request would mean an fsync per API call. The trade-off, stated
// plainly rather than engineered around: a hard crash loses up to this much
// last-used history. Nothing else about a key is buffered -- create, update
// and revoke are written through immediately.
const LAST_USED_FLUSH_MS = 60_000;

export function hashSecret(secret) {
  return createHash("sha256").update(`${HASH_DOMAIN}${secret}`).digest("hex");
}

export function formatKey(id, secret) {
  return `${KEY_PREFIX}${id}_${secret}`;
}

// The id is fixed-length hex and comes first, so this cannot be done by
// splitting on "_" -- the base64url secret may itself contain "_".
export function parseKey(token) {
  if (typeof token !== "string" || !token.startsWith(KEY_PREFIX)) return null;
  const body = token.slice(KEY_PREFIX.length);
  if (body.length < KEY_ID_LENGTH + 2) return null;
  const id = body.slice(0, KEY_ID_LENGTH);
  if (!/^[0-9a-f]+$/.test(id)) return null;
  if (body[KEY_ID_LENGTH] !== "_") return null;
  const secret = body.slice(KEY_ID_LENGTH + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(secret)) return null;
  return { id, secret };
}

export function bearerToken(header) {
  const parts = String(header || "").split(/\s+/);
  return parts.length === 2 && /^Bearer$/i.test(parts[0]) ? parts[1].trim() : "";
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

// The single authorization decision for a key. Pure, so it can be tested
// without a store or an HTTP request.
export function keyAllows(key, action) {
  if (!key || typeof action !== "string" || !action) return false;
  const namespace = namespaceOf(action);
  if (!namespace) return false;
  // Checked before the scope lookup on purpose: a hand-edited api-keys.json
  // granting `settings: write` still cannot mint keys.
  if (KEY_DENIED_NAMESPACES.has(namespace)) return false;
  const scopes = key.scopes && typeof key.scopes === "object" ? key.scopes : {};
  // A namespace holds either a level ("read"/"write") or an explicit list of
  // actions. Absent, or anything else, is None. scopeAllowsAction is the one
  // place both forms are interpreted -- including the write-denied degrade
  // that normalizeScopes applies on save and this re-applies for a
  // hand-edited api-keys.json.
  return scopeAllowsAction(namespace, scopes[namespace], action);
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

export function validateName(value) {
  const name = String(value ?? "").trim();
  if (!name) throw badRequest("Enter a name for this API key.");
  if (name.length > MAX_NAME_LENGTH) throw badRequest(`API key names must be ${MAX_NAME_LENGTH} characters or fewer.`);
  return name;
}

export function validateExpiry(value, at = Date.now()) {
  if (value === undefined || value === null || value === "") return null;
  // Numbers are rejected rather than guessed at: new Date(n) treats n as
  // milliseconds, so a caller sending epoch SECONDS got a 1970 expiry and a
  // key that was dead on arrival. Requiring a string makes the unit explicit.
  if (typeof value !== "string") throw badRequest("Expiry must be a date string such as 2027-01-31, or empty for no expiry.");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw badRequest("Expiry must be a valid date, or empty for no expiry.");
  // A past expiry used to be accepted, returning 200 with a secret for a key
  // that 401s on its very first call. Disabling or revoking is what the
  // operator actually wants there, and both are reversible/explicit.
  if (parsed.getTime() <= at) throw badRequest("Expiry must be in the future. To stop a key now, disable or revoke it instead.");
  return parsed.toISOString();
}

export function validateRateLimit(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_RATE_LIMIT_PER_MINUTE;
  return clampInt(value, DEFAULT_RATE_LIMIT_PER_MINUTE, MIN_RATE_LIMIT_PER_MINUTE, MAX_RATE_LIMIT_PER_MINUTE);
}

// What the browser is allowed to see. Never includes `hash`, and there is no
// stored field that could reconstruct the secret.
export function publicKey(record, expired = false) {
  return {
    // Computed here and sent, never re-derived in the browser: a second copy
    // of this formula drifted and showed keys as Active that the API refused.
    expired,
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    // One level deeper than a spread: a scope value may be an ARRAY, and
    // `{ ...record.scopes }` would share that array with every caller, so any
    // sort or push downstream would edit the live key's grant in place.
    scopes: Object.fromEntries(Object.entries(record.scopes || {})
      .map(([namespace, value]) => [namespace, Array.isArray(value) ? [...value] : value])),
    enabled: record.enabled !== false,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt || null,
    lastUsedAt: record.lastUsedAt || null,
    lastUsedIp: record.lastUsedIp || null,
    rateLimitPerMinute: record.rateLimitPerMinute || DEFAULT_RATE_LIMIT_PER_MINUTE
  };
}

export function createApiKeyStore({ file, now = () => Date.now(), flushMs = LAST_USED_FLUSH_MS } = {}) {
  let state = load();
  const pendingLastUsed = new Map();
  let flushTimer = null;

  // All read-modify-write goes through one chain. Without it the last-used
  // flush can interleave with a create or a revoke and write back a stale
  // key list -- resurrecting a key the operator just revoked.
  let writeChain = Promise.resolve();

  function enqueue(mutator) {
    const result = writeChain.then(() => mutator());
    writeChain = result.then(() => undefined, () => undefined);
    return result;
  }

  function validRecord(record) {
    return Boolean(record && typeof record.id === "string" && typeof record.hash === "string");
  }

  // authenticate() hands the RAW record to the caller, and server.js reads
  // record.rateLimitPerMinute straight off it -- publicKey()'s `|| DEFAULT`
  // fallback is only applied to the API response, so it does not protect the
  // gate. A record written by hand, or by an older/newer schema, could arrive
  // without the field, and `count >= undefined` is false, which silently means
  // NO rate limit at all. Normalizing at the boundary keeps every consumer
  // honest rather than relying on each one to re-default.
  function normalizeRecord(record) {
    return {
      ...record,
      scopes: normalizeScopes(record.scopes),
      enabled: record.enabled !== false,
      expiresAt: record.expiresAt || null,
      rateLimitPerMinute: validateRateLimit(record.rateLimitPerMinute)
    };
  }

  function load() {
    if (!file || !existsSync(file)) return { version: 1, keys: [] };
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      const rawKeys = Array.isArray(parsed?.keys) ? parsed.keys : [];
      const keys = rawKeys.filter(validRecord).map(normalizeRecord);
      // A dropped record is a key the operator believes exists. The next write
      // serializes this pruned list back over the file, so saying nothing here
      // meant the record vanished from disk with no diagnostic at all.
      if (keys.length !== rawKeys.length) {
        console.warn(
          `API key store at ${file}: ignoring ${rawKeys.length - keys.length} record(s) missing an id or hash. ` +
          "They will be dropped from the file on the next change."
        );
      }
      return { version: 1, keys };
    } catch (error) {
      // Fail closed: an unreadable store means no key authenticates. Loud,
      // because silently authenticating nobody is a confusing outage.
      //
      // Quarantine before proceeding: the in-memory state is now empty, and the
      // next create/revoke would write it straight over the file, destroying the
      // bytes an operator could otherwise have repaired by hand. Renaming keeps
      // them and still lets key management work.
      console.warn(`Ignoring unreadable API key store at ${file}: ${error.message}`);
      quarantine();
      return { version: 1, keys: [] };
    }
  }

  function quarantine() {
    try {
      // randomBytes is what makes the name unique; the stamp is decorative,
      // so a clock that cannot produce one must not cost us the file.
      let stamp;
      try {
        stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
      } catch {
        stamp = "unknown-time";
      }
      const target = `${file}.corrupt-${stamp}-${randomBytes(3).toString("hex")}`;
      renameSync(file, target);
      console.warn(`Moved the unreadable API key store aside to ${target} so it is not overwritten.`);
    } catch (error) {
      // Best effort. If the rename fails the original is still on disk and the
      // next write will replace it -- worth saying so rather than pretending.
      console.warn(`Could not preserve the unreadable API key store: ${error.message}`);
    }
  }

  function persist() {
    writeJsonAtomic(file, state, 0o600);
  }

  function byId(id) {
    return state.keys.find((record) => record.id === id) || null;
  }

  function isExpired(record, at = now()) {
    if (!record.expiresAt) return false;
    const expiresAt = new Date(record.expiresAt).getTime();
    // Unparseable is treated as expired, not as "no expiry": NaN <= at is
    // false, which would fail open. The stored value is left as-is; we just
    // refuse to honour it.
    return !Number.isFinite(expiresAt) || expiresAt <= at;
  }

  function list() {
    return state.keys.map((record) => publicKey(record, isExpired(record)));
  }

  function create({ name, scopes, expiresAt, rateLimitPerMinute } = {}) {
    // Validation happens inside the queue, not before it, so create() and
    // update() reject the same way on bad input -- a synchronous throw from
    // one and a rejected promise from the other is a trap for callers.
    return enqueue(async () => {
      // byId() and revoke() both match the FIRST record with an id, so a
      // collision would leave the second key unable to authenticate and a
      // revoke silently sparing a live key. 32 bits makes this rare, not
      // impossible, and retrying costs nothing.
      let id = randomBytes(KEY_ID_LENGTH / 2).toString("hex");
      for (let attempt = 0; byId(id) && attempt < 8; attempt += 1) {
        id = randomBytes(KEY_ID_LENGTH / 2).toString("hex");
      }
      if (byId(id)) throw new Error("Could not allocate a unique API key id.");
      const secret = randomBytes(SECRET_BYTES).toString("base64url");
      const record = {
        id,
        name: validateName(name),
        // Every namespace starts at None. No default is seeded here or
        // anywhere below -- a key with no scopes is valid and reaches nothing.
        scopes: normalizeScopes(scopes),
        enabled: true,
        createdAt: new Date(now()).toISOString(),
        expiresAt: validateExpiry(expiresAt, now()),
        lastUsedAt: null,
        lastUsedIp: null,
        rateLimitPerMinute: validateRateLimit(rateLimitPerMinute),
        prefix: `${KEY_PREFIX}${id}`,
        hash: hashSecret(secret)
      };
      // Rolled back if the write fails, or the key would authenticate from
      // memory for the life of the process after the caller saw an error.
      state.keys.push(record);
      try {
        persist();
      } catch (error) {
        state.keys = state.keys.filter((entry) => entry !== record);
        throw error;
      }
      // The only time the full key exists outside the caller's request.
      return { key: publicKey(record, isExpired(record)), secret: formatKey(id, secret) };
    });
  }

  function update(id, patch = {}) {
    return enqueue(async () => {
      const record = byId(id);
      if (!record) return null;

      // Validate into a staged copy first. Assigning field-by-field meant a
      // later throw left earlier fields on the live record — and authenticate()
      // hands that record to keyAllows(), so a 400 could change access.
      const staged = {};
      if (patch.name !== undefined) staged.name = validateName(patch.name);
      // Wholesale replacement, never a merge: omitting a namespace revokes it.
      if (patch.scopes !== undefined) staged.scopes = normalizeScopes(patch.scopes);
      if (patch.enabled !== undefined) {
        // `=== true` would turn {"enabled":"true"} into DISABLED and report 200.
        if (typeof patch.enabled !== "boolean") throw badRequest("Enabled must be true or false.");
        staged.enabled = patch.enabled;
      }
      if (patch.expiresAt !== undefined) staged.expiresAt = validateExpiry(patch.expiresAt, now());
      if (patch.rateLimitPerMinute !== undefined) staged.rateLimitPerMinute = validateRateLimit(patch.rateLimitPerMinute);

      // Past this point nothing can throw, so the record cannot be left half
      // written. Mutating in place rather than replacing the object keeps any
      // reference an in-flight request already holds pointing at live data.
      // Shallow copy is enough to undo this: normalizeScopes() returns a fresh
      // object, so `before.scopes` still points at the previous one.
      const before = { ...record };
      // The shallow copy restores changed fields but cannot remove one that was
      // absent before, and validRecord only requires id and hash.
      const added = Object.keys(staged).filter((field) => !(field in record));
      Object.assign(record, staged);
      try {
        persist();
      } catch (error) {
        Object.assign(record, before);
        for (const field of added) delete record[field];
        throw error;
      }
      return publicKey(record, isExpired(record));
    });
  }

  function revoke(id) {
    return enqueue(async () => {
      const index = state.keys.findIndex((record) => record.id === id);
      if (index < 0) return null;
      const [removed] = state.keys.splice(index, 1);
      // Drop any buffered last-used write for this key, or the next flush
      // would re-add the record we just removed.
      const bufferedUse = pendingLastUsed.get(id);
      pendingLastUsed.delete(id);
      try {
        persist();
      } catch (error) {
        // Otherwise the key is denied from memory but still on disk, so it
        // returns at the next restart -- a revoke that errored and then
        // half-happened.
        state.keys.splice(index, 0, removed);
        if (bufferedUse) pendingLastUsed.set(id, bufferedUse);
        throw error;
      }
      return publicKey(removed, isExpired(removed));
    });
  }

  function authenticate(req) {
    const token = bearerToken(req?.headers?.authorization || req?.headers?.Authorization || "");
    if (!token) return null;                       // no bearer header -> cookie auth proceeds

    const parsed = parseKey(token);
    const record = parsed ? byId(parsed.id) : null;
    // Everything up to and including the hash comparison returns one generic
    // message: a caller without a valid key learns nothing about which keys
    // exist. Only after the secret verifies do we say why it was refused.
    if (!parsed || !record || !constantTimeEqual(hashSecret(parsed.secret), record.hash)) {
      return { error: "Invalid API key.", status: 401 };
    }
    if (record.enabled === false) return { error: "This API key is disabled.", status: 401 };
    if (isExpired(record)) return { error: "This API key has expired.", status: 401 };

    return {
      key: record,
      session: {
        id: `apikey:${record.id}`,
        // Hardcoded, and never read from the stored record. The policy engine
        // denies any principal whose tier is not one of the five known tiers
        // (policy.js resolveSessionTier), so a key needs a valid tier just to
        // traverse it. "owner" is Allow *, which makes that check a no-op and
        // leaves the key's own scope map as the single thing deciding access.
        // This is deliberately NOT a second permission control -- see
        // docs/console/api-keys.md. Do not make it configurable.
        tier: "owner",
        apiKeyId: record.id,
        csrf: ""
      }
    };
  }

  function recordUse(id, ip) {
    if (!byId(id)) return;
    pendingLastUsed.set(id, { lastUsedAt: new Date(now()).toISOString(), lastUsedIp: ip || null });
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushLastUsed();
    }, flushMs);
    if (typeof flushTimer.unref === "function") flushTimer.unref();
  }

  function flushLastUsed() {
    if (!pendingLastUsed.size) return Promise.resolve(false);
    return enqueue(async () => {
      const applied = [];
      for (const [id, usage] of pendingLastUsed) {
        const record = byId(id);
        if (!record) continue;
        applied.push([id, usage, { lastUsedAt: record.lastUsedAt, lastUsedIp: record.lastUsedIp }]);
        record.lastUsedAt = usage.lastUsedAt;
        record.lastUsedIp = usage.lastUsedIp;
      }
      if (!applied.length) {
        pendingLastUsed.clear();
        return false;
      }
      try {
        persist();
      } catch (error) {
        // Was: clear the buffer, then write. A failed write then lost the
        // entries permanently AND left memory diverged from disk. The buffer is
        // only cleared once the write has actually landed, so the next flush
        // retries rather than silently dropping them.
        for (const [id, , previous] of applied) {
          const record = byId(id);
          if (record) Object.assign(record, previous);
        }
        throw error;
      }
      pendingLastUsed.clear();
      return true;
    });
  }

  return {
    list,
    get: (id) => {
      const record = byId(id);
      return record ? publicKey(record, isExpired(record)) : null;
    },
    create,
    update,
    revoke,
    authenticate,
    allows: keyAllows,
    recordUse,
    flushLastUsed,
    scopesGrantAnything
  };
}
