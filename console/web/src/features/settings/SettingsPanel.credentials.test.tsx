import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { api, post } from "../../api/client";
import { SettingsPanel } from "./SettingsPanel";

vi.mock("../../api/client", () => ({
  api: vi.fn(),
  post: vi.fn(),
}));

const mockApi = vi.mocked(api);
const mockPost = vi.mocked(post);
const onPasswordChanged = vi.fn();

const STRONG_PASSWORD = "New-Correct-Horse-9!Battery";

// /api/settings is read first, then /api/auth/me for secondFactorEnrolled.
function mockBackend({ enrolled, unavailable = false }: { enrolled: boolean; unavailable?: boolean }) {
  mockApi.mockImplementation((path: string) => {
    if (path === "/api/auth/me") {
      return Promise.resolve({ secondFactorEnrolled: enrolled, secondFactorUnavailable: unavailable } as never);
    }
    return Promise.resolve({ config: { port: 8088 }, publicDirectory: {}, serverConfig: {} } as never);
  });
}

async function openLoginPasswordSection() {
  fireEvent.click(await screen.findByLabelText("Expand Login Password"));
}

function fillPasswordFields() {
  fireEvent.change(screen.getByPlaceholderText("Current password"), { target: { value: "old-password" } });
  fireEvent.change(screen.getByPlaceholderText("At Least 13 Characters"), { target: { value: STRONG_PASSWORD } });
  fireEvent.change(screen.getByPlaceholderText("Confirm new password"), { target: { value: STRONG_PASSWORD } });
}

