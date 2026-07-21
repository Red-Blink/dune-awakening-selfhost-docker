import { useEffect, useRef, useState } from "react";
import { KeyRound, RotateCcw, Trophy, Zap } from "lucide-react";
import { playersApi } from "../../api/players";
import { InlineActionResult } from "../../components/common/InlineActionResult";

type SpecializationTrackRow = { trackType: string; xp: number; level: number; keystone?: boolean };

type ConfirmAction = (message: string, options?: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean; details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[] }) => Promise<boolean>;

type ActionResult = { key: string; tone: "success" | "danger" | "neutral"; text: string; pending?: boolean };

type SpecializationTabProps = {
  dbPlayerId: string;
  playerName: string;
  isOnline: boolean;
  onError: (text: string) => void;
  confirmAction: ConfirmAction;
  onSkillBaselineChange?: (baseline: Record<string, number>) => void;
  onActionLog?: (actionType: string, target: string, amount: string, notes: string) => void;
};

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
  const [xpAmount, setXpAmount] = useState("1000");
  const [actionResult, setActionResult] = useState<ActionResult | null>(null);
  const resultTimer = useRef<number | null>(null);
  const loadRequest = useRef(0);

  useEffect(() => {
    void load();
  }, [dbPlayerId]);

  useEffect(() => () => { if (resultTimer.current) window.clearTimeout(resultTimer.current); }, []);

  function showResult(key: string, text: string, tone: "success" | "danger" | "neutral" = "success", pending = false) {
    setActionResult({ key, text, tone, pending });
    if (resultTimer.current) window.clearTimeout(resultTimer.current);
    resultTimer.current = null;
    if (!pending) resultTimer.current = window.setTimeout(() => setActionResult(null), 8000);
  }

  async function load() {
    const request = ++loadRequest.current;
    if (!dbPlayerId) {
      setRows([]);
      setError("");
      setLoading(false);
      onSkillBaselineChange?.({});
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await playersApi.specs(dbPlayerId);
      if (request !== loadRequest.current) return;
      setRows((response.rows || []).map((row) => ({
        trackType: String(row.track_type || row.trackType || ""),
        xp: Number(row.xp_amount ?? row.xp ?? 0),
        level: Math.max(0, Math.floor(Number(row.level ?? 0) || 0)),
        keystone: Boolean(row.keystone || row.has_keystone)
      })).filter((row) => row.trackType));
      const learnedRows = Array.isArray(response.skillModules) ? response.skillModules as Record<string, unknown>[] : [];
      const baseline = Object.fromEntries(learnedRows.map((row) => {
        const moduleId = String(row.module_id || row.moduleId || row.id || "");
        const level = Number(row.level ?? row.rank ?? row.skill_points_spent ?? row.skillPointsSpent ?? 0);
        return [moduleId, Math.max(0, level)];
      }).filter(([moduleId, level]) => moduleId && Number(level) > 0));
      onSkillBaselineChange?.(baseline);
    } catch (err) {
      if (request !== loadRequest.current) return;
      setRows([]);
      setError(friendlyInlineError(err));
      onSkillBaselineChange?.({});
    } finally {
      if (request === loadRequest.current) setLoading(false);
    }
  }

  async function addXp(trackType: string) {
    const amount = Number(xpAmount) || 0;
    if (!amount) {
      showResult(`spec_${trackType}`, "Enter an XP amount first.", "danger");
      return;
    }
    if (isOnline) {
      showResult(`spec_${trackType}`, "The player must be offline for specialization changes.", "danger");
      return;
    }
    onError("");
    showResult(`spec_${trackType}`, "Updating XP", "neutral", true);
    try {
      await playersApi.addSpecializationXp(dbPlayerId, { trackType, amount, confirmation: "ADD SPECIALIZATION XP" });
      showResult(`spec_${trackType}`, "XP updated. Relog required.", "success");
      onActionLog?.("Add Specialization XP", trackType, String(amount), "Succeeded");
      await load();
    } catch (err) {
      const message = friendlyInlineError(err);
      showResult(`spec_${trackType}`, message, "danger");
      onActionLog?.("Add Specialization XP", trackType, String(amount), `Failed: ${message}`);
    }
  }

  async function grantMax(trackType: string) {
    if (isOnline) {
      showResult(`spec_${trackType}`, "The player must be offline for specialization changes.", "danger");
      return;
    }
    if (!(await confirmAction(`Grant max level for ${trackType} to ${playerName}? This is a high-impact action.`, {
      title: "Grant Max Specialization",
      confirmLabel: "Grant Max",
      danger: true,
      details: [{ label: "Track", value: trackType, tone: "accent" }, { label: "Player", value: playerName }]
    }))) return;
    onError("");
    showResult(`spec_${trackType}`, "Granting max level", "neutral", true);
    try {
      await playersApi.grantMaxSpecialization(dbPlayerId, { trackType, confirmation: "GRANT MAX SPECIALIZATION" });
      showResult(`spec_${trackType}`, "Max level granted. Relog required.", "success");
      onActionLog?.("Grant Max Specialization", trackType, "1", "Succeeded");
      await load();
    } catch (err) {
      const message = friendlyInlineError(err);
      showResult(`spec_${trackType}`, message, "danger");
      onActionLog?.("Grant Max Specialization", trackType, "1", `Failed: ${message}`);
    }
  }

  async function resetTrack(trackType: string) {
    if (isOnline) {
      showResult(`spec_${trackType}`, "The player must be offline for specialization changes.", "danger");
      return;
    }
    if (!(await confirmAction(`Reset ${trackType} specialization for ${playerName}?`, {
      title: "Reset Specialization",
      danger: true,
      details: [{ label: "Track", value: trackType, tone: "danger" }]
    }))) return;
    onError("");
    showResult(`spec_${trackType}`, "Resetting track", "neutral", true);
    try {
      await playersApi.resetSpecialization(dbPlayerId, { trackType, confirmation: "RESET SPECIALIZATION" });
      showResult(`spec_${trackType}`, "Track reset. Relog required.", "success");
      onActionLog?.("Reset Specialization", trackType, "1", "Succeeded");
      await load();
    } catch (err) {
      const message = friendlyInlineError(err);
      showResult(`spec_${trackType}`, message, "danger");
      onActionLog?.("Reset Specialization", trackType, "1", `Failed: ${message}`);
    }
  }

  async function grantAllKeystones() {
    if (isOnline) {
      showResult("specKeystones", "The player must be offline for specialization changes.", "danger");
      return;
    }
    if (!(await confirmAction(`Grant all specialization keystones to ${playerName}? This is a high-impact action that affects all tracks.`, {
      title: "Grant All Keystones",
      confirmLabel: "Grant All",
      danger: true,
      details: [{ label: "Player", value: playerName, tone: "accent" }]
    }))) return;
    onError("");
    showResult("specKeystones", "Granting keystones", "neutral", true);
    try {
      await playersApi.grantAllSpecializationKeystones(dbPlayerId, "GRANT ALL KEYSTONES");
      showResult("specKeystones", "Keystones granted. Relog required.", "success");
      onActionLog?.("Grant All Keystones", playerName, "1", "Succeeded");
      await load();
    } catch (err) {
      const message = friendlyInlineError(err);
      showResult("specKeystones", message, "danger");
      onActionLog?.("Grant All Keystones", playerName, "1", `Failed: ${message}`);
    }
  }

  async function resetAllKeystones() {
    if (isOnline) {
      showResult("specKeystones", "The player must be offline for specialization changes.", "danger");
      return;
    }
    if (!(await confirmAction(`Reset all specialization keystones for ${playerName}?`, {
      title: "Reset All Keystones",
      danger: true,
      details: [{ label: "Player", value: playerName, tone: "danger" }]
    }))) return;
    onError("");
    showResult("specKeystones", "Resetting keystones", "neutral", true);
    try {
      await playersApi.resetAllSpecializationKeystones(dbPlayerId, "RESET ALL KEYSTONES");
      showResult("specKeystones", "Keystones reset. Relog required.", "success");
      onActionLog?.("Reset All Keystones", playerName, "1", "Succeeded");
      await load();
    } catch (err) {
      const message = friendlyInlineError(err);
      showResult("specKeystones", message, "danger");
      onActionLog?.("Reset All Keystones", playerName, "1", `Failed: ${message}`);
    }
  }

  const isBusy = Boolean(actionResult?.pending);
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
          <button
            disabled={!canAct || isBusy}
            onClick={() => void grantAllKeystones()}
            aria-label="Grant All Keystones"
          >
            <KeyRound size={14} /> Grant All Keystones
          </button>
          <button
            className="danger"
            disabled={!canAct || isBusy}
            onClick={() => void resetAllKeystones()}
            aria-label="Reset All Keystones"
          >
            <RotateCcw size={14} /> Reset All Keystones
          </button>
          <InlineActionResult result={actionResult} resultKey="specKeystones" />
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
            {rows.map((row) => (
              <tr key={row.trackType}>
                <td>
                  <div className="spec-track-name">
                    <Trophy size={14} className="spec-track-icon" />
                    {row.trackType}
                  </div>
                  <InlineActionResult result={actionResult} resultKey={`spec_${row.trackType}`} />
                </td>
                <td>{row.xp.toLocaleString()}</td>
                <td>
                  <span className={`spec-level-badge ${row.level >= 10 ? "spec-level-max" : ""}`}>
                    <Zap size={12} />
                    {row.level}
                  </span>
                </td>
                <td>
                  {row.keystone
                    ? <span className="spec-keystone-yes"><KeyRound size={14} /> Granted</span>
                    : <span className="spec-keystone-no">—</span>}
                </td>
                <td>
                  <div className="specialization-xp-control">
                    <input
                      className="playerAdmin_specXpInput"
                      type="number"
                      min="0"
                      value={xpAmount}
                      onChange={(event) => setXpAmount(event.target.value)}
                      disabled={!canAct || isBusy}
                      aria-label={`XP amount for ${row.trackType}`}
                    />
                    <button
                      disabled={!canAct || isBusy}
                      onClick={() => void addXp(row.trackType)}
                      aria-label={`Add XP to ${row.trackType}`}
                    >
                      Add
                    </button>
                  </div>
                </td>
                <td className="playerAdmin_actionCell">
                  <button
                    disabled={!canAct || isBusy}
                    onClick={() => void grantMax(row.trackType)}
                    aria-label={`Grant Max for ${row.trackType}`}
                  >
                    Grant Max
                  </button>
                  <button
                    className="danger"
                    disabled={!canAct || isBusy}
                    onClick={() => void resetTrack(row.trackType)}
                    aria-label={`Reset ${row.trackType}`}
                  >
                    Reset
                  </button>
                </td>
              </tr>
            ))}
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
