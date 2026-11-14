import { PermissionGate } from "../../lib/consoleAccess";
import { useEffect, useRef, useState } from "react";
import { KeyRound, RotateCcw, Trophy, Zap } from "lucide-react";
import { playersApi } from "../../api/players";
import { InlineActionResult } from "../../components/common/InlineActionResult";

type SpecializationTrackRow = {
  trackType: string;
  xp: number;
  level: number;
  keystone: boolean;
  keystoneOwned: number;
  keystoneTotal: number;
};

type ConfirmAction = (message: string, options?: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean; details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[] }) => Promise<boolean>;

type ActionResult = { key: string; tone: "success" | "danger" | "neutral"; text: string; pending?: boolean };

const DEFAULT_XP_AMOUNT = "1000";
const KEYSTONE_RESULT_KEY = "specKeystones";

function trackResultKey(trackType: string) {
  return `spec_${trackType}`;
}

function pluralKeystones(count: number) {
  return count === 1 ? "keystone" : "keystones";
}

// Keystone mutations report how many rows they touched; a zero count means the action
// succeeded but changed nothing, which needs different wording from a real change.
function countFromResult(response: { result?: Record<string, unknown> } | undefined, field: string) {
  return Math.max(0, Math.floor(Number(response?.result?.[field] ?? 0) || 0));
}

type SpecializationTabProps = {
  dbPlayerId: string;
  playerName: string;
  isOnline: boolean;
  onError: (text: string) => void;
  confirmAction: ConfirmAction;
  onSkillBaselineChange?: (baseline: Record<string, number>) => void;
  onActionLog?: (actionType: string, target: string, amount: string, notes: string) => void;
};

function KeystoneCell({ row }: { row: SpecializationTrackRow }) {
  if (row.keystone) return <span className="spec-keystone-yes"><KeyRound size={14} /> Granted</span>;
  if (row.keystoneOwned > 0) {
    return (
      <span className="spec-keystone-partial" title={`${row.keystoneOwned} of ${row.keystoneTotal} keystones purchased`}>
        <KeyRound size={14} /> {row.keystoneOwned}/{row.keystoneTotal}
      </span>
    );
  }
  return <span className="spec-keystone-no">—</span>;
}

