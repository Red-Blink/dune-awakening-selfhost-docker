# Webhook Notifications

**Status:** Current | **Last Updated:** November 2026

> Deutsche Fassung: [README_de.md](README_de.md)

The Console can post a message to Discord, or to any HTTPS endpoint, when:

| Event | When it is sent |
|---|---|
| **Server restart** | A restart finished, whether it started manually in the Console or automatically: scheduled restart, restart after a game update, stalled-server recovery, CLI or script. Failed restarts are reported too. |
| **Game update available** | The Steam update check finds a newer Dune: Awakening server build than the installed one. |
| **Console update available** | A newer Dune Docker release is published on GitHub. |

Webhooks are configured in **Settings → Webhooks**. No `.env` change and no restart are needed.

## Quick Start with Discord

1. In Discord, open **Server Settings → Integrations → Webhooks → New Webhook**.
2. Pick the channel for the messages, then click **Copy Webhook URL**.
3. In the Console, open **Settings → Webhooks** and click **Add Webhook**.
4. Keep the type **Discord** and paste the URL into **Webhook URL**.
5. Choose the events and click **Save Webhooks**.
6. Click **Send Test**. A "Webhook test" message appears in the channel.

You can add up to 5 webhooks, for example one channel for restarts and another for updates.

## Settings

| Field | Meaning |
|---|---|
| **Name** | Your label for the webhook, shown in the Console and in log lines. |
| **Type** | **Discord** sends a Discord embed. **Generic JSON** sends the JSON body described below. |
| **Webhook URL** | Must start with `https://`. Discord URLs must look like `https://discord.com/api/webhooks/<id>/<token>`; a version segment such as `/api/v10/` is also accepted. After saving, the URL is never shown again. Leave the field empty to keep the saved URL, or type a new one to replace it. |
| **Enabled** | Turn the webhook off without deleting it. |
| **Server restart / Game update available / Console update available** | The events this webhook receives. |
| **Include map and service restarts** | By default only Battlegroup restarts are announced. Turn this on to also announce single map, Sietch and service restarts. |
| **Update check interval (minutes)** | How often the Console checks for game and Console updates for webhooks (30 to 1440, default 60). |

Below each webhook, the Console shows whether the last message was delivered and, if not, the HTTP status or error. This status is kept in memory and resets when the Console restarts.

## How Messages Are Triggered

### Server restarts

Every restart is already written to the restart journal (`runtime/generated/restart-history.jsonl`, also shown as Restart History in the Console). The Console reads new entries every 15 seconds and sends one message per entry. This covers restarts started from the Console, by the restart schedule, by a game update, by automatic recovery and from the command line.

The **Trigger** field of each message tells you what started the restart:

| Trigger | Origin |
|---|---|
| Manual (Console) | Started by an admin in the Console. |
| Automatic (scheduled restart) | The restart schedule. |
| Game update | The restart that applies a game update, whether started in the Console, from the CLI or by automatic updates. |
| Automatic (recovery) | Automatic recovery of stalled game servers. |
| Runtime (CLI or script) | A Game Farm restart run from the command line or a script. |

Notes:

- When webhooks are set up for the first time, older journal entries are **not** sent. Only restarts that finish from then on are announced.
- If the Console itself is down while a restart finishes (for example, during a Console update), the message is sent when the Console is back.
- Each webhook gets its messages in the order the restarts finished. At most 20 new entries are sent per 15-second pass.

### Updates

The Console reuses the same update checks as the **Updates** page. If that page checked recently, its cached result is used; otherwise the check runs live (SteamCMD for the game, GitHub for the Console). The first check runs about two minutes after the Console starts, then once per **Update check interval**. Saving a changed interval or switching an update event on runs the next check right away.

Each new version is announced once per webhook:

- A webhook added while an update is already pending still receives it at the next check.
- If a delivery fails, it is retried at the next check until it succeeds.
- When the update is installed and the check reports "no update", the record is cleared, so the next new version is announced again.

Update messages only say that an update is **available**. Installing it, and the restart that follows, is still done by you or by automatic updates. That restart then appears as a separate **Server restart** message with the trigger **Game update**.

## Generic JSON Format

