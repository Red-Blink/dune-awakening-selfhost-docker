import { api } from "./client";

export const basesApi = {
  list: (params: { q?: string; page?: number; pageSize?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.q) search.set("q", params.q);
    if (params.page) search.set("page", String(params.page));
    if (params.pageSize) search.set("pageSize", String(params.pageSize));
    const qs = search.toString();
    return api<{ rows: Record<string, unknown>[]; totalCount: number; totalBases: number; totalPieces: number; totalPlaceables: number; capabilities: Record<string, unknown>; reason?: string }>(`/api/bases${qs ? `?${qs}` : ""}`);
  }
};
