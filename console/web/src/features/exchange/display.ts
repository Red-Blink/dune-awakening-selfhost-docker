export const EXCHANGE_CATEGORY_LABELS: Record<string, string> = {
  armor: "Armor",
  augments: "Augments",
  buildings: "Buildings",
  clothing: "Clothing",
  components: "Components",
  consumables: "Consumables",
  contracts: "Contracts",
  customizations: "Customizations",
  emotes: "Emotes",
  gadgets: "Gadgets",
  misc: "Misc",
  resources: "Resources",
  schematics: "Schematics",
  vehicles: "Vehicles",
  weapons: "Weapons"
};

/** Formats raw Exchange text as a human-facing label without changing IDs. */
export function exchangeDisplayLabel(value: unknown, humanizeSeparators = false) {
  const text = String(value ?? "").trim();
  const known = EXCHANGE_CATEGORY_LABELS[text.toLowerCase()];
  if (known) return known;
  const label = humanizeSeparators ? text.replace(/[_-]+/g, " ") : text;
  return label.replace(/(^|[\s-])(\p{L})/gu, (_match, prefix: string, letter: string) => `${prefix}${letter.toLocaleUpperCase()}`);
}
