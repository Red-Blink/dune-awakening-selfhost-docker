# World Model: Maps, Dimensions and Partitions

**Status:** Observed — verified against game build 2117304-0-shipping (September 2026). Re-verify after a game update.

The game addresses world space in three levels — **map**, **dimension**,
**partition** — and every one of them is a column on a single table,
`dune.world_partition`. Understanding this model is what makes the rest of the
schema legible: it is why world state tables carry a `dimension_index`, why
`partition_id` appears throughout the event log, and why "the same map" can
hold two completely independent worlds.

Related: [`DATABASE.md` §6](DATABASE.md#6-partitioning) for how `partition_id` provisions the
`event_log_p*` tables, [`SERVICES.md`](SERVICES.md) for the game servers that
own partitions at runtime, and
[`live-map.md`](../console/live-map.md) for the Deep Desert sector grid.

---

## 1. The three levels

Everything below is one row in `dune.world_partition`:

```
partition_id          bigint   -- PK; drives event_log_p* and combat state
map                   text     -- the authored map identifier
dimension_index       integer  -- which parallel instance of that map (default 0)
partition_definition  jsonb    -- the spatial box for this partition
label                 text     -- friendly name, set by a trigger
server_id             text     -- the game server currently holding it (nullable)
blocked               boolean  -- excluded from selection
```

### Map

The authored map — a shipped piece of geometry. `Survival_1`, `DeepDesert_1`,
`Overmap`, the two standalone hubs (`SH_Arrakeen`, `SH_HarkoVillage`), and the
~30 on-demand content maps (story missions, dungeons, sietch rooms, ecolabs,
overland islands). A map is a template, not a running world.

`dune.map_names` is a separate id→display-name lookup (`HaggaBasin`,
`Arrakeen`, `DeepDesert`, …) — note that the survival map's authored id is
`Survival_1` while its display name is `HaggaBasin`.

### Dimension

`dimension_index` is **a parallel, independent instance of the same map.**
Same geometry, entirely separate state — actors, resources, buildings, event
log. The live worlds make this concrete:

- `Survival_1` runs dimension **0 = Abbir** and dimension **1 = Alraab** —
  two survival worlds on the same Hagga Basin geometry.
- `DeepDesert_1` runs dimension **0 = PvP** and dimension **1 = PvE**.

This is the single most important consequence of the model for anyone writing
a query: **world state is keyed by `(map, dimension_index)`, not by map
alone.** A query that groups spice fields, resource fields, actors or event
rows by map without splitting on `dimension_index` silently merges Abbir with
Alraab, or PvP with PvE. Several state tables (`resourcefield_state` among
them) carry `dimension_index` for exactly this reason.

### Partition

A partition is one `(map, dimension, spatial box)` unit — the row itself.
`partition_definition` is a `box2d_array` giving `min_x/min_y/max_x/max_y`;
on the current build every live world is a single `1x1` box, so map + dimension
and partition are one-to-one today, but the model allows a map to be carved
into a spatial grid of partitions.

`partition_id` is the identity the rest of the schema hangs off: inserting a
`world_partition` row fires the trigger that provisions that partition's
`event_log_p*` table (see [`DATABASE.md` §6](DATABASE.md#6-partitioning)), and combat/world
state references it. **Never insert a `world_partition` row by hand** — it
provisions tables as a side effect.

`server_id` is the game server currently hosting the partition, or NULL when
nothing has loaded it. `label` is set automatically by the
`determine_partition_label` trigger on insert.

---

## 2. The catalog

37 partitions on the verified build. This list drifts with every game update
(and with DLC), so treat it as a snapshot, not a contract — regenerate it with
`runtime/scripts/extract-partition-catalog.sh` (writes
`runtime/generated/partition-catalog.json`), or directly:

```bash
docker exec dune-postgres psql -U dune -d dune -c \
  "select map, dimension_index, label, server_id from dune.world_partition order by map, dimension_index"
```

### Stopgap partitions

A game build can ship an instanced map before Funcom's `world-template.yaml`
lists it. Without a partition the map never gets a server, so players cannot
travel into it. `runtime/scripts/partition_stopgaps.py` adds the catalog entry
for such maps, and the normal additive reconcile then inserts the row. The
catalog ID is the next one after the template's highest ID; the reconcile falls
back to the sequence if that ID is already taken.

| Map | Label | Why |
|---|---|---|
| `CB_Halloween_Event_Shipwreck_01` | Halloween2026Shipwreck_0 | "Wreck of the Hieronymus", Halloween 2026 event dungeon (issue #268) |

Each entry retires itself. It is skipped once the template lists the map and
dimension, and it is skipped when the installed game image does not ship the
map's `.umap`. The extraction step checks for the `.umap` by searching the
image's `.utoc` indexes with `docker run --pull=never`, and only when the image
is already present locally; if it cannot read the image, it adds no stopgaps.
A row that has already been inserted stays when its entry retires: the reconcile
never deletes rows. Remove an entry from `STOPGAP_PARTITIONS` once Funcom's
template carries the map.

### Live worlds (a game server is attached)

| Map | Dim | Label | Notes |
|---|---|---|---|
| `Survival_1` | 0 | Abbir | Hagga Basin survival world |
| `Survival_1` | 1 | Alraab | second, independent survival world |
| `DeepDesert_1` | 0 | PvP | Deep Desert, PvP ruleset |
| `DeepDesert_1` | 1 | PvE | Deep Desert, PvE ruleset |
| `Overmap` | 0 | Overland | the strategic overland layer |
| `SH_Arrakeen` | 0 | Arrakeen_0 | standalone hub |
| `SH_HarkoVillage` | 0 | HarkoVillage_0 | standalone hub |

### On-demand content maps (no persistent server)

These start with a dimension-0 partition row and no `server_id` until a player
instance is loaded. For Director requests marked `ClassicalInstancing`, Dune
Docker creates additional partition dimensions on demand (five by default) so
independent parties do not share or displace one another. Every dimension is a
single `1x1` box.

**Dungeons**

| Map | Label |
|---|---|
| `CB_Dungeon_Hephaestus` | WreckOfHephaestusDungeon_0 |
| `CB_Dungeon_OldCarthag` | OldCarthagDungeon_0 |
| `CB_Dungeon_ThePit` | PitDungeon_0 |
| `CB_Ecolab_Bronze_Green_024` | DarknessDungeon_0 |
| `CB_Ecolab_Bronze_Green_089` | RadiationDungeon_0 |
| `CB_Ecolab_Bronze_Green_136` | FireDungeon_0 |
| `CB_Ecolab_Bronze_Green_152` | ElectricityDungeon_0 |
| `CB_Ecolab_Bronze_Green_195` | PoisonDungeon_0 |
| `Story_HeighlinerDungeon` | HeighlinerDungeon_0 |

**Overland islands**

| Map | Label |
|---|---|
| `CB_Overland_M_01` | RadioactiveShipwreck_0 |
| `CB_Overland_S_04` | ErythriteCaveIsland_0 |
| `CB_Overland_S_06` | GroundVehicleTimeTrialIsland_0 |
| `CB_Overland_S_07` | TheRuinsOfTsimpo_0 |
| `CB_Overland_S_08` | WindPass_0 |

**Story maps**

| Map | Label |
|---|---|
| `CB_Story_BanditFortress01` | SandfliesFortress_0 |
| `CB_Story_DestroyedZanovar` | DestroyedZanovar_0 |
| `CB_Story_Ecolab_Carthag` | BeneathCarthag_0 |
| `CB_Story_Hephaestus` | WreckOfHephaestus_0 |
| `CB_Story_OrbitalMonitor` | OrbitalMonitor_0 |
| `CB_Story_WaterFatManor` | WaterFat_0 |
| `Story_ArtOfKanly` | ArtOfKanly_0 |
| `Story_Faction_Outpost_Atre` | Story_Faction_Outpost_Atre_0 |
| `Story_Faction_Outpost_Hark` | Story_Faction_Outpost_Hark_0 |
| `Story_ProcesVerbal` | ProcesVerbal_0 |
| `DLC_Story_LostHarvest_EcolabA` | LostHarvest_EcolabA_0 |
| `DLC_Story_LostHarvest_EcolabB` | LostHarvest_EcolabB_0 |
| `DLC_Story_LostHarvest_ForgottenLab` | LostHarvest_ForgottenLab_0 |

**Sietch / story rooms**

| Map | Label |
|---|---|
| `CB_Arrakis_Generic_Sietch_Room` | SietchTalab_0 |
| `CB_Arrakis_Story_Glutton_DiningRoom` | GluttonRoom_0 |
| `CB_Arrakis_Story_Paranoid_PrayerRoom` | ParanoidRoom_0 |

---

## 3. Why it matters when querying

1. **Always split world state by `dimension_index`.** Grouping by `map` alone
   merges independent worlds (Abbir+Alraab, PvP+PvE). This is a correctness
   bug, not a cosmetic one.
2. **`partition_id`, not map name, is the join key** into the event log and
   combat state.
3. **A content map with no `server_id` is normal**, not a fault — it simply
   has not been loaded into an instance.
4. **The catalog is `Observed` data.** The DLC and every game build move it;
   regenerate rather than trust the table above if the vintage has advanced.
