const DUNE_ASSET_BASE = "/assets/dune";

const PLAYER_ADMIN_ICON_RAIL_LABELS = [
  "All Categories",
  "Essentials",
  "Water Discipline",
  "Combat",
  "Construction",
  "Exploration",
  "Vehicles",
  "Augmentations",
  "Augments",
  "Uniques",
  "Trooper",
  "Swordmaster",
  "Bene Gesserit",
  "Mentat",
  "Planetologist"
];

let playerAdminIconRailPreloadStarted = false;

function duneCategoryAssetKey(label: string) {
  const normalized = label.trim().toLowerCase();
  if (!normalized || normalized === "all categories") return "all_categories";
  if (normalized === "specializations") return "all_categories";
  if (normalized === "augments") return "augmentations";
  return normalized.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function duneCategoryIconPath(label: string, selected: boolean) {
  const key = duneCategoryAssetKey(label);
  if (selected && key === "all_categories") return `${DUNE_ASSET_BASE}/${key}_selected.png`;
  return `${DUNE_ASSET_BASE}/${key}_icon${selected ? "_selected" : ""}.png`;
}

export function preloadPlayerAdminIconRailAssets() {
  if (playerAdminIconRailPreloadStarted || typeof window === "undefined") return;
  playerAdminIconRailPreloadStarted = true;
  const paths = new Set<string>();
  PLAYER_ADMIN_ICON_RAIL_LABELS.forEach((label) => {
    paths.add(duneCategoryIconPath(label, false));
    paths.add(duneCategoryIconPath(label, true));
  });
  paths.forEach((path) => {
    const image = new Image();
    image.decoding = "async";
    image.src = path;
  });
}

export function PlayerCategoryIconRail({
  options,
  value,
  onChange,
  allLabel = "All Categories",
  emptyLabel = "Select Category",
  includeAll = true
}: {
  options: string[];
  value: string;
  onChange: (value: string) => void;
  allLabel?: string;
  emptyLabel?: string;
  includeAll?: boolean;
}) {
  const items = includeAll ? [{ value: "", label: allLabel }, ...options.map((option) => ({ value: option, label: option }))] : options.map((option) => ({ value: option, label: option }));
  const selectedItem = items.find((item) => item.value === value);
  const selectedLabel = selectedItem?.label || emptyLabel;

  return (
    <div className="playerAdmin_iconRail" aria-label="Category selector">
      <div className="playerAdmin_iconRailItems">
        <div className="playerAdmin_iconRailIconGroup">
          {items.map((item) => {
            const selected = item.value === value;
            const categoryKey = duneCategoryAssetKey(item.label);
            return (
              <button
                key={item.label}
                type="button"
                className={`playerAdmin_iconRailButton ${selected ? "active" : ""}`}
                aria-pressed={selected}
                title={item.label}
                data-category={categoryKey}
                onClick={() => onChange(item.value)}
              >
                <img src={duneCategoryIconPath(item.label, selected)} alt="" loading="eager" decoding="async" fetchPriority="high" />
              </button>
            );
          })}
        </div>
        <span className="playerAdmin_iconRailLabel">{selectedLabel}</span>
      </div>
    </div>
  );
}
