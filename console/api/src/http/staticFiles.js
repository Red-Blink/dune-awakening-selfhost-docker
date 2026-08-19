import { existsSync, createReadStream } from "node:fs";
import { extname } from "node:path";
import { json, withSecurityHeaders } from "../auth.js";
import { safeStaticTarget } from "../httpSafety.js";

const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"]
]);

export function contentTypeForPath(target) {
  return mime.get(extname(target)) || "application/octet-stream";
}

// Vite fingerprints every file under its default assetsDir ("/assets") with a
// content hash, so those can be cached forever -- a rebuild that changes their
// content always produces a new filename. Everything else, above all
// index.html (the SPA shell every navigation and every unrecognized route
// falls back to via safeStaticTarget), must never be cached without
// revalidation: without this, a browser holding a stale index.html keeps
// requesting hashed asset filenames a later image rebuild already replaced,
// which looks like "the page doesn't update until I hard refresh."
export function cacheControlForPath(path) {
  return path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
}

export function serveStatic(config, req, res) {
  const path = new URL(req.url || "/", "http://localhost").pathname;
  const target = safeStaticTarget(config.staticDir, path);
  if (!existsSync(target)) {
    json(res, 200, { app: config.appName, message: "Frontend is not built yet. Run npm install && npm run build in console/web/." });
    return;
  }
  // safeStaticTarget silently falls back to index.html for any unrecognized
  // path, including a stale /assets/*.js URL a pre-update browser still
  // references after a rebuild removes it. Deciding cache-control from the
  // *requested* path alone would tag that fallback response -- the HTML
  // shell -- as an immutable JS asset forever, so a stale browser could never
  // recover without a hard refresh. Only the path that actually resolved to
  // a real file under /assets/ earns the long-lived cache.
  const servedRequestedAsset = path.startsWith("/assets/") && !target.endsWith("index.html");
  res.writeHead(200, withSecurityHeaders({ "content-type": contentTypeForPath(target), "cache-control": servedRequestedAsset ? cacheControlForPath(path) : "no-cache" }));
  createReadStream(target).pipe(res);
}
