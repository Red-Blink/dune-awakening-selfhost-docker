// Schema, Funcom-helper stand-ins and seed data for
// test/baseBackups.integration.test.js.
//
// Tables carry the production constraints (primary keys, foreign keys with
// their ON DELETE actions, unique, check and NOT NULL constraints) and column
// types, read from a live server's game database -- a hand-written schema
// that drops a real constraint can hide a real write bug.
//
// The dune._character_transfer_* functions are stand-ins written for these
// tests. They implement the behaviour the module relies on -- the reference
// rules of _character_transfer_get_filter for the kinds a base backup uses,
// id allocation, and the "!!act#id" rewriting of embedded references -- but
// they are not the game's code. They cannot catch the game changing; testing
// the module against a real game database dump does that.

export const BASE_BACKUP_SCHEMA = `
create schema dune;

create type dune.vector as (x double precision, y double precision, z double precision);
create type dune.quaternion as (x double precision, y double precision, z double precision, w double precision);
create type dune.transform as (location dune.vector, rotation dune.quaternion);

create type dune.actorstate as enum (
  'Default', 'Travel', 'VehicleBackup', 'AbortedAuthorityTransfer', 'VehicleRecovery', 'BaseBackup', 'SimulatedLandsraadActor'
);
create table dune.actors (
  id bigserial primary key check (id > 0),
  class text,
  map text,
  transform dune.transform,
  partition_id bigint,
  dimension_index integer not null default 0,
  gas_attributes jsonb not null default '{}',
  properties jsonb not null default '{}',
  owner_account_id bigint,
  serial bigint not null default 0,
  state dune.actorstate not null default 'Default'
);
create table dune.fgl_entities (
  entity_id bigint primary key check (entity_id <> 0),
  components jsonb
);
create table dune.actor_fgl_entities (
  actor_id bigint references dune.actors(id) on delete cascade,
  entity_id bigint unique references dune.fgl_entities(entity_id),
  slot_name text not null,
  unique (actor_id, slot_name)
);
create table dune.permission_actor (
  actor_id bigint primary key references dune.actors(id) on delete cascade,
  actor_name text,
  actor_type smallint not null default 0,
  access_level smallint not null default 3,
  is_child boolean not null default false,
  edited_by_player_id bigint
);
create table dune.permission_actor_rank (
  permission_actor_id bigint not null references dune.permission_actor(actor_id) on delete cascade,
  player_id bigint not null references dune.actors(id) on delete cascade,
  rank smallint not null,
  unique (permission_actor_id, player_id)
);
create table dune.inventories (
  id bigserial primary key check (id > 0),
  actor_id bigint references dune.actors(id) on delete cascade,
  item_id bigint,
  exchange_id bigint,
  vehicle_module_id bigint,
  inventory_type smallint,
  max_item_count integer,
  check (actor_id is not null or exchange_id is not null or item_id is not null or vehicle_module_id is not null)
);
create table dune.items (
  id bigserial primary key,
  inventory_id bigint references dune.inventories(id) on delete cascade,
  stack_size integer check (stack_size > 0),
  position_index integer check (position_index >= 0),
  template_id text,
  stats jsonb
);
alter table dune.inventories add foreign key (item_id) references dune.items(id) on delete cascade;
create table dune.actor_inventories (
  inventory_id bigint references dune.inventories(id) on delete cascade,
  component_name_hash bigint
);
create table dune.buildings (
  id bigint primary key references dune.actors(id) on delete cascade,
  owner_id bigint
);
create table dune.building_instances (
  building_id bigint not null references dune.actors(id) on delete cascade,
  instance_id integer not null,
  building_type text not null,
  transform real[],
  owner_entity_id bigint references dune.fgl_entities(entity_id) on delete set null,
  building_flags integer,
  health real not null,
  shelter smallint not null,
  sand_buildup smallint not null default 0,
  last_placed_by_player_id bigint not null default 0,
  unique (building_id, instance_id)
);
create table dune.placeables (
  id bigint primary key references dune.actors(id) on delete cascade,
  owner_entity_id bigint references dune.fgl_entities(entity_id) on delete set null,
  health real,
  building_type text,
  has_hit_ground boolean not null default false,
  has_buildable_support boolean not null default false,
  is_hologram boolean not null default false,
  last_placed_by_player_id bigint not null default 0
);
create table dune.totems (
  id bigint primary key references dune.actors(id) on delete cascade,
  landclaim_original_global_location real[],
  landclaim_original_global_yaw_rotation real,
  landclaim_vertical_level integer
);
create table dune.base_backups (
  id bigserial primary key check (id > 0),
  player_id bigint references dune.actors(id) on delete cascade,
  base_backup_name text,
  last_edited_by_player_id bigint not null default 0
);
create table dune.base_backup_linked_actors (
  id bigint references dune.base_backups(id) on delete cascade,
  actor_id bigint references dune.actors(id) on delete cascade
);
create table dune.landclaim_segments (
  totem_id bigint references dune.actors(id) on delete cascade,
  grid_location_x bigint,
  grid_location_y bigint
);
create table dune.tax_invoice (
  id bigserial primary key,
  totem_id bigint references dune.actors(id) on delete cascade,
  amount integer
);
create table dune.sinkcharts (
  item_id bigint not null unique references dune.items(id) on delete cascade,
  marker_hash_ids integer[] not null
);
create table dune.building_blueprints (
  id bigserial primary key check (id > 0),
  item_id bigint references dune.items(id) on delete cascade,
  player_id bigint references dune.actors(id) on delete cascade,
  building_blueprint_map text
);
create table dune.building_blueprint_instances (
  building_blueprint_id bigint references dune.building_blueprints(id) on delete cascade,
  instance_id integer,
  building_type text,
  transform real[],
  unique (building_blueprint_id, instance_id)
);
create table dune.building_blueprint_placeables (
  building_blueprint_id bigint references dune.building_blueprints(id) on delete cascade,
  placeable_id integer,
  building_type text,
  transform real[],
  unique (building_blueprint_id, placeable_id)
);
create table dune.building_blueprint_pentashields (
  building_blueprint_id bigint references dune.building_blueprints(id) on delete cascade,
  placeable_id integer,
  scale smallint[],
  unique (building_blueprint_id, placeable_id)
);
-- A view in production; the columns the module reads.
create table dune.player_state (
  id bigserial primary key,
  account_id bigint,
  player_controller_id bigint,
  player_pawn_id bigint,
  character_name text,
  online_status text
);
create table dune.applied_patches (name text primary key, date timestamp not null default now());
`;

