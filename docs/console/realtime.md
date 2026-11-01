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

### From the Console (recommended)

When an API key holds **Realtime Data** and the agent does not answer, **Settings → API Keys**
shows a notice with **Set Up Agent**. The notice also appears while you tick Realtime Data in
the key you are creating. Nothing is installed until the owner confirms the dialog.

Set Up Agent builds the agent from the pinned MapViewer3D release (`beta.15`, verified against its
commit; the build fails if the tag moved) and starts it as the container `dune-realtime-agent`.
The same notice offers **Remove Agent** once no key uses Realtime Data any more. Removing stops the
container and deletes the image; API keys are not touched.

Setting it up is an owner-only action (`settings:write`, like Encrypted API Access, so no API key,
addon or admin-tier account can start it). A short note on trust, because the agent's *intended
behaviour* is narrower than the *privileges it is given*:

- **Intended behaviour:** read object positions from the game server processes, read-only, and offer
  them on `127.0.0.1:8796` for the Console to pass on to authorized callers.
- **Privileges granted:** root, `pid: host`, `SYS_PTRACE`, `DAC_OVERRIDE` and
  `apparmor=unconfined` (the game containers run unconfined, and the default profile refuses ptrace
  of such a peer), with all other capabilities dropped, a read-only file system, `no-new-privileges`
  and a fixed memory and process limit.
- **What is *not* enforced:** that it only reads, or only game processes. The container cannot
  guarantee either; a compromised or modified agent could read or change any process it can see.
- **Who can reach it:** it listens on loopback and has no login. The Console authorizes API callers,
  but loopback does not stop other local processes from connecting to `127.0.0.1:8796` directly, so
  install it only on a host where you trust the local processes.

The same steps are available on the command line: `runtime/scripts/realtime-agent.sh enable|disable|status`.
Player positions stay off at the agent by default; set `DUNE_REALTIME_AGENT_PLAYERS=true` in the
environment of that script to let the agent read players (the Console still shows them only to
callers with `players:read`).

### Manual

The agent runs next to the Console as its own compose project and changes
nothing in the Dune containers. It listens on `127.0.0.1:8796` of the host and
has no login, so it is reachable only through the Console.

```bash
git clone --branch ddp --depth 1 https://github.com/dev-prophet-code/MapViewer3D.git mapviewer-live
cd mapviewer-live && cp .env.example .env
docker compose -f docker-compose.mapviewer-live.yml up -d --build
```

`DUNE_REALTIME_AGENT_URL` (default `http://127.0.0.1:8796`) points the Console
at the agent; only plain HTTP on loopback is accepted. The stock Compose file
passes it through from `.env`. A value that is not accepted turns off Realtime
Data only (its routes answer with the reason); the rest of the Console starts
as usual.

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
