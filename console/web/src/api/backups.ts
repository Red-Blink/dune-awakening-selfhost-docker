import { api, post } from "./client";
import type { Task } from "./setup";

export type SystemImportConflict = "overwrite" | "rename";

export type BackupIdentityMode = "adopt-backup" | "keep-current";

export type AuditLogMode = "adopt-backup" | "keep-current";

export type SystemBackupRow = {
  name: string;
  createdAt: string;
  origin: string;
  type: string;
  source: string;
  encryption: string;
  serverTitle: string;
  battlegroupId: string;
  hasSidecar: boolean;
  includesAuditLog: boolean;
  sizeBytes: number;
  size: string;
};

export function backupIdentityDiffers(currentBattlegroupId: unknown, backupBattlegroupId: unknown) {
  const current = String(currentBattlegroupId || "Unknown");
  const backup = String(backupBattlegroupId || "Unknown");
  return current !== "Unknown" && backup !== "Unknown" && current !== backup;
}

// What to send when the two identities do NOT differ, which covers two very
// different situations. On a configured host they match, and keeping the
// current one is right. On a host that has no identity at all -- a fresh
// machine receiving a migration, the case system backups exist for -- there is
// nothing to keep, and import_db refuses "keep-current" outright because it
// cannot verify continuity against an ID that does not exist. Adopting the
// archive's is the only coherent answer there, and it mirrors how the audit log
// is already handled when only the archive has one.
export function defaultBackupIdentityMode(currentBattlegroupId: unknown, backupBattlegroupId: unknown) {
  const current = String(currentBattlegroupId || "Unknown");
  const backup = String(backupBattlegroupId || "Unknown");
  if (current === "Unknown" && backup !== "Unknown") return "adopt-backup" as const;
  return "keep-current" as const;
}

export const backupsApi = {
  list: () => api<{ stdout: string; currentBattlegroupId?: string; rows?: Record<string, unknown>[] }>("/api/backups"),
  create: () => post<{ task: Task }>("/api/backups/create"),
  restore: (backup: string, identityMode: BackupIdentityMode) => post<{ task: Task }>("/api/backups/restore", { backup, identityMode }),
  delete: (backup: string) => api<{ task: Task }>(`/api/backups/${encodeURIComponent(backup)}`, { method: "DELETE" }),
  deleteAll: () => post<{ task: Task }>("/api/backups/delete-all"),
  deleteSelected: (backups: string[]) => post<{ task: Task }>("/api/backups/delete-selected", { backups }),
  downloadUrl: (backup: string) => `/api/backups/${encodeURIComponent(backup)}/download`,
  listSystem: () => api<{ rows: SystemBackupRow[] }>("/api/backups/system"),
  // Body, never a query string: a passphrase in a URL lands in proxy and access logs.
  createSystem: (passphrase: string) => post<{ task: Task }>("/api/backups/system/create", { passphrase }),
  systemDownloadUrl: (name: string) => `/api/backups/system/${encodeURIComponent(name)}/download`,
  // Body for the same reason as createSystem. Defaults to a dry run: a call
  // that loses its apply flag must preview, never replace the host.
  restoreSystem: (name: string, body: { passphrase: string; apply: boolean; identityMode?: BackupIdentityMode; auditLogMode?: AuditLogMode }) =>
    post<{ task: Task }>(`/api/backups/system/${encodeURIComponent(name)}/restore`, body),
  // The file itself is the body, not a multipart form: one file travels now
  // that the archive and its sidecar are bundled, and XHR (see importSystem in
  // BackupsPanel) is what can report upload progress -- fetch cannot.
  importSystemUrl: (filename: string, onConflict?: SystemImportConflict) => {
    const query = new URLSearchParams({ filename });
    if (onConflict) query.set("onConflict", onConflict);
    return `/api/backups/system/import?${query.toString()}`;
  },
  deleteSystem: (name: string) => api<{ task: Task }>(`/api/backups/system/${encodeURIComponent(name)}`, { method: "DELETE" }),
  deleteSystemSelected: (backups: string[]) => post<{ task: Task }>("/api/backups/system/delete-selected", { backups }),
  deleteSystemAll: () => post<{ task: Task }>("/api/backups/system/delete-all"),
  importExternal: (form: FormData) => api<{ ok: boolean; row?: Record<string, unknown>; rows?: Record<string, unknown>[] }>("/api/backups/import-external", { method: "POST", body: form }),
  autoStatus: () => api<{ stdout: string; stderr?: string; exitCode?: number; status?: Record<string, unknown> }>("/api/backups/auto"),
  saveAuto: (body: { enabled: boolean; time: string; retentionDays: number; intervalHours: number }) => post<{ task: Task }>("/api/backups/auto", body)
};
