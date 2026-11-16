import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function fixture() {
  const scratch = mkdtempSync(join(tmpdir(), "dune-console-status-"));
  const root = join(scratch, "install");
  const scripts = join(root, "runtime/scripts");
  const bin = join(scratch, "bin");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin);
  for (const name of ["dune", "console.sh", "compose-project.sh", "lib/console-secrets-env.sh", "lib/secrets.sh", "lib/secrets_aead.py"]) {
    mkdirSync(dirname(join(scripts, name)), { recursive: true });
    copyFileSync(join(repoRoot, "runtime/scripts", name), join(scripts, name));
    chmodSync(join(scripts, name), 0o755);
  }
  writeFileSync(join(root, "docker-compose.web.yml"), "services: {}\n");
  const calls = join(scratch, "docker-calls");
  writeFileSync(join(bin, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_DOCKER_CALLS"
if [ "$1" = ps ]; then
  printf 'redblink-dune-docker-console   Up 7 hours\\n'
fi
`);
  chmodSync(join(bin, "docker"), 0o755);
  const run = (script, args) => spawnSync("bash", [join(scripts, script), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_DOCKER_CALLS: calls,
      DUNE_COMPOSE_PROJECT_NAME: "fixture-project", COMPOSE_PROJECT_NAME: "fixture-project",
      ADMIN_WEB_PORT: "", ADMIN_BIND_PORT: "", DUNE_SKIP_STACK_GIT_REPAIR: "1" },
  });
  return { root, calls, run, cleanup() { chmodSync(root, 0o755); rmSync(scratch, { recursive: true, force: true }); } };
}

for (const writable of [false, true]) {
  for (const [script, args] of [
    ["console.sh", ["status"]], ["console.sh", ["url"]], ["console.sh", ["help"]],
    ["dune", ["console", "status"]], ["dune", ["web", "url"]], ["dune", ["console", "help"]],
  ]) {
    test(`${script} ${args.join(" ")} preserves ${writable ? "writable" : "read-only"} configuration`, () => {
      const f = fixture();
      try {
        const path = join(f.root, ".env");
        const content = "ADMIN_BIND_PORT=18088\nDOCKER_SOCKET_GID=123\n";
        writeFileSync(path, content, { mode: writable ? 0o644 : 0o444 });
        if (!writable) chmodSync(f.root, 0o555);
        const before = statSync(path);
        const result = f.run(script, args);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(path, "utf8"), content);
        const after = statSync(path);
        for (const key of ["ino", "mtimeMs", "ctimeMs", "mode", "uid", "gid"]) assert.equal(after[key], before[key], key);
        if (!args.includes("help")) {
          assert.match(result.stdout, /redblink-dune-docker-console\s+Up 7 hours/);
          assert.match(result.stdout, /:18088/);
        }
        const calls = existsSync(f.calls) ? readFileSync(f.calls, "utf8").trim().split("\n") : [];
        assert.ok(calls.every(call => call.startsWith("ps ")), calls.join("\n"));
      } finally { f.cleanup(); }
    });
  }
}

test("Console status can read an existing project configuration without touching .env", () => {
  const f = fixture();
  try {
    const path = join(f.root, ".env");
    const content = "DUNE_COMPOSE_PROJECT_NAME=fixture-project\nCOMPOSE_PROJECT_NAME=fixture-project\nADMIN_BIND_PORT=18088\n";
    writeFileSync(path, content, { mode: 0o444 });
    const before = statSync(path);
    for (const [script, args] of [["console.sh", ["status"]], ["dune", ["console", "status"]]]) {
      const result = f.run(script, args);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /:18088/);
      assert.equal(readFileSync(path, "utf8"), content);
      assert.equal(statSync(path).mtimeMs, before.mtimeMs);
    }
  } finally { f.cleanup(); }
});

test("Console status does not create a missing .env", () => {
  const f = fixture();
  try {
    for (const [script, args] of [["console.sh", ["status"]], ["dune", ["console", "status"]]]) {
      const result = f.run(script, args);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(join(f.root, ".env")), false);
      assert.match(result.stdout, /:8088/);
    }
  } finally { f.cleanup(); }
});

for (const command of ["restart", "reload"]) {
  test(`Console ${command} still persists deployment configuration`, () => {
    const f = fixture();
    try {
      writeFileSync(join(f.root, ".env"), "ADMIN_BIND_PORT=18088\n");
      const result = f.run("console.sh", [command]);
      assert.equal(result.status, 0, result.stderr);
      const content = readFileSync(join(f.root, ".env"), "utf8");
      assert.match(content, /^DUNE_COMPOSE_PROJECT_NAME=fixture-project$/m);
      assert.match(content, /^COMPOSE_PROJECT_NAME=fixture-project$/m);
      assert.match(content, /^DOCKER_SOCKET_GID=\d+$/m);
      assert.match(readFileSync(f.calls, "utf8"), /compose .* up -d redblink-dune-docker-console/);
    } finally { f.cleanup(); }
  });
}
