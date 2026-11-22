import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeLauncher } from "./ThemeLauncher";

// The picker is a lazy chunk; under the full parallel suite its first transform can exceed the 1 s default.
const SLOW = { timeout: 10_000 };

// Transform the lazy chunk before measuring picker interactions.
beforeAll(async () => { await import("./ThemePanel"); }, 60_000);

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.theme;
});
afterEach(() => vi.restoreAllMocks());

// Allow both the open and close waits to finish under parallel CI load.
describe("ThemeLauncher", { timeout: 30_000 }, () => {
  it("opens the lazy picker from the header button and closes it again", async () => {
    const onOpen = vi.fn();
    render(<ThemeLauncher onOpen={onOpen} />);
    const button = screen.getByRole("button", { name: "Console Theme" });
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("dialog", {}, SLOW)).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), SLOW);
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("choosing a theme through the launcher changes the page and Default restores it", async () => {
    render(<ThemeLauncher />);
    fireEvent.click(screen.getByRole("button", { name: "Console Theme" }));
    const radios = await screen.findAllByRole("radio", {}, SLOW);
    const other = radios.find((radio) => radio.getAttribute("aria-checked") === "false")!;
    fireEvent.click(other);
    expect(document.documentElement.dataset.theme).toBeTruthy();
    fireEvent.click(screen.getAllByRole("radio")[0]);
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(document.documentElement.getAttribute("style") ?? "").toBe("");
  });
});
