import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, utimesSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listQueuedBaseDeletes, queueBaseDelete } from "../src/duneDb.js";

test("atomic replacement invalidates the cache even with identical size and mtime", t => {
  const root = mkdtempSync(join(tmpdir(), "dune-queue-replace-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "runtime/generated");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "pending-base-deletes.json");
  const fixed = new Date("2026-01-01T00:00:00Z");
  writeFileSync(file, '[{"baseId":123}]');
  utimesSync(file, fixed, fixed);
  const original = statSync(file);
  assert.equal(listQueuedBaseDeletes(root)[0].baseId, 123);
  writeFileSync(`${file}.replacement`, '[{"baseId":456}]');
  utimesSync(`${file}.replacement`, fixed, fixed);
  renameSync(`${file}.replacement`, file);
  assert.equal(statSync(file).mtimeMs, original.mtimeMs);
  assert.equal(statSync(file).size, original.size);
  assert.equal(listQueuedBaseDeletes(root)[0].baseId, 456);
});

test("rapid same-size queue updates always invalidate cached JSON", t => {
  const root = mkdtempSync(join(tmpdir(), "dune-queue-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (let i = 1; i <= 40; i++) {
    queueBaseDelete(root, { baseId: i });
    assert.equal(listQueuedBaseDeletes(root).length, i);
  }
  for (let i = 1; i <= 40; i++) {
    queueBaseDelete(root, { baseId: i });
    assert.equal(listQueuedBaseDeletes(root).at(-1).baseId, i);
  }
});
