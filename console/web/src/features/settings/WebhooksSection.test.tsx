import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { WebhooksSection } from "./WebhooksSection";

vi.mock("../../api/client", () => ({ api: vi.fn(), post: vi.fn() }));

import { api, post } from "../../api/client";

const mockedApi = vi.mocked(api);
const mockedPost = vi.mocked(post);

function settings(webhooks: unknown[] = []) {
  return { updateCheckMinutes: 60, webhooks, limits: { maxWebhooks: 5, updateCheckMinutes: { min: 30, max: 1440 } } };
}

const saved = {
  id: "hook-1", name: "Ops", type: "discord", enabled: true, events: ["serverRestart", "gameUpdate", "consoleUpdate"],
  includeMapRestarts: false, hasUrl: true, urlHint: "discord.com/…abcd", lastDelivery: null
};

beforeEach(() => {
  vi.resetAllMocks();
});

test("adds a webhook and saves it with its URL", async () => {
  mockedApi.mockResolvedValue(settings());
  mockedPost.mockResolvedValue(settings([saved]));
  render(<WebhooksSection />);
  expect(await screen.findByText(/No webhooks configured/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Add Webhook" }));
  fireEvent.change(screen.getByLabelText("Webhook URL"), { target: { value: "https://discord.com/api/webhooks/1/abcd" } });
  fireEvent.click(screen.getByRole("button", { name: "Save Webhooks" }));
  await waitFor(() => expect(mockedPost).toHaveBeenCalledWith("/api/settings/webhooks", {
    updateCheckMinutes: 60,
    webhooks: [{ id: undefined, name: "Discord", type: "discord", enabled: true, events: ["serverRestart", "gameUpdate", "consoleUpdate"], includeMapRestarts: false, url: "https://discord.com/api/webhooks/1/abcd" }]
  }));
  expect(await screen.findByText("Webhook settings saved.")).toBeVisible();
  expect(screen.getByLabelText("Webhook URL")).toHaveAttribute("placeholder", expect.stringContaining("discord.com/…abcd"));
});

test("an unchanged saved webhook keeps its stored URL and can send a test", async () => {
  mockedApi.mockResolvedValue(settings([saved]));
  mockedPost.mockResolvedValue({ ok: true, status: 204, error: "" });
  render(<WebhooksSection />);
  fireEvent.click(await screen.findByRole("button", { name: "Send Test" }));
  await waitFor(() => expect(mockedPost).toHaveBeenCalledWith("/api/settings/webhooks/test", { id: "hook-1" }));
  expect(await screen.findByText("Test message sent.")).toBeVisible();

  fireEvent.click(screen.getByRole("checkbox", { name: "Game update available" }));
  expect(screen.getByRole("button", { name: "Send Test" })).toBeDisabled();
  mockedPost.mockResolvedValue(settings([{ ...saved, events: ["serverRestart", "consoleUpdate"] }]));
  fireEvent.click(screen.getByRole("button", { name: "Save Webhooks" }));
  await waitFor(() => expect(mockedPost).toHaveBeenLastCalledWith("/api/settings/webhooks", {
    updateCheckMinutes: 60,
    webhooks: [{ id: "hook-1", name: "Ops", type: "discord", enabled: true, events: ["serverRestart", "consoleUpdate"], includeMapRestarts: false }]
  }));
});

test("edits made while a test message is sending are kept", async () => {
  mockedApi.mockResolvedValue(settings([saved, { ...saved, id: "hook-2", name: "Second" }]));
  let finishTest: (value: unknown) => void = () => {};
  mockedPost.mockReturnValue(new Promise((done) => { finishTest = done; }));
  render(<WebhooksSection />);
  fireEvent.click((await screen.findAllByRole("button", { name: "Send Test" }))[0]);
  const urlInputs = screen.getAllByLabelText("Webhook URL");
  fireEvent.change(urlInputs[1], { target: { value: "https://discord.com/api/webhooks/2/typed" } });
  mockedApi.mockResolvedValue(settings([
    { ...saved, lastDelivery: { at: "2026-11-28T10:00:00Z", event: "test", ok: true, status: 204, error: "" } },
    { ...saved, id: "hook-2", name: "Second" }
  ]));
  finishTest({ ok: true, status: 204, error: "" });
  expect(await screen.findByText(/Last message delivered/)).toBeVisible();
  expect(screen.getAllByLabelText("Webhook URL")[1]).toHaveValue("https://discord.com/api/webhooks/2/typed");
  expect(screen.getByRole("button", { name: "Save Webhooks" })).toBeEnabled();
});
