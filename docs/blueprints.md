# Blueprint Import/Export — Developer Documentation

## Overview

The Blueprints feature allows server admins to import, export, list, and delete
player building blueprints through the admin console. Blueprints are stored as
`BuildingBlueprint_CopyDevice` solido items in the player's backpack inventory.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│ Admin Console (React SPA)                                │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ BlueprintsPanel.tsx                                   │ │
│ │ - File upload with multi-select                       │ │
│ │ - Progress bar during import                          │ │
│ │ - DataTable with checkbox selection                   │ │
│ │ - Export Single / Selected / All                      │ │
│ │ - Delete Single / Selected                            │ │
│ │ - Inventory capacity check (all-or-nothing)           │ │
│ └────────────────┬─────────────────────────────────────┘ │
└──────────────────┼──────────────────────────────────────┘
                   │ fetch() + FormData / JSON
┌──────────────────▼──────────────────────────────────────┐
│ Express API Server (server.js)                           │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ GET  /api/blueprints              → listBlueprints()  │ │
│ │ GET  /api/blueprints/:id/export   → exportBlueprint() │ │
│ │ POST /api/blueprints/import       → importBlueprint() │ │
│ │ DEL  /api/blueprints/:id          → deleteBlueprint() │ │
│ └──────────────────┬───────────────────────────────────┘ │
└────────────────────┼────────────────────────────────────┘
                     │ pg (parameterized)
┌────────────────────▼────────────────────────────────────┐
│ PostgreSQL — dune schema                                 │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ building_blueprints         (id, item_id, player_id)  │ │
│ │ building_blueprint_instances (piece data)             │ │
│ │ building_blueprint_placeables (decor data)             │ │
│ │ building_blueprint_pentashields (shield data)          │ │
│ │ items                       (inventory items)         │ │
│ │ inventories                 (slot/volume limits)       │ │
│ └──────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

## Database Schema

### Tables used

| Table | Key columns | Purpose |
|-------|-------------|---------|
| `dune.building_blueprints` | `id`, `item_id`, `player_id`, `building_blueprint_map` | Blueprint metadata |
| `dune.building_blueprint_instances` | `building_blueprint_id`, `instance_id`, `building_type`, `transform`, `hologram`, `provides_stability`, `health` | Building pieces |
| `dune.building_blueprint_placeables` | `building_blueprint_id`, `placeable_id`, `building_type`, `transform`, `hologram` | Placeable objects |
| `dune.building_blueprint_pentashields` | `building_blueprint_id`, `placeable_id`, `scale` | Pentashield data |
| `dune.items` | `id`, `inventory_id`, `template_id`, `stack_size`, `position_index`, `stats`, `volume_override` | Inventory items |
| `dune.inventories` | `id`, `actor_id`, `inventory_type`, `max_item_count`, `max_item_volume` | Inventory containers |
| `dune.player_state` | `player_pawn_id`, `character_name`, `online_status` | Player state |

### Item Stats JSON Structure

Each `BuildingBlueprint_CopyDevice` item stores blueprint metadata in `dune.items.stats`:

```json
{
  "FCustomizationStats": [[], {}],
  "FBuildingBlueprintItemStats": [[], {
    "PlayerBlueprintId": "!!bbp#123",
    "BuildingBlueprintName": "My Base",
    "PlayerBaseBackupId": {}
  }],
  "FItemStackAndDurabilityStats": [[], {
    "DecayedMaxDurability": 0.0
  }]
}
```

- `PlayerBlueprintId`: Format `!!bbp#ID` — used by game server to link item to blueprint
- `PlayerBaseBackupId`: Empty object `{}` — present in live solido format for compatibility
- `BuildingBlueprintName`: Display name for the blueprint

## API Reference

### GET /api/blueprints

Returns all blueprints for all players.

**Response**: JSON array of objects:
```json
[
  {
    "id": 14,
    "owner_id": "6",
    "owner_name": "PlayerName",
    "item_id": 789309,
    "pieces": 2217,
    "placeables": 188,
    "name": "My Base"
  }
]
```

### GET /api/blueprints/:id/export

Exports a blueprint as downloadable JSON file.

**Response**: JSON file download with structure:
```json
{
  "name": "My Base",
  "instances": [
    {
      "instance_id": 0,
      "building_type": "Foundation_1",
      "x": 7545.8,
      "y": -2697.4,
      "z": 1418.6,
      "rotation": -60.0,
      "provides_stability": true
    }
  ],
  "placeables": [...],
  "pentashields": [...]
}
```

### POST /api/blueprints/import

