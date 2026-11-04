# Generator fuel burn rates

**Status:** Current | **Last Updated:** November 2026

`FUEL_BURN_SECONDS` in `console/api/src/duneDb.js` stores the normal, per-unit
uptime for each supported generator consumable. The values match the persisted
`m_FuelBurningDuration` fields and the normal burn times documented by the
Dune: Awakening Community Wiki.

Temporary live events are applied separately. Funcom's 1.4.10.2 hotfix doubles
generator, wind-turbine, and consumable uptime from July 1 through August 31,
2026. `generatorUptimePolicy()` applies that 2x multiplier during the event and
automatically returns to 1x on September 1. Do not replace the normal constants
with event-adjusted values.

Official event source:
https://duneawakening.com/news/dune-awakening-1-4-10-0-patch-notes/

## Measured values (live DB, re-verified 2026-07-26)

| Building type | Burning fuel | Duration (s) | Generators observed |
|---|---|---|---|
| `Generator_Placeable` | `Oil` | 3600 | 65 |
| `Generator_Placeable` | `None` | 3600 | 4 |
| `Generator_Placeable` | `None` | n/a | 1 |
| `SpiceGenerator_Placeable` | `SpicedFuelCell` | 5400 | 1 |
| `WindTurbineDirectional_Placeable` | `WindTurbineLubricant2` | 5400 | 2 |
| `WindTurbineOmnidirectional_Placeable` | `WindTurbineLubricant1` | 3600 | 3 |
| `WindTurbineOmnidirectional_Placeable` | `None` | 3600 | 3 |

## Effective uptime by power source

| Power source | Accepted consumable | Normal | July-August 2026 event (ended 2026-08-31) |
|---|---|---:|---:|
| Fuel-Powered Generator | Fuel Cell (`Oil`) | 1 hour | 2 hours |
| Omnidirectional Wind Turbine | Low-grade Lubricant (`WindTurbineLubricant1`) | 1 hour | 2 hours |
| Directional Wind Turbine | Industrial-grade Lubricant (`WindTurbineLubricant2`) | 1 hour 30 minutes | 3 hours |
| Spice-Powered Generator | Spice-infused Fuel Cell (`SpicedFuelCell`) | 1 hour 30 minutes | 3 hours |
| Windtrap | Makeshift Filter (`WindTrapFilter1`) | 3 hours | 3 hours (not covered) |
| Windtrap | Standard Filter (`WindTrapFilter2`) | 8 hours | 8 hours (not covered) |
| Large Windtrap | Particulate Filter (`WindTrapFilter3`) | 12 hours | 12 hours (not covered) |
| Large Windtrap | Advanced Particulate Filter (`WindTrapFilter4`) | 24 hours | 24 hours (not covered) |

The lubricant grades are not interchangeable for reserve calculations. An
incompatible item present in a turbine inventory must not count as usable fuel.

Windtrap filters were never covered by the 2x uptime event, so the console
applies no multiplier to them. Regular windtraps were only ever seen holding
tiers 1-2 and Large Windtraps tiers 3-4, never a mix. Measured
2026-09-26: Filter1/2 on dune2 (9 windtraps), Filter2/3/4 on the kovalt
test dump (28 windtraps).

This re-run confirms all four normal `FUEL_BURN_SECONDS` values against the live
server, including spice: a `SpiceGenerator_Placeable` burning `SpicedFuelCell`
was observed at 5400s, matching the constant that was previously an
unverified inheritance rather than a direct measurement. Its building type
(`spicegenerator_placeable` lowercased) is present in the explicit allowlist
in `portalGeneratorFuel()`, so it is classified correctly. No constant needs
updating from this pass.

The one `Generator_Placeable`/`None` row with no duration is an idle
generator whose fuel-burning component has never been populated (nothing
has burned in it yet) — it contributes no stock either way and doesn't
affect `FUEL_BURN_SECONDS`.

The Console uses these durations to convert accepted fuel units currently
queued in each generator's inventory into a queued reserve. It deliberately
does not call that value an exact depletion countdown: the active burn marker
and its timestamps can remain stale after a restart or base load, so they do
not reliably prove whether a partially consumed unit is still active.

## Re-verification query

Run this against the live Postgres database after any game update that
might touch fuel burn rates:

```sql
select p.building_type,
       coalesce(nullif(state.fuel_state->'m_FuelBurningId'->>'Name', ''), 'None') as burning_fuel,
       (state.fuel_state->>'m_FuelBurningDuration')::numeric as duration_seconds,
       count(*) as generators
from dune.placeables p
left join lateral (
  select fe.components->'FFuelPoweredPlaceableComponent'->1 as fuel_state
  from dune.actor_fgl_entities afe
  join dune.fgl_entities fe on fe.entity_id = afe.entity_id
  where afe.actor_id = p.id
    and fe.components->'FFuelPoweredPlaceableComponent'->1 is not null
  limit 1
) state on true
where lower(p.building_type) like '%generator%' or lower(p.building_type) like '%turbine%'
group by 1, 2, 3
order by 1, 2;
```

The persisted duration is the normal value and may not include a live-event
multiplier shown by the game UI. If a duration changes outside an announced
event, update the normal constant and re-run `console/api`'s test suite. For a
temporary event, add or update a bounded event policy instead.

See [generator-refill-caps.md](generator-refill-caps.md) for how these same
generator types map to fuel refill stack/cap limits and their operator
override file.
