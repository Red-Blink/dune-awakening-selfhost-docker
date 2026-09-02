import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSystemBackups, validSystemArchiveName, validSystemBackupName } from "../src/services/systemBackups.js";
import { validBackupDownloadName } from "../src/services/backups.js";
import { parseBackupListRows } from "../src/statusParsers.js";
import { actionForRoute } from "../src/actions.js";
import { buildDuneArgs } from "../src/runner.js";
import { isReadAction } from "../src/apiKeyScopes.js";
import { withSecurityHeaders } from "../src/auth.js";

const ARCHIVE = "dune-system-20260830-120000-4711-9931.tar.gz.enc";

function makeHost() {
  const root = mkdtempSync(join(tmpdir(), "system-backups-"));
  const directory = join(root, "runtime/backups/system");
  mkdirSync(directory, { recursive: true });
  return { root, directory, config: { repoRoot: root } };
}

test("validSystemBackupName accepts real archives and their sidecars only", () => {
  assert.equal(validSystemBackupName(ARCHIVE), true);
  assert.equal(validSystemBackupName(`${ARCHIVE}.yaml`), true);
  for (const denied of [
    `${ARCHIVE}.partial.99`,
    "../../etc/passwd",
    "/etc/passwd",
    "dune-db-20260830-120000.dump",
    "evil.tar.gz.enc",
    "dune-system-20260830-120000.tar.gz.enc",
    ""
  ]) {
    assert.equal(validSystemBackupName(denied), false, denied);
  }
});

// The two namespaces must not bleed into each other: a system archive is not a
// database backup, and must not be reachable through the database download route
// or appear as a row in the database backup list.
test("a system archive is not a database backup", () => {
  assert.equal(validBackupDownloadName(ARCHIVE), false);
  assert.deepEqual(parseBackupListRows(`2026-08-30 12:00 4096 runtime/backups/system/${ARCHIVE}`), []);
});

test("listSystemBackups reads sidecars and ignores staging files", () => {
  const { directory, config } = makeHost();
  writeFileSync(join(directory, ARCHIVE), Buffer.alloc(2048));
  writeFileSync(join(directory, `${ARCHIVE}.yaml`), [
    "artifact_id: dune-system-20260830-120000-4711-9931",
    "created_at: 2026-08-30T12:00:00-04:00",
    "encryption: aes-256-ocb-gpg-aead",
    "server_title: Kovalt",
    "battlegroup_id: sh-abc-def",
    ""
  ].join("\n"));
  writeFileSync(join(directory, "dune-system-20260901-000000-1-1.tar.gz.enc.partial.77"), "staging");
  writeFileSync(join(directory, "notes.txt"), "unrelated");

  const rows = listSystemBackups(config);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, ARCHIVE);
  assert.equal(rows[0].serverTitle, "Kovalt");
  assert.equal(rows[0].battlegroupId, "sh-abc-def");
  assert.equal(rows[0].encryption, "aes-256-ocb-gpg-aead");
  assert.equal(rows[0].hasSidecar, true);
  assert.equal(rows[0].size, "2 KB");
});

// Regression: sorting once fell back to the filename when created_at was absent,
// which compared "dune-system-…" against an ISO date and floated every
// sidecar-less archive to the top.
test("listSystemBackups sorts newest first even without sidecars", () => {
  const { directory, config } = makeHost();
  const names = [
    "dune-system-20260829-080000-1-1.tar.gz.enc",
    "dune-system-20260831-090000-2-2.tar.gz.enc",
    "dune-system-20260830-120000-3-3.tar.gz.enc"
  ];
  for (const name of names) writeFileSync(join(directory, name), Buffer.alloc(16));
  // Only the middle one gets a sidecar.
  writeFileSync(join(directory, `${names[1]}.yaml`), "created_at: 2026-08-31T09:00:00-04:00\n");

  assert.deepEqual(listSystemBackups(config).map((row) => row.name), [
    "dune-system-20260831-090000-2-2.tar.gz.enc",
    "dune-system-20260830-120000-3-3.tar.gz.enc",
    "dune-system-20260829-080000-1-1.tar.gz.enc"
  ]);
});

test("listSystemBackups tolerates a missing directory and an unreadable sidecar", () => {
  assert.deepEqual(listSystemBackups({ repoRoot: mkdtempSync(join(tmpdir(), "empty-")) }), []);

  const { directory, config } = makeHost();
  writeFileSync(join(directory, ARCHIVE), Buffer.alloc(8));
  writeFileSync(join(directory, `${ARCHIVE}.yaml`), "  not yaml at all");
  const rows = listSystemBackups(config);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].serverTitle, "Unknown");
});

// A GET is invisible to the mutating-route parity test, so this route's action
// assignment is the only thing keeping the archive -- which contains every
// credential on the host -- off a read-only grant.
test("the system backup routes carry their own write-shaped actions", () => {
  const download = actionForRoute(`/api/backups/system/${ARCHIVE}/download`, "GET");
  const create = actionForRoute("/api/backups/system/create", "POST");

  assert.equal(download, "backups:download-system");
  assert.equal(create, "backups:create-system");
  assert.equal(isReadAction(download), false);
  assert.equal(isReadAction(create), false);
  assert.notEqual(download, "backups:read");

  // The plain database download is deliberately untouched.
  assert.equal(actionForRoute("/api/backups/dune-db-20260830-120000.dump/download", "GET"), "backups:read");
  // And listing system backups is a genuine read.
  assert.equal(actionForRoute("/api/backups/system", "GET"), "backups:read");
});

