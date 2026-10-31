import { api, post } from "../../api/client";

export const LANGUAGE_STORAGE_KEY = "dune-console:language";
export const LANGUAGE_CHANGE_EVENT = "dune-console:language-change";
export const LANGUAGE_STATS_EVENT = "dune-console:language-stats";

export type SupportedLanguageItem = {
  code: string;
  deeplCode: string;
  name: string;
  nativeName: string;
  region: string;
  dir: "ltr" | "rtl";
  core: boolean;
  translatedCount: number;
  coveragePercent: number;
  cachedInDb: boolean;
};

export type MeshStatusInfo = {
  nodeId: string;
  peerSyncEnabled: boolean;
  enrollmentConfigured?: boolean;
  peers: string[];
  exchangedPacksCount: number;
  verifiedPeersCount: number;
  lastMeshSyncAt: string | null;
};

export type LanguageCatalogResponse = {
  version: number;
  updatedAt: string;
  totalSourceStrings: number;
  autoSyncLanguages: string[];
  encryptedKeyConfigured: boolean;
  fallbackEngineAvailable?: boolean;
  encryptionAlgorithm: string;
  syncInProgress: boolean;
  lastDeltaSyncAt: string | null;
  lastDeltaSyncError: string | null;
  mesh?: MeshStatusInfo;
  languages: SupportedLanguageItem[];
};

export type LanguageTranslationsResponse = {
  lang: string;
  name: string;
  nativeName: string;
  dir: "ltr" | "rtl";
  totalSourceStrings: number;
  translatedCount: number;
  updatedAt?: string;
  translations: Record<string, string>;
};

export type TranslateBatchResponse = {
  lang: string;
  dir: "ltr" | "rtl";
  translations: Record<string, string>;
  newlyAddedCount: number;
  rejectedUnreviewedCount?: number;
  translatedNowCount: number;
  servedFromCacheCount: number;
};

export type SyncAllResponse = {
  ok: boolean;
  totalSourceStrings: number;
  totalTranslatedNow: number;
  updatedAt: string;
  languages: Record<string, { translatedNow: number; totalCached: number; remaining?: number }>;
};

export type UpdateMeshSettingsResponse = {
  ok: boolean;
  mesh: MeshStatusInfo;
  syncSummary?: {
    syncedLanguages: string[];
    syncedPhrasesCount: number;
    verifiedPeers: number;
  } | null;
};

export function loadSelectedLanguage(): string {
  try {
    const raw = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return raw ? raw.trim().toUpperCase() : "EN";
  } catch {
    return "EN";
  }
}

export function saveSelectedLanguage(langCode: string): void {
  const normalized = (langCode || "EN").trim().toUpperCase();
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, normalized);
  } catch {
    // Ignore storage errors in private browsing
  }
  window.dispatchEvent(new CustomEvent(LANGUAGE_CHANGE_EVENT, { detail: { lang: normalized } }));
}

export const i18nApi = {
  suggest: (payload: {lang:string;source:string;translation:string;credit:string}) => post<{id:string;status:string}>("/api/i18n/suggestions",payload),
  catalog: () => api<LanguageCatalogResponse>("/api/i18n/languages"),
  translations: (lang: string) =>
    api<LanguageTranslationsResponse>(`/api/i18n/translations?lang=${encodeURIComponent(lang)}`),
  translateBatch: (lang: string, texts: string[]) =>
    post<TranslateBatchResponse>("/api/i18n/translate", { lang, texts }),
  saveKey: (apiKey: string) =>
    post<{ ok: boolean; encryptedKeyConfigured: boolean; encryptionAlgorithm: string }>("/api/i18n/key", { apiKey }),
  saveSettings: (payload: {
    peerSyncEnabled?: boolean;
    peers?: string[];
    replacePeers?: boolean;
    meshEnrollmentKey?: string;
    generateMeshEnrollmentKey?: boolean;
    triggerPeerSync?: boolean;
  }) => post<UpdateMeshSettingsResponse>("/api/i18n/settings", payload),
  syncAll: (languages?: string[]) =>
    post<SyncAllResponse>("/api/i18n/sync-all", languages ? { languages } : {})
};