describe("SettingsPanel credential controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("password change with no second factor enrolled", () => {
    it("does not ask for an authenticator code and posts without one", async () => {
      mockBackend({ enrolled: false });
      mockPost.mockResolvedValue({ ok: true } as never);
      render(<SettingsPanel onPasswordChanged={onPasswordChanged} confirmAction={vi.fn()} onTotpEnrollmentStarted={vi.fn()} />);
      await openLoginPasswordSection();

      expect(screen.queryByPlaceholderText("6-digit code")).toBeNull();

      fillPasswordFields();
      fireEvent.click(screen.getByText("Change Password"));

      await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
        "/api/settings/admin-password",
        { currentPassword: "old-password", newPassword: STRONG_PASSWORD }
      ));
    });
  });

  describe("password change with a second factor enrolled", () => {
    it("renders an authenticator-code field", async () => {
      mockBackend({ enrolled: true });
      render(<SettingsPanel onPasswordChanged={onPasswordChanged} confirmAction={vi.fn()} onTotpEnrollmentStarted={vi.fn()} />);
      await openLoginPasswordSection();

      expect(await screen.findByPlaceholderText("6-digit code")).toBeTruthy();
    });

    // The regression itself: the server rejects a rotation with no totpCode
    // (server.js, "Enter your current authenticator code to change the
    // password"), so a form that cannot send one is a dead end.
    it("sends the authenticator code with the rotation request", async () => {
      mockBackend({ enrolled: true });
      mockPost.mockResolvedValue({ ok: true } as never);
      render(<SettingsPanel onPasswordChanged={onPasswordChanged} confirmAction={vi.fn()} onTotpEnrollmentStarted={vi.fn()} />);
      await openLoginPasswordSection();
      await screen.findByPlaceholderText("6-digit code");

      fillPasswordFields();
      fireEvent.change(screen.getByPlaceholderText("6-digit code"), { target: { value: "123456" } });
      fireEvent.click(screen.getByText("Change Password"));

      await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
        "/api/settings/admin-password",
        { currentPassword: "old-password", newPassword: STRONG_PASSWORD, totpCode: "123456" }
      ));
    });

    it("keeps the submit button disabled until a code is entered", async () => {
      mockBackend({ enrolled: true });
      render(<SettingsPanel onPasswordChanged={onPasswordChanged} confirmAction={vi.fn()} onTotpEnrollmentStarted={vi.fn()} />);
      await openLoginPasswordSection();
      await screen.findByPlaceholderText("6-digit code");

      fillPasswordFields();
      expect((screen.getByText("Change Password") as HTMLButtonElement).disabled).toBe(true);

      fireEvent.change(screen.getByPlaceholderText("6-digit code"), { target: { value: "123456" } });
      expect((screen.getByText("Change Password") as HTMLButtonElement).disabled).toBe(false);
    });

    it("clears the code after a rejected attempt so a stale one is not resubmitted", async () => {
      mockBackend({ enrolled: true });
      mockPost.mockRejectedValue(new Error("That authenticator code was not accepted."));
      render(<SettingsPanel onPasswordChanged={onPasswordChanged} confirmAction={vi.fn()} onTotpEnrollmentStarted={vi.fn()} />);
      await openLoginPasswordSection();
      await screen.findByPlaceholderText("6-digit code");

      fillPasswordFields();
      fireEvent.change(screen.getByPlaceholderText("6-digit code"), { target: { value: "123456" } });
      fireEvent.click(screen.getByText("Change Password"));

      await waitFor(() => expect(
        (screen.getByPlaceholderText("6-digit code") as HTMLInputElement).value
      ).toBe(""));
    });
  });

  describe("recovery-code regeneration ( UI)", () => {
    it("is hidden entirely when no second factor is enrolled", async () => {
      mockBackend({ enrolled: false });
      render(<SettingsPanel onPasswordChanged={onPasswordChanged} confirmAction={vi.fn()} onTotpEnrollmentStarted={vi.fn()} />);
      await screen.findByLabelText("Expand Login Password");

      expect(screen.queryByLabelText("Expand Two-Factor Authentication")).toBeNull();
    });

    it("posts password + code, then shows the new codes behind an acknowledgment gate", async () => {
      mockBackend({ enrolled: true });
      mockPost.mockResolvedValue({ ok: true, recoveryCodes: ["aaaa-bbbb", "cccc-dddd"] } as never);
      render(<SettingsPanel onPasswordChanged={onPasswordChanged} confirmAction={vi.fn()} onTotpEnrollmentStarted={vi.fn()} />);
      fireEvent.click(await screen.findByLabelText("Expand Two-Factor Authentication"));

      fireEvent.change(screen.getByPlaceholderText("Your login password"), { target: { value: "old-password" } });
      fireEvent.change(screen.getByPlaceholderText("Current 6-digit code"), { target: { value: "654321" } });
      fireEvent.click(screen.getByText("Regenerate Recovery Codes"));

      await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
        "/api/auth/2fa/recovery-codes/regenerate",
        { currentPassword: "old-password", totpCode: "654321" }
      ));

      // Codes are displayed once, and "Done" stays disabled until acknowledged.
      expect(await screen.findByText("aaaa-bbbb")).toBeTruthy();
      const done = screen.getByText("Done") as HTMLButtonElement;
      expect(done.disabled).toBe(true);

      fireEvent.click(screen.getByRole("checkbox", { name: /saved these codes/i }));
      expect((screen.getByText("Done") as HTMLButtonElement).disabled).toBe(false);
    });

    it("surfaces a rejection and clears the code without showing any codes", async () => {
      mockBackend({ enrolled: true });
      mockPost.mockRejectedValue(new Error("Current password is incorrect."));
      render(<SettingsPanel onPasswordChanged={onPasswordChanged} confirmAction={vi.fn()} onTotpEnrollmentStarted={vi.fn()} />);
      fireEvent.click(await screen.findByLabelText("Expand Two-Factor Authentication"));

      fireEvent.change(screen.getByPlaceholderText("Your login password"), { target: { value: "wrong" } });
      fireEvent.change(screen.getByPlaceholderText("Current 6-digit code"), { target: { value: "654321" } });
      fireEvent.click(screen.getByText("Regenerate Recovery Codes"));

      await waitFor(() => expect(
        (screen.getByPlaceholderText("Current 6-digit code") as HTMLInputElement).value
      ).toBe(""));
      expect(screen.queryByText("Save your new recovery codes")).toBeNull();
    });
  });
});

