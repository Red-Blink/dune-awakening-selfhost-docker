import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Ban, Check, Copy, Plus, Trash2 } from "lucide-react";
import {
  apiKeysApi,
  describeScopes,
  grantedCount,
  endOfLocalDayIso,
  keyStatus,
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

const COLUMNS = ["name", "prefix", "scopes", "status", "lastUsed", "expires"];
const COLUMN_LABELS: Record<string, string> = {
  name: "Name",
  prefix: "Prefix",
  scopes: "Scopes",
  status: "Status",
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
    try {
      await apiKeysApi.update(key.id, { enabled: !key.enabled });
    } catch (error) {
      setResult({ key: "list", tone: "danger", text: error instanceof Error ? error.message : String(error) });
      setBusyId("");
      return;
    }
    await refreshAfterSuccess(`${key.name} ${key.enabled ? "disabled" : "enabled"}.`);
    setBusyId("");
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
    // The global `td { max-width: 360px }` ellipses this, and it is the column
    // that says what the key can actually do -- without a title the grants
    // become unreadable past about five namespaces.
    scopes: describeScopes(key.scopes),
    status: keyStatus(key),
    lastUsed: key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : "Never",
    expires: key.expiresAt ? new Date(key.expiresAt).toLocaleDateString() : "Never"
  })), [keys]);

  const keyById = useMemo(() => new Map((keys || []).map((key) => [key.id, key])), [keys]);

  return <div className="api-keys-section">
    <p className="muted">
      Named keys for calling this console&apos;s HTTP API from outside the browser. Send one as
      {" "}<code>Authorization: Bearer &lt;key&gt;</code>. Each key reaches only what you grant it below.
    </p>

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
      : <DataTable
        rows={rows}
        columns={COLUMNS}
        columnLabels={COLUMN_LABELS}
        renderCell={(row: Record<string, unknown>, col: string) =>
          col === "scopes"
            ? <span title={String(row.scopes)}>{String(row.scopes)}</span>
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
              className="icon-toggle-button"
              disabled={busyId === key.id}
              title={key.enabled ? "Disable this key" : "Enable this key"}
              aria-label={`${key.enabled ? "Disable" : "Enable"} ${key.name}`}
              onClick={(event) => { event.stopPropagation(); void toggleEnabled(key); }}
            >{key.enabled ? <Ban size={16} /> : <Check size={16} />}</button>
            <button
              className="icon-toggle-button danger"
              disabled={busyId === key.id}
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
        ? `The list of grantable namespaces could not be refreshed, so it may be out of date. ${catalogError}`
        : `The list of grantable namespaces could not be loaded, so no permissions can be chosen. ${catalogError}`}
    </p>}

    <div className="action-row">
      {!formOpen && <button onClick={() => { resetForm(); setFormOpen(true); }}>
        <Plus size={16} aria-hidden="true" /> Create Key
      </button>}
      <InlineActionResult result={result} resultKey="list" />
    </div>

    {formOpen && <div className="api-key-form">
      <div className="settings-password-grid api-key-form-grid">
        <label>Name<input value={name} disabled={creating} maxLength={64} placeholder="Grafana Dashboard" onChange={(event) => setName(event.target.value)} /></label>
        <label>Expires<input type="date" min={todayIso()} value={expiresAt} disabled={creating} onChange={(event) => setExpiresAt(event.target.value)} /></label>
        <label>Rate Limit / Min<input type="number" min="1" max="10000" value={rateLimit} disabled={creating} onChange={(event) => setRateLimit(event.target.value.replace(/[^\d]/g, ""))} /></label>
      </div>

      <div className="api-key-scope-header">
        <span className="muted">Scope — Nothing Is Granted Until You Grant It</span>
        <button disabled={creating || !grants} onClick={() => setDraftScopes({})}>Clear All</button>
      </div>

      <div className="api-key-scope-grid">
        {catalog.map((entry) => {
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
                <input
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

      <div className="action-row">
        <button disabled={creating || !name.trim() || !grants} onClick={() => { void createKey(); }}>
          {creating ? "Creating..." : "Create Key"}
        </button>
        <button disabled={creating} onClick={() => { setFormOpen(false); resetForm(); }}>Cancel</button>
        {!grants && <span className="muted">Grant At Least One Namespace First</span>}
        <InlineActionResult result={result} resultKey="create" />
      </div>
    </div>}
  </div>;
}
