import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { createServer, request } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { join } from "node:path";
import { writeJsonAtomic } from "../jsonStore.js";

// Official multi-architecture images verified on 2026-10-28: cloudflared
// 2026.10.5, Tailscale 1.104.2, ngrok 3.39.13. Pin digests for repeatable setup.
// Existing user-managed connectors are discovered,
// never adopted or stopped. All Docker commands use argument arrays, not a shell.
export const HTTPS_PROVIDERS = {
  cloudflare: { image: "cloudflare/cloudflared@sha256:1b1d34d0a9c0bfca9de72db8460d328db3f19edd2b96169114e3e893a97bbe53", label: "Cloudflare Tunnel" },
  tailscale: { image: "tailscale/tailscale@sha256:b11583ad2e93e4671128538c88cf11f460444a5d7e449311dd1933a400ab849d", label: "Tailscale" },
  ngrok: { image: "ngrok/ngrok@sha256:ff3b5c3674432d14a786349908b7bdf28ee56c25662637afcbe7180d471993ef", label: "ngrok" }
};
const OWNER_LABEL = "app.dunedocker.console-https";
const HOP_HEADERS = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];
export class ConsoleHttpsError extends Error {
  constructor(message, status = 409) { super(message); this.statusCode = status; }
}
function output(command, args, { includeStderr = false, ...options } = {}) {
  return new Promise((resolve, reject) => execFile(command, args, { timeout: 15_000, maxBuffer: 512 * 1024, ...options }, (error, stdout, stderr) => error ? reject(error) : resolve(includeStderr ? stdout + stderr : stdout)));
}
function readJson(file, fallback) { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; } }
function validProvider(value) {
  if (!Object.hasOwn(HTTPS_PROVIDERS, value)) throw new ConsoleHttpsError("Choose an HTTPS provider.", 400);
  return value;
}
export function providerUrl(provider, text) {
  const pattern = provider === "cloudflare" ? /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/g
    : provider === "tailscale" ? /https:\/\/[a-z0-9.-]+\.ts\.net\b/g
      : /https:\/\/[a-z0-9-]+\.(?:ngrok-free\.app|ngrok-free\.dev|ngrok\.app|ngrok\.io|ngrok\.dev)\b/g;
  return String(text).match(pattern)?.at(-1) || "";
}
export function connectorClientIp(provider, headers) {
  // Each connector overwrites/appends its own client address. Never use the
  // leftmost XFF entry, which a public visitor can supply themselves.
  const value = provider === "cloudflare" ? headers["cf-connecting-ip"] : String(headers["x-forwarded-for"] || "").split(",").at(-1)?.trim();
  return typeof value === "string" && isIP(value) ? value : null;
}

