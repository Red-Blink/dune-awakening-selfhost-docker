import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { exchangeApi, type ExchangeItemsResponse } from "../../api/exchange";
import { marketBotApi } from "../../api/marketBot";
import { ExchangePanel, _resetExchangeCacheForTests } from "./ExchangePanel";

vi.mock("../../api/exchange", () => ({
  exchangeApi: {
    items: vi.fn(),
    listings: vi.fn(),
    stats: vi.fn(),
    getConfig: vi.fn(),
    saveConfig: vi.fn()
  }
}));

vi.mock("../../api/marketBot", () => ({
  marketBotApi: {
    status: vi.fn(),
    exchanges: vi.fn(),
    probeBuyback: vi.fn(),
    saveBuybackSchedule: vi.fn(),
    saveSeedSchedule: vi.fn(),
    runBuyback: vi.fn(),
    runSeed: vi.fn()
  }
}));

function renderPanel(overrides: Partial<Parameters<typeof ExchangePanel>[0]> = {}) {
  const props = {
    onError: vi.fn(),
    confirmAction: vi.fn().mockResolvedValue(true),
    formatMutationResult: vi.fn().mockReturnValue("Action completed."),
    ...overrides
  };
  render(<ExchangePanel {...props} />);
  return props;
}

function itemsResponse(overrides: Partial<ExchangeItemsResponse> = {}): ExchangeItemsResponse {
  return {
    capabilities: { exchange: true },
    totalCount: 1,
    totalItems: 1,
    categories: ["utility", "weapons"],
    rows: [
      {
        template_id: "PartialStabilizationBelt",
        quality_level: 0,
        display_name: "Partial Stabilization Belt",
        category: "utility",
        tier: null,
        lowest_price: 45084,
        total_stock: 4,
        npc_stock: 0,
        listing_count: 4,
        icon: null
      }
    ],
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetExchangeCacheForTests();
  vi.mocked(exchangeApi.getConfig).mockResolvedValue({ includeNpcBroker: true, botOwnerIds: [], blacklistedOwnerIds: [] });
  vi.mocked(exchangeApi.listings).mockResolvedValue({ capabilities: { exchange: true }, rows: [] });
  // Default: no exchange:market permission — the Market Bot button stays hidden.
  vi.mocked(marketBotApi.status).mockRejectedValue(new Error("Forbidden"));
});

