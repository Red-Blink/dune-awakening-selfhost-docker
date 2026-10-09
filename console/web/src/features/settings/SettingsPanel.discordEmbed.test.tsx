import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { api } from "../../api/client";
import { SettingsPanel } from "./SettingsPanel";

// #643: replaces SettingsPanel's old manual Discord OAuth form with the
// embedded guided wizard. These tests cover SettingsPanel's OWN wiring to
// that component (mount/collapse/re-probe) -- the wizard's internal
// correctness (steps, saves, restart-and-poll) is already covered by
// DiscordSetupWizard.test.tsx and deliberately not re-tested here. The real
// component is replaced with a minimal stub that exposes exactly the props
// SettingsPanel passes it, per the design's own §4.4 test #2.
const mockOnCancel = vi.fn();
const mockOnDone = vi.fn();
let lastEmbeddedProp: boolean | undefined;
vi.mock("../auth/DiscordSetupWizard", () => ({
  DiscordSetupWizard: (props: { embedded?: boolean; onCancel: () => void; onDone: () => void }) => {
    lastEmbeddedProp = props.embedded;
    mockOnCancel.mockImplementation(props.onCancel);
    mockOnDone.mockImplementation(props.onDone);
    return <div data-testid="discord-setup-wizard-stub">DiscordSetupWizard stub content -- wizard-only marker</div>;
  },
}));

vi.mock("../../api/client", () => ({ api: vi.fn(), post: vi.fn(), setCsrfToken: vi.fn() }));
const mockApi = vi.mocked(api);

function mockBackend() {
  let settingsCalls = 0;
  mockApi.mockImplementation((path: string) => {
    if (path === "/api/auth/me") return Promise.resolve({ secondFactorEnrolled: false } as never);
    if (path === "/api/settings") { settingsCalls++; return Promise.resolve({ config: { port: 8088 }, publicDirectory: {}, serverConfig: {} } as never); }
    return Promise.reject(new Error(`unexpected api call: ${path}`));
  });
  return () => settingsCalls;
}

describe("SettingsPanel: embedded Discord OAuth wizard (#643)", () => {
  beforeEach(() => { vi.clearAllMocks(); lastEmbeddedProp = undefined; });

  it("Discord OAuth accordion is collapsed by default -- the wizard is not mounted until expanded", async () => {
    mockBackend();
    render(<SettingsPanel onPasswordChanged={vi.fn()} confirmAction={vi.fn()} onTotpEnrollmentStarted={vi.fn()} />);
    await screen.findByLabelText("Expand Discord OAuth");
    expect(screen.queryByTestId("discord-setup-wizard-stub")).toBeNull();
  });

  it("expanding the accordion mounts the wizard, passed embedded=true", async () => {
    mockBackend();
    render(<SettingsPanel onPasswordChanged={vi.fn()} confirmAction={vi.fn()} onTotpEnrollmentStarted={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText("Expand Discord OAuth"));
    expect(await screen.findByTestId("discord-setup-wizard-stub")).toBeTruthy();
    expect(lastEmbeddedProp).toBe(true);
  });

  it("the wizard's onCancel collapses the accordion", async () => {
    mockBackend();
    render(<SettingsPanel onPasswordChanged={vi.fn()} confirmAction={vi.fn()} onTotpEnrollmentStarted={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText("Expand Discord OAuth"));
    await screen.findByTestId("discord-setup-wizard-stub");

    mockOnCancel();
    await waitFor(() => expect(screen.queryByTestId("discord-setup-wizard-stub")).toBeNull());
  });

  it("the wizard's onDone collapses the accordion AND re-runs Settings' own config probe", async () => {
    const getSettingsCalls = mockBackend();
    render(<SettingsPanel onPasswordChanged={vi.fn()} confirmAction={vi.fn()} onTotpEnrollmentStarted={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText("Expand Discord OAuth"));
    await screen.findByTestId("discord-setup-wizard-stub");
    const callsBeforeDone = getSettingsCalls();

    mockOnDone();
    await waitFor(() => expect(screen.queryByTestId("discord-setup-wizard-stub")).toBeNull());
    await waitFor(() => expect(getSettingsCalls()).toBeGreaterThan(callsBeforeDone));
  });

  it("autoOpenDiscordSetup=true auto-expands the accordion on mount and calls onDiscordSetupAutoOpened exactly once", async () => {
    mockBackend();
    const onAutoOpened = vi.fn();
    render(<SettingsPanel onPasswordChanged={vi.fn()} confirmAction={vi.fn()} onTotpEnrollmentStarted={vi.fn()} autoOpenDiscordSetup onDiscordSetupAutoOpened={onAutoOpened} />);
    expect(await screen.findByTestId("discord-setup-wizard-stub")).toBeTruthy();
    expect(onAutoOpened).toHaveBeenCalledTimes(1);
  });

  it("without autoOpenDiscordSetup, the accordion stays collapsed and onDiscordSetupAutoOpened is never called", async () => {
    mockBackend();
    const onAutoOpened = vi.fn();
    render(<SettingsPanel onPasswordChanged={vi.fn()} confirmAction={vi.fn()} onTotpEnrollmentStarted={vi.fn()} onDiscordSetupAutoOpened={onAutoOpened} />);
    await screen.findByLabelText("Expand Discord OAuth");
    expect(screen.queryByTestId("discord-setup-wizard-stub")).toBeNull();
    expect(onAutoOpened).not.toHaveBeenCalled();
  });
});
