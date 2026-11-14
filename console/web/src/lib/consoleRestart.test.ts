import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, post } from "../api/client";
import { restartConsoleAndReload } from "./consoleRestart";

vi.mock("../api/client", async (original) => ({ ...await original<typeof import("../api/client")>(), post: vi.fn() }));

describe("Console restart readiness", () => {
  const replace = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    Object.defineProperty(window, "location", { configurable: true, value: { replace } });
    vi.mocked(post).mockResolvedValue({ ok: true });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  const state = (instanceId: string, enabled = true) => ({ ok: true, json: async () => ({ instanceId, config: { enabled } }) });

  it("ignores the old process, proxy downtime, and a new process with stale configuration", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(state("old"))
      .mockResolvedValueOnce(state("old"))
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(state("new", false))
      .mockResolvedValueOnce(state("new", true));
    vi.stubGlobal("fetch", fetch);
    const done = restartConsoleAndReload(config => config.enabled === true);
    await vi.advanceTimersByTimeAsync(8000);
    expect(replace).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(replace).toHaveBeenCalledExactlyOnceWith("/");
    expect(post).toHaveBeenCalledExactlyOnceWith("/api/setup/discord-restart", {});
  });

  it("shows a server rejection without polling or pretending a restart started", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(state("old")));
    vi.mocked(post).mockRejectedValue(new ApiError("Password required", 403));
    await expect(restartConsoleAndReload(() => true)).rejects.toThrow("Password required");
    expect(replace).not.toHaveBeenCalled();
  });

  it("keeps the page open and explains an unfinished build", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(state("old")));
    const onTimeout = vi.fn();
    const done = restartConsoleAndReload(() => true, { onTimeout });
    await vi.advanceTimersByTimeAsync(600000);
    await done;
    expect(replace).not.toHaveBeenCalled();
    expect(onTimeout).toHaveBeenCalledWith(expect.stringMatching(/taking longer.*rebuild/i));
  });
});
