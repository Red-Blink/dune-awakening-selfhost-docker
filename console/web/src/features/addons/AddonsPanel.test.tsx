import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addonsApi, type CommunityAddonSummary, type InstalledAddon } from "../../api/addons";
import { AddonsPanel } from "./AddonsPanel";
import { addonUpdateAvailable, hasAddonUpdates } from "./addonVersions";
import "../../styles.css";

vi.mock("../../api/addons", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/addons")>();
  return {
    ...actual,
    addonsApi: {
      community: vi.fn(),
      installed: vi.fn(),
      installCommunity: vi.fn(),
      updateCommunity: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
      remove: vi.fn(),
      bridge: vi.fn()
    }
  };
});

const catalogAddon: CommunityAddonSummary = {
  id: "eda-exchange-bot",
  name: "EDA Exchange Bot",
  description: "Automated exchange deliveries.",
  author: "Atobo",
  version: "0.11.0",
  sourceUrl: "https://github.com/example/eda-exchange-bot",
  manifestUrl: "https://example.test/eda-exchange-bot.json",
  lifecycle: "active",
  lifecycleMessage: "",
  lifecycleUrl: "",
  permissions: ["database:read", "database:write", "scheduler:server"],
  provenance: {}
};

const installedAddon: InstalledAddon = {
  id: catalogAddon.id,
  name: catalogAddon.name,
  description: catalogAddon.description,
  author: catalogAddon.author,
  version: "0.9.2",
  type: "ui",
  status: "Enabled",
  enabled: true,
  lifecycle: "active",
  lifecycleMessage: "",
  lifecycleUrl: "",
  entryPath: "web/index.html",
  permissions: ["database:read", "database:write"],
  approvedPermissions: ["database:read", "database:write"],
  provenance: {}
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(addonsApi.community).mockResolvedValue({ schemaVersion: 1, sourceUrl: "https://example.test/index.json", updatedAt: "", addons: [catalogAddon] });
  vi.mocked(addonsApi.installed).mockResolvedValue({ addons: [installedAddon] });
  vi.mocked(addonsApi.updateCommunity).mockResolvedValue({
    ok: true,
    addon: { ...installedAddon, version: catalogAddon.version, permissions: catalogAddon.permissions, approvedPermissions: catalogAddon.permissions },
    sha256: "a".repeat(64),
    previousVersion: installedAddon.version,
    preservedConfiguration: true
  });
});

it("explains companion and database removal before uninstalling Airdrop", async () => {
  const notice = "This stops the companion and deletes its reward queues and database triggers.";
  vi.mocked(addonsApi.installed).mockResolvedValue({ addons: [{ ...installedAddon, uninstallNotice: notice }] });
  const confirmAction = vi.fn().mockResolvedValue(false);
  render(<AddonsPanel pinnedAddons={[]} setPinnedAddons={vi.fn()} selectedAddonId=""
    clearSelectedAddon={vi.fn()} setAddonUpdateAvailable={vi.fn()} confirmAction={confirmAction} />);
  fireEvent.click(await screen.findByRole("button", { name: "Uninstall" }));
  expect(confirmAction).toHaveBeenCalledWith(expect.stringContaining(notice), { danger: true, confirmLabel: "Uninstall" });
  expect(addonsApi.remove).not.toHaveBeenCalled();
});

