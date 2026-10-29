import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

test("Console healthcheck follows the configured bind address and port", async t => {
  const server = createServer((req, res) => { assert.equal(req.url, "/api/health"); res.end("ok"); });
  server.listen(0, "127.0.0.2");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const child = spawn(process.execPath, [new URL("../src/healthcheck.js", import.meta.url).pathname], {
    env: { ...process.env, ADMIN_BIND_HOST: "127.0.0.2", ADMIN_BIND_PORT: String(server.address().port) }, stdio: "ignore"
  });
  assert.equal((await once(child, "exit"))[0], 0);
});
