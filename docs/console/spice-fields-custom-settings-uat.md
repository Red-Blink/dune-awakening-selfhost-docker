# Spice Fields Settings — UAT

**Status:** Merged, pending QA | **For:** [PR #228](https://github.com/Red-Blink/dune-awakening-selfhost-docker/pull/228) (merged 2026-09-21, commit `461bd1e8`) — **updated for the per-map/per-partition scoping follow-up** (see this PR's own body)

**Location correction (2026-09-22):** this section originally lived under `Maps -> Interactive Modifiers -> Custom Settings`. Upstream's own commit `8eb6715c` ("Improve mobile bases and Spice Field settings", release v1.4.37) independently moved it into the `Maps -> Interactive Modifiers -> Spice Fields` tab, merged together with that tab's pre-existing read-only "Active Spice Fields" table. The steps below are updated for the current, real location — the **Target selector that scopes these settings still lives in the `Custom Settings` (or `UserGame`) tab**, not the `Spice Fields` tab itself; you'll switch tabs during this checklist.

This is a manual test plan for verifying the Spice Fields settings section against a real, live server. It isn't end-user documentation; a normal operator-facing document can be added separately if the maintainer wants one.

**Known caveat, not a merge blocker:** per-map write isolation for these
settings is confirmed (config-file level, and now UI-level via §9 below),
but full *behavioral* isolation per-field is not guaranteed for all 9
fields — one field (`spice_spawning_active`) is confirmed to not do what
its name implies regardless of scope (issue
[#998](https://github.com/Project-Arrakis/dune-awakening-selfhost-docker/issues/998)).
Don't treat a successful UAT pass on the *other* 8 fields as proof #998 is
also resolved — it isn't, and is tracked separately.

## Prerequisites

- A running Dune Docker Console with at least one Battlegroup/map server up.
- Admin access to the Console.
- Shell access to the host (to inspect `UserGame.ini` directly, to confirm
  what the UI claims actually landed in the file).

## Setup

1. Open the Console, go to **Maps -> Interactive Modifiers**.
2. Click the **Spice Fields** tab. The "Settings" section sits below the
   existing read-only "Active Spice Fields" table.

## 1. Section is visible and usable without selecting a Target

- [ ] With **no** Target selected (check the **Custom Settings** tab's
      "Target" dropdown — it's shared with this section, see below), confirm
      the Spice Fields tab's Settings section is still visible and its 9
      fields are populated with real values (not blank/loading forever).
- [ ] Confirm the section's explanatory paragraph states these settings
      apply to whichever Target is selected in the **Custom Settings** tab —
      server-wide (Global) with nothing selected, or to that specific
      map/partition once one is chosen.
- [ ] Confirm a small **"Editing: Global"** label, with a hint pointing to
      the Custom Settings tab, is visible directly in the section's own
      header — this is the persistent scope indicator, not just the
      paragraph text.
- [ ] Confirm the **Filter Spice Field Settings** search box is enabled
      (not greyed out) even with no Target selected, and typing into it
      filters this section's grid only (not the Active Spice Fields table
      above it, which has its own separate filter).

## 2. All 9 fields are present, correctly labeled, and correctly typed

Confirm each of the following renders as a **toggle** (not a text/number
input):

- [ ] Spice Spawning Active (default: on)
- [ ] Spice Player Must Witness Bloom (default: off)
- [ ] Spice Bloom Long Range Replication (default: on)
- [ ] Spice Field Long Range Replication (default: on)

Confirm each of the following renders as a **number input**:

- [ ] Spice Prime Rate Seconds (default: 30)
- [ ] Spice Manager Tick Rate Seconds (default: 5)
- [ ] Spice Manager Refresh Rate Seconds (default: 90)
- [ ] Spice Global Manager Refresh Rate Seconds (default: 120)
- [ ] Spice Node Value To Resource Ratio (default: 10)

- [ ] Hover/read each field's description. Confirm the Node Value To
      Resource Ratio field's description makes clear it's a **yield**
      multiplier, not a spawn-count or field-size control (this is the
      single most likely field to be misread — verify the copy actually
      prevents that misunderstanding for a first-time reader, not just that
      the words are technically present).

## 3. Save actually writes to `UserGame.ini`, at Global scope

1. On the **Spice Fields** tab, change **Spice Manager Tick Rate Seconds**
   from its current value to a distinct test value (e.g. `7`).
2. Click **Save** (in this section's own action row, below the settings
   grid — not the Active Spice Fields table's Refresh button above it).
3. Confirm a save-in-progress/success indicator appears (matching this
   Console's existing save UX for other settings tabs).
4. On the host, inspect the Global `UserGame.ini` file (or use the existing
   **UserGame** tab's own **Advanced** raw-editor view) and confirm
   `m_ManagerTickRateInSeconds=7.000000` appears under the
   `[/Script/DuneSandbox.SpiceHarvestingSystem]` section.
5. Reload the Console page (or navigate away from Spice Fields and back).
   Confirm the field still shows `7` (proves the value round-trips through
   a real reload, not just optimistic UI state).
6. Restore the value to its default (`5`) via step 6 below before
   continuing, so later checks start from a known state.

## 4. Discard Changes reverts to the last-loaded value (not the schema default)

1. Change **Spice Prime Rate Seconds** to a new value (e.g. `45`) but do
   **not** save.
2. Click **Discard Changes**.
3. Confirm the field reverts to whatever it was *before* your edit in this
   session (the last-loaded/saved value) — not necessarily the schema
   default of `30`, if the live server's actual current value differs from
   default.

## 5. Restore Defaults sets every field to its schema default (draft only, until Saved)

1. Change 2–3 fields to non-default values (don't save).
2. Click **Restore Defaults**.
3. Confirm all 9 fields now show their schema defaults (see the table in
   section 2 above) — including fields you didn't touch, if they weren't
   already at default.
4. Confirm nothing is written to disk yet (check `UserGame.ini` — should
   still show the pre-existing values) until you click **Save**.
5. Click **Discard Changes** afterward instead of Save, to avoid actually
   resetting your live server's spice settings to default as a side effect
   of this test.

## 6. Switching Target in Custom Settings correctly updates the Spice Fields tab

(This is the real, current interaction between the two tabs — they used to
be two action rows on the same tab; as of upstream's own relocation
they're now on separate tabs sharing the same underlying Target state.)

1. On the **Custom Settings** tab, select a real Target (map or partition).
2. Switch to the **Spice Fields** tab. Confirm its scope label ("Editing:
   ...") now shows that Target, and the settings grid shows that Target's
   own values (see §9 for the fuller per-map/per-partition checks).
3. Make a pending (unsaved) change on the Spice Fields tab, then switch
   back to Custom Settings and make a separate pending change there too.
4. Switch back to Spice Fields and click **Save**. Confirm only the Spice
   Fields change was saved — switch to Custom Settings and confirm its own
   pending change is still sitting there, untouched.

## 7. Interaction with the existing Target/range-validation feature is unaffected

(This isn't new behavior from this PR — it's an existing Custom Settings
feature; verifying it still works correctly alongside the relocated
section.)

1. On the **Custom Settings** tab, with a Target selected, enter an
   out-of-range value into an existing field that has documented min/max
   bounds (e.g. `Gathering Amount`).
2. Confirm the existing "Enter a supported value within the displayed
   range before saving" message still appears, and **Save Custom
   Settings** is disabled — confirming this validation is scoped to
   Custom Settings' own fields and doesn't affect the separate Spice
   Fields tab.

## 8. Restart/apply behavior matches every other Global `UserGame.ini` save

- [ ] Confirm saving triggers the same restart-confirmation flow (immediate
      / deferred / cancel) as saving the existing **UserGame** tab's own
      Global-scope fields — this PR reuses that exact mechanism and should
      not behave differently.

## 9. Per-map/per-partition scoping (new, #996/PR #1014)

Automated tests already cover this at the component level (`MapsPanel.settingsAvailability.test.tsx`); this section is the live, real-server confirmation those tests can't provide on their own. Note the Target selector lives on the **Custom Settings** tab; the settings it scopes render on the **Spice Fields** tab — you'll switch between them throughout this section.

1. On **Custom Settings**, select a Deep Desert partition in the **Target** dropdown. Switch to **Spice Fields**.
   - [ ] Confirm the scope label updates to that partition (e.g. "Editing: DeepDesert_1 - ... (8)").
   - [ ] Confirm the field values shown are that partition's own saved values, not Global's (change one value at Global scope first, then confirm the partition shows a *different* value if one was previously set there, or the schema default if not).
2. Change a value and click **Save**.
   - [ ] On the host, inspect that partition's own compiled `UserGame.ini` (e.g. `runtime/game/deepdesert-1-<id>/Saved/UserSettings/UserGame.ini`) and confirm the new value landed there under `[/Script/DuneSandbox.SpiceHarvestingSystem]`.
   - [ ] Confirm the **Global** `UserGame.ini` (or Survival_1's) was **not** touched by this save.
3. On **Custom Settings**, select **Overmap** in the Target dropdown. Switch to **Spice Fields**.
   - [ ] Confirm the section shows a distinct, worded notice ("Overmap doesn't host spice fields...") instead of the field grid — visually different from the ordinary "select a Target" empty state elsewhere on the page, not just different text.
   - [ ] Confirm **Save**, **Discard Changes**, and **Restore Defaults** are all disabled while Overmap is selected.
4. On **Custom Settings**, deselect the Target (choose "Select Map Or Partition" again). Switch to **Spice Fields**.
   - [ ] Confirm the section reverts to showing **Global**'s values and the scope label reads "Editing: Global" again.
5. Repeat step 1-2 for a Hagga Basin (Survival_1) Sietch partition, confirming the same isolation.

## Sign-off

| Section | Result | Notes |
|---|---|---|
| 1. Visible without Target | ☐ Pass ☐ Fail | |
| 2. All 9 fields, correct types | ☐ Pass ☐ Fail | |
| 3. Save writes to UserGame.ini | ☐ Pass ☐ Fail | |
| 4. Discard reverts correctly | ☐ Pass ☐ Fail | |
| 5. Restore Defaults (draft only) | ☐ Pass ☐ Fail | |
| 6. Cross-tab Target/pending-edit independence | ☐ Pass ☐ Fail | |
| 7. Range validation unaffected | ☐ Pass ☐ Fail | |
| 8. Restart flow matches UserGame tab | ☐ Pass ☐ Fail | |
| 9. Per-map/per-partition scoping | ☐ Pass ☐ Fail | |

**Tested against:** commit ___________ | **Server:** ___________ | **Date:** ___________
