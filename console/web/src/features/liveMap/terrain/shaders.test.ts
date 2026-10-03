import { describe, expect, it } from "vitest";
import { FS } from "./shaders";

describe("terrain picking shader", () => {
  it("writes the picked height before the depth-only return, after visibility clipping", () => {
    // pickAt enables both modes: prepass supplies the same masked geometry as
    // the depth pass, while pick must still write a height and a hit flag.
    const pick = FS.indexOf("if(uPick > 0.5)");
    const depthReturn = FS.indexOf("if(uPrepass > 0.5){ o = vec4(0.0); return; }");
    expect(pick).toBeGreaterThan(FS.lastIndexOf("discard;"));
    expect(depthReturn).toBeGreaterThan(pick);
    expect(FS.slice(pick, depthReturn)).toContain("vec4(vZ, 1.0, 0.0, 1.0)");
  });
});
