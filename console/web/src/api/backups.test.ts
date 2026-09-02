import { describe, expect, it } from "vitest";
import { backupIdentityDiffers, backupsApi } from "./backups";

describe("backup Battlegroup identity", () => {
  it("requires a choice when a known backup belongs to another Battlegroup", () => {
    expect(backupIdentityDiffers("sh-current-01", "sh-backup-02")).toBe(true);
  });

  it("does not report a mismatch for the same Battlegroup", () => {
    expect(backupIdentityDiffers("sh-current-01", "sh-current-01")).toBe(false);
  });

  it("does not invent a mismatch when either identity is unavailable", () => {
    expect(backupIdentityDiffers("Unknown", "sh-backup-02")).toBe(false);
    expect(backupIdentityDiffers("sh-current-01", undefined)).toBe(false);
  });
});

describe("backup download URLs", () => {
  it("builds the download route for a backup", () => {
    expect(backupsApi.downloadUrl("dune-db-20260830-120000.dump")).toBe(
      "/api/backups/dune-db-20260830-120000.dump/download"
    );
  });

  it("escapes backup names in the path", () => {
    expect(backupsApi.downloadUrl("imported backup.backup")).toBe(
      "/api/backups/imported%20backup.backup/download"
    );
  });
});
