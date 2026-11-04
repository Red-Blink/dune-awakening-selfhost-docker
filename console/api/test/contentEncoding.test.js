import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync, brotliDecompressSync } from "node:zlib";
import { preferredContentEncoding } from "../src/http/contentEncoding.js";
import { json } from "../src/auth.js";

test("encoding quality weights, wildcard and explicit exclusions are honored", () => {
  for (const [header, expected] of [["", null], ["br, gzip", "br"], ["br;q=0, gzip;q=1", "gzip"], ["gzip;q=0, br;q=0", null], ["br;q=.2, gzip;q=.8", "gzip"], ["br;q=0, *;q=.5", "gzip"]]) assert.equal(preferredContentEncoding(header), expected);
});

test("JSON responses negotiate encoding and always vary even for identity", () => {
  const body = { text: "Synthetic response ".repeat(200) };
  for (const [header, encoding] of [["br;q=0, gzip", "gzip"], ["gzip, br", "br"], ["br;q=0, gzip;q=0", undefined], ["", undefined]]) {
    let headers, content;
    json({ req: { headers: { "accept-encoding": header } }, writeHead(_status, h) { headers = h; }, end(c) { content = c; } }, 200, body);
    assert.equal(headers["content-encoding"], encoding);
    assert.equal(headers.vary, "Accept-Encoding");
    const decoded = encoding === "gzip" ? gunzipSync(content).toString() : encoding === "br" ? brotliDecompressSync(content).toString() : content;
    assert.deepEqual(JSON.parse(decoded), body);
  }
});
