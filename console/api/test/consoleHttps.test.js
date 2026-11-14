import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConsoleHttps, connectorClientIp, providerUrl } from "../src/services/consoleHttps.js";
import { tlsClientAddress } from "../src/services/tlsClientAddress.js";
import { actionForRoute } from "../src/actions.js";
import { evaluate } from "../src/policy.js";

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "dune-https-test-"));
  const calls = [];
  let c = null;
  let discoveryContainers = [];
  let logs = "https://verified-example.trycloudflare.com";
  let serve = {};
  let ts = {};
  let unavailable = false;
  const run = async (command, args) => {
    assert.equal(command, "docker"); calls.push(args);
    if (unavailable) throw new Error("Docker is unavailable");
    if (args[0] === "ps") return discoveryContainers.map(JSON.stringify).join("\n");
    if (args[0] === "inspect" && args[1] === "--format") return "local-console:test";
    if (args[0] === "inspect") { if (!c) throw new Error("No such container"); return JSON.stringify([c]); }
    if (args[0] === "run" && args.includes("--rm")) return JSON.stringify({ cloudflare: true, tailscale: false, ngrok: true });
    if (args[0] === "run") {
      const id = args[args.indexOf("--label") + 1].split("=")[1];
      c = { Config: { Labels: { "app.dunedocker.console-https": id } }, State: { Running: true, StartedAt: "2026-10-28T00:00:00Z" } }; return "created";
    }
    if (args[0] === "rm") { c = null; return "removed"; }
    if (args[0] === "logs") return logs;
    if (args[0] === "exec" && args[3] === "status") return JSON.stringify(ts);
    if (args[0] === "exec" && args[3] === "serve" && args[4] === "status") return JSON.stringify(serve);
    if (args[0] === "exec" && args[3] === "serve") return "https://login.tailscale.com/f/serve?node=test";
    if (args[0] === "exec" && args[3] === "up") return "https://login.tailscale.com/a/testapproval";
    throw new Error(`Unexpected Docker operation: ${args[0]}`);
  };
  const service = createConsoleHttps({ repoRoot: root, host: "192.0.2.10", port: 9099, run, probe: async () => true, ...options });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  return { service, root, calls, setContainer: (value) => { c = value; }, setDiscovery: (value) => { discoveryContainers = value; }, setLogs: (value) => { logs = value; }, setTs: (value) => { ts = value; }, setServe: (value) => { serve = value; }, unavailable: () => { unavailable = true; }, state: () => JSON.parse(readFileSync(join(root, "runtime/generated/console-https/state.json"))) };
}

test("detects host and Docker installations without adopting or changing them", async (t) => {
  const f = fixture(t);
  f.setDiscovery([{ Names: "my-cloudflare", Image: "cloudflare/cloudflared:old", State: "running" }, { Names: "my-vpn", Image: "tailscale/tailscale:stable", State: "exited" }]);
  const result = await f.service.status();
  assert.equal(result.target, "http://192.0.2.10:9099");
  assert.equal(result.providers[0].hostInstalled, true);
  assert.deepEqual(result.providers[0].containers, [{ name: "my-cloudflare", running: true }]);
  assert.deepEqual(result.providers[1].containers, [{ name: "my-vpn", running: false }]);
  assert.equal(f.calls.some((a) => ["rm", "stop", "exec", "pull"].includes(a[0])), false);
  const helper = f.calls.find((a) => a[0] === "run");
  assert.ok(helper.includes("none") && helper.includes("--read-only") && helper.includes("65534:65534"));
  const firstCalls = f.calls.length; await f.service.status();
  assert.equal(f.calls.length, firstCalls, "installation detection is cached");
});

test("start requires exposure confirmation, allowlisted provider and valid ngrok token", (t) => {
  const f = fixture(t);
  assert.throws(() => f.service.start({ provider: "cloudflare" }), /Confirm/);
  assert.throws(() => f.service.start({ provider: "$(touch bad)", confirmed: true }), /Choose/);
  assert.throws(() => f.service.start({ provider: "__proto__", confirmed: true }), /Choose/);
  assert.throws(() => f.service.start({ provider: "ngrok", confirmed: true, token: "bad\nvalue" }), /authtoken/);
  assert.equal(f.calls.length, 0);
});

test("managed Cloudflare lifecycle uses a stable local relay and verifies its public URL", async (t) => {
  const f = fixture(t);
  f.service.start({ provider: "cloudflare", confirmed: true });
  assert.throws(() => f.service.start({ provider: "cloudflare", confirmed: true }), /Wait/);
  await f.service.settled();
  const start = f.calls.find((a) => a[0] === "run" && a.includes("--name"));
  assert.ok(start.includes(`http://127.0.0.1:${f.state().relayPort}`));
  const status = await f.service.status();
  assert.equal(status.url, "https://verified-example.trycloudflare.com");
  assert.equal(status.verified, true);
  assert.throws(() => f.service.start({ provider: "tailscale", confirmed: true }), /Stop/);
  await f.service.stop();
  assert.equal((await f.service.status()).enabled, false);
  assert.equal(f.calls.filter((a) => a[0] === "rm").length, 1);
});

test("unverified public endpoints are not offered as ready", async (t) => {
  const f = fixture(t, { probe: async () => false });
  f.service.start({ provider: "cloudflare", confirmed: true }); await f.service.settled();
  const status = await f.service.status(); assert.equal(status.url, ""); assert.equal(status.verified, false);
});