function friendlyInlineError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function SpecializationTab({
  dbPlayerId,
  playerName,
  isOnline,
  onError,
  confirmAction,
  onSkillBaselineChange,
  onActionLog
}: SpecializationTabProps) {
  const [rows, setRows] = useState<SpecializationTrackRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [xpAmounts, setXpAmounts] = useState<Record<string, string>>({});
  const [actionResults, setActionResults] = useState<Record<string, ActionResult>>({});
  const resultTimers = useRef<Record<string, number>>({});
  const loadRequest = useRef(0);
  const activePlayerId = useRef(dbPlayerId);
  activePlayerId.current = dbPlayerId;

  useEffect(() => {
    clearResults();
    setXpAmounts({});
    void load();
  }, [dbPlayerId]);

  useEffect(() => () => clearResultTimers(), []);

  function clearResultTimers() {
    Object.values(resultTimers.current).forEach((timer) => window.clearTimeout(timer));
    resultTimers.current = {};
  }

  function clearResults() {
    clearResultTimers();
    setActionResults({});
  }

  function showResult(key: string, text: string, tone: "success" | "danger" | "neutral" = "success", pending = false) {
    setActionResults((current) => ({ ...current, [key]: { key, text, tone, pending } }));
    if (resultTimers.current[key]) window.clearTimeout(resultTimers.current[key]);
    delete resultTimers.current[key];
    if (pending) return;
    resultTimers.current[key] = window.setTimeout(() => {
      delete resultTimers.current[key];
      setActionResults((current) => {
        if (!current[key]) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    }, 8000);
  }

  function isActivePlayer(playerId: string) {
    return activePlayerId.current === playerId;
  }

  async function load(playerId = dbPlayerId) {
    const request = ++loadRequest.current;
    if (!playerId) {
      setRows([]);
      setError("");
      setLoading(false);
      onSkillBaselineChange?.({});
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await playersApi.specs(playerId);
      if (request !== loadRequest.current || !isActivePlayer(playerId)) return;
      setRows((response.rows || []).map((row) => ({
        trackType: String(row.track_type || row.trackType || ""),
        xp: Number(row.xp_amount ?? row.xp ?? 0),
        level: Math.max(0, Math.floor(Number(row.level ?? 0) || 0)),
        keystone: Boolean(row.keystone || row.has_keystone),
        keystoneOwned: Math.max(0, Math.floor(Number(row.keystone_count ?? 0) || 0)),
        keystoneTotal: Math.max(0, Math.floor(Number(row.keystone_total ?? 0) || 0))
      })).filter((row) => row.trackType));
      const learnedRows = Array.isArray(response.skillModules) ? response.skillModules as Record<string, unknown>[] : [];
      const baseline = Object.fromEntries(learnedRows.map((row) => {
        const moduleId = String(row.module_id || row.moduleId || row.id || "");
        const level = Number(row.level ?? row.rank ?? row.skill_points_spent ?? row.skillPointsSpent ?? 0);
        return [moduleId, Math.max(0, level)];
      }).filter(([moduleId, level]) => moduleId && Number(level) > 0));
      onSkillBaselineChange?.(baseline);
    } catch (err) {
      if (request !== loadRequest.current || !isActivePlayer(playerId)) return;
      setRows([]);
      setError(friendlyInlineError(err));
      onSkillBaselineChange?.({});
    } finally {
      if (request === loadRequest.current) setLoading(false);
    }
  }

  async function addXp(trackType: string) {
    const playerId = dbPlayerId;
    const amount = Number(xpAmounts[trackType] ?? DEFAULT_XP_AMOUNT) || 0;
    if (!amount) {
      showResult(trackResultKey(trackType), "Enter an XP amount first.", "danger");
      return;
    }
    if (isOnline) {
      showResult(trackResultKey(trackType), "The player must be offline for specialization changes.", "danger");
      return;
    }
    onError("");
    showResult(trackResultKey(trackType), "Updating XP", "neutral", true);
    try {
      await playersApi.addSpecializationXp(playerId, { trackType, amount, confirmation: "ADD SPECIALIZATION XP" });
      onActionLog?.("Add Specialization XP", trackType, String(amount), "Succeeded");
      if (!isActivePlayer(playerId)) return;
      showResult(trackResultKey(trackType), "XP updated. Relog required.", "success");
      await load(playerId);
    } catch (err) {
      const message = friendlyInlineError(err);
      onActionLog?.("Add Specialization XP", trackType, String(amount), `Failed: ${message}`);
      if (isActivePlayer(playerId)) showResult(trackResultKey(trackType), message, "danger");
    }
  }

  async function grantMax(trackType: string) {
    const playerId = dbPlayerId;
    if (isOnline) {
      showResult(trackResultKey(trackType), "The player must be offline for specialization changes.", "danger");
      return;
    }
    if (!(await confirmAction(`Grant max level for ${trackType} to ${playerName}? This is a high-impact action.`, {
      title: "Grant Max Specialization",
      confirmLabel: "Grant Max",
      danger: true,
      details: [{ label: "Track", value: trackType, tone: "accent" }, { label: "Player", value: playerName }]
    }))) return;
    if (!isActivePlayer(playerId)) return;
    onError("");
    showResult(trackResultKey(trackType), "Granting max level", "neutral", true);
    try {
      await playersApi.grantMaxSpecialization(playerId, { trackType, confirmation: "GRANT MAX SPECIALIZATION" });
      onActionLog?.("Grant Max Specialization", trackType, "1", "Succeeded");
      if (!isActivePlayer(playerId)) return;
      showResult(trackResultKey(trackType), "Max level granted. Relog required.", "success");
      await load(playerId);
    } catch (err) {
      const message = friendlyInlineError(err);
      onActionLog?.("Grant Max Specialization", trackType, "1", `Failed: ${message}`);
      if (isActivePlayer(playerId)) showResult(trackResultKey(trackType), message, "danger");
    }
  }

  async function resetTrack(trackType: string) {
    const playerId = dbPlayerId;
    if (isOnline) {
      showResult(trackResultKey(trackType), "The player must be offline for specialization changes.", "danger");
      return;
    }
    if (!(await confirmAction(`Reset ${trackType} specialization for ${playerName}?`, {
      title: "Reset Specialization",
      danger: true,
      details: [{ label: "Track", value: trackType, tone: "danger" }]
    }))) return;
    if (!isActivePlayer(playerId)) return;
    onError("");
    showResult(trackResultKey(trackType), "Resetting track", "neutral", true);
    try {
      await playersApi.resetSpecialization(playerId, { trackType, confirmation: "RESET SPECIALIZATION" });
      onActionLog?.("Reset Specialization", trackType, "1", "Succeeded");
      if (!isActivePlayer(playerId)) return;
      showResult(trackResultKey(trackType), "Track reset. Relog required.", "success");
      await load(playerId);
    } catch (err) {
      const message = friendlyInlineError(err);
      onActionLog?.("Reset Specialization", trackType, "1", `Failed: ${message}`);
      if (isActivePlayer(playerId)) showResult(trackResultKey(trackType), message, "danger");
    }
  }

  async function grantAllKeystones() {
    const playerId = dbPlayerId;
    if (isOnline) {
      showResult(KEYSTONE_RESULT_KEY, "The player must be offline for specialization changes.", "danger");
      return;
    }
    if (!(await confirmAction(`Grant all specialization keystones to ${playerName}? This is a high-impact action that affects all tracks.`, {
      title: "Grant All Keystones",
      confirmLabel: "Grant All",
      danger: true,
      details: [{ label: "Player", value: playerName, tone: "accent" }]
    }))) return;
    if (!isActivePlayer(playerId)) return;
    onError("");
    showResult(KEYSTONE_RESULT_KEY, "Granting keystones", "neutral", true);
    try {
      const response = await playersApi.grantAllSpecializationKeystones(playerId, "GRANT ALL KEYSTONES");
      const granted = countFromResult(response, "insertedRows");
      onActionLog?.("Grant All Keystones", playerName, String(granted), "Succeeded");
      if (!isActivePlayer(playerId)) return;
      showResult(
        KEYSTONE_RESULT_KEY,
        granted ? `${granted} ${pluralKeystones(granted)} granted. Relog required.` : "All keystones were already granted.",
        granted ? "success" : "neutral"
      );
      await load(playerId);
    } catch (err) {
      const message = friendlyInlineError(err);
      onActionLog?.("Grant All Keystones", playerName, "1", `Failed: ${message}`);
      if (isActivePlayer(playerId)) showResult(KEYSTONE_RESULT_KEY, message, "danger");
    }
  }

  async function resetAllKeystones() {
    const playerId = dbPlayerId;
    if (isOnline) {
      showResult(KEYSTONE_RESULT_KEY, "The player must be offline for specialization changes.", "danger");
      return;
    }
    if (!(await confirmAction(`Reset all specialization keystones for ${playerName}?`, {
      title: "Reset All Keystones",
      danger: true,
      details: [{ label: "Player", value: playerName, tone: "danger" }]
    }))) return;
    if (!isActivePlayer(playerId)) return;
    onError("");
    showResult(KEYSTONE_RESULT_KEY, "Resetting keystones", "neutral", true);
    try {
      const response = await playersApi.resetAllSpecializationKeystones(playerId, "RESET ALL KEYSTONES");
      const removed = countFromResult(response, "deletedRows");
      onActionLog?.("Reset All Keystones", playerName, String(removed), "Succeeded");
      if (!isActivePlayer(playerId)) return;
      showResult(
        KEYSTONE_RESULT_KEY,
        removed ? `${removed} ${pluralKeystones(removed)} reset. Relog required.` : "This player had no keystones to reset.",
        removed ? "success" : "neutral"
      );
      await load(playerId);
    } catch (err) {
      const message = friendlyInlineError(err);
      onActionLog?.("Reset All Keystones", playerName, "1", `Failed: ${message}`);
      if (isActivePlayer(playerId)) showResult(KEYSTONE_RESULT_KEY, message, "danger");
    }
  }

  // Keystone actions touch every track, so they block (and are blocked by) all rows.
  // A per-track action only locks its own row.
  const keystoneBusy = Boolean(actionResults[KEYSTONE_RESULT_KEY]?.pending);
  const anyBusy = Object.values(actionResults).some((result) => result.pending);
  const canAct = Boolean(dbPlayerId) && !isOnline;

  return (
    <section className="playerAdmin_box specialization-tab">
      <div className="specialization-header">
        <h4>Specialization Tracks</h4>
        <div className="specialization-header-actions">
          <button
            disabled={!dbPlayerId || loading}
            onClick={() => void load()}
            aria-label="Reload specializations"
          >
            {loading ? "Loading..." : "Reload"}
          </button>
          <PermissionGate action="players:grant"><button
            disabled={!canAct || anyBusy}
            onClick={() => void grantAllKeystones()}
            aria-label="Grant All Keystones"
          >
            <KeyRound size={14} /> Grant All Keystones
          </button></PermissionGate>
          <PermissionGate action="players:reset"><button
            className="danger"
            disabled={!canAct || anyBusy}
            onClick={() => void resetAllKeystones()}
            aria-label="Reset All Keystones"
          >
            <RotateCcw size={14} /> Reset All Keystones
          </button></PermissionGate>
          <InlineActionResult result={actionResults[KEYSTONE_RESULT_KEY] ?? null} resultKey={KEYSTONE_RESULT_KEY} />
        </div>
        <p className="specialization-offline-notice">
          The player must be offline for all specialization changes. A relog is required to see changes in-game.
        </p>
      </div>

      {error && <p className="playerAdmin_note danger">{error}</p>}

      <div className="playerAdmin_tableWrap playerAdmin_specializationTableWrap">
        <table className="playerAdmin_table playerAdmin_specializationTable">
          <colgroup>
            <col className="playerAdmin_specTrackCol" />
            <col className="playerAdmin_specXpCol" />
            <col className="playerAdmin_specLevelCol" />
            <col className="playerAdmin_specKeystoneCol" />
            <col className="playerAdmin_specAddXpCol" />
            <col className="playerAdmin_specActionCol" />
          </colgroup>
          <thead>
            <tr>
              <th>Track</th>
              <th>XP</th>
              <th>Level</th>
              <th>Keystone</th>
              <th>Add XP</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const resultKey = trackResultKey(row.trackType);
              const rowBusy = keystoneBusy || Boolean(actionResults[resultKey]?.pending);
              return (
              <tr key={row.trackType}>
                <td>
                  <div className="spec-track-name">
                    <Trophy size={14} className="spec-track-icon" />
                    {row.trackType}
                  </div>
                  <InlineActionResult result={actionResults[resultKey] ?? null} resultKey={resultKey} />
                </td>
                <td>{row.xp.toLocaleString()}</td>
                <td>
                  <span className={`spec-level-badge ${row.level >= 10 ? "spec-level-max" : ""}`}>
                    <Zap size={12} />
                    {row.level}
                  </span>
                </td>
                <td>
                  <KeystoneCell row={row} />
                </td>
                <td>
                  <div className="specialization-xp-control">
                    <input
                      className="playerAdmin_specXpInput"
                      type="number"
                      min="0"
                      value={xpAmounts[row.trackType] ?? DEFAULT_XP_AMOUNT}
                      onChange={(event) => setXpAmounts((current) => ({ ...current, [row.trackType]: event.target.value }))}
                      disabled={!canAct || rowBusy}
                      aria-label={`XP amount for ${row.trackType}`}
                    />
                    <PermissionGate action="players:grant"><button
                      disabled={!canAct || rowBusy}
                      onClick={() => void addXp(row.trackType)}
                      aria-label={`Add XP to ${row.trackType}`}
                    >
                      Add
                    </button></PermissionGate>
                  </div>
                </td>
                <td className="playerAdmin_actionCell">
                  <PermissionGate action="players:grant"><button
                    disabled={!canAct || rowBusy}
                    onClick={() => void grantMax(row.trackType)}
                    aria-label={`Grant Max for ${row.trackType}`}
                  >
                    Grant Max
                  </button></PermissionGate>
                  <PermissionGate action="players:reset"><button
                    className="danger"
                    disabled={!canAct || rowBusy}
                    onClick={() => void resetTrack(row.trackType)}
                    aria-label={`Reset ${row.trackType}`}
                  >
                    Reset
                  </button></PermissionGate>
                </td>
              </tr>
              );
            })}
            {!rows.length && (
              <tr>
                <td colSpan={6}>
                  {loading
                    ? "Loading specializations..."
                    : "No specialization tracks were found."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

    </section>
  );
}
