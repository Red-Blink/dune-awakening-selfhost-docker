import { describe, expect, test } from "vitest";
import { endOfLocalDayIso } from "./apiKeys";

describe("endOfLocalDayIso", () => {
  // `<input type="date">` yields "YYYY-MM-DD", which new Date() parses as UTC
  // midnight. Sending that verbatim killed the key at the START of the chosen
  // day and the list redisplayed it, in local time, as the day before.
  test("resolves a picked date to the last instant of that day, locally", () => {
    for (const picked of ["2026-09-01", "2026-02-28", "2028-02-29", "2026-12-31"]) {
      const iso = endOfLocalDayIso(picked);
      expect(iso).not.toBeNull();
      const back = new Date(iso as string);
      const roundTripped = [
        back.getFullYear(),
        String(back.getMonth() + 1).padStart(2, "0"),
        String(back.getDate()).padStart(2, "0")
      ].join("-");
      expect(roundTripped).toBe(picked);
      expect(back.getHours()).toBe(23);
      expect(back.getMinutes()).toBe(59);
    }
  });

  test("a key expiring today is still alive for the rest of today", () => {
    const now = new Date();
    const today = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0")
    ].join("-");
    expect(new Date(endOfLocalDayIso(today) as string).getTime()).toBeGreaterThan(now.getTime());
  });

  test("rejects malformed and out-of-range dates instead of rolling them over", () => {
    // new Date(2026, 12, 45) silently becomes Feb 2027 without a range check.
    for (const bad of ["", "   ", "not-a-date", "2026-13-45", "2026-02-30", "2026-00-10", "26-09-01"]) {
      expect(endOfLocalDayIso(bad)).toBeNull();
    }
  });
});
