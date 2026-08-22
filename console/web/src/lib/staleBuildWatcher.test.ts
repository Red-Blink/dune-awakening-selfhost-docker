import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { staleBuildWatcherInternals, useStaleBuildWatcher } from "./staleBuildWatcher";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); })
  };
}

// Returns `versions[0]` on every call until `advance()` is called, then
// `versions[1]`, and so on -- avoids asserting an exact call count on
// fetchVersion itself (this environment's fake timers can invoke a mounting
// effect's async body more than once without that affecting the hook's real,
// user-facing contract: whether/when reload() fires).
function versionSource(...versions: (string | null)[]) {
  let index = 0;
  return {
    fetchVersion: vi.fn(async () => versions[Math.min(index, versions.length - 1)]),
    advance: () => { index = Math.min(index + 1, versions.length - 1); }
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useStaleBuildWatcher", () => {
  it("does not reload on the initial poll -- it only establishes the baseline version", async () => {
    const reload = vi.fn();
    const { fetchVersion } = versionSource("v1.0.0");
    renderHook(() => useStaleBuildWatcher({ fetchVersion, reload, storage: memoryStorage() }));
    await vi.runOnlyPendingTimersAsync();

    expect(reload).not.toHaveBeenCalled();
  });

  it("does not reload while the polled version keeps matching the baseline", async () => {
    const reload = vi.fn();
    const { fetchVersion } = versionSource("v1.0.0");
    renderHook(() => useStaleBuildWatcher({ fetchVersion, reload, storage: memoryStorage(), intervalMs: 1000 }));
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads automatically the first time the polled version changes", async () => {
    const reload = vi.fn();
    const storage = memoryStorage();
    const { fetchVersion, advance } = versionSource("v1.0.0", "v1.0.1");
    renderHook(() => useStaleBuildWatcher({ fetchVersion, reload, storage, now: () => 100_000, intervalMs: 1000 }));
    await vi.runOnlyPendingTimersAsync();
    advance();
    await vi.advanceTimersByTimeAsync(1000);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledWith(staleBuildWatcherInternals.RELOAD_COOLDOWN_KEY, "100000");
  });

  it("does not reload again within the cooldown window", async () => {
    const reload = vi.fn();
    const storage = memoryStorage({ [staleBuildWatcherInternals.RELOAD_COOLDOWN_KEY]: "90000" });
    const { fetchVersion, advance } = versionSource("v1.0.0", "v1.0.1");
    renderHook(() => useStaleBuildWatcher({ fetchVersion, reload, storage, now: () => 100_000, intervalMs: 1000 }));
    await vi.runOnlyPendingTimersAsync();
    advance();
    await vi.advanceTimersByTimeAsync(1000);

    expect(reload).not.toHaveBeenCalled();
  });

  it("does not reload when storage is unavailable, even once a new version is seen", async () => {
    const reload = vi.fn();
    const { fetchVersion, advance } = versionSource("v1.0.0", "v1.0.1");
    renderHook(() => useStaleBuildWatcher({ fetchVersion, reload, storage: null, intervalMs: 1000 }));
    await vi.runOnlyPendingTimersAsync();
    advance();
    await vi.advanceTimersByTimeAsync(1000);

    expect(reload).not.toHaveBeenCalled();
  });

  it("does not crash and does not reload when the version fetch fails", async () => {
    const reload = vi.fn();
    const fetchVersion = vi.fn().mockRejectedValue(new Error("network error"));
    renderHook(() => useStaleBuildWatcher({ fetchVersion, reload, storage: memoryStorage(), intervalMs: 1000 }));
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(1000);

    expect(reload).not.toHaveBeenCalled();
  });

  it("never polls while disabled", async () => {
    const reload = vi.fn();
    const { fetchVersion } = versionSource("v1.0.0");
    renderHook(() => useStaleBuildWatcher({ enabled: false, fetchVersion, reload, storage: memoryStorage() }));
    await vi.advanceTimersByTimeAsync(staleBuildWatcherInternals.DEFAULT_POLL_INTERVAL_MS * 2);

    expect(fetchVersion).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("stops polling once disabled mid-flight", async () => {
    const reload = vi.fn();
    const { fetchVersion } = versionSource("v1.0.0");
    const { rerender } = renderHook(
      ({ enabled }) => useStaleBuildWatcher({ enabled, fetchVersion, reload, storage: memoryStorage(), intervalMs: 1000 }),
      { initialProps: { enabled: true } }
    );
    await vi.runOnlyPendingTimersAsync();
    fetchVersion.mockClear();
    rerender({ enabled: false });
    await vi.advanceTimersByTimeAsync(5000);

    expect(fetchVersion).not.toHaveBeenCalled();
  });
});
