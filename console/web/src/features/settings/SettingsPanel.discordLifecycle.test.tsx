import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { api, post, postForResult } from "../../api/client";
import { SettingsPanel } from "./SettingsPanel";

// #676 §3 (tri-state Settings restructure), §6 (disable/enable/forget), §7
// (the zero-2FA guard's UI half), §8 (contextual copy for a Discord session).
vi.mock("../auth/DiscordSetupWizard", () => ({
  DiscordSetupWizard: () => <div data-testid="discord-setup-wizard-stub">wizard stub</div>,
}));
vi.mock("../../lib/consoleRestart", () => ({ restartConsoleAndReload: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../api/client", () => ({
  api: vi.fn(), post: vi.fn(), postForResult: vi.fn(), setCsrfToken: vi.fn(),
}));
const mockApi = vi.mocked(api);
const mockPost = vi.mocked(post);
const mockPostForResult = vi.mocked(postForResult);
const confirmAction = vi.fn().mockResolvedValue(true);

function mockBackend(config: Record<string, unknown>, { enrolled = false }: { enrolled?: boolean } = {}) {
  mockApi.mockImplementation((path: string) => {
    if (path === "/api/auth/me") return Promise.resolve({ secondFactorEnrolled: enrolled, user: { id: "local-owner" } } as never);
    if (path === "/api/settings") return Promise.resolve({ config, publicDirectory: {}, serverConfig: {} } as never);
    return Promise.reject(new Error(`unexpected api call: ${path}`));
  });
}

describe("SettingsPanel: Discord OAuth tri-state ordering (#676 §3)", () => {
  beforeEach(() => { vi.clearAllMocks(); confirmAction.mockResolvedValue(true); });

  it("not configured: Password Sign-In section renders before the Discord OAuth accordion", async () => {
    mockBackend({});
    const { container } = render(<SettingsPanel onPasswordChanged={vi.fn()} confirmAction={confirmAction} onTotpEnrollmentStarted={vi.fn()} />);
    await screen.findByLabelText("Expand Login Password");
    const headers = [...container.querySelectorAll(".playerAdmin_toggleHeader span:first-of-type, .playerAdmin_toggleHeader span")].map((el) => el.textContent);
    const loginIndex = headers.findIndex((t) => t === "Login Password");
    const discordIndex = headers.findIndex((t) => t === "Discord OAuth");
    expect(loginIndex).toBeGreaterThanOrEqual(0);
    expect(discordIndex).toBeGreaterThanOrEqual(0);
    expect(loginIndex).toBeLessThan(discordIndex);
  });

  it("configured and active: the Discord OAuth accordion renders before Login Password, open by default", async () => {
    mockBackend({ discordOAuthConfigured: true });
    const { container } = render(<SettingsPanel onPasswordChanged={vi.fn()} confirmAction={confirmAction} onTotpEnrollmentStarted={vi.fn()} />);
    await screen.findByTestId("discord-setup-wizard-stub");
    const headers = [...container.querySelectorAll(".playerAdmin_toggleHeader span")].map((el) => el.textContent);
    const loginIndex = headers.findIndex((t) => t?.startsWith("Login Password"));
    const discordIndex = headers.findIndex((t) => t === "Discord OAuth");
    expect(discordIndex).toBeGreaterThanOrEqual(0);
    expect(loginIndex).toBeGreaterThan(discordIndex);
    // Open by default -- the wizard stub is already rendered without a click.
    expect(screen.getByTestId("discord-setup-wizard-stub")).toBeTruthy();
  });

  it("configured and active: Login Password is labeled (fallback) and the break-glass reminder is shown", async () => {
    mockBackend({ discordOAuthConfigured: true });
    render(<SettingsPanel onPasswordChanged={vi.fn()} confirmAction={confirmAction} onTotpEnrollmentStarted={vi.fn()} />);
    await screen.findByTestId("discord-setup-wizard-stub");
    expect(await screen.findByText("Login Password (fallback)")).toBeTruthy();
    expect(screen.getByText(/break-glass fallback/i)).toBeTruthy();
  });

  it("not configured: no (fallback) label and no reminder", async () => {
    mockBackend({});
    render(<SettingsPanel onPasswordChanged={vi.fn()} confirmAction={confirmAction} onTotpEnrollmentStarted={vi.fn()} />);
    await screen.findByLabelText("Expand Login Password");
    expect(screen.queryByText("Login Password (fallback)")).toBeNull();
    expect(screen.getByText("Login Password")).toBeTruthy();
    expect(screen.queryByText(/break-glass fallback/i)).toBeNull();
  });

  it("soft-disabled: Password Sign-In reverts to primary (before Discord OAuth), which renders as the disabled banner", async () => {
    mockBackend({ discordOAuthDisabled: true });
    const { container } = render(<SettingsPanel onPasswordChanged={vi.fn()} confirmAction={confirmAction} onTotpEnrollmentStarted={vi.fn()} />);
    await screen.findByText("Discord Sign-In (disabled)");
    const headers = [...container.querySelectorAll(".playerAdmin_toggleHeader span, .settings-discord-disabled-banner strong")].map((el) => el.textContent);
    const loginIndex = headers.findIndex((t) => t?.startsWith("Login Password"));
    const disabledIndex = headers.findIndex((t) => t === "Discord Sign-In (disabled)");
    expect(loginIndex).toBeGreaterThanOrEqual(0);
    expect(disabledIndex).toBeGreaterThanOrEqual(0);
    expect(loginIndex).toBeLessThan(disabledIndex);
    // The wizard itself must not render in this state.
    expect(screen.queryByTestId("discord-setup-wizard-stub")).toBeNull();
  });
});

