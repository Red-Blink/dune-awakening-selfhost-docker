import assert from "node:assert/strict";
import test from "node:test";
import {
  factionDisplayName,
  factionIdByName,
  factionTierBumps,
  craftingRecipeCatalogRows,
  compareJourneyCatalogOrder,
  journeyDepth,
  journeyCompletionNodeIds,
  journeyDisplayName,
  journeyParentId,
  recipeCategory,
  recipeDisplayName,
  repairTarget,
  researchCategory,
  researchDisplayName,
  researchProductGroup,
  researchRecipeId,
  researchType,
  schematicRecipeId,
  tagsForJourneyNodeSubtree,
  tutorialStatus,
  validateMapName,
  validateRecipeId,
  validateResearchKey,
  validateTemplateId,
  xpToLevel
} from "../src/duneDb/presentation.js";

test("xpToLevel maps cumulative XP thresholds", () => {
  assert.equal(xpToLevel(0), 0);
  assert.equal(xpToLevel(39), 1);
  assert.equal(xpToLevel(40), 1);
  assert.equal(xpToLevel(344440), 200);
});

test("display helpers normalize game identifiers", () => {
  assert.equal(factionDisplayName({ faction_name: "Atreides", faction_id: 1 }), "Atreides");
  assert.equal(factionDisplayName({ faction_name: "", faction_id: 9 }), "Faction 9");
  assert.equal(journeyDisplayName("DA_ChapterOne.Step2"), "Step 2");
  assert.equal(journeyDisplayName("DA_MQ_NPEAutocompleted", {
    DA_MQ_NPEAutocompleted: "The Fall of the Proteus"
  }), "The Fall of the Proteus");
  assert.equal(recipeDisplayName("Buggy_TreadWheel_Recipe"), "Buggy Tread Wheel");
  assert.equal(researchDisplayName("RCP_SandbikeEnginePatent"), "Sandbike Engine");
});

test("journey tree helpers resolve parents, depth, and subtree tags", () => {
  const ids = ["Root", "Root.Branch", "Root.Branch.Leaf"];
  assert.equal(journeyParentId("Root.Branch.Leaf", ids), "Root.Branch");
  assert.equal(journeyDepth("Root.Branch.Leaf", ids), 2);
  assert.deepEqual(tagsForJourneyNodeSubtree("Root", {
    journey_node_tags: {
      Root: ["Tag.A"],
      "Root.Branch": ["Tag.B"],
      Other: ["Tag.C"]
    }
  }), ["Tag.A", "Tag.B"]);
  assert.deepEqual(journeyCompletionNodeIds("Root.Branch.Leaf", {
    journey_node_tags: {
      "Root.Branch.Leaf.Child": ["Tag.C"],
      Other: ["Tag.D"]
    }
  }), ["Root.Branch", "Root.Branch.Leaf", "Root.Branch.Leaf.Child"]);
});

test("journey catalog ordering follows explicit sibling sequences", () => {
  const parent = "DA_SQ_VermiliusGap.Relocate.RelocateOutsideHBS";
  const drive = `${parent}.Drive north to the Vermilius Gap`;
  const research = `${parent}.ResearchAdvTotem`;
  const construct = `${parent}.ConstructAdvTotem`;
  const destroy = `${parent}.DestroyYourBase`;
  const data = { journey_children: { [parent]: [drive, research, construct, destroy] } };
  assert.deepEqual(
    [construct, destroy, drive, research].sort((a, b) => compareJourneyCatalogOrder(a, b, data)),
    [drive, research, construct, destroy]
  );
});

test("category helpers classify common recipe and research identifiers", () => {
  assert.equal(recipeCategory("Sandbike_Frame_Recipe"), "Vehicles");
  assert.equal(recipeCategory("Stillsuit_Recipe"), "Water Discipline");
  assert.equal(researchType("RCP_Sandbike"), "Recipe");
  assert.equal(researchRecipeId("RCP_Sandbike"), "Sandbike");
  assert.equal(researchRecipeId("BLD_WaterCistern_Patent"), "WaterCistern_Patent");
  assert.equal(researchRecipeId("BLD_Windtrap"), "Windtrap_Patent");
  assert.equal(researchCategory("BLD_Turbine"), "Construction");
  assert.equal(researchProductGroup("T5_DuraluminumThing"), "Duraluminum Products");
});

test("schematic catalog helpers map item schematics to crafting recipes", () => {
  assert.equal(schematicRecipeId("HealthPackSchematic"), "HealthPackRecipe");
  assert.equal(schematicRecipeId("Bloodsack_Unique_Durable_02_Schematic"), "Bloodsack_Unique_Durable_02_Recipe");
  assert.equal(schematicRecipeId("Schematic_UniqueBattleRifle"), "UniqueBattleRifleRecipe");
  assert.equal(schematicRecipeId("NPE_ScrapMetalKnife_Schematic"), "ScrapMetalKnifeRecipe");
  assert.deepEqual(craftingRecipeCatalogRows([
    { id: "HealthPackSchematic", name: "Healkit", category: "schematics" },
    { id: "WaterCistern_Patent", name: "Water Cistern Patent", category: "buildings" }
  ]), [
    {
      recipeId: "HealthPackRecipe",
      displayName: "Healkit",
      category: "Essentials",
      source: "Schematics",
      qualityLevel: 0
    },
    {
      recipeId: "WaterCistern_Patent",
      displayName: "Water Cistern Patent",
      category: "Water Discipline",
      source: "Building Patents",
      qualityLevel: 0
    }
  ]);
});

test("validation helpers reject unsafe identifiers", () => {
  assert.equal(validateRecipeId("Crafting_Recipe-01"), "Crafting_Recipe-01");
  assert.equal(validateResearchKey("RCP_Item+01"), "RCP_Item+01");
  assert.equal(validateTemplateId("/Game/Dune/Item:01"), "/Game/Dune/Item:01");
  assert.equal(validateMapName("Survival_1:2"), "Survival_1:2");
  assert.throws(() => validateRecipeId("bad recipe"));
  assert.throws(() => validateResearchKey("bad/value"));
  assert.throws(() => validateTemplateId("bad value"));
  assert.throws(() => validateMapName("bad/value"));
});

test("faction and repair helpers keep mutation math predictable", () => {
  assert.equal(factionIdByName("Atreides"), 1);
  assert.equal(factionIdByName("Unknown"), 0);
  assert.deepEqual([...factionTierBumps(["Faction.Atreides.Tier2", "Faction.Harkonnen.Tier0"])], [["Atreides", 250]]);
  assert.equal(repairTarget({ MaxDurability: 100, CurrentDurability: 40, DecayedDurability: 10 }), 100);
  assert.equal(repairTarget({ MaxDurability: 100, CurrentDurability: 100, DecayedDurability: 100 }), 0);
  assert.equal(tutorialStatus(2), "Complete");
});
