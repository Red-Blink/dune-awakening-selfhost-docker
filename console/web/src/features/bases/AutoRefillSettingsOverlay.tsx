import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { basesApi } from "../../api/bases";
import type { AutoRefillSettingKey, AutoRefillSettings, AutoRefillSettingsPatch } from "../../api/bases";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

// Tuning for both auto-refill scanners. Fetches its own state rather than
// taking it from BasesPanel: it needs the sources/defaults/limits/envNames the
// panel never loads, and it opens rarely enough for one request on open.
type AutoRefillSettingsOverlayProps = {
  onClose: () => void;
  onSaved: () => void;
  onError: (text: string) => void;
};

// `group` exists so the accessible name distinguishes the two subsystems --
// the visible label is identical on both sides.
type FieldSpec = { key: AutoRefillSettingKey; label: string; unit: string; group: string };

const GENERATOR_FIELDS: FieldSpec[] = [
  { key: "thresholdPercent", label: "Queue a refill below", unit: "%", group: "Generators" },
  { key: "intervalHours", label: "Check every", unit: "h", group: "Generators" }
];

const WATER_FIELDS: FieldSpec[] = [
  { key: "waterThresholdPercent", label: "Queue a refill below", unit: "%", group: "Water" },
  { key: "waterIntervalHours", label: "Check every", unit: "h", group: "Water" }
];

const ALL_KEYS: AutoRefillSettingKey[] = [...GENERATOR_FIELDS, ...WATER_FIELDS].map((field) => field.key);

export function AutoRefillSettingsOverlay({ onClose, onSaved, onError }: AutoRefillSettingsOverlayProps) {
  const [state, setState] = useState<AutoRefillSettings | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Which fields the operator has actually set. Reset clears the flag so Save
  // sends null (delete the override); sending the number would persist the env
  // value and permanently shadow the env var.
  const [overridden, setOverridden] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await basesApi.autoRefillSettings();
        if (cancelled) return;
        setState(loaded);
        setDrafts(Object.fromEntries(ALL_KEYS.map((key) => [key, String(loaded.settings[key])])));
        setOverridden(Object.fromEntries(ALL_KEYS.map((key) => [key, loaded.sources[key] === "console"])));
      } catch (error) {
        if (!cancelled) onError(errorText(error));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [onError]);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const errorFor = useCallback((key: AutoRefillSettingKey): string => {
    if (!state) return "";
    const limits = state.limits[key];
    const draft = drafts[key] ?? "";
    const value = Number(draft);
    if (draft.trim() === "" || !Number.isInteger(value) || value < limits.min || value > limits.max) {
      return `Must be a whole number, ${limits.min}-${limits.max}.`;
    }
    return "";
  }, [state, drafts]);

  const canSave = Boolean(state) && !saving && !loading && ALL_KEYS.every((key) => !errorFor(key));

  const setDraft = (key: AutoRefillSettingKey, value: string) => {
    setDrafts((previous) => ({ ...previous, [key]: value }));
    setOverridden((previous) => ({ ...previous, [key]: true }));
  };

  const reset = (key: AutoRefillSettingKey) => {
    if (!state) return;
    setDrafts((previous) => ({ ...previous, [key]: String(state.defaults[key]) }));
    setOverridden((previous) => ({ ...previous, [key]: false }));
  };

  const save = async () => {
    if (!state || !canSave) return;
    setSaving(true);
    onError("");
    try {
      const patch: AutoRefillSettingsPatch = {};
      for (const key of ALL_KEYS) patch[key] = overridden[key] ? Number(drafts[key]) : null;
      await basesApi.saveAutoRefillSettings(patch);
      onSaved();
      onClose();
    } catch (error) {
      onError(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  const renderField = (field: FieldSpec) => {
    if (!state) return null;
    const limits = state.limits[field.key];
    const error = errorFor(field.key);
    const isOverridden = Boolean(overridden[field.key]);
    const showEnvHint = !isOverridden && state.sources[field.key] === "env";
    return (
      <div className="auto-refill-settings-field-row" key={field.key}>
        <label className="auto-refill-settings-field">
          <span>{field.label}</span>
          <input
            type="number"
            min={limits.min}
            max={limits.max}
            step={1}
            aria-label={`${field.group}: ${field.label} (${field.unit})`}
            value={drafts[field.key] ?? ""}
            onChange={(event) => setDraft(field.key, event.target.value)}
          />
          <span className="auto-refill-settings-unit">{field.unit}</span>
        </label>
        <button
          type="button"
          className="auto-refill-settings-reset"
          aria-label={`Reset ${field.group.toLowerCase()} ${field.label.toLowerCase()}`}
          disabled={!isOverridden}
          onClick={() => reset(field.key)}
        >Reset</button>
        {error && <p className="danger-note" role="alert">{error}</p>}
        {showEnvHint && (
          <p className="muted auto-refill-settings-hint">
            Set by {state.envNames[field.key]} ({state.defaults[field.key]}). Saving here overrides it.
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="modal-overlay" role="presentation" onMouseDown={onClose}>
      <section
        className="confirm-modal auto-refill-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auto-refill-settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="confirm-modal-title">
          <h3 id="auto-refill-settings-title">Auto-refill settings</h3>
          <button ref={closeButtonRef} className="icon-action" aria-label="Close" onClick={onClose}><X size={16} /></button>
        </div>

        <p className="muted">
          Applies to every enrolled base. Stored in the console only — no game data is changed,
          and the change applies without a restart.
        </p>

        {loading ? <p className="muted">Loading…</p> : state && (
          <>
            <div className="auto-refill-settings-group">
              <span className="auto-refill-settings-group-title">Generators</span>
              {GENERATOR_FIELDS.map(renderField)}
            </div>
            <div className="auto-refill-settings-group auto-refill-settings-group-divided">
              <span className="auto-refill-settings-group-title">Water</span>
              {WATER_FIELDS.map(renderField)}
            </div>
            <p className="muted auto-refill-settings-note">
              A shorter interval pulls the next scan in. A longer one applies after the next scan.
              A changed threshold is used by the next scan, not immediately.
            </p>
          </>
        )}

        <div className="confirm-modal-actions">
          <button onClick={onClose} disabled={saving}>Cancel</button>
          <button className="primary" onClick={() => void save()} disabled={!canSave}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </section>
    </div>
  );
}
