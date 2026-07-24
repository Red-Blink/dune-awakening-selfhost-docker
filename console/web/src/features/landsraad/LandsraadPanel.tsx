import { useEffect, useMemo, useRef, useState } from "react";
import { adminApi, type LandsraadMilestonePreset, type LandsraadOverview, type LandsraadReward, type LandsraadTask } from "../../api/admin";
import { mapsApi } from "../../api/maps";
import { playersApi } from "../../api/players";
import { setupApi, type Task } from "../../api/setup";
import { DataTable } from "../../components/common/DataTable";
import { InlineActionResult, type InlineActionResultState } from "../../components/common/InlineActionResult";
import { conciseTaskError } from "../../lib/taskDisplay";
import { friendlyInlineError } from "../players/playerAdminUtils";

type ConfirmAction = (message: string, options?: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }) => Promise<boolean>;

type LandsraadAdminSectionProps = {
  confirmAction: ConfirmAction;
  onError: (text: string) => void;
};

export function LandsraadPanel({ confirmAction, onError }: LandsraadAdminSectionProps) {
  const [loading, setLoading] = useState(false);
  const [overview, setOverview] = useState<LandsraadOverview | null>(null);
  const [players, setPlayers] = useState<Record<string, unknown>[]>([]);
  const [goalDrafts, setGoalDrafts] = useState<Record<string, string>>({});
  const [rewardDrafts, setRewardDrafts] = useState<Record<string, { threshold: string; templateId: string; amount: string }>>({});
  const [bulkGoal, setBulkGoal] = useState("");
  const [milestonePreset, setMilestonePreset] = useState<LandsraadMilestonePreset | null>(null);
  const [milestoneDraft, setMilestoneDraft] = useState({ enabled: false, goalAmount: "", thresholds: [] as string[] });
  const [contributionPlayer, setContributionPlayer] = useState("");
  const [contributionTask, setContributionTask] = useState("");
  const [contributionAmount, setContributionAmount] = useState("");
  const [persistentRules, setPersistentRules] = useState<Record<string, string>>({});
  const [persistentDraft, setPersistentDraft] = useState<Record<string, string>>({});
  const [persistentLoading, setPersistentLoading] = useState(false);
  const [result, setResult] = useState<InlineActionResultState | null>(null);
  const resultTimer = useRef<number | null>(null);

  const taskOptions = overview?.tasks || [];
  const taskNameById = useMemo(() => new Map(taskOptions.map((task) => [task.task_id, task.display_name || task.house_name || `Task ${task.task_id}`])), [taskOptions]);
  const rewardRows = useMemo(() => (overview?.rewards || []).map((reward) => ({
    ...reward,
    task: taskNameById.get(reward.task_id) || `Task ${reward.task_id}`
  })), [overview, taskNameById]);
  const currentTermThresholds = useMemo(() => overview ? detectedMilestoneThresholds(overview) : [], [overview]);
  const milestoneTierMismatch = currentTermThresholds.length > 0 && currentTermThresholds.length !== milestoneDraft.thresholds.length;

  useEffect(() => {
    void load();
    void loadPersistentRules();
  }, []);

  useEffect(() => {
    return () => {
      if (resultTimer.current) window.clearTimeout(resultTimer.current);
    };
  }, []);

  async function load() {
    setLoading(true);
    setResult(null);
    onError("");
    try {
      const [nextOverview, nextPlayers, presetResponse] = await Promise.all([
        adminApi.landsraad(),
        playersApi.listAll().catch(() => ({ rows: [] })),
        adminApi.landsraadMilestonePreset()
      ]);
      setOverview(nextOverview);
      setPlayers(nextPlayers.rows || []);
      setGoalDrafts(Object.fromEntries((nextOverview.tasks || []).map((task) => [task.task_id, String(task.goal_amount ?? 0)])));
      setRewardDrafts(Object.fromEntries((nextOverview.rewards || []).map((reward) => [rewardKey(reward), {
        threshold: String(reward.threshold ?? 0),
        templateId: String(reward.template_id || ""),
        amount: String(reward.amount ?? 0)
      }])));
      const preset = presetResponse.preset;
      const detectedThresholds = detectedMilestoneThresholds(nextOverview);
      setMilestonePreset(preset);
      setMilestoneDraft({
        enabled: preset.enabled,
        goalAmount: String(preset.thresholds.length ? preset.goalAmount : nextOverview.tasks?.[0]?.goal_amount ?? 0),
        thresholds: (preset.thresholds.length ? preset.thresholds : detectedThresholds).map(String)
      });
      if (!contributionTask && nextOverview.tasks?.[0]) setContributionTask(nextOverview.tasks[0].task_id);
      if (!contributionPlayer && nextPlayers.rows?.[0]) setContributionPlayer(playerActorId(nextPlayers.rows[0]));
    } catch (error) {
      onError(friendlyInlineError(error));
    } finally {
      setLoading(false);
    }
  }

  async function loadPersistentRules() {
    setPersistentLoading(true);
    try {
      const values = parseUserSettingsMap((await mapsApi.userSettingsValues("global")).stdout || "");
      setPersistentRules(values);
      setPersistentDraft(values);
    } catch (error) {
      onError(friendlyInlineError(error));
    } finally {
      setPersistentLoading(false);
    }
  }

  async function savePersistentRules() {
    if (persistentDraft.landsraad_enabled === persistentRules.landsraad_enabled) return;
    if (!(await confirmAction("Save persistent Landsraad rules and restart game services so the config is applied?", { title: "Save Landsraad Rules", confirmLabel: "Save And Restart" }))) return;
    if (resultTimer.current) window.clearTimeout(resultTimer.current);
    setResult({ key: "persistent-rules", text: "Services Restarting", tone: "neutral", pending: true });
    resultTimer.current = window.setTimeout(() => setResult(null), 6500);
    onError("");
    try {
      const response = await mapsApi.saveUserSettings({ scope: "global", values: { landsraad_enabled: persistentDraft.landsraad_enabled || "True" } });
      const final = await waitForTask(response.task);
      if (final.status !== "succeeded") throw new Error(conciseTaskError(final));
      await loadPersistentRules();
    } catch (error) {
      if (resultTimer.current) window.clearTimeout(resultTimer.current);
      setResult({ key: "persistent-rules", text: friendlyInlineError(error), tone: "danger" });
      resultTimer.current = window.setTimeout(() => setResult(null), 6500);
    }
  }

  async function run(key: string, pendingText: string, action: () => Promise<unknown>, successText: string) {
    if (resultTimer.current) window.clearTimeout(resultTimer.current);
    resultTimer.current = null;
    setResult({ key, text: pendingText, tone: "neutral", pending: true });
    onError("");
    try {
      await action();
      await load();
      setResult({ key, text: successText, tone: "success" });
      resultTimer.current = window.setTimeout(() => setResult(null), 4500);
    } catch (error) {
      setResult({ key, text: friendlyInlineError(error), tone: "danger" });
      resultTimer.current = window.setTimeout(() => setResult(null), 6500);
    }
  }

  async function saveGoal(task: LandsraadTask) {
    const value = Number(goalDrafts[task.task_id] ?? task.goal_amount);
    if (!Number.isInteger(value) || value < 0) {
      setResult({ key: `goal:${task.task_id}`, text: "Goal must be a whole number at or above zero.", tone: "danger" });
      return;
    }
    await run(`goal:${task.task_id}`, "Saving goal", () => adminApi.setLandsraadTaskGoal(task.task_id, value), "Goal Saved");
  }

  async function saveAllGoals() {
    const termId = overview?.term?.term_id;
    const value = Number(bulkGoal);
    if (!termId || !Number.isInteger(value) || value < 0) {
      setResult({ key: "bulk-goal", text: "Enter a whole current-term goal at or above zero.", tone: "danger" });
      return;
    }
    if (!(await confirmAction(`Set every current Landsraad task goal to ${value}?`, { title: "Update Landsraad Goals", confirmLabel: "Update Goals" }))) return;
    await run("bulk-goal", "Saving all goals", () => adminApi.setLandsraadTermTaskGoals(termId, value), "All Current-Term Task Goals Saved");
  }

  async function saveMilestonePreset() {
    const goalAmount = Number(milestoneDraft.goalAmount);
    const thresholds = milestoneDraft.thresholds.map(Number);
    if (!Number.isInteger(goalAmount) || goalAmount < 0 || !thresholds.length || thresholds.some((value) => !Number.isInteger(value) || value < 1)) {
      setResult({ key: "milestone-preset", text: "Enter a whole goal at or above zero and reward thresholds greater than zero.", tone: "danger" });
      return;
    }
    if (thresholds.some((value, index) => index > 0 && value <= thresholds[index - 1])) {
      setResult({ key: "milestone-preset", text: "Reward thresholds must increase from one level to the next.", tone: "danger" });
      return;
    }
    if (!(await confirmAction(
      `Apply the ${thresholds.length}-level milestone preset to every house in the current Landsraad term?`,
      { title: "Apply Landsraad Milestones", confirmLabel: "Save And Apply" }
    ))) return;

    const responseRef: { current: Awaited<ReturnType<typeof adminApi.saveLandsraadMilestonePreset>> | null } = { current: null };
    await run(
      "milestone-preset",
      "Applying milestones",
      async () => { responseRef.current = await adminApi.saveLandsraadMilestonePreset({ enabled: milestoneDraft.enabled, goalAmount, thresholds }); },
      "Milestone Preset Saved"
    );
    if (responseRef.current && !responseRef.current.result.applied) {
      setResult({ key: "milestone-preset", text: responseRef.current.result.reason || "Preset saved and waiting for the current term.", tone: "neutral" });
      resultTimer.current = window.setTimeout(() => setResult(null), 6500);
    }
  }

  async function saveReward(reward: LandsraadReward) {
    const draft = rewardDrafts[rewardKey(reward)];
    const threshold = Number(draft?.threshold ?? reward.threshold);
    const amount = Number(draft?.amount ?? reward.amount);
    const templateId = String(draft?.templateId ?? reward.template_id).trim();
    if (!Number.isInteger(threshold) || threshold < 0 || !Number.isInteger(amount) || amount < 0 || !templateId) {
      setResult({ key: `reward:${rewardKey(reward)}`, text: "Reward threshold, template, and amount are required.", tone: "danger" });
      return;
    }
    await run(
      `reward:${rewardKey(reward)}`,
      "Saving reward",
      () => adminApi.setLandsraadRewardTier({ rowLocator: reward.row_locator, taskId: reward.task_id, threshold: reward.threshold, newThreshold: threshold, templateId, amount }),
      "Reward Saved"
    );
  }

  async function saveContribution() {
    const amount = Number(contributionAmount);
    if (!contributionPlayer || !contributionTask || !Number.isFinite(amount) || amount < 0) {
      setResult({ key: "contribution", text: "Choose a player, choose a task, and enter a contribution at or above zero.", tone: "danger" });
      return;
    }
    await run(
      "contribution",
      "Saving contribution",
      () => adminApi.setLandsraadPlayerContribution({ playerId: contributionPlayer, taskId: contributionTask, amount }),
      "Contribution Saved And Totals Recalculated"
    );
  }

  function renderTaskCell(row: Record<string, unknown>, column: string) {
    const task = row as unknown as LandsraadTask;
    if (column === "goal_amount") {
      return <input className="landsraad-number-input" type="number" min="0" step="1" value={goalDrafts[task.task_id] ?? ""} onChange={(event) => setGoalDrafts((current) => ({ ...current, [task.task_id]: event.target.value }))} />;
    }
    if (column === "progress") return `${Math.floor(Number(task.faction_progress || 0))} / ${task.goal_amount}`;
    if (column === "completed") return task.completed ? "Yes" : "No";
    if (column === "sysselraad") return task.sysselraad ? "Yes" : "No";
    if (column === "winning_faction") return task.winning_faction || "None";
    return String(row[column] ?? "");
  }

  function renderRewardCell(row: Record<string, unknown>, column: string) {
    const reward = row as unknown as LandsraadReward;
    const key = rewardKey(reward);
    const draft = rewardDrafts[key] || { threshold: String(reward.threshold), templateId: reward.template_id, amount: String(reward.amount) };
    if (column === "threshold") return <input className="landsraad-number-input" type="number" min="0" step="1" value={draft.threshold} onChange={(event) => setRewardDrafts((current) => ({ ...current, [key]: { ...draft, threshold: event.target.value } }))} />;
    if (column === "template_id") return <input className="landsraad-template-input" value={draft.templateId} onChange={(event) => setRewardDrafts((current) => ({ ...current, [key]: { ...draft, templateId: event.target.value } }))} />;
    if (column === "amount") return <input className="landsraad-number-input" type="number" min="0" step="1" value={draft.amount} onChange={(event) => setRewardDrafts((current) => ({ ...current, [key]: { ...draft, amount: event.target.value } }))} />;
    return String(row[column] ?? "");
  }

  return <section className="panel landsraad-panel">
    <div className="panel-title">
      <h2>Landsraad <span className="landsraad-experimental-badge">Experimental</span></h2>
    </div>
    <div className="landsraad-admin-body">
      <div className="panel-title schedule-panel-title">
        <h4>Current Term</h4>
        <button disabled={loading} onClick={() => void load()}>{loading ? "Loading..." : "Reload"}</button>
      </div>
      {!overview && <p className="muted">{loading ? "Loading Landsraad data..." : "Open this section to load Landsraad data."}</p>}
      {overview?.term && <div className="landsraad-summary-grid">
        <span><strong>Term</strong>{String(overview.term.term_id)}</span>
        <span><strong>Starts</strong>{formatLandsraadTime(overview.term.start_time)}</span>
        <span><strong>Ends</strong>{formatLandsraadTime(overview.term.end_time)}</span>
        <span><strong>Active Decree</strong>{overview.term.active_decree || "None"}</span>
        <span><strong>Elected Decree</strong>{overview.term.elected_decree || "None"}</span>
        <span><strong>Winning Faction</strong>{overview.term.winning_faction || "None"}</span>
      </div>}
      {overview && !overview.term && <p className="empty">No Landsraad term found in the database.</p>}

      <section className="landsraad-persistent-settings">
        <div className="landsraad-persistent-copy">
          <h4>Persistent Rules</h4>
          <p className="muted">Saved to gameplay config and applied on restart. Current-term tables below edit live database state.</p>
        </div>
        <div className="landsraad-persistent-status">
          <InlineActionResult result={result} resultKey="persistent-rules" format={false} />
        </div>
        <div className="landsraad-persistent-controls">
          <label>Landsraad System<select disabled={persistentLoading} value={persistentDraft.landsraad_enabled || "True"} onChange={(event) => setPersistentDraft((current) => ({ ...current, landsraad_enabled: event.target.value }))}>
            <option value="True">Enabled</option>
            <option value="False">Disabled</option>
          </select></label>
          <button disabled={persistentLoading || persistentDraft.landsraad_enabled === persistentRules.landsraad_enabled || (result?.key === "persistent-rules" && Boolean(result.pending))} onClick={() => void savePersistentRules()}>{persistentLoading ? "Loading..." : "Save Rules"}</button>
        </div>
      </section>

      <div className="section-divider landsraad-section-divider" />

      <section className="landsraad-milestone-preset">
        <div className="landsraad-milestone-heading">
          <div>
            <h4>Milestone Preset</h4>
            <p className="muted">Set the goal and reward thresholds for every house. Reward items and quantities are preserved.</p>
          </div>
          <div className="landsraad-milestone-heading-actions">
            {milestonePreset?.lastAppliedTermId && <span className="landsraad-preset-status">Applied To Term {milestonePreset.lastAppliedTermId}</span>}
            {milestoneTierMismatch && <button className="secondary" onClick={() => setMilestoneDraft((current) => ({ ...current, thresholds: currentTermThresholds.map(String) }))}>Use Current Term Levels</button>}
          </div>
        </div>
        {milestoneDraft.thresholds.length ? <>
          <div className="landsraad-milestone-fields">
            <label>Overall Goal<input type="number" min="0" step="1" value={milestoneDraft.goalAmount} onChange={(event) => setMilestoneDraft((current) => ({ ...current, goalAmount: event.target.value }))} /></label>
            {milestoneDraft.thresholds.map((threshold, index) => <label key={index}>Level {index + 1} Reward Threshold<input type="number" min="1" step="1" value={threshold} onChange={(event) => setMilestoneDraft((current) => ({ ...current, thresholds: current.thresholds.map((value, thresholdIndex) => thresholdIndex === index ? event.target.value : value) }))} /></label>)}
          </div>
          <div className="landsraad-milestone-actions">
            <label className={`switch-checkbox landsraad-cycle-toggle ${milestoneDraft.enabled ? "enabled" : "disabled"}`}><input type="checkbox" checked={milestoneDraft.enabled} onChange={(event) => setMilestoneDraft((current) => ({ ...current, enabled: event.target.checked }))} /><span className="switch-label">Apply Automatically Each Cycle</span><strong className="switch-state">{milestoneDraft.enabled ? "ON" : "OFF"}</strong></label>
            <div className="landsraad-milestone-result"><InlineActionResult result={result} resultKey="milestone-preset" format={false} /></div>
            <button onClick={() => void saveMilestonePreset()}>Save And Apply</button>
          </div>
        </> : <p className="empty">Reward levels will appear after the current Landsraad term generates its milestones.</p>}
      </section>

      <div className="section-divider landsraad-section-divider" />

      {overview?.term && <div className="landsraad-bulk-row">
        <label className="compact-select">Set All Current Goals<input type="number" min="0" step="1" value={bulkGoal} onChange={(event) => setBulkGoal(event.target.value)} /></label>
        <button onClick={() => void saveAllGoals()}>Apply To Term</button>
        <InlineActionResult result={result} resultKey="bulk-goal" format={false} />
      </div>}

      {overview?.tasks?.length ? <DataTable
        rows={overview.tasks as unknown as Record<string, unknown>[]}
        columns={["board_index", "display_name", "progress", "goal_amount", "completed", "sysselraad", "winning_faction"]}
        tableClassName="landsraad-task-table"
        renderCell={renderTaskCell}
        actionClassName="landsraad-actions-cell"
        action={(row) => {
          const task = row as unknown as LandsraadTask;
          return <div className="landsraad-row-actions"><button onClick={() => void saveGoal(task)}>Save</button><InlineActionResult result={result} resultKey={`goal:${task.task_id}`} format={false} /></div>;
        }}
      /> : overview && <div className="empty">No current Landsraad tasks found.</div>}

      {overview?.capabilities?.rewards && <div className="section-divider" />}
      {overview?.capabilities?.rewards && <div className="landsraad-reward-card">
        <h4>Reward Milestones</h4>
        {rewardRows.length ? <DataTable
          rows={rewardRows as unknown as Record<string, unknown>[]}
          columns={["task", "threshold", "template_id", "amount"]}
          tableClassName="landsraad-reward-table"
          renderCell={renderRewardCell}
          actionClassName="landsraad-actions-cell"
          action={(row) => {
            const reward = row as unknown as LandsraadReward;
            return <div className="landsraad-row-actions"><button onClick={() => void saveReward(reward)}>Save</button><InlineActionResult result={result} resultKey={`reward:${rewardKey(reward)}`} format={false} /></div>;
          }}
        /> : <div className="empty">No current reward milestones found.</div>}
      </div>}

      {overview?.capabilities?.playerContributions && <div className="section-divider" />}
      {overview?.capabilities?.playerContributions && <div className="landsraad-contribution-card">
        <h4>Player Contribution</h4>
        <div className="landsraad-contribution-row">
          <label className="landsraad-contribution-player">Player<select value={contributionPlayer} onChange={(event) => setContributionPlayer(event.target.value)}>
            {players.map((player) => <option key={playerActorId(player)} value={playerActorId(player)}>{playerLabel(player)}</option>)}
          </select></label>
          <label className="landsraad-contribution-task">Task<select value={contributionTask} onChange={(event) => setContributionTask(event.target.value)}>
            {taskOptions.map((task) => <option key={task.task_id} value={task.task_id}>{task.display_name || task.house_name || `Task ${task.task_id}`}</option>)}
          </select></label>
          <label className="landsraad-contribution-amount">Contribution<input type="number" min="0" step="1" value={contributionAmount} onChange={(event) => setContributionAmount(event.target.value)} /></label>
          <button onClick={() => void saveContribution()}>Save</button>
          <InlineActionResult result={result} resultKey="contribution" format={false} />
        </div>
      </div>}
    </div>
  </section>;
}

