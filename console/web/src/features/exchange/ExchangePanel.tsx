import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Settings } from "lucide-react";
import { exchangeApi, type ExchangeItem, type ExchangeOwner } from "../../api/exchange";
import { marketBotApi } from "../../api/marketBot";
import type { SortDirection } from "../../components/common/DataTable";
import { ExchangeTable } from "./ExchangeTable";
import { ExchangeConfigOverlay } from "./ExchangeConfigOverlay";
import { MarketBotOverlay } from "./MarketBotOverlay";
import { BotItemsTab } from "./BotItemsTab";

type ExchangePanelProps = {
  onError: (text: string) => void;
  // The board itself is read-only; confirmAction guards the Market Bot's
  // game-DB writes (seed/buyback runs) inside MarketBotOverlay.
  confirmAction: (message: string, options?: { title?: string; confirmLabel?: string; warning?: string; danger?: boolean; details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[] }) => Promise<boolean>;
  formatMutationResult: (result: unknown) => string;
};

const EXCHANGE_AUTO_REFRESH_MS = 5 * 60_000; // 5 minutes — the market changes slowly
const EXCHANGE_PAGE_SIZES = [25, 50, 100, 200] as const;
const EXCHANGE_DEFAULT_PAGE_SIZE = 50;
const OWNER_OPTIONS: { value: ExchangeOwner; label: string }[] = [
  { value: "all", label: "All listings" },
  { value: "player", label: "Player listings" },
  { value: "bot", label: "Bot listings" }
];

type ExchangeView = { q: string; page: number; pageSize: number; sortColumn: string; sortDirection: SortDirection; owner: ExchangeOwner; category: string };

type ExchangeCache = ExchangeView & {
  rows: ExchangeItem[];
  totalCount: number;
  totalItems: number;
  categories: string[];
  supported: boolean;
  reason: string;
  lastFetchedAt: number;
};

let exchangeCache: ExchangeCache | null = null;

// Test-only: the module-level cache persists across renders (for instant
// back-navigation), which leaks view state between test cases. Reset it in test
// setup so each case starts from the default view.
export function _resetExchangeCacheForTests() {
  exchangeCache = null;
}

