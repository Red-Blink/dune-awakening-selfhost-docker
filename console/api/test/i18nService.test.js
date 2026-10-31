import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuth } from "../src/auth.js";
import { createApiKeyStore } from "../src/apiKeys.js";
import { loadPolicies } from "../src/policy.js";
import {
  ENCRYPTION_METADATA,
  SEED_DB_PATH,
  callDeepLTranslateBatch,
  callNeuralFallbackBatch,
  computeZeroKnowledgePeerToken,
  createDuneDockerMeshHeaders,
  createDuneDockerMeshResponseSignature,
  createMeshDiscoveryBeacon,
  decryptDeepLApiKey,
  decryptMeshWireEnvelope,
  encryptDeepLApiKey,
  encryptMeshWireEnvelope,
  generateMeshEnrollmentSecret,
  getLanguageCatalogStatus,
  handleI18nRoute,
  isI18nRoute,
  isReviewedUiPhrase,
  isSafeReviewedTranslation,
  loadMeshSettings,
  loadTranslationDatabase,
  normalizeLanguageCode,
  normalizeSafeMeshPeerOrigin,
  pushLanguagePackToPeers,
  resetTranslationDatabaseCache,
  runtimeDbPath,
  saveEncryptedDeepLApiKey,
  saveMeshSettings,
  saveTranslationDatabase,
  syncLanguagePacksFromPeers,
  translateAndCacheTexts,
  verifyDuneDockerMeshHeaders,
  verifyMeshDiscoveryBeacon
} from "../src/services/i18nService.js";

