import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./client";
import { vehiclesApi } from "./vehicles";

vi.mock("./client", () => ({ api: vi.fn() }));

describe("vehiclesApi.list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requests the bare endpoint when no params are given", () => {
    vehiclesApi.list();
    expect(api).toHaveBeenCalledWith("/api/vehicles");
  });

  it("serializes every provided param into the query string in order", () => {
    vehiclesApi.list({ q: "worm", page: 2, pageSize: 100, sortColumn: "owner", sortDirection: "desc" });
    expect(api).toHaveBeenCalledWith("/api/vehicles?q=worm&page=2&pageSize=100&sortColumn=owner&sortDirection=desc");
  });

  it("omits an empty search term and a falsy page (0)", () => {
    vehiclesApi.list({ q: "", page: 0, pageSize: 50 });
    expect(api).toHaveBeenCalledWith("/api/vehicles?pageSize=50");
  });

  it("URL-encodes special characters in the search term", () => {
    vehiclesApi.list({ q: "a&b c" });
    expect(api).toHaveBeenCalledWith("/api/vehicles?q=a%26b+c");
  });

  it("requests a player's vehicles with an encoded player id", () => {
    vehiclesApi.forPlayer("player/42");
    expect(api).toHaveBeenCalledWith("/api/players/player%2F42/vehicles");
  });
});

describe("vehiclesApi.storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads a vehicle's cargo hold with an encoded vehicle id", () => {
    vehiclesApi.storage("vehicle/1");
    expect(api).toHaveBeenCalledWith("/api/vehicles/vehicle%2F1/storage");
  });
});

describe("vehiclesApi permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads a vehicle's roster with an encoded vehicle id", () => {
    vehiclesApi.permissions("vehicle/1");
    expect(api).toHaveBeenCalledWith("/api/vehicles/vehicle%2F1/permissions");
  });

  it("PUTs the whole roster, not a delta", () => {
    vehiclesApi.setPermissions("5001", [{ playerId: "4", rank: 1 }, { playerId: "9", rank: 3 }]);
    expect(api).toHaveBeenCalledWith("/api/vehicles/5001/permissions", {
      method: "PUT",
      body: JSON.stringify({ entries: [{ playerId: "4", rank: 1 }, { playerId: "9", rank: 3 }] })
    });
  });

  it("searches candidates with a default limit of 25", () => {
    vehiclesApi.permissionCandidates("Leto");
    expect(api).toHaveBeenCalledWith("/api/vehicles/permission-candidates?q=Leto&limit=25");
  });

  it("omits an empty query but still sends the limit", () => {
    vehiclesApi.permissionCandidates("", 50);
    expect(api).toHaveBeenCalledWith("/api/vehicles/permission-candidates?limit=50");
  });
});
