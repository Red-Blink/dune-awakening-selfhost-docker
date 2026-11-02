# Addon Runtime API

**Status:** Current | **Last Updated:** September 2026

The runtime API gives UI addons typed player data, addon-owned storage, durable
reward delivery, and private player messages without granting direct access to
the Console REST API or requiring writes to Funcom's game tables.

Every call uses the iframe bridge:

```js
const result = await window.DuneAddon.request("players.summary.list");
```

## Permissions

| Permission | Capability |
| --- | --- |
| `players:read` | Player summaries, identities, and supported progression data |
| `files:addon-data` | Private persistent JSON storage scoped to the addon ID |
| `rewards:grant` | Item, game XP, Intel, currency, and Building Sets rewards |
| `players:message` | Queue a private in-game message for one player |
| `realtime:read` | Read Realtime Data snapshots (sandworms, NPCs, vehicles, storms) from the optional position agent |

Installing or updating an addon never approves a new permission automatically.
The server owner must approve every requested permission.

## Realtime Data

Requires `realtime:read` (manifest: `"permissions": { "realtime": ["read"] }`). The optional
MapViewer3D position agent must run on the host; see
[Realtime Data](../console/realtime.md). Both actions are read-only snapshots; the
bridge has no streaming channel, so poll at a modest rate (the bridge allows 60
calls per minute per addon).

### `realtime.health`

```js
const health = await window.DuneAddon.request("realtime.health");
// { available: true, version: 1, ok: true, ready: 2, sources: [{ map, partition, ready, n }] }
```

### `realtime.objects`

```js
const snap = await window.DuneAddon.request("realtime.objects", { kinds: ["worm", "storm"], map: "Survival_1" });
// { gen, t, sources: [{ map, partition, ready, n }], objects: [{ i, k, c, s, x, y, z }] }
```

- `kinds` (optional): array of `worm`, `vehicle`, `npc`, `civilian`, `storm`, `coriolis`, `player`.
- `map` (optional): one map name such as `Survival_1`. `sources` then lists that map only and `s` indexes into it.
- `player` objects are returned only when the addon also holds `players:read`; otherwise they are never included, even when requested.
- Unknown kinds or a malformed `map` fail with HTTP 400.
- When the agent is not running the call still succeeds with `{ available: false, error }` so a polling addon can show a hint instead of handling an error.

## Players

### `players.summary.list`

Requires `players:read`. Returns `{ capabilities, rows }`. Each row includes:

- `playerId`: the preferred ID to send back to reward and message actions
- `name`, `status`, `map`, `lastSeen`, and `level`
- `faction` and `guild` when supported
- `actorId`, `controllerId`, `accountId`, `flsId`, and `funcomId` for correlation

`leadership.players.list` remains supported and returns the same summary shape.

### `players.progression.get`

Requires `players:read`.

```js
const progression = await bridge("players.progression.get", { playerId });
```

The response reports capabilities separately for `level`, `faction`, `story`,
`sideQuests`, `exploration`, and `achievements`. Unsupported categories remain
explicitly unsupported. Story and side-quest data use the Console's verified
Journey interpretation; addons should not reproduce game-schema SQL.

## Addon-owned storage

Requires `files:addon-data`. Keys may contain letters, numbers, dots, colons,
underscores, and hyphens. Each value can contain up to 256 KiB of JSON; one
addon can store up to 2,000 keys or 8 MiB total.

```js
await bridge("addon.storage.put", {
  key: "season.active",
  value: { id: "arrakis-rising", tiers: [] },
  expectedVersion: null
});

const entry = await bridge("addon.storage.get", { key: "season.active" });
const keys = await bridge("addon.storage.list", { prefix: "player." });

await bridge("addon.storage.put", {
  key: "season.active",
  value: nextSeason,
  expectedVersion: entry.version
});

await bridge("addon.storage.delete", {
  key: "season.active",
  expectedVersion: entry.version
});
```

