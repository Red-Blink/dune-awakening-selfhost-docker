# Live Map

**Status:** Current | **Last Updated:** August 2026

The Live Map panel renders Hagga Basin and The Deep Desert as pannable,
zoomable square maps with real-time markers read directly from Postgres --
players, vehicles, bases, storage, spice, resources, and points of interest.
Nothing on this page polls the game server itself except the Coriolis seed
(a `docker logs` tail) and player teleport (a live in-game move); everything
else is a straight database read. Live actors and active fields refresh every
5 seconds; the much larger static POI/resource atlas refreshes once per minute
and is retained between live polls.

See [API-REFERENCE.md](API-REFERENCE.md#live-map) for the endpoint contract.

## Map and partition selection

The two **Choose Map** buttons switch between Hagga Basin and The Deep
Desert. Each map's config (world bounds, image, default partition) lives in
`LIVE_MAP_CONFIGS` in `duneDb.js`.

The **Partition** dropdown lists every partition for the active map that has
a `server_id` (i.e. an actual assigned shard, not a story/dungeon instance
with no server). Its display name resolves in two layers:

1. Preferred: the effective, merged `Bgd.ServerDisplayName` for that
   partition -- the same name a player sees in-game -- fetched from the
   existing `/api/maps/combat-state` endpoint (`console/api/src/services/
   mapCombatState.js`), which already resolves this precedence
   (partition -> map -> global `UserEngine.ini`) for the Maps panel.
2. Fallback: `dune.world_partition.label` (the short name set via
   `sietches set-display`), then the raw map name, then `Partition <id>`.

This is why a shard renamed in-game to "Sietch Alraab PVP" can show a
shorter "Alraab" in the dropdown until the combat-state lookup resolves --
the fallback is not stale data, it is a different, always-available name
for the same partition. A resolve failure (no `dune` runner reachable, as
in a database-only sandbox) is swallowed silently and the dropdown just
uses the fallback name; it never blocks the page.

## Marker categories

### Actors (`dune.actors`-backed)

**Player**, **Vehicle**, **Base**, and **Storage** come from `dune.actors`
joined against `player_state` / `vehicles` / `buildings` / `placeables`.

- **Vehicle** subtype is derived from the raw Unreal blueprint class path
  (`dune.actors.class`, e.g. `.../BP_Sandbike_CHOAM.BP_Sandbike_CHOAM_C`) by
  `vehicleSubtypeFromClass()` in `duneDb.js` -- an ordered regex pattern
  list (`VEHICLE_CLASS_SUBTYPE_PATTERNS`), falling back to `"Other"`. Order
  matters: the Assault-Ornithopter pattern must run before the generic
  Ornithopter one or it gets swallowed by it.
- **Vehicle** owner resolves the same way a base's does: a vehicle is its
  own `dune.permission_actor` (no indirection through another table the way
  a base goes through `buildings`/`building_instances`), so the overlay's
  Owner row is a `left join lateral` on `permission_actor_rank` at
  `rank = 1` (owner). An unclaimed vehicle has no such row and shows
  "No Owner", exactly like an unclaimed base.
- **Base** markers link to the Bases panel (`Open in Bases` in the marker
  overlay); **Vehicle** markers link to the Vehicles panel the same way
  (`Open in Vehicles`) -- both search by the exact numeric id and
  auto-expand that one row.

### Spice & resources

**Static Spice Spawns**, **Active Spice Blows**, and **Flour Sand** are
three independent layers built by `liveMapSpice()`
(`console/api/src/services/liveMapSpice.js`):

- *Static Spice Spawns* is the full known pool for the **current Coriolis
  seed** (see below): the committed `console/api/data/
  large-spice-locations.json` archive (Large tier, Deep-Desert-only, built
  from ground truth) merged with a runtime-generated
  `learned-spice-locations.json` that the console grows itself by recording
  every field it has ever seen active. On a `field_id` collision the
  committed archive wins -- it is the higher-confidence source.
- *Active Spice Blows* reads `dune.resourcefield_state` live
  (`field_kind_id = 1`), sized by `value_remaining`
  (`> 150000` Large, `> 5000` Medium, else Small), and positioned by
  decoding `field_id`'s bit-packing directly when no archive entry exists
  for it (see below). Every active field observed here feeds the learned
  pool, tagged `confidence: "decoded"` so a decode-only entry is never
  presented as more certain than it is.
- *Flour Sand* (`field_kind_id = 0`) is always decode-only -- there is no
  historical pool for it on either map.

`field_id` bit-packs `(x, y, z)` as three 21-bit two's-complement fields
(`spiceFieldDecode.js`), verified against 350 ground-truth points at 84%
exact. Every miss is a coordinate whose magnitude exceeds 1,048,575 (the
21-bit signed limit) -- Deep Desert's real bounds reach roughly 1.27M, so
the far edge of the map silently wraps and there is no way to detect a
wrapped result from `field_id` alone. This is why the committed archive's
ground-truth position always wins over the decode when both are available.

**Ores & Metals**, **Scrap & Wrecks**, and **Plants & Fibers** come from
`dune.markers` through the same POI registry described next.

### World (registry-driven POI framework)

**POI's**, **House Representative**, **Trainer**, **Fortress**, **Hazard
Zones**, and **Enemy Camp/Outpost** are all `dune.markers` rows classified
by `ILIKE` pattern against `marker_type`, driven by one registry:

- `POI_CATEGORIES` in `console/api/src/services/liveMapPoi.js` -- the list
  of categories, their legend label, and which section header they group
  under.
- `POI_CATEGORY_PATTERNS` in `console/api/src/duneDb.js` -- the `ILIKE`
  patterns for each category key.

Adding a new category once it has a real data source is exactly two edits
(one entry in each list above) -- no new query function, no new
orchestration code. Pattern order matters where categories could overlap:
`ore` matches on **suffix only** (`%Ore`, `%Pickup`, `%Rock`), not a bare
substring, because a substring match on `%ore%` false-positived on
`HarkoRecustomization` (contains "ore" mid-word) in production data.

Fortress/House Representative/Trainer were originally sub-grouped inside
`poi` and were promoted to their own top-level categories so each gets its
own legend row instead of only being reachable by expanding POI's first.

## The Layers legend

- **Expandable categories** (`EXPANDABLE_KEYS` in `LiveMapPanel.tsx`) show
  the real sub-types actually present in the loaded data -- never a
  curated list -- so a new game-added resource or marker type appears with
  zero code changes.
- **Empty rows are hidden**, at every tier (category, sub-group, subtype).
  The existence check uses a *raw*, filter-independent count computed from
  the partition-scoped data before the user's own checkbox state is
  applied -- unchecking a category's own box can never make its row
  disappear, only a genuinely empty category's row does.
- **Section headers** ("Spice & Resources", "World") carry a toggle-all
  checkbox that cascades to every member category and its sub-types.
- The gear icon opens a **Default Layer Settings** popover: per-category
  and per-sub-type checkboxes, independent of the live legend's own
  checkboxes. **Save as Default** persists the popover's state to this
  browser's `localStorage` under `duneLiveMapDefaultLayers` (category
  on/off) and `duneLiveMapDefaultSubtypeLayers` (nested per-category
  sub-type on/off) -- read by `console/web/src/features/liveMap/
  liveMapLayerDefaults.ts`. A newly-discovered sub-type with no saved
  default of its own inherits its **category's** own default rather than
  always defaulting to visible, so a category whose default is off never
  shows a mismatched "checked" top-level box for sub-types no one has
  toggled yet.

