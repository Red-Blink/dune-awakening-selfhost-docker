import { afterEach, describe, expect, it } from "vitest";
import { ALL_TABS, loadPersistedTab, persistActiveTab } from "./App";

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
});
