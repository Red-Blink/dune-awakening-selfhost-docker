import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retireLegacyEdaExchangeBot } from "../src/services/marketBotRetirement.js";

function makeRepo() {
  return mkdtempSync(join(tmpdir(), "dune-eda-retirement-"));
}

function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function paths(repoRoot) {
  return {
    installed: join(repoRoot, "runtime/addons/installed/eda-exchange-bot"),
    legacy: join(repoRoot, "runtime/addons/jobs/eda-exchange-bot"),
    core: join(repoRoot, "runtime/generated/market-bot"),
    state: join(repoRoot, "runtime/addons/state.json")
  };
}

test("initializes healthy core state when EDA was already uninstalled", async () => {
  const repoRoot = makeRepo();
  try {
    const result = await retireLegacyEdaExchangeBot({ repoRoot }, { now: () => new Date("2026-08-17T12:00:00.000Z") });
    const target = paths(repoRoot);
    assert.equal(result.retired, true);
    assert.equal(result.addonRemoved, true);
    assert.equal(result.migrated, true);
    assert.deepEqual(
      [readJson(join(target.core, "buyback.json")).enabled, readJson(join(target.core, "buyback.json")).source],
      [false, "console"]
    );
    assert.deepEqual(
      [readJson(join(target.core, "seed.json")).enabled, readJson(join(target.core, "seed.json")).source],
      [false, "console"]
    );
    assert.equal(readJson(join(target.core, "eda-retirement.json")).legacyAddonFound, false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("migrates enabled legacy schedules after EDA was already uninstalled", async () => {
  const repoRoot = makeRepo();
  try {
    const target = paths(repoRoot);
    writeJson(join(target.legacy, "buyback.json"), {
      enabled: true,
      exchangeId: "5",
      intervalMinutes: 15,
      buybackPercent: 60,
      source: "console",
      nextRunAt: "2026-08-17T12:47:58.244Z"
    });
    writeJson(join(target.legacy, "seed.json"), {
      enabled: true,
      exchangeId: "5",
      intervalMinutes: 15,
      priceMultiplier: 5,
      source: "console",
      nextRunAt: "2026-08-17T12:45:45.549Z"
    });

    const result = await retireLegacyEdaExchangeBot({ repoRoot }, { now: () => new Date("2026-08-17T12:40:00.000Z") });

    assert.equal(result.addonRemoved, true);
    assert.equal(existsSync(target.installed), false);
    assert.equal(existsSync(target.legacy), false);
    assert.deepEqual(
      [readJson(join(target.core, "buyback.json")).enabled, readJson(join(target.core, "buyback.json")).nextRunAt],
      [true, "2026-08-17T12:47:58.244Z"]
    );
    assert.deepEqual(
      [readJson(join(target.core, "seed.json")).enabled, readJson(join(target.core, "seed.json")).nextRunAt],
      [true, "2026-08-17T12:45:45.549Z"]
    );
    assert.equal(readJson(join(target.core, "eda-retirement.json")).legacyAddonFound, false);
    assert.equal(readJson(join(target.core, "eda-retirement.json")).legacySchedulesFound, true);
    assert.equal(existsSync(join(repoRoot, result.backupDir, "jobs/buyback.json")), true);
    assert.equal(existsSync(join(repoRoot, result.backupDir, "jobs/seed.json")), true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("backs up and migrates installed EDA schedules before removal", async () => {
  const repoRoot = makeRepo();
  try {
    const target = paths(repoRoot);
    writeJson(join(target.installed, "addon.json"), {
      schemaVersion: 1, id: "eda-exchange-bot", name: "EDA Exchange Bot", version: "1.0.0",
      type: "ui", entry: { path: "web/index.html" }, permissions: []
    });
    writeJson(target.state, { "eda-exchange-bot": { enabled: true } });
    writeJson(join(target.legacy, "buyback.json"), { enabled: true, exchangeId: "42", intervalMinutes: 30, nextRunAt: "2026-08-17T12:30:00.000Z", source: "addon" });
    writeJson(join(target.legacy, "seed.json"), { enabled: true, exchangeId: "42", intervalMinutes: 60, nextRunAt: "2026-08-17T13:00:00.000Z", source: "addon" });

    const result = await retireLegacyEdaExchangeBot({ repoRoot }, { now: () => new Date("2026-08-17T12:00:00.000Z") });
    assert.equal(existsSync(target.installed), false);
    assert.equal(existsSync(target.legacy), false);
    assert.equal(readJson(join(target.core, "buyback.json")).source, "console");
    assert.equal(readJson(join(target.core, "buyback.json")).exchangeId, "42");
    assert.equal(readJson(join(target.core, "buyback.json")).nextRunAt, "2026-08-17T12:30:00.000Z");
    assert.equal(readJson(join(target.core, "seed.json")).source, "console");
    assert.ok(result.backupDir);
    assert.equal(existsSync(join(repoRoot, result.backupDir, "installed-addon/addon.json")), true);
    assert.equal(existsSync(join(repoRoot, result.backupDir, "jobs/buyback.json")), true);
    assert.deepEqual(readJson(target.state), {});
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("leaves legacy state untouched when a schedule is malformed", async () => {
  const repoRoot = makeRepo();
  try {
    const target = paths(repoRoot);
    mkdirSync(target.installed, { recursive: true });
    writeFileSync(join(target.installed, "keep.txt"), "keep");
    writeJson(join(target.legacy, "buyback.json"), { enabled: true, exchangeId: "not-an-id" });
    await assert.rejects(retireLegacyEdaExchangeBot({ repoRoot }), /Legacy EDA buyback schedule is invalid/);
    assert.equal(existsSync(join(target.installed, "keep.txt")), true);
    assert.equal(existsSync(join(target.legacy, "buyback.json")), true);
    assert.equal(existsSync(target.core), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("keeps core state and retries an interrupted addon cleanup", async () => {
  const repoRoot = makeRepo();
  try {
    const target = paths(repoRoot);
    mkdirSync(target.installed, { recursive: true });
    writeFileSync(join(target.installed, "keep.txt"), "keep");
    const first = await retireLegacyEdaExchangeBot({ repoRoot }, {
      removeAddon: async () => { await Promise.resolve(); throw new Error("busy"); }
    });
    assert.equal(first.retired, true);
    assert.equal(first.addonRemoved, false);
    assert.match(first.cleanupError, /busy/);
    assert.equal(existsSync(join(target.core, "buyback.json")), true);
    assert.equal(existsSync(target.installed), true);

    const second = await retireLegacyEdaExchangeBot({ repoRoot }, {
      removeAddon: (_config, _id) => rmSync(target.installed, { recursive: true, force: true })
    });
    assert.equal(second.migrated, false);
    assert.equal(second.addonRemoved, true);
    assert.equal(second.cleanupError, "");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("preserves an existing native schedule and fills its missing companion", async () => {
  const repoRoot = makeRepo();
  try {
    const target = paths(repoRoot);
    writeJson(join(target.core, "buyback.json"), {
      enabled: true, exchangeId: "99", intervalMinutes: 45, source: "console"
    });
    writeJson(join(target.legacy, "buyback.json"), {
      enabled: true, exchangeId: "42", intervalMinutes: 30, source: "addon"
    });
    writeJson(join(target.legacy, "seed.json"), {
      enabled: true, exchangeId: "77", intervalMinutes: 60, source: "addon"
    });

    const result = await retireLegacyEdaExchangeBot({ repoRoot });
    assert.equal(result.migrated, true);
    assert.equal(readJson(join(target.core, "buyback.json")).exchangeId, "99");
    assert.equal(readJson(join(target.core, "seed.json")).exchangeId, "77");
    assert.equal(readJson(join(target.core, "seed.json")).source, "console");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
