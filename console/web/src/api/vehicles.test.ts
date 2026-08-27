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

  it("omits count entirely for a whole-stack delete", () => {
    vehiclesApi.deleteStorageItem("2008", "501", "DELETE ITEM");
    // Not `count: undefined` and not `count: null` -- the server reads an
    // absent count as "the whole slot" and a present one as an exact request
    // it will refuse to widen, so the two must not be conflated on the wire.
    expect(api).toHaveBeenCalledWith("/api/vehicles/2008/storage/items/501", {
      method: "DELETE",
      body: JSON.stringify({ confirmation: "DELETE ITEM" })
    });
  });

  it("sends count for a partial removal", () => {
    vehiclesApi.deleteStorageItem("2008", "501", "DELETE ITEM", 100);
    expect(api).toHaveBeenCalledWith("/api/vehicles/2008/storage/items/501", {
      method: "DELETE",
      body: JSON.stringify({ confirmation: "DELETE ITEM", count: 100 })
    });
  });

  it("encodes both ids on a single-item delete", () => {
    vehiclesApi.deleteStorageItem("vehicle/1", "item/2", "DELETE ITEM");
    expect(api).toHaveBeenCalledWith("/api/vehicles/vehicle%2F1/storage/items/item%2F2", {
      method: "DELETE",
      body: JSON.stringify({ confirmation: "DELETE ITEM" })
    });
  });

  it("sends the id list for a bulk delete", () => {
    vehiclesApi.deleteStorageItems("2008", ["501", "503"], "DELETE ITEMS");
    expect(api).toHaveBeenCalledWith("/api/vehicles/2008/storage/items", {
      method: "DELETE",
      body: JSON.stringify({ confirmation: "DELETE ITEMS", itemIds: ["501", "503"] })
    });
  });

  it("sends only the confirmation for a delete-all", () => {
    vehiclesApi.deleteAllStorageItems("2008", "DELETE ALL ITEMS");
    expect(api).toHaveBeenCalledWith("/api/vehicles/2008/storage/all-items", {
      method: "DELETE",
      body: JSON.stringify({ confirmation: "DELETE ALL ITEMS" })
    });
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
