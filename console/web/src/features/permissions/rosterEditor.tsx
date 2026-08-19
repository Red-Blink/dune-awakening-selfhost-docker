import { TriangleAlert } from "lucide-react";

// rank 1/2/3 = Owner/Co-Owner/Associate, confirmed in both directions against a
// live server: the game's own Permissions panel writes exactly these values.
// The 5/4/3 badges the game UI shows beside those labels are decoration, not
// ranks -- no row in permission_actor_rank ever holds a 4 or 5. Shared by
// bases and vehicles: both are permission_actor_rank actors with identical
// rank semantics, just different id spaces.
export type PermissionRank = 1 | 2 | 3;

export type PermissionEntry = {
  playerId: string;
  name: string;
  rank: PermissionRank;
  label: string;
  canonical: boolean;
};

export const OWNER_RANK: PermissionRank = 1;
export const CO_OWNER_RANK: PermissionRank = 2;
export const ASSOCIATE_RANK: PermissionRank = 3;

export const RANK_LABELS: Record<PermissionRank, string> = {
  1: "Owner",
  2: "Co-Owner",
  3: "Associate"
};

export const RANK_OPTIONS: PermissionRank[] = [OWNER_RANK, CO_OWNER_RANK, ASSOCIATE_RANK];

// `label` is the server's own rendering of the rank ("Owner", or "Rank 7" for
// anything outside 1-3). Carried through so a rank the segmented control cannot
// represent is still readable on screen -- see unknownRankLabel.
export type DraftEntry = { playerId: string; name: string; rank: PermissionRank; canonical: boolean; label: string };

export function toDraft(entries: PermissionEntry[]): DraftEntry[] {
  return entries.map((entry) => ({
    playerId: entry.playerId,
    name: entry.name,
    rank: entry.rank,
    canonical: entry.canonical,
    label: entry.label || ""
  }));
}

export function sortDraft(entries: DraftEntry[]) {
  return [...entries].sort((left, right) => left.rank - right.rank || left.name.localeCompare(right.name));
}

export function sameRoster(left: DraftEntry[], right: DraftEntry[]) {
  if (left.length !== right.length) return false;
  const rightByPlayer = new Map(right.map((entry) => [entry.playerId, entry.rank]));
  return left.every((entry) => rightByPlayer.get(entry.playerId) === entry.rank);
}

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// "1 co-owner, 4 associates", skipping whichever count is zero so a roster
// shared with associates only does not advertise "0 co-owners". Empty when
// nobody is on the roster -- the caller drops the element rather than
// rendering "". `other` covers rows the game stored outside rank 1-3 plus any
// duplicate Owner; they are real roster members and have to be counted, but
// calling them Associates would put a rank on them that nobody chose.
export function formatShareBreakdown(coOwners: number, associates: number, other = 0) {
  const parts: string[] = [];
  if (coOwners) parts.push(plural(coOwners, "co-owner"));
  if (associates) parts.push(plural(associates, "associate"));
  if (other) parts.push(`${other} of another rank`);
  return parts.join(", ");
}

// The three segments cover rank 1-3 only. Anything else the game stored has no
// segment to check, so the control would render blank with no way to read the
// real rank -- show it instead of silently dropping it.
export function unknownRankLabel(entry: DraftEntry) {
  if (RANK_OPTIONS.includes(entry.rank)) return "";
  return entry.label || `Rank ${entry.rank}`;
}

// Shared by the Owner display and the roster rows so the custodian pill and
// the ignored-entry warning follow a player between the two as their rank
// changes, instead of being duplicated in both places and drifting apart.
// isSystemCustodian defaults to false: vehicles have no system custodian
// concept, so their Owner display never passes it.
export function EntryName({ entry, isSystemCustodian = false, className }: {
  entry: DraftEntry;
  isSystemCustodian?: boolean;
  className: string;
}) {
  return (
    <span className={className} title={entry.name || entry.playerId}>
      {entry.name || `Player ${entry.playerId}`}
      {unknownRankLabel(entry) && <span
        className="bases-permissions-rank-unknown"
        title="The game stored a rank this editor cannot represent. Changing it below replaces it with the rank you pick."
      >{unknownRankLabel(entry)}</span>}
      {isSystemCustodian && <span className="bases-permissions-system-label">System Custodian</span>}
      {!entry.canonical && <span className="bases-permissions-orphan" title="This entry does not match a known player character, so the game ignores it. Removing it is safe.">
        <TriangleAlert size={13} aria-label="Ignored by the game" />
      </span>}
    </span>
  );
}

// Native radios rather than aria-pressed buttons: the browser supplies arrow-key
// navigation and a single roving tab stop per group for free, so a five-member
// roster costs five tab stops before Save instead of fifteen. aria-pressed would
// also announce "toggle, pressed" with no set position, which is wrong for one
// mutually exclusive value.
export function RankSegments({ entry, scopeId, disabled, onChange, groupClassName = "bases-rank-segments", segmentClassName = "bases-rank-segment" }: {
  entry: DraftEntry;
  scopeId: string;
  disabled: boolean;
  onChange: (rank: PermissionRank) => void;
  // Bases and vehicles style this control through separate class names (see
  // styles.css) even though the rules are identical today, so each feature can
  // diverge later without touching the other. Defaults keep the base tab's
  // existing markup unchanged.
  groupClassName?: string;
  segmentClassName?: string;
}) {
  const who = entry.name || entry.playerId;
  // scopeId is in the group name so two rosters rendered at once (a base tab
  // and a vehicle tab, say) could never merge two players' radios into one
  // browser group, where selecting in one row would silently clear the other.
  const groupName = `permissions-rank-${scopeId}-${entry.playerId}`;
  return (
    <div className={groupClassName} role="radiogroup" aria-label={`Rank for ${who}`}>
      {RANK_OPTIONS.map((rank) => (
        <label className={segmentClassName} key={rank}>
          <input
            type="radio"
            name={groupName}
            value={rank}
            checked={entry.rank === rank}
            disabled={disabled}
            // Full rank word in the accessible name, abbreviation on screen.
            // Each abbreviation is a prefix of the full label, so the
            // label-in-name requirement still holds for voice control.
            aria-label={`${RANK_LABELS[rank]} for ${who}`}
            onChange={() => onChange(rank)}
            // Clicking an already-checked radio fires no change event, which
            // would strand a roster carrying two rank-1 rows: the duplicate's
            // "Own" segment renders checked, so the click that is supposed to
            // demote the other Owner would do nothing. onChange is still what
            // arrow-key navigation fires, so both are needed. changeRank is
            // idempotent for a rank the entry already holds.
            onClick={() => onChange(rank)}
          />
          <span aria-hidden="true">{RANK_LABELS[rank]}</span>
        </label>
      ))}
    </div>
  );
}
