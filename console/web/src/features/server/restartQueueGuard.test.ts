import { beforeEach, describe, expect, it, vi } from "vitest";
import { basesApi } from "../../api/bases";
import { serverApi } from "../../api/server";
import { runGatedRestart, type RestartGateMeta } from "./restartQueueGuard";

vi.mock("../../api/bases", () => ({
  basesApi: {
    pendingRefills: vi.fn(),
    pendingWaterRefills: vi.fn(),
    pendingDeletes: vi.fn(),
    pendingChildAccess: vi.fn()
  }
}));

vi.mock("../../api/server", () => ({
  serverApi: { restartQueue: vi.fn() }
}));

function refills(total: number, partitionId = 59) {
  return {
    supported: true,
    total,
    pending: Array.from({ length: total }, (_, index) => ({
      baseId: 100 + index, map: "DeepDesert", partitionId, queuedAt: "2026-08-25T00:00:00.000Z", attempts: 0, lastError: ""
    })),
    byTarget: total ? [{ map: "DeepDesert", partitionId, partitionMap: "Deep_Desert", dimensionIndex: 0, count: total }] : []
  };
}

function emptyQueues() {
  vi.mocked(basesApi.pendingRefills).mockResolvedValue(refills(0) as never);
  vi.mocked(basesApi.pendingWaterRefills).mockResolvedValue(refills(0) as never);
  vi.mocked(basesApi.pendingDeletes).mockResolvedValue(refills(0) as never);
  vi.mocked(basesApi.pendingChildAccess).mockResolvedValue({ supported: true, total: 0, pending: [], byTarget: [] } as never);
}

async function capture(target?: { partitionId: number; map?: string }) {
  let meta: RestartGateMeta | null = null;
  await runGatedRestart({
    restartGate: async (received) => { meta = received; return "cancel"; },
    label: "Deep_Desert",
    dispatch: async () => ({ queued: false, task: undefined }) as never,
    target: target as never
  });
  return meta as RestartGateMeta | null;
}

beforeEach(() => {
  vi.clearAllMocks();
  emptyQueues();
  vi.mocked(serverApi.restartQueue).mockResolvedValue({
    settings: { enabled: false, defaultCountdownMinutes: 15 }, playersOnline: 0, battlegroupPlayersOnline: 0
  } as never);
});

describe("runGatedRestart queued-writes detail", () => {
  // Every restart surface funnels through here -- per-service Restart,
  // Landsraad, the Maps deferred-settings banner, Admin Tools "Restart Now" --
  // and none of them knew about these queues before.
  it("reports all four queues battlegroup-wide when no target is given", async () => {
    vi.mocked(basesApi.pendingRefills).mockResolvedValue(refills(2) as never);
    vi.mocked(basesApi.pendingWaterRefills).mockResolvedValue(refills(1) as never);
    vi.mocked(basesApi.pendingDeletes).mockResolvedValue(refills(1) as never);
    vi.mocked(basesApi.pendingChildAccess).mockResolvedValue({
      supported: true,
      total: 1,
      pending: [{
        baseId: 3453, map: "DeepDesert", partitionId: 59, queuedAt: "2026-08-25T00:00:00.000Z", attempts: 0, lastError: "",
        updates: [{ actorId: "1", accessLevel: 3 }, { actorId: "2", accessLevel: 5 }]
      }],
      byTarget: [{ map: "DeepDesert", partitionId: 59, partitionMap: "Deep_Desert", dimensionIndex: 0, count: 1 }]
    } as never);

    const detail = (await capture())?.details?.find((entry) => entry.label === "Queued Writes");
    // Permissions count pieces, not bases: one base with two queued pieces is
    // two pending writes.
    expect(detail?.value).toBe("2 generator refills, 1 water refill, 1 base delete, 2 permission changes");
  });

  it("scopes counts to the targeted partition", async () => {
    vi.mocked(basesApi.pendingRefills).mockResolvedValue(refills(2, 59) as never);
    const detail = (await capture({ partitionId: 3 }))?.details?.find((entry) => entry.label === "Queued Writes");
    expect(detail).toBeUndefined();

    const onTarget = (await capture({ partitionId: 59 }))?.details?.find((entry) => entry.label === "Queued Writes");
    expect(onTarget?.value).toBe("2 generator refills");
  });

  it("adds no detail when nothing is queued", async () => {
    expect((await capture())?.details?.some((entry) => entry.label === "Queued Writes")).toBeFalsy();
  });

  // These counts are context, not a gate: an unreachable queue endpoint must
  // not block a restart the operator has already decided to run.
  it("still shows the dialog when the queue endpoints fail", async () => {
    vi.mocked(basesApi.pendingRefills).mockRejectedValue(new Error("offline"));
    vi.mocked(basesApi.pendingChildAccess).mockRejectedValue(new Error("offline"));
    const meta = await capture();
    expect(meta).not.toBeNull();
    expect(meta?.details?.some((entry) => entry.label === "Queued Writes")).toBeFalsy();
  });
});