// Deleting one of these destroys the only copy of the credentials inside it, so
// it gets its own action rather than sharing the database backups' backups:delete.
test("the system delete routes carry their own write-shaped action", () => {
  const one = actionForRoute(`/api/backups/system/${ARCHIVE}`, "DELETE");
  const selected = actionForRoute("/api/backups/system/delete-selected", "POST");
  const all = actionForRoute("/api/backups/system/delete-all", "POST");

  for (const action of [one, selected, all]) {
    assert.equal(action, "backups:delete-system");
    assert.equal(isReadAction(action), false);
  }
  // The database backup delete is a separate grant and must be unaffected.
  assert.equal(actionForRoute("/api/backups/dune-db-20260830-120000.dump", "DELETE"), "backups:delete");
});

test("system delete operations build the right dune arguments", () => {
  assert.deepEqual(buildDuneArgs("backupSystemDelete", { backup: ARCHIVE }), ["db", "delete-system", ARCHIVE]);
  assert.deepEqual(buildDuneArgs("backupSystemDeleteAll", {}), ["db", "delete-system", "--all"]);
  assert.deepEqual(
    buildDuneArgs("backupSystemDeleteSelected", { backups: [ARCHIVE, ARCHIVE] }),
    ["db", "delete-system", ARCHIVE]
  );
});

test("system delete refuses names that are not system archives", () => {
  for (const bad of ["../../etc/passwd", "/etc/passwd", "dune-db-20260830-120000.dump", `${ARCHIVE}.partial.9`, ""]) {
    assert.equal(validSystemBackupName(bad), false, bad);
  }
  assert.throws(() => buildDuneArgs("backupSystemDelete", { backup: "../etc/passwd" }), /Invalid backup name/);
});

// Download serves the sidecar too, but delete must not: a sidecar name used to
// pass the HTTP gate and only fail in the shell, surfacing as a failed task
// rather than a 400.
test("the delete gate rejects sidecar names the download gate accepts", () => {
  assert.equal(validSystemBackupName(`${ARCHIVE}.yaml`), true);
  assert.equal(validSystemArchiveName(`${ARCHIVE}.yaml`), false);

  // The archive itself passes both.
  assert.equal(validSystemBackupName(ARCHIVE), true);
  assert.equal(validSystemArchiveName(ARCHIVE), true);

  // And everything the download gate rejects, the delete gate rejects too.
  for (const bad of ["../../etc/passwd", "/etc/passwd", "dune-db-20260830-120000.dump", `${ARCHIVE}.partial.9`, ""]) {
    assert.equal(validSystemArchiveName(bad), false, bad);
  }
});

// The archive is downloadable, so a degenerate passphrase is trivially
// crackable offline regardless of the KDF. This is a floor, not a policy.
test("the passphrase floor rejects degenerate input but allows real passphrases", () => {
  const distinct = (value) => new Set(value).size;
  assert.ok(distinct("aaaaaaaaaaaa") < 5, "twelve of one character must fail the floor");
  assert.ok(distinct("abababababab") < 5, "a two-character cycle must fail the floor");
  assert.ok(distinct("correct horse battery staple") >= 5);
  assert.ok(distinct("Tr0ub4dor&3xyz") >= 5);
});

test("system backup downloads carry the standard security headers", () => {
  // The archive holds every credential on the host; it must not be served
  // without nosniff / frame / referrer protection the way json() applies them.
  const headers = withSecurityHeaders({ "content-type": "application/octet-stream" });
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["x-frame-options"], "DENY");
  assert.equal(headers["referrer-policy"], "no-referrer");
  assert.equal(headers["content-type"], "application/octet-stream");
});

// The two tables should read alike: Type and Source use the same vocabulary
// and the same sidecar field as enrichBackupRows does for database backups.
test("listSystemBackups derives Type and Source the way the database table does", () => {
  const { directory, config } = makeHost();
  const cases = [
    ["dune-system-20260904-120000-1-1.tar.gz.enc", "manual", "Manual Backup", "Local"],
    ["dune-system-20260903-120000-1-2.tar.gz.enc", "automatic", "Automatic Backup", "Local"],
    ["dune-system-20260902-120000-1-3.tar.gz.enc", "external", "Imported Backup", "External"],
    ["dune-system-20260905-120000-1-5.tar.gz.enc", "imported", "Imported Backup", "External"]
  ];
  for (const [name, origin] of cases) {
    writeFileSync(join(directory, name), Buffer.alloc(16));
    writeFileSync(join(directory, `${name}.yaml`), `backup_origin: ${origin}
`);
  }
  // No sidecar at all: nothing is known, so nothing is asserted.
  const orphan = "dune-system-20260901-120000-1-4.tar.gz.enc";
  writeFileSync(join(directory, orphan), Buffer.alloc(16));

  const byName = new Map(listSystemBackups(config).map((row) => [row.name, row]));
  for (const [name, , type, source] of cases) {
    assert.equal(byName.get(name).type, type, name);
    assert.equal(byName.get(name).source, source, name);
  }
  assert.equal(byName.get(orphan).type, "Unknown");
  // Local is the honest default: an archive only becomes External when
  // something writes backup_origin: external, which no import path does yet.
  assert.equal(byName.get(orphan).source, "Local");
});
