import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createEncryptedApi, EncryptedApiError, fingerprintOfCertificate, parseTlsFrontEnv } from "../src/services/encryptedApi.js";
import { actionForRoute } from "../src/actions.js";

// The certificate and the pin below were produced by the front door itself (dune-tls-front -pin) and
// checked with openssl: openssl x509 -pubkey | openssl pkey -pubin -outform der | sha256 | base64url.
const CERT = readFileSync(new URL("./fixtures/tls-front-cert.pem", import.meta.url), "utf8");
const PIN = "sha256/gY-8xrfZUMTXC8eigcmXP1JbNuz-z7dulO6y2P4GgUg";

function installation({ cert = true, env = "", compose = true, script = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "tlsfront-"));
  mkdirSync(join(root, "runtime", "scripts"), { recursive: true });
  mkdirSync(join(root, "runtime", "generated", "tls-front"), { recursive: true });
  if (compose) writeFileSync(join(root, "docker-compose.tls-front.yml"), "name: x\n");
  if (script) writeFileSync(join(root, "runtime", "scripts", "tls-front.sh"), "#!/bin/sh\n");
  if (cert) writeFileSync(join(root, "runtime", "generated", "tls-front", "front-cert.pem"), CERT);
  if (env) writeFileSync(join(root, "runtime", "generated", "tls-front.env"), env);
  return root;
}

const dockerRunning = (state = "running", health = "healthy") => async (file, args) => {
  if (file === "docker" && args[0] === "inspect") return `${state}\t${health}\n`;
  throw new Error(`unexpected ${file} ${args.join(" ")}`);
};

test("the fingerprint is the SHA-256 of the certificate's public key, as the front door computes it", () => {
  assert.equal(fingerprintOfCertificate(CERT), PIN);
});

test("env file parsing falls back to safe defaults", () => {
  assert.deepEqual(parseTlsFrontEnv("DUNE_TLS_FRONT_ENABLED=true\nDUNE_TLS_FRONT_PORT=9443\n"), { enabled: true, port: 9443 });
  assert.deepEqual(parseTlsFrontEnv("DUNE_TLS_FRONT_ENABLED=false\nDUNE_TLS_FRONT_PORT=70000\n"), { enabled: false, port: 8797 });
  assert.deepEqual(parseTlsFrontEnv("garbage; rm -rf /\n"), { enabled: false, port: 8797 });
  assert.deepEqual(parseTlsFrontEnv(""), { enabled: false, port: 8797 });
});

test("status shows state, port and fingerprint when the front door runs", async () => {
  const root = installation({ env: "DUNE_TLS_FRONT_ENABLED=true\nDUNE_TLS_FRONT_PORT=8797\n" });
  const status = await createEncryptedApi({ repoRoot: root, run: dockerRunning() }).status();
  assert.deepEqual(status, { available: true, enabled: true, running: true, state: "running", health: "healthy", port: 8797, fingerprint: PIN });
});

test("the fingerprint is still shown while the container is stopped (the key stays)", async () => {
  const root = installation({ env: "DUNE_TLS_FRONT_ENABLED=false\n" });
  const run = async () => { throw new Error("No such container"); };
  const status = await createEncryptedApi({ repoRoot: root, run }).status();
  assert.equal(status.enabled, false);
  assert.equal(status.running, false);
  assert.equal(status.fingerprint, PIN);
});

test("no certificate yet means an empty fingerprint, not an error", async () => {
  const root = installation({ cert: false });
  const status = await createEncryptedApi({ repoRoot: root, run: dockerRunning() }).status();
  assert.equal(status.fingerprint, "");
});

test("a broken certificate file does not break the page", async () => {
  const root = installation({ cert: false });
  writeFileSync(join(root, "runtime", "generated", "tls-front", "front-cert.pem"), "not a certificate");
  assert.equal((await createEncryptedApi({ repoRoot: root, run: dockerRunning() }).status()).fingerprint, "");
});

test("an installation without the feature reports it as not available", async () => {
  const root = installation({ compose: false, script: false });
  const status = await createEncryptedApi({ repoRoot: root, run: dockerRunning() }).status();
  assert.equal(status.available, false);
  assert.equal(status.fingerprint, "");
  await assert.rejects(createEncryptedApi({ repoRoot: root }).setEnabled(true), { status: 404 });
});

test("the status never contains anything secret: the private key is never read", async () => {
  const root = installation({});
  writeFileSync(join(root, "runtime", "generated", "tls-front", "front-key.pem"), "-----BEGIN EC PRIVATE KEY-----\nSECRET\n");
  const reads = [];
  const read = (path, enc) => { reads.push(String(path)); return readFileSync(path, enc); };
  const status = await createEncryptedApi({ repoRoot: root, run: dockerRunning(), read }).status();
  assert.ok(!JSON.stringify(status).includes("SECRET"));
  assert.ok(reads.every((path) => !path.endsWith("front-key.pem")), "front-key.pem must not be read");
});

test("enable and disable run the script with a fixed argument and return the new status", async () => {
  const root = installation({});
  const calls = [];
  const run = async (file, args, options) => {
    calls.push([file, args, options?.cwd]);
    if (file === "docker") return "running\thealthy\n";
    return "";
  };
  const api = createEncryptedApi({ repoRoot: root, run });
  const status = await api.setEnabled(true);
  const script = resolve(root, "runtime", "scripts", "tls-front.sh");
  assert.deepEqual(calls[0], [script, ["enable"], root]);
  assert.equal(status.fingerprint, PIN);
  await api.setEnabled(false);
  assert.deepEqual(calls.find((call) => call[1][0] === "disable"), [script, ["disable"], root]);
});

test("only a real boolean switches it; nothing else reaches the script", async () => {
  const root = installation({});
  let ran = false;
  const api = createEncryptedApi({ repoRoot: root, run: async () => { ran = true; return ""; } });
  for (const bad of ["true", 1, null, undefined, { enabled: true }, "enable; rm -rf /"]) {
    await assert.rejects(api.setEnabled(bad), (error) => error instanceof EncryptedApiError && error.status === 400, String(bad));
  }
  assert.equal(ran, false);
});

test("a second change while the first one builds is refused, and a failure frees the lock", async () => {
  const root = installation({});
  let release;
  const gate = new Promise((resolvePromise) => { release = resolvePromise; });
  let fail = false;
  const run = async (file) => {
    if (file === "docker") return "running\thealthy\n";
    await gate;
    if (fail) throw new Error("build failed");
    return "";
  };
  const api = createEncryptedApi({ repoRoot: root, run });
  const first = api.setEnabled(true);
  await assert.rejects(api.setEnabled(false), { status: 409 });
  fail = true;
  release();
  await assert.rejects(first, { status: 502 });
  fail = false;
  await assert.doesNotReject(api.setEnabled(true));
});

test("routes: reading is settings:read, switching is settings:write (never reachable with an API key)", () => {
  assert.equal(actionForRoute("/api/settings/encrypted-api", "GET"), "settings:read");
  assert.equal(actionForRoute("/api/settings/encrypted-api", "POST"), "settings:write");
});