describe("ExchangePanel", () => {
  it("renders an aggregated item row with name and lowest price", async () => {
    vi.mocked(exchangeApi.items).mockResolvedValue(itemsResponse());
    renderPanel();

    expect(await screen.findByText("Partial Stabilization Belt")).toBeInTheDocument();
    expect(screen.getByText("45,084")).toBeInTheDocument();
  });

  it("defaults the owner filter to all listings", async () => {
    vi.mocked(exchangeApi.items).mockResolvedValue(itemsResponse());
    renderPanel();

    await screen.findByText("Partial Stabilization Belt");
    expect(vi.mocked(exchangeApi.items)).toHaveBeenCalledWith(expect.objectContaining({ owner: "all" }));
  });

  it("refetches when the owner filter changes", async () => {
    vi.mocked(exchangeApi.items).mockResolvedValue(itemsResponse());
    renderPanel();

    await screen.findByText("Partial Stabilization Belt");
    fireEvent.change(screen.getByRole("combobox", { name: /Show/ }), { target: { value: "bot" } });

    await waitFor(() => expect(vi.mocked(exchangeApi.items)).toHaveBeenCalledWith(expect.objectContaining({ owner: "bot" })));
  });

  it("populates the category options and refetches on category change", async () => {
    vi.mocked(exchangeApi.items).mockResolvedValue(itemsResponse());
    renderPanel();

    await screen.findByText("Partial Stabilization Belt");
    const categorySelect = screen.getByRole("combobox", { name: /Category/ });
    expect(within(categorySelect).getByRole("option", { name: "weapons" })).toBeInTheDocument();
    fireEvent.change(categorySelect, { target: { value: "utility" } });

    await waitFor(() => expect(vi.mocked(exchangeApi.items)).toHaveBeenCalledWith(expect.objectContaining({ category: "utility" })));
  });

  it("clears the category when the owner filter changes", async () => {
    vi.mocked(exchangeApi.items).mockResolvedValue(itemsResponse());
    renderPanel();

    await screen.findByText("Partial Stabilization Belt");
    fireEvent.change(screen.getByRole("combobox", { name: /Category/ }), { target: { value: "utility" } });
    await waitFor(() => expect(vi.mocked(exchangeApi.items)).toHaveBeenCalledWith(expect.objectContaining({ category: "utility" })));

    fireEvent.change(screen.getByRole("combobox", { name: /Show/ }), { target: { value: "bot" } });
    await waitFor(() => expect(vi.mocked(exchangeApi.items)).toHaveBeenCalledWith(expect.objectContaining({ owner: "bot", category: "" })));
  });

  it("submits the search term", async () => {
    vi.mocked(exchangeApi.items).mockResolvedValue(itemsResponse());
    renderPanel();

    await screen.findByText("Partial Stabilization Belt");
    fireEvent.change(screen.getByPlaceholderText("Search item name, category, or template"), { target: { value: "belt" } });
    fireEvent.click(screen.getByText("Search"));

    await waitFor(() => expect(vi.mocked(exchangeApi.items)).toHaveBeenCalledWith(expect.objectContaining({ q: "belt" })));
  });

  it("advances to the next page", async () => {
    vi.mocked(exchangeApi.items).mockResolvedValue(itemsResponse({ totalCount: 120, totalItems: 120 }));
    renderPanel();

    await screen.findByText("Partial Stabilization Belt");
    await waitFor(() => expect(screen.getByText("Next")).not.toBeDisabled());
    fireEvent.click(screen.getByText("Next"));

    await waitFor(() => expect(vi.mocked(exchangeApi.items)).toHaveBeenCalledWith(expect.objectContaining({ page: 1 })));
  });

  it("sorts by a column when its header is clicked", async () => {
    vi.mocked(exchangeApi.items).mockResolvedValue(itemsResponse());
    renderPanel();

    await screen.findByText("Partial Stabilization Belt");
    fireEvent.click(screen.getByRole("columnheader", { name: /Lowest Price/ }));

    await waitFor(() => expect(vi.mocked(exchangeApi.items)).toHaveBeenCalledWith(expect.objectContaining({ sortColumn: "lowest_price", sortDirection: "asc" })));
  });

  it("opens the config overlay from the gear button", async () => {
    vi.mocked(exchangeApi.items).mockResolvedValue(itemsResponse());
    renderPanel();

    await screen.findByText("Partial Stabilization Belt");
    fireEvent.click(screen.getByLabelText("Configure bots and blacklist"));

    expect(await screen.findByText("Exchange Filter Settings")).toBeInTheDocument();
    expect(vi.mocked(exchangeApi.getConfig)).toHaveBeenCalled();
  });

  it("loads listings on demand when a row is expanded", async () => {
    vi.mocked(exchangeApi.items).mockResolvedValue(itemsResponse());
    vi.mocked(exchangeApi.listings).mockResolvedValue({
      capabilities: { exchange: true },
      rows: [{ order_id: "1", template_id: "PartialStabilizationBelt", owner_type: "player", owner_name: "Halfmoondee", price: 45084, stock: 1, quality: 0 }]
    });
    renderPanel();

    fireEvent.click(await screen.findByLabelText("Show listings for Partial Stabilization Belt"));

    expect(await screen.findByText("Halfmoondee")).toBeInTheDocument();
    // Drill-down respects the current owner filter (default: all).
    expect(vi.mocked(exchangeApi.listings)).toHaveBeenCalledWith("PartialStabilizationBelt", 0, "all");
  });

  it("shows the unsupported reason when the schema lacks exchange tables", async () => {
    vi.mocked(exchangeApi.items).mockResolvedValue({
      capabilities: { exchange: false },
      totalCount: 0,
      totalItems: 0,
      categories: [],
      rows: [],
      reason: "Unsupported by detected schema. Missing required table(s): dune.dune_exchange_orders"
    });
    renderPanel();

    expect(await screen.findByText(/Missing required table/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Search item name, category, or template")).not.toBeInTheDocument();
  });

  it("shows the Market Bot button only when the market status endpoint is reachable", async () => {
    vi.mocked(exchangeApi.items).mockResolvedValue(itemsResponse());
    vi.mocked(marketBotApi.status).mockResolvedValue({
      capabilities: { exchangeMarket: true },
      plan: { available: true, source: "bundled", rows: 10, panelVersion: "0.14.0", generatedAt: "" },
      buyback: { enabled: false, intervalMinutes: 30, exchangeId: "", priceMultiplier: 5, augmentMultiplier: 1, rankedArmorMultiplier: 1, rankedWeaponMultiplier: 1, buybackPercent: 60, buybackPriceBasis: "seeded", maxBuys: 500, source: "console", lastRunAt: "", lastRunStatus: "", lastRunDetail: "", nextRunAt: "" },
      seed: { enabled: false, intervalMinutes: 15, exchangeId: "", priceMultiplier: 5, augmentMultiplier: 1, rankedArmorMultiplier: 1, rankedWeaponMultiplier: 1, augmentPricing: "discounted", source: "console", lastRunAt: "", lastRunStatus: "", lastRunDetail: "", nextRunAt: "", commodityStacks: {} }
    });
    renderPanel();

    expect(await screen.findByLabelText("Market Bot settings")).toBeInTheDocument();
  });

  it("hides the Market Bot button when the status endpoint rejects (no exchange:market permission)", async () => {
    vi.mocked(exchangeApi.items).mockResolvedValue(itemsResponse());
    renderPanel();

    await screen.findByText("Partial Stabilization Belt");
    expect(screen.queryByLabelText("Market Bot settings")).not.toBeInTheDocument();
  });
});
