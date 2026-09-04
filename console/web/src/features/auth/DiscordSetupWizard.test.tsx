import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { api, post } from "../../api/client";
import { DiscordSetupWizard } from "./DiscordSetupWizard";

// #641 (guided Discord app-creation flow + hard HTTPS gate). Real Eight Hats
// Layer 1 findings this test suite regression-pins directly (design doc
// docs/design/discord-setup-wizard-guided-flow-l1-design-2026-08-30.md, §4.3):
//   - Architect HIGH: the connect-step save must send ONLY the 2 keys it
//     manages (DISCORD_OAUTH_CLIENT_ID, DISCORD_OAUTH_REDIRECT_URI) -- never
//     as blank strings for any other write-oauth-config field, which would
//     recreate the exact discordSetupFinalize owner-bootstrap-allowlist bug
//     this codebase already fixed once.
//   - QA HIGH: the window.open/visibilitychange mechanism has zero test
//     precedent in this codebase -- resolved in the design by using the
//     existing, trivially-testable <a rel="noreferrer"> pattern instead of a
//     raw window.open() call, which this suite asserts directly (the href).
//   - QA MEDIUM: the HTTPS gate line had zero test coverage even in its
//     original warning-only form.
vi.mock("../../api/client", () => ({ api: vi.fn(), post: vi.fn() }));
const mockApi = vi.mocked(api);
const mockPost = vi.mocked(post);

function stubNotYetConfigured() {
  mockApi.mockImplementation((path: string) => {
    if (path === "/api/settings") return Promise.resolve({ serverConfig: {}, config: { discordOAuthAppConfigured: false } } as never);
    if (path === "/api/setup/discord-identity") return Promise.reject(new Error("not signed in with Discord yet"));
    return Promise.reject(new Error(`unexpected api call: ${path}`));
  });
}

function stubHttps(value: boolean) {
  Object.defineProperty(window, "location", {
    value: { ...window.location, protocol: value ? "https:" : "http:", origin: value ? "https://console.example.org" : "http://console.example.org", search: "" },
    writable: true,
  });
}

describe("DiscordSetupWizard: hard HTTPS gate", () => {
  beforeEach(() => { vi.clearAllMocks(); stubHttps(true); });
  afterEach(() => { stubHttps(true); });

  it("blocks the connect step entirely and shows free HTTPS options when not loaded over HTTPS", async () => {
    stubHttps(false);
    stubNotYetConfigured();
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);

    expect(await screen.findByText(/requires https/i)).toBeTruthy();
    expect(screen.getByText(/Cloudflare Tunnel/i)).toBeTruthy();
    expect(screen.getAllByText(/Tailscale/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/ngrok/i).length).toBeGreaterThan(0);
    // The connect-step branch buttons must not appear while blocked.
    expect(screen.queryByText("I already have a Discord application")).toBeNull();
  });

  it("does not block, and shows the normal connect step, when loaded over HTTPS", async () => {
    stubHttps(true);
    stubNotYetConfigured();
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);

    expect(await screen.findByText("I already have a Discord application")).toBeTruthy();
    expect(screen.queryByText(/requires https/i)).toBeNull();
  });
});

