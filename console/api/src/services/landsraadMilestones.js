import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { applyLandsraadMilestonePreset } from "../duneDb.js";

const DEFAULT_PRESET = {
  enabled: false,
  goalAmount: 0,
  thresholds: [],
  lastAppliedTermId: null,
  lastAppliedAt: "",
  lastResult: ""
};

export function readLandsraadMilestonePreset(config) {
  const file = presetPath(config);
  if (!existsSync(file)) return { ...DEFAULT_PRESET, thresholds: [] };
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const settings = normalizeLandsraadMilestonePreset(parsed, { allowEmpty: true });
  return {
    ...settings,
    lastAppliedTermId: nullableTermId(parsed.lastAppliedTermId),
    lastAppliedAt: String(parsed.lastAppliedAt || ""),
    lastResult: String(parsed.lastResult || "")
  };
}

export function saveLandsraadMilestonePreset(config, input = {}) {
  const settings = normalizeLandsraadMilestonePreset(input);
  const previous = readLandsraadMilestonePreset(config);
  const unchanged = previous.goalAmount === settings.goalAmount
    && previous.thresholds.length === settings.thresholds.length
    && previous.thresholds.every((value, index) => value === settings.thresholds[index]);
  const next = {
    ...settings,
    lastAppliedTermId: unchanged ? previous.lastAppliedTermId : null,
    lastAppliedAt: unchanged ? previous.lastAppliedAt : "",
    lastResult: unchanged ? previous.lastResult : ""
  };
  writePreset(config, next);
  return next;
}

export async function applySavedLandsraadMilestonePreset(config, db) {
  const preset = readLandsraadMilestonePreset(config);
  if (!preset.thresholds.length) return { preset, result: { ok: true, applied: false, reason: "No Landsraad milestone preset has been configured." } };
  const result = await applyLandsraadMilestonePreset(db, preset);
  const next = {
    ...preset,
    lastAppliedTermId: result.applied ? String(result.termId) : preset.lastAppliedTermId,
    lastAppliedAt: result.applied ? new Date().toISOString() : preset.lastAppliedAt,
    lastResult: result.applied ? "Applied" : String(result.reason || "Waiting")
  };
  writePreset(config, next);
  return { preset: next, result };
}

export function createLandsraadMilestoneReconciler(config, options = {}) {
  const getDb = options.getDb;
  const applyPreset = options.applyPreset || applyLandsraadMilestonePreset;
  const intervalMs = Math.max(10_000, Number(options.intervalMs || 60_000));
  let running = false;
  let lastCheckedAt = 0;

  return {
    async tick(now = Date.now()) {
      if (running || now - lastCheckedAt < intervalMs) return { skipped: true, reason: running ? "running" : "interval" };
      lastCheckedAt = now;
      const preset = readLandsraadMilestonePreset(config);
      if (!preset.enabled || !preset.thresholds.length) return { skipped: true, reason: "disabled" };
      const db = getDb?.();
      if (!db) return { skipped: true, reason: "database-unavailable" };

      running = true;
      try {
        const term = await db.query(`
          select term_id::text as term_id
          from dune.landsraad_decree_term
          order by term_id desc
          limit 1`);
        const termId = term.rows[0]?.term_id || null;
        if (!termId) return { skipped: true, reason: "no-term" };
        if (String(preset.lastAppliedTermId || "") === String(termId)) return { skipped: true, reason: "already-applied", termId };

        const result = await applyPreset(db, preset);
        const next = {
          ...preset,
          lastAppliedTermId: result.applied ? String(result.termId) : preset.lastAppliedTermId,
          lastAppliedAt: result.applied ? new Date(now).toISOString() : preset.lastAppliedAt,
          lastResult: result.applied ? "Applied Automatically" : String(result.reason || "Waiting")
        };
        writePreset(config, next);
        return { skipped: false, preset: next, result };
      } finally {
        running = false;
      }
    }
  };
}

export function normalizeLandsraadMilestonePreset(input = {}, options = {}) {
  if (typeof input.enabled !== "boolean") throw new Error("Automatic Landsraad milestone application must be enabled or disabled.");
  const goalAmount = wholeNumber(input.goalAmount, "Landsraad goal amount");
  if (!Array.isArray(input.thresholds) || (!options.allowEmpty && !input.thresholds.length) || input.thresholds.length > 20) {
    throw new Error(options.allowEmpty
      ? "Landsraad milestone presets support up to 20 reward thresholds."
      : "Add at least one Landsraad reward threshold.");
  }
  const thresholds = input.thresholds.map((value, index) => positiveWholeNumber(value, `Level ${index + 1} reward threshold`));
  for (let index = 1; index < thresholds.length; index += 1) {
    if (thresholds[index] <= thresholds[index - 1]) throw new Error("Reward thresholds must increase from one level to the next.");
  }
  return { enabled: input.enabled, goalAmount, thresholds };
}

function wholeNumber(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 2147483647) throw new Error(`${label} must be a whole number at or above zero.`);
  return number;
}

function positiveWholeNumber(value, label) {
  const number = wholeNumber(value, label);
  if (number < 1) throw new Error(`${label} must be greater than zero.`);
  return number;
}

function nullableTermId(value) {
  const termId = String(value ?? "").trim();
  return termId || null;
}

function presetPath(config) {
  return config.landsraadMilestonePresetFile
    || resolve(config.generatedDir || resolve(config.repoRoot, "runtime/generated"), "landsraad-milestones.json");
}

function writePreset(config, value) {
  const file = presetPath(config);
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, ...value, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o664 });
  renameSync(temporary, file);
  try { chmodSync(file, 0o664); } catch {}
}
