import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, post } from "../../api/client";
import { HttpsSetup } from "./HttpsSetup";

vi.mock("../../api/client", () => ({ api: vi.fn(), post: vi.fn() }));
const initial = {
  providers: [
    { provider: "cloudflare", label: "Cloudflare Tunnel", hostInstalled: false, hostDetection: "checked", containers: [] },
    { provider: "tailscale", label: "Tailscale", hostInstalled: true, hostDetection: "checked", containers: [{ name: "my-vpn", running: true }] },
    { provider: "ngrok", label: "ngrok", hostInstalled: false, hostDetection: "checked", containers: [] }
  ], provider: "", enabled: false, busy: false, phase: "", error: "", target: "http://192.0.2.40:9099", running: false, url: "", approvalUrl: "", verified: false
};
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api).mockResolvedValue(initial); vi.mocked(post).mockResolvedValue({ accepted: true }); });
afterEach(() => { vi.useRealTimers(); });

describe("HTTPS setup", () => {
  it("does not inspect installations until expanded and uses the actual listener address", async () => {
    render(<HttpsSetup />);
    expect(api).not.toHaveBeenCalled();
    const disclosure = screen.getByText("HTTPS Connection Options").closest("details")!;
    disclosure.open = true; fireEvent(disclosure, new Event("toggle"));
    expect(await screen.findByText("http://192.0.2.40:9099")).toBeVisible();
    expect(screen.queryByText(/localhost:8088/)).toBeNull();
    expect(screen.getByRole("button", { name: /set up HTTPS/i })).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/allow public access/i));
    fireEvent.click(screen.getByRole("button", { name: /set up HTTPS/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/settings/console-https", { action: "start", provider: "cloudflare", confirmed: true }));
  });

  it("detects existing host and Docker installations and offers their address without replacing them", async () => {
    render(<HttpsSetup initiallyOpen />);
    await screen.findByText("http://192.0.2.40:9099");
    fireEvent.click(screen.getByRole("button", { name: /^Tailscale/i }));
    expect(screen.getByText("Existing Installation Detected")).toBeVisible();
    expect(screen.getByText(/my-vpn \(Running\)/)).toBeVisible();
    fireEvent.change(screen.getByLabelText("HTTPS Console Address"), { target: { value: "https://console.example.com" } });
    expect(screen.getByRole("link", { name: /open existing HTTPS Console/i })).toHaveAttribute("href", "https://console.example.com");
    expect(post).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("HTTPS Console Address"), { target: { value: "javascript:alert(1)" } });
    expect(screen.queryByRole("link", { name: /open existing HTTPS Console/i })).toBeNull();
  });

  it("requires an ngrok authtoken and clears it after submission", async () => {
    render(<HttpsSetup initiallyOpen />); await screen.findByText("http://192.0.2.40:9099");
    fireEvent.click(screen.getByRole("button", { name: /^ngrok/i }));
    fireEvent.click(screen.getByLabelText(/allow public access/i));
    expect(screen.getByRole("button", { name: /set up HTTPS/i })).toBeDisabled();
    const token = screen.getByPlaceholderText("Paste your account authtoken");
    expect(token).toHaveAttribute("type", "password");
    fireEvent.change(token, { target: { value: "synthetic-test-value" } });
    fireEvent.click(screen.getByRole("button", { name: /set up HTTPS/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/settings/console-https", { action: "start", provider: "ngrok", confirmed: true, token: "synthetic-test-value" }));
    await waitFor(() => expect(token).toHaveValue(""));
  });

  it("polls through starting and account approval until the HTTPS address is ready", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api).mockResolvedValueOnce({ ...initial, provider: "tailscale", enabled: true, running: true, approvalUrl: "https://login.tailscale.com/a/test" });
    render(<HttpsSetup initiallyOpen />);
    expect(await screen.findByText("Account Approval Needed")).toBeVisible();
    expect(screen.getByRole("link", { name: /Continue with Tailscale/i })).toHaveAttribute("target", "_blank");
    vi.mocked(api).mockResolvedValue({ ...initial, provider: "tailscale", enabled: true, running: true, url: "https://console.test.ts.net", tailnetReady: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(await screen.findByText("HTTPS Is Ready")).toBeVisible();
    expect(screen.getByRole("link", { name: "Open HTTPS Console" })).toHaveAttribute("href", "https://console.test.ts.net");
    expect(screen.getByText(/from a device on your tailnet/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Stop Connection" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/settings/console-https", { action: "stop" }));
  });

  it("shows a failed start and keeps the existing account installation safe", async () => {
    vi.mocked(api).mockResolvedValue({ ...initial, enabled: true, provider: "cloudflare", error: "Docker could not start the connector." });
    render(<HttpsSetup initiallyOpen />);
    expect(await screen.findByText("Needs Attention")).toBeVisible();
    expect(screen.getByText("Docker could not start the connector.")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Open HTTPS Console" })).toBeNull();
    expect(screen.getByRole("button", { name: "Stop Connection" })).toBeEnabled();
  });

  it("ignores a pre-start poll that arrives after the connection was started", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<HttpsSetup initiallyOpen />); await screen.findByText("http://192.0.2.40:9099");
    let finishOldPoll!: (value: typeof initial) => void;
    vi.mocked(api).mockReturnValueOnce(new Promise((resolve) => { finishOldPoll = resolve; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    fireEvent.click(screen.getByLabelText(/allow public access/i));
    fireEvent.click(screen.getByRole("button", { name: /set up HTTPS/i }));
    await screen.findByText("Preparing HTTPS");
    await act(async () => { finishOldPoll(initial); });
    expect(screen.getByText("Preparing HTTPS")).toBeVisible();
    expect(screen.getByRole("button", { name: "Stop Connection" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /set up HTTPS/i })).toBeNull();
  });
});