describe("DiscordSetupWizard: guided app-creation branch", () => {
  beforeEach(() => { vi.clearAllMocks(); stubHttps(true); });

  it("shows the branch question before either path is chosen", async () => {
    stubNotYetConfigured();
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);
    expect(await screen.findByText("I already have a Discord application")).toBeTruthy();
    expect(screen.getByText("I need to create one")).toBeTruthy();
    expect(screen.queryByLabelText(/client id/i)).toBeNull();
  });

  // Live-testing finding: "I need to create one" used the same tiny,
  // muted-text-link class as "Cancel" -- a real, weighted either/or choice
  // (arguably the MORE common path for a first-time operator) looked like a
  // throwaway escape hatch next to the bold primary button. It needs its own
  // real, visually-distinct secondary-button styling, not .login-password-
  // toggle (reserved for genuine tertiary/escape actions like Cancel).
  it("'I need to create one' is a real secondary button, not styled the same as Cancel", async () => {
    stubNotYetConfigured();
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);
    const needAppButton = await screen.findByText("I need to create one");
    const cancelButton = screen.getByText("Cancel");
    expect(needAppButton.className).not.toBe(cancelButton.className);
    expect(needAppButton.className).toContain("login-secondary-button");
  });

  it("'I already have one' reveals the form directly, with the dedicated-app warning co-located", async () => {
    stubNotYetConfigured();
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);
    fireEvent.click(await screen.findByText("I already have a Discord application"));
    expect(await screen.findByLabelText(/client id/i)).toBeTruthy();
    expect(screen.getByLabelText(/client secret/i)).toBeTruthy();
    expect(screen.getByText(/dedicated/i)).toBeTruthy();
  });

  it("'I need to create one' opens Discord's portal via a safe <a rel=noreferrer> link, shows a numbered checklist, and the same form", async () => {
    stubNotYetConfigured();
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);
    fireEvent.click(await screen.findByText("I need to create one"));

    const link = await screen.findByRole("link", { name: /developer portal/i });
    expect(link.getAttribute("href")).toBe("https://discord.com/developers/applications");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noreferrer");

    expect(screen.getByText("OAuth2")).toBeTruthy();
    expect(await screen.findByLabelText(/client id/i)).toBeTruthy();
    expect(screen.getByText(/dedicated/i)).toBeTruthy();
  });

  it("shows a welcome-back nudge once the window regains focus after choosing 'need to create one'", async () => {
    stubNotYetConfigured();
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);
    fireEvent.click(await screen.findByText("I need to create one"));
    expect(screen.queryByText(/welcome back/i)).toBeNull();

    fireEvent(window, new Event("focus"));
    expect(await screen.findByText(/welcome back/i)).toBeTruthy();
  });
});

describe("DiscordSetupWizard: saving the connect-step form", () => {
  beforeEach(() => { vi.clearAllMocks(); stubHttps(true); });

  it("sends ONLY DISCORD_OAUTH_CLIENT_ID and DISCORD_OAUTH_REDIRECT_URI to write-oauth-config -- no other key present at all", async () => {
    stubNotYetConfigured();
    mockPost.mockImplementation((path: string) => {
      if (path === "/api/setup/write-oauth-config") return Promise.resolve({ ok: true } as never);
      return Promise.reject(new Error(`unexpected post: ${path}`));
    });
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);
    fireEvent.click(await screen.findByText("I already have a Discord application"));

    fireEvent.change(await screen.findByLabelText(/client id/i), { target: { value: "123456789012345678" } });
    fireEvent.click(screen.getByText(/save/i));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/api/setup/write-oauth-config", expect.anything()));
    const [, body] = mockPost.mock.calls.find(([p]) => p === "/api/setup/write-oauth-config")!;
    expect(Object.keys(body as object).sort()).toEqual(["DISCORD_OAUTH_CLIENT_ID", "DISCORD_OAUTH_REDIRECT_URI"].sort());
    expect((body as Record<string, string>).DISCORD_OAUTH_CLIENT_ID).toBe("123456789012345678");
  });

  it("also saves the secret via save-oauth-secret when one was entered", async () => {
    stubNotYetConfigured();
    mockPost.mockImplementation((path: string) => {
      if (path === "/api/setup/write-oauth-config") return Promise.resolve({ ok: true } as never);
      if (path === "/api/setup/save-oauth-secret") return Promise.resolve({ ok: true } as never);
      return Promise.reject(new Error(`unexpected post: ${path}`));
    });
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);
    fireEvent.click(await screen.findByText("I already have a Discord application"));

    fireEvent.change(await screen.findByLabelText(/client id/i), { target: { value: "123456789012345678" } });
    fireEvent.change(screen.getByLabelText(/client secret/i), { target: { value: "shh-its-a-secret" } });
    fireEvent.click(screen.getByText(/save/i));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/api/setup/save-oauth-secret", { secret: "shh-its-a-secret", overwrite: false }));
  });

  it("does not call save-oauth-secret at all when no secret was entered", async () => {
    stubNotYetConfigured();
    mockPost.mockImplementation((path: string) => {
      if (path === "/api/setup/write-oauth-config") return Promise.resolve({ ok: true } as never);
      return Promise.reject(new Error(`unexpected post: ${path}`));
    });
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);
    fireEvent.click(await screen.findByText("I already have a Discord application"));
    fireEvent.change(await screen.findByLabelText(/client id/i), { target: { value: "123456789012345678" } });
    fireEvent.click(screen.getByText(/save/i));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/api/setup/write-oauth-config", expect.anything()));
    expect(mockPost).not.toHaveBeenCalledWith("/api/setup/save-oauth-secret", expect.anything());
  });
});

