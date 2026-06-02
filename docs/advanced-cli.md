# Advanced CLI Notes

Arrakis Server Console is the recommended admin surface for normal use. The RedBlink CLI remains available for advanced maintenance, automation, and emergency recovery.

Install or reinstall the wrapper if you want the `dune` command globally:

```bash
sudo runtime/scripts/install-command.sh
```

The wrapper points to `runtime/scripts/dune`. If you move the repo, reinstall the wrapper or set `DUNE_DOCKER_DIR=/path/to/dune-awakening-selfhost-docker`.

## Common Commands

| Task | Command |
|---|---|
| Open interactive manager | `dune manager` |
| First-time init or reset-style setup | `dune init` |
| Start server stack | `dune start` |
| Stop server stack | `dune stop` |
| Check status | `dune status` |
| Check readiness | `dune ready` |
| Show containers | `dune ps` |
| Show expected/listening ports | `dune ports` |
| Run diagnostics | `dune doctor` |
| View service logs | `dune logs <service>` |
| Restart a service | `dune restart <service>` |

## Backups

| Task | Command |
|---|---|
| Create database backup | `dune db backup` |
| List backups | `dune db list` |
| Restore backup | `dune db restore <backup>` |
| Delete backup | `dune db delete <backup>` |

Restores are destructive. Create a fresh backup first and disconnect players if needed.

## Updates

| Task | Command |
|---|---|
| Check game server update | `dune update check` |
| Apply game server update | `dune update --yes` |
| Check stack update | `dune self-update check` |
| Install latest stack update | `dune self-update install latest` |

## Maps, Sietches, and Deep Desert

| Task | Command |
|---|---|
| List servers | `dune servers` |
| List maps | `dune maps list` |
| Show map mode | `dune maps mode` |
| Set map mode | `dune maps set <map> <dynamic|always-on>` |
| Reconcile maps | `dune maps reconcile` |
| Spawn map/server | `dune spawn <map-or-partition>` |
| Despawn map/server | `dune despawn <target>` |
| Autoscaler status | `dune autoscaler status` |
| Sietch list/status | `dune sietches list` |
| Deep Desert status | `dune deepdesert dual status` |
| Memory status | `dune memory status` |

Map and Sietch changes can affect live services. Prefer the web UI unless you are intentionally doing advanced maintenance.

## Player Admin Commands

| Task | Command |
|---|---|
| List players | `dune admin players` |
| List online players | `dune admin players --online` |
| Search items | `dune admin item-search "<query>"` |
| Grant item by name | `dune admin grant-item PLAYER_FLS_ID "Item Name" 1 1` |
| Grant item by ID | `dune admin grant-item-id PLAYER_FLS_ID ITEM_ID 1 1` |
| Add XP | `dune admin award-xp PLAYER_FLS_ID 1000` |
| Set skill points | `dune admin skill-points PLAYER_FLS_ID 10` |
| Set skill module | `dune admin skill-module PLAYER_FLS_ID Skills.Ability.Hypersprint 1` |
| Refill water | `dune admin refill-water PLAYER_FLS_ID` |
| Kick player | `dune admin kick PLAYER_FLS_ID` |
| Vehicle list | `dune admin vehicle-list` |
| Spawn vehicle | `dune admin spawn-vehicle PLAYER_FLS_ID Sandbike T1_ExtraSeat` |
| Command history | `dune admin history` |

Use the player FLS/admin ID, for example `RedBlink#75570`, for CLI-backed admin commands. Database actor IDs are not accepted by most live admin commands.

## Database Browser

The web UI is safer for normal read-only database browsing. Advanced CLI database commands include:

```bash
dune database status
dune database schemas
dune database tables
dune database preview
dune database sql
dune database export
```

Avoid direct SQL writes unless you know the schema and have a fresh backup.

## Runtime Paths

| Path | Meaning |
|---|---|
| `.env` | Local server settings |
| `runtime/secrets/` | Local secrets such as Funcom token and web admin password |
| `runtime/generated/` | Generated state, catalogs, exports, and web admin history |
| `runtime/backups/` | Backups |
| `runtime/data/` | Admin catalogs |
| `runtime/scripts/` | CLI scripts |

Do not commit secrets or local runtime state.
