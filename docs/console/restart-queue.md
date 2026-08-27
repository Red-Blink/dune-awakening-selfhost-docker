# Restart Queue

**Status:** Current | **Last Updated:** August 2026

The Restart Queue turns any console-triggered restart into a warned, player-aware
operation. When it is enabled and real players are online, a restart does not run
immediately — it starts a countdown and sends in-game **Server Broadcast**
warnings before the server goes down. When nobody is online, the restart runs at
once with no countdown.

The toggle lives in **Admin Tools → Schedule Server Restart**, between
**Daily Restart** and **Restart On Public IP Change**.

## What it gates

With the queue **enabled**, restart actions triggered *from the console* are
intercepted:

- Battlegroup restart
- Single-map respawn
- Service restart
- Sietch restart
- Settings-save-and-restart — the three ops that persist a setting and then
  restart to apply it: saving UserEngine/UserGame values, resetting them to
  defaults, and writing a raw `.ini`. The whole save-and-restart is captured
  into the countdown and runs at T-0. A settings save that does **not**
  restart (`restart: false`) is unaffected.

For each gated action, the console first checks how many real players are online — scoped to
that action's actual target. A battlegroup restart checks everyone; a single-map or sietch
restart checks only players on that map/partition (resolved via `dune.world_partition`, never
`dune.actors.map`, which names an in-game region rather than a restart target). The interception
dialog also shows the battlegroup-wide count for context when it differs from the scoped one.

- **No real players online** → the restart runs **immediately**, with no
  countdown.
- **Players online** → a countdown starts (default **15 minutes**) and Server
  Broadcast warnings are sent at configurable checkpoints (default **15, 10, 5
  and 1 minutes** remaining). The restart runs at T-0. If everyone logs off
  before then, it restarts immediately.

## Restart later (deferred settings saves)

The settings-save confirm in **Maps → Interactive Modifiers** and
**Maps → Advanced** offers a 4th choice alongside Cancel / Restart Immediately
/ Queue Restart: **Restart later**. It's offered regardless of whether the
queue above is enabled. Choosing it saves the change (`.ini` files are fully
written to disk immediately, same as any other save) but skips the restart
entirely — the change takes effect the next time the battlegroup restarts,
whether that's a manual restart, the daily restart timer, or the IP-change
restart.

A **Pending Restart** badge and a **Restart Battlegroup** shortcut appear in
Interactive Modifiers/Advanced (and a "Settings Pending" line in Admin Tools →
Restart Queue) until that next full battlegroup restart clears it. A
single-map or sietch restart does **not** clear it — only a full stack start
does (`start-all.sh`), which every restart path (manual, scheduled,
IP-change) ultimately runs. This mirrors the existing Landsraad "Pending
Restart" indicator, generalized to any UserEngine/UserGame save.

The same indicator can also appear with no admin action at all: on first
startup, if `SERVER_REGION` maps to a known Coriolis master schedule, the
console seeds whichever of the global Cycle Start Hour and Cycle Start Day
have never been explicitly saved and marks the same deferred-restart
indicator ("Coriolis cycle start settings (region default)"). Each field is
migrated independently — an admin who already saved one keeps their value,
and only the other (if still unset) is seeded. This is a one-time migration
per field, not a recurring background write — restart at your convenience
like any other deferred save.

## Enabling and configuring

Open **Admin Tools → Schedule Server Restart** and turn on **Restart Queue**.
Settings persist to `runtime/generated/restart-queue.json`:

| Field | Default | Meaning |
|---|---:|---|
| `enabled` | `false` | Master toggle. When off, restarts run as before, ungated. |
| `defaultCountdownMinutes` | `15` | Countdown length when players are online. |
| `broadcastCheckpoints` | `[15, 10, 5, 1]` | Minutes-remaining marks at which a warning broadcast is sent. |
| `broadcastDurationSec` | `30` | How long each broadcast banner is shown in game (1-3600 seconds), shared by both message variants. Editable via **Edit Messages** → Display Duration (sec). |
| `recoveryGraceMinutes` | `5` | Crash-recovery window for a just-elapsed countdown (see below). |
| `messages` | see below | The two customizable broadcast templates. |

Clicking **Save Queue** rejects the change with an inline error, before it is
sent, if any `broadcastCheckpoints` value is later than
`defaultCountdownMinutes` — that checkpoint's remaining-time mark would never
be reached, so the warning could never fire. Lower the checkpoint or raise the
countdown to save.

Configuration is read per save, so changes take effect without a console
release. Saving any one field (the toggle, the countdown/checkpoints, or the
message templates) merges onto the currently persisted settings — it never
resets the fields you didn't touch.

## The two broadcast message variants