// Live-testing finding: "entered both values, clicked save and the secret
// input went away and nothing else [happened]". Root cause (confirmed against
// real server code, not guessed): writeOAuthConfig/saveOAuthClientSecret only
// write .env / the secret file -- config.discordOAuthAppConfigured is computed
// once from process.env at loadConfig() (server.js:81) and is never hot-reloaded,
// so a successful save is real but invisible until the console restarts. This
// exact "wrote config the running process hasn't loaded" problem already has a
// solved pattern in this same component for the later finalize step (the "done"
// step's restartNow() + poll-until-config-flips) -- the connect step's save
// never wired into it. publicConfig() already exposes discordOAuthAppConfigured
// (config.js:527), so /api/auth/state carries exactly the field needed to poll;
// this is a frontend-only fix.
describe("DiscordSetupWizard: a restart is required after saving (the process only reads .env at boot)", () => {
  beforeEach(() => { vi.clearAllMocks(); stubHttps(true); });
  afterEach(() => { vi.useRealTimers(); });

  function stubLocationReplace() {
    const replace = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, protocol: "https:", origin: "https://console.example.org", search: "", replace },
      writable: true,
    });
    return replace;
  }

  it("shows a 'restart required' prompt instead of silently doing nothing once the save succeeds", async () => {
    stubNotYetConfigured();
    mockPost.mockImplementation((path: string) => {
      if (path === "/api/setup/write-oauth-config") return Promise.resolve({ ok: true } as never);
      if (path === "/api/setup/save-oauth-secret") return Promise.resolve({ ok: true } as never);
      return Promise.reject(new Error(`unexpected post: ${path}`));
    });
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);
    fireEvent.click(await screen.findByText("I already have a Discord application"));
    fireEvent.change(await screen.findByLabelText(/client id/i), { target: { value: "123456789012345678" } });
    fireEvent.change(screen.getByLabelText(/client secret/i), { target: { value: "shh-its-a-secret" } });
    fireEvent.click(screen.getByText(/save/i));

    expect(await screen.findByText("Restart the console now")).toBeTruthy();
    // The stale, now-emptied form must not still be the only thing on screen --
    // that is exactly what read as "went away and nothing else".
    expect(screen.queryByLabelText(/client secret/i)).toBeNull();
  });

  it("clicking 'Restart the console now' restarts and polls for discordOAuthAppConfigured -- not discordOAuthConfigured, which also needs a home guild not set yet at this step -- before reloading", async () => {
    stubNotYetConfigured();
    mockPost.mockImplementation((path: string) => {
      if (path === "/api/setup/write-oauth-config") return Promise.resolve({ ok: true } as never);
      if (path === "/api/setup/discord-restart") return Promise.resolve({ ok: true } as never);
      return Promise.reject(new Error(`unexpected post: ${path}`));
    });
    const replace = stubLocationReplace();

    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);
    fireEvent.click(await screen.findByText("I already have a Discord application"));
    fireEvent.change(await screen.findByLabelText(/client id/i), { target: { value: "123456789012345678" } });
    fireEvent.click(screen.getByText(/save/i));
    const restartButton = await screen.findByText("Restart the console now");

    // Fake timers only go on now -- findBy above relies on real-timer polling,
    // same precedent as features/players/PlayerSummary.test.tsx's 30s-refresh test.
    let pollCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      pollCount++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ config: { discordOAuthAppConfigured: pollCount > 1, discordOAuthConfigured: false } }) });
    }));
    vi.useFakeTimers();

    fireEvent.click(restartButton);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    expect(mockPost).toHaveBeenCalledWith("/api/setup/discord-restart", {});
    expect(replace).toHaveBeenCalledWith("/");
  });
});

