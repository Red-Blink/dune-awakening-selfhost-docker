import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { bearingName, LiveMapCompass, viewBearing } from "./LiveMapCompass";

const deg = (d: number) => (d * Math.PI) / 180;

describe("viewBearing", () => {
  it("reads the yaw as degrees clockwise from north, wrapped to 0..360", () => {
    expect(viewBearing(0)).toBe(0);
    expect(viewBearing(deg(90))).toBeCloseTo(90, 9);
    expect(viewBearing(deg(-90))).toBeCloseTo(270, 9);
    expect(viewBearing(deg(725))).toBeCloseTo(5, 9);
  });

  it("names the nearest of the eight points", () => {
    expect(bearingName(0)).toBe("N");
    expect(bearingName(22)).toBe("N");
    expect(bearingName(23)).toBe("NE");
    expect(bearingName(180)).toBe("S");
    expect(bearingName(350)).toBe("N");
  });
});

describe("LiveMapCompass", () => {
  it("turns the needle against the view", () => {
    const { container } = render(<LiveMapCompass yaw={deg(90)} onFaceNorth={() => {}} />);
    const button = screen.getByRole("button", { name: /Facing E \(90°\)/ });
    const needle = container.querySelector(".needle-north")!.parentElement!;
    expect(needle.getAttribute("transform")).toBe("rotate(-90)");
    // Facing east, north is to the left: the N sits left of centre, level with it.
    const north = [...button.querySelectorAll("text")].find((t) => t.textContent === "N")!;
    expect(Number(north.getAttribute("x"))).toBeCloseTo(-20, 9);
    expect(Number(north.getAttribute("y"))).toBeCloseTo(0, 9);
  });

  it("faces north when clicked", () => {
    const onFaceNorth = vi.fn();
    render(<LiveMapCompass yaw={deg(200)} onFaceNorth={onFaceNorth} />);
    fireEvent.click(screen.getByRole("button", { name: /Facing S \(200°\)/ }));
    expect(onFaceNorth).toHaveBeenCalledTimes(1);
  });
});
