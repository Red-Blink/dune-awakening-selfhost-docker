import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { marketBotApi, type MarketBotStatus } from "../../api/marketBot";
import { MarketBotOverlay } from "./MarketBotOverlay";

vi.mock("../../api/marketBot", () => ({
  marketBotApi: {
    status: vi.fn(),
    exchanges: vi.fn(),
    probeBuyback: vi.fn(),
    buybackLog: vi.fn(),
    refreshBuybackLog: vi.fn(),
    clearBuybackLog: vi.fn(),
    saveBuybackSchedule: vi.fn(),
    saveSeedSchedule: vi.fn(),
    runBuyback: vi.fn(),
    runSeed: vi.fn(),
    unseed: vi.fn(),
    setActivePlan: vi.fn(),
    renamePlan: vi.fn(),
    downloadPlanCsv: vi.fn(),
    uploadPlanCsv: vi.fn()
  }
}));

function statusFixture(overrides: Partial<MarketBotStatus> = {}): MarketBotStatus {
  const bundled = {
    id: "bundled",
    name: "Bundled",
    source: "bundled" as const,
    readOnly: true,
    rows: 2910,
    panelVersion: "0.14.0",
    generatedAt: "2026-08-01T00:00:00+00:00",
    active: true
  };
  return {
    capabilities: { exchangeMarket: true },
    plan: { available: true, source: "bundled", rows: 2910, panelVersion: "0.14.0", generatedAt: "2026-08-01T00:00:00+00:00", id: "bundled", name: "Bundled" },
    plans: { activePlanId: "bundled", items: [bundled] },
    buyback: {
      enabled: false, intervalMinutes: 30, exchangeId: "42", priceMultiplier: 5,
      augmentMultiplier: 1, rankedArmorMultiplier: 1, rankedWeaponMultiplier: 1,
      buybackPercent: 60, buybackPriceBasis: "seeded", maxBuys: 500, source: "console",
      lastRunAt: "", lastRunStatus: "", lastRunDetail: "", nextRunAt: ""
    },
    seed: {
      enabled: false, intervalMinutes: 15, exchangeId: "", priceMultiplier: 5,
      augmentMultiplier: 1, rankedArmorMultiplier: 1, rankedWeaponMultiplier: 1,
      augmentPricing: "discounted", source: "console",
      commodityStacks: {},
      lastRunAt: "", lastRunStatus: "", lastRunDetail: "", nextRunAt: ""
    },
    ...overrides
  };
}

const EXCHANGES = {
  capabilities: { exchangeMarket: true },
  rows: [
    { exchangeId: "42", isGlobal: false, accessPoints: 2, orderCount: 40, botOrders: 30, playerOrders: 10 },
    { exchangeId: "9007199254740993", isGlobal: true, accessPoints: 1, orderCount: 5, botOrders: 0, playerOrders: 5 }
  ]
};

function renderOverlay() {
  const props = { onClose: vi.fn(), onError: vi.fn(), confirmAction: vi.fn().mockResolvedValue(true) };
  render(<MarketBotOverlay {...props} />);
  return props;
}