test("ngrok credentials stay in a private file, out of Docker arguments and responses", async (t) => {
  const f = fixture(t); const token = "synthetic_account_credential";
  f.service.start({ provider: "ngrok", confirmed: true, token }); await f.service.settled();
  const secret = join(f.root, "runtime/secrets/console-https-ngrok.json");
  assert.equal(JSON.parse(readFileSync(secret)).authtoken, token);
  assert.equal(statSync(secret).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(f.calls).includes(token), false);
  assert.equal(JSON.stringify(await f.service.status()).includes(token), false);
  assert.equal(JSON.stringify(f.state()).includes(token), false);
  await f.service.stop();
  f.service.start({ provider: "ngrok", confirmed: true }); await f.service.settled();
  assert.equal((await f.service.status()).ngrokTokenSaved, true);
  assert.equal(JSON.parse(readFileSync(secret)).authtoken, token, "restarting reuses the private saved token");
});

test("Tailscale account approval resumes a private Serve connection without host network changes", async (t) => {
  const f = fixture(t);
  f.service.start({ provider: "tailscale", confirmed: true }); await f.service.settled();
  assert.equal((await f.service.status()).approvalUrl, "https://login.tailscale.com/a/testapproval");
  f.setTs({ BackendState: "Running", Self: { DNSName: "dune.test.ts.net." } });
  await f.service.reconcile();
  assert.ok(f.calls.find((a) => a[3] === "serve" && a.includes("--bg")));
  f.setServe({ TCP: { "443": { HTTPS: true } }, Web: { "dune.test.ts.net:443": { Handlers: { "/": { Proxy: `http://127.0.0.1:${f.state().relayPort}` } } } } });
  const result = await f.service.status();
  assert.equal(result.url, "https://dune.test.ts.net");
  assert.equal(result.tailnetReady, true); assert.equal(result.verified, false, "tailnet configuration is distinct from an external HTTPS probe");
  assert.equal(f.calls.some((a) => a.includes("--privileged") || a.includes("net_admin") || a.includes("/dev/net/tun")), false);
});

test("foreign containers and an unreachable Docker daemon never produce a false stopped state", async (t) => {
  const f = fixture(t);
  f.setContainer({ Config: { Labels: {} }, State: { Running: true } });
  await assert.rejects(f.service.stop(), /another container/);
  assert.equal(f.calls.some((a) => a[0] === "rm"), false);
  f.unavailable(); await assert.rejects(f.service.stop(), /Docker could not check/);
});

test("relay follows a changed Console port across restarts, preserves requests and signs the real client", async (t) => {
  const received = [];
  const backend = createServer((req, res) => {
    received.push({ url: req.url, ip: tlsClientAddress(req, f.root), headers: req.headers });
    res.writeHead(200, { "set-cookie": "session=synthetic; HttpOnly" }); req.pipe(res);
  });
  backend.listen(0, "127.0.0.1"); await once(backend, "listening");
  t.after(() => { backend.closeAllConnections(); backend.close(); });
  const f = fixture(t, { host: "0.0.0.0", port: backend.address().port });
  f.service.start({ provider: "cloudflare", confirmed: true }); await f.service.settled();
  const relayPort = f.state().relayPort;
  const response = await fetch(`http://127.0.0.1:${relayPort}/api/test?value=1`, { method: "POST", headers: { "cf-connecting-ip": "203.0.113.44", "x-dune-tls-client": "198.51.100.1", "x-dune-tls-signature": "forged", "x-forwarded-for": "198.51.100.1" }, body: "payload" });
  assert.equal(await response.text(), "payload"); assert.match(response.headers.get("set-cookie"), /; Secure/);
  assert.equal(received[0].ip, "203.0.113.44"); assert.equal(received[0].url, "/api/test?value=1");
  assert.equal(received[0].headers["x-forwarded-for"], undefined);
  assert.equal((await fetch(`http://127.0.0.1:${relayPort}/api/test`)).status, 403);
  f.service.close(); await new Promise((r) => setTimeout(r, 20));
  const nextBackend = createServer((req, res) => { res.end("new port"); });
  nextBackend.listen(0, "127.0.0.1"); await once(nextBackend, "listening");
  t.after(() => { nextBackend.closeAllConnections(); nextBackend.close(); });
  const next = createConsoleHttps({ repoRoot: f.root, host: "127.0.0.1", port: nextBackend.address().port });
  t.after(() => next.close()); await next.resume();
  assert.equal((await fetch(`http://127.0.0.1:${relayPort}/`, { headers: { "cf-connecting-ip": "203.0.113.44" } })).status, 200);
  const changed = await fetch(`http://127.0.0.1:${relayPort}/`, { headers: { "cf-connecting-ip": "203.0.113.44" } });
  assert.equal(await changed.text(), "new port");
});

test("provider client identity uses trusted connector output and settings remain owner-only", () => {
  assert.equal(connectorClientIp("ngrok", { "x-forwarded-for": "192.0.2.1, 203.0.113.8" }), "203.0.113.8");
  assert.equal(connectorClientIp("tailscale", { "x-forwarded-for": "not-an-ip" }), null);
  assert.equal(providerUrl("cloudflare", "https://unrelated.example"), "");
  assert.equal(providerUrl("ngrok", "url=https://test.ngrok-free.dev"), "https://test.ngrok-free.dev");
  for (const method of ["GET", "POST"]) {
    const action = actionForRoute("/api/settings/console-https", method);
    assert.ok(action); assert.equal(evaluate({ tier: "owner" }, action), true);
    for (const tier of ["admin", "moderator", "player"]) assert.equal(evaluate({ tier }, action), false);
  }
});
