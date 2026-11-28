# Webhook-Benachrichtigungen

**Status:** Aktuell | **Zuletzt aktualisiert:** November 2026

> English version: [README.md](README.md)

Die Console kann eine Nachricht an Discord oder an einen beliebigen HTTPS-Endpunkt senden, wenn:

| Ereignis | Wann es gesendet wird |
|---|---|
| **Server-Neustart** | Ein Neustart ist abgeschlossen, egal ob manuell in der Console oder automatisch gestartet: geplanter Neustart, Neustart nach einem Game-Update, Wiederherstellung hängender Server, CLI oder Skript. Fehlgeschlagene Neustarts werden ebenfalls gemeldet. |
| **Game-Update verfügbar** | Die Steam-Prüfung findet einen neueren Dune: Awakening-Server-Build als den installierten. |
| **Console-Update verfügbar** | Auf GitHub ist eine neuere Dune-Docker-Version veröffentlicht. |

Webhooks werden unter **Settings → Webhooks** eingerichtet. Dafür ist weder eine Änderung an der `.env` noch ein Neustart nötig.

## Schnellstart mit Discord

1. In Discord **Servereinstellungen → Integrationen → Webhooks → Neuer Webhook** öffnen.
2. Den Kanal für die Nachrichten wählen und **Webhook-URL kopieren** klicken.
3. In der Console **Settings → Webhooks** öffnen und **Add Webhook** klicken.
4. Den Typ **Discord** lassen und die URL in **Webhook URL** einfügen.
5. Die gewünschten Ereignisse wählen und **Save Webhooks** klicken.
6. **Send Test** klicken. Im Kanal erscheint die Nachricht "Webhook test".

Es lassen sich bis zu 5 Webhooks anlegen, zum Beispiel ein Kanal für Neustarts und ein anderer für Updates.

## Einstellungen

| Feld | Bedeutung |
|---|---|
| **Name** | Deine Bezeichnung für den Webhook, angezeigt in der Console und in Log-Zeilen. |
| **Type** | **Discord** sendet ein Discord-Embed. **Generic JSON** sendet den unten beschriebenen JSON-Body. |
| **Webhook URL** | Muss mit `https://` beginnen. Discord-URLs müssen die Form `https://discord.com/api/webhooks/<id>/<token>` haben; ein Versionsteil wie `/api/v10/` wird ebenfalls akzeptiert. Nach dem Speichern wird die URL nie wieder angezeigt. Feld leer lassen, um die gespeicherte URL zu behalten, oder eine neue eintragen, um sie zu ersetzen. |
| **Enabled** | Schaltet den Webhook ab, ohne ihn zu löschen. |
| **Server restart / Game update available / Console update available** | Die Ereignisse, die dieser Webhook erhält. |
| **Include map and service restarts** | Standardmäßig werden nur Neustarts der Battlegroup gemeldet. Mit dieser Option kommen auch Neustarts einzelner Maps, Sietches und Dienste dazu. |
| **Update check interval (minutes)** | Wie oft die Console für Webhooks nach Game- und Console-Updates sucht (30 bis 1440, Standard 60). |

Unter jedem Webhook zeigt die Console, ob die letzte Nachricht zugestellt wurde, und wenn nicht, den HTTP-Status oder Fehler. Diese Anzeige liegt nur im Speicher und wird bei einem Neustart der Console zurückgesetzt.

## Wann Nachrichten ausgelöst werden

### Server-Neustarts

Jeder Neustart wird bereits im Restart-Journal festgehalten (`runtime/generated/restart-history.jsonl`, in der Console als Restart History sichtbar). Die Console liest alle 15 Sekunden neue Einträge und sendet pro Eintrag eine Nachricht. Das deckt Neustarts aus der Console, durch den Neustart-Zeitplan, durch ein Game-Update, durch die automatische Wiederherstellung und von der Kommandozeile ab.

Das Feld **Trigger** in jeder Nachricht sagt, was den Neustart ausgelöst hat:

| Trigger | Herkunft |
|---|---|
| Manual (Console) | Von einem Admin in der Console gestartet. |
| Automatic (scheduled restart) | Der Neustart-Zeitplan. |
| Game update | Der Neustart, der ein Game-Update einspielt, egal ob aus der Console, über die CLI oder durch automatische Updates gestartet. |
| Automatic (recovery) | Automatische Wiederherstellung hängender Game-Server. |
| Runtime (CLI or script) | Ein Game-Farm-Neustart von der Kommandozeile oder aus einem Skript. |

Hinweise:

- Beim ersten Einrichten werden ältere Journal-Einträge **nicht** gesendet. Gemeldet werden nur Neustarts, die ab dann abgeschlossen werden.
- Ist die Console selbst nicht erreichbar, während ein Neustart endet (zum Beispiel bei einem Console-Update), wird die Nachricht gesendet, sobald sie wieder läuft.
- Jeder Webhook erhält seine Nachrichten in der Reihenfolge, in der die Neustarts endeten. Pro 15-Sekunden-Durchlauf werden höchstens 20 neue Einträge gesendet.

### Updates

Die Console nutzt dieselben Update-Prüfungen wie die Seite **Updates**. Hat diese Seite kürzlich geprüft, wird das zwischengespeicherte Ergebnis verwendet; sonst läuft die Prüfung live (SteamCMD für das Spiel, GitHub für die Console). Die erste Prüfung läuft etwa zwei Minuten nach dem Start der Console, danach einmal pro **Update check interval**. Wird ein geändertes Intervall gespeichert oder ein Update-Ereignis eingeschaltet, läuft die nächste Prüfung sofort.

