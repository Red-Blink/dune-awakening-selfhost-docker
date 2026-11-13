import { useEffect, useRef, useState } from "react";
import { MessageCircle, RefreshCw, Search, Settings2, Trash2 } from "lucide-react";
import { chatApi, type ChatHistory, type ChatSettings } from "../../api/chat";
import "./chat.css";

const STATE_LABELS: Record<string, string> = { disabled: "Collection Off", starting: "Connecting", recording: "Collecting", unavailable: "Connection Unavailable", "storage-error": "Storage Needs Attention" };
export function ChatPanel({ onError }: { onError: (text: string) => void }) {
  const [data, setData] = useState<ChatHistory | null>(null);
  const [settings, setSettings] = useState<ChatSettings>({ enabled: false, retentionDays: 7 });
  const [showSettings, setShowSettings] = useState(false);
  const [q, setQ] = useState("");
  const [context, setContext] = useState("");
  const [filters, setFilters] = useState({ q: "", context: "", channel: "", page: 0, limit: 50 });
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const generation = useRef(0);
  const settingsDirty = useRef(false);
  const previousFilters = useRef(filters);

  useEffect(() => {
    const id = ++generation.current;
    setLoading(true);
    if (previousFilters.current !== filters) setData(current => current ? { ...current, rows: [], total: 0 } : null);
    previousFilters.current = filters;
    chatApi.history(filters).then(result => {
      if (generation.current !== id) return;
      const lastPage = Math.max(0, Math.ceil(result.total / filters.limit) - 1);
      if (filters.page > lastPage) { setFilters(f => ({ ...f, page: lastPage })); return; }
      setData(result);
      if (!settingsDirty.current) setSettings(result.settings);
    }).catch(error => { if (generation.current === id) { setData(null); onError(error instanceof Error ? error.message : String(error)); } })
      .finally(() => { if (generation.current === id) setLoading(false); });
    return () => { generation.current++; };
  }, [filters, refresh, onError]);

  useEffect(() => {
    if (!data?.settings.enabled || showSettings || filters.page !== 0) return;
    const timer = window.setInterval(() => { if (!document.hidden) setRefresh(n => n + 1); }, 5000);
    return () => window.clearInterval(timer);
  }, [data?.settings.enabled, showSettings, filters.page]);

  async function save() {
    setBusy(true); onError("");
    try { await chatApi.save(settings); settingsDirty.current = false; setShowSettings(false); setFilters(f => ({ ...f, page: 0 })); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function clear() {
    setBusy(true); onError("");
    try { await chatApi.clear(); setConfirmClear(false); setFilters(f => ({ ...f, page: 0 })); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  function edit(update: Partial<ChatSettings>) { settingsDirty.current = true; setSettings(s => ({ ...s, ...update })); }
  const totalPages = Math.max(1, Math.ceil((data?.total || 0) / filters.limit));
  const rangeStart = !data?.total ? 0 : filters.page * filters.limit + 1;
  const rangeEnd = Math.min((filters.page + 1) * filters.limit, data?.total || 0);

  return <section className="panel chat-panel">
    <div className="chat-heading">
      <div><h2><MessageCircle size={22} /> Chat</h2><p className="muted">Search published in-game messages. Captured messages may be filtered before players receive them.</p></div>
      <div className="chat-actions">
        <span className={`badge chat-status ${data?.state === "recording" ? "ok" : data?.state === "disabled" ? "bad" : ""}`}>{data ? STATE_LABELS[data.state] || "Unavailable" : loading ? "Loading..." : "Unavailable"}</span>
        <button aria-label="Refresh chat" onClick={() => setRefresh(n => n + 1)} disabled={loading}><RefreshCw size={16} /> Refresh</button>
        {data?.canConfigure && <button aria-expanded={showSettings} onClick={() => setShowSettings(s => !s)}><Settings2 size={16} /> Collection</button>}
      </div>
    </div>
    {showSettings && data?.canConfigure && <div className="chat-settings">
      <h3>Chat Collection</h3>
      <label className="chat-check"><input type="checkbox" checked={settings.enabled} onChange={e => edit({ enabled: e.target.checked })} /> Collect new chat messages</label>
      <p className="muted">Collection includes map, guild and proximity messages. Private whispers never reach the recorder.</p>
      <label className="chat-retention">Keep history for <input aria-label="Retention days" type="number" min={1} max={30} value={settings.retentionDays} onChange={e => edit({ retentionDays: Number(e.target.value) })} /> days</label>
      <p className="muted">History is limited to 5,000 messages and 10 MiB. The oldest messages are removed first. Collection starts with new messages; earlier chat cannot be recovered.</p>
      <div className="chat-actions"><button className="primary" onClick={save} disabled={busy}>Save Collection Settings</button>
        <button onClick={() => setConfirmClear(true)} disabled={busy}><Trash2 size={16} /> Clear History</button></div>
      {confirmClear && <div className="chat-clear" role="alert"><p>Delete all stored chat history? This cannot be undone.</p><button className="danger" onClick={clear} disabled={busy}>Delete All History</button> <button onClick={() => setConfirmClear(false)}>Cancel</button></div>}
    </div>}
    <form className="chat-filters" onSubmit={e => { e.preventDefault(); setFilters(f => ({ ...f, q: q.trim(), context: context.trim(), page: 0 })); }}>
      <label>Search<input aria-label="Search chat" placeholder="Message or sender" value={q} onChange={e => setQ(e.target.value)} maxLength={200} /></label>
      <label>Channel<select aria-label="Chat channel" value={filters.channel} onChange={e => { setFilters(f => ({ ...f, channel: e.target.value, page: 0 })); setConfirmClear(false); }}>
        <option value="">All Channels</option><option>Map</option><option>Guild</option><option>Proximity</option>
      </select></label>
      <label>Map / Guild<input aria-label="Map or guild" placeholder="Any map or guild" value={context} onChange={e => setContext(e.target.value)} maxLength={180} /></label>
      <button type="submit"><Search size={16} /> Search</button>
    </form>
    {data?.state === "disabled" && <p className="muted">Collection is off. An owner can enable it under Collection. Previously stored history remains available until it expires or is cleared.</p>}
    {data && ["unavailable", "storage-error"].includes(data.state) && <p role="status">{data.state === "storage-error" ? "Chat storage needs attention. Existing data has been preserved." : "Chat collection cannot connect to RabbitMQ. It will retry automatically."}</p>}
    <div className="chat-table-wrap" aria-busy={loading}>
      <table className="chat-table"><thead><tr><th>Captured</th><th>Channel / Location</th><th>Sender</th><th>Message</th></tr></thead>
        <tbody>{data?.rows.map(row => <tr key={row.id}>
          <td><span className="chat-mobile-label">Captured</span>{new Date(row.capturedAt).toLocaleString()}</td><td><span className="chat-mobile-label">Channel / Location</span><span className="badge">{row.channel}</span>{row.context && <small data-no-translate>{row.context}</small>}</td>
          <td><span className="chat-mobile-label">Sender</span><span data-no-translate>{row.senderName || row.sender}</span>{row.senderName && <small data-no-translate>{row.sender}</small>}</td>
          <td className="chat-message"><span className="chat-mobile-label">Message</span><span data-no-translate>{row.text}</span></td>
        </tr>)}</tbody>
      </table>
      {!data?.rows.length && <div className="chat-empty"><MessageCircle size={28} /><strong>{loading ? "Loading chat..." : "No Messages Found"}</strong><p className="muted">{filters.q || filters.channel || filters.context ? "Try another search or channel." : "New messages will appear here after collection is enabled."}</p></div>}
    </div>
    <div className="panel-title players-pagination-footer"><p className="action-help-note">Showing {rangeStart}-{rangeEnd} of {(data?.total || 0).toLocaleString()}</p><div className="database-pagination-controls">
      <label className="compact-select">Rows<select aria-label="Chat rows" value={filters.limit} onChange={e => setFilters(f => ({ ...f, limit: Number(e.target.value), page: 0 }))}>{[25, 50, 100, 200].map(n => <option key={n}>{n}</option>)}</select></label>
      <button disabled={loading || !filters.page} onClick={() => setFilters(f => ({ ...f, page: 0 }))}>First</button>
      <button disabled={loading || !filters.page} onClick={() => setFilters(f => ({ ...f, page: f.page - 1 }))}>Previous</button>
      <span className="muted database-page-indicator">Page {filters.page + 1} of {totalPages}</span>
      <button disabled={loading || filters.page + 1 >= totalPages} onClick={() => setFilters(f => ({ ...f, page: f.page + 1 }))}>Next</button>
      <button disabled={loading || filters.page + 1 >= totalPages} onClick={() => setFilters(f => ({ ...f, page: totalPages - 1 }))}>Last</button>
    </div></div>
    <p className="muted chat-footnote">The newest page refreshes every five seconds. Whispers are never collected. Faction and party are not supported yet.</p>
  </section>;
}
