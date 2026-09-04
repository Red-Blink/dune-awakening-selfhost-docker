import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateEnvFileValue, updateEnvFileValues } from "../src/services/envFile.js";

// Real bug found via live-testing: dune-dev's .env showed a blank line before
// every Discord OAuth key the guided setup wizard writes, except the first.
// discordSetupFinalize (server.js) calls updateEnvFileValue once per key in a
// loop -- each call reads the current file, splits on newline, and appends
// the new key. A normally-newline-terminated file splits into a trailing ""
// entry (the position right before EOF); the new key was pushed AFTER that
// entry instead of replacing it, so the write preserved a blank line in front
// of every newly-added key, and the NEXT sequential call saw the freshly
// blank-line-prefixed file and repeated the same mistake.
//
// updateEnvFileValue/updateEnvFileValues are now async, backed by a shared
// in-process write queue (#678) -- every test below awaits the write before
// reading the file back.

function readEnvLines(path) {
  return readFileSync(path, "utf8").split("\n");
}

test("updateEnvFileValue: appending a new key to a normally-newline-terminated file adds no blank line before it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "envfile-"));
  writeFileSync(join(dir, ".env"), "EXISTING_KEY=1\n"); // the normal case: ends in a single trailing newline
  await updateEnvFileValue(dir, "NEW_KEY", "2");
  const lines = readEnvLines(join(dir, ".env"));
  assert.deepEqual(lines, ["EXISTING_KEY=1", "NEW_KEY=2", ""]);
  rmSync(dir, { recursive: true, force: true });
});

test("updateEnvFileValue: sequential calls (a legacy per-key loop shape) never insert a blank line between keys", async () => {
  const dir = mkdtempSync(join(tmpdir(), "envfile-"));
  writeFileSync(join(dir, ".env"), "DISCORD_OAUTH_CLIENT_ID=abc\n");
  await updateEnvFileValue(dir, "DISCORD_HOME_GUILD_ID", "1");
  await updateEnvFileValue(dir, "DISCORD_CONSOLE_ADMIN_ROLE_IDS", "2");
  await updateEnvFileValue(dir, "DISCORD_CONSOLE_MODERATOR_ROLE_IDS", "3");
  const lines = readEnvLines(join(dir, ".env"));
  assert.deepEqual(lines, [
    "DISCORD_OAUTH_CLIENT_ID=abc",
    "DISCORD_HOME_GUILD_ID=1",
    "DISCORD_CONSOLE_ADMIN_ROLE_IDS=2",
    "DISCORD_CONSOLE_MODERATOR_ROLE_IDS=3",
    "",
  ]);
  rmSync(dir, { recursive: true, force: true });
});

// #641 (guided Discord app-creation flow) design's §4.3: the connect step's
// sequential write of exactly the 2 keys it manages is the coldest possible
// .env state this loop shape will ever see -- a brand-new install, before
// ANY Discord config (or .env file at all) exists. Distinct from the test
// above, which starts from a file that already has one key.
test("updateEnvFileValue: the guided setup wizard's connect step (write DISCORD_OAUTH_CLIENT_ID then DISCORD_OAUTH_REDIRECT_URI) against a .env that doesn't exist yet inserts no blank lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "envfile-"));
  // No writeFileSync at all -- .env genuinely does not exist yet.
  await updateEnvFileValue(dir, "DISCORD_OAUTH_CLIENT_ID", "123456789012345678");
  await updateEnvFileValue(dir, "DISCORD_OAUTH_REDIRECT_URI", "example-redirect-uri");
  const lines = readEnvLines(join(dir, ".env"));
  assert.deepEqual(lines, [
    "DISCORD_OAUTH_CLIENT_ID=123456789012345678",
    "DISCORD_OAUTH_REDIRECT_URI=example-redirect-uri",
    "",
  ]);
  rmSync(dir, { recursive: true, force: true });
});

test("updateEnvFileValue: updating an EXISTING key in place still adds no stray blank line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "envfile-"));
  writeFileSync(join(dir, ".env"), "A=1\nB=2\n");
  await updateEnvFileValue(dir, "B", "22");
  const lines = readEnvLines(join(dir, ".env"));
  assert.deepEqual(lines, ["A=1", "B=22", ""]);
  rmSync(dir, { recursive: true, force: true });
});

test("updateEnvFileValue: a deliberate blank line BETWEEN existing keys (not at EOF) is preserved, not collapsed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "envfile-"));
  writeFileSync(join(dir, ".env"), "# Section one\nA=1\n\n# Section two\nB=2\n");
  await updateEnvFileValue(dir, "C", "3");
  const lines = readEnvLines(join(dir, ".env"));
  assert.deepEqual(lines, ["# Section one", "A=1", "", "# Section two", "B=2", "C=3", ""]);
  rmSync(dir, { recursive: true, force: true });
});

test("updateEnvFileValue: a file with multiple stray trailing blank lines is normalized to exactly one on write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "envfile-"));
  writeFileSync(join(dir, ".env"), "A=1\n\n\n");
  await updateEnvFileValue(dir, "B", "2");
  const lines = readEnvLines(join(dir, ".env"));
  assert.deepEqual(lines, ["A=1", "B=2", ""]);
  rmSync(dir, { recursive: true, force: true });
});