Webhooks of type **Generic JSON** receive a `POST` with `content-type: application/json`:

```json
{
  "source": "dune-docker",
  "event": "serverRestart",
  "title": "Server restarted",
  "message": "Battlegroup: Scheduled restart",
  "timestamp": "2026-11-28T04:00:00Z",
  "fields": {
    "Trigger": "Automatic (scheduled restart)",
    "Scope": "Battlegroup",
    "Result": "Succeeded",
    "Duration": "3m 0s"
  },
  "data": {
    "id": "runtime-4242-2026-11-28T04:00:00Z",
    "startedAt": "2026-11-28T03:57:00Z",
    "finishedAt": "2026-11-28T04:00:00Z",
    "durationSeconds": 180,
    "scope": "battlegroup",
    "target": "Battlegroup",
    "map": "",
    "partitionId": "",
    "source": "Scheduled",
    "reason": "Scheduled restart",
    "result": "Succeeded"
  },
  "footer": "Dune Docker v1.4.69"
}
```

| `event` | `fields` | `data` |
|---|---|---|
| `serverRestart` | Trigger, Scope, Result, Duration | The Restart History entry, as shown above. |
| `gameUpdate` | Installed build, New build | `installed`, `latest` |
| `consoleUpdate` | Installed version, New version | `installed`, `latest`, `releaseUrl` |
| `test` | none | `{}` |

A `2xx` answer counts as delivered. Redirects are not followed. The request times out after 10 seconds. On HTTP `429` the Console waits for `Retry-After` (up to 30 seconds) and tries once more.

## Security and Data

- Webhook settings can only be read and changed with the `settings:read` and `settings:write` permissions. API keys cannot reach them.
- A webhook URL contains its own credential (for Discord, the token at the end). It is stored with file mode `0600` in `runtime/generated/webhook-settings.json` and is never sent back to the browser. The Console only shows a short hint such as `discord.com/…abcd`.
- Only `https://` URLs to public host names are accepted. Addresses such as `localhost`, `127.0.0.1` or `192.168.x.x` are rejected. The name is not resolved when saving, so the admin-only permission is the actual protection.
- Discord messages have mentions turned off, so a map name or restart reason can never ping `@everyone`.
- Delivery progress is stored in `runtime/generated/webhook-state.json`. Both files are part of system backups. After a restore, the Console picks up the restored settings within 15 seconds.
- Saving settings and sending a test are written to the Console audit log (`settings.webhooks-updated`, `settings.webhook-test`), without the URLs.

## API

| Method and path | Permission | Purpose |
|---|---|---|
| `GET /api/settings/webhooks` | `settings:read` | Settings, limits and the last delivery per webhook. URLs are never included. |
| `POST /api/settings/webhooks` | `settings:write` | Replace all webhooks. Body: `{ "updateCheckMinutes": 60, "webhooks": [{ "id"?, "name", "type", "url"?, "enabled", "events", "includeMapRestarts" }] }`. Omit `url` for an existing `id` to keep the saved URL. |
| `POST /api/settings/webhooks/test` | `settings:write` | Send a test message to a saved webhook. Body: `{ "id": "<webhook id>" }`. |

## Troubleshooting

| Symptom | What to check |
|---|---|
| "Discord webhook URL must look like …" | Copy the URL again with **Copy Webhook URL** in Discord. It must contain `/api/webhooks/<id>/<token>`. |
| Last delivery shows HTTP 401 or 404 | The Discord webhook was deleted or its token was reset. Create a new one and paste the new URL. |
| Last delivery shows HTTP 429 | Discord rate-limited the webhook. Messages resume on their own; avoid sharing one webhook between many tools. |
| No restart messages | Check that the webhook is **Enabled** and has **Server restart** ticked. Map or service restarts need **Include map and service restarts**. Restarts that finished before the webhook was set up are not sent. |
| No update messages | Wait for the first check (about two minutes after the Console starts, then every interval). Check the Updates page: if its check fails, no update message can be sent. The Console log contains `Webhook gameUpdate check failed` or `Webhook consoleUpdate check failed` with the reason. |
| Messages in the wrong language | Messages are in English, like the rest of the Console. |
