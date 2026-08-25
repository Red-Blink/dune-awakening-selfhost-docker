import { useCallback, useEffect, useMemo, useState } from "react";
import { basesApi, type BaseAccessLevel, type BaseChildAccessGroup, type BaseChildAccessRow } from "../../api/bases";
import { errorText } from "../permissions/rosterEditor";

type Props = {
  baseId: string;
  baseName: string;
  confirmAction: (message: string, options?: {
    title?: string;
    confirmLabel?: string;
    warning?: string;
    danger?: boolean;
    details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[];
  }) => Promise<boolean>;
  onError: (message: string) => void;
};

// permission_actor.access_level: a distinct 5-tier scale from the Sub-Fief
// roster's rank (1-3, see rosterEditor.tsx). SUB_FIEF_ACCESS_LEVEL (Associate)
// is what every top-level base actor and the overwhelming majority of child
// pieces carry -- it is the game's "matches the base's own roster" default.
const SUB_FIEF_ACCESS_LEVEL: BaseAccessLevel = 3;
const ACCESS_LEVEL_OPTIONS: BaseAccessLevel[] = [1, 2, 3, 4, 5];
const ACCESS_LEVEL_LABELS: Record<BaseAccessLevel, string> = {
  1: "Public",
  2: "Guild",
  3: "Associate",
  4: "Co-Owner",
  5: "Owner"
};

// Mirrors CHILD_ACCESS_GROUP_ORDER/CHILD_ACCESS_GROUP_LABELS in duneDb.js.
const GROUP_ORDER: BaseChildAccessGroup[] = ["storage", "refining", "crafting", "generators", "water", "pentashield", "door", "other"];
const GROUP_LABELS: Record<BaseChildAccessGroup, string> = {
  storage: "Storage",
  refining: "Refining",
  crafting: "Crafting",
  generators: "Generators",
  water: "Water Storage",
  pentashield: "Pentashield",
  door: "Door",
  other: "Other"
};

// Same native-radio segmented control as RankSegments, under its own class
// names: this is a different scale (5 levels, not 3) and must not share
// RANK_OPTIONS/RANK_LABELS.
function AccessLevelSegments({ actorId, name, level, disabled, onChange }: {
  actorId: string;
  name: string;
  level: BaseAccessLevel;
  disabled: boolean;
  onChange: (level: BaseAccessLevel) => void;
}) {
  const groupName = `child-access-level-${actorId}`;
  return (
    <div className="bases-access-segments" role="radiogroup" aria-label={`Access level for ${name}`}>
      {ACCESS_LEVEL_OPTIONS.map((option) => (
        <label className="bases-access-segment" key={option}>
          <input
            type="radio"
            name={groupName}
            value={option}
            checked={level === option}
            disabled={disabled}
            aria-label={`${ACCESS_LEVEL_LABELS[option]} for ${name}`}
            onChange={() => onChange(option)}
            onClick={() => onChange(option)}
          />
          <span aria-hidden="true">{ACCESS_LEVEL_LABELS[option]}</span>
        </label>
      ))}
    </div>
  );
}

