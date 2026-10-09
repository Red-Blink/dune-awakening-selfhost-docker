# Realtime Data

**Status:** Optional | **Last Updated:** October 2026

The Live Map reads Postgres, so it shows players, vehicles and bases but not
sandworms, NPCs or sandstorms: those exist only in the memory of the running
game server processes. The optional MapViewer3D position agent `mvagent`
([MapViewer3D, branch `ddp`](https://github.com/dev-prophet-code/MapViewer3D/tree/ddp))
reads them there, read-only, about ten times per second. The Console passes
them on as **Realtime Data** to clients that hold the matching permission –
for example a MapViewer3D running on an administrator's PC.

## Setup

The agent runs next to the Console as its own compose project and changes
nothing in the Dune containers. It listens on `127.0.0.1:8796` of the host and
has no login, so it is reachable only through the Console.

```bash
git clone --branch ddp --depth 1 https://github.com/dev-prophet-code/MapViewer3D.git mapviewer-live
cd mapviewer-live && cp .env.example .env
docker compose -f docker-compose.mapviewer-live.yml up -d --build
```

`DUNE_REALTIME_AGENT_URL` (default `http://127.0.0.1:8796`) points the Console
at the agent; only plain HTTP on loopback is accepted.

## Permission: API key scope "Realtime Data"

Realtime Data is its own namespace, `realtime`, with a single action
`realtime:read`. In **Settings → API Keys** it is a separate row,
**Realtime Data**, with **None / Read** (there is nothing to write).

- **Read** lets the key stream sandworms, enemies, civilians, vehicles and
  storms.
- **Player positions** are included only if the key also has
  **Players → Read**. Without it, player objects are removed and their position
  updates dropped.
- `maps:read` does **not** include it, so existing keys gain nothing.
- Tiers: owner and admin hold `realtime:*`; moderator, player and observer do
  not.

The stream re-checks its key every 10 seconds: disabling, expiring or revoking
the key, or removing its Realtime Data (or Players) scope, ends the stream (or
stops the player positions) without waiting for a reconnect. At most four
streams per key and 16 in total are open at once.

## Routes

| Route | Action | Answer |
|---|---|---|
| `GET /api/realtime/healthz` | `realtime:read` | `{ available, version, ok, ready, sources }`; `503` when the agent does not run |
| `GET /api/realtime/objects` | `realtime:read` | current snapshot `{ gen, t, sources, objects }` |
| `GET /api/realtime/stream` | `realtime:read` | server-sent events `snap` (full state) and `pos` (`d`: `[id, x, y, z]`, `r`: removed ids) |

Sources never carry process ids. Object kinds: `worm`, `vehicle`, `npc`,
`civilian`, `storm`, `coriolis`, and `player` (see above).

## Transport

API keys and positions travel inside the Console's own connection. Serve the
Console over **HTTPS** (for example behind Caddy or nginx) when it is reached
over the internet. MapViewer3D (Beta.16 or newer) uses Realtime Data only over
HTTPS or on the same machine, and checks the Console certificate – by the
system trust store or by a pinned fingerprint for a self-signed / internal
certificate.