Warnings are delivered as in-game **Server Broadcast** banners. The variant
depends on the scope of the restart, and both are **customizable**: click
**Edit Messages** next to Save Queue to open a two-tab editor (Battlegroup
Restart / Map Restart) with a live preview, a character counter, and a
**Reset to Default** button per tab. The editor also has a **Display Duration
(sec)** field — how long the banner stays on screen — which is shared by both
message types (there's one duration, not one per tab) and has its own Reset.

**Battlegroup restart** — default title `Battlegroup Restart`, default body:

> All servers will restart in {minutes}. Please get to a safe place.

**Single-map restart** — default title `Map Restart`, default body:

> {mapLabel} will restart in {minutes}. Please move to another map or get to a safe place.

The map warning is a **battlegroup-wide banner that names the map**, not a
per-map banner. The shipped game has no per-map titled banner, so the message is
broadcast to everyone and identifies the affected map by name in its body.

**Placeholders** — substituted when the broadcast is sent:

| Placeholder | Renders as | Available in |
|---|---|---|
| `{minutes}` | The countdown remaining, pluralized (`15 minutes`, `1 minute`) | Both templates |
| `{mapLabel}` | The map/Sietch display name (`All servers` for a battlegroup entry) | Both templates |

An unrecognized `{token}` is left as-is rather than silently erased, so a typo
is visible in the preview and in the live broadcast. Title is 1-80 characters,
body is 1-500 characters (the same limits the game's broadcast command
enforces) — an edit outside those bounds is rejected per-field, in the editor
and again on save.

## What a restart will flush

Taking a map down is when queued database writes are applied — generator
refills, water refills, base deletes,
[vehicle deletes](vehicle-deletion.md), and
[base permission changes](base-child-permissions.md). Every restart
confirmation therefore carries a **Queued Writes** line naming what this
particular restart will write, scoped to the targeted partition (or totalled
across every map for a battlegroup restart).

This is resolved inside `runGatedRestart`, not by each caller, so it reaches
every surface that can trigger a restart — the Bases queue banner, the Maps
per-map and per-Sietch controls, the Server battlegroup buttons, the
per-service Restart, the Landsraad persistent-rules restart, the Maps
deferred-settings banner, and Admin Tools' **Restart Now**. Several of those
previously showed nothing about pending writes at all.

The counts are context, not a gate: an unreachable or unsupported queue
endpoint omits the line rather than blocking a restart. Permission changes are
counted in **pieces, not bases** — one base with six queued pieces is six
pending writes.

## Concurrency rules

Only one of these can be in flight at a time:

- **One battlegroup countdown**, XOR
- **Multiple simultaneous countdowns for distinct maps.**

Specifically:

- A battlegroup restart is **blocked while any map is restarting**, and a map
  restart is **blocked while a battlegroup restart is in flight**.
- The **same map cannot be queued twice** — a second attempt is rejected rather
  than starting a duplicate countdown.

A blocked attempt returns a concurrency conflict (see
[the endpoints](#endpoints)) rather than silently starting a second timer.

## Crash recovery

Active queue state persists to `runtime/generated/restart-queue-state.json` so a
countdown survives a console restart. On boot, each stored entry is reconciled:

| Stored state | Action on boot |
|---|---|
| Already dispatched | Cleared — never re-fired. |
| Countdown still in its window | Resumed. |
| Countdown just elapsed, within `recoveryGraceMinutes` (default 5) | Run now. |
| Countdown long-stale (past the grace window) | Discarded. |

This prevents a console crash from either double-firing a restart or silently
dropping one that was seconds away.

## Limitations

One limitation is intentional in this version and is documented here so it is
not mistaken for a bug.

**There is no join-lock.** Players can still join during a countdown. The shipped
game commands offer no way to block new joins with a reason, so only the T-0
restart itself stops joins. A player who joins mid-countdown will see the
remaining warning broadcasts but is not prevented from entering.

## Enforcement scope

Only **console-triggered** restarts are gated by the queue. These paths are
**not** gated in this version and keep their own existing warnings:

- The systemd daily-restart timer
- The public-IP-change monitor
- Direct CLI restarts

Extending the queue to cover those paths is a possible future enhancement.

## Endpoints

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/server/restart-queue` | Settings, defaults, active state and online count | None |
| POST | `/api/server/restart-queue` | Save settings (partial; merges onto the current settings) | `enabled?`, `defaultCountdownMinutes?`, `broadcastCheckpoints?`, `broadcastDurationSec?`, `recoveryGraceMinutes?`, `messages?: { battlegroup: {title, body}, map: {title, body} }` |
| POST | `/api/server/restart-queue/cancel` | Cancel one active countdown | `id` |
| POST | `/api/server/restart-queue/restart-now` | Execute one queued restart immediately | `id` |
| GET | `/api/maps/user-settings/deferred-pending` | Whether a "Restart later" deferred save is pending | None |

`GET /api/server/restart-queue` returns the saved settings, the shipped defaults,
the active state (the queued `entries`), and the battlegroup `playersOnline`
count.

When the queue is enabled, the existing restart routes
(`/api/server/restart`, `/api/server/restart-service`, and the map/sietch restart
paths) answer:

- **`202 { queued: true, ... }`** when the restart is queued behind a countdown.
- **`409 { queued: false, error }`** when a concurrency conflict blocks it.

Append **`?restartQueue=immediate`** to a restart route to bypass the queue and
force an immediate restart.

## Related

- [API-REFERENCE.md](API-REFERENCE.md) — full HTTP API reference, including the
  Server Operations section these routes belong to.
