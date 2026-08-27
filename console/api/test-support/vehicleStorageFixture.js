// Shared schema + seed for the vehicle cargo-hold integration tests
// (vehicleStorage.integration.test.js reads it; vehicleStorageDelete.integration.test.js
// deletes from it). One fixture rather than two so the read and the write can
// never disagree about the shape they are exercising.
//
// Transcribed from a real production dump (.claude/dune_backup.sql),
// constraints included, not invented:
//   inventories                                      (line 19703)
//     CHECK valid_fkey: actor_id | exchange_id | item_id | vehicle_module_id  (19713)
//     CHECK inventories_id_check: id > 0                                      (19712)
//   items                                            (line 19783)
//     CHECK items_stack_size_check: stack_size > 0                            (19795)
//     CHECK items_position_index_check: position_index >= 0                   (19794)
//     position_index and stats are NOT NULL                                   (19787, 19791)
//   inventories.actor_id -> actors.id       ON DELETE CASCADE   (line 75804)
//   items.inventory_id -> inventories.id    ON DELETE CASCADE   (line 75844)
//   vehicles.id -> actors.id                ON DELETE CASCADE   (line 76467)
//   vehicle_modules.vehicle_id -> vehicles.id  ON DELETE CASCADE (line 76459)
//   inventories.vehicle_module_id -> vehicle_modules.id CASCADE (line 75828)
//
// The NOT NULL on items.position_index is one reason these tests exist rather
// than only the mocked ones: a hand-written schema that let it be null would
// make the "unplaced slot" path look reachable when production cannot produce
// it. A missing constraint here has hidden a real write bug before.

export const VEHICLE_ID = 9401;
export const OTHER_VEHICLE_ID = 9402;
export const PLACEABLE_ID = 9403;
export const MODULE_ID = 9404;
// Its own vehicle so a blocked-state test can run without disturbing the
// others -- dune.actor_state is keyed on the actor, so sharing one would make
// every other test in the file order-dependent.
export const BLOCKED_VEHICLE_ID = 9405;

export const CARGO_INVENTORY_ID = 8401;
export const OTHER_CARGO_INVENTORY_ID = 8402;
export const PLACEABLE_INVENTORY_ID = 8403;
// The per-component holds that share the vehicle actor. Real dumps carry two
// or three of these per vehicle with inventory_type NULL and no capacity --
// they are what the inventory_type = 0 filter exists to exclude.
export const COMPONENT_INVENTORY_IDS = [8404, 8405];
export const BLOCKED_CARGO_INVENTORY_ID = 8406;

// A real bigint id past Number.MAX_SAFE_INTEGER (9007199254740991). Number()-ing
// this rounds it to a different value, which on a destructive path means
// silently targeting a different row.
export const BIG_ITEM_ID = "9223372036854775806";

export const SCHEMA = `
  create schema dune;

  create type dune.actorstate as enum (
    'Default', 'Travel', 'VehicleBackup', 'AbortedAuthorityTransfer', 'VehicleRecovery', 'BaseBackup'
  );

  create table dune.actors (id bigint primary key, map text, partition_id bigint);
  create table dune.actor_state (actor_id bigint primary key, state dune.actorstate not null);
  create table dune.vehicles (id bigint primary key references dune.actors(id) on delete cascade);
  create table dune.placeables (id bigint primary key references dune.actors(id) on delete cascade);
  create table dune.vehicle_modules (
    id bigint primary key,
    vehicle_id bigint not null references dune.vehicles(id) on delete cascade,
    template_id text not null
  );
  create table dune.inventories (
    id bigint primary key,
    actor_id bigint references dune.actors(id) on delete cascade,
    exchange_id bigint,
    item_id bigint,
    vehicle_module_id bigint references dune.vehicle_modules(id) on delete cascade,
    inventory_type integer,
    max_item_count integer,
    max_item_volume real,
    constraint inventories_id_check check (id > 0),
    constraint valid_fkey check (
      actor_id is not null or exchange_id is not null or item_id is not null or vehicle_module_id is not null
    )
  );
  create table dune.items (
    id bigint primary key,
    inventory_id bigint references dune.inventories(id) on delete cascade,
    stack_size bigint not null,
    position_index bigint not null,
    template_id text not null,
    is_new boolean default true,
    acquisition_time bigint default 0 not null,
    stats jsonb not null,
    quality_level bigint default 0 not null,
    volume_override real,
    constraint items_position_index_check check (position_index >= 0),
    constraint items_stack_size_check check (stack_size > 0)
  );

  -- delete_item's item-tracking log. Early-returns in production unless
  -- dune.item_tracking_enabled is set; stubbed to a no-op so the signature and
  -- call shape match without needing the setting.
  create function dune._add_item_delete_log(in_item_id bigint, in_inventory_id bigint, in_template_id text)
  returns void language plpgsql as $$ begin return; end $$;

  create function dune.delete_item(in_id bigint) returns void
  language sql as $$
    delete from dune.items i
    using dune.inventories inv
    where i.inventory_id = inv.id
      and i.id = in_id
    returning dune._add_item_delete_log(i.id, inv.id, i.template_id);
  $$;

  create function dune.delete_inventory_item(in_item_id bigint, in_count bigint) returns bigint
  language plpgsql as $$
  declare
    remaining_stack_size bigint;
  begin
    select into strict remaining_stack_size stack_size from dune.items where id = in_item_id;
    remaining_stack_size := remaining_stack_size - in_count;
    if remaining_stack_size < 0 then
      return null;
    end if;
    if remaining_stack_size > 0 then
      update dune.items set stack_size = remaining_stack_size where id = in_item_id;
    else
      perform dune.delete_item(in_item_id);
    end if;
    return remaining_stack_size;
  end $$;
`;

