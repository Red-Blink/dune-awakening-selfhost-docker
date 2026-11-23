import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

// Cooked card conditions from client build 26592269 (NetCL 2181988).
// O is an opaque game condition. Its counter target is absent from the export.
export const journeyCards = JSON.parse(readFileSync(new URL("./journey-cards.json", import.meta.url), "utf8"));
const parents = new Map();
const dependents = new Map();
// The two map-area discoveries in the Second Trial are one-time events.
// Other opaque Count conditions can have different thresholds.
const secondTrialAreas = new Set(journeyCards["DA_MQ_FindTheFremen.SecondTest"].r.c[1].c);
function indexCondition(id, condition) {
  if (condition?.t === "N") {
    const key = condition.n + (condition.s === "Revealed" ? ":reveal" : ":complete");
    if (!dependents.has(key)) dependents.set(key, new Set());
    dependents.get(key).add(id);
  }
  for (const part of condition?.c || []) indexCondition(id, part);
}
for (const [id, card] of Object.entries(journeyCards)) {
  for (const child of card.c || []) parents.set(child, id);
  indexCondition(id, card.r);
  indexCondition(id, card.k);
}

function evaluate(condition, previous, states, tags, changedNodes) {
  if (condition.t === "O") {
    const isMapArea = secondTrialAreas.has(condition);
    const met = previous === true || (isMapArea && previous?.Count >= 1);
    return { value: previous ?? (isMapArea ? { Count: 0 } : undefined), met, touched: false };
  }
  if (condition.t === "C") {
    const parts = condition.c.map((part, index) =>
      evaluate(part, previous?.[index], states, tags, changedNodes));
    const met = condition.op === "And" ? parts.every(p => p.met) : parts.some(p => p.met);
    const touched = parts.some(p => p.touched);
    if (!touched && previous === true) return { met: true, touched: false, value: true };
    // A collapsed map no longer says which opaque condition was satisfied.
    // Refuse to invent or erase progress when reversing such a dependency.
    if (previous === true && touched && !met && containsOpaque(condition)) {
      throw new Error("This journey condition includes game-tracked progress that cannot be reconstructed after completion.");
    }
    const value = { ...previous };
    parts.forEach((part, index) => {
      if ((part.touched || !Object.hasOwn(value, index)) && part.value !== undefined) value[index] = part.value;
    });
    return { met, touched, value: met ? true : value };
  }
  if (condition.t === "G") {
    const met = tags.has(condition.g);
    return { met, touched: false, value: previous ?? { Count: Number(met) } };
  }
  const field = condition.s === "Revealed" ? "reveal" : "complete";
  const met = states.get(condition.n)?.[field] === true;
  return { met, touched: changedNodes.has(condition.n + ":" + field), value: met ? { Done: 1 } : {} };
}

function containsOpaque(condition) {
  return condition.t === "O" || (condition.c || []).some(containsOpaque);
}

// Tracked counters are game state. A tag notification updates counters the
// game already tracks, including counters inside an otherwise opaque map.
function refreshTagCounters(condition, state, tags, events) {
  if (!state || typeof state !== "object") return state;
  if (condition.t === "G" && events.has(condition.g) && Object.hasOwn(state, "Count")) {
    return { ...state, Count: Number(tags.has(condition.g)) };
  }
  if (condition.t !== "C") return state;
  const next = { ...state };
  condition.c.forEach((part, index) => {
    if (Object.hasOwn(state, index)) next[index] = refreshTagCounters(part, state[index], tags, events);
  });
  return next;
}

