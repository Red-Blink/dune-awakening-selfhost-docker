import test from "node:test";
import assert from "node:assert/strict";
import { createInFlightShare } from "../src/inFlightShare.js";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test("concurrent identical calls share one load and nothing is kept afterwards", async () => {
  const share = createInFlightShare();
  const gate = deferred();
  let loads = 0;
  const load = async () => { loads += 1; await gate.promise; return loads; };
  const first = share.share("k", load);
  const second = share.share("k", load);
  gate.resolve();
  assert.equal(await first, 1);
  assert.equal(await second, 1);
  assert.equal(await share.share("k", async () => { loads += 1; return loads; }), 2);
});

test("a call started before bump() is not handed to a request after it", async () => {
  const share = createInFlightShare();
  const gate = deferred();
  const before = share.share("k", async () => { await gate.promise; return "old"; });
  share.bump();
  const after = share.share("k", async () => "new");
  assert.equal(await after, "new");
  gate.resolve();
  assert.equal(await before, "old");
});

test("a rejected load is shared and then forgotten", async () => {
  const share = createInFlightShare();
  const gate = deferred();
  const load = async () => { await gate.promise; throw new Error("boom"); };
  const a = share.share("k", load);
  const b = share.share("k", load);
  gate.resolve();
  await assert.rejects(a, /boom/);
  await assert.rejects(b, /boom/);
  assert.equal(await share.share("k", async () => "fine"), "fine");
});