export const SEED = `
  insert into dune.actors (id, map, partition_id) values
    (${VEHICLE_ID}, 'HaggaBasin', 1),
    (${OTHER_VEHICLE_ID}, 'HaggaBasin', 1),
    (${BLOCKED_VEHICLE_ID}, 'HaggaBasin', 1),
    (${PLACEABLE_ID}, 'HaggaBasin', 1);
  insert into dune.vehicles (id) values (${VEHICLE_ID}), (${OTHER_VEHICLE_ID}), (${BLOCKED_VEHICLE_ID});
  insert into dune.placeables (id) values (${PLACEABLE_ID});
  insert into dune.vehicle_modules (id, vehicle_id, template_id)
    values (${MODULE_ID}, ${VEHICLE_ID}, 'BuggyInventory_4');

  -- The cargo hold. inventory_type = 0, capacity matching the fitted
  -- BuggyInventory_4 (20 / 2000), reached through actor_id.
  insert into dune.inventories (id, actor_id, inventory_type, max_item_count, max_item_volume)
    values (${CARGO_INVENTORY_ID}, ${VEHICLE_ID}, 0, 20, 2000);
  -- The decoys: same actor, no inventory_type, no capacity. A query that
  -- dropped the inventory_type filter would pick one of these roughly at
  -- random and report an empty hold.
  insert into dune.inventories (id, actor_id, inventory_type, max_item_count, max_item_volume)
    values (${COMPONENT_INVENTORY_IDS[0]}, ${VEHICLE_ID}, null, null, null),
           (${COMPONENT_INVENTORY_IDS[1]}, ${VEHICLE_ID}, null, null, null);
  -- A second vehicle's hold, to prove no cross-leak.
  insert into dune.inventories (id, actor_id, inventory_type, max_item_count, max_item_volume)
    values (${OTHER_CARGO_INVENTORY_ID}, ${OTHER_VEHICLE_ID}, 0, 10, 250);
  -- A placeable's storage container, on the same shape of link. A query that
  -- read dune.inventories by actor_id without joining dune.vehicles would
  -- serve this through a vehicles-scoped route.
  insert into dune.inventories (id, actor_id, inventory_type, max_item_count, max_item_volume)
    values (${PLACEABLE_INVENTORY_ID}, ${PLACEABLE_ID}, 0, 45, 500);
  -- A vehicle mid-recovery, holding real cargo. Production has no such row
  -- today (every blocked-state vehicle is empty), which is exactly why the
  -- guard needs a fixture that manufactures the case.
  insert into dune.inventories (id, actor_id, inventory_type, max_item_count, max_item_volume)
    values (${BLOCKED_CARGO_INVENTORY_ID}, ${BLOCKED_VEHICLE_ID}, 0, 20, 2000);
  insert into dune.actor_state (actor_id, state) values (${BLOCKED_VEHICLE_ID}, 'VehicleRecovery');

  insert into dune.items (id, inventory_id, stack_size, position_index, template_id, stats, quality_level, volume_override) values
    (7001, ${CARGO_INVENTORY_ID}, 162, 5, 'JasmiumCrystal', '{}'::jsonb, 0, 1.5),
    -- Same template as above in a different slot: the per-slot view exists so
    -- these stay two rows rather than one merged 202.
    (7002, ${CARGO_INVENTORY_ID}, 40, 2, 'JasmiumCrystal', '{}'::jsonb, 0, 1.5),
    (7003, ${CARGO_INVENTORY_ID}, 1, 7, 'Mk5Cutteray',
      '{"FItemStackAndDurabilityStats":[null,{"CurrentDurability":"300","MaxDurability":"600"}],
        "FAugmentedItemStats":[null,{"AppliedAugments":[{"Name":"T6_Augment_UnitTestFixture1"}],"AppliedAugmentQualities":[3]}]}'::jsonb,
      4, 12),
    -- Items in the decoy component holds and in the other vehicle's hold:
    -- neither may appear in this vehicle's contents, nor be deletable through
    -- this vehicle's routes.
    (7004, ${COMPONENT_INVENTORY_IDS[0]}, 99, 0, 'ComponentHoldDecoy', '{}'::jsonb, 0, null),
    (7005, ${OTHER_CARGO_INVENTORY_ID}, 7, 0, 'OtherVehicleSpice', '{}'::jsonb, 0, null),
    (7006, ${PLACEABLE_INVENTORY_ID}, 500, 0, 'PlaceableScrapMetal', '{}'::jsonb, 0, null),
    -- volume_override 0 rather than null on purpose: a null here would make
    -- this row's unit volume unknown and flip volumeComplete to false for the
    -- whole hold, which is a different behaviour than the volume test means to
    -- exercise.
    (${BIG_ITEM_ID}, ${CARGO_INVENTORY_ID}, 3, 9, 'BigIdStone', '{}'::jsonb, 0, 0),
    (7007, ${BLOCKED_CARGO_INVENTORY_ID}, 12, 0, 'StashedSpice', '{}'::jsonb, 0, null);
`;
