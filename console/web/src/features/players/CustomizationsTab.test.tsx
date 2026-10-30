import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { playersApi } from "../../api/players";
import { CustomizationsTab } from "./CustomizationsTab";

vi.mock("../../api/players", () => ({
  playersApi: {
    customizations: vi.fn(),
    grantCustomizations: vi.fn()
  }
}));

const groups = [
  { id: "atreides", name: "Atreides", count: 2 },
  { id: "dune-man", name: "Dune Man", count: 1 }
];

const rows = [
  { itemId: "B1C3_Atre_Maula_Pistol", name: "Atreides Pistol", groupId: "atreides", group: "Atreides", status: "Available" },
  { itemId: "B1C3_Atre_Sword", name: "Atreides Sword", groupId: "atreides", group: "Atreides", status: "Pending" },
  { itemId: "MTX_B1C2_DuneManCoverallsSetVariant_Top", name: "Dune Man Jacket", groupId: "dune-man", group: "Dune Man", status: "Available", requiredDlc: "Lost Harvest", entitlementControlled: true }
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(playersApi.customizations).mockResolvedValue({ groups, rows, capabilities: { customizationOwnership: false, customizationPending: true } });
});

it("unlocks Halloween cosmetics directly with an offline confirmation and ownership status", async () => {
  const itemId = "Halloween2026_Radsuit_Variant";
  vi.mocked(playersApi.customizations).mockResolvedValue({
    groups: [{ id: "halloween-2026", name: "Halloween 2026", count: 1 }],
    rows: [{ itemId, name: "Derelict Recovery Suit", groupId: "halloween-2026", group: "Halloween 2026", directUnlock: true, status: "Available" }],
    capabilities: {}
  });
  vi.mocked(playersApi.grantCustomizations).mockResolvedValue({
    ok: true, delivered: 0, unlocked: 1, granted: 1, requested: 0, skipped: 0, failed: 0,
    results: [{ itemId, status: "Unlocked", ok: true, ownershipVerified: true }]
  });
  const confirmAction = vi.fn().mockResolvedValue(true);
  render(<CustomizationsTab dbPlayerId="123" playerName="Chani" confirmAction={confirmAction} />);
  fireEvent.click(await screen.findByRole("button", { name: "Grant" }));
  await waitFor(() => expect(confirmAction).toHaveBeenCalledWith(expect.stringMatching(/1 event cosmetics.*fully offline/is), expect.anything()));
  expect(await screen.findByText(/1 unlocked/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Unlocked" })).toBeDisabled();
});

describe("CustomizationsTab", () => {
  it("shows grouped sets and marks tokens already waiting for login", async () => {
    render(<CustomizationsTab dbPlayerId="123" playerName="Chani" confirmAction={vi.fn().mockResolvedValue(true)} />);
    expect(await screen.findByText("Atreides Pistol")).toBeInTheDocument();
    expect(screen.getByText("Dune Man Jacket")).toBeInTheDocument();
    expect(screen.getByText("Pending Login")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Grant Set" })).toHaveLength(2);
  });

  it("grants a complete set in one request and skips pending tokens", async () => {
    const confirmAction = vi.fn().mockResolvedValue(true);
    vi.mocked(playersApi.grantCustomizations).mockResolvedValue({
      ok: true,
      granted: 1,
      requested: 0,
      skipped: 1,
      failed: 0,
      results: [
        { itemId: "B1C3_Atre_Maula_Pistol", status: "Processing", ok: true },
        { itemId: "B1C3_Atre_Sword", status: "Pending", ok: true, skipped: true }
      ]
    });
    render(<CustomizationsTab dbPlayerId="123" playerName="Chani" confirmAction={confirmAction} />);
    await screen.findByText("Atreides Pistol");
    fireEvent.click(screen.getAllByRole("button", { name: "Grant Set" })[0]);
    await waitFor(() => expect(playersApi.grantCustomizations).toHaveBeenCalledWith("123", {
      groupId: "atreides",
      itemId: undefined,
      confirmation: "GRANT CUSTOMIZATIONS"
    }));
    expect(confirmAction).toHaveBeenCalled();
    expect(await screen.findByText(/1 delivered · 1 already pending/i)).toBeInTheDocument();
  });

  it("reports an accepted but immediately consumed token as a delivery request", async () => {
    vi.mocked(playersApi.grantCustomizations).mockResolvedValue({
      ok: true,
      granted: 0,
      requested: 1,
      skipped: 0,
      failed: 0,
      results: [
        { itemId: "B1C3_Atre_Maula_Pistol", status: "Processing", ok: true, verified: false, deliveryRequested: true }
      ]
    });
    render(<CustomizationsTab dbPlayerId="123" playerName="Chani" confirmAction={vi.fn().mockResolvedValue(true)} />);
    await screen.findByText("Atreides Pistol");
    fireEvent.click(screen.getAllByRole("button", { name: "Grant" })[0]);
    expect(await screen.findByText(/^1 delivery requested\./i)).toBeInTheDocument();
    expect(screen.getByText(/persistent ownership cannot be verified/i)).toBeInTheDocument();
    expect(screen.queryByText(/1 failed/i)).not.toBeInTheDocument();
  });

  it("shows a DLC requirement in Filmic Archive grant confirmations", async () => {
    const confirmAction = vi.fn().mockResolvedValue(false);
    vi.mocked(playersApi.customizations).mockResolvedValue({
      groups: [{ id: "filmic-archive", name: "Filmic Archive", count: 1 }],
      rows: [{ itemId: "MTX_Fremen_FedaykinArmor_SetVariant", name: "Aegis of an Unwalked Path Armor", groupId: "filmic-archive", group: "Filmic Archive", status: "Available", requiredDlc: "Filmic Archive", image: "/images/items/MTX_Fremen_FedaykinArmor_SetVariant.png" }],
      capabilities: { customizationOwnership: false, customizationPending: true }
    });
    render(<CustomizationsTab dbPlayerId="123" playerName="Chani" confirmAction={confirmAction} />);

    fireEvent.click(await screen.findByRole("button", { name: "Grant Set" }));
    expect(confirmAction).toHaveBeenCalledWith(expect.stringMatching(/must own Filmic Archive/i), expect.objectContaining({
      details: expect.arrayContaining([expect.objectContaining({ label: "Requires", value: "Filmic Archive" })])
    }));
  });

  it("labels Dune Man as Lost Harvest content and does not claim ownership", async () => {
    const confirmAction = vi.fn().mockResolvedValue(true);
    vi.mocked(playersApi.grantCustomizations).mockResolvedValue({
      ok: true,
      delivered: 1,
      granted: 1,
      requested: 0,
      skipped: 0,
      failed: 0,
      ownershipVerified: false,
      results: [{ itemId: "MTX_B1C2_DuneManCoverallsSetVariant_Top", status: "Delivered", ok: true, inventoryVerified: true, ownershipVerified: false }]
    });
    render(<CustomizationsTab dbPlayerId="123" playerName="Chani" confirmAction={confirmAction} />);

    fireEvent.click((await screen.findAllByRole("button", { name: "Grant Set" }))[1]);
    expect(confirmAction).toHaveBeenCalledWith(expect.stringMatching(/must own Lost Harvest.*does not grant DLC ownership/is), expect.anything());
    expect(await screen.findByText(/persistent ownership requires the player's account entitlement/i)).toBeInTheDocument();
    expect(screen.getAllByText("Delivered")).toHaveLength(2);
  });
});
