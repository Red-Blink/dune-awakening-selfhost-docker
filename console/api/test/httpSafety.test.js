import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { createConnectionLimiter, readJsonBody, safeStaticTarget } from "../src/httpSafety.js";

test("readJsonBody enforces request size limits", async () => {
  assert.deepEqual(await readJsonBody(Readable.from(["{\"ok\":true}"]), 100), { ok: true });
  await assert.rejects(() => readJsonBody(Readable.from(["{\"too\":\"large\"}"]), 5), /exceeds 5 bytes/);
});

test("connection limiter caps and releases active streams", () => {
  const limiter = createConnectionLimiter(2);
  const first = limiter.enter();
  const second = limiter.enter();
  assert.equal(typeof first, "function");
  assert.equal(typeof second, "function");
  assert.equal(limiter.activeCount(), 2);
  assert.equal(limiter.enter(), null);

  first();
  first();
  assert.equal(limiter.activeCount(), 1);
  const third = limiter.enter();
  assert.equal(typeof third, "function");
  assert.equal(limiter.activeCount(), 2);
});

test("safeStaticTarget prevents serving files outside static directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-static-"));
  try {
    writeFileSync(resolve(dir, "index.html"), "index");
    writeFileSync(resolve(dir, "app.js"), "app");
    assert.equal(safeStaticTarget(dir, "/app.js"), resolve(dir, "app.js"));
    assert.equal(safeStaticTarget(dir, "/../../README.md"), resolve(dir, "index.html"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
