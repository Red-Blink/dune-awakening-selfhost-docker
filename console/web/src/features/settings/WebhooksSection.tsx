import { useEffect, useRef, useState } from "react";
import { friendlyApiError } from "../../api/client";
import { webhooksApi, type Webhook, type WebhookEvent, type WebhookSettings, type WebhookType } from "../../api/webhooks";
import { SecretInput } from "../../components/SecretInput";
import { InlineActionResult, type InlineActionResultState } from "../../components/common/InlineActionResult";
import { formatAbsoluteDateTime } from "../../lib/display";

const EVENT_LABELS: Record<WebhookEvent, string> = {
  serverRestart: "Server restart",
  gameUpdate: "Game update available",
  consoleUpdate: "Console update available"
};
const EVENTS = Object.keys(EVENT_LABELS) as WebhookEvent[];

// `url` is only what the user typed: stored URLs never reach the browser.
type Draft = Omit<Webhook, "id"> & { key: string; id?: string; url: string };

let draftCounter = 0;
const nextKey = () => `draft-${++draftCounter}`;

function toDraft(hook: Webhook): Draft {
  return { ...hook, key: hook.id, url: "" };
}

function newDraft(): Draft {
  return { key: nextKey(), name: "Discord", type: "discord", url: "", enabled: true, events: [...EVENTS], includeMapRestarts: false, hasUrl: false, urlHint: "", lastDelivery: null };
}

function deliveryText(delivery: NonNullable<Webhook["lastDelivery"]>) {
  const when = formatAbsoluteDateTime(delivery.at);
  return delivery.ok ? `Last message delivered ${when}.` : `Last message failed ${when}: ${delivery.error}`;
}

