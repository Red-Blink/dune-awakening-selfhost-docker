import { act, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HomePanel,
  formatFreshness,
  homeNeedsWarmRefresh,
  homeOverallBadge,
  homeOverallHeading,
  homeStateDotTone,
  isPopulationUnknowable,
  isStatusSampleStale,
  STALE_SAMPLE_AGE_MS,
  isHomeActionComplete,
  performanceCardStatus,
  performanceTrackTone,
  type HomeLoadResult
} from "./ServerPanels";
import { normalizeStatus } from "../../lib/display";

// The panel polls performance every 3s and the Funcom token every 10s on mount.
// Neither is what these tests are about, so both are stubbed; `performance`
// is re-pointed per test to drive the utilisation thresholds.
const performanceMock = vi.fn();
const checkFuncomTokenMock = vi.fn();

vi.mock("../../api/server", () => ({
  serverApi: {
    performance: () => performanceMock(),
    checkFuncomToken: (since: string) => checkFuncomTokenMock(since),
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    status: vi.fn(),
    readiness: vi.fn(),
    restartQueue: vi.fn()
  }
}));

// The pending-queue hooks each hit their own endpoint on mount; the refill note
// they feed is not under test here.
vi.mock("../../lib/usePendingRefills", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/usePendingRefills")>();
  return {
    ...actual,
    usePendingQueues: () => ({
      fuel: { pending: null },
      water: { pending: null },
      deletes: { pending: null },
      vehicleDeletes: { pending: null },
      permissions: { pending: null }
    })
  };
});

const STATUS_TEXT = [
  "Title: Kovalt",
  "Region: EU",
  "Mode: public",
  "Server IP: 10.0.0.4",
  "Battlegroup: bg-12345",
  "Population: 14"
].join("\n");

function snapshot(cpu: number | null, memoryPercent: number | null, diskPercent: number | null) {
  return {
    cpuPercent: cpu,
    memory: { usedBytes: 8e9, totalBytes: 16e9, availableBytes: 8e9, percent: memoryPercent },
    disk: { usedBytes: 4e11, totalBytes: 5e11, freeBytes: 1e11, percent: diskPercent },
    uptimeSeconds: 561600,
    uptime: "6d 12h 00m",
    sampledAt: new Date(0).toISOString()
  };
}

function loadResult(overrides: Partial<HomeLoadResult> = {}): HomeLoadResult {
  return {
    statusLoaded: true,
    readinessLoaded: true,
    statusError: "",
    readinessError: "",
    statusText: STATUS_TEXT,
    readinessText: "READY: all checks passed",
    sampledAtMs: Date.now(),
    ...overrides
  };
}

function renderHome(props: Partial<Parameters<typeof HomePanel>[0]> = {}) {
  const onLoad = props.onLoad || vi.fn().mockResolvedValue(loadResult());
  return {
    onLoad,
    ...render(<HomePanel
      status={STATUS_TEXT}
      readiness="READY: all checks passed"
      taskResult={null}
      setTaskResult={vi.fn()}
      funcomTokenResult={null}
      setFuncomTokenResult={vi.fn()}
      runningAction=""
      restartStartObserved={false}
      setRunningAction={vi.fn()}
      onLoad={onLoad}
      confirmAction={vi.fn().mockResolvedValue(true)}
      restartGate={vi.fn()}
      {...props}
    />)
  };
}

// Find the .status-card whose title cell holds this label.
function card(label: string) {
  const title = screen.getAllByText(label).find((node) => node.closest(".status-card-title"));
  const found = title?.closest(".status-card");
  if (!found) throw new Error(`no status card for ${label}`);
  return found as HTMLElement;
}

// App owns sampledAtMs so it outlives HomePanel unmounting on a tab switch.
// This mirrors that, which is the only way to exercise the remount behaviour.
function renderStateful(props: Partial<Parameters<typeof HomePanel>[0]> = {}) {
  let setLoad: (fn: Parameters<typeof HomePanel>[0]["onLoad"]) => void = () => undefined;
  let setMounted: (value: boolean) => void = () => undefined;

  function Harness() {
    const [sampledAtMs, setSampledAtMs] = useState(0);
    const [mounted, setMountedState] = useState(true);
    const [load, setLoadState] = useState(() => props.onLoad || vi.fn().mockResolvedValue(loadResult()));
    setLoad = (fn) => act(() => setLoadState(() => fn));
    setMounted = (value) => act(() => setMountedState(value));
    if (!mounted) return <div />;
    return <HomePanel
      status={STATUS_TEXT}
      readiness="READY: all checks passed"
      taskResult={null}
      setTaskResult={vi.fn()}
      funcomTokenResult={null}
      setFuncomTokenResult={vi.fn()}
      runningAction=""
      restartStartObserved={false}
      setRunningAction={vi.fn()}
      confirmAction={vi.fn().mockResolvedValue(true)}
      restartGate={vi.fn()}
      {...props}
      onLoad={load}
      sampledAtMs={sampledAtMs}
      setSampledAtMs={setSampledAtMs}
    />;
  }

  const view = render(<Harness />);
  return {
    ...view,
    leaveHome: () => setMounted(false),
    enterHome: () => setMounted(true),
    rerenderWithLoad: (fn: Parameters<typeof HomePanel>[0]["onLoad"]) => setLoad(fn)
  };
}