// #643 (embed the guided wizard into Settings). Real Eight Hats Layer 1
// findings this suite regression-pins (design doc
// docs/design/discord-settings-embed-l1-design-2026-08-30.md, §4):
//   - Architect CRITICAL (#676's own audit, carried into this implementation):
//     the "done" step's restartNow() always ends in window.location.replace,
//     a full navigation -- embedded mode must never rely on a subsequent
//     Discord round-trip re-mounting THIS component; App.tsx owns that via
//     the sessionStorage marker instead (asserted below).
//   - Cloud Security HIGH (#676): the credential-entry form must remain the
//     ONLY reachable way to rotate the Discord Client Secret once this
//     replaces SettingsPanel's old always-editable manual form -- "Change
//     application credentials" (§4.2).
//   - GRC HIGH (#676): the map step's role/MFA fields must pre-fill from
//     already-saved config, not silently reset to blank/true on reopen (§4.3).
function stubAlreadyConfiguredNoIdentity() {
  mockApi.mockImplementation((path: string) => {
    if (path === "/api/settings") {
      return Promise.resolve({
        serverConfig: {
          DISCORD_OAUTH_CLIENT_ID: "123456789012345678",
          DISCORD_CONSOLE_ADMIN_ROLE_IDS: "111111111111111111",
          DISCORD_CONSOLE_MODERATOR_ROLE_IDS: "",
          DISCORD_CONSOLE_PLAYER_ROLE_IDS: "222222222222222222",
          DISCORD_OAUTH_REQUIRE_MFA_TIERS: "owner,admin",
        },
        config: { discordOAuthAppConfigured: true },
      } as never);
    }
    if (path === "/api/setup/discord-identity") return Promise.reject(new Error("not signed in with Discord yet"));
    return Promise.reject(new Error(`unexpected api call: ${path}`));
  });
}

describe("DiscordSetupWizard: embedded mode structural difference", () => {
  beforeEach(() => { vi.clearAllMocks(); stubHttps(true); });

  it("standalone (not embedded): renders the full-page login-screen wrapper, no embedded wrapper", async () => {
    stubNotYetConfigured();
    const { container } = render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);
    await screen.findByText("I already have a Discord application");
    expect(container.querySelector("main.login-screen")).not.toBeNull();
    expect(container.querySelector(".discord-setup-panel-embedded")).toBeNull();
  });

  it("embedded: renders the embedded wrapper, never the full-page login-screen wrapper", async () => {
    stubNotYetConfigured();
    const { container } = render(<DiscordSetupWizard embedded onDone={() => {}} onCancel={() => {}} />);
    await screen.findByText("I already have a Discord application");
    expect(container.querySelector(".discord-setup-panel-embedded")).not.toBeNull();
    expect(container.querySelector("main.login-screen")).toBeNull();
  });

  it("embedded: sets the DISCORD_SETUP_RETURN_MARKER in sessionStorage before navigating to the OAuth round-trip; standalone mode never sets it", async () => {
    window.sessionStorage.clear();
    stubAlreadyConfiguredNoIdentity();
    render(<DiscordSetupWizard embedded onDone={() => {}} onCancel={() => {}} />);
    const link = await screen.findByRole("link", { name: /continue with discord/i });
    fireEvent.click(link);
    expect(window.sessionStorage.getItem("dune-console:discord-setup-return")).toBe("1");
    window.sessionStorage.clear();
  });

  it("standalone: never sets the marker, since the pre-login flow's existing forced-logout/standalone-mount behavior must stay unchanged", async () => {
    window.sessionStorage.clear();
    stubAlreadyConfiguredNoIdentity();
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);
    const link = await screen.findByRole("link", { name: /continue with discord/i });
    fireEvent.click(link);
    expect(window.sessionStorage.getItem("dune-console:discord-setup-return")).toBeNull();
  });
});

