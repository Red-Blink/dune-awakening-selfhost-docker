import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  marketBotApi,
  type MarketAugmentPricing,
  type MarketBotStatus,
  type MarketBuybackLogBatch,
  type MarketCategoryMultipliers,
  type CommodityStackGroup,
  type CommodityStackItem,
  type MarketExchange,
  type MarketPriceBasis,
  type MarketProbeResult,
  type MarketSeedPlanInfo
} from "../../api/marketBot";
import { InfoTooltip } from "../../components/common/DisplayPrimitives";
import { invalidSeedPlanCsvMessage } from "./seedPlanCsvGuard";

// Console-managed NPC market bot (EDA Exchange Bot engine, first-class):
// seed the CHOAM exchange with NPC sell listings from the active named seed
// plan, and buy back player listings priced at or below a percentage of a
// reference price. Schedules run inside the console API process (no page needs
// to stay open); every write is preceded by a database backup.

type MarketBotOverlayProps = {
  onClose: () => void;
  onError: (text: string) => void;
  confirmAction: (message: string, options?: { title?: string; confirmLabel?: string; warning?: string; danger?: boolean }) => Promise<boolean>;
};

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function SectionTitle({ title, id, help }: { title: string; id: string; help: string }) {
  return <div className="market-bot-section-title">
    <strong>{title}</strong>
    <InfoTooltip id={id} label={`About ${title}`}>{help}</InfoTooltip>
  </div>;
}

// Per-category price multipliers (1-5x) layered on top of the base price
// multiplier. Rendered identically in the buyback and reseed sections; the
// aria labels are prefixed with the section so both stay addressable.
const CATEGORY_MULTIPLIER_FIELDS: Array<{ key: keyof MarketCategoryMultipliers; label: string }> = [
  { key: "augmentMultiplier", label: "Augment Multiplier" },
  { key: "rankedArmorMultiplier", label: "Ranked Armor Multiplier" },
  { key: "rankedWeaponMultiplier", label: "Ranked Weapon Multiplier" }
];

function defaultCategoryMultipliers(): MarketCategoryMultipliers {
  return { augmentMultiplier: 1, rankedArmorMultiplier: 1, rankedWeaponMultiplier: 1 };
}

function categoryMultipliersFrom(schedule: Partial<MarketCategoryMultipliers>): MarketCategoryMultipliers {
  return {
    augmentMultiplier: schedule.augmentMultiplier ?? 1,
    rankedArmorMultiplier: schedule.rankedArmorMultiplier ?? 1,
    rankedWeaponMultiplier: schedule.rankedWeaponMultiplier ?? 1
  };
}

const COMMODITY_STACK_MIN = 1;
const COMMODITY_STACK_MAX = 20;
const COMMODITY_STACK_DEFAULT = 2;

function commodityStacksFrom(saved: Record<string, number> | undefined, catalog: CommodityStackItem[]): Record<string, number> {
  const next: Record<string, number> = {};
  for (const item of catalog) {
    const value = saved?.[item.templateId];
    next[item.templateId] = Number.isInteger(value) ? Number(value) : COMMODITY_STACK_DEFAULT;
  }
  return next;
}

function catalogGroups(catalog: CommodityStackItem[], groups: CommodityStackGroup[]): CommodityStackGroup[] {
  if (groups.length) {
    return groups.filter((group) => catalog.some((item) => item.group === group.id));
  }
  const seen = new Set<string>();
  const derived: CommodityStackGroup[] = [];
  for (const item of catalog) {
    if (seen.has(item.group)) continue;
    seen.add(item.group);
    derived.push({ id: item.group, label: item.group });
  }
  return derived;
}

type CommodityStackInputsProps = {
  catalog: CommodityStackItem[];
  groups: CommodityStackGroup[];
  values: Record<string, number>;
  onChange: (next: Record<string, number>) => void;
};

