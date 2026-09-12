import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteAddonData, listAddonData, readAddonData, writeAddonData } from "../src/addonDataStore.js";

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-addon-data-"));
  return { repoRoot, config: { repoRoot }, cleanup: () => rmSync(repoRoot, { recursive: true, force: true }) };
}

test("stores addon-scoped JSON atomically and lists metadata", async () => {
  const f = fixture();
  try {
    const created = await writeAddonData(f.config, "battle-pass", { key: "season.active", value: { id: "s1" }, expectedVersion: null }, { now: () => new Date("2026-09-11T10:00:00Z") });
    assert.equal(created.version, 1);
    assert.deepEqual(readAddonData(f.config, "battle-pass", "season.active").value, { id: "s1" });
    assert.deepEqual(listAddonData(f.config, "battle-pass", { prefix: "season." }).entries, [{ key: "season.active", version: 1, updatedAt: "2026-09-11T10:00:00.000Z" }]);
    const mode = readFileSync(join(f.repoRoot, "runtime/addons/data/battle-pass/store.json"), "utf8");
    assert.match(mode, /"season.active"/);
  } finally {
    f.cleanup();
  }
});

test("uses compare-and-swap versions and serializes concurrent writes", async () => {
  const f = fixture();
  try {
    await writeAddonData(f.config, "battle-pass", { key: "player.1", value: 1 });
    const outcomes = await Promise.allSettled([
      writeAddonData(f.config, "battle-pass", { key: "player.1", value: 2, expectedVersion: 1 }),
      writeAddonData(f.config, "battle-pass", { key: "player.1", value: 3, expectedVersion: 1 })
    ]);
    assert.equal(outcomes.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((entry) => entry.status === "rejected").length, 1);
    assert.equal(readAddonData(f.config, "battle-pass", "player.1").version, 2);
  } finally {
    f.cleanup();
  }
});

test("deletes only the requested addon key", async () => {
  const f = fixture();
  try {
    await writeAddonData(f.config, "battle-pass", { key: "one", value: 1 });
    await writeAddonData(f.config, "battle-pass", { key: "two", value: 2 });
    assert.deepEqual(await deleteAddonData(f.config, "battle-pass", { key: "one", expectedVersion: 1 }), { ok: true, deleted: true, key: "one" });
    assert.equal(readAddonData(f.config, "battle-pass", "one").found, false);
    assert.equal(readAddonData(f.config, "battle-pass", "two").found, true);
  } finally {
    f.cleanup();
  }
});

test("rejects unsafe keys, oversized values, and corrupt state", async () => {
  const f = fixture();
  try {
    await assert.rejects(() => writeAddonData(f.config, "battle-pass", { key: "../escape", value: 1 }), /key/);
    await assert.rejects(() => writeAddonData(f.config, "battle-pass", { key: "large", value: "x".repeat(300000) }), /exceed/);
    const path = join(f.repoRoot, "runtime/addons/data/battle-pass/store.json");
    mkdirSync(join(f.repoRoot, "runtime/addons/data/battle-pass"), { recursive: true });
    writeFileSync(path, "not-json");
    assert.throws(() => readAddonData(f.config, "battle-pass", "safe"), /unreadable/);
  } finally {
    f.cleanup();
  }
});