describe("DiscordSetupWizard: change application credentials (§4.2)", () => {
  beforeEach(() => { vi.clearAllMocks(); stubHttps(true); });

  it("is not shown before the application is configured", async () => {
    stubNotYetConfigured();
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);
    await screen.findByText("I already have a Discord application");
    expect(screen.queryByText("Change application credentials")).toBeNull();
  });

  it("once configured (authorize step), offers a way back to the credential-entry form, pre-filled with the saved Client ID", async () => {
    stubAlreadyConfiguredNoIdentity();
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);
    fireEvent.click(await screen.findByText("Change application credentials"));
    const clientIdInput = await screen.findByLabelText(/client id/i) as HTMLInputElement;
    expect(clientIdInput.value).toBe("123456789012345678");
  });

  // Layer 2 audit finding (Software Architect hat, HIGH, #676 follow-up):
  // saveApp() sets appSaved=true/forceReconfigure=false, but
  // discordOAuthConfigured/discordOAuthAppConfigured are boot-time snapshots
  // that a save alone cannot flip (the console only reads .env at boot) --
  // for an install that was ALREADY fully active before this reconfigure
  // (mappingConfigured true the whole time), the step re-derivation used to
  // fall straight back to "active", silently skipping the "a restart is
  // needed" card. A subsequent "Continue with Discord" click would then
  // authorize against the stale, pre-rotation credentials still resident in
  // the running process.
  it("after saving new credentials for an ALREADY fully-active install, shows the restart-required card instead of silently reverting to the active summary", async () => {
    mockApi.mockImplementation((path: string) => {
      if (path === "/api/settings") {
        return Promise.resolve({
          serverConfig: { DISCORD_OAUTH_CLIENT_ID: "123456789012345678" },
          // Reconfigure-of-active scenario: mapping was already finalized
          // before this save started, and (per the real bug) STAYS true
          // after saveApp()'s own probe() re-fetch, since nothing has
          // actually restarted yet.
          config: { discordOAuthAppConfigured: true, discordOAuthConfigured: true },
        } as never);
      }
      if (path === "/api/setup/discord-identity") return Promise.reject(new Error("not signed in with Discord yet"));
      return Promise.reject(new Error(`unexpected api call: ${path}`));
    });
    mockPost.mockImplementation((path: string) => {
      if (path === "/api/setup/write-oauth-config") return Promise.resolve({ ok: true } as never);
      return Promise.reject(new Error(`unexpected post: ${path}`));
    });
    render(<DiscordSetupWizard embedded onDone={() => {}} onCancel={() => {}} />);

    fireEvent.click(await screen.findByText("Change application credentials"));
    fireEvent.change(await screen.findByLabelText(/client id/i), { target: { value: "999999999999999999" } });
    fireEvent.click(screen.getByText(/^save$/i));

    expect(await screen.findByText(/a restart is needed before Discord sign-in can continue/i)).toBeTruthy();
    expect(screen.queryByText(/connected and active for this server/i)).toBeNull();
    expect(screen.queryByRole("link", { name: /sign in with discord to update server or role mapping/i })).toBeNull();
  });
});

