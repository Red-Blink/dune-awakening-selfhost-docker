import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGzip, gunzipSync } from "node:zlib";
import { json, withSecurityHeaders } from "../src/auth.js";
import { createTarHeader, tarPadding, TAR_TRAILER_BYTES, validBackupDownloadName } from "../src/services/backups.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const serverSource = readFileSync(resolve(__dirname, "../src/server.js"), "utf8");

function extractAsyncFunctionSource(source, name) {
  const marker = `async function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} must exist in server.js`);
  const openBrace = source.indexOf("{", start);
  let depth = 1;
  for (let i = openBrace + 1; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Could not find closing brace for ${name}`);
}

function buildBackupDownloadRoute(overrides = {}) {
  const fnSource = extractAsyncFunctionSource(serverSource, "backupDownloadRoute");
  const factory = new Function(
    "deps",
    `const {
      validBackupDownloadName,
      resolve,
      config,
      existsSync,
      statSync,
      withSecurityHeaders,
      createGzip,
      pipeline,
      createTarHeader,
      createReadStream,
      tarPadding,
      TAR_TRAILER_BYTES,
      json
    } = deps;
    return (${fnSource});`
  );
  return factory({
    validBackupDownloadName,
    resolve,
    config: { repoRoot: "/synthetic-repo" },
    existsSync: () => true,
    statSync: () => ({ size: 0 }),
    withSecurityHeaders,
    createGzip,
    pipeline,
    createTarHeader,
    createReadStream: () => Readable.from([]),
    tarPadding,
    TAR_TRAILER_BYTES,
    json,
    ...overrides
  });
}

async function withRejectionGuard(run) {
  const unhandledRejections = [];
  const uncaughtExceptions = [];
  const onRejection = (reason) => unhandledRejections.push(reason);
  const onException = (error) => uncaughtExceptions.push(error);
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);
  try {
    await run();
    // Allow pending microtasks/ticks/timers to settle so late pipeline rejections are caught.
    await new Promise((resolveTick) => setTimeout(resolveTick, 25));
    assert.deepEqual(unhandledRejections, [], `Expected no unhandledRejection, got: ${unhandledRejections.map((e) => e?.stack || e).join("\n")}`);
    assert.deepEqual(uncaughtExceptions, [], `Expected no uncaughtException, got: ${uncaughtExceptions.map((e) => e?.stack || e).join("\n")}`);
  } finally {
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
  }
}

function createHeaderCapturingWritable(options) {
  const writable = new Writable(options);
  writable.statusCode = null;
  writable.headers = {};
  writable.writeHead = function writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = { ...headers };
  };
  return writable;
}

test("backupDownloadRoute streams a valid multi-chunk .tar.gz under backpressure and preserves both members byte-for-byte", async () => {
  await withRejectionGuard(async () => {
    const backupName = "dune-db-survival_1__20260901-120000.dump";
    const chunkCount = 12;
    const chunkSize = 8192;
    const backupPayload = Buffer.alloc(chunkCount * chunkSize);
    for (let i = 0; i < backupPayload.length; i += 1) backupPayload[i] = (i * 31 + 7) & 0xff;
    const yamlPayload = Buffer.from("battlegroup_id: sh-1842e91d579eb145-aohwkl\nbackup_origin: manual\n", "utf8");

    const receivedChunks = [];
    const res = createHeaderCapturingWritable({
      highWaterMark: 1024,
      write(chunk, _encoding, callback) {
        receivedChunks.push(Buffer.from(chunk));
        setTimeout(callback, 1);
      }
    });

    const route = buildBackupDownloadRoute({
      statSync(filePath) {
        if (filePath.endsWith(".yaml")) return { size: yamlPayload.length };
        return { size: backupPayload.length };
      },
      createReadStream(filePath) {
        const buffer = filePath.endsWith(".yaml") ? yamlPayload : backupPayload;
        let offset = 0;
        return new Readable({
          read() {
            setImmediate(() => {
              if (offset >= buffer.length) {
                this.push(null);
                return;
              }
              const next = buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length));
              offset += next.length;
              this.push(next);
            });
          }
        });
      }
    });

    await route({}, res, backupName);
    await finished(res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "application/gzip");
    assert.match(res.headers["content-disposition"], new RegExp(`${backupName}\\.tar\\.gz`));
    assert.equal(res.writableFinished, true);

    const compressed = Buffer.concat(receivedChunks);
    const tarBytes = gunzipSync(compressed);
    assert.ok(tarBytes.length > backupPayload.length + yamlPayload.length);

    const extractDir = mkdtempSync(join(tmpdir(), "dune-backup-dl-verify-"));
    try {
      const archiveFile = join(extractDir, `${backupName}.tar.gz`);
      writeFileSync(archiveFile, compressed);
      const listed = execFileSync("tar", ["-tzf", archiveFile], { encoding: "utf8" }).trim().split(/\r?\n/);
      assert.deepEqual(listed, [backupName, `${backupName}.yaml`]);

      execFileSync("tar", ["-xzf", archiveFile, "-C", extractDir]);
      assert.deepEqual(readFileSync(join(extractDir, backupName)), backupPayload);
      assert.deepEqual(readFileSync(join(extractDir, `${backupName}.yaml`)), yamlPayload);
    } finally {
      rmSync(extractDir, { recursive: true, force: true });
    }
  });
});

test("backupDownloadRoute handles client disconnect during multi-chunk transfer without unhandled rejection", async () => {
  for (const disconnectMode of ["write-error", "premature-destroy"]) {
    await withRejectionGuard(async () => {
      const backupName = "dune-db-survival_1__20260901-120000.dump";
      const totalChunks = 16;
      const chunkSize = 16384;
      const spawnedSources = [];

      let writeCount = 0;
      const res = createHeaderCapturingWritable({
        write(_chunk, _encoding, callback) {
          writeCount += 1;
          if (writeCount === 2) {
            if (disconnectMode === "write-error") {
              callback(new Error("Simulated client disconnect during download"));
            } else {
              this.destroy();
            }
            return;
          }
          callback();
        }
      });

      const route = buildBackupDownloadRoute({
        statSync(filePath) {
          return { size: filePath.endsWith(".yaml") ? 64 : totalChunks * chunkSize };
        },
        createReadStream() {
          let emitted = 0;
          let timer = null;
          const source = new Readable({
            read() {
              timer = setTimeout(() => {
                emitted += 1;
                if (emitted <= totalChunks) {
                  this.push(Buffer.alloc(chunkSize, emitted));
                } else {
                  this.push(null);
                }
              }, 3);
            },
            destroy(err, callback) {
              if (timer) clearTimeout(timer);
              callback(err);
            }
          });
          spawnedSources.push(source);
          return source;
        }
      });

      await route({}, res, backupName);
      assert.equal(res.destroyed, true, `response must be destroyed (${disconnectMode})`);
      assert.equal(res.writableFinished, false, `response must not finish cleanly on disconnect (${disconnectMode})`);
      assert.ok(spawnedSources.length >= 1, "at least the first member stream must have started");
      for (const source of spawnedSources) {
        assert.equal(source.destroyed, true, `source stream must be torn down (${disconnectMode})`);
      }
    });
  }
});

test("backupDownloadRoute handles multi-chunk source-read failure and tears down output pipeline without unhandled rejection", async () => {
  await withRejectionGuard(async () => {
    const backupName = "dune-db-survival_1__20260901-120000.dump";
    const totalChunks = 10;
    const chunkSize = 16384;
    const spawnedSources = [];

    const res = createHeaderCapturingWritable({
      write(_chunk, _encoding, callback) {
        callback();
      }
    });

    const route = buildBackupDownloadRoute({
      statSync() {
        return { size: totalChunks * chunkSize };
      },
      createReadStream() {
        let emitted = 0;
        const source = new Readable({
          read() {
            setImmediate(() => {
              emitted += 1;
              if (emitted === 4) {
                this.destroy(new Error("Simulated disk read EIO failure"));
                return;
              }
              this.push(Buffer.alloc(chunkSize, 0x42));
            });
          }
        });
        spawnedSources.push(source);
        return source;
      }
    });

    await route({}, res, backupName);
    let streamError = null;
    await finished(res).catch((err) => {
      streamError = err;
    });

    assert.equal(res.destroyed, true);
    assert.equal(res.writableFinished, false);
    assert.match(String(streamError?.message || res.errored?.message || ""), /Simulated disk read EIO failure/);
    assert.equal(spawnedSources.length, 1, "second member must not be opened after first member fails");
    assert.equal(spawnedSources[0].destroyed, true);
  });
});

test("backupDownloadRoute handles multi-chunk file-size mismatch (truncated and grown) without unhandled rejection", async () => {
  for (const mismatchCase of [
    { label: "truncated", declaredChunks: 8, actualChunks: 4 },
    { label: "grown", declaredChunks: 4, actualChunks: 8 }
  ]) {
    await withRejectionGuard(async () => {
      const backupName = "dune-db-survival_1__20260901-120000.dump";
      const chunkSize = 8192;
      const spawnedSources = [];

      const res = createHeaderCapturingWritable({
        write(_chunk, _encoding, callback) {
          callback();
        }
      });

      const route = buildBackupDownloadRoute({
        statSync() {
          return { size: mismatchCase.declaredChunks * chunkSize };
        },
        createReadStream() {
          let emitted = 0;
          const source = new Readable({
            read() {
              setImmediate(() => {
                emitted += 1;
                if (emitted <= mismatchCase.actualChunks) {
                  this.push(Buffer.alloc(chunkSize, 0x55));
                } else {
                  this.push(null);
                }
              });
            }
          });
          spawnedSources.push(source);
          return source;
        }
      });

      await route({}, res, backupName);
      let streamError = null;
      await finished(res).catch((err) => {
        streamError = err;
      });

      assert.equal(res.destroyed, true, `response must be destroyed (${mismatchCase.label})`);
      assert.equal(res.writableFinished, false, `response must not complete normally (${mismatchCase.label})`);
      assert.match(String(streamError?.message || res.errored?.message || ""), /Backup file size changed during download/);
      assert.equal(spawnedSources.length, 1, `second member must not be streamed on size mismatch (${mismatchCase.label})`);
      assert.equal(spawnedSources[0].destroyed, true, `source must be destroyed (${mismatchCase.label})`);
    });
  }
});

test("start-rabbitmq.sh preserves default public game HTTP binding, localhost shortcut, custom ports, and opt-in bind IP", () => {
  const work = mkdtempSync(join(tmpdir(), "dune-rmq-launch-test-"));
  try {
    const launchRepo = join(work, "repo");
    const binDir = join(work, "bin");
    const captureDir = join(work, "captures");
    mkdirSync(join(launchRepo, "runtime/rabbitmq-game/certs"), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    cpSync(join(repoRoot, "runtime/scripts"), join(launchRepo, "runtime/scripts"), { recursive: true });

    for (const pem of ["key.pem", "cert.pem", "cacert.pem"]) {
      writeFileSync(join(launchRepo, "runtime/rabbitmq-game/certs", pem), "dummy\n");
    }

    writeFileSync(join(binDir, "sleep"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    writeFileSync(
      join(binDir, "docker"),
      `#!/usr/bin/env bash
if [ "$1" = "run" ]; then
  container=""
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "--name" ]; then
      container="$arg"
      break
    fi
    prev="$arg"
  done
  printf '%s\\n' "$*" > "\${DOCKER_RUN_CAPTURE_DIR}/\${container}.args"
