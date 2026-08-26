import { Droplet, Fuel, KeyRound, Trash2 } from "lucide-react";

// The four base-write queues, rendered as one row of badges.
//
// This exists because these counts belong next to every control that restarts
// a map or the battlegroup -- taking a map down is when its queued writes are
// applied -- and those surfaces had drifted apart: the Bases banner showed all
// four, the Server battlegroup note showed fuel and water only, and the Maps
// per-restart badge showed fuel alone. Adding a fifth queue should be one edit
// here, not four edits across three panels that are easy to miss.
export type QueueCounts = {
  fuel: number;
  water: number;
  deletes: number;
  permissions: number;
};

export function queueCountsTotal(counts: QueueCounts) {
  return counts.fuel + counts.water + counts.deletes + counts.permissions;
}

// "Refills, Deletes and Permissions" -- only the kinds actually queued, so a
// battlegroup with nothing but fuel waiting still reads exactly as it did
// before the other three queues existed.
export function queueCountsSummary(counts: QueueCounts) {
  const parts = [
    ...(counts.fuel > 0 || counts.water > 0 ? ["Refills"] : []),
    ...(counts.deletes > 0 ? ["Deletes"] : []),
    ...(counts.permissions > 0 ? ["Permissions"] : [])
  ];
  if (parts.length <= 2) return parts.join(" and ");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

// labels=false is the compact form used inside a per-map row, where the
// surrounding text already says what the numbers are.
export function QueueBadges({ counts, labels = true, size = 13 }: {
  counts: QueueCounts;
  labels?: boolean;
  size?: number;
}) {
  const plural = (count: number, noun: string) => `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
  return <>
    {counts.fuel > 0 && <span className="bases-queue-badge bases-queue-badge-fuel">
      <Fuel size={size} aria-hidden="true" />{labels ? `${counts.fuel.toLocaleString()} fuel` : counts.fuel.toLocaleString()}
    </span>}
    {counts.water > 0 && <span className="bases-queue-badge bases-queue-badge-water">
      <Droplet size={size} aria-hidden="true" />{labels ? `${counts.water.toLocaleString()} water` : counts.water.toLocaleString()}
    </span>}
    {counts.deletes > 0 && <span className="bases-queue-badge bases-queue-badge-delete">
      <Trash2 size={size} aria-hidden="true" />{labels ? plural(counts.deletes, "delete") : counts.deletes.toLocaleString()}
    </span>}
    {/* Counts pieces, not bases -- see childAccessPieceCount. */}
    {counts.permissions > 0 && <span className="bases-queue-badge bases-queue-badge-permission">
      <KeyRound size={size} aria-hidden="true" />{labels ? plural(counts.permissions, "permission") : counts.permissions.toLocaleString()}
    </span>}
  </>;
}
