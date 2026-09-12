import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

export function clampInt(value, fallback, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return Math.min(Math.max(fallback, min), max);
  return Math.min(Math.max(n, min), max);
}

export function writeJsonAtomic(file, value, mode = 0o600, { pretty = true } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const temporaryPath = `${file}.${process.pid}.tmp`;
  const json = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  writeFileSync(temporaryPath, `${json}\n`, { mode });
  renameSync(temporaryPath, file);
}

// Async, non-blocking, durable atomic JSON write: write a uniquely-named temp
// file (mode set at creation, so never briefly world-readable), fsync it, rename
// over the target (atomic same-filesystem replace), then fsync the directory so
// the rename itself survives power loss. Used by security-sensitive stores that
// run inside a serialized queue and must not block the event loop with the
// synchronous writeJsonAtomic above. A random temp suffix avoids any collision
// or predictable-name concern and keeps a crash-orphaned temp uniquely named.
export async function writeJsonAtomicAsync(file, value, mode = 0o600, { pretty = true } = {}) {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });
  const temporaryPath = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const json = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  let fh;
  try {
    fh = await open(temporaryPath, "wx", mode); // wx: fail if it somehow exists
    await fh.writeFile(`${json}\n`);
    await fh.sync(); // durability: data on platter before the rename
    await fh.close();
    fh = null;
    await rename(temporaryPath, file);
  } catch (err) {
    if (fh) { try { await fh.close(); } catch { /* ignore */ } }
    try { await unlink(temporaryPath); } catch { /* best-effort cleanup of the orphan */ }
    throw err;
  }
  // fsync the directory so the rename (a directory-metadata change) is durable.
  // Best-effort: some platforms/filesystems reject O_RDONLY dir fsync -- a failure
  // here does not undo the already-atomic rename, so it must not fail the write.
  try {
    const dh = await open(dir, "r");
    try { await dh.sync(); } finally { await dh.close(); }
  } catch { /* directory fsync not supported here; rename already applied */ }
}
