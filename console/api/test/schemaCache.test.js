import test from "node:test";
import assert from "node:assert/strict";
import { createSchemaCache, isDdlStatement, parseSchemaCacheTtl } from "../src/db.js";
import { tableExists, columnsFor } from "../src/duneDb.js";

function fakeDb(cache, answers) {
  const calls = [];
  return {
    calls,
    schemaCache: cache,
    async query(text, values) {
      calls.push(text);
      if (text.includes("to_regclass")) return { rows: [{ exists: answers.exists }] };
      return { rows: answers.columns.map((column_name) => ({ column_name })) };
    }
  };
}

test("tableExists and columnsFor hit the database once within the TTL", async () => {
  const db = fakeDb(createSchemaCache(), { exists: true, columns: ["id", "name"] });
  assert.equal(await tableExists(db, "actors"), true);
  assert.equal(await tableExists(db, "actors"), true);
  assert.deepEqual([...(await columnsFor(db, "actors"))], ["id", "name"]);
  assert.deepEqual([...(await columnsFor(db, "actors"))], ["id", "name"]);
  assert.equal(db.calls.length, 2);
});

test("a DDL statement invalidates cached lookups", async () => {
  const cache = createSchemaCache();
  const answers = { exists: false, columns: [] };
  const db = fakeDb(cache, answers);
  assert.equal(await tableExists(db, "addon_t"), false);
  answers.exists = true;
  cache.noteStatement("create table dune.addon_t (id int)");
  assert.equal(await tableExists(db, "addon_t"), true);
});

test("negative results expire after the short TTL", async () => {
  let clock = 0;
  const cache = createSchemaCache({ now: () => clock });
  const answers = { exists: false, columns: [] };
  const db = fakeDb(cache, answers);
  assert.equal(await tableExists(db, "later"), false);
  answers.exists = true;
  clock = 4000;
  assert.equal(await tableExists(db, "later"), false);
  clock = 5001;
  assert.equal(await tableExists(db, "later"), true);
});

test("the cache is bypassed while a restore is in progress and when disabled", async () => {
  let paused = true;
  const cache = createSchemaCache({ isPaused: () => paused });
  cache.refresh();
  const db = fakeDb(cache, { exists: true, columns: [] });
  await tableExists(db, "x");
  await tableExists(db, "x");
  assert.equal(db.calls.length, 2);
  paused = false;
  const off = fakeDb(createSchemaCache({ ttlMs: 0 }), { exists: true, columns: [] });
  await tableExists(off, "x");
  await tableExists(off, "x");
  assert.equal(off.calls.length, 2);
});

test("a lookup that overlaps a DDL statement is not stored", async () => {
  const cache = createSchemaCache();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const first = cache.get("k", async () => { calls += 1; await gate; return "old"; });
  cache.noteStatement("alter table dune.x add column y int");
  release();
  assert.equal(await first, "old");
  assert.equal(await cache.get("k", async () => { calls += 1; return "new"; }), "new");
  assert.equal(calls, 2);
});

test("a restore that ends between two lookups still drops the old schema", async () => {
  let paused = false;
  const cache = createSchemaCache({ isPaused: () => paused });
  const answers = { exists: true, columns: [] };
  const db = fakeDb(cache, answers);
  assert.equal(await tableExists(db, "t"), true);
  paused = true;
  cache.refresh();
  paused = false;
  answers.exists = false;
  cache.refresh();
  assert.equal(await tableExists(db, "t"), false);
  assert.equal(db.calls.length, 2);
});

test("the restore watcher refresh clears entries even if nothing queried meanwhile", async () => {
  let paused = false;
  const cache = createSchemaCache({ isPaused: () => paused });
  const db = fakeDb(cache, { exists: true, columns: [] });
  await tableExists(db, "t");
  paused = true;
  cache.refresh();
  paused = false;
  await tableExists(db, "t");
  assert.equal(db.calls.length, 2);
});

test("isDdlStatement recognises DDL text and query config objects", () => {
  assert.equal(isDdlStatement("create table x (id int)"), true);
  assert.equal(isDdlStatement({ text: "ALTER TABLE x ADD y int" }), true);
  assert.equal(isDdlStatement("select * from dune.actors"), false);
});

test("parseSchemaCacheTtl falls back to the default for empty or invalid values", () => {
  assert.equal(parseSchemaCacheTtl(undefined), 60000);
  assert.equal(parseSchemaCacheTtl(""), 60000);
  assert.equal(parseSchemaCacheTtl("abc"), 60000);
  assert.equal(parseSchemaCacheTtl("-5"), 60000);
  assert.equal(parseSchemaCacheTtl("0"), 0);
  assert.equal(parseSchemaCacheTtl("15000"), 15000);
});

test("createDb exposes a schema cache that a restore maintenance flag bypasses", async () => {
  const { createDb } = await import("../src/db.js");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const repoRoot = mkdtempSync(join(tmpdir(), "schema-cache-db-"));
  const db = createDb({ repoRoot });
  try {
    assert.equal(db.schemaCache.enabled, true);
    const flag = join(repoRoot, "runtime/generated/db-restore-maintenance");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(repoRoot, "runtime/generated"), { recursive: true });
    writeFileSync(flag, "1");
    await assert.rejects(db.query("select 1"), /restore is in progress/);
    let loads = 0;
    await db.schemaCache.get("k", async () => ++loads);
    await db.schemaCache.get("k", async () => ++loads);
    assert.equal(loads, 2);
  } finally {
    await db.close();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
