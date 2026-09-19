import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("local-state backup snapshots active audit files and keeps archive failures fatal", () => {
  const root = mkdtempSync(join(tmpdir(), "arrakis-state-snapshot-"));
  try {
    const source = readFileSync(join(repoRoot, "runtime/scripts/self-update.sh"), "utf8");
    const fn = source.slice(source.indexOf("backup_local_state() {"), source.indexOf("\nrestore_local_state_file_if_needed()"));
    const generated = join(root, "runtime/generated"), bin = join(root, "bin"), backup = join(root, "backup");
    mkdirSync(generated, { recursive: true }); mkdirSync(bin); mkdirSync(backup);
    const audit = join(generated, "care-package-grants.jsonl");
    writeFileSync(audit, '{"id":1}\n{"partial":', { mode: 0o600 });
    writeFileSync(join(generated, "care-package-grant-receipts.json"), '[{"kitId":"starter"}]', { mode: 0o600 });
    writeFileSync(join(generated, "care-package-first-online-claims.json"), '{"version":1,"players":{},"aliases":{}}', { mode: 0o600 });
    writeFileSync(join(root, ".env"), "TEST_SETTING=preserved\n", { mode: 0o600 });
    const realTar = spawnSync("which", ["tar"], { encoding: "utf8" }).stdout.trim();
    // Start an active writer only once tar is invoked: the snapshot must be isolated.
    writeFileSync(join(bin, "tar"), `#!/usr/bin/env bash
set -eu
if [ "\${FAIL_ARCHIVE:-0}" = 1 ]; then exit 2; fi
(while true; do printf '%s\\n' '{"id":2}' >> "$AUDIT"; sleep .001; done) &
writer=$!
trap 'kill "$writer" 2>/dev/null || true; wait "$writer" 2>/dev/null || true' EXIT
sleep .05
"$REAL_TAR" "$@"
`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, AUDIT: audit, REAL_TAR: realTar };
    const run = (extra={}) => spawnSync("bash", ["-c", `set -euo pipefail\n${fn}\nbackup_local_state "$1"`, "test", backup], { cwd: root, env: { ...env, ...extra }, encoding: "utf8" });
    const result = run(); assert.equal(result.status, 0, result.stderr);
    const archive = join(backup, "local-state.tgz");
    const extract = path => spawnSync(realTar, ["-xOzf", archive, path], { encoding: "utf8" });
    assert.equal(extract("runtime/generated/care-package-grants.jsonl").stdout, '{"id":1}\n');
    assert.equal(extract(".env").stdout, "TEST_SETTING=preserved\n");
    assert.equal(extract("runtime/generated/care-package-grant-receipts.json").stdout, '[{"kitId":"starter"}]');
    assert.equal(extract("runtime/generated/care-package-first-online-claims.json").stdout, '{"version":1,"players":{},"aliases":{}}');
    assert.equal(statSync(archive).mode & 0o777, 0o600);
    assert.ok(readFileSync(audit,"utf8").includes('{"id":2}'));
    assert.equal(readdirSync(backup).some(name=>name.startsWith(".local-state")), false);
    const original = readFileSync(archive);
    assert.notEqual(run({ FAIL_ARCHIVE: "1" }).status, 0);
    assert.deepEqual(readFileSync(archive), original, "failed archive cannot replace the last good backup");
    assert.equal(readdirSync(backup).some(name=>name.startsWith(".local-state")), false);
    mkdirSync(join(generated, "usersettings.json"));
    assert.notEqual(run().status, 0, "unreadable state must fail the backup");
    assert.deepEqual(readFileSync(archive), original);
    assert.equal(readdirSync(backup).some(name=>name.startsWith(".local-state")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("self-update check prefers the official upstream release repo in fork checkouts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-self-update-"));
  mkdirSync(join(dir, "runtime", "scripts"), { recursive: true });
  copyFileSync(join(repoRoot, "runtime", "scripts", "self-update.sh"), join(dir, "runtime", "scripts", "self-update.sh"));
  copyFileSync(join(repoRoot, "runtime", "scripts", "compose-project.sh"), join(dir, "runtime", "scripts", "compose-project.sh"));
  chmodSync(join(dir, "runtime", "scripts", "self-update.sh"), 0o700);
  writeFileSync(join(dir, "VERSION"), "v1.3.37\n");

  assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
  assert.equal(spawnSync("git", ["remote", "add", "origin", "git@github.com:yacketrj/dune-awakening-selfhost-docker-WSL.git"], { cwd: dir }).status, 0);
  assert.equal(spawnSync("git", ["remote", "add", "upstream", "https://github.com/Red-Blink/dune-awakening-selfhost-docker.git"], { cwd: dir }).status, 0);

  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url || "");
    if (req.url === "/repos/Red-Blink/dune-awakening-selfhost-docker/releases/latest") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ tag_name: "v1.3.37" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));

  try {
    const address = server.address();
    const apiBase = `http://127.0.0.1:${address.port}`;
    const result = await runProcess("bash", ["runtime/scripts/self-update.sh", "check"], {
      cwd: dir,
      timeout: 15000,
      env: { ...process.env, DUNE_SELF_UPDATE_API_BASE: apiBase, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" }
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /GitHub repo:\s+Red-Blink\/dune-awakening-selfhost-docker/);
    assert(!result.stdout.includes("yacketrj/dune-awakening-selfhost-docker-WSL"));
    assert.deepEqual(requests, ["/repos/Red-Blink/dune-awakening-selfhost-docker/releases/latest"]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("self-update check falls back to the public release redirect when the GitHub API is rate-limited", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-self-update-rate-limit-"));
  mkdirSync(join(dir, "runtime", "scripts"), { recursive: true });
  copyFileSync(join(repoRoot, "runtime", "scripts", "self-update.sh"), join(dir, "runtime", "scripts", "self-update.sh"));
  copyFileSync(join(repoRoot, "runtime", "scripts", "compose-project.sh"), join(dir, "runtime", "scripts", "compose-project.sh"));
  chmodSync(join(dir, "runtime", "scripts", "self-update.sh"), 0o700);
  writeFileSync(join(dir, "VERSION"), "v1.3.97\n");

  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url || "");
    if (req.url?.startsWith("/repos/")) {
      res.writeHead(403, { "content-type": "application/json", "x-ratelimit-remaining": "0" });
      res.end(JSON.stringify({ message: "API rate limit exceeded" }));
      return;
    }
    if (req.url === "/Red-Blink/dune-awakening-selfhost-docker/releases/latest") {
      res.writeHead(302, { location: "/Red-Blink/dune-awakening-selfhost-docker/releases/tag/v1.3.98" });
      res.end();
      return;
    }
    if (req.url === "/Red-Blink/dune-awakening-selfhost-docker/releases/tag/v1.3.98") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("release");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));

  try {
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}`;
    const result = await runProcess("bash", ["runtime/scripts/self-update.sh", "check"], {
      cwd: dir,
      timeout: 15000,
      env: {
        ...process.env,
        DUNE_SELF_UPDATE_API_BASE: base,
        DUNE_SELF_UPDATE_WEB_BASE: base,
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost"
      }
    });

    assert.equal(result.status, 100, result.stderr || result.stdout);
    assert.match(result.stdout, /Latest release:\s+v1\.3\.98/);
    assert(requests.includes("/Red-Blink/dune-awakening-selfhost-docker/releases/latest"));
  } finally {
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("archive self-update replaces project files and preserves local state", async () => {
  const root = mkdtempSync(join(tmpdir(), "arrakis-self-update-install-"));
  const stagingDir = join(root, "staging");
  const installDir = join(root, "install");
  const fakeBin = join(root, "bin");
  const archive = join(root, "candidate.tar.gz");
  const version = readFileSync(join(repoRoot, "VERSION"), "utf8").trim();

  mkdirSync(stagingDir, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  const archiveResult = spawnSync("git", ["archive", "--format=tar.gz", "--prefix=candidate/", "-o", archive, "HEAD"], { cwd: repoRoot });
  assert.equal(archiveResult.status, 0, archiveResult.stderr?.toString());
  const extractResult = spawnSync("tar", ["-xzf", archive, "-C", stagingDir]);
  assert.equal(extractResult.status, 0, extractResult.stderr?.toString());
  copyFileSync(
    join(repoRoot, "runtime", "scripts", "self-update.sh"),
    join(stagingDir, "candidate", "runtime", "scripts", "self-update.sh")
  );
  copyFileSync(
    join(repoRoot, "runtime", "scripts", "compose-project.sh"),
    join(stagingDir, "candidate", "runtime", "scripts", "compose-project.sh")
  );
  copyFileSync(join(repoRoot, "VERSION"), join(stagingDir, "candidate", "VERSION"));
  const repackResult = spawnSync("tar", ["-czf", archive, "-C", stagingDir, "candidate"]);
  assert.equal(repackResult.status, 0, repackResult.stderr?.toString());
  cpSync(join(stagingDir, "candidate"), installDir, { recursive: true });
  copyFileSync(
    join(repoRoot, "runtime", "scripts", "self-update.sh"),
    join(installDir, "runtime", "scripts", "self-update.sh")
  );
  chmodSync(join(installDir, "runtime", "scripts", "self-update.sh"), 0o700);

  writeFileSync(join(installDir, "VERSION"), "v0.0.1\n");
  writeFileSync(join(installDir, "README.md"), "stale project file\n");
  writeFileSync(join(installDir, "newer-release-only.txt"), "must be removed\n");
  const blockedProjectDir = join(installDir, "blocked-project-dir");
  mkdirSync(blockedProjectDir);
  writeFileSync(join(blockedProjectDir, "managed-file.txt"), "must not be removed during a failed preflight\n");
  const pythonCacheDir = join(installDir, "runtime", "scripts", "__pycache__");
  mkdirSync(pythonCacheDir, { recursive: true });
  writeFileSync(join(pythonCacheDir, "usersettings.cpython-test.pyc"), "disposable cache\n");
  chmodSync(pythonCacheDir, 0o555);
  writeFileSync(join(installDir, ".env"), "SERVER_TITLE=Preserved Server\nADMIN_BIND_PORT=9090\n");
  mkdirSync(join(installDir, "runtime", "generated"), { recursive: true });
  mkdirSync(join(installDir, "runtime", "secrets"), { recursive: true });
  writeFileSync(join(installDir, "runtime", "generated", "map-runtime-modes.json"), "{\"DeepDesert_1\":\"always-on\"}\n");
  writeFileSync(join(installDir, "runtime", "generated", "landsraad-milestones.json"), "{\"enabled\":true,\"goalAmount\":70000,\"thresholds\":[700,3500]}\n");
  writeFileSync(join(installDir, "runtime", "generated", "director-deepdesert-dual.ini"), "[DeepDesert_1]\nNumExtraServers=1\nMinServers=0\n");
  writeFileSync(join(installDir, "runtime", "generated", "public-directory-status.json"), "{\"state\":\"online\"}\n");
  writeFileSync(join(installDir, "runtime", "generated", "public-probe.env"), "DUNE_PUBLIC_PROBE_ENABLED=true\nDUNE_PUBLIC_PROBE_ADDRESS=203.0.113.42\nDUNE_PUBLIC_PROBE_ENDPOINT=https://203.0.113.42\n");
  writeFileSync(join(installDir, "runtime", "generated", "director-capacity.ini"), "[Survival_1]\nPlayerHardCap=60\nShouldUpdatePlayerCountOnFls=true\n");
  mkdirSync(join(installDir, "runtime", "director", "config"), { recursive: true });
  writeFileSync(join(installDir, "runtime", "director", "config", "director_config.ini"), "live Director configuration\n");
  writeFileSync(join(installDir, "runtime", "secrets", "funcom-token.txt"), "test-token\n");
  writeFileSync(join(installDir, "runtime", "secrets", "public-directory.json"), "{\"serverId\":\"11111111-1111-4111-8111-111111111111\",\"secret\":\"abcdefghijklmnopqrstuvwxyz123456\"}\n");
  mkdirSync(join(installDir, "runtime", "addons", "installed", "example"), { recursive: true });
  writeFileSync(join(installDir, "runtime", "addons", "installed", "example", "state.txt"), "preserved addon\n");

  writeFileSync(join(fakeBin, "docker"), `#!/usr/bin/env bash
set -e
if [ "\${1:-}" = "compose" ] && [[ " $* " == *" config --services "* ]]; then
  echo redblink-dune-docker-console
fi
exit 0
`);
  writeFileSync(join(fakeBin, "sudo"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(fakeBin, "docker"), 0o700);
  chmodSync(join(fakeBin, "sudo"), 0o700);

  const archiveBody = readFileSync(archive);
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url || "");
    if (req.url === `/repos/Red-Blink/dune-awakening-selfhost-docker/releases/tags/${version}`) {
      const address = server.address();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ tag_name: version, tarball_url: `http://127.0.0.1:${address.port}/candidate.tar.gz` }));
      return;
    }
    if (req.url === "/candidate.tar.gz") {
      res.writeHead(200, { "content-type": "application/gzip", "content-length": archiveBody.length });
      res.end(archiveBody);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));

  try {
    const address = server.address();
    if (typeof process.getuid !== "function" || process.getuid() !== 0) {
      chmodSync(blockedProjectDir, 0o555);
      const blockedResult = await runProcess("bash", ["runtime/scripts/self-update.sh", "install", version], {
        cwd: installDir,
        timeout: 60000,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          DUNE_SELF_UPDATE_API_BASE: `http://127.0.0.1:${address.port}`,
          DUNE_SELF_UPDATE_REPO: "Red-Blink/dune-awakening-selfhost-docker",
          NO_PROXY: "127.0.0.1,localhost",
          no_proxy: "127.0.0.1,localhost"
        }
      });

      assert.equal(blockedResult.status, 13, blockedResult.stderr || blockedResult.stdout);
      assert.match(blockedResult.stdout, /No project files were removed/);
      assert.match(blockedResult.stdout, /sudo chown -R "\d+:\d+"/);
      assert.equal(readFileSync(join(installDir, "VERSION"), "utf8"), "v0.0.1\n");
      assert.equal(readFileSync(join(installDir, "README.md"), "utf8"), "stale project file\n");
      assert.equal(readFileSync(join(blockedProjectDir, "managed-file.txt"), "utf8"), "must not be removed during a failed preflight\n");
      chmodSync(blockedProjectDir, 0o755);
      requests.length = 0;
    }

    const result = await runProcess("bash", ["runtime/scripts/self-update.sh", "install", version], {
      cwd: installDir,
      timeout: 60000,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        DUNE_SELF_UPDATE_API_BASE: `http://127.0.0.1:${address.port}`,
        DUNE_SELF_UPDATE_REPO: "Red-Blink/dune-awakening-selfhost-docker",
        DUNE_SELF_UPDATE_RUN_ID: "123e4567-e89b-42d3-a456-426614174000",
        DUNE_SELF_UPDATE_BUILD_TIMEOUT_SECONDS: "60",
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost"
      }
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readFileSync(join(installDir, "VERSION"), "utf8").trim(), version);
    assert.notEqual(readFileSync(join(installDir, "README.md"), "utf8"), "stale project file\n");
    assert.equal(existsSync(join(installDir, "newer-release-only.txt")), false);
    assert.equal(existsSync(join(pythonCacheDir, "usersettings.cpython-test.pyc")), true);
    const updatedEnv = readFileSync(join(installDir, ".env"), "utf8");
    assert.ok(updatedEnv.includes("SERVER_TITLE=Preserved Server\n"));
    assert.ok(updatedEnv.includes("ADMIN_BIND_PORT=9090\n"));
    assert.ok(updatedEnv.includes("DUNE_COMPOSE_PROJECT_NAME=install\n"));
    assert.ok(updatedEnv.includes("COMPOSE_PROJECT_NAME=install\n"));
    assert.equal(existsSync(join(installDir, "runtime", "scripts", "compose-project.sh")), true);
    assert.equal(readFileSync(join(installDir, "runtime", "generated", "map-runtime-modes.json"), "utf8"), "{\"DeepDesert_1\":\"always-on\"}\n");
    assert.equal(readFileSync(join(installDir, "runtime", "generated", "landsraad-milestones.json"), "utf8"), "{\"enabled\":true,\"goalAmount\":70000,\"thresholds\":[700,3500]}\n");
    assert.equal(readFileSync(join(installDir, "runtime", "generated", "director-deepdesert-dual.ini"), "utf8"), "[DeepDesert_1]\nNumExtraServers=1\nMinServers=0\n");
    assert.equal(readFileSync(join(installDir, "runtime", "generated", "public-directory-status.json"), "utf8"), "{\"state\":\"online\"}\n");
    assert.equal(readFileSync(join(installDir, "runtime", "generated", "public-probe.env"), "utf8"), "DUNE_PUBLIC_PROBE_ENABLED=true\nDUNE_PUBLIC_PROBE_ADDRESS=203.0.113.42\nDUNE_PUBLIC_PROBE_ENDPOINT=https://203.0.113.42\n");
    assert.equal(readFileSync(join(installDir, "runtime", "generated", "director-capacity.ini"), "utf8"), "[Survival_1]\nPlayerHardCap=60\nShouldUpdatePlayerCountOnFls=true\n");
    assert.equal(readFileSync(join(installDir, "runtime", "director", "config", "director_config.ini"), "utf8"), "live Director configuration\n");
    assert.equal(readFileSync(join(installDir, "runtime", "secrets", "funcom-token.txt"), "utf8"), "test-token\n");
    assert.equal(readFileSync(join(installDir, "runtime", "secrets", "public-directory.json"), "utf8"), "{\"serverId\":\"11111111-1111-4111-8111-111111111111\",\"secret\":\"abcdefghijklmnopqrstuvwxyz123456\"}\n");
    assert.equal(readFileSync(join(installDir, "runtime", "addons", "installed", "example", "state.txt"), "utf8"), "preserved addon\n");
    assert(existsSync(join(installDir, "runtime", "backups", "self-update")));
    assert(readdirSync(join(installDir, "runtime", "backups", "self-update")).length > 0);
    assert.ok(result.stdout.includes(`Installed stack version: ${version}`));
    const updateStatus = readFileSync(join(installDir, "runtime", "generated", "self-update-status", "123e4567-e89b-42d3-a456-426614174000.env"), "utf8");
    assert.match(updateStatus, /^state=succeeded$/m);
    assert.match(updateStatus, /^stage=complete$/m);
    assert.match(updateStatus, /^percent=100$/m);
    assert.deepEqual(requests, [
      `/repos/Red-Blink/dune-awakening-selfhost-docker/releases/tags/${version}`,
      "/candidate.tar.gz"
    ]);
  } finally {
    if (existsSync(blockedProjectDir)) chmodSync(blockedProjectDir, 0o755);
    if (existsSync(pythonCacheDir)) chmodSync(pythonCacheDir, 0o755);
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(root, { recursive: true, force: true });
  }
});

