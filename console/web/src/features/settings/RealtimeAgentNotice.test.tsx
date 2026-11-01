import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RealtimeAgentNotice } from "./RealtimeAgentNotice";

vi.mock("../../api/client", () => ({ api: vi.fn(), post: vi.fn() }));

import { api, post } from "../../api/client";

const mockedApi = vi.mocked(api);
const mockedPost = vi.mocked(post);

function status(over: Record<string, unknown> = {}) {
  return { available: true, installed: false, running: false, state: "", reachable: false, reason: "not-running", busy: null, ...over };
}

afterEach(() => vi.useRealTimers());

beforeEach(() => {
  vi.resetAllMocks();
  mockedApi.mockResolvedValue(status());
});

test("says nothing while no key needs Realtime Data and no agent is installed", async () => {
  const { container } = render(<RealtimeAgentNotice needed={false} confirmAction={vi.fn()} />);
  await waitFor(() => expect(mockedApi).toHaveBeenCalled());
  expect(container).toBeEmptyDOMElement();
});

test("says nothing when the installation has no agent setup", async () => {
  mockedApi.mockResolvedValue(status({ available: false }));
  const { container } = render(<RealtimeAgentNotice needed confirmAction={vi.fn()} />);
  await waitFor(() => expect(mockedApi).toHaveBeenCalled());
  expect(container).toBeEmptyDOMElement();
});

test("says nothing when the agent answers", async () => {
  mockedApi.mockResolvedValue(status({ installed: true, running: true, reachable: true, reason: "" }));
  const { container } = render(<RealtimeAgentNotice needed confirmAction={vi.fn()} />);
  await waitFor(() => expect(mockedApi).toHaveBeenCalled());
  expect(container).toBeEmptyDOMElement();
});

test("a missing agent is announced and nothing is installed before the owner confirms", async () => {
  const confirmAction = vi.fn().mockResolvedValue(false);
  render(<RealtimeAgentNotice needed confirmAction={confirmAction} />);
  expect(await screen.findByText(/position agent is not installed/i)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Set Up Agent" }));
  await waitFor(() => expect(confirmAction).toHaveBeenCalled());
  expect(confirmAction.mock.calls[0][0]).toMatch(/runs as root/i);
  expect(confirmAction.mock.calls[0][0]).toMatch(/ptrace/i);
  expect(mockedPost).not.toHaveBeenCalled();
});

test("a confirmed setup posts once and shows the result", async () => {
  const confirmAction = vi.fn().mockResolvedValue(true);
  mockedPost.mockResolvedValue(status({ installed: true, running: true, reachable: true, reason: "" }));
  render(<RealtimeAgentNotice needed confirmAction={confirmAction} />);
  fireEvent.click(await screen.findByRole("button", { name: "Set Up Agent" }));
  await waitFor(() => expect(mockedPost).toHaveBeenCalledWith("/api/settings/realtime-agent", { enabled: true, confirmed: true }));
  expect(await screen.findByText(/agent is set up/i)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Set Up Agent" })).toBeNull();
});

test("a failed setup is reported and the button stays usable", async () => {
  mockedPost.mockRejectedValue(new Error("The Realtime Data agent could not be set up."));
  render(<RealtimeAgentNotice needed confirmAction={vi.fn().mockResolvedValue(true)} />);
  fireEvent.click(await screen.findByRole("button", { name: "Set Up Agent" }));
  expect(await screen.findByText(/could not be set up/i)).toBeVisible();
  expect(screen.getByRole("button", { name: "Set Up Agent" })).not.toBeDisabled();
});

test("a bad agent address is reported instead of offering a setup", async () => {
  mockedApi.mockResolvedValue(status({ reason: "misconfigured" }));
  render(<RealtimeAgentNotice needed confirmAction={vi.fn()} />);
  expect(await screen.findByText(/DUNE_REALTIME_AGENT_URL is not usable/i)).toBeVisible();
  expect(screen.queryByRole("button", { name: /set up agent/i })).toBeNull();
});

test("once no key needs Realtime Data the installed agent can be removed", async () => {
  mockedApi.mockResolvedValue(status({ installed: true, running: true, reachable: true, reason: "" }));
  mockedPost.mockResolvedValue(status());
  const confirmAction = vi.fn().mockResolvedValue(true);
  render(<RealtimeAgentNotice needed={false} confirmAction={confirmAction} />);
  expect(await screen.findByText(/No API key uses Realtime Data any more/i)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Remove Agent" }));
  await waitFor(() => expect(mockedPost).toHaveBeenCalledWith("/api/settings/realtime-agent", { enabled: false }));
  expect(await screen.findByText(/agent was removed/i)).toBeVisible();
});

test("a setup that leaves the agent not running is not reported as successful", async () => {
  mockedPost.mockResolvedValue(status({ installed: true, running: false, state: "exited", reachable: false, reason: "not-running" }));
  render(<RealtimeAgentNotice needed confirmAction={vi.fn().mockResolvedValue(true)} />);
  fireEvent.click(await screen.findByRole("button", { name: "Set Up Agent" }));
  expect(await screen.findByText(/set up but is not running/i)).toBeVisible();
  expect(screen.queryByText(/set up and answering/i)).toBeNull();
  expect(await screen.findByRole("button", { name: "Rebuild Agent" })).not.toBeDisabled();
});

test("a started agent that does not answer yet is reported as such", async () => {
  mockedPost.mockResolvedValue(status({ installed: true, running: true, state: "running", reachable: false }));
  render(<RealtimeAgentNotice needed confirmAction={vi.fn().mockResolvedValue(true)} />);
  fireEvent.click(await screen.findByRole("button", { name: "Set Up Agent" }));
  expect(await screen.findByText(/started but is not answering yet/i)).toBeVisible();
});

test("opening the page during a setup shows progress, keeps checking and reports the end", async () => {
  vi.useFakeTimers();
  mockedApi
    .mockResolvedValueOnce(status({ busy: "install" }))
    .mockResolvedValueOnce(status({ busy: "install" }))
    .mockResolvedValue(status({ installed: true, running: true, reachable: true, reason: "", busy: null }));
  render(<RealtimeAgentNotice needed confirmAction={vi.fn()} />);
  await act(async () => {});
  expect(screen.getByRole("button", { name: /Setting Up/ })).toBeDisabled();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(screen.getByRole("button", { name: /Setting Up/ })).toBeDisabled();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(screen.getByText(/set up and answering/i)).toBeVisible();
  const calls = mockedApi.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(mockedApi.mock.calls.length).toBe(calls); // polling stopped once the server was idle
});

test("a lost response keeps the page checking until the server is done", async () => {
  vi.useFakeTimers();
  mockedApi
    .mockResolvedValueOnce(status())
    .mockResolvedValueOnce(status({ busy: "install" }))
    .mockResolvedValue(status({ installed: true, running: true, reachable: true, reason: "", busy: null }));
  mockedPost.mockRejectedValue(new Error("Bad Gateway"));
  render(<RealtimeAgentNotice needed confirmAction={vi.fn().mockResolvedValue(true)} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Set Up Agent" }));
  await act(async () => {});
  expect(screen.getByText(/still running on the server/i)).toBeVisible();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(screen.getByText(/set up and answering/i)).toBeVisible();
});

test("polling stops when the page is left", async () => {
  vi.useFakeTimers();
  mockedApi.mockResolvedValue(status({ busy: "install" }));
  const { unmount } = render(<RealtimeAgentNotice needed confirmAction={vi.fn()} />);
  await act(async () => {});
  unmount();
  const calls = mockedApi.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(mockedApi.mock.calls.length).toBe(calls);
});
