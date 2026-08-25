import { afterEach, describe, expect, it } from "vitest";
import {
  clearDefaultLayerFilters,
  clearDefaultSubtypeLayerFilters,
  loadDefaultLayerFilters,
  loadDefaultSubtypeLayerFilters,
  saveDefaultLayerFilters,
  saveDefaultSubtypeLayerFilters
} from "./liveMapLayerDefaults";

afterEach(() => {
  window.localStorage.clear();
});

describe("liveMapLayerDefaults (category-level)", () => {
  it("returns null when nothing has been saved yet", () => {
    expect(loadDefaultLayerFilters()).toBeNull();
  });

  it("round-trips whatever was saved", () => {
    saveDefaultLayerFilters({ player: true, hazard: false });
    expect(loadDefaultLayerFilters()).toEqual({ player: true, hazard: false });
  });

  it("clearing removes the saved value so load falls back to null again", () => {
    saveDefaultLayerFilters({ player: false });
    clearDefaultLayerFilters();
    expect(loadDefaultLayerFilters()).toBeNull();
  });

  it("ignores malformed stored JSON instead of throwing", () => {
    window.localStorage.setItem("duneLiveMapDefaultLayers", "{not json");
    expect(loadDefaultLayerFilters()).toBeNull();
  });

  it("drops non-boolean entries rather than passing them through", () => {
    window.localStorage.setItem("duneLiveMapDefaultLayers", JSON.stringify({ player: true, vehicle: "yes", base: 1 }));
    expect(loadDefaultLayerFilters()).toEqual({ player: true });
  });

  it("returns null for a stored value that isn't a plain object", () => {
    window.localStorage.setItem("duneLiveMapDefaultLayers", JSON.stringify(["player", "vehicle"]));
    expect(loadDefaultLayerFilters()).toBeNull();
  });
});

describe("liveMapLayerDefaults (sub-type level)", () => {
  it("returns null when nothing has been saved yet", () => {
    expect(loadDefaultSubtypeLayerFilters()).toBeNull();
  });

  it("round-trips a nested category -> subtype -> boolean map", () => {
    saveDefaultSubtypeLayerFilters({ hazard: { Hazard_Quicksand: false, Hazard_Radiation: true }, ore: { AzuriteOre: true } });
    expect(loadDefaultSubtypeLayerFilters()).toEqual({ hazard: { Hazard_Quicksand: false, Hazard_Radiation: true }, ore: { AzuriteOre: true } });
  });

  it("clearing removes the saved value", () => {
    saveDefaultSubtypeLayerFilters({ hazard: { Hazard_Quicksand: false } });
    clearDefaultSubtypeLayerFilters();
    expect(loadDefaultSubtypeLayerFilters()).toBeNull();
  });

  it("ignores malformed stored JSON instead of throwing", () => {
    window.localStorage.setItem("duneLiveMapDefaultSubtypeLayers", "{not json");
    expect(loadDefaultSubtypeLayerFilters()).toBeNull();
  });

  it("drops non-boolean leaf entries and empty categories", () => {
    window.localStorage.setItem("duneLiveMapDefaultSubtypeLayers", JSON.stringify({
      hazard: { Hazard_Quicksand: false, Hazard_Radiation: "yes" },
      ore: { AzuriteOre: 1 },
      poi: "not an object"
    }));
    expect(loadDefaultSubtypeLayerFilters()).toEqual({ hazard: { Hazard_Quicksand: false } });
  });

  it("returns null for a stored value that isn't a plain object", () => {
    window.localStorage.setItem("duneLiveMapDefaultSubtypeLayers", JSON.stringify(["hazard"]));
    expect(loadDefaultSubtypeLayerFilters()).toBeNull();
  });
});
