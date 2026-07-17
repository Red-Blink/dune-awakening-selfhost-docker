import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

test("public probe implements a bounded WebRTC data-channel echo", () => {
  const source = readFileSync(resolve(repoRoot, "runtime/public-probe/main.go"), "utf8");
  assert.match(source, /github\.com\/pion\/webrtc\/v4/);
  assert.match(source, /maxMessageBytes\s+=\s+256/);
  assert.match(source, /messages >= 20/);
  assert.match(source, /maxSessions\s+=\s+4/);
  assert.match(source, /sessionLifetime\s+=\s+20 \* time\.Second/);
  assert.match(source, /slots:\s+make\(chan struct\{\}, maxSessions\)/);
  assert.match(source, /DUNE_PUBLIC_PROBE_SIGNAL_URL/);
  assert.match(source, /https:\/\/dunedocker\.app\//);
});

test("public probe does not publish ports and runs with restricted privileges", () => {
  const compose = readFileSync(resolve(repoRoot, "docker-compose.public-probe.yml"), "utf8");
  const hostCompose = readFileSync(resolve(repoRoot, "docker-compose.public-probe-host.yml"), "utf8");
  assert.doesNotMatch(compose, /^\s+ports:/m);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:\s*\n\s+- ALL/);
  assert.match(compose, /DUNE_PUBLIC_PROBE_SECRET/);
  assert.match(compose, /cpus: "0\.50"/);
  assert.match(compose, /mem_limit: 128m/);
  assert.match(compose, /pids_limit: 64/);
  assert.doesNotMatch(compose, /NET_BIND_SERVICE/);
  assert.match(hostCompose, /network_mode: host/);
  assert.doesNotMatch(hostCompose, /^\s+ports:/m);
});

test("public probe image runs as an unprivileged dedicated user", () => {
  const dockerfile = readFileSync(resolve(repoRoot, "runtime/public-probe/Dockerfile"), "utf8");
  assert.match(dockerfile, /FROM golang:1\.25-alpine AS build/);
  assert.match(dockerfile, /USER probe/);
  assert.match(dockerfile, /CGO_ENABLED=0/);
  assert.match(dockerfile, /HEALTHCHECK .*kill -0 1/);
});

test("public probe lifecycle script is executable and supports clean shutdown", () => {
  const scriptPath = resolve(repoRoot, "runtime/scripts/public-probe.sh");
  const script = readFileSync(scriptPath, "utf8");
  assert.equal(statSync(scriptPath).mode & 0o111, 0o111);
  assert.match(script, /compose build dune-public-probe/);
  assert.match(script, /public-probe-build\.sha256/);
  assert.match(script, /compose up -d/);
  assert.match(script, /compose down --remove-orphans/);
  assert.match(script, /use_host_network/);
  assert.match(script, /microsoft\|wsl/);
  assert.match(script, /native Linux LAN discovery/);
  assert.match(script, /outbound-only WebRTC compatibility mode/);
  assert.match(script, /DUNE_PUBLIC_PROBE_FORCE_BRIDGE=true compose up -d/);
});

test("public probe lifecycle does not block the Console event loop", () => {
  const source = readFileSync(resolve(repoRoot, "console/api/src/services/publicDirectory.js"), "utf8");
  assert.doesNotMatch(source, /execFileSync/);
  assert.match(source, /await runCommand\(script, \["reconcile"\]/);
  assert.match(source, /await execFileOutput\("docker"/);
});
