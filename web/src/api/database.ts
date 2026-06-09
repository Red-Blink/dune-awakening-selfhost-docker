import { api, post } from "./client";
import type { Task } from "./setup";

export const databaseApi = {
  status: () => api<Record<string, unknown>>("/api/database/status"),
  changePassword: (password: string) => post<{ ok: boolean; user: string; task: Task }>("/api/database/password", { password }),
  schemas: () => api<string[]>("/api/database/schemas"),
  tables: (schema = "dune") => api<{ schema: string; name: string; estimated_rows: string }[]>(`/api/database/tables?schema=${encodeURIComponent(schema)}`),
  columns: (schema: string, table: string) => api<Record<string, unknown>[]>(`/api/database/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}/columns`),
  count: (schema: string, table: string) => api<{ count: string }>(`/api/database/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}/count`),
  preview: (schema: string, table: string, limit = 50, offset = 0) => api<{ columns: { name: string }[]; rows: Record<string, unknown>[] }>(`/api/database/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}/preview?limit=${limit}&offset=${offset}`),
  updateRow: (schema: string, table: string, rowId: string, values: Record<string, unknown>) => api<{ ok: boolean; updatedRows: number; schema: string; table: string }>(`/api/database/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}/row`, { method: "PATCH", body: JSON.stringify({ rowId, values }) }),
  search: (q: string) => api<Record<string, unknown>[]>(`/api/database/search?q=${encodeURIComponent(q)}`),
  query: (query: string, confirmation = "") => post<{ columns: { name: string }[]; rows: Record<string, unknown>[] }>("/api/database/query", { query, confirmDestructive: confirmation === "RUN DESTRUCTIVE SQL", confirmation }),
  export: (query: string) => post<{ columns: { name: string }[]; rows: Record<string, unknown>[] }>("/api/database/export", { query })
};
