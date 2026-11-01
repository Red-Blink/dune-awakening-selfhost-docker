import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Ban, Clock3, Copy, KeyRound, LoaderCircle, Plus, Search, Trash2 } from "lucide-react";
import {
  apiKeysApi,
  describeScopes,
  grantedCount,
  endOfLocalDayIso,
  grantableActions,
  scopeLabel,
  scopeValueOf,
  selectedActions,
  supportsCustom,
  type ApiKey,
  type ApiKeyScopes,
  type ScopeCatalogEntry,
  type ScopeLevel
} from "../../api/apiKeys";
import { DataTable } from "../../components/common/DataTable";
import { InlineActionResult, type InlineActionResultState } from "../../components/common/InlineActionResult";
import { SegmentedControl, type SegmentOption } from "../../components/common/SegmentedControl";
import { copyText } from "../../lib/clipboard";
import { RealtimeAgentNotice } from "./RealtimeAgentNotice";

type ConfirmAction = (
  message: string,
  options?: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }
) => Promise<boolean>;

// "none" exists only in the UI. It is the absence of a scope entry, never a
// stored value -- see toScopes below.
type SegmentValue = ScopeLevel | "none" | "custom";

// The server rejects a past expiry; `min` stops the picker offering one in the
// first place, so the operator finds out before submitting rather than after.
function todayIso() {
  const now = new Date();
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
}

const COLUMNS = ["name", "prefix", "scopes", "lastUsed", "expires"];
const COLUMN_LABELS: Record<string, string> = {
  name: "Name",
  prefix: "Prefix",
  scopes: "Permissions",
  lastUsed: "Last Used",
  expires: "Expires"
};