describe("DiscordSetupWizard: already-active state, no identity for this session (live UAT UX finding, #676 follow-up)", () => {
  beforeEach(() => { vi.clearAllMocks(); stubHttps(true); });

  // Found live on dune-dev: an admin who signed in with the console password
  // and opens Settings -> Discord OAuth for an install where Discord sign-in
  // is already fully configured and actively used by other people saw "Set up
  // Discord sign-in" / "Continue with Discord" as the primary heading and
  // call to action -- reading as broken or unconfigured, when the integration
  // was demonstrably live. Root cause: the wizard only ever tracked
  // discordOAuthAppConfigured (app credentials saved), never
  // discordOAuthConfigured (guild/role mapping actually finalized), so
  // "mapping still in progress" and "fully active, this session just hasn't
  // done its own OAuth round-trip" were indistinguishable and both rendered
  // as the "authorize" step.
  function stubFullyActiveNoIdentity() {
    mockApi.mockImplementation((path: string) => {
      if (path === "/api/settings") {
        return Promise.resolve({
          serverConfig: { DISCORD_OAUTH_CLIENT_ID: "123456789012345678" },
          config: { discordOAuthAppConfigured: true, discordOAuthConfigured: true },
        } as never);
      }
      if (path === "/api/setup/discord-identity") return Promise.reject(new Error("not signed in with Discord yet"));
      return Promise.reject(new Error(`unexpected api call: ${path}`));
    });
  }

  it("shows an active summary, not the 'Set up Discord sign-in' authorize prompt, when mapping is already finalized", async () => {
    stubFullyActiveNoIdentity();
    render(<DiscordSetupWizard embedded onDone={() => {}} onCancel={() => {}} />);
    expect(await screen.findByText(/connected and active for this server/i)).toBeTruthy();
    expect(screen.queryByText("Set up Discord sign-in")).toBeNull();
    expect(screen.queryByRole("link", { name: /^continue with discord$/i })).toBeNull();
  });

  it("still offers a way to update server/role mapping and to change application credentials", async () => {
    stubFullyActiveNoIdentity();
    render(<DiscordSetupWizard embedded onDone={() => {}} onCancel={() => {}} />);
    expect(await screen.findByRole("link", { name: /sign in with discord to update server or role mapping/i })).toBeTruthy();
    expect(screen.getByText("Change application credentials")).toBeTruthy();
  });

  it("the mapping-update link still sets the embedded return marker like the authorize step's own link does", async () => {
    window.sessionStorage.clear();
    stubFullyActiveNoIdentity();
    render(<DiscordSetupWizard embedded onDone={() => {}} onCancel={() => {}} />);
    fireEvent.click(await screen.findByRole("link", { name: /sign in with discord to update server or role mapping/i }));
    expect(window.sessionStorage.getItem("dune-console:discord-setup-return")).toBe("1");
    window.sessionStorage.clear();
  });

  it("falls back to the authorize step when the app is configured but mapping is not finalized yet (unchanged behavior)", async () => {
    stubAlreadyConfiguredNoIdentity();
    render(<DiscordSetupWizard embedded onDone={() => {}} onCancel={() => {}} />);
    expect(await screen.findByRole("link", { name: /^continue with discord$/i })).toBeTruthy();
    expect(screen.queryByText(/connected and active for this server/i)).toBeNull();
  });
});