// Stand-ins for Funcom's character-transfer helpers (see file header).
export const TRANSFER_HELPER_STUBS = `
create type dune._charactertransferentrykind as enum (
  'act', 'fgl', 'inv', 'itm', 'bbp', 'acc',
  'PermissionActor', 'PermissionActorRank', 'ActorInventory', 'Building', 'BuildingInstance',
  'Placeable', 'Totem', 'BaseBackup', 'BaseBackupLinkedActor', 'LandclaimSegment', 'TaxInvoice',
  'Sinkchart', 'BuildingBlueprintInstance', 'BuildingBlueprintPlaceable', 'BuildingBlueprintPentashield',
  'Character'
);

create table dune._stub_transfer_filter (
  kind dune._charactertransferentrykind primary key,
  id_col text,
  removed text[] not null default '{}',
  refs jsonb not null default '[]'
);
insert into dune._stub_transfer_filter (kind, id_col, removed, refs) values
  ('act', 'id', '{}', '[]'),
  ('fgl', 'entity_id', '{}', '[{"key":"actor_id","kind":"act","required":true}]'),
  ('inv', 'id', '{exchange_id,item_id}', '[{"key":"actor_id","kind":"act","required":false}]'),
  ('itm', 'id', '{}', '[{"key":"inventory_id","kind":"inv","required":true}]'),
  ('bbp', 'id', '{}', '[{"key":"item_id","kind":"itm","required":true},{"key":"player_id","kind":"act","required":false}]'),
  ('PermissionActor', null, '{}', '[{"key":"actor_id","kind":"act","required":true}]'),
  ('PermissionActorRank', null, '{}', '[{"key":"permission_actor_id","kind":"act","required":true},{"key":"player_id","kind":"act","required":true}]'),
  ('ActorInventory', null, '{}', '[{"key":"inventory_id","kind":"inv","required":true}]'),
  ('Building', null, '{}', '[{"key":"id","kind":"act","required":true}]'),
  ('BuildingInstance', null, '{}', '[{"key":"building_id","kind":"act","required":true},{"key":"owner_entity_id","kind":"fgl","required":false}]'),
  ('Placeable', null, '{}', '[{"key":"id","kind":"act","required":true},{"key":"owner_entity_id","kind":"fgl","required":false}]'),
  ('Totem', null, '{}', '[{"key":"id","kind":"act","required":true}]'),
  ('BaseBackup', 'id', '{}', '[{"key":"player_id","kind":"act","required":true}]'),
  ('BaseBackupLinkedActor', null, '{}', '[{"key":"id","kind":"BaseBackup","required":true},{"key":"actor_id","kind":"act","required":true}]'),
  ('LandclaimSegment', null, '{}', '[{"key":"totem_id","kind":"act","required":true}]'),
  ('TaxInvoice', 'id', '{}', '[{"key":"totem_id","kind":"act","required":true}]'),
  ('Sinkchart', null, '{}', '[{"key":"item_id","kind":"itm","required":true}]'),
  ('BuildingBlueprintInstance', null, '{}', '[{"key":"building_blueprint_id","kind":"bbp","required":true}]'),
  ('BuildingBlueprintPlaceable', null, '{}', '[{"key":"building_blueprint_id","kind":"bbp","required":true}]'),
  ('BuildingBlueprintPentashield', null, '{}', '[{"key":"building_blueprint_id","kind":"bbp","required":true}]');

create sequence dune._stub_fgl_entity_id_seq start with 700000;

create function dune._character_transfer_create_data_table() returns void language plpgsql as $$
begin
  create temporary table if not exists export_data (
    id bigint default null,
    transfer_id bigserial primary key not null,
    kind dune._charactertransferentrykind not null,
    data jsonb not null
  ) on commit drop;
  alter sequence pg_temp.export_data_transfer_id_seq restart with 1;
  truncate pg_temp.export_data;
end $$;

create function dune._character_transfer_top_level_export(in_kind dune._charactertransferentrykind, data jsonb)
returns jsonb language plpgsql as $$
declare f record; r jsonb; v_id bigint; v_transfer bigint;
begin
  select * into f from dune._stub_transfer_filter where kind = in_kind;
  data := data - f.removed;
  if f.id_col is not null then data := data - f.id_col; end if;
  for r in select * from jsonb_array_elements(f.refs) loop
    v_id := (data ->> (r ->> 'key'))::bigint;
    if v_id is null then
      if (r ->> 'required')::boolean then raise exception 'Required reference % not found in %', r ->> 'key', data; end if;
      continue;
    end if;
    select transfer_id into v_transfer from pg_temp.export_data
      where kind = (r ->> 'kind')::dune._charactertransferentrykind and id = v_id;
    if v_transfer is null then raise exception 'Id % for % not mapped into a transfer id', v_id, r ->> 'key'; end if;
    data := jsonb_set(data, array[r ->> 'key'], to_jsonb(v_transfer));
  end loop;
  return data;
end $$;

create function dune._character_transfer_top_level_import(in_kind dune._charactertransferentrykind, data jsonb, in_id bigint)
returns jsonb language plpgsql as $$
declare f record; r jsonb; v_transfer bigint; v_local bigint;
begin
  select * into f from dune._stub_transfer_filter where kind = in_kind;
  if f.id_col is not null then data := data || jsonb_build_object(f.id_col, in_id); end if;
  for r in select * from jsonb_array_elements(f.refs) loop
    v_transfer := (data ->> (r ->> 'key'))::bigint;
    if v_transfer is null then
      if (r ->> 'required')::boolean then raise exception 'Missing reference % in import of %', r ->> 'key', in_kind; end if;
      continue;
    end if;
    select id into v_local from pg_temp.export_data
      where kind = (r ->> 'kind')::dune._charactertransferentrykind and transfer_id = v_transfer;
    if v_local is null then raise exception 'Unknown reference % with transfer id %', r ->> 'key', v_transfer; end if;
    data := jsonb_set(data, array[r ->> 'key'], to_jsonb(v_local));
  end loop;
  return data;
end $$;

-- Paths whose reference may point outside the export: the reference becomes
-- "@0" instead of failing. A subset of the game's list, enough for the seed.
create function dune._stub_not_exported_is_expected(path text) returns boolean language sql as $$
  select path = any(array[
    '.stats.FSinkchartsStats.*.CreatorPlayerId',
    '.components.FTotemLandclaimComponent.*.m_PendingStakingUnitsEntityIds.*'
  ]);
$$;

-- Paths whose not-exported reference stands for "the exporting player": the
-- game reads that player's controller (a transfer id) from the export's
-- Character entry and fails with sbMG2$ when there is none. The game's list.
create function dune._stub_not_exported_maps_to_exporting_player(path text) returns boolean language sql as $$
  select path = any(array[
    '.stats.FBuildingBlueprintItemStats.*.BlueprintNameLastEditedByPlayerId'
  ]);
$$;

create function dune._character_transfer_replace_local_id_with_transfer_id_in_json(data jsonb, path text)
returns jsonb language plpgsql as $$
declare k text; v jsonb; result jsonb; s text; v_id bigint; v_transfer bigint;
begin
  if jsonb_typeof(data) = 'object' then
    result := '{}';
    for k, v in select * from jsonb_each(data) loop
      result := result || jsonb_build_object(k, dune._character_transfer_replace_local_id_with_transfer_id_in_json(v, path || '.' || k));
    end loop;
    return result;
  elsif jsonb_typeof(data) = 'array' then
    select coalesce(jsonb_agg(dune._character_transfer_replace_local_id_with_transfer_id_in_json(e, path || '.*') order by o), '[]')
      into result from jsonb_array_elements(data) with ordinality x(e, o);
    return result;
  elsif jsonb_typeof(data) = 'string' and (data #>> '{}') like '!!___#%' then
    s := data #>> '{}';
    v_id := substr(s, 7)::bigint;
    if v_id = 0 then return to_jsonb('!!' || substr(s, 3, 3) || '@0'); end if;
    -- A negative 32-bit id is stored wrapped, as the game does.
    if v_id < 0 and v_id >= -2147483648 then v_id := v_id + 4294967296; end if;
    select transfer_id into v_transfer from pg_temp.export_data
      where kind = substr(s, 3, 3)::dune._charactertransferentrykind and id = v_id;
    if v_transfer is null then
      if dune._stub_not_exported_maps_to_exporting_player(path) then
        v_transfer := (select (e.data ->> 'player_controller_id')::bigint from pg_temp.export_data e where e.kind = 'Character');
        if v_transfer is null then raise exception 'sbMG2$ - No exported player controller to replace % by %', s, path; end if;
      elsif dune._stub_not_exported_is_expected(path) then
        return to_jsonb('!!' || substr(s, 3, 3) || '@0');
      else
        raise exception 'Id % by % was not exported', s, path;
      end if;
    end if;
    return to_jsonb('!!' || substr(s, 3, 3) || '@' || v_transfer);
  end if;
  return data;
end $$;

create function dune._character_transfer_replace_transfer_id_with_local_id_in_json(data jsonb, path text)
returns jsonb language plpgsql as $$
declare k text; v jsonb; result jsonb; s text; v_local bigint;
begin
  if jsonb_typeof(data) = 'object' then
    result := '{}';
    for k, v in select * from jsonb_each(data) loop
      result := result || jsonb_build_object(k, dune._character_transfer_replace_transfer_id_with_local_id_in_json(v, path || '.' || k));
    end loop;
    return result;
  elsif jsonb_typeof(data) = 'array' then
    select coalesce(jsonb_agg(dune._character_transfer_replace_transfer_id_with_local_id_in_json(e, path || '.*') order by o), '[]')
      into result from jsonb_array_elements(data) with ordinality x(e, o);
    return result;
  elsif jsonb_typeof(data) = 'string' and (data #>> '{}') ~ '^!![a-z]{3}@[0-9]+$' then
    s := data #>> '{}';
    if substr(s, 7)::bigint = 0 then return to_jsonb('!!' || substr(s, 3, 3) || '#0'); end if;
    select id into v_local from pg_temp.export_data
      where kind = substr(s, 3, 3)::dune._charactertransferentrykind and transfer_id = substr(s, 7)::bigint;
    if v_local is null then raise exception 'Unknown transfer id % at %', s, path; end if;
    return to_jsonb('!!' || substr(s, 3, 3) || '#' || v_local);
  end if;
  return data;
end $$;

create function dune._stub_allocate_id(kind dune._charactertransferentrykind) returns bigint language sql as $$
  select case
    when kind = 'act' then nextval('dune.actors_id_seq')
    when kind = 'inv' then nextval('dune.inventories_id_seq')
    when kind = 'itm' then nextval('dune.items_id_seq')
    when kind = 'fgl' then nextval('dune._stub_fgl_entity_id_seq')
    when kind = 'bbp' then nextval('dune.building_blueprints_id_seq')
    when kind = 'BaseBackup' then nextval('dune.base_backups_id_seq')
    when kind = 'TaxInvoice' then nextval('dune.tax_invoice_id_seq')
    else null
  end;
$$;

create function dune._character_transfer_data_table_load(entries jsonb) returns void language plpgsql as $$
begin
  insert into pg_temp.export_data (id, transfer_id, kind, data)
  select dune._stub_allocate_id(kind), transfer_id, kind, data
  from (
    select (entry ->> 'id')::bigint as transfer_id,
           (entry ->> 'kind')::dune._charactertransferentrykind as kind,
           entry -> 'data' as data
    from jsonb_array_elements(entries) entry
  ) parsed;
end $$;

create function dune._character_transfer_data_table_save() returns jsonb language plpgsql as $$
begin
  return (select jsonb_agg(jsonb_build_object('id', transfer_id, 'kind', kind, 'data', data) order by transfer_id) from pg_temp.export_data);
end $$;

-- The game's own definition, verbatim in effect: delete the linked actors
-- (the foreign keys take their pieces, placeables, storage and items) and the
-- backup row.
create function dune.base_backup_delete(in_base_backup_id bigint) returns void language sql as $$
  delete from dune.actors a where a.id in (
    select bbla.actor_id from dune.base_backup_linked_actors bbla where bbla.id = in_base_backup_id);
  delete from dune.base_backups where id = in_base_backup_id;
$$;

create function dune._character_transfer_get_patches_checksum() returns text language sql as $$
  select md5(coalesce(string_agg(name, ',' order by name), '')) from dune.applied_patches;
$$;
`;

