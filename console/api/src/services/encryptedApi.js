// Encrypted API access: the optional front door (runtime/tls-front, docker-compose.tls-front.yml)
// that serves the Console API over HTTPS with its own long-lived key, so API clients can reach the
// Console without sending the API key in clear text. The front door forwards only `GET /api/*`
// with an API key to the unchanged Console (no web UI, no cookies).
//
// This service shows its state and fingerprint in Settings and turns it on and off. Clients pin
// the fingerprint of the KEY (SHA-256 of the certificate's public key, "sha256/<base64url>"); the
// admin compares it with what the client shows. The Console only reads the certificate (public);
// the private key stays in runtime/generated/tls-front and is never read here.
import { execFile } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const TLS_FRONT_CONTAINER = "dune-tls-front";
export const TLS_FRONT_DEFAULT_PORT = 8797;
const CERT_PATH = ["runtime", "generated", "tls-front", "front-cert.pem"];
const ENV_PATH = ["runtime", "generated", "tls-front.env"];
const SCRIPT_PATH = ["runtime", "scripts", "tls-front.sh"];
const COMPOSE_FILE = "docker-compose.tls-front.yml";
const ENABLE_TIMEOUT_MS = 10 * 60 * 1000; // the first start builds the image

export class EncryptedApiError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.name = "EncryptedApiError";
    this.status = status;
  }
}

// "sha256/" + base64url(SHA-256(SubjectPublicKeyInfo)), the same value the front door and its
// clients compute.
export function fingerprintOfCertificate(pem) {
  const spki = new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" });
  return `sha256/${createHash("sha256").update(spki).digest("base64url")}`;
}

export function parseTlsFrontEnv(text) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = /^(DUNE_TLS_FRONT_[A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) out[match[1]] = match[2].trim();
  }
  const port = Number(out.DUNE_TLS_FRONT_PORT);
  return {
    enabled: out.DUNE_TLS_FRONT_ENABLED === "true",
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : TLS_FRONT_DEFAULT_PORT
  };
}

export function createEncryptedApi({ repoRoot, run = execFileOutput, exists = existsSync, read = readFileSync } = {}) {
  let busy = false;

  function settings() {
    const path = resolve(repoRoot, ...ENV_PATH);
    try {
      return parseTlsFrontEnv(read(path, "utf8"));
    } catch {
      return { enabled: false, port: TLS_FRONT_DEFAULT_PORT };
    }
  }

  function fingerprint() {
    try {
      return fingerprintOfCertificate(read(resolve(repoRoot, ...CERT_PATH), "utf8"));
    } catch {
      return "";
    }
  }

  async function container() {
    try {
      const out = await run("docker", ["inspect", "--format", "{{.State.Status}}\t{{if .State.Health}}{{.State.Health.Status}}{{end}}", TLS_FRONT_CONTAINER], { timeout: 10_000 });
      const [state, health] = String(out).trim().split("\t");
      return { exists: true, state: (state || "").toLowerCase(), health: (health || "").toLowerCase() };
    } catch {
      return { exists: false, state: "", health: "" };
    }
  }

  return {
    // Settings section. Contains no secret: the fingerprint is public by design.
    async status() {
      const available = exists(resolve(repoRoot, COMPOSE_FILE)) && exists(resolve(repoRoot, ...SCRIPT_PATH));
      const { enabled, port } = settings();
      if (!available) return { available: false, enabled: false, running: false, state: "", health: "", port, fingerprint: "" };
      const c = await container();
      return {
        available: true,
        enabled,
        running: c.exists && c.state === "running",
        state: c.state,
        health: c.health,
        port,
        fingerprint: fingerprint()
      };
    },

    // Turns the front door on (builds and starts it) or off. Serialized: a second call while the
    // first one builds is refused instead of queued.
    async setEnabled(enabled) {
      if (typeof enabled !== "boolean") throw new EncryptedApiError("Send { \"enabled\": true } or { \"enabled\": false }.", 400);
      if (!exists(resolve(repoRoot, COMPOSE_FILE)) || !exists(resolve(repoRoot, ...SCRIPT_PATH))) {
        throw new EncryptedApiError("This installation does not include the encrypted API access.", 404);
      }
      if (busy) throw new EncryptedApiError("The encrypted API access is being changed. Try again in a moment.", 409);
      busy = true;
      try {
        await run(resolve(repoRoot, ...SCRIPT_PATH), [enabled ? "enable" : "disable"], {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: ENABLE_TIMEOUT_MS,
          stdio: ["ignore", "pipe", "pipe"]
        });
      } catch {
        throw new EncryptedApiError(enabled
          ? "The encrypted API access could not be started. Check the Docker build output with: dune encrypted-api enable"
          : "The encrypted API access could not be stopped.", 502);
      } finally {
        busy = false;
      }
      return this.status();
    }
  };
}

function execFileOutput(file, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(file, args, { maxBuffer: 4 * 1024 * 1024, shell: false, ...options }, (error, stdout) => {
      if (error) rejectPromise(error);
      else resolvePromise(stdout || "");
    });
  });
}
