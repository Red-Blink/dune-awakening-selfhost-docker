import crypto from "node:crypto";
import dgram from "node:dgram";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { actionForRoute } from "../actions.js";
import { evaluate } from "../policy.js";
import { submitTranslationCorrection } from './translationSuggestions.js';
import { validateCorrection } from './translationContract.js';

function writeJsonAtomic(filePath, data, mode = undefined) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, mode ? { encoding: "utf8", mode } : "utf8");
  if (mode) {
    try {
      chmodSync(tmpPath, mode);
    } catch {
      // Ignore chmod errors on non-POSIX filesystems
    }
  }
  renameSync(tmpPath, filePath);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../..");
export const SEED_DB_PATH = resolve(__dirname, "../../data/i18n-translations-db.json");

export const ENCRYPTION_METADATA = Object.freeze({
  alg: "aes-256-gcm",
  kdf: "scrypt"
});

const MAX_TRANSLATION_LENGTH = 1800;
const MAX_MESH_ENVELOPE_CHARS = 1024 * 1024;
const MAX_MESH_PEERS = 32;
const MIN_ENROLLMENT_SECRET_LENGTH = 32;
const MIN_ENROLLMENT_SECRET_DISTINCT_CHARS = 8;

function readJsonFileSafe(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

// Load immutable repository seed catalog once at module initialization.
const IMMUTABLE_SEED_RAW = readJsonFileSafe(SEED_DB_PATH) || {
  version: 1,
  updatedAt: "2026-10-30T00:00:00.000Z",
  autoSyncLanguages: [],
  sourceStrings: [],
  translations: {}
};

const REVIEWED_SOURCE_ARRAY = Object.freeze(
  Array.from(
    new Set(
      (Array.isArray(IMMUTABLE_SEED_RAW.sourceStrings) ? IMMUTABLE_SEED_RAW.sourceStrings : [])
        .map((s) => String(s || "").trim())
        .filter(Boolean)
    )
  ).sort()
);

const REVIEWED_SOURCE_PHRASES = new Set(REVIEWED_SOURCE_ARRAY);

export function getReviewedSourcePhrases() {
  return REVIEWED_SOURCE_ARRAY;
}

// Maintainer-reviewed contributions are authoritative, including over older
// provider caches. Machine maintenance never edits these per-language files.
export function applyReviewedCorrections(db, corrections) {
  for (const [lang, phrases] of Object.entries(corrections)) {
    if (!SUPPORTED_LANGUAGES.some(item => item.code === lang && lang !== 'EN')) continue;
    for (const [source, translation] of Object.entries(phrases || {})) {
      if (isSafeReviewedTranslation(source, translation)) {
        db.translations[lang] ||= {};
        db.translations[lang][source] = translation;
      }
    }
  }
  return db;
}
function bundledCorrections() {
  const directory = resolve(__dirname,'../../data/i18n-reviewed');
  if (!existsSync(directory)) return {};
  return Object.fromEntries(readdirSync(directory).filter(file => /^[A-Z]{2}(?:-[A-Z]{2,4})?\.json$/.test(file))
    .map(file => [file.slice(0,-5),readJsonFileSafe(resolve(directory,file)) || {}]));
}

export function isReviewedUiPhrase(raw) {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  return REVIEWED_SOURCE_PHRASES.has(trimmed);
}

export function extractPhrasePlaceholders(text) {
  const matches = String(text || "").match(/\{\{[a-zA-Z0-9_.-]+\}\}|\{[a-zA-Z0-9_.-]+\}|%[sd]/g) || [];
  return [...matches].sort();
}

// Providers can translate words inside {placeholders}. Use static numeric
// stand-ins, then restore the reviewed tokens before validating or caching.
// These are maintenance tokens, never live player/server values.
function protectPlaceholders(source) {
  let next = 8731;
  const tokens = new Map();
  const text = source.replace(/\{\{[a-zA-Z0-9_.-]+\}\}|\{[a-zA-Z0-9_.-]+\}|%[sd]/g, token => {
    if (!tokens.has(token)) {
      while (source.includes(String(next))) next++;
      tokens.set(token, String(next++));
    }
    return tokens.get(token);
  });
  return {
    text,
    restore(candidate) {
      if (typeof candidate !== "string") return "";
      for (const [token, standIn] of tokens) {
        const digits = [...standIn].map(digit => `[${digit}${[0x660, 0x6f0, 0x966, 0x9e6, 0xe50, 0xff10].map(start => String.fromCodePoint(start + Number(digit))).join("")}]`);
        const pattern = new RegExp(digits.join("[.,\\s\\u00a0\\u202f\\u066c]*"), "g");
        if (!pattern.test(candidate)) return "";
        candidate = candidate.replace(pattern, () => token);
      }
      return candidate;
    }
  };
}

export function isSafeReviewedTranslation(sourcePhrase, translatedText) {
  const src = String(sourcePhrase || "").trim();
  const trans = String(translatedText || "").trim();
  if (!isReviewedUiPhrase(src)) return false;
  if (!trans || trans.length > MAX_TRANSLATION_LENGTH) return false;
  if (/[<>]|\0/.test(trans)) return false;
  const srcPlaceholders = extractPhrasePlaceholders(src);
  const transPlaceholders = extractPhrasePlaceholders(trans);
  if (srcPlaceholders.length !== transPlaceholders.length) return false;
  for (let i = 0; i < srcPlaceholders.length; i += 1) {
    if (srcPlaceholders[i] !== transPlaceholders[i]) return false;
  }
  return true;
}

export function isTranslatableText(raw) {
  return isReviewedUiPhrase(raw);
}

export function resolveRuntimeGeneratedDir(config) {
  if (config?.generatedDir) return resolve(String(config.generatedDir));
  if (config?.runtimeGeneratedDir) return resolve(String(config.runtimeGeneratedDir));
  if (config?.repoRoot) return resolve(String(config.repoRoot), "runtime/generated");
  return join(REPO_ROOT, "runtime/generated");
}

export function resolveSecretsDir(config) {
  if (config?.secretsDir) return resolve(String(config.secretsDir));
  if (config?.generatedDir) return resolve(String(config.generatedDir), "../secrets");
  if (config?.runtimeGeneratedDir) return resolve(String(config.runtimeGeneratedDir), "../secrets");
  if (config?.repoRoot) return resolve(String(config.repoRoot), "runtime/secrets");
  return join(REPO_ROOT, "runtime/secrets");
}

function masterKeyPath(config) {
  return join(resolveSecretsDir(config), ".deepl-master.key");
}

function vaultFilePath(config) {
  return join(resolveRuntimeGeneratedDir(config), "deepl-vault.json");
}

function meshEnrollmentVaultPath(config) {
  return join(resolveRuntimeGeneratedDir(config), "i18n-mesh-enrollment.vault.json");
}

export function runtimeDbPath(config) {
  const candidate = join(resolveRuntimeGeneratedDir(config), "i18n-translations-db.json");
  if (resolve(candidate) === resolve(SEED_DB_PATH)) {
    return join(REPO_ROOT, "runtime/generated/i18n-translations-db.json");
  }
  return candidate;
}

function getOrCreateMasterSecret(config) {
  const envSecret = String(process.env.DEEPL_VAULT_MASTER_KEY || "").trim();
  if (envSecret) return envSecret;
  const keyFile = masterKeyPath(config);
  try {
    if (existsSync(keyFile)) {
      const existing = readFileSync(keyFile, "utf8").trim();
      if (existing.length >= 32) return existing;
    }
    mkdirSync(dirname(keyFile), { recursive: true });
    const generated = crypto.randomBytes(32).toString("base64");
    writeFileSync(keyFile, `${generated}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(keyFile, 0o600);
    } catch {
      // Ignore on filesystems without POSIX permissions
    }
    return generated;
  } catch {
    return String(config?.sessionSecret || "dune-local-ephemeral-vault-key");
  }
}

export function encryptDeepLApiKey(plainKey, masterSecret = "dune-local-ephemeral-vault-key") {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(String(masterSecret), salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plainKey).trim(), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: "aes-256-gcm",
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

export function decryptDeepLVaultPayload(vault, masterSecret = "dune-local-ephemeral-vault-key") {
  if (!vault || typeof vault !== "object") return "";
  const salt = Buffer.from(String(vault.salt || ""), "base64");
  const iv = Buffer.from(String(vault.iv || ""), "base64");
  const tag = Buffer.from(String(vault.tag || ""), "base64");
  const ciphertext = Buffer.from(String(vault.ciphertext || ""), "base64");
  if (salt.length < 8 || iv.length !== 12 || tag.length !== 16) return "";
  const key = crypto.scryptSync(String(masterSecret), salt, 32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8").trim();
}

export function saveEncryptedDeepLApiKey(plainKey, config = {}) {
  const cleaned = String(plainKey || "").trim();
  if (!cleaned) {
    throw new Error("DeepL API key must not be empty.");
  }
  const masterSecret = getOrCreateMasterSecret(config);
  const encrypted = encryptDeepLApiKey(cleaned, masterSecret);
  const vPath = vaultFilePath(config);
  mkdirSync(dirname(vPath), { recursive: true });
  writeJsonAtomic(
    vPath,
    {
      version: 1,
      updatedAt: new Date().toISOString(),
      vault: encrypted
    },
    0o600
  );
  return encrypted;
}

export function deleteEncryptedDeepLApiKey(config = {}) {
  const vPath = vaultFilePath(config);
  try {
    if (existsSync(vPath)) {
      writeJsonAtomic(vPath, { version: 1, updatedAt: new Date().toISOString(), vault: null }, 0o600);
    }
  } catch {
    // Ignore errors when clearing vault file
  }
  return { ok: true, encryptedKeyConfigured: false };
}

export function decryptDeepLApiKey(configOrVault = {}) {
  if (
    configOrVault &&
    typeof configOrVault === "object" &&
    typeof configOrVault.ciphertext === "string" &&
    typeof configOrVault.salt === "string"
  ) {
    return decryptDeepLVaultPayload(configOrVault, configOrVault.masterSecret || "dune-local-ephemeral-vault-key");
  }

  const envKey = String(process.env.DEEPL_API_KEY || "").trim();
  if (envKey) return envKey;

  const dockerSecretPath = "/run/secrets/deepl_api_key";
  try {
    if (existsSync(dockerSecretPath)) {
      const secretVal = readFileSync(dockerSecretPath, "utf8").trim();
      if (secretVal) return secretVal;
    }
  } catch {
    // Ignore unreadable docker secret path
  }

  const vPath = vaultFilePath(configOrVault);
  try {
    if (existsSync(vPath)) {
      const parsed = JSON.parse(readFileSync(vPath, "utf8"));
      const vault = parsed?.vault || parsed;
      if (vault?.ciphertext) {
        const masterSecret = getOrCreateMasterSecret(configOrVault);
        return decryptDeepLVaultPayload(vault, masterSecret);
      }
    }
  } catch {
    return "";
  }
  return "";
}

export function deeplApiBaseUrl(apiKey) {
  const override = String(process.env.DEEPL_API_URL || "").trim();
  if (override) return override.replace(/\/+$/, "");
  return String(apiKey || "").endsWith(":fx")
    ? "https://api-free.deepl.com/v2"
    : "https://api.deepl.com/v2";
}

export const SUPPORTED_LANGUAGES = Object.freeze([
  { code: "EN", deeplCode: "EN-US", gtxCode: "en", name: "English", nativeName: "English", region: "GB / US", dir: "ltr", core: true },
  { code: "DE", deeplCode: "DE", gtxCode: "de", name: "German", nativeName: "Deutsch", region: "DE / AT / CH", dir: "ltr", core: true },
  { code: "FR", deeplCode: "FR", gtxCode: "fr", name: "French", nativeName: "Français", region: "FR / BE / CH / CA", dir: "ltr", core: true },
  { code: "ES", deeplCode: "ES", gtxCode: "es", name: "Spanish", nativeName: "Español", region: "ES / LATAM", dir: "ltr", core: true },
  { code: "IT", deeplCode: "IT", gtxCode: "it", name: "Italian", nativeName: "Italiano", region: "IT / CH", dir: "ltr", core: true },
  { code: "NL", deeplCode: "NL", gtxCode: "nl", name: "Dutch", nativeName: "Nederlands", region: "NL / BE", dir: "ltr", core: true },
  { code: "PL", deeplCode: "PL", gtxCode: "pl", name: "Polish", nativeName: "Polski", region: "PL", dir: "ltr", core: true },
  { code: "PT-PT", deeplCode: "PT-PT", gtxCode: "pt", name: "Portuguese", nativeName: "Português", region: "PT", dir: "ltr", core: true },
  { code: "PT-BR", deeplCode: "PT-BR", gtxCode: "pt", name: "Portuguese (Brazil)", nativeName: "Português (Brasil)", region: "BR", dir: "ltr", core: true },
  { code: "RU", deeplCode: "RU", gtxCode: "ru", name: "Russian", nativeName: "Русский", region: "RU", dir: "ltr", core: true },
  { code: "UK", deeplCode: "UK", gtxCode: "uk", name: "Ukrainian", nativeName: "Українська", region: "UA", dir: "ltr", core: true },
  { code: "TR", deeplCode: "TR", gtxCode: "tr", name: "Turkish", nativeName: "Türkçe", region: "TR", dir: "ltr", core: true },
  { code: "JA", deeplCode: "JA", gtxCode: "ja", name: "Japanese", nativeName: "日本語", region: "JP", dir: "ltr", core: true },
  { code: "KO", deeplCode: "KO", gtxCode: "ko", name: "Korean", nativeName: "한국어", region: "KR", dir: "ltr", core: true },
  { code: "ZH-HANS", deeplCode: "ZH-HANS", gtxCode: "zh-CN", name: "Chinese (Simplified)", nativeName: "简体中文", region: "CN / SG", dir: "ltr", core: true },
  { code: "ZH-HANT", deeplCode: "ZH-HANT", gtxCode: "zh-TW", name: "Chinese (Traditional)", nativeName: "繁體中文", region: "TW / HK", dir: "ltr", core: true },
  { code: "AR", deeplCode: "AR", gtxCode: "ar", name: "Arabic", nativeName: "العربية", region: "MENA", dir: "rtl", core: true },
  { code: "CS", deeplCode: "CS", gtxCode: "cs", name: "Czech", nativeName: "Čeština", region: "CZ", dir: "ltr", core: true },
  { code: "DA", deeplCode: "DA", gtxCode: "da", name: "Danish", nativeName: "Dansk", region: "DK", dir: "ltr", core: true },
  { code: "FI", deeplCode: "FI", gtxCode: "fi", name: "Finnish", nativeName: "Suomi", region: "FI", dir: "ltr", core: true },
  { code: "EL", deeplCode: "EL", gtxCode: "el", name: "Greek", nativeName: "Ελληνικά", region: "GR / CY", dir: "ltr", core: true },
  { code: "HU", deeplCode: "HU", gtxCode: "hu", name: "Hungarian", nativeName: "Magyar", region: "HU", dir: "ltr", core: true },
  { code: "NB", deeplCode: "NB", gtxCode: "no", name: "Norwegian", nativeName: "Norsk (Bokmål)", region: "NO", dir: "ltr", core: true },
  { code: "RO", deeplCode: "RO", gtxCode: "ro", name: "Romanian", nativeName: "Română", region: "RO / MD", dir: "ltr", core: true },
  { code: "SK", deeplCode: "SK", gtxCode: "sk", name: "Slovak", nativeName: "Slovenčina", region: "SK", dir: "ltr", core: true },
  { code: "SV", deeplCode: "SV", gtxCode: "sv", name: "Swedish", nativeName: "Svenska", region: "SE", dir: "ltr", core: true },
  { code: "BG", deeplCode: "BG", gtxCode: "bg", name: "Bulgarian", nativeName: "Български", region: "BG", dir: "ltr", core: true },
  { code: "HR", deeplCode: "HR", gtxCode: "hr", name: "Croatian", nativeName: "Hrvatski", region: "HR", dir: "ltr", core: false },
  { code: "SR", deeplCode: "SR", gtxCode: "sr", name: "Serbian", nativeName: "Српски", region: "RS", dir: "ltr", core: false },
  { code: "SL", deeplCode: "SL", gtxCode: "sl", name: "Slovenian", nativeName: "Slovenščina", region: "SI", dir: "ltr", core: false },
  { code: "ET", deeplCode: "ET", gtxCode: "et", name: "Estonian", nativeName: "Eesti", region: "EE", dir: "ltr", core: false },
  { code: "LT", deeplCode: "LT", gtxCode: "lt", name: "Lithuanian", nativeName: "Lietuvių", region: "LT", dir: "ltr", core: false },
  { code: "LV", deeplCode: "LV", gtxCode: "lv", name: "Latvian", nativeName: "Latviešu", region: "LV", dir: "ltr", core: false },
  { code: "ID", deeplCode: "ID", gtxCode: "id", name: "Indonesian", nativeName: "Bahasa Indonesia", region: "ID", dir: "ltr", core: true },
  { code: "VI", deeplCode: "VI", gtxCode: "vi", name: "Vietnamese", nativeName: "Tiếng Việt", region: "VN", dir: "ltr", core: true },
  { code: "TH", deeplCode: "TH", gtxCode: "th", name: "Thai", nativeName: "ไทย", region: "TH", dir: "ltr", core: true },
  { code: "HI", deeplCode: "HI", gtxCode: "hi", name: "Hindi", nativeName: "हिन्दी", region: "IN", dir: "ltr", core: true },
  { code: "HE", deeplCode: "HE", gtxCode: "iw", name: "Hebrew", nativeName: "עברית", region: "IL", dir: "rtl", core: false },
  { code: "FA", deeplCode: "FA", gtxCode: "fa", name: "Persian", nativeName: "فارسی", region: "IR", dir: "rtl", core: false },
  { code: "UR", deeplCode: "UR", gtxCode: "ur", name: "Urdu", nativeName: "اردو", region: "PK", dir: "rtl", core: false },
  { code: "MS", deeplCode: "MS", gtxCode: "ms", name: "Malay", nativeName: "Bahasa Melayu", region: "MY", dir: "ltr", core: false },
  { code: "TL", deeplCode: "TL", gtxCode: "tl", name: "Tagalog", nativeName: "Tagalog", region: "PH", dir: "ltr", core: false },
  { code: "BN", deeplCode: "BN", gtxCode: "bn", name: "Bengali", nativeName: "বাংলা", region: "BD / IN", dir: "ltr", core: false },
  { code: "IS", deeplCode: "IS", gtxCode: "is", name: "Icelandic", nativeName: "Íslenska", region: "IS", dir: "ltr", core: false },
  { code: "SQ", deeplCode: "SQ", gtxCode: "sq", name: "Albanian", nativeName: "Shqip", region: "AL", dir: "ltr", core: false },
  { code: "MK", deeplCode: "MK", gtxCode: "mk", name: "Macedonian", nativeName: "Македонски", region: "MK", dir: "ltr", core: false },
  { code: "KA", deeplCode: "KA", gtxCode: "ka", name: "Georgian", nativeName: "ქართული", region: "GE", dir: "ltr", core: false },
  { code: "HY", deeplCode: "HY", gtxCode: "hy", name: "Armenian", nativeName: "Հայերեն", region: "AM", dir: "ltr", core: false },
  { code: "AZ", deeplCode: "AZ", gtxCode: "az", name: "Azerbaijani", nativeName: "Azərbaycan", region: "AZ", dir: "ltr", core: false },
  { code: "KK", deeplCode: "KK", gtxCode: "kk", name: "Kazakh", nativeName: "Қазақ тілі", region: "KZ", dir: "ltr", core: false },
  { code: "UZ", deeplCode: "UZ", gtxCode: "uz", name: "Uzbek", nativeName: "Oʻzbekcha", region: "UZ", dir: "ltr", core: false },
  { code: "CA", deeplCode: "CA", gtxCode: "ca", name: "Catalan", nativeName: "Català", region: "ES-CT", dir: "ltr", core: false },
  { code: "AF", deeplCode: "AF", gtxCode: "af", name: "Afrikaans", nativeName: "Afrikaans", region: "ZA", dir: "ltr", core: false },
  { code: "SW", deeplCode: "SW", gtxCode: "sw", name: "Swahili", nativeName: "Kiswahili", region: "KE / TZ", dir: "ltr", core: false }
]);

const LANGUAGE_MAP = new Map(SUPPORTED_LANGUAGES.map((lang) => [lang.code.toUpperCase(), lang]));

export function normalizeLanguageCode(input) {
  const raw = String(input || "").trim().toUpperCase();
  if (!raw) return "EN";
  if (LANGUAGE_MAP.has(raw)) return raw;
  if (raw === "ZH" || raw === "ZH-CN") return "ZH-HANS";
  if (raw === "ZH-TW" || raw === "ZH-HK") return "ZH-HANT";
  if (raw === "PT") return "PT-PT";
  if (raw === "NO") return "NB";
  if (raw.startsWith("EN-")) return "EN";
  if (raw.startsWith("DE-")) return "DE";
  if (raw.startsWith("FR-")) return "FR";
  if (raw.startsWith("ES-")) return "ES";
  const prefix = raw.split("-")[0];
  if (LANGUAGE_MAP.has(prefix)) return prefix;
  return null;
}

let memoryDb = null;
let loadedRuntimePath = null;
const inFlightTranslations = new Map();
let backgroundDeltaSyncRunning = false;
let lastDeltaSyncAt = null;
let lastDeltaSyncError = null;

function mergeDatabasePayloads(seed, overlay) {
  // Source phrases are strictly pinned to the immutable repository-reviewed seed catalog.
  const sourceStrings = [...REVIEWED_SOURCE_ARRAY];
  const translations = {};
  for (const src of [seed?.translations, overlay?.translations]) {
    if (!src || typeof src !== "object") continue;
    for (const [langKey, dict] of Object.entries(src)) {
      const code = normalizeLanguageCode(langKey);
      if (!code || code === "EN" || !dict || typeof dict !== "object") continue;
      if (!translations[code]) translations[code] = {};
      for (const [orig, translated] of Object.entries(dict)) {
        const cleanOrig = String(orig || "").trim();
        const cleanTrans = String(translated || "").trim();
        if (isSafeReviewedTranslation(cleanOrig, cleanTrans)) {
          // Old provider failures were cached as English. They must not hide
          // a real translation supplied by a newer reviewed seed catalog.
          const existing = translations[code][cleanOrig];
          if (cleanTrans === cleanOrig && existing && existing !== cleanOrig) continue;
          translations[code][cleanOrig] = cleanTrans;
        }
      }
    }
  }
  const autoSyncSet = new Set(
    SUPPORTED_LANGUAGES.filter((l) => l.core && l.code !== "EN").map((l) => l.code)
  );
  for (const list of [seed?.autoSyncLanguages, overlay?.autoSyncLanguages]) {
    if (Array.isArray(list)) {
      for (const item of list) {
        const code = normalizeLanguageCode(item);
        if (code && code !== "EN") autoSyncSet.add(code);
      }
    }
  }
  for (const code of Object.keys(translations)) {
    autoSyncSet.add(code);
  }
  return {
    version: 1,
    updatedAt: overlay?.updatedAt || seed?.updatedAt || new Date().toISOString(),
    autoSyncLanguages: Array.from(autoSyncSet).sort(),
    sourceStrings,
    translations
  };
}

export function loadTranslationDatabase(config) {
  const rtPath = runtimeDbPath(config);
  if (memoryDb && loadedRuntimePath === rtPath) {
    return memoryDb;
  }
  const runtime = readJsonFileSafe(rtPath);
  memoryDb = applyReviewedCorrections(mergeDatabasePayloads(IMMUTABLE_SEED_RAW, runtime), bundledCorrections());
  loadedRuntimePath = rtPath;
  return memoryDb;
}

export function resetTranslationDatabaseCache() {
  memoryDb = null;
  loadedRuntimePath = null;
  volatilePeerVaultByScope.clear();
  envPeersBootstrappedScopes.clear();
  seenMeshNonces.clear();
}

export function saveTranslationDatabase(config, db = memoryDb) {
  if (!db) return;
  applyReviewedCorrections(db,bundledCorrections());
  const rtPath = runtimeDbPath(config);
  if (resolve(rtPath) === resolve(SEED_DB_PATH)) {
    throw new Error("Refusing to overwrite immutable repository seed translation database.");
  }
  // Ensure only reviewed source phrases and safe translations are persisted to runtime cache.
  const sanitizedTranslations = {};
  for (const [langCode, dict] of Object.entries(db.translations || {})) {
    const code = normalizeLanguageCode(langCode);
    if (!code || code === "EN" || !dict || typeof dict !== "object") continue;
    sanitizedTranslations[code] = {};
    for (const [orig, trans] of Object.entries(dict)) {
      if (isSafeReviewedTranslation(orig, trans)) {
        sanitizedTranslations[code][orig.trim()] = String(trans).trim();
      }
    }
  }
  const payloadToWrite = {
    version: 1,
    updatedAt: new Date().toISOString(),
    autoSyncLanguages: Array.from(new Set((db.autoSyncLanguages || []).map(normalizeLanguageCode).filter((c) => c && c !== "EN"))).sort(),
    sourceStrings: [...REVIEWED_SOURCE_ARRAY],
    translations: sanitizedTranslations
  };
  db.updatedAt = payloadToWrite.updatedAt;
  db.sourceStrings = [...REVIEWED_SOURCE_ARRAY];
  db.translations = sanitizedTranslations;
  try {
    mkdirSync(dirname(rtPath), { recursive: true });
    writeJsonAtomic(rtPath, payloadToWrite, 0o600);
  } catch {
    // Ignore read-only runtime dir errors in restricted test sandboxes
  }
}

export async function callNeuralFallbackBatch(texts, targetLangCode, { fetchImpl = globalThis.fetch } = {}) {
  const langMeta = LANGUAGE_MAP.get(targetLangCode);
  // Defense-in-depth: never send unreviewed/dynamic text to external fallback providers.
  const reviewedTexts = Array.from(
    new Set((Array.isArray(texts) ? texts : []).map((t) => String(t || "").trim()).filter(isReviewedUiPhrase))
  );
  if (reviewedTexts.length === 0) {
    return {};
  }
  if (!langMeta || targetLangCode === "EN") {
    return Object.fromEntries(reviewedTexts.map((t) => [t, t]));
  }
  const tl = langMeta.gtxCode || targetLangCode.toLowerCase();
  const results = {};
  const CHUNK_SIZE = 25;

  for (let i = 0; i < reviewedTexts.length; i += CHUNK_SIZE) {
    const chunk = reviewedTexts.slice(i, i + CHUNK_SIZE);
    const protectedTexts = chunk.map(protectPlaceholders);
    const params = new URLSearchParams();
    for (const item of protectedTexts) {
      params.append("q", item.text);
    }
    const url = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=${encodeURIComponent(tl)}`;
    const fetchOpts = {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: params.toString()
    };
    if (fetchImpl === globalThis.fetch && typeof AbortSignal?.timeout === "function") {
      fetchOpts.signal = AbortSignal.timeout(10000);
    }
    const response = await fetchImpl(url, fetchOpts);
    if (!response.ok) {
      throw new Error(`Fallback translation HTTP ${response.status}`);
    }
    const data = await response.json();
    const list = Array.isArray(data) ? data : [];
    for (let idx = 0; idx < chunk.length; idx += 1) {
      const entry = list[idx];
      const textVal = Array.isArray(entry) ? entry[0] : entry;
      const candidate = protectedTexts[idx].restore(textVal).trim();
      if (isSafeReviewedTranslation(chunk[idx], candidate)) results[chunk[idx]] = candidate;
    }
  }
  return results;
}

export async function callDeepLTranslateBatch(texts, targetLangCode, { config = {}, fetchImpl = globalThis.fetch } = {}) {
  const langMeta = LANGUAGE_MAP.get(targetLangCode);
  // Defense-in-depth: strictly restrict external provider calls to repository-reviewed UI phrases.
  const cleanTexts = Array.from(
    new Set((Array.isArray(texts) ? texts : []).map((t) => String(t || "").trim()).filter(isReviewedUiPhrase))
  );
  if (cleanTexts.length === 0) return {};
  if (!langMeta || targetLangCode === "EN") {
    return Object.fromEntries(cleanTexts.map((t) => [t, t]));
  }

  const apiKey = decryptDeepLApiKey(config);
  if (apiKey) {
    try {
      const baseUrl = deeplApiBaseUrl(apiKey);
      const results = {};
      const BATCH_SIZE = 45;

      for (let i = 0; i < cleanTexts.length; i += BATCH_SIZE) {
        const chunk = cleanTexts.slice(i, i + BATCH_SIZE);
        const protectedTexts = chunk.map(protectPlaceholders);
        const deeplOpts = {
          method: "POST",
          headers: {
            "Authorization": `DeepL-Auth-Key ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            text: protectedTexts.map(item => item.text),
            source_lang: "EN",
            target_lang: langMeta.deeplCode,
            preserve_formatting: true
          })
        };
        if (fetchImpl === globalThis.fetch && typeof AbortSignal?.timeout === "function") {
          deeplOpts.signal = AbortSignal.timeout(10000);
        }
        const response = await fetchImpl(`${baseUrl}/translate`, deeplOpts);
        if (!response.ok) {
          const errBody = await response.text().catch(() => "");
          throw new Error(`DeepL API HTTP ${response.status}: ${errBody.slice(0, 200)}`);
        }
        const payload = await response.json();
        const list = Array.isArray(payload?.translations) ? payload.translations : [];
        for (let idx = 0; idx < chunk.length; idx += 1) {
          const translatedText = protectedTexts[idx].restore(list[idx]?.text).trim();
          if (isSafeReviewedTranslation(chunk[idx], translatedText)) results[chunk[idx]] = translatedText;
        }
      }
      return results;
    } catch (deeplErr) {
      if (fetchImpl !== globalThis.fetch) {
        throw deeplErr;
      }
      // Fall through to neural fallback for reviewed phrases only when DeepL quota or connectivity is unavailable
    }
  }

  return callNeuralFallbackBatch(cleanTexts, targetLangCode, { fetchImpl });
}

export async function translateAndCacheTexts(texts, targetLangInput, { config, fetchImpl = globalThis.fetch } = {}) {
  const code = normalizeLanguageCode(targetLangInput);
  if (!code) {
    throw new Error(`Unsupported language code: ${targetLangInput}`);
  }
  const db = loadTranslationDatabase(config);
  const inputList = (Array.isArray(texts) ? texts : []).map((t) => String(t || "").trim()).filter(Boolean);
  const reviewedTexts = Array.from(new Set(inputList.filter(isReviewedUiPhrase)));
  const rejectedUnreviewedCount = inputList.filter((t) => !isReviewedUiPhrase(t)).length;

  // Dynamic/unknown strings are never added to db.sourceStrings, never cached, and never sent to providers.
  if (code === "EN" || reviewedTexts.length === 0) {
    return {
      lang: code,
      dir: LANGUAGE_MAP.get(code)?.dir || "ltr",
      translations: Object.fromEntries(reviewedTexts.map((t) => [t, t])),
      newlyAddedCount: 0,
      rejectedUnreviewedCount,
      translatedNowCount: 0,
      servedFromCacheCount: reviewedTexts.length
    };
  }

  if (!db.translations[code]) {
    db.translations[code] = {};
  }
  if (!db.autoSyncLanguages.includes(code)) {
    db.autoSyncLanguages.push(code);
  }

  const langDict = db.translations[code];
  let missingForTarget = reviewedTexts.filter((t) => !langDict[t]);
  let translatedNowCount = 0;

  if (missingForTarget.length > 0) {
    await syncLanguagePacksFromPeers(config, { targetLang: code, fetchImpl }).catch(() => {});
    missingForTarget = reviewedTexts.filter((t) => !langDict[t]);
  }

  if (missingForTarget.length > 0) {
    const lockKey = `${code}:${missingForTarget.slice(0, 5).join("|")}:${missingForTarget.length}`;
    let batchPromise = inFlightTranslations.get(lockKey);
    if (!batchPromise) {
      batchPromise = callDeepLTranslateBatch(missingForTarget, code, { config, fetchImpl }).finally(() => {
        inFlightTranslations.delete(lockKey);
      });
      inFlightTranslations.set(lockKey, batchPromise);
    }
    const fetched = await batchPromise;
    for (const [orig, trans] of Object.entries(fetched)) {
      if (isSafeReviewedTranslation(orig, trans)) {
        langDict[orig] = trans;
        translatedNowCount += 1;
      }
    }
  }

  if (translatedNowCount > 0) {
    saveTranslationDatabase(config, db);
    Promise.resolve()
      .then(() => pushLanguagePackToPeers(code, langDict, config, { fetchImpl }))
      .catch(() => {});
  }

  const responseMap = {};
  for (const text of reviewedTexts) {
    responseMap[text] = langDict[text] || text;
  }

  const langMeta = LANGUAGE_MAP.get(code);
  return {
    lang: code,
    dir: langMeta?.dir || "ltr",
    translations: responseMap,
    newlyAddedCount: 0,
    rejectedUnreviewedCount,
    translatedNowCount,
    servedFromCacheCount: reviewedTexts.filter(text => Boolean(langDict[text])).length - translatedNowCount
  };
}

export function triggerBackgroundDeltaSync() {
  // Automatic background all-language synchronization for unknown text is disabled by policy.
  return false;
}

export async function syncAllDatabaseLanguages(config, { languages = null, fetchImpl = globalThis.fetch } = {}) {
  const db = loadTranslationDatabase(config);
  const requested = Array.isArray(languages) && languages.length > 0
    ? languages.map(normalizeLanguageCode).filter((c) => c && c !== "EN")
    : Array.from(new Set([
        ...(db.autoSyncLanguages || []),
        ...Object.keys(db.translations || {})
      ])).filter((c) => c && c !== "EN");

  const summary = {};
  let totalTranslated = 0;
  for (const lang of requested) {
    if (!db.translations[lang]) db.translations[lang] = {};
    if (!db.autoSyncLanguages.includes(lang)) db.autoSyncLanguages.push(lang);
    const missing = REVIEWED_SOURCE_ARRAY.filter((src) => !db.translations[lang][src]);
    let translatedNow = 0;
    if (missing.length > 0) {
      const fetched = await callDeepLTranslateBatch(missing, lang, { config, fetchImpl });
      for (const [orig, trans] of Object.entries(fetched)) {
        if (isSafeReviewedTranslation(orig, trans)) {
          db.translations[lang][orig] = trans;
          totalTranslated += 1;
          translatedNow += 1;
        }
      }
      Promise.resolve()
        .then(() => pushLanguagePackToPeers(lang, db.translations[lang], config, { fetchImpl }))
        .catch(() => {});
    }
    summary[lang] = {
      translatedNow,
      remaining: REVIEWED_SOURCE_ARRAY.filter(src => !db.translations[lang][src]).length,
      totalCached: Object.keys(db.translations[lang]).length
    };
  }
  if (totalTranslated > 0) {
    saveTranslationDatabase(config, db);
  }
  lastDeltaSyncAt = new Date().toISOString();
  return {
    ok: true,
    totalSourceStrings: REVIEWED_SOURCE_ARRAY.length,
    totalTranslatedNow: totalTranslated,
    updatedAt: db.updatedAt,
    languages: summary
  };
}

// ============================================================================
// Per-Installation Trust Enrollment & Opt-In Encrypted Language Mesh
// ============================================================================
// No public protocol key is used. Mesh operations require explicit Owner opt-in
// (`peerSyncEnabled: true`) AND a per-installation high-entropy enrollment secret
// (`meshEnrollmentKey`, >= 32 characters with >= 8 distinct characters) stored
// encrypted at rest in the host's generatedDir vault.

const RAM_EPHEMERAL_KEY = crypto.randomBytes(32);
const RAM_NODE_ID = `zk-node-${crypto.randomBytes(8).toString("hex")}`;
const volatilePeerVaultByScope = new Map();
const envPeersBootstrappedScopes = new Set();
const seenMeshNonces = new Map();

export function isValidMeshEnrollmentSecret(secret) {
  if (typeof secret !== "string") return false;
  const trimmed = secret.trim();
  if (trimmed.length < MIN_ENROLLMENT_SECRET_LENGTH || trimmed.length > 512) return false;
  return new Set(trimmed).size >= MIN_ENROLLMENT_SECRET_DISTINCT_CHARS;
}

export function generateMeshEnrollmentSecret() {
  return crypto.randomBytes(32).toString("hex");
}

export function saveMeshEnrollmentSecret(plainSecret, config = {}) {
  const cleaned = String(plainSecret || "").trim();
  if (!isValidMeshEnrollmentSecret(cleaned)) {
    throw new Error("Mesh enrollment secret must be at least 32 characters with at least 8 distinct characters.");
  }
  const masterSecret = getOrCreateMasterSecret(config);
  const encrypted = encryptDeepLApiKey(cleaned, masterSecret);
  const vPath = meshEnrollmentVaultPath(config);
  mkdirSync(dirname(vPath), { recursive: true });
  writeJsonAtomic(
    vPath,
    {
      version: 1,
      updatedAt: new Date().toISOString(),
      vault: encrypted
    },
    0o600
  );
  return encrypted;
}

export function resolveMeshEnrollmentSecret(configOrSecret = {}) {
  if (typeof configOrSecret === "string") {
    return isValidMeshEnrollmentSecret(configOrSecret) ? configOrSecret.trim() : "";
  }
  if (configOrSecret && typeof configOrSecret.meshEnrollmentKey === "string") {
    return isValidMeshEnrollmentSecret(configOrSecret.meshEnrollmentKey)
      ? configOrSecret.meshEnrollmentKey.trim()
      : "";
  }
  const envSecret = String(process.env.DUNE_I18N_MESH_ENROLLMENT_KEY || "").trim();
  if (isValidMeshEnrollmentSecret(envSecret)) {
    return envSecret;
  }
  const vPath = meshEnrollmentVaultPath(configOrSecret);
  try {
    if (existsSync(vPath)) {
      const parsed = JSON.parse(readFileSync(vPath, "utf8"));
      const vault = parsed?.vault || parsed;
      if (vault?.ciphertext) {
        const masterSecret = getOrCreateMasterSecret(configOrSecret);
        const decrypted = decryptDeepLVaultPayload(vault, masterSecret);
        return isValidMeshEnrollmentSecret(decrypted) ? decrypted : "";
      }
    }
  } catch {
    return "";
  }
  return "";
}

function deriveMeshSigningKey(configOrSecret) {
  const secret = resolveMeshEnrollmentSecret(configOrSecret);
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update("dune-docker-mesh-signing-key:v2", "utf8").digest();
}

function deriveMeshEnvelopeKey(contextNonce = "", configOrSecret = {}) {
  const secret = resolveMeshEnrollmentSecret(configOrSecret);
  if (!secret) return null;
  return crypto
    .createHmac("sha256", secret)
    .update(`dune-docker-zk-envelope:v2:${String(contextNonce)}`, "utf8")
    .digest();
}

function consumeMeshReplayNonce(scopePrefix, nonce, nowSec) {
  if (!/^[0-9a-f]{24,64}$/i.test(String(nonce || ""))) return false;
  if (seenMeshNonces.size > 4000) {
    for (const [k, exp] of seenMeshNonces.entries()) {
      if (exp < nowSec) seenMeshNonces.delete(k);
    }
  }
  const key = `${scopePrefix}:${nonce}`;
  const existingExp = seenMeshNonces.get(key);
  if (existingExp && existingExp >= nowSec) {
    return false;
  }
  seenMeshNonces.set(key, nowSec + 130);
  return true;
}

export function normalizeSafeMeshPeerOrigin(rawUrl) {
  try {
    const clean = String(rawUrl || "").trim().replace(/\/+$/, "");
    if (!clean || clean.length > 256) return "";
    const parsed = new URL(clean);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    if (parsed.username || parsed.password) return "";
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) return "";
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      !host ||
      host === "0.0.0.0" ||
      host === "255.255.255.255" ||
      host === "metadata.google.internal" ||
      host === "100.100.100.200" ||
      host.startsWith("169.254.") ||
      host.startsWith("fe80:") ||
      host.startsWith("ff0")
    ) {
      return "";
    }
    return parsed.origin;
  } catch {
    return "";
  }
}

function getVolatilePeerVault(config = {}) {
  const scope = resolveRuntimeGeneratedDir(config);
  let vault = volatilePeerVaultByScope.get(scope);
  if (!vault) {
    vault = new Map();
    volatilePeerVaultByScope.set(scope, vault);
  }
  return vault;
}

const MESH_UDP_DEFAULT_PORT = 41888;
const MESH_MULTICAST_GROUP = "239.255.68.68";
let activeMeshDiscoverySocket = null;
let activeMeshDiscoveryTimer = null;

export function encryptMeshWireEnvelope(payloadObj, contextNonce = "", configOrSecret = {}) {
  const key = deriveMeshEnvelopeKey(contextNonce, configOrSecret);
  if (!key) {
    throw new Error("A valid per-installation mesh enrollment secret (>= 32 chars) is required to encrypt mesh envelopes.");
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plainBuf = Buffer.from(JSON.stringify(payloadObj), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.from(
    JSON.stringify({
      v: 2,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ct: ciphertext.toString("base64")
    }),
    "utf8"
  ).toString("base64url");
}

export function decryptMeshWireEnvelope(encodedEnvelope, contextNonce = "", configOrSecret = {}) {
  try {
    if (!encodedEnvelope || typeof encodedEnvelope !== "string") return null;
    if (encodedEnvelope.length > MAX_MESH_ENVELOPE_CHARS) return null;
    const key = deriveMeshEnvelopeKey(contextNonce, configOrSecret);
    if (!key) return null;
    const raw = JSON.parse(Buffer.from(encodedEnvelope, "base64url").toString("utf8"));
    const iv = Buffer.from(String(raw.iv || ""), "base64");
    const tag = Buffer.from(String(raw.tag || ""), "base64");
    const ct = Buffer.from(String(raw.ct || ""), "base64");
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    return JSON.parse(decrypted);
  } catch {
    return null;
  }
}

export function computeZeroKnowledgePeerToken(peerUrl, configOrSecret = {}) {
  const clean = normalizeSafeMeshPeerOrigin(peerUrl);
  if (!clean) return "";
  const signingKey = deriveMeshSigningKey(configOrSecret) || RAM_EPHEMERAL_KEY;
  const digest = crypto
    .createHmac("sha256", signingKey)
    .update(`dune-docker-zk-peer:v2:${clean}`, "utf8")
    .digest("hex")
    .slice(0, 24);
  return `zk-peer-${digest}`;
}

function sealPeerUrlInRam(rawUrl, config = {}) {
  const clean = normalizeSafeMeshPeerOrigin(rawUrl);
  if (!clean) return "";
  const zkToken = computeZeroKnowledgePeerToken(clean, config);
  if (!zkToken) return "";
  const vault = getVolatilePeerVault(config);
  if (!vault.has(zkToken) && vault.size >= MAX_MESH_PEERS) {
    return "";
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", RAM_EPHEMERAL_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(clean, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  vault.set(zkToken, { iv, tag, ciphertext });
  return zkToken;
}

function unsealPeerUrlFromRam(zkToken, config = {}) {
  const vault = getVolatilePeerVault(config);
  const entry = vault.get(zkToken);
  if (!entry) return "";
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", RAM_EPHEMERAL_KEY, entry.iv);
    decipher.setAuthTag(entry.tag);
    return Buffer.concat([decipher.update(entry.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

function getAllUnsealedRamPeers(config = {}) {
  const vault = getVolatilePeerVault(config);
  const urls = [];
  for (const zkToken of vault.keys()) {
    const url = unsealPeerUrlFromRam(zkToken, config);
    if (url) urls.push(url);
  }
  return urls;
}

function bootstrapEnvPeersInRam(config = {}) {
  const scope = resolveRuntimeGeneratedDir(config);
  if (envPeersBootstrappedScopes.has(scope)) return;
  envPeersBootstrappedScopes.add(scope);
  const rawList = String(process.env.DUNE_I18N_PEERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const url of rawList) {
    sealPeerUrlInRam(url, config);
  }
}

function meshSettingsPath(config) {
  return join(resolveRuntimeGeneratedDir(config), "i18n-mesh-settings.json");
}

function localMeshOrigin(config = {}) {
  const raw = String(config?.publicOrigin || process.env.DUNE_PUBLIC_URL || "").trim().replace(/\/+$/, "");
  return normalizeSafeMeshPeerOrigin(raw);
}

export function loadMeshSettings(config = {}) {
  bootstrapEnvPeersInRam(config);
  const file = meshSettingsPath(config);
  const existing = readJsonFileSafe(file);
  const vault = getVolatilePeerVault(config);
  const blindedPeers = Array.from(vault.keys());
  const enrollmentConfigured = Boolean(resolveMeshEnrollmentSecret(config));

  if (existing && typeof existing === "object") {
    // Explicit opt-in only: peerSyncEnabled is false unless explicitly set to true AND enrollment secret is configured.
    const optedIn = existing.peerSyncEnabled === true;
    return {
      nodeId: typeof existing.nodeId === "string" && existing.nodeId.startsWith("zk-node-")
        ? existing.nodeId
        : RAM_NODE_ID,
      peerSyncEnabled: optedIn && enrollmentConfigured,
      peerSyncOptIn: optedIn,
      enrollmentConfigured,
      peers: blindedPeers,
      exchangedPacksCount: Number(existing.exchangedPacksCount) || 0,
      verifiedPeersCount: Math.max(Number(existing.verifiedPeersCount) || 0, blindedPeers.length),
      lastMeshSyncAt: existing.lastMeshSyncAt || null,
      zeroKnowledgeMode: true
    };
  }
  const initialDiskState = {
    nodeId: RAM_NODE_ID,
    peerSyncEnabled: false,
    exchangedPacksCount: 0,
    verifiedPeersCount: blindedPeers.length,
    lastMeshSyncAt: null,
    zeroKnowledgeMode: true
  };
  return {
    ...initialDiskState,
    peerSyncOptIn: false,
    enrollmentConfigured,
    peers: blindedPeers
  };
}

export function saveMeshSettings(config = {}, updates = {}) {
  if (typeof updates.meshEnrollmentKey === "string" && updates.meshEnrollmentKey.trim()) {
    saveMeshEnrollmentSecret(updates.meshEnrollmentKey.trim(), config);
  } else if (updates.generateMeshEnrollmentKey === true) {
    saveMeshEnrollmentSecret(generateMeshEnrollmentSecret(), config);
  }

  const current = loadMeshSettings(config);
  const enrollmentConfigured = Boolean(resolveMeshEnrollmentSecret(config));

  if (updates.peerSyncEnabled === true && !enrollmentConfigured) {
    throw new Error("A per-installation mesh enrollment secret (at least 32 characters) must be configured before enabling peer sync.");
  }

  if (Array.isArray(updates.peers)) {
    if (updates.replacePeers === true) {
      getVolatilePeerVault(config).clear();
    }
    for (const item of updates.peers.slice(0, MAX_MESH_PEERS)) {
      const clean = String(item || "").trim();
      if (/^https?:\/\//i.test(clean)) {
        sealPeerUrlInRam(clean, config);
      }
    }
  }
  const vault = getVolatilePeerVault(config);
  const blindedPeers = Array.from(vault.keys());
  const nextOptIn = typeof updates.peerSyncEnabled === "boolean" ? updates.peerSyncEnabled : current.peerSyncOptIn;
  const nextDiskState = {
    nodeId: current.nodeId,
    peerSyncEnabled: Boolean(nextOptIn && enrollmentConfigured),
    exchangedPacksCount: typeof updates.exchangedPacksCount === "number" ? updates.exchangedPacksCount : current.exchangedPacksCount,
    verifiedPeersCount: typeof updates.verifiedPeersCount === "number"
      ? Math.max(updates.verifiedPeersCount, blindedPeers.length)
      : Math.max(current.verifiedPeersCount, blindedPeers.length),
    lastMeshSyncAt: updates.lastMeshSyncAt !== undefined ? updates.lastMeshSyncAt : current.lastMeshSyncAt,
    zeroKnowledgeMode: true
  };
  const file = meshSettingsPath(config);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeJsonAtomic(file, nextDiskState, 0o600);
  } catch {
    // Ignore read-only runtime dir
  }
  return {
    ...nextDiskState,
    peerSyncOptIn: nextOptIn,
    enrollmentConfigured,
    peers: blindedPeers
  };
}

function computeBodySha256Hex(bodyPayload = "") {
  if (!bodyPayload) return "";
  const serialized = typeof bodyPayload === "string" ? bodyPayload : JSON.stringify(bodyPayload);
  return crypto.createHash("sha256").update(serialized, "utf8").digest("hex");
}

export function createDuneDockerMeshHeaders(
  nodeId,
  method = "GET",
  path = "/api/i18n/mesh/manifest",
  origin = "",
  configOrSecret = {},
  bodyPayload = ""
) {
  const signingKey = deriveMeshSigningKey(configOrSecret);
  if (!signingKey) {
    throw new Error("A valid per-installation mesh enrollment secret (>= 32 chars) is required to sign mesh headers.");
  }
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString("hex");
  const bodyHash = computeBodySha256Hex(bodyPayload);
  const payload = `dune-docker-mesh:v2:${nodeId}:${ts}:${nonce}:${String(method).toUpperCase()}:${path}:${bodyHash}`;
  const sig = crypto.createHmac("sha256", signingKey).update(payload, "utf8").digest("hex");
  const headers = {
    "x-dune-docker-mesh-id": nodeId,
    "x-dune-docker-mesh-ts": ts,
    "x-dune-docker-mesh-nonce": nonce,
    "x-dune-docker-mesh-body-sha256": bodyHash,
    "x-dune-docker-mesh-sig": sig
  };
  const cleanOrigin = normalizeSafeMeshPeerOrigin(origin);
  if (cleanOrigin) {
    headers["x-dune-docker-mesh-zk-origin"] = encryptMeshWireEnvelope({ origin: cleanOrigin }, `${ts}:${nonce}`, configOrSecret);
  }
  return headers;
}

export function createDuneDockerMeshResponseSignature(nodeId, requestNonce, langOrAction, configOrSecret = {}) {
  const signingKey = deriveMeshSigningKey(configOrSecret);
  if (!signingKey) {
    throw new Error("A valid per-installation mesh enrollment secret (>= 32 chars) is required to sign mesh responses.");
  }
  const payload = `dune-docker-mesh-res:v2:${nodeId}:${requestNonce}:${langOrAction}`;
  return crypto.createHmac("sha256", signingKey).update(payload, "utf8").digest("hex");
}

export function verifyDuneDockerMeshHeaders(
  headers = {},
  method = "GET",
  path = "/api/i18n/mesh/manifest",
  configOrSecret = {},
  rawBody = ""
) {
  const signingKey = deriveMeshSigningKey(configOrSecret);
  if (!signingKey) {
    return { valid: false, reason: "Per-installation mesh enrollment secret is not configured on this instance." };
  }
  const getHeader = (name) => {
    const val = headers[name] ?? headers[name.toLowerCase()];
    return Array.isArray(val) ? val[0] : String(val || "").trim();
  };
  const nodeId = getHeader("x-dune-docker-mesh-id");
  const tsRaw = getHeader("x-dune-docker-mesh-ts");
  const nonce = getHeader("x-dune-docker-mesh-nonce");
  const bodyHashHeader = getHeader("x-dune-docker-mesh-body-sha256");
  const sig = getHeader("x-dune-docker-mesh-sig");
  const zkOriginEnvelope = getHeader("x-dune-docker-mesh-zk-origin");

  if (!nodeId || !tsRaw || !nonce || !/^[0-9a-f]{64}$/i.test(sig)) {
    return { valid: false, reason: "Missing or malformed Dune-Docker attestation headers." };
  }
  const ts = Number(tsRaw);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > 120) {
    return { valid: false, reason: "Attestation timestamp expired or skewed." };
  }
  if (rawBody) {
    const actualBodyHash = computeBodySha256Hex(rawBody);
    if (!bodyHashHeader || bodyHashHeader !== actualBodyHash) {
      return { valid: false, reason: "Mesh request body integrity hash mismatch." };
    }
  }
  const expectedPayload = `dune-docker-mesh:v2:${nodeId}:${tsRaw}:${nonce}:${String(method).toUpperCase()}:${path}:${bodyHashHeader}`;
  const expectedHex = crypto.createHmac("sha256", signingKey).update(expectedPayload, "utf8").digest("hex");
  const expectedBuf = Buffer.from(expectedHex, "hex");
  const providedBuf = Buffer.from(sig, "hex");
  if (expectedBuf.length !== providedBuf.length || !crypto.timingSafeEqual(expectedBuf, providedBuf)) {
    return { valid: false, reason: "Invalid per-installation cryptographic attestation signature." };
  }
  if (!consumeMeshReplayNonce(`http:${nodeId}`, nonce, nowSec)) {
    return { valid: false, reason: "Replay nonce detected." };
  }
  let peerOrigin = "";
  if (zkOriginEnvelope) {
    const unsealed = decryptMeshWireEnvelope(zkOriginEnvelope, `${tsRaw}:${nonce}`, configOrSecret);
    peerOrigin = normalizeSafeMeshPeerOrigin(unsealed?.origin || "");
  }
  return {
    valid: true,
    peerNodeId: nodeId,
    nonce,
    peerOrigin
  };
}

export function createMeshDiscoveryBeacon(nodeId, port = 8080, origin = "", configOrSecret = {}) {
  const signingKey = deriveMeshSigningKey(configOrSecret);
  if (!signingKey) {
    throw new Error("A valid per-installation mesh enrollment secret (>= 32 chars) is required to create discovery beacons.");
  }
  const cleanPort = Number(port) || 8080;
  const cleanOrigin = normalizeSafeMeshPeerOrigin(origin);
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString("hex");
  const envelope = encryptMeshWireEnvelope(
    {
      nodeId,
      port: cleanPort,
      origin: cleanOrigin
    },
    `${ts}:${nonce}`,
    configOrSecret
  );
  const payload = `dune-docker-zk-beacon:v2:${ts}:${nonce}:${envelope}`;
  const sig = crypto.createHmac("sha256", signingKey).update(payload, "utf8").digest("hex");
  return {
    protocol: "dune-docker-zk-mesh:v2",
    ts,
    nonce,
    envelope,
    sig
  };
}

export function verifyMeshDiscoveryBeacon(rawPacket, remoteAddress = "", configOrSecret = {}) {
  try {
    const signingKey = deriveMeshSigningKey(configOrSecret);
    if (!signingKey) {
      return { valid: false, reason: "Per-installation mesh enrollment secret is not configured." };
    }
    if (typeof rawPacket === "string" && rawPacket.length > 16384) {
      return { valid: false, reason: "Discovery beacon exceeds maximum packet size." };
    }
    const packet = typeof rawPacket === "string" || Buffer.isBuffer(rawPacket)
      ? JSON.parse(String(rawPacket))
      : rawPacket;
    if (!packet || packet.protocol !== "dune-docker-zk-mesh:v2") {
      return { valid: false, reason: "Invalid mesh discovery protocol." };
    }
    const tsRaw = String(packet.ts || "").trim();
    const nonce = String(packet.nonce || "").trim();
    const envelope = String(packet.envelope || "").trim();
    const sig = String(packet.sig || "").trim();
    if (!tsRaw || !nonce || !envelope || !/^[0-9a-f]{64}$/i.test(sig)) {
      return { valid: false, reason: "Malformed beacon fields." };
    }
    const ts = Number(tsRaw);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > 120) {
      return { valid: false, reason: "Beacon timestamp expired." };
    }
    const expectedPayload = `dune-docker-zk-beacon:v2:${tsRaw}:${nonce}:${envelope}`;
    const expectedHex = crypto.createHmac("sha256", signingKey).update(expectedPayload, "utf8").digest("hex");
    const expectedBuf = Buffer.from(expectedHex, "hex");
    const providedBuf = Buffer.from(sig, "hex");
    if (expectedBuf.length !== providedBuf.length || !crypto.timingSafeEqual(expectedBuf, providedBuf)) {
      return { valid: false, reason: "Invalid beacon signature." };
    }
    if (!consumeMeshReplayNonce("udp-beacon", nonce, nowSec)) {
      return { valid: false, reason: "Replay beacon nonce detected." };
    }
    const decrypted = decryptMeshWireEnvelope(envelope, `${tsRaw}:${nonce}`, configOrSecret);
    if (!decrypted || typeof decrypted !== "object") {
      return { valid: false, reason: "Unable to decrypt zero-knowledge beacon envelope." };
    }
    const nodeId = String(decrypted.nodeId || "").trim();
    const port = Number(decrypted.port);
    const origin = normalizeSafeMeshPeerOrigin(decrypted.origin || "");
    if (!nodeId || !Number.isInteger(port) || port < 1 || port > 65535) {
      return { valid: false, reason: "Invalid decrypted beacon payload." };
    }
    let peerUrl = "";
    if (origin) {
      peerUrl = origin;
    } else if (remoteAddress) {
      const cleanAddr = String(remoteAddress).replace(/^::ffff:/i, "").trim();
      if (cleanAddr && cleanAddr !== "127.0.0.1" && cleanAddr !== "::1") {
        const candidateUrl = cleanAddr.includes(":") ? `http://[${cleanAddr}]:${port}` : `http://${cleanAddr}:${port}`;
        peerUrl = normalizeSafeMeshPeerOrigin(candidateUrl);
      }
    }
    return {
      valid: true,
      peerNodeId: nodeId,
      peerUrl,
      zkPeerToken: computeZeroKnowledgePeerToken(peerUrl, configOrSecret),
      port
    };
  } catch {
    return { valid: false, reason: "Failed to parse discovery beacon." };
  }
}

export function stopDuneDockerMeshDiscovery() {
  if (activeMeshDiscoveryTimer) {
    clearInterval(activeMeshDiscoveryTimer);
    activeMeshDiscoveryTimer = null;
  }
  if (activeMeshDiscoverySocket) {
    try {
      activeMeshDiscoverySocket.close();
    } catch {
      // Ignore socket close errors
    }
    activeMeshDiscoverySocket = null;
  }
}

export function startDuneDockerMeshDiscovery(config = {}, { fetchImpl = globalThis.fetch, udpPort = MESH_UDP_DEFAULT_PORT } = {}) {
  if (activeMeshDiscoverySocket) return activeMeshDiscoverySocket;
  if (process.env.DUNE_I18N_MESH_UDP === "0") return null;
  const mesh = loadMeshSettings(config);
  if (!mesh.peerSyncEnabled || !mesh.enrollmentConfigured) return null;

  try {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    socket.on("error", () => {
      stopDuneDockerMeshDiscovery();
    });

    socket.on("message", (msg, rinfo) => {
      const currentMesh = loadMeshSettings(config);
      if (!currentMesh.peerSyncEnabled || !currentMesh.enrollmentConfigured) return;
      const verified = verifyMeshDiscoveryBeacon(msg, rinfo?.address || "", config);
      if (!verified.valid || verified.peerNodeId === currentMesh.nodeId || !verified.peerUrl) return;
      const vault = getVolatilePeerVault(config);
      const hadToken = vault.has(verified.zkPeerToken);
      sealPeerUrlInRam(verified.peerUrl, config);
      if (!hadToken) {
        syncLanguagePacksFromPeers(config, { fetchImpl }).catch(() => {});
      }
    });

    const broadcastBeacon = () => {
      const currentMesh = loadMeshSettings(config);
      if (!currentMesh.peerSyncEnabled || !currentMesh.enrollmentConfigured || !activeMeshDiscoverySocket) return;
      const httpPort = Number(config?.port || process.env.CONSOLE_PORT || 8080);
      const beacon = createMeshDiscoveryBeacon(currentMesh.nodeId, httpPort, localMeshOrigin(config), config);
      const buf = Buffer.from(JSON.stringify(beacon), "utf8");
      try {
        activeMeshDiscoverySocket.send(buf, 0, buf.length, udpPort, MESH_MULTICAST_GROUP);
      } catch {
        // Ignore multicast network errors
      }
      try {
        activeMeshDiscoverySocket.send(buf, 0, buf.length, udpPort, "255.255.255.255");
      } catch {
        // Ignore broadcast network errors
      }
    };

    socket.bind(udpPort, () => {
      try {
        socket.setBroadcast(true);
      } catch {
        // Ignore broadcast setup errors
      }
      try {
        socket.addMembership(MESH_MULTICAST_GROUP);
      } catch {
        // Ignore multicast membership errors in isolated containers
      }
      broadcastBeacon();
    });
    socket.unref?.();
    activeMeshDiscoverySocket = socket;
    activeMeshDiscoveryTimer = setInterval(broadcastBeacon, 60000);
    activeMeshDiscoveryTimer.unref?.();
    return socket;
  } catch {
    return null;
  }
}

function sanitizeReviewedTranslationsMap(rawMap) {
  const cleanMap = {};
  if (!rawMap || typeof rawMap !== "object" || Array.isArray(rawMap)) return cleanMap;
  const entries = Object.entries(rawMap);
  const maxEntries = REVIEWED_SOURCE_ARRAY.length + 50;
  for (const [orig, trans] of entries.slice(0, maxEntries)) {
    const cleanOrig = String(orig || "").trim();
    const cleanTrans = String(trans || "").trim();
    if (isSafeReviewedTranslation(cleanOrig, cleanTrans)) {
      cleanMap[cleanOrig] = cleanTrans;
    }
  }
  return cleanMap;
}

export async function pushLanguagePackToPeers(langCode, translationsDict, config = {}, { fetchImpl = globalThis.fetch } = {}) {
  const code = normalizeLanguageCode(langCode);
  if (!code || code === "EN" || !translationsDict || typeof translationsDict !== "object") {
    return { pushedPeers: 0 };
  }
  const mesh = loadMeshSettings(config);
  const ramPeers = getAllUnsealedRamPeers(config);
  if (!mesh.peerSyncEnabled || !mesh.enrollmentConfigured || ramPeers.length === 0) {
    return { pushedPeers: 0 };
  }
  // Never export unreviewed/dynamic content to peers.
  const reviewedOnlyDict = sanitizeReviewedTranslationsMap(translationsDict);
  if (Object.keys(reviewedOnlyDict).length === 0) {
    return { pushedPeers: 0 };
  }

  const ownOrigin = localMeshOrigin(config);
  const pushPath = "/api/i18n/mesh/push";
  let pushedPeers = 0;

  for (const peerBase of ramPeers) {
    try {
      const nonceSeedHeaders = createDuneDockerMeshHeaders(mesh.nodeId, "POST", pushPath, ownOrigin, config, "");
      const nonce = nonceSeedHeaders["x-dune-docker-mesh-nonce"];
      const encryptedEnvelope = encryptMeshWireEnvelope(
        {
          nodeId: mesh.nodeId,
          lang: code,
          translations: reviewedOnlyDict
        },
        nonce,
        config
      );
      const bodyObj = { envelope: encryptedEnvelope };
      const bodyStr = JSON.stringify(bodyObj);
      const reqHeaders = {
        ...createDuneDockerMeshHeaders(mesh.nodeId, "POST", pushPath, ownOrigin, config, bodyObj),
        "Content-Type": "application/json"
      };
      // Re-encrypt with the signed request's nonce so envelope and header nonce match.
      const finalNonce = reqHeaders["x-dune-docker-mesh-nonce"];
      const finalEnvelope = encryptMeshWireEnvelope(
        {
          nodeId: mesh.nodeId,
          lang: code,
          translations: reviewedOnlyDict
        },
        finalNonce,
        config
      );
      const finalBodyObj = { envelope: finalEnvelope };
      const finalBodyStr = JSON.stringify(finalBodyObj);
      const signedHeaders = {
        ...createDuneDockerMeshHeaders(mesh.nodeId, "POST", pushPath, ownOrigin, config, finalBodyObj),
        "Content-Type": "application/json"
      };
      // Compute envelope & signature using the same nonce:
      const ts = String(Math.floor(Date.now() / 1000));
      const unifiedNonce = crypto.randomBytes(16).toString("hex");
      const unifiedEnvelope = encryptMeshWireEnvelope(
        {
          nodeId: mesh.nodeId,
          lang: code,
          translations: reviewedOnlyDict
        },
        unifiedNonce,
        config
      );
      const unifiedBodyObj = { envelope: unifiedEnvelope };
      const unifiedBodyStr = JSON.stringify(unifiedBodyObj);
      const unifiedBodyHash = computeBodySha256Hex(unifiedBodyObj);
      const signingKey = deriveMeshSigningKey(config);
      const sigPayload = `dune-docker-mesh:v2:${mesh.nodeId}:${ts}:${unifiedNonce}:POST:${pushPath}:${unifiedBodyHash}`;
      const sig = crypto.createHmac("sha256", signingKey).update(sigPayload, "utf8").digest("hex");
      const headers = {
        "x-dune-docker-mesh-id": mesh.nodeId,
        "x-dune-docker-mesh-ts": ts,
        "x-dune-docker-mesh-nonce": unifiedNonce,
        "x-dune-docker-mesh-body-sha256": unifiedBodyHash,
        "x-dune-docker-mesh-sig": sig,
        "Content-Type": "application/json"
      };
      if (ownOrigin) {
        headers["x-dune-docker-mesh-zk-origin"] = encryptMeshWireEnvelope({ origin: ownOrigin }, `${ts}:${unifiedNonce}`, config);
      }

      const pushOpts = {
        method: "POST",
        headers,
        body: unifiedBodyStr
      };
      if (fetchImpl === globalThis.fetch && typeof AbortSignal?.timeout === "function") {
        pushOpts.signal = AbortSignal.timeout(5000);
      }
      const res = await fetchImpl(`${peerBase}${pushPath}`, pushOpts);
      if (!res.ok) continue;
      const rawData = await res.json();
      const data = rawData?.envelope
        ? (decryptMeshWireEnvelope(rawData.envelope, unifiedNonce, config) || null)
        : null;
      if (!data) continue;
      const expectedSig = createDuneDockerMeshResponseSignature(
        String(data?.nodeId || ""),
        unifiedNonce,
        code,
        config
      );
      if (data?.attestation === expectedSig && data?.nodeId !== mesh.nodeId) {
        pushedPeers += 1;
      }
    } catch {
      // Ignore unreachable peer during push
    }
  }
  return { pushedPeers };
}

export async function syncLanguagePacksFromPeers(config = {}, { targetLang = null, fetchImpl = globalThis.fetch } = {}) {
  const mesh = loadMeshSettings(config);
  const initialRamPeers = getAllUnsealedRamPeers(config);
  if (!mesh.peerSyncEnabled || !mesh.enrollmentConfigured || initialRamPeers.length === 0) {
    return { syncedLanguages: [], syncedPhrasesCount: 0, verifiedPeers: 0 };
  }
  const db = loadTranslationDatabase(config);
  const syncedLanguages = new Set();
  const visitedZkTokens = new Set();
  // Only contact explicitly enrolled peers (no transitive unverified gossip crawling).
  const peerQueue = [...initialRamPeers.slice(0, MAX_MESH_PEERS)];
  const ownOrigin = localMeshOrigin(config);
  let syncedPhrasesCount = 0;
  let verifiedPeers = 0;

  while (peerQueue.length > 0 && visitedZkTokens.size < MAX_MESH_PEERS) {
    const peerBase = peerQueue.shift();
    const zkToken = computeZeroKnowledgePeerToken(peerBase, config);
    if (!zkToken || visitedZkTokens.has(zkToken)) continue;
    visitedZkTokens.add(zkToken);

    try {
      const manifestPath = "/api/i18n/mesh/manifest";
      const reqHeaders = createDuneDockerMeshHeaders(mesh.nodeId, "GET", manifestPath, ownOrigin, config, "");
      const reqNonce = reqHeaders["x-dune-docker-mesh-nonce"];
      const manifestOpts = {
        method: "GET",
        headers: reqHeaders
      };
      if (fetchImpl === globalThis.fetch && typeof AbortSignal?.timeout === "function") {
        manifestOpts.signal = AbortSignal.timeout(5000);
      }
      const manifestRes = await fetchImpl(`${peerBase}${manifestPath}`, manifestOpts);
      if (!manifestRes.ok) continue;
      const rawManifest = await manifestRes.json();
      const manifestData = rawManifest?.envelope
        ? decryptMeshWireEnvelope(rawManifest.envelope, reqNonce, config)
        : null;
      if (!manifestData || typeof manifestData !== "object") continue;
      const expectedResSig = createDuneDockerMeshResponseSignature(
        String(manifestData?.nodeId || ""),
        reqNonce,
        "manifest",
        config
      );
      if (manifestData?.attestation !== expectedResSig || manifestData?.nodeId === mesh.nodeId) {
        continue;
      }
      verifiedPeers += 1;

      const peerCompleted = Array.isArray(manifestData?.completedLanguages)
        ? manifestData.completedLanguages.slice(0, SUPPORTED_LANGUAGES.length)
        : [];
      const langsToPull = targetLang
        ? peerCompleted.filter((c) => c === targetLang)
        : peerCompleted;

      for (const langCode of langsToPull) {
        const code = normalizeLanguageCode(langCode);
        if (!code || code === "EN") continue;
        const localDict = db.translations[code] || {};
        const missingCount = REVIEWED_SOURCE_ARRAY.filter((s) => !localDict[s]).length;
        if (missingCount === 0) continue;

        const packPath = `/api/i18n/mesh/pack?lang=${encodeURIComponent(code)}`;
        const packHeaders = createDuneDockerMeshHeaders(mesh.nodeId, "GET", packPath, ownOrigin, config, "");
        const packNonce = packHeaders["x-dune-docker-mesh-nonce"];
        const packOpts = {
          method: "GET",
          headers: packHeaders
        };
        if (fetchImpl === globalThis.fetch && typeof AbortSignal?.timeout === "function") {
          packOpts.signal = AbortSignal.timeout(5000);
        }
        const packRes = await fetchImpl(`${peerBase}${packPath}`, packOpts);
        if (!packRes.ok) continue;
        const rawPack = await packRes.json();
        const packData = rawPack?.envelope
          ? decryptMeshWireEnvelope(rawPack.envelope, packNonce, config)
          : null;
        if (!packData || typeof packData !== "object") continue;
        const expectedPackSig = createDuneDockerMeshResponseSignature(
          String(packData?.nodeId || ""),
          packNonce,
          code,
          config
        );
        if (packData?.attestation !== expectedPackSig || !packData?.translations || typeof packData.translations !== "object") {
          continue;
        }

        if (!db.translations[code]) db.translations[code] = {};
        const sanitizedIncoming = sanitizeReviewedTranslationsMap(packData.translations);
        let addedForLang = 0;
        for (const [orig, trans] of Object.entries(sanitizedIncoming)) {
          if (!db.translations[code][orig]) {
            db.translations[code][orig] = trans;
            addedForLang += 1;
            syncedPhrasesCount += 1;
          }
        }
        if (addedForLang > 0) {
          syncedLanguages.add(code);
        }
      }
    } catch {
      // Ignore unreachable peer
    }
  }

  if (syncedPhrasesCount > 0) {
    saveTranslationDatabase(config, db);
  }
  saveMeshSettings(config, {
    exchangedPacksCount: mesh.exchangedPacksCount + syncedLanguages.size,
    verifiedPeersCount: verifiedPeers,
    lastMeshSyncAt: new Date().toISOString()
  });

  return {
    syncedLanguages: Array.from(syncedLanguages),
    syncedPhrasesCount,
    verifiedPeers
  };
}

export function getLanguageCatalogStatus(config) {
  const db = loadTranslationDatabase(config);
  const totalSource = REVIEWED_SOURCE_ARRAY.length;
  const languages = SUPPORTED_LANGUAGES.map((lang) => {
    if (lang.code === "EN") {
      return {
        ...lang,
        translatedCount: totalSource,
        coveragePercent: 100,
        cachedInDb: true
      };
    }
    const dict = db.translations[lang.code] || {};
    const count = REVIEWED_SOURCE_ARRAY.reduce((acc, s) => acc + (dict[s] ? 1 : 0), 0);
    const coveragePercent = totalSource > 0 ? Math.min(100, Math.round((count / totalSource) * 100)) : 0;
    return {
      ...lang,
      translatedCount: count,
      coveragePercent,
      cachedInDb: count > 0
    };
  });

  const hasDeepLKey = Boolean(decryptDeepLApiKey(config));
  const mesh = loadMeshSettings(config);
  return {
    version: db.version || 1,
    updatedAt: db.updatedAt,
    totalSourceStrings: totalSource,
    autoSyncLanguages: db.autoSyncLanguages || [],
    encryptedKeyConfigured: hasDeepLKey,
    fallbackEngineAvailable: true,
    encryptionAlgorithm: `${ENCRYPTION_METADATA.alg.toUpperCase()} (${ENCRYPTION_METADATA.kdf})`,
    syncInProgress: backgroundDeltaSyncRunning,
    lastDeltaSyncAt,
    lastDeltaSyncError,
    mesh: {
      nodeId: mesh.nodeId,
      peerSyncEnabled: mesh.peerSyncEnabled,
      enrollmentConfigured: mesh.enrollmentConfigured,
      peers: mesh.peers,
      exchangedPacksCount: mesh.exchangedPacksCount,
      verifiedPeersCount: mesh.verifiedPeersCount,
      lastMeshSyncAt: mesh.lastMeshSyncAt
    },
    languages
  };
}

export function isI18nRoute(path) {
  return path === "/api/i18n" || path.startsWith("/api/i18n/");
}

export function isPublicOrMeshI18nRoute(path, method = "GET") {
  if (method === "GET" && (path === "/api/i18n/languages" || path === "/api/i18n/translations")) {
    return true;
  }
  if (method === "GET" && (path === "/api/i18n/mesh/manifest" || path === "/api/i18n/mesh/pack")) {
    return true;
  }
  if (method === "POST" && path === "/api/i18n/mesh/push") {
    return true;
  }
  return false;
}

function enforceProtectedI18nRouteGate({ req, res, path, config, auth, apiKeys, json }) {
  const method = req?.method || "GET";
  const action = actionForRoute(path, method) || "settings:write";

  // 1. Check Bearer API key authentication if present
  const authHeader = String(req?.headers?.authorization || "").trim();
  if (authHeader) {
    if (apiKeys && typeof apiKeys.authenticate === "function") {
      const bearer = apiKeys.authenticate(req);
      if (bearer?.error) {
        json(res, bearer.status || 401, { error: bearer.error });
        return null;
      }
      if (bearer) {
        if (!evaluate(bearer.session, action)) {
          json(res, 403, { error: "Your account does not have permission to access this resource." });
          return null;
        }
        if (typeof apiKeys.allows === "function" && !apiKeys.allows(bearer.key, action)) {
          json(res, 403, { error: "This API key is not permitted to use this endpoint." });
          return null;
        }
        req.authSession = bearer.session;
        req.authApiKey = bearer.key;
        return bearer.session;
      }
    } else {
      // Any bearer token on a settings:write route without a valid key store is rejected.
      json(res, 401, { error: "Invalid or unauthorized API key." });
      return null;
    }
  }

  if (req?.authApiKey) {
    if (apiKeys && typeof apiKeys.allows === "function" && !apiKeys.allows(req.authApiKey, action)) {
      json(res, 403, { error: "This API key is not permitted to use this endpoint." });
      return null;
    }
  }

  // 2. Session & CSRF guard (`auth.requireAuth` enforces session validity + x-csrf-token on state-changing methods)
  let session = req?.authSession || null;
  if (!session) {
    if (auth && typeof auth.requireAuth === "function") {
      session = auth.requireAuth(req, res);
      if (!session) return null;
    } else if (config?.authDisabled === true) {
      session = { id: "dev", csrf: "dev", tier: "owner" };
    } else {
      json(res, 401, { error: "Your browser login session expired. Refresh the page, then sign in again." });
      return null;
    }
  } else if (!["GET", "HEAD", "OPTIONS"].includes(method) && !req?.authApiKey) {
    const csrf = req?.headers?.["x-csrf-token"];
    if (!config?.authDisabled && session.csrf && csrf !== session.csrf) {
      json(res, 403, { error: "Your browser login session expired. Refresh the page, then sign in again." });
      return null;
    }
  }

  // 3. Enforce IAM policy (`settings:write` -> Owner only in DEFAULT_POLICIES)
  const effectiveSession = session?.tier ? session : { ...session, tier: session?.tier || "owner" };
  if (!evaluate(effectiveSession, action)) {
    json(res, 403, { error: "Your account does not have permission to access this resource." });
    return null;
  }

  req.authSession = effectiveSession;
  return effectiveSession;
}

export async function handleI18nRoute({ req, res, path, url, config, auth, apiKeys, readJson, json, fetchImpl = globalThis.fetch }) {
  try {
    // Public strictly read-only endpoints (never trigger provider work or state changes)
    if (path === "/api/i18n/languages" && req.method === "GET") {
      const status = getLanguageCatalogStatus(config);
      return json(res, 200, status);
    }

    if (path === "/api/i18n/translations" && req.method === "GET") {
      const langParam = url.searchParams.get("lang") || "EN";
      const code = normalizeLanguageCode(langParam);
      if (!code) {
        return json(res, 400, { error: `Unsupported language code: ${langParam}` });
      }
      const db = loadTranslationDatabase(config);
      const langMeta = LANGUAGE_MAP.get(code);
      if (code === "EN") {
        return json(res, 200, {
          lang: "EN",
          name: langMeta.name,
          nativeName: langMeta.nativeName,
          dir: "ltr",
          totalSourceStrings: REVIEWED_SOURCE_ARRAY.length,
          translatedCount: REVIEWED_SOURCE_ARRAY.length,
          translations: Object.fromEntries(REVIEWED_SOURCE_ARRAY.map((s) => [s, s]))
        });
      }

      // Strictly read-only dictionary lookup limited to reviewed phrases.
      // Public GET requests never trigger paid/external provider calls, even when auth cookies are present.
      const rawDict = db.translations[code] || {};
      const reviewedDict = sanitizeReviewedTranslationsMap(rawDict);
      return json(res, 200, {
        lang: code,
        name: langMeta.name,
        nativeName: langMeta.nativeName,
        dir: langMeta.dir,
        totalSourceStrings: REVIEWED_SOURCE_ARRAY.length,
        translatedCount: Object.keys(reviewedDict).length,
        updatedAt: db.updatedAt,
        translations: reviewedDict
      });
    }

    if (path === '/api/i18n/suggestions' && req.method === 'POST') {
      const session = enforceProtectedI18nRouteGate({req,res,path,config,auth,apiKeys,json});
      if (!session) return;
      const input = (await readJson(req)) || {};
      const db = loadTranslationDatabase(config);
      const current = db.translations[String(input.lang || '').toUpperCase()]?.[input.source] || input.source;
      const catalog={ sourceStrings:REVIEWED_SOURCE_ARRAY, languages:SUPPORTED_LANGUAGES };
      try { validateCorrection({ ...input,current },catalog); } catch(error) { return json(res,400,{error:error.message}); }
      try {
        const receipt = await submitTranslationCorrection({ ...input, current }, config, catalog, {fetchImpl});
        return json(res,201,receipt);
      } catch(error) { return json(res,502,{error:error.message}); }
    }
    // Protected Owner-only routes (require session/CSRF, API-key check, and settings:write Owner permission)
    if (
      (path === "/api/i18n/translate" && req.method === "POST") ||
      (path === "/api/i18n/key" && (req.method === "POST" || req.method === "DELETE")) ||
      (path === "/api/i18n/sync-all" && req.method === "POST") ||
      (path === "/api/i18n/settings" && req.method === "POST")
    ) {
      const session = enforceProtectedI18nRouteGate({ req, res, path, config, auth, apiKeys, json });
      if (!session) return;

      if (path === "/api/i18n/translate" && req.method === "POST") {
        const body = await readJson(req);
        const langParam = body?.lang || "EN";
        const code = normalizeLanguageCode(langParam);
        if (!code) {
          return json(res, 400, { error: `Unsupported language code: ${langParam}` });
        }
        const rawTexts = Array.isArray(body?.texts) ? body.texts.slice(0, 250) : [];
        const cleanedInputs = rawTexts.map((t) => String(t || "").trim()).filter(Boolean);
        const unreviewed = cleanedInputs.filter((t) => !isReviewedUiPhrase(t));
        if (unreviewed.length > 0) {
          return json(res, 400, {
            error: "Only repository-reviewed UI phrases may be translated. Dynamic or private content is rejected.",
            rejectedUnreviewedCount: unreviewed.length
          });
        }
        const result = await translateAndCacheTexts(cleanedInputs, code, {
          config,
          fetchImpl
        });
        return json(res, 200, result);
      }

      if (path === "/api/i18n/key" && req.method === "POST") {
        const body = await readJson(req);
        const apiKey = String(body?.apiKey || "").trim();
        if (!apiKey || apiKey.length < 10 || apiKey.length > 256) {
          return json(res, 400, { error: "Please provide a valid DeepL API key." });
        }
        saveEncryptedDeepLApiKey(apiKey, config);
        return json(res, 200, {
          ok: true,
          encryptedKeyConfigured: true,
          encryptionAlgorithm: `${ENCRYPTION_METADATA.alg.toUpperCase()} (${ENCRYPTION_METADATA.kdf})`
        });
      }

      if (path === "/api/i18n/key" && req.method === "DELETE") {
        return json(res, 200, deleteEncryptedDeepLApiKey(config));
      }

      if (path === "/api/i18n/sync-all" && req.method === "POST") {
        const body = await readJson(req);
        const languages = Array.isArray(body?.languages) ? body.languages : null;
        await syncLanguagePacksFromPeers(config, { fetchImpl }).catch(() => {});
        const result = await syncAllDatabaseLanguages(config, { languages, fetchImpl });
        return json(res, 200, result);
      }

      if (path === "/api/i18n/settings" && req.method === "POST") {
        const body = await readJson(req);
        let nextMesh;
        try {
          nextMesh = saveMeshSettings(config, {
            peerSyncEnabled: typeof body?.peerSyncEnabled === "boolean" ? body.peerSyncEnabled : undefined,
            peers: Array.isArray(body?.peers) ? body.peers : undefined,
            replacePeers: body?.replacePeers === true,
            meshEnrollmentKey: typeof body?.meshEnrollmentKey === "string" ? body.meshEnrollmentKey : undefined,
            generateMeshEnrollmentKey: body?.generateMeshEnrollmentKey === true
          });
        } catch (settingsErr) {
          return json(res, 400, { error: String(settingsErr?.message || "Invalid mesh settings.") });
        }
        if (!nextMesh.peerSyncEnabled) {
          stopDuneDockerMeshDiscovery();
        } else if (fetchImpl === globalThis.fetch && !process.env.NODE_TEST_CONTEXT) {
          startDuneDockerMeshDiscovery(config, { fetchImpl });
        }
        let syncSummary = null;
        if (nextMesh.peerSyncEnabled && body?.triggerPeerSync === true) {
          syncSummary = await syncLanguagePacksFromPeers(config, { fetchImpl });
        }
        return json(res, 200, {
          ok: true,
          mesh: loadMeshSettings(config),
          syncSummary
        });
      }
    }

    // Enrolled Peer Mesh endpoints (strictly opt-in + per-installation enrollment key authenticated)
    if (path === "/api/i18n/mesh/manifest" && req.method === "GET") {
      const mesh = loadMeshSettings(config);
      if (!mesh.peerSyncEnabled || !mesh.enrollmentConfigured) {
        return json(res, 403, { error: "Dune-Docker peer language sync is disabled or not enrolled on this instance." });
      }
      const verified = verifyDuneDockerMeshHeaders(req.headers || {}, "GET", path, config, "");
      if (!verified.valid) {
        return json(res, 403, { error: verified.reason });
      }
      const db = loadTranslationDatabase(config);
      const total = REVIEWED_SOURCE_ARRAY.length;
      const completedLanguages = Object.entries(db.translations)
        .filter(([, dict]) => dict && total > 0 && Object.keys(sanitizeReviewedTranslationsMap(dict)).length >= Math.floor(total * 0.95))
        .map(([code]) => code);
      const attestation = createDuneDockerMeshResponseSignature(mesh.nodeId, verified.nonce, "manifest", config);
      return json(res, 200, {
        envelope: encryptMeshWireEnvelope(
          {
            nodeId: mesh.nodeId,
            totalSourceStrings: total,
            completedLanguages,
            attestation
          },
          verified.nonce,
          config
        )
      });
    }

    if (path === "/api/i18n/mesh/pack" && req.method === "GET") {
      const mesh = loadMeshSettings(config);
      if (!mesh.peerSyncEnabled || !mesh.enrollmentConfigured) {
        return json(res, 403, { error: "Dune-Docker peer language sync is disabled or not enrolled on this instance." });
      }
      const fullPath = `${path}${url.search || ""}`;
      const verified = verifyDuneDockerMeshHeaders(req.headers || {}, "GET", fullPath, config, "");
      if (!verified.valid) {
        return json(res, 403, { error: verified.reason });
      }
      const code = normalizeLanguageCode(url.searchParams.get("lang") || "");
      if (!code || code === "EN") {
        return json(res, 400, { error: "Invalid language pack code." });
      }
      const db = loadTranslationDatabase(config);
      // Export strictly reviewed static phrases only.
      const reviewedDict = sanitizeReviewedTranslationsMap(db.translations[code] || {});
      const attestation = createDuneDockerMeshResponseSignature(mesh.nodeId, verified.nonce, code, config);
      return json(res, 200, {
        envelope: encryptMeshWireEnvelope(
          {
            nodeId: mesh.nodeId,
            lang: code,
            translations: reviewedDict,
            attestation
          },
          verified.nonce,
          config
        )
      });
    }

    if (path === "/api/i18n/mesh/push" && req.method === "POST") {
      const mesh = loadMeshSettings(config);
      if (!mesh.peerSyncEnabled || !mesh.enrollmentConfigured) {
        return json(res, 403, { error: "Dune-Docker peer language sync is disabled or not enrolled on this instance." });
      }
      const rawBody = await readJson(req);
      if (!rawBody || typeof rawBody.envelope !== "string" || rawBody.envelope.length > MAX_MESH_ENVELOPE_CHARS) {
        return json(res, 400, { error: "Invalid or oversized encrypted mesh envelope." });
      }
      const verified = verifyDuneDockerMeshHeaders(req.headers || {}, "POST", path, config, rawBody);
      if (!verified.valid) {
        return json(res, 403, { error: verified.reason });
      }
      const body = decryptMeshWireEnvelope(rawBody.envelope, verified.nonce, config);
      if (!body || typeof body !== "object") {
        return json(res, 403, { error: "Unable to decrypt or authenticate mesh push payload." });
      }
      const code = normalizeLanguageCode(body?.lang || "");
      if (!code || code === "EN" || !body?.translations || typeof body.translations !== "object" || Array.isArray(body.translations)) {
        return json(res, 400, { error: "Invalid language pack push payload." });
      }
      const rawEntries = Object.entries(body.translations);
      if (rawEntries.length > REVIEWED_SOURCE_ARRAY.length + 50) {
        return json(res, 400, { error: "Language pack push exceeds bounded phrase limit." });
      }
      const db = loadTranslationDatabase(config);
      if (!db.translations[code]) db.translations[code] = {};
      let acceptedCount = 0;
      let rejectedUnreviewedCount = 0;
      for (const [orig, trans] of rawEntries) {
        const cleanOrig = String(orig || "").trim();
        const cleanTrans = String(trans || "").trim();
        if (isSafeReviewedTranslation(cleanOrig, cleanTrans)) {
          if (!db.translations[code][cleanOrig]) {
            db.translations[code][cleanOrig] = cleanTrans;
            acceptedCount += 1;
          }
        } else {
          rejectedUnreviewedCount += 1;
        }
      }
      if (acceptedCount > 0) {
        saveTranslationDatabase(config, db);
        saveMeshSettings(config, {
          exchangedPacksCount: mesh.exchangedPacksCount + 1,
          lastMeshSyncAt: new Date().toISOString()
        });
      }
      const attestation = createDuneDockerMeshResponseSignature(mesh.nodeId, verified.nonce, code, config);
      return json(res, 200, {
        envelope: encryptMeshWireEnvelope(
          {
            ok: true,
            nodeId: mesh.nodeId,
            lang: code,
            acceptedCount,
            rejectedUnreviewedCount,
            attestation
          },
          verified.nonce,
          config
        )
      });
    }

    return json(res, 404, { error: "Not found" });
  } catch (err) {
    return json(res, 500, { error: String(err?.message || "Translation service failed.") });
  }
}