fi
exit 0
`,
      { mode: 0o755 }
    );

    const runStub = (extraEnv = {}) => {
      rmSync(captureDir, { recursive: true, force: true });
      mkdirSync(captureDir, { recursive: true });
      const env = {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ""}`,
        DOCKER_RUN_CAPTURE_DIR: captureDir
      };
      delete env.RMQ_GAME_HTTP_BIND_IP;
      delete env.RMQ_GAME_HTTP_PORT;
      delete env.RMQ_GAME_LOCAL_HTTP_PORT;
      delete env.RMQ_GAME_PORT;
      Object.assign(env, extraEnv);
      const res = spawnSync("bash", [join(launchRepo, "runtime/scripts/start-rabbitmq.sh")], {
        cwd: launchRepo,
        env,
        encoding: "utf8"
      });
      assert.equal(res.status, 0, `start-rabbitmq.sh failed: ${res.stderr}`);
      return {
        admin: readFileSync(join(captureDir, "dune-rmq-admin.args"), "utf8"),
        game: readFileSync(join(captureDir, "dune-rmq-game.args"), "utf8")
      };
    };

    // 1. Default stock bindings: public 31983 + loopback shortcut 127.0.0.1:15672
    const stock = runStub();
    assert.match(stock.admin, /-p 127\.0\.0\.1:32573:5672\b/);
    assert.match(stock.admin, /-p 127\.0\.0\.1:32574:15672\/tcp\b/);
    assert.match(stock.game, /-p 31982:5672\/tcp\b/);
    assert.match(stock.game, /-p 127\.0\.0\.1:15672:15672\/tcp\b/);
    assert.match(stock.game, /-p 31983:15672\/tcp\b/);
    assert.doesNotMatch(stock.game, /127\.0\.0\.1:31983:15672\/tcp/);

    // 2. Custom game HTTP & localhost shortcut ports remain public + loopback respectively
    writeFileSync(
      join(launchRepo, ".env"),
      "RMQ_GAME_PORT=32982\nRMQ_GAME_HTTP_PORT=32983\nRMQ_GAME_LOCAL_HTTP_PORT=16672\n"
    );
    const custom = runStub();
    assert.match(custom.game, /-p 32982:5672\/tcp\b/);
    assert.match(custom.game, /-p 127\.0\.0\.1:16672:15672\/tcp\b/);
    assert.match(custom.game, /-p 32983:15672\/tcp\b/);
    assert.doesNotMatch(custom.game, /127\.0\.0\.1:32983:15672\/tcp/);

    // 3. Opt-in RMQ_GAME_HTTP_BIND_IP restricts the external port while preserving custom ports & localhost shortcut
    const restrictedCustom = runStub({ RMQ_GAME_HTTP_BIND_IP: "192.0.2.10" });
    assert.match(restrictedCustom.game, /-p 127\.0\.0\.1:16672:15672\/tcp\b/);
    assert.match(restrictedCustom.game, /-p 192\.0\.2\.10:32983:15672\/tcp\b/);

    rmSync(join(launchRepo, ".env"), { force: true });
    const restrictedStock = runStub({ RMQ_GAME_HTTP_BIND_IP: "127.0.0.1" });
    assert.match(restrictedStock.game, /-p 127\.0\.0\.1:15672:15672\/tcp\b/);
    assert.match(restrictedStock.game, /-p 127\.0\.0\.1:31983:15672\/tcp\b/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
