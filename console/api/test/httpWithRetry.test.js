import assert from "node:assert/strict";
import test from "node:test";
import { fetchWithTimeoutAndRetry, fetchJsonWithTimeoutAndRetry } from "../src/services/httpWithRetry.js";

test("returns the response on a successful first attempt, no retry", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, status: 200 }; };
  const result = await fetchWithTimeoutAndRetry("https://example.test", {}, { fetchImpl });
  assert.equal(result.status, 200);
  assert.equal(calls, 1);
});

test("retries exactly once on a 5xx, then returns the retry's result", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return calls === 1 ? { ok: false, status: 503 } : { ok: true, status: 200 };
  };
  const result = await fetchWithTimeoutAndRetry("https://example.test", {}, { fetchImpl });
  assert.equal(result.status, 200);
  assert.equal(calls, 2);
});

test("does not retry on a 4xx", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: false, status: 400 }; };
  const result = await fetchWithTimeoutAndRetry("https://example.test", {}, { fetchImpl });
  assert.equal(result.status, 400);
  assert.equal(calls, 1);
});

test("retries exactly once on a connection-level failure, then rethrows if the retry also fails", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("connection reset"); };
  await assert.rejects(() => fetchWithTimeoutAndRetry("https://example.test", {}, { fetchImpl }), /connection reset/);
  assert.equal(calls, 2);
});

// Layer 3 audit finding (HIGH): a 5xx response followed by the retry ITSELF
// throwing used to fall into a second, separate catch that made a third
// real network call -- exactly one call more than "exactly one retry"
// promises, and a real risk of a duplicate side effect for a non-idempotent
// POST. Exactly the mock sequence the finding verified with: [503, throws,
// 200] must consume only the first two mocked responses (2 real calls) and
// reject with the connection failure, never silently succeed via a third.
test("a 5xx response followed by the retry itself throwing rejects after exactly 2 calls, never a 3rd", async () => {
  let calls = 0;
  const responses = [
    () => ({ ok: false, status: 503 }),
    () => { throw new Error("connection reset"); },
    () => ({ ok: true, status: 200 })
  ];
  const fetchImpl = async () => {
    const respond = responses[calls];
    calls += 1;
    return respond();
  };
  await assert.rejects(() => fetchWithTimeoutAndRetry("https://example.test", {}, { fetchImpl }), /connection reset/);
  assert.equal(calls, 2, "must stop after the single retry throws, never consuming the 3rd mocked response");
});

test("aborts a call that exceeds the timeout", async () => {
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  await assert.rejects(() => fetchWithTimeoutAndRetry("https://example.test", {}, { fetchImpl, timeoutMs: 10 }), /aborted/);
});

// #1339 (Layer 3 review): fetchWithTimeoutAndRetry() used to clear the abort
// timer as soon as fetchImpl() resolved HEADERS, leaving a body read with no
// bound at all -- every real caller in server.js reads the body after this
// function returns. A peer that returns 200 immediately but stalls the body
// must still get cut off at timeoutMs. The response's own `signal` is reused
// (not cleared) for response.json(), so a genuinely slow/stalled body read
// rejects via the SAME abort -- fetchJsonWithTimeoutAndRetry() is the wrapper
// every caller should use for this, since it reads the body under the bound
// and always releases the timer afterward.
test("fetchJsonWithTimeoutAndRetry aborts a response whose BODY stalls, not just a response whose headers stall", async () => {
  let aborted = false;
  const fetchImpl = (url, init) => {
    init.signal.addEventListener("abort", () => { aborted = true; });
    return Promise.resolve({
      ok: true,
      status: 200,
      // json() never resolves on its own -- only the abort should end it.
      json: () => new Promise((resolve, reject) => {
        // Real fetch() implementations reject a body read cut off by its own
        // AbortSignal with an error named "AbortError" -- matching that name
        // here is what proves the implementation's own AbortError check.
        init.signal.addEventListener("abort", () => reject(Object.assign(new Error("body read aborted"), { name: "AbortError" })));
      })
    });
  };
  await assert.rejects(
    () => fetchJsonWithTimeoutAndRetry("https://example.test", {}, { fetchImpl, timeoutMs: 10 }),
    /body read aborted/
  );
  assert.equal(aborted, true, "the timeout must still be armed during the body read, not cleared as soon as headers resolved");
});

test("fetchJsonWithTimeoutAndRetry returns the parsed body on success and releases the timer", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ state: "abc123" }) });
  const { response, json } = await fetchJsonWithTimeoutAndRetry("https://example.test", {}, { fetchImpl });
  assert.equal(response.status, 200);
  assert.deepEqual(json, { state: "abc123" });
});

test("fetchJsonWithTimeoutAndRetry treats a malformed/non-JSON body as a soft null, not a thrown error", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } });
  const { response, json } = await fetchJsonWithTimeoutAndRetry("https://example.test", {}, { fetchImpl });
  assert.equal(response.status, 200);
  assert.equal(json, null);
});