describe("SettingsPanel: Discord OAuth disable/enable/forget (#676 §6)", () => {
  beforeEach(() => { vi.clearAllMocks(); confirmAction.mockResolvedValue(true); });

  it("Re-enable posts to /api/settings/discord-oauth/enable with no body fields required", async () => {
    mockBackend({ discordOAuthDisabled: true });
    mockPost.mockResolvedValue({ ok: true } as never);
    render(<SettingsPanel onPasswordChanged={vi.fn()} confirmAction={confirmAction} onTotpEnrollmentStarted={vi.fn()} />);
    fireEvent.click(await screen.findByText("Re-enable Discord Sign-In"));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/api/settings/discord-oauth/enable", {}));
  });

  it("Forget stays disabled until \"forget\" is typed exactly, and requires a password", async () => {
    mockBackend({ discordOAuthDisabled: true });
    render(<SettingsPanel onPasswordChanged={vi.fn()} confirmAction={confirmAction} onTotpEnrollmentStarted={vi.fn()} />);
    fireEvent.click(await screen.findByText("Forget this configuration entirely"));
    const forgetButton = await screen.findByText("Forget This Configuration Entirely");
    expect(forgetButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/type.*forget.*to confirm/i), { target: { value: "not quite" } });
    expect(forgetButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/type.*forget.*to confirm/i), { target: { value: "forget" } });
    expect(forgetButton).toBeDisabled(); // still needs a password

    fireEvent.change(screen.getByLabelText(/password \(to confirm it's you\)/i), { target: { value: "the-password" } });
    expect(forgetButton).not.toBeDisabled();
  });

  it("Forget posts the typed-confirmed password to /api/settings/discord-oauth/forget", async () => {
    mockBackend({ discordOAuthDisabled: true });
    mockPost.mockResolvedValue({ ok: true } as never);
    render(<SettingsPanel onPasswordChanged={vi.fn()} confirmAction={confirmAction} onTotpEnrollmentStarted={vi.fn()} />);
    fireEvent.click(await screen.findByText("Forget this configuration entirely"));
    fireEvent.change(screen.getByLabelText(/type.*forget.*to confirm/i), { target: { value: "forget" } });
    fireEvent.change(screen.getByLabelText(/password \(to confirm it's you\)/i), { target: { value: "the-password" } });
    fireEvent.click(screen.getByText("Forget This Configuration Entirely"));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/api/settings/discord-oauth/forget", { currentPassword: "the-password" }));
  });

  it("Disable Discord Sign-In (active state) shows a danger confirmation before posting, and is disabled until a password is entered", async () => {
    mockBackend({ discordOAuthConfigured: true });
    mockPost.mockResolvedValue({ ok: true } as never);
    render(<SettingsPanel onPasswordChanged={vi.fn()} confirmAction={confirmAction} onTotpEnrollmentStarted={vi.fn()} />);
    await screen.findByTestId("discord-setup-wizard-stub"); // Discord is primary/open by default
    fireEvent.click(screen.getByText("Disable Discord Sign-In"));
    const disableButtons = screen.getAllByText("Disable Discord Sign-In");
    const submitButton = disableButtons[disableButtons.length - 1];
    expect(submitButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/password \(to confirm it's you\)/i), { target: { value: "the-password" } });
    expect(submitButton).not.toBeDisabled();

    fireEvent.click(submitButton);
    await waitFor(() => expect(confirmAction).toHaveBeenCalled());
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/api/settings/discord-oauth/disable", { currentPassword: "the-password" }));
  });
});

describe("SettingsPanel: zero-2FA guard UI (#676 §7)", () => {
  beforeEach(() => { vi.clearAllMocks(); confirmAction.mockResolvedValue(true); });

  async function openTwoFactorDisable() {
    render(<SettingsPanel onPasswordChanged={vi.fn()} confirmAction={confirmAction} onTotpEnrollmentStarted={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText("Expand Two-Factor Authentication"));
    fireEvent.change(screen.getByPlaceholderText("Your login password (to disable)"), { target: { value: "the-password" } });
    fireEvent.change(screen.getByPlaceholderText("Current 6-digit code (to disable)"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Disable Two-Factor Authentication" }));
  }

  it("a 409 zeroFactorWarning response shows the inline warning with an override, not a plain failure toast", async () => {
    mockBackend({ discordOAuthConfigured: true }, { enrolled: true });
    mockPostForResult.mockResolvedValue({ status: 409, body: { zeroFactorWarning: true, error: "no other factor" } });
    await openTwoFactorDisable();

    expect(await screen.findByText(/no two-factor authentication anywhere/i)).toBeTruthy();
    expect(screen.getByText("Disable anyway")).toBeTruthy();
    expect(screen.queryByText("Disable Failed")).toBeNull();
  });

  it("\"Disable anyway\" resubmits with acknowledgeNoOtherFactor:true", async () => {
    mockBackend({ discordOAuthConfigured: true }, { enrolled: true });
    mockPostForResult.mockResolvedValueOnce({ status: 409, body: { zeroFactorWarning: true } });
    mockPostForResult.mockResolvedValueOnce({ status: 200, body: { ok: true, sessionsRevoked: 0 } });
    await openTwoFactorDisable();
    await screen.findByText("Disable anyway");

    fireEvent.click(screen.getByText("Disable anyway"));

    await waitFor(() => expect(mockPostForResult).toHaveBeenCalledWith("/api/auth/2fa/disable", expect.objectContaining({ acknowledgeNoOtherFactor: true })));
  });

  it("no warning when the response is a plain success (Discord not configured, or its MFA already covers this tier)", async () => {
    mockBackend({}, { enrolled: true });
    mockPostForResult.mockResolvedValue({ status: 200, body: { ok: true, sessionsRevoked: 0 } });
    await openTwoFactorDisable();

    await waitFor(() => expect(screen.queryByText(/no two-factor authentication anywhere/i)).toBeNull());
  });
});

describe("SettingsPanel: contextual copy for a Discord-authenticated session (#676 §8)", () => {
  beforeEach(() => { vi.clearAllMocks(); confirmAction.mockResolvedValue(true); });

  it("shows where to find the admin password on the Enable-TOTP form when the acting session is Discord-authenticated", async () => {
    mockApi.mockImplementation((path: string) => {
      if (path === "/api/auth/me") return Promise.resolve({ secondFactorEnrolled: false, user: { id: "222222222222222222" } } as never);
      if (path === "/api/settings") return Promise.resolve({ config: { consoleTotpEnabled: true }, publicDirectory: {}, serverConfig: {} } as never);
      return Promise.reject(new Error(`unexpected api call: ${path}`));
    });
    render(<SettingsPanel onPasswordChanged={vi.fn()} confirmAction={confirmAction} onTotpEnrollmentStarted={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText("Expand Two-Factor Authentication"));
    expect(await screen.findByText(/runtime\/secrets\/admin-web-password\.txt/i)).toBeTruthy();
  });

  it("does not show that copy for a plain password session", async () => {
    mockBackend({ consoleTotpEnabled: true });
    render(<SettingsPanel onPasswordChanged={vi.fn()} confirmAction={confirmAction} onTotpEnrollmentStarted={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText("Expand Two-Factor Authentication"));
    await screen.findByText("Enable Two-Factor Authentication");
    expect(screen.queryByText(/runtime\/secrets\/admin-web-password\.txt/i)).toBeNull();
  });
});
