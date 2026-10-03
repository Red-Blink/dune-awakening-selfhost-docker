// Realtime Data: live sandworms, enemies, civilians, vehicles and sandstorms
// (optionally players) read from the game server processes by the optional
// MapViewer3D position agent `mvagent`
// (https://github.com/dev-prophet-code/MapViewer3D/tree/ddp).
//
// The agent has no login and listens on loopback only. The Console is the one
// door to it: every request is authenticated and authorized here like any
// other API call (API key scope "Realtime Data" = realtime:read), so enabling,
// disabling, expiring or revoking a key turns the stream on and off.
//
// Player objects leave only when the caller may also read players
// (players:read); otherwise they are removed from snapshots and their position
// updates are dropped.
import http from "node:http";
import { withSecurityHeaders } from "../auth.js";

export const REALTIME_VERSION = 1;
export const REALTIME_KINDS = ["worm", "vehicle", "npc", "civilian", "storm", "coriolis"];

const DEFAULT_AGENT_URL = "http://127.0.0.1:8796";
const HEALTH_TIMEOUT_MS = 3000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const RECHECK_MS = 10_000;

export class RealtimeError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.name = "RealtimeError";
    this.status = status;
  }
}

// Only plain HTTP on loopback: the agent has no login, so it must never be
// reached over a network.
export function parseAgentUrl(value) {
  let url;
  try {
    url = new URL(String(value || DEFAULT_AGENT_URL));
  } catch {
    throw new RealtimeError("DUNE_REALTIME_AGENT_URL is not a valid URL.", 500);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || !["127.0.0.1", "::1", "localhost"].includes(host) || url.username || url.password) {
    throw new RealtimeError("DUNE_REALTIME_AGENT_URL must be http://127.0.0.1:<port> (the agent has no login).", 500);
  }
  return url;
}

// What the Console passes on about the game server processes: no PIDs.
function publicSources(sources) {
  return (Array.isArray(sources) ? sources : []).map((source) => {
    const out = { map: source.map, partition: source.partition, ready: Boolean(source.ready), n: source.n || 0 };
    if (source.reason) out.reason = String(source.reason);
    if (source.weather) out.weather = source.weather;
    return out;
  });
}

function filterSnapshot(snapshot, allowPlayers) {
  const objects = Array.isArray(snapshot?.objects) ? snapshot.objects : [];
  const kept = allowPlayers ? objects : objects.filter((object) => object?.k !== "player");
  return { ...snapshot, sources: publicSources(snapshot?.sources), objects: kept };
}