async function selectTab(name: "Buyback" | "Reseed" | "Activity") {
  fireEvent.click(await screen.findByRole("tab", { name: new RegExp(`^${name}`) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(marketBotApi.status).mockResolvedValue(statusFixture());
  vi.mocked(marketBotApi.exchanges).mockResolvedValue(EXCHANGES);
  vi.mocked(marketBotApi.buybackLog).mockResolvedValue({ batches: [] });
  vi.mocked(marketBotApi.refreshBuybackLog).mockResolvedValue({ batches: [] });
  vi.mocked(marketBotApi.clearBuybackLog).mockResolvedValue({ batches: [] });
  vi.mocked(marketBotApi.setActivePlan).mockResolvedValue({ activePlanId: "bundled", items: [] });
  vi.mocked(marketBotApi.renamePlan).mockResolvedValue({ activePlanId: "bundled", items: [] });
  vi.mocked(marketBotApi.downloadPlanCsv).mockResolvedValue(new Response("template_id\nWaterBottle\n", { headers: { "content-disposition": 'attachment; filename="market-seed-bundled.csv"' } }));
  vi.mocked(marketBotApi.uploadPlanCsv).mockResolvedValue({ id: "cheap-water", name: "Cheap Water", rows: 1, active: true });
});

describe("MarketBotOverlay", () => {
  it("loads status and exchanges with organized settings tabs", async () => {
    renderOverlay();

    expect(await screen.findByText(/2,910 rows · v0\.14\.0/)).toBeInTheDocument();
    expect(screen.getByLabelText("Seed Plan")).toBeInTheDocument();
    expect(screen.getByLabelText("Seed Plan Name")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set as Active Plan" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Download CSV" })).toBeInTheDocument();
    expect(screen.getByLabelText("Upload CSV")).toBeInTheDocument();
    expect(screen.getByText("Buyback Sweeps")).toBeInTheDocument();
    expect(screen.queryByText("Market Reseed")).not.toBeInTheDocument();
    await selectTab("Reseed");
    expect(screen.getByText("Market Reseed")).toBeInTheDocument();
    // BIGINT-sized ids stay intact as strings in the selector.
    expect(screen.getByRole("option", { name: "Exchange 42 — 2 Access Points — 30 Bot / 10 Player Orders" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Global (ID 9007199254740993) — 1 Access Point — 0 Bot / 5 Player Orders" })).toBeInTheDocument();
  });

  it("populates the form from the saved buyback schedule and saves edits with the selected exchange", async () => {
    vi.mocked(marketBotApi.status).mockResolvedValue(statusFixture({
      buyback: { ...statusFixture().buyback, buybackPercent: 65, maxBuys: 250 }
    }));
    vi.mocked(marketBotApi.saveBuybackSchedule).mockImplementation(async (schedule) => ({
      ...statusFixture().buyback, ...schedule, exchangeId: String(schedule.exchangeId || "42"), enabled: Boolean(schedule.enabled)
    }));
    renderOverlay();

    const percent = await screen.findByLabelText("Buyback Percent");
    expect(percent).toHaveValue(65);
    expect(percent).toHaveAttribute("max", "500");
    fireEvent.change(percent, { target: { value: "250" } });
    fireEvent.change(screen.getByLabelText("Buyback Price Basis"), { target: { value: "lowest" } });
    fireEvent.click(screen.getByLabelText("Run Buyback on a Schedule"));
    fireEvent.click(screen.getByRole("button", { name: "Save Buyback Schedule" }));

    await waitFor(() => expect(marketBotApi.saveBuybackSchedule).toHaveBeenCalledWith({
      enabled: true,
      intervalMinutes: 30,
      priceMultiplier: 5,
      augmentMultiplier: 1,
      rankedArmorMultiplier: 1,
      rankedWeaponMultiplier: 1,
      buybackPercent: 250,
      buybackPriceBasis: "lowest",
      maxBuys: 250,
      exchangeId: "42"
    }));
    expect(await screen.findByText(/Buyback schedule saved: every 30 min on exchange 42/)).toBeInTheDocument();
  });

  it("probes eligibility read-only and reports the count", async () => {
    vi.mocked(marketBotApi.probeBuyback).mockResolvedValue({
      eligible: 7, exchangeId: "42", priceMultiplier: 5,
      playerListings: 20, knownListings: 17, aboveThreshold: 8,
      unknownTemplate: 3, invalidPriceOrStack: 2,
      augmentMultiplier: 1, rankedArmorMultiplier: 2, rankedWeaponMultiplier: 1,
      buybackPercent: 60, buybackPriceBasis: "seeded", maxBuys: 500
    });
    renderOverlay();

    const armorMultiplier = await screen.findByLabelText("Buyback Ranked Armor Multiplier");
    expect(armorMultiplier).toHaveValue(1);
    fireEvent.change(armorMultiplier, { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Probe Eligibility" }));

    await waitFor(() => expect(marketBotApi.probeBuyback).toHaveBeenCalledWith({
      exchangeId: "42", priceMultiplier: 5,
      augmentMultiplier: 1, rankedArmorMultiplier: 2, rankedWeaponMultiplier: 1,
      buybackPercent: 60, buybackPriceBasis: "seeded", maxBuys: 500
    }));
    expect(await screen.findByText(/7 eligible player listing\(s\) on exchange 42 at 60%/)).toBeInTheDocument();
    const diagnostics = screen.getByLabelText("Buyback Diagnostics");
    expect(diagnostics).toHaveTextContent("Why Listings Were Not Bought");
    expect(diagnostics).toHaveTextContent("Player Listings Checked20");
    expect(diagnostics).toHaveTextContent("Recognized in Seed Plan17");
    expect(diagnostics).toHaveTextContent("Above Price Threshold8");
    expect(diagnostics).toHaveTextContent("Waiting Beyond Sweep Limit0");
    expect(diagnostics).toHaveTextContent("Unknown Template3");
    expect(diagnostics).toHaveTextContent("Invalid Price or Empty Stack2");
  });

  it("confirms before running a sweep and reports the result", async () => {
    vi.mocked(marketBotApi.runBuyback).mockResolvedValue({ status: "swept", purchased: 3, totalUnits: "120", totalSolari: "9000" });
    const props = renderOverlay();

    fireEvent.click(await screen.findByRole("button", { name: "Run Sweep Now" }));

    await waitFor(() => expect(props.confirmAction).toHaveBeenCalled());
    await waitFor(() => expect(marketBotApi.runBuyback).toHaveBeenCalled());
    expect(await screen.findByText(/bought 3 listing\(s\), 120 units for 9000 Solari/)).toBeInTheDocument();
  });

  it("does not run a sweep when the confirmation is declined", async () => {
    const props = renderOverlay();
    props.confirmAction.mockResolvedValue(false);

    fireEvent.click(await screen.findByRole("button", { name: "Run Sweep Now" }));

    await waitFor(() => expect(props.confirmAction).toHaveBeenCalled());
    expect(marketBotApi.runBuyback).not.toHaveBeenCalled();
  });

  it("saves the seed schedule with the chosen augment pricing", async () => {
    vi.mocked(marketBotApi.saveSeedSchedule).mockImplementation(async (schedule) => ({
      ...statusFixture().seed, ...schedule, exchangeId: String(schedule.exchangeId || "42"), enabled: Boolean(schedule.enabled)
    }));
    renderOverlay();
    await selectTab("Reseed");

    const pricing = await screen.findByLabelText("Augment Pricing");
    expect(pricing).toHaveValue("discounted");
    fireEvent.change(pricing, { target: { value: "original" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Reseed Schedule" }));

    await waitFor(() => expect(marketBotApi.saveSeedSchedule).toHaveBeenCalledWith({
      enabled: false,
      intervalMinutes: 15,
      priceMultiplier: 5,
      augmentMultiplier: 1,
      rankedArmorMultiplier: 1,
      rankedWeaponMultiplier: 1,
      augmentPricing: "original",
      commodityStacks: {},
      exchangeId: "42"
    }));
    expect(await screen.findByText(/Reseed schedule saved \(disabled\)\./)).toBeInTheDocument();
  });

  it("populates saved category multipliers and saves edited ones with the reseed schedule", async () => {
    vi.mocked(marketBotApi.status).mockResolvedValue(statusFixture({
      seed: { ...statusFixture().seed, augmentMultiplier: 2 }
    }));
    vi.mocked(marketBotApi.saveSeedSchedule).mockImplementation(async (schedule) => ({
      ...statusFixture().seed, ...schedule, exchangeId: String(schedule.exchangeId || "42"), enabled: Boolean(schedule.enabled)
    }));
    renderOverlay();
    await selectTab("Reseed");

    const augment = await screen.findByLabelText("Seed Augment Multiplier");
    expect(augment).toHaveValue(2);
    fireEvent.change(augment, { target: { value: "2.5" } });
    fireEvent.change(screen.getByLabelText("Seed Ranked Armor Multiplier"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Seed Ranked Weapon Multiplier"), { target: { value: "1.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Reseed Schedule" }));

    await waitFor(() => expect(marketBotApi.saveSeedSchedule).toHaveBeenCalledWith({
      enabled: false,
      intervalMinutes: 15,
      priceMultiplier: 5,
      augmentMultiplier: 2.5,
      rankedArmorMultiplier: 3,
      rankedWeaponMultiplier: 1.5,
      augmentPricing: "discounted",
      commodityStacks: {},
      exchangeId: "42"
    }));
  });

  it("saves commodity stack counts from the reseed section", async () => {
    vi.mocked(marketBotApi.status).mockResolvedValue(statusFixture({
      commodityStackCatalog: [
        { templateId: "Oil", label: "Fuel Cell", group: "power", stackSize: 500 },
        { templateId: "AntiRadiationPill", label: "Iodine Pill", group: "survival", stackSize: 20 }
      ],
      commodityStackGroups: [
        { id: "power", label: "Power" },
        { id: "survival", label: "Survival" }
      ],
      seed: { ...statusFixture().seed, commodityStacks: { Oil: 2, AntiRadiationPill: 2 } }
    }));
    vi.mocked(marketBotApi.saveSeedSchedule).mockImplementation(async (schedule) => ({
      ...statusFixture().seed, ...schedule, exchangeId: String(schedule.exchangeId || "42"), enabled: Boolean(schedule.enabled)
    }));
    renderOverlay();
    await selectTab("Reseed");

    const fuel = await screen.findByLabelText("Fuel Cell Stacks");
    expect(fuel).toHaveValue(2);
    expect(screen.queryByText("10 × 500 = 5,000 units")).not.toBeInTheDocument();
    fireEvent.change(fuel, { target: { value: "10" } });
    expect(screen.getByText("10 × 500 = 5,000 units")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save Reseed Schedule" }));

    await waitFor(() => expect(marketBotApi.saveSeedSchedule).toHaveBeenCalledWith({
      enabled: false,
      intervalMinutes: 15,
      priceMultiplier: 5,
      augmentMultiplier: 1,
      rankedArmorMultiplier: 1,
      rankedWeaponMultiplier: 1,
      augmentPricing: "discounted",
      commodityStacks: { Oil: 10, AntiRadiationPill: 2 },
      exchangeId: "42"
    }));
  });

  it("disables Run reseed now until a seed schedule has a saved exchange", async () => {
    renderOverlay();
    await selectTab("Reseed");

    const runSeed = await screen.findByRole("button", { name: "Run Reseed Now" });
    expect(runSeed).toBeDisabled();
    await selectTab("Buyback");
    expect(await screen.findByRole("button", { name: "Run Sweep Now" })).toBeEnabled();
  });

  it("confirms before removing NPC listings and reports the removed count", async () => {
    vi.mocked(marketBotApi.unseed).mockResolvedValue({ status: "unseeded", removedListings: "180", removedItems: "180", exchangeId: "42" });
    const props = renderOverlay();
    await selectTab("Reseed");

    // Unlike Run reseed now, the unseed targets the exchange selected in the
    // dropdown, so it works without a saved seed schedule.
    fireEvent.click(await screen.findByRole("button", { name: "Remove NPC Listings" }));

    await waitFor(() => expect(props.confirmAction).toHaveBeenCalled());
    await waitFor(() => expect(marketBotApi.unseed).toHaveBeenCalledWith({ exchangeId: "42" }));
    expect(await screen.findByText(/removed 180 NPC listing\(s\) from exchange 42/)).toBeInTheDocument();
  });

  it("reports an empty market without claiming anything was removed", async () => {
    vi.mocked(marketBotApi.unseed).mockResolvedValue({
      status: "empty", removedListings: "0", removedItems: "0", exchangeId: "42",
      detail: "No bot listings on exchange 42; nothing removed and no backup was taken."
    });
    renderOverlay();
    await selectTab("Reseed");

    fireEvent.click(await screen.findByRole("button", { name: "Remove NPC Listings" }));

    expect(await screen.findByText(/No bot listings on exchange 42/)).toBeInTheDocument();
  });

  it("does not remove NPC listings when the confirmation is declined", async () => {
    const props = renderOverlay();
    props.confirmAction.mockResolvedValue(false);
    await selectTab("Reseed");

    fireEvent.click(await screen.findByRole("button", { name: "Remove NPC Listings" }));

    await waitFor(() => expect(props.confirmAction).toHaveBeenCalled());
    expect(marketBotApi.unseed).not.toHaveBeenCalled();
  });

  it("explains an unsupported schema instead of rendering controls", async () => {
    vi.mocked(marketBotApi.status).mockResolvedValue(statusFixture({
      capabilities: { exchangeMarket: false },
      reason: "Unsupported by detected schema. Missing required table(s): dune.dune_exchange_orders"
    }));
    renderOverlay();

    expect(await screen.findByText(/Missing required table/)).toBeInTheDocument();
    expect(screen.queryByText("Buyback Sweeps")).not.toBeInTheDocument();
  });

  it("explains a missing seed plan", async () => {
    vi.mocked(marketBotApi.status).mockResolvedValue(statusFixture({
      plan: { available: false, source: null, rows: 0, panelVersion: "", generatedAt: "" },
      plans: { activePlanId: "bundled", items: [] }
    }));
    renderOverlay();

    expect(await screen.findByText(/bundled market seed plan is missing/)).toBeInTheDocument();
    expect(screen.queryByText("Buyback Sweeps")).not.toBeInTheDocument();
  });

  it("shows stored sweep log batches with purchase and skip reasons", async () => {
    vi.mocked(marketBotApi.buybackLog).mockResolvedValue({
      batches: [{
        source: "Buyback sweep",
        exchangeId: "42",
        at: "2026-08-17T12:00:00.000Z",
        note: "",
        summary: "2 listing(s); 0x0×1, 0x1×1",
        entries: [
          { orderId: "11", templateId: "WaterBottle", displayName: "Water Bottle", qualityLevel: "0", itemPrice: "100", stackSize: "10", maxUnitPrice: "600", resultCode: 0, resultHex: "0x0", resultLabel: "success", detail: "bought stack 10 at 100/unit (cap 600)" },
          { orderId: "12", templateId: "Sword", displayName: "Sword", qualityLevel: "0", itemPrice: "900", stackSize: "1", maxUnitPrice: "600", resultCode: 1, resultHex: "0x1", resultLabel: "price too high", detail: "ask 900 > cap 600" }
        ]
      }]
    });
    renderOverlay();
    await selectTab("Activity");

    expect(await screen.findByLabelText("Buyback Sweep Log")).toBeInTheDocument();
    expect(screen.getByText("Buyback Sweep Log")).toBeInTheDocument();
    expect(screen.getByText("success")).toBeInTheDocument();
    expect(screen.getByText("price too high")).toBeInTheDocument();
    expect(screen.getByText("bought stack 10 at 100/unit (cap 600)")).toBeInTheDocument();
    expect(screen.getByText("ask 900 > cap 600")).toBeInTheDocument();
    expect(screen.getByText("Water Bottle")).toBeInTheDocument();
    expect(screen.getByLabelText("About Buyback Sweep Log")).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByLabelText("About Buyback Sweep Log"));
    expect(screen.getByText(/retained for five days/)).toBeInTheDocument();
  });

  it("refreshes the log with a dry-run classify and can clear it", async () => {
    const dryRun = {
      exchangeId: "42",
      entries: [{ orderId: "9", templateId: "Sword", displayName: "Sword", qualityLevel: "0", itemPrice: "50", stackSize: "1", maxUnitPrice: "1200", resultCode: 0, resultHex: "0x0", resultLabel: "eligible", detail: "ask 50/unit <= cap 1200" }],
      batches: [{
        source: "Dry-run classify",
        exchangeId: "42",
        at: "2026-08-17T12:01:00.000Z",
        note: "read-only; nothing purchased",
        summary: "1 listing(s); 0x0×1",
        entries: [{ orderId: "9", templateId: "Sword", displayName: "Sword", qualityLevel: "0", itemPrice: "50", stackSize: "1", maxUnitPrice: "1200", resultCode: 0, resultHex: "0x0", resultLabel: "eligible", detail: "ask 50/unit <= cap 1200" }]
      }]
    };
    vi.mocked(marketBotApi.refreshBuybackLog).mockImplementation(async () => {
      vi.mocked(marketBotApi.buybackLog).mockResolvedValue({ batches: dryRun.batches });
      return dryRun;
    });
    vi.mocked(marketBotApi.clearBuybackLog).mockImplementation(async () => {
      vi.mocked(marketBotApi.buybackLog).mockResolvedValue({ batches: [] });
      return { batches: [] };
    });
    renderOverlay();
    await selectTab("Activity");

    fireEvent.click(await screen.findByRole("button", { name: "Refresh Log (Dry-Run)" }));
    await waitFor(() => expect(marketBotApi.refreshBuybackLog).toHaveBeenCalledWith({
      exchangeId: "42", priceMultiplier: 5,
      augmentMultiplier: 1, rankedArmorMultiplier: 1, rankedWeaponMultiplier: 1,
      buybackPercent: 60, buybackPriceBasis: "seeded", maxBuys: 500
    }));
    expect(await screen.findByText(/1 player sell listing\(s\) classified on exchange 42/)).toBeInTheDocument();
    expect(screen.getByText("eligible")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear Log" }));
    await waitFor(() => expect(marketBotApi.clearBuybackLog).toHaveBeenCalled());
    expect(await screen.findByText("Buyback sweep log cleared.")).toBeInTheDocument();
  });

  it("sets the selected named seed plan as active and saves a friendly name", async () => {
    const bundled = { id: "bundled", name: "Bundled", source: "bundled" as const, readOnly: true, rows: 2910, panelVersion: "0.14.0", generatedAt: "", active: true };
    const cheap = { id: "cheap-water", name: "Cheap Water", source: "custom" as const, readOnly: false, rows: 12, panelVersion: "", generatedAt: "", active: false };
    vi.mocked(marketBotApi.status).mockResolvedValue(statusFixture({
      plans: { activePlanId: "bundled", items: [bundled, cheap] }
    }));
    vi.mocked(marketBotApi.setActivePlan).mockResolvedValue({
      activePlanId: "cheap-water",
      items: [{ ...bundled, active: false }, { ...cheap, active: true }]
    });
    vi.mocked(marketBotApi.renamePlan).mockResolvedValue({
      activePlanId: "cheap-water",
      items: [{ ...bundled, active: false }, { ...cheap, name: "Weekend Sale", active: true }]
    });
    renderOverlay();

    fireEvent.change(await screen.findByLabelText("Seed Plan"), { target: { value: "cheap-water" } });
    expect(screen.getByLabelText("Seed Plan Name")).toHaveValue("Cheap Water");
    fireEvent.click(screen.getByRole("button", { name: "Set as Active Plan" }));
    await waitFor(() => expect(marketBotApi.setActivePlan).toHaveBeenCalledWith({ planId: "cheap-water" }));
    expect(await screen.findByText(/Active seed plan is now Cheap Water/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Seed Plan Name"), { target: { value: "Weekend Sale" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Plan Name" }));
    await waitFor(() => expect(marketBotApi.renamePlan).toHaveBeenCalledWith({ planId: "cheap-water", name: "Weekend Sale" }));
  });

  it("downloads the selected seed plan as CSV and uploads a named list as the active plan", async () => {
    const createObjectURL = vi.fn(() => "blob:csv");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    vi.mocked(marketBotApi.uploadPlanCsv).mockResolvedValue({
      id: "cheap-water",
      name: "Cheap Water",
      rows: 1,
      active: true
    });
    renderOverlay();

    fireEvent.click(await screen.findByRole("button", { name: "Download CSV" }));
    await waitFor(() => expect(marketBotApi.downloadPlanCsv).toHaveBeenCalledWith("bundled"));
    expect(createObjectURL).toHaveBeenCalled();
    expect(await screen.findByText(/Downloaded market-seed-bundled\.csv/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Seed Plan Name"), { target: { value: "Cheap Water" } });
    const file = new File(["template_id,price\nWaterBottle,10\n"], "list.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("Upload CSV"), { target: { files: [file] } });
    await waitFor(() => expect(marketBotApi.uploadPlanCsv).toHaveBeenCalled());
    const form = vi.mocked(marketBotApi.uploadPlanCsv).mock.calls[0][0];
    expect(form.get("name")).toBe("Cheap Water");
    expect(form.get("planId")).toBe("bundled");
    expect(await screen.findByText(/Imported 1 row\(s\) as "Cheap Water"/)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("rejects SQL or non-CSV uploads before calling the import API", async () => {
    const props = renderOverlay();
    fireEvent.change(await screen.findByLabelText("Seed Plan Name"), { target: { value: "Cheap Water" } });
    const sqlFile = new File(["INSERT INTO items VALUES (1);"], "attack.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("Upload CSV"), { target: { files: [sqlFile] } });
    await waitFor(() => {
      expect(props.onError.mock.calls.some((call) => /SQL script/i.test(String(call[0])))).toBe(true);
    });
    expect(marketBotApi.uploadPlanCsv).not.toHaveBeenCalled();
  });
});
