import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TotpSetupScreen } from "./TotpSetupScreen";
import { post } from "../../api/client";

vi.mock("../../api/client", () => ({ post: vi.fn() }));

const SETUP_RESPONSE = { secret: "AAAAAAAAAAAAAAAA", otpauthUri: "otpauth://totp/x", qrCodeDataUri: "data:image/png;base64,AA==" };

afterEach(() => {
  vi.restoreAllMocks();
});

async function renderReadyScreen(onComplete = vi.fn(), onCancel = vi.fn()) {
  vi.mocked(post).mockResolvedValueOnce(SETUP_RESPONSE);
  render(<TotpSetupScreen mode="enroll" onComplete={onComplete} onCancel={onCancel} />);
  await screen.findByAltText(/authenticator qr code/i);
  return { onComplete, onCancel };
}

async function submitCode(value: string) {
  const codeInput = screen.getByPlaceholderText("6-digit code");
  fireEvent.change(codeInput, { target: { value } });
  fireEvent.submit(codeInput.closest("form")!);
}

describe("TotpSetupScreen", () => {
  it("calls /api/auth/2fa/setup on mount and shows the QR + manual secret", async () => {
    await renderReadyScreen();
    expect(screen.getByText("AAAAAAAAAAAAAAAA")).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith("/api/auth/2fa/setup");
  });

  it("shows the confirm error but keeps the QR/secret visible, so a mistyped code doesn't lose setup state", async () => {
    await renderReadyScreen();
    vi.mocked(post).mockRejectedValueOnce(new Error("That code was not accepted. Check your device's clock and enter the current code."));

    await submitCode("000000");

    await waitFor(() => {
      expect(screen.getByText(/that code was not accepted/i)).toBeInTheDocument();
    });
    expect(screen.getByAltText(/authenticator qr code/i)).toBeInTheDocument();
    expect(screen.getByText("AAAAAAAAAAAAAAAA")).toBeInTheDocument();
  });

  it("shows clock-skew guidance after 3 consecutive failed confirm attempts", async () => {
    await renderReadyScreen();
    vi.mocked(post).mockRejectedValue(new Error("That code was not accepted."));

    await submitCode("111111");
    await waitFor(() => expect(screen.getByText(/that code was not accepted/i)).toBeInTheDocument());
    expect(screen.queryByText(/clock/i)).not.toBeInTheDocument();

    await submitCode("222222");
    await waitFor(() => expect(screen.getByText(/that code was not accepted/i)).toBeInTheDocument());
    expect(screen.queryByText(/clock/i)).not.toBeInTheDocument();

    await submitCode("333333");
    await waitFor(() => {
      expect(screen.getByText(/clock being out of sync/i)).toBeInTheDocument();
    });
  });

  it("resets the failure count after a successful confirm (no lingering clock-skew state)", async () => {
    await renderReadyScreen();
    vi.mocked(post).mockRejectedValueOnce(new Error("wrong"));
    await submitCode("000000");
    await waitFor(() => expect(screen.getByText("wrong")).toBeInTheDocument());

    vi.mocked(post).mockResolvedValueOnce({ enrolled: true, recoveryCodes: Array.from({ length: 10 }, (_, i) => `code-${i}`) });
    await submitCode("444444");

    await waitFor(() => {
      expect(screen.getByText("Save your recovery codes")).toBeInTheDocument();
    });
  });

  it("shows all 10 recovery codes once confirm succeeds, disables Continue until acknowledged, then calls onComplete", async () => {
    const { onComplete } = await renderReadyScreen();
    const codes = Array.from({ length: 10 }, (_, i) => `aaaa-bbbb-cccc-dddd-${String(i).padStart(2, "0")}`);
    vi.mocked(post).mockResolvedValueOnce({ enrolled: true, recoveryCodes: codes });

    await submitCode("123456");

    await waitFor(() => {
      expect(screen.getByText("Save your recovery codes")).toBeInTheDocument();
    });
    for (const code of codes) expect(screen.getByText(code)).toBeInTheDocument();

    const continueButton = screen.getByText("Continue to sign in") as HTMLButtonElement;
    expect(continueButton.disabled).toBe(true);

    fireEvent.click(screen.getByLabelText(/i have saved these codes/i));
    expect(continueButton.disabled).toBe(false);

    fireEvent.click(continueButton);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("calls onCancel from the 'Back to sign in' escape hatch", async () => {
    const { onCancel } = await renderReadyScreen();
    fireEvent.click(screen.getByText(/back to sign in/i));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("shows resetup-specific copy in resetup mode", async () => {
    vi.mocked(post).mockResolvedValueOnce(SETUP_RESPONSE);
    render(<TotpSetupScreen mode="resetup" onComplete={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByAltText(/authenticator qr code/i);
    expect(screen.getByText(/no longer work/i)).toBeInTheDocument();
  });
});
