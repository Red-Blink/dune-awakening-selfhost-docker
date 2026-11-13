import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatApi, type ChatHistory } from "../../api/chat";
import { ChatPanel } from "./ChatPanel";

vi.mock("../../api/chat", () => ({ chatApi: { history: vi.fn(), save: vi.fn(), clear: vi.fn() } }));
const response = (extra: Partial<ChatHistory> = {}): ChatHistory => ({ settings: { enabled: false, retentionDays: 7 },
  state: "disabled", lastCheckedAt: null, maxRows: 5000, maxBytes: 10485760, channels: ["Map", "Guild", "Proximity"],
  canConfigure: true, rows: [], total: 0, page: 0, limit: 50, ...extra });

describe("Chat history", () => {
  beforeEach(() => { vi.resetAllMocks(); vi.mocked(chatApi.history).mockResolvedValue(response()); vi.mocked(chatApi.save).mockResolvedValue({}); vi.mocked(chatApi.clear).mockResolvedValue({}); });
  it("starts disabled and never offers whisper collection", async () => {
    render(<ChatPanel onError={vi.fn()} />);
    await screen.findByText("Collection Off");
    expect(screen.getByText("Collection Off")).toHaveClass("bad");
    fireEvent.click(screen.getByRole("button", { name: "Collection" }));
    expect(screen.getByLabelText("Collect new chat messages")).not.toBeChecked();
    expect(screen.queryByLabelText("Store private whispers")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Collect new chat messages"));
    fireEvent.click(screen.getByRole("button", { name: "Save Collection Settings" }));
    await waitFor(() => expect(chatApi.save).toHaveBeenCalledWith({ enabled: true, retentionDays: 7 }));
  });
  it("renders chat text as inert text and applies search, channel and row filters", async () => {
    vi.mocked(chatApi.history).mockResolvedValue(response({ rows: [{ id: "fixture", capturedAt: "2026-11-13T00:00:00Z", channel: "Map", sender: "Fixture", senderName: "", context: "HaggaBasin.1", text: "<img src=x onerror=alert(1)>" }], total: 1 }));
    const { container } = render(<ChatPanel onError={vi.fn()} />);
    await screen.findByText("<img src=x onerror=alert(1)>");
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>").closest("[data-no-translate]")).not.toBeNull();
    expect(screen.getByText("Fixture").closest("[data-no-translate]")).not.toBeNull();
    fireEvent.change(screen.getByLabelText("Search chat"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(chatApi.history).toHaveBeenLastCalledWith(expect.objectContaining({ q: "hello", page: 0 })));
    fireEvent.change(screen.getByLabelText("Chat rows"), { target: { value: "25" } });
    await waitFor(() => expect(chatApi.history).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 25 })));
  });
  it("does not offer whisper access or configuration without permissions", async () => {
    vi.mocked(chatApi.history).mockResolvedValue(response({ canConfigure: false }));
    render(<ChatPanel onError={vi.fn()} />);
    await screen.findByText("Collection Off");
    expect(screen.queryByRole("option", { name: "Whispers" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Collection" })).not.toBeInTheDocument();
  });
  it("requires explicit confirmation to clear all history", async () => {
    render(<ChatPanel onError={vi.fn()} />);
    await screen.findByText("Collection Off");
    fireEvent.click(screen.getByRole("button", { name: "Collection" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear History" }));
    expect(chatApi.clear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete All History" }));
    await waitFor(() => expect(chatApi.clear).toHaveBeenCalledOnce());
  });
  it("clears displayed history when access fails", async () => {
    const onError = vi.fn();
    vi.mocked(chatApi.history).mockResolvedValueOnce(response({ rows: [{ id: "fixture", capturedAt: "2026-11-13T00:00:00Z", channel: "Guild", sender: "Fixture", senderName: "", context: "", text: "stored fixture text" }], total: 1 }));
    render(<ChatPanel onError={onError} />);
    await screen.findByText("stored fixture text");
    vi.mocked(chatApi.history).mockRejectedValueOnce(new Error("Access denied"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh chat" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Access denied"));
    expect(screen.queryByText("stored fixture text")).not.toBeInTheDocument();
  });
  it("automatically replaces Connecting with the collector's current status", async () => {
    vi.useFakeTimers();
    vi.mocked(chatApi.history).mockResolvedValueOnce(response({ settings: { enabled: true, retentionDays: 7 }, state: "starting" }))
      .mockResolvedValue(response({ settings: { enabled: true, retentionDays: 7 }, state: "recording" }));
    const view = render(<ChatPanel onError={vi.fn()} />);
    try {
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByText("Connecting")).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(screen.getByText("Collecting")).toBeInTheDocument();
      expect(screen.getByText("Collecting")).toHaveClass("ok");
      expect(chatApi.history).toHaveBeenCalledTimes(2);
    } finally { view.unmount(); vi.useRealTimers(); }
  });
  it("matches Players pagination with ranges, row choices and First/Last controls", async () => {
    vi.mocked(chatApi.history).mockResolvedValue(response({ total: 125 }));
    render(<ChatPanel onError={vi.fn()} />);
    await screen.findByText("Showing 1-50 of 125");
    expect(Array.from((screen.getByLabelText("Chat rows") as HTMLSelectElement).options).map(o => o.value)).toEqual(["25", "50", "100", "200"]);
    fireEvent.click(screen.getByRole("button", { name: "Last" }));
    await screen.findByText("Page 3 of 3");
    expect(chatApi.history).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
    fireEvent.click(screen.getByRole("button", { name: "First" }));
    await screen.findByText("Page 1 of 3");
    expect(chatApi.history).toHaveBeenLastCalledWith(expect.objectContaining({ page: 0 }));
  });
});
