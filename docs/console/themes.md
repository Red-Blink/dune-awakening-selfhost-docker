# Console themes

Status: Current (verified 2026-11-12 against upstream v1.4.64 with this change applied).

The palette button in the console header (next to the language button) opens **Console Theme**.
The choice applies to the browser you made it in and is stored in that browser's local storage
(`dune-console-theme`). Nothing is stored on the server, so each operator and each device picks
independently. **Default** is the standard console look and sets no overrides at all; clearing the
choice, or choosing Default, restores it exactly. If browser storage is blocked, the current
page can still use a theme and reopening the picker reflects the applied choice.

## What is offered

- 16 dark palettes from [Fedaykin Dune Themes](https://github.com/btriapitsyn/zed-fedaykin-themes) (MIT). The 18 vendored palette files and `palettes/LICENSE` were checked byte-identical to upstream commit `f0be575142b784d4b8728ab036ae1cfdf9279cab` on 2026-11-12 (only the file extension differs: `.json` became `.jsonc` so the release gate's strict JSON check ignores them).
- Three looks from [Tabr](https://github.com/Project-Arrakis/tabr-tau) (MIT): Tabr Fremen, Tabr Awakening, Tabr Sietch.

Light palettes (Fedaykin Mentat and Fremen Sietch, the Tabr "Dayside" variants) are vendored and the
engine supports them, but they are **not offered**: the stylesheet still has many hardcoded dark
surfaces, so a light theme shows pale text on dark cards. They return once those surfaces use tokens.

## How it works

`console/web/src/themes/themeEngine.ts` maps each source palette onto the console's existing CSS custom
properties (`--bg`, `--panel`, `--text`, `--accent`, ...) by setting them on `<html>` at runtime, before the
first render so there is no flash. Text colours are pulled toward white or black until they reach WCAG AA
(4.5:1, 7:1 for body text) on the page and panel surfaces, so a palette whose own text colours are too dim
for the console is corrected rather than shipped unreadable. Colours that are hardcoded in the stylesheet
(for example the Discord and Support buttons, map and status colours, and some dialog surfaces) are not themed, so even a dark theme shows a few stock-coloured surfaces. Tokenising them is a follow-up.

## Loading

The palettes (about 60 KB of source) are not in the console's entry chunk. `themes/themeBoot.ts` is the only theme code loaded at start: with the default look it does nothing, and with a saved theme it re-applies that theme's tokens from a small cache in `localStorage` (`dune-console-theme-cache`, written by the engine) so there is no flash, then loads the engine to check the choice against the real catalogue (a changed palette refreshes the cache; an id that no longer exists falls back to Default). The cache is only trusted if every entry is a custom property set to a hex colour or the one `rgba()` glow the engine emits; anything else is ignored. The picker itself (`ThemeLauncher.tsx`) is a lazy chunk; if that chunk cannot be fetched after a console update, the recovery panel offers Refresh Now and Close.

## Keyboard

Arrow keys, Home and End move focus between the cards without changing anything; Space or Enter chooses the focused card. Escape closes the picker.

## Adding a palette

Drop a Fedaykin-format `dune-<name>.jsonc` into `console/web/src/themes/palettes/` (slots `color_01`..`color_46`,
see the template in the Fedaykin repo) and it appears in the picker. `npm test` in `console/web` checks that every
palette yields a complete token set and meets the contrast floor. Keep each source's licence next to its files
(`palettes/LICENSE`, `tabr/LICENSE`).
