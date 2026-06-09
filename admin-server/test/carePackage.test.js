import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { enableStarterKit, grantEligibleStarterKits, grantStarterKit, runStarterKitAutoScan, saveStarterKitConfig, starterKitCapabilities, starterKitConfig, starterKitEligiblePlayers, validateStarterKitConfig } from "../src/carePackage.js";

test("starter kit is disabled by default and reports manual capability", () => {
  const config = tempConfig();
  try {
    assert.equal(starterKitConfig(config).enabled, false);
    const caps = starterKitCapabilities();
    assert.equal(caps.manualGrant, true);
    assert.equal(caps.bulkGrant, true);
    assert.equal(caps.automaticScanner, true);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("starter kit config validation rejects unsafe items and bounds", () => {
  assert.deepEqual(validateStarterKitConfig({
    enabled: false,
    version: "starter-kit-v1",
    items: [{ itemName: "Water", quantity: 2, durability: 1 }],
    xp: 100
  }).items[0], { itemName: "Water", itemId: "", quantity: 2, durability: 1 });
  assert.equal(validateStarterKitConfig({ autoGrantEnabled: true, autoGrantIntervalSeconds: 60, grantWhen: "first_online" }).grantWhen, "first_online");
  assert.equal(validateStarterKitConfig({ version: "bad version with spaces" }).version, "starter-kit-v1");
  assert.throws(() => validateStarterKitConfig({ items: [{ itemName: "Bad\nName" }] }), /Invalid Care Package item name/);
  assert.throws(() => validateStarterKitConfig({ xp: -1 }), /xp/);
  assert.throws(() => validateStarterKitConfig({ autoGrantIntervalSeconds: 59 }), /autoGrantIntervalSeconds/);
  assert.equal(validateStarterKitConfig({ grantWhen: "always" }).grantWhen, "first_online");
  assert.equal(validateStarterKitConfig({ grantWhen: "first_seen" }).grantWhen, "last_seen");
  assert.equal(validateStarterKitConfig({ grantWhen: "last_seen" }).grantWhen, "last_seen");
});

test("starter kit config writes and enable disable stay file-backed", () => {
  const config = tempConfig();
  try {
    const saved = saveStarterKitConfig(config, {
      enabled: false,
      version: "starter-kit-v2",
      items: [{ itemId: "WaterBottle_1", quantity: 1, durability: 1 }],
      xp: 10
    });
    assert.equal(saved.version, "starter-kit-v2");
    assert.equal(saved.kits[0].name, "Care Package");
    assert.equal(starterKitConfig(config).items[0].itemId, "WaterBottle_1");
    assert.equal(enableStarterKit(config, true).enabled, true);
    assert.equal(enableStarterKit(config, false).enabled, false);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("starter kit config can persist zero kits", () => {
  const config = tempConfig();
  try {
    const saved = saveStarterKitConfig(config, {
      enabled: false,
      activeKitId: "",
      autoGrantKitId: "",
      kits: [],
      autoGrantRules: []
    });
    assert.deepEqual(saved.kits, []);
    assert.deepEqual(saved.autoGrantRules, []);
    assert.equal(starterKitConfig(config).kits.length, 0);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("starter kit config can persist zero auto grant rules", () => {
  const config = tempConfig();
  try {
    const saved = saveStarterKitConfig(config, {
      enabled: true,
      activeKitId: "package-a",
      autoGrantKitId: "package-a",
      kits: [{ id: "package-a", name: "Package A", xp: 10, items: [] }],
      autoGrantRules: []
    });
    assert.deepEqual(saved.autoGrantRules, []);
    assert.equal(starterKitConfig(config).autoGrantRules.length, 0);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("starter kit eligibility skips missing action ids, offline players, and already granted players", async () => {
  const config = tempConfig();
  try {
    saveStarterKitConfig(config, { enabled: true, version: "starter-kit-v1", xp: 10, items: [] });
    const granted = await grantStarterKit(config, "RedBlink#75570", { confirmation: "GRANT STARTER KIT" });
    assert.equal(granted.status, "granted");
    const result = starterKitEligiblePlayers(config, [
      { actor_id: 82, character_name: "RedBlink", action_player_id: "RedBlink#75570", online_status: "Online" },
      { actor_id: 83, character_name: "NoId", action_player_id: "", online_status: "Online" },
      { actor_id: 84, character_name: "New", action_player_id: "New#1", online_status: "Offline" }
    ]);
    assert.equal(result.rows.find((row) => row.character_name === "RedBlink").eligible, false);
    assert.match(result.rows.find((row) => row.character_name === "RedBlink").reason, /Already granted/);
    assert.equal(result.rows.find((row) => row.character_name === "NoId").eligible, false);
    assert.equal(result.rows.find((row) => row.character_name === "New").eligible, false);
    assert.match(result.rows.find((row) => row.character_name === "New").reason, /Not currently online/);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("starter kit manual repeat grants are allowed while automatic repeats stay blocked", async () => {
  const config = tempConfig();
  try {
    saveStarterKitConfig(config, { enabled: true, version: "starter-kit-v1", xp: 10, items: [], allowRepeatGrants: false });
    await grantStarterKit(config, "RedBlink#75570", { confirmation: "GRANT STARTER KIT" });
    const repeat = await grantStarterKit(config, "RedBlink#75570", { confirmation: "GRANT STARTER KIT" });
    assert.equal(repeat.status, "granted");
    await assert.rejects(() => grantStarterKit(config, "RedBlink#75570", { confirmation: "GRANT STARTER KIT", source: "auto" }), /already granted/);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("starter kit supports separate manual and auto-grant kit selection", async () => {
  const config = tempConfig();
  try {
    saveStarterKitConfig(config, {
      enabled: true,
      activeKitId: "manual-kit",
      autoGrantKitId: "auto-kit",
      autoGrantEnabled: true,
      kits: [
        { id: "manual-kit", name: "Manual Kit", xp: 10, items: [] },
        { id: "auto-kit", name: "Auto Kit", xp: 25, items: [] }
      ]
    });
    const manual = await grantStarterKit(config, "Manual#1", { confirmation: "GRANT STARTER KIT", kitId: "manual-kit" });
    assert.equal(manual.kitName, "Manual Kit");
    assert.equal(manual.version, "manual-kit");
    const auto = await runStarterKitAutoScan(config, [{ actor_id: 1, character_name: "Auto", action_player_id: "Auto#1", online_status: "Online" }]);
    assert.equal(auto.granted, 1);
    assert.equal(auto.results[0].kitName, "Auto Kit");
    assert.equal(auto.results[0].version, "auto-kit");
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("starter kit auto scan supports multiple enabled rules with different conditions", async () => {
  const config = tempConfig();
  try {
    saveStarterKitConfig(config, {
      enabled: true,
      activeKitId: "online-kit",
      autoGrantKitId: "online-kit",
      autoGrantEnabled: true,
      kits: [
        { id: "online-kit", name: "Online Kit", xp: 10, items: [] },
        { id: "detected-kit", name: "Detected Kit", xp: 25, items: [] }
      ],
      autoGrantRules: [
        { id: "online-rule", enabled: true, kitId: "online-kit", grantWhen: "first_online" },
        { id: "last-seen-rule", enabled: true, kitId: "detected-kit", grantWhen: "last_seen", lastSeenDays: 30 }
      ]
    });
    const result = await runStarterKitAutoScan(config, [
      { actor_id: 1, character_name: "Online", action_player_id: "Online#1", online_status: "Online", last_seen: "2026-01-01T00:00:00.000Z" },
      { actor_id: 2, character_name: "Offline", action_player_id: "Offline#1", online_status: "Offline", last_seen: "2026-01-01T00:00:00.000Z" }
    ]);
    assert.equal(result.results.filter((row) => row.status === "granted" && row.kitName === "Online Kit").length, 1);
    assert.equal(result.results.filter((row) => row.status === "granted" && row.kitName === "Detected Kit").length, 1);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("starter kit grant all successes records granted status and summary", async () => {
  const config = tempConfig();
  try {
    writeCatalog(config);
    saveStarterKitConfig(config, { enabled: true, version: "starter-kit-v1", xp: 10, items: [{ itemName: "Plant Fiber", quantity: 2, durability: 1 }] });
    const result = await grantStarterKit(config, "RedBlink#75570", { confirmation: "GRANT STARTER KIT" });
    assert.equal(result.status, "granted");
    assert.equal(result.ok, true);
    assert.match(result.summary, /2 succeeded, 0 failed/);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("care package welcome message is sent as a grant action", async () => {
  const config = tempConfig();
  try {
    saveStarterKitConfig(config, {
      enabled: true,
      version: "starter-kit-v1",
      xp: 10,
      items: [],
      kits: [{ id: "starter-kit-v1", name: "Care Package", xp: 10, items: [], welcomeMessage: "Welcome" }]
    });
    const result = await grantStarterKit(config, "RedBlink#75570", {
      confirmation: "GRANT STARTER KIT",
      characterName: "RedBlink",
      funcomId: "RedBlink#75570"
    }, { db: fakePersonaDb() });
    assert.equal(result.status, "granted");
    assert.equal(result.results.find((row) => row.operation === "carePackageWelcomeWhisper")?.ok, true);
    assert.match(result.summary, /2 succeeded, 0 failed/);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("care package welcome message fails clearly without recipient identity", async () => {
  const config = tempConfig();
  try {
    saveStarterKitConfig(config, {
      enabled: true,
      version: "starter-kit-v1",
      xp: 10,
      items: [],
      kits: [{ id: "starter-kit-v1", name: "Care Package", xp: 10, items: [], welcomeMessage: "Welcome" }]
    });
    const result = await grantStarterKit(config, "12345", { confirmation: "GRANT STARTER KIT" }, { db: fakePersonaDb() });
    assert.equal(result.status, "partial_failed");
    assert.match(result.summary, /recipient Funcom ID is unavailable/);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("starter kit grant partial failures records partial_failed status and summary", async () => {
  const config = tempConfig();
  try {
    writeCatalog(config);
    saveStarterKitConfig(config, {
      enabled: true,
      version: "starter-kit-v1",
      xp: 10,
      items: [
        { itemName: "fiber", quantity: 10, durability: 1 },
        { itemName: "Cup of Water", quantity: 1, durability: 1 }
      ]
    });
    const result = await grantStarterKit(config, "RedBlink#75570", { confirmation: "GRANT STARTER KIT" });
    assert.equal(result.status, "partial_failed");
    assert.equal(result.ok, false);
    assert.match(result.summary, /2 succeeded, 1 failed/);
    assert.match(result.summary, /fiber x10 failed: No item found for: fiber/);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("starter kit grant all failures records failed status and no blank summary", async () => {
  const config = tempConfig();
  try {
    writeCatalog(config);
    saveStarterKitConfig(config, { enabled: true, version: "starter-kit-v1", xp: 0, items: [{ itemName: "fiber", quantity: 10, durability: 1 }] });
    const result = await grantStarterKit(config, "RedBlink#75570", { confirmation: "GRANT STARTER KIT" });
    assert.equal(result.status, "failed");
    assert.equal(result.ok, false);
    assert.match(result.summary, /0 succeeded, 1 failed/);
    assert.ok(result.summary.length > 0);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("starter kit bulk grant returns per-player granted skipped and failed rows", async () => {
  const config = tempConfig();
  try {
    saveStarterKitConfig(config, { enabled: true, version: "starter-kit-v1", xp: 10, items: [] });
    await grantStarterKit(config, "Existing#1", { confirmation: "GRANT STARTER KIT" });
    const result = await grantEligibleStarterKits(config, [
      { actor_id: 1, character_name: "Existing", action_player_id: "Existing#1", online_status: "Online" },
      { actor_id: 2, character_name: "Missing", action_player_id: "", online_status: "Online" },
      { actor_id: 3, character_name: "New", action_player_id: "New#1", online_status: "Online" }
    ], { confirmation: "GRANT STARTER KIT TO ELIGIBLE PLAYERS" });
    assert.equal(result.granted, 1);
    assert.equal(result.skipped, 2);
    assert.equal(result.failed, 0);
    assert.equal(result.results.find((row) => row.character_name === "New").playerId, "New#1");
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("starter kit auto scan only grants when enabled and players have action ids", async () => {
  const config = tempConfig();
  try {
    saveStarterKitConfig(config, { enabled: false, version: "starter-kit-v1", xp: 10, items: [], autoGrantEnabled: true });
    assert.equal((await runStarterKitAutoScan(config, [{ actor_id: 1, action_player_id: "A#1" }])).skipped, true);
    saveStarterKitConfig(config, { enabled: true, version: "starter-kit-v1", xp: 10, items: [], autoGrantEnabled: false });
    assert.equal((await runStarterKitAutoScan(config, [{ actor_id: 1, action_player_id: "A#1" }])).skipped, true);
    saveStarterKitConfig(config, { enabled: true, version: "starter-kit-v1", xp: 10, items: [], autoGrantEnabled: true });
    const result = await runStarterKitAutoScan(config, [
      { actor_id: 1, character_name: "A", action_player_id: "A#1", online_status: "Online" },
      { actor_id: 2, character_name: "B", action_player_id: "", online_status: "Online" }
    ]);
    assert.equal(result.granted, 1);
    const duplicate = await runStarterKitAutoScan(config, [{ actor_id: 1, character_name: "A", action_player_id: "A#1", online_status: "Online" }]);
    assert.equal(duplicate.granted, 0);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

function tempConfig() {
  const repoRoot = mkdtempSync(join(tmpdir(), "starter-kit-test-"));
  return {
    repoRoot,
    generatedDir: resolve(repoRoot, "runtime/generated"),
    mockMode: true
  };
}

function writeCatalog(config) {
  mkdirSync(resolve(config.repoRoot, "runtime/data"), { recursive: true });
  writeFileSync(resolve(config.repoRoot, "runtime/data/admin-items.json"), JSON.stringify([
    { id: "PlantFiber_1", name: "Plant Fiber", category: "materials" },
    { id: "CupWater_1", name: "Cup of Water", category: "consumables" }
  ]));
}

function fakePersonaDb() {
  const columns = {
    accounts: ["id", "user", "funcom_id"],
    encrypted_accounts: ["id", "encrypted_funcom_id"],
    player_state: ["account_id", "character_name"]
  };
  return {
    queries: [],
    async query(text, params = []) {
      this.queries.push({ text, params });
      if (/information_schema\.columns/.test(text)) {
        return { rows: (columns[params[0]] || []).map((column_name) => ({ column_name })) };
      }
      return { rows: [], rowCount: 1 };
    }
  };
}
