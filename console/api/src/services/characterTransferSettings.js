import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const incomingCharacterTransferPolicies = [
  { value: 0, label: "Default" },
  { value: 10, label: "Deny All Incoming" },
  { value: 20, label: "Accept Incoming From Private" },
  { value: 30, label: "Accept Incoming From Official" },
  { value: 40, label: "Accept All Incoming" }
];

export const characterTransferDefaults = Object.freeze({
  ShouldDeleteOriginCharactersDuringTransfers: true,
  AcceptOutgoingCharacterTransfers: true,
  IncomingCharacterTransfers: 0,
  ExportCharacterTimeout: 900,
  ImportCharacterTimeout: 900,
  FreeToTransferCharactersFrom: false,
  FreeToTransferCharactersTo: false,
  ValidateBeforeImportCharacterTimeout: 180,
  ForceIsWorldClosed: false,
  ForceIsWorldClosingSoon: false
});

const booleanKeys = new Set([
  "ShouldDeleteOriginCharactersDuringTransfers",
  "AcceptOutgoingCharacterTransfers",
  "FreeToTransferCharactersFrom",
  "FreeToTransferCharactersTo",
  "ForceIsWorldClosed",
  "ForceIsWorldClosingSoon"
]);

const integerKeys = new Set([
  "IncomingCharacterTransfers",
  "ExportCharacterTimeout",
  "ImportCharacterTimeout",
  "ValidateBeforeImportCharacterTimeout"
]);

const transferKeys = Object.keys(characterTransferDefaults);
const transferKeySet = new Set(transferKeys);
const incomingPolicyValues = new Set(incomingCharacterTransferPolicies.map((entry) => entry.value));

export function characterTransferSettingsPath(config) {
  return resolve(config.repoRoot, "runtime/generated/director-character-transfer.ini");
}

export function readCharacterTransferSettings(config) {
  const path = characterTransferSettingsPath(config);
  const source = existsSync(path) ? readFileSync(path, "utf8") : "";
  const parsed = parseCharacterTransferSettings(source);
  return {
    settings: { ...characterTransferDefaults, ...parsed.settings },
    defaults: characterTransferDefaults,
    policies: incomingCharacterTransferPolicies,
    path,
    customized: Boolean(source.trim())
  };
}

export function saveCharacterTransferSettings(config, payload, options = {}) {
  const settings = options.defaults ? characterTransferDefaults : validateCharacterTransferSettings(payload);
  const path = characterTransferSettingsPath(config);
  const previous = existsSync(path) ? readFileSync(path, "utf8") : "";
  const next = writeCharacterTransferSettingsText(previous, settings);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  return { settings, path };
}

export function validateCharacterTransferSettings(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw badRequest("Character transfer settings are required.");
  }
  const out = {};
  for (const key of transferKeys) {
    if (!Object.hasOwn(payload, key)) throw badRequest(`${key} is required.`);
    if (booleanKeys.has(key)) {
      if (typeof payload[key] !== "boolean") throw badRequest(`${key} must be true or false.`);
      out[key] = payload[key];
      continue;
    }
    if (integerKeys.has(key)) {
      out[key] = validatePositiveInteger(key, payload[key]);
      continue;
    }
  }
  if (!incomingPolicyValues.has(out.IncomingCharacterTransfers)) {
    throw badRequest("IncomingCharacterTransfers must be one of 0, 10, 20, 30, or 40.");
  }
  return out;
}

export function parseCharacterTransferSettings(text) {
  const settings = {};
  const lines = String(text || "").split(/\r?\n/);
  let activeSection = "";
  let sawSection = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      sawSection = true;
      activeSection = section[1].trim();
      continue;
    }
    if (sawSection && activeSection.toLowerCase() !== "battlegroup") continue;
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const match = line.match(/^([^=]+)=(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    if (!transferKeySet.has(key)) continue;
    settings[key] = parseTransferValue(key, match[2].trim());
  }
  return { settings };
}

export function writeCharacterTransferSettingsText(existingText, settings) {
  const values = validateCharacterTransferSettings(settings);
  const lines = String(existingText || "").split(/\r?\n/);
  const output = [];
  const written = new Set();
  let activeSection = "";
  let sawSection = false;
  let insertedBeforeNextSection = false;

  for (const rawLine of lines) {
    const section = rawLine.trim().match(/^\[([^\]]+)\]$/);
    if (section) {
      if (sawSection && activeSection.toLowerCase() === "battlegroup" && !insertedBeforeNextSection) {
        appendMissingTransferLines(output, values, written);
        insertedBeforeNextSection = true;
      }
      sawSection = true;
      activeSection = section[1].trim();
      output.push(rawLine);
      continue;
    }

    const match = rawLine.match(/^(\s*)([^=;\s#][^=]*?)(\s*)=(.*)$/);
    if (match && (!sawSection || activeSection.toLowerCase() === "battlegroup")) {
      const key = match[2].trim();
      if (transferKeySet.has(key)) {
        output.push(`${match[1]}${key}${match[3]}=${formatTransferValue(values[key])}`);
        written.add(key);
        continue;
      }
    }
    if (rawLine !== "" || output.length) output.push(rawLine);
  }

  if (sawSection && activeSection.toLowerCase() === "battlegroup" && !insertedBeforeNextSection) {
    appendMissingTransferLines(output, values, written);
  } else if (!sawSection) {
    appendMissingTransferLines(output, values, written);
  } else if (!insertedBeforeNextSection) {
    if (output.length && output[output.length - 1] !== "") output.push("");
    output.push("[Battlegroup]");
    appendMissingTransferLines(output, values, written);
  }

  return `${trimTrailingBlankLines(output).join("\n")}\n`;
}

function appendMissingTransferLines(output, values, written) {
  for (const key of transferKeys) {
    if (written.has(key)) continue;
    output.push(`${key}=${formatTransferValue(values[key])}`);
    written.add(key);
  }
}

function parseTransferValue(key, value) {
  if (booleanKeys.has(key)) return /^true$/i.test(value);
  if (integerKeys.has(key)) return Number(value);
  return value;
}

function formatTransferValue(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function validatePositiveInteger(key, value) {
  const number = typeof value === "number" ? value : Number(String(value || "").trim());
  const minimum = key === "IncomingCharacterTransfers" ? 0 : 1;
  if (!Number.isInteger(number) || number < minimum || number > 86400) {
    throw badRequest(`${key} must be a safe positive integer in seconds.`);
  }
  return number;
}

function trimTrailingBlankLines(lines) {
  const next = [...lines];
  while (next.length && next[next.length - 1] === "") next.pop();
  return next;
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}
