# Discord Bot Output Architecture

**Status:** Historical record — describes the output pipeline of the companion bot in a separate repository as of 2026-08-10; its command counts and groups are not verifiable from this repository. Not maintained.

**Date:** 2026-08-10
**Companion repository:** [yacketrj/arrakis-control-panel](https://github.com/yacketrj/arrakis-control-panel)

## Overview

The Arrakis Control Panel Discord bot surfaces 54 slash commands across
9 groups. Output formatting was consolidated from 4 independent rendering
paths into a single unified pipeline with shared enrichment.

## Unified Output Pipeline

```
src/output/
├── pipeline.js       # Single call site: sendEmbed, sendCard, sendError, sendText, sendEphemeral
├── enricher.js       # Footer, timestamp, version applied to ALL outputs
└── (formatters in embedFormat.js)
```

Every command response flows through one of 5 pipeline methods:
- `sendEmbed()` — styled Discord embed (primary path, ~30 commands)
- `sendCard()` — PNG image card + optional embed (13 OPS + server status commands)
- `sendError()` — red-styled error embed (all errors)
- `sendText()` — plain text with enrichment footer (fallback)
- `sendEphemeral()` — ephemeral embed (auth/cooldown denials)

## Output Polish (12 fixes, 2026-08-10)

| Fix | Description |
|-----|-------------|
| Dead formatter cleanup | Removed 10 unused OPS embed formatters from import chain |
| fmtBool guard | `undefined`/`null` shows "— Unknown —", not "❌ No" |
| Dynamic colors | Population/Storage/Unlink/Ports use warning on empty, success on data |
| Readiness undefined | `r.ready === true` (not `!== false`) prevents false "READY" |
| Null placeholders | formatGenericEmbed shows "— None —" instead of silently dropping fields |
| "?" fix | Population missing counts show "— Unknown —" not "?" |
| Map names guard | Missing map names show "Unknown Map" not "undefined" |
| Steam-link embed | Uses styled embed + button instead of raw text |
| Auth/cooldown embeds | Ephemeral denials use styled embeds, distinct from permanent errors |
| Bold fmt() | String values render in **bold** for consistency with dedicated formatters |
| Dedicated formatters | 7 command groups got dedicated formatters replacing generic JSON flattening |

## Architecture Properties

- **Single edit site**: adding a footer/timestamp/version to all output requires editing `enricher.js` only
- **Domain-separated formatters**: each command group has its own `format*Embed()` function in `embedFormat.js`
- **Pipeline testability**: formatters are pure functions `(payload) → embed`, testable against JSON fixtures
- **Card + embed composition**: OPS commands can send both a PNG card and a styled embed simultaneously

## Related

- [Output polish issues #114–131](https://github.com/yacketrj/arrakis-control-panel/issues)
- [Unified pipeline issue #118](https://github.com/yacketrj/arrakis-control-panel/issues/118)
- [Core RW architecture PR #141](https://github.com/Red-Blink/dune-awakening-selfhost-docker/pull/141)