test("archive self-update times out a stalled download before changing installed files", async () => {
  const root = mkdtempSync(join(tmpdir(), "arrakis-self-update-download-timeout-"));
  const fakeBin = join(root, "bin");
  const runId = "123e4567-e89b-42d3-a456-426614174004";
  mkdirSync(join(root, "runtime", "scripts"), { recursive: true });
  mkdirSync(fakeBin);
  copyFileSync(join(repoRoot, "runtime", "scripts", "self-update.sh"), join(root, "runtime", "scripts", "self-update.sh"));
  copyFileSync(join(repoRoot, "runtime", "scripts", "compose-project.sh"), join(root, "runtime", "scripts", "compose-project.sh"));
  chmodSync(join(root, "runtime", "scripts", "self-update.sh"), 0o700);
  writeFileSync(join(root, "VERSION"), "v1.4.12\n");
  writeFileSync(join(fakeBin, "docker"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });

  const server = createServer((req, res) => {
    if (req.url === "/repos/Red-Blink/dune-awakening-selfhost-docker/releases/tags/v1.4.16") {
      const address = server.address();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ tag_name: "v1.4.16", tarball_url: `http://127.0.0.1:${address.port}/stalled.tar.gz` }));
      return;
    }
    if (req.url === "/stalled.tar.gz") {
      res.writeHead(200, { "content-type": "application/gzip" });
      res.write("partial archive data");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));

  try {
    const address = server.address();
    const result = await runProcess("bash", ["runtime/scripts/self-update.sh", "install", "v1.4.16"], {
      cwd: root,
      timeout: 10000,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        DUNE_SELF_UPDATE_API_BASE: `http://127.0.0.1:${address.port}`,
        DUNE_SELF_UPDATE_REPO: "Red-Blink/dune-awakening-selfhost-docker",
        DUNE_SELF_UPDATE_RUN_ID: runId,
        DUNE_SELF_UPDATE_DOWNLOAD_TIMEOUT_SECONDS: "2",
        DUNE_SELF_UPDATE_PROGRESS_INTERVAL_SECONDS: "1",
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost"
      }
    });

    assert.equal(result.status, 124, result.stderr || result.stdout);
    assert.match(result.stderr, /Downloading console release v1\.4\.16 timed out after 2 seconds/);
    assert.equal(readFileSync(join(root, "VERSION"), "utf8"), "v1.4.12\n");
    assert.deepEqual(readdirSync(join(root, "runtime", "backups", "self-update")), []);
    const status = readFileSync(join(root, "runtime", "generated", "self-update-status", `${runId}.env`), "utf8");
    assert.match(status, /^state=failed$/m);
    assert.match(status, /^stage=downloading$/m);
    assert.match(status, /^percent=20$/m);
    assert.match(status, /^message=Downloading console release v1\.4\.16 timed out after 2 seconds\. Check the server's connection to GitHub, then retry\.$/m);
  } finally {
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(root, { recursive: true, force: true });
  }
});

