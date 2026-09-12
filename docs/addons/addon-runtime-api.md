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

Installing or updating an addon never approves a new permission automatically.
The server owner must approve every requested permission.

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