function rewardKey(reward: LandsraadReward) {
  return reward.row_locator;
}

function detectedMilestoneThresholds(overview: LandsraadOverview) {
  const firstTaskId = overview.tasks?.[0]?.task_id;
  if (!firstTaskId) return [];
  return overview.rewards
    .filter((reward) => reward.task_id === firstTaskId)
    .map((reward) => Number(reward.threshold))
    .filter((threshold) => Number.isInteger(threshold) && threshold >= 0)
    .sort((left, right) => left - right);
}

function playerActorId(player: Record<string, unknown>) {
  return String(player.actor_id || player.actorId || "");
}

function playerLabel(player: Record<string, unknown>) {
  return String(player.character_name || player.name || player.actor_id || player.actorId || "Unknown Player");
}

function parseUserSettingsMap(stdout: string) {
  const values: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [key, value = ""] = line.split("\t");
    if (key) values[key] = value;
  }
  return values;
}

async function waitForTask(task: Task) {
  let current = task;
  for (let i = 0; i < 3600 && !["succeeded", "failed", "cancelled"].includes(current.status); i += 1) {
    await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 1000));
    current = (await setupApi.task(current.id)).task;
  }
  return current;
}

function formatLandsraadTime(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return "Unknown";
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?/);
  if (match && !/[zZ]|[+-]\d\d:?\d\d$/.test(raw)) {
    const [, year, month, day, hour, minute] = match;
    const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }
  const isoLike = raw.includes("T") ? raw : raw.replace(" ", "T");
  const date = new Date(isoLike);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}
