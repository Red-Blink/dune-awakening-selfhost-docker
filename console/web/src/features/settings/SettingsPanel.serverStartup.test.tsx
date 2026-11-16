import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { SettingsPanel } from "./SettingsPanel";

vi.mock("../../api/client", () => ({ api: vi.fn(), post: vi.fn() }));

import { api, post } from "../../api/client";

const mockedApi = vi.mocked(api);
const mockedPost = vi.mocked(post);

function settings(autoStartBattlegroup: boolean) {
  return {
    config: { port: 8088 },
    files: {},
    publicDirectory: { available: false, anonymousCountEnabled: true },
    serverStartup: {
      settings: { autoStartBattlegroup },
      defaults: { autoStartBattlegroup: true },
      source: "console"
    }
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.mockResolvedValue(settings(true));
});

test("groups Discord controls and keeps password two-factor protection in Account Security", async () => {
  mockedApi.mockResolvedValue({ ...settings(true), config: { port: 8088, consoleTotpEnabled: true } });
  render(<SettingsPanel onPasswordChanged={vi.fn()} onTotpEnrollmentStarted={vi.fn()} confirmAction={vi.fn()} />);
  const discord = await screen.findByRole("region", { name: "Discord" });
  expect(within(discord).getByRole("button", { name: "Expand Discord Sign In" })).toBeVisible();
  // Hosted-bot management belongs to the stacked #215 implementation.
  expect(within(discord).queryByRole("button", { name: "Expand Server Bot" })).toBeNull();
  const security = screen.getByRole("region", { name: "Account Security" });
  expect(await within(security).findByRole("button", { name: "Expand Two Factor Authentication" })).toBeVisible();
  expect(within(security).getByText("Off")).toBeVisible();
  expect(within(discord).queryByText("Two Factor Authentication")).toBeNull();
});

test("keeps the requested Settings section order", async () => {
  const { container } = render(<SettingsPanel onPasswordChanged={vi.fn()} onTotpEnrollmentStarted={vi.fn()} confirmAction={vi.fn()} />);
  await screen.findByRole("button", { name: "Expand Server Startup" });
  const stack = container.querySelector(".settings-section-stack")!;
  expect([...stack.querySelectorAll("h4")].slice(0, 2).map(node => node.textContent)).toEqual(["Files Checklist", "Runtime Configuration"]);
  expect(stack.firstElementChild).toContainElement(screen.getByRole("heading", { name: "Files Checklist" }));
  const titles = [...stack.children].map(node => node.querySelector("h3, .playerAdmin_toggleHeader")?.textContent).filter(Boolean);
  expect(titles.slice(0, 7)).toEqual(["Account Security", "Discord", "Server Startup", "Web Console Port", "API Keys", "Encrypted API Access", "Experimental Features"]);
});

test("shows the saved automatic Battlegroup startup choice", async () => {
  render(<SettingsPanel onPasswordChanged={vi.fn()} onTotpEnrollmentStarted={vi.fn()} confirmAction={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Expand Server Startup" }));
  expect(screen.getByText("Start Battlegroup Automatically")).toBeVisible();
  expect(screen.getByRole("checkbox", { name: /automatic startup/i })).toBeChecked();
  expect(screen.getByText(/Battlegroup remains stopped after the Linux host boots/i)).toBeVisible();
});

test("persists the choice immediately and leaves the Console available", async () => {
  mockedPost.mockResolvedValue({ ok: true, ...settings(false).serverStartup });
  render(<SettingsPanel onPasswordChanged={vi.fn()} onTotpEnrollmentStarted={vi.fn()} confirmAction={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Expand Server Startup" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /automatic startup/i }));

  await waitFor(() => expect(mockedPost).toHaveBeenCalledWith("/api/settings/server-startup", { autoStartBattlegroup: false }));
  expect(await screen.findByText(/Server Startup Saved/)).toBeVisible();
  expect(screen.getByText(/Console will start after the Linux host boots/i)).toBeVisible();
  expect(screen.getByRole("checkbox", { name: /automatic startup/i })).not.toBeChecked();
});

test("keeps the previous choice when saving fails", async () => {
  mockedPost.mockRejectedValue(new Error("Could not save the setting."));
  render(<SettingsPanel onPasswordChanged={vi.fn()} onTotpEnrollmentStarted={vi.fn()} confirmAction={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Expand Server Startup" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /automatic startup/i }));

  expect(await screen.findByText(/Server Startup Save Failed/)).toBeVisible();
  expect(screen.getByText("Could not save the setting.")).toBeVisible();
  expect(screen.getByRole("checkbox", { name: /automatic startup/i })).toBeChecked();
});
