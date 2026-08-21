import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { LazyTabBoundary } from "./LazyTabBoundary";

function Bomb(): never {
  throw new Error("Failed to fetch dynamically imported module");
}

describe("LazyTabBoundary", () => {
  it("renders children when the lazy import succeeds", () => {
    render(<LazyTabBoundary label="Loading Widget"><span>Loaded</span></LazyTabBoundary>);
    expect(screen.getByText("Loaded")).toBeTruthy();
  });

  it("shows a manual refresh option instead of crashing when a lazy chunk fails to load", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<LazyTabBoundary label="Loading Widget"><Bomb /></LazyTabBoundary>);
    expect(screen.getByText("Could not load this section.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh Now" })).toBeTruthy();
    spy.mockRestore();
  });
});
