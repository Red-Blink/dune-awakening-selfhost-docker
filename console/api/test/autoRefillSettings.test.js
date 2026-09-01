import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  AUTO_REFILL_SETTING_SPECS,
  autoRefillSettingsView,
  readAutoRefillSettings,
  resolveAutoRefillSetting,
  saveAutoRefillSettings
} from "../src/services/autoRefillSettings.js";

// Empty env so the host's own ADMIN_AUTO_REFILL_* values cannot change results.
const TEST_ENV = {};

async function withRepo(run) {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-auto-refill-settings-"));
  try {
    await run(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

function settingsPath(repoRoot) {
  return resolve(repoRoot, "runtime/generated/auto-refill-settings.json");
}

function writeRaw(repoRoot, contents) {
  const file = settingsPath(repoRoot);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
}

// --- Reading ---

test("an absent settings file reads as no overrides", async () => {
  await withRepo((repoRoot) => {
    assert.deepEqual(readAutoRefillSettings(repoRoot), {});
    assert.equal(existsSync(settingsPath(repoRoot)), false, "reading must not create the file");
  });
});

test("a corrupt settings file degrades to no overrides rather than throwing", async () => {
  await withRepo((repoRoot) => {
    writeRaw(repoRoot, "{ not json");
    assert.deepEqual(readAutoRefillSettings(repoRoot), {});
    assert.equal(resolveAutoRefillSetting("thresholdPercent", { repoRoot, env: TEST_ENV }), 50);
  });
});

test("a hand-edited out-of-range value is dropped, not clamped", async () => {
  await withRepo((repoRoot) => {
    writeRaw(repoRoot, { thresholdPercent: 500, intervalHours: 0 });
    assert.deepEqual(readAutoRefillSettings(repoRoot), {});
    // Falls through to the env layer rather than pinning to the nearest legal
    // value -- 500 was not an instruction to use 99.
    const env = { ADMIN_AUTO_REFILL_THRESHOLD_PERCENT: "70" };
    assert.equal(resolveAutoRefillSetting("thresholdPercent", { repoRoot, env }), 70);
  });
});

// The whole reason "unset" is an absent key: clampInt turns null and "" into 0,
// which clamps to min, so a persisted blank would silently read as 1% / 1h.
test("a persisted null or empty string never resolves to the minimum", async () => {
  await withRepo((repoRoot) => {
    writeRaw(repoRoot, { thresholdPercent: null, intervalHours: "", waterThresholdPercent: undefined });
    assert.deepEqual(readAutoRefillSettings(repoRoot), {});
    assert.equal(resolveAutoRefillSetting("thresholdPercent", { repoRoot, env: TEST_ENV }), 50);
    assert.notEqual(resolveAutoRefillSetting("thresholdPercent", { repoRoot, env: TEST_ENV }), AUTO_REFILL_SETTING_SPECS.thresholdPercent.min);
    assert.equal(resolveAutoRefillSetting("intervalHours", { repoRoot, env: TEST_ENV }), 24);
    assert.notEqual(resolveAutoRefillSetting("intervalHours", { repoRoot, env: TEST_ENV }), AUTO_REFILL_SETTING_SPECS.intervalHours.min);
  });
});

test("a non-object settings file reads as no overrides", async () => {
  await withRepo((repoRoot) => {
    writeRaw(repoRoot, [1, 2, 3]);
    assert.deepEqual(readAutoRefillSettings(repoRoot), {});
    writeRaw(repoRoot, "null");
    assert.deepEqual(readAutoRefillSettings(repoRoot), {});
  });
});

// --- Layering ---

test("the settings file beats the env var, which beats the hardcoded default", async () => {
  await withRepo((repoRoot) => {
    const env = { ADMIN_AUTO_REFILL_THRESHOLD_PERCENT: "70" };
    assert.equal(resolveAutoRefillSetting("thresholdPercent", { repoRoot, env: TEST_ENV }), 50, "default");
    assert.equal(resolveAutoRefillSetting("thresholdPercent", { repoRoot, env }), 70, "env beats default");
    saveAutoRefillSettings(repoRoot, { thresholdPercent: 40 });
    assert.equal(resolveAutoRefillSetting("thresholdPercent", { repoRoot, env }), 40, "file beats env");
  });
});

test("an out-of-range env var still clamps rather than being dropped", async () => {
  await withRepo((repoRoot) => {
    // Only the env layer goes through clampInt -- an operator's bad env value
    // is a startup-time typo we survive, not a hand edit of console state.
    assert.equal(resolveAutoRefillSetting("thresholdPercent", { repoRoot, env: { ADMIN_AUTO_REFILL_THRESHOLD_PERCENT: "500" } }), 99);
    assert.equal(resolveAutoRefillSetting("intervalHours", { repoRoot, env: { ADMIN_AUTO_REFILL_INTERVAL_HOURS: "0" } }), 1);
  });
});

test("the four settings resolve independently of each other", async () => {
  await withRepo((repoRoot) => {
    saveAutoRefillSettings(repoRoot, { thresholdPercent: 30, waterIntervalHours: 6 });
    assert.equal(resolveAutoRefillSetting("thresholdPercent", { repoRoot, env: TEST_ENV }), 30);
    assert.equal(resolveAutoRefillSetting("intervalHours", { repoRoot, env: TEST_ENV }), 24, "untouched key keeps its default");
    assert.equal(resolveAutoRefillSetting("waterThresholdPercent", { repoRoot, env: TEST_ENV }), 50, "generator setting does not leak into water");
    assert.equal(resolveAutoRefillSetting("waterIntervalHours", { repoRoot, env: TEST_ENV }), 6);
  });
});

// --- Saving ---

test("only the keys actually set are persisted", async () => {
  await withRepo((repoRoot) => {
    saveAutoRefillSettings(repoRoot, { thresholdPercent: 40 });
    assert.deepEqual(JSON.parse(readFileSync(settingsPath(repoRoot), "utf8")), { thresholdPercent: 40 });
  });
});

test("an omitted key leaves the stored value alone", async () => {
  await withRepo((repoRoot) => {
    saveAutoRefillSettings(repoRoot, { thresholdPercent: 40, intervalHours: 6 });
    saveAutoRefillSettings(repoRoot, { intervalHours: 12 });
    assert.deepEqual(readAutoRefillSettings(repoRoot), { thresholdPercent: 40, intervalHours: 12 });
  });
});

// Reset has to DELETE the key, not write the default. Writing the default would
// persist the current env value and permanently shadow the env var, so a later
// change to ADMIN_AUTO_REFILL_* would silently stop taking effect.
test("null resets a key by deleting it, restoring the env layer", async () => {
  await withRepo((repoRoot) => {
    const env = { ADMIN_AUTO_REFILL_THRESHOLD_PERCENT: "70" };
    saveAutoRefillSettings(repoRoot, { thresholdPercent: 40 });
    assert.equal(resolveAutoRefillSetting("thresholdPercent", { repoRoot, env }), 40);

    saveAutoRefillSettings(repoRoot, { thresholdPercent: null });
    assert.deepEqual(JSON.parse(readFileSync(settingsPath(repoRoot), "utf8")), {}, "key removed, not blanked");
    assert.equal(resolveAutoRefillSetting("thresholdPercent", { repoRoot, env }), 70, "env layer is live again");
  });
});

test("resetting one key leaves the others overridden", async () => {
  await withRepo((repoRoot) => {
    saveAutoRefillSettings(repoRoot, { thresholdPercent: 40, waterThresholdPercent: 30 });
    saveAutoRefillSettings(repoRoot, { thresholdPercent: null });
    assert.deepEqual(readAutoRefillSettings(repoRoot), { waterThresholdPercent: 30 });
  });
});

test("saving rejects values the scanners could not act on", async () => {
  await withRepo((repoRoot) => {
    for (const key of Object.keys(AUTO_REFILL_SETTING_SPECS)) {
      const spec = AUTO_REFILL_SETTING_SPECS[key];
      for (const bad of [spec.min - 1, spec.max + 1, 1.5, "40", true, [], {}, NaN]) {
        assert.throws(
          () => saveAutoRefillSettings(repoRoot, { [key]: bad }),
          (error) => error.statusCode === 400,
          `${key} should reject ${JSON.stringify(bad) ?? String(bad)}`
        );
      }
    }
    assert.equal(existsSync(settingsPath(repoRoot)), false, "a rejected save must not create the file");
  });
});

test("saving rejects a non-object body and an empty patch", async () => {
  await withRepo((repoRoot) => {
    for (const bad of [null, undefined, "x", 5, []]) {
      assert.throws(() => saveAutoRefillSettings(repoRoot, bad), (error) => error.statusCode === 400);
    }
    assert.throws(() => saveAutoRefillSettings(repoRoot, {}), (error) => error.statusCode === 400);
    assert.throws(() => saveAutoRefillSettings(repoRoot, { notASetting: 5 }), (error) => error.statusCode === 400);
  });
});

test("a rejected save leaves existing settings untouched", async () => {
  await withRepo((repoRoot) => {
    saveAutoRefillSettings(repoRoot, { thresholdPercent: 40 });
    assert.throws(() => saveAutoRefillSettings(repoRoot, { thresholdPercent: 500 }), (error) => error.statusCode === 400);
    assert.deepEqual(readAutoRefillSettings(repoRoot), { thresholdPercent: 40 });
  });
});

test("the boundary values of each range are accepted", async () => {
  await withRepo((repoRoot) => {
    for (const [key, spec] of Object.entries(AUTO_REFILL_SETTING_SPECS)) {
      saveAutoRefillSettings(repoRoot, { [key]: spec.min });
      assert.equal(resolveAutoRefillSetting(key, { repoRoot, env: TEST_ENV }), spec.min);
      saveAutoRefillSettings(repoRoot, { [key]: spec.max });
      assert.equal(resolveAutoRefillSetting(key, { repoRoot, env: TEST_ENV }), spec.max);
    }
  });
});

// --- The GET payload ---

test("the view reports where each value came from", async () => {
  await withRepo((repoRoot) => {
    const env = { ADMIN_AUTO_REFILL_INTERVAL_HOURS: "12" };
    saveAutoRefillSettings(repoRoot, { thresholdPercent: 40 });
    const view = autoRefillSettingsView(repoRoot, env);

    assert.equal(view.settings.thresholdPercent, 40);
    assert.equal(view.sources.thresholdPercent, "console");
    assert.equal(view.settings.intervalHours, 12);
    assert.equal(view.sources.intervalHours, "env");
    assert.equal(view.settings.waterThresholdPercent, 50);
    assert.equal(view.sources.waterThresholdPercent, "default");
  });
});

// Reset restores the env value where one is set, so the overlay can offer it
// without knowing the layering. If this returned the hardcoded fallback, Reset
// on an env-configured host would visibly change the number.
test("the view's defaults are what Reset restores, not the hardcoded fallback", async () => {
  await withRepo((repoRoot) => {
    const view = autoRefillSettingsView(repoRoot, { ADMIN_AUTO_REFILL_INTERVAL_HOURS: "12" });
    assert.equal(view.defaults.intervalHours, 12);
    assert.equal(view.defaults.thresholdPercent, 50, "no env var set, so the fallback is the default");
  });
});

test("the view carries the limits and env names the overlay needs", async () => {
  await withRepo((repoRoot) => {
    const view = autoRefillSettingsView(repoRoot, TEST_ENV);
    assert.deepEqual(view.limits.thresholdPercent, { min: 1, max: 99 });
    assert.deepEqual(view.limits.intervalHours, { min: 1, max: 168 });
    assert.equal(view.envNames.waterIntervalHours, "ADMIN_AUTO_REFILL_WATER_INTERVAL_HOURS");
    assert.deepEqual(Object.keys(view.settings).sort(), Object.keys(AUTO_REFILL_SETTING_SPECS).sort());
  });
});

// A blank env var is how .env carries a declared-but-unset optional. Before
// this was fixed it read as 0 and clamped to the MINIMUM, so a blank
// ADMIN_AUTO_REFILL_INTERVAL_HOURS meant hourly scans instead of daily.
test("a blank env var reads as unset rather than clamping to the minimum", async () => {
  await withRepo((repoRoot) => {
    for (const blank of ["", "   "]) {
      const env = { ADMIN_AUTO_REFILL_INTERVAL_HOURS: blank, ADMIN_AUTO_REFILL_THRESHOLD_PERCENT: blank };
      assert.equal(resolveAutoRefillSetting("intervalHours", { repoRoot, env }), 24);
      assert.equal(resolveAutoRefillSetting("thresholdPercent", { repoRoot, env }), 50);
      const view = autoRefillSettingsView(repoRoot, env);
      assert.equal(view.sources.intervalHours, "default");
      assert.equal(view.settings.intervalHours, 24);
      assert.equal(view.defaults.intervalHours, 24, "Reset must not restore the clamped minimum");
    }
  });
});
