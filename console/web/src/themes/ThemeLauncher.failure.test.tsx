import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lazyTabBoundaryInternals } from "../components/common/LazyTabBoundary";

// A stale deploy: the picker's chunk no longer exists on the server.
vi.mock("./ThemePanel", () => {
  throw new Error("Failed to fetch dynamically imported module: /assets/ThemePanel-old.js");
});

import { ThemeLauncher } from "./ThemeLauncher";

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe("ThemeLauncher when the picker chunk fails to load", () => {
  it("shows the recovery panel, leaves the page usable, and can be closed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Inside the reload cooldown, so the boundary shows its manual panel instead of reloading jsdom.
    window.sessionStorage.setItem(lazyTabBoundaryInternals.CHUNK_RELOAD_KEY, String(Date.now()));
    render(<><button>Neighbouring control</button><ThemeLauncher /></>);

    const launcher = screen.getByRole("button", { name: "Console Theme" });
    fireEvent.click(launcher);
    expect(await screen.findByRole("alert", {}, { timeout: 10_000 })).toHaveTextContent("Could not load this section.");
    expect(screen.getByRole("button", { name: "Refresh Now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Neighbouring control" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(launcher).toHaveAttribute("aria-expanded", "false");
  });
});
