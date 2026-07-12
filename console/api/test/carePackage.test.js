import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { clearCarePackageHistory, enableCarePackage, grantEligibleCarePackages, grantCarePackage, runCarePackageAutoScan, saveCarePackageConfig, carePackageCapabilities, carePackageConfig, carePackageEligiblePlayers, carePackageHistory, validateCarePackageConfig } from "../src/carePackage.js";

test("care package starts empty, disabled, and reports manual capability", () => {
  const config = tempConfig();
  try {
    const initial = carePackageConfig(config);
    assert.equal(initial.enabled, false);
    assert.equal(initial.activeKitId, "");
    assert.equal(initial.autoGrantKitId, "");
    assert.deepEqual(initial.kits, []);
    assert.deepEqual(initial.items, []);
    assert.equal(initial.xp, 0);
    assert.equal(initial.autoGrantEnabled, false);
    assert.deepEqual(initial.autoGrantRules, []);
    const caps = carePackageCapabilities();
    assert.equal(caps.manualGrant, true);
    assert.equal(caps.bulkGrant, true);
    assert.equal(caps.automaticScanner, true);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("care package config validation rejects unsafe items and bounds", () => {
  assert.deepEqual(validateCarePackageConfig({
    enabled: false,
    version: "care-package-v1",
    items: [{ itemName: "Water", quantity: 2, durability: 1 }],
    xp: 100
  }).items[0], { itemName: "Water", itemId: "", quantity: 2, quality: 0, durability: 1, augments: [] });
  assert.deepEqual(validateCarePackageConfig({
    items: [{ itemName: "Water", quantity: 2, grade: 5, durability: 0, augments: ["T6_Augment_Damage1"], augmentQuality: 5 }]
  }).items[0], { itemName: "Water", itemId: "", quantity: 2, quality: 0, durability: 1, augments: [] });
  assert.equal(validateCarePackageConfig({ autoGrantEnabled: true, autoGrantIntervalSeconds: 60, grantWhen: "first_online" }).grantWhen, "first_online");
  assert.equal(validateCarePackageConfig({ version: "bad version with spaces" }).version, "");
  assert.throws(() => validateCarePackageConfig({ items: [{ itemName: "Bad\nName" }] }), /Invalid Care Package item name/);
  assert.throws(() => validateCarePackageConfig({ xp: -1 }), /xp/);
  assert.throws(() => validateCarePackageConfig({ autoGrantIntervalSeconds: 59 }), /autoGrantIntervalSeconds/);
  assert.equal(validateCarePackageConfig({ grantWhen: "always" }).grantWhen, "first_online");
  assert.equal(validateCarePackageConfig({ grantWhen: "last_seen" }).grantWhen, "last_seen");
});

test("care package config writes and enable disable stay file-backed", () => {
  const config = tempConfig();
  try {
    const saved = saveCarePackageConfig(config, {
      enabled: false,
      version: "care-package-v2",
      items: [{ itemId: "WaterBottle_1", quantity: 1, durability: 1 }],
      xp: 10
    });
    assert.equal(saved.version, "care-package-v2");
    assert.equal(saved.kits[0].name, "Care Package");
    assert.equal(carePackageConfig(config).items[0].itemId, "WaterBottle_1");
    assert.equal(enableCarePackage(config, true).enabled, true);
    assert.equal(enableCarePackage(config, false).enabled, false);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("care package config can persist zero kits", () => {
  const config = tempConfig();
  try {
    const saved = saveCarePackageConfig(config, {
      enabled: false,
      activeKitId: "",
      autoGrantKitId: "",
      kits: [],
      autoGrantRules: []
    });
    assert.deepEqual(saved.kits, []);
    assert.deepEqual(saved.autoGrantRules, []);
    assert.equal(carePackageConfig(config).kits.length, 0);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("care package config can persist zero auto grant rules", () => {
  const config = tempConfig();
  try {
    const saved = saveCarePackageConfig(config, {
      enabled: true,
      activeKitId: "package-a",
      autoGrantKitId: "package-a",
      kits: [{ id: "package-a", name: "Package A", xp: 10, items: [] }],
      autoGrantRules: []
    });
    assert.deepEqual(saved.autoGrantRules, []);
    assert.equal(carePackageConfig(config).autoGrantRules.length, 0);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("care package eligibility skips missing action ids, offline players, and already granted players", async () => {
  const config = tempConfig();
  try {
    saveCarePackageConfig(config, { enabled: true, version: "care-package-v1", xp: 10, items: [] });
    const granted = await grantCarePackage(config, "RedBlink#75570", { confirmation: "GRANT CARE PACKAGE" });
    assert.equal(granted.status, "granted");
    const result = carePackageEligiblePlayers(config, [
      { actor_id: 82, character_name: "RedBlink", action_player_id: "RedBlink#75570", online_status: "Online" },
      { actor_id: 83, character_name: "NoId", action_player_id: "", online_status: "Online" },
      { actor_id: 84, character_name: "New", action_player_id: "New#1", online_status: "Offline" }
    ]);
    assert.equal(result.rows.find((row) => row.character_name === "RedBlink").eligible, false);
    assert.match(result.rows.find((row) => row.character_name === "RedBlink").reason, /Already received first-online Care Package/);
    assert.equal(result.rows.find((row) => row.character_name === "NoId").eligible, false);
    assert.equal(result.rows.find((row) => row.character_name === "New").eligible, false);
    assert.match(result.rows.find((row) => row.character_name === "New").reason, /Not currently online/);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("care package manual repeat grants are allowed while automatic repeats stay blocked", async () => {
  const config = tempConfig();
  try {
    saveCarePackageConfig(config, { enabled: true, version: "care-package-v1", xp: 10, items: [], allowRepeatGrants: false });
    await grantCarePackage(config, "RedBlink#75570", { confirmation: "GRANT CARE PACKAGE" });
    const repeat = await grantCarePackage(config, "RedBlink#75570", { confirmation: "GRANT CARE PACKAGE" });
    assert.equal(repeat.status, "granted");
    await assert.rejects(() => grantCarePackage(config, "RedBlink#75570", { confirmation: "GRANT CARE PACKAGE", source: "auto" }), /already granted/);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("care package first-online grants are player-aware across actor and character changes", async () => {
  const config = tempConfig();
  try {
    saveCarePackageConfig(config, { enabled: true, version: "care-package-v1", xp: 10, items: [] });
    await grantCarePackage(config, "Account#1", {
      confirmation: "GRANT CARE PACKAGE",
      source: "auto",
      actorId: 101,
      accountId: "stable-account-1",
      funcomId: "funcom-1",
      flsId: "fls-1",
      characterName: "Existing"
    });
    const result = carePackageEligiblePlayers(config, [
      { actor_id: 101, character_name: "Existing", action_player_id: "Account#1", online_status: "Online" },
      { actor_id: 102, account_id: "stable-account-1", funcom_id: "funcom-1", fls_id: "fls-1", character_name: "New Character", action_player_id: "Account#1", online_status: "Online" }
    ]);
    assert.equal(result.rows.find((row) => row.character_name === "Existing").eligible, false);
    assert.equal(result.rows.find((row) => row.character_name === "New Character").eligible, false);
    assert.match(result.rows.find((row) => row.character_name === "New Character").reason, /Already received first-online Care Package/);
    await assert.rejects(() => grantCarePackage(config, "Account#1", { confirmation: "GRANT CARE PACKAGE", source: "auto", actorId: 101, characterName: "Existing" }), /already granted/);
    await assert.rejects(() => grantCarePackage(config, "Account#1", {
      confirmation: "GRANT CARE PACKAGE",
      source: "auto",
      actorId: 102,
      accountId: "stable-account-1",
      funcomId: "funcom-1",
      flsId: "fls-1",
      characterName: "New Character"
    }), /already granted/);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("care package first-online does not repeat after the package kit changes", async () => {
  const config = tempConfig();
  try {
    saveCarePackageConfig(config, {
      enabled: true,
      activeKitId: "starter-kit",
      autoGrantKitId: "starter-kit",
      kits: [{ id: "starter-kit", name: "Starter Kit", xp: 10, items: [] }],
      autoGrantRules: [{ id: "first-online-rule", enabled: true, kitId: "starter-kit", grantWhen: "first_online" }]
    });
    await runCarePackageAutoScan(config, [{
      actor_id: 101,
      account_id: "stable-account-1",
      character_name: "Test1",
      action_player_id: "Player#1",
      funcom_id: "Player#1",
      fls_id: "Player#1",
      online_status: "Online"
    }]);

    saveCarePackageConfig(config, {
      enabled: true,
      activeKitId: "boots-kit",
      autoGrantKitId: "boots-kit",
      kits: [{ id: "boots-kit", name: "Boots Kit", xp: 25, items: [] }],
      autoGrantRules: [{ id: "first-online-rule", enabled: true, kitId: "boots-kit", grantWhen: "first_online" }]
    });
    const repeat = await runCarePackageAutoScan(config, [{
      actor_id: 202,
      account_id: "stable-account-1",
      character_name: "Test1",
      action_player_id: "Player#1",
      funcom_id: "Player#1",
      fls_id: "Player#1",
      online_status: "Online"
    }]);

    assert.equal(repeat.granted, 0);
    assert.equal(repeat.skipped, 1);
    assert.match(repeat.results[0].reason, /Already received first-online Care Package/);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("care package first-online does not repeat after many skipped scans", async () => {
  const config = tempConfig();
  try {
    saveCarePackageConfig(config, {
      enabled: true,
      activeKitId: "starter-kit",
      autoGrantKitId: "starter-kit",
      kits: [{ id: "starter-kit", name: "Starter Kit", xp: 10, items: [] }],
      autoGrantRules: [{ id: "first-online-rule", enabled: true, kitId: "starter-kit", grantWhen: "first_online" }]
    });
    await runCarePackageAutoScan(config, [{
      actor_id: 101,
      account_id: "stable-account-1",
      character_name: "Test1",
      action_player_id: "Player#1",
      funcom_id: "Player#1",
      fls_id: "Player#1",
      online_status: "Online"
    }]);

    const grantsFile = resolve(config.generatedDir, "care-package-grants.jsonl");
    for (let index = 0; index < 600; index += 1) {
      appendFileSync(grantsFile, `${JSON.stringify({
        id: `skipped-${index}`,
        playerId: "Other#1",
        action_player_id: "Other#1",
        actor_id: "202",
        account_id: "stable-account-2",
        character_name: "Offline Player",
        source: "auto",
        version: "starter-kit",
        kitId: "starter-kit",
        kitName: "Starter Kit",
        status: "skipped",
        ok: true,
        reason: "Not currently online",
        startedAt: new Date(Date.now() + index).toISOString(),
        finishedAt: new Date(Date.now() + index).toISOString(),
        results: []
      })}\n`);
    }

    const repeat = await runCarePackageAutoScan(config, [{
      actor_id: 303,
      account_id: "stable-account-1",
      character_name: "Test1 Again",
      action_player_id: "Player#1",
      funcom_id: "Player#1",
      fls_id: "Player#1",
      online_status: "Online"
    }]);

    assert.equal(repeat.granted, 0);
    assert.equal(repeat.skipped, 1);
    assert.match(repeat.results[0].reason, /Already received first-online Care Package/);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("care package manual grant satisfies first-online claim after visible history is cleared", async () => {
  const config = tempConfig();
  try {
    saveCarePackageConfig(config, {
      enabled: true,
      activeKitId: "starter-kit",
      autoGrantKitId: "starter-kit",
      kits: [{ id: "starter-kit", name: "Starter Kit", xp: 10, items: [] }],
      autoGrantRules: [{ id: "first-online-rule", enabled: true, kitId: "starter-kit", grantWhen: "first_online" }]
    });

    const manual = await grantCarePackage(config, "Player#1", {
      confirmation: "GRANT CARE PACKAGE",
      kitId: "starter-kit",
      accountId: "account-1",
      funcomId: "Player#1",
      flsId: "Player#1",
      characterName: "Player",
      onlineStatus: "Online"
    });
    assert.equal(manual.status, "granted");

    const claimsFile = resolve(config.generatedDir, "care-package-first-online-claims.json");
    assert.equal(existsSync(claimsFile), true);
    const cleared = clearCarePackageHistory(config);
    assert.equal(cleared.firstOnlineClaimsPreserved, true);
    assert.deepEqual(carePackageHistory(config).rows, []);

    const repeat = await runCarePackageAutoScan(config, [{
      actor_id: 2,
      account_id: "account-1",
      funcom_id: "Player#1",
      fls_id: "Player#1",
      character_name: "Player Again",
      action_player_id: "Player#1",
      online_status: "Online"
    }]);
    assert.equal(repeat.granted, 0);
    assert.equal(repeat.skipped, 1);
    assert.match(repeat.results[0].reason, /Already received first-online Care Package/);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("care package first-online manual and auto overlap is blocked by pre-delivery claim", async () => {
  const config = tempConfig();
  config.mockMode = false;
  try {
    writeCatalog(config);
    saveCarePackageConfig(config, {
      enabled: true,
      activeKitId: "starter-kit",
      autoGrantKitId: "starter-kit",
      kits: [{
        id: "starter-kit",
        name: "Starter Kit",
        xp: 0,
        items: [{ itemName: "Arhun K-28 Lasgun", quantity: 1 }]
      }],
      autoGrantRules: [{ id: "first-online-rule", enabled: true, kitId: "starter-kit", grantWhen: "first_online" }]
    });

    let releaseGrant;
    const itemGrantStarted = new Promise((resolveStarted) => {
      const releaseWait = new Promise((resolveRelease) => { releaseGrant = resolveRelease; });
      config.dbGiveItemToPlayer = async (_actorId, item) => {
        resolveStarted();
        await releaseWait;
        return { ok: true, inserted: { template_id: item.templateId, stack_size: item.quantity, quality_level: item.quality } };
      };
    });

    const manualGrant = grantCarePackage(config, "Player#1", {
      confirmation: "GRANT CARE PACKAGE",
      kitId: "starter-kit",
      actorId: 1,
      accountId: "account-1",
      funcomId: "Player#1",
      flsId: "Player#1",
      characterName: "Player",
      onlineStatus: "Online"
    }, {
      db: {},
      dbGiveItemToPlayer: (...args) => config.dbGiveItemToPlayer(...args)
    });
    await itemGrantStarted;

    const auto = await runCarePackageAutoScan(config, [{
      actor_id: 2,
      account_id: "account-1",
      funcom_id: "Player#1",
      fls_id: "Player#1",
      character_name: "Player Again",
      action_player_id: "Player#1",
      online_status: "Online"
    }], "auto", {
      db: {},
      dbGiveItemToPlayer: async () => {
        throw new Error("auto path should not deliver package content");
      }
    });
    assert.equal(auto.granted, 0);
    assert.equal(auto.skipped, 1);
    assert.match(auto.results[0].reason, /Already received first-online Care Package/);

    releaseGrant();
    const manual = await manualGrant;
    assert.equal(manual.status, "granted");

    const claims = JSON.parse(readFileSync(resolve(config.generatedDir, "care-package-first-online-claims.json"), "utf8"));
    assert.ok(claims.players["account_id:account-1"]);
    assert.equal(claims.aliases["funcom_id:player#1"], "account_id:account-1");
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("care package first-online auto claim blocks overlapping manual starter delivery", async () => {
  const config = tempConfig();
  config.mockMode = false;
  try {
    writeCatalog(config);
    saveCarePackageConfig(config, {
      enabled: true,
      activeKitId: "starter-kit",
      autoGrantKitId: "starter-kit",
      kits: [{
        id: "starter-kit",
        name: "Starter Kit",
        xp: 0,
        items: [{ itemName: "Arhun K-28 Lasgun", quantity: 1 }]
      }],
      autoGrantRules: [{ id: "first-online-rule", enabled: true, kitId: "starter-kit", grantWhen: "first_online" }]
    });

    let releaseGrant;
    const itemGrantStarted = new Promise((resolveStarted) => {
      const releaseWait = new Promise((resolveRelease) => { releaseGrant = resolveRelease; });
      config.dbGiveItemToPlayer = async (_actorId, item) => {
        resolveStarted();
        await releaseWait;
        return { ok: true, inserted: { template_id: item.templateId, stack_size: item.quantity, quality_level: item.quality } };
      };
    });

    const autoGrant = runCarePackageAutoScan(config, [{
      actor_id: 1,
      account_id: "account-1",
      funcom_id: "Player#1",
      fls_id: "Player#1",
      character_name: "Player",
      action_player_id: "Player#1",
      online_status: "Online"
    }], "auto", {
      db: {},
      dbGiveItemToPlayer: (...args) => config.dbGiveItemToPlayer(...args)
    });
    await itemGrantStarted;

    const manual = await grantCarePackage(config, "Player#1", {
      confirmation: "GRANT CARE PACKAGE",
      kitId: "starter-kit",
      actorId: 2,
      accountId: "account-1",
      funcomId: "Player#1",
      flsId: "Player#1",
      characterName: "Player Again",
      onlineStatus: "Online"
    }, {
      db: {},
      dbGiveItemToPlayer: async () => {
        throw new Error("manual path should not deliver package content");
      }
    });
    assert.equal(manual.status, "skipped");
    assert.match(manual.reason, /Already received first-online Care Package/);

    releaseGrant();
    const auto = await autoGrant;
    assert.equal(auto.granted, 1);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("care package supports separate manual and auto-grant kit selection", async () => {
  const config = tempConfig();
  try {
    saveCarePackageConfig(config, {
      enabled: true,
      activeKitId: "manual-kit",
      autoGrantKitId: "auto-kit",
      autoGrantEnabled: true,
      kits: [
        { id: "manual-kit", name: "Manual Kit", xp: 10, items: [] },
        { id: "auto-kit", name: "Auto Kit", xp: 25, items: [] }
      ],
      autoGrantRules: [{ id: "auto-rule-1", enabled: true, kitId: "auto-kit", grantWhen: "first_online", lastSeenDays: 30 }]
    });
    const manual = await grantCarePackage(config, "Manual#1", { confirmation: "GRANT CARE PACKAGE", kitId: "manual-kit" });
    assert.equal(manual.kitName, "Manual Kit");
    assert.equal(manual.version, "manual-kit");
    const auto = await runCarePackageAutoScan(config, [{ actor_id: 1, character_name: "Auto", action_player_id: "Auto#1", online_status: "Online" }]);
    assert.equal(auto.granted, 1);
    assert.equal(auto.results[0].kitName, "Auto Kit");
    assert.equal(auto.results[0].version, "auto-kit");
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("care package grants schematics through the database item path", async () => {
  const config = tempConfig();
  try {
    writeCatalog(config);
    saveCarePackageConfig(config, {
      enabled: true,
      activeKitId: "schematic-kit",
      kits: [{ id: "schematic-kit", name: "Schematic Kit", xp: 0, items: [{ itemName: "Arhun K-28 Lasgun", quantity: 1, quality: 0 }] }]
    });
    const result = await grantCarePackage(config, "Player#1", {
      confirmation: "GRANT CARE PACKAGE",
      kitId: "schematic-kit",
      actorId: 101,
      characterName: "Test"
    }, { db: {}, dbGiveItemToPlayer: async (_actorId, item) => ({ ok: true, inserted: { template_id: item.templateId, quality_level: item.quality } }) });
    const itemGrant = result.results.find((row) => row.item?.itemId === "ChoamHeavyLasgunSchematic");
    assert.equal(itemGrant.operation, "dbGiveItemToPlayer");
    assert.equal(itemGrant.result.inserted.quality_level, 0);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("care package auto scan supports multiple enabled rules with different conditions", async () => {
  const config = tempConfig();
  try {
    saveCarePackageConfig(config, {
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
    const result = await runCarePackageAutoScan(config, [
      { actor_id: 1, character_name: "Online", action_player_id: "Online#1", online_status: "Online", last_seen: new Date().toISOString() },
      { actor_id: 2, character_name: "Offline", action_player_id: "Offline#1", online_status: "Offline", last_seen: "2026-01-01T00:00:00.000Z" }
    ]);
    assert.equal(result.results.filter((row) => row.status === "granted" && row.kitName === "Online Kit").length, 1);
    assert.equal(result.results.filter((row) => row.status === "granted" && row.kitName === "Detected Kit").length, 0);
    assert.equal(result.results.filter((row) => row.kitName === "Detected Kit" && row.reason === "Waiting for player to return online").length, 1);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("last seen auto scan grants when a qualified stale player returns online", async () => {
  const config = tempConfig();
  try {
    saveCarePackageConfig(config, {
      enabled: true,
      autoGrantEnabled: true,
      kits: [{ id: "back-again", name: "Back Again", xp: 25, items: [] }],
      activeKitId: "back-again",
      autoGrantKitId: "back-again",
      autoGrantRules: [{ id: "last-seen-rule", enabled: true, kitId: "back-again", grantWhen: "last_seen", lastSeenDays: 30 }]
    });
    const players = [{ actor_id: 2, character_name: "Offline", action_player_id: "Offline#1", online_status: "Offline", last_seen: "2026-01-01T00:00:00.000Z" }];
    const preview = carePackageEligiblePlayers(config, players, { ruleId: "last-seen-rule" });
    assert.equal(preview.rows[0].eligible, true);
    const scan = await runCarePackageAutoScan(config, players);
    assert.equal(scan.granted, 0);
    assert.equal(scan.skipped, 1);
    assert.equal(scan.results[0].reason, "Waiting for player to return online");
    const returned = await runCarePackageAutoScan(config, [
      { actor_id: 2, character_name: "Offline", action_player_id: "Offline#1", online_status: "Online", last_seen: new Date().toISOString() }
    ]);
    assert.equal(returned.granted, 1);
    assert.equal(returned.results[0].kitName, "Back Again");
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("last seen eligible-only preview removes players after they receive the package", async () => {
  const config = tempConfig();
  try {
    saveCarePackageConfig(config, {
      enabled: true,
      autoGrantEnabled: true,
      kits: [{ id: "back-again", name: "Back Again", xp: 25, items: [] }],
      activeKitId: "back-again",
      autoGrantKitId: "back-again",
      autoGrantRules: [{ id: "last-seen-rule", enabled: true, kitId: "back-again", grantWhen: "last_seen", lastSeenDays: 30 }]
    });
    await grantCarePackage(config, "Granted#1", {
      confirmation: "GRANT CARE PACKAGE",
      source: "auto",
      kitId: "back-again",
      actorId: 1,
      characterName: "Granted"
    });
    const preview = carePackageEligiblePlayers(config, [
      { actor_id: 1, character_name: "Granted", action_player_id: "Granted#1", online_status: "Offline", last_seen: "2026-01-01T00:00:00.000Z" },
      { actor_id: 2, character_name: "Waiting", action_player_id: "Waiting#1", online_status: "Offline", last_seen: "2026-01-01T00:00:00.000Z" }
    ], { ruleId: "last-seen-rule", onlyEligible: true });
    assert.deepEqual(preview.rows.map((row) => row.character_name), ["Waiting"]);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("care package grant all successes records granted status and summary", async () => {
  const config = tempConfig();
  try {
    writeCatalog(config);
    saveCarePackageConfig(config, { enabled: true, version: "care-package-v1", xp: 10, items: [{ itemName: "Plant Fiber", quantity: 2, durability: 1 }] });
    const result = await grantCarePackage(config, "RedBlink#75570", { confirmation: "GRANT CARE PACKAGE" });
    assert.equal(result.status, "granted");
    assert.equal(result.ok, true);
    assert.match(result.summary, /2 succeeded, 0 failed/);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("care package strips legacy grades and augments from package items", async () => {
  const config = tempConfig();
  config.mockMode = true;
  try {
    writeCatalog(config);
    const saved = saveCarePackageConfig(config, {
      enabled: true,
      activeKitId: "welcome-kit",
      kits: [{
        id: "welcome-kit",
        name: "Welcome",
        xp: 0,
        sendMessage: "",
        items: [{
          itemId: "SMG_Unique_LargeMag_06",
          itemName: "A Dart for Every Man",
          quantity: 1,
          quality: 5,
          augments: ["T6_Augment_Acuracy1"],
          augmentQuality: 5
        }]
      }]
    });
    assert.equal(saved.kits[0].items[0].quality, 0);
    assert.deepEqual(saved.kits[0].items[0].augments, []);
    assert.equal("augmentQuality" in saved.kits[0].items[0], false);

    const result = await grantCarePackage(config, "Dagnir#1", {
      confirmation: "GRANT CARE PACKAGE",
      source: "manual",
      kitId: "welcome-kit",
      actorId: 42,
      characterName: "Dagnir",
      onlineStatus: "Online"
    }, {
      db: {},
      dbGiveItemToPlayer: async () => {
        throw new Error("care package should not use the database path for stripped grade or augment input");
      }
    });
    assert.equal(result.status, "granted");
    const itemGrant = result.results.find((entry) => entry.operation === "adminGiveItemId");
    assert.ok(itemGrant);
    assert.equal(itemGrant.item.quality, 0);
    assert.deepEqual(itemGrant.item.augments, []);
    assert.doesNotMatch(result.summary, /Relog required/);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("care package send message is sent as a grant action", async () => {
  const config = tempConfig();
  try {
    saveCarePackageConfig(config, {
      enabled: true,
      version: "care-package-v1",
      xp: 10,
      items: [],
      kits: [{ id: "care-package-v1", name: "Care Package", xp: 10, items: [], sendMessage: "Welcome" }]
    });
    const db = fakePersonaDb();
    const result = await grantCarePackage(config, "RedBlink#75570", {
      confirmation: "GRANT CARE PACKAGE",
      characterName: "RedBlink",
      funcomId: "RedBlink#75570",
      flsId: "ABCDEF1234567890"
    }, { db });
    assert.equal(result.status, "granted");
    const whisper = result.results.find((row) => row.operation === "carePackageWelcomeWhisper");
    assert.equal(whisper?.ok, true);
    assert.equal(whisper?.senderName, "Server");
    assert.match(result.summary, /2 succeeded, 0 failed/);
    assert.equal(db.queries.some((query) => /insert into dune\."encrypted_accounts"/.test(query.text)), true);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("care package send message fails clearly without recipient identity", async () => {
  const config = tempConfig();
  try {
    saveCarePackageConfig(config, {
      enabled: true,
      version: "care-package-v1",
      xp: 10,
      items: [],
      kits: [{ id: "care-package-v1", name: "Care Package", xp: 10, items: [], sendMessage: "Welcome" }]
    });
    const result = await grantCarePackage(config, "12345", { confirmation: "GRANT CARE PACKAGE" }, { db: fakePersonaDb() });
    assert.equal(result.status, "partial_failed");
    assert.match(result.summary, /recipient Funcom ID is unavailable/);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("care package send message seeds the synthetic sender persona safely", async () => {
  const config = tempConfig();
  try {
    writeCatalog(config);
    saveCarePackageConfig(config, {
      enabled: true,
      version: "care-package-v1",
      xp: 0,
      items: [{ itemName: "Plant Fiber", quantity: 10, durability: 1 }],
      kits: [{ id: "care-package-v1", name: "Care Package", xp: 0, items: [{ itemName: "Plant Fiber", quantity: 10, durability: 1 }], sendMessage: "Welcome" }]
    });
    const db = fakePersonaDb({ failEncryptedPlayerStateConflict: true });
    const result = await grantCarePackage(config, "12345", {
      confirmation: "GRANT CARE PACKAGE",
      characterName: "Player",
      funcomId: "Player#1",
      flsId: "ABCDEF1234567890"
    }, { db });
    assert.equal(result.status, "granted");
    assert.equal(db.queries.some((query) => /update dune\."encrypted_player_state"/.test(query.text)), true);
    assert.equal(db.queries.some((query) => /insert into dune\."encrypted_player_state".*where not exists/s.test(query.text)), true);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("care package grant partial failures records partial_failed status and summary", async () => {
  const config = tempConfig();
  try {
    writeCatalog(config);
    saveCarePackageConfig(config, {
      enabled: true,
      version: "care-package-v1",
      xp: 10,
      items: [
        { itemName: "fiber", quantity: 10, durability: 1 },
        { itemName: "Cup of Water", quantity: 1, durability: 1 }
      ]
    });
    const result = await grantCarePackage(config, "RedBlink#75570", { confirmation: "GRANT CARE PACKAGE" });
    assert.equal(result.status, "partial_failed");
    assert.equal(result.ok, false);
    assert.match(result.summary, /2 succeeded, 1 failed/);
    assert.match(result.summary, /fiber x10 failed: No item found for: fiber/);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("care package auto scan does not repeat after package content was delivered in a partial grant", async () => {
  const config = tempConfig();
  try {
    writeCatalog(config);
    saveCarePackageConfig(config, {
      enabled: true,
      autoGrantEnabled: true,
      activeKitId: "welcome-kit",
      autoGrantKitId: "welcome-kit",
      kits: [{
        id: "welcome-kit",
        name: "Welcome Kit",
        xp: 0,
        sendMessage: "Welcome to our server!",
        items: [
          { itemName: "Plant Fiber", quantity: 1, durability: 1 },
          { itemName: "Missing Item", quantity: 1, durability: 1 }
        ]
      }],
      autoGrantRules: [{ id: "first-online-rule", enabled: true, kitId: "welcome-kit", grantWhen: "first_online" }]
    });
    const first = await grantCarePackage(config, "Player#1", {
      confirmation: "GRANT CARE PACKAGE",
      source: "auto",
      kitId: "welcome-kit",
      actorId: 1,
      accountId: "account-1",
      funcomId: "Player#1",
      flsId: "Player#1",
      characterName: "Player",
      onlineStatus: "Online"
    }, { db: fakePersonaDb() });
    assert.equal(first.status, "partial_failed");
    assert.equal(first.results.some((result) => result.ok && result.operation !== "carePackageWelcomeWhisper"), true);

    const repeat = await runCarePackageAutoScan(config, [{
      actor_id: 2,
      account_id: "account-1",
      funcom_id: "Player#1",
      fls_id: "Player#1",
      character_name: "Player Again",
      action_player_id: "Player#1",
      online_status: "Online"
    }], "auto", { db: fakePersonaDb() });
    assert.equal(repeat.granted, 0);
    assert.equal(repeat.skipped, 1);
    assert.match(repeat.results[0].reason, /Already received first-online Care Package/);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("care package grant all failures records failed status and no blank summary", async () => {
  const config = tempConfig();
  try {
    writeCatalog(config);
    saveCarePackageConfig(config, { enabled: true, version: "care-package-v1", xp: 0, items: [{ itemName: "fiber", quantity: 10, durability: 1 }] });
    const result = await grantCarePackage(config, "RedBlink#75570", { confirmation: "GRANT CARE PACKAGE" });
    assert.equal(result.status, "failed");
    assert.equal(result.ok, false);
    assert.match(result.summary, /0 succeeded, 1 failed/);
    assert.ok(result.summary.length > 0);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("care package bulk grant returns per-player granted skipped and failed rows", async () => {
  const config = tempConfig();
  try {
    saveCarePackageConfig(config, { enabled: true, version: "care-package-v1", xp: 10, items: [] });
    await grantCarePackage(config, "Existing#1", { confirmation: "GRANT CARE PACKAGE" });
    const result = await grantEligibleCarePackages(config, [
      { actor_id: 1, character_name: "Existing", action_player_id: "Existing#1", online_status: "Online" },
      { actor_id: 2, character_name: "Missing", action_player_id: "", online_status: "Online" },
      { actor_id: 3, character_name: "New", action_player_id: "New#1", online_status: "Online" }
    ], { confirmation: "GRANT CARE PACKAGE TO ELIGIBLE PLAYERS" });
    assert.equal(result.granted, 1);
    assert.equal(result.skipped, 2);
    assert.equal(result.failed, 0);
    assert.equal(result.results.find((row) => row.character_name === "New").playerId, "New#1");
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("care package history hides skipped rows and can be cleared", async () => {
  const config = tempConfig();
  try {
    saveCarePackageConfig(config, { enabled: true, version: "care-package-v1", xp: 10, items: [] });
    await grantCarePackage(config, "Existing#1", { confirmation: "GRANT CARE PACKAGE" });
    await grantEligibleCarePackages(config, [
      { actor_id: 1, character_name: "Existing", action_player_id: "Existing#1", online_status: "Online" },
      { actor_id: 2, character_name: "New", action_player_id: "New#1", online_status: "Online" }
    ], { confirmation: "GRANT CARE PACKAGE TO ELIGIBLE PLAYERS" });
    const visibleHistory = carePackageHistory(config).rows;
    assert.equal(visibleHistory.some((row) => row.status === "skipped"), false);
    assert.equal(visibleHistory.some((row) => row.character_name === "New"), true);
    const cleared = clearCarePackageHistory(config);
    assert.equal(cleared.ok, true);
    assert.deepEqual(carePackageHistory(config).rows, []);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("care package auto scan only grants when enabled and players have action ids", async () => {
  const config = tempConfig();
  try {
    saveCarePackageConfig(config, { enabled: false, version: "care-package-v1", xp: 10, items: [], autoGrantEnabled: true });
    assert.equal((await runCarePackageAutoScan(config, [{ actor_id: 1, action_player_id: "A#1" }])).skipped, true);
    saveCarePackageConfig(config, { enabled: true, version: "care-package-v1", xp: 10, items: [], autoGrantRules: [{ id: "auto-rule-1", enabled: false, kitId: "care-package-v1", grantWhen: "first_online", lastSeenDays: 30 }] });
    assert.equal((await runCarePackageAutoScan(config, [{ actor_id: 1, action_player_id: "A#1" }])).skipped, true);
    saveCarePackageConfig(config, { enabled: true, version: "care-package-v1", xp: 10, items: [], autoGrantEnabled: false, autoGrantRules: [{ id: "auto-rule-1", enabled: true, kitId: "care-package-v1", grantWhen: "first_online", lastSeenDays: 30 }] });
    const result = await runCarePackageAutoScan(config, [
      { actor_id: 1, character_name: "A", action_player_id: "A#1", online_status: "Online" },
      { actor_id: 2, character_name: "B", action_player_id: "", online_status: "Online" }
    ]);
    assert.equal(result.granted, 1);
    const duplicate = await runCarePackageAutoScan(config, [{ actor_id: 1, character_name: "A", action_player_id: "A#1", online_status: "Online" }]);
    assert.equal(duplicate.granted, 0);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("care package auto scan uses enabled rules even when legacy global flag is off", async () => {
  const config = tempConfig();
  try {
    saveCarePackageConfig(config, {
      enabled: true,
      autoGrantEnabled: false,
      activeKitId: "first-online-kit",
      autoGrantKitId: "first-online-kit",
      kits: [{ id: "first-online-kit", name: "First Online Kit", xp: 10, items: [] }],
      autoGrantRules: [{ id: "first-online-rule", enabled: true, kitId: "first-online-kit", grantWhen: "first_online", lastSeenDays: 30 }]
    });
    const saved = carePackageConfig(config);
    assert.equal(saved.autoGrantEnabled, true);
    const result = await runCarePackageAutoScan(config, [
      { actor_id: 1, character_name: "New", action_player_id: "New#1", online_status: "Online" }
    ]);
    assert.equal(result.granted, 1);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

function tempConfig() {
  const repoRoot = mkdtempSync(join(tmpdir(), "care-package-test-"));
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
    { id: "CupWater_1", name: "Cup of Water", category: "consumables" },
    { id: "SMG_Unique_LargeMag_06", name: "A Dart for Every Man", category: "weapons" },
    { id: "ChoamHeavyLasgunSchematic", name: "Arhun K-28 Lasgun", category: "schematics", source: "Schematics" }
  ]));
}

function fakePersonaDb(options = {}) {
  const columns = {
    accounts: ["id", "user", "funcom_id"],
    encrypted_accounts: ["id", "user", "encrypted_funcom_id", "takeoverable"],
    player_state: ["account_id", "character_name"],
    encrypted_player_state: ["account_id", "encrypted_character_name", "online_status"]
  };
  const tableTypes = {
    accounts: "VIEW",
    encrypted_accounts: "BASE TABLE",
    player_state: "VIEW",
    encrypted_player_state: "BASE TABLE"
  };
  let failedEncryptedPlayerStateConflict = false;
  return {
    queries: [],
    async query(text, params = []) {
      this.queries.push({ text, params });
      if (/information_schema\.columns/.test(text)) {
        return { rows: (columns[params[0]] || []).map((column_name) => ({ column_name })) };
      }
      if (/information_schema\.tables/.test(text)) {
        return { rows: tableTypes[params[0]] ? [{ table_type: tableTypes[params[0]] }] : [] };
      }
      if (/from dune\.accounts/.test(text)) {
        return { rows: [{ hex_fls_id: "A5C0DE5E12A00001", funcom_id: "Server#0001" }] };
      }
      if (
        options.failEncryptedPlayerStateConflict
        && !failedEncryptedPlayerStateConflict
        && /insert into dune\."encrypted_player_state"/.test(text)
        && /on conflict \("account_id"\)/.test(text)
      ) {
        failedEncryptedPlayerStateConflict = true;
        throw new Error("there is no unique or exclusion constraint matching the ON CONFLICT specification");
      }
      return { rows: [], rowCount: 1 };
    }
  };
}
