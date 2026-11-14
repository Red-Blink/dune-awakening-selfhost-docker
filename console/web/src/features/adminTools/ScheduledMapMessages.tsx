import { PermissionGate } from "../../lib/consoleAccess";
import { useEffect, useMemo, useRef, useState } from "react";
import { adminApi, type ScheduledMapMessage, type ScheduledMapMessageDraft } from "../../api/admin";
import { InlineActionResult, type InlineActionResultState } from "../../components/common/InlineActionResult";

type MapOption = { key: string; label: string; chatRegion: string; dimension: number };
type ConfirmAction = (message: string, options?: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }) => Promise<boolean>;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function ScheduledMapMessages({ mapOptions, confirmAction, onDelivery }: { mapOptions: MapOption[]; confirmAction: ConfirmAction; onDelivery: () => Promise<void> | void }) {
  const scheduleMapOptions = useMemo(() => [{ key: "AllMaps|0", label: "All Maps", chatRegion: "AllMaps", dimension: 0 }, ...mapOptions], [mapOptions]);
  const [schedules, setSchedules] = useState<ScheduledMapMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState<ScheduledMapMessageDraft>(() => emptyDraft(mapOptions));
  const [result, setResult] = useState<InlineActionResultState | null>(null);
  const [busyId, setBusyId] = useState("");
  const busyIdRef = useRef("");
  const timezoneOptions = useMemo(supportedTimezones, []);

  useEffect(() => {
    void loadSchedules();
    const id = window.setInterval(() => {
      if (!document.hidden && !busyIdRef.current) void loadSchedules(true);
    }, 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    busyIdRef.current = busyId;
  }, [busyId]);

  useEffect(() => {
    if (!result || result.pending) return undefined;
    const id = window.setTimeout(() => setResult(null), 8_000);
    return () => window.clearTimeout(id);
  }, [result]);

  useEffect(() => {
    if (draft.id || scheduleMapOptions.some((option) => option.key === mapKey(draft.mapName, draft.dimension))) return;
    const target = mapOptions[0] || scheduleMapOptions[0];
    setDraft((current) => ({ ...current, mapName: target.chatRegion, dimension: target.dimension }));
  }, [mapOptions, scheduleMapOptions, draft.id, draft.mapName, draft.dimension]);

  async function loadSchedules(silent = false) {
    if (!silent) setLoading(true);
    try {
      const response = await adminApi.mapChatSchedules();
      setSchedules(response.schedules || []);
    } catch (error) {
      if (!silent) setResult(actionResult("list", error, "danger"));
    } finally {
      if (!silent) setLoading(false);
    }
  }

  function startCreate() {
    setDraft(emptyDraft(mapOptions));
    setEditorOpen(true);
    setResult(null);
  }

  function startEdit(schedule: ScheduledMapMessage) {
    setDraft({
      id: schedule.id,
      name: schedule.name,
      enabled: schedule.enabled,
      mapName: schedule.mapName,
      dimension: schedule.dimension,
      message: schedule.message,
      frequency: schedule.frequency,
      daysOfWeek: [...schedule.daysOfWeek],
      time: schedule.time,
      timezone: schedule.timezone
    });
    setEditorOpen(true);
    setResult(null);
  }

  async function saveDraft() {
    setBusyId(draft.id || "new");
    setResult({ key: "editor", tone: "neutral", text: "Saving scheduled message", pending: true });
    try {
      const response = await adminApi.saveMapChatSchedule(draft);
      setSchedules(response.schedules || []);
      setDraft(emptyDraft(mapOptions));
      setEditorOpen(false);
      setResult({ key: "list", tone: "success", text: "Scheduled message saved." });
    } catch (error) {
      setResult(actionResult("editor", error, "danger"));
    } finally {
      setBusyId("");
    }
  }

  async function toggleSchedule(schedule: ScheduledMapMessage) {
    setBusyId(schedule.id);
    try {
      const response = await adminApi.saveMapChatSchedule({ ...schedule, enabled: !schedule.enabled });
      setSchedules(response.schedules || []);
      setResult({ key: "list", tone: "success", text: `${schedule.name} ${schedule.enabled ? "disabled" : "enabled"}.` });
    } catch (error) {
      setResult(actionResult("list", error, "danger"));
    } finally {
      setBusyId("");
    }
  }

  async function runNow(schedule: ScheduledMapMessage) {
    setBusyId(schedule.id);
    setResult({ key: "list", tone: "neutral", text: `Sending ${schedule.name}`, pending: true });
    try {
      const response = await adminApi.runMapChatSchedule(schedule.id);
      setSchedules(response.schedules || []);
      setResult({ key: "list", tone: "success", text: `${schedule.name} was sent successfully.` });
      await onDelivery();
    } catch (error) {
      setResult(actionResult("list", error, "danger"));
    } finally {
      setBusyId("");
    }
  }

  async function deleteSchedule(schedule: ScheduledMapMessage) {
    if (!(await confirmAction(`Delete the scheduled message “${schedule.name}”?`, { title: "Delete Scheduled Message", confirmLabel: "Delete", danger: true }))) return;
    setBusyId(schedule.id);
    try {
      const response = await adminApi.deleteMapChatSchedule(schedule.id);
      setSchedules(response.schedules || []);
      if (draft.id === schedule.id) {
        setEditorOpen(false);
        setDraft(emptyDraft(mapOptions));
      }
      setResult({ key: "list", tone: "success", text: "Scheduled message deleted." });
    } catch (error) {
      setResult(actionResult("list", error, "danger"));
    } finally {
      setBusyId("");
    }
  }

  function chooseTarget(key: string) {
    const target = scheduleMapOptions.find((option) => option.key === key) || scheduleMapOptions[0];
    if (target) setDraft((current) => ({ ...current, mapName: target.chatRegion, dimension: target.dimension }));
  }

  function toggleWeekday(day: number) {
    setDraft((current) => ({ ...current, daysOfWeek: current.daysOfWeek.includes(day) ? current.daysOfWeek.filter((value) => value !== day) : [...current.daysOfWeek, day].sort() }));
  }

  return <div className="map-message-schedules">
    <div className="map-message-schedule-heading">
      <div><strong>Scheduled Messages</strong><span>Send recurring announcements using each schedule’s timezone.</span></div>
      <button disabled={Boolean(busyId)} onClick={startCreate}>Add Schedule</button>
    </div>

    {editorOpen && <div className="map-message-schedule-editor">
      <div className="map-message-schedule-editor-title"><strong>{draft.id ? "Edit Schedule" : "New Schedule"}</strong><span>{draft.id ? "Update this recurring message." : "Create a daily or weekly map announcement."}</span></div>
      <div className="map-message-schedule-fields">
        <label>Schedule Name<input maxLength={80} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Name" /></label>
        <label>Choose Map<select value={mapKey(draft.mapName, draft.dimension)} onChange={(event) => chooseTarget(event.target.value)}>{scheduleMapOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>
        <label>Frequency<select value={draft.frequency} onChange={(event) => setDraft({ ...draft, frequency: event.target.value as "daily" | "weekly" })}><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>
        <label>Time<input type="time" step="60" value={draft.time} onChange={(event) => setDraft({ ...draft, time: event.target.value })} /></label>
        <label>Timezone<input list="map-message-timezones" value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })} placeholder="UTC" /><datalist id="map-message-timezones">{timezoneOptions.map((timezone) => <option key={timezone} value={timezone} />)}</datalist></label>
      </div>
      {draft.frequency === "weekly" && <fieldset className="map-message-weekdays"><legend>Send On</legend><div>{WEEKDAYS.map((label, day) => <button type="button" key={label} className={draft.daysOfWeek.includes(day) ? "active" : ""} aria-pressed={draft.daysOfWeek.includes(day)} onClick={() => toggleWeekday(day)}>{label}</button>)}</div></fieldset>}
      <label className="map-message-schedule-body">Message<textarea rows={4} maxLength={500} value={draft.message} onChange={(event) => setDraft({ ...draft, message: event.target.value })} placeholder="Your message here..." /><span className="muted">{draft.message.length}/500 characters</span></label>
      <div className="map-message-schedule-editor-actions">
        <label className={`switch-checkbox ${draft.enabled ? "enabled" : "disabled"}`}><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /><span className="switch-label">Schedule</span><strong className="switch-state">{draft.enabled ? "ON" : "OFF"}</strong></label>
        <PermissionGate action="admin:map-chat"><button disabled={Boolean(busyId) || !draft.message.trim()} onClick={() => void saveDraft()}>{busyId ? "Saving..." : "Save Schedule"}</button></PermissionGate>
        <button disabled={Boolean(busyId)} onClick={() => { setEditorOpen(false); setDraft(emptyDraft(mapOptions)); }}>Cancel</button>
        <InlineActionResult result={result} resultKey="editor" />
      </div>
    </div>}

    <InlineActionResult result={result} resultKey="list" />
    {loading ? <p className="muted">Loading scheduled messages...</p> : schedules.length === 0 ? <div className="map-message-schedule-empty"><strong>No scheduled messages yet</strong><span>Create one to send recurring map announcements automatically.</span></div> : <div className="map-message-schedule-list">
      {schedules.map((schedule) => <article key={schedule.id} className={`map-message-schedule-card ${schedule.enabled ? "enabled" : "disabled"}`}>
        <div className="map-message-schedule-summary">
          <div><strong>{schedule.name}</strong><span>{mapLabel(schedule, scheduleMapOptions)} · {scheduleLabel(schedule)}</span></div>
          <span className={`badge ${schedule.enabled ? "success" : ""}`}>{schedule.enabled ? "Enabled" : "Disabled"}</span>
        </div>
        <p>{schedule.message}</p>
        <div className="map-message-schedule-meta">
          <span><small>Next Delivery</small><strong>{schedule.enabled ? formatScheduleDate(schedule.nextRunAt, schedule.timezone) : "Disabled"}</strong></span>
          <span><small>Last Result</small><strong className={`schedule-status-${schedule.lastStatus}`}>{lastResultLabel(schedule)}</strong></span>
        </div>
        {schedule.lastError && <span className="map-message-schedule-error">{schedule.lastError}</span>}
        <div className="map-message-schedule-actions">
          <button disabled={Boolean(busyId)} onClick={() => startEdit(schedule)}>Edit</button>
          <PermissionGate action="admin:map-chat"><button disabled={Boolean(busyId)} onClick={() => void runNow(schedule)}>Send Now</button></PermissionGate>
          <PermissionGate action="admin:map-chat"><button disabled={Boolean(busyId)} onClick={() => void toggleSchedule(schedule)}>{schedule.enabled ? "Disable" : "Enable"}</button></PermissionGate>
          <PermissionGate action="admin:map-chat"><button className="danger" disabled={Boolean(busyId)} onClick={() => void deleteSchedule(schedule)}>Delete</button></PermissionGate>
        </div>
      </article>)}
    </div>}
  </div>;
}

