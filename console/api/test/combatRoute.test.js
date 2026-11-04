import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiKeyStore } from '../src/apiKeys.js';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

async function getFreePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function startConsole(port, dir, env) {
  const child = spawn(process.execPath, [new URL('../src/server.js', import.meta.url).pathname], {
    env: { ...process.env, DUNE_DOCKER_DIR: dir, ADMIN_BIND_PORT: String(port), ADMIN_SECURE_COOKIES: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  return { child, logs: () => output };
}

async function waitForHealth(port, timeout, logs) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Isolated Console did not start: ${logs()}`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

test('combat endpoint requires authentication and the existing player-data scope over HTTP', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dune-combat-route-'));
  let child;
  try {
    const store = createApiKeyStore({ file: join(dir, 'runtime/secrets/api-keys.json') });
    const allowed = await store.create({ name: 'Player reader', scopes: { players: 'read' } });
    const denied = await store.create({ name: 'Server reader', scopes: { server: 'read' } });
    const port = await getFreePort();
    const process = startConsole(port, dir, {
      ADMIN_BIND_HOST: '127.0.0.1', ADMIN_MOCK_MODE: '1', ADMIN_AUTH_DISABLED: '0',
      ADMIN_PASSWORD: 'synthetic-test-password-only', ADMIN_AUTO_START_STACK_ON_BOOT: '0'
    });
    child = process.child;
    await waitForHealth(port, 30_000, process.logs);
    const request = (secret, query = '') => fetch(`http://127.0.0.1:${port}/api/players/combat${query}`,
      { headers: secret ? { authorization: `Bearer ${secret}` } : {} });
    assert.equal((await request()).status, 401);
    assert.equal((await request(denied.secret)).status, 403);
    const response = await request(allowed.secret);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.supported, false);
    assert.deepEqual(body.leaderboard, []);
    assert.equal((await request(allowed.secret, '?controllerId=invalid')).status, 400);
    assert.equal((await request(allowed.secret, '?leaderboardLimit=all&killsLimit=20')).status, 200);
    assert.equal((await request(denied.secret, '?leaderboardLimit=all&killsLimit=all')).status, 403);
    assert.equal((await request(allowed.secret, '?leaderboardLimit=500')).status, 400);
    assert.equal((await request(allowed.secret, '?killsLimit=-1')).status, 400);
    const settings = secret => fetch(`http://127.0.0.1:${port}/api/players/list-settings`,
      { headers: secret ? { authorization: `Bearer ${secret}` } : {} });
    assert.equal((await settings()).status, 401);
    assert.equal((await settings(denied.secret)).status, 403);
    const visibility = await settings(allowed.secret);
    assert.equal(visibility.status, 200);
    assert.equal((await visibility.json()).pvpVisible, true);
  } finally {
    await stopProcess(child);
    rmSync(dir, { recursive: true, force: true });
  }
});
