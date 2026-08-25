import test from "node:test";
import assert from "node:assert/strict";
import { vehicleSubtypeFromClass } from "../src/duneDb.js";

test("vehicleSubtypeFromClass recognizes every known vehicle blueprint", () => {
  const cases = [
    ["/Game/Dune/Systems/Vehicles/Blueprints/GroundVehicles/BP_Sandbike_CHOAM.BP_Sandbike_CHOAM_C", "Sandbike"],
    ["/Game/Dune/Systems/Vehicles/Blueprints/GroundVehicles/BP_Buggy_CHOAM.BP_Buggy_CHOAM_C", "Buggy"],
    ["/Game/Dune/Systems/Vehicles/Blueprints/GroundVehicles/BP_SandCrawler_CHOAM.BP_SandCrawler_CHOAM_C", "SandCrawler"],
    ["/Game/Dune/Systems/Vehicles/Blueprints/GroundVehicles/BP_TreadWheel.BP_TreadWheel_C", "TreadWheel"],
    ["/Game/Dune/Systems/Vehicles/Blueprints/GroundVehicles/BP_ContainerVehicle.BP_ContainerVehicle_C", "ContainerVehicle"],
    ["/Game/Dune/Systems/Vehicles/Blueprints/FlyingVehicles/BP_LightOrnithopter_Choam.BP_LightOrnithopter_Choam_C", "LightOrnithopter"],
    ["/Game/Dune/Systems/Vehicles/Blueprints/FlyingVehicles/BP_MediumOrnithopter_CHOAM.BP_MediumOrnithopter_CHOAM_C", "MediumOrnithopter"],
    ["/Game/Dune/Systems/Vehicles/Blueprints/FlyingVehicles/BP_TransportOrnithopter_CHOAM.BP_TransportOrnithopter_CHOAM_C", "TransportOrnithopter"],
    ["/Game/Dune/Systems/Vehicles/Blueprints/FlyingVehicles/BP_AssaultOrnithopter_CHOAM.BP_AssaultOrnithopter_CHOAM_C", "AssaultOrnithopter"]
  ];
  for (const [rawClass, expected] of cases) {
    assert.equal(vehicleSubtypeFromClass(rawClass), expected);
  }
});

test("vehicleSubtypeFromClass falls back to a bare Ornithopter for an unnamed variant", () => {
  assert.equal(vehicleSubtypeFromClass("/Game/.../BP_Ornithopter_CHOAM.BP_Ornithopter_CHOAM_C"), "Ornithopter");
});

test("vehicleSubtypeFromClass checks Assault before the generic Ornithopter pattern", () => {
  assert.equal(vehicleSubtypeFromClass("BP_OrnithopterAssault_CHOAM_C"), "AssaultOrnithopter");
});

test("vehicleSubtypeFromClass falls back to Other for an unrecognized or empty class", () => {
  assert.equal(vehicleSubtypeFromClass("/Game/Dune/Systems/Vehicles/Blueprints/GroundVehicles/BP_Tank_CHOAM.BP_Tank_CHOAM_C"), "Tank");
  assert.equal(vehicleSubtypeFromClass(""), "Other");
  assert.equal(vehicleSubtypeFromClass(null), "Other");
  assert.equal(vehicleSubtypeFromClass(undefined), "Other");
  assert.equal(vehicleSubtypeFromClass("/Game/Dune/Systems/Vehicles/Blueprints/GroundVehicles/BP_SomethingNew_CHOAM.BP_SomethingNew_CHOAM_C"), "Other");
});
