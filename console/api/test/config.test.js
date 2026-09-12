import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, publicConfig, readConsoleBuildId, resolvePorts, APP_NAME } from "../src/config.js";

test("frontend build ID changes when the built entry file changes", () => {
  const staticDir = mkdtempSync(join(tmpdir(), "arrakis-build-id-"));
  try {
    writeFileSync(join(staticDir, "index.html"), '<script src="/assets/index-build-a.js"></script>');
    const first = readConsoleBuildId(staticDir, "v1.0.0");
    writeFileSync(join(staticDir, "index.html"), '<script src="/assets/index-build-b.js"></script>');
    const second = readConsoleBuildId(staticDir, "v1.0.0");

    assert.notEqual(first, second);
    assert.match(first, /^[a-f0-9]{16}$/);
    assert.match(second, /^[a-f0-9]{16}$/);
  } finally {
    rmSync(staticDir, { recursive: true, force: true });
  }
});

test("web config exposes safe deployment flags and JSON body limit", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "arrakis-config-"));
  const previous = { ...process.env };
  process.env.DUNE_DOCKER_DIR = repoRoot;
  process.env.NODE_ENV = "production";
  process.env.ADMIN_MAX_JSON_BYTES = "12345";
  try {
    const config = loadConfig();
    assert.equal(config.secureCookies, true);
    assert.equal(config.maxJsonBytes, 12345);
    const exposed = publicConfig(config);
    assert.equal(exposed.secureCookies, true);
    assert.equal(exposed.authDisabled, false);
    assert.equal(exposed.mockMode, false);
    assert.equal(Object.hasOwn(exposed, "adminPassword"), false);
    assert.equal(Object.hasOwn(exposed, "sessionSecret"), false);

    process.env.ADMIN_SECURE_COOKIES = "0";
    assert.equal(loadConfig().secureCookies, false);
  } finally {
    process.env = previous;
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// #690: totpIssuer itself is just the static fallback (APP_NAME) -- the real,
// live SERVER_TITLE-based issuer is computed per-request from the .env FILE
// in the /api/auth/2fa/setup route handler, not baked into boot-time config
// via process.env (docker-compose.web.yml's environment: passthrough doesn't
// carry SERVER_TITLE, so a process.env-based version of this silently never
// worked -- found live). See totpOptIn.integration.test.js's two issuer
// tests for the real, route-level coverage.
test("totpIssuer is the static fallback app name", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "arrakis-config-"));
  const previous = { ...process.env };
  process.env.DUNE_DOCKER_DIR = repoRoot;
  try {
    assert.equal(loadConfig().totpIssuer, APP_NAME);
  } finally {
    process.env = previous;
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// Regression guard: a full-codebase audit found 6 places hardcoded
// stock port values instead of reading them from a shared source,
// breaking any deployment running non-default configured ports. This
// test must fail if any consumer ever reverts to reading process.env
// directly instead of going through resolvePorts()/config.ports.
//
// This test covers the SERVICE ports (Postgres/RMQ/TextRouter/
// Director/Prometheus), which really are env-var-configured with no
// other source of truth -- confirmed against runtime-env.sh's
// resolve_*_port() functions, which read process.env the same way.
test("resolvePorts() honors configured (non-default) service ports, does not silently fall back to stock values", () => {
  const configuredEnv = {
    POSTGRES_PORT: "16432",
    RMQ_ADMIN_PORT: "33573",
    RMQ_GAME_PORT: "32982",
    RMQ_GAME_HTTP_PORT: "32983",
    RMQ_GAME_LOCAL_HTTP_PORT: "16672",
    TEXT_ROUTER_PORT: "6059",
    DIRECTOR_PORT: "12717",
    METRICS_PROMETHEUS_PORT: "10090"
  };
  const ports = resolvePorts(configuredEnv, "/nonexistent-repo-root-for-this-test");
  assert.equal(ports.postgres, 16432);
  assert.equal(ports.rmqAdmin, 33573);
  assert.equal(ports.rmqGame, 32982);
  assert.equal(ports.rmqGameHttp, 32983);
  assert.equal(ports.rmqGameLocalHttp, 16672);
  assert.equal(ports.textRouter, 6059);
  assert.equal(ports.director, 12717);
  assert.equal(ports.metricsPrometheus, 10090);
});

test("resolvePorts() falls back to stock values when nothing is configured and no profile file exists", () => {
  const ports = resolvePorts({}, "/nonexistent-repo-root-for-this-test");
  assert.deepEqual(ports, {
    postgres: 15432,
    rmqAdmin: 32573,
    rmqGame: 31982,
    rmqGameHttp: 31983,
    rmqGameLocalHttp: 15672,
    textRouter: 5059,
    director: 11717,
    metricsPrometheus: 9090,
    clientBase: 7777,
    clientBaseSecondary: 7778,
    igwBase: 7888,
    igwBaseSecondary: 7889
  });
});

// This is the REAL, authoritative source for Player/Game and IGW base
// ports: runtime/generated/gameplay-profile.ini's [Engine:URL] section
// (written by runtime/scripts/usersettings.py engine-set, e.g. via the
// Maps UI or multi-server-config.py) -- NOT an env var. A prior version
// of this test only validated CLIENT_PORT_BASE/IGW_PORT_BASE env vars,
// which are documented as secondary "compatibility/console metadata"
// only -- that test passed while the underlying implementation used
// the wrong source of truth, exactly the kind of gap a Requirement 20
// Layer 1/QA audit is meant to catch (found retroactively; see PR
// history). This test exercises the real mechanism directly.
test("resolvePorts() reads Player/Game and IGW base ports from gameplay-profile.ini, the real authoritative source (not .env)", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "arrakis-config-profile-"));
  try {
    mkdirSync(join(repoRoot, "runtime", "generated"), { recursive: true });
    writeFileSync(
      join(repoRoot, "runtime", "generated", "gameplay-profile.ini"),
      "; UserGame.ini managed by Docker.\n\n[Engine:URL]\nIGWPort=8888\n\nPort=8777\n"
    );
    // Deliberately set a DIFFERENT, stale value in .env to prove the
    // profile file wins -- this is exactly the staleness scenario a
    // real deployment could hit if an operator changed the port via
    // the Maps UI without also updating .env.
    const staleEnv = { CLIENT_PORT_BASE: "9999", IGW_PORT_BASE: "9998" };
    const ports = resolvePorts(staleEnv, repoRoot);
    assert.equal(ports.clientBase, 8777, "profile file's Port must win over stale .env CLIENT_PORT_BASE");
    assert.equal(ports.clientBaseSecondary, 8778);
    assert.equal(ports.igwBase, 8888, "profile file's IGWPort must win over stale .env IGW_PORT_BASE");
    assert.equal(ports.igwBaseSecondary, 8889);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// Requirement 20 Layer 3 (integration) audit finding, CRITICAL,
// independently reproduced: this test previously asserted
// resolvePorts() falls back to .env's CLIENT_PORT_BASE/IGW_PORT_BASE
// when gameplay-profile.ini doesn't exist yet -- that passed, but was
// testing the WRONG behavior. The real shell/Python resolver
// (runtime-env.sh's usersettings_engine_value(), which every game-server
// start/stop script actually calls) never reads .env for these two
// fields at all; its real fallback is runtime/generated/
// usersettings.json's legacy "engine" config, then the stock literal.
// Directly reproduced the divergence before this fix: with
// CLIENT_PORT_BASE=7001 in .env and no profile file, Node returned 7001
// while the real Python tool returned stock 7777 -- the Web UI could
// show a port the game server's own startup scripts would never
// actually bind to. This test now asserts the CORRECT chain: .env is
// NOT consulted for these two fields; usersettings.json is.
test("resolvePorts() does NOT fall back to .env CLIENT_PORT_BASE/IGW_PORT_BASE when gameplay-profile.ini doesn't exist yet -- matches the real shell/Python resolver, which never reads .env for these fields", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "arrakis-config-no-profile-"));
  try {
    // .env has a configured value, but no profile file and no
    // usersettings.json exist yet -- the real shell/Python resolver
    // would return stock defaults here, ignoring .env entirely. Node
    // must agree.
    const ports = resolvePorts({ CLIENT_PORT_BASE: "8777", IGW_PORT_BASE: "8888" }, repoRoot);
    assert.equal(ports.clientBase, 7777, ".env's CLIENT_PORT_BASE must NOT be used -- the real shell/Python resolver never reads it for this field");
    assert.equal(ports.igwBase, 7888, ".env's IGW_PORT_BASE must NOT be used -- the real shell/Python resolver never reads it for this field");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// This is the SECOND step of the real fallback chain (profile file ->
// usersettings.json's legacy engine config -> stock) -- see
// runtime-env.sh's usersettings_engine_value() and usersettings.py's
// load_config()/ENGINE_FIELDS for the authoritative implementation this
// mirrors. usersettings.json is written by `dune init`/materialize
// before the first gameplay-profile.ini exists, or is read directly by
// runtime-env.sh's Python fallback when the profile file is missing.
test("resolvePorts() falls back to runtime/generated/usersettings.json's legacy engine config when gameplay-profile.ini doesn't exist yet", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "arrakis-config-legacy-"));
  try {
    mkdirSync(join(repoRoot, "runtime", "generated"), { recursive: true });
    writeFileSync(
      join(repoRoot, "runtime", "generated", "usersettings.json"),
      JSON.stringify({ engine: { port: "8001", igw_port: "8002" }, maps: {}, partitions: {} })
    );
    const ports = resolvePorts({}, repoRoot);
    assert.equal(ports.clientBase, 8001);
    assert.equal(ports.igwBase, 8002);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("resolvePorts() falls back to stock values when neither gameplay-profile.ini nor usersettings.json exist", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "arrakis-config-nothing-"));
  try {
    const ports = resolvePorts({}, repoRoot);
    assert.equal(ports.clientBase, 7777);
    assert.equal(ports.igwBase, 7888);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("resolvePorts() prefers gameplay-profile.ini over usersettings.json when both exist", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "arrakis-config-both-"));
  try {
    mkdirSync(join(repoRoot, "runtime", "generated"), { recursive: true });
    writeFileSync(
      join(repoRoot, "runtime", "generated", "usersettings.json"),
      JSON.stringify({ engine: { port: "9001", igw_port: "9002" }, maps: {}, partitions: {} })
    );
    writeFileSync(
      join(repoRoot, "runtime", "generated", "gameplay-profile.ini"),
      "[Engine:URL]\nPort=8001\nIGWPort=8002\n"
    );
    const ports = resolvePorts({}, repoRoot);
    assert.equal(ports.clientBase, 8001, "gameplay-profile.ini must win over usersettings.json's legacy config");
    assert.equal(ports.igwBase, 8002, "gameplay-profile.ini must win over usersettings.json's legacy config");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// Requirement 20 Layer 3 (integration) audit finding, HIGH: if a
// section has a duplicate key (Port= appearing twice -- usersettings.py's
// own _advanced_editor_duplicate_key_warnings() explicitly anticipates
// this as a real, reachable state), the real Python tool the game
// server uses to materialize this file (profile_get_key(), which
// iterates reversed(block["lines"])) takes the LAST occurrence.
// Directly reproduced the divergence before this fix: Node's
// first-match regex returned 7777 for a fixture where Python's
// last-match logic returned 9999 -- the Web UI would have shown a
// different port than the one the engine actually bound to.
test("resolvePorts() takes the LAST occurrence of a duplicate Port/IGWPort key, matching usersettings.py's profile_get_key() (reversed iteration)", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "arrakis-config-dup-"));
  try {
    mkdirSync(join(repoRoot, "runtime", "generated"), { recursive: true });
    writeFileSync(
      join(repoRoot, "runtime", "generated", "gameplay-profile.ini"),
      "[Engine:URL]\nPort=7777\nPort=9999\nIGWPort=8001\nIGWPort=8888\n"
    );
    const ports = resolvePorts({}, repoRoot);
    assert.equal(ports.clientBase, 9999, "the LAST Port= line must win, matching usersettings.py's reversed() iteration");
    assert.equal(ports.igwBase, 8888, "the LAST IGWPort= line must win, matching usersettings.py's reversed() iteration");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("publicConfig() exposes ports to the frontend", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "arrakis-config-ports-"));
  const previous = { ...process.env };
  process.env.DUNE_DOCKER_DIR = repoRoot;
  process.env.POSTGRES_PORT = "16432";
  try {
    const config = loadConfig();
    const exposed = publicConfig(config);
    assert.equal(exposed.ports.postgres, 16432);
    assert.equal(exposed.ports.rmqGame, 31982);
  } finally {
    process.env = previous;
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// Layer 2 audit regression: config.ports is a getter, not a value
// snapshotted once at loadConfig() time. loadConfig() is only called
// once at process startup (see server.js's top-level `const config =
// loadConfig()`), but gameplay-profile.ini can be rewritten by the Maps
// UI at any point during the process's lifetime without a console
// restart -- a plain value would silently reintroduce the exact
// staleness bug this PR's first commit fixed (correct once at boot,
// stale forever after the first Maps UI port change). This test
// simulates that exact sequence: load config, THEN write the profile
// file, and confirms config.ports reflects the new value without
// calling loadConfig() again.
test("config.ports re-reads gameplay-profile.ini live, not just at loadConfig() time", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "arrakis-config-live-"));
  const previous = { ...process.env };
  process.env.DUNE_DOCKER_DIR = repoRoot;
  try {
    const config = loadConfig();
    // No profile file yet -- falls back to stock.
    assert.equal(config.ports.clientBase, 7777);
    assert.equal(config.ports.igwBase, 7888);

    // Simulate the Maps UI writing a new port via usersettings.py
    // engine-set, entirely independent of this already-loaded config
    // object and without any console restart.
    mkdirSync(join(repoRoot, "runtime", "generated"), { recursive: true });
    writeFileSync(
      join(repoRoot, "runtime", "generated", "gameplay-profile.ini"),
      "[Engine:URL]\nPort=8001\nIGWPort=8002\n"
    );

    assert.equal(config.ports.clientBase, 8001, "config.ports must reflect the live profile file, not a boot-time snapshot");
    assert.equal(config.ports.igwBase, 8002, "config.ports must reflect the live profile file, not a boot-time snapshot");

    // publicConfig() (the /api/auth/state payload) must also see the
    // live value on every call, not a stale copy from an earlier call.
    assert.equal(publicConfig(config).ports.clientBase, 8001);
  } finally {
    process.env = previous;
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// Layer 2 audit regression: readEnginePortsFromProfile()'s section-
// boundary regex relies on multiline `$` to find the end of the
// [Engine:URL] section. `$` matches before `\n` but not before a `\r`
// that precedes it, so an unnormalized CRLF file caused the section
// boundary to be found one line early, silently dropping whichever key
// (Port or IGWPort) came last in the section. usersettings.py always
// writes LF-only on this project's Linux hosts, so this guards a
// narrow but real edge case (hand-edited/out-of-band files).
test("resolvePorts() parses gameplay-profile.ini correctly with CRLF line endings", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "arrakis-config-crlf-"));
  try {
    mkdirSync(join(repoRoot, "runtime", "generated"), { recursive: true });
    writeFileSync(
      join(repoRoot, "runtime", "generated", "gameplay-profile.ini"),
      "[Engine:URL]\r\nPort=7777\r\nIGWPort=7888\r\n\r\n[Engine:ConsoleVariables]\r\n"
    );
    const ports = resolvePorts({}, repoRoot);
    assert.equal(ports.clientBase, 7777, "Port must be parsed from a CRLF-encoded profile file");
    assert.equal(ports.igwBase, 7888, "IGWPort (the last key in the section) must not be silently dropped on CRLF files");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// Layer 2 audit regression: a corrupted/malformed gameplay-profile.ini
// could previously produce an out-of-range port value (e.g. Port=0 or a
// 10-digit garbage number) that bypassed portValue()'s range validation
// entirely, since the nullish-coalescing fallback only ran portValue()
// on the .env/stock branch, never on the profile-file branch.
test("resolvePorts() ignores an out-of-range Port/IGWPort parsed from a corrupted gameplay-profile.ini", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "arrakis-config-corrupt-"));
  try {
    mkdirSync(join(repoRoot, "runtime", "generated"), { recursive: true });
    writeFileSync(
      join(repoRoot, "runtime", "generated", "gameplay-profile.ini"),
      "[Engine:URL]\nPort=999999999\nIGWPort=0\n"
    );
    const ports = resolvePorts({ CLIENT_PORT_BASE: "7777", IGW_PORT_BASE: "7888" }, repoRoot);
    assert.equal(ports.clientBase, 7777, "an out-of-range Port must fall back to .env/stock, not pass through unvalidated");
    assert.equal(ports.igwBase, 7888, "an out-of-range IGWPort must fall back to .env/stock, not pass through unvalidated");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// Upstream review finding: if [Engine:URL] is absent entirely, the
// previous implementation fell back to scanning the WHOLE profile file
// for a Port=/IGWPort= match, which could silently pick up an unrelated
// key from a different section (here, [Engine:ConsoleVariables]'s own
// Port= override -- a real key some UE-based configs use for something
// unrelated to the game server's own bind port) and report it as the
// real game port. The real Python tool (usersettings.py's
// profile_get_key()) only ever looks inside the named section; if the
// section doesn't exist, it returns nothing for that key.
test("resolvePorts() does not read Port/IGWPort from an unrelated section when [Engine:URL] is missing", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "arrakis-config-wrong-section-"));
  try {
    mkdirSync(join(repoRoot, "runtime", "generated"), { recursive: true });
    writeFileSync(
      join(repoRoot, "runtime", "generated", "gameplay-profile.ini"),
      "[Engine:ConsoleVariables]\nPort=1234\nIGWPort=1235\n"
    );
    const ports = resolvePorts({}, repoRoot);
    assert.equal(ports.clientBase, 7777, "a Port= key in an unrelated section must not be treated as the real game port");
    assert.equal(ports.igwBase, 7888, "an IGWPort= key in an unrelated section must not be treated as the real IGW port");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// Upstream review finding: portValue() only range-checks the base port
// itself (1-65535), but each base is really the start of a 34-slot
// range used across the maximum 34 world partitions this project
// supports (see spawn-server.sh's game_end=$((CLIENT_PORT_BASE + 33))).
// A base near the top of the valid range can still cause the derived
// end-of-range port to overflow past 65535, which is exactly as
// unusable as an already-out-of-range base.
test("resolvePorts() rejects a Port/IGWPort base whose +33 partition range would exceed 65535", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "arrakis-config-overflow-"));
  try {
    mkdirSync(join(repoRoot, "runtime", "generated"), { recursive: true });
    writeFileSync(
      join(repoRoot, "runtime", "generated", "gameplay-profile.ini"),
      "[Engine:URL]\nPort=65510\nIGWPort=65520\n"
    );
    const ports = resolvePorts({}, repoRoot);
    assert.equal(ports.clientBase, 7777, "a Port base whose +33 range overflows 65535 must fall back to stock");
    assert.equal(ports.igwBase, 7888, "an IGWPort base whose +33 range overflows 65535 must fall back to stock");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("resolvePorts() accepts a Port/IGWPort base whose +33 partition range exactly reaches 65535", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "arrakis-config-boundary-"));
  try {
    mkdirSync(join(repoRoot, "runtime", "generated"), { recursive: true });
    writeFileSync(
      join(repoRoot, "runtime", "generated", "gameplay-profile.ini"),
      "[Engine:URL]\nPort=65502\nIGWPort=65502\n"
    );
    const ports = resolvePorts({}, repoRoot);
    assert.equal(ports.clientBase, 65502, "a base whose +33 range lands exactly on 65535 must be accepted");
    assert.equal(ports.igwBase, 65502, "a base whose +33 range lands exactly on 65535 must be accepted");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
