# Console themes

The palette button beside the language button opens **Console Theme**.
The choice applies to this browser and is stored in its local storage
(`dune-console-theme`). Each operator and device can choose independently.
**Default** preserves the standard Console appearance without overrides.
If browser storage is blocked, the current page can still use a theme and
reopening the picker reflects the applied choice.

## Palettes

The Console includes 19 original Dune Docker palettes: Amber Dunes, Basalt,
Copper, Deep Desert, Dust Storm, Emerald, Golden Dusk, Ice Blue, Indigo,
Jade, Moonstone, Nightfall, Oasis, Rosewood, Saffron, Sandstone, Slate,
Spice and Steel. Their colour combinations are maintained in
`console/web/src/themes/consolePalettes.ts`.

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

Arrow keys, Home and End move focus between cards without applying a theme.
Space or Enter selects the focused card. Escape closes the picker and returns
focus to its header button.

## Adding a palette

Add a `ConsolePalette` entry to `consolePalettes.ts` with a unique `dd-` ID,
name, description, background, panel, accent and secondary colour. Use hex
colours; the engine derives the remaining tokens. Keep the catalogue sorted
by display name. Theme tests check distinct choices, complete tokens,
readable contrast, persistence and resetting to Default.