test("self-update refuses a concurrent install and records a durable busy result", async () => {
  const root = mkdtempSync(join(tmpdir(), "arrakis-self-update-lock-"));
  const runId = "123e4567-e89b-42d3-a456-426614174001";
  mkdirSync(join(root, "runtime", "scripts"), { recursive: true });
  mkdirSync(join(root, "runtime", "generated"), { recursive: true });
  copyFileSync(join(repoRoot, "runtime", "scripts", "self-update.sh"), join(root, "runtime", "scripts", "self-update.sh"));
  copyFileSync(join(repoRoot, "runtime", "scripts", "compose-project.sh"), join(root, "runtime", "scripts", "compose-project.sh"));
  writeFileSync(join(root, "VERSION"), "v0.0.1\n");

  const holder = spawn("flock", [join(root, "runtime", "generated", "self-update.lock"), "sleep", "10"], { stdio: "ignore" });
  try {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    const result = await runProcess("bash", ["runtime/scripts/self-update.sh", "install", "v0.0.2"], {
      cwd: root,
      env: { ...process.env, DUNE_SELF_UPDATE_RUN_ID: runId }
    });
    assert.equal(result.status, 75, result.stderr || result.stdout);
    assert.match(result.stderr, /Another console update is already running/);
    const status = readFileSync(join(root, "runtime", "generated", "self-update-status", `${runId}.env`), "utf8");
    assert.match(status, /^state=failed$/m);
    assert.match(status, /^stage=busy$/m);
  } finally {
    holder.kill("SIGKILL");
    await new Promise((resolveClose) => holder.once("close", resolveClose));
    rmSync(root, { recursive: true, force: true });
  }
});