export function createRealtime({
  agentUrl = process.env.DUNE_REALTIME_AGENT_URL,
  maxStreams = 16,
  maxStreamsPerPrincipal = 4,
  recheckMs = RECHECK_MS
} = {}) {
  const base = parseAgentUrl(agentUrl);
  const open = new Map(); // principal -> number of open streams
  let total = 0;

  function get(path, { timeout = HEALTH_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      const request = http.get(new URL(path, base), { timeout, headers: { accept: "application/json" } }, (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) request.destroy(new Error("agent answer too large"));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          if (response.statusCode !== 200) return reject(new Error(`agent HTTP ${response.statusCode}`));
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("agent sent invalid JSON"));
          }
        });
      });
      request.on("timeout", () => request.destroy(new Error("agent timeout")));
      request.on("error", reject);
    });
  }

  return {
    // GET /api/realtime/healthz. 503 when the agent is not installed or down.
    async health() {
      let answer;
      try {
        answer = await get("/healthz");
      } catch {
        throw new RealtimeError("Realtime Data is not available: the MapViewer3D position agent is not running on this host.", 503);
      }
      return { available: true, version: REALTIME_VERSION, ok: Boolean(answer?.ok), ready: Number(answer?.ready) || 0, sources: publicSources(answer?.sources) };
    },

    // GET /api/realtime/objects
    async objects({ allowPlayers }) {
      const kinds = allowPlayers ? [...REALTIME_KINDS, "player"] : REALTIME_KINDS;
      let snapshot;
      try {
        snapshot = await get(`/api/objects?kinds=${kinds.join(",")}`, { timeout: 10_000 });
      } catch {
        throw new RealtimeError("Realtime Data is not available: the MapViewer3D position agent is not running on this host.", 503);
      }
      return filterSnapshot(snapshot, allowPlayers);
    },

    // GET /api/realtime/stream (server-sent events, same events as the agent).
    // allowPlayers and stillAllowed are re-evaluated every recheckMs, so a
    // disabled, expired or revoked key (or a removed scope) ends the stream.
    stream(req, res, { principal, allowPlayers, stillAllowed }) {
      const mine = open.get(principal) || 0;
      if (total >= maxStreams || mine >= maxStreamsPerPrincipal) {
        res.writeHead(429, withSecurityHeaders({ "content-type": "application/json; charset=utf-8", "retry-after": "30" }));
        res.end(JSON.stringify({ error: "Too many open Realtime Data streams. Close another viewer and try again." }));
        return;
      }
      open.set(principal, mine + 1);
      total += 1;

      let players = Boolean(allowPlayers());
      let visible = new Set(); // object ids the caller may see
      let pending = "";
      let finished = false;

      const upstream = http.get(new URL("/stream", base), { headers: { accept: "text/event-stream" } });
      const recheck = setInterval(() => {
        if (!stillAllowed()) return finish();
        const nextPlayers = Boolean(allowPlayers());
        // Previously admitted player IDs remain in the delta cache until the
        // next snapshot. End this stream on a downgrade rather than leaking
        // their positions in the meantime; reconnect applies the new scope.
        if (players && !nextPlayers) return finish();
        players = nextPlayers;
      }, recheckMs);

      function finish() {
        if (finished) return;
        finished = true;
        clearInterval(recheck);
        upstream.destroy();
        if (!res.writableEnded) res.end();
        const left = (open.get(principal) || 1) - 1;
        if (left > 0) open.set(principal, left);
        else open.delete(principal);
        total -= 1;
      }

      function send(text) {
        if (finished) return;
        res.write(text);
        if (res.writableLength > MAX_BUFFERED_BYTES) finish(); // the client stopped reading
      }

      function handle(block) {
        if (block.startsWith(":")) return send(`${block}\n\n`); // keep-alive comment
        let name = "";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) name = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        let payload;
        try {
          payload = JSON.parse(data);
        } catch {
          return;
        }
        if (name === "snap") {
          const snapshot = filterSnapshot(payload, players);
          visible = new Set(snapshot.objects.map((object) => object.i));
          send(`event: snap\ndata: ${JSON.stringify(snapshot)}\n\n`);
        } else if (name === "pos") {
          const d = Array.isArray(payload.d) ? payload.d.filter((entry) => visible.has(entry?.[0])) : [];
          const r = Array.isArray(payload.r) ? payload.r.filter((id) => visible.has(id)) : [];
          for (const id of r) visible.delete(id);
          if (d.length || r.length) send(`event: pos\ndata: ${JSON.stringify({ gen: payload.gen, t: payload.t, d, r })}\n\n`);
        }
        // anything else is not forwarded
      }

      upstream.on("response", (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          if (!res.headersSent) {
            res.writeHead(503, withSecurityHeaders({ "content-type": "application/json; charset=utf-8" }));
            res.end(JSON.stringify({ error: "Realtime Data is not available right now." }));
          }
          return finish();
        }
        res.writeHead(200, withSecurityHeaders({
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          "x-accel-buffering": "no"
        }));
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          pending += chunk;
          if (pending.length > MAX_BODY_BYTES) return finish();
          let index;
          while ((index = pending.indexOf("\n\n")) >= 0) {
            const block = pending.slice(0, index).replace(/\r/g, "");
            pending = pending.slice(index + 2);
            if (block) handle(block);
          }
        });
        response.on("end", finish);
        response.on("error", finish);
      });
      upstream.on("error", () => {
        if (!res.headersSent) {
          res.writeHead(503, withSecurityHeaders({ "content-type": "application/json; charset=utf-8" }));
          res.end(JSON.stringify({ error: "Realtime Data is not available: the MapViewer3D position agent is not running on this host." }));
        }
        finish();
      });
      req.on("close", finish);
      res.on("close", finish);
    },

    openStreams() {
      return total;
    }
  };
}
