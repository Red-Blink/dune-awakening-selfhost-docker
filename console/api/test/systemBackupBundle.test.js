import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemBackupBundleMembers } from "../src/services/systemBackups.js";
import { createTarHeader, tarArchiveLength, tarPadding, TAR_TRAILER_BYTES } from "../src/services/backups.js";

const ARCHIVE = "dune-system-20260830-120000-4711-9931.tar.gz.enc";

function makeHost({ withSidecar = true, archiveBytes = 1000 } = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), "system-bundle-"));
  const directory = join(repoRoot, "runtime/backups/system");
  mkdirSync(directory, { recursive: true });
  // Deliberately not a multiple of 512, so the padding maths is exercised.
  const archive = Buffer.alloc(archiveBytes);
  for (let index = 0; index < archive.length; index += 1) archive[index] = index % 251;
  writeFileSync(join(directory, ARCHIVE), archive);
  const sidecar = Buffer.from("artifact_id: dune-system-20260830-120000-4711-9931\nencryption: aes-256-ocb-gpg-aead\n");
  if (withSidecar) writeFileSync(join(directory, `${ARCHIVE}.yaml`), sidecar);
  return { config: { repoRoot }, repoRoot, directory, archive, sidecar };
}

// Assembles exactly what the download route streams, so the assertions below are
// about the bytes a client actually receives.
function buildBundle(members) {
  const blocks = [];
  for (const member of members) {
    blocks.push(createTarHeader(member.name, member.size));
    blocks.push(readFileSync(member.path));
    const padding = tarPadding(member.size);
    if (padding) blocks.push(Buffer.alloc(padding, 0));
  }
  blocks.push(Buffer.alloc(TAR_TRAILER_BYTES, 0));
  return Buffer.concat(blocks);
}

test("the bundle carries the archive and its sidecar", () => {
  const { config } = makeHost();
  const members = systemBackupBundleMembers(config, ARCHIVE);
  assert.deepEqual(members.map((member) => member.name), [ARCHIVE, `${ARCHIVE}.yaml`]);
});

test("a missing sidecar is skipped rather than failing the download", () => {
  // An archive copied in by hand arrives without one. Refusing to download it
  // then would be worse than downloading what exists.
  const { config } = makeHost({ withSidecar: false });
  const members = systemBackupBundleMembers(config, ARCHIVE);
  assert.deepEqual(members.map((member) => member.name), [ARCHIVE]);
});

test("the declared length matches the bytes actually produced", () => {
  // This is the whole reason the download can stream a multi-GB archive: the
  // Content-Length is computed before any content is read. If these two ever
  // disagree the client gets a truncated or hung response.
  const { config } = makeHost({ archiveBytes: 1000 });
  const members = systemBackupBundleMembers(config, ARCHIVE);
  assert.equal(buildBundle(members).length, tarArchiveLength(members));
});

test("the declared length holds for a content size that is an exact block multiple", () => {
  const { config } = makeHost({ archiveBytes: 1024 });
  const members = systemBackupBundleMembers(config, ARCHIVE);
  assert.equal(tarPadding(1024), 0);
  assert.equal(buildBundle(members).length, tarArchiveLength(members));
});

test("real tar reads the bundle and both files survive byte-for-byte", () => {
  // Verified against GNU tar rather than a parser written here: a bug shared
  // between writer and reader would pass a self-check and fail on a real host.
  const { config, archive, sidecar } = makeHost({ archiveBytes: 1000 });
  const members = systemBackupBundleMembers(config, ARCHIVE);
  const out = mkdtempSync(join(tmpdir(), "system-bundle-out-"));
  const bundlePath = join(out, "bundle.tar");
  writeFileSync(bundlePath, buildBundle(members));

  const listed = execFileSync("tar", ["-tf", bundlePath], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(listed, [ARCHIVE, `${ARCHIVE}.yaml`]);

  execFileSync("tar", ["-xf", bundlePath, "-C", out]);
  assert.deepEqual(readFileSync(join(out, ARCHIVE)), archive);
  assert.deepEqual(readFileSync(join(out, `${ARCHIVE}.yaml`)), sidecar);
  rmSync(out, { recursive: true, force: true });
});

test("a sidecar-less bundle is still a valid tar", () => {
  const { config, archive } = makeHost({ withSidecar: false, archiveBytes: 777 });
  const members = systemBackupBundleMembers(config, ARCHIVE);
  const out = mkdtempSync(join(tmpdir(), "system-bundle-out-"));
  const bundlePath = join(out, "bundle.tar");
  writeFileSync(bundlePath, buildBundle(members));

  assert.equal(execFileSync("tar", ["-tf", bundlePath], { encoding: "utf8" }).trim(), ARCHIVE);
  execFileSync("tar", ["-xf", bundlePath, "-C", out]);
  assert.deepEqual(readFileSync(join(out, ARCHIVE)), archive);
  rmSync(out, { recursive: true, force: true });
});
