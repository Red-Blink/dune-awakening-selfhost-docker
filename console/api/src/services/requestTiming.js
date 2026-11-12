import { performance } from "node:perf_hooks";
import { actionForRoute, ROUTE_ACTIONS, REGEX_ACTIONS, REGEX_ACTIONS_BY_METHOD, REGEX_ACTIONS_BY_METHOD_PATTERN } from "../actions.js";
import { writeDiagnostic } from "./diagnosticLog.js";
import { DISCORD_ADAPTER_ROUTES } from "../integrations/discord/adapter.js";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);
// These handlers do not use IAM's action catalog. Keep diagnostic labels
// separate from authorization, and reuse the adapter's canonical route names.
const NON_IAM_ROUTES = new Set([
  "/api/health", "/api/auth/state", "/api/auth/login", "/api/auth/logout",
  "/api/i18n/languages", "/api/i18n/translations", "/api/i18n/mesh/manifest",
  "/api/i18n/mesh/pack", "/api/i18n/mesh/push",
  ...Object.values(DISCORD_ADAPTER_ROUTES)
]);

// Every returned string comes from the static route registry, never from a
// dynamic identifier, query parameter, request body, cookie or authorization.
export function requestRouteLabel(path, method) {
  if (NON_IAM_ROUTES.has(path)) return path;
  const key = `${method} ${path}`;
  if (Object.hasOwn(ROUTE_ACTIONS, key)) return key.slice(method.length + 1);
  for (const entry of REGEX_ACTIONS_BY_METHOD_PATTERN) {
    if (entry.method === method && entry.pattern.test(path)) return entry.pattern.source;
  }
  for (const key of Object.keys(REGEX_ACTIONS_BY_METHOD)) {
    const [verb, prefix] = key.split(" ", 2);
    if (verb === method && path.startsWith(prefix)) return `${prefix}*`;
  }
  for (const [prefix] of REGEX_ACTIONS) {
    if (path.startsWith(prefix)) return `${prefix}*`;
  }
  return "/api/*";
}

function clientKind(req) {
  const agent = String(req.headers?.["user-agent"] || "").slice(0, 512);
  if (/curl\/|wget\//i.test(agent)) return "cli";
  if (/python|axios|undici|node-fetch|Go-http-client|Postman/i.test(agent)) return "automation";
  if (/Mozilla\//i.test(agent)) return "browser";
  return "other";
}

export function createRequestTimingLogger({ write = writeDiagnostic, now = Date.now, monotonic = () => performance.now() } = {}) {
  return (req, res) => {
    const path = String(req.url || "").split(/[?#]/, 1)[0];
    if (!path.startsWith("/api/")) return;
    const method = METHODS.has(req.method) ? req.method : "OTHER";
    const route = requestRouteLabel(path, method);
    const action = actionForRoute(path, method);
    const startedAt = new Date(now()).toISOString(), started = monotonic();
    const client = clientKind(req);
    let finished = false;
    const complete = () => {
      if (finished) return;
      finished = true;
      try {
        write({ at: new Date(now()).toISOString(), event: "console.request", startedAt,
          method, route, action, status: res.writableFinished ? res.statusCode : 499,
          durationMs: Math.max(0, Math.round((monotonic() - started) * 100) / 100),
          client, authentication: req.authSession?.apiKeyId ? "api-key" : req.authSession ? "session" : "anonymous" });
      } catch {
        // Logs are diagnostic, not part of request success or authentication.
      }
    };
    res.once("finish", complete);
    res.once("close", complete);
  };
}