## Coriolis seed and countdown

The active spice-blow schedule is tied to Deep Desert's Coriolis storm
cycle. The current seed and next-cycle time are resolved from the selected
partition's own server container logs (`console/api/src/services/
coriolisSeed.js`): a bounded `docker logs --tail 10000` with a 5-second
timeout and a short server-side cache, since every server container prints
the identical farm-wide seed and cycle boundary once at startup. Candidate
container names are built from the map/partition
(`dune-server-survival-1[-<id>]` for Hagga Basin,
`dune-server-deepdesert-1-<id>` for Deep Desert, both falling back to a
farm-wide `overmap`/`survival-1` default) and re-validated against the same
allowlist regex the rest of the console's Docker-log access uses.

### Why a stale seed suppresses the static pool

The seed line is only printed **at container startup**, but the Deep Desert
world re-rolls at every weekly Coriolis boundary whether or not anything
restarts. Between a boundary and the next restart the logs therefore still
advertise the *previous* cycle's seed, and taking that at face value put the
previous cycle's spice pool on the map -- observed on a live server, where
fields first seen the day after a boundary were filed under the old seed and
39% of them later reappeared under the new one (against a 2% baseline overlap
between genuinely different seeds).

The same log block also prints when the cycle ends, so a boundary that is
already in the past is proof the logged seed is stale. `resolveCoriolisCycle()`
treats that seed as **unknown** rather than trusting it: it returns a null seed
plus a `staleSince` timestamp, which makes every archive and learned-pool
lookup short-circuit and suppresses the write-back. *Static Spice Spawns*
therefore disappears until the map server restarts and prints the new seed,
while *Active Spice Blows* and *Flour Sand* keep working -- they read Postgres
and never depend on the seed. The Overview strip shows `Coriolis Seed:
Awaiting restart` during that window so the empty layer does not read as a bug.

A log block that carries a seed but no boundary line is passed through
unchanged; there is nothing to check it against.

**Anything keyed into a static file must carry the seed it belongs to.** Both
spice files are keyed `seeds["cor-<n>"]`, and neither is read or written when
the seed is unknown.

This includes Hagga Basin, whose resources also move at a Coriolis -- so its
learned entries are keyed by the Deep Desert seed and relearned each cycle by
design. Measured across one boundary on a live server, Deep Desert re-rolled
95% of its positions while Hagga Basin's mostly recurred (only 8% new), which
makes the relearn look redundant for Hagga Basin -- it is not. Some Hagga Basin
positions genuinely are new each cycle, and there is no way to tell a recurring
one from a moved one after the fact, so the keying stays conservative.

### Which cartography layout is live

The Deep Desert is not one fixed landscape: the game ships **12 cartography
layouts** and each Coriolis cycle selects one, so after a reset the terrain
genuinely changes. Only a Deep Desert map server states which one it picked,
once at startup:

```
LogWorldLayout: Display: BP_DuneGameState_C_...: 'DA_DeepDesert_1_Layout_03'
                layout selected with 678 content blocks.