Imports one or more blueprint JSON files.

**Request**: `multipart/form-data`
- `file`: Blueprint JSON file(s)
- `player_id`: Player pawn ID (numeric, required)

**Constraints**:
- Max file size: 32 MB (32 << 20 bytes)
- Max files per batch: 10 (frontend-enforced)
- Player must exist in `dune.player_state`
- Inventory must exist in `dune.inventories` (type 0)
- Blueprint must have at least one `instances`, `placeables`, or `pentashields` array
- Player can be online — import succeeds with relog warning

**Response**:
```json
{
  "ok": true,
  "message": "Imported 2217 pieces + 188 placeables + 0 pentashields -> My Base (#14, item 789309) in player inventory",
  "blueprintName": "My Base",
  "blueprintId": 14,
  "itemId": 789309,
  "pieces": 2217,
  "placeables": 188,
  "pentashields": 0,
  "online": false
}
```

### DELETE /api/blueprints/:id

Deletes a blueprint and its associated inventory item.

**Transaction**: Removes rows from all 5 tables in order:
1. `building_blueprint_pentashields`
2. `building_blueprint_placeables`
3. `building_blueprint_instances`
4. `building_blueprints`
5. `items`

**Response**:
```json
{ "ok": true }
```
or
```json
{ "ok": false, "error": "Blueprint not found" }
```

## Name Resolution

Blueprint names are resolved in this priority order:

1. `bf.name` — JSON `"name"` field
2. `bf.Name` — JSON `"Name"` field (capital N)
3. `bf.blueprint_name` — JSON `"blueprint_name"` field
4. **File name** — derived from uploaded filename, with `.json` stripped
5. `bf.instances[0].building_type` — first piece type
6. `"Imported Blueprint"` — hardcoded fallback

### Name Sanitization