export function WebhooksSection() {
  const [settings, setSettings] = useState<WebhookSettings | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [interval, setIntervalValue] = useState("60");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [result, setResult] = useState<InlineActionResultState | null>(null);
  const mounted = useRef(true);

  function apply(next: WebhookSettings) {
    setSettings(next);
    setDrafts(next.webhooks.map(toDraft));
    setIntervalValue(String(next.updateCheckMinutes));
    setDirty(false);
  }

  useEffect(() => {
    mounted.current = true;
    webhooksApi.settings()
      .then((next) => { if (mounted.current) apply(next); })
      .catch((error) => { if (mounted.current) setLoadError(friendlyApiError(error)); });
    return () => { mounted.current = false; };
  }, []);

  function markDirty() {
    setDirty(true);
    setResult(null);
  }

  function changeDrafts(change: (current: Draft[]) => Draft[]) {
    setDrafts(change);
    markDirty();
  }

  function update(key: string, change: Partial<Draft>) {
    changeDrafts((current) => current.map((draft) => draft.key === key ? { ...draft, ...change } : draft));
  }

  function toggleEvent(draft: Draft, event: WebhookEvent, checked: boolean) {
    update(draft.key, { events: checked ? EVENTS.filter((entry) => entry === event || draft.events.includes(entry)) : draft.events.filter((entry) => entry !== event) });
  }

  async function save() {
    setBusy(true);
    setResult(null);
    try {
      const next = await webhooksApi.save(Number(interval), drafts.map((draft) => ({
        id: draft.id,
        name: draft.name,
        type: draft.type,
        enabled: draft.enabled,
        events: draft.events,
        includeMapRestarts: draft.includeMapRestarts,
        ...(draft.url.trim() ? { url: draft.url.trim() } : {})
      })));
      if (!mounted.current) return;
      apply(next);
      setResult({ key: "save", tone: "success", text: "Webhook settings saved." });
    } catch (error) {
      if (mounted.current) setResult({ key: "save", tone: "danger", text: friendlyApiError(error) });
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function sendTest(draft: Draft) {
    if (!draft.id) return;
    const key = `test-${draft.key}`;
    setBusy(true);
    setResult({ key, tone: "neutral", text: "Sending test message", pending: true });
    try {
      const outcome = await webhooksApi.test(draft.id);
      if (!mounted.current) return;
      setResult({ key, tone: outcome.ok ? "success" : "danger", text: outcome.ok ? "Test message sent." : outcome.error });
      // Only the delivery status is taken over: the form stays editable while
      // the test runs, and replacing the drafts would discard what was typed.
      const next = await webhooksApi.settings();
      if (!mounted.current) return;
      const deliveries = new Map(next.webhooks.map((hook) => [hook.id, hook.lastDelivery]));
      setDrafts((current) => current.map((entry) => entry.id && deliveries.has(entry.id) ? { ...entry, lastDelivery: deliveries.get(entry.id) ?? null } : entry));
    } catch (error) {
      if (mounted.current) setResult({ key, tone: "danger", text: friendlyApiError(error) });
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  if (!settings) return loadError
    ? <p className="attention-text" role="alert">Could not load webhook settings: {loadError}</p>
    : <p className="muted">Loading webhooks...</p>;

  const limits = settings.limits;
  return <div className="webhooks-section">
    <p className="muted">
      Post a message to Discord or any HTTPS endpoint when the server restarts (manually or automatically) or when a game or Console update is available.
    </p>

    {drafts.length === 0 && <p className="muted">No webhooks configured yet.</p>}

    {drafts.map((draft, index) => <fieldset className="webhook-card" key={draft.key} aria-label={`Webhook ${index + 1}`}>
      <div className="webhook-fields">
        <label>Name
          <input value={draft.name} maxLength={60} onChange={(event) => update(draft.key, { name: event.target.value })} />
        </label>
        <label>Type
          <select value={draft.type} onChange={(event) => update(draft.key, { type: event.target.value as WebhookType })}>
            <option value="discord">Discord</option>
            <option value="generic">Generic JSON</option>
          </select>
        </label>
        <label className="webhook-url">Webhook URL
          <SecretInput value={draft.url}
            placeholder={draft.hasUrl ? `Saved (${draft.urlHint}). Leave empty to keep it.` : draft.type === "discord" ? "https://discord.com/api/webhooks/..." : "https://..."}
            onChange={(event) => update(draft.key, { url: event.target.value })} />
        </label>
      </div>
      <div className="webhook-options">
        <label className="webhook-check">
          <input type="checkbox" checked={draft.enabled} onChange={(event) => update(draft.key, { enabled: event.target.checked })} />Enabled
        </label>
        {EVENTS.map((event) => <label className="webhook-check" key={event}>
          <input type="checkbox" checked={draft.events.includes(event)} onChange={(change) => toggleEvent(draft, event, change.target.checked)} />{EVENT_LABELS[event]}
        </label>)}
        <label className="webhook-check" title="By default only Battlegroup restarts are announced.">
          <input type="checkbox" disabled={!draft.events.includes("serverRestart")} checked={draft.includeMapRestarts}
            onChange={(event) => update(draft.key, { includeMapRestarts: event.target.checked })} />Include map and service restarts
        </label>
      </div>
      {draft.lastDelivery && <p className={draft.lastDelivery.ok ? "muted" : "attention-text"}>{deliveryText(draft.lastDelivery)}</p>}
      <div className="action-row">
        <button type="button" disabled={busy || !draft.id || dirty} title={dirty ? "Save your changes first." : undefined}
          onClick={() => { void sendTest(draft); }}>Send Test</button>
        <button type="button" className="danger" disabled={busy}
          onClick={() => changeDrafts((current) => current.filter((entry) => entry.key !== draft.key))}>Remove</button>
        <InlineActionResult result={result} resultKey={`test-${draft.key}`} />
      </div>
    </fieldset>)}

    <div className="webhook-fields">
      <label>Update check interval (minutes)
        <input type="number" min={limits.updateCheckMinutes.min} max={limits.updateCheckMinutes.max} value={interval}
          onChange={(event) => { setIntervalValue(event.target.value); markDirty(); }} />
      </label>
    </div>
    <div className="action-row">
      <button type="button" disabled={busy || drafts.length >= limits.maxWebhooks}
        onClick={() => changeDrafts((current) => [...current, newDraft()])}>Add Webhook</button>
      <button type="button" disabled={busy || !dirty} onClick={() => { void save(); }}>{busy ? "Saving..." : "Save Webhooks"}</button>
      <InlineActionResult result={result} resultKey="save" />
    </div>
  </div>;
}
