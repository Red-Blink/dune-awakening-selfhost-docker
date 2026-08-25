# Base permissions

**Status:** Current | **Last Updated:** August 2026

The Bases panel can edit who owns a base and who it is shared with. The editor
lives in the **Sub-Fief Permissions** tab of an expanded base row, alongside the
existing **Power** tab.

Unlike generator refills, permission changes are **not** queued for a map
restart — they reach a running map immediately. See
[Why there is no queue](#why-there-is-no-queue).

## Ranks

Permissions are rows in `dune.permission_actor_rank`, one per player per base:

| Rank | Label | Notes |
|---:|---|---|
| 1 | Owner | Exactly one per base. Shown in the **Owner** column. |
| 2 | Co-Owner | Shown in the **Shared With** column. |
| 3 | Associate | Shown in the **Shared With** column. |

The in-game Permissions panel displays `5` / `4` / `3` beside Owner / Co-Owner /
Associate. Those are decoration, not database ranks — an in-game Co-Owner is
stored as rank `2`, and no row ever holds a `4` or `5`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/bases/:baseId/permissions` | The base's roster, with resolved names and rank labels. |
| `PUT` | `/api/bases/:baseId/permissions` | Replace the roster. Body: `{ entries: [{ playerId, rank }] }`. |
| `GET` | `/api/bases/permission-candidates?q=&limit=` | Player search for the add-player picker. |
| `POST` | `/api/bases/:baseId/system-custodian` | Transfer ownership to a reserved Server or GM identity while preserving access; creates the Server identity first when needed. |

`PUT` takes a **whole roster**, not a delta. The server diffs it against current
state and applies only the difference, so an unchanged row is never rewritten —
every write emits a notification, and re-notifying an unchanged rank is pointless
traffic to the game server.

Roster saves are audited as `bases.set-permissions`; custodian transfers use
`bases.transfer-system-custodian`. Both are rate limited. No confirmation phrase
is required by the API, matching the guild mutations and refill route; the UI
shows an explicit transfer confirmation and the change is reversible from the
same editor.

## What the server enforces

Client-side rules are re-checked server-side; none of them are trusted from the
request.

- **Exactly one Owner.** `permission_set_player_rank` is a plain upsert, so
  setting rank 1 for a second player would simply leave the base with two owners.
  The outgoing Owner is demoted first, in the same transaction.
- **The roster cap**, read from live server config (see below).
- **Ranks limited to 1–3**, no duplicate players.
- **Every player id must be a `player_controller_id`** (see below).
- **The base must be claimed** (see below).

## An unclaimed base is refused, not attempted

`permission_actor_rank.permission_actor_id` carries a foreign key against
`dune.permission_actor(actor_id)`. The actor id every write uses is resolved from
`buildings → building_instances → actor_fgl_entities → actors`, which says
nothing about whether that actor is *claimed* — an unclaimed base keeps every one
of those rows and has no `permission_actor` row at all.

Both mutation routes therefore check for that row, inside the transaction and
after taking the claim lock, and refuse with *"This base is not claimed…"*.
Without the check the write reached `permission_set_player_rank` and failed the
constraint, surfacing raw PostgreSQL text
(`violates foreign key constraint permission_actor_rank_permission_actor_id_fkey`)
to the operator.

`GET` still succeeds on such a base — the roster is simply empty, and seeing that
is how the state gets diagnosed — and returns `claimed: false` plus
`unclaimedReason`. The tab uses those to disable Save, Transfer, the rank
controls and the remove buttons, rather than offering controls whose only
outcome is an error. This matters most for **Transfer to Custodian**: an
unclaimed base renders "No Owner set", which is exactly the state that button
exists to resolve, making it the shortest path into the failure.

The pickup ("backed-up") case is caught earlier and separately, by
`baseIsBackedUp` in `server.js`, which returns a 409 naming the base-backup tool.
That check requires *both* signals — unclaimed **and** registered in
`base_backup_linked_actors` — so a base that is unclaimed for any other reason
falls through to this one.

The game's own pickup path does not take the claim lock, so a pickup landing
mid-edit can still reach the constraint. That race is what the foreign key is
for; the check removes the steady-state case, which is the one operators hit.

## System custodian

The Sub-Fief Permissions tab offers a transfer action when it detects a supported
reserved identity. It prefers the RedBlink `Server` persona (`9000002xx`) and
falls back to Funcom's `GM` persona (`9000001xx`), which is present in some
battlegroup databases instead. Detection uses the complete stable
account/controller/state/pawn tuple from `player_state` or
`encrypted_player_state`, not a possibly encrypted or renamed display value.
Older manually-created `Server` identities remain
supported through an exact-name compatibility lookup.

Both identities remain excluded from normal player search. The dedicated action
preserves every existing permission, demotes the outgoing Owner to Co-Owner, and
promotes the detected custodian last in the same locked transaction.

This provides a reversible administrative parking owner without leaving the
base ownerless. If neither supported identity exists, the UI offers **Transfer
to Server** and creates the same reserved Server persona used by Care Packages
before transferring ownership. This keeps the action available when messaging
services have never been enabled. An ambiguous matching identity still disables
the action rather than guessing an actor id. As with ordinary transfers, the
shipped permission procedures notify the running map immediately; no map restart
is queued.

Detection is entirely server-wide, not base-scoped — there is exactly one
reserved Server/GM custodian per battlegroup, the same identity Care Packages
and MOTD use. Vehicle permissions offer the identical transfer action against
the same detected identity; see
[vehicle-permissions.md's System custodian section](vehicle-permissions.md#system-custodian).

## The roster cap comes from server config

The game caps permissions per actor. Two settings exist:

| Key | Section | Shipped default |
|---|---|---:|
| `permission_max_permissions_per_actor` | `/Script/DuneSandbox.PermissionSettings` | **32** |
| `max_permissions_per_actor` | `/Script/DuneSandbox.DuneGameMode` (legacy) | 20 |

`DefaultGame.ini` inside the server image defines `m_MaxPermissionsPerActor=32`
under `[PermissionSettings]` only — there is no `DuneGameMode` form of the key —
so the canonical field is the one the server enforces.
`parseEffectivePermissionLimit` (`console/api/src/services/permissionSettings.js`)
therefore reads the canonical key **first** and falls back to the legacy one,
defaulting to 32.

Note this is the **opposite** precedence to `parseEffectiveGuildMemberLimit`,
where the legacy `DuneGameMode` field wins. Reading the legacy key first here
would inherit its `20` and silently cap rosters below what the server permits.

To raise the cap, edit `permission_max_permissions_per_actor` in the settings
editor — the console reads it per save, so no release is needed.

> **Footgun:** writing the *legacy* field through the Advanced Editor introduces
> a `DuneGameMode` value defaulting to 20, which can lower the effective cap
> below the shipped 32.

## Two ids that are easy to confuse

**The base id is not the permission actor id.** The id shown in the Bases table
is `min(buildings.id)` for the claim; `permission_actor_rank.permission_actor_id`
is the claim *actor* id (`dune.actors.id`). They differ for every base and by a
varying offset — observed live: `70 → 354`, `1006 → 1004`, `1675 → 1717`,
`3030 → 3116`. The actor is always resolved server-side from the base id; an
actor id is never accepted from a client.

**`player_id` must be a `player_controller_id`.** One account owns several
`dune.actors` rows, and only the one matching
`dune.player_state.player_controller_id` is a real permission holder. A rank row
written against any other actor id of the same account is accepted by the
procedure and then **ignored by the game**.

This is easy to get wrong because the read path hides it: names resolve through
`actors.owner_account_id`, and every actor row of an account maps to the same
character name — so a bad row renders perfectly in the console while doing
nothing in game. The roster marks such rows (`canonical: false`) rather than
hiding them; the console can see them and the game client cannot.

## Why there is no queue

Generator refills are queued until a map is down because a running server
rewrites its own state back to Postgres and would overwrite the refill.
Permissions are different: the game ships stored procedures that **notify the
running server**, and the console calls those rather than writing the table.

- `dune.permission_set_player_rank(actor_id, player_id, rank, map_id)` — upserts
  the rank row, refreshes the base marker, then
  `pg_notify('permission_notify_channel', 'set_rank#{…}')`.
- `dune.permission_remove_player_rank(actor_id, player_id)` — deletes the rank
  row and the player's marker, then notifies.

Every map server `LISTEN`s on that channel (`LogFarmNotification: Display:
Listening for notification 'permission_notify_channel'` in the server log).
Verified in-game: a rank change written this way moved a player between sections
in the owner's open Permissions panel with no relog and no map restart.

**Do not write `permission_actor_rank` directly.** Direct DML skips the marker
refresh and the notification, producing exactly the silently-reverted behaviour
the refill queue exists to avoid.

`dune.permission_actor_takeover` is **not** a transfer path — it refuses any
actor that already has a rank-1 owner and returns quietly via `RAISE NOTICE`, so
calling it on an owned base looks successful while doing nothing. Ownership
transfer is demote-then-promote through `permission_set_player_rank`.

## Two implementation constraints

**`search_path`.** The shipped procedures reference their tables unqualified and
carry no `SET search_path` of their own. They resolve only because every client —
the game servers and the console — connects as the `dune` role, whose default
`"$user", public` path reaches the `dune` schema. Since every query the console
writes is schema-qualified, this had never mattered before; `setBasePermissions`
now issues `set local search_path to dune, public` inside its transaction so the
feature survives `ADMIN_DATABASE_URL` pointing at a differently-named role.

**Write order.** The marker refresh inside `permission_set_player_rank` resolves
the owner with a `LIMIT 1` over rank-1 rows, so a moment with two rank-1 rows
could stamp the wrong owner onto the base marker. Removals run first, then
non-owner ranks, then the Owner last — at most one rank-1 row exists when the
owner write lands. (`NOTIFY` is only delivered on commit, so the game never
observes the intermediate state; the marker refresh, running inside the
transaction, does.)

**Locking** is a row lock on the claim actor (`dune.actors`), not on the rank
rows: a base whose roster is being fully replaced may have no rank rows, and
`for update` over zero rows serializes nothing.

## A base can exist but be unresolvable

`building_instances.owner_entity_id` is nullable — it carries an
`ON DELETE SET NULL` foreign key against `fgl_entities` — so a base can still
have a row in `dune.buildings` while its link down to a permission actor is
broken. **Such a base does not appear in the Bases table** — `listBases` still
inner-joins the same chain, so it's excluded from the list entirely rather than
shown with a broken Sub-Fief Permissions tab. The distinct error instead surfaces from
paths that resolve a base id directly: a `GET`/`PUT` to
`/api/bases/:baseId/permissions` with a stale or copied id returns *"This base
has no resolvable owner entity, so permission editing is unavailable for it,"*
distinct from *"That base was not found"* (the base id itself doesn't exist).
The same distinction applies to blueprint export and to the auto-refill
scanner's existence check (`baseMapLocation`), both of which resolve the same
join chain and must not conflate "link broken" with "base deleted" — the
scanner in particular un-enrolls a base from auto-refill on the latter, so
collapsing the two would silently drop a base that still exists and may still
need fuel. No such rows exist in production today; this is a documented edge
case, not an active issue.

## Capability gating

The panel hides the editor unless `listBases` reports `capabilities.basePermissions`.
That requires `dune.permission_actor_rank`, `dune.permission_actor`, `dune.actors`,
`dune.player_state` and `dune.map_names`, plus both stored procedures — probed
once per list request rather than per row.

## Related

- [generator-refill-caps.md](generator-refill-caps.md) — the refill endpoint, and
  the queue this feature deliberately does not use.
- [vehicle-permissions.md](vehicle-permissions.md) — the same roster-editing
  engine and the same system-custodian transfer, applied to vehicles.
- [API-REFERENCE.md](API-REFERENCE.md) — full HTTP API reference.
