// Honor explicit exclusions and quality weights rather than matching tokens
// inside a header such as "br;q=0, gzip;q=1".
export function preferredContentEncoding(header = "") {
  const weights = new Map();
  for (const part of String(header).toLowerCase().split(",")) {
    const [name, ...params] = part.trim().split(";");
    if (!name) continue;
    const quality = params.find(param => param.trim().startsWith("q="));
    const q = quality ? Number(quality.trim().slice(2)) : 1;
    weights.set(name, Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0);
  }
  const quality = name => weights.get(name) ?? weights.get("*") ?? 0;
  return ["br", "gzip"].filter(name => quality(name) > 0).sort((a, b) => quality(b) - quality(a))[0] || null;
}