Jede neue Version wird pro Webhook einmal gemeldet:

- Ein Webhook, der hinzukommt, während schon ein Update aussteht, bekommt es bei der nächsten Prüfung trotzdem.
- Schlägt eine Zustellung fehl, wird sie bei der nächsten Prüfung wiederholt, bis sie klappt.
- Ist das Update installiert und meldet die Prüfung "kein Update", wird der Vermerk gelöscht, sodass die nächste neue Version wieder gemeldet wird.

Update-Nachrichten sagen nur, dass ein Update **verfügbar** ist. Installieren und den anschließenden Neustart erledigst weiterhin du oder die automatischen Updates. Dieser Neustart erscheint dann als eigene Nachricht **Server-Neustart** mit dem Trigger **Game update**.

## Format für Generic JSON

Webhooks vom Typ **Generic JSON** erhalten einen `POST` mit `content-type: application/json`:

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
| `serverRestart` | Trigger, Scope, Result, Duration | Der Eintrag aus der Restart History, wie oben. |
| `gameUpdate` | Installed build, New build | `installed`, `latest` |
| `consoleUpdate` | Installed version, New version | `installed`, `latest`, `releaseUrl` |
| `test` | keine | `{}` |

Eine Antwort mit `2xx` gilt als zugestellt. Weiterleitungen werden nicht verfolgt. Die Anfrage bricht nach 10 Sekunden ab. Bei HTTP `429` wartet die Console die Zeit aus `Retry-After` ab (höchstens 30 Sekunden) und versucht es noch einmal.

Titel und Feldnamen sind auf Englisch, wie die restliche Console.

## Sicherheit und Daten

- Webhook-Einstellungen lassen sich nur mit den Berechtigungen `settings:read` und `settings:write` lesen und ändern. API-Keys haben darauf keinen Zugriff.
- Eine Webhook-URL enthält ihre eigene Zugangsberechtigung (bei Discord das Token am Ende). Sie wird mit Dateirechten `0600` in `runtime/generated/webhook-settings.json` gespeichert und nie an den Browser zurückgegeben. Die Console zeigt nur einen kurzen Hinweis wie `discord.com/…abcd`.
- Akzeptiert werden nur `https://`-URLs zu öffentlichen Hostnamen. Adressen wie `localhost`, `127.0.0.1` oder `192.168.x.x` werden abgelehnt. Der Name wird beim Speichern nicht aufgelöst; der eigentliche Schutz ist, dass nur Admins Webhooks ändern dürfen.
- In Discord-Nachrichten sind Erwähnungen abgeschaltet, ein Map-Name oder Neustartgrund kann also nie `@everyone` anpingen.
- Der Zustellstand liegt in `runtime/generated/webhook-state.json`. Beide Dateien sind Teil der System-Backups. Nach einer Wiederherstellung übernimmt die Console die wiederhergestellten Einstellungen innerhalb von 15 Sekunden.
- Speichern und Test-Versand werden im Audit-Log der Console vermerkt (`settings.webhooks-updated`, `settings.webhook-test`), ohne die URLs.

## API

| Methode und Pfad | Berechtigung | Zweck |
|---|---|---|
| `GET /api/settings/webhooks` | `settings:read` | Einstellungen, Grenzen und letzte Zustellung pro Webhook. URLs sind nie enthalten. |
| `POST /api/settings/webhooks` | `settings:write` | Ersetzt alle Webhooks. Body: `{ "updateCheckMinutes": 60, "webhooks": [{ "id"?, "name", "type", "url"?, "enabled", "events", "includeMapRestarts" }] }`. `url` bei einer bestehenden `id` weglassen, um die gespeicherte URL zu behalten. |
| `POST /api/settings/webhooks/test` | `settings:write` | Sendet eine Testnachricht an einen gespeicherten Webhook. Body: `{ "id": "<webhook id>" }`. |

## Fehlersuche

| Symptom | Was prüfen |
|---|---|
| "Discord webhook URL must look like …" | Die URL in Discord erneut über **Webhook-URL kopieren** holen. Sie muss `/api/webhooks/<id>/<token>` enthalten. |
| Letzte Zustellung zeigt HTTP 401 oder 404 | Der Discord-Webhook wurde gelöscht oder sein Token zurückgesetzt. Einen neuen anlegen und die neue URL eintragen. |
| Letzte Zustellung zeigt HTTP 429 | Discord hat den Webhook gedrosselt. Die Nachrichten gehen von selbst weiter; einen Webhook möglichst nicht mit vielen Tools teilen. |
| Keine Neustart-Nachrichten | Prüfen, ob der Webhook **Enabled** ist und **Server restart** angehakt hat. Map- oder Dienst-Neustarts brauchen **Include map and service restarts**. Neustarts, die vor dem Einrichten endeten, werden nicht gesendet. |
| Keine Update-Nachrichten | Die erste Prüfung abwarten (etwa zwei Minuten nach dem Start der Console, danach pro Intervall). Die Seite Updates prüfen: Schlägt dort die Prüfung fehl, kann keine Update-Nachricht gesendet werden. Im Console-Log steht dann `Webhook gameUpdate check failed` oder `Webhook consoleUpdate check failed` mit dem Grund. |
| Nachrichten in der falschen Sprache | Nachrichten sind auf Englisch, wie die restliche Console. |