function CommodityStackInputs({ catalog, groups, values, onChange }: CommodityStackInputsProps) {
  if (!catalog.length) return null;
  return (
    <div className="market-bot-commodity-stacks">
      {catalogGroups(catalog, groups).map((group) => (
        <div key={group.id} className="market-bot-commodity-group">
          <strong>{group.label}</strong>
          <div className="market-bot-commodity-grid">
            {catalog.filter((item) => item.group === group.id).map((item) => {
              const stacks = values[item.templateId] ?? COMMODITY_STACK_DEFAULT;
              const units = stacks * item.stackSize;
              return (
                <label key={item.templateId}>{item.label}
                  <input
                    aria-label={`${item.label} Stacks`}
                    type="number"
                    min={COMMODITY_STACK_MIN}
                    max={COMMODITY_STACK_MAX}
                    value={stacks}
                    onChange={(event) => onChange({ ...values, [item.templateId]: Number(event.target.value) })}
                  />
                  <span className="stack-hint">{stacks} × {item.stackSize.toLocaleString()} = {units.toLocaleString()} units</span>
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

type CategoryMultiplierInputsProps = {
  section: "Buyback" | "Seed";
  values: MarketCategoryMultipliers;
  onChange: (next: MarketCategoryMultipliers) => void;
};

function CategoryMultiplierInputs({ section, values, onChange }: CategoryMultiplierInputsProps) {
  return (
    <>
      {CATEGORY_MULTIPLIER_FIELDS.map(({ key, label }) => (
        <label key={key}>{label}
          <input
            aria-label={`${section} ${label}`}
            type="number"
            min={1}
            max={5}
            step={0.5}
            value={values[key]}
            onChange={(event) => onChange({ ...values, [key]: Number(event.target.value) })}
          />
        </label>
      ))}
    </>
  );
}

function exchangeLabel(exchange: MarketExchange) {
  const parts = [
    exchange.isGlobal ? `Global (ID ${exchange.exchangeId})` : `Exchange ${exchange.exchangeId}`,
    `${exchange.accessPoints} Access Point${exchange.accessPoints === 1 ? "" : "s"}`,
    `${exchange.botOrders} Bot / ${exchange.playerOrders} Player Orders`
  ];
  return parts.join(" — ");
}

function runSummary(schedule: { lastRunAt: string; lastRunStatus: string; lastRunDetail: string; nextRunAt: string; enabled: boolean }) {
  const parts: string[] = [];
  if (schedule.enabled && schedule.nextRunAt) parts.push(`Next run ${new Date(schedule.nextRunAt).toLocaleString()}`);
  if (schedule.lastRunAt) parts.push(`Last run ${new Date(schedule.lastRunAt).toLocaleString()}${schedule.lastRunStatus ? ` (${schedule.lastRunStatus})` : ""}${schedule.lastRunDetail ? `: ${schedule.lastRunDetail}` : ""}`);
  return parts.length ? parts.join(" | ") : "No runs yet.";
}

function planOptionLabel(plan: MarketSeedPlanInfo) {
  const count = plan.rows ? ` · ${plan.rows.toLocaleString()} rows` : "";
  return `${plan.name}${plan.active ? " (active)" : ""}${count}`;
}

function downloadBlob(filename: string, blob: Blob) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
}

function buybackOverrides(exchangeId: string, priceMultiplier: number, category: MarketCategoryMultipliers, buybackPercent: number, buybackPriceBasis: MarketPriceBasis, maxBuys: number) {
  return {
    ...(exchangeId ? { exchangeId } : {}),
    priceMultiplier,
    ...category,
    buybackPercent,
    buybackPriceBasis,
    maxBuys
  };
}

function logExchangeLabel(batch: MarketBuybackLogBatch) {
  return batch.exchangeId ? `Exchange ${batch.exchangeId}` : "Exchange unknown";
}

function formatLogTime(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
}

function BuybackSweepLog({
  batches,
  busy,
  onRefresh,
  onClear
}: {
  batches: MarketBuybackLogBatch[];
  busy: string;
  onRefresh: () => void;
  onClear: () => void;
}) {
  const latest = batches[0];
  return (
    <div className="market-bot-section market-bot-log-section">
      <SectionTitle
        title="Buyback Sweep Log"
        id="market-bot-log-help"
        help="Write sweeps record purchases and eligible leftovers. Dry-run refreshes classify listings without buying anything or taking a backup. Results are capped at 1,000 rows, with up to 20 batches retained for five days. Codes: 0x0 bought or eligible; 0x1 price too high; 0x2 no reference price; 0x3 invalid price; 0x4 invalid stack; 0x5 sweep limit; 0x6 listing was locked by another sweep."
      />
      <div className="confirm-modal-actions market-bot-actions">
        <button onClick={onRefresh} disabled={Boolean(busy)}>{busy === "refresh-log" ? "Refreshing…" : "Refresh Log (Dry-Run)"}</button>
        <button onClick={onClear} disabled={Boolean(busy) || !batches.length}>{busy === "clear-log" ? "Clearing…" : "Clear Log"}</button>
      </div>
      <p className="muted" role="status">
        {batches.length
          ? `${batches.length} log batch(es) stored. Latest: ${latest.source} on ${logExchangeLabel(latest)} at ${formatLogTime(latest.at)} — ${latest.summary || `${latest.entries?.length || 0} listings`}.`
          : "No buyback sweep attempts logged yet."}
      </p>
      <div className="market-bot-log" aria-label="Buyback Sweep Log">
        {!batches.length && <p className="muted market-bot-log-empty">Run a buyback sweep or Refresh log (dry-run) to classify player sell listings.</p>}
        {batches.map((batch, index) => (
          <div className="market-bot-log-batch" key={`${batch.at}-${batch.exchangeId}-${index}`}>
            <h4>{batch.source} <span className="badge">{logExchangeLabel(batch)}</span> <span className="muted">{formatLogTime(batch.at)}</span></h4>
            <p className="muted">{batch.summary}{batch.note ? ` — ${batch.note}` : ""}</p>
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Result</th>
                  <th>Item</th>
                  <th>Grade</th>
                  <th>Ask / Unit</th>
                  <th>Stack</th>
                  <th>Cap</th>
                  <th>Order</th>
                  <th>Info</th>
                </tr>
              </thead>
              <tbody>
                {(batch.entries || []).length ? batch.entries.map((entry) => (
                  <tr key={`${entry.orderId}-${entry.resultHex}`} className={entry.resultCode === 0 ? "ok" : "skip"}>
                    <td><code>{entry.resultHex}</code></td>
                    <td>{entry.resultLabel}</td>
                    <td>{entry.displayName || entry.templateId}</td>
                    <td>{entry.qualityLevel}</td>
                    <td>{entry.itemPrice}</td>
                    <td>{entry.stackSize}</td>
                    <td>{entry.maxUnitPrice || "—"}</td>
                    <td>{entry.orderId}</td>
                    <td><details className="market-bot-row-info"><summary aria-label={`Details for Order ${entry.orderId}`}>i</summary><span>{entry.detail || "No additional detail was recorded."}</span></details></td>
                  </tr>
                )) : (
                  <tr><td colSpan={9} className="muted">No player sell listings on this exchange.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MarketBotOverlay({ onClose, onError, confirmAction }: MarketBotOverlayProps) {
  const [activeTab, setActiveTab] = useState<"buyback" | "reseed" | "activity">("buyback");
  const [status, setStatus] = useState<MarketBotStatus | null>(null);
  const [exchanges, setExchanges] = useState<MarketExchange[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [probeResult, setProbeResult] = useState<MarketProbeResult | null>(null);
  const [logBatches, setLogBatches] = useState<MarketBuybackLogBatch[]>([]);

  const [exchangeId, setExchangeId] = useState("");
  const [buybackEnabled, setBuybackEnabled] = useState(false);
  const [buybackInterval, setBuybackInterval] = useState(30);
  const [buybackMultiplier, setBuybackMultiplier] = useState(5);
  const [buybackCategoryMultipliers, setBuybackCategoryMultipliers] = useState(defaultCategoryMultipliers);
  const [buybackPercent, setBuybackPercent] = useState(60);
  const [buybackBasis, setBuybackBasis] = useState<MarketPriceBasis>("seeded");
  const [maxBuys, setMaxBuys] = useState(500);
  const [seedEnabled, setSeedEnabled] = useState(false);
  const [seedInterval, setSeedInterval] = useState(15);
  const [seedMultiplier, setSeedMultiplier] = useState(5);
  const [seedCategoryMultipliers, setSeedCategoryMultipliers] = useState(defaultCategoryMultipliers);
  const [augmentPricing, setAugmentPricing] = useState<MarketAugmentPricing>("discounted");
  const [commodityCatalog, setCommodityCatalog] = useState<CommodityStackItem[]>([]);
  const [commodityGroups, setCommodityGroups] = useState<CommodityStackGroup[]>([]);
  const [commodityStacks, setCommodityStacks] = useState<Record<string, number>>({});
  const [selectedPlanId, setSelectedPlanId] = useState("bundled");
  const [planNameDraft, setPlanNameDraft] = useState("");
  const csvInputRef = useRef<HTMLInputElement>(null);

  function applyStatus(next: MarketBotStatus, options: { populateForm?: boolean } = {}) {
    setStatus(next);
    const catalog = next.commodityStackCatalog || [];
    const groups = next.commodityStackGroups || [];
    setCommodityCatalog(catalog);
    setCommodityGroups(groups);
    if (options.populateForm) {
      setBuybackEnabled(Boolean(next.buyback.enabled));
      setBuybackInterval(next.buyback.intervalMinutes);
      setBuybackMultiplier(next.buyback.priceMultiplier);
      setBuybackCategoryMultipliers(categoryMultipliersFrom(next.buyback));
      setBuybackPercent(next.buyback.buybackPercent);
      setBuybackBasis(next.buyback.buybackPriceBasis || "seeded");
      setMaxBuys(next.buyback.maxBuys);
      setSeedEnabled(Boolean(next.seed.enabled));
      setSeedInterval(next.seed.intervalMinutes);
      setSeedMultiplier(next.seed.priceMultiplier);
      setSeedCategoryMultipliers(categoryMultipliersFrom(next.seed));
      setAugmentPricing(next.seed.augmentPricing === "original" ? "original" : "discounted");
      setCommodityStacks(commodityStacksFrom(next.seed.commodityStacks, catalog));
      setExchangeId((current) => current || next.buyback.exchangeId || next.seed.exchangeId || "");
      const activeId = next.plans?.activePlanId || next.plan.id || "bundled";
      setSelectedPlanId(activeId);
      const activePlan = next.plans?.items?.find((plan) => plan.id === activeId);
      setPlanNameDraft(activePlan?.source === "custom" ? activePlan.name : "");
    } else {
      const plans = next.plans?.items || [];
      setSelectedPlanId((current) => (current && plans.some((plan) => plan.id === current) ? current : (next.plans?.activePlanId || next.plan.id || "bundled")));
    }
  }

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      marketBotApi.status(),
      marketBotApi.exchanges(),
      marketBotApi.buybackLog().catch(() => ({ batches: [] as MarketBuybackLogBatch[] }))
    ])
      .then(([nextStatus, exchangeList, log]) => {
        if (cancelled) return;
        applyStatus(nextStatus, { populateForm: true });
        setExchanges(exchangeList.rows || []);
        setExchangeId((current) => current || exchangeList.rows?.[0]?.exchangeId || "");
        setLogBatches(log.batches || []);
        setLoading(false);
      })
      .catch((error) => {
        if (cancelled) return;
        onError(errorText(error));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [onError]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setInterval(() => {
      void marketBotApi.buybackLog()
        .then((log) => {
          if (!cancelled) setLogBatches(log.batches || []);
        })
        .catch(() => { /* keep the last successful log view */ });
    }, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  async function refreshStatus() {
    try {
      applyStatus(await marketBotApi.status());
    } catch {
      // Non-fatal: the action that triggered the refresh already reported.
    }
  }

  async function refreshLog() {
    try {
      setLogBatches((await marketBotApi.buybackLog()).batches || []);
    } catch {
      // Non-fatal: the action that triggered the refresh already reported.
    }
  }

  async function run(label: string, action: () => Promise<string>) {
    setBusy(label);
    setNotice("");
    onError("");
    try {
      setNotice(await action());
      await refreshStatus();
      await refreshLog();
    } catch (error) {
      onError(errorText(error));
    } finally {
      setBusy("");
    }
  }

  function saveBuyback() {
    return run("save-buyback", async () => {
      const saved = await marketBotApi.saveBuybackSchedule({
        enabled: buybackEnabled,
        intervalMinutes: buybackInterval,
        priceMultiplier: buybackMultiplier,
        ...buybackCategoryMultipliers,
        buybackPercent,
        buybackPriceBasis: buybackBasis,
        maxBuys,
        ...(exchangeId ? { exchangeId } : {})
      });
      return saved.enabled
        ? `Buyback schedule saved: every ${saved.intervalMinutes} min on exchange ${saved.exchangeId}. First run fires one full interval after enabling.`
        : "Buyback schedule saved (disabled).";
    });
  }

  function saveSeed() {
    return run("save-seed", async () => {
      const saved = await marketBotApi.saveSeedSchedule({
        enabled: seedEnabled,
        intervalMinutes: seedInterval,
        priceMultiplier: seedMultiplier,
        ...seedCategoryMultipliers,
        augmentPricing,
        commodityStacks,
        ...(exchangeId ? { exchangeId } : {})
      });
      return saved.enabled
        ? `Reseed schedule saved: every ${saved.intervalMinutes} min on exchange ${saved.exchangeId}. Every run is backup, clear bot listings, seed.`
        : "Reseed schedule saved (disabled).";
    });
  }

  function probe() {
    return run("probe", async () => {
      const result = await marketBotApi.probeBuyback(buybackOverrides(exchangeId, buybackMultiplier, buybackCategoryMultipliers, buybackPercent, buybackBasis, maxBuys));
      setProbeResult(result);
      return `${result.eligible.toLocaleString()} eligible player listing(s) on exchange ${result.exchangeId} at ${result.buybackPercent}% (read-only; no backup taken).`;
    });
  }

  async function runBuybackNow() {
    const confirmed = await confirmAction(
      "Run a buyback sweep now with the saved schedule settings? The console probes eligibility first and takes a database backup only when there is something to buy.",
      { title: "Run Buyback Sweep", confirmLabel: "Run Sweep", danger: true }
    );
    if (!confirmed) return;
    await run("run-buyback", async () => {
      const result = await marketBotApi.runBuyback();
      if (result.status === "swept") {
        return `Sweep finished: bought ${result.purchased ?? 0} listing(s), ${result.totalUnits ?? "0"} units for ${result.totalSolari ?? "0"} Solari.`;
      }
      return result.detail || "Nothing eligible; no backup was taken.";
    });
  }

  function refreshLogDryRun() {
    return run("refresh-log", async () => {
      const result = await marketBotApi.refreshBuybackLog(buybackOverrides(exchangeId, buybackMultiplier, buybackCategoryMultipliers, buybackPercent, buybackBasis, maxBuys));
      setLogBatches(result.batches || []);
      const count = result.entries?.length ?? result.batches?.[0]?.entries?.length ?? 0;
      return `Buyback log refreshed: ${count.toLocaleString()} player sell listing(s) classified on exchange ${result.exchangeId || exchangeId} (dry-run).`;
    });
  }

  function clearLog() {
    return run("clear-log", async () => {
      setLogBatches((await marketBotApi.clearBuybackLog()).batches || []);
      return "Buyback sweep log cleared.";
    });
  }

  async function runSeedNow() {
    const confirmed = await confirmAction(
      "Reseed the NPC sell market now with the saved schedule settings? The console takes a database backup, clears the bot's own listings on that exchange, then seeds fresh from the active seed plan. Player listings are never touched.",
      { title: "Run Market Reseed", confirmLabel: "Run Reseed", danger: true }
    );
    if (!confirmed) return;
    await run("run-seed", async () => {
      const result = await marketBotApi.runSeed();
      return `Reseed finished: ${result.listingCount ?? "0"} listings on exchange ${result.exchangeId ?? "?"}.`;
    });
  }

  async function runUnseedNow() {
    const confirmed = await confirmAction(
      "Remove all of the Market Bot's NPC sell listings from the selected exchange? The console checks read-only first and takes a database backup only when there is something to remove. Player listings and pending seller payments are never touched.",
      {
        title: "Remove NPC Listings",
        confirmLabel: "Remove Listings",
        danger: true,
        warning: seedEnabled ? "The reseed schedule is enabled: the next scheduled run will repopulate this market. Disable the schedule to keep it unseeded." : undefined
      }
    );
    if (!confirmed) return;
    await run("unseed", async () => {
      const result = await marketBotApi.unseed(exchangeId ? { exchangeId } : {});
      if (result.status === "empty") return result.detail || "No NPC listings to remove; no backup was taken.";
      return `Unseed finished: removed ${result.removedListings ?? "0"} NPC listing(s) from exchange ${result.exchangeId ?? "?"}.`;
    });
  }

  function selectPlan(planId: string) {
    setSelectedPlanId(planId);
    const plan = status?.plans?.items?.find((item) => item.id === planId);
    setPlanNameDraft(plan?.source === "custom" ? plan.name : "");
  }

  function setActivePlan() {
    return run("set-active-plan", async () => {
      const plans = await marketBotApi.setActivePlan({ planId: selectedPlanId });
      const active = plans.items.find((item) => item.id === plans.activePlanId);
      return `Active seed plan is now ${active?.name || selectedPlanId}.`;
    });
  }

  function savePlanName() {
    return run("rename-plan", async () => {
      const plans = await marketBotApi.renamePlan({ planId: selectedPlanId, name: planNameDraft });
      const renamed = plans.items.find((item) => item.id === selectedPlanId);
      return `Seed plan renamed to ${renamed?.name || planNameDraft}.`;
    });
  }

  function downloadPlanCsv() {
    return run("download-csv", async () => {
      const response = await marketBotApi.downloadPlanCsv(selectedPlanId);
      const blob = await response.blob();
      const header = response.headers.get("content-disposition") || "";
      const filename = header.match(/filename="([^"]+)"/)?.[1] || "market-seed-plan.csv";
      downloadBlob(filename, blob);
      return `Downloaded ${filename}.`;
    });
  }

  async function uploadPlanCsv(file: File | null) {
    if (!file) return;
    if (selectedIsReadOnly && !planNameDraft.trim()) {
      onError("Enter a friendly name for the imported seed plan.");
      if (csvInputRef.current) csvInputRef.current.value = "";
      return;
    }
    try {
      const text = await file.text();
      const invalid = invalidSeedPlanCsvMessage(file.name || "", text);
      if (invalid) {
        onError(invalid);
        if (csvInputRef.current) csvInputRef.current.value = "";
        return;
      }
    } catch {
      onError("The selected file could not be read as CSV.");
      if (csvInputRef.current) csvInputRef.current.value = "";
      return;
    }
    await run("upload-csv", async () => {
      const form = new FormData();
      form.append("file", file);
      if (planNameDraft.trim()) form.append("name", planNameDraft.trim());
      if (selectedPlanId) form.append("planId", selectedPlanId);
      const result = await marketBotApi.uploadPlanCsv(form);
      setSelectedPlanId(result.id);
      setPlanNameDraft(result.name);
      return `Imported ${result.rows.toLocaleString()} row(s) as "${result.name}" and set it as the active seed plan.`;
    });
    if (csvInputRef.current) csvInputRef.current.value = "";
  }

  const supported = status?.capabilities.exchangeMarket !== false;
  const planCatalog = status?.plans?.items?.length
    ? status.plans.items
    : (status?.plan?.available ? [{
      id: status.plan.id || "bundled",
      name: status.plan.name || "Bundled",
      source: (status.plan.source === "custom" || status.plan.source === "addon" || status.plan.source === "bundled") ? status.plan.source : "bundled",
      readOnly: status.plan.source !== "custom",
      rows: status.plan.rows,
      panelVersion: status.plan.panelVersion,
      generatedAt: status.plan.generatedAt,
      active: true
    } satisfies MarketSeedPlanInfo] : []);
  const selectedPlan = planCatalog.find((plan) => plan.id === selectedPlanId) || planCatalog.find((plan) => plan.active) || planCatalog[0];
  const selectedIsReadOnly = selectedPlan?.readOnly !== false && selectedPlan?.source !== "custom";
  const selectedIsActive = Boolean(selectedPlan?.active || selectedPlan?.id === status?.plans?.activePlanId);
  const planReady = status?.plan.available === true;
  const showBot = Boolean(!loading && supported && (planReady || planCatalog.length));
  const savedBuybackExchange = status?.buyback.exchangeId || "";
  const savedSeedExchange = status?.seed.exchangeId || "";

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Market Bot Settings" onClick={onClose}>
      <div className="confirm-modal exchange-config-modal market-bot-modal" onClick={(event) => event.stopPropagation()}>
        <div className="confirm-modal-title">
          <div className="market-bot-title"><h3>Market Bot</h3><InfoTooltip id="market-bot-overview-help" label="About Market Bot">Market Bot can seed NPC sell listings and buy eligible player listings. Schedules run inside the Console without this window remaining open. Every database write is preceded by a backup.</InfoTooltip></div>
          <button className="exchange-config-close" aria-label="Close" onClick={onClose}><X size={16} /></button>
        </div>
        {loading && <p className="muted">Loading…</p>}
        {!loading && !supported && <p className="muted">{status?.reason || "The Market Bot is unsupported by the detected database schema."}</p>}
        {!loading && supported && !planReady && !planCatalog.length && <p className="muted">The bundled market seed plan is missing. Repair or reinstall the console release.</p>}
        {!loading && supported && !planReady && planCatalog.length > 0 && <p className="muted">The active seed plan could not be read. Choose another plan or upload a CSV.</p>}
        {showBot && status && (
          <div className="market-bot-shell">
            <div className="market-bot-context">
              <div className="market-bot-plan-manager">
                <SectionTitle title="Seed Plans" id="market-bot-plans-help" help="Named seed plans are CSV-backed lists the Market Bot can stock. The bundled catalog stays read-only. Set one plan as active to use it for reseeds and buyback price caps. Download CSV exports the selected plan; Upload CSV imports a UTF-8 CSV of names and numbers only (no extra columns, SQL, JSON, or formulas)." />
                <div className="market-bot-grid market-bot-plan-fields">
                  <label className="compact-select">Seed Plan
                    <select aria-label="Seed Plan" value={selectedPlan?.id || ""} onChange={(event) => selectPlan(event.target.value)}>
                      {!planCatalog.length && <option value="">No Seed Plans</option>}
                      {planCatalog.map((plan) => (
                        <option key={plan.id} value={plan.id}>{planOptionLabel(plan)}</option>
                      ))}
                    </select>
                  </label>
                  <label>Plan Name
                    <input
                      aria-label="Seed Plan Name"
                      value={planNameDraft}
                      onChange={(event) => setPlanNameDraft(event.target.value)}
                      maxLength={80}
                      placeholder={selectedIsReadOnly ? "Name for a new imported plan" : "Friendly name"}
                    />
                  </label>
                </div>
                <p className="muted market-bot-plan-summary">
                  {selectedPlan ? `${selectedPlan.rows.toLocaleString()} rows${selectedPlan.panelVersion ? ` · v${selectedPlan.panelVersion}` : ""}${selectedIsActive ? " · active seeding list" : ""}` : "No seed plan selected."}
                  {status.plan.available === false ? " The bot cannot seed until an available plan is active." : ""}
                </p>
                <div className="confirm-modal-actions market-bot-actions market-bot-plan-actions">
                  <button type="button" onClick={() => void setActivePlan()} disabled={Boolean(busy) || !selectedPlan || selectedIsActive}>{busy === "set-active-plan" ? "Setting…" : "Set as Active Plan"}</button>
                  <button type="button" onClick={() => void savePlanName()} disabled={Boolean(busy) || selectedIsReadOnly || !planNameDraft.trim()}>{busy === "rename-plan" ? "Saving…" : "Save Plan Name"}</button>
                  <button type="button" onClick={() => void downloadPlanCsv()} disabled={Boolean(busy) || !selectedPlan}>{busy === "download-csv" ? "Downloading…" : "Download CSV"}</button>
                  <label className="button-link">
                    {busy === "upload-csv" ? "Uploading…" : "Upload CSV"}
                    <input
                      ref={csvInputRef}
                      className="hidden-file-input"
                      type="file"
                      accept=".csv,text/csv"
                      aria-label="Upload CSV"
                      disabled={Boolean(busy)}
                      onChange={(event) => void uploadPlanCsv(event.target.files?.[0] || null)}
                    />
                  </label>
                </div>
              </div>
              <label className="compact-select market-bot-exchange">
              <span className="market-bot-label-with-info">Exchange<InfoTooltip id="market-bot-exchange-help" label="About Exchange Selection">Exchanges with access points appear first because players can reach them in game. Saving a schedule binds it to the exchange selected here.</InfoTooltip></span>
              <select aria-label="Exchange" value={exchangeId} onChange={(event) => setExchangeId(event.target.value)}>
                {!exchanges.length && <option value="">No Exchanges Found</option>}
                {exchanges.map((exchange) => (
                  <option key={exchange.exchangeId} value={exchange.exchangeId}>{exchangeLabel(exchange)}</option>
                ))}
              </select>
              </label>
            </div>

            <div className="market-bot-tabs" role="tablist" aria-label="Market Bot Sections">
              <button type="button" role="tab" aria-selected={activeTab === "buyback"} className={activeTab === "buyback" ? "active" : ""} onClick={() => setActiveTab("buyback")}>Buyback</button>
              <button type="button" role="tab" aria-selected={activeTab === "reseed"} className={activeTab === "reseed" ? "active" : ""} onClick={() => setActiveTab("reseed")}>Reseed</button>
              <button type="button" role="tab" aria-selected={activeTab === "activity"} className={activeTab === "activity" ? "active" : ""} onClick={() => setActiveTab("activity")}>Activity{logBatches.length ? <span>{logBatches.length}</span> : null}</button>
            </div>

            {notice && <p className="market-bot-notice" role="status">{notice}</p>}

            {activeTab === "buyback" && <div className="market-bot-section" role="tabpanel">
              <SectionTitle title="Buyback Sweeps" id="market-bot-buyback-help" help="Buys complete player-listed stacks when the per-unit ask is within the configured percentage of the selected price basis. A sweep checks eligibility first and creates a backup only when something qualifies. Seeded pricing follows the reseed augment-pricing choice; category multipliers may be tuned independently." />
              <div className="market-bot-settings-block">
                <strong>Schedule</strong>
                <div className="market-bot-grid market-bot-schedule-grid">
                  <label>Interval (Minutes)
                    <input aria-label="Buyback Interval Minutes" type="number" min={10} max={1440} value={buybackInterval} onChange={(event) => setBuybackInterval(Number(event.target.value))} />
                  </label>
                  <label className="market-bot-toggle">
                    <input aria-label="Run Buyback on a Schedule" type="checkbox" checked={buybackEnabled} onChange={(event) => setBuybackEnabled(event.target.checked)} />
                    <span>Run Automatically</span>
                  </label>
                </div>
              </div>
              <div className="market-bot-settings-block">
                <strong>Pricing and Limits</strong>
              <div className="market-bot-grid">
                <label>Price Multiplier
                  <input aria-label="Buyback Price Multiplier" type="number" min={1} max={100} value={buybackMultiplier} onChange={(event) => setBuybackMultiplier(Number(event.target.value))} />
                </label>
                <label>Buyback Percent
                  <input aria-label="Buyback Percent" type="number" min={1} max={500} value={buybackPercent} onChange={(event) => setBuybackPercent(Number(event.target.value))} />
                </label>
                <label>Price Basis
                  <select aria-label="Buyback Price Basis" value={buybackBasis} onChange={(event) => setBuybackBasis(event.target.value as MarketPriceBasis)}>
                    <option value="seeded">Seeded NPC Price</option>
                    <option value="average">Live Market Average</option>
                    <option value="lowest">Live Market Lowest</option>
                  </select>
                </label>
                <label>Max Buys Per Sweep
                  <input aria-label="Max Buys Per Sweep" type="number" min={1} max={5000} value={maxBuys} onChange={(event) => setMaxBuys(Number(event.target.value))} />
                </label>
              </div>
              </div>
              <details className="market-bot-advanced"><summary>Category Price Tuning</summary><div className="market-bot-grid"><CategoryMultiplierInputs section="Buyback" values={buybackCategoryMultipliers} onChange={setBuybackCategoryMultipliers} /></div></details>
              <p className="muted market-bot-run-summary">{runSummary(status.buyback)}{savedBuybackExchange ? ` | Saved exchange ${savedBuybackExchange}` : ""}</p>
              <div className="confirm-modal-actions market-bot-actions">
                <button onClick={() => void saveBuyback()} disabled={Boolean(busy)}>{busy === "save-buyback" ? "Saving…" : "Save Buyback Schedule"}</button>
                <button onClick={() => void probe()} disabled={Boolean(busy)}>{busy === "probe" ? "Probing…" : "Probe Eligibility"}</button>
                <button className="danger" onClick={() => void runBuybackNow()} disabled={Boolean(busy) || !savedBuybackExchange}>{busy === "run-buyback" ? "Running…" : "Run Sweep Now"}</button>
              </div>
              {probeResult && (
                <div className="market-bot-diagnostics" aria-label="Buyback Diagnostics">
                  <strong>Why Listings Were Not Bought</strong>
                  <p className="muted">Read-only probe for exchange {probeResult.exchangeId} at the {probeResult.buybackPercent}% threshold using the {probeResult.buybackPriceBasis} price basis.</p>
                  <dl>
                    <div><dt>Player Listings Checked</dt><dd>{probeResult.playerListings.toLocaleString()}</dd></div>
                    <div><dt>Recognized in Seed Plan</dt><dd>{probeResult.knownListings.toLocaleString()}</dd></div>
                    <div><dt>Eligible to Buy</dt><dd>{probeResult.eligible.toLocaleString()}</dd></div>
                    <div><dt>Waiting Beyond Sweep Limit</dt><dd>{Math.max(0, probeResult.eligible - probeResult.maxBuys).toLocaleString()}</dd></div>
                    <div><dt>Above Price Threshold</dt><dd>{probeResult.aboveThreshold.toLocaleString()}</dd></div>
                    <div><dt>Unknown Template</dt><dd>{probeResult.unknownTemplate.toLocaleString()}</dd></div>
                    <div><dt>Invalid Price or Empty Stack</dt><dd>{probeResult.invalidPriceOrStack.toLocaleString()}</dd></div>
                  </dl>
                </div>
              )}
            </div>}

            {activeTab === "reseed" && <div className="market-bot-section" role="tabpanel">
              <SectionTitle title="Market Reseed" id="market-bot-reseed-help" help="Replaces only the bot's NPC sell listings from the active seed plan. Each write run creates a backup, clears the bot listings on the selected exchange, and seeds fresh stock; player listings are never touched. Augments use bottom-of-range rolls, with either discounted or original plan pricing." />
              <div className="market-bot-settings-block">
                <strong>Schedule</strong>
                <div className="market-bot-grid market-bot-schedule-grid">
                  <label>Interval (Minutes)
                    <input aria-label="Seed Interval Minutes" type="number" min={10} max={1440} value={seedInterval} onChange={(event) => setSeedInterval(Number(event.target.value))} />
                  </label>
                  <label className="market-bot-toggle">
                    <input aria-label="Run Reseed on a Schedule" type="checkbox" checked={seedEnabled} onChange={(event) => setSeedEnabled(event.target.checked)} />
                    <span>Run Automatically</span>
                  </label>
                </div>
              </div>
              <div className="market-bot-settings-block">
                <strong>Pricing</strong>
              <div className="market-bot-grid">
                <label>Price Multiplier
                  <input aria-label="Seed Price Multiplier" type="number" min={1} max={100} value={seedMultiplier} onChange={(event) => setSeedMultiplier(Number(event.target.value))} />
                </label>
                <label>Augment Pricing
                  <select aria-label="Augment Pricing" value={augmentPricing} onChange={(event) => setAugmentPricing(event.target.value as MarketAugmentPricing)}>
                    <option value="discounted">Cheaper Than Patterns</option>
                    <option value="original">Original Plan Prices</option>
                  </select>
                </label>
              </div>
              </div>
              <details className="market-bot-advanced"><summary>Category Price Tuning</summary><div className="market-bot-grid"><CategoryMultiplierInputs section="Seed" values={seedCategoryMultipliers} onChange={setSeedCategoryMultipliers} /></div></details>
              {commodityCatalog.length > 0 && <details className="market-bot-advanced market-bot-commodity-panel"><summary>Commodity Stack Quantities</summary><CommodityStackInputs catalog={commodityCatalog} groups={commodityGroups} values={commodityStacks} onChange={setCommodityStacks} /></details>}
              <p className="muted market-bot-run-summary">{runSummary(status.seed)}{savedSeedExchange ? ` | Saved exchange ${savedSeedExchange}` : ""}</p>
              <div className="confirm-modal-actions market-bot-actions">
                <button onClick={() => void saveSeed()} disabled={Boolean(busy)}>{busy === "save-seed" ? "Saving…" : "Save Reseed Schedule"}</button>
                <button className="danger" onClick={() => void runSeedNow()} disabled={Boolean(busy) || !savedSeedExchange}>{busy === "run-seed" ? "Running…" : "Run Reseed Now"}</button>
                <button className="danger" onClick={() => void runUnseedNow()} disabled={Boolean(busy) || !exchangeId}>{busy === "unseed" ? "Removing…" : "Remove NPC Listings"}</button>
              </div>
            </div>}

            {activeTab === "activity" && <BuybackSweepLog
              batches={logBatches}
              busy={busy}
              onRefresh={() => void refreshLogDryRun()}
              onClear={() => void clearLog()}
            />}
          </div>
        )}
        <div className="confirm-modal-actions">
          <button onClick={onClose} disabled={Boolean(busy)}>Close</button>
        </div>
      </div>
    </div>
  );
}
