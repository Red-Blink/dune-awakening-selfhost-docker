# Blueprint Import/Export — Feature Specification & Test Report

> **Branch**: `feature/blueprints-ui` | **PR**: [#80](https://github.com/Red-Blink/dune-awakening-selfhost-docker/pull/80)
> **Status**: Complete | **Tests**: 97 pass / 0 fail | **OWASP**: All 10 categories pass

---

## 1. Feature Summary

The Blueprints feature allows server admins to manage player building blueprints through the admin console. Admins can import blueprint JSON files into a player's inventory as `BuildingBlueprint_CopyDevice` solido items, export existing blueprints to JSON, list all blueprints with filtering, and delete blueprints with full cascade cleanup.

### Key Capabilities

| Capability | Description |
|-----------|-------------|
| **Multi-file import** | Import up to 10 blueprint JSON files in one batch |
| **Export Single / Selected / All** | Download blueprints as JSON with instances, placeables, pentashields |
| **Bulk delete** | Delete selected blueprints with inventory item removal |
| **Name resolution** | Name derived from file name with underscore/dot sanitization |
| **Name deduplication** | Windows-style (2), (3) suffixes when names collide |
| **Inventory validation** | Slot count check (all-or-nothing) against real `max_item_count` |
| **Online player support** | Import works for online players with relog warning |
| **Progress feedback** | Full-width progress panel with filename + animated bar |
| **Atomic operations** | All DB writes in transactions with row-level locking |

---

## 2. Architecture

```
Browser (React SPA)
  ├── BlueprintsPanel.tsx        │ Multi-select, progress, validation
  └── api/client.ts              │ CSRF-authenticated fetch()
         │
    ┌────▼──────────────────────────────────┐
    │  Express API (server.js)              │
    │  GET  /api/blueprints                 │ → listBlueprints()
    │  GET  /api/blueprints/:id/export      │ → exportBlueprint()
    │  POST /api/blueprints/import (32MB)   │ → importBlueprint()
    │  DEL  /api/blueprints/:id             │ → deleteBlueprint()
    └────┬──────────────────────────────────┘
         │
    ┌────▼──────────────────────────────────┐
    │  PostgreSQL (dune schema)             │
    │  building_blueprints                  │ Blueprint metadata
    │  building_blueprint_instances         │ Building pieces
    │  building_blueprint_placeables        │ Decor objects
    │  building_blueprint_pentashields      │ Shield data
    │  items                                │ Inventory items
    │  inventories                          │ Slot/volume limits
    │  player_state                         │ Online/offline status
    └───────────────────────────────────────┘
```

---

## 3. API Reference

### `GET /api/blueprints`
Returns all blueprints with owner name, piece/placeable counts, sorted newest-first.

### `GET /api/blueprints/:id/export`
Exports blueprint as downloadable JSON. Filename sanitized to remove path traversal characters.

### `POST /api/blueprints/import`
**Request**: `multipart/form-data` with `file` (JSON) and `player_id` (numeric).

**Validation**:
- File size ≤ 32 MB
- Player exists in `dune.player_state`
- Inventory exists (type 0)
- Contains at least one of: `instances`, `placeables`, `pentashields`

**Behavior**:
- Creates `BuildingBlueprint_CopyDevice` item at next position
- Inserts instances in batches of 50
- Sets hologram=true on all pieces
- Includes `PlayerBaseBackupId` in stats for live solido compatibility
- Warns if player is online (relog required to see item)
- Rejects if inventory slots are full

### `DELETE /api/blueprints/:id`
Cascade-deletes in transaction: pentashields → placeables → instances → blueprint → item.

---

## 4. Name Resolution Pipeline

```
Input: "Hawks_Base.v2.json"
  │
  ▼ strip .json
  "Hawks_Base.v2"
  │
  ▼ replace [_ . \\] → space, collapse whitespace
  "Hawks Base v2"
  │
  ▼ strip trailing " (N)" suffix
  "Hawks Base v2" (no suffix)
  │
  ▼ deduplication check against player's existing names
  "Hawks Base v2"             ← if unique, use as-is
  "Hawks Base v2 (2)"         ← if duplicate exists
  "Hawks Base v2 (3)"         ← if (2) also taken
```

---

## 5. Test Suite Summary

### 5.1 Unit Tests — `blueprints.test.js` (52 tests)

| Category | Tests | Coverage |
|----------|-------|----------|
| **Capabilities** | 3 | Table existence checks (all 6 tables required) |
| **Import — basic** | 6 | Item creation, instance/placeable/pentashield insertion |
| **Import — stability** | 2 | Structural building types, explicit `provides_stability` |
| **Import — batches** | 2 | 51+ instances, 200+ across multiple batches |
| **Import — edge cases** | 4 | Pentashield-only, empty arrays, non-arrays |
| **Export** | 3 | Full JSON structure, empty blueprint, undefined pentashields |
| **List** | 1 | Rows with piece/placeable counts |
| **Delete** | 3 | Happy path, not-found, null item_id |
| **Online player** | 1 | Warns with relog message |
| **Player not found** | 1 | Throws error |
| **Name fallback chain** | 4 | name → Name → blueprint_name → building_type |
| **Name sanitization** | 1 | Underscores, dots, backslashes → spaces |
| **Name deduplication** | 4 | (2), (3), (N) strip, rapid sequential |
| **Inventory slots** | 2 | Full slots reject, uses real max_item_count |
| **Stats JSON** | 3 | PlayerBaseBackupId, structure validation |
| **Instance/placeable** | 3 | Default IDs, explicit IDs, missing rotations |

### 5.2 Multipart Tests — `httpSafety.test.js` (15 tests)

| Category | Tests |
|----------|-------|
| Single file upload | 1 |
| Fields + files together | 1 |
| Multiple files | 1 |
| Empty body | 1 |
| Missing boundary (error) | 1 |
| Quoted boundary | 1 |
| Size limit enforcement | 1 |
| Binary file content | 1 |
| Special characters in field names | 1 |
| Parts without content-disposition | 1 |
| Large field values | 1 |
| Empty JSON body | 1 |
| Whitespace-only body | 1 |
| Path traversal (missing files) | 1 |
| Encoded path traversal | 1 |

### 5.3 Route Tests — `blueprints-http-routes.test.js` (15 tests)

| Category | Tests |
|----------|-------|
| Filename sanitization (special chars) | 1 |
| Filename sanitization (null/undefined) | 1 |
| Filename sanitization (empty string) | 1 |
| Filename sanitization (control chars) | 1 |
| Filename sanitization (valid chars) | 1 |
| Blueprint ID validation (valid) | 1 |
| Blueprint ID validation (non-numeric) | 1 |
| Blueprint ID validation (zero/negative) | 1 |
| Export ID validation (valid) | 1 |
| Export ID validation (malformed) | 1 |
| Export vs delete path distinction | 1 |
| Player ID validation (valid) | 1 |
| Player ID validation (invalid) | 1 |
| Route order — import before delete | 1 |
| Route order — export before delete | 1 |

### 5.4 Security Tests — `blueprints-security.test.js` (15 tests)

```
XSS in names          ✅  10K-long names     ✅  Large instance arrays  ✅
SQL injection names   ✅  Null bytes         ✅  Deeply nested JSON     ✅
Unicode names         ✅  Newlines in names  ✅  Negative IDs           ✅
Prototype pollution   ✅  String player IDs   ✅  Null item_id delete    ✅
```

### 5.5 OWASP Top 10 Tests — `owasp-security.test.js` (27 tests)

| OWASP Category | Checks |
|---------------|--------|
| **A01** Broken Access Control | CSRF validation, route authorization, path traversal |
| **A02** Cryptographic Failures | No hardcoded secrets, env-var passwords |
| **A03** Injection | Parameterized queries, no eval(), upload size limits |
| **A04** Insecure Design | Rate limiting, blueprint payload validation |
| **A05** Security Misconfig | Error redaction, proper error handling |
| **A06** Vulnerable Components | package-lock.json pinning |
| **A07** Auth Failures | crypto.randomBytes sessions, no password logging |
| **A08** Data Integrity | JSON upload validation, atomic transactions, cascade deletes |
| **A09** Logging & Monitoring | Audit calls on all mutations |
| **A10** SSRF | fetch() URL validation |

---

## 6. CI Gates

### Pre-commit Hooks (run on every commit)

| Hook | Purpose |
|------|---------|
| check-json | Valid JSON syntax in all `.json` files |
| check-yaml | Valid YAML syntax |
| check-merge-conflict | No unresolved merge markers |
| mixed-line-ending | LF line endings enforced |
| end-of-file-fixer | All files end with newline |
| trailing-whitespace | No trailing spaces |
| gitleaks | Hardcoded secret detection |
| ggshield | GitGuardian secret scanning |
| trivy | Container/fs secret + vulnerability scanning |
| semgrep | Static analysis (p/default rules) |

### GitHub Actions CI

| Job | Trigger | Checks |
|-----|---------|--------|
| `api-tests` | PR, push to main/integration/release | `node --test test/*.test.js` (439 tests) |
| `metrics-unit` | PR, push to main/integration/release | `bash tests/metrics-stack-unit.sh` |
| `security-checks` | PR, push to main/integration/release | `bash tests/security-pr-checks.sh` (gitleaks, trivy, shellcheck, secret scan) |
| `api-dependency-audit` | PR, push to main/integration/release | `npm audit --audit-level=high` |
| `owasp-security` | PR, push to main/integration/release | `node --test test/owasp-security.test.js` |

### Pipeline Tools (ops-observability-addon)

| Tool | Purpose |
|------|---------|
| `pre-push-gates` | Web build + artifact guard + test suite |
| `pre-pr-check.sh` | 6-step pre-PR validation |
| `merge-safety.sh` | JSX/TSX syntax check |
| `artifact-guard.sh` | Blocks generated files from commits |
| `run-security-tests.sh` | Injects OWASP + security tests into any repo |

---

## 7. Known Issues

| Issue | Status | Detail |
|-------|--------|--------|
| **P34 crash on preview** | OPEN | Some imported blueprints crash the game server when previewed. `PlayerBaseBackupId` fix applied. Root cause: likely engine-level — building type not valid for target map, or transform/hologram mismatch. |
| **Volume validation** | Deferred | Cannot compute inventory volume without item template data from game binaries. Deferred to data-scraping branch. |
| **Building blueprint map** | Empty | `building_blueprint_map` column set to `''`. Game behavior with empty map unknown but import succeeds with it. |

---

## 8. File Manifest

### Source Files

| File | Lines | Purpose |
|------|-------|---------|
| `console/api/src/blueprints.js` | 373 | Import, export, list, delete operations |
| `console/api/src/server.js` | 2278 | HTTP route handlers (4 routes added) |
| `console/api/src/httpSafety.js` | 82 | Multipart form parser (fields + files) |
| `console/api/src/duneDb.js` | 4201 | Inventory query (inventory_type=0 filter) |
| `console/web/src/features/blueprints/BlueprintsPanel.tsx` | 254 | React UI component |
| `console/web/src/features/players/CharacterAdminUI.tsx` | +7 lines | Tab integration |

### Test Files

| File | Tests | Lines |
|------|-------|-------|
| `console/api/test/blueprints.test.js` | 52 | 730 |
| `console/api/test/httpSafety.test.js` | 15 | 222 |
| `console/api/test/blueprints-http-routes.test.js` | 15 | 127 |
| `console/api/test/blueprints-security.test.js` | 15 | 171 |
| `console/api/test/owasp-security.test.js` | 27 | 288 |

### Documentation

| File | Purpose |
|------|---------|
| `docs/blueprints.md` | Architecture, API reference, schema, security analysis |
| `ISSUES.md` | Issue tracking (P34 crash, frontend UI) |
| `CHANGELOG.md` | Feature changelog |

---

## 9. Test Execution

```bash
cd console/api
npm ci
node --test test/*.test.js
```

```
# tests 439
# suites 0
# pass 439
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

TypeScript typecheck:
```bash
cd console/web
npx tsc -b      # no errors
```

Frontend build:
```bash
npx vite build  # ✓ built in 2s
```

---

## 10. Security Audit

| Property | Status |
|----------|--------|
| All DB queries parameterized | ✅ Verified by OWASP A03 test |
| CSRF tokens on mutations | ✅ Required on POST/DELETE |
| Upload size limit | ✅ 32 MB enforced |
| Input validation | ✅ All IDs checked (numeric, > 0) |
| Error message redaction | ✅ Stack traces never leak to client |
| Audit logging | ✅ Import + delete audited |
| Path traversal prevented | ✅ Export filenames sanitized |
| Password/secrets in code | ✅ None — all from env/config |
| session token entropy | ✅ `crypto.randomBytes` |
| Rate limiting | ✅ `applyMutationRateLimit` on mutations |

---

*Generated 2026-07-13 | Branch `feature/blueprints-ui` | Fork `yacketrj/dune-awakening-selfhost-docker`*