export function ApiKeysSection({ confirmAction }: { confirmAction: ConfirmAction }) {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [catalog, setCatalog] = useState<ScopeCatalogEntry[]>([]);
  const [result, setResult] = useState<InlineActionResultState | null>(null);
  const [busyId, setBusyId] = useState("");
  const [creating, setCreating] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [rateLimit, setRateLimit] = useState("60");
  // Every namespace starts at None. This map holds only what has been granted.
  const [draftScopes, setDraftScopes] = useState<ApiKeyScopes>({});
  const [scopeQuery, setScopeQuery] = useState("");
  const [revealed, setRevealed] = useState<{ name: string; secret: string } | null>(null);
  const [copied, setCopied] = useState(false);
  // Tracked separately from `result`: the scope grid cannot be rendered
  // without the catalog, so this has to persist rather than auto-dismiss.
  const [catalogError, setCatalogError] = useState("");
  // Tracks which secret we have already focused, so re-renders (the Copy button
  // flipping to "Copied", say) do not yank focus back to the field.
  const focusedSecret = useRef("");

  async function refresh() {
    // Settled, not all: the two fetches fail for different reasons, and a catalog
    // failure must not blank the key list or leave the create form a dead end.
    const [listed, scopeCatalog] = await Promise.allSettled([apiKeysApi.list(), apiKeysApi.catalog()]);
    if (scopeCatalog.status === "fulfilled") {
      setCatalog(scopeCatalog.value.namespaces);
      setCatalogError("");
    } else {
      setCatalogError(reasonText(scopeCatalog.reason));
    }
    if (listed.status === "rejected") throw listed.reason;
    setKeys(listed.value.keys);
  }

  function reasonText(reason: unknown) {
    return reason instanceof Error ? reason.message : String(reason);
  }

  useEffect(() => {
    refresh().catch((error) => {
      setKeys([]);
      setResult({ key: "list", tone: "danger", text: error instanceof Error ? error.message : String(error) });
    });
  }, []);

  useEffect(() => {
    if (!result || result.pending) return undefined;
    const id = window.setTimeout(() => setResult(null), 8000);
    return () => window.clearTimeout(id);
  }, [result]);

  const grants = grantedCount(draftScopes);
  const visibleCatalog = useMemo(() => {
    const query = scopeQuery.trim().toLowerCase();
    return catalog.filter((entry) => `${scopeLabel(entry.namespace)} ${entry.namespace}`.toLowerCase().includes(query));
  }, [catalog, scopeQuery]);

  // The mutation is already committed by the time the list refreshes, so a
  // refresh failure must never read as if the action failed.
  async function refreshAfterSuccess(succeeded: string) {
    try {
      await refresh();
      setResult({ key: "list", tone: "success", text: succeeded });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setResult({ key: "list", tone: "danger", text: `${succeeded} The list could not be refreshed, so it may be out of date. ${detail}` });
    }
  }

  function resetForm() {
    setName("");
    setExpiresAt("");
    setRateLimit("60");
    setDraftScopes({});
    setScopeQuery("");
  }

  function setLevel(namespace: string, level: SegmentValue) {
    setDraftScopes((current) => {
      const next = { ...current };
      // None is stored as absence, so the operator can never end up with a
      // key carrying a level that means nothing.
      if (level === "none") { delete next[namespace]; return next; }
      if (level !== "custom") { next[namespace] = level; return next; }
      // Custom seeds from what the namespace grants right now, so switching
      // does not silently drop the operator's existing choice. An empty seed
      // (from None) stays an empty array -- "Custom, nothing ticked yet",
      // which createKey refuses to send.
      const entry = catalog.find((candidate) => candidate.namespace === namespace);
      // Sorted, like toggleAction below and like the server stores it.
      // Catalog order would make what gets SENT depend on how the operator
      // reached the selection, and reorder the draft when the key came back.
      next[namespace] = entry ? [...selectedActions(current, entry)].sort() : [];
      return next;
    });
  }

  function toggleAction(namespace: string, action: string, checked: boolean) {
    setDraftScopes((current) => {
      const value = current[namespace];
      const actions = Array.isArray(value) ? value : [];
      const next = { ...current };
      next[namespace] = checked
        ? [...new Set([...actions, action])].sort()
        : actions.filter((candidate) => candidate !== action);
      return next;
    });
  }

  async function createKey() {
    setCreating(true);
    setResult({ key: "create", tone: "neutral", text: "Creating API key...", pending: true });
    let createdName = "";
    try {
      const created = await apiKeysApi.create({
        name,
        scopes: draftScopes,
        expiresAt: endOfLocalDayIso(expiresAt),
        rateLimitPerMinute: Number(rateLimit) || undefined
      });
      createdName = created.key.name;
      setRevealed({ name: created.key.name, secret: created.secret });
      setCopied(false);
      setFormOpen(false);
      resetForm();
      setResult(null);
    } catch (error) {
      // The form is still mounted on this path, so "create" is visible.
      setResult({ key: "create", tone: "danger", text: error instanceof Error ? error.message : String(error) });
      return;
    } finally {
      setCreating(false);
    }
    // Refreshed separately: the create already succeeded and the form is now
    // unmounted, so a failure here must report at the list -- keying it
    // "create" sent it to a component that no longer exists, leaving a stale
    // table and no error while the key really did exist on the server.
    await refreshAfterSuccess(`${createdName} created.`);
  }

  async function toggleEnabled(key: ApiKey) {
    setBusyId(key.id);
    setResult(null);
    try {
      const updated = await apiKeysApi.update(key.id, { enabled: !key.enabled });
      // The update returns the saved key. Reflect that confirmed state in the
      // control itself without a success banner or a second list request.
      setKeys((current) => current?.map((entry) => entry.id === key.id ? updated.key : entry) ?? current);
    } catch (error) {
      setResult({ key: "list", tone: "danger", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyId("");
    }
  }

  async function revokeKey(key: ApiKey) {
    // "revoke" is not in ConfirmDialog's danger auto-detect regex, so this is
    // passed explicitly rather than inferred from the message.
    const confirmed = await confirmAction(
      `Revoke the API key "${key.name}"? Anything using it will stop working immediately, and the key cannot be restored.`,
      { title: "Revoke API Key", confirmLabel: "Revoke", danger: true }
    );
    if (!confirmed) return;
    setBusyId(key.id);
    try {
      await apiKeysApi.revoke(key.id);
    } catch (error) {
      // Keyed "list", not key.id: no mount listens for the latter, so a revoke
      // that failed after the operator cleared the danger dialog said nothing.
      setResult({ key: "list", tone: "danger", text: error instanceof Error ? error.message : String(error) });
      setBusyId("");
      return;
    }
    // The key is gone at this point, so a refresh failure must still say so --
    // otherwise the table keeps listing a revoked key as Active.
    await refreshAfterSuccess(`${key.name} revoked.`);
    setBusyId("");
  }

  async function copySecret() {
    if (!revealed) return;
    try {
      // copyText throws rather than returning a flag; on a plain-HTTP LAN
      // address the Clipboard API is blocked and even its execCommand
      // fallback can fail, so a silent "Copied" would be a lie about the one
      // value the operator cannot recover.
      await copyText(revealed.secret);
      setCopied(true);
    } catch {
      setCopied(false);
      setResult({ key: "reveal", tone: "danger", text: "Could not copy automatically. Select the key and copy it manually." });
    }
  }

  const rows = useMemo(() => (keys || []).map((key) => ({
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    // Keep a full-text tooltip as well as the wrapped permission summary.
    scopes: describeScopes(key.scopes),
    lastUsed: key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : "Never",
    expires: key.expiresAt ? new Date(key.expiresAt).toLocaleDateString() : "Never"
  })), [keys]);

  const keyById = useMemo(() => new Map((keys || []).map((key) => [key.id, key])), [keys]);

  function keyControl(key: ApiKey) {
    const pending = busyId === key.id;
    const state = key.expired ? "expired" : key.enabled ? "enabled" : "disabled";
    const text = pending ? "Updating" : key.expired ? "Expired" : key.enabled ? "Enabled" : "Disabled";
    const Icon = pending ? LoaderCircle : key.expired ? Clock3 : key.enabled ? KeyRound : Ban;
    return <button type="button" className={`api-key-state-button is-${state}`} disabled={Boolean(busyId) || key.expired}
      aria-busy={pending}
      aria-label={key.expired ? `Expired ${key.name}` : `${key.enabled ? "Disable" : "Enable"} ${key.name}`}
      title={key.expired ? "This key has expired. Create a new key to restore access." : `${key.enabled ? "Disable" : "Enable"} this key`}
      onClick={() => { void toggleEnabled(key); }}>
      <Icon size={16} aria-hidden="true" />
      <span className="api-key-state-name">{key.name}</span>
      <span className="api-key-state-label">{text}</span>
    </button>;
  }

  // Realtime Data needs the position agent: true while an active key, or the key
  // being created, holds the permission.
  const realtimeNeeded = Boolean(keys?.some((key) => key.enabled && !key.expired && scopeValueOf(key.scopes, "realtime") !== undefined))
    || (formOpen && scopeValueOf(draftScopes, "realtime") !== undefined);

  return <div className="api-keys-section">
    <div className="api-keys-header">
      <p className="muted">Give external tools their own API keys, with only the permissions they need. You can disable or revoke a key at any time.</p>
      {!formOpen && <button onClick={() => { resetForm(); setFormOpen(true); }}>
        <Plus size={16} aria-hidden="true" /> Create Key
      </button>}
    </div>

    {/* role="alert" + aria-live: the secret cannot be recovered, so its
        appearance has to be announced rather than only shown. Focus moves to
        the field itself (below) because the button the operator activated is
        unmounted at this point, which would otherwise drop focus to the body. */}
    {revealed && <div className="api-key-reveal" role="alert" aria-live="assertive">
      <div className="api-key-reveal-warning">
        <AlertTriangle size={16} aria-hidden="true" />
        <span>Copy this key now. It will not be shown again.</span>
      </div>
      <div className="api-key-reveal-row">
        <input
          readOnly
          ref={(node) => { if (node && revealed.secret !== focusedSecret.current) { focusedSecret.current = revealed.secret; node.focus(); node.select(); } }}
          value={revealed.secret}
          aria-label={`API key for ${revealed.name}. Copy it now, it will not be shown again.`}
          onFocus={(event) => event.target.select()}
        />
        <button onClick={() => { void copySecret(); }}><Copy size={16} aria-hidden="true" /> {copied ? "Copied" : "Copy"}</button>
      </div>
      <div className="action-row">
        <button onClick={() => setRevealed(null)}>I&apos;ve Saved It</button>
        <InlineActionResult result={result} resultKey="reveal" />
      </div>
    </div>}

    {keys === null
      ? <p className="muted">Loading API Keys...</p>
      : keys.length === 0 ? <div className="api-keys-empty"><KeyRound size={24} aria-hidden="true" /><div><strong>No API keys yet.</strong><p className="muted">Create a key to connect an external tool.</p></div></div>
      : <DataTable
        tableClassName="api-keys-table"
        wrapClassName="api-keys-table-wrap"
        rows={rows}
        columns={COLUMNS}
        columnLabels={COLUMN_LABELS}
        renderCell={(row: Record<string, unknown>, col: string) =>
          col === "scopes"
            ? <span className="api-key-scope-summary" title={String(row.scopes)}>{String(row.scopes)}</span>
            : col === "name" && keyById.has(String(row.id)) ? keyControl(keyById.get(String(row.id))!)
            : col === "prefix" ? <code>{String(row.prefix)}</code>
            : String(row[col] ?? "")}
        rowKey={(row: Record<string, unknown>) => String(row.id)}
        emptyMessage="No API keys yet. Create one to call this console from outside the browser."
        // Without this the <td> has no class and `.actions-column
        // .icon-toggle-group` never matches, leaving the two row icons flush
        // against each other. Every other DataTable consumer passes it.
        actionClassName="actions-column"
        action={(row: Record<string, unknown>) => {
          const key = keyById.get(String(row.id));
          if (!key) return null;
          return <div className="icon-toggle-group">
            <button
              className="icon-toggle-button danger"
              disabled={Boolean(busyId)}
              title="Revoke this key"
              aria-label={`Revoke ${key.name}`}
              onClick={(event) => { event.stopPropagation(); void revokeKey(key); }}
            ><Trash2 size={16} /></button>
          </div>;
        }}
      />}

    {/* Rendered outside the create form: a catalog outage while the form is
        closed used to be invisible, and the state does not auto-dismiss, so it
        could be arbitrarily stale by the time anyone opened the form. */}
    {catalogError && <p className="error">
      {catalog.length
        ? `The permission list could not be refreshed, so it may be out of date. ${catalogError}`
        : `The permission list could not be loaded, so no permissions can be chosen. ${catalogError}`}
    </p>}

    <InlineActionResult result={result} resultKey="list" />

    <RealtimeAgentNotice needed={realtimeNeeded} confirmAction={confirmAction} />

    {formOpen && <div className="api-key-form">
      <div className="api-key-form-heading"><h3>Create API Key</h3><p className="muted">Name the key, choose its limits, then select its permissions.</p></div>
      <div className="settings-password-grid api-key-form-grid">
        <div className="api-key-form-field"><label>Name<input aria-describedby="api-key-name-help" value={name} disabled={creating} maxLength={64} placeholder="e.g. Map Viewer" onChange={(event) => setName(event.target.value)} /></label><p id="api-key-name-help" className="muted">The tool or service that will use this key.</p></div>
        <div className="api-key-form-field"><label>Expires<input aria-describedby="api-key-expiry-help" type="date" min={todayIso()} value={expiresAt} disabled={creating} onChange={(event) => setExpiresAt(event.target.value)} /></label><p id="api-key-expiry-help" className="muted">Optional. Leave blank for no expiry.</p></div>
        <div className="api-key-form-field"><label>Requests per Minute<input aria-describedby="api-key-rate-help" type="number" min="1" max="10000" value={rateLimit} disabled={creating} onChange={(event) => setRateLimit(event.target.value.replace(/[^\d]/g, ""))} /></label><p id="api-key-rate-help" className="muted">The maximum request rate for this key.</p></div>
      </div>

      <div className="api-key-scope-header">
        <div><h3>Permissions</h3><p className="muted">Choose access for each area. Everything starts at None.</p></div>
        <div className="api-key-scope-selection"><span aria-live="polite">{grants} of {catalog.length} selected</span><button disabled={creating || !grants} onClick={() => setDraftScopes({})}>Clear All</button></div>
      </div>
      <label className="api-key-scope-search"><Search size={16} aria-hidden="true" /><input type="search" aria-label="Search permissions" placeholder="Search permissions..." value={scopeQuery} disabled={creating} onChange={(event) => setScopeQuery(event.target.value)} /></label>

      <div className="api-key-scope-grid">
        {visibleCatalog.map((entry) => {
          const stored = scopeValueOf(draftScopes, entry.namespace);
          const level: SegmentValue = Array.isArray(stored) ? "custom" : stored ?? "none";
          const chosen = Array.isArray(stored) ? stored : [];
          // logs has no write action and updates' writes are denied to keys, so
          // offering a third segment there would be a control that changes
          // nothing. Driven off the catalog, not a hardcoded name.
          // Each ariaLabel STARTS with the visible label. WCAG 2.5.3 Label in
          // Name: a voice-control user says what they can see ("click
          // Read+write"), so the accessible name has to contain it. RankSegments
          // documents preserving exactly this property; the first version of
          // this grid dropped it ("None" vs "No access to bases").
          const options: SegmentOption<SegmentValue>[] = [
            { value: "none", label: "None", ariaLabel: `None — no access to ${entry.namespace}` },
            { value: "read", label: "Read", ariaLabel: `Read ${entry.namespace}` }
          ];
          if (entry.supportsWrite) options.push({ value: "write", label: "Read+Write", ariaLabel: `Read+Write for ${entry.namespace}` });
          // Catalog-driven, like supportsWrite above. See supportsCustom.
          if (supportsCustom(entry)) options.push({ value: "custom", label: "Custom", ariaLabel: `Custom actions for ${entry.namespace}` });
          const actions = grantableActions(entry);
          // Must match grantedCount, which drops an empty action list because
          // the server does. `level !== "none"` alone paints an empty Custom
          // row as reached while Create stays disabled.
          const granted = level === "custom" ? chosen.length > 0 : level !== "none";
          return <div className={`api-key-scope-row${granted ? " granted" : ""}`} key={entry.namespace}>
            <span className="api-key-scope-name">{scopeLabel(entry.namespace)}</span>
            <SegmentedControl
              name={`api-key-scope-${entry.namespace}`}
              ariaLabel={`Access level for ${entry.namespace}`}
              value={level}
              options={options}
              disabled={creating}
              onChange={(next) => setLevel(entry.namespace, next)}
              groupClassName="segmented-control api-key-scope-segments"
            />
            {level === "custom" && <fieldset className="api-key-scope-actions">
              <legend className="muted">
                {chosen.length} of {actions.length} actions selected
                {!chosen.length && " — tick at least one, or switch back to None"}
              </legend>
              {actions.map((action) => <label key={action} className="api-key-scope-action">
                <input aria-label={action}
                  type="checkbox"
                  checked={chosen.includes(action)}
                  disabled={creating}
                  onChange={(event) => toggleAction(entry.namespace, action, event.target.checked)}
                />
                <code>{action}</code>
              </label>)}
            </fieldset>}
          </div>;
        })}
      </div>
      {scopeQuery.trim() && !visibleCatalog.length && <div className="api-key-scope-empty"><p className="muted">No permissions match your search.</p><button disabled={creating} onClick={() => setScopeQuery("")}>Clear Search</button></div>}

      <div className="action-row api-key-form-footer">
        <button disabled={creating || !name.trim() || !grants} onClick={() => { void createKey(); }}>
          {creating ? "Creating..." : "Create Key"}
        </button>
        <button disabled={creating} onClick={() => { setFormOpen(false); resetForm(); }}>Cancel</button>
        {!grants && <span className="muted">Choose at least one permission to continue.</span>}
        <InlineActionResult result={result} resultKey="create" />
      </div>
    </div>}
  </div>;
}