function emptyDraft(options: MapOption[]): ScheduledMapMessageDraft {
  const target = options[0];
  return { name: "", enabled: true, mapName: target?.chatRegion || "HaggaBasin", dimension: target?.dimension || 0, message: "", frequency: "daily", daysOfWeek: [1, 2, 3, 4, 5], time: "09:00", timezone: browserTimezone() };
}

function browserTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function supportedTimezones() {
  const supportedValuesOf = (Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf;
  const values = supportedValuesOf ? supportedValuesOf("timeZone") : [];
  return [...new Set(["UTC", browserTimezone(), ...values])];
}

function mapKey(mapName: string, dimension: number) {
  return `${mapName}|${dimension}`;
}

function mapLabel(schedule: ScheduledMapMessage, options: MapOption[]) {
  return options.find((option) => option.key === mapKey(schedule.mapName, schedule.dimension))?.label || `${schedule.mapName} (${schedule.dimension})`;
}

function scheduleLabel(schedule: ScheduledMapMessage) {
  if (schedule.frequency === "daily") return `Daily at ${schedule.time} · ${schedule.timezone}`;
  return `${schedule.daysOfWeek.map((day) => WEEKDAYS[day]).join(", ")} at ${schedule.time} · ${schedule.timezone}`;
}

function formatScheduleDate(value: string, timezone: string) {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Not scheduled";
  return new Intl.DateTimeFormat(undefined, { timeZone: timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(date);
}

function lastResultLabel(schedule: ScheduledMapMessage) {
  if (schedule.lastStatus === "never") return "Not sent yet";
  if (schedule.lastStatus === "sent") return `Sent to ${schedule.lastRecipients} player${schedule.lastRecipients === 1 ? "" : "s"}`;
  if (schedule.lastStatus === "skipped") return "No players online";
  if (schedule.lastStatus === "missed") return "Missed while offline";
  if (schedule.lastStatus === "running") return "Sending...";
  return "Delivery failed";
}

function actionResult(key: string, error: unknown, tone: "danger" | "neutral" | "success"): InlineActionResultState {
  return { key, tone, text: error instanceof Error ? error.message : String(error) };
}
