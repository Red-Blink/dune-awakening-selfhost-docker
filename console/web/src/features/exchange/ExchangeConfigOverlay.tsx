import { useEffect, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { exchangeApi, type ExchangeConfig } from "../../api/exchange";

type ExchangeConfigOverlayProps = {
  onClose: () => void;
  onSaved: (config: ExchangeConfig) => void;
  onError: (text: string) => void;
};

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

type BuiltInEntry = { present: boolean; label: string; onToggle: (present: boolean) => void };

function IdListEditor({ title, hint, ids, onChange, builtIn }: { title: string; hint: string; ids: string[]; onChange: (next: string[]) => void; builtIn?: BuiltInEntry }) {
  const [draft, setDraft] = useState("");
  const valid = /^\d{1,19}$/.test(draft.trim());
  const hasChips = ids.length > 0 || Boolean(builtIn?.present);

  function add() {
    const id = draft.trim();
    if (!/^\d{1,19}$/.test(id) || ids.includes(id)) return;
    onChange([...ids, id]);
    setDraft("");
  }

  return (
    <div className="exchange-config-list">
      <div className="exchange-config-list-head">
        <strong>{title}</strong>
        <span className="muted">{hint}</span>
      </div>
      {hasChips
        ? <ul className="exchange-config-chips">
          {builtIn?.present && (
            <li className="exchange-config-chip exchange-config-chip-builtin">
              <span>{builtIn.label}<em>Built-In</em></span>
              <button type="button" aria-label={`Remove ${builtIn.label}`} onClick={() => builtIn.onToggle(false)}><Trash2 size={13} /></button>
            </li>
          )}
          {ids.map((id) => (
            <li key={id} className="exchange-config-chip">
              <span>{id}</span>
              <button type="button" aria-label={`Remove ${id}`} onClick={() => onChange(ids.filter((value) => value !== id))}><Trash2 size={13} /></button>
            </li>
          ))}
        </ul>
        : <p className="muted exchange-config-empty">None yet.</p>}
      {builtIn && !builtIn.present && (
        <button type="button" className="exchange-config-restore" onClick={() => builtIn.onToggle(true)}><Plus size={13} /> Restore {builtIn.label}</button>
      )}
      <div className="exchange-config-add">
        <input
          value={draft}
          inputMode="numeric"
          placeholder="Add Owner ID"
          onChange={(event) => setDraft(event.target.value.replace(/[^\d]/g, ""))}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }}
        />
        <button type="button" onClick={add} disabled={!valid || ids.includes(draft.trim())}><Plus size={14} /> Add</button>
      </div>
    </div>
  );
}

export function ExchangeConfigOverlay({ onClose, onSaved, onError }: ExchangeConfigOverlayProps) {
  const [includeNpcBroker, setIncludeNpcBroker] = useState(true);
  const [botOwnerIds, setBotOwnerIds] = useState<string[]>([]);
  const [blacklistedOwnerIds, setBlacklistedOwnerIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void exchangeApi.getConfig()
      .then((config) => {
        if (cancelled) return;
        setIncludeNpcBroker(config.includeNpcBroker !== false);
        setBotOwnerIds(config.botOwnerIds || []);
        setBlacklistedOwnerIds(config.blacklistedOwnerIds || []);
        setLoading(false);
      })
      .catch((error) => {
        if (cancelled) return;
        onError(errorText(error));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [onError]);

  async function save() {
    setSaving(true);
    onError("");
    try {
      const saved = await exchangeApi.saveConfig({ includeNpcBroker, botOwnerIds, blacklistedOwnerIds });
      onSaved(saved);
      onClose();
    } catch (error) {
      onError(errorText(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Exchange Filter Settings" onClick={onClose}>
      <div className="confirm-modal exchange-config-modal" onClick={(event) => event.stopPropagation()}>
        <div className="confirm-modal-title">
          <h3>Exchange Filter Settings</h3>
          <button className="exchange-config-close" aria-label="Close" onClick={onClose}><X size={16} /></button>
        </div>
        <p>Stored in the console only. No game data is changed. Blacklisted IDs are hidden from the market on every view.</p>
        {loading
          ? <p className="muted">Loading…</p>
          : <>
            <IdListEditor
              title="Bot User IDs"
              hint="Counted as bot listings. The in-game broker is built in; remove it to stop treating its orders as bot."
              ids={botOwnerIds}
              onChange={setBotOwnerIds}
              builtIn={{ present: includeNpcBroker, label: "In-Game Broker (Revy)", onToggle: setIncludeNpcBroker }}
            />
            <IdListEditor title="Blacklisted IDs" hint="Hidden from the market on every view." ids={blacklistedOwnerIds} onChange={setBlacklistedOwnerIds} />
          </>}
        <div className="confirm-modal-actions">
          <button onClick={onClose} disabled={saving}>Cancel</button>
          <button className="primary" onClick={() => void save()} disabled={saving || loading}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}
