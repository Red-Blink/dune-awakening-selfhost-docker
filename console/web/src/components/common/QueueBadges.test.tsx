import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QueueBadges, queueCountsSummary, queueCountsTotal, type QueueCounts } from "./QueueBadges";

const counts: QueueCounts = { fuel: 1, water: 2, deletes: 3, vehicleDeletes: 4, permissions: 5 };
const none: QueueCounts = { fuel: 0, water: 0, deletes: 0, vehicleDeletes: 0, permissions: 0 };

describe("QueueBadges", () => {
  // Regression: these badges are inline elements, so without explicit spaces
  // the surrounding paragraph reads "1 fuel2 water" to a screen reader and to
  // anyone copying it. The CSS gap is visual only. This was a real bug before
  // the badges were extracted into this component, and the extraction lost the
  // separators again.
  it("separates adjacent badges with real whitespace, not just CSS gap", () => {
    const { container } = render(<p><QueueBadges counts={counts} />queued</p>);
    const text = container.textContent || "";
    expect(text).toContain("1 fuel 2 water");
    expect(text).toContain("2 water 3 base deletes");
    expect(text).toContain("3 base deletes 4 vehicle deletes");
    expect(text).toContain("4 vehicle deletes 5 permissions");
    expect(text).toContain("5 permissions queued");
    expect(text).not.toMatch(/\d(fuel|water|base|vehicle|permission)/);
  });

  it("keeps whitespace in the compact label-less form", () => {
    const { container } = render(<p><QueueBadges counts={counts} labels={false} />pending</p>);
    expect(container.textContent).toBe("1 2 3 4 5 pending");
  });

  it("renders only the queues that have entries", () => {
    const { container } = render(<QueueBadges counts={{ ...none, permissions: 2 }} />);
    expect(container.textContent?.trim()).toBe("2 permissions");
    expect(container.querySelectorAll(".bases-queue-badge")).toHaveLength(1);
  });

  it("singularizes a count of one", () => {
    const { container } = render(<QueueBadges counts={{ ...none, deletes: 1, permissions: 1 }} />);
    expect(container.textContent).toContain("1 base delete ");
    expect(container.textContent).toContain("1 permission ");
  });
});

describe("queueCountsSummary", () => {
  it("names only the kinds actually queued", () => {
    expect(queueCountsSummary({ ...none, fuel: 2 })).toBe("Refills");
    expect(queueCountsSummary({ ...none, water: 1, deletes: 1 })).toBe("Refills and Deletes");
  });

  // Base and vehicle deletes are two queues but one word to an operator.
  it("counts either delete queue as Deletes", () => {
    expect(queueCountsSummary({ ...none, vehicleDeletes: 1 })).toBe("Deletes");
  });

  it("comma-joins three kinds rather than chaining 'and'", () => {
    expect(queueCountsSummary(counts)).toBe("Refills, Deletes and Permissions");
  });

  it("is empty when nothing is queued", () => {
    expect(queueCountsSummary(none)).toBe("");
    expect(queueCountsTotal(none)).toBe(0);
  });

  it("totals every queue", () => {
    expect(queueCountsTotal(counts)).toBe(15);
  });
});
