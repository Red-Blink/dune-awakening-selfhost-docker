import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { EncryptedApiSection } from "./EncryptedApiSection";

vi.mock("../../api/client", () => ({ api: vi.fn(), post: vi.fn() }));
vi.mock("../../lib/clipboard", () => ({ copyText: vi.fn().mockResolvedValue(undefined) }));

import { api, post } from "../../api/client";
import { copyText } from "../../lib/clipboard";

const mockedApi = vi.mocked(api);
const mockedPost = vi.mocked(post);
const PIN = `sha256/${"B".repeat(43)}`;

function status(over: Record<string, unknown> = {}) {
  return { available: true, enabled: true, running: true, state: "running", health: "healthy", port: 8797, fingerprint: PIN, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.mockResolvedValue(status());
});

test("shows status, address and the key fingerprint, and copies it", async () => {
  render(<EncryptedApiSection />);
  expect(await screen.findByText("Running")).toBeVisible();
  expect(screen.getByLabelText(/key fingerprint of the encrypted api access/i)).toHaveValue(PIN);
  expect(screen.getByText(`https://${window.location.hostname}:8797`)).toBeVisible();
  expect(screen.getByRole("checkbox", { name: /encrypted api access/i })).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: /copy/i }));
  await waitFor(() => expect(copyText).toHaveBeenCalledWith(PIN));
  expect(await screen.findByRole("button", { name: /copied/i })).toBeVisible();
});

test("an installation without the feature says so and offers no switch", async () => {
  mockedApi.mockResolvedValue(status({ available: false, enabled: false, running: false, fingerprint: "" }));
  render(<EncryptedApiSection />);
  expect(await screen.findByText("Not Available")).toBeVisible();
  expect(screen.getByText(/does not include the encrypted API access/i)).toBeVisible();
  expect(screen.queryByRole("checkbox")).toBeNull();
});

test("switching it on starts it and then shows the new fingerprint", async () => {
  mockedApi.mockResolvedValue(status({ enabled: false, running: false, state: "", health: "", fingerprint: "" }));
  mockedPost.mockResolvedValue(status());
  render(<EncryptedApiSection />);
  expect(await screen.findByText("Off")).toBeVisible();
  expect(screen.queryByLabelText(/key fingerprint/i)).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: /encrypted api access/i }));
  await waitFor(() => expect(mockedPost).toHaveBeenCalledWith("/api/settings/encrypted-api", { enabled: true }));
  expect(await screen.findByLabelText(/key fingerprint/i)).toHaveValue(PIN);
  expect(await screen.findByText(/Encrypted API access is on/i)).toBeVisible();
});

test("a failed start is reported and the section stays usable", async () => {
  mockedApi.mockResolvedValue(status({ enabled: false, running: false, fingerprint: "" }));
  mockedPost.mockRejectedValue(new Error("The encrypted API access could not be started."));
  render(<EncryptedApiSection />);
  fireEvent.click(await screen.findByRole("checkbox", { name: /encrypted api access/i }));
  expect(await screen.findByText(/could not be started/i)).toBeVisible();
  expect(screen.getByRole("checkbox", { name: /encrypted api access/i })).not.toBeDisabled();
});