export function planJourneyChange(rows, currentTags, selected, completing, tagEvents = []) {
  const states = new Map(rows.map(row => [row.story_node_id, {
    complete: row.complete_condition_state, reveal: row.reveal_condition_state
  }]));
  const original = new Map(states);
  const selectedIds = new Set([...Object.keys(journeyCards), ...states.keys()].filter(id =>
    id === selected || id.startsWith(selected + ".")));
  const tags = new Set(currentTags);
  const cleared = new Set();
  let changedNodes = new Set();
  let changedTags = new Set(tagEvents);
  function set(id, field, value) {
    const before = states.get(id) || { complete: {}, reveal: {} };
    if (states.has(id) && isDeepStrictEqual(before[field], value)) return;
    states.set(id, { ...before, [field]: value });
    if ((before[field] === true) === (value === true)) return;
    changedNodes.add(id + ":" + field);
    if (field === "complete" && value !== true) cleared.add(id);
  }
  for (const id of selectedIds) {
    if (completing) set(id, "reveal", true);
    if (completing || states.has(id)) set(id, "complete", completing ? true : {});
    // Also repair dependencies of nodes completed by older Console versions.
    if (completing) {
      changedNodes.add(id + ":complete");
      changedNodes.add(id + ":reveal");
    }
  }
  const recipes = new Set();
  // Each pass propagates transitions to their immediate consumers. A completion
  // only moves forward, and a reset only invalidates prior completions.
  for (let pass = 0; changedNodes.size || changedTags.size; pass++) {
    if (pass > journeyCardsCount) throw new Error("Journey dependencies did not converge.");
    const nodes = changedNodes;
    const tagEvents = changedTags;
    changedNodes = new Set();
    changedTags = new Set();
    for (const event of nodes) {
      if (!event.endsWith(":complete")) continue;
      const id = event.slice(0, -9);
      const card = journeyCards[id] || {};
      const complete = states.get(id)?.complete === true;
      if (complete) for (const recipe of card.recipes || []) recipes.add(recipe);
      const wasComplete = original.get(id)?.complete === true;
      const add = complete && !wasComplete ? card.ta || [] : [];
      let remove = [];
      if (complete && !wasComplete) remove = card.tr || [];
      if (!complete && wasComplete) remove = card.ta || [];
      for (const tag of add) {
        if (!tags.has(tag)) { tags.add(tag); changedTags.add(tag); }
      }
      for (const tag of remove) {
        if (!complete && [...states].some(([key, state]) => state.complete === true && journeyCards[key]?.ta?.includes(tag))) continue;
        if (tags.delete(tag)) changedTags.add(tag);
      }
      const parent = parents.get(id);
      if (!parent || journeyCards[parent].k) continue;
      if (complete && journeyCards[parent].c.every(child => states.get(child)?.complete === true)) {
        set(parent, "complete", true);
      } else if (!complete && states.get(parent)?.complete === true) {
        set(parent, "complete", {});
      }
    }
    const candidates = new Set(states.keys());
    if (completing) for (const event of nodes) {
      for (const id of dependents.get(event) || []) candidates.add(id);
    }
    for (const id of candidates) {
      const state = states.get(id) || { complete: {}, reveal: {} };
      if (selectedIds.has(id)) continue;
      const card = journeyCards[id];
      for (const [field, condition] of [["complete", card?.k], ["reveal", card?.r]]) {
        if (!condition || (completing && state[field] === true)) continue;
        const prior = tagEvents.size ? refreshTagCounters(condition, state[field], tags, tagEvents) : state[field];
        if (!nodes.size) {
          if (!isDeepStrictEqual(prior, state[field])) set(id, field, prior);
          continue;
        }
        const next = evaluate(condition, prior, states, tags, nodes);
        if (next.touched) set(id, field, next.met ? true : next.value);
        else if (!isDeepStrictEqual(prior, state[field])) set(id, field, prior);
      }
    }
  }
  return {
    changes: [...states].filter(([id, row]) => !isDeepStrictEqual(original.get(id), row))
      .map(([id, state]) => ({ id, ...state })),
    add: [...tags].filter(tag => !currentTags.has(tag)),
    remove: [...currentTags].filter(tag => !tags.has(tag)),
    recipes: [...recipes], clearCooldowns: [...new Set([...selectedIds, ...cleared])]
  };
}
const journeyCardsCount = Object.keys(journeyCards).length;