export function createConsoleHttps({ repoRoot, host = "127.0.0.1", port, run = output, probe = verifyEndpoint } = {}) {
  const directory = join(repoRoot, "runtime/generated/console-https");
  const file = join(directory, "state.json");
  const secretFile = join(repoRoot, "runtime/secrets/console-https-proxy-key.bin");
  const ngrokFile = join(repoRoot, "runtime/secrets/console-https-ngrok.json");
  const hostRoot = process.env.DUNE_HOST_REPO_ROOT || repoRoot;
  const id = createHash("sha256").update(hostRoot).digest("hex").slice(0, 12);
  const name = `dune-console-https-${id}`;
  let state = readJson(file, {});
  let busy = false;
  let error = "";
  let phase = "";
  let relay;
  let discovery;
  let discoveryAt = 0;
  let pending;
  let timer;
  let reconciling = false;
  const challenge = randomBytes(24).toString("hex");
  const targetHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  const target = `http://${targetHost.includes(":") ? `[${targetHost}]` : targetHost}:${port}`;
  const save = () => { mkdirSync(directory, { recursive: true }); writeJsonAtomic(file, state); };
  const docker = (args, options) => run("docker", args, options);
  async function container() {
    try {
      const c = JSON.parse(await docker(["inspect", name]))[0];
      if (c.Config?.Labels?.[OWNER_LABEL] !== id) throw new ConsoleHttpsError("This connection name belongs to another container. It has been left untouched.");
      return c;
    } catch (cause) {
      if (cause instanceof ConsoleHttpsError) throw cause;
      if (/no such (?:object|container)/i.test(`${cause.stderr || ""} ${cause.message || ""}`)) return null;
      throw new ConsoleHttpsError("Docker could not check the HTTPS connector. Check the Docker service before trying again.", 503);
    }
  }
  async function discover(refresh = false) {
    if (discovery && !refresh && Date.now() - discoveryAt < 60_000) return discovery;
    const containers = String(await docker(["ps", "-a", "--format", "{{json .}}"])).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    let binaries = {};
    let hostDetection = "unavailable";
    try {
      // Read only standard host binary locations. Do not execute host binaries,
      // read their account configuration, or install packages on the host.
      const image = String(await docker(["inspect", "--format", "{{.Config.Image}}", "redblink-dune-docker-console"])).trim();
      const script = "const fs=require('fs');const out={};for(const [k,n] of Object.entries({cloudflare:'cloudflared',tailscale:'tailscale',ngrok:'ngrok'}))out[k]=['/host/usr/bin/','/host/usr/local/bin/','/host/opt/bin/'].some(p=>fs.existsSync(p+n));console.log(JSON.stringify(out))";
      binaries = JSON.parse(await docker(["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "65534:65534", "--mount", "type=bind,src=/usr,dst=/host/usr,readonly", "--entrypoint", "node", image, "-e", script]));
      hostDetection = "checked";
    } catch { /* Docker installations still appear if host binaries cannot be inspected. */ }
    discovery = Object.entries(HTTPS_PROVIDERS).map(([provider, details]) => ({
      provider, label: details.label, hostInstalled: Boolean(binaries[provider]), hostDetection,
      containers: containers.filter((c) => c.Names !== name && (provider === "cloudflare" ? /(?:^|\/)cloudflared(?=:|@|$)/.test(c.Image) : provider === "tailscale" ? /(?:^|\/)tailscale(?=:|@|$)/.test(c.Image) : /(?:^|\/)ngrok(?=:|@|$)/.test(c.Image))).map((c) => ({ name: c.Names, running: c.State === "running" }))
    }));
    discoveryAt = Date.now();
    return discovery;
  }
  async function startRelay() {
    if (relay?.listening) return;
    mkdirSync(join(repoRoot, "runtime/secrets"), { recursive: true });
    if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32), { flag: "wx", mode: 0o600 });
    const key = readFileSync(secretFile);
    if (key.length !== 32) throw new ConsoleHttpsError("The HTTPS forwarding key is invalid. Restore it before starting HTTPS.");
    relay = createServer((incoming, response) => {
      if (incoming.url === `/.well-known/dune-console-https/${challenge}`) {
        response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
        response.end(challenge); return;
      }
      const client = connectorClientIp(state.provider, incoming.headers);
      if (!client) { response.writeHead(403); response.end("The HTTPS connector did not supply a valid client address."); return; }
      const headers = { ...incoming.headers };
      for (const name of String(headers.connection || "").split(",").map((h) => h.trim().toLowerCase())) delete headers[name];
      for (const name of Object.keys(headers)) if (HOP_HEADERS.includes(name) || name.startsWith("x-dune-") || name.startsWith("x-forwarded-")) delete headers[name];
      const timestamp = String(Math.floor(Date.now() / 1000));
      headers["x-dune-console-proxy"] = "1";
      headers["x-dune-tls-client"] = client;
      headers["x-dune-tls-time"] = timestamp;
      headers["x-dune-tls-signature"] = createHmac("sha256", key).update(`${timestamp}\n${client}\n${incoming.method}\n${incoming.url}`).digest("hex");
      const upstream = request({ hostname: targetHost, port, path: incoming.url, method: incoming.method, headers }, (result) => {
        const outgoing = { ...result.headers };
        for (const name of HOP_HEADERS) delete outgoing[name];
        if (outgoing["set-cookie"]) outgoing["set-cookie"] = outgoing["set-cookie"].map((cookie) => /;\s*secure(?:;|$)/i.test(cookie) ? cookie : `${cookie}; Secure`);
        response.writeHead(result.statusCode || 502, outgoing); result.pipe(response);
      });
      upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end("The Console is restarting. Try again shortly."); });
      incoming.on("aborted", () => upstream.destroy());
      response.on("close", () => upstream.destroy());
      incoming.pipe(upstream);
    });
    await new Promise((resolve, reject) => { relay.once("error", reject); relay.listen(state.relayPort || 0, "127.0.0.1", resolve); });
    relay.on("error", () => { error = "The local HTTPS connection is unavailable. Stop it and try again."; });
    state.relayPort = relay.address().port; save();
  }
  async function connection() {
    const c = await container();
    if (!c || !c.State.Running) return { running: false, url: "", approvalUrl: "", verified: false, connectionError: busy ? "" : `The HTTPS connector is not running.${state.provider === "ngrok" ? " Check your ngrok authtoken and account limits." : ""} Stop this connection, then try setting it up again.` };
    let url = "";
    let approvalUrl = "";
    const logs = String(await docker(["logs", "--since", c.State.StartedAt, "--tail", "100", name], { includeStderr: true }).catch(() => ""));
    if (state.provider === "tailscale") {
      const ts = readJsonText(await docker(["exec", name, "tailscale", "status", "--json"]).catch(() => "{}"));
      if (ts.BackendState === "Running" && ts.Self?.DNSName) {
        const dns = String(ts.Self.DNSName).replace(/\.$/, "");
        if (/^[a-z0-9.-]+\.ts\.net$/.test(dns)) url = `https://${dns}`;
      }
      approvalUrl = safeApprovalUrl(ts.AuthURL || state.approvalUrl || logs);
    } else url = providerUrl(state.provider, logs);
    let tailnetReady = false;
    if (url && state.provider === "tailscale") {
      const serve = readJsonText(await docker(["exec", name, "tailscale", "serve", "status", "--json"]).catch(() => "{}"));
      const handlers = serve.Web?.[`${new URL(url).hostname}:443`]?.Handlers;
      tailnetReady = serve.TCP?.["443"]?.HTTPS === true && handlers?.["/"]?.Proxy === `http://127.0.0.1:${state.relayPort}`;
    }
    const verified = Boolean(url && state.provider !== "tailscale" && await probe(url, challenge));
    return { running: true, url: verified || tailnetReady ? url : "", approvalUrl, verified, tailnetReady };
  }
  async function status({ refresh = false } = {}) {
    const providers = await discover(refresh);
    const current = state.enabled ? await connection() : { running: false, url: "", approvalUrl: "", verified: false };
    return { providers, provider: state.provider || "", enabled: Boolean(state.enabled), busy, phase, target, ngrokTokenSaved: Boolean(readJson(ngrokFile, {}).authtoken), ...current, error: error || current.connectionError || "" };
  }
  async function stop() {
    if (busy) throw new ConsoleHttpsError("Wait for the current HTTPS change to finish.");
    busy = true;
    try {
      const c = await container();
      if (c) await docker(["rm", "-f", name]);
      state.enabled = false; save();
      clearInterval(timer); timer = null;
      if (relay) { relay.closeAllConnections(); await new Promise((resolve) => relay.close(resolve)); relay = null; }
      error = ""; phase = "";
    } finally { busy = false; }
  }
  function start({ provider, token, confirmed }) {
    validProvider(provider);
    if (confirmed !== true) throw new ConsoleHttpsError("Confirm who can reach the Console before starting HTTPS.", 400);
    if (busy) throw new ConsoleHttpsError("Wait for the current HTTPS change to finish.");
    if (state.enabled && state.provider !== provider) throw new ConsoleHttpsError("Stop the current HTTPS connection before choosing another provider.");
    if (provider === "ngrok") {
      token = token || readJson(ngrokFile, {}).authtoken;
      if (typeof token !== "string" || !/^[a-zA-Z0-9_-]{10,512}$/.test(token)) throw new ConsoleHttpsError("Enter your ngrok account authtoken.", 400);
    }
    busy = true; error = ""; phase = "Preparing HTTPS";
    pending = (async () => {
      try {
        let existing = await container();
        if (existing?.State.Running) { phase = "Waiting for HTTPS"; return; }
        if (existing) await docker(["rm", name]);
        state = { ...state, provider, enabled: true }; save(); await startRelay();
        const upstream = `http://127.0.0.1:${state.relayPort}`;
        const args = ["run", "-d", "--name", name, "--label", `${OWNER_LABEL}=${id}`, "--network", "host", "--restart", "unless-stopped", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--log-driver", "local", "--log-opt", "max-size=5m", "--log-opt", "max-file=2"];
        let command;
        if (provider === "cloudflare") command = ["tunnel", "--no-autoupdate", "--url", upstream];
        if (provider === "tailscale") {
          // Userspace mode avoids host VPN, routes, DNS, /dev/net/tun and capabilities.
          mkdirSync(join(repoRoot, "runtime/secrets/console-https-tailscale"), { recursive: true, mode: 0o700 });
          args.push("--user", `${process.getuid()}:${process.getgid()}`, "--tmpfs", `/var/run/tailscale:rw,uid=${process.getuid()},gid=${process.getgid()},mode=0700`, "--entrypoint", "tailscaled", "--mount", `type=bind,src=${join(hostRoot, "runtime/secrets/console-https-tailscale")},dst=/var/lib/tailscale`);
          command = ["--tun=userspace-networking", "--state=/var/lib/tailscale/tailscaled.state"];
        }
        if (provider === "ngrok") {
          writeFileSync(ngrokFile, JSON.stringify({ version: "2", authtoken: token, web_addr: false }), { mode: 0o600 }); chmodSync(ngrokFile, 0o600);
          args.push("--user", `${process.getuid()}:${process.getgid()}`, "--mount", `type=bind,src=${join(hostRoot, "runtime/secrets/console-https-ngrok.json")},dst=/config/ngrok.json,readonly`);
          command = ["http", upstream, "--config", "/config/ngrok.json", "--log", "stdout", "--log-format", "json"];
        }
        phase = "Downloading and starting connector";
        await docker([...args, HTTPS_PROVIDERS[provider].image, ...command], { timeout: 180_000 });
        if (provider === "tailscale") {
          // The login command exits only after approval. Its bounded invocation
          // records the approval URL in tailscaled; status polls then resume Serve.
          const out = await docker(["exec", name, "tailscale", "up", "--accept-dns=false", `--hostname=dune-console-${id}`, "--timeout=5s"], { timeout: 10_000, includeStderr: true }).catch((cause) => `${cause.stdout || ""}\n${cause.stderr || ""}`);
          state.approvalUrl = safeApprovalUrl(out); save();
        }
        phase = "Waiting for HTTPS";
      } catch { error = `${HTTPS_PROVIDERS[provider].label} could not start. Check Docker and your internet connection, then stop this connection and try again.${provider === "ngrok" ? " Also check your ngrok authtoken and account limits." : ""}`; phase = ""; }
      finally { token = undefined; busy = false; monitor(); }
    })();
    return { accepted: true };
  }
  async function resume() {
    if (state.enabled && Object.hasOwn(HTTPS_PROVIDERS, state.provider)) {
      try { await startRelay(); monitor(); } catch { error = "The local HTTPS forwarding port is unavailable. Stop this connection and try again."; }
    }
  }
  async function reconcile() {
    if (!state.enabled || state.provider !== "tailscale" || busy || reconciling) return;
    reconciling = true;
    try {
      const c = await container();
      if (!c?.State.Running) return;
      const ts = readJsonText(await docker(["exec", name, "tailscale", "status", "--json"]));
      if (ts.BackendState !== "Running") return;
      const serve = readJsonText(await docker(["exec", name, "tailscale", "serve", "status", "--json"]));
      const dns = String(ts.Self?.DNSName || "").replace(/\.$/, "");
      if (serve.TCP?.["443"]?.HTTPS && serve.Web?.[`${dns}:443`]?.Handlers?.["/"]?.Proxy === `http://127.0.0.1:${state.relayPort}`) return;
      const out = await docker(["exec", name, "tailscale", "serve", "--bg", "--yes", `http://127.0.0.1:${state.relayPort}`], { timeout: 8000, includeStderr: true }).catch((cause) => `${cause.stdout || ""}\n${cause.stderr || ""}`);
      state.approvalUrl = safeApprovalUrl(out); save();
    } catch { /* Status shows the pending approval or unavailable connection. */ }
    finally { reconciling = false; }
  }
  function monitor() {
    if (!state.enabled || timer) return;
    timer = setInterval(() => { void reconcile(); }, 5000); timer.unref();
    void reconcile();
  }
  return { status, discover, start, stop, resume, reconcile, settled: () => pending, close: () => { clearInterval(timer); relay?.closeAllConnections(); relay?.close(); }, target };
}
function safeApprovalUrl(text) {
  return String(text || "").match(/https:\/\/login\.tailscale\.com\/(?:a\/[a-zA-Z0-9]+|f\/serve\?[a-zA-Z0-9_=&%-]+)/)?.[0] || "";
}
function readJsonText(text) { try { return JSON.parse(text); } catch { return {}; } }
function verifyEndpoint(origin, challenge) {
  return new Promise((resolve) => {
    const req = httpsRequest(`${origin}/.well-known/dune-console-https/${challenge}`, { timeout: 4000, headers: { "ngrok-skip-browser-warning": "1" } }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; if (body.length > 1024) { res.destroy(); resolve(false); } });
      res.on("end", () => resolve(res.statusCode === 200 && body === challenge));
      res.on("error", () => resolve(false));
    });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false)); req.end();
  });
}
