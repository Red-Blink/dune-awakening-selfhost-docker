import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Database, Globe, Network, RefreshCw, Search, Settings, Sparkles } from "lucide-react";
import {
  i18nApi,
  LANGUAGE_CHANGE_EVENT,
  LANGUAGE_STATS_EVENT,
  loadSelectedLanguage,
  saveSelectedLanguage,
  type LanguageCatalogResponse,
  type SupportedLanguageItem
} from "./i18nClient";

export function LanguagePanel() {
  const [catalog, setCatalog] = useState<LanguageCatalogResponse | null>(null);
  const [selectedLang, setSelectedLang] = useState<string>(() => loadSelectedLanguage());
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [switchingLang, setSwitchingLang] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [enrollmentKeyInput, setEnrollmentKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [savingMesh, setSavingMesh] = useState(false);
  const [notice, setNotice] = useState<{ title: string; message: string; tone: "ok" | "fail" } | null>(null);

  async function loadCatalog(silent = false) {
    if (!silent) setLoading(true);
    try {
      const data = await i18nApi.catalog();
      setCatalog(data);
    } catch (err) {
      setNotice({
        title: "Language Catalog Unavailable",
        message: err instanceof Error ? err.message : "Could not load translation database status.",
        tone: "fail"
      });
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    void loadCatalog();
    const onLangChange = (event: Event) => {
      const custom = event as CustomEvent<{ lang?: string }>;
      setSelectedLang(custom.detail?.lang || loadSelectedLanguage());
    };
    const onStatsUpdate = () => {
      void loadCatalog(true);
    };
    window.addEventListener(LANGUAGE_CHANGE_EVENT, onLangChange);
    window.addEventListener(LANGUAGE_STATS_EVENT, onStatsUpdate);
    return () => {
      window.removeEventListener(LANGUAGE_CHANGE_EVENT, onLangChange);
      window.removeEventListener(LANGUAGE_STATS_EVENT, onStatsUpdate);
    };
  }, []);

  async function selectLanguage(item: SupportedLanguageItem) {
    setSwitchingLang(item.code);
    setNotice(null);
    try {
      if (item.code !== "EN") {
        await i18nApi.translations(item.code);
      }
      saveSelectedLanguage(item.code);
      setSelectedLang(item.code);
      await loadCatalog(true);
    } catch (err) {
      setNotice({
        title: "Language Switch Failed",
        message: err instanceof Error ? err.message : "Failed to load language dictionary.",
        tone: "fail"
      });
    } finally {
      setSwitchingLang(null);
    }
  }

  async function handleSaveKey() {
    if (!apiKeyInput.trim()) return;
    setSavingKey(true);
    setNotice(null);
    try {
      await i18nApi.saveKey(apiKeyInput.trim());
      setApiKeyInput("");
      await loadCatalog(true);
      setNotice({
        title: "DeepL API Key Encrypted & Saved",
        message: "Your DeepL API key has been encrypted with AES-256-GCM (scrypt) and stored in the local host vault.",
        tone: "ok"
      });
    } catch (err) {
      setNotice({
        title: "Key Update Failed",
        message: err instanceof Error ? err.message : "Could not save DeepL API key.",
        tone: "fail"
      });
    } finally {
      setSavingKey(false);
    }
  }

  async function handleSaveEnrollmentSecret() {
    if (!enrollmentKeyInput.trim()) return;
    setSavingMesh(true);
    setNotice(null);
    try {
      await i18nApi.saveSettings({
        meshEnrollmentKey: enrollmentKeyInput.trim()
      });
      setEnrollmentKeyInput("");
      await loadCatalog(true);
      setNotice({
        title: "Mesh Enrollment Secret Saved",
        message: "Per-installation trust enrollment secret stored encrypted in the host vault.",
        tone: "ok"
      });
    } catch (err) {
      setNotice({
        title: "Mesh Enrollment Failed",
        message: err instanceof Error ? err.message : "Could not save mesh enrollment secret.",
        tone: "fail"
      });
    } finally {
      setSavingMesh(false);
    }
  }

  async function handleTogglePeerSync(nextEnabled: boolean) {
    setSavingMesh(true);
    setNotice(null);
    try {
      await i18nApi.saveSettings({
        peerSyncEnabled: nextEnabled,
        ...(enrollmentKeyInput.trim() ? { meshEnrollmentKey: enrollmentKeyInput.trim() } : {}),
        ...(nextEnabled && !catalog?.mesh?.enrollmentConfigured && !enrollmentKeyInput.trim()
          ? { generateMeshEnrollmentKey: true }
          : {}),
        triggerPeerSync: nextEnabled
      });
      setEnrollmentKeyInput("");
      await loadCatalog(true);
      setNotice({
        title: nextEnabled ? "Dune-Docker Peer Sync Enabled" : "Dune-Docker Peer Sync Disabled",
        message: nextEnabled
          ? "Per-installation authenticated language pack exchange for reviewed UI phrases is active."
          : "Background language pack exchange between Dune-Docker installations is now turned off.",
        tone: "ok"
      });
    } catch (err) {
      setNotice({
        title: "Peer Sync Update Failed",
        message: err instanceof Error ? err.message : "Could not update peer sync setting.",
        tone: "fail"
      });
    } finally {
      setSavingMesh(false);
    }
  }

  async function handleSyncAll() {
    setSyncing(true);
    setNotice(null);
    try {
      const res = await i18nApi.syncAll();
      await loadCatalog(true);
      setNotice({
        title: "Translation Database Synchronized",
        message: `Synchronized ${res.totalSourceStrings} source phrases across all national languages (${res.totalTranslatedNow} new phrases translated).`,
        tone: "ok"
      });
    } catch (err) {
      setNotice({
        title: "Database Sync Failed",
        message: err instanceof Error ? err.message : "Could not synchronize translation database.",
        tone: "fail"
      });
    } finally {
      setSyncing(false);
    }
  }

  const activeLanguageMeta = useMemo(() => {
    const list = catalog?.languages || [];
    return list.find((l) => l.code === selectedLang) || {
      code: selectedLang,
      name: selectedLang,
      nativeName: selectedLang,
      region: "Global",
      coveragePercent: 100,
      translatedCount: catalog?.totalSourceStrings || 0
    };
  }, [catalog, selectedLang]);

  const filteredLanguages = useMemo(() => {
    const list = catalog?.languages || [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.nativeName.toLowerCase().includes(q) ||
        item.code.toLowerCase().includes(q) ||
        item.region.toLowerCase().includes(q)
    );
  }, [catalog, searchQuery]);

  // Explicitly opt-in: false unless peerSyncEnabled is explicitly true on the backend.
  const peerSyncEnabled = Boolean(catalog?.mesh?.peerSyncEnabled === true);

  return (
    <div className="language-panel">
      <div
        className="panel-title addons-page-header"
        style={{
          display: "flex",
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12
        }}
      >
        <h2 style={{ margin: 0 }}>
          <span>Language &amp; Localization</span>{" "}
          <span className="addons-title-status">DeepL Neural Database</span>
        </h2>
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            flexWrap: "nowrap",
            alignItems: "center",
            gap: 8
          }}
        >
          {selectedLang !== "EN" && (
            <button
              type="button"
              style={{ whiteSpace: "nowrap" }}
              onClick={() => {
                saveSelectedLanguage("EN");
                setSelectedLang("EN");
              }}
            >
              Reset to English
            </button>
          )}
          <button
            type="button"
            disabled={syncing || loading}
            style={{ whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 6 }}
            onClick={() => void handleSyncAll()}
          >
            <Sparkles size={15} />
            <span>{syncing ? "Syncing..." : "Sync All Languages"}</span>
          </button>
          <button
            type="button"
            disabled={loading}
            style={{ whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 6 }}
            onClick={() => void loadCatalog()}
          >
            <RefreshCw size={15} />
            <span>{loading ? "Refreshing..." : "Refresh"}</span>
          </button>
          <button
            type="button"
            className={settingsOpen ? "active" : ""}
            aria-label="Language Settings"
            title="Language Settings"
            onClick={() => setSettingsOpen((v) => !v)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "8px 10px",
              minWidth: 38
            }}
          >
            <Settings size={17} />
          </button>
        </div>
      </div>

      {notice && (
        <div className={`result-panel ${notice.tone === "ok" ? "result-ok" : "result-fail"}`} role="alert" style={{ marginBottom: 16 }}>
          <strong>{notice.title}</strong>
          <p>{notice.message}</p>
        </div>
      )}

      {settingsOpen && (
        <div className="card" style={{ padding: 18, marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <h4 style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
              <Settings size={17} />
              <span>Translation &amp; Dune-Docker Mesh Settings</span>
            </h4>
            <button type="button" onClick={() => setSettingsOpen(false)}>
              Close
            </button>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              padding: "12px 14px",
              borderRadius: 8,
              border: "1px solid rgba(228, 155, 60, 0.45)",
              background: "rgba(228, 155, 60, 0.1)",
              marginBottom: 16
            }}
          >
            <AlertTriangle size={18} style={{ color: "var(--accent, #e49b3c)", flexShrink: 0, marginTop: 2 }} />
            <div style={{ fontSize: 13, lineHeight: 1.45 }}>
              <strong style={{ display: "block", marginBottom: 3 }}>
                Important Notice (DeepL API Key)
              </strong>
              <span>
                You have the option to enter and use your own personal DeepL API key here if you own one. Otherwise, please leave this setting untouched — the console already includes a pre-populated 53-language database, automatic fallback translation, and Dune-Docker peer synchronization.
              </span>
            </div>
          </div>

          <div style={{ marginBottom: 18 }}>
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
              Personal DeepL API Key (AES-256-GCM Encrypted Host Vault)
            </label>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <input
                type="password"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder="DeepL API Key (e.g. xxxx-xxxx:fx)"
                aria-label="DeepL API Key"
                style={{ flex: "1 1 280px" }}
              />
              <button type="button" disabled={savingKey || !apiKeyInput.trim()} onClick={() => void handleSaveKey()}>
                {savingKey ? "Saving..." : "Save Encrypted Key"}
              </button>
            </div>
          </div>

          <hr style={{ border: "none", borderTop: "1px solid rgba(255,255,255,0.1)", margin: "16px 0" }} />

          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 16,
                flexWrap: "wrap",
                marginBottom: 12
              }}
            >
              <div style={{ flex: "1 1 360px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 14 }}>
                  <Network size={16} />
                  <span>Dune-Docker Peer Language Pack Sync (Token Saver)</span>
                </div>
                <p style={{ margin: "4px 0 0", fontSize: 13, opacity: 0.8 }}>
                  Cryptographically recognizes other genuine Dune-Docker installations (strictly verified via mutual HMAC-SHA256 attestation) to automatically exchange completed language packs in the background and save DeepL token quota.
                </p>
              </div>

              <button
                type="button"
                role="switch"
                aria-checked={peerSyncEnabled}
                aria-label="Toggle Dune-Docker Peer Language Pack Sync"
                disabled={savingMesh}
                onClick={() => void handleTogglePeerSync(!peerSyncEnabled)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "6px 12px",
                  borderRadius: 999,
                  border: peerSyncEnabled
                    ? "1px solid var(--accent, #e49b3c)"
                    : "1px solid rgba(255,255,255,0.2)",
                  background: peerSyncEnabled ? "rgba(228, 155, 60, 0.2)" : "rgba(255,255,255,0.06)",
                  cursor: "pointer",
                  fontWeight: 700,
                  fontSize: 13
                }}
              >
                <span
                  style={{
                    width: 28,
                    height: 16,
                    borderRadius: 999,
                    background: peerSyncEnabled ? "var(--accent, #e49b3c)" : "rgba(255,255,255,0.25)",
                    position: "relative",
                    display: "inline-block",
                    transition: "background 0.15s ease"
                  }}
                >
                  <span
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: "50%",
                      background: "#111",
                      position: "absolute",
                      top: 2,
                      left: peerSyncEnabled ? 14 : 2,
                      transition: "left 0.15s ease"
                    }}
                  />
                </span>
                <span>{peerSyncEnabled ? "Enabled" : "Disabled"}</span>
              </button>
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <input
                type="password"
                value={enrollmentKeyInput}
                onChange={(e) => setEnrollmentKeyInput(e.target.value)}
                placeholder="Per-Installation Mesh Enrollment Secret (min. 32 chars)"
                aria-label="Per-Installation Mesh Enrollment Secret"
                style={{ flex: "1 1 280px" }}
              />
              <button
                type="button"
                disabled={savingMesh || enrollmentKeyInput.trim().length < 32}
                onClick={() => void handleSaveEnrollmentSecret()}
              >
                {savingMesh ? "Saving..." : "Save Enrollment Secret"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
          gap: 14,
          marginBottom: 18
        }}
      >
        <div className="card" style={{ padding: "14px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, opacity: 0.78, fontSize: 13 }}>
            <Globe size={16} />
            <span>Active Language</span>
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, marginTop: 6 }} data-no-translate="true">
            {activeLanguageMeta.nativeName}{" "}
            <span style={{ fontSize: 13, opacity: 0.7 }}>({activeLanguageMeta.code})</span>
          </div>
          <div style={{ fontSize: 12, opacity: 0.72, marginTop: 4 }}>
            <span>{activeLanguageMeta.name}</span> •{" "}
            <span data-no-translate="true">{activeLanguageMeta.coveragePercent}%</span> <span>Coverage</span>
          </div>
        </div>

        <div className="card" style={{ padding: "14px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, opacity: 0.78, fontSize: 13 }}>
            <Database size={16} />
            <span>Translation Database</span>
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, marginTop: 6 }}>
            <span data-no-translate="true">{catalog?.totalSourceStrings ?? 0}</span> <span>Phrases</span>
          </div>
          <div style={{ fontSize: 12, opacity: 0.72, marginTop: 4 }}>
            <span data-no-translate="true">{catalog?.languages.length ?? 54}</span>{" "}
            <span>National Languages Cached</span>
          </div>
        </div>

        <div className="card" style={{ padding: "14px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, opacity: 0.78, fontSize: 13 }}>
            <Network size={16} />
            <span>Dune-Docker Peer Mesh</span>
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, marginTop: 6 }}>
            {peerSyncEnabled ? "Enabled (Token Saver)" : "Disabled"}
          </div>
          <div style={{ fontSize: 12, opacity: 0.72, marginTop: 4 }}>
            <span>Verified Dune-Docker-Only Pack Exchange</span>
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 16
          }}
        >
          <div>
            <h4 style={{ margin: 0 }}>Console Language</h4>
            <p style={{ margin: "4px 0 0", fontSize: 13, opacity: 0.78 }}>
              Translate the entire Dune Docker Console into any national language using DeepL. New UI text is automatically detected, translated via DeepL, and cached in the local translation database to save API traffic.
            </p>
          </div>
          <div style={{ position: "relative", minWidth: 260 }}>
            <Search
              size={15}
              style={{
                position: "absolute",
                left: 10,
                top: "50%",
                transform: "translateY(-50%)",
                opacity: 0.6,
                pointerEvents: "none"
              }}
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search language by name or code..."
              aria-label="Search language by name or code"
              style={{ paddingLeft: 32, width: "100%" }}
            />
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(225px, 1fr))",
            gap: 10
          }}
        >
          {filteredLanguages.map((item) => {
            const isActive = item.code === selectedLang;
            const isSwitching = switchingLang === item.code;
            return (
              <button
                key={item.code}
                type="button"
                onClick={() => void selectLanguage(item)}
                disabled={isSwitching}
                className={isActive ? "active" : ""}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  textAlign: "left",
                  padding: "12px 14px",
                  borderRadius: 8,
                  border: isActive
                    ? "1px solid var(--accent, #e49b3c)"
                    : "1px solid rgba(255, 255, 255, 0.1)",
                  background: isActive
                    ? "rgba(228, 155, 60, 0.14)"
                    : "rgba(255, 255, 255, 0.025)",
                  cursor: "pointer",
                  gap: 8,
                  transition: "border-color 0.15s ease, background 0.15s ease"
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    width: "100%",
                    gap: 8
                  }}
                >
                  <span style={{ fontWeight: 700, fontSize: 15 }} data-no-translate="true">
                    {item.nativeName}
                  </span>
                  <span
                    data-no-translate="true"
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      padding: "2px 6px",
                      borderRadius: 4,
                      background: isActive ? "var(--accent, #e49b3c)" : "rgba(255,255,255,0.08)",
                      color: isActive ? "#111" : "inherit"
                    }}
                  >
                    {item.code}
                  </span>
                </div>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    width: "100%",
                    fontSize: 12,
                    opacity: 0.78
                  }}
                >
                  <span>
                    <span>{item.name}</span> <span data-no-translate="true">({item.region})</span>
                  </span>
                  {isActive ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--accent, #e49b3c)", fontWeight: 600 }}>
                      <Check size={13} /> <span>Active</span>
                    </span>
                  ) : (
                    <span>{isSwitching ? "Loading..." : `${item.coveragePercent}% DB`}</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
