import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { playersApi } from "../../api/players";
import { carePackageApi, type CarePackageConfig, type CarePackageEntry } from "../../api/carePackage";
import type { CarePackageAutoGrantRule } from "../../api/carePackage";
import { friendlyApiError } from "../../api/client";
import { DataTable } from "../../components/common/DataTable";
import { TechnicalDetails } from "../../components/common/DisplayPrimitives";
import {
  ItemCatalogSelector,
  PackageItemPreview,
  catalogItemId,
  catalogItemName,
  grantItemDurability,
  type CatalogItem
} from "../../components/common/ItemCatalog";
import { formatUiSentence } from "../../lib/display";
import { titleCaseWords } from "../players/playerAdminUtils";

type HomeTaskResult = { status: "running" | "succeeded" | "failed" | "stopped"; title: string; message?: string; details?: string };
type ConfirmAction = (message: string, options?: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean; details?: { label: string; value: string; tone?: "danger" | "success" | "accent" }[] }) => Promise<boolean>;

function formatResultTitle(value: unknown, pending = false) {
  return formatUiSentence(value, pending);
}

function formatResultMessage(value: unknown) {
  return formatUiSentence(value, false);
}

export function CarePackagePanel({ onError, confirmAction }: { onError: (text: string) => void; confirmAction: ConfirmAction }) {
  const [config, setConfig] = useState<CarePackageConfig>({
    enabled: false,
    version: "",
    activeKitId: "",
    autoGrantKitId: "",
    kits: [],
    items: [],
    xp: 0,
    allowRepeatGrants: false,
    autoGrantEnabled: false,
    autoGrantIntervalSeconds: 60,
    grantWhen: "first_online",
    autoGrantRules: []
  });
  const [itemsText, setItemsText] = useState("");
  const [selectedPackageItem, setSelectedPackageItem] = useState<CatalogItem | null>(null);
  const [packageDraft, setPackageDraft] = useState({ itemName: "", itemId: "", quantity: "1" });
  const [editingPackageIndex, setEditingPackageIndex] = useState<number | null>(null);
  const [packageEditDraft, setPackageEditDraft] = useState({ quantity: "1" });
  const [players, setPlayers] = useState<Record<string, unknown>[]>([]);
  const [selectedPlayer, setSelectedPlayer] = useState("");
  const [manualPlayerId, setManualPlayerId] = useState("");
  const [manualKitId, setManualKitId] = useState("");
  const [eligibleByRule, setEligibleByRule] = useState<Record<string, Record<string, unknown>[]>>({});
  const [history, setHistory] = useState<Record<string, unknown>[]>([]);
  const [carePackageGrantTab, setCarePackageGrantTab] = useState<"auto" | "manual">("auto");
  const [carePackageTab, setCarePackageTab] = useState<"create" | "configure">("create");
  const [packageItemsOpen, setPackageItemsOpen] = useState(false);
  const [kitSaveResult, setKitSaveResult] = useState<HomeTaskResult | null>(null);
  const [packageCreateResult, setPackageCreateResult] = useState<HomeTaskResult | null>(null);
  const [autoGrantResult, setAutoGrantResult] = useState<HomeTaskResult | null>(null);
  const [manualGrantResult, setManualGrantResult] = useState<HomeTaskResult | null>(null);
  const [newKitName, setNewKitName] = useState("");
  const [newAutoRule, setNewAutoRule] = useState<{ kitId: string; grantWhen: CarePackageAutoGrantRule["grantWhen"]; lastSeenDays: number }>({ kitId: "", grantWhen: "first_online", lastSeenDays: 30 });
  const [expandedRuleIds, setExpandedRuleIds] = useState<Record<string, boolean>>({});
  const [output, setOutput] = useState("");
  const [technicalOutput, setTechnicalOutput] = useState("");
  const [outputScope, setOutputScope] = useState<"config" | "grant" | "auto" | "history" | "">("");
  async function run(action: () => Promise<unknown>) {
    onError("");
    setOutput("");
    setTechnicalOutput("");
    setOutputScope("");
    try { await action(); } catch (error) { const text = friendlyApiError(error); setOutput(text); onError(text); }
  }
  async function load() {
    const next = await carePackageApi.config();
    const normalized = normalizeCarePackageConfig(next);
    const lastKit = normalized.kits.at(-1);
    const displayConfig = lastKit ? { ...normalized, activeKitId: lastKit.id, version: lastKit.id, items: lastKit.items, xp: lastKit.xp } : normalized;
    setConfig(displayConfig);
    setCarePackageTab(lastKit ? "configure" : "create");
    setNewAutoRule({ kitId: lastKit?.id || normalized.autoGrantKitId || normalized.activeKitId, grantWhen: normalized.grantWhen, lastSeenDays: 30 });
    setManualKitId(lastKit?.id || normalized.activeKitId || "");
    setItemsText((lastKit?.items || normalized.items || []).map(carePackageItemTextLine).join("\n"));
    setHistory((await carePackageApi.history()).rows || []);
    setPlayers((await playersApi.list()).rows || []);
  }
  useEffect(() => {
    run(load);
  }, []);
  useEffect(() => {
    if (!kitSaveResult || kitSaveResult.status === "running") return undefined;
    const timer = window.setTimeout(() => setKitSaveResult(null), 5000);
    return () => window.clearTimeout(timer);
  }, [kitSaveResult]);
  useEffect(() => {
    if (!packageCreateResult || packageCreateResult.status === "running") return undefined;
    const timer = window.setTimeout(() => setPackageCreateResult(null), 5000);
    return () => window.clearTimeout(timer);
  }, [packageCreateResult]);
  useEffect(() => {
    if (!autoGrantResult || autoGrantResult.status === "running") return undefined;
    const timer = window.setTimeout(() => setAutoGrantResult(null), 5000);
    return () => window.clearTimeout(timer);
  }, [autoGrantResult]);
  useEffect(() => {
    if (!output || !outputScope) return undefined;
    const timer = window.setTimeout(() => {
      setOutput("");
      setTechnicalOutput("");
      setOutputScope("");
    }, 10000);
    return () => window.clearTimeout(timer);
  }, [output, outputScope]);
  function nextConfig(source = config): CarePackageConfig {
    const sourceActiveKit = carePackageActiveKit(source);
    return {
      ...source,
      allowRepeatGrants: false,
      grantWhen: source.grantWhen,
      items: source.kits.length === 0 ? [] : sourceActiveKit.items?.length ? sourceActiveKit.items : itemsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
        const [nameOrId, qty = "1"] = line.split(",").map((part) => part.trim());
        const item = /^[A-Za-z0-9_./:-]{16,}$/.test(nameOrId) ? { itemId: nameOrId } : { itemName: nameOrId };
        return { ...item, quantity: Number(qty), quality: 0, durability: grantItemDurability(), augments: [] };
      }),
      xp: sourceActiveKit.xp,
      kits: source.kits
    };
  }
  async function saveCarePackageConfigDraft(draft: CarePackageConfig, successTitle: string, resultTarget: "package" | "auto" | "create" | "setup" = "package") {
    const setResult = resultTarget === "auto" ? setAutoGrantResult : resultTarget === "create" || resultTarget === "setup" ? setPackageCreateResult : setKitSaveResult;
    setResult({ status: "running", title: resultTarget === "auto" ? "Saving Auto Grant..." : resultTarget === "create" ? "Creating Package..." : "Saving Package..." });
    try {
      const saved = normalizeCarePackageConfig(await carePackageApi.saveConfig(nextConfig(draft), "SAVE CARE PACKAGE"));
      setConfig(saved);
      const savedActiveKit = carePackageActiveKit(saved);
      setNewAutoRule((current) => ({
        kitId: saved.kits.some((kit) => kit.id === current.kitId) ? current.kitId : saved.autoGrantKitId || savedActiveKit.id,
        grantWhen: current.grantWhen,
        lastSeenDays: current.lastSeenDays
      }));
      setManualKitId((current) => saved.kits.some((kit) => kit.id === current) ? current : savedActiveKit.id);
      setItemsText(savedActiveKit.items.map(carePackageItemTextLine).join("\n"));
      if (!saved.kits.length) setCarePackageTab("create");
      setResult({ status: "succeeded", title: successTitle });
      return saved;
    } catch (error) {
      setResult({ status: "failed", title: resultTarget === "auto" ? "Auto Grant Save Failed." : resultTarget === "create" ? "Package Create Failed." : "Package Save Failed.", message: formatCarePackageError(error instanceof Error ? error.message : String(error)) });
      throw error;
    }
  }
  function setActiveKitId(nextId: string) {
    const nextKit = config.kits.find((kit) => kit.id === nextId) || config.kits[0];
    if (!nextKit) return;
    setConfig({ ...config, activeKitId: nextKit.id, version: nextKit.id, items: nextKit.items, xp: nextKit.xp });
    setManualKitId(nextKit.id);
    setItemsText(nextKit.items.map(carePackageItemTextLine).join("\n"));
    setEditingPackageIndex(null);
  }
  function updateActiveKit(patch: Partial<CarePackageEntry>) {
    const nextKits = config.kits.map((kit) => kit.id === activeKit.id ? { ...kit, ...patch } : kit);
    const nextActive = nextKits.find((kit) => kit.id === activeKit.id) || nextKits[0];
    setConfig({ ...config, kits: nextKits, activeKitId: nextActive.id, version: nextActive.id, items: nextActive.items, xp: nextActive.xp });
  }
  function addCarePackage() {
    const name = newKitName.trim();
    if (!name) {
      setPackageCreateResult({ status: "failed", title: "Package Create Failed.", message: "Package name is required." });
      return;
    }
    const nextIndex = config.kits.length + 1;
    const id = uniqueCarePackageId(config.kits, name || `care-package-${nextIndex}`);
    const nextKit = { id, name, items: [], xp: 0, sendMessage: "" };
    const draft = { ...config, kits: [...config.kits, nextKit], activeKitId: id, version: id, items: [], xp: 0 };
    run(async () => {
      await saveCarePackageConfigDraft(draft, "Package was created.", "create");
      setNewKitName("");
      setCarePackageTab("configure");
      setEditingPackageIndex(null);
      setSelectedPackageItem(null);
      setPackageDraft({ itemName: "", itemId: "", quantity: "1" });
    });
  }
  async function deleteActiveKit() {
    const attachedRule = config.autoGrantRules.find((rule) => rule.kitId === activeKit.id);
    if (attachedRule) {
      setPackageCreateResult({ status: "failed", title: "Package Delete Failed.", message: "Delete the Auto Grant rule first." });
      return;
    }
    if (!(await confirmAction("This package will be removed.", {
      title: "Delete Package",
      confirmLabel: "Delete",
      danger: true,
      details: [{ label: "Package", value: activeKit.name || "Unnamed package", tone: "danger" }]
    }))) return;
    const nextKits = config.kits.filter((kit) => kit.id !== activeKit.id);
    const nextActive = nextKits.at(-1);
    const autoGrantRules = config.autoGrantRules.filter((rule) => nextKits.some((kit) => kit.id === rule.kitId));
    const draft = {
      ...config,
      kits: nextKits,
      activeKitId: nextActive?.id || "",
      autoGrantKitId: nextKits.some((kit) => kit.id === config.autoGrantKitId) ? config.autoGrantKitId : nextActive?.id || "",
      version: nextActive?.id || "",
      items: nextActive?.items || [],
      xp: nextActive?.xp || 0,
      autoGrantEnabled: autoGrantRules.some((rule) => rule.enabled),
      autoGrantRules
    };
    run(async () => {
      await saveCarePackageConfigDraft(draft, "Package was deleted.", "setup");
      setEditingPackageIndex(null);
      setEligibleByRule({});
      if (!nextKits.length) setCarePackageTab("create");
    });
  }
  function addAutoGrantRule() {
    const kitId = config.kits.some((kit) => kit.id === newAutoRule.kitId) ? newAutoRule.kitId : activeKit.id;
    const grantWhen: CarePackageAutoGrantRule["grantWhen"] = newAutoRule.grantWhen === "last_seen" ? "last_seen" : "first_online";
    const lastSeenDays = Math.max(1, Number(newAutoRule.lastSeenDays) || 30);
    const duplicateRule = config.autoGrantRules.some((rule) => {
      const ruleGrantWhen = rule.grantWhen === "last_seen" ? "last_seen" : "first_online";
      if (ruleGrantWhen !== grantWhen) return false;
      if (grantWhen !== "last_seen") return true;
      return Math.max(1, Number(rule.lastSeenDays) || 30) === lastSeenDays;
    });
    if (duplicateRule) {
      setAutoGrantResult({
        status: "failed",
        title: "Auto Grant Rule Already Exists.",
        message: grantWhen === "last_seen"
          ? `A Last Seen rule for ${lastSeenDays} days ago already exists.`
          : "A First Online rule already exists."
      });
      return;
    }
    const id = uniquePackageRuleId(config.autoGrantRules, `auto-rule-${config.autoGrantRules.length + 1}`);
    const autoGrantRules = [...config.autoGrantRules, { id, enabled: false, kitId, grantWhen, lastSeenDays }];
    const draft = { ...config, autoGrantEnabled: autoGrantRules.some((rule) => rule.enabled), autoGrantRules };
    run(async () => { await saveCarePackageConfigDraft(draft, "Auto grant rule was created.", "auto"); });
  }
  function updateAutoGrantRule(id: string, patch: Partial<CarePackageAutoGrantRule>) {
    const currentRule = config.autoGrantRules.find((rule) => rule.id === id);
    const nextEnabled = typeof patch.enabled === "boolean" ? patch.enabled : currentRule?.enabled;
    const resultTitle = typeof patch.enabled === "boolean"
      ? `${carePackageRuleName(currentRule, config.kits)} was ${patch.enabled ? "enabled" : "disabled"}.`
      : "Auto grant rule was saved.";
    const autoGrantRules = config.autoGrantRules.map((rule) => rule.id === id ? { ...rule, ...patch } : rule);
    const draft = { ...config, autoGrantEnabled: autoGrantRules.some((rule) => rule.enabled), autoGrantRules };
    run(async () => {
      await saveCarePackageConfigDraft(draft, resultTitle, "auto");
      if (typeof nextEnabled === "boolean") setAutoGrantResult({ status: nextEnabled ? "succeeded" : "failed", title: resultTitle });
    });
  }
  async function deleteAutoGrantRule(id: string) {
    if (!(await confirmAction("Delete this Auto Grant rule?"))) return;
    const autoGrantRules = config.autoGrantRules.filter((rule) => rule.id !== id);
    const draft = { ...config, autoGrantEnabled: autoGrantRules.some((rule) => rule.enabled), autoGrantRules };
    run(async () => {
      await saveCarePackageConfigDraft(draft, "Auto grant rule was deleted.", "auto");
      setEligibleByRule((current) => {
        const { [id]: _removed, ...rest } = current;
        void _removed;
        return rest;
      });
      setExpandedRuleIds((current) => {
        const { [id]: _removed, ...rest } = current;
        void _removed;
        return rest;
      });
    });
  }
  function toggleRuleEligible(ruleId: string) {
    const nextOpen = !expandedRuleIds[ruleId];
    setExpandedRuleIds({ ...expandedRuleIds, [ruleId]: nextOpen });
    if (!nextOpen) return;
    run(async () => {
      const result = await carePackageApi.eligible(ruleId, true);
      setEligibleByRule((current) => ({ ...current, [ruleId]: result.rows || [] }));
    });
  }
  function choosePackageItem(item: CatalogItem | null) {
    setSelectedPackageItem(item);
    setPackageDraft({ ...packageDraft, itemName: item?.name || "", itemId: item?.id || "" });
  }
  function addPackageItem() {
    const item = packageDraft.itemId ? { itemId: packageDraft.itemId, itemName: packageDraft.itemName, image: selectedPackageItem?.image } : { itemName: packageDraft.itemName, image: selectedPackageItem?.image };
    if (!packageDraft.itemName && !packageDraft.itemId) return;
    const nextItems = [...(activeKit.items || []), { ...item, quantity: Number(packageDraft.quantity), quality: 0, durability: grantItemDurability(), augments: [] }];
    updateActiveKit({ items: nextItems });
    setItemsText(nextItems.map(carePackageItemTextLine).join("\n"));
  }
  function editPackageItem(index: number) {
    const item = activeKit.items?.[index];
    if (!item) return;
    setEditingPackageIndex(index);
    setPackageEditDraft({ quantity: String(item.quantity ?? 1) });
  }
  function savePackageItemEdit(index: number) {
    const nextItems = (activeKit.items || []).map((item, itemIndex) => {
      if (itemIndex !== index) return item;
      return { ...item, quantity: Number(packageEditDraft.quantity), quality: 0, durability: grantItemDurability(), augments: [] };
    });
    updateActiveKit({ items: nextItems });
    setItemsText(nextItems.map(carePackageItemTextLine).join("\n"));
    setEditingPackageIndex(null);
  }
  const activeKit = carePackageActiveKit(config);
  const manualKit = config.kits.find((kit) => kit.id === manualKitId) || activeKit;
  const packageItemCount = activeKit.items?.length || 0;
  const selected = players.find((player) => String(player.actor_id || player.player_pawn_id || "") === selectedPlayer) || null;
  const onlinePlayers = players.filter((player) => String(player.online_status || "").toLowerCase() === "online");
  const grantPlayerId = manualPlayerId.trim() || String(selected?.action_player_id || "");
  const manualGrantTargetName = String(selected?.character_name || grantPlayerId || "selected player");
  const historyRows = carePackageHistoryRows(history).filter((row) => String(row.status || "").toLowerCase() !== "skipped").slice(0, 10);
  return <section className="panel">
    <div className="panel-title"><h2>Care Package</h2></div>
    <div className="action-sections">
      <section className="action-section">
        <div className="panel-title">
          <h4>Care Package Configuration</h4>
          <button className={`switch-toggle care-package-toggle ${config.enabled ? "enabled" : "disabled"}`} onClick={() => run(async () => {
            const confirmation = config.enabled ? "DISABLE CARE PACKAGE" : "ENABLE CARE PACKAGE";
            setConfig(normalizeCarePackageConfig(await carePackageApi[config.enabled ? "disable" : "enable"](confirmation)));
          })}><span className="switch-label">Care Package</span><strong className="switch-state">{config.enabled ? "ON" : "OFF"}</strong></button>
        </div>
        <div className="settings-tabs" role="tablist" aria-label="Care Package setup">
          <button className={carePackageTab === "create" ? "active" : ""} role="tab" aria-selected={carePackageTab === "create"} onClick={() => setCarePackageTab("create")}>Create</button>
          <button className={carePackageTab === "configure" ? "active" : ""} role="tab" aria-selected={carePackageTab === "configure"} disabled={!config.kits.length} onClick={() => setCarePackageTab("configure")}>Configure</button>
          {packageCreateResult && <span className={`inline-task-result result-${packageCreateResult.status === "succeeded" ? "ok" : packageCreateResult.status === "failed" ? "fail" : "running"}`}>
            <strong className={packageCreateResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(packageCreateResult.title, packageCreateResult.status === "running")}</strong>
            {packageCreateResult.message && <span className="inline-task-message">{formatResultMessage(packageCreateResult.message)}</span>}
          </span>}
        </div>
        {carePackageTab === "create" ? <div className="care-package-builder care-package-create">
          <label className="care-package-new-field">New Package Name<input value={newKitName} onChange={(event) => setNewKitName(event.target.value)} placeholder="New package" /></label>
          <button onClick={addCarePackage}>Add Package</button>
        </div> : <>
        <div className="care-package-builder">
          <label className="compact-select">Select Package<select value={activeKit.id} onChange={(event) => setActiveKitId(event.target.value)}>{config.kits.map((kit) => <option key={kit.id} value={kit.id}>{kit.name || "Name Required"}</option>)}</select></label>
          <button className="danger" onClick={deleteActiveKit}>Delete Package</button>
        </div>
        <label className="care-package-name-field">Package Name<input value={activeKit.name} onChange={(event) => updateActiveKit({ name: event.target.value })} placeholder="Enter package name" /></label>
        <div className="package-xp-row">
          <span>Grant</span>
          <input type="number" min="0" value={String(activeKit.xp)} onChange={(event) => updateActiveKit({ xp: Number(event.target.value) })} />
          <span>XP</span>
        </div>
        <label className="package-message-field">Send Message<textarea value={activeKit.sendMessage || ""} onChange={(event) => updateActiveKit({ sendMessage: event.target.value })} placeholder="Optional private whisper after this package is granted" /></label>
        <div className={`playerAdmin_toggle ${packageItemsOpen ? "open" : ""}`}>
          <button className="playerAdmin_toggleHeader" aria-label={packageItemsOpen ? "Collapse Select Items" : "Expand Select Items"} onClick={() => setPackageItemsOpen(!packageItemsOpen)}>{packageItemsOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}<span>Select Items</span></button>
          {packageItemsOpen && <div className="playerAdmin_toggleBody"><div className="playerAdmin_section">
            <ItemCatalogSelector selected={selectedPackageItem} onSelect={choosePackageItem} />
            <div className="playerAdmin_itemActionStack">
              <div className="playerAdmin_itemInputLine">
                <span className="playerAdmin_actionLabel playerAdmin_itemSelectedLabel">Selected Item</span>
                <label className="playerAdmin_itemNumberField">Quantity<input className="package-item-quantity-input" type="number" min="1" value={packageDraft.quantity} onChange={(event) => setPackageDraft({ ...packageDraft, quantity: event.target.value })} /></label>
                <div className="playerAdmin_actionRow playerAdmin_itemActionRow">
                  <button disabled={!selectedPackageItem} onClick={addPackageItem}>Add Item</button>
                </div>
              </div>
              <p className="action-help-note">Care Package items are granted as live-safe Grade 0 rewards. Use Give Items for graded or augmented gear.</p>
            </div>
          </div></div>}
        </div>
        {activeKit.items?.length ? <div className="table-wrap package-items-table playerAdmin_itemsTable"><table><thead><tr><th>Preview</th><th>Item Name</th><th>Item ID</th><th>Quantity</th><th>Actions</th></tr></thead><tbody>{activeKit.items.map((item, index) => {
          const editing = editingPackageIndex === index;
          return <tr key={`${item.itemName || item.itemId}-${index}`}><td><PackageItemPreview item={item} /></td><td>{catalogItemName(item)}</td><td>{catalogItemId(item)}</td><td>{editing ? <input className="package-item-quantity-input" type="number" min="1" value={packageEditDraft.quantity} onChange={(event) => setPackageEditDraft({ ...packageEditDraft, quantity: event.target.value })} /> : item.quantity}</td><td className="package-actions-cell"><div className="service-actions">{editing ? <><button onClick={() => savePackageItemEdit(index)}>Save</button><button onClick={() => setEditingPackageIndex(null)}>Cancel</button></> : <button onClick={() => editPackageItem(index)}>Edit</button>}<button className="danger" onClick={() => {
          const nextItems = activeKit.items.filter((_, itemIndex) => itemIndex !== index);
          updateActiveKit({ items: nextItems });
          setItemsText(nextItems.map(carePackageItemTextLine).join("\n"));
          if (editingPackageIndex === index) setEditingPackageIndex(null);
        }}>Remove</button></div></td></tr>;
        })}</tbody></table></div> : null}
        <details className="technical-details"><summary>Developer raw package item textarea</summary><p>One item per line: item name or raw item ID, quantity. Extra legacy grade or augment columns are ignored for Care Packages.</p><label>Package Items<textarea value={itemsText} onChange={(event) => setItemsText(event.target.value)} placeholder="Plant Fiber,10&#10;cup of water,1" /></label></details>
        <div className="action-line">
          <button onClick={() => run(async () => {
            if (!(await confirmAction("These settings will be saved.", {
              title: "Save Package",
              confirmLabel: "Save",
              details: [{ label: "Package", value: activeKit.name || "Unnamed package", tone: "accent" }]
            }))) return;
            setKitSaveResult({ status: "running", title: "Saving Package..." });
            try {
              const saved = normalizeCarePackageConfig(await carePackageApi.saveConfig(nextConfig(), "SAVE CARE PACKAGE"));
              setConfig(saved);
              const savedActiveKit = carePackageActiveKit(saved);
              setItemsText(savedActiveKit.items.map(carePackageItemTextLine).join("\n"));
              setKitSaveResult({ status: "succeeded", title: "Package was saved successfully." });
            } catch (error) {
              setKitSaveResult({ status: "failed", title: "Package Save Failed.", message: formatCarePackageError(error instanceof Error ? error.message : String(error)) });
            }
          })}>Save Package</button>
          {kitSaveResult && <span className={`inline-task-result result-${kitSaveResult.status === "succeeded" ? "ok" : kitSaveResult.status === "failed" ? "fail" : "running"}`}>
            <strong className={kitSaveResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(kitSaveResult.title, kitSaveResult.status === "running")}</strong>
            {kitSaveResult.message && <span className="inline-task-message">{formatResultMessage(kitSaveResult.message)}</span>}
          </span>}
        </div>
        </>}
      </section>

      <section className="action-section">
        <div className="care-package-grant-header">
          <div className="settings-tabs" role="tablist" aria-label="Care Package grants">
            <button className={carePackageGrantTab === "auto" ? "active" : ""} role="tab" aria-selected={carePackageGrantTab === "auto"} onClick={() => setCarePackageGrantTab("auto")}>Auto Grant</button>
            <button className={carePackageGrantTab === "manual" ? "active" : ""} role="tab" aria-selected={carePackageGrantTab === "manual"} onClick={() => setCarePackageGrantTab("manual")}>Manual Grant</button>
            {manualGrantResult && <span className="inline-task-result result-running">
              <strong className="loading-dots">{formatResultTitle(manualGrantResult.title, true)}</strong>
            </span>}
          </div>
          {autoGrantResult && <span className={`inline-task-result result-${autoGrantResult.status === "succeeded" ? "ok" : autoGrantResult.status === "failed" ? "fail" : "running"}`}>
            <strong className={autoGrantResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(autoGrantResult.title, autoGrantResult.status === "running")}</strong>
            {autoGrantResult.message && <span className="inline-task-message">{formatResultMessage(autoGrantResult.message)}</span>}
          </span>}
        </div>
        {carePackageGrantTab === "auto" ? <>
          <div className="action-line package-auto-line">
            <label className="compact-field">Check Every (s)<input type="number" min="60" max="3600" value={String(config.autoGrantIntervalSeconds)} onChange={(event) => setConfig({ ...config, autoGrantIntervalSeconds: Number(event.target.value) })} /></label>
            <label className="compact-select">Package<select value={newAutoRule.kitId} onChange={(event) => setNewAutoRule({ ...newAutoRule, kitId: event.target.value })}>{config.kits.map((kit) => <option key={kit.id} value={kit.id}>{kit.name || "Name Required"}</option>)}</select></label>
            <label className="compact-select">Grant When<select value={newAutoRule.grantWhen} onChange={(event) => setNewAutoRule({ ...newAutoRule, grantWhen: event.target.value as CarePackageAutoGrantRule["grantWhen"] })}><option value="first_online">First Online</option><option value="last_seen">Last Seen</option></select></label>
            {newAutoRule.grantWhen === "last_seen" && <label className="compact-field">Days Ago<input type="number" min="1" max="3650" value={String(newAutoRule.lastSeenDays)} onChange={(event) => setNewAutoRule({ ...newAutoRule, lastSeenDays: Number(event.target.value) })} /></label>}
            <button disabled={!config.kits.length} onClick={addAutoGrantRule}>Create Rule</button>
          </div>
          <div className="package-auto-rules">
            {config.autoGrantRules.map((rule) => {
              const kit = config.kits.find((entry) => entry.id === rule.kitId);
              const ruleEligible = eligibleByRule[rule.id] || [];
              const expanded = Boolean(expandedRuleIds[rule.id]);
              const showEligibility = rule.grantWhen === "last_seen";
              return <article className="package-auto-rule" key={rule.id}>
                <button className={`switch-toggle package-rule-toggle ${rule.enabled ? "enabled" : "disabled"}`} onClick={() => updateAutoGrantRule(rule.id, { enabled: !rule.enabled })}><span className="switch-label">Rule</span><strong className="switch-state">{rule.enabled ? "ON" : "OFF"}</strong></button>
                <span className="package-rule-summary">Grants <span className="package-rule-package-name">{carePackageGrantSummary(kit)}</span> based on {carePackageConditionLabel(rule)}</span>
            <button className="icon-toggle-button danger package-rule-delete" aria-label="Delete Auto Grant rule" title="Delete" onClick={() => deleteAutoGrantRule(rule.id)}><X size={18} /></button>
                {showEligibility && <button className={`icon-toggle-button ${expanded ? "active" : ""}`} aria-label={expanded ? "Collapse Eligibility" : "Expand Eligibility"} title={expanded ? "Collapse" : "Expand"} onClick={() => toggleRuleEligible(rule.id)}>{expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</button>}
                {showEligibility && expanded && <div className="package-rule-eligible"><h5>Eligibility</h5>{ruleEligible.length ? <DataTable rows={carePackageEligibleRows(ruleEligible)} /> : <div className="empty package-history-empty">No eligible players were found for this rule.</div>}</div>}
              </article>;
            })}
          </div>
        </> : <>
          <div className="action-line">
            <label className="compact-select">Package<select value={manualKit.id} onChange={(event) => setManualKitId(event.target.value)}>{config.kits.map((kit) => <option key={kit.id} value={kit.id}>{kit.name || "Name Required"}</option>)}</select></label>
            <label className="package-player-select">Player<select className={selectedPlayer ? "package-player-selected-online" : ""} value={selectedPlayer} onChange={(event) => setSelectedPlayer(event.target.value)}>
              <option value="">{onlinePlayers.length ? "Select player" : "No players are online"}</option>
              {onlinePlayers.map((player) => {
                return <option className="package-player-option-online" key={String(player.actor_id || player.player_pawn_id || player.action_player_id)} value={String(player.actor_id || player.player_pawn_id || "")}>
                  {String(player.character_name || "Unknown")} (Online)
                </option>;
              })}
            </select></label>
            <button disabled={!grantPlayerId || !manualKit.id || manualGrantResult?.status === "running"} onClick={() => run(async () => {
              if (!(await confirmAction("This package will be sent to the selected player.", {
                title: "Grant Package",
                confirmLabel: "Grant",
                details: [
                  { label: "Package", value: manualKit.name || "Unnamed package", tone: "accent" },
                  { label: "Player", value: manualGrantTargetName, tone: "success" }
                ]
              }))) return;
              setManualGrantResult({ status: "running", title: `Granting ${manualKit.name || "package"} to ${manualGrantTargetName}...` });
              try {
                showGrantResult("grant", await carePackageApi.grant(grantPlayerId, "GRANT CARE PACKAGE", manualKit.id));
                setHistory((await carePackageApi.history()).rows || []);
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                setOutputScope("grant");
                setOutput(`FAIL: ${formatCarePackageError(message)}`);
                setTechnicalOutput(message);
              } finally {
                setManualGrantResult(null);
              }
            })}>Grant Package</button>
          </div>
          {selected && !selected.action_player_id && <p className="danger-note">Selected player has no Admin action ID, so CLI-backed grants are disabled.</p>}
          <details className="technical-details">
            <summary>Advanced manual player ID override</summary>
            <label>Admin action ID<input value={manualPlayerId} onChange={(event) => setManualPlayerId(event.target.value)} placeholder="RedBlink#75570" /></label>
          </details>
          <CarePackageResult output={outputScope === "grant" ? output : ""} technicalOutput={outputScope === "grant" ? technicalOutput : ""} />
        </>}
      </section>

      <section className="action-section">
        <div className="panel-title">
          <h4>Grant History</h4>
          <button disabled={!historyRows.length} onClick={() => run(async () => {
            if (!(await confirmAction("Clear Care Package grant history?"))) return;
            await carePackageApi.clearHistory();
            setHistory([]);
            setOutputScope("history");
            setOutput("");
            setTechnicalOutput("");
          })}>Clear</button>
        </div>
        <CarePackageResult output={outputScope === "history" ? output : ""} technicalOutput={outputScope === "history" ? technicalOutput : ""} />
        <div className="package-history-table">
          {historyRows.length ? <DataTable rows={historyRows} columns={["timestamp", "character_name", "action_player_id", "source", "status", "summary"]} action={(row) => String(row.status || "").toLowerCase() === "failed" ? <button onClick={() => run(async () => {
            if (!(await confirmAction("Retry this failed grant?", {
              title: "Retry Grant",
              confirmLabel: "Retry",
              details: [
                { label: "Package", value: carePackageHistoryPackageName(row), tone: "accent" },
                { label: "Player", value: carePackageHistoryPlayerName(row), tone: "success" }
              ]
            }))) return;
            showGrantResult("history", await carePackageApi.retry(String(row.id), "RETRY CARE PACKAGE"));
            setHistory((await carePackageApi.history()).rows || []);
          })}>Retry</button> : null} /> : <div className="empty package-history-empty">No Care Package grants have been recorded yet.</div>}
        </div>
      </section>
    </div>
    <details className="technical-details">
      <summary>Raw Care Package JSON</summary>
      <pre className="mini-output">{JSON.stringify(displayCarePackageConfig(config), null, 2)}</pre>
    </details>
  </section>;

  function showGrantResult(scope: "grant" | "auto" | "history", result: Record<string, unknown>) {
    setOutputScope(scope);
    setOutput(formatCarePackageGrantResult(result));
    setTechnicalOutput(JSON.stringify(result, null, 2));
  }
}

