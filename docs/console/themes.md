# Console themes

The palette button beside the language button opens **Console Theme**.
The choice applies to this browser and is stored in its local storage
(`dune-console-theme`). Each operator and device can choose independently.
**Default** preserves the standard Console appearance without overrides.
If browser storage is blocked, the current page can still use a theme and
reopening the picker reflects the applied choice.

## Palettes

The Console includes 23 palettes defined in
`console/web/src/themes/consolePalettes.ts`: the 19 Console palettes (Amber
Dunes, Basalt, Copper, Deep Desert, Dust Storm, Emerald, Golden Dusk, Ice Blue,
Indigo, Jade, Moonstone, Nightfall, Oasis, Rosewood, Saffron, Sandstone, Slate,
Spice and Steel) and four Dune faction palettes (Atreides, Fremen, Harkonnen and
Sardaukar Imperial), plus the 42 swatch palettes below.

The picker lists them in four sections, each sorted by name: Console palettes
(with Default), Dune factions, Houses and Outfits and dyes. A filter box matches
the palette or section name and shows `N of 66 palettes`; the applied palette
always stays listed so the choice is never hidden. Escape clears the filter
first and closes the picker on the next press.

### House swatch palettes

One palette per in-game armour swatch (42: all 25 Houses plus Harkonnen and Atreides, and the
15 others such as Sunset Dye, Dusk Rider, Blue Dasher, CHOAM, Smuggler and Hot Zone) uses that
swatch's four armour-dye colours. The dyes are in
`console/web/src/themes/houseSwatches.ts`, taken from the community wiki data
module <https://awakening.wiki/Module:Swatches/data> (colour values only; the
wiki's text is CC BY-NC-SA 4.0). The engine derives the palette: the darkest dye,
darkened, becomes the page; a lift toward the second-darkest dye becomes the
panel; the most vivid light dyes become the accents. Text and accent contrast
are enforced exactly as for the other palettes, so a pale House (for example
Kenola) still gets a dark page.

All offered palettes use dark surfaces to match the existing Console controls.
The picker, browser persistence, cross-tab updates and keyboard controls work
for every palette. A saved selection that is no longer in the catalogue falls
back to Default, including selections from a previous preview.

## Readability and loading

`themeEngine.ts` derives the Console's existing CSS custom properties from
each palette's background, panel, accent and secondary colours. Shared text
and status colours keep the interface consistent, and contrast checks adjust
text against the page and panel surfaces. Hardcoded colours in existing
controls, map markers and some dialogs retain their standard appearance.

The catalogue and engine load lazily. The small `themeBoot.ts` entry module
does nothing for Default. For a saved selection it restores a validated cache
before rendering, then reconciles the selection against the current catalogue.
Only the engine's supported colour properties are accepted from the cache.
An unavailable picker chunk offers Refresh Now and Close through the existing
recovery panel.

## Keyboard

Arrow keys, Home and End move focus between cards in the order they appear on screen (section by section) without applying a theme.
Space or Enter selects the focused card. Escape closes the picker and returns
focus to its header button.

## Adding a palette

Add a `ConsolePalette` entry to `consolePalettes.ts` with a unique ID, a
`group` (the picker section: one of `PALETTE_GROUPS`), name, description,
background, panel, accent and secondary colour. Use hex
colours; the engine derives the remaining tokens. Keep the catalogue sorted
by display name. Theme tests check distinct choices, complete tokens,
readable contrast, persistence and resetting to Default.