function sha256File(filePath) {
  return crypto.createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function createMockHttpCall({ method = "GET", path = "/api/i18n/languages", headers = {}, body = {} }) {
  const url = new URL(path, "http://localhost");
  let statusCode = 200;
  let responseBody = null;
  const req = {
    method,
    url: path,
    headers: { ...headers },
    socket: { remoteAddress: "127.0.0.1" }
  };
  const res = {
    req,
    writeHead(code) {
      statusCode = code;
    },
    end(payload) {
      responseBody = typeof payload === "string" ? JSON.parse(payload) : payload;
    }
  };
  const json = (_res, code, data) => {
    statusCode = code;
    responseBody = data;
  };
  const readJson = async () => body;
  return { req, res, url, path: url.pathname, json, readJson, getStatus: () => statusCode, getBody: () => responseBody };
}

test("encryptDeepLApiKey and saveEncryptedDeepLApiKey store and decrypt AES-256-GCM vault in config.generatedDir", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "dune-i18n-vault-"));
  try {
    const config = {
      generatedDir: join(tempDir, "generated"),
      secretsDir: join(tempDir, "secrets")
    };
    const saved = saveEncryptedDeepLApiKey("test-key-12345:fx", config);
    assert.notEqual(saved.ciphertext, "test-key-12345:fx");
    assert.equal(saved.alg, "aes-256-gcm");
    assert.equal(decryptDeepLApiKey(config), "test-key-12345:fx");
    assert.equal(existsSync(join(config.generatedDir, "deepl-vault.json")), true);

    const customVault = encryptDeepLApiKey("direct-vault-key:fx", "custom-secret");
    assert.equal(
      decryptDeepLApiKey({ ...customVault, masterSecret: "custom-secret" }),
      "direct-vault-key:fx"
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("normalizeLanguageCode resolves standard and regional codes", () => {
  assert.equal(normalizeLanguageCode("de"), "DE");
  assert.equal(normalizeLanguageCode("de-AT"), "DE");
  assert.equal(normalizeLanguageCode("zh-CN"), "ZH-HANS");
  assert.equal(normalizeLanguageCode("zh-TW"), "ZH-HANT");
  assert.equal(normalizeLanguageCode("pt-BR"), "PT-BR");
  assert.equal(normalizeLanguageCode("en-US"), "EN");
  assert.equal(normalizeLanguageCode("invalid_code_xyz"), null);
});

test("Boundary 1 & 4: config.generatedDir is respected, seed database remains strictly immutable, and unreviewed dynamic text is rejected without provider calls", async () => {
  const seedHashBefore = sha256File(SEED_DB_PATH);
  const tempDir = mkdtempSync(join(tmpdir(), "dune-i18n-boundary1-"));
  try {
    resetTranslationDatabaseCache();
    // Real Console config shape uses `generatedDir`, not `runtimeGeneratedDir`
    const config = {
      generatedDir: join(tempDir, "generated"),
      secretsDir: join(tempDir, "secrets")
    };
    assert.equal(runtimeDbPath(config), join(config.generatedDir, "i18n-translations-db.json"));
    assert.notEqual(runtimeDbPath(config), SEED_DB_PATH);

    saveEncryptedDeepLApiKey("unit-test-deepl-key:fx", config);

    let providerCalls = 0;
    const fakeFetch = async (_url, opts) => {
      providerCalls += 1;
      const body = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          translations: body.text.map((t) => ({ text: `[${body.target_lang}] ${t}` }))
        })
      };
    };

    // 1. Dynamic/private strings must NEVER be recognized as reviewed UI phrases
    const privatePlayerText = "Player_MuadDib_SecretBase_Coords_4412";
    const privateServerText = "Private Discord Webhook: token_abc123";
    assert.equal(isReviewedUiPhrase(privatePlayerText), false);
    assert.equal(isReviewedUiPhrase(privateServerText), false);
    assert.equal(isReviewedUiPhrase("Home"), true);

    // 2. Direct calls to DeepL and Google fallback batch functions must filter out unreviewed phrases and make 0 HTTP calls
    const directDeepL = await callDeepLTranslateBatch([privatePlayerText, privateServerText], "DE", {
      config,
      fetchImpl: fakeFetch
    });
    assert.deepEqual(directDeepL, {});
    assert.equal(providerCalls, 0);

    const directFallback = await callNeuralFallbackBatch([privatePlayerText, privateServerText], "DE", {
      fetchImpl: fakeFetch
    });
    assert.deepEqual(directFallback, {});
    assert.equal(providerCalls, 0);

    // 3. translateAndCacheTexts must reject unreviewed phrases, make 0 provider calls, and never add them to db.sourceStrings
    const mixedResult = await translateAndCacheTexts(["Home", privatePlayerText, privateServerText], "DE", {
      config,
      fetchImpl: fakeFetch
    });
    assert.equal(providerCalls, 0);
    assert.equal(mixedResult.rejectedUnreviewedCount, 2);
    assert.equal(mixedResult.newlyAddedCount, 0);
    assert.ok(mixedResult.translations.Home);
    assert.equal(mixedResult.translations[privatePlayerText], undefined);

    const db = loadTranslationDatabase(config);
    assert.equal(db.sourceStrings.includes(privatePlayerText), false);
    assert.equal(db.translations.DE?.[privatePlayerText], undefined);

    // 4. Translating a reviewed phrase that is missing from cache writes ONLY to config.generatedDir and never touches SEED_DB_PATH
    delete db.translations.DE.Home;
    const retranslated = await translateAndCacheTexts(["Home"], "DE", {
      config,
      fetchImpl: fakeFetch
    });
    assert.equal(providerCalls, 1);
    assert.equal(retranslated.translatedNowCount, 1);
    assert.equal(retranslated.translations.Home, "[DE] Home");
    assert.equal(existsSync(join(config.generatedDir, "i18n-translations-db.json")), true);

    const seedHashAfter = sha256File(SEED_DB_PATH);
    assert.equal(seedHashAfter, seedHashBefore, "Repository seed database must remain 100% byte-identical");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Boundary 2 & 4: Authentication, CSRF, API-key, Owner authorization, and Public GET zero-provider guarantees", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "dune-i18n-authz-"));
  try {
    resetTranslationDatabaseCache();
    loadPolicies(tempDir);
    const config = {
      repoRoot: tempDir,
      generatedDir: join(tempDir, "generated"),
      secretsDir: join(tempDir, "secrets"),
      sessionSecret: "test-session-secret-0123456789abcdef0123456789abcdef",
      adminPassword: "test-owner-password",
      adminPasswordEnvManaged: true,
      authDisabled: false
    };
    const auth = createAuth(config);
    const apiKeys = createApiKeyStore({ file: join(config.secretsDir, "api-keys.json") });

    const ownerSession = auth.makeSession({ tier: "owner", username: "owner-user" });
    const adminSession = auth.makeSession({ tier: "admin", username: "admin-user" });
    const moderatorSession = auth.makeSession({ tier: "moderator", username: "mod-user" });
    const observerSession = auth.makeSession({ tier: "observer", username: "obs-user" });

    let externalProviderCalls = 0;
    const spyFetch = async () => {
      externalProviderCalls += 1;
      throw new Error("External provider must never be called during unauthorized or public GET requests");
    };

    // Force a missing reviewed phrase in DE to prove public GET never triggers provider work even with Owner cookies
    const db = loadTranslationDatabase(config);
    delete db.translations.DE.Home;
    saveTranslationDatabase(config, db);

    // 1. Public GET /api/i18n/translations with Owner session cookie present must make ZERO provider calls
    const publicGetWithCookie = createMockHttpCall({
      method: "GET",
      path: "/api/i18n/translations?lang=DE",
      headers: { cookie: `asc_session=${ownerSession.cookie}` }
    });
    await handleI18nRoute({ ...publicGetWithCookie, config, auth, apiKeys, fetchImpl: spyFetch });
    assert.equal(publicGetWithCookie.getStatus(), 200);
    assert.equal(externalProviderCalls, 0);

    // 2. Unauthenticated requests to state-changing/provider routes must be rejected with 401
    for (const [method, routePath] of [
      ["POST", "/api/i18n/translate"],
      ["POST", "/api/i18n/key"],
      ["DELETE", "/api/i18n/key"],
      ["POST", "/api/i18n/settings"],
      ["POST", "/api/i18n/sync-all"]
    ]) {
      const unauthCall = createMockHttpCall({
        method,
        path: routePath,
        body: { lang: "DE", texts: ["Home"], apiKey: "valid-looking-key:fx" }
      });
      await handleI18nRoute({ ...unauthCall, config, auth, apiKeys, fetchImpl: spyFetch });
      assert.equal(unauthCall.getStatus(), 401, `Expected 401 for unauthenticated ${method} ${routePath}`);
    }

    // 3. Missing or invalid CSRF token on Owner session must be rejected with 403
    for (const [method, routePath] of [
      ["POST", "/api/i18n/translate"],
      ["POST", "/api/i18n/key"],
      ["DELETE", "/api/i18n/key"],
      ["POST", "/api/i18n/settings"],
      ["POST", "/api/i18n/sync-all"]
    ]) {
      const missingCsrfCall = createMockHttpCall({
        method,
        path: routePath,
        headers: { cookie: `asc_session=${ownerSession.cookie}` },
        body: { lang: "DE", texts: ["Home"] }
      });
      await handleI18nRoute({ ...missingCsrfCall, config, auth, apiKeys, fetchImpl: spyFetch });
      assert.equal(missingCsrfCall.getStatus(), 403, `Expected 403 for missing CSRF on ${method} ${routePath}`);

      const wrongCsrfCall = createMockHttpCall({
        method,
        path: routePath,
        headers: {
          cookie: `asc_session=${ownerSession.cookie}`,
          "x-csrf-token": "forged-csrf-token"
        },
        body: { lang: "DE", texts: ["Home"] }
      });
      await handleI18nRoute({ ...wrongCsrfCall, config, auth, apiKeys, fetchImpl: spyFetch });
      assert.equal(wrongCsrfCall.getStatus(), 403, `Expected 403 for wrong CSRF on ${method} ${routePath}`);
    }

    // 4. Lower-privilege sessions (observer, moderator, admin) WITH valid CSRF must be rejected with 403 (Owner-only)
    for (const lowSession of [observerSession, moderatorSession, adminSession]) {
      for (const [method, routePath] of [
        ["POST", "/api/i18n/translate"],
        ["POST", "/api/i18n/key"],
        ["DELETE", "/api/i18n/key"],
        ["POST", "/api/i18n/settings"],
        ["POST", "/api/i18n/sync-all"]
      ]) {
        const lowPrivCall = createMockHttpCall({
          method,
          path: routePath,
          headers: {
            cookie: `asc_session=${lowSession.cookie}`,
            "x-csrf-token": lowSession.csrf
          },
          body: { lang: "DE", texts: ["Home"], apiKey: "valid-looking-key:fx" }
        });
        await handleI18nRoute({ ...lowPrivCall, config, auth, apiKeys, fetchImpl: spyFetch });
        assert.equal(
          lowPrivCall.getStatus(),
          403,
          `Expected 403 for tier=${lowSession.tier} on ${method} ${routePath}`
        );
      }
    }

    // 5. Invalid API key -> 401; Valid API key -> 403 (settings namespace is denied to API keys)
    const createdKey = await apiKeys.create({
      name: "broad-key",
      scopes: { server: "write", players: "write", admin: "write" }
    });
    const invalidBearerCall = createMockHttpCall({
      method: "POST",
      path: "/api/i18n/translate",
      headers: { authorization: "Bearer ddc_invalid_secret_key_000000" },
      body: { lang: "DE", texts: ["Home"] }
    });
    await handleI18nRoute({ ...invalidBearerCall, config, auth, apiKeys, fetchImpl: spyFetch });
    assert.equal(invalidBearerCall.getStatus(), 401);

    const validBearerCall = createMockHttpCall({
      method: "POST",
      path: "/api/i18n/translate",
      headers: { authorization: `Bearer ${createdKey.secret}` },
      body: { lang: "DE", texts: ["Home"] }
    });
    await handleI18nRoute({ ...validBearerCall, config, auth, apiKeys, fetchImpl: spyFetch });
    assert.equal(validBearerCall.getStatus(), 403);

    // 6. Owner session WITH valid CSRF submitting unreviewed private text to POST /api/i18n/translate is rejected with 400
    const ownerUnreviewedCall = createMockHttpCall({
      method: "POST",
      path: "/api/i18n/translate",
      headers: {
        cookie: `asc_session=${ownerSession.cookie}`,
        "x-csrf-token": ownerSession.csrf
      },
      body: { lang: "DE", texts: ["Synthetic_Private_Operator_Secret_Example"] }
    });
    await handleI18nRoute({ ...ownerUnreviewedCall, config, auth, apiKeys, fetchImpl: spyFetch });
    assert.equal(ownerUnreviewedCall.getStatus(), 400);
    assert.equal(externalProviderCalls, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Boundary 3 & 5: Penetration test reproducing @Red-Blink PoC exploit chain and verifying per-installation mesh enrollment", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "dune-i18n-pentest-"));
  try {
    resetTranslationDatabaseCache();
    loadPolicies(tempDir);
    const config = {
      repoRoot: tempDir,
      generatedDir: join(tempDir, "generated"),
      secretsDir: join(tempDir, "secrets"),
      sessionSecret: "pentest-session-secret-0123456789abcdef0123456789",
      adminPassword: "pentest-owner-password",
      adminPasswordEnvManaged: true,
      authDisabled: false
    };
    const auth = createAuth(config);
    const apiKeys = createApiKeyStore({ file: join(config.secretsDir, "api-keys.json") });

    // 1. Verify Mesh is DISABLED by default (strictly opt-in)
    const initialMesh = loadMeshSettings(config);
    assert.equal(initialMesh.peerSyncEnabled, false);
    assert.equal(initialMesh.enrollmentConfigured, false);

    // 2. Reproduce @Red-Blink's exact PoC:
    // Step A: Low-privilege session attempts to submit synthetic private text without CSRF guard
    const lowPrivSession = auth.makeSession({ tier: "moderator", username: "low-priv" });
    const pocStepA = createMockHttpCall({
      method: "POST",
      path: "/api/i18n/translate",
      headers: { cookie: `asc_session=${lowPrivSession.cookie}` },
      body: { lang: "DE", texts: ["Synthetic_Private_Example_From_Audit"] }
    });
    await handleI18nRoute({ ...pocStepA, config, auth, apiKeys });
    assert.equal(pocStepA.getStatus(), 403, "Low-privilege / CSRF-missing injection attempt must be blocked with 403");

    // Step B: Unauthenticated attacker computes headers using the old public protocol constant from git history
    const legacyPublicKey = crypto.scryptSync(
      "dune-docker-i18n-mesh-protocol:v1",
      "arrakis-selfhost-console-attestation",
      32
    );
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomBytes(16).toString("hex");
    const legacySig = crypto
      .createHmac("sha256", legacyPublicKey)
      .update(`dune-docker-mesh:v1:attacker-node:${ts}:${nonce}:GET:/api/i18n/mesh/pack?lang=DE`, "utf8")
      .digest("hex");

    const pocStepBDefaultDisabled = createMockHttpCall({
      method: "GET",
      path: "/api/i18n/mesh/pack?lang=DE",
      headers: {
        "x-dune-docker-mesh-id": "attacker-node",
        "x-dune-docker-mesh-ts": ts,
        "x-dune-docker-mesh-nonce": nonce,
        "x-dune-docker-mesh-sig": legacySig
      }
    });
    await handleI18nRoute({ ...pocStepBDefaultDisabled, config, auth, apiKeys });
    assert.equal(pocStepBDefaultDisabled.getStatus(), 403, "Mesh pack endpoint must reject requests when opt-in is disabled");

    // 3. Attempting to enable peerSyncEnabled without configuring a per-installation enrollment secret fails closed
    assert.throws(
      () => saveMeshSettings(config, { peerSyncEnabled: true }),
      /enrollment secret/i
    );

    // 4. Enroll this installation with a unique per-installation 256-bit secret and opt-in
    const installationSecret = generateMeshEnrollmentSecret();
    saveMeshSettings(config, {
      meshEnrollmentKey: installationSecret,
      peerSyncEnabled: true,
      peers: ["http://192.168.1.99:8088"]
    });
    const enrolledMesh = loadMeshSettings(config);
    assert.equal(enrolledMesh.peerSyncEnabled, true);
    assert.equal(enrolledMesh.enrollmentConfigured, true);

    // 5. Attacker retries with legacy public protocol key OR wrong installation secret -> rejected with 403!
    const wrongSecret = generateMeshEnrollmentSecret();
    const attackerHeaders = createDuneDockerMeshHeaders(
      "attacker-node",
      "GET",
      "/api/i18n/mesh/pack?lang=DE",
      "",
      wrongSecret,
      ""
    );
    const pocStepBWrongSecret = createMockHttpCall({
      method: "GET",
      path: "/api/i18n/mesh/pack?lang=DE",
      headers: attackerHeaders
    });
    await handleI18nRoute({ ...pocStepBWrongSecret, config, auth, apiKeys });
    assert.equal(pocStepBWrongSecret.getStatus(), 403, "Attacker without this installation's enrollment secret must be rejected");

    // 6. Even if runtime cache file on disk were manually poisoned with a private key,
    // public GET and enrolled mesh pack export ONLY reviewed repository phrases!
    writeFileSync(
      runtimeDbPath(config),
      JSON.stringify({
        version: 1,
        sourceStrings: ["Home", "MANUAL_DISK_POISON_SECRET"],
        translations: {
          DE: {
            Home: "Startseite",
            MANUAL_DISK_POISON_SECRET: "Geheimes Token 999"
          }
        }
      }),
      "utf8"
    );
    resetTranslationDatabaseCache();

    const validPackHeaders = createDuneDockerMeshHeaders(
      "trusted-peer-node",
      "GET",
      "/api/i18n/mesh/pack?lang=DE",
      "",
      config,
      ""
    );
    const validPackCall = createMockHttpCall({
      method: "GET",
      path: "/api/i18n/mesh/pack?lang=DE",
      headers: validPackHeaders
    });
    await handleI18nRoute({ ...validPackCall, config, auth, apiKeys });
    assert.equal(validPackCall.getStatus(), 200);
    const decryptedPack = decryptMeshWireEnvelope(
      validPackCall.getBody().envelope,
      validPackHeaders["x-dune-docker-mesh-nonce"],
      config
    );
    assert.equal(decryptedPack.translations.Home, "Startseite");
    assert.equal(
      decryptedPack.translations.MANUAL_DISK_POISON_SECRET,
      undefined,
      "Unreviewed phrase must never be exported in a mesh pack"
    );

    // 7. Enrolled peer attempting to push unreviewed phrases, XSS payloads, or tampered body via POST /api/i18n/mesh/push
    const pushNonce = crypto.randomBytes(16).toString("hex");
    const pushTs = String(Math.floor(Date.now() / 1000));
    const pushEnvelope = encryptMeshWireEnvelope(
      {
        nodeId: "trusted-peer-node",
        lang: "DE",
        translations: {
          Home: "Startseite",
          UNREVIEWED_DYNAMIC_PLAYER_NAME: "Verbotener Text",
          Settings: "<script>alert(1)</script>"
        }
      },
      pushNonce,
      config
    );
    const pushBody = { envelope: pushEnvelope };

    // 7a. Tampered body (body hash mismatch) -> 403
    const badHashHeaders = createDuneDockerMeshHeaders(
      "trusted-peer-node",
      "POST",
      "/api/i18n/mesh/push",
      "",
      config,
      { envelope: "different-envelope" }
    );
    const tamperedPushCall = createMockHttpCall({
      method: "POST",
      path: "/api/i18n/mesh/push",
      headers: badHashHeaders,
      body: pushBody
    });
    await handleI18nRoute({ ...tamperedPushCall, config, auth, apiKeys });
    assert.equal(tamperedPushCall.getStatus(), 403, "Tampered body hash must be rejected with 403");

    // 7b. Validly signed push with unreviewed key + XSS payload -> filters out both bad entries!
    const dbBeforePush = loadTranslationDatabase(config);
    delete dbBeforePush.translations.DE.Home;
    saveTranslationDatabase(config, dbBeforePush);

    const validPushHeaders = createDuneDockerMeshHeaders(
      "trusted-peer-node",
      "POST",
      "/api/i18n/mesh/push",
      "",
      config,
      pushBody
    );
    // Align envelope encryption nonce with header nonce
    const alignedEnvelope = encryptMeshWireEnvelope(
      {
        nodeId: "trusted-peer-node",
        lang: "DE",
        translations: {
          Home: "Startseite",
          UNREVIEWED_DYNAMIC_PLAYER_NAME: "Verbotener Text",
          Settings: "<script>alert(1)</script>"
        }
      },
      validPushHeaders["x-dune-docker-mesh-nonce"],
      config
    );
    const alignedBody = { envelope: alignedEnvelope };
    const finalPushHeaders = createDuneDockerMeshHeaders(
      "trusted-peer-node",
      "POST",
      "/api/i18n/mesh/push",
      "",
      config,
      alignedBody
    );
    // Re-encrypt with finalPushHeaders nonce and sign once cleanly:
    const fixedNonce = finalPushHeaders["x-dune-docker-mesh-nonce"];
    const fixedTs = finalPushHeaders["x-dune-docker-mesh-ts"];
    const fixedEnvelope = encryptMeshWireEnvelope(
      {
        nodeId: "trusted-peer-node",
        lang: "DE",
        translations: {
          Home: "Startseite",
          UNREVIEWED_DYNAMIC_PLAYER_NAME: "Verbotener Text",
          Settings: "<script>alert(1)</script>"
        }
      },
      fixedNonce,
      config
    );
    const fixedBody = { envelope: fixedEnvelope };
    const fixedBodyHash = crypto.createHash("sha256").update(JSON.stringify(fixedBody), "utf8").digest("hex");
    const signingKey = crypto.createHmac("sha256", installationSecret).update("dune-docker-mesh-signing-key:v2", "utf8").digest();
    const fixedSig = crypto
      .createHmac("sha256", signingKey)
      .update(`dune-docker-mesh:v2:trusted-peer-node:${fixedTs}:${fixedNonce}:POST:/api/i18n/mesh/push:${fixedBodyHash}`, "utf8")
      .digest("hex");

    const validPushCall = createMockHttpCall({
      method: "POST",
      path: "/api/i18n/mesh/push",
      headers: {
        "x-dune-docker-mesh-id": "trusted-peer-node",
        "x-dune-docker-mesh-ts": fixedTs,
        "x-dune-docker-mesh-nonce": fixedNonce,
        "x-dune-docker-mesh-body-sha256": fixedBodyHash,
        "x-dune-docker-mesh-sig": fixedSig
      },
      body: fixedBody
    });
    await handleI18nRoute({ ...validPushCall, config, auth, apiKeys });
    assert.equal(validPushCall.getStatus(), 200);
    const pushResDecrypted = decryptMeshWireEnvelope(validPushCall.getBody().envelope, fixedNonce, config);
    assert.equal(pushResDecrypted.acceptedCount, 1);
    assert.equal(pushResDecrypted.rejectedUnreviewedCount, 2);

    const dbAfterPush = loadTranslationDatabase(config);
    assert.equal(dbAfterPush.translations.DE.Home, "Startseite");
    assert.equal(dbAfterPush.translations.DE.UNREVIEWED_DYNAMIC_PLAYER_NAME, undefined);
    assert.notEqual(dbAfterPush.translations.DE.Settings, "<script>alert(1)</script>");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Dune-Docker Mesh mutual attestation, SSRF origin normalization, discovery beacons, and placeholder validation", async () => {
  const secret = generateMeshEnrollmentSecret();
  const headers = createDuneDockerMeshHeaders("dune-node-alpha", "GET", "/api/i18n/mesh/manifest", "", secret);
  const valid = verifyDuneDockerMeshHeaders(headers, "GET", "/api/i18n/mesh/manifest", secret);
  assert.equal(valid.valid, true);
  assert.equal(valid.peerNodeId, "dune-node-alpha");

  const replayed = verifyDuneDockerMeshHeaders(headers, "GET", "/api/i18n/mesh/manifest", secret);
  assert.equal(replayed.valid, false);

  assert.equal(normalizeSafeMeshPeerOrigin("http://169.254.169.254:8080"), "");
  assert.equal(normalizeSafeMeshPeerOrigin("http://metadata.google.internal:8080"), "");
  assert.equal(normalizeSafeMeshPeerOrigin("http://user:pass@192.168.1.50:8080"), "");
  assert.equal(normalizeSafeMeshPeerOrigin("http://192.168.1.50:8088/some/path?x=1"), "");
  assert.equal(normalizeSafeMeshPeerOrigin("http://192.168.1.50:8088"), "http://192.168.1.50:8088");

  assert.equal(isSafeReviewedTranslation("Home", "Startseite"), true);
  assert.equal(isSafeReviewedTranslation("Unreviewed_Dynamic_Key", "Startseite"), false);
  assert.equal(isSafeReviewedTranslation("Home", "<img src=x onerror=alert(1)>"), false);
  assert.equal(isSafeReviewedTranslation("Home", "Startseite {injected_placeholder}"), false);

  const beacon = createMeshDiscoveryBeacon("zk-node-lan", 8080, "", secret);
  const verifiedBeacon = verifyMeshDiscoveryBeacon(JSON.stringify(beacon), "192.168.1.50", secret);
  assert.equal(verifiedBeacon.valid, true);
  assert.equal(verifiedBeacon.peerNodeId, "zk-node-lan");
  assert.equal(verifiedBeacon.peerUrl, "http://192.168.1.50:8080");

  const wrongSecretBeacon = verifyMeshDiscoveryBeacon(JSON.stringify(beacon), "192.168.1.50", generateMeshEnrollmentSecret());
  assert.equal(wrongSecretBeacon.valid, false);

  const status = getLanguageCatalogStatus({ generatedDir: join(tmpdir(), "dune-status-check") });
  assert.ok(status.encryptionAlgorithm.includes(ENCRYPTION_METADATA.alg.toUpperCase()));
  assert.ok(isI18nRoute("/api/i18n/languages"));
});

test("Cycling all 53 languages via public GET /api/i18n/translations does not pin dictionaries in __materialized and supports 304 ETag", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "dune-i18n-bounded-lru-"));
  try {
    resetTranslationDatabaseCache();
    const config = {
      generatedDir: join(tempDir, "generated"),
      secretsDir: join(tempDir, "secrets")
    };
    const db = loadTranslationDatabase(config);
    assert.equal(Object.keys(db.translations.__materialized).length, 0);
    const catalogLanguages = getLanguageCatalogStatus(config).languages;
    assert.equal(catalogLanguages.length, 54);

    for (const lang of catalogLanguages) {
      const getCall = createMockHttpCall({
        method: "GET",
        path: "/api/i18n/translations",
        query: `lang=${encodeURIComponent(lang.code)}`
      });
      await handleI18nRoute({ ...getCall, config });
      assert.equal(getCall.getStatus(), 200);
      assert.ok(getCall.getBody().translatedCount > 0);
    }

    // Even after reading all 53 languages via the public endpoint, __materialized stays at 0 entries!
    assert.equal(Object.keys(db.translations.__materialized).length, 0);

    // Submitting or probing POST /api/i18n/suggestions across multiple languages also keeps __materialized at 0
    for (const code of ["DE", "FR", "ES", "JA", "KO", "PL"]) {
      const suggestCall = createMockHttpCall({
        method: "POST",
        path: "/api/i18n/suggestions",
        headers: { "x-csrf-token": "csrf-tok" },
        body: { lang: code, source: "Home", translation: "Start", credit: "Tester" }
      });
      suggestCall.req.authSession = { id: "s1", csrf: "csrf-tok", tier: "observer" };
      await handleI18nRoute({
        ...suggestCall,
        config,
        fetchImpl: async (_url, opts) => {
          const parsed = JSON.parse(opts.body);
          return { ok: true, json: async () => ({ id: parsed.id, reference: "TR-999999" }) };
        }
      });
      assert.equal(suggestCall.getStatus(), 201);
    }
    assert.equal(Object.keys(db.translations.__materialized).length, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
