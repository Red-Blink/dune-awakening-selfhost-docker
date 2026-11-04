import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listReadyRabbitQueues } from '../src/rmq.js';

test('credential rotation invalidates queue caches without allowing an old in-flight response back in', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rmq-rotation-'));
  const saved = { ...process.env };
  try {
    delete process.env.DUNE_RMQ_TRANSPORT;
    process.env.DUNE_RMQ_ADMIN_USER = 'synthetic-user';
    process.env.DUNE_RMQ_ADMIN_PASSWORD = 'synthetic-before';
    const config = { repoRoot: root, commandTimeoutMs: 1000 };
    let finishOld;
    let calls = 0;
    const fetchImpl = async (_url, options) => {
      calls++;
      const auth = Buffer.from(options.headers.Authorization.slice(6), 'base64').toString();
      const response = name => ({ ok: true, json: async () => [{ name, consumers: 1, state: 'running' }] });
      if (auth === 'synthetic-user:synthetic-before') {
        return new Promise(resolve => { finishOld = () => resolve(response('before')); });
      }
      assert.equal(auth, 'synthetic-user:synthetic-after');
      return response('after');
    };
    const options = { fetchImpl, now: () => 1000, exec: async () => { throw new Error('Unexpected exec'); } };
    const oldRequest = listReadyRabbitQueues(config, options);
    process.env.DUNE_RMQ_ADMIN_PASSWORD = 'synthetic-after';
    assert.deepEqual([...(await listReadyRabbitQueues(config, options))], ['after']);
    finishOld();
    assert.deepEqual([...(await oldRequest)], ['before']);
    assert.deepEqual([...(await listReadyRabbitQueues(config, options))], ['after']);
    assert.equal(calls, 2);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
});

test('HTTP queue discovery scopes credentials and cache, expires, and falls back safely', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rmq-http-'));
  const saved = { ...process.env };
  try {
    delete process.env.DUNE_RMQ_TRANSPORT;
    delete process.env.DUNE_RMQ_ADMIN_USER;
    delete process.env.DUNE_RMQ_ADMIN_PASSWORD;
    delete process.env.DUNE_RMQ_GAME_HTTP_URL;
    process.env.RMQ_GAME_LOCAL_HTTP_PORT = '16672';
    process.env.RMQ_GAME_HTTP_PORT = '31983';
    for (const name of ['a', 'b']) {
      mkdirSync(join(root, name, 'runtime/text-router'), { recursive: true });
      writeFileSync(join(root, name, 'runtime/text-router/director-current.log'),
        `bgd.old.admin/OldFake => allow administrator\nGenerated new admin credentials: bgd.${name}.admin / FakeNew\n`);
    }
    let clock = 1000;
    let calls = 0;
    const config = (name) => ({ repoRoot: join(root, name), commandTimeoutMs: 1000 });
    const fetchImpl = async (url, opts) => {
      calls++;
      assert.ok(url.startsWith('http://127.0.0.1:16672/'));
      const name = Buffer.from(opts.headers.Authorization.slice(6), 'base64').toString();
      assert.match(name, /^bgd\.[ab]\.admin:FakeNew$/);
      return { ok: true, json: async () => [
        { name, consumers: 1, state: 'running' },
        { name: 'idle', consumers: 0 }, { name: 'stopped', consumers: 1, state: 'down' }
      ] };
    };
    const options = { fetchImpl, exec: async () => { throw new Error('Unexpected exec'); }, now: () => clock };
    const first = await listReadyRabbitQueues(config('a'), options);
    assert.deepEqual([...first], ['bgd.a.admin:FakeNew']);
    first.clear();
    assert.equal((await listReadyRabbitQueues(config('a'), options)).size, 1);
    assert.equal(calls, 1);
    assert.deepEqual([...(await listReadyRabbitQueues(config('b'), options))], ['bgd.b.admin:FakeNew']);
    clock += 5001;
    await listReadyRabbitQueues(config('a'), options);
    assert.equal(calls, 3);
    process.env.RMQ_GAME_LOCAL_HTTP_PORT = '16673';
    let fallbacks = 0;
    const fallback = await listReadyRabbitQueues(config('a'), {
      now: () => clock, fetchImpl: async () => ({ ok: false, status: 401 }),
      exec: async () => { fallbacks++; return { stdout: 'fallback 1 running\nidle 0 running\n' }; }
    });
    assert.deepEqual([...fallback], ['fallback']);
    assert.equal(fallbacks, 1);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
});