export function BaseChildPermissionsTab({ baseId, baseName, confirmAction, onError }: Props) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [supported, setSupported] = useState(true);
  const [reason, setReason] = useState("");
  const [rows, setRows] = useState<BaseChildAccessRow[]>([]);
  const [saved, setSaved] = useState<Record<string, BaseAccessLevel>>({});
  const [draft, setDraft] = useState<Record<string, BaseAccessLevel>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [typeFilter, setTypeFilter] = useState("all");
  const [applyLevel, setApplyLevel] = useState<BaseAccessLevel>(SUB_FIEF_ACCESS_LEVEL);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [statusKind, setStatusKind] = useState<"" | "ok" | "fail">("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const result = await basesApi.childAccess(baseId);
      setSupported(result.supported);
      setReason(result.reason || "");
      setRows(result.rows);
      const levels: Record<string, BaseAccessLevel> = {};
      for (const row of result.rows) levels[row.actorId] = row.currentAccess;
      setSaved(levels);
      setDraft(levels);
      setSelected(new Set());
      setTypeFilter("all");
    } catch (error) {
      setLoadError(errorText(error));
    } finally {
      setLoading(false);
    }
  }, [baseId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!status || statusKind !== "ok") return undefined;
    const retire = window.setTimeout(() => {
      setStatus("");
      setStatusKind("");
    }, 10_400);
    return () => window.clearTimeout(retire);
  }, [status, statusKind]);

  const dirty = rows.some((row) => draft[row.actorId] !== saved[row.actorId]);
  const deviatingCount = rows.filter((row) => !row.isSubFief).length;

  // Only the master categories are selectable, not individual building
  // types -- one option per category actually present among this base's
  // pieces, in GROUP_ORDER.
  const presentGroups = useMemo(() => {
    const present = new Set(rows.map((row) => row.group));
    return GROUP_ORDER.filter((group) => present.has(group));
  }, [rows]);
  const visibleRows = useMemo(
    () => typeFilter === "all" ? rows : rows.filter((row) => row.group === typeFilter),
    [rows, typeFilter]
  );
  const visibleIds = useMemo(() => visibleRows.map((row) => row.actorId), [visibleRows]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  function changeLevel(actorId: string, level: BaseAccessLevel) {
    setDraft((current) => ({ ...current, [actorId]: level }));
  }

  // Acts on every currently checked row regardless of the type filter --
  // once a piece is checked it stays part of the batch even if you narrow
  // the filter afterward, matching normal filtered-table behavior.
  function applyLevelToSelected(level: BaseAccessLevel) {
    if (!selected.size) return;
    setDraft((current) => {
      const next = { ...current };
      for (const actorId of selected) next[actorId] = level;
      return next;
    });
  }

  function toggleSelected(actorId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(actorId)) next.delete(actorId); else next.add(actorId);
      return next;
    });
  }

  // Selects (or clears) only the rows the current type filter is showing --
  // a hidden row that was already checked stays checked, and this never
  // reaches into pieces the filter has hidden.
  function toggleSelectAll() {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of visibleIds) {
        if (allVisibleSelected) next.delete(id); else next.add(id);
      }
      return next;
    });
  }

  async function save() {
    const updates = rows
      .filter((row) => draft[row.actorId] !== saved[row.actorId])
      .map((row) => ({ actorId: row.actorId, accessLevel: draft[row.actorId] }));
    if (!updates.length) return;
    const confirmed = await confirmAction(
      `Apply access level changes to ${updates.length} ${updates.length === 1 ? "piece" : "pieces"} on ${baseName}?`,
      {
        title: "Set Base Permissions",
        confirmLabel: "Save Changes",
        warning: "Changes reach the running map immediately.",
        details: updates.slice(0, 8).map((entry) => {
          const row = rows.find((candidate) => candidate.actorId === entry.actorId);
          return { label: row?.name || entry.actorId, value: ACCESS_LEVEL_LABELS[entry.accessLevel], tone: "accent" as const };
        })
      }
    );
    if (!confirmed) return;
    setSaving(true);
    setStatus("");
    setStatusKind("");
    try {
      const response = await basesApi.setChildAccess(baseId, updates);
      setStatus(response.result?.message || "Access levels were updated.");
      setStatusKind("ok");
      await load();
    } catch (error) {
      onError(errorText(error));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="muted" role="status">Loading base permissions…</p>;
  }
  if (loadError) {
    return <p className="bases-permissions-error" role="alert">
      {loadError} <button onClick={() => void load()}>Retry</button>
    </p>;
  }

  return (
    <div className="bases-permissions" onClick={(event) => event.stopPropagation()}>
      <div className="bases-permissions-content">
        <p className="action-help-note">
          Every piece on this base is listed below with its current access
          level. Pieces normally match this base's Sub-Fief (Associate)
          default. Pick a level for any piece, then save -- changes reach the
          running map immediately.
        </p>

        {!supported && <p className="muted">{reason || "Base permission auditing is unavailable for this database."}</p>}

        {supported && rows.length === 0 && <p className="bases-child-access-clean">This base has no doors or devices with their own access level.</p>}

        {supported && rows.length > 0 && <>
          <div className="bases-child-access-head">
            <div>
              <span className="bases-permissions-section-title">Pieces · {rows.length}</span>
              {deviatingCount > 0 && <span className="bases-permissions-section-meta">{deviatingCount} not Sub-Fief</span>}
            </div>
          </div>

          <div className="bases-child-access-actions">
            <label className="compact-select">
              Type
              <select value={typeFilter} disabled={saving} onChange={(event) => setTypeFilter(event.target.value)}>
                <option value="all">All Types</option>
                {presentGroups.map((group) => <option key={group} value={group}>{GROUP_LABELS[group]}</option>)}
              </select>
            </label>
            <button disabled={saving} onClick={toggleSelectAll}>
              {allVisibleSelected ? "Clear" : "Select All"}
            </button>
            <label className="compact-select">
              Apply
              <select value={String(applyLevel)} disabled={saving} onChange={(event) => setApplyLevel(Number(event.target.value) as BaseAccessLevel)}>
                {ACCESS_LEVEL_OPTIONS.map((level) => <option key={level} value={level}>{ACCESS_LEVEL_LABELS[level]}</option>)}
              </select>
            </label>
            <button className="warning" disabled={saving || selected.size === 0} onClick={() => applyLevelToSelected(applyLevel)}>
              Apply to Selected
            </button>
          </div>

          <div className="bases-child-access-list">
            {/* A plain div, not a <label>: AccessLevelSegments nests its own
                <label>s for the radio segments, and a label wrapping other
                labels double-fires on click (the outer label's implicit
                checkbox toggle plus whichever segment was actually clicked).
                The checkbox gets an explicit aria-label instead. */}
            {visibleRows.map((row) => (
              <div className={`bases-child-access-row${row.isSubFief ? "" : " unusual"}`} key={row.actorId}>
                <input
                  type="checkbox"
                  checked={selected.has(row.actorId)}
                  disabled={saving}
                  aria-label={`Select ${row.name}`}
                  onChange={() => toggleSelected(row.actorId)}
                />
                <span className="bases-child-access-name">
                  <strong title={row.buildingType}>{row.name}</strong>
                </span>
                <AccessLevelSegments
                  actorId={row.actorId}
                  name={row.name}
                  level={draft[row.actorId]}
                  disabled={saving}
                  onChange={(level) => changeLevel(row.actorId, level)}
                />
              </div>
            ))}
          </div>
        </>}

        {(dirty || status) && <div className="bases-permissions-banner-slot">
          {dirty && <p className="confirm-modal-warning bases-permissions-warning" role="status">
            Saving writes to the live database and notifies the running map server.
          </p>}
          {status && <p
            className={`inline-task-result${statusKind ? ` result-${statusKind}` : ""}`}
            role={statusKind === "fail" ? "alert" : "status"}
            onAnimationEnd={() => {
              if (statusKind !== "ok") return;
              setStatus("");
              setStatusKind("");
            }}
          >
            <strong>{status}</strong>
          </p>}
        </div>}

        {supported && rows.length > 0 && <div className="bases-permissions-actions">
          <span className="muted">{dirty ? "Unsaved changes" : ""}</span>
          <button disabled={!dirty || saving} onClick={() => setDraft(saved)}>Revert</button>
          <button className="update-action" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>}
      </div>
    </div>
  );
}
