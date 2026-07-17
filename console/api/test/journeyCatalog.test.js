import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const catalog = JSON.parse(readFileSync(
  new URL("../../../runtime/data/journey-tags.json", import.meta.url),
  "utf8"
));

test("journey catalog contains the verified official display names", () => {
  assert.equal(Object.keys(catalog.journey_aliases).length, 971);
  assert.equal(catalog.journey_aliases.DA_MQ_NPEAutocompleted, "The Fall of the Proteus");
  assert.equal(catalog.journey_aliases.DA_FQ_ClimbTheRanks, "The War of Assassins");
  assert.equal(catalog.journey_aliases.DA_SQ_OverlandMap, "Greater Arrakis");
});

test("every ordered journey child has an official display name", () => {
  for (const [parent, children] of Object.entries(catalog.journey_children)) {
    assert.equal(new Set(children).size, children.length, `${parent} contains duplicate children`);
    for (const child of children) {
      assert.equal(typeof catalog.journey_aliases[child], "string", `${child} has no display name`);
      assert.equal(catalog.journey_aliases[child], catalog.journey_aliases[child].trim(), `${child} has surrounding whitespace`);
    }
  }
});

test("top-level journeys retain the reference website order", () => {
  assert.deepEqual(catalog.journey_children[""], [
    "DA_MQ_ANewBeginning",
    "DA_SQ_DeepDesert",
    "DA_MQ_FindTheFremen",
    "DA_SQ_OverlandMap",
    "DA_SQ_JabalEifrit",
    "DA_DLC_LostHarvest",
    "DA_SQ_Taxation",
    "DA_SQ_Oodham",
    "DA_MQ_AssassinsHandbook",
    "DA_MQ_NPEAutocompleted",
    "DA_MQ_TheGreatConvention",
    "DA_MQ_TheGreatConventionPt2",
    "DA_SQ_Sheol",
    "DA_FQ_ClimbTheRanks",
    "DA_SQ_VermiliusGap"
  ]);
});

test("Moving On objectives use official names and reference order", () => {
  const parent = "DA_SQ_VermiliusGap.Relocate.RelocateOutsideHBS";
  const expected = [
    [`${parent}.Drive north to the Vermilius Gap`, "Drive north to the Vermillius Gap"],
    [`${parent}.ResearchAdvTotem`, "Research the Advanced Construction Kit"],
    [`${parent}.ConstructAdvTotem`, "Construct or interact with an Advanced Sub-Fief Console"],
    [`${parent}.DestroyYourBase`, "Open the map and abandon your base(s) in Hagga Basin South"]
  ];
  assert.equal(catalog.journey_aliases[parent], "Move your base to a new area");
  assert.deepEqual(catalog.journey_children[parent], expected.map(([id]) => id));
  for (const [id, name] of expected) assert.equal(catalog.journey_aliases[id], name);
});

test("journey catalog includes Sietch interaction completion metadata", () => {
  assert.deepEqual(
    catalog.journey_node_tags["DA_MQ_FindTheFremen.TheSietch.SietchLocationParent.SietchInteractions"],
    [
      "Journey.TheSietch.Interactions.Lesson1Completed",
      "Journey.TheSietch.Interactions.Lesson2Completed",
      "Journey.TheSietch.Interactions.Lesson3Completed",
      "Journey.TheSietch.Interactions.DeathStillInteracted",
      "Journey.TheSietch.Interactions.SafeInteracted"
    ]
  );
});
