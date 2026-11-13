import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

// Host paths passed to Docker are not necessarily visible inside the Console.
// Resolve only against its mounted checkout, keeping UID/GID provenance paired.
export function resolveHostIdentity(config, { env = process.env, stat = statSync, readFile = readFileSync,
  callerUid = process.getuid?.() ?? 0, callerGid = process.getgid?.() ?? 0 } = {}) {
  const root = config.repoRoot || process.cwd();
  let owner = {}, saved = {};
  try { owner = stat(root); } catch { /* Use persisted identity or caller. */ }
  try {
    for (const line of readFile(resolve(root, ".env"), "utf8").split(/\r?\n/)) {
      const match = /^(DUNE_HOST_UID|DUNE_HOST_GID)=([^=]*)/.exec(line);
      if (match && saved[match[1]] === undefined) saved[match[1]] = match[2].replace(/[\s"']/g, "");
    }
  } catch { /* A missing/unreadable file must not prevent owner-based repair. */ }
  const valid = value => /^\d+$/.test(String(value ?? ""));
  const incomingUid = env.DUNE_HOST_UID || "";
  const incomingGid = env.DUNE_HOST_GID || "";
  if ((incomingUid && !valid(incomingUid)) || (incomingGid && !valid(incomingGid))) {
    throw new Error("Set numeric DUNE_HOST_UID and DUNE_HOST_GID before updating.");
  }
  let uid = incomingUid;
  let identityGid = owner.gid;
  if (!uid || uid === "0") {
    if (valid(saved.DUNE_HOST_UID) && saved.DUNE_HOST_UID !== "0") {
      uid = saved.DUNE_HOST_UID;
      identityGid = saved.DUNE_HOST_GID || owner.gid;
    } else uid = owner.uid ?? callerUid;
  } else if (saved.DUNE_HOST_UID === uid) identityGid = saved.DUNE_HOST_GID || owner.gid;
  const gid = !incomingGid || (incomingGid === "0" && (!incomingUid || incomingUid === "0"))
    ? identityGid ?? callerGid : incomingGid;
  if (!valid(uid) || !valid(gid)) throw new Error("Could not resolve the host installation owner.");
  return { uid: String(uid), gid: String(gid) };
}