// #678: two concurrent requests each writing a different key must not race --
// whichever write used to land second silently discarded the first, since
// each did an independent read -> mutate -> write with no serialization.
test("updateEnvFileValue: two concurrent single-key writes (not awaited before the second starts) both survive, in the shared queue's order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "envfile-"));
  writeFileSync(join(dir, ".env"), "EXISTING=1\n");
  // Deliberately not awaited individually -- this is the exact shape of two
  // concurrent HTTP requests each calling updateEnvFileValue without knowing
  // about the other.
  const first = updateEnvFileValue(dir, "FIRST", "a");
  const second = updateEnvFileValue(dir, "SECOND", "b");
  await Promise.all([first, second]);
  const lines = readEnvLines(join(dir, ".env"));
  assert.equal(lines.includes("FIRST=a"), true);
  assert.equal(lines.includes("SECOND=b"), true);
  assert.equal(lines.includes("EXISTING=1"), true);
  rmSync(dir, { recursive: true, force: true });
});

// The write-race's more dangerous shape: a multi-key "transaction" (the
// wizard's role-mapping save, or #676's Discord OAuth disable/forget) racing
// against a single unrelated key write from a different request. Before
// updateEnvFileValues existed, a caller writing N keys in a loop of
// updateEnvFileValue calls could have another request's write land BETWEEN
// two of its own iterations.
test("updateEnvFileValues: a multi-key bulk write is one atomic operation, immune to an interleaved single-key write from a different caller", async () => {
  const dir = mkdtempSync(join(tmpdir(), "envfile-"));
  writeFileSync(join(dir, ".env"), "EXISTING=1\n");
  const bulk = updateEnvFileValues(dir, {
    DISCORD_HOME_GUILD_ID: "1",
    DISCORD_CONSOLE_ADMIN_ROLE_IDS: "2",
    DISCORD_CONSOLE_MODERATOR_ROLE_IDS: "3",
  });
  const unrelated = updateEnvFileValue(dir, "UNRELATED_KEY", "z");
  await Promise.all([bulk, unrelated]);
  const lines = readEnvLines(join(dir, ".env"));
  assert.equal(lines.includes("DISCORD_HOME_GUILD_ID=1"), true);
  assert.equal(lines.includes("DISCORD_CONSOLE_ADMIN_ROLE_IDS=2"), true);
  assert.equal(lines.includes("DISCORD_CONSOLE_MODERATOR_ROLE_IDS=3"), true);
  assert.equal(lines.includes("UNRELATED_KEY=z"), true);
  assert.equal(lines.includes("EXISTING=1"), true);
  rmSync(dir, { recursive: true, force: true });
});

test("updateEnvFileValues: updating an existing key and adding a new one in the same call inserts no stray blank line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "envfile-"));
  writeFileSync(join(dir, ".env"), "A=1\nB=2\n");
  await updateEnvFileValues(dir, { B: "22", C: "3" });
  const lines = readEnvLines(join(dir, ".env"));
  assert.deepEqual(lines, ["A=1", "B=22", "C=3", ""]);
  rmSync(dir, { recursive: true, force: true });
});

// A rejected write (e.g. a filesystem error) must not wedge the shared queue
// for every writer after it.
test("updateEnvFileValue: a failed write does not block a subsequent write from a different caller", async () => {
  const dir = mkdtempSync(join(tmpdir(), "envfile-"));
  const missingDir = join(dir, "does-not-exist");
  await assert.rejects(() => updateEnvFileValue(missingDir, "A", "1"));
  // The queue must still be usable afterward, against a real directory.
  await updateEnvFileValue(dir, "B", "2");
  const lines = readEnvLines(join(dir, ".env"));
  assert.deepEqual(lines, ["B=2", ""]);
  rmSync(dir, { recursive: true, force: true });
});

// Layer 2 audit finding (DBA hat, #676): the previous write used a bare
// writeFileSync straight to .env, which truncates the target before writing
// -- a process kill/OOM/power-loss mid-write left .env corrupted with no
// fallback (reproduced directly: a truncated write dropped DUNE_DB_PASSWORD
// entirely and left a dangling, unparseable key). Fixed by writing to a
// uniquely-named temp file first and renaming over the target, matching this
// repo's own established atomic-write pattern (jsonStore.js's
// writeJsonAtomic). These two tests pin that guarantee.

test("updateEnvFileValues: writes via a temp file + rename, leaving no leftover temp artifact behind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "envfile-"));
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "EXISTING_KEY=1\n");
  await updateEnvFileValues(dir, { NEW_KEY: "2" });
  const lines = readEnvLines(envPath);
  assert.deepEqual(lines, ["EXISTING_KEY=1", "NEW_KEY=2", ""]);
  const leftoverTempFiles = readdirSync(dir).filter((name) => name.includes(".tmp"));
  assert.deepEqual(leftoverTempFiles, []);
  rmSync(dir, { recursive: true, force: true });
});

test("updateEnvFileValues: a write that fails before the rename step leaves the existing .env completely untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "envfile-"));
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "DUNE_DB_PASSWORD=original-secret\n");
  // Force the temp-file write step to fail by pre-creating its exact path as
  // a directory -- writeFileSync throws EISDIR before ever opening the real
  // .env file, standing in for a crash/kill/disk-full mid-write.
  const tempPath = `${envPath}.${process.pid}.tmp`;
  mkdirSync(tempPath);
  await assert.rejects(() => updateEnvFileValues(dir, { DUNE_DB_PASSWORD: "new-secret" }));
  assert.equal(readFileSync(envPath, "utf8"), "DUNE_DB_PASSWORD=original-secret\n");
  rmSync(dir, { recursive: true, force: true });
});
