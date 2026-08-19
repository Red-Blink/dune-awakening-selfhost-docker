import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { exchangeApi } from "../../api/exchange";
import { ExchangeConfigOverlay } from "./ExchangeConfigOverlay";

vi.mock("../../api/exchange", () => ({
  exchangeApi: { getConfig: vi.fn(), saveConfig: vi.fn() }
}));

function renderOverlay() {
  const props = { onClose: vi.fn(), onSaved: vi.fn(), onError: vi.fn() };
  render(<ExchangeConfigOverlay {...props} />);
  return props;
}

function listSection(title: string) {
  return screen.getByText(title).closest(".exchange-config-list") as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(exchangeApi.getConfig).mockResolvedValue({ includeNpcBroker: true, botOwnerIds: [], blacklistedOwnerIds: [] });
  vi.mocked(exchangeApi.saveConfig).mockImplementation(async (config) => config);
});

describe("ExchangeConfigOverlay", () => {
  it("loads and shows existing bot ids as chips", async () => {
    vi.mocked(exchangeApi.getConfig).mockResolvedValue({ includeNpcBroker: true, botOwnerIds: ["75"], blacklistedOwnerIds: [] });
    renderOverlay();

    const botList = await waitFor(() => listSection("Bot User IDs"));
    expect(await within(botList).findByText("75")).toBeInTheDocument();
  });

  it("shows the built-in in-game broker as a removable chip by default", async () => {
    renderOverlay();

    const botList = await waitFor(() => listSection("Bot User IDs"));
    expect(within(botList).getByText("In-Game Broker (Revy)")).toBeInTheDocument();
    expect(within(botList).getByLabelText("Remove In-Game Broker (Revy)")).toBeInTheDocument();
  });

  it("removes the built-in broker and saves includeNpcBroker=false, then can restore it", async () => {
    const props = renderOverlay();

    const botList = await waitFor(() => listSection("Bot User IDs"));
    fireEvent.click(within(botList).getByLabelText("Remove In-Game Broker (Revy)"));
    // A restore affordance appears once it is removed.
    const restore = within(botList).getByRole("button", { name: /Restore In-Game Broker/ });
    expect(restore).toBeInTheDocument();

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(vi.mocked(exchangeApi.saveConfig)).toHaveBeenCalledWith({ includeNpcBroker: false, botOwnerIds: [], blacklistedOwnerIds: [] }));
    expect(props.onSaved).toHaveBeenCalled();
  });

  it("adds a blacklist id and saves the merged config", async () => {
    vi.mocked(exchangeApi.getConfig).mockResolvedValue({ includeNpcBroker: true, botOwnerIds: ["75"], blacklistedOwnerIds: [] });
    const props = renderOverlay();

    await screen.findByText("75");
    const blacklist = listSection("Blacklisted IDs");
    fireEvent.change(within(blacklist).getByPlaceholderText("Add Owner ID"), { target: { value: "9929" } });
    fireEvent.click(within(blacklist).getByRole("button", { name: /Add/ }));
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(vi.mocked(exchangeApi.saveConfig)).toHaveBeenCalledWith({ includeNpcBroker: true, botOwnerIds: ["75"], blacklistedOwnerIds: ["9929"] }));
    await waitFor(() => expect(props.onSaved).toHaveBeenCalled());
    expect(props.onClose).toHaveBeenCalled();
  });

  it("strips non-numeric input and disables Add for empty values", async () => {
    renderOverlay();

    const botList = await waitFor(() => listSection("Bot User IDs"));
    const input = within(botList).getByPlaceholderText("Add Owner ID") as HTMLInputElement;
    const addButton = within(botList).getByRole("button", { name: /^Add/ });
    expect(addButton).toBeDisabled();
    // Letters are stripped by the input handler, keeping the field numeric-only.
    fireEvent.change(input, { target: { value: "1a2b3" } });
    expect(input.value).toBe("123");
  });

  it("removes a bot id chip", async () => {
    vi.mocked(exchangeApi.getConfig).mockResolvedValue({ includeNpcBroker: false, botOwnerIds: ["75"], blacklistedOwnerIds: [] });
    renderOverlay();

    await screen.findByText("75");
    fireEvent.click(screen.getByLabelText("Remove 75"));
    expect(screen.queryByText("75")).not.toBeInTheDocument();
  });
});
