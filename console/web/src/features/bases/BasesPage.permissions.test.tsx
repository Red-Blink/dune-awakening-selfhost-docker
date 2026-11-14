import { render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { setConsoleAccess } from "../../lib/consoleAccess";
import { BasesPage } from "./BasesPage";

vi.mock("./BasesPanel", () => ({ BasesPanel: ({ viewSwitch }: { viewSwitch?: ReactNode }) => <><h2>Live Bases Fixture</h2>{viewSwitch}</> }));
vi.mock("./BaseBackupsView", () => ({ BaseBackupsView: ({ viewSwitch }: { viewSwitch?: ReactNode }) => <><h2>Backup Bases Fixture</h2>{viewSwitch}</> }));
const user = { username: "viewer", displayName: "Viewer", tier: "moderator" };
const props = { onError: vi.fn(), confirmAction: vi.fn(), restartGate: vi.fn(), formatMutationResult: vi.fn() } as ComponentProps<typeof BasesPage>;
afterEach(() => sessionStorage.removeItem("bases_view"));

it("opens the permitted backup component without mounting the live bases component", () => {
  setConsoleAccess("ready", user, ["blueprints:read"]);
  render(<BasesPage {...props} />);
  expect(screen.getByRole("heading", { name: "Backup Bases Fixture" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Live Bases Fixture" })).toBeNull();
  expect(screen.queryByText("Bases", { exact: true })).toBeNull();
});

it("does not restore a forbidden saved backup view for a live-bases reader", () => {
  sessionStorage.setItem("bases_view", "backups");
  setConsoleAccess("ready", user, ["bases:read"]);
  render(<BasesPage {...props} />);
  expect(screen.getByRole("heading", { name: "Live Bases Fixture" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Backup Bases Fixture" })).toBeNull();
  expect(screen.queryByText("Base Backups", { exact: true })).toBeNull();
});
