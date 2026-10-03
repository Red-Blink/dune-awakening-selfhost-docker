# Live Map

**Status:** Current | **Last Updated:** October 2026

The Live Map panel renders Hagga Basin and The Deep Desert as pannable,
zoomable square maps with real-time markers read directly from Postgres --
players, vehicles, bases, storage, spice, resources, and points of interest.
Nothing on this page polls the game server itself except the Coriolis seed
(read from the current game log) and player teleport (a live in-game move); everything
else is a straight database read. Live actors and active fields refresh every
5 seconds; the much larger static POI/resource atlas refreshes once per minute
and is retained between live polls.

The Deep Desert is not drawn from a picture: it is rendered from the game's own
map meshes for the layout the current cycle selected, and can be tilted and
turned. See [Rendered terrain](#rendered-terrain-deep-desert).

See [API-REFERENCE.md](API-REFERENCE.md#live-map) for the endpoint contract.

## Map and partition selection

The two **Choose Map** buttons switch between Hagga Basin and The Deep
Desert. Each map's config (world bounds, image, default partition) lives in
`LIVE_MAP_CONFIGS` in `duneDb.js`.

The **Partition** dropdown lists every Hagga Basin and Deep Desert partition
known to `world_partition`, including a stopped dynamic partition whose active
`server_id` has been released. Story and dungeon instances remain excluded by
map type. A stopped partition is marked **Offline**, and the map explains that
its terrain, resources, bases, and vehicles are saved database/static data;
opening or browsing it does not start a map process. Its display name resolves
in two layers:

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

**Possible Spice Locations**, **Active Spice Fields**, and **Flour Sand** are
three independent layers built by `liveMapSpice()`
(`console/api/src/services/liveMapSpice.js`):

- *Possible Spice Locations* is the full known pool for the **current Coriolis
  seed** (see below): the committed `console/api/data/
  large-spice-locations.json` archive (Large tier, Deep-Desert-only, built
  from ground truth) merged with a runtime-generated
  `learned-spice-locations.json` that the console grows itself by recording
  every field it has ever seen active. On a `field_id` collision the
  committed archive wins -- it is the higher-confidence source.
- *Active Spice Fields* reads `dune.resourcefield_state` live (every row
  whose `value_remaining` isn't Flour Sand's fixed 60,000 tier below), sized
  by `value_remaining` (`> 150000` Large, `> 5000` Medium, else Small), and
  positioned by decoding `field_id`'s bit-packing directly when no archive
  entry exists for it (see below). Every active field observed here feeds
  the learned pool, tagged `confidence: "decoded"` so a decode-only entry is
  never presented as more certain than it is.
- *Flour Sand* (`value_remaining = 60000`, its one fixed tier) is always
  decode-only -- there is no historical pool for it on either map.

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

Fortress, House Representative and Trainer are top-level categories rather
than sub-groups of `poi`, so each has its own legend row.

## The Layers legend

- **Terrain overlays sit above the marker legend**, in a group of their own:
  **Sector Grid** (the Deep Desert, on the rendered terrain and the flat image
  alike) and **Elevation Lines** (only while the rendered terrain is drawing --
  it is a shader effect, and on the flat image would do nothing). They are not
  marker categories and are not part of Default Layer Settings: Sector Grid
  starts on and Elevation Lines off, each time the panel opens.
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
partition's own server logs (`console/api/src/services/coriolisSeed.js`). The
resolver reads the active `DuneSandbox_PIDX*.log` inside that allowlisted map
container first, with a 5-second timeout. This matters after a container
stop/start: retained `docker logs` output can still contain the previous cycle
even though the current game process has written a fresh seed to `Saved/Logs`.
`docker logs` remains a compatibility fallback when the active file cannot be
read.

It selects the `LogCoriolis`/`LogWorldLayout` lines out of that file by pattern
rather than tailing it: the block is written once during startup, so on a server
that has been up for hours it sits far above any tail window. Output is still
bounded, and a log that opens but holds no block is treated as
authoritative-empty. Results use a short server-side cache,
since every server container prints the identical farm-wide seed and cycle
boundary once at startup. Candidate container names are built from the
map/partition (`dune-server-survival-1[-<id>]` for Hagga Basin,
`dune-server-deepdesert-1-<id>` for Deep Desert, both falling back to a
farm-wide `overmap`/`survival-1` default) and re-validated against the same
allowlist regex used by the rest of the Console's Docker access.

### Why a stale seed suppresses the static pool

The seed line is only printed **at container startup**, but the Deep Desert
world re-rolls at every weekly Coriolis boundary whether or not anything
restarts. Between a boundary and the next restart the logs therefore still
advertise the *previous* cycle's seed, and taking that at face value would put
the previous cycle's spice pool on the map and file newly seen fields under the
wrong seed.

The same log block also prints when the cycle ends, so a boundary that is
already in the past is proof the logged seed is stale. `resolveCoriolisCycle()`
treats that seed as **unknown** rather than trusting it: it returns a null seed
plus a `staleSince` timestamp, which makes every archive and learned-pool
lookup short-circuit and suppresses the write-back. *Possible Spice Locations*
therefore disappears until the map server restarts and prints the new seed,
while *Active Spice Fields* and *Flour Sand* keep working -- they read Postgres
and never depend on the seed. The Overview strip shows `Coriolis Seed:
Awaiting restart` during that window so the empty layer does not read as a bug.

A log block that carries a seed but no boundary line is passed through
unchanged; there is nothing to check it against.

**Anything keyed into a static file must carry the seed it belongs to.** Both
spice files are keyed `seeds["cor-<n>"]`, and neither is read or written when
the seed is unknown.

This includes Hagga Basin, whose resources also move at a Coriolis -- so its
learned entries are keyed by the Deep Desert seed and relearned each cycle by
design. Most Hagga Basin positions recur from cycle to cycle, but some are new,
and there is no way to tell a recurring one from a moved one after the fact, so
the keying stays conservative.

### Cleanup when the database wipe is disabled

The game normally removes obsolete discovery markers and Deep Desert resource
fields as part of its Coriolis database wipe. Servers that disable that wipe to
retain Deep Desert structures also disable this housekeeping, so renewable
resource markers from old cycles otherwise accumulate in `dune.markers` and
continue to appear on the Live Map.

Immediately before its coordinated farm restart, the Coriolis Coordinator runs
`runtime/scripts/coriolis-data-cleanup.sh`. It checks the effective setting
for Hagga Basin and Deep Desert independently and acts only where **Coriolis
Database Wipe** is disabled. The cleanup:

- uses the game's `dune.delete_markers_for_all_players` procedure, preserving
  its lock ordering and `player_markers` cascade;
- removes only marker categories known to be regenerated by the new cycle,
  while retaining every unknown or permanent marker type;
- clears `resourcefield_state` for Deep Desert so old active-field rows do not
  survive into the next layout; and
- never calls the partition cleanup procedure and never deletes actors,
  structures, bases, inventories, or progression.

Deep Desert caves, shipwrecks, camps, hazards, resources, scrap, and plants are
cycle-generated and are swept. Hagga Basin keeps its permanent POIs, caves,
camps, bases, vendors, trainers, and sietches; only its renewable resource,
scrap, and plant marker categories are swept. Setting
`DUNE_CORIOLIS_SAFE_DATA_CLEANUP=0` disables this additional housekeeping.

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
container is down, the line is not in the log, or the game reports a layout
this console has no terrain for. Consumers must treat `null` as
"fall back", never as an error.

**It is also null once the cycle boundary has passed**, for exactly the reason
the seed is (above): the layout line is printed only at container startup, so
between a boundary and the next restart the logs still name the *previous*
cycle's layout. Drawing that would put the previous rotation's terrain on the
map -- silently, since nothing about a stale layout looks broken. The same
expiry check that suppresses the stale seed nulls the layout, so the Live Map
falls back to the flat image until the map server restarts.

## Rendered terrain (Deep Desert)

The Deep Desert is drawn from the game's own map meshes for whichever layout the
current cycle selected, not from a picture. The game ships no terrain texture for
it: its in-game map is a mesh diorama. The sand is a height field built from the
map's landscape tiles, and the rock is the map's own meshes. The view is top-down
by default and can be [tilted and turned](#tilt-and-rotation). The flat
`images/maps/deep-desert.png` stays as the [fallback](#when-it-falls-back).

### How it fits together

`console/web/src/features/liveMap/terrain/` holds a framework-free WebGL2
renderer (`renderer.ts`) behind a thin React wrapper (`DeepDesertTerrain.tsx`),
lazy-loaded so a Hagga Basin user never downloads it.

- **The panel owns the view.** Pan, zoom, markers and teleport are DOM; the
  renderer replaces only the `<img>` and decides nothing about what is shown.
  Top-down it is handed the world rect scrolled into view (`visibleWorldRect`)
  and draws exactly that. Tilted, the panel and the renderer each build the same
  camera from one helper (`liveMapCamera`) and the same scroll and zoom. Either
  way terrain and markers share one mapping, and the scroll position is the
  single source of truth for where the view is.
- **No render loop.** It draws only when something changed; the console sits open
  for hours and must not pin a GPU.
- **The map rect is the sector square.** Image, terrain, markers and grid share
  that one frame of reference. Players do stray past the edge, so
  `worldToLiveMapPoint` allows 16 px of tolerance, and such markers are drawn at
  their true position, never clamped.
- **The canvas covers the viewport, not the scaled map**, and is translated to
  follow the scroll. At maximum zoom the map is 16,384 px across, beyond
  `MAX_TEXTURE_SIZE` on many GPUs.
- **That translation is clamped to the map's extent, and the clamp must stay.** A
  transform counts toward the frame's scrollable width, so an unclamped one
  inflates the scroll area and leaves the map stuck off-centre after zooming out.
  The one exception is tilted with the map narrower than the frame (a wide window
  at fit zoom): the canvas is widened to the frame, which it never reaches past
  (`terrainViewport`'s `fill`).
- **Only what is in view is drawn.** A layout is 18-26 million triangles per pass.
  Each frame draws the instances whose bounding circle touches the view and is at
  least half a pixel in radius. Not one pixel: POI hulls are assembled from
  sub-pixel pieces and would vanish from the overview.

### Rock

In the game the map's rock has no textures and no normal maps; its material is a
flat tone with a per-instance random. Here it gets:

- **Authored normals**, read from the meshes' own tangent buffers. Shading is the
  whole visual read of a cliff, so these are not resynthesised.
- **Per-instance tone.** A value hashed from each instance's translation varies
  brightness with a slight warm/cool swing, so a field of rocks does not read as
  one asset stamped repeatedly.
- **The game's own diffuse.** Each of the 64 rock families is painted with the
  baked diffuse of its in-world counterpart. The map's geometry is kept, so
  outlines match the map; only the paint is borrowed. UVs are an overhead
  projection, which is how the in-world cliff blocks bake theirs; the shield
  walls' atlases are re-baked overhead to match. Colour is pulled halfway toward
  the map's ochre so that shape mismatches blend in.
- **Relief on the two big wall shapes.** The outer shield wall and the shield
  wall vista ship a diffuse that is close to one flat brown; in the game their
  detail comes from a normal map. That normal map is lit from a fixed direction
  and the shading multiplied into their two texture layers, so they read as
  rock. The light is baked in and does not turn with the view.
- **Sealing.** The rock meshes are stacks of open plates, and the bottom of one
  cliff face hangs a few metres above the ledge below, leaving a slit. When the
  library loads, `terrainSeal.ts` hangs a 60 m skirt from every open edge of
  every rock mesh, which closes them. A skirt has its own vertices, with a level
  normal, so it lights and textures as cliff rather than as a ramp down from
  the ledge. From overhead a skirt has no area, so the top-down view is
  unaffected. POIs and ground patches are left alone.

The diffuse ships as BC1 (60 layers of 256 x 256) and is decoded once on the GPU
into a mipmapped array.

Laid on from overhead, a texture gives a vertical face one column of texels
stretched down it, which shows as stripes. So when the view is tilted, a steep
face takes the same texture from the side instead: across the face one way and
up it the other, at the density the overhead mapping has, blended in by how far
the face leans. Top-down is unchanged.

Limit of the overhead projection: where the in-world rock and the map's proxy
differ in shape (an arch, say) the paint does not line up.

### Elevation lines

An optional layer, off by default, in the Layers panel while the terrain is
drawing. It marks changes in height, which shading alone cannot show from
straight overhead.

The lines are bands, not true isolines: the rock is terraced, and an isoline
vanishes across a flat tread. The elevation is banded and a line drawn where the
band index changes between neighbouring pixels. The interval is 200 uu zoomed in
and coarsens with zoom-out in a 1-2-5 sequence (1,000 uu at 100%, 2,000-5,000 at
the whole map, depending on the window's size). Sand uses an interval eight times coarser, capped at 2,500 uu, and
fades its lines on steep dune flanks.

### Sector grid

**Sector Grid**, in the Layers panel and on by default, overlays the Deep
Desert's 9x9 lettered grid: 250,000 uu cells spanning +/-1,125,000 uu about the
map centre. Top-down it is drawn over the rendered terrain or the flat image;
tilted, the terrain draws it (below). Hagga Basin has no lettered sectors.

- **I is at the top and A at the bottom.** World +Y draws downward, so the letter
  runs opposite to screen-down. This matches the game's own map art and is pinned
  by tests.
- **Lines and labels are a constant size on screen** at every zoom.
- **Labels follow the viewport.** Above about 2x zoom a cell is wider than the
  frame, so each label sits at the centre of the *visible part* of its cell and is
  hidden when too little of the cell is on screen.
- **Tilted**, the terrain draws the lines itself, on whatever surface each pixel
  shows: across the sand, over rock tops and down cliff faces. Anything standing
  in front hides them, by the same depth test as the terrain. Widths stay 1 px
  (2 px for the outer edge) from how fast the grid coordinate changes across a
  pixel. Only the labels are still projected by the panel, at the pivot height.
  Measured: the grid's per-frame work in the panel went from 0.6-1.8 ms to under
  0.1 ms, with no measurable change in draw time.

### Tilt and rotation

While the terrain is drawing, the map can be leaned back up to 60 degrees and
turned. A **Tilt** slider and a **Top-Down** reset sit in the toolbar, and
**right-dragging** the map does both: across rotates, up leans it back. The
controls are absent on Hagga Basin and on the flat fallback image.

A **compass** shows in the map's top-right corner whenever the view is tilted or
turned. Its needle points at north (the map's top edge, sector row I), and its
label names the way the view faces. It turns with the view but stays round
while tilted, so between the four main directions its needle can be a few
degrees off the grid's lines (up to about 8 at 45 degrees of tilt). Clicking it
turns the view back to face north and keeps the tilt.

The map frame spans the panel's width but is never taller than the window less
the toolbar, so the whole map fits without scrolling the page. In a wide window
the flat map is centred at fit zoom; tilted, the view fills the frame's width.

Top-down is not a special case of the tilted view. With no tilt and no rotation
the original code path runs, and everything below is inactive.

- **Camera** (`terrainCamera.ts`). It looks at the middle of the viewport, which
  scrolling still sets, so pan and zoom mean the same in both modes. Perspective
  grows with tilt, from none to a 35 degree field of view at 60, with the scale
  at the view centre held fixed. The sun turns with the view.
- **Eye clearance.** Zooming in brings the eye closer and lower. At high zoom the
  field of view is narrowed just enough to keep the eye 10% above the layout's
  tallest point, so it never ends up inside rock. Framing is unchanged; there is
  only less perspective.
- **Markers** are projected at their own `z`, or at the sand height under them
  where they have none. Markers outside the view are not drawn.
- **Picking.** Double-click and player-drag read the point from the terrain under
  the cursor, by rendering that one pixel's world height. Nothing past the map's
  edge can be picked. What is sent to the server is unchanged.
- **Pan and zoom** keep the ground under the pointer fixed, perspective included.
- **Lighting.** Over the first 25 degrees of tilt, rock and POIs change from the
  top-down shading to ambient plus sun plus a fill from the camera. The top-down
  curve leaves steep faces near-black, which reads as holes once cliffs face the
  camera. Sand keeps the top-down curve.
- **Past the map's edge.** The clip moves out 375,000 uu, which takes in the
  shield walls nearest the map. That rock lies wholly outside the mapped square
  and is the same in every layout, so it ships once, as a shared file, and is
  added to whichever layout is drawn. It includes the wall pieces the game
  places by hand rather than as instances, which the layout build does not
  read. Only pieces lying wholly within the 375,000 uu are shipped, so none is
  sliced by the clip.
- **Rock that hangs in the air.** The shield wall is built in tiers, and the
  upper ones have nothing under them: the game only shows its map from above,
  where that cannot be seen. When a layout loads, every rock piece whose own
  floor clears the sand beneath it by more than 1,500 uu is marked (about 50 of
  a layout's own along the south, and most of the outside rock), and the vertex
  shader carries a marked piece's skirts straight down to the ground. It stands
  as a cliff instead of floating, and from above nothing changes.
- **The sand out there.** The game's sand tiles reach about 90,000 uu past the
  square, and that ring is shared too: it is joined to the layout's height field
  on the same grid when the layout loads. The dunes run on for about 65,000 uu,
  settle over the next 25,000 into a level plain at the edge's own height, and
  the plain carries on to the clip. A layout's own texels are never changed, so
  the top-down picture is the same with or without the ring.

**Hiding what the terrain covers.** Markers are DOM elements over the canvas, so
nothing occludes them by itself. After each tilted frame the renderer reads back
a small copy of that frame's depth (one texel per 4 px), and a marker is hidden
when the terrain at its spot is both nearer the eye and more than 30 m above it
(`terrainOcclusion.ts`).

- Both conditions are needed: open ground in front of a marker is nearer the eye
  too, and a cliff behind it is higher.
- The 30 m keeps a marker visible on or in the coarse mesh it belongs to, such as
  a base on a ledge.
- All 3x3 texels round a marker must be covered, so an edge clipping it does not
  hide it.
- **Never hidden:** the selected marker, a player being dragged, and everything
  while the search box has text in it. Searching is how to find a covered marker.
- Sector labels are not hidden. Grid lines need no test: the terrain draws them.
- The read-back is asynchronous, so a marker is hidden a frame or two after it
  passes behind something.

**Known limits.**

- A marker with no height of its own stands on the *sand*. On a rock top it is
  drawn at the rock's foot and, being under the rock, is hidden.
- The view centre cannot be panned past the map square. The ground beyond the
  edge is seen by tilting or turning toward it.
- The game has sand for only about 90,000 uu past the edge. Beyond that the
  ground is a level plain, which the game does not have. One outer sand tile
  differs in layout 9, by up to 515 uu, and is drawn as in the other eleven.
- Rock that reaches beyond 375,000 uu is not drawn (32 pieces), and one nearer
  piece is missing because its shape is not in the mesh library.
- The two big wall shapes are still coarse up close: one texel of theirs covers
  about 256 x 712 uu, against 129 uu for a typical rock.

### Assets

`terrain/assets/` is 49 gzipped files totalling 16.0 MB, inflated in the browser:

| part | size |
|---|---|
| shared: mesh library | 4.0 MB |
| shared: rock UVs | 0.8 MB |
| shared: rock textures | 1.4 MB |
| shared: sand detail textures | 1.8 MB |
| shared: rock outside the map (221 pieces) | 5 KB |
| shared: sand outside the map | 50 KB |
| shared: placements every layout has (6,394) | 0.13 MB |
| each of 12 layouts | about 0.65 MB |

A Coriolis reset changes only the layout, so the browser re-fetches about
0.65 MB and the 8.2 MB shared half stays cached.

Two encodings shrink the files, and the loader undoes both:

- **Mesh indices** are stored as the step from the index before, zigzagged so
  small steps either way stay small (`idxCoding` in `meshes.json.gz`). The
  library gzips 10% smaller. `decodeIndices` restores them exactly.
- **Placements every layout shares**, 45% of an average layout's, ship once in
  `rock-common.*`. A split layout's table carries `common`, and `joinShared`
  gives each of its draws the shared placements of that mesh first, then its
  own. The placements are exactly the original ones; only their order within a
  draw changes, which the order-independent blending does not see.

Vite fingerprints them into `dist/assets/`, which earns the immutable
cache-control rule in `staticFiles.js`. Two build settings must stay:
`assetsInclude` keeps `.gz` opaque so it is hashed and copied rather than parsed,
and `build.assetsInlineLimit` stops the ~1.6 KB layout sidecars being inlined
into the main bundle.

The pipeline that produced these is developer-only and not in the repo. It needs
the game's paks and a local Oodle DLL, so it cannot run in CI.

### When it falls back

The rendered terrain is an upgrade over the flat image, never a replacement.
Every case below shows `deep-desert.png` instead, with no error state and no loss
of markers, teleport, pan or zoom. Which case applied is shown as **Terrain**
beside the Coriolis readout.

| condition | |
|---|---|
| not the Deep Desert | Hagga Basin always uses its image |
| `coriolisLayout` is null | the layout could not be read, **or the cycle boundary has passed** and the logged layout belongs to the previous rotation |
| layout outside 0-11 | the game reported one this console has no assets for |
| no WebGL2 | browser or GPU does not provide it |
| no `EXT_texture_compression_bptc` | the sand normals are BC7; common on desktop, absent on many mobile GPUs |
| no `DecompressionStream` | Safari before 16.4 |
| an asset fails to load | fetch or inflate error |
| the context is lost | GPU reset, driver update, or the browser reclaiming it |

If the browser's GPU lacks either of these two capabilities, the terrain still
draws but loses something. Both are standard on desktop GPUs.

| GPU capability | what is lost without it |
|---|---|
| `EXT_color_buffer_float` | a slightly flatter blend; and, tilted, picking from the terrain (the pick falls back to the sand) and hiding markers behind rock |
| `WEBGL_compressed_texture_s3tc` | the rock textures; rock draws in its flat per-instance tone |

## Player teleport

Dragging an **online** player marker previews a new position; releasing
commits it through the same live in-game teleport path used elsewhere in
the console. Offline players cannot be drag-teleported from the map.

Every marker overlay also carries a **Teleport** button, for sending a
player *to* that marker instead of dragging a player marker *to* a new
spot. Clicking it lists the online players sharing the marker's own map
and partition (a static-pool marker with no partition, such as a spice
field or POI, uses the partition currently selected by the admin); picking one and
confirming teleports them to the marker's coordinates through the same
`teleport-player` path as the drag gesture. The button is disabled unless an
online player is already inside that exact ready partition. The API independently
enforces both conditions, so Live Map never starts a dynamic Deep Desert or
moves a player across partitions; normal in-game travel must start and place the
player in that partition first.

**Double-clicking empty map** picks that point and opens the same overlay on it,
headed *Picked Location*: the world X and Y, the partition, the sector on the
Deep Desert, and the same Teleport button. It presents itself to the teleport
code as a marker (`type: "picked_location"`, the one marker type the API never
sends) so that path is shared rather than duplicated. Closing the overlay, or
pressing Escape, clears the pick.

With the Deep Desert tilted, both gestures take their point from the terrain
under the cursor rather than from the flat map, and nothing past the map's edge
can be picked. What is sent is unchanged. See
[Tilt and rotation](#tilt-and-rotation).

## Related

- [API-REFERENCE.md](API-REFERENCE.md#live-map) -- full HTTP API reference.
- [base-permissions.md](base-permissions.md) -- the Bases panel this page's
  base markers link into.

## Change log

Feature-level changes to the Live Map, newest first.

| Release | Date | Change |
|---|---|---|
| Unreleased | 2026-10 | **Tilt and rotation** of the Deep Desert terrain, with perspective: Tilt slider, Top-Down reset, right-drag and a compass. Markers are projected through the camera and hidden where rock covers them; the sector grid is drawn on the terrain, over rock and cliffs. Tilted, the view reaches 375,000 uu past the map's edge: the shield walls outside the square, hand-placed pieces included and floating upper tiers closed down to the ground, on the game's own sand for the first 90,000 uu and a level plain beyond. **Elevation Lines** layer. Rock is painted with the game's own textures (its normal map baked into the two big wall shapes), lit with its authored normals and a per-instance tone, sealed at load, lit as a solid and textured from the side when tilted; the camera's eye stays above the rock at high zoom. The map frame fits the window's height. Terrain instances are culled per frame and the depth pass stops before shading; assets are 1.9 MB smaller (delta-coded mesh indices, shared placements shipped once). |
| v1.4.35 | 2026-09-20 | The Coriolis block is read from the game log by pattern instead of from a tail, so the layout no longer goes missing on long-running servers. |
| v1.4.23 | 2026-09-17 | Spice and Flour Sand layers fixed after the game changed `resourcefield_state`. |
| v1.4.7 | 2026-09-02 | **Rendered Deep Desert terrain** for the live Coriolis layout, with the flat image as fallback. **Sector Grid** overlay. Map rect corrected to the sector square. A double-clicked location opens as an overlay. |
| v1.4.7 | 2026-09-02 | Partition runtime state (Ready / Starting / Offline). Stale Coriolis map data cleaned before the farm restart. Sector Grid toggle moved into the Layers panel. Sub-types come from a backend registry. |
| v1.4.6 | 2026-08-31 | A Coriolis seed whose cycle has ended is no longer served; the static spice pool waits for the restart. |
| v1.4.0 | 2026-08-25 | Large Spice locations and the redesigned marker overlay. |