function normalizeCarePackageConfig(config: CarePackageConfig): CarePackageConfig {
  const hasLegacyPackage = !Array.isArray(config.kits) && ((Array.isArray(config.items) && config.items.length > 0) || Number(config.xp) > 0);
  const fallbackKit: CarePackageEntry = { id: config.version || "care-package-v1", name: "Care Package", items: config.items || [], xp: Number(config.xp) || 0, sendMessage: "" };
  const rawKits = Array.isArray(config.kits) ? config.kits : hasLegacyPackage ? [fallbackKit] : [];
  const kits = rawKits.map((kit, index) => ({
    id: kit.id || `care-package-${index + 1}`,
    name: typeof kit.name === "string" ? kit.name : (index === 0 ? "Care Package" : `Care Package ${index + 1}`),
    items: kit.items || [],
    xp: Number(kit.xp) || 0,
    sendMessage: normalizeCarePackageSendMessage(kit.sendMessage)
  }));
  const activeKitId = kits.some((kit) => kit.id === config.activeKitId) ? config.activeKitId : kits[0]?.id || "";
  const autoGrantKitId = kits.some((kit) => kit.id === config.autoGrantKitId) ? config.autoGrantKitId : activeKitId;
  const activeKit = kits.find((kit) => kit.id === activeKitId) || kits[0] || { id: "", name: "", items: [], xp: 0, sendMessage: "" };
  const autoGrantRules = (kits.length && Array.isArray(config.autoGrantRules) ? config.autoGrantRules : []).map((rule, index) => ({
    id: rule.id || `auto-rule-${index + 1}`,
    enabled: rule.enabled === true,
    kitId: kits.some((kit) => kit.id === rule.kitId) ? rule.kitId : autoGrantKitId,
    grantWhen: rule.grantWhen === "last_seen" ? "last_seen" as const : "first_online" as const,
    lastSeenDays: Number(rule.lastSeenDays) || 30
  }));
  const grantWhen = config.grantWhen === "last_seen" ? "last_seen" : "first_online";
  return { ...config, version: activeKit.id, activeKitId, autoGrantKitId, kits, items: activeKit.items, xp: activeKit.xp, allowRepeatGrants: false, autoGrantEnabled: autoGrantRules.some((rule) => rule.enabled), grantWhen, autoGrantRules };
}

