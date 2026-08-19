import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { once } from "node:events";
import { cacheControlForPath, contentTypeForPath, serveStatic } from "../src/http/staticFiles.js";

test("cacheControlForPath caches Vite's hashed /assets files forever, everything else must revalidate", () => {
  assert.equal(cacheControlForPath("/assets/index-a1b2c3.js"), "public, max-age=31536000, immutable");
  assert.equal(cacheControlForPath("/assets/index-a1b2c3.css"), "public, max-age=31536000, immutable");
  // index.html is the SPA shell every navigation and unrecognized route falls
  // back to (safeStaticTarget) -- it must never be cached without
  // revalidation, or a stale copy keeps referencing hashed filenames a later
  // rebuild already replaced.
  assert.equal(cacheControlForPath("/index.html"), "no-cache");
  assert.equal(cacheControlForPath("/"), "no-cache");
  // An unrecognized client-side route also falls back to index.html.
  assert.equal(cacheControlForPath("/some/client/route"), "no-cache");
  // A non-hashed top-level file (e.g. a public/ asset copied verbatim) is not
  // safe to cache aggressively either, since its filename never changes.
  assert.equal(cacheControlForPath("/favicon.svg"), "no-cache");
});

test("contentTypeForPath is unaffected by the cache-control change", () => {
  assert.equal(contentTypeForPath("/app/dist/index.html"), "text/html; charset=utf-8");
  assert.equal(contentTypeForPath("/app/dist/assets/index-abc.js"), "text/javascript; charset=utf-8");
});

// A real Writable so createReadStream(...).pipe(res) works as it does against
// an actual http.ServerResponse, while still capturing writeHead's arguments.
function fakeResponse() {
  const res = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  res.status = null;
  res.headers = null;
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers;
  };
  return res;
}

test("serveStatic sends cache-control: no-cache for index.html and immutable for hashed assets", async () => {
  const dist = mkdtempSync(join(tmpdir(), "static-files-test-"));
  try {
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "index.html"), "<html></html>");
    writeFileSync(join(dist, "assets", "index-deadbeef.js"), "console.log(1);");
    const config = { staticDir: dist, appName: "Test" };

    const htmlRes = fakeResponse();
    serveStatic(config, { url: "/" }, htmlRes);
    await once(htmlRes, "finish");
    assert.equal(htmlRes.status, 200);
    assert.equal(htmlRes.headers["cache-control"], "no-cache");
    assert.equal(htmlRes.headers["content-type"], "text/html; charset=utf-8");

    const assetRes = fakeResponse();
    serveStatic(config, { url: "/assets/index-deadbeef.js" }, assetRes);
    await once(assetRes, "finish");
    assert.equal(assetRes.status, 200);
    assert.equal(assetRes.headers["cache-control"], "public, max-age=31536000, immutable");
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("serveStatic never tags a stale-asset fallback to index.html as an immutable asset", async () => {
  // A pre-update browser can still reference a hashed /assets file a rebuild
  // has since removed. safeStaticTarget falls back to index.html for that
  // request; cacheControlForPath(path) alone would misread the /assets/
  // prefix and cache the HTML shell forever under that JS URL, so no reload
  // could ever recover without a hard refresh.
  const dist = mkdtempSync(join(tmpdir(), "static-files-test-"));
  try {
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "index.html"), "<html></html>");
    writeFileSync(join(dist, "assets", "index-newhash.js"), "console.log(1);");
    const config = { staticDir: dist, appName: "Test" };

    const staleAssetRes = fakeResponse();
    serveStatic(config, { url: "/assets/index-oldhash.js" }, staleAssetRes);
    await once(staleAssetRes, "finish");
    assert.equal(staleAssetRes.status, 200);
    assert.equal(staleAssetRes.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(staleAssetRes.headers["cache-control"], "no-cache");
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});
