import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThemePanel } from "./ThemePanel";
import { DEFAULT_THEME_ID, THEME_STORAGE_KEY, applyTheme } from "./themeEngine";

describe("ThemePanel", () => {
  beforeEach(() => { window.localStorage.clear(); applyTheme(DEFAULT_THEME_ID); });
  afterEach(cleanup);

  it("lists Default plus every palette and marks the current one", () => {
    render(<ThemePanel />);
    expect(screen.getAllByRole("radio")).toHaveLength(20);
    expect(screen.getByRole("radio", { name: /Default/ })).toHaveAttribute("aria-checked", "true");
  });

  it("applies and stores a theme when chosen, and Escape closes", () => {
    const onClose = vi.fn();
    render(<ThemePanel onClose={onClose} />);
    fireEvent.click(screen.getByRole("radio", { name: /Amber Dunes/ }));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dd-amber-dunes");
    expect(document.documentElement.dataset.theme).toBe("dd-amber-dunes");
    expect(screen.getByRole("radio", { name: /Amber Dunes/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("arrow keys move focus without applying; Space/Enter-click chooses; Home/End jump", () => {
    render(<ThemePanel />);
    const radios = screen.getAllByRole("radio");
    expect(radios.filter((r) => r.getAttribute("tabindex") === "0")).toHaveLength(1);
    fireEvent.keyDown(radios[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(radios[1]);
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    expect(document.documentElement.dataset.theme).toBeUndefined();
    fireEvent.keyDown(radios[1], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(radios[0]);
    fireEvent.keyDown(radios[0], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(radios.at(-1));
    fireEvent.keyDown(radios[0], { key: "End" });
    expect(document.activeElement).toBe(radios.at(-1));
    fireEvent.keyDown(radios.at(-1)!, { key: "Home" });
    expect(document.activeElement).toBe(radios[0]);
    fireEvent.click(radios[2]);
    expect(radios[2]).toHaveAttribute("aria-checked", "true");
  });

  it("gives each card an accessible description", () => {
    render(<ThemePanel />);
    const radio = screen.getByRole("radio", { name: /Amber Dunes/ });
    expect(radio).toHaveAccessibleDescription(/\S/);
  });

  it("keeps the Tab trap inside the dialog even though only one radio is tabbable", () => {
    render(<ThemePanel />);
    const dialog = screen.getByRole("dialog");
    const selected = screen.getByRole("radio", { checked: true });
    selected.focus();
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    selected.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialog.querySelector('button[aria-label="Close"]'));
  });

  it("keeps Tab inside the dialog when focus was moved onto a non-selected radio with the arrow keys", () => {
    render(<ThemePanel />);
    const radios = screen.getAllByRole("radio");
    fireEvent.keyDown(radios[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(radios[1]);
    const forward = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    radios[1].dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    radios[1].focus();
    const back = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    radios[1].dispatchEvent(back);
    expect(back.defaultPrevented).toBe(true);
  });

  it("Escape closes only the picker, even if another document listener exists", () => {
    const other = vi.fn();
    document.addEventListener("keydown", other);
    const onClose = vi.fn();
    render(<ThemePanel onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    document.removeEventListener("keydown", other);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });

  it("restores focus and scrolling on close, and the close button and overlay close it", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const onClose = vi.fn();
    const { unmount } = render(<ThemePanel onClose={onClose} />);
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.mouseDown(document.querySelector(".theme-picker-overlay")!);
    expect(onClose).toHaveBeenCalledTimes(2);
    unmount();
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("follows a theme chosen in another tab while open", () => {
    render(<ThemePanel />);
    window.localStorage.setItem(THEME_STORAGE_KEY, "dd-oasis");
    fireEvent(window, new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
    expect(screen.getByRole("radio", { name: /Oasis/ })).toHaveAttribute("aria-checked", "true");
  });
});
