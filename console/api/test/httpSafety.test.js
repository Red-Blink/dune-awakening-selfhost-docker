import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { readJsonBody, readMultipartForm, safeStaticTarget } from "../src/httpSafety.js";

test("readJsonBody enforces request size limits", async () => {
  assert.deepEqual(await readJsonBody(Readable.from(["{\"ok\":true}"]), 100), { ok: true });
  await assert.rejects(() => readJsonBody(Readable.from(["{\"too\":\"large\"}"]), 5), /exceeds 5 bytes/);
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

// ── multipart form tests ──

function multipartBody(boundary, parts) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(`--${boundary}\r\n`);
    for (const [header, value] of Object.entries(part.headers)) {
      chunks.push(`${header}: ${value}\r\n`);
    }
    chunks.push("\r\n");
    chunks.push(part.body);
    chunks.push("\r\n");
  }
  chunks.push(`--${boundary}--\r\n`);
  return Buffer.from(chunks.join(""), "utf8");
}

test("readMultipartForm parses single file upload", async () => {
  const boundary = "abc123";
  const content = JSON.stringify({ instances: [{ building_type: "Test", x: 0, y: 0, z: 0, rotation: 0 }] });
  const body = multipartBody(boundary, [{
    headers: { "Content-Disposition": 'form-data; name="file"; filename="test.json"' },
    body: content
  }]);
  const req = Readable.from([body]);
  req.headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
  const result = await readMultipartForm(req, 10 << 20);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].fieldName, "file");
  assert.equal(result.files[0].fileName, "test.json");
  assert.equal(result.files[0].content.toString("utf8"), content);
});

test("readMultipartForm parses form fields and files together", async () => {
  const boundary = "xyz789";
  const content = JSON.stringify({ name: "test" });
  const body = multipartBody(boundary, [
    { headers: { "Content-Disposition": 'form-data; name="player_id"' }, body: "42" },
    { headers: { "Content-Disposition": 'form-data; name="file"; filename="bp.json"' }, body: content }
  ]);
  const req = Readable.from([body]);
  req.headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
  const result = await readMultipartForm(req, 10 << 20);
  assert.equal(result.fields.player_id, "42");
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].fileName, "bp.json");
});

test("readMultipartForm handles multiple files", async () => {
  const boundary = "multi1";
  const body = multipartBody(boundary, [
    { headers: { "Content-Disposition": 'form-data; name="file"; filename="a.json"' }, body: "{}" },
    { headers: { "Content-Disposition": 'form-data; name="file"; filename="b.json"' }, body: "{}" }
  ]);
  const req = Readable.from([body]);
  req.headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
  const result = await readMultipartForm(req, 10 << 20);
  assert.equal(result.files.length, 2);
  assert.equal(result.files[0].fileName, "a.json");
  assert.equal(result.files[1].fileName, "b.json");
});

test("readMultipartForm returns empty fields/files for empty body", async () => {
  const boundary = "empty1";
  const body = Buffer.from(`--${boundary}--\r\n`, "utf8");
  const req = Readable.from([body]);
  req.headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
  const result = await readMultipartForm(req, 10 << 20);
  assert.deepEqual(result.fields, {});
  assert.deepEqual(result.files, []);
});

test("readMultipartForm rejects missing boundary", async () => {
  const req = Readable.from([Buffer.from("data")]);
  req.headers = { "content-type": "multipart/form-data" };
  await assert.rejects(
    () => readMultipartForm(req, 100),
    /multipart\/form-data upload/
  );
});

test("readMultipartForm rejects quoted boundary", async () => {
  const boundary = "qwerty";
  const content = JSON.stringify({ test: true });
  const body = multipartBody(boundary, [
    { headers: { "Content-Disposition": 'form-data; name="file"; filename="q.json"' }, body: content }
  ]);
  const req = Readable.from([body]);
  req.headers = { "content-type": `multipart/form-data; boundary="${boundary}"` };
  const result = await readMultipartForm(req, 10 << 20);
  assert.equal(result.files.length, 1);
});

test("readMultipartForm enforces size limit on upload", async () => {
  const boundary = "bigfile";
  const largeContent = "x".repeat(5000);
  const body = multipartBody(boundary, [
    { headers: { "Content-Disposition": 'form-data; name="file"; filename="big.json"' }, body: largeContent }
  ]);
  const req = Readable.from([body]);
  req.headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
  await assert.rejects(
    () => readMultipartForm(req, 100),
    /exceeds \d+ bytes/
  );
});

test("readMultipartForm handles binary file content", async () => {
  const boundary = "bin123";
  const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD]);
  const chunks = [];
  chunks.push(Buffer.from(`--${boundary}\r\n`, "utf8"));
  chunks.push(Buffer.from('Content-Disposition: form-data; name="file"; filename="bin.dat"\r\n\r\n', "utf8"));
  chunks.push(binaryContent);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
  const body = Buffer.concat(chunks);
  const req = Readable.from([body]);
  req.headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
  const result = await readMultipartForm(req, 10 << 20);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].fileName, "bin.dat");
  assert.deepEqual(result.files[0].content, binaryContent);
});

