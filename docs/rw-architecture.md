# RW Command Architecture — Discord Bot Write Operations

**Date:** 2026-08-08

**Status:** Historical record — Layer 1 design proposal (2026-08-08); the write adapter bridge was never built. Not maintained. For the Discord adapter as shipped, see the Discord Adapter section of [API-REFERENCE.md](console/API-REFERENCE.md).

**Audit:** Eight-Hat Layer 1 completed. 8 issues filed (#215-223). Awaiting fixes before Layer 2.

---

## 1. Architecture Overview

```
Discord User → Slash Command → Bot RBAC → Confirmation (if destructive)
  → Rate Limit → Adapter Client → POST /api/integrations/discord/write/preview
  → Core validates actor + capability → returns nonce
  → Bot displays confirmation embed → User clicks Confirm
  → POST /api/integrations/discord/write/execute with nonce
  → Core validates nonce (60s expiry) → calls real console API endpoint
  → Result → Audit → Discord embed
```

### Key Design Decisions

1. **Write adapter bridge** — All RW Discord commands target Core via `/api/integrations/discord/write/...`, never directly to console API endpoints. This ensures Discord actor signing + capability enforcement applies to every write operation.

2. **Two-phase confirmation** — Destructive operations use `write/preview` (validate authority + return impact preview) → user confirmation → `write/execute` (consume nonce + perform action). Nonce binds user identity, operation type, and parameters. 60s expiry prevents replay.

3. **Tier ladder** — Console capability tiers mapped to Discord roles via existing `discordActorTier()`:

| Discord Role | Capability Tier | Can do |
|-------------|----------------|--------|
| observer | `public` | RO only — no write commands |
| moderator | `moderator` | `player:warn` (map chat) |
| admin | `admin` | Most RW: player kick/ban, base refill, server start, map control, carepackage grant, guild add/remove |
| owner | `owner` | Destructive: server restart/stop, base destroy, guild delete, player inventory clear, give-item, grant-all, history clear |

4. **Master kill switch** — `DUNE_DISCORD_WRITES_ENABLED=1` (standardized per #217). All RW commands disabled when unset. Parsed identically by bot and Core.

---

## 2. Command Groups

### Group A: `player` — Player Management

| Subcommand | Core Adapter Endpoint | IAM Action | Tier | Confirmation |
|------------|----------------------|------------|------|-------------|
| `kick <name> [reason]` | write/execute → `POST /api/players/.../kick` | `players:mutate` | admin | Yes (shows player name) |
| `ban <name> [reason]` | write/execute → `DELETE /api/players/.../ban` | `players:mutate` | admin | Yes (shows player name + reason) |
| `warn <name> <message>` | write/execute → `POST /api/admin/map-chat` | `admin:map-chat` | moderator | No (non-destructive) |
| `give-item <player> <item> [qty]` | write/execute → storage endpoint | `storage:mutate` | **owner** | Yes (shows item name, quantity, recipient) |
| `clear-backpack <player>` | write/execute → `POST /api/players/.../clean-inventory` | `players:mutate` | **owner** | Yes (requires typing character name) |

**Safety**: `give-item` requires item-type allowlist (no quest items, no admin-only flags), 1-stack-per-invocation cap, per-admin 10/day volume limit. `clear-backpack` requires typing the character name as the confirmation string, not just clicking a button.

### Group B: `base` — Base Management

| Subcommand | Core Adapter Endpoint | IAM Action | Tier | Confirmation |
|------------|----------------------|------------|------|-------------|
| `refill generators <base>` | write/execute → `POST /api/bases/.../refill-generators` | `bases:mutate` | admin | Yes |
| `refill water <base>` | write/execute → `POST /api/bases/.../refill-water` | `bases:mutate` | admin | Yes |

**Note**: `destroy` deferred until Core `DELETE /api/bases/:id` endpoint is implemented (#216).

### Group C: `server` — Server Control

| Subcommand | Core Adapter Endpoint | IAM Action | Tier | Confirmation |
|------------|----------------------|------------|------|-------------|
| `restart` | write/execute → `POST /api/server/restart` | `server:restart` | **owner** | Yes (shows live player count, 30s cancellable countdown, requires typing server name) |
| `stop` | write/execute → `POST /api/server/stop` | `server:stop` | **owner** | Yes (requires typing "STOP") |
| `start` | write/execute → `POST /api/server/start` | `server:start` | admin | No (non-destructive) |
| `restart-service <name>` | write/execute → `POST /api/server/restart-service` | `server:restart-service` | admin | Yes (shows affected service) |
| `maintenance on/off` | write/execute → config endpoint | `server:write-config` | admin | No |

**Safety**: `restart` and `stop` require confirmation phrases on Core (#223). Bot displays live player count in preview embed. 60s cooldown group. 30s cancellable countdown between confirm and execute. `stop` requires a second administrator to confirm (dual-confirmation gate).

### Group D: `map` — Map Control

| Subcommand | Core Adapter Endpoint | IAM Action | Tier | Confirmation |
|------------|----------------------|------------|------|-------------|
| `spawn <preset>` | write/execute → `POST /api/maps/spawn` | `maps:spawn` | admin | Yes (shows preset, estimated resource usage) |
| `despawn <map>` | write/execute → `POST /api/maps/despawn` | `maps:despawn` | admin | Yes (shows connected players) |
| `respawn <map>` | write/execute → `POST /api/maps/respawn` | `maps:restart` | admin | Yes |
| `teleport <player> <map>` | write/execute → `POST /api/map/teleport-player` | `maps:teleport` | admin | Yes (shows player + destination) |

**Safety**: `spawn` checks available memory and port slots before confirming (#223). `despawn` warns about connected players. 15s cooldown group.

### Group E: `carepackage` — Care Packages

| Subcommand | Core Adapter Endpoint | IAM Action | Tier | Confirmation |
|------------|----------------------|------------|------|-------------|
| `grant <player> <tier>` | write/execute → `POST /api/care-package/grant/:id` | `carepackage:grant` | admin | Yes (shows player + tier) |
| `grant-all` | write/execute → `POST /api/care-package/grant-eligible` | `carepackage:grant` | **owner** | Yes (shows eligible count) |
| `enable` | write/execute → `POST /api/care-package/enable` | `carepackage:write-config` | admin | No |
| `disable` | write/execute → `POST /api/care-package/disable` | `carepackage:write-config` | admin | No |
| `scan` | write/execute → `POST /api/care-package/run` | `carepackage:scan` | admin | No |
| `history clear` | write/execute → `POST /api/care-package/history/clear` | `carepackage:clear-history` | **owner** | Yes (requires typing "CLEAR HISTORY") |

### Group F: `broadcast` — Server Communications

| Subcommand | Core Adapter Endpoint | IAM Action | Tier | Confirmation |
|------------|----------------------|------------|------|-------------|
| `broadcast <msg>` | `/api/integrations/discord/broadcast` | `admin:broadcast` | admin | Yes (shows message preview) |
| `broadcast-shutdown <msg> [mins]` | `/api/integrations/discord/broadcast` | `admin:broadcast-shutdown` | admin | Yes (shows message + countdown) |

**Safety**: 5s cooldown group. Message sanitized: max 500 chars, control characters stripped. Shutdown message must include a non-blank reason field. Core rate limit: 3 broadcasts per 5 minutes (#223).

### Group G: `guild` — Guild Management

| Subcommand | Core Adapter Endpoint | IAM Action | Tier | Confirmation |
|------------|----------------------|------------|------|-------------|
| `add <player> <guild>` | write/execute → `POST /api/guilds/.../members` | `guilds:mutate` | admin | Yes |
| `remove <player>` | write/execute → `DELETE /api/guilds/.../members` | `guilds:mutate` | admin | Yes |

**Note**: `create` and `rename` deferred until Core `POST /api/guilds` and `PUT /api/guilds/:id` endpoints are implemented (#216).

---

## 3. Write Adapter Bridge (Must Be Built First)

The write adapter bridge is the critical path component. Without it, no RW command can ship.

### Core Side

```
POST /api/integrations/discord/write/preview
  Headers: X-Dune-Actor-Signature, X-Dune-Actor-Timestamp
  Body: { actor: {...}, action: "players:mutate", params: { playerName: "..." }, idempotencyKey: "uuid" }
  Response: { ok: true, nonce: "uuid", expiresAt: 1766249032, preview: { ... } }

POST /api/integrations/discord/write/execute
  Headers: X-Dune-Actor-Signature, X-Dune-Actor-Timestamp
  Body: { actor: {...}, nonce: "uuid", action: "players:mutate", params: {...}, idempotencyKey: "uuid" }
  Response: { ok: true, result: {...} }
```

**Security**: Both endpoints require `verifyActorSignature({ required: true })` + `requireDiscordCapability()`. Nonce is single-use with 60s expiry. Idempotency key prevents duplicate executions.

### Bot Side

```
adapterClient.writePreview(actor, action, params, idempotencyKey)
adapterClient.writeExecute(actor, nonce, action, params, idempotencyKey)
```

**Existing pattern**: Uses the same `AdapterClient.request()` HTTP machinery. Nonce stored in confirmation state Map alongside the pending interaction.

---

## 4. Safety Model

### Confirmation Flow
```
1. User invokes slash command (e.g., /dune player kick Bob)
2. Bot validates actor + capability + rate limit
3. Bot calls write/preview → receives nonce + impact preview
4. Bot displays confirmation embed with Confirm/Cancel buttons (60s timeout)
5. User clicks Confirm
6. Bot calls write/execute with nonce
7. Bot displays result embed
```

Destructive tiers for each confirmation level:
- **None**: start, enable, disable, scan, maintenance
- **Button click**: kick, ban, warn, give-item, refill, restart-service, spawn, despawn, teleport, grant, broadcast
- **Type confirmation string**: server restart, server stop, clear-backpack, history clear, grant-all

### Rate Limits

| Scope | Limit | Window |
|-------|-------|--------|
| Per-actor global RW | 3 actions | 30s |
| player group | 5s | per-subcommand |
| base group | 10s | per-subcommand |
| server group | 60s | per-subcommand |
| map group | 15s | per-subcommand |
| carepackage group | 10s | per-subcommand |
| broadcast group | 5s | per-subcommand |
| Core server restart | 1 | per 5min |
| Core broadcast | 3 | per 5min |

### Idempotency

Every write command generates a `uuid` idempotency key. Core rejects duplicate keys with the same params (returns cached result). Core rejects duplicate keys with different params (409 "already executed"). This prevents accidental double-execution from network retries or impatient users.

### Errors

| Core HTTP | Bot Embed | Color |
|-----------|-----------|-------|
| 200 | "✅ Action completed" | success |
| 400 | "⚠️ Invalid parameters: {details}" | warning |
| 403 | "🔒 Not authorized for {action}" | error |
| 409 | "⚠️ Already executed" | warning |
| 429 | "⏱️ Rate limited. Retry in {s}s" | warning |
| 500 | "💥 Action failed: {details}" | error |
| 503 | "🔴 Adapter unavailable" | error |

---

## 5. What's Already Built vs What's Needed

### Core (dune-awakening-selfhost-docker)

| Component | Status | Issue |
|-----------|--------|-------|
| Write adapter bridge (preview + execute) | **NOT BUILT** | #215 |
| Missing endpoint: guild create | **NOT BUILT** | #216 |
| Missing endpoint: guild rename | **NOT BUILT** | #216 |
| Missing endpoint: base destroy | **NOT BUILT** | #216 |
| Server restart/stop confirmation phrases | **PENDING** | #223 |
| `discordWritesEnabled` standardization | **PENDING** | #217 |
| Actor signing on all write adapter routes | **EXISTS** | #207 (verified) |

### Bot (arrakis-control-panel)

| Component | Status | Issue |
|-----------|--------|-------|
| Confirmation button flow | **EXISTS** (`writeConfirmation.js`) | — |
| Write command dispatch | **EXISTS** (`writeHandler.js`) | — |
| Item autocomplete | **NOT BUILT** | #222 |
| Per-group cooldowns | **NOT BUILT** | — |
| AdapterClient write methods | **NOT BUILT** | Depends on #215 |
| Parameter validation | **NOT BUILT** | — |
| Error format (embed-based) | **PARTIAL** (`format.js`) | — |

---

## 6. Test Strategy

### Layer 1: Unit Tests (per component)
- `validateWriteParams()` — control chars, SQL fragments, length limits, enum validation
- `writeCooldown.checkGroup()` — per-group keying, expiry, cross-group isolation
- `writeConfirmation.js` — all 7 button interaction states (already tested, extend for new destructive confirmations)
- `writeExecute()` / `writePreview()` — mock adapter returns fixture nonce/result

### Layer 2: Integration Tests
- Full lifecycle: slash command → preview nonce → confirmation → execute → result embed
- Nonce expiry (60s timeout) → bot shows "expired" embed
- Idempotency replay (same key, same params) → bot shows cached result
- Idempotency collision (same key, different params) → bot shows "already executed"
- All 6 error codes from the error table above

### Layer 3: End-to-End
- Real Core HTTP mock server with nonce store (extend `scripts/mock-adapter.js`)
- Bot-side Discord interaction mocks with button state machine
- Concurrency test: two simultaneous write commands serialize correctly

---

## 7. Not in Scope (Explicitly Deferred)

- `database:export` / `database:query` — raw SQL from Discord is too dangerous
- `updates:apply` — requires console UI visibility (downtime, rollback)
- `landsraad:*` — experimental, requires console context
- `sietches:write` / `deepdesert:write` — low-use, defer
- `addons:install` / `addons:update` — requires console UI
- `player:unban` — defer until Core `DELETE /api/players/:id/ban` is verified
- `guild:create` / `guild:rename` — defer until Core endpoints exist (#216)
- `base:destroy` — defer until Core endpoint exists (#216)

---

## 8. Related Issues

| # | Title | Hat | Severity |
|---|-------|-----|----------|
| 215 | Write adapter bridge must be built on Core | CloudSec | CRITICAL |
| 216 | 5 RW endpoints don't exist on Core | Architect | CRITICAL |
| 217 | DUNE_DISCORD_WRITES_ENABLED parse mismatch | CloudSec | HIGH |
| 218 | give-item at admin = economy destruction | Security | HIGH |
| 219 | grant-all at admin = server-wide injection | Security | HIGH |
| 220 | server restart + history-clear should be owner | Security | HIGH |
| 221 | No cross-group rate limit | Security | MEDIUM |
| 222 | No item autocomplete infrastructure | UI/Bot | HIGH |
| 223 | Server restart/stop lack confirmation phrases | Network | MEDIUM |
