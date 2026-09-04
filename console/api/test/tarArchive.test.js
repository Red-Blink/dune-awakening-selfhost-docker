import test from "node:test";
import assert from "node:assert/strict";
import { createTarArchive, createTarHeader, tarPadding, TAR_TRAILER_BYTES } from "../src/services/backups.js";

// Two writers share createTarHeader: createTarArchive, which buffers a whole
// archive for the database download, and the system backup download, which
// streams. Header guarantees are therefore asserted against createTarHeader
// itself rather than through either caller -- otherwise a caller that stopped
// delegating would take the coverage with it and the other path would lose a
// guarantee nothing tests.

function readField(block, offset, length) {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
}

test("the header declares the POSIX ustar magic and version", () => {
  const header = createTarHeader("a.txt", 2);
  assert.equal(header.subarray(257, 263).toString("binary"), "ustar\u0000");
  // writeTarString reserves a trailing NUL, which truncated this fixed 2-byte
  // field to "0". The ustar version is exactly "00", with no terminator.
  assert.equal(header.subarray(263, 265).toString("binary"), "00");
});

test("the header is exactly one block and records the content size", () => {
  const header = createTarHeader("a.txt", 1234);
  assert.equal(header.length, 512);
  assert.equal(parseInt(readField(header, 124, 12).trim(), 8), 1234);
});

test("the header checksum is the one a reader recomputes", () => {
  // Real tar rejects a header whose checksum does not match, so this is a
  // correctness property, not a formality. Recomputed the way readers do it:
  // the checksum field itself counted as spaces.
  const header = createTarHeader("a.txt", 2);
  const declared = parseInt(readField(header, 148, 8).trim(), 8);
  const recomputed = Buffer.from(header).fill(32, 148, 156).reduce((sum, byte) => sum + byte, 0);
  assert.equal(declared, recomputed);
});

test("a short path stays in the name field, leaving the prefix empty", () => {
  const header = createTarHeader("runtime/generated/a.json", 2);
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

  const header = createTarHeader(path, 2);
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
  assert.throws(() => createTarHeader(`a/${"x".repeat(200)}`, 2), /too long for a tar archive/);
});

test("padding rounds each member up to a block boundary", () => {
  assert.equal(tarPadding(0), 0);
  assert.equal(tarPadding(512), 0);
  assert.equal(tarPadding(1), 511);
  assert.equal(tarPadding(513), 511);
});

test("createTarArchive lays out header, content, padding and trailer", () => {
  // The buffered writer's own concern: that it assembles the pieces in the
  // right order and sizes. The pieces themselves are asserted above.
  const content = Buffer.from("hi");
  const archive = createTarArchive([{ name: "a.txt", content }]);
  assert.equal(archive.length, 512 + 512 + TAR_TRAILER_BYTES);
  assert.equal(archive.subarray(512, 514).toString(), "hi");
  assert.ok(archive.subarray(514, 1024).every((byte) => byte === 0));
  assert.ok(archive.subarray(1024).every((byte) => byte === 0));
});