beforeEach(() => {
  performanceMock.mockResolvedValue(snapshot(30, 40, 50));
  checkFuncomTokenMock.mockResolvedValue({ ok: true, mismatch: false, checkedSince: "10m" });
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("performanceCardStatus", () => {
  // Before this the badge was `performance ? "OK" : "INFO"`, so a disk at 96%
  // showed the same green pill as one at 4% and the band could never report a
  // problem at all.
  it("grades a reading against its own value, not merely whether a sample arrived", () => {
    expect(performanceCardStatus(30, true)).toBe("OK");
    expect(performanceCardStatus(74.9, true)).toBe("OK");
    expect(performanceCardStatus(75, true)).toBe("WARN");
    expect(performanceCardStatus(90, true)).toBe("WARN");
    expect(performanceCardStatus(90.1, true)).toBe("FAILED");
    expect(performanceCardStatus(96.7, true)).toBe("FAILED");
  });

  // The API returns null routinely, not exceptionally -- cpuPercent is null on
  // the first sample after every API start, because it needs two samples for a
  // delta. Reporting that as OK is the exact failure this function exists to
  // prevent, and the card literal used to collapse it to 0 before this guard.
  it("reports INFO for a missing or nonsensical reading, never OK", () => {
    expect(performanceCardStatus(30, false)).toBe("INFO");
    expect(performanceCardStatus(null, true)).toBe("INFO");
    expect(performanceCardStatus(null, false)).toBe("INFO");
    expect(performanceCardStatus(Number.NaN, true)).toBe("INFO");
    expect(performanceCardStatus(-5, true)).toBe("INFO");
  });

  it("moves the bar tone with the badge so the two cannot disagree", () => {
    expect(performanceTrackTone(30, true)).toBe("");
    expect(performanceTrackTone(85, true)).toBe("metric-track-warn");
    expect(performanceTrackTone(95, true)).toBe("metric-track-fail");
  });
});

describe("homeOverallHeading", () => {
  it("passes ordinary readings through", () => {
    expect(homeOverallHeading("Stopped")).toBe("Stopped");
    expect(homeOverallHeading("Starting")).toBe("Starting");
    expect(homeOverallHeading("Needs Review")).toBe("Needs Review");
    expect(homeOverallHeading(undefined)).toBe("Unknown");
  });

  // summarizeHomeStatus yields "Restarting Battlegroup" mid-restart, which
  // under the "Battlegroup Status:" prefix would say Battlegroup twice.
  it("drops the redundant word the heading prefix already supplies", () => {
    expect(homeOverallHeading("Restarting Battlegroup")).toBe("Restarting");
  });

  // isHomeActionComplete matches the summary value with /^OK$/, so the rename
  // has to stay in the render layer. This pins that it is display-only.
  it("reads a healthy battlegroup as Ready rather than OK", () => {
    expect(homeOverallHeading("OK")).toBe("Ready");
    expect(homeOverallHeading("ok")).toBe("Ready");
  });
});

describe("homeOverallBadge", () => {
  it("keeps the readings that were already correct", () => {
    expect(normalizeStatus(homeOverallBadge("OK"))).toBe("pass");
    expect(normalizeStatus(homeOverallBadge("Stopped"))).toBe("warn");
    expect(normalizeStatus(homeOverallBadge("Starting"))).toBe("warn");
    expect(normalizeStatus(homeOverallBadge("Stopping"))).toBe("warn");
    expect(normalizeStatus(homeOverallBadge("Restarting Battlegroup"))).toBe("warn");
    expect(normalizeStatus(homeOverallBadge("Unknown"))).toBe("info");
    expect(normalizeStatus(homeOverallBadge("Checking"))).toBe("info");
  });

  // "Readiness checked" is only ever the label for a readiness run that did
  // not pass -- a passing one reads "OK". inferStatus matched the word
  // "checked" against its pass list, so the dot went green at the exact moment
  // readiness had failed.
  it("does not report a failed readiness check as healthy", () => {
    expect(normalizeStatus(homeOverallBadge("Readiness checked"))).toBe("warn");
  });

  // Previously fell through to Info, the same neutral grey as "Unknown", so a
  // flagged subsystem looked identical to nothing being known yet.
  it("distinguishes a flagged subsystem from an unknown state", () => {
    expect(normalizeStatus(homeOverallBadge("Needs Review"))).toBe("warn");
    expect(normalizeStatus(homeOverallBadge("Needs Review"))).not.toBe(normalizeStatus(homeOverallBadge("Unknown")));
  });
});

describe("homeStateDotTone", () => {
  const healthy = [{ status: "Ready" }, { status: "Ready" }];
  const failed = [{ status: "Ready" }, { status: "FAILED" }];

  it("separates in-motion states from the ones that need a human", () => {
    // All four of these were the same amber as "Needs Review" before.
    expect(homeStateDotTone("Starting", healthy)).toBe("motion");
    expect(homeStateDotTone("Stopping", healthy)).toBe("motion");
    expect(homeStateDotTone("Restarting Battlegroup", healthy)).toBe("motion");
    expect(homeStateDotTone("Needs Review", healthy)).toBe("attention");
    expect(homeStateDotTone("Readiness checked", healthy)).toBe("attention");
  });

  it("reports a stopped battlegroup at full severity", () => {
    expect(homeStateDotTone("Stopped", healthy)).toBe("failed");
  });

  it("distinguishes having no reading from having a bad one", () => {
    expect(homeStateDotTone("Checking", healthy)).toBe("loading");
    expect(homeStateDotTone("Unknown", healthy)).toBe("nodata");
    expect(homeStateDotTone("Status loaded", healthy)).toBe("nodata");
    expect(homeStateDotTone("", healthy)).toBe("attention");
  });

  it("stays green only when nothing is wrong", () => {
    expect(homeStateDotTone("OK", healthy)).toBe("ok");
  });

  // summarizeHomeStatus's token-mismatch branch overrides its own ready
  // override, so "OK" can be reported while Funcom/FLS is FAILED right beside
  // it. The dot has to reflect the worst thing on screen, not just the word.
  it("escalates past the heading word when a subsystem has failed", () => {
    expect(homeStateDotTone("OK", failed)).toBe("failed");
    expect(homeStateDotTone("Needs Review", failed)).toBe("failed");
  });

  // A stop or restart takes the subsystems down on purpose; going red there
  // would cry wolf on an action the operator just triggered.
  it("does not escalate mid-action, when subsystems are down on purpose", () => {
    expect(homeStateDotTone("Restarting Battlegroup", failed)).toBe("motion");
    expect(homeStateDotTone("Stopping", failed)).toBe("motion");
  });

  // Stopped is already the top severity, so a failed subsystem cannot make it
  // worse -- but it must not downgrade it either.
  it("keeps a stopped battlegroup at failed regardless of subsystem state", () => {
    expect(homeStateDotTone("Stopped", failed)).toBe("failed");
  });
});

describe("formatFreshness", () => {
  it("counts seconds, then minutes, then hours", () => {
    const base = 1_000_000;
    expect(formatFreshness(base, base + 8_000)).toBe("8s ago");
    expect(formatFreshness(base, base + 59_000)).toBe("59s ago");
    expect(formatFreshness(base, base + 61_000)).toBe("1m ago");
    expect(formatFreshness(base, base + 3_600_000)).toBe("1h 0m ago");
    expect(formatFreshness(base, base + 5_400_000)).toBe("1h 30m ago");
  });

  it("renders nothing before the first successful load", () => {
    expect(formatFreshness(0, 1_000_000)).toBe("");
  });
});

describe("HomePanel performance band", () => {
  it("badges each utilisation card from its own reading", async () => {
    performanceMock.mockResolvedValue(snapshot(30, 85, 95));
    renderHome();
    await waitFor(() => expect(within(card("CPU Usage")).getByText("OK")).toBeTruthy());
    expect(within(card("Memory")).getByText("WARN")).toBeTruthy();
    expect(within(card("Disk")).getByText("FAILED")).toBeTruthy();
  });

  it("tones the meter bar to match", async () => {
    performanceMock.mockResolvedValue(snapshot(30, 85, 95));
    renderHome();
    await waitFor(() => expect(card("Disk").querySelector(".metric-track span")).toBeTruthy());
    expect(card("CPU Usage").querySelector(".metric-track span")?.className).toBe("");
    expect(card("Memory").querySelector(".metric-track span")?.className).toBe("metric-track-warn");
    expect(card("Disk").querySelector(".metric-track span")?.className).toBe("metric-track-fail");
  });

  it("gives Uptime no badge or bar at all -- it is not a utilisation figure", async () => {
    renderHome();
    // Wait for the loaded state specifically: an absent badge is also true before
    // the snapshot arrives, so waiting on the card merely existing would let this
    // pass without ever exercising the case where a badge could wrongly appear.
    await waitFor(() => expect(card("CPU Usage").textContent).toContain("30.0%"));
    expect(card("Uptime").querySelector(".badge")).toBeNull();
    expect(card("Uptime").querySelector(".metric-track")).toBeNull();
  });

  // Regression: the card literal read `performance?.cpuPercent ?? 0`, which
  // collapsed a null reading to 0 before performanceCardStatus could see it,
  // so an unmeasured CPU rendered a green OK pill beside the text "Sampling...".
  it("does not badge an unmeasured metric as OK", async () => {
    performanceMock.mockResolvedValue(snapshot(null, 40, 50));
    renderHome();
    // Wait on a value that ONLY exists once the snapshot has resolved. "Sampling..."
    // is not one: the CPU card shows it both when the whole snapshot is still null
    // and when only cpuPercent is, so waiting on it passes on first paint and the
    // assertions below then race an unloaded panel.
    await waitFor(() => expect(card("Memory").textContent).toContain("40.0%"));
    expect(card("CPU Usage").textContent).toContain("Sampling");
    expect(within(card("CPU Usage")).getByText("INFO")).toBeTruthy();
    expect(within(card("CPU Usage")).queryByText("OK")).toBeNull();
    // No bar either -- a 0%-wide track would read as "measured, and idle".
    expect(card("CPU Usage").querySelector(".metric-track")).toBeNull();
    // The metrics that did report still grade normally.
    expect(within(card("Memory")).getByText("OK")).toBeTruthy();
  });
});

describe("HomePanel server identity", () => {
  it("leads with the overall verdict as the hero heading", async () => {
    const { container } = renderHome();
    await waitFor(() => expect(container.querySelector(".home-hero-state")).toBeTruthy());
    // With a space: the dot between label and reading is an empty element, so
    // without one this reads "Battlegroup Status:Ready" to a screen reader.
    expect(container.querySelector(".home-hero-state")?.textContent).toBe("Battlegroup Status: Ready");
    expect(container.querySelector(".home-hero-state-value")?.textContent).toBe("Ready");
    // The label is an h3 so it matches the "Readiness & Health" and
    // "Performance" section headings by element rather than by restated CSS.
    const label = container.querySelector(".home-hero-state-label");
    expect(label?.tagName).toBe("H3");
    expect(label?.textContent).toBe("Battlegroup Status:");
  });

  it("summarises the identity values on one line under the state", async () => {
    const { container } = renderHome();
    await waitFor(() => expect(container.querySelector(".home-hero-identity")).toBeTruthy());
    const line = container.querySelector(".home-hero-identity")?.textContent || "";
    expect(line).toContain("Kovalt");
    expect(line).toContain("EU");
    expect(line).toContain("Public");
    expect(line).toContain("14 online");
  });

  // The Server Identity band was the only renderer of Population's WARN, so
  // folding population into the plain summary string dropped the signal that
  // the count could not be read.
  it("marks an unreadable player count instead of printing it as fact", async () => {
    const status = "Title: Kovalt\nPopulation: 14 / ?";
    const { container } = renderHome({ status, onLoad: vi.fn().mockResolvedValue(loadResult({ statusText: status })) });
    await waitFor(() => expect(container.querySelector(".home-hero-identity")).toBeTruthy());
    const warn = container.querySelector(".home-population-warn");
    expect(warn).not.toBeNull();
    expect(warn?.textContent).toContain("?");
  });

  it("leaves a healthy player count unmarked", async () => {
    const { container } = renderHome();
    await waitFor(() => expect(container.querySelector(".home-hero-identity")).toBeTruthy());
    expect(container.querySelector(".home-population-warn")).toBeNull();
    expect(container.querySelector(".home-hero-identity")?.textContent).toContain("14 online");
  });

  // The Performance band carries Uptime on its own card; the hero line said it
  // a second time.
  it("leaves uptime to the Performance band", async () => {
    const { container } = renderHome();
    // The uptime value comes from the performance snapshot, so wait for that --
    // the identity line renders straight from props and is present before it.
    await waitFor(() => expect(card("Uptime").textContent).toContain("6d 12h 00m"));
    expect(container.querySelector(".home-hero-identity")?.textContent).not.toContain("6d 12h 00m");
  });

  it("carries Server IP and Battlegroup as labelled reference values in the hero", async () => {
    const { container } = renderHome();
    await waitFor(() => expect(container.querySelector(".home-hero-meta")).toBeTruthy());
    const pairs = Array.from(container.querySelectorAll(".home-hero-meta-item")).map((node) => [
      node.querySelector("dt")?.textContent,
      node.querySelector("dd")?.textContent
    ]);
    expect(pairs).toEqual([["Server IP", "10.0.0.4"], ["Battlegroup", "bg-12345"]]);
  });

  // These two are now the only place those values appear, so an absent one has
  // to read "Unknown" rather than silently vanish from the panel.
  it("still names Server IP and Battlegroup when the status text omits them", async () => {
    const onLoad = vi.fn().mockResolvedValue(loadResult({ statusText: "Title: Kovalt" }));
    const { container } = renderHome({ status: "Title: Kovalt", onLoad });
    await waitFor(() => expect(container.querySelector(".home-hero-meta")).toBeTruthy());
    const pairs = Array.from(container.querySelectorAll(".home-hero-meta-item")).map((node) => [
      node.querySelector("dt")?.textContent,
      node.querySelector("dd")?.textContent
    ]);
    expect(pairs).toEqual([["Server IP", "Unknown"], ["Battlegroup", "Unknown"]]);
  });

  // The Server Identity band repeated Title/Region/Mode/Population, which the
  // hero summary line already carries. Only the performance cards remain.
  it("no longer renders a Server Identity band", async () => {
    const { container } = renderHome();
    await waitFor(() => expect(container.querySelector(".home-hero-meta")).toBeTruthy());
    expect(container.querySelector(".home-health")).toBeNull();
    expect(screen.queryByText("Server Identity")).toBeNull();
    const cardLabels = Array.from(container.querySelectorAll(".status-card-title > span:not(.badge)")).map((node) => node.textContent);
    expect(cardLabels).toEqual(["CPU Usage", "Memory", "Disk", "Uptime"]);
  });

  it("states each identity value exactly once", async () => {
    const { container } = renderHome();
    await waitFor(() => expect(container.querySelector(".home-hero-meta")).toBeTruthy());
    const text = container.textContent || "";
    for (const value of ["Kovalt", "10.0.0.4", "bg-12345"]) {
      expect(text.split(value).length - 1).toBe(1);
    }
  });
});

describe("HomePanel subsystem rows", () => {
  const SUBSYSTEMS = ["Containers", "Listeners", "Database", "Game Servers", "RabbitMQ", "Funcom/FLS"];

  it("lists every readiness subsystem", async () => {
    const { container } = renderHome();
    await waitFor(() => expect(container.querySelectorAll(".home-subsystem-row").length).toBe(6));
    const labels = Array.from(container.querySelectorAll(".home-subsystem-label")).map((node) => node.textContent);
    expect(labels).toEqual(SUBSYSTEMS);
  });

  it("routes an unhealthy subsystem to the tab that can fix it", async () => {
    const onNavigate = vi.fn();
    const { container } = renderHome({ onNavigate });
    await waitFor(() => expect(container.querySelectorAll(".home-subsystem-button").length).toBe(6));
    const rowFor = (label: string) => {
      const node = Array.from(container.querySelectorAll(".home-subsystem-label")).find((item) => item.textContent === label);
      return node?.closest("button") as HTMLButtonElement;
    };
    // Every row lands on Server Control: these report health, and that is where
    // health is diagnosed. Database deliberately included -- the Database tab is
    // for data, not for whether Postgres is up.
    for (const label of ["Containers", "Listeners", "Database", "Game Servers", "RabbitMQ", "Funcom/FLS"]) {
      onNavigate.mockClear();
      rowFor(label).click();
      expect(onNavigate, `${label} should route to Server Control`).toHaveBeenCalledWith("Server Control");
    }
  });

  it("renders plain rows, not buttons to nowhere, when no navigation is wired", async () => {
    const { container } = renderHome();
    await waitFor(() => expect(container.querySelectorAll(".home-subsystem-row").length).toBe(6));
    expect(container.querySelectorAll(".home-subsystem-button").length).toBe(0);
    expect(container.querySelectorAll(".home-subsystem-static").length).toBe(6);
  });
});

describe("HomePanel status freshness", () => {
  it("dates the values from the sample once a load succeeds", async () => {
    const { container } = renderStateful();
    await waitFor(() => expect(container.querySelector(".home-freshness")).toBeTruthy());
    expect(container.querySelector(".home-freshness")?.textContent).toMatch(/^Updated \d+s ago$/);
    expect(container.querySelector(".home-freshness.stale")).toBeNull();
  });

  // The API caches status for ~15s, so a cache hit carries an older sampledAt.
  // Dating the fetch instead would make a 12s-old snapshot claim to be current.
  it("reports the age of the sample, not of the fetch", async () => {
    const sampledAtMs = Date.now() - 12_000;
    const { container } = renderStateful({ onLoad: vi.fn().mockResolvedValue(loadResult({ sampledAtMs })) });
    await waitFor(() => expect(container.querySelector(".home-freshness")).toBeTruthy());
    expect(container.querySelector(".home-freshness")?.textContent).toMatch(/^Updated 1[12] s? ?ago$|^Updated 12s ago$/);
  });

  // No failed poll anywhere in this test: age alone is the signal now, which is
  // what makes it survive a remount and a hidden tab.
  it("warns on a sample older than the threshold with no failed poll", async () => {
    const sampledAtMs = Date.now() - (STALE_SAMPLE_AGE_MS + 5_000);
    const { container } = renderStateful({ onLoad: vi.fn().mockResolvedValue(loadResult({ sampledAtMs })) });
    await waitFor(() => expect(container.querySelector(".home-freshness.stale")).toBeTruthy());
    expect(container.querySelector(".home-freshness")?.textContent).toMatch(/^Status may be stale/);
    // The last good values stay on screen -- the point is to date them, not
    // blank the panel.
    expect(container.querySelector(".home-hero-identity")?.textContent).toContain("Kovalt");
    expect(container.querySelector(".home-hero-meta")?.textContent).toContain("10.0.0.4");
  });

  // The assertion that actually pins the fix: with the old component-state
  // counter both the age and the warning reset to zero on every remount, so
  // leaving Home during an outage and coming back hid the problem.
  it("keeps the age and the warning across leaving Home and coming back", async () => {
    const sampledAtMs = Date.now() - (STALE_SAMPLE_AGE_MS + 5_000);
    const onLoad = vi.fn().mockResolvedValue(loadResult({ sampledAtMs }));
    const view = renderStateful({ onLoad });
    await waitFor(() => expect(view.container.querySelector(".home-freshness.stale")).toBeTruthy());

    view.leaveHome();
    expect(view.container.querySelector(".home-freshness")).toBeNull();

    view.enterHome();
    // Present immediately on return, before any new load resolves.
    expect(view.container.querySelector(".home-freshness.stale")).toBeTruthy();
    expect(view.container.querySelector(".home-freshness")?.textContent).toMatch(/^Status may be stale/);
  });

  it("clears the warning once a fresh sample arrives", async () => {
    const stale = Date.now() - (STALE_SAMPLE_AGE_MS + 5_000);
    const onLoad = vi.fn().mockResolvedValue(loadResult({ sampledAtMs: stale }));
    const { container, rerenderWithLoad } = renderStateful({ onLoad });
    await waitFor(() => expect(container.querySelector(".home-freshness.stale")).toBeTruthy());

    // Swapping the prop alone changes nothing -- the mount effect has already
    // run. Clear it the way an operator would, via Refresh Status.
    rerenderWithLoad(vi.fn().mockResolvedValue(loadResult({ sampledAtMs: Date.now() })));
    screen.getByRole("button", { name: /Refresh Status/i }).click();

    await waitFor(() => expect(container.querySelector(".home-freshness.stale")).toBeNull());
    expect(container.querySelector(".home-freshness")?.textContent).toMatch(/^Updated /);
  });
});

// The API caches status/readiness for ~15s. Anything driving the restart
// lifecycle must bypass that cache, or isHomeActionComplete can be handed a
// pre-restart snapshot; anything merely displaying it should not.
describe("HomePanel cache bypass", () => {
  const freshFlags = (onLoad: ReturnType<typeof vi.fn>) =>
    onLoad.mock.calls.map(([opts]) => Boolean(opts?.fresh));

  it("accepts a cached read on mount -- the visit that used to cost ~4s", async () => {
    const onLoad = vi.fn().mockResolvedValue(loadResult());
    renderHome({ onLoad });
    await waitFor(() => expect(onLoad).toHaveBeenCalled());
    expect(freshFlags(onLoad)).toEqual([false]);
  });

  it("forces a fresh read when the operator asks for one", async () => {
    const onLoad = vi.fn().mockResolvedValue(loadResult());
    renderHome({ onLoad });
    await waitFor(() => expect(onLoad).toHaveBeenCalled());
    onLoad.mockClear();

    screen.getByRole("button", { name: /Refresh Status/i }).click();
    await waitFor(() => expect(onLoad).toHaveBeenCalled());
    expect(freshFlags(onLoad).every(Boolean)).toBe(true);
  });

  it("forces fresh reads while the battlegroup is warming", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const warming = ["Overall: WARMING", "Title: Kovalt", "", "Game servers", "Survival_1 WARMING"].join("\n");
    const onLoad = vi.fn().mockResolvedValue(loadResult({ statusText: warming, readinessText: "", readinessLoaded: false }));
    renderHome({ onLoad, status: warming, readiness: "" });
    await vi.waitFor(() => expect(onLoad).toHaveBeenCalled());
    onLoad.mockClear();

    // One tick of the 5s warm poll.
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(onLoad).toHaveBeenCalled();
    expect(freshFlags(onLoad).every(Boolean)).toBe(true);
  });
});

// A stopped battlegroup used to report six rows of "Needs Review" -- there is
// nothing to review, everything is simply off.
describe("HomePanel when the battlegroup is stopped", () => {
  const STOPPED_STATUS = [
    "Overall: STOPPED",
    "Title: Kovalt",
    "",
    "Containers",
    "dune-postgres missing",
    "dune-rmq-admin missing",
    "dune-rmq-game missing",
    "dune-text-router missing",
    "dune-director missing",
    "dune-server-gateway missing",
    "dune-server-survival-1 missing",
    "dune-server-overmap missing"
  ].join("\n");

  const renderStopped = () => renderHome({
    status: STOPPED_STATUS,
    readiness: "",
    onLoad: vi.fn().mockResolvedValue(loadResult({ statusText: STOPPED_STATUS, readinessText: "", readinessLoaded: false }))
  });

  it("says every subsystem is stopped rather than needing review", async () => {
    const { container } = renderStopped();
    await waitFor(() => expect(container.querySelectorAll(".home-subsystem-row").length).toBe(6));
    const values = Array.from(container.querySelectorAll(".home-subsystem-value")).map((node) => node.textContent);
    expect(values.every((text) => text?.includes("Stopped"))).toBe(true);
    expect(values.some((text) => text?.includes("Needs Review"))).toBe(false);
  });

  it("badges them FAILED, not WARN", async () => {
    const { container } = renderStopped();
    await waitFor(() => expect(container.querySelectorAll(".home-subsystem-row .badge").length).toBe(6));
    const badges = Array.from(container.querySelectorAll(".home-subsystem-row .badge"));
    expect(badges.every((b) => b.className.includes("badge-fail"))).toBe(true);
  });

  // Population is unknowable while the battlegroup is down, so reporting it as
  // "population unavailable" in amber flagged an expected consequence as if it
  // were a problem.
  it("says nothing about population, rather than warning it is unavailable", async () => {
    const { container } = renderStopped();
    await waitFor(() => expect(container.querySelector(".home-hero-identity")).toBeTruthy());
    const line = container.querySelector(".home-hero-identity")?.textContent || "";
    expect(line).not.toMatch(/population/i);
    expect(line).not.toMatch(/online/i);
    expect(container.querySelector(".home-population-warn")).toBeNull();
    // The rest of the identity line survives -- this drops one segment, not the line.
    expect(line).toContain("Kovalt");
  });

  it("carries the same severity in the heading dot", async () => {
    const { container } = renderStopped();
    await waitFor(() => expect(container.querySelector(".home-state-dot")).toBeTruthy());
    expect(container.querySelector(".home-state-dot")?.className).toContain("home-state-dot-failed");
    expect(container.querySelector(".home-hero-state h3")?.textContent).toBe("Battlegroup Status:");
  });

  // Reported live: the Stop banner appeared while all six rows stayed "Ready".
  // status and readiness are separate reads, so status flipped to STOPPED while
  // readiness was still the previous "READY:", and the readiness all-clear was
  // winning. Every fixture above passes an empty readiness, which is why none of
  // them caught it.
  it("believes an observed stop over a readiness reading left over from before it", async () => {
    const { container } = renderHome({
      status: STOPPED_STATUS,
      readiness: "READY: all checks passed",
      taskResult: { status: "stopped", title: "Battlegroup Stopped" },
      onLoad: vi.fn().mockResolvedValue(loadResult({ statusText: STOPPED_STATUS, readinessText: "READY: all checks passed" }))
    });
    await waitFor(() => expect(container.querySelectorAll(".home-subsystem-row").length).toBe(6));
    const values = Array.from(container.querySelectorAll(".home-subsystem-value")).map((node) => node.textContent);
    expect(values.every((text) => text?.includes("Stopped"))).toBe(true);
    expect(container.querySelector(".home-hero-state-value")?.textContent).toBe("Stopped");
    expect(container.querySelector(".home-state-dot")?.className).toContain("home-state-dot-failed");
  });

  // The reading is coloured from the same tone as the dot. Asserting they match
  // rather than naming the class twice: the point is that they cannot disagree.
  it("colours the reading to match its dot", async () => {
    const { container } = renderStopped();
    await waitFor(() => expect(container.querySelector(".home-state-dot")).toBeTruthy());
    const dot = container.querySelector(".home-state-dot")?.className || "";
    const value = container.querySelector(".home-hero-state-value")?.className || "";
    expect(dot).toContain("home-state-dot-failed");
    expect(value).toContain("home-hero-state-value-failed");
  });

  // The same override fires for a failed start/restart. Claiming "Stopped"
  // there would be a false statement about what happened.
  it("does not claim stopped when an action merely failed", async () => {
    const { container } = renderHome({
      status: "Title: Kovalt",
      readiness: "",
      taskResult: { status: "failed", title: "Battlegroup Start Failed" },
      onLoad: vi.fn().mockResolvedValue(loadResult({ statusText: "Title: Kovalt", readinessText: "", readinessLoaded: false }))
    });
    await waitFor(() => expect(container.querySelectorAll(".home-subsystem-row").length).toBe(6));
    const values = Array.from(container.querySelectorAll(".home-subsystem-value")).map((node) => node.textContent);
    expect(values.every((text) => text?.includes("Needs Review"))).toBe(true);
    expect(values.some((text) => text?.includes("Stopped"))).toBe(false);
  });
});

// Population is unknowable whenever the battlegroup is not serving -- stopped,
// or moving to or from stopped. summarizeHomeStatus reports "Unavailable" and
// flags it WARN in all of them, which put an amber warning beside the server
// name for an expected condition.
describe("isPopulationUnknowable", () => {
  it("covers stopped and every transitional reading", () => {
    for (const value of ["Stopped", "Starting", "Stopping", "Restarting Battlegroup"]) {
      expect(isPopulationUnknowable(value), value).toBe(true);
    }
  });

  // These leave the battlegroup up and serving, so the count is real.
  it("leaves a serving battlegroup alone", () => {
    for (const value of ["OK", "Needs Review", "Warming"]) {
      expect(isPopulationUnknowable(value), value).toBe(false);
    }
  });

  it("matches on the whole word, not a prefix", () => {
    expect(isPopulationUnknowable("Stoppedish")).toBe(false);
    expect(isPopulationUnknowable("")).toBe(false);
    expect(isPopulationUnknowable(undefined)).toBe(false);
  });
});

describe("isStatusSampleStale", () => {
  const now = 1_000_000_000;
  it("is not stale inside the window and stale outside it", () => {
    expect(isStatusSampleStale(now - (STALE_SAMPLE_AGE_MS - 1), now)).toBe(false);
    expect(isStatusSampleStale(now - (STALE_SAMPLE_AGE_MS + 1), now)).toBe(true);
  });

  it("treats a never-sampled panel as not stale rather than alarming on first paint", () => {
    expect(isStatusSampleStale(0, now)).toBe(false);
  });
});

// Regression guard for the constraint that made this refactor safe.
// summarizeHomeStatus is not only a view model: its health/identity arrays
// drive the restart lifecycle. Removing the Readiness & Health *band* must not
// remove the health *entries*. Emptying that array makes the first case here
// fail, which is exactly the accident this guards.
describe("summarizeHomeStatus consumers still see identity and health entries", () => {
  const WARMING_STATUS = ["Overall: WARMING", "Title: Kovalt", "", "Game servers", "Survival_1 WARMING"].join("\n");

  it("treats a READY readiness as a completed action via the health array", () => {
    // No required-signal lines, so isHomeReadinessOperational is false and the
    // verdict has to come from summary.health being fully OK.
    expect(isHomeActionComplete("Title: Kovalt", "READY: all checks passed")).toBe(true);
  });

  it("still reports an incomplete action when nothing is ready", () => {
    expect(isHomeActionComplete("", "")).toBe(false);
  });

  it("reads Overall and Game Servers to pick the warm poll cadence", () => {
    expect(homeNeedsWarmRefresh(WARMING_STATUS, "")).toBe(true);
    expect(homeNeedsWarmRefresh("Title: Kovalt", "READY: all checks passed")).toBe(false);
  });
});