// Source owner (controller 10 / pawn 11) and receiving player (20 / 21).
// Backup 1 holds a totem (100), a building actor (101) with three pieces and
// a storage chest (102). The data deliberately carries what a naive import
// gets wrong: 0-based arrays of two element types, a tilted piece, a 64-bit
// integer in item stats, embedded "!!act#" references, and raw player ids.
export const SOURCE = { controller: 10, pawn: 11, backup: 1, totem: 100, building: 101, chest: 102 };
export const TARGET = { controller: 20, pawn: 21 };
// A live (not picked-up) base owned by the source player: totem 200, a
// building actor (201, the Bases row id) and a door, a lamp and a chest.
export const LIVE = { totem: 200, building: 201, door: 202, lamp: 203, chest: 204 };
export const BIG_INT_TEXT = "9007199254740993"; // 2^53 + 1: JSON.parse would round it

export const BASE_BACKUP_SEED = `
insert into dune.applied_patches (name) values ('PATCH-1'), ('PATCH-2');
insert into dune.actors (id, class) values
  (10, 'BP_DunePlayerController_C'), (11, 'BP_DunePlayerCharacter_C'),
  (20, 'BP_DunePlayerController_C'), (21, 'BP_DunePlayerCharacter_C');
insert into dune.player_state (account_id, player_controller_id, player_pawn_id, character_name, online_status) values
  (1, 10, 11, 'Owner', 'Offline'), (2, 20, 21, 'Receiver', 'Offline');

insert into dune.actors (id, class, map, transform, partition_id, serial, state) values
  (100, 'BP_Totem_Small_C', 'DeepDesert', row(row(160529.125, 1035462.625, 24828.2265625), row(0, 0, 0.3420201433256691, 0.9396926207859082))::dune.transform, 36, 12, 'BaseBackup'),
  (101, 'BP_DuneBuildingBase_C', 'DeepDesert', row(row(160529, 1035462, 24828), row(0, 0, 0, 1))::dune.transform, 36, 3, 'BaseBackup'),
  (102, 'BP_StorageContainer_C', 'DeepDesert', row(row(160600.5, 1035500.25, 24830), row(0.1826, -0.3651, 0.5477, 0.7303))::dune.transform, 36, 7, 'BaseBackup');

insert into dune.fgl_entities (entity_id, components) values
  (5001, '{"FTotemLandclaimComponent": [0, {"m_OwnerActor": "!!act#100"}]}'),
  (5002, '{"FContainer": [0, {}]}'),
  (5003, '{"FPlaceableComponent": [16, {"m_Chest": "!!act#102", "m_None": "!!act#0"}]}');
insert into dune.actor_fgl_entities (actor_id, entity_id, slot_name) values
  (100, 5001, 'Actor'), (100, 5002, 'ContainerInventory'), (102, 5003, 'Actor');

insert into dune.buildings (id, owner_id) values (101, null);
insert into dune.building_instances (building_id, instance_id, building_type, transform, owner_entity_id, health, shelter, last_placed_by_player_id) values
  (101, 0, 'MTX_Smug_Foundation', '[0:6]={161485.88,1036197.1,24474.97,0,0,-0.34202015,0.9396926}', 5001, 1500, 0, 10),
  (101, 1, 'MTX_Smug_Wall', '[0:6]={161485.88,1036197.1,24474.97,0.18257418,-0.36514837,0.5477226,0.73029673}', 5001, 800, 1, 10),
  (101, 2, 'MTX_Smug_Rooftop_01', '[0:6]={1e-07,3.4028235e+38,-0.000123,0,0.70710677,-0.70710677,0}', 5001, 800, 2, 0);

insert into dune.placeables (id, building_type, owner_entity_id, last_placed_by_player_id) values
  (100, 'Totem_Small_Placeable', 5001, 10),
  (102, 'StorageContainer_Placeable', 5001, 10);
insert into dune.totems (id, landclaim_original_global_location, landclaim_original_global_yaw_rotation, landclaim_vertical_level) values
  (100, '[0:2]={160529.12,1035462.625,-0.000123}', -123.456789, 1);
insert into dune.landclaim_segments (totem_id, grid_location_x, grid_location_y) values (100, 1, 2), (100, 1, 3);
insert into dune.permission_actor (actor_id, actor_name, access_level, edited_by_player_id) values (102, 'Chest', 3, 10);

insert into dune.inventories (id, actor_id, inventory_type, max_item_count) values (900, 102, 0, 40);
insert into dune.items (id, inventory_id, stack_size, position_index, template_id, stats) values
  (800, 900, 5, 0, 'Sinkchart_Item', '{"Big": ${BIG_INT_TEXT}, "Ref": "!!act#102", "FSinkchartsStats": [[], {"CreatorPlayerId": "!!act#999"}]}'),
  (801, 900, 1, 1, 'BuildingBlueprint_CopyDevice', '{"FBuildingBlueprintItemStats": [[], {"BuildingBlueprintName": "Stored"}]}');
insert into dune.actor_inventories (inventory_id, component_name_hash) values (900, 1234567890123);
insert into dune.sinkcharts (item_id, marker_hash_ids) values (800, '[0:2]={11,12,13}');
insert into dune.building_blueprints (id, item_id, player_id, building_blueprint_map) values (300, 801, 10, '');
insert into dune.building_blueprint_instances (building_blueprint_id, instance_id, building_type, transform) values
  (300, 0, 'MTX_Smug_Foundation', '[0:3]={1,2,3,90}'),
  (300, 1, 'MTX_Smug_Wall', '{4,5,6,180}');
insert into dune.building_blueprint_pentashields (building_blueprint_id, placeable_id, scale) values
  (300, 0, '[0:2]={1,2,3}');

insert into dune.base_backups (id, player_id, base_backup_name, last_edited_by_player_id) values (1, 10, 'Test Base', 10);
insert into dune.base_backup_linked_actors (id, actor_id) values (1, 100), (1, 101), (1, 102);

-- An unrelated claimed actor that must never be exported.
insert into dune.actors (id, class, map) values (999, 'BP_Other_C', 'HaggaBasin');
insert into dune.permission_actor (actor_id, actor_name) values (999, 'Unrelated');
-- A live claim on another map, which makes HaggaBasin a map bases can be built on.
insert into dune.actors (id, class, map, partition_id) values (998, 'BP_Totem_C', 'HaggaBasin', 7);
insert into dune.totems (id) values (998);

-- A live base, as the game keeps one before it is picked up. What a pickup
-- would not take: the unowned piece, the lamp (no buildable support), the
-- totem's own permissions and invoice, and the building actor's entity and
-- properties (a pickup makes a fresh building actor).
insert into dune.actors (id, class, map, transform, partition_id, serial, properties, state) values
  (200, 'BP_Totem_Small_C', 'HaggaBasin', row(row(1000, 2000, 300), row(0, 0, 0, 1))::dune.transform, 7, 5, '{"Totem": 1}', 'Default'),
  (201, 'BP_DuneBuildingBase_C', 'HaggaBasin', row(row(1000, 2000, 300), row(0, 0, 0, 1))::dune.transform, 7, 9, '{"DamageableActorComponent": {}}', 'Default'),
  (202, 'BP_Door_C', 'HaggaBasin', row(row(1010, 2000, 300), row(0, 0, 0, 1))::dune.transform, 7, 4, '{}', 'Default'),
  (203, 'BP_Lamp_C', 'HaggaBasin', row(row(1020, 2000, 300), row(0, 0, 0, 1))::dune.transform, 7, 2, '{}', 'Default'),
  (204, 'BP_StorageContainer_C', 'HaggaBasin', row(row(1030, 2000, 300), row(0, 0, 0, 1))::dune.transform, 7, 3, '{}', 'Default');
insert into dune.fgl_entities (entity_id, components) values
  (6001, '{"FTotemLandclaimComponent": [0, {"m_OwnerActor": "!!act#200"}]}'),
  (6002, '{"FContainer": [0, {}]}'),
  (6003, '{"FHealthComponent": [0, {"m_CurrentHealth": 0.0}]}'),
  (6004, '{"FDoorComponent": [0, {"m_Totem": "!!act#200"}]}');
insert into dune.actor_fgl_entities (actor_id, entity_id, slot_name) values
  (200, 6001, 'Actor'), (200, 6002, 'ContainerInventory'), (201, 6003, 'Actor'), (202, 6004, 'Actor');
insert into dune.buildings (id, owner_id) values (201, null);
update dune.actors set gas_attributes = '{"Stale": 1}' where id = 201;
insert into dune.building_instances (building_id, instance_id, building_type, transform, owner_entity_id, health, shelter, last_placed_by_player_id) values
  (201, 0, 'Hark_Foundation', '[0:6]={1000,2000,300,0,0,0,1}', 6001, 1500, 0, 10),
  (201, 1, 'Hark_Wall', '[0:6]={1000,2100,300,0,0,0.70710677,0.70710677}', 6001, 800, 1, 10),
  (201, 2, 'Hark_Wall', '[0:6]={1000,2200,300,0,0,0,1}', null, 800, 1, 0);
insert into dune.placeables (id, building_type, owner_entity_id, has_buildable_support, last_placed_by_player_id) values
  (200, 'Totem_Small_Placeable', 6001, true, 10),
  (202, 'Door_Placeable', 6001, true, 10),
  (203, 'Lamp_Placeable', 6001, false, 10),
  (204, 'StorageContainer_Placeable', 6001, true, 10);
insert into dune.totems (id, landclaim_original_global_location, landclaim_original_global_yaw_rotation, landclaim_vertical_level) values
  (200, '[0:2]={1000,2000,300}', 90, 0);
insert into dune.landclaim_segments (totem_id, grid_location_x, grid_location_y) values (200, 5, 5);
insert into dune.permission_actor (actor_id, actor_name, access_level, edited_by_player_id) values
  (200, 'Live Base', 5, 10), (202, 'Door', 3, 10);
insert into dune.permission_actor_rank (permission_actor_id, player_id, rank) values
  (200, 10, 1), (200, 20, 3), (202, 10, 1), (202, 20, 3);
insert into dune.tax_invoice (totem_id, amount) values (200, 50);
insert into dune.inventories (id, actor_id, inventory_type, max_item_count) values (910, 204, 0, 40);
insert into dune.items (id, inventory_id, stack_size, position_index, template_id, stats) values
  (810, 910, 3, 0, 'Water_Item', '{"Ref": "!!act#204"}');

select setval('dune.actors_id_seq', 5000);
select setval('dune.inventories_id_seq', 5000);
select setval('dune.items_id_seq', 5000);
select setval('dune.base_backups_id_seq', 50);
select setval('dune.building_blueprints_id_seq', 5000);
`;
