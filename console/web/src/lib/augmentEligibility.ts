import type { AugmentEffect } from "../components/common/AugmentDropdown";

export type AugmentOption = { id: string; name: string; displayName?: string; effects?: AugmentEffect[] };

export type AugmentableItem = {
  id?: string;
  itemId?: string;
  name?: string;
  templateId?: string;
  template_id?: string;
  category?: string;
  source?: string;
};

import augmentCompatibility from "../../../../runtime/data/augment-compatibility.json";

type AugmentCompatibilityCatalog = {
  augments: Record<string, { name: string; tags: string[]; gradeEffects?: Record<string, string[]>; effectSummary?: string }>;
  methodItems: Record<string, string[]>;
  itemAliases?: Record<string, string[]>;
};

const catalog = augmentCompatibility as AugmentCompatibilityCatalog;
const namedItemTags = new Map(Object.entries(catalog.methodItems).map(([name, tags]) => [normalizeName(name), tags]));
const itemAliasTags = new Map(Object.entries(catalog.itemAliases || {}).map(([id, tags]) => [normalizeName(id), tags]));

function normalizeName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function itemText(item: AugmentableItem) {
  return [
    item.templateId,
    item.template_id,
    item.itemId,
    item.id,
    item.name
  ].filter(Boolean).join(" ").toLowerCase();
}

function itemDisplayName(item: AugmentableItem) {
  return String(item.name || "").trim();
}

export function augmentItemKind(item: AugmentableItem): "schematic" | "clothing" | "weapon" | "other" {
  const text = itemText(item);
  const category = String(item.category || "").toLowerCase();
  const source = String(item.source || "").toLowerCase();
  if (category === "schematics" || source === "schematics" || /_schematic$/i.test(text) || /schematic$/i.test(text)) return "schematic";
  if (
    category === "clothing" ||
    source === "clothing" ||
    /social|castoffs|garment|helmet|boots|gloves|stillsuit|still_suit|suit|top|bottom|shirt|pants|robe|cloak|hood|wearable|clothing|armor|chest|guard/i.test(text)
  ) return "clothing";
  if (
    category === "weapons" ||
    source === "weapons" ||
    /weapon|lasgun|lg\b|choamlg|spitdart|jabal|dmr|rifle|longrifle|logrifle|karpov|battle.?rifle|hark.?ar|unique.?ar|\bar\d*|br\d*|disruptor|smg|lmg|vulcan|atre.?lmg|drillshot|shotgun|scattergun|grda|pyrocket|fireball|flamethrower|rocket|missile|pistol|snubnose|rafiq|maula|sda|choamsda|uniquesda|melee|sword|blade|knife|dirk|rapier|kindjal|minotaur|dualblades|crysknife|dewreaper|ghola|hook/i.test(text)
  ) return "weapon";
  return "other";
}

function inferItemTags(item: AugmentableItem) {
  const nameTags = namedItemTags.get(normalizeName(itemDisplayName(item)));
  if (nameTags?.length) return nameTags;
  for (const value of [item.templateId, item.template_id, item.itemId, item.id]) {
    const aliasTags = itemAliasTags.get(normalizeName(String(value || "")));
    if (aliasTags?.length) return aliasTags;
  }
  return [];
}

export function augmentLimitForItem(item: AugmentableItem) {
  return augmentItemKind(item) === "clothing" ? 2 : 3;
}

export function itemCanUseAugments(item: AugmentableItem) {
  const kind = augmentItemKind(item);
  if (kind !== "clothing" && kind !== "weapon") return false;
  return inferItemTags(item).length > 0;
}

function tagsMatch(itemTags: string[], augmentTags: string[]) {
  return augmentTags.some((augmentTag) => itemTags.some((itemTag) => itemTag === augmentTag || itemTag.startsWith(`${augmentTag}.`)));
}

export function filterAugmentsForItem(item: AugmentableItem, all: AugmentOption[]) {
  const kind = augmentItemKind(item);
  if (kind === "schematic" || kind === "other" || all.length === 0) return [];
  const itemTags = inferItemTags(item);
  if (itemTags.length === 0) return [];
  return all.filter((augment) => {
    const entry = catalog.augments[augment.id];
    return Boolean(entry?.tags?.length) && tagsMatch(itemTags, entry.tags);
  });
}

function normalizeAugmentGrade(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(5, Math.trunc(parsed)));
}

export function augmentEffectSummary(augmentId: string, grade: unknown = 5) {
  const entry = catalog.augments[augmentId];
  if (!entry) return "";
  const normalizedGrade = String(normalizeAugmentGrade(grade));
  const gradeEffects = entry.gradeEffects?.[normalizedGrade] || entry.gradeEffects?.["5"] || entry.effectSummary?.split("; ") || [];
  return formatPerfectEffects(gradeEffects).map((effect) => effect.text).join("; ");
}

function numericValue(value: string) {
  const match = value.match(/[+-]?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function valueTokens(text: string) {
  return text.match(/[+-]?\d+(?:\.\d+)?%?/g) || [];
}

function perfectValue(values: string[]) {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0];
  const numbers = values.map((value) => ({ value, number: numericValue(value) }));
  const allNegative = numbers.every((entry) => entry.number < 0);
  if (allNegative) return numbers.reduce((best, entry) => Math.abs(entry.number) > Math.abs(best.number) ? entry : best).value;
  return numbers.reduce((best, entry) => entry.number > best.number ? entry : best).value;
}

function effectTone(label: string, value: string): "positive" | "negative" | "neutral" {
  const number = numericValue(value);
  if (!Number.isFinite(number) || number === 0) return "neutral";
  const normalized = label.toLowerCase();
  const lowerIsBetter = /consumption|cost|recoil|spread|weight|volume|cooldown|delay|heat|overheat|durability loss|threat|detection/.test(normalized);
  const higherIsBetter = /damage|armor|resist|resistance|mitigation|health|clip|magazine|capacity|range|speed|rate|reload|stamina|max|yield|healing|regen|regeneration|shield/.test(normalized);
  if (lowerIsBetter) return number < 0 ? "positive" : "negative";
  if (higherIsBetter) return number > 0 ? "positive" : "negative";
  return number > 0 ? "positive" : "negative";
}

function formatPerfectEffects(effects: string[]): AugmentEffect[] {
  return effects.map((effect) => {
    const values = valueTokens(effect);
    const firstValue = values[0] || "";
    const label = firstValue ? effect.slice(0, effect.indexOf(firstValue)).trim() : effect.trim();
    const value = perfectValue(values);
    const text = value ? `${label} ${value}` : effect;
    return { label, value, tone: effectTone(label, value), text };
  });
}

export function augmentOptionEffects(augmentId: string, grade: unknown = 5) {
  const entry = catalog.augments[augmentId];
  if (!entry) return [];
  const normalizedGrade = String(normalizeAugmentGrade(grade));
  const gradeEffects = entry.gradeEffects?.[normalizedGrade] || entry.gradeEffects?.["5"] || entry.effectSummary?.split("; ") || [];
  return formatPerfectEffects(gradeEffects);
}

export function formatAugmentOptions(options: AugmentOption[], grade: unknown = 5) {
  return options.map((option) => {
    const effects = augmentOptionEffects(option.id, grade);
    const summary = effects.map((effect) => effect.text).join("; ");
    return { ...option, displayName: summary ? `${option.name} (${summary})` : option.name, effects };
  });
}
