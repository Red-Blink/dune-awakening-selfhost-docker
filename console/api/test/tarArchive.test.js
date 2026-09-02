import test from "node:test";
import assert from "node:assert/strict";
import { createTarArchive } from "../src/services/backups.js";

// createTarArchive backs the backup download. These cases used to live in
// configBundle.test.js, which was deleted with the plaintext migration bundle;
// the writer itself is still live, so the coverage moved here rather than going
// with it.

function readField(header, offset, length) {
  const raw = header.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
}

test("the header declares the POSIX ustar magic and version", () => {
  const header = createTarArchive([{ name: "a.txt", content: Buffer.from("hi") }]);
  assert.equal(header.subarray(257, 263).toString("binary"), "ustar\u0000");
  // writeTarString reserves a trailing NUL, which truncated this fixed 2-byte
  // field to "0". The ustar version is exactly "00", with no terminator.
  assert.equal(header.subarray(263, 265).toString("binary"), "00");
});

test("a short path stays in the name field, leaving the prefix empty", () => {
  const header = createTarArchive([{ name: "runtime/generated/a.json", content: Buffer.from("{}") }]);
  assert.equal(readField(header, 0, 100), "runtime/generated/a.json");
  assert.equal(readField(header, 345, 155), "");
});

test("a path over 99 bytes splits across the prefix field instead of truncating", () => {
  // The name field is 100 bytes with a reserved NUL, so this 164-byte path can
  // only survive as prefix + "/" + name. It used to be silently cut at 99,
  // producing an entry pointing at a different file.
  const dir = "d".repeat(60);
  const file = `${"f".repeat(80)}.json`;
  const path = `runtime/generated/${dir}/${file}`;
  assert.ok(Buffer.byteLength(path) > 99);

  const header = createTarArchive([{ name: path, content: Buffer.from("{}") }]);
  const name = readField(header, 0, 100);
  const prefix = readField(header, 345, 155);

  assert.equal(name, file);
  assert.equal(prefix, `runtime/generated/${dir}`);
  // What a reader reconstructs must be the path we asked for.
  assert.equal(`${prefix}/${name}`, path);
});

test("a path that cannot be split is refused rather than written wrong", () => {
  // No split point leaves a name under 100 bytes, so there is no correct entry
  // to write. Throwing beats emitting a corrupt archive.
  assert.throws(
    () => createTarArchive([{ name: `a/${"x".repeat(200)}`, content: Buffer.from("hi") }]),
    /too long for a tar archive/
  );
});