describe("DiscordSetupWizard: password-awareness checkbox on the map step (#676 §8)", () => {
  beforeEach(() => { vi.clearAllMocks(); stubHttps(true); });

  function stubReadyToFinalize() {
    mockApi.mockImplementation((path: string) => {
      if (path === "/api/settings") return Promise.resolve({ serverConfig: {}, config: { discordOAuthAppConfigured: true } } as never);
      if (path === "/api/setup/discord-identity") {
        return Promise.resolve({ user: { id: "u1", username: "owner", mfaEnabled: true }, guilds: [{ id: "333333333333333333", name: "My Server", owner: true }] } as never);
      }
      return Promise.reject(new Error(`unexpected api call: ${path}`));
    });
  }

  it("\"Turn on Discord sign-in\" stays disabled until the password-awareness checkbox is checked, even with a valid guild and role", async () => {
    stubReadyToFinalize();
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);
    await screen.findByText("My Server", { exact: false });
    fireEvent.change(await screen.findByLabelText(/admin role/i), { target: { value: "400000000000000002" } });

    const finalizeButton = screen.getByText("Turn on Discord sign-in");
    expect(finalizeButton).toBeDisabled();

    fireEvent.click(screen.getByLabelText(/I know this console's admin password/i));
    expect(finalizeButton).not.toBeDisabled();
  });

  it("mentions where the admin password lives", async () => {
    stubReadyToFinalize();
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);
    expect(await screen.findByText(/runtime\/secrets\/admin-web-password\.txt/i)).toBeTruthy();
  });
});

describe("DiscordSetupWizard: the offer-step marker (#676 §7)", () => {
  beforeEach(() => { vi.clearAllMocks(); stubHttps(true); });
  afterEach(() => { vi.useRealTimers(); });

  function stubLocationReplace() {
    const replace = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, protocol: "https:", origin: "https://console.example.org", search: "", replace },
      writable: true,
    });
    return replace;
  }

  async function driveToRestartButtonOnDoneStep({ secondFactorEnrolled }: { secondFactorEnrolled: boolean }) {
    mockApi.mockImplementation((path: string) => {
      if (path === "/api/settings") return Promise.resolve({ serverConfig: {}, config: { discordOAuthAppConfigured: true, discordOAuthConfigured: false } } as never);
      if (path === "/api/setup/discord-identity") {
        return Promise.resolve({ user: { id: "u1", username: "owner", mfaEnabled: true }, guilds: [{ id: "333333333333333333", name: "My Server", owner: true }] } as never);
      }
      if (path === "/api/auth/me") return Promise.resolve({ secondFactorEnrolled } as never);
      return Promise.reject(new Error(`unexpected api call: ${path}`));
    });
    mockPost.mockImplementation((path: string) => {
      if (path === "/api/setup/discord-finalize") return Promise.resolve({ ok: true, guild: { name: "My Server" }, owner: { username: "owner" } } as never);
      if (path === "/api/setup/discord-restart") return Promise.resolve({ ok: true } as never);
      return Promise.reject(new Error(`unexpected post: ${path}`));
    });
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);
    await screen.findByText("My Server", { exact: false });
    fireEvent.change(await screen.findByLabelText(/admin role/i), { target: { value: "400000000000000002" } });
    fireEvent.click(screen.getByLabelText(/I know this console's admin password/i));
    fireEvent.click(screen.getByText("Turn on Discord sign-in"));
    return screen.findByText("Restart the console now");
  }

  it("sets the marker when this is a first-time configuration (not already configured) with TOTP already enrolled", async () => {
    window.sessionStorage.clear();
    const restartButton = await driveToRestartButtonOnDoneStep({ secondFactorEnrolled: true });
    fireEvent.click(restartButton);
    expect(window.sessionStorage.getItem("dune-console:discord-oauth-just-configured")).toBe("1");
    window.sessionStorage.clear();
  });

  it("does NOT set the marker when TOTP was never enrolled", async () => {
    window.sessionStorage.clear();
    const restartButton = await driveToRestartButtonOnDoneStep({ secondFactorEnrolled: false });
    fireEvent.click(restartButton);
    expect(window.sessionStorage.getItem("dune-console:discord-oauth-just-configured")).toBeNull();
  });

  it("does NOT set the marker for a re-edit (already fully configured before this session started)", async () => {
    window.sessionStorage.clear();
    mockApi.mockImplementation((path: string) => {
      if (path === "/api/settings") return Promise.resolve({ serverConfig: {}, config: { discordOAuthAppConfigured: true, discordOAuthConfigured: true } } as never);
      if (path === "/api/setup/discord-identity") {
        return Promise.resolve({ user: { id: "u1", username: "owner", mfaEnabled: true }, guilds: [{ id: "333333333333333333", name: "My Server", owner: true }] } as never);
      }
      if (path === "/api/auth/me") return Promise.resolve({ secondFactorEnrolled: true } as never);
      return Promise.reject(new Error(`unexpected api call: ${path}`));
    });
    mockPost.mockImplementation((path: string) => {
      if (path === "/api/setup/discord-finalize") return Promise.resolve({ ok: true, guild: { name: "My Server" }, owner: { username: "owner" } } as never);
      if (path === "/api/setup/discord-restart") return Promise.resolve({ ok: true } as never);
      return Promise.reject(new Error(`unexpected post: ${path}`));
    });
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);
    await screen.findByText("My Server", { exact: false });
    fireEvent.change(await screen.findByLabelText(/admin role/i), { target: { value: "400000000000000002" } });
    fireEvent.click(screen.getByLabelText(/I know this console's admin password/i));
    fireEvent.click(screen.getByText("Turn on Discord sign-in"));
    fireEvent.click(await screen.findByText("Restart the console now"));

    expect(window.sessionStorage.getItem("dune-console:discord-oauth-just-configured")).toBeNull();
  });

  it("does NOT set the marker when the restart button is never clicked (e.g. \"Back to Settings\" instead)", async () => {
    window.sessionStorage.clear();
    await driveToRestartButtonOnDoneStep({ secondFactorEnrolled: true });
    // Deliberately not clicking "Restart the console now" -- the marker must
    // only ever be set at the moment the restart is actually invoked.
    expect(window.sessionStorage.getItem("dune-console:discord-oauth-just-configured")).toBeNull();
  });
});