All name sources are sanitized:
- `_` (underscore) → replaced with space
- `.` (dot) → replaced with space
- `\` (backslash) → replaced with space
- Multiple consecutive spaces collapsed to single space
- Leading/trailing whitespace trimmed

Example: `Hawks_Base.v2.json` → `"Hawks Base v2"`

### Name Deduplication

If a blueprint with the same sanitized name already exists for the player,
a Windows-style numeric suffix is appended:

- First duplicate: `"My Base (2)"`
- Second duplicate: `"My Base (3)"`
- etc.

Before deduplication, any existing ` (N)` suffix is stripped from the name,
preventing nested suffixes like `"My Base (1) (2)"`.

Example:
- Import `"Base (1).json"` → strip `(1)` → base = `"Base"`
- If `"Base"` exists, try `"Base (2)"` → `"Base (3)"` → etc.

## Inventory Validation

### Slot Check (Backend)

During import, the transaction queries:
```sql
select count(*)::int as cnt from dune.items where inventory_id = $1
```
and compares against `dune.inventories.max_item_count` (default: 40).

If `used >= max`, the import is rejected with:
`"Inventory full (40/40 slots). Cannot import blueprint."`

### Slot Check (Frontend)

The frontend calls `GET /api/players/:id/inventory` (now filtered to `inventory_type = 0`, backpack only)
and blocks the entire batch if `importFiles.length > availableSlots`. This is all-or-nothing —
no partial imports.

### Volume

Volume checking is deferred. The `dune.items` table stores `volume_override` (usually NULL),
and item template volumes are in game binaries, not accessible from the admin API.
A solido item (`BuildingBlueprint_CopyDevice`) has negligible volume (~0.1-1.0),
so volume is rarely a bottleneck vs. slot count (40 default).

## Frontend Component

### BlueprintsPanel.tsx

React component integrated into `CharacterAdminUI` as a sub-tab between Journey and Admin.

**State management**:
- `rows`: blueprint list from API
- `selected`: Set of selected blueprint IDs
- `importFiles`: files selected for import (replaced on each new upload)
- `importing`/`exporting`: boolean flags for loading states
- `importProgress`: `{ current, total, name }` for progress display
- `message`: transient status/error messages

**Key behaviors**:
- Import button disabled when: no files selected, no player selected, or import in progress
- `importing` flag set to `true` immediately on click, reset to `false` on ALL exit paths
- Old messages cleared on each new attempt
- File input replaces previous selection on re-click (not append)
- Max 10 files per import batch
- Inventory capacity checked before import; batch rejected if insufficient slots

### Progress Indicator

During import, a full-width panel appears above the action buttons:

```
┌──────────────────────────────────────────────┐
│ Importing 3 of 5                              │
│ Hawks_Base.json                               │
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░ (accent gradient)    │
└──────────────────────────────────────────────┘
```

## Batch Processing

Building instances and placeables are inserted in batches of 50 rows
(`BLUEPRINT_IMPORT_BATCH_SIZE = 50`). A 2217-piece blueprint generates
~45 insert batches. The entire import runs in a single database transaction.

Large blueprints (2217 pieces + 188 placeables) import in ~1-2 seconds.

## Security

### CSRF Protection

All mutation endpoints (POST, DELETE) require a valid `x-csrf-token` header,
validated against the session's CSRF token in `auth.js`.

### SQL Injection

All database queries use parameterized values (`$1`, `$2`, etc.).
No SQL string concatenation with user input.

### Input Validation

| Input | Validation |
|-------|-----------|
| `player_id` | Must be numeric, > 0 (`Number.isFinite`) |
| Blueprint file | Must parse as valid JSON |
| Blueprint content | Must have at least one of `instances`, `placeables`, `pentashields` as arrays |
| Blueprint ID (delete/export) | Must be numeric, > 0 |
| Upload size | Max 32 MB enforced by `readMultipartForm` |
| Name field | String cast + sanitization before DB insertion |

### Route Order

Routes are registered in order to prevent path confusion:
1. `GET /api/blueprints` (list)
2. `GET /api/blueprints/:id/export` (export)
3. `POST /api/blueprints/import` (import)
4. `DELETE /api/blueprints/:id` (delete)

Routes 1-3 use exact matching before the generic `:id` delete pattern,
preventing `"import"` or `"export"` from being interpreted as blueprint IDs.

### Error Redaction

Error messages returned to the client are redacted via the `redact()` function
to prevent leaking internal paths, stack traces, or sensitive configuration.

### Audit Trail

All blueprint mutations log to the audit system:
- `audit(config, req, "blueprints.import", {...})`
- `audit(config, req, "blueprints.delete", {...})`

## Testing

### Test Files

| File | Tests | Scope |
|------|-------|-------|
| `test/blueprints.test.js` | 52 | Unit tests: import, export, list, delete, deduplication, name sanitization, slot limits, batch handling, edge cases |
| `test/httpSafety.test.js` | 15 | Multipart form: fields+files, binary, size limits, quoted boundaries, path traversal |
| `test/blueprints-http-routes.test.js` | 15 | Route validation, ID parsing, filename sanitization |

### Running Tests

```bash
cd console/api
npm ci
node --test test/blueprints*.test.js test/httpSafety.test.js
```

### OWASP Top 10 Security Tests

Additional security tests live in the
[ops-observability addon](https://github.com/yacketrj/dune-ops-observability-addon/tree/main/pipeline/tests)
and can be injected into any repo:

```bash
bash pipeline/run-security-tests.sh <path-to-repo>
```

Covers A01-A10 static analysis checks for the blueprint API surface.

## Known Issues

### P34 Crash on In-Game Blueprint Preview

- **Status**: OPEN
- **Finding**: Game server crashes (P34) when previewing some imported blueprints in-game
- **Fixed**: `PlayerBaseBackupId` added to stats JSON to match live solido format
- **Verification needed**: Test with different blueprints and map types
- **Root cause candidates**: hologram flag interaction, transform format mismatch, `building_blueprint_map` empty, invalid building types on target map

### Volume Validation

Cannot validate inventory volume limits without item template data
(deferred to future branch that scrapes game data tables).

## Deployment

### E2E Clean Stack

```bash
# Deploy latest code to e2e-clean
docker cp console/api/src/blueprints.js redblink-dune-docker-console:/app/src/blueprints.js
docker cp console/api/src/server.js redblink-dune-docker-console:/app/src/server.js
docker cp console/web/dist/. redblink-dune-docker-console:/app/web-dist/
docker restart redblink-dune-docker-console
```

### Rebuild Frontend

```bash
cd console/web && npx vite build
```

## Files

| File | Purpose |
|------|---------|
| `console/api/src/blueprints.js` | Blueprint CRUD operations |
| `console/api/src/httpSafety.js` | Multipart form parser, static safety |
| `console/api/src/server.js` | HTTP route handlers |
| `console/api/src/duneDb.js` | Inventory query (backpack-only filter) |
| `console/web/src/features/blueprints/BlueprintsPanel.tsx` | React UI component |
| `console/web/src/features/players/CharacterAdminUI.tsx` | Tab integration |
| `console/api/test/blueprints.test.js` | Unit tests |
| `console/api/test/httpSafety.test.js` | Multipart tests |
| `console/api/test/blueprints-http-routes.test.js` | Route tests |
