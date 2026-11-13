/** Original Console palettes: four colours each. Dark surfaces keep the existing controls
 * readable; the engine derives the shared semantic tokens. */
/** Picker sections, in display order. */
export const PALETTE_GROUPS = ["Console palettes", "Dune factions", "Houses", "Outfits and dyes"] as const;
export type PaletteGroup = (typeof PALETTE_GROUPS)[number];

export interface ConsolePalette {
  id: string;
  group: PaletteGroup;
  name: string;
  description: string;
  background: string;
  panel: string;
  accent: string;
  secondary: string;
}

export const CONSOLE_PALETTES: readonly ConsolePalette[] = [
  { id: "dd-amber-dunes", group: "Console palettes", name: "Amber Dunes", description: "Warm charcoal with amber and muted turquoise.", background: "#17120f", panel: "#292019", accent: "#efb56b", secondary: "#85c5bc" },
  { id: "dune-house-atreides", group: "Dune factions", name: "Atreides", description: "Deep evergreen with silver sage and sunlit brass.", background: "#111a18", panel: "#20332c", accent: "#a5d6b8", secondary: "#dbbc79" },
  { id: "dd-basalt", group: "Console palettes", name: "Basalt", description: "Volcanic gray with soft silver and warm copper.", background: "#131517", panel: "#24292c", accent: "#b7c9cf", secondary: "#dfa585" },
  { id: "dd-copper", group: "Console palettes", name: "Copper", description: "Dark umber with burnished copper and sage.", background: "#191311", panel: "#2b211e", accent: "#e7a078", secondary: "#a7c5aa" },
  { id: "dd-deep-desert", group: "Console palettes", name: "Deep Desert", description: "Quiet brown-black with sand gold and clear sky blue.", background: "#15140f", panel: "#27271e", accent: "#ddc178", secondary: "#8abdda" },
  { id: "dd-dust-storm", group: "Console palettes", name: "Dust Storm", description: "Smoky slate with pale apricot and lavender.", background: "#181619", panel: "#2c282d", accent: "#e7b690", secondary: "#b6a4db" },
  { id: "dd-emerald", group: "Console palettes", name: "Emerald", description: "Deep forest with fresh mint and soft brass.", background: "#101a16", panel: "#1d2e26", accent: "#80d1ac", secondary: "#d4be83" },
  { id: "tabr-fremen", group: "Dune factions", name: "Fremen", description: "Desert slate with spice blue and woven sand.", background: "#181a1d", panel: "#2b3037", accent: "#89c8eb", secondary: "#d7b98b" },
  { id: "dd-golden-dusk", group: "Console palettes", name: "Golden Dusk", description: "Dark aubergine with honey gold and rose.", background: "#1b141a", panel: "#30242c", accent: "#f0c47a", secondary: "#d99eb9" },
  { id: "dune-harkonnen", group: "Dune factions", name: "Harkonnen", description: "Iron charcoal with pale crimson and cold steel.", background: "#171216", panel: "#2e222a", accent: "#efa0ac", secondary: "#aabbd4" },
  { id: "dd-ice-blue", group: "Console palettes", name: "Ice Blue", description: "Cold blue-gray with glacial blue and pale mint.", background: "#101820", panel: "#202e3a", accent: "#9ed7ef", secondary: "#a2d8c3" },
  { id: "dd-indigo", group: "Console palettes", name: "Indigo", description: "Ink blue with periwinkle and peach.", background: "#151525", panel: "#272940", accent: "#b4b8f2", secondary: "#e4b097" },
  { id: "dd-jade", group: "Console palettes", name: "Jade", description: "Dark teal with jade and misty blue.", background: "#101b1c", panel: "#1c3031", accent: "#81cbbd", secondary: "#a8c6e6" },
  { id: "dd-moonstone", group: "Console palettes", name: "Moonstone", description: "Smoky violet with pearl lavender and sand.", background: "#1a1721", panel: "#302a3c", accent: "#d0bbeb", secondary: "#d9c39c" },
  { id: "dd-nightfall", group: "Console palettes", name: "Nightfall", description: "Near-black navy with electric blue and lilac.", background: "#10141d", panel: "#1d2634", accent: "#8cbafa", secondary: "#c6acec" },
  { id: "dd-oasis", group: "Console palettes", name: "Oasis", description: "Deep petrol with aqua and sunlit gold.", background: "#101b20", panel: "#1d3039", accent: "#83d2d9", secondary: "#e2c382" },
  { id: "dd-rosewood", group: "Console palettes", name: "Rosewood", description: "Dark wine with dusty rose and pearl blue.", background: "#1d1418", panel: "#34242c", accent: "#e4a3b4", secondary: "#aabfdf" },
  { id: "dd-saffron", group: "Console palettes", name: "Saffron", description: "Earthy charcoal with saffron and olive silver.", background: "#19170f", panel: "#2e2a1d", accent: "#ebc66e", secondary: "#b7c69a" },
  { id: "dd-sandstone", group: "Console palettes", name: "Sandstone", description: "Soft dark taupe with limestone and sage blue.", background: "#1b1916", panel: "#302d27", accent: "#dbc7a7", secondary: "#9abfc2" },
  { id: "dune-sardaukar-imperial", group: "Dune factions", name: "Sardaukar Imperial", description: "Imperial plum with pale orchid and antique gold.", background: "#1b1421", panel: "#302439", accent: "#d4b2ec", secondary: "#dec181" },
  { id: "dd-slate", group: "Console palettes", name: "Slate", description: "Graphite blue with steel silver and sea green.", background: "#15191e", panel: "#272f38", accent: "#acc3dc", secondary: "#8cc7ba" },
  { id: "dd-spice", group: "Console palettes", name: "Spice", description: "Roasted brown with spice orange and cool turquoise.", background: "#1c1410", panel: "#33251d", accent: "#f2a76b", secondary: "#8ec5ca" },
  { id: "dd-steel", group: "Console palettes", name: "Steel", description: "Neutral charcoal with pale blue and warm ivory.", background: "#17191b", panel: "#2b3034", accent: "#b5d1e1", secondary: "#dfcbb1" },
];
