// dune.resourcefield_state.field_id bit-packs (x, y, z) as three 21-bit
// two's-complement fields, low to high: x = bits 0-20, y = bits 21-41,
// z = bits 42-62. Verified against 350 known field_id -> (x, y) ground-truth
// points pulled from a live position archive: 294/350 (84%) decode exactly
// right with zero false positives. Every miss is a coordinate whose
// magnitude exceeds 1,048,575 -- the max a 21-bit signed field can hold --
// and Deep Desert's real bounds reach roughly 1.27M, so the outer edge of
// the map silently wraps rather than failing loudly. There is no way to
// detect a wrapped result from field_id alone; a wrapped value looks like
// any other valid-looking coordinate. Callers that have ground truth (the
// committed position archive) should prefer it over this decode wherever
// both are available.
const AXIS_BITS = 21n;
const AXIS_MASK = (1n << AXIS_BITS) - 1n;
const AXIS_SIGN_BIT = 1n << (AXIS_BITS - 1n);
const AXIS_MODULUS = 1n << AXIS_BITS;

function unpackAxis(id, shift) {
  let value = (id >> shift) & AXIS_MASK;
  if (value >= AXIS_SIGN_BIT) value -= AXIS_MODULUS;
  return Number(value);
}

export function decodeFieldPosition(fieldIdStr) {
  const id = BigInt(fieldIdStr);
  return {
    x: unpackAxis(id, 0n),
    y: unpackAxis(id, AXIS_BITS),
    z: unpackAxis(id, AXIS_BITS * 2n)
  };
}
