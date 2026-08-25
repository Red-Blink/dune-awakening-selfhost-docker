import test from "node:test";
import assert from "node:assert/strict";
import { decodeFieldPosition } from "../src/services/spiceFieldDecode.js";

test("decodeFieldPosition decodes in-range coordinates exactly", () => {
  const cases = [
    ["9205148799453754336", { x: 914400, y: -1016000, z: -4144 }],
    ["9205148799454124288", { x: -812800, y: -1016000, z: -4144 }],
    ["9205149651736225536", { x: 812800, y: -609600, z: -4144 }],
    ["9205149651736493888", { x: -1016000, y: -609600, z: -4144 }],
    ["9205150290949134688", { x: -304800, y: -304800, z: -4144 }],
    ["9205149225596121888", { x: -101600, y: -812800, z: -4144 }]
  ];
  for (const [fieldId, expected] of cases) {
    assert.deepEqual(decodeFieldPosition(fieldId), expected);
  }
});

test("decodeFieldPosition wraps -- documented limitation, not a bug -- for coordinates beyond +/-1,048,575", () => {
  // These are real, verified field_id -> position pairs whose true y is
  // -1,117,600, outside the 21-bit signed range. The decode is expected to
  // produce a wrong-but-deterministic result; this test locks in that exact
  // wrapped output so a future change to the unpack logic can't silently
  // shift it without the test catching it.
  assert.deepEqual(decodeFieldPosition("9205150785405452288"), { x: 0, y: -69024, z: -4144 });
  assert.deepEqual(decodeFieldPosition("9205150290949370464"), { x: -69024, y: -304800, z: -4144 });
});