test("web console rebuild stops at the configured build timeout", async () => {
  const root = mkdtempSync(join(tmpdir(), "arrakis-self-update-timeout-"));
  const fakeBin = join(root, "bin");
  const runId = "123e4567-e89b-42d3-a456-426614174002";
  mkdirSync(join(root, "runtime", "scripts", "lib"), { recursive: true });
  mkdirSync(join(root, "runtime", "generated"), { recursive: true });
  mkdirSync(fakeBin);
  copyFileSync(join(repoRoot, "runtime", "scripts", "self-update.sh"), join(root, "runtime", "scripts", "self-update.sh"));
  copyFileSync(join(repoRoot, "runtime", "scripts", "compose-project.sh"), join(root, "runtime", "scripts", "compose-project.sh"));
  // dune-awakening-selfhost-docker#901: prepare_web_console_rebuild_env()
  // (called by rebuild_web_console_now(), exercised below) now sources
  // console-secrets-env.sh, a new real dependency of self-update.sh this
  // isolated fixture didn't carry before -- without it, self-update.sh
  // fails on the missing file before ever reaching the `timeout` command
  // this test is actually exercising.
  copyFileSync(join(repoRoot, "runtime", "scripts", "lib", "console-secrets-env.sh"), join(root, "runtime", "scripts", "lib", "console-secrets-env.sh"));
  copyFileSync(join(repoRoot, "runtime", "scripts", "lib", "secrets.sh"), join(root, "runtime", "scripts", "lib", "secrets.sh"));
  copyFileSync(join(repoRoot, "runtime", "scripts", "lib", "secrets_aead.py"), join(root, "runtime", "scripts", "lib", "secrets_aead.py"));
  writeFileSync(join(root, "VERSION"), "v0.0.1\n");
  writeFileSync(join(root, "docker-compose.web.yml"), "services: {}\n");
  writeFileSync(join(fakeBin, "docker"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
  writeFileSync(join(fakeBin, "timeout"), "#!/usr/bin/env bash\nexit 124\n", { mode: 0o700 });

  try {
    const result = await runProcess("bash", ["runtime/scripts/self-update.sh", "rebuild-web-console", "redblink-dune-docker-console"], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        DUNE_SELF_UPDATE_RUN_ID: runId,
        DUNE_SELF_UPDATE_BUILD_TIMEOUT_SECONDS: "60"
      }
    });
    assert.equal(result.status, 124, result.stderr || result.stdout);
    assert.match(result.stderr, /build timed out after 60 seconds/);
    const status = readFileSync(join(root, "runtime", "generated", "self-update-status", `${runId}.env`), "utf8");
    assert.match(status, /^state=failed$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Layer 3 audit finding (HIGH): resolve_discord_adapter_token() must match
// readDiscordBotApiToken()'s (routes.js) REAL, current precedence exactly --
// direct DUNE_DISCORD_ADAPTER_TOKEN first, token file as fallback -- since
// that JS function is what actually authenticates the live adapter this
// health check probes. An earlier revision of this function (and this test)
// had that backwards on the mistaken belief that routes.js had also been
// changed to prefer the file; it never was (confirmed by reading it
// directly). Checking the file first meant an operator who minted a fresh
// token via the Settings UI while a stale direct value still lingered in
// .env got a false-unhealthy report: the live adapter authenticates with
// the stale direct value (real precedence), while this shell check sent the
// fresh file token and got a real 401 from a genuinely healthy adapter.
//
// self-update.sh is an entrypoint that runs its full case-statement
// dispatch on execution/sourcing (no `[ "${BASH_SOURCE[0]}" = "$0" ]`
// guard), and verify_discord_adapter_health()'s own full path needs a
// live Docker container to curl against -- neither can run here. Instead,
// following baseContainerMutationRoutes.test.js's precedent for
// entrypoint-only files, this extracts the REAL shipped
// read_env_file_value() and resolve_discord_adapter_token() function
// bodies verbatim from the script and executes them for real in an
// isolated bash process -- proving the actual shipped precedence, not a
// reimplemented copy of it.
function extractShellFunction(source, name) {
  const startMarker = `${name}() {`;
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${name}() not found in self-update.sh`);
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `could not find the end of ${name}()`);
  return source.slice(start, end + 2);
}

function runShellFunction(functionsSource, callExpression, cwd) {
  const script = `#!/usr/bin/env bash\nset -euo pipefail\ncd ${JSON.stringify(cwd)}\n${functionsSource}\n${callExpression}\n`;
  const result = spawnSync("bash", ["-c", script]);
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout.toString();
}

test("resolve_discord_adapter_token prefers the direct DUNE_DISCORD_ADAPTER_TOKEN value over the token FILE, matching readDiscordBotApiToken()'s real precedence", () => {
  const source = readFileSync(join(repoRoot, "runtime", "scripts", "self-update.sh"), "utf8");
  const functionsSource = [
    extractShellFunction(source, "read_env_file_value"),
    extractShellFunction(source, "resolve_discord_adapter_token")
  ].join("\n");

  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-token-resolution-"));
  try {
    const tokenFile = join(dir, "discord-adapter-token.txt");
    writeFileSync(tokenFile, "fresh-file-token\n");
    writeFileSync(join(dir, ".env"), [
      "DUNE_DISCORD_ADAPTER_TOKEN=direct-token",
      `DUNE_DISCORD_ADAPTER_TOKEN_FILE=${tokenFile}`,
      ""
    ].join("\n"));

    const output = runShellFunction(functionsSource, "resolve_discord_adapter_token", dir);
    assert.equal(output, "direct-token", "the direct env var must win when both are present -- this is the same credential the live adapter (routes.js) actually authenticates with");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolve_discord_adapter_token falls back to the direct env var when no usable token file exists (a manual, not-yet-migrated config)", () => {
  const source = readFileSync(join(repoRoot, "runtime", "scripts", "self-update.sh"), "utf8");
  const functionsSource = [
    extractShellFunction(source, "read_env_file_value"),
    extractShellFunction(source, "resolve_discord_adapter_token")
  ].join("\n");

  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-token-resolution-fallback-"));
  try {
    writeFileSync(join(dir, ".env"), "DUNE_DISCORD_ADAPTER_TOKEN=manual-direct-token\n");

    const output = runShellFunction(functionsSource, "resolve_discord_adapter_token", dir);
    assert.equal(output, "manual-direct-token", "a manual, direct-only config (no token file at all) must still resolve");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Finding 3 (IMPORTANT, final review): resolve_discord_adapter_token() was
// missing the same DUNE_BOT_API_TOKEN_FILE legacy-file fallback
// readDiscordBotApiToken() (routes.js) has. An operator using only
// DUNE_BOT_API_TOKEN_FILE (no DUNE_DISCORD_ADAPTER_TOKEN_FILE at all) would
// have both of the shell side's checked vars come back empty, sending an
// empty bearer token, getting a real 401, and this script reporting
// discord_health_ok=0 even though the adapter is actually fine.
test("resolve_discord_adapter_token falls back to the legacy DUNE_BOT_API_TOKEN_FILE when DUNE_DISCORD_ADAPTER_TOKEN_FILE is not set (Finding 3)", () => {
  const source = readFileSync(join(repoRoot, "runtime", "scripts", "self-update.sh"), "utf8");
  const functionsSource = [
    extractShellFunction(source, "read_env_file_value"),
    extractShellFunction(source, "resolve_discord_adapter_token")
  ].join("\n");

  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-token-resolution-legacy-file-"));
  try {
    const legacyTokenFile = join(dir, "legacy-bot-api-token.txt");
    writeFileSync(legacyTokenFile, "legacy-file-token\n");
    writeFileSync(join(dir, ".env"), `DUNE_BOT_API_TOKEN_FILE=${legacyTokenFile}\n`);

    const output = runShellFunction(functionsSource, "resolve_discord_adapter_token", dir);
    assert.equal(output, "legacy-file-token", "an operator with only the legacy DUNE_BOT_API_TOKEN_FILE set must still resolve the real token, not an empty bearer token");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolve_discord_adapter_token still prefers DUNE_DISCORD_ADAPTER_TOKEN_FILE over the legacy DUNE_BOT_API_TOKEN_FILE when both are set (Finding 3)", () => {
  const source = readFileSync(join(repoRoot, "runtime", "scripts", "self-update.sh"), "utf8");
  const functionsSource = [
    extractShellFunction(source, "read_env_file_value"),
    extractShellFunction(source, "resolve_discord_adapter_token")
  ].join("\n");

  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-token-resolution-precedence-"));
  try {
    const newTokenFile = join(dir, "new-token.txt");
    const legacyTokenFile = join(dir, "legacy-token.txt");
    writeFileSync(newTokenFile, "new-file-token\n");
    writeFileSync(legacyTokenFile, "legacy-file-token\n");
    writeFileSync(join(dir, ".env"), [
      `DUNE_DISCORD_ADAPTER_TOKEN_FILE=${newTokenFile}`,
      `DUNE_BOT_API_TOKEN_FILE=${legacyTokenFile}`,
      ""
    ].join("\n"));

    const output = runShellFunction(functionsSource, "resolve_discord_adapter_token", dir);
    assert.equal(output, "new-file-token", "DUNE_DISCORD_ADAPTER_TOKEN_FILE must still win over the legacy DUNE_BOT_API_TOKEN_FILE when both are set, matching readDiscordBotApiToken()'s real precedence");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Finding 1 (CRITICAL, final review): migrate_discord_role_ids_env() must
// copy a legacy-only DISCORD_OBSERVER_ROLE_IDS value into the new
// DISCORD_PLAYER_ROLE_IDS key in .env, once, so an existing operator who
// upgrades does not silently lose that role mapping (docker-compose.web.yml's
// own interpolated environment: entry always sets DISCORD_PLAYER_ROLE_IDS in
// the container -- even as an empty string -- so the JS-side
// `!== undefined` legacy fallback in discordRoleMappingFromEnv() can never
// fire inside a real deployed container without this migration).
test("migrate_discord_role_ids_env copies a legacy-only DISCORD_OBSERVER_ROLE_IDS value into DISCORD_PLAYER_ROLE_IDS (Finding 1)", () => {
  const source = readFileSync(join(repoRoot, "runtime", "scripts", "self-update.sh"), "utf8");
  const functionsSource = [
    extractShellFunction(source, "read_env_file_value"),
    extractShellFunction(source, "persist_env_file_value"),
    extractShellFunction(source, "migrate_discord_role_ids_env")
  ].join("\n");

  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-role-migration-"));
  try {
    writeFileSync(join(dir, ".env"), "DISCORD_OBSERVER_ROLE_IDS=123456789012345678\n");

    runShellFunction(functionsSource, "migrate_discord_role_ids_env", dir);

    const envContent = readFileSync(join(dir, ".env"), "utf8");
    assert.match(envContent, /^DISCORD_PLAYER_ROLE_IDS=123456789012345678$/m, "the legacy role IDs must be copied into the new key so the container sees them regardless of Compose interpolation behavior");
    assert.match(envContent, /^DISCORD_OBSERVER_ROLE_IDS=123456789012345678$/m, "the legacy key itself must be left untouched, not deleted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migrate_discord_role_ids_env never overwrites an already-present DISCORD_PLAYER_ROLE_IDS -- including a deliberately-cleared empty value (Finding 1)", () => {
  const source = readFileSync(join(repoRoot, "runtime", "scripts", "self-update.sh"), "utf8");
  const functionsSource = [
    extractShellFunction(source, "read_env_file_value"),
    extractShellFunction(source, "persist_env_file_value"),
    extractShellFunction(source, "migrate_discord_role_ids_env")
  ].join("\n");

  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-role-migration-noop-"));
  try {
    writeFileSync(join(dir, ".env"), "DISCORD_OBSERVER_ROLE_IDS=999999999999999999\nDISCORD_PLAYER_ROLE_IDS=\n");

    runShellFunction(functionsSource, "migrate_discord_role_ids_env", dir);

    const envContent = readFileSync(join(dir, ".env"), "utf8");
    assert.match(envContent, /^DISCORD_PLAYER_ROLE_IDS=$/m, "an operator who deliberately cleared DISCORD_PLAYER_ROLE_IDS to revoke access must not have it silently repopulated from the stale legacy value");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migrate_discord_role_ids_env is a no-op when there is no legacy value to migrate (Finding 1)", () => {
  const source = readFileSync(join(repoRoot, "runtime", "scripts", "self-update.sh"), "utf8");
  const functionsSource = [
    extractShellFunction(source, "read_env_file_value"),
    extractShellFunction(source, "persist_env_file_value"),
    extractShellFunction(source, "migrate_discord_role_ids_env")
  ].join("\n");

  const dir = mkdtempSync(join(tmpdir(), "arrakis-discord-role-migration-nothing-"));
  try {
    writeFileSync(join(dir, ".env"), "SOME_OTHER_KEY=untouched\n");

    runShellFunction(functionsSource, "migrate_discord_role_ids_env", dir);

    const envContent = readFileSync(join(dir, ".env"), "utf8");
    assert.doesNotMatch(envContent, /DISCORD_PLAYER_ROLE_IDS/, "nothing to migrate means no new key should be written at all");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeout = 15000, ...spawnOptions } = options;
    const child = spawn(command, args, spawnOptions);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} ${args.join(" ")} timed out\n${stdout}\n${stderr}`));
    }, timeout);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}
