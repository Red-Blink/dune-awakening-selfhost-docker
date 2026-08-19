import { api, post } from "./client";

// Per-item Market Bot catalog overrides — an admin-editable layer on top of
// the bundled, read-only market seed plan. See console/api/src/services/marketItemOverrides.js.

export type MarketBotItemRow = {
  templateId: string;
  displayName: string;
  category: string;
  qualityLevel: number;
  price: number;
  listings: number;
  enabled: boolean;
  overridden: boolean;
  isNew: boolean;
  unsafe: boolean;
};

export type MarketBotItemsResponse = {
  capabilities: { exchangeMarket?: boolean } & Record<string, unknown>;
  rows: MarketBotItemRow[];
  reason?: string;
};

export type MarketItemOverridePatch = { enabled?: boolean; price?: number; listings?: number };

export type MarketNewItemPayload = {
  name?: string;
  price: number;
  listings: number;
  enabled?: boolean;
  qualityLevel?: number;
  stackSize?: number;
};

// overrides is nested templateId -> qualityLevel (as a string key) -> patch,
// since the same template id has a distinct row (and price) per grade.
export type MarketItemsSavePayload = {
  overrides?: Record<string, Record<string, MarketItemOverridePatch>>;
  newItems?: Record<string, MarketNewItemPayload>;
  removedNewItems?: string[];
};

export type MarketCatalogPickItem = {
  id: string;
  itemId: string;
  name: string;
  category: string;
  image: string;
};

export const marketBotItemsApi = {
  list: () => api<MarketBotItemsResponse>("/api/exchange/market/items"),
  catalog: (params: { q?: string; category?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.q) query.set("q", params.q);
    if (params.category) query.set("category", params.category);
    const suffix = query.toString();
    return api<{ rows: MarketCatalogPickItem[] }>(`/api/exchange/market/items/catalog${suffix ? `?${suffix}` : ""}`);
  },
  save: (payload: MarketItemsSavePayload) => post<{ overrides: Record<string, Record<string, MarketItemOverridePatch>>; newItems: Record<string, MarketNewItemPayload> }>("/api/exchange/market/items", payload)
};
