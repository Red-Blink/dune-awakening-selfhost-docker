import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  looksLikeTar,
  mintSystemBackupName,
  normalizeImportedSystemMetadata,
  readEncryptedArchiveHeader,
  readTarMemberIndex,
  synthesizeSystemMetadata
} from "../src/services/systemBackupImport.js";
import { createTarArchive } from "../src/services/backups.js";
import { validSystemArchiveName } from "../src/services/systemBackups.js";

// The first six bytes gpg 2.4.7 actually writes for db.sh's flag set, measured
// against real backup_system output rather than taken from the spec:
// old-format CTB tag 3, SKESK v5, cipher 9 (AES256), aead 2 (OCB), s2k 3.
const AEAD_HEAD = Buffer.from([0x8c, 0x4d, 0x05, 0x09, 0x02, 0x03]);
// The same command without --force-aead: SKESK v4, no aead byte.
const CFB_HEAD = Buffer.from([0x8c, 0x0d, 0x04, 0x09, 0x03, 0x0a]);

test("a real AEAD archive header is accepted and names its own cipher", () => {
  const result = readEncryptedArchiveHeader(AEAD_HEAD);
  assert.equal(result.ok, true);
  // Read from the archive rather than copied from the writer's template, so a
  // synthesized sidecar can state it without having the passphrase.
  assert.equal(result.encryption, "aes-256-ocb-gpg-aead");
});

test("an unauthenticated archive is refused", () => {
  // db.sh chose AEAD so a tampered archive is rejected instead of decrypting to
  // garbage; backup_system cannot produce a v4 archive, so one arriving here
  // came from somewhere else.
  const result = readEncryptedArchiveHeader(CFB_HEAD);
  assert.equal(result.ok, false);
  assert.match(result.reason, /not authenticated/i);
});

test("files that are not OpenPGP messages are refused with a reason", () => {
  for (const [label, head] of [
    ["zip", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x6a, 0x75])],
    ["gzip", Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00])],
    ["html", Buffer.from("<!DOCT", "binary")],
    ["random", Buffer.from([0x05, 0x49, 0xee, 0xc4, 0xde, 0xb6])]
  ]) {
    const result = readEncryptedArchiveHeader(head);
    assert.equal(result.ok, false, `${label} should be refused`);
    assert.match(result.reason, /not an OpenPGP message/i);
  }
});

test("an empty or truncated head is refused rather than read past", () => {
  assert.equal(readEncryptedArchiveHeader(Buffer.alloc(0)).ok, false);
  assert.equal(readEncryptedArchiveHeader(Buffer.from([0x8c])).ok, false);
});

test("a future SKESK version is still accepted", () => {
  // Accepting version >= 5 with any non-zero aead keeps a v6 packet working
  // rather than pinning the exact bytes gpg 2.4 writes today.
  const v6 = Buffer.from([0x8c, 0x4d, 0x06, 0x09, 0x02, 0x03]);
  assert.equal(readEncryptedArchiveHeader(v6).ok, true);
});

test("a tar is told apart from a bare archive", () => {
  const tar = createTarArchive([{ name: "a.enc", content: Buffer.from("x") }]);
  assert.equal(looksLikeTar(tar), true);
  assert.equal(looksLikeTar(AEAD_HEAD), false);
});

test("tar members are indexed by offset without reading their content", () => {
  const dir = mkdtempSync(join(tmpdir(), "import-tar-"));
  const archive = Buffer.alloc(1000, 7);
  const sidecar = Buffer.from("backup_origin: manual\n");
  const path = join(dir, "bundle.tar");
  writeFileSync(path, createTarArchive([
    { name: "dune-system-20260830-120000-4711-9931.tar.gz.enc", content: archive },
    { name: "dune-system-20260830-120000-4711-9931.tar.gz.enc.yaml", content: sidecar }
  ]));

  const members = readTarMemberIndex(path);
  assert.deepEqual(members.map((member) => member.name), [
    "dune-system-20260830-120000-4711-9931.tar.gz.enc",
    "dune-system-20260830-120000-4711-9931.tar.gz.enc.yaml"
  ]);
  assert.deepEqual(members.map((member) => member.size), [1000, sidecar.length]);
  // First member starts after its own header; the second after the first is
  // padded to a block boundary.
  assert.equal(members[0].start, 512);
  assert.equal(members[1].start, 512 + 1024 + 512);
});

test("a minted name is one the rest of the system will accept", () => {
  // Restore, download and delete all validate this shape; a name that fails it
  // would land where nothing can act on it.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    assert.equal(validSystemArchiveName(mintSystemBackupName()), true);
  }
});

test("normalizing a sidecar keeps its block scalars intact", () => {
  // The trap: normalizeImportedBackupMetadata round-trips through a flat
  // key/value parse, which would drop these indented continuation lines and
  // take the decrypt instructions with them -- the most useful thing in the
  // file on a host with no console.
  const original = [
    "artifact_id: dune-system-20260830-120000-4711-9931",
    "backup_origin: manual",
    "server_title: SteelHeart",
    "decrypt_note: >-",
    "  Do not pass the passphrase on the command line -- it would be",
    "  visible to other processes via ps/proc.",
    "decrypt_command: |-",
    "  read -r -s -p \"Passphrase: \" p; echo",
    "  printf '%s' \"$p\" | gpg --batch --yes",
    ""
  ].join("\n");

  const result = normalizeImportedSystemMetadata(original, { importedFrom: "old.tar.gz.enc" });

  assert.match(result, /^backup_origin: external$/m);
  assert.match(result, /^imported_at: /m);
  assert.match(result, /^imported_from: old\.tar\.gz\.enc$/m);
  assert.match(result, /^server_title: SteelHeart$/m);
  assert.match(result, /^decrypt_note: >-$/m);
  assert.match(result, /^ {2}Do not pass the passphrase on the command line/m);
  assert.match(result, /^decrypt_command: \|-$/m);
  assert.match(result, /^ {2}read -r -s -p "Passphrase: " p; echo$/m);
  assert.doesNotMatch(result, /^backup_origin: manual$/m);
});

test("normalizing twice does not stack imported_at lines", () => {
  const once = normalizeImportedSystemMetadata("backup_origin: manual\n", { importedFrom: "a" });
  const twice = normalizeImportedSystemMetadata(once, { importedFrom: "a" });
  assert.equal(twice.match(/^imported_at: /gm).length, 1);
  assert.equal(twice.match(/^imported_from: /gm).length, 1);
  assert.equal(twice.match(/^backup_origin: /gm).length, 1);
});

test("a synthesized sidecar invents nothing it does not know", () => {
  const result = synthesizeSystemMetadata({
    archiveName: "dune-system-20260830-120000-4711-9931.tar.gz.enc",
    importedFrom: "renamed (1).tar",
    encryption: "aes-256-ocb-gpg-aead"
  });
  assert.match(result, /^backup_origin: external$/m);
  assert.match(result, /^encryption: aes-256-ocb-gpg-aead$/m);
  // These live in the sidecar the upload did not have. Guessing them would put
  // invented values in columns an operator reads as fact.
  assert.doesNotMatch(result, /^created_at:/m);
  assert.doesNotMatch(result, /^server_title:/m);
  assert.doesNotMatch(result, /^battlegroup_id:/m);
});

test("a synthesized sidecar omits encryption when the header did not establish it", () => {
  const result = synthesizeSystemMetadata({ archiveName: "dune-system-20260830-120000-4711-9931.tar.gz.enc" });
  assert.doesNotMatch(result, /^encryption:/m);
});
