import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThemePanel } from "./ThemePanel";
import { DEFAULT_THEME_ID, THEME_STORAGE_KEY, applyTheme } from "./themeEngine";

describe("ThemePanel", () => {
  beforeEach(() => { window.localStorage.clear(); applyTheme(DEFAULT_THEME_ID); });
  afterEach(cleanup);

  it("lists Default plus every palette and marks the current one", () => {
    render(<ThemePanel />);
    expect(screen.getAllByRole("radio")).toHaveLength(66);
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
  it("groups the palettes under headings, each section sorted by name", () => {
    render(<ThemePanel />);
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Console palettes", "Dune factions", "Houses", "Outfits and dyes"]);
    const names = screen.getAllByRole("radio").map((r) => r.textContent ?? "");
    expect(names.indexOf("Harkonnen")).toBeLessThan(names.indexOf("House Alexin"));
    expect(names.indexOf("House Wydras")).toBeLessThan(names.indexOf("Blue Dasher"));
    const houses = names.slice(names.indexOf("House Alexin"), names.indexOf("House Wydras") + 1);
    expect(houses).toEqual([...houses].sort((a, b) => a.localeCompare(b)));
    expect(houses).toHaveLength(27);
  });

  it("numbers every radio in the order it appears", () => {
    render(<ThemePanel />);
    const radios = screen.getAllByRole("radio");
    radios.forEach((radio, index) => {
      expect(radio).toHaveAttribute("aria-posinset", String(index + 1));
      expect(radio).toHaveAttribute("aria-setsize", String(radios.length));
    });
  });

  it("arrow keys follow the on-screen order across section boundaries", () => {
    render(<ThemePanel />);
    const radios = screen.getAllByRole("radio");
    // Every step lands on the next rendered card, including the last card of one section into the first of the next.
    radios.forEach((radio, index) => {
      fireEvent.keyDown(radio, { key: "ArrowRight" });
      expect(document.activeElement, radio.textContent ?? "").toBe(radios[(index + 1) % radios.length]);
      fireEvent.keyDown(radios[(index + 1) % radios.length], { key: "ArrowLeft" });
      expect(document.activeElement).toBe(radio);
    });
    fireEvent.keyDown(radios[5], { key: "End" });
    expect(document.activeElement).toBe(radios.at(-1));
    fireEvent.keyDown(radios[5], { key: "Home" });
    expect(document.activeElement).toBe(radios[0]);
  });

  it("filters by palette or section name, keeps the applied choice listed, and reports no matches", () => {
    render(<ThemePanel />);
    const filter = screen.getByRole("searchbox", { name: "Filter palettes" });
    expect(screen.getByRole("status")).toHaveTextContent("66 palettes");
    fireEvent.change(filter, { target: { value: "sardaukar" } });
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["Default", "Sardaukar Imperial", "Sardaukar Tactical"]);
    expect(screen.getByRole("status")).toHaveTextContent("2 of 66 palettes");
    fireEvent.change(filter, { target: { value: "outfits" } });
    expect(screen.getAllByRole("radio")).toHaveLength(16);
    fireEvent.change(filter, { target: { value: "zzzz" } });
    expect(screen.getByRole("status")).toHaveTextContent("No other palettes match.");
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["Default"]);
    expect(screen.getByRole("radio", { name: /Default/ })).toHaveAttribute("aria-checked", "true");
  });

  it("keeps the filtered list navigable: Home, End and wrap stay inside what is shown", () => {
    render(<ThemePanel />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter palettes" }), { target: { value: "sardaukar" } });
    const radios = screen.getAllByRole("radio");
    fireEvent.keyDown(radios[0], { key: "End" });
    expect(document.activeElement).toBe(radios[2]);
    fireEvent.keyDown(radios[2], { key: "ArrowRight" });
    expect(document.activeElement).toBe(radios[0]);
    fireEvent.keyDown(radios[0], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(radios[2]);
  });

  it("pins the applied palette while filtering and hands the choice to the one clicked", () => {
    render(<ThemePanel />);
    fireEvent.click(screen.getByRole("radio", { name: /Sunset Dye/ }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter palettes" }), { target: { value: "alexin" } });
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["House Alexin", "Sunset Dye"]);
    expect(screen.getByRole("radio", { name: /Sunset Dye/ })).toHaveAttribute("aria-checked", "true");
  });

  it("shows a swatch palette's own dye colours and a console palette's four colours on its card", () => {
    render(<ThemePanel />);
    const boxes = (name: RegExp) => [...screen.getByRole("radio", { name }).querySelectorAll<HTMLElement>(".theme-swatches i")].map((i) => i.style.background);
    expect(boxes(/House Alexin/)).toEqual(["rgb(89, 55, 48)", "rgb(188, 171, 149)", "rgb(210, 165, 82)", "rgb(149, 149, 149)"]);
    expect(boxes(/Amber Dunes/)).toHaveLength(4);
    expect(boxes(/Amber Dunes/)[0]).toBe("rgb(23, 18, 15)");
  });

  it("Escape in the filter box clears it first, then closes on the next press", () => {
    const onClose = vi.fn();
    render(<ThemePanel onClose={onClose} />);
    const filter = screen.getByRole("searchbox", { name: "Filter palettes" }) as HTMLInputElement;
    fireEvent.change(filter, { target: { value: "house" } });
    filter.focus();
    fireEvent.keyDown(filter, { key: "Escape" });
    expect(filter.value).toBe("");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(filter, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps Tab inside the dialog from the filter box and from the last control", () => {
    render(<ThemePanel />);
    const dialog = screen.getByRole("dialog");
    const close = dialog.querySelector<HTMLElement>('button[aria-label="Close"]')!;
    const filter = screen.getByRole("searchbox", { name: "Filter palettes" });
    const selected = screen.getByRole("radio", { checked: true });
    filter.focus();
    const back = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    filter.dispatchEvent(back);
    expect(back.defaultPrevented).toBe(false); // the filter is neither first nor last: the browser moves to the close button
    close.focus();
    const wrap = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    close.dispatchEvent(wrap);
    expect(wrap.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(selected);
  });
});
