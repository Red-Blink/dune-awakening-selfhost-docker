# Addon Scheduled Jobs (Server-Side Buyback)

The console API process can run recurring addon work in the background, so automation keeps running when no browser has the addon page open. The first supported job is the **EDA Exchange Bot** (`eda-exchange-bot`) buyback sweep.

## How it works

The scheduler ticks with the console's other background tasks (the 10-second interval that also drives care package auto-grants and the message of the day). On every due run it:

1. Verifies the addon is still installed, enabled, not blocked, and approved for `database:read`, `database:write`, and `scheduler:server`. Revoking any of these (or disabling/removing the addon) stops scheduled runs immediately.
2. Runs a **read-only eligibility probe** — no backup is taken while the market is idle.
3. Only when eligible player listings exist: creates a database backup (`DB_BACKUP_ORIGIN=addon-eda-exchange-bot`) and runs the buyback sweep.
4. Re-arms the next run from **completion** time, so a sweep that outlasts the interval cannot trigger back-to-back runs, and audits the outcome to `runtime/generated/web-admin-audit.jsonl` (`addons.scheduled-job`).

The sweep SQL is built **server-side** from the addon's bundled `web/market-seed-plan.json` (in `runtime/addons/installed/eda-exchange-bot/`) and the validated schedule parameters. The console never persists or replays SQL text sent by the addon iframe, following the same typed-action model as `admin.items.grant`.

The sweep uses `FOR UPDATE OF o, s SKIP LOCKED`, so a scheduled sweep racing a manual sweep from the addon page is safe at the database level. It runs through the Console database transaction helper, which guarantees a rollback before the connection returns to the pool if any statement fails.

## The `scheduler:server` permission

Unattended background writes require an explicit opt-in beyond `database:write`. The addon manifest must request `scheduler:server` and the server owner must approve it at install/enable time. Enabling the schedule fails until that approval exists; disabling the schedule only needs `database:write`.

## Schedule state

The schedule persists in `runtime/addons/jobs/eda-exchange-bot/buyback.json` (owner-only file, written atomically) and survives console restarts. If the console was down when a run came due, the scheduler recomputes `nextRunAt` one interval out at boot instead of firing immediately.

Uninstalling the addon removes its persisted scheduled-job files. Reinstalling therefore cannot unexpectedly resume a schedule configured before the uninstall.

Fields:

| Field | Meaning |
| --- | --- |
| `enabled` | Whether the schedule runs. Requires a valid `exchangeId` and the `scheduler:server` approval. |
| `intervalMinutes` | Minutes between runs, clamped to 10–1440 (default 30). |
| `exchangeId` | Target exchange, validated as a decimal string up to the PostgreSQL BIGINT max. |
| `priceMultiplier` | Seed-plan price multiplier used to derive buyback reference prices (1–100, default 5). |
| `buybackPercent` | Buy player listings priced at or below this percent of the reference price (1–100, default 60). |
| `maxBuys` | Maximum listings bought per sweep (1–5000, default 500). |
| `lastRunAt` / `lastRunStatus` / `lastRunDetail` / `nextRunAt` | Status reporting (`idle`, `swept`, or `error`). |

Validation note for addon authors: `intervalMinutes` is the only field that silently clamps into its range; `exchangeId`, `priceMultiplier`, `buybackPercent`, and `maxBuys` reject out-of-range or malformed values with an error. `exchangeId` must be sent as a decimal **string**, and run results report `totalUnits`/`totalSolari` as decimal strings too (BIGINT-safe).

Failures (database offline, backup failure) record an `error` status, apply the standard background failure backoff, and re-arm the next attempt.

## Bridge actions

The addon page manages the schedule through typed bridge actions on `POST /api/addons/installed/eda-exchange-bot/bridge`:

```js
// Read the schedule and last-run status (requires database:read).
await bridge("scheduler.schedule.get");

// Save the schedule (requires database:write; enabling also requires scheduler:server).
await bridge("scheduler.schedule.set", {
  schedule: { enabled: true, exchangeId: "42", intervalMinutes: 30, buybackPercent: 60, maxBuys: 500 }
});

// Read-only eligibility check, optionally overriding saved parameters (requires database:read).
await bridge("scheduler.probe", { exchangeId: "42", buybackPercent: 60 });

// Run one sweep now (requires database:write). Takes a backup only when eligible listings exist.
await bridge("scheduler.run");
```

The existing addon bridge rate limits apply to these actions; scheduled background runs consume a dedicated mutation rate-limit scope (`addon-scheduler:eda-exchange-bot`) since no session or client IP exists in that context.
