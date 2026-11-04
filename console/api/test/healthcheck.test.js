import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { resolveAdminBindHost } from "../src/config.js";

test("Compose resolves the image healthcheck independently of its /repo working directory", () => {
  const compose = readFileSync(new URL("../../../docker-compose.web.yml", import.meta.url), "utf8");
  assert.match(compose, /test: \["CMD", "node", "\/app\/src\/healthcheck.js"\]/);
});

for (const host of ["127.0.0.2", "auto"]) test(`Console healthcheck follows the ${host} bind address and port`, async t => {
  const server = createServer((req, res) => { assert.equal(req.url, "/api/health"); res.end("ok"); });
  server.listen(0, resolveAdminBindHost(host));
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const child = spawn(process.execPath, [new URL("../src/healthcheck.js", import.meta.url).pathname], {
    env: { ...process.env, ADMIN_BIND_HOST: host, ADMIN_BIND_PORT: String(server.address().port) }, stdio: "ignore"
  });
  assert.equal((await once(child, "exit"))[0], 0);
});
