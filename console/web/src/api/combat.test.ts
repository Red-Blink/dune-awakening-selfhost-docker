import { beforeEach, expect, it, vi } from "vitest";
import { api } from "./client";
import { combatApi } from "./combat";
vi.mock("./client", () => ({ api: vi.fn().mockResolvedValue({}) }));
beforeEach(() => vi.clearAllMocks());
it("sends separate row choices and preserves the selected controller and fresh-data behavior", async () => {
  await combatApi.history("101", { leaderboardLimit: "all", killsLimit: 20 });
  const [path, options] = vi.mocked(api).mock.calls[0];
  const url = new URL(String(path), "https://console.example");
  expect(url.searchParams.get("controllerId")).toBe("101");
  expect(url.searchParams.get("leaderboardLimit")).toBe("all");
  expect(url.searchParams.get("killsLimit")).toBe("20");
  expect(options).toEqual({ cache: "no-store" });
});
it("keeps calls without row options compatible with the existing API", async () => {
  await combatApi.history();
  expect(api).toHaveBeenCalledWith("/api/players/combat", { cache: "no-store" });
});
