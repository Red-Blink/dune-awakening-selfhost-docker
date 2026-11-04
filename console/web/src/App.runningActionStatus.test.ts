import { describe, expect, it, vi } from "vitest";
import { loadRunningActionStatus, skipWhileInFlight } from "./App";
import type { HomeLoadResult } from "./features/server/ServerPanels";

function result(overrides: Partial<HomeLoadResult> = {}): HomeLoadResult {
  return { statusLoaded: true, readinessLoaded: true, statusError: "", readinessError: "", statusText: "", readinessText: "", sampledAtMs: 1_000, ...overrides };
}

// Seen live on dune2: the 3s restart poll read cached status through the whole
// stop phase, and Home's "Updated" line froze at "8m ago" while it ran.
describe("loadRunningActionStatus", () => {
  it("asks for a fresh reading on every tick", async () => {
    const load = vi.fn().mockResolvedValue(result());
    await loadRunningActionStatus(load, vi.fn());
    expect(load).toHaveBeenCalledWith({ fresh: true });
  });

  it("moves Home's clock to when the reading was taken", async () => {
    const setSampledAtMs = vi.fn();
    await loadRunningActionStatus(vi.fn().mockResolvedValue(result({ sampledAtMs: 42_000 })), setSampledAtMs);
    expect(setSampledAtMs).toHaveBeenCalledWith(42_000);
  });

  it("leaves the clock alone when both reads failed, so the age keeps growing", async () => {
    const setSampledAtMs = vi.fn();
    await loadRunningActionStatus(vi.fn().mockResolvedValue(result({ statusLoaded: false, readinessLoaded: false })), setSampledAtMs);
    expect(setSampledAtMs).not.toHaveBeenCalled();
  });

  it("returns the result for the lifecycle checks", async () => {
    const loaded = result({ statusText: "Overall: READY" });
    expect(await loadRunningActionStatus(vi.fn().mockResolvedValue(loaded), vi.fn())).toBe(loaded);
  });
});

describe("skipWhileInFlight", () => {
  function deferredTick() {
    let finish: (fail?: boolean) => void = () => {};
    const tick = vi.fn(() => new Promise<void>((resolve, reject) => { finish = (fail) => (fail ? reject(new Error("read failed")) : resolve()); }));
    return { tick, finish: (fail?: boolean) => finish(fail) };
  }

  it("drops ticks that fire while a read is still running", async () => {
    const { tick, finish } = deferredTick();
    const guarded = skipWhileInFlight(tick);
    const first = guarded();
    void guarded();
    void guarded();
    expect(tick).toHaveBeenCalledTimes(1);
    finish();
    await first;
  });

  it("runs the next tick once the read finishes", async () => {
    const { tick, finish } = deferredTick();
    const guarded = skipWhileInFlight(tick);
    const first = guarded();
    finish();
    await first;
    void guarded();
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("recovers after a tick throws, so one failed read can't stop the poll", async () => {
    const { tick, finish } = deferredTick();
    const guarded = skipWhileInFlight(tick);
    const first = guarded();
    finish(true);
    await expect(first).rejects.toThrow("read failed");
    void guarded();
    expect(tick).toHaveBeenCalledTimes(2);
  });
});