`expectedVersion: null` creates only when absent. A numeric `expectedVersion`
provides compare-and-swap protection and returns HTTP 409 if another request
changed the value. Omitting it performs an unconditional write. Updates retain
this data; uninstalling the addon removes it.

## Rewards

Requires `rewards:grant`. `requestId` is the addon's permanent idempotency key
for one delivery. Use a deterministic value such as
`season:<season>:player:<player>:tier:<tier>:reward:<index>`.

```js
await bridge("rewards.deliver", {
  requestId: "season:s1:player:p1:tier:3:reward:0",
  playerId,
  type: "item",
  itemId: "WaterBottle_1",
  amount: 2,
  quality: 0
});
```

Supported payloads:

| `type` | Additional fields |
| --- | --- |
| `item` | `itemId`, `amount` (1-1000), optional `quality` (0-5) |
| `xp` | `amount` |
| `intel` | `amount` |
| `currency` | `currencyId`, `amount` |
| `building-unlock` | `itemId` from the verified Building Sets catalog |

Currency reward IDs are stable across supported game database generations: `0` grants Solaris, while `1` grants the secondary wallet currency (`House Credit` on current servers and `Scrip` on older servers). The core translates these IDs to the database type used by the installed game version, so addons must not write wallet rows directly.

Item and XP rewards wait for the player to be online. Intel waits until the
player is offline because the live game process can overwrite an online
database edit. Currency uses the Console's supported database mutation.
Building Sets use the same verified ownership and delivery path as the Players
page.

The first request creates a durable record before attempting delivery. A retry
with identical details returns the same record and never repeats a completed
delivery. Reusing a request ID with different details is rejected. Offline
deliveries remain `pending` and the Console retries them in the background.
If the Console stops during an in-flight operation, the record becomes
`uncertain` and is not automatically retried, preventing a possible duplicate.

Read delivery state with:

```js
await bridge("rewards.status", { requestId });
await bridge("rewards.list", { status: "pending", limit: 100 });
```

Possible states are `pending`, `processing`, `delivered`, `failed`, and
`uncertain`.

## Private player messages

Requires `players:message`. Messages use the same persistent offline queue and
idempotency rules as rewards.

```js
await bridge("players.message.send", {
  requestId: "season:s1:player:p1:tier:3:message",
  playerId,
  message: "You unlocked Battle Pass Tier 3."
});
```

Use `players.message.status` and `players.message.list` to inspect message
delivery. Messages remain pending until the player is online.

## Execution model

Addon JavaScript still runs only while its UI iframe is open. Once an addon has
submitted a reward or message, the core owns its queue and continues processing
it after the iframe closes or the Console restarts. Eligibility scans and
season-rule evaluation remain the addon's responsibility; third-party
JavaScript is not executed as an unrestricted server process.

## Addon Removal

Uninstall disables the addon first, then removes its Console jobs, stored data,
delivery state, and installed files. The confirmation explains what is removed.
Manually installed external services are separate unless the Console explicitly
supports their cleanup.

For the legacy `dune-airdrop-addon`, Uninstall also removes its companion
containers and reward automation before deleting the addon files. The Console
matches companions to this server using their repository mounts or both labels
`io.dunedocker.addon.id=dune-airdrop-addon` and
`io.dunedocker.project.root=<absolute host repository path>`. A container name
alone is insufficient. It disables container restart, stops the companions,
removes the verified playtime triggers and isolated `dune_airdrop` schema in a
database transaction, and removes the stopped containers. Shared legacy tables
under `dune` are preserved.

Docker and the database must be available. If cleanup cannot be completed, the
addon stays installed and disabled, and the Console reports an error. Correct the
reported access or ownership problem and retry Uninstall. No game service needs
to be restarted.

If an older Console already removed the Airdrop files while leaving its daemon
running, reinstall the addon, leave it disabled, and select Uninstall again using
the updated Console. Do not initialize its database schema or enable it first.