function sameView(cache: ExchangeCache | null, view: ExchangeView) {
  return !!cache && cache.q === view.q && cache.page === view.page && cache.pageSize === view.pageSize
    && cache.sortColumn === view.sortColumn && cache.sortDirection === view.sortDirection && cache.owner === view.owner
    && cache.category === view.category;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function ExchangePanel({ onError, confirmAction }: ExchangePanelProps) {
  const [q, setQ] = useState(() => exchangeCache?.q ?? "");
  const [submittedQ, setSubmittedQ] = useState(() => exchangeCache?.q ?? "");
  const [page, setPage] = useState(() => exchangeCache?.page ?? 0);
  const [pageSize, setPageSize] = useState<number>(() => exchangeCache?.pageSize ?? EXCHANGE_DEFAULT_PAGE_SIZE);
  const [sortColumn, setSortColumn] = useState(() => exchangeCache?.sortColumn ?? "display_name");
  const [sortDirection, setSortDirection] = useState<SortDirection>(() => exchangeCache?.sortDirection ?? "asc");
  const [owner, setOwner] = useState<ExchangeOwner>(() => exchangeCache?.owner ?? "all");
  const [category, setCategory] = useState(() => exchangeCache?.category ?? "");
  const [categories, setCategories] = useState<string[]>(() => exchangeCache?.categories ?? []);
  const [rows, setRows] = useState<ExchangeItem[]>(() => exchangeCache?.rows ?? []);
  const [totalCount, setTotalCount] = useState(() => exchangeCache?.totalCount ?? 0);
  const [totalItems, setTotalItems] = useState(() => exchangeCache?.totalItems ?? 0);
  const [supported, setSupported] = useState(() => exchangeCache?.supported ?? true);
  const [reason, setReason] = useState(() => exchangeCache?.reason ?? "");
  const [loading, setLoading] = useState(() => exchangeCache === null);
  const [configOpen, setConfigOpen] = useState(false);
  const [marketBotOpen, setMarketBotOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"exchange" | "bot-items">("exchange");
  // The Market Bot button only appears when the status endpoint answers, so
  // viewers without the exchange:market action never see a control they
  // cannot use. Checked silently once per mount.
  const [marketBotAvailable, setMarketBotAvailable] = useState(false);
  const requestIdRef = useRef(0);
  const skipNextSearchReset = useRef(true);

  useEffect(() => {
    let cancelled = false;
    marketBotApi.status()
      .then(() => { if (!cancelled) setMarketBotAvailable(true); })
      .catch(() => { if (!cancelled) setMarketBotAvailable(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (skipNextSearchReset.current) {
      skipNextSearchReset.current = false;
      return;
    }
    setPage(0);
  }, [submittedQ, owner, category]);

  function submitSearch() {
    setSubmittedQ(q);
  }

  function handleClearSearch() {
    setQ("");
    setSubmittedQ("");
  }

  function handleSort(column: string) {
    setPage(0);
    if (column === sortColumn) {
      setSortDirection((current) => current === "asc" ? "desc" : "asc");
      return;
    }
    setSortColumn(column);
    setSortDirection("asc");
  }

  function changePageSize(nextSize: number) {
    setPageSize(nextSize);
    setPage(0);
  }

  const load = useCallback(async (view: ExchangeView, options: { silent?: boolean } = {}) => {
    const requestId = ++requestIdRef.current;
    if (!options.silent) onError("");
    try {
      const result = await exchangeApi.items(view);
      if (requestIdRef.current !== requestId) return;
      const nextRows = result.rows || [];
      const nextCategories = result.categories || [];
      const nextSupported = result.capabilities?.exchange !== false;
      setRows(nextRows);
      setTotalCount(result.totalCount || 0);
      setTotalItems(result.totalItems || 0);
      setCategories(nextCategories);
      setSupported(nextSupported);
      setReason(result.reason || "");
      exchangeCache = {
        ...view,
        rows: nextRows,
        totalCount: result.totalCount || 0,
        totalItems: result.totalItems || 0,
        categories: nextCategories,
        supported: nextSupported,
        reason: result.reason || "",
        lastFetchedAt: Date.now()
      };
    } catch (error) {
      if (requestIdRef.current === requestId && !options.silent) onError(errorText(error));
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | undefined;
    const view: ExchangeView = { q: submittedQ, page, pageSize, sortColumn, sortDirection, owner, category };
    const cacheHit = sameView(exchangeCache, view) ? exchangeCache : null;

    if (cacheHit) {
      setRows(cacheHit.rows);
      setTotalCount(cacheHit.totalCount);
      setTotalItems(cacheHit.totalItems);
      setCategories(cacheHit.categories);
      setSupported(cacheHit.supported);
      setReason(cacheHit.reason);
      setLoading(false);
    }

    const scheduleNext = () => {
      if (cancelled) return;
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => { void tick(); }, EXCHANGE_AUTO_REFRESH_MS);
    };

    const tick = async () => {
      if (document.visibilityState !== "hidden") await load(view, { silent: true });
      scheduleNext();
    };

    void load(view, { silent: Boolean(cacheHit) }).then(scheduleNext);

    const onVisibilityChange = () => {
      const currentCache = sameView(exchangeCache, view) ? exchangeCache : null;
      if (document.visibilityState === "visible" && (!currentCache || Date.now() - currentCache.lastFetchedAt >= EXCHANGE_AUTO_REFRESH_MS)) {
        void load(view, { silent: true }).then(scheduleNext);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [submittedQ, page, pageSize, sortColumn, sortDirection, owner, category, load]);

  function currentView(): ExchangeView {
    return { q: submittedQ, page, pageSize, sortColumn, sortDirection, owner, category };
  }

  function changeOwner(nextOwner: ExchangeOwner) {
    setOwner(nextOwner);
    // Categories differ per owner scope; clear the selection so a category that
    // isn't in the new scope can't linger as a filter that hides everything.
    setCategory("");
  }

  if (activeTab === "exchange" && loading && !rows.length) {
    return (
      <section className="panel">
        <div className="loading-panel">
          <span className="spinner" aria-hidden="true" />
          <strong className="loading-dots">Loading Market Board</strong>
        </div>
      </section>
    );
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const rangeStart = totalCount === 0 ? 0 : page * pageSize + 1;
  const rangeEnd = totalCount === 0 ? 0 : rangeStart + rows.length - 1;
  const hasPreviousPage = page > 0;
  const hasNextPage = page + 1 < totalPages;

  return (
    <section className="panel">
      <div className="panel-title">
        <h2>Market Board</h2>
        <div className="action-row">
          <button className="exchange-config-button" title="Configure bots and blacklist" aria-label="Configure bots and blacklist" onClick={() => setConfigOpen(true)}>
            <Settings size={16} />
          </button>
          {marketBotAvailable && (
            <button className="exchange-config-button" title="Market Bot: NPC market seeding and buyback" aria-label="Market Bot settings" onClick={() => setMarketBotOpen(true)}>
              <Bot size={16} />
            </button>
          )}
        </div>
      </div>
      <div className="bases-expanded-tablist" role="tablist">
        <button type="button" role="tab" aria-selected={activeTab === "exchange"} className={`bases-expanded-tab${activeTab === "exchange" ? " active" : ""}`} onClick={() => setActiveTab("exchange")}>Exchange</button>
        <button type="button" role="tab" aria-selected={activeTab === "bot-items"} className={`bases-expanded-tab${activeTab === "bot-items" ? " active" : ""}`} onClick={() => setActiveTab("bot-items")}>Bot items</button>
      </div>
      {activeTab === "exchange" && <>
        {supported
          ? <p className="action-help-note">Read-only view of the CHOAM exchange. {totalCount.toLocaleString()}{totalCount !== totalItems ? ` of ${totalItems.toLocaleString()}` : ""} item{totalItems === 1 ? "" : "s"} listed for the current filter.</p>
          : <p className="action-help-note">{reason || "The Market Board is unsupported by the detected database schema."}</p>}
        {supported && <>
          <div className="action-row exchange-search-row">
            <input
              value={q}
              onChange={(event) => setQ(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") submitSearch(); }}
              placeholder="Search item name, category, or template"
            />
            <button onClick={submitSearch}>Search</button>
            <button onClick={handleClearSearch} disabled={!q && !submittedQ}>Clear</button>
            <label className="compact-select exchange-category-select">
              Category
              <select value={categories.includes(category) ? category : ""} onChange={(event) => setCategory(event.target.value)}>
                <option value="">All categories</option>
                {categories.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <label className="compact-select exchange-owner-select">
              Show
              <select value={owner} onChange={(event) => changeOwner(event.target.value as ExchangeOwner)}>
                {OWNER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <button onClick={() => void load(currentView())}>Refresh</button>
          </div>
          <ExchangeTable
            rows={rows}
            owner={owner}
            sortColumn={sortColumn}
            sortDirection={sortDirection}
            onSort={handleSort}
            emptyMessage="No market listings match this filter."
          />
          <div className="panel-title exchange-pagination-footer">
            <p className="action-help-note">Showing {rangeStart}-{rangeEnd} of {totalCount} items.</p>
            <div className="database-pagination-controls">
              <label className="compact-select">
                Rows
                <select value={String(pageSize)} onChange={(event) => changePageSize(Number(event.target.value))}>
                  {EXCHANGE_PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
                </select>
              </label>
              <button disabled={!hasPreviousPage} onClick={() => setPage(0)}>First</button>
              <button disabled={!hasPreviousPage} onClick={() => setPage(page - 1)}>Previous</button>
              <span className="muted database-page-indicator">Page {page + 1} of {totalPages}</span>
              <button disabled={!hasNextPage} onClick={() => setPage(page + 1)}>Next</button>
              <button disabled={!hasNextPage} onClick={() => setPage(totalPages - 1)}>Last</button>
            </div>
          </div>
        </>}
      </>}
      {activeTab === "bot-items" && <BotItemsTab onError={onError} />}
      {configOpen && (
        <ExchangeConfigOverlay
          onClose={() => setConfigOpen(false)}
          onError={onError}
          onSaved={() => { exchangeCache = null; void load(currentView()); }}
        />
      )}
      {marketBotOpen && (
        <MarketBotOverlay
          onClose={() => { setMarketBotOpen(false); exchangeCache = null; void load(currentView(), { silent: true }); }}
          onError={onError}
          confirmAction={confirmAction}
        />
      )}
    </section>
  );
}
