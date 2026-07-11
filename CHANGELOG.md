# Changelog

All notable changes to the `yacketrj/dune-awakening-selfhost-docker` fork.

---

## [Unreleased]

### `feature/rbac-core` — Role-Based Access Control

#### Added
- **Tier-based capability resolution** — `resolveSessionCapabilities()` in `auth.js` assigns capabilities by auth source:
  - `local`: owner tier (full access)
  - `discord`: capability set from `discordActorTier` + `CAPABILITY_BY_TIER`
  - `unknown`: public tier (empty set)
- **Route pattern matching** — `matchRouteCapability()` in `server.js` converts `:param` patterns to regex; unregistered routes default to DENY
- **`CAPABILITY_BY_TIER` export** from `policy.js` — consumed by `auth.js` for session resolution
- **`ops:read` capability check** on Discord OPS routes in `routes.js`
- **RBAC database tables** in `duneDb.js`: role-capability mappings, audit log, Discord player links
- **Discord OAuth2** support — `auth.js` OAuth2 handler, `config.js` Discord OAuth config
- **`deathPoller.js` stub** — `{ enabled: false, init() {}, tick() {} }` for clean upstream compat
- **Architecture doc**: `docs/architecture/RBAC-DESIGN.md`

#### Security
- **CRITICAL**: Unregistered routes now DENY (was ALLOW on all mutations)
- **CRITICAL**: Session capabilities now tier-based (was granting all caps to unknown sources)
- **CRITICAL**: Route parameter matching uses regex (was literal string match only)
- Audit log for all RBAC mutations
- CSRF validation confirmed (false positive on audit)

---

### `feature/augment-upstream` — Pre-Augmented Gear

#### Added
- **Augmented item stats** — `FAugmentedItemStats` structure with `AppliedAugments`, `AppliedAugmentRollData`, `AppliedAugmentQualities`
- **Schema name stripping** — `_Schematic` suffix removed from augmented item names
- **Per-augment roll count** — `augmentRollCount()` with type defaults (melee=2, others=1)
- **Augment validation** — `isTemplateAugmentable()`, `isWeaponTemplate()`, `isArmorTemplate()`
- **AugmentPicker UI** — chip-based augment selector in Player Tab + CarePackage panel
- **Catalog filter** — schematic-only filter for augmented items
- **Weapon-type filtering** — melee/ranged/armor separation in augment picker
- **Weapon map fallback** — `weaponMap` lowercase sets for item lookup
- **DB trigger** — max roll recalculation on durability change
- **Scraper scripts** — `dev-tools/scrape-augments.js` + `scrape-placeables.js` in addon repo
- **Architecture doc**: `docs/architecture/PRE-AUGMENTED-GEAR.md`

#### Fixed
- Chapter 5 / Off / lowercase augment names now handled in filter
- Weapon-type filter correctly separates melee from ranged
- A-Z sorted augment list in picker

---

### `feature/ui-enhancements` — UI & Quality of Life

#### Added
- **Give Placeables** — category rail (Utilities, Fabricators, Refineries, Storage) with custom icons (normal + selected)
- **Resource requirements** — volume display, `resourceTemplateId()` mapping
- **Inventory validation** — slot count + volume capacity check before granting placeable resources
- **Give Level** — XP table for quick level grants
- **Grant All Research / Crafting / Skills** — confirmation dialogs
- **Building sub-categories** in catalog
- **Grant table auto-width** — adapts to content
- **Inventory display names** — human-readable labels
- **Catalog performance** — results caching
- **Addon-source-link** — neutral gold color, removed faction accent bleed
- **Faction tagger fixes** — removed `*` wildcard and `strong` CSS overrides
- **Architecture doc**: `docs/architecture/UI-ENHANCEMENTS.md`

#### Security
- `actionPlayerId` required (online) for placeable resource grants
- Inventory capacity validation prevents overflow exploits

---

### Infrastructure

- **Pre-push gates** (`~/.local/bin/pre-push-gates`): 5 security scans + 4 upstream CI mirror checks
- **E2E compose**: source mounts for live development (`duneDb.js`, `server.js`, `auth.js`, `config.js`, `deathPoller.js`, `blueprints.js`, `discord/`)
- **Docker image**: `redblink-dune-docker-console:dev`
- **Branch decoupling**: `feature/rbac` (118 commits) split into 3 clean single-concern branches

---

## Upstream Releases

### v1.3.48
- Bridge smoke test + integration test suite
- Economy/activity/resource/combat bridge actions
- Death poller gating behind `DUNE_DEATH_POLLER_ENABLED`
- Defensive column names in activity queries

### v1.3.47
- Blueprint import/export from Solido blueprint JSON
- Augment filter by item type (melee/ranged/armor)
- Augment picker in Care Package + Give Items
- Persistent UID/GID for web console runtime

### v1.3.44 – v1.3.46
- Earlier upstream releases pre-fork
