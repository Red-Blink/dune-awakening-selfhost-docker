import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { carePackageApi } from "../../api/carePackage";
import { playersApi } from "../../api/players";
import { setConsoleAccess } from "../../lib/consoleAccess";
import { CarePackagePanel } from "./CarePackagePanel";

vi.mock("../../api/carePackage", () => ({ carePackageApi: { config: vi.fn(), history: vi.fn() } }));
vi.mock("../../api/players", () => ({ playersApi: { listAll: vi.fn() } }));
const user = { username: "helper", displayName: "Helper", tier: "moderator" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(carePackageApi.config).mockResolvedValue({ enabled: true, kits: [{ id: "welcome", name: "Welcome", items: [], xp: 0 }], activeKitId: "welcome", autoGrantKitId: "welcome", items: [], xp: 0, autoGrantRules: [], grantWhen: "first_online" } as never);
  vi.mocked(carePackageApi.history).mockResolvedValue({ rows: [] });
});

it("shows only manual grants when package configuration is not granted", async () => {
  setConsoleAccess("ready", user, ["carepackage:read", "carepackage:grant"]);
  render(<CarePackagePanel onError={vi.fn()} confirmAction={vi.fn()} />);
  expect(await screen.findByRole("tab", { name: "Manual Grant" })).toHaveAttribute("aria-selected", "true");
  await screen.findByRole("button", { name: "Grant Package" });
  expect(screen.queryByRole("tab", { name: "Auto Grant" })).toBeNull();
  expect(screen.queryByText("Care Package Configuration")).toBeNull();
  expect(playersApi.listAll).not.toHaveBeenCalled();
});

it("keeps grant history readable while hiding configuration and grant controls", async () => {
  setConsoleAccess("ready", user, ["carepackage:read"]);
  render(<CarePackagePanel onError={vi.fn()} confirmAction={vi.fn()} />);
  await waitFor(() => expect(carePackageApi.history).toHaveBeenCalled());
  expect(screen.getByRole("heading", { name: "Grant History" })).toBeVisible();
  expect(screen.queryByRole("tab", { name: /Grant/ })).toBeNull();
  expect(screen.queryByText("Care Package Configuration")).toBeNull();
  expect(playersApi.listAll).not.toHaveBeenCalled();
});