function normalizeCarePackageSendMessage(value: unknown) {
  const text = typeof value === "string" ? value : "";
  return text.trim() === "Welcome to the server" ? "" : text;
}

function displayCarePackageConfig(config: CarePackageConfig) {
  const { version, allowRepeatGrants, ...visible } = config;
  void version;
  void allowRepeatGrants;
  return visible;
}

function formatCarePackageError(value: string) {
  const text = friendlyApiError(value || "").trim()
    .replaceAll("Care Package", "Care Package")
    .replaceAll("care package", "care package")
    .replaceAll(" kit", " package")
    .replaceAll(" Kit", " Package");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Care Package save failed.";
}

function carePackageActiveKit(config: CarePackageConfig) {
  return config.kits.find((kit) => kit.id === config.activeKitId) || config.kits[0] || { id: "", name: "", items: [], xp: 0 };
}

function carePackageGrantSummary(kit?: CarePackageEntry) {
  if (!kit) return "Unknown Package";
  const parts = [];
  if (kit.xp) parts.push(`${kit.xp} XP`);
  if (kit.items?.length) parts.push(`${kit.items.length} item${kit.items.length === 1 ? "" : "s"}`);
  return `${kit.name || "Name Required"}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

function carePackageItemTextLine(item: Record<string, unknown>) {
  const nameOrId = String(item.itemId || item.itemName || "").trim();
  const quantity = Number(item.quantity || 1);
  return `${nameOrId},${Number.isFinite(quantity) && quantity > 0 ? Math.trunc(quantity) : 1}`;
}

function carePackageRuleName(rule: CarePackageAutoGrantRule | undefined, kits: CarePackageEntry[]) {
  const kit = kits.find((entry) => entry.id === rule?.kitId);
  return kit?.name ? `${kit.name} rule` : "Auto Grant rule";
}

function carePackageConditionLabel(rule: CarePackageAutoGrantRule) {
  if (rule.grantWhen === "last_seen") return `Last Seen ${Number(rule.lastSeenDays) || 30} Days Ago`;
  return "First Online";
}

function uniqueCarePackageId(kits: CarePackageEntry[], base: string) {
  const normalized = base.toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "") || "care-package";
  let id = normalized;
  let index = 2;
  while (kits.some((kit) => kit.id === id)) {
    id = `${normalized}-${index}`;
    index += 1;
  }
  return id;
}

function uniquePackageRuleId(rules: CarePackageAutoGrantRule[], base: string) {
  const normalized = base.toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "") || "auto-rule";
  let id = normalized;
  let index = 2;
  while (rules.some((rule) => rule.id === id)) {
    id = `${normalized}-${index}`;
    index += 1;
  }
  return id;
}

function carePackageEligibleRows(rows: Record<string, unknown>[]) {
  return rows.map((row) => ({
    character_name: row.character_name || "Unknown",
    online_status: row.online_status || "",
    eligible: row.eligible ? "True" : "False",
    reason: row.reason || "",
    action_player_id: row.action_player_id || "",
    actor_id: row.actor_id || ""
  }));
}

function carePackageHistoryRows(rows: Record<string, unknown>[]) {
  return rows.map((row) => ({
    ...row,
    timestamp: String(row.local_timestamp || row.timestamp || ""),
    character_name: titleCaseWords(String(row.character_name || "Unknown")),
    source: titleCaseWords(String(row.source || "")),
    status: titleCaseWords(String(row.status || "")),
    summary: titleCaseWords(String(row.summary || ""))
  }));
}

function carePackageHistoryPackageName(row: Record<string, unknown>) {
  return String(row.kitName || row.packageName || row.version || "Selected package");
}

function carePackageHistoryPlayerName(row: Record<string, unknown>) {
  return String(row.character_name || row.playerName || row.action_player_id || row.playerId || "Selected player");
}

function CarePackageResult({ output, technicalOutput }: { output: string; technicalOutput: string }) {
  if (!output) return null;
  const rows = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return <div className="result-panel care-package-result">
    <strong>Care Package Result</strong>
    <ul className="result-list">
      {rows.map((line, index) => {
        const status = /^OK:/i.test(line) ? "ok" : /^FAIL:/i.test(line) || /failed/i.test(line) ? "fail" : "info";
        return <li className={`result-row result-${status} ${/relog required/i.test(line) ? "result-has-warning" : ""}`} key={`${line}-${index}`}>{formatCarePackageResultMessage(friendlyCarePackageResultLine(line))}</li>;
      })}
    </ul>
    {technicalOutput && <TechnicalDetails text={technicalOutput} />}
  </div>;
}

function formatCarePackageResultMessage(line: string) {
  const match = line.match(/^(.*?)(\s*Relog required before the item appears correctly\.?)$/i);
  if (!match) return formatResultMessage(line);
  return <>
    {formatResultMessage(match[1].trim())}
    <span className="care-package-relog-warning">{formatResultMessage(match[2].trim())}</span>
  </>;
}

function friendlyCarePackageResultLine(line: string) {
  return line
    .replace(/^OK:\s*/i, "Granted ")
    .replace(/^FAIL:\s*/i, "Failed ")
    .replace(/\s+granted$/i, "")
    .replace(/\s+failed:/i, ":")
    .replace(/\s+/g, " ")
    .trim();
}

function formatCarePackageGrantResult(result: Record<string, unknown>) {
  if (Array.isArray(result.results) && result.results.some((row) => row && typeof row === "object" && "status" in row)) {
    const rows = result.results as Record<string, unknown>[];
    const lines = [
      `Care Package bulk grant finished: ${result.granted || 0} granted, ${result.skipped || 0} skipped, ${result.failed || 0} failed.`
    ];
    rows.slice(0, 20).forEach((row) => {
      const name = row.character_name || row.action_player_id || row.playerId || "Unknown player";
      lines.push(`${String(row.status || "unknown").toUpperCase()}: ${name} - ${row.summary || row.reason || ""}`);
    });
    return lines.join("\n");
  }
  const status = String(result.status || (result.ok ? "granted" : "failed"));
  const lines: string[] = [];
  if (Array.isArray(result.results)) {
    for (const action of result.results as Record<string, unknown>[]) {
      if (action.ok) {
        const warning = carePackageActionError(action);
        lines.push(`OK: ${describeCarePackageAction(action)}${warning ? `. ${warning}` : ""}`);
      }
      else if (action.operation === "adminAddXp" || action.item) {
        const reason = carePackageActionError(action);
        lines.push(`FAIL: ${describeCarePackageAction(action)} could not be granted.${reason ? ` ${reason}` : ""}`);
      } else {
        const reason = carePackageActionError(action);
        lines.push(`FAIL: to grant ${describeCarePackageAction(action)}${reason ? `: ${reason}` : ""}`);
      }
    }
  }
  if (!lines.length) {
    if (status === "skipped") lines.push(`FAIL: ${result.reason || "grant was skipped"}`);
    else lines.push(`FAIL: ${result.summary || "grant failed"}`);
  }
  return lines.join("\n");
}

function carePackageActionError(action: Record<string, unknown>) {
  const error = action.error || action.warning || action.stderr || action.reason;
  return typeof error === "string" && error.trim() ? formatUiSentence(error.trim(), false) : "";
}

function describeCarePackageAction(action: Record<string, unknown>) {
  const item = action.item as Record<string, unknown> | undefined;
  if (item) return `${item.itemName || item.itemId || "Item"} x${item.quantity || 1}`;
  if (action.operation === "adminAddXp") return `${action.amount || 0} XP`;
  if (action.operation === "carePackageWelcomeWhisper") return "Whisper Message";
  return String(action.operation || "Care Package action");
}
