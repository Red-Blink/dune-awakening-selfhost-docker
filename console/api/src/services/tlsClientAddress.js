import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";

// Only the project TLS front may supply a client address. Its per-install
// shared key signs the address, timestamp and exact request, so arbitrary
// X-Forwarded-For headers never bypass ADMIN_ALLOWED_IPS.
export function tlsClientAddress(req, repoRoot, now = Date.now()) {
  const peer = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  const ip = req.headers["x-dune-tls-client"];
  const timestamp = req.headers["x-dune-tls-time"];
  const signature = req.headers["x-dune-tls-signature"];
  if (ip === undefined && timestamp === undefined && signature === undefined) return peer;
  const local = String(req.socket.localAddress || "").replace(/^::ffff:/, "");
  if (!["127.0.0.1", "::1", local].includes(peer)
    || typeof ip !== "string" || !isIP(ip)
    || typeof timestamp !== "string" || !/^\d{10}$/.test(timestamp)
    || Math.abs(now - Number(timestamp) * 1000) > 60_000
    || typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature)) return null;
  try {
    const key = readFileSync(join(repoRoot, "runtime/generated/tls-front/proxy-key"));
    if (key.length !== 32) return null;
    const expected = createHmac("sha256", key)
      .update(`${timestamp}\n${ip}\n${req.method}\n${req.url}`).digest();
    return timingSafeEqual(expected, Buffer.from(signature, "hex")) ? ip : null;
  } catch { return null; }
}