describe("DiscordSetupWizard: role/MFA pre-fill on the map step (§4.3)", () => {
  beforeEach(() => { vi.clearAllMocks(); stubHttps(true); });

  it("pre-fills admin/player role IDs and the MFA requirement from already-saved config, not blank/default", async () => {
    mockApi.mockImplementation((path: string) => {
      if (path === "/api/settings") {
        return Promise.resolve({
          serverConfig: {
            DISCORD_OAUTH_CLIENT_ID: "123456789012345678",
            DISCORD_CONSOLE_ADMIN_ROLE_IDS: "111111111111111111",
            DISCORD_CONSOLE_MODERATOR_ROLE_IDS: "",
            DISCORD_CONSOLE_PLAYER_ROLE_IDS: "222222222222222222",
            DISCORD_OAUTH_REQUIRE_MFA_TIERS: "",
          },
          config: { discordOAuthAppConfigured: true },
        } as never);
      }
      if (path === "/api/setup/discord-identity") {
        return Promise.resolve({ user: { id: "u1", username: "owner", mfaEnabled: true }, guilds: [{ id: "333333333333333333", name: "My Server", owner: true }] } as never);
      }
      return Promise.reject(new Error(`unexpected api call: ${path}`));
    });
    render(<DiscordSetupWizard onDone={() => {}} onCancel={() => {}} />);

    // The map step can render (identity alone gates it) before the app-config
    // probe's own pre-fill effect has applied -- wait for the VALUE, not just
    // the element, to avoid a real race between the two independent probes.
    const adminInput = await screen.findByLabelText(/admin role/i) as HTMLInputElement;
    await waitFor(() => expect(adminInput.value).toBe("111111111111111111"));
    const playerInput = screen.getByLabelText(/player role/i) as HTMLInputElement;
    expect(playerInput.value).toBe("222222222222222222");
    // Saved config had no MFA requirement -- the checkbox must reflect that,
    // not silently default to checked (the real bug this pre-fill fixes).
    const mfaCheckbox = screen.getByLabelText(/require.*two-factor for owner and admin/i) as HTMLInputElement;
    expect(mfaCheckbox.checked).toBe(false);
  });
});
