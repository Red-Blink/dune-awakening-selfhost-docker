-- Console imports used ordinary one-based PostgreSQL arrays before v1.4.26
-- and were verified in game. v1.4.26 changed those rows to explicit zero-based
-- bounds without runtime evidence. Restore only Console-owned imports, which
-- are identified by building_blueprints.player_id. Native Funcom blueprints
-- have player_id IS NULL and must retain their native array metadata.

DO $patch$
DECLARE
  repaired_instances bigint := 0;
  repaired_placeables bigint := 0;
  repaired_pentashields bigint := 0;
BEGIN
  IF to_regclass('dune.building_blueprints') IS NOT NULL
     AND to_regclass('dune.building_blueprint_instances') IS NOT NULL THEN
    UPDATE dune.building_blueprint_instances child
       SET transform = ARRAY[
         child.transform[0], child.transform[1], child.transform[2], child.transform[3]
       ]::real[]
      FROM dune.building_blueprints blueprint
     WHERE child.building_blueprint_id = blueprint.id
       AND blueprint.player_id IS NOT NULL
       AND array_lower(child.transform, 1) = 0
       AND array_length(child.transform, 1) = 4;
    GET DIAGNOSTICS repaired_instances = ROW_COUNT;
  END IF;

  IF to_regclass('dune.building_blueprints') IS NOT NULL
     AND to_regclass('dune.building_blueprint_placeables') IS NOT NULL THEN
    UPDATE dune.building_blueprint_placeables child
       SET transform = ARRAY[
         child.transform[0], child.transform[1], child.transform[2],
         child.transform[3], child.transform[4], child.transform[5]
       ]::real[]
      FROM dune.building_blueprints blueprint
     WHERE child.building_blueprint_id = blueprint.id
       AND blueprint.player_id IS NOT NULL
       AND array_lower(child.transform, 1) = 0
       AND array_length(child.transform, 1) = 6;
    GET DIAGNOSTICS repaired_placeables = ROW_COUNT;
  END IF;

  IF to_regclass('dune.building_blueprints') IS NOT NULL
     AND to_regclass('dune.building_blueprint_pentashields') IS NOT NULL THEN
    UPDATE dune.building_blueprint_pentashields child
       SET scale = ARRAY[child.scale[0], child.scale[1], child.scale[2]]::smallint[]
      FROM dune.building_blueprints blueprint
     WHERE child.building_blueprint_id = blueprint.id
       AND blueprint.player_id IS NOT NULL
       AND array_lower(child.scale, 1) = 0
       AND array_length(child.scale, 1) = 3;
    GET DIAGNOSTICS repaired_pentashields = ROW_COUNT;
  END IF;

  -- A database-wide marker cannot identify the importer that wrote an
  -- individual blueprint. Preserve every rotation component, including on
  -- restores without the old yaw migration marker.
  RAISE NOTICE 'Restored Console blueprint arrays: % instances, % placeables, % pentashields.',
    repaired_instances, repaired_placeables, repaired_pentashields;
END
$patch$;
