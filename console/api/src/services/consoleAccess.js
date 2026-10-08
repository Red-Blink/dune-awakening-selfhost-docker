import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { parseAllowedIps } from "../config.js";
import { writeJsonAtomic } from "../jsonStore.js";

export const ACCESS_RECOVERY = "Using SSH, edit ADMIN_ALLOWED_IPS in the project's .env file to correct the addresses or clear the value, then run runtime/scripts/dune console reload. This affects the Console only, not the Battlegroup.";

export function createConsoleAccess({ repoRoot, configured = "", legacy = "" }) {
  const file = join(repoRoot, "runtime/generated/console-access-review.json");
  const requested = parseAllowedIps(configured);
  const existing = parseAllowedIps(legacy);
  const fingerprint = createHash("sha256").update(JSON.stringify(requested)).digest("hex");
  let reviewed = null;
  if (requested.length && !existing.length && existsSync(file)) {
    // Corrupt security state must not silently remove an active restriction.
    reviewed = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(reviewed.allowedIps) || !reviewed.allowedIps.every((ip) => typeof ip === "string" && isIP(ip))) {
      throw new Error("Console access review state is invalid. Restore the file using SSH.");
    }
  }
  function activeIps() {
    // Direct/override deployments that already enforced ADMIN_ALLOWED_IPS keep
    // that exact policy. Clearing the existing .env setting is the SSH recovery.
    if (existing.length) return existing;
    if (!requested.length) return [];
    return reviewed?.allowedIps || [];
  }
  function status(clientIp) {
    const pending = !existing.length && requested.length > 0 && reviewed?.fingerprint !== fingerprint;
    return {
      pending, configuredCount: requested.length, activeCount: activeIps().length,
      canConfirm: pending && requested.every((ip) => isIP(ip)) && requested.includes(clientIp),
      fingerprint: pending ? fingerprint : "", recovery: ACCESS_RECOVERY
    };
  }
  function confirm({ confirmed, fingerprint: expected }, clientIp) {
    const current = status(clientIp);
    if (confirmed !== true || expected !== fingerprint || !current.pending) {
      throw new Error("The IP restrictions need a fresh review. Refresh Settings and try again.");
    }
    if (!current.canConfirm) {
      throw new Error(`These restrictions would block your current connection or contain an invalid address. ${ACCESS_RECOVERY}`);
    }
    const next = { fingerprint, allowedIps: requested };
    writeJsonAtomic(file, next);
    reviewed = next;
    return status(clientIp);
  }
  return { activeIps, status, confirm };
}
