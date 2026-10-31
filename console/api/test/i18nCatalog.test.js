import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SEED_DB_PATH, SUPPORTED_LANGUAGES, getReviewedSourcePhrases, loadTranslationDatabase,
  resetTranslationDatabaseCache, callNeuralFallbackBatch, callDeepLTranslateBatch,
  saveEncryptedDeepLApiKey, translateAndCacheTexts, isSafeReviewedTranslation,
  encryptMeshWireEnvelope, decryptMeshWireEnvelope
} from "../src/services/i18nService.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "reviewed-catalog-"));
  t.after(() => { resetTranslationDatabaseCache(); rmSync(dir, { recursive: true, force: true }); });
  resetTranslationDatabaseCache();
  return { generatedDir: dir, secretsDir: join(dir, "secrets") };
}

test("an old cached English fallback cannot hide a newer bundled translation", t => {
  const config = fixture(t);
  writeFileSync(join(config.generatedDir, "i18n-translations-db.json"), JSON.stringify({ translations: { DE: { Home: "Home" } } }));
  const seed = JSON.parse(readFileSync(SEED_DB_PATH));
  assert.equal(loadTranslationDatabase(config).translations.DE.Home, seed.translations.DE.Home);
});

test("a real operator-cached translation remains an override", t => {
  const config = fixture(t);
  writeFileSync(join(config.generatedDir, "i18n-translations-db.json"), JSON.stringify({ translations: { DE: { Home: "Eigene Startseite" } } }));
  assert.equal(loadTranslationDatabase(config).translations.DE.Home, "Eigene Startseite");
});

test("missing and invalid fallback responses are not fabricated as English translations", async () => {
  for (const payload of [[], [""], ["<script>invalid</script>"]]) {
    assert.deepEqual(await callNeuralFallbackBatch(["Home"], "DE", { fetchImpl: async () => ({ ok: true, json: async () => payload }) }), {});
  }
  assert.deepEqual(await callNeuralFallbackBatch(["Home"], "DE", { fetchImpl: async () => ({ ok: true, json: async () => ["Home"] }) }), { Home: "Home" });
});

test("a missing DeepL response does not become a successful cached translation", async t => {
  const config = fixture(t);
  saveEncryptedDeepLApiKey("synthetic-test-provider-key:fx", config);
  assert.deepEqual(await callDeepLTranslateBatch(["Home"], "DE", { config, fetchImpl: async () => ({ ok: true, json: async () => ({ translations: [] }) }) }), {});
});

test("failed provider work is neither cached nor reported as a cache hit", async t => {
  const config = fixture(t);
  const db = loadTranslationDatabase(config);
  delete db.translations.DE.Home;
  const result = await translateAndCacheTexts(["Home"], "DE", { config, fetchImpl: async () => ({ ok: true, json: async () => [] }) });
  assert.equal(result.translatedNowCount, 0);
  assert.equal(result.servedFromCacheCount, 0);
  assert.equal(db.translations.DE.Home, undefined);
});

test("reviewed numeric placeholders survive provider translation and native digit formatting", async () => {
  const source = "{count0} of {count1}";
  assert.ok(getReviewedSourcePhrases().includes(source));
  let wire;
  const result = await callNeuralFallbackBatch([source], "AR", { fetchImpl: async (_url, options) => {
    wire = new URLSearchParams(options.body).get("q");
    assert.ok(!wire.includes("{count"));
    return { ok: true, json: async () => [wire.replace(" of ", " من ").replace("8731", "٨٬٧٣١").replace("8732", "٨٬٧٣٢")] };
  } });
  assert.equal(result[source], "{count0} من {count1}");
});

test("translated paragraphs may expand without being discarded as English", () => {
  const source = getReviewedSourcePhrases().find(text => text.length > 200 && !/[{}%]/.test(text));
  assert.ok(source);
  assert.equal(isSafeReviewedTranslation(source, "Eine längere übersetzte Beschreibung. ".repeat(25)), true);
  assert.equal(isSafeReviewedTranslation(source, "<script>invalid</script>"), false);
});

test("every supported language has a safe cached translation for every reviewed phrase", t => {
  const config = fixture(t);
  const db = loadTranslationDatabase(config);
  const sources = getReviewedSourcePhrases();
  for (const language of SUPPORTED_LANGUAGES.filter(item => item.code !== "EN")) {
    const missing = sources.filter(source => !db.translations[language.code]?.[source]);
    assert.deepEqual(missing, [], `${language.code}: missing reviewed interface translations`);
  }
});

test("the expanded bundled dictionaries still fit authenticated peer envelopes", t => {
  const config = fixture(t);
  const db = loadTranslationDatabase(config);
  const enrollment = "Synthetic-Peer-Enrollment-Only-1234567890";
  for (const language of SUPPORTED_LANGUAGES.filter(item => item.code !== "EN")) {
    const payload = { lang: language.code, translations: db.translations[language.code] };
    const encoded = encryptMeshWireEnvelope(payload, "review-nonce", enrollment);
    assert.deepEqual(decryptMeshWireEnvelope(encoded, "review-nonce", enrollment), payload, language.code);
  }
});
