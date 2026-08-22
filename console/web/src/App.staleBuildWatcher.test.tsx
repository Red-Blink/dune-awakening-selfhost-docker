import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const useStaleBuildWatcher = vi.hoisted(() => vi.fn());

vi.mock("./lib/staleBuildWatcher", () => ({ useStaleBuildWatcher }));

import { App } from "./App";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("App stale build watcher", () => {
  it("stays active while logged out so a rebuild cannot strand the old bundle at login", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      authenticated: false,
      csrfToken: null,
      config: { version: "v1.3.96" }
    }), { status: 200, headers: { "content-type": "application/json" } })));

    render(<App />);

    expect(useStaleBuildWatcher).toHaveBeenCalledWith();
  });
});
