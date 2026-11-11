// Use the existing rotated Console container log. Never queue unbounded output
// behind a slow log driver or let diagnostic failures affect a request.
export function createDiagnosticWriter({ stream = process.stdout, now = Date.now, maxPerSecond = 200 } = {}) {
  let window = -1, written = 0, blocked = false, dropped = 0;
  function emit(record) {
    try {
      const accepted = stream.write(`${JSON.stringify(record)}\n`);
      if (accepted === false) {
        blocked = true;
        stream.once("drain", () => { blocked = false; });
      }
      return true;
    } catch {
      return false;
    }
  }
  return (record) => {
    const current = now(), nextWindow = Math.floor(current / 1000);
    if (window !== nextWindow) { window = nextWindow; written = 0; }
    if (blocked || written >= maxPerSecond) { dropped += 1; return false; }
    if (dropped) {
      const count = dropped;
      dropped = 0;
      written += 1;
      emit({ at: new Date(current).toISOString(), event: "diagnostics.dropped", count });
      if (blocked || written >= maxPerSecond) { dropped += 1; return false; }
    }
    written += 1;
    return emit(record);
  };
}

export const writeDiagnostic = createDiagnosticWriter();
