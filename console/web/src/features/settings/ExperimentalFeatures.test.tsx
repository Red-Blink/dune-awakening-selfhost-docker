import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { ExperimentalFeatures } from "./ExperimentalFeatures";
import { friendlyVehicleName, friendlyVehicleTemplateName } from "../players/playerAdminUtils";
import { api, post } from "../../api/client";
import { setupApi, type Task } from "../../api/setup";

vi.mock("../../api/client", () => ({ api: vi.fn(), post: vi.fn() }));
vi.mock("../../api/setup", () => ({ setupApi: { task: vi.fn() } }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api).mockResolvedValue({ enabled: false, supported: true, applying: false, error: "", build: "2134304-0-shipping" });
});

test("shows an image card when off, with an explicit Hagga-only restart confirmation", async () => {
  const confirm = vi.fn().mockResolvedValue(true);
  vi.mocked(post).mockResolvedValue({ task: { id: "1", status: "running", logLines: [] } });
  render(<ExperimentalFeatures confirmAction={confirm} />);
  expect(screen.getByRole("img", { name: "Regis Tanks in the desert" })).toHaveAttribute("src", "/images/features/regis-tank.jpg");
  await waitFor(() => expect(screen.getByRole("button", { name: "Enable Regis Tanks" })).toBeEnabled());
  expect(screen.getByRole("article")).toHaveClass("disabled");
  fireEvent.click(screen.getByRole("button", { name: "Enable Regis Tanks" }));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/api/settings/experimental-tanks", { enabled: true, confirmRestart: true }));
  expect(confirm.mock.calls[0][0]).toContain("Other maps will not restart");
  expect(await screen.findByText("Applying Changes")).toHaveClass("loading-dots");
  expect(screen.getByRole("article").querySelector(".inline-task-result")).toBeNull();
  expect(screen.getAllByText("Applying Changes")).toHaveLength(1);
  expect(screen.queryByText("Applying Tank Settings…")).not.toBeInTheDocument();
  expect(screen.queryByText(/This can take several minutes/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Enabling..." })).toBeDisabled();
  expect(screen.getByRole("article")).toHaveClass("enabled");
});

test.each([true, false])("immediately shows the requested enabled=%s border and action while waiting for the response", async (enabled) => {
  vi.mocked(api).mockResolvedValue({ enabled: !enabled, supported: true, applying: false, error: "" });
  vi.mocked(post).mockReturnValue(new Promise(() => {}));
  render(<ExperimentalFeatures confirmAction={vi.fn().mockResolvedValue(true)} />);
  const button = await screen.findByRole("button", { name: enabled ? "Enable Regis Tanks" : "Disable Regis Tanks" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  const pending = await screen.findByText("Applying Changes");
  expect(pending).toHaveClass("loading-dots");
  expect(pending.closest(".experimental-feature-status")).toBeVisible();
  expect(screen.getByRole("article")).toHaveClass(enabled ? "enabled" : "disabled");
  expect(screen.getByRole("button", { name: enabled ? "Enabling..." : "Disabling..." })).toBeDisabled();
  expect(screen.getByRole("article").querySelector(".inline-task-result")).toBeNull();
  expect(screen.queryByText("Applying Tank Settings…")).not.toBeInTheDocument();
});

test.each([true, false])("switches the single status to the saved enabled=%s state after completion", async (enabled) => {
  const saved = { enabled, supported: true, applying: false, error: "", build: "2134304-0-shipping" };
  vi.mocked(api).mockResolvedValueOnce({ ...saved, enabled: !enabled }).mockResolvedValue(saved);
  const task: Task = { id: "apply", type: "settings", operation: "experimentalTanksApply", status: "running", currentStep: "Running", progressMessage: "", logLines: [], warnings: [], startedAt: "2026-10-04T20:30:00Z", finishedAt: null, errorMessage: null };
  vi.mocked(post).mockResolvedValue({ task });
  vi.mocked(setupApi.task).mockResolvedValue({ task: { ...task, status: "succeeded" } });
  render(<ExperimentalFeatures confirmAction={vi.fn().mockResolvedValue(true)} />);
  const button = await screen.findByRole("button", { name: enabled ? "Enable Regis Tanks" : "Disable Regis Tanks" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  expect(await screen.findByText("Applying Changes")).toHaveClass("loading-dots");
  expect(await screen.findByText(enabled ? "Enabled" : "Disabled", {}, { timeout: 5000 })).toBeVisible();
  expect(screen.queryByText("Applying Changes")).not.toBeInTheDocument();
  expect(screen.queryByText("Tank Settings Applied")).not.toBeInTheDocument();
  expect(screen.getByRole("article").querySelector(".inline-task-result")).toBeNull();
});

test("unsupported builds cannot be enabled but can be disabled", async () => {
  vi.mocked(api).mockResolvedValue({ enabled: false, supported: false, applying: false, error: "" });
  render(<ExperimentalFeatures confirmAction={vi.fn()} />);
  expect(await screen.findByText(/This game build is not supported/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Enable Regis Tanks" })).toBeDisabled();
});

test("restores the saved border when the apply request fails", async () => {
  vi.mocked(post).mockRejectedValue(new Error("Unable to start the operation."));
  render(<ExperimentalFeatures confirmAction={vi.fn().mockResolvedValue(true)} />);
  const button = await screen.findByRole("button", { name: "Enable Regis Tanks" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  expect(await screen.findByRole("alert")).toHaveTextContent("Unable to start the operation.");
  expect(screen.getByRole("article")).toHaveClass("disabled");
  expect(screen.getByRole("status")).toHaveTextContent("Disabled");
});

test("canceling confirmation makes no changes", async () => {
  render(<ExperimentalFeatures confirmAction={vi.fn().mockResolvedValue(false)} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Enable Regis Tanks" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Enable Regis Tanks" }));
  await waitFor(() => expect(post).not.toHaveBeenCalled());
});

test("keeps a queued disable visible and polls until the countdown is cancelled", async () => {
  const saved = { enabled: true, supported: true, applying: false, error: "" };
  vi.mocked(api).mockResolvedValue(saved);
  vi.mocked(post).mockResolvedValue({ queued: true, entryId: "tank-countdown" });
  render(<ExperimentalFeatures confirmAction={vi.fn().mockResolvedValue(true)} />);
  fireEvent.click(await screen.findByRole("button", { name: "Disable Regis Tanks" }));
  expect(await screen.findByText("Restart Queued")).toBeVisible();
  expect(screen.getByRole("button", { name: "Disabling..." })).toBeDisabled();
  expect(await screen.findByRole("button", { name: "Disable Regis Tanks" }, { timeout: 5000 })).toBeEnabled();
  expect(api).toHaveBeenCalledWith("/api/settings/experimental-tanks");
});

test("restores a queued disable when the settings page is opened again", async () => {
  vi.mocked(api).mockResolvedValue({ enabled: true, supported: true, applying: false,
    error: "", queuedEntryId: "tank-countdown", queuedEnabled: false });
  render(<ExperimentalFeatures confirmAction={vi.fn()} />);
  expect(await screen.findByText("Restart Queued")).toBeVisible();
  expect(screen.getByRole("button", { name: "Disabling..." })).toBeDisabled();
  expect(screen.getByRole("article")).toHaveClass("disabled");
});

test("follows a queued disable into the applying state and then the saved policy", async () => {
  let applying = false;
  let enabled = true;
  vi.mocked(api).mockImplementation(async () => ({ enabled, supported: true, applying, error: "" }));
  vi.mocked(post).mockResolvedValue({ queued: true, entryId: "tank-countdown" });
  render(<ExperimentalFeatures confirmAction={vi.fn().mockResolvedValue(true)} />);
  fireEvent.click(await screen.findByRole("button", { name: "Disable Regis Tanks" }));
  expect(await screen.findByText("Restart Queued")).toBeVisible();
  applying = true;
  enabled = false;
  expect(await screen.findByText("Applying Changes", {}, { timeout: 5000 })).toBeVisible();
  applying = false;
  expect(await screen.findByText("Disabled", {}, { timeout: 5000 })).toBeVisible();
});

test("all six Tank presets describe the actual utility and weapon, without changing stock template names", () => {
  expect(friendlyVehicleName("Tank")).toBe("Regis Tank");
  const templates = ["T0", "T6_CombatDart", "T6_CombatFire", "T6_DartInventory", "T6_RocketInventory", "T6_FireInventory"];
  expect(templates.map((template) => friendlyVehicleTemplateName(template, "Tank"))).toEqual([
    "Tier 6 Booster Dart", "Tier 6 Booster Rocket", "Tier 6 Booster Flame",
    "Tier 6 Inventory Dart", "Tier 6 Inventory Rocket", "Tier 6 Inventory Flame"
  ]);
  expect(friendlyVehicleTemplateName("T0", "Sandbike")).toBe("Tier 0 Standard");
});

test("keeps the experimental explanation behind the standard info icon", async () => {
  render(<ExperimentalFeatures confirmAction={vi.fn()} />);
  expect(screen.queryByText(/Enable six Tier 6 Tank presets/)).not.toBeInTheDocument();
  const help = screen.getByRole("button", { name: "About Regis Tanks" });
  expect(help).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(help);
  expect(help).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("tooltip")).toHaveTextContent("Disable before updating the game server");
});

test("enabled cards have a green-state class and offer disabling even on unsupported builds", async () => {
  vi.mocked(api).mockResolvedValue({ enabled: true, supported: false, applying: false, error: "" });
  const confirm = vi.fn().mockResolvedValue(false);
  render(<ExperimentalFeatures confirmAction={confirm} />);
  const button = await screen.findByRole("button", { name: "Disable Regis Tanks" });
  expect(button).toBeEnabled();
  expect(screen.getByRole("article")).toHaveClass("enabled");
  fireEvent.click(button);
  await waitFor(() => expect(confirm).toHaveBeenCalled());
  expect(confirm.mock.calls[0][0]).toContain("Disable Regis Tanks");
  expect(confirm.mock.calls[0][0]).toContain("All Tanks in Hagga Basin will be deleted.");
  expect(confirm.mock.calls[0][0]).not.toContain("preserved");
});

test("prevents another apply while the server reports an operation in progress", async () => {
  vi.mocked(api).mockResolvedValue({ enabled: true, supported: true, applying: true, error: "" });
  render(<ExperimentalFeatures confirmAction={vi.fn()} />);
  expect(await screen.findByRole("button", { name: "Enabling..." })).toBeDisabled();
  expect(screen.getByText("Applying Changes").closest(".experimental-feature-status")).toBeVisible();
});
