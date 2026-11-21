import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
