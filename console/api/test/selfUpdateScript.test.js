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
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("self-update check prefers the official upstream release repo in fork checkouts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-self-update-"));
  mkdirSync(join(dir, "runtime", "scripts"), { recursive: true });
  copyFileSync(join(repoRoot, "runtime", "scripts", "self-update.sh"), join(dir, "runtime", "scripts", "self-update.sh"));
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
  cpSync(join(stagingDir, "candidate"), installDir, { recursive: true });
  copyFileSync(
    join(repoRoot, "runtime", "scripts", "self-update.sh"),
    join(installDir, "runtime", "scripts", "self-update.sh")
  );
  chmodSync(join(installDir, "runtime", "scripts", "self-update.sh"), 0o700);

  writeFileSync(join(installDir, "VERSION"), "v0.0.1\n");
  writeFileSync(join(installDir, "README.md"), "stale project file\n");
  writeFileSync(join(installDir, "newer-release-only.txt"), "must be removed\n");
  writeFileSync(join(installDir, ".env"), "SERVER_TITLE=Preserved Server\nADMIN_BIND_PORT=9090\n");
  mkdirSync(join(installDir, "runtime", "generated"), { recursive: true });
  mkdirSync(join(installDir, "runtime", "secrets"), { recursive: true });
  writeFileSync(join(installDir, "runtime", "generated", "map-runtime-modes.json"), "{\"DeepDesert_1\":\"always-on\"}\n");
  writeFileSync(join(installDir, "runtime", "generated", "public-directory-status.json"), "{\"state\":\"online\"}\n");
  writeFileSync(join(installDir, "runtime", "generated", "public-probe.env"), "DUNE_PUBLIC_PROBE_ENABLED=true\nDUNE_PUBLIC_PROBE_ADDRESS=203.0.113.42\nDUNE_PUBLIC_PROBE_ENDPOINT=https://203.0.113.42\n");
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
    const result = await runProcess("bash", ["runtime/scripts/self-update.sh", "install", version], {
      cwd: installDir,
      timeout: 30000,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        DUNE_SELF_UPDATE_API_BASE: `http://127.0.0.1:${address.port}`,
        DUNE_SELF_UPDATE_REPO: "Red-Blink/dune-awakening-selfhost-docker",
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost"
      }
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readFileSync(join(installDir, "VERSION"), "utf8").trim(), version);
    assert.notEqual(readFileSync(join(installDir, "README.md"), "utf8"), "stale project file\n");
    assert.equal(existsSync(join(installDir, "newer-release-only.txt")), false);
    const updatedEnv = readFileSync(join(installDir, ".env"), "utf8");
    assert.ok(updatedEnv.includes("SERVER_TITLE=Preserved Server\n"));
    assert.ok(updatedEnv.includes("ADMIN_BIND_PORT=9090\n"));
    assert.equal(readFileSync(join(installDir, "runtime", "generated", "map-runtime-modes.json"), "utf8"), "{\"DeepDesert_1\":\"always-on\"}\n");
    assert.equal(readFileSync(join(installDir, "runtime", "generated", "public-directory-status.json"), "utf8"), "{\"state\":\"online\"}\n");
    assert.equal(readFileSync(join(installDir, "runtime", "generated", "public-probe.env"), "utf8"), "DUNE_PUBLIC_PROBE_ENABLED=true\nDUNE_PUBLIC_PROBE_ADDRESS=203.0.113.42\nDUNE_PUBLIC_PROBE_ENDPOINT=https://203.0.113.42\n");
    assert.equal(readFileSync(join(installDir, "runtime", "secrets", "funcom-token.txt"), "utf8"), "test-token\n");
    assert.equal(readFileSync(join(installDir, "runtime", "secrets", "public-directory.json"), "utf8"), "{\"serverId\":\"11111111-1111-4111-8111-111111111111\",\"secret\":\"abcdefghijklmnopqrstuvwxyz123456\"}\n");
    assert.equal(readFileSync(join(installDir, "runtime", "addons", "installed", "example", "state.txt"), "utf8"), "preserved addon\n");
    assert(existsSync(join(installDir, "runtime", "backups", "self-update")));
    assert(readdirSync(join(installDir, "runtime", "backups", "self-update")).length > 0);
    assert.ok(result.stdout.includes(`Installed stack version: ${version}`));
    assert.deepEqual(requests, [
      `/repos/Red-Blink/dune-awakening-selfhost-docker/releases/tags/${version}`,
      "/candidate.tar.gz"
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(root, { recursive: true, force: true });
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