describe("credential-state robustness (, , )", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // /api/auth/me is read independently of /api/settings. That await used to
  // sit outside any try/catch, so a blip there aborted refresh() before /me ran
  // and silently left the panel asserting "not enrolled" -- the  dead end
  // again, reached through a fail-open default.
  it("still learns the credential state when /api/settings fails", async () => {
    mockApi.mockImplementation((path: string) => {
      if (path === "/api/auth/me") return Promise.resolve({ secondFactorEnrolled: true } as never);
      return Promise.reject(new Error("settings unavailable"));
    });
    render(<SettingsPanel onPasswordChanged={onPasswordChanged} confirmAction={vi.fn()} onTotpEnrollmentStarted={vi.fn()} />);
    await openLoginPasswordSection();

    expect(await screen.findByPlaceholderText("6-digit code")).toBeTruthy();
  });

  // an unreadable store is "unknown", not "no". Hiding the controls is the
  // worst response -- that is exactly when the operator needs them.
  it("says so when the second-factor state is unreadable, instead of silently hiding it", async () => {
    mockBackend({ enrolled: false, unavailable: true });
    render(<SettingsPanel onPasswordChanged={onPasswordChanged} confirmAction={vi.fn()} onTotpEnrollmentStarted={vi.fn()} />);

    expect(await screen.findByText(/two-factor state could not be read/i)).toBeTruthy();
  });

  it("treats a failed /api/auth/me as unknown rather than as not-enrolled", async () => {
    mockApi.mockImplementation((path: string) => {
      if (path === "/api/auth/me") return Promise.reject(new Error("boom"));
      return Promise.resolve({ config: { port: 8088 }, publicDirectory: {}, serverConfig: {} } as never);
    });
    render(<SettingsPanel onPasswordChanged={onPasswordChanged} confirmAction={vi.fn()} onTotpEnrollmentStarted={vi.fn()} />);

    expect(await screen.findByText(/two-factor state could not be read/i)).toBeTruthy();
  });

  // authenticator apps show "123 456" and the server strips whitespace so
  // that paste validates. maxLength={6} truncated it to "123 45" before the
  // server saw it, and every rejection spent rate-limiter budget.
  it("accepts a pasted space-separated code without truncating it", async () => {
    mockBackend({ enrolled: true });
    mockPost.mockResolvedValue({ ok: true } as never);
    render(<SettingsPanel onPasswordChanged={onPasswordChanged} confirmAction={vi.fn()} onTotpEnrollmentStarted={vi.fn()} />);
    await openLoginPasswordSection();
    await screen.findByPlaceholderText("6-digit code");

    fillPasswordFields();
    fireEvent.change(screen.getByPlaceholderText("6-digit code"), { target: { value: "123 456" } });
    fireEvent.click(screen.getByText("Change Password"));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
      "/api/settings/admin-password",
      { currentPassword: "old-password", newPassword: STRONG_PASSWORD, totpCode: "123456" }
    ));
  });

  // the codes are the only copy that will ever exist. Gating their display
  // on a flag the panel's own Refresh button can flip to false destroyed them.
  it("keeps displaying regenerated codes even if the enrolled flag goes false", async () => {
    mockBackend({ enrolled: true });
    mockPost.mockResolvedValue({ ok: true, recoveryCodes: ["aaaa-bbbb", "cccc-dddd"] } as never);
    render(<SettingsPanel onPasswordChanged={onPasswordChanged} confirmAction={vi.fn()} onTotpEnrollmentStarted={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText("Expand Two-Factor Authentication"));

    fireEvent.change(screen.getByPlaceholderText("Your login password"), { target: { value: "old-password" } });
    fireEvent.change(screen.getByPlaceholderText("Current 6-digit code"), { target: { value: "654321" } });
    fireEvent.click(screen.getByText("Regenerate Recovery Codes"));
    expect(await screen.findByText("aaaa-bbbb")).toBeTruthy();

    // Simulate what Refresh does on a console whose store just became unreadable.
    mockBackend({ enrolled: false, unavailable: true });
    fireEvent.click(screen.getByText("Refresh"));

    // The codes must survive: the old sheet is already dead server-side.
    await waitFor(() => expect(screen.queryByText(/two-factor state could not be read/i)).toBeTruthy());
    expect(screen.getByText("aaaa-bbbb")).toBeTruthy();
    expect(screen.getByText("cccc-dddd")).toBeTruthy();
  });
});

