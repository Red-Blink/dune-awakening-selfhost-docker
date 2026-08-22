import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALL_TABS, loadPersistedTab, persistActiveTab, useActiveTab } from "./App";
import { LazyTabBoundary } from "./components/common/LazyTabBoundary";

function ChunkFailure(): never {
  throw new Error("Failed to fetch dynamically imported module: /assets/Panel-old.js");
}

// Regression coverage for the tab surviving the automatic reload
// LazyTabBoundary triggers after a stale post-update chunk load -- without
// this, that reload always dropped the user back on Home instead of the tab
// they were trying to open.
describe("active tab persistence", () => {
  afterEach(() => {
    window.sessionStorage.clear();
  });

  it("defaults to Home when nothing is persisted", () => {
    expect(loadPersistedTab()).toBe("Home");
  });

  it("restores a tab that was persisted", () => {
    persistActiveTab("Care Package");
    expect(loadPersistedTab()).toBe("Care Package");
  });

  it("falls back to Home for a stale/invalid persisted value", () => {
    window.sessionStorage.setItem("dune-console:active-tab", "Some Removed Tab");
    expect(loadPersistedTab()).toBe("Home");
  });

  it("validates against every currently known tab", () => {
    for (const tab of ALL_TABS) {
      persistActiveTab(tab);
      expect(loadPersistedTab()).toBe(tab);
    }
  });

  it("does not throw and falls back to Home when sessionStorage.getItem throws", () => {
    const spy = vi.spyOn(window.sessionStorage.__proto__, "getItem").mockImplementation(() => {
      throw new Error("SecurityError: storage access denied");
    });
    expect(loadPersistedTab()).toBe("Home");
    spy.mockRestore();
  });

  it("does not throw when sessionStorage.setItem throws (quota exceeded, private browsing)", () => {
    const spy = vi.spyOn(window.sessionStorage.__proto__, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => persistActiveTab("Care Package")).not.toThrow();
    spy.mockRestore();
  });
});

// Covers the actual init-from-storage + persist-on-change wiring App() uses
// (useState(loadPersistedTab) + useEffect(persistActiveTab)) end to end,
// not just its two halves in isolation -- a break here only shows up in
// practice as "the reload lost my tab", with no type or lint error.
describe("useActiveTab", () => {
  afterEach(() => {
    window.sessionStorage.clear();
  });

  it("initializes from whatever tab was already persisted", () => {
    persistActiveTab("Care Package");
    const { result } = renderHook(() => useActiveTab());
    expect(result.current[0]).toBe("Care Package");
  });

  it("persists to sessionStorage whenever the tab changes", () => {
    const { result } = renderHook(() => useActiveTab());
    expect(result.current[0]).toBe("Home");

    act(() => {
      result.current[1]("Settings");
    });

    expect(result.current[0]).toBe("Settings");
    expect(loadPersistedTab()).toBe("Settings");
  });

  it("persists the destination before a lazy chunk recovery reload", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn(() => {
      expect(loadPersistedTab()).toBe("Care Package");
    });

    function Harness() {
      const [tab, setTab] = useActiveTab();
      return <>
        <button onClick={() => setTab("Care Package")}>Open Care Package</button>
        {tab === "Care Package" && <LazyTabBoundary reload={reload}><ChunkFailure /></LazyTabBoundary>}
      </>;
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open Care Package" }));

    expect(reload).toHaveBeenCalledTimes(1);
  });
});
