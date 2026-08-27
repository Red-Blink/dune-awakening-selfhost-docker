import { api, post } from "./client";

// "read" and "write" only. A namespace absent from the map is None -- there is
// no "none" level to store, and the server treats anything it does not
// recognise as None rather than falling back to read.
export type ScopeLevel = "read" | "write";
export type ApiKeyScopes = Record<string, ScopeLevel>;

export type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScopes;
  enabled: boolean;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  rateLimitPerMinute: number;
  // Computed by the server. Do not re-derive it here: a second copy of the
  // expiry formula is exactly how the UI came to show a key as Active that
  // the API was refusing as expired.
  expired: boolean;
};

export type ScopeCatalogEntry = {
  namespace: string;
  readActions: string[];
  writeActions: string[];
  // False for `logs`, which has no write action at all, and for `updates`,
  // whose write actions are denied to keys -- the UI renders a two-segment
  // None/Read control for such a namespace.
  supportsWrite: boolean;
};

export type CreateApiKeyInput = {
  name: string;
  scopes: ApiKeyScopes;
  expiresAt?: string | null;
  rateLimitPerMinute?: number;
};

export type UpdateApiKeyInput = Partial<{
  name: string;
  scopes: ApiKeyScopes;
  enabled: boolean;
  expiresAt: string | null;
  rateLimitPerMinute: number;
}>;

// `secret` is the full key and is returned exactly once, by create. Only its
// hash is stored, so it can never be fetched again.
export type CreatedApiKey = { key: ApiKey; secret: string };

export const apiKeysApi = {
  list: () => api<{ keys: ApiKey[] }>("/api/settings/api-keys"),
  catalog: () => api<{ namespaces: ScopeCatalogEntry[] }>("/api/settings/api-keys/catalog"),
  create: (input: CreateApiKeyInput) => post<CreatedApiKey>("/api/settings/api-keys", input),
  update: (id: string, input: UpdateApiKeyInput) =>
    api<{ key: ApiKey }>(`/api/settings/api-keys/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(input)
    }),
  revoke: (id: string) =>
    api<{ ok: boolean }>(`/api/settings/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" })
};

// `<input type="date">` yields a bare "YYYY-MM-DD", which `new Date()` parses as
// UTC midnight per spec. Sending that verbatim expired a key at the START of the
// chosen day, in UTC -- so an operator west of UTC lost the whole day they
// picked, and the list redisplayed it via toLocaleDateString() as the day
// before. Resolving to the last instant of that day in the operator's OWN
// timezone makes both the lifetime and the redisplay match what they chose.
export function endOfLocalDayIso(yyyyMmDd: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec((yyyyMmDd || "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Month is 0-based; this constructor is local-time, unlike Date.parse.
  const local = new Date(year, month - 1, day, 23, 59, 59, 999);
  if (Number.isNaN(local.getTime())) return null;
  // The constructor rolls out-of-range parts over silently -- "2026-13-45"
  // would become Feb 2027 rather than being rejected. Reading the components
  // back is the check that the date the operator gets is the date they typed.
  if (local.getFullYear() !== year || local.getMonth() !== month - 1 || local.getDate() !== day) return null;
  return local.toISOString();
}

export function keyStatus(key: ApiKey): "Active" | "Disabled" | "Expired" {
  if (key.expired) return "Expired";
  return key.enabled ? "Active" : "Disabled";
}

// Record<string, ScopeLevel> models a missing key as ScopeLevel rather than
// undefined, and ScopeLevel has no falsy member, so `scopes[ns] ?? "none"`
// narrows straight back to ScopeLevel at the call site. A declared return type
// is not narrowed that way, and the hasOwnProperty guard makes the lookup
// honest about a namespace that was never granted.
export function scopeLevelOf(scopes: ApiKeyScopes, namespace: string): ScopeLevel | undefined {
  return Object.prototype.hasOwnProperty.call(scopes || {}, namespace) ? scopes[namespace] : undefined;
}

export function grantedCount(scopes: ApiKeyScopes) {
  return Object.keys(scopes || {}).length;
}

export function describeScopes(scopes: ApiKeyScopes) {
  const entries = Object.entries(scopes || {});
  if (!entries.length) return "No access";
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([namespace, level]) => `${namespace} ${level === "write" ? "RW" : "R"}`)
    .join(", ");
}