it("reports failed cleanup and keeps the addon visible and disabled for retry", async () => {
  vi.mocked(addonsApi.remove).mockRejectedValue(new Error("Companion cleanup failed. Retry Uninstall."));
  vi.mocked(addonsApi.installed).mockResolvedValueOnce({ addons: [installedAddon] })
    .mockResolvedValue({ addons: [{ ...installedAddon, enabled: false, status: "Disabled" }] });
  render(<AddonsPanel pinnedAddons={[]} setPinnedAddons={vi.fn()} selectedAddonId=""
    clearSelectedAddon={vi.fn()} setAddonUpdateAvailable={vi.fn()} confirmAction={vi.fn().mockResolvedValue(true)} />);
  fireEvent.click(await screen.findByRole("button", { name: "Uninstall" }));
  expect(await screen.findByText(/^Uninstall Failed\./)).toBeInTheDocument();
  expect(screen.getByText("Companion cleanup failed. Retry Uninstall.")).toBeInTheDocument();
  expect(screen.getByText("Disabled")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Uninstall" })).toBeEnabled();
  expect(screen.queryByText(/^Addon Uninstalled/)).not.toBeInTheDocument();
});

describe("AddonsPanel updates", () => {
  it("only bridges messages from the active sandboxed addon frame", async () => {
    vi.mocked(addonsApi.bridge).mockResolvedValue({ ok: true, result: {} });
    // Finish the asynchronous addon load and its message-listener effect before
    // sending an event. Seeing the iframe alone does not flush passive effects.
    await act(async () => {
      render(<AddonsPanel pinnedAddons={[]} setPinnedAddons={vi.fn()} selectedAddonId={installedAddon.id} clearSelectedAddon={vi.fn()} setAddonUpdateAvailable={vi.fn()} confirmAction={vi.fn().mockResolvedValue(true)} />);
    });
    const frame = await screen.findByTitle(installedAddon.name) as HTMLIFrameElement;
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    const data = { type: "dune-addon-request", addonId: installedAddon.id, requestId: "test-request", action: "leadership.players.list", payload: {} };
    window.dispatchEvent(new MessageEvent("message", { data, origin: window.location.origin, source: window }));
    expect(addonsApi.bridge).not.toHaveBeenCalled();
    window.dispatchEvent(new MessageEvent("message", { data, origin: "null", source: frame.contentWindow }));
    await waitFor(() => expect(addonsApi.bridge).toHaveBeenCalledWith(installedAddon.id, data.action, {}));
  });
  it("keeps multiple permission labels contained beside addon status", async () => {
    render(<AddonsPanel
      pinnedAddons={[]}
      setPinnedAddons={vi.fn()}
      selectedAddonId=""
      clearSelectedAddon={vi.fn()}
      setAddonUpdateAvailable={vi.fn()}
      confirmAction={vi.fn().mockResolvedValue(true)}
    />);

    const permission = await screen.findByText("Database Read & Write");
    const cell = permission.closest("td");
    expect(cell).toHaveClass("addon-permissions-cell");
    expect(getComputedStyle(cell as HTMLElement).overflow).toBe("hidden");
    expect(getComputedStyle(permission).whiteSpace).toBe("normal");
    expect(getComputedStyle(permission).overflowWrap).toBe("anywhere");
    expect(screen.getByText("Scheduler Server")).toBeInTheDocument();
    expect(screen.getByText("Enabled").closest("td")).not.toBe(cell);
  });

  it("detects newer semantic versions but not equal, older, or malformed versions", () => {
    expect(addonUpdateAvailable("0.9.2", "0.11.0")).toBe(true);
    expect(addonUpdateAvailable("1.0.0-rc.2", "1.0.0")).toBe(true);
    expect(addonUpdateAvailable("1.0.0", "1.0.0")).toBe(false);
    expect(addonUpdateAvailable("1.1.0", "1.0.0")).toBe(false);
    expect(addonUpdateAvailable("old", "new")).toBe(false);
  });

  it("shows an update action and requires approval for newly requested permissions", async () => {
    const confirmAction = vi.fn().mockResolvedValue(true);
    render(<AddonsPanel
      pinnedAddons={[]}
      setPinnedAddons={vi.fn()}
      selectedAddonId=""
      clearSelectedAddon={vi.fn()}
      setAddonUpdateAvailable={vi.fn()}
      confirmAction={confirmAction}
    />);

    expect(await screen.findByLabelText("Update available: 0.9.2 to 0.11.0")).toBeInTheDocument();
    expect(screen.getByText("0.9.2")).toBeInTheDocument();
    expect(screen.getByText("0.11.0")).toBeInTheDocument();
    expect(screen.getByText("Database Read & Write")).toBeInTheDocument();
    expect(screen.queryByText("Database Read")).not.toBeInTheDocument();
    expect(screen.queryByText("Database Write")).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Description" })).not.toBeInTheDocument();
    const updateButton = screen.getByRole("button", { name: "Update" });
    const actionGroup = updateButton.closest(".service-actions");
    expect(actionGroup).not.toBeNull();
    expect(within(actionGroup as HTMLElement).getByRole("button", { name: "Open" })).toBeInTheDocument();
    expect(within(actionGroup as HTMLElement).getByRole("button", { name: "Uninstall" })).toBeInTheDocument();
    fireEvent.click(updateButton);

    await waitFor(() => expect(confirmAction).toHaveBeenCalledOnce());
    expect(confirmAction.mock.calls[0][0]).toMatch(/additional access: scheduler server/i);
    expect(confirmAction.mock.calls[0][0]).toMatch(/settings, schedules, enabled state, and browser preferences will be preserved/i);
    await waitFor(() => expect(addonsApi.updateCommunity).toHaveBeenCalledWith(catalogAddon.id, catalogAddon.permissions));
    expect(await screen.findByText(/Existing configuration was preserved/)).toBeInTheDocument();
  });

  it("does not offer an update when installed and catalog versions match", async () => {
    vi.mocked(addonsApi.installed).mockResolvedValue({ addons: [{ ...installedAddon, version: catalogAddon.version }] });
    render(<AddonsPanel
      pinnedAddons={[]}
      setPinnedAddons={vi.fn()}
      selectedAddonId=""
      clearSelectedAddon={vi.fn()}
      setAddonUpdateAvailable={vi.fn()}
      confirmAction={vi.fn().mockResolvedValue(true)}
    />);

    await screen.findByText(catalogAddon.name);
    expect(screen.queryByLabelText(/Update available:/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
  });

  it("does not display addons flagged as removed", async () => {
    const removedAddon = { ...catalogAddon, lifecycle: "removed" as const };
    vi.mocked(addonsApi.community).mockResolvedValue({ schemaVersion: 1, sourceUrl: "https://example.test/index.json", updatedAt: "", addons: [removedAddon] });
    vi.mocked(addonsApi.installed).mockResolvedValue({ addons: [] });
    render(<AddonsPanel
      pinnedAddons={[]}
      setPinnedAddons={vi.fn()}
      selectedAddonId=""
      clearSelectedAddon={vi.fn()}
      setAddonUpdateAvailable={vi.fn()}
      confirmAction={vi.fn().mockResolvedValue(true)}
    />);

    await waitFor(() => expect(addonsApi.community).toHaveBeenCalledOnce());
    expect(screen.queryByText(removedAddon.name)).not.toBeInTheDocument();
    expect(screen.queryByText(/Removed:/)).not.toBeInTheDocument();
  });

  it("reports whether any installed addon has a catalog update", () => {
    expect(hasAddonUpdates([catalogAddon], [installedAddon])).toBe(true);
    expect(hasAddonUpdates([{ ...catalogAddon, lifecycle: "removed" }], [installedAddon])).toBe(false);
    expect(hasAddonUpdates([catalogAddon], [{ ...installedAddon, version: catalogAddon.version }])).toBe(false);
    expect(hasAddonUpdates([catalogAddon], [])).toBe(false);
  });
});
