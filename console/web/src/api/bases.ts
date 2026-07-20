import { api } from "./client";

export const basesApi = {
  list: (params: { q?: string; page?: number; pageSize?: number; sortColumn?: string; sortDirection?: "asc" | "desc" } = {}) => {
    const search = new URLSearchParams();
    if (params.q) search.set("q", params.q);
    if (params.page) search.set("page", String(params.page));
    if (params.pageSize) search.set("pageSize", String(params.pageSize));
    if (params.sortColumn) search.set("sortColumn", params.sortColumn);
    if (params.sortDirection) search.set("sortDirection", params.sortDirection);
    const qs = search.toString();
    return api<{ rows: Record<string, unknown>[]; totalCount: number; totalBases: number; totalPieces: number; totalPlaceables: number; capabilities: Record<string, unknown>; reason?: string }>(`/api/bases${qs ? `?${qs}` : ""}`);
  }
};
