# Roadmap — Dune Awakening Selfhost Docker

## Planned

### Specialization UI Refactor & Feature Expansion

**Goal:** Move the existing Specializations UI out of Players → select player → Skills and into its own first-class tab next to Skills, while preserving all current behavior, improving safety, and adding regression tests.

**Repository facts:**
- Current frontend specialization logic lives inside `console/web/src/features/players/CharacterAdminUI.tsx`
- Current client API calls live inside `console/web/src/api/players.ts`
- Current backend route wiring lives inside `console/api/src/server.js`
- Current backend delegates specialization calls to duneDb functions: `playerSpecs`, `addSpecializationXp`, `grantMaxSpecialization`, `resetSpecialization`, `grantAllSpecializationKeystones`, `resetAllSpecializationKeystones`
- Current top tabs: Character, Crafting, Research, Skills, Journey, Blueprints, Admin
- Current specialization is rendered as a nested toggle box: `playerAdmin_toggleBox("skills_specializations", "Specializations", ...)`
- Current specialization features already implemented:
  - load specialization rows from `/api/players/:id/specs`
  - show trackType, xp, level
  - add specialization XP per track
  - grant max specialization per track
  - reset specialization per track
  - grant all keystones
  - reset all keystones

**Current issues to fix:**
- specialization is not its own tab
- offline-only writes are explained in text but not enforced in the UI
- Grant All Keystones lacks confirmation
- keystone state is not visible
- specialization state is tightly coupled to Skills tab lifecycle
- specialization lacks clear dedicated tests
- keep security in scope throughout

**Implementation requirements:**

1. **Frontend extraction**
   - Create a dedicated specialization module folder under `console/web/src/features/players/specialization/`
   - Add at least: `SpecializationTab.tsx`, `SpecializationTable.tsx`, `SpecializationSummary.tsx`, `SpecializationRowActions.tsx`, `useSpecializationState.ts`, `types.ts`, `normalizers.ts`
   - Keep code small, typed, and testable
   - Refactor `CharacterAdminUI.tsx` so it adds a new top-level tab labeled "Specialization" immediately next to "Skills"
   - Remove specialization rendering from the Skills tab after the new tab is wired and tested
   - Preserve current action logging and inline result patterns where reasonable

2. **UX and safety**
   - Add hard UI disablement for specialization write actions when the player is online
   - Show an inline explanatory banner when writes are disabled due to online state
   - Add `confirmAction` for: Grant All Keystones, Reset All Keystones, Grant Max per track, Reset per track
   - Convert the current shared global XP input into a row-local XP input per specialization row
   - Keep reload behavior explicit and user-driven, with automatic reload after successful writes

3. **Data model and API compatibility**
   - Keep existing `playersApi` methods compatible
   - If you extend `/api/players/:id/specs`, do so additively only
   - Preserve existing fields: `rows`, `skillModules`, `capabilities`, `reason`
   - Add a richer optional specialization summary object if needed
   - Do not break old callers

4. **Backend hardening**
   - Ensure backend validation remains authoritative
   - Do not rely on frontend confirmation strings as a security control
   - Preserve route-level permission protections already in place
   - Validate `trackType` and `amount` on the backend if not already strongly validated
   - Ensure online/offline business rule is enforced server-side as well as in the UI

5. **Testing**
   Add automated tests for:
   - frontend component rendering
   - row-local XP actions
   - disabled state when player is online
   - confirmation flow for dangerous actions
   - specialization load success / error states
   - API route contract tests for all specialization endpoints
   - backend validation tests for invalid `trackType` and invalid XP values
   - backward compatibility tests for old `/specs` response shape
   - regression test proving the new Specialization tab renders and the old nested Skills specialization UI is removed

6. **Security**
   At every relevant change, apply:
   - least privilege
   - explicit validation
   - safe defaults
   - clear operator confirmation for destructive actions
   - no silent dangerous fallbacks
   - no widening of API surface unless necessary

7. **Deliverables**
   - code changes
   - tests
   - brief migration notes in comments or a small markdown doc
   - no placeholders
   - no TODOs left behind

**Coding style:**
- TypeScript/React on the web side
- follow existing project conventions
- keep components composable
- keep helper functions pure where possible
- prefer explicit types over implicit any
- preserve current behavior unless intentionally improved

**Important:** Before editing, inspect current specialization logic in `CharacterAdminUI.tsx`, `players.ts`, and `server.js`. Then implement the extraction safely and incrementally.

---

## Completed

- Discord adapter player inventory routes + linking + storage queries (PR #91)
- Base page implementation (PR #89)
- Alpine Linux support in install script (PR #25)
