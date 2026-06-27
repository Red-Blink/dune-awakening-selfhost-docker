import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrichBackupRows, extractFuncomBattlegroupId, formatBackupSize, normalizeImportedBackupMetadata, parseBackupMetadata } from "../src/services/backups.js";

const officialBattleGroupYaml = `
apiVersion: igw.funcom.com/v1
kind: BattleGroup
metadata:
  name: sh-1842e91d579eb145-aohwkl
  namespace: funcom-seabass-sh-1842e91d579eb145-aohwkl
spec:
  name: sh-1842e91d579eb145-aohwkl
  serverGroup:
    template:
      spec:
        sets: []
`;

test("backup metadata parser extracts battlegroup from official BattleGroup YAML", () => {
  assert.equal(extractFuncomBattlegroupId(officialBattleGroupYaml), "sh-1842e91d579eb145-aohwkl");
  assert.equal(parseBackupMetadata(officialBattleGroupYaml).battlegroup_id, "sh-1842e91d579eb145-aohwkl");
});

test("imported official BattleGroup YAML is normalized with source battlegroup", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-backup-metadata-"));
  const generatedDir = join(repoRoot, "runtime/generated");
  mkdirSync(generatedDir, { recursive: true });
  writeFileSync(join(generatedDir, "battlegroup.env"), "BATTLEGROUP_ID=sh-current1234567890-local\n");

  const normalized = normalizeImportedBackupMetadata({ repoRoot, generatedDir }, officialBattleGroupYaml);
  const metadata = parseBackupMetadata(normalized);

  assert.equal(metadata.battlegroup_id, "sh-1842e91d579eb145-aohwkl");
  assert.equal(metadata.imported_from_battlegroup_id, "sh-1842e91d579eb145-aohwkl");
  assert.equal(metadata.backup_origin, "external");
});

test("backup rows include human-readable file sizes", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-backup-size-"));
  const backupDir = join(repoRoot, "runtime/backups/db");
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(join(backupDir, "dune-db-test-20260620-010203.backup"), Buffer.alloc(1536));

  const rows = enrichBackupRows({ repoRoot }, [{ name: "dune-db-test-20260620-010203.backup", backupName: "dune-db-test-20260620-010203.backup" }]);

  assert.equal(rows[0].sizeBytes, 1536);
  assert.equal(rows[0].size, "1.5 KB");
  assert.equal(formatBackupSize(0), "Unknown");
});
