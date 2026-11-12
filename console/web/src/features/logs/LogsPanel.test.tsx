import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { logsApi } from "../../api/logs";
import { LogsPanel } from "./LogsPanel";

vi.mock("../../api/logs", () => ({ logsApi: {
  services: vi.fn().mockResolvedValue({ services: ["director", "console"] }),
  get: vi.fn(async (service: string) => ({ stdout: service === "console"
    ? '{"event":"console.request","durationMs":25}\n{"event":"memory.limit","outcome":"applied"}' : "Director log" })),
  downloadUrl: (service: string) => `/api/logs/${service}/download`
} }));
vi.mock("../../api/maps", () => ({ mapsApi: { sietchDimensions: vi.fn().mockResolvedValue({ stdout: "" }) } }));
const onError = vi.fn();
function Viewer() {
  const [service, setService] = useState("director");
  const [text, setText] = useState("");
  return <LogsPanel selectedService={service} setSelectedService={setService} text={text} setText={setText} onError={onError} />;
}

it("reads and filters Console diagnostics through the existing Logs controls", async () => {
  render(<Viewer />);
  await screen.findByRole("option", { name: "Console" });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "console" } });
  await waitFor(() => expect(logsApi.get).toHaveBeenCalledWith("console"));
  expect(await screen.findByText(/console.request/)).toHaveTextContent("memory.limit");
  expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute("href", "/api/logs/console/download");
  fireEvent.change(screen.getByPlaceholderText("Search Logs"), { target: { value: "memory.limit" } });
  await waitFor(() => expect(screen.queryByText(/console.request/)).not.toBeInTheDocument());
  expect(screen.getByText(/memory.limit/)).toBeInTheDocument();
});