// with a factor enrolled, the Login Password and Two-Factor sections used
// to render byte-identical fields -- same placeholders, same label text, and no
// id/name on any of them -- and both can be open at once. A password manager or
// iOS one-time-code autofill had nothing to tell them apart, and an operator
// typing into the visually identical field a few rows up got "enter your
// authenticator code" with a code already on screen.
//
// The suite passed before only because every test opened exactly one section.
describe("the two credential forms are distinguishable", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("keeps both sections' fields addressable when both are open", async () => {
    mockBackend({ enrolled: true });
    render(<SettingsPanel onPasswordChanged={onPasswordChanged} confirmAction={vi.fn()} onTotpEnrollmentStarted={vi.fn()} />);
    await openLoginPasswordSection();
    fireEvent.click(screen.getByLabelText("Expand Two-Factor Authentication"));

    // Would throw "Found multiple elements" if the two sections still shared
    // placeholder text -- which is precisely the regression being pinned.
    expect(screen.getByPlaceholderText("Current password")).toBeTruthy();
    expect(screen.getByPlaceholderText("Your login password")).toBeTruthy();
    expect(screen.getByPlaceholderText("6-digit code")).toBeTruthy();
    expect(screen.getByPlaceholderText("Current 6-digit code")).toBeTruthy();

    // Every credential input carries a stable id/name, so autofill and the
    // accessible name can tell the two sections apart.
    for (const id of ["settings-pw-current", "settings-pw-totp", "settings-regen-password", "settings-regen-totp"]) {
      const el = document.getElementById(id) as HTMLInputElement | null;
      expect(el, `#${id} should exist`).toBeTruthy();
      expect(el!.name).toBe(id);
    }
  });

  it("writes to only the field that was targeted", async () => {
    mockBackend({ enrolled: true });
    render(<SettingsPanel onPasswordChanged={onPasswordChanged} confirmAction={vi.fn()} onTotpEnrollmentStarted={vi.fn()} />);
    await openLoginPasswordSection();
    fireEvent.click(screen.getByLabelText("Expand Two-Factor Authentication"));

    fireEvent.change(screen.getByPlaceholderText("Current 6-digit code"), { target: { value: "111111" } });
    expect((screen.getByPlaceholderText("Current 6-digit code") as HTMLInputElement).value).toBe("111111");
    expect((screen.getByPlaceholderText("6-digit code") as HTMLInputElement).value).toBe("");
  });
});

// RecoveryCodesPanel hardcoded an <h1>. The app shell already renders one
// and the panel titles itself with an <h2>, so the settings copy emitted a
// page-level heading nested under an h2 -- an inverted outline (WCAG 1.3.1)
// that no lint in console/web would have caught. Added after a mutation test
// showed reverting the fix left the whole suite green.
describe("recovery-codes heading level", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("renders the settings copy as an h3, not a second page-level h1", async () => {
    mockBackend({ enrolled: true });
    mockPost.mockResolvedValue({ ok: true, recoveryCodes: ["aaaa-bbbb"] } as never);
    render(<SettingsPanel onPasswordChanged={onPasswordChanged} confirmAction={vi.fn()} onTotpEnrollmentStarted={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText("Expand Two-Factor Authentication"));

    fireEvent.change(screen.getByPlaceholderText("Your login password"), { target: { value: "pw" } });
    fireEvent.change(screen.getByPlaceholderText("Current 6-digit code"), { target: { value: "654321" } });
    fireEvent.click(screen.getByText("Regenerate Recovery Codes"));

    const heading = await screen.findByText("Save your new recovery codes");
    expect(heading.tagName).toBe("H3");
    expect(document.querySelectorAll("h1").length).toBe(0);
  });
});

// the catch in refreshCredentialState set only `unavailable`, leaving
// `enrolled` stale from an earlier success -- {enrolled:true, unavailable:true},
// a shape the server never emits. Both JSX gates are independent, so the panel
// rendered the "could not be read" banner AND the interactive regenerate form
// it had just declared unavailable.
//
// The existing "treats a failed /api/auth/me as unknown" test could not catch
// this: it only exercises the INITIAL MOUNT, where `enrolled` is already at its
// false initializer, so the missing reset is invisible. This primes enrolled
// first, then fails /me -- the transition is the whole point.
describe("stale credential state after a transient /me failure", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("clears enrolled when /me starts failing, instead of showing the banner beside a live form", async () => {
    mockBackend({ enrolled: true });
    render(<SettingsPanel onPasswordChanged={onPasswordChanged} confirmAction={vi.fn()} onTotpEnrollmentStarted={vi.fn()} />);
    // Prime it: the Two-Factor section is present because /me said enrolled.
    expect(await screen.findByLabelText("Expand Two-Factor Authentication")).toBeTruthy();

    // /me now fails transiently (rate limit, network blip) on a Refresh.
    mockApi.mockImplementation((path: string) => {
      if (path === "/api/auth/me") return Promise.reject(new Error("blip"));
      return Promise.resolve({ config: { port: 8088 }, publicDirectory: {}, serverConfig: {} } as never);
    });
    fireEvent.click(screen.getByText("Refresh"));

    await waitFor(() => expect(screen.queryByText(/two-factor state could not be read/i)).toBeTruthy());
    // The contradiction: the section must NOT still be offering itself.
    expect(screen.queryByLabelText("Expand Two-Factor Authentication")).toBeNull();
  });
});
