import { api, apiDownload, post } from "./client";

// First-class Market Bot (console-managed NPC market seeding and buyback).
// Exchange ids are PostgreSQL BIGINTs that can exceed Number.MAX_SAFE_INTEGER,
// so they travel as decimal strings end-to-end.

export type MarketPriceBasis = "seeded" | "average" | "lowest";

// How the seed run prices standalone augment items (always listed as
// bottom-of-range rolls): "discounted" undercuts their schematics at half
// price, "original" keeps the seed plan's own augment item prices.
export type MarketAugmentPricing = "discounted" | "original";

// Per-category price multipliers (1-5x, 1 = no change) layered on top of the
// schedule's base priceMultiplier: augments & augment schematics, ranked
// (grade 1-5) armor, and ranked weapons.
export type MarketCategoryMultipliers = {
  augmentMultiplier: number;
  rankedArmorMultiplier: number;
  rankedWeaponMultiplier: number;
};

export type MarketBuybackSchedule = MarketCategoryMultipliers & {
  enabled: boolean;
  intervalMinutes: number;
  exchangeId: string;
  priceMultiplier: number;
  buybackPercent: number;
  buybackPriceBasis: MarketPriceBasis;
  maxBuys: number;
  source: "addon" | "console";
  lastRunAt: string;
  lastRunStatus: string;
  lastRunDetail: string;
  nextRunAt: string;
};

export type CommodityStackItem = {
  templateId: string;
  label: string;
  group: string;
  stackSize: number;
};

export type CommodityStackGroup = {
  id: string;
  label: string;
};

export type MarketSeedSchedule = MarketCategoryMultipliers & {
  enabled: boolean;
  intervalMinutes: number;
  exchangeId: string;
  priceMultiplier: number;
  augmentPricing: MarketAugmentPricing;
  commodityStacks: Record<string, number>;
  source: "addon" | "console";
  lastRunAt: string;
  lastRunStatus: string;
  lastRunDetail: string;
  nextRunAt: string;
};

export type MarketBotStatus = {
  capabilities: { exchangeMarket?: boolean } & Record<string, unknown>;
  plan: { available: boolean; source: "addon" | "bundled" | "custom" | null; rows: number; panelVersion: string; generatedAt: string; id?: string; name?: string };
  plans?: { activePlanId: string; items: MarketSeedPlanInfo[] };
  buyback: MarketBuybackSchedule;
  seed: MarketSeedSchedule;
  commodityStackCatalog?: CommodityStackItem[];
  commodityStackGroups?: CommodityStackGroup[];
  reason?: string;
};

export type MarketSeedPlanInfo = {
  id: string;
  name: string;
  source: "bundled" | "addon" | "custom";
  readOnly: boolean;
  rows: number;
  panelVersion?: string;
  generatedAt?: string;
  active: boolean;
};

export type MarketSeedPlanImportResult = {
  id: string;
  name: string;
  rows: number;
  active: boolean;
  plans?: { activePlanId: string; items: MarketSeedPlanInfo[] };
};

export type MarketExchange = {
  exchangeId: string;
  isGlobal: boolean;
  accessPoints: number;
  orderCount: number;
  botOrders: number;
  playerOrders: number;
};

export type MarketProbeResult = MarketCategoryMultipliers & {
  eligible: number;
  playerListings: number;
  knownListings: number;
  aboveThreshold: number;
  unknownTemplate: number;
  invalidPriceOrStack: number;
  exchangeId: string;
  priceMultiplier: number;
  buybackPercent: number;
  buybackPriceBasis: MarketPriceBasis;
  maxBuys: number;
};

export type MarketRunResult = {
  status: string;
  detail?: string;
  exchangeId?: string;
  // buyback run
  eligible?: number;
  purchased?: number;
  totalUnits?: string;
  totalSolari?: string;
  // seed run
  listingCount?: string;
  // unseed run
  removedListings?: string;
  removedItems?: string;
  schedule?: MarketBuybackSchedule | MarketSeedSchedule;
};

export type MarketBuybackLogEntry = {
  orderId: string;
  templateId: string;
  displayName: string;
  qualityLevel: string;
  itemPrice: string;
  stackSize: string;
  maxUnitPrice: string;
  resultCode: number;
  resultHex: string;
  resultLabel: string;
  detail: string;
};

export type MarketBuybackLogBatch = {
  source: string;
  exchangeId: string;
  at: string;
  note: string;
  summary: string;
  buybackPercent?: number | null;
  buybackPriceBasis?: string;
  maxBuys?: number | null;
  truncatedFrom?: number;
  entries: MarketBuybackLogEntry[];
};

export type MarketBuybackLog = {
  batches: MarketBuybackLogBatch[];
  entries?: MarketBuybackLogEntry[];
  exchangeId?: string;
  removed?: number;
};

export const marketBotApi = {
  status: () => api<MarketBotStatus>("/api/exchange/market"),
  exchanges: () => api<{ rows: MarketExchange[]; capabilities: { exchangeMarket?: boolean } }>("/api/exchange/market/exchanges"),
  probeBuyback: (overrides: Partial<{ exchangeId: string; priceMultiplier: number; buybackPercent: number; buybackPriceBasis: MarketPriceBasis; maxBuys: number } & MarketCategoryMultipliers> = {}) =>
    post<MarketProbeResult>("/api/exchange/market/buyback/probe", overrides),
  buybackLog: () => api<MarketBuybackLog>("/api/exchange/market/buyback/log"),
  refreshBuybackLog: (overrides: Partial<{ exchangeId: string; priceMultiplier: number; buybackPercent: number; buybackPriceBasis: MarketPriceBasis; maxBuys: number } & MarketCategoryMultipliers> = {}) =>
    post<MarketBuybackLog>("/api/exchange/market/buyback/log", overrides),
  clearBuybackLog: () => post<MarketBuybackLog>("/api/exchange/market/buyback/log/clear", {}),
  saveBuybackSchedule: (schedule: Partial<MarketBuybackSchedule>) => post<MarketBuybackSchedule>("/api/exchange/market/buyback/schedule", schedule),
  saveSeedSchedule: (schedule: Partial<MarketSeedSchedule>) => post<MarketSeedSchedule>("/api/exchange/market/seed/schedule", schedule),
  runBuyback: () => post<MarketRunResult>("/api/exchange/market/buyback/run", {}),
  runSeed: () => post<MarketRunResult>("/api/exchange/market/seed/run", {}),
  // Remove the bot's NPC listings from one exchange without reseeding.
  unseed: (payload: { exchangeId?: string } = {}) => post<MarketRunResult>("/api/exchange/market/seed/clear", payload),
  setActivePlan: (payload: { planId: string }) => post<{ activePlanId: string; items: MarketSeedPlanInfo[] }>("/api/exchange/market/plans/active", payload),
  renamePlan: (payload: { planId: string; name: string }) => post<{ activePlanId: string; items: MarketSeedPlanInfo[] }>("/api/exchange/market/plans/name", payload),
  downloadPlanCsv: (planId: string) => apiDownload(`/api/exchange/market/plans/csv?planId=${encodeURIComponent(planId)}`),
  uploadPlanCsv: (form: FormData) => api<MarketSeedPlanImportResult>("/api/exchange/market/plans/csv", { method: "POST", body: form })
};