test("readMultipartForm handles field names with special characters", async () => {
  const boundary = "spec1";
  const body = multipartBody(boundary, [
    { headers: { "Content-Disposition": 'form-data; name="user[profile][id]"' }, body: "99" }
  ]);
  const req = Readable.from([body]);
  req.headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
  const result = await readMultipartForm(req, 10 << 20);
  assert.equal(result.fields["user[profile][id]"], "99");
});

test("readMultipartForm ignores parts without content-disposition", async () => {
  const boundary = "nodisp";
  const chunks = [];
  chunks.push(Buffer.from(`--${boundary}\r\n`, "utf8"));
  chunks.push(Buffer.from("X-Custom: value\r\n\r\n", "utf8"));
  chunks.push(Buffer.from("ignored content", "utf8"));
  chunks.push(Buffer.from(`\r\n--${boundary}\r\n`, "utf8"));
  chunks.push(Buffer.from('Content-Disposition: form-data; name="valid"\r\n\r\n', "utf8"));
  chunks.push(Buffer.from("42", "utf8"));
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
  const req = Readable.from([Buffer.concat(chunks)]);
  req.headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
  const result = await readMultipartForm(req, 10 << 20);
  assert.equal(result.fields.valid, "42");
  assert.deepEqual(result.files, []);
});

test("readMultipartForm handles large field value", async () => {
  const boundary = "largef";
  const largeValue = "a".repeat(10000);
  const body = multipartBody(boundary, [
    { headers: { "Content-Disposition": 'form-data; name="big_field"' }, body: largeValue }
  ]);
  const req = Readable.from([body]);
  req.headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
  const result = await readMultipartForm(req, 1 << 20);
  assert.equal(result.fields.big_field, largeValue);
});

test("readJsonBody returns empty object for empty body", async () => {
  assert.deepEqual(await readJsonBody(Readable.from([]), 1024), {});
  assert.deepEqual(await readJsonBody(Readable.from([""]), 1024), {});
});

test("readJsonBody returns empty object for whitespace-only body", async () => {
  assert.deepEqual(await readJsonBody(Readable.from(["  \n\t  "]), 1024), {});
});

test("safeStaticTarget falls back to index.html for missing files", () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-static2-"));
  try {
    writeFileSync(resolve(dir, "index.html"), "fallback");
    assert.equal(safeStaticTarget(dir, "/nonexistent.js"), resolve(dir, "index.html"));
    assert.equal(safeStaticTarget(dir, "/"), resolve(dir, "index.html"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("safeStaticTarget path traversal with encoded sequences", () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-static3-"));
  try {
    writeFileSync(resolve(dir, "index.html"), "safe");
    assert.equal(safeStaticTarget(dir, "/..%2F..%2Fetc/passwd"), resolve(dir, "index.html"));
    assert.equal(safeStaticTarget(dir, "/%2e%2e/%2e%2e/etc/passwd"), resolve(dir, "index.html"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression guard: "/." resolves to the static root itself, a directory,
// not a file. The containment check alone reads that as "contained" (it is
// dist, after all), so without also requiring a real file the function
// returned the raw directory path -- which serveStatic's
// createReadStream().pipe() would throw an unhandled EISDIR on.
test("safeStaticTarget falls back to index.html rather than returning a directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-static4-"));
  try {
    writeFileSync(resolve(dir, "index.html"), "safe");
    mkdirSync(resolve(dir, "assets"));
    assert.equal(safeStaticTarget(dir, "/."), resolve(dir, "index.html"));
    assert.equal(safeStaticTarget(dir, "/assets"), resolve(dir, "index.html"));
    assert.equal(safeStaticTarget(dir, "/assets/"), resolve(dir, "index.html"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a body of literal null does not become a TypeError at the call site", async () => {
  // readJsonBody returned JSON.parse(text) raw, so `null` reached ~82 routes
  // that all do `body.someField` -- a TypeError surfacing as a 500 from an
  // authenticated route instead of a 400.
  const parsed = await readJsonBody(Readable.from(["null"]), 1024);
  assert.deepEqual(parsed, {});
  assert.doesNotThrow(() => parsed.anyField);

  // Everything else still reaches each route's own validation unchanged --
  // property access on these yields undefined rather than throwing.
  assert.equal(await readJsonBody(Readable.from(["5"]), 1024), 5);
  assert.equal(await readJsonBody(Readable.from(['"x"']), 1024), "x");
  assert.deepEqual(await readJsonBody(Readable.from(["[]"]), 1024), []);
  assert.deepEqual(await readJsonBody(Readable.from(['{"a":1}']), 1024), { a: 1 });
});