```

`/api/map/markers` reports that number as `coriolisLayout` (`0`-`11`), or
`null` when it cannot be read. It is parsed from the log line rather than
derived from the seed: the two have matched every time they have been observed
together, but this is the game stating its own choice, so it needs no mapping
assumption and stays correct if they ever diverge.

Two details worth knowing when reading `coriolisSeed.js`:

- `overmap` and `survival-1` print the seed and the cycle boundary but **never**
  the layout, so the resolver keeps walking past a container that answered with
  only a seed -- and stops early rather than asking those two for a layout they
  cannot log.
- When no partition is supplied there is no single container to ask, and a bare
  `dune-server-deepdesert-1` is not guaranteed to exist (a real deploy runs only
  suffixed ones such as `-8` and `-59`). The markers route therefore passes the
  known Deep Desert partition ids in, and the resolver fans out over a capped
  few of them. The Live Map itself always has a partition selected -- there is
  no "All Partitions" entry -- but other API callers need not supply one.

`coriolisLayout` is `null` whenever the layout cannot be determined -- the
container is down, the line has aged out of the tail, or the game reports a
layout this console has no terrain for. Consumers must treat `null` as
"fall back", never as an error.

**It is also null once the cycle boundary has passed**, for exactly the reason
the seed is (above): the layout line is printed only at container startup, so
between a boundary and the next restart the logs still name the *previous*
cycle's layout. Drawing that would put the previous rotation's terrain on the
map -- silently, since nothing about a stale layout looks broken. The same
expiry check that suppresses the stale seed nulls the layout, so the Live Map
falls back to the flat image until the map server restarts.

## Rendered terrain (Deep Desert)

The Deep Desert map is not a picture. Instead of the flat
`images/maps/deep-desert.png`, the console draws the game's own cartography
meshes for whichever layout the current cycle selected -- the same proxy geometry
the in-game map table renders, extracted from the game's `.pak` files offline.

The Deep Desert ships **no terrain texture at all**; its in-game map is a mesh
diorama, which is why upscaling an image was never an option.

### How it fits together

`console/web/src/features/liveMap/terrain/` holds a framework-free WebGL2
renderer (`renderer.ts`) behind a thin React wrapper
(`DeepDesertTerrain.tsx`), lazy-loaded so a Hagga Basin user never downloads it.

**The panel keeps ownership of everything interactive.** Pan, zoom, markers and
teleport are all DOM and unchanged; the renderer replaces only the `<img>`. It
has no camera of its own -- it is handed the world rect currently scrolled into
view (`visibleWorldRect` in `liveMapGeometry.ts`) and draws exactly that. Terrain
and markers therefore land on the same pixel by construction, using one shared
mapping rather than two that must be kept in step.

Rendering the terrain is what exposed a long-standing inaccuracy in
`LIVE_MAP_CONFIGS`. Its Deep Desert rect was ~8% wider than the square the PNG
covers, so the picture was stretched across a rect it does not fill and every
marker was drawn short of where the image put it -- exact at the centre, 84,163
uu adrift at the edges, a third of a sector cell. Terrain sidestepped it by
placing geometry at true world positions, which made the two visibly disagree.
The rect is now the sector square itself, so image, terrain, markers and grid
share one frame of reference.

The world does not stop at that edge, though, so `worldToLiveMapPoint` allows a
16 px tolerance before calling a marker out of bounds. Measured on a live farm, a
player and the ornithopter they were flying sat 4,216 uu past the north edge; a
hard cut would drop exactly the marker an admin is most likely to be hunting for.
Such markers are drawn at their true position, never clamped.

The canvas covers the frame's **viewport**, not the scaled map, and is translated
to follow the scrollport on each scroll. At maximum zoom the map is 16384 px
across -- beyond `MAX_TEXTURE_SIZE` on many GPUs, and roughly a gigabyte of
backing store.

That translation is clamped to the map's own extent, and the clamp is
load-bearing rather than defensive: a transform on the canvas counts toward the
frame's scrollable width, so translating by an out-of-range `scrollLeft` pushes
the canvas past the map's edge, inflates the scroll area, and thereby makes that
out-of-range offset legal. The result was a self-sustaining state in which
zooming back out left the map stuck off-centre instead of returning to the fit.

### Assets

`terrain/assets/` is 41 gzipped files totalling 15.7 MB, inflated in the browser:
a 6.4 MB shared half -- the 4.6 MB mesh library plus 1.8 MB of detail textures --
and twelve per-layout sets of about 0.78 MB each. The split is the point: a
Coriolis reset changes only the layout, so the browser re-fetches under a
megabyte and the shared half stays cached.

Vite fingerprints them into `dist/assets/`, which earns the immutable
cache-control rule in `staticFiles.js` and, being content-addressed, cannot go
stale. Two build settings are load-bearing and easy to lose: `assetsInclude`
keeps `.gz` opaque so it is hashed and copied rather than parsed, and
`build.assetsInlineLimit` stops the ~1.6 KB layout sidecars being inlined as
base64 into the main bundle by the 4 KB default.

The offline pipeline that produced these is developer-only and not in the repo --
it needs the game's paks and a local Oodle DLL, so it can never run in CI.

### When it falls back

The rendered terrain is an upgrade over the flat image, never a replacement for
it. `deep-desert.png` stays committed and stays in `LIVE_MAP_CONFIGS.image`, and
every case below simply shows it, with no error state and no loss of function --
markers, teleport, pan and zoom are unaffected either way.

| condition | |
|---|---|
| not the Deep Desert | Hagga Basin always uses its image |
| `coriolisLayout` is null | the layout could not be read, **or the cycle boundary has passed** and the logged layout belongs to the previous rotation |
| layout outside 0-11 | the game reported one this console has no assets for |
| no WebGL2 | browser or GPU does not provide it |
| no `EXT_texture_compression_bptc` | the sand normals are BC7; common on desktop, absent on many mobile GPUs |
| no `DecompressionStream` | Safari before 16.4 |
| an asset fails to load | fetch or inflate error |
| the context is lost | GPU reset, driver update, or the browser reclaiming it after a successful start |

Which one applied is shown as **Terrain** beside the Coriolis readout, so a flat
map is always explainable rather than mysterious. Silent degradation is what made
the stale-layout problem invisible in the first place.

`EXT_color_buffer_float` is **not** in that list: without it the renderer keeps
drawing with a slightly flatter blend rather than refusing.

### Sector grid

A **Sector Grid** toolbar button overlays the Deep Desert's 9x9 lettered grid --
250,000 uu cells spanning +/-1,125,000 uu about the map centre. Deep Desert only,
and only while the terrain is being rendered; Hagga Basin has no lettered sector
system, and the flat image supplies its own grid.

Orientation is the easy thing to get wrong, so it is pinned by tests: **I is at
the top and A at the bottom**, confirmed against the game's own map art, which
carries the labels burned in. World +Y draws downward in the panel, so the letter
runs *opposite* to screen-down and the obvious guess is upside down.

The overlay is drawn in map-pixel space from the same `worldToLiveMapPoint` the
markers use, so a marker at a cell's centre lands on that cell's label (measured:
within 0.5 px).

Lines and labels are both a constant size on screen: the strokes use
`vector-effect: non-scaling-stroke`, and the label font size is divided back out
by zoom (sized in viewBox units alone, a label would render ~368 px tall at
maximum zoom).

**Labels follow the viewport.** A 250,000 uu cell is wider than the frame above
roughly 2x zoom, so a label pinned to the cell's true centre scrolls out of view
and the grid stops answering the one question it exists for. Each label is
instead placed at the centre of the *visible part* of its own cell, and hidden
when too little of the cell is on screen to label. Measured across a pan at high
zoom: a label is visible at every position, where fixed centres left 6 of 8
positions unlabelled.

**It is on by default.** The rendered terrain has no grid of its own and
relating a marker to a sector is the common case. It is drawn over the flat image
too: that picture carries its own grid, but the two now describe the same world
square and coincide, and the overlay's labels stay crisp and constant-sized at
any zoom where the burned-in ones do not. Before the bounds were corrected the
two sat about a third of a cell apart, which read as a rendering fault.

## Player teleport

Dragging an **online** player marker previews a new position; releasing
commits it through the same live in-game teleport path used elsewhere in
the console. Offline players cannot be drag-teleported from the map.

Every marker overlay also carries a **Teleport** button, for sending a
player *to* that marker instead of dragging a player marker *to* a new
spot. Clicking it lists the online players sharing the marker's own map
and partition (a static-pool marker with no partition, such as a spice
field or POI, matches any online player on that map); picking one and
confirming teleports them to the marker's coordinates through the same
`teleport-player` path as the drag gesture. If no online player matches,
the button reports "Error: No online players." instead of opening the
picker.

**Double-clicking empty map** picks that point and opens the same overlay on it,
headed *Picked Location*: the world X and Y, the partition, the sector on the
Deep Desert, and the same Teleport button. It presents itself to the teleport
code as a marker (`type: "picked_location"`, the one marker type the API never
sends) so that path is shared rather than duplicated. Closing the overlay, or
pressing Escape, clears the pick.

## Related

- [API-REFERENCE.md](API-REFERENCE.md#live-map) -- full HTTP API reference.
- [base-permissions.md](base-permissions.md) -- the Bases panel this page's
  base markers link into.
