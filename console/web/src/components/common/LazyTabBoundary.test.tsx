import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LazyTabBoundary, isLazyChunkLoadError, lazyTabBoundaryInternals } from "./LazyTabBoundary";

function Bomb({ message = "Failed to fetch dynamically imported module" }: { message?: string }): never {
  throw new Error(message);
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); })
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LazyTabBoundary", () => {
  it("renders children when the lazy import succeeds", () => {
    render(<LazyTabBoundary label="Loading Widget"><span>Loaded</span></LazyTabBoundary>);
    expect(screen.getByText("Loaded")).toBeInTheDocument();
  });

  it("automatically reloads once for a recognized stale chunk failure", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    const storage = memoryStorage();
    render(<LazyTabBoundary label="Loading Widget" reload={reload} storage={storage} now={() => 100_000}><Bomb /></LazyTabBoundary>);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledWith(lazyTabBoundaryInternals.CHUNK_RELOAD_KEY, "100000");
  });

  it("uses the manual fallback during the cooldown instead of reloading forever", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    const storage = memoryStorage({ [lazyTabBoundaryInternals.CHUNK_RELOAD_KEY]: "90000" });
    render(<LazyTabBoundary label="Loading Widget" reload={reload} storage={storage} now={() => 100_000}><Bomb /></LazyTabBoundary>);

    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText("Could not load this section.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh Now" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not auto-reload an ordinary render error", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    render(<LazyTabBoundary reload={reload} storage={memoryStorage()}><Bomb message="Cannot read properties of undefined" /></LazyTabBoundary>);

    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText("This section encountered an unexpected error. Refresh and try again.")).toBeInTheDocument();
  });

  it("falls back safely when session storage is unavailable", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    render(<LazyTabBoundary reload={reload} storage={null}><Bomb /></LazyTabBoundary>);

    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Refresh Now" })).toBeInTheDocument();
  });
});

describe("isLazyChunkLoadError", () => {
  it.each([
    "Failed to fetch dynamically imported module: /assets/Panel-old.js",
    "error loading dynamically imported module",
    "Importing a module script failed.",
    "Loading chunk 42 failed.",
    "Unable to preload CSS for /assets/Panel-old.css"
  ])("recognizes browser and bundler chunk failures: %s", (message) => {
    expect(isLazyChunkLoadError(new Error(message))).toBe(true);
  });

  it("does not classify ordinary application errors as chunk failures", () => {
    expect(isLazyChunkLoadError(new TypeError("Cannot read properties of undefined"))).toBe(false);
  });
});
