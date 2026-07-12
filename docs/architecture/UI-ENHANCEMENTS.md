# UI Enhancements Documentation

**Branch:** `feature/ui-enhancements`
**Status:** Complete, tested, ready for upstream PR

---

## Overview

Comprehensive UI enhancements across the Dune Docker Console web interface. All changes are client-side (React/TypeScript/CSS) with minimal server-side support.

---

## Features

### 1. Give Placeables (Player Tab → Character)

Grant building construction resources to players instead of trying to give buildings directly (which the game doesn't support as inventory items).

**Location:** `CharacterAdminUI.tsx`

**Features:**
- Category rail: Utilities, Fabricators, Refineries, Storage
- Grid of building items with custom category icons
- Resource requirements table with per-item volume
- Total volume and slot count display
- **Inventory capacity validation** — checks both slot count and volume before granting
- Player must be online (uses console command path)
- Resource template ID mapping from game catalog

**Resource Data:** `console/web/src/data/placeableResources.ts`
- 34 buildings mapped with accurate resource requirements
- Volume data per resource type
- Template ID mapping for game compatibility

### 2. Give Level (Quick Rewards)

Grant XP to reach a specific player level using the official XP table.

**Location:** `CharacterAdminUI.tsx`

**Features:**
- Input target level (1-200)
- Calculates cumulative XP from wiki table
- Uses existing `addXp` API

### 3. Grant All Research / Crafting / Skills

Bulk unlock buttons for player progression.

**Locations:** `CharacterAdminUI.tsx`

**Features:**
- **Research:** Grant All Research + per-category grants
- **Crafting:** Grant All Crafting + per-category grants
- **Skills:** Grant All Skills + per-school grants
- Confirmation dialogs
- Online/offline validation
- Failure count reporting

### 4. Building Sub-Categories (Item Catalog)

Split the generic "buildings" category into functional sub-categories.

**Location:** `ItemCatalog.tsx`

**Categories:** Fabricators, Refineries, Utilities, Storage, Structures

**Features:**
- Keyword-based sub-category detection
- Applied to catalog filter dropdown
- Maintains backward compatibility

### 5. Grant Table Auto-Width

Item name columns auto-size to fit longest name without truncation.

**Location:** `styles.css`

**Features:**
- `table-layout: auto` instead of fixed
- `min-width` instead of percentage widths
- Horizontal scroll when needed

### 6. Inventory Display Names

Show human-readable names instead of raw template IDs in inventory tables.

**Locations:** `PlayerDetailTab.tsx`, `ItemCatalog.tsx`

**Features:**
- `renderCell` converts `template_id` to friendly name
- CamelCase splitting: `GreatHouseComponet2` → `Great House Componet 2`

### 7. Faction Tagger

Auto-color table cells containing faction keywords (Atreides/Harkonnen).

**Location:** `factionTagger.js`, `styles.css`

**Features:**
- Tags `td`/`th` in guilds/players tables
- Atreides → green, Harkonnen → red
- Scoped to prevent bleed into catalogs/pickers
- MutationObserver for dynamic content

### 8. Catalog Performance

Server-side item catalog caching for faster load times.

**Location:** `adminCatalog.js`

**Features:**
- Memory cache for parsed admin-items.json (287KB)
- Image path cache (avoids per-item filesystem checks)
- Client-side `useMemo` for filtered lists

### 9. Blueprints Panel

New tab for managing building blueprints.

**Location:** `BlueprintsPanel.tsx`

---

## Server-Side Changes

| File | Change |
|------|--------|
| `adminCatalog.js` | Catalog memory cache, image path cache |

All other changes are client-side only.

---

## Testing

- **Unit tests:** 0 failures, 5 pre-existing skips
- **Security:** ggshield/gitleaks/semgrep pass, trivy has pre-existing findings
- **Web build:** Succeeds cleanly
- **Manual e2e:** All features tested on running container

---

## Icons

Category icons sourced from Dune: Awakening community assets:
- `dune_awakening_category_icons.zip` — normal state icons
- `dune_awakening_selected_icons.zip` — selected state icons
- All icons in `console/web/public/assets/dune/`

---

## Future Work

1. **Specializations Tab** — Player tab after Skills, with Grant All/Category (Combat, Crafting, Exploration, Gathering, Sabotage) — roadmap item
2. **Placeable Resource Scraper** — Automated scraper for building resource data from gaming.tools (script exists in addon repo `dev-tools/`)
3. **Player-specific volume data** — Currently estimates volume; could query actual inventory API
