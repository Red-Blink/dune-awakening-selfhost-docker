import assert from "node:assert/strict";
import test from "node:test";
import { planJourneyChange } from "../src/duneDb/journeyProgress.js";

const trial = "DA_MQ_FindTheFremen.FirstTest";
const question = trial + ".FirstQuestion";
const altar = question + ".CompleteFirstTest";
const second = "DA_MQ_FindTheFremen.SecondTest";
const caveProgress = { 0: { Count: 0 }, 1: { Count: 0 } };
function row(id, complete, reveal = true) {
  return { story_node_id: id, complete_condition_state: complete, reveal_condition_state: reveal };
}
const priorSteps = [row(question + ".FindAltarCave", true), row(question + ".FindtheCaveentrance", true)];

test("completing the altar rolls up only finished parents and preserves the second trial's map progress", () => {
  const plan = planJourneyChange([...priorSteps, row(second, {}, { 0: {}, 1: caveProgress })], new Set(), altar, true);
  const changes = new Map(plan.changes.map(change => [change.id, change]));
  assert.equal(changes.get(question).complete, true);
  assert.equal(changes.get(trial).complete, true);
  assert.notEqual(changes.get("DA_MQ_FindTheFremen")?.complete, true);
  assert.deepEqual(changes.get(second).reveal, { 0: { Done: 1 }, 1: caveProgress });
  assert.equal(plan.recipes.length, 4);
  assert.ok(plan.add.includes("JourneySets.Fremkit.Stillsuit"));
  assert.ok(plan.add.includes("Journey.SpiceDream.Completed1"));
});

test("resetting a leaf invalidates completed parents and only its prerequisite in an existing reveal map", () => {
  const rows = [...priorSteps, row(altar, true), row(question, true), row(trial, true),
    row(second, {}, { 0: { Done: 1 }, 1: caveProgress })];
  const plan = planJourneyChange(rows, new Set(["JourneySets.Fremkit.Stillsuit"]), altar, false);
  const changes = new Map(plan.changes.map(change => [change.id, change]));
  for (const id of [altar, question, trial]) {
    assert.deepEqual(changes.get(id).complete, {});
    assert.equal(changes.get(id).reveal, true);
    assert.ok(plan.clearCooldowns.includes(id));
  }
  assert.deepEqual(changes.get(second).reveal, { 0: {}, 1: caveProgress });
  assert.deepEqual(plan.remove, ["JourneySets.Fremkit.Stillsuit"]);
});

test("reset refuses to guess which map condition was satisfied after the game collapsed the state", () => {
  assert.throws(() => planJourneyChange([row(trial, true), row(second, {}, true)], new Set(), trial, false),
    /cannot be reconstructed/);
});

test("a map area already discovered is enough to reveal the Second Trial on First Trial completion", () => {
  const rows = [row(second, {}, { 0: {}, 1: { 0: { Count: 0 }, 1: { Count: 1 } } })];
  const plan = planJourneyChange(rows, new Set(), trial, true);
  assert.equal(plan.changes.find(change => change.id === second).reveal, true);
});

test("Copper Required updates only existing tag counters and leaves other contract conditions alone", () => {
  const tag = "Contract.UniqueInstance.Journey.FirstContractDone";
  const id = "DA_MQ_ANewBeginning.Reach Civilization.Tradepost.PickupContract";
  const previous = { 0: { Count: 2 }, 2: { Count: 0 } };
  const result = planJourneyChange([row(id, previous)], new Set([tag]), null, true, [tag]);
  assert.deepEqual(result.changes, [{ id, complete: { 0: { Count: 2 }, 2: { Count: 1 } }, reveal: true }]);
});
