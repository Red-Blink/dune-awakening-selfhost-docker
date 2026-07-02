import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
