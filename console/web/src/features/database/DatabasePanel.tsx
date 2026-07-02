import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { databaseApi } from "../../api/database";
import { setupApi, type Task } from "../../api/setup";
import { SecretInput } from "../../components/SecretInput";
import { DataTable } from "../../components/common/DataTable";
import { KeyValueGrid, StatusPill, TechnicalDetails } from "../../components/common/DisplayPrimitives";
import { formatUiSentence } from "../../lib/display";
import { conciseTaskError } from "../../lib/taskDisplay";

type HomeTaskResult = { status: "running" | "succeeded" | "failed" | "stopped"; title: string; message?: string; details?: string };
type DatabasePasswordState = { taskId?: string; result: HomeTaskResult | null };

const DATABASE_PASSWORD_STATE_KEY = "arrakis.databasePasswordState";
const DATABASE_PREVIEW_MAX_ROWS = 10000;

function formatResultTitle(value: unknown, pending = false) {
  return formatUiSentence(value, pending);
}

function formatResultMessage(value: unknown) {
  return formatUiSentence(value, false);
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function isTerminalTask(status: string) {
  return ["succeeded", "failed", "cancelled"].includes(status);
}

type SortState = { column: string; direction: "asc" | "desc" };

function useSortableRows<T extends Record<string, unknown>>(rows: T[]) {
  const [sort, setSort] = useState<SortState | null>(null);
  const sortedRows = sort ? [...rows].sort((a, b) => compareTableValues(a[sort.column], b[sort.column], sort.direction)) : rows;
  function onSort(column: string) {
    setSort((current) => (current?.column === column ? { column, direction: current.direction === "asc" ? "desc" : "asc" } : { column, direction: "asc" }));
  }
  return { sortedRows, sortColumn: sort?.column, sortDirection: sort?.direction, onSort, reset: () => setSort(null) };
}

function loadDatabasePasswordState(): DatabasePasswordState {
  if (typeof window === "undefined") return { result: null };
  try {
    const raw = window.localStorage.getItem(DATABASE_PASSWORD_STATE_KEY);
    if (!raw) return { result: null };
    const parsed = JSON.parse(raw) as DatabasePasswordState;
    return parsed && parsed.result ? parsed : { result: null };
  } catch {
    return { result: null };
  }
}

function persistDatabasePasswordState(state: DatabasePasswordState) {
  if (typeof window === "undefined") return;
  if (!state.result) {
    window.localStorage.removeItem(DATABASE_PASSWORD_STATE_KEY);
    return;
  }
  window.localStorage.setItem(DATABASE_PASSWORD_STATE_KEY, JSON.stringify(state));
}

async function pollDatabasePasswordRestart(
  taskId: string,
  setState: (state: DatabasePasswordState) => void,
  onFinished: () => Promise<void>
) {
  let current: Task;
  try {
    current = (await setupApi.task(taskId)).task;
    for (let i = 0; i < 3600 && !isTerminalTask(current.status); i += 1) {
      const runningState = { taskId, result: { status: "running", title: "Restarting Server..." } satisfies HomeTaskResult };
      persistDatabasePasswordState(runningState);
      setState(runningState);
      await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 1000));
      current = (await setupApi.task(taskId)).task;
    }
  } catch (error) {
    const failed = { result: { status: "failed", title: "Password Change Failed", message: error instanceof Error ? error.message : String(error) } satisfies HomeTaskResult };
    persistDatabasePasswordState(failed);
    setState(failed);
    return;
  }
  const next = current.status === "succeeded"
    ? { result: { status: "succeeded", title: "Password Changed Successfully" } satisfies HomeTaskResult }
    : { result: { status: "failed", title: "Password Change Failed", message: conciseTaskError(current) } satisfies HomeTaskResult };
  persistDatabasePasswordState(next);
  setState(next);
  await onFinished().catch(() => undefined);
}

export function DatabasePanel() {
  const [schema, setSchema] = useState("dune");
  const [tables, setTables] = useState<Record<string, unknown>[]>([]);
  const [selected, setSelected] = useState("");
  const [preview, setPreview] = useState<{ columns?: { name: string }[]; rows?: Record<string, unknown>[] } | null>(null);
  const [columns, setColumns] = useState<Record<string, unknown>[]>([]);
  const [count, setCount] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [sql, setSql] = useState("select * from dune.player_state limit 25");
  const [queryResult, setQueryResult] = useState<{ columns?: { name: string }[]; rows?: Record<string, unknown>[]; rowCount?: number; command?: string } | null>(null);
  const [queryError, setQueryError] = useState("");
  const [queryRan, setQueryRan] = useState(false);
  const [databaseStatus, setDatabaseStatus] = useState<Record<string, unknown> | null>(null);
  const [databaseStatusError, setDatabaseStatusError] = useState("");
  const [databaseStatusLoading, setDatabaseStatusLoading] = useState(false);
  const [passwordPanelOpen, setPasswordPanelOpen] = useState(false);
  const [databasePassword, setDatabasePassword] = useState("");
  const [databasePasswordConfirm, setDatabasePasswordConfirm] = useState("");
  const [databasePasswordState, setDatabasePasswordState] = useState<DatabasePasswordState>(() => loadDatabasePasswordState());
  const [tableSearch, setTableSearch] = useState("");
  const [search, setSearch] = useState("");
  const [searchRows, setSearchRows] = useState<Record<string, unknown>[]>([]);
  const [searchRan, setSearchRan] = useState(false);
  const [advancedSqlOpen, setAdvancedSqlOpen] = useState(false);
  const [editRow, setEditRow] = useState<Record<string, unknown> | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [editResult, setEditResult] = useState<HomeTaskResult | null>(null);
  const previewRef = useRef<HTMLHeadingElement | null>(null);
  const editRef = useRef<HTMLElement | null>(null);
  const databasePasswordResult = databasePasswordState.result;
  async function loadTables() { setTables(await databaseApi.tables(schema)); }
  useEffect(() => {
    loadTables().catch(() => undefined);
  }, []);
  useEffect(() => {
    let cancelled = false;
    if (!databasePasswordState.taskId || databasePasswordState.result?.status !== "running") return undefined;
    void pollDatabasePasswordRestart(databasePasswordState.taskId, (next) => {
      if (!cancelled) setDatabasePasswordState(next);
    }, async () => {
      if (!cancelled) await loadDatabaseStatus();
    });
    return () => {
      cancelled = true;
    };
  }, [databasePasswordState.taskId, databasePasswordState.result?.status]);
  useEffect(() => {
    if (!(databaseStatus || databaseStatusError) || databaseStatusLoading) return undefined;
    const timer = window.setTimeout(() => {
      setDatabaseStatus(null);
      setDatabaseStatusError("");
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [databaseStatus, databaseStatusError, databaseStatusLoading]);
  useEffect(() => {
    if (!editResult || editResult.status === "running") return undefined;
    const timer = window.setTimeout(() => setEditResult(null), 5000);
    return () => window.clearTimeout(timer);
  }, [editResult]);
  useEffect(() => {
    if (!queryRan || (!queryError && !queryResult)) return undefined;
    if (!queryError && Array.isArray(queryResult?.rows) && queryResult.rows.length > 0) return undefined;
    const timer = window.setTimeout(() => {
      setQueryRan(false);
      setQueryError("");
      setQueryResult(null);
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [queryRan, queryError, queryResult]);
  function updateDatabasePasswordState(next: DatabasePasswordState) {
    setDatabasePasswordState(next);
    persistDatabasePasswordState(next);
  }
  async function open(table: string) {
    setSelected(table);
    setEditRow(null);
    setEditResult(null);
    setPreview(null);
    setColumns([]);
    setCount("");
    setPreviewError("");
    columnsSort.reset();
    previewSort.reset();
    await refreshTablePreview(table);
    window.setTimeout(() => previewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }
  async function refreshTablePreview(table: string) {
    setPreviewLoading(true);
    setPreviewError("");
    try {
      const [nextColumns, nextCount] = await Promise.all([
        databaseApi.columns(schema, table),
        databaseApi.count(schema, table)
      ]);
      const rowCount = Math.max(0, Number(nextCount.count) || 0);
      const previewLimit = Math.max(1, Math.min(rowCount || DATABASE_PREVIEW_MAX_ROWS, DATABASE_PREVIEW_MAX_ROWS));
      const nextPreview = rowCount > 0 ? await databaseApi.preview(schema, table, previewLimit, 0) : { columns: [], rows: [] };
      setPreview(nextPreview);
      setColumns(nextColumns);
      setCount(String(nextCount.count));
    } catch (error) {
      setPreview(null);
      setColumns([]);
      setPreviewError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreviewLoading(false);
    }
  }
  async function loadDatabaseStatus() {
    setDatabaseStatusLoading(true);
    setDatabaseStatusError("");
    try {
      setDatabaseStatus(await databaseApi.status());
    } catch (error) {
      setDatabaseStatus(null);
      setDatabaseStatusError(error instanceof Error ? error.message : String(error));
    } finally {
    setDatabaseStatusLoading(false);
    }
  }
  async function changeDatabasePassword() {
    if (databasePassword.length < 4) {
      updateDatabasePasswordState({ result: { status: "failed", title: "Password Change Failed", message: "Database password must be at least 4 characters." } });
      return;
    }
    if (databasePassword !== databasePasswordConfirm) {
      updateDatabasePasswordState({ result: { status: "failed", title: "Password Change Failed", message: "Passwords do not match." } });
      return;
    }
    updateDatabasePasswordState({ result: { status: "running", title: "Changing Password..." } });
    try {
      const response = await databaseApi.changePassword(databasePassword);
      setDatabasePassword("");
      setDatabasePasswordConfirm("");
      const runningState = { taskId: response.task.id, result: { status: "running", title: "Restarting Server..." } satisfies HomeTaskResult };
      updateDatabasePasswordState(runningState);
      setDatabaseStatus((current) => current ? { ...current, usesDefaultPassword: false } : current);
    } catch (error) {
      updateDatabasePasswordState({ result: { status: "failed", title: "Password Change Failed", message: error instanceof Error ? error.message : String(error) } });
    }
  }
  function startEdit(row: Record<string, unknown>) {
    setEditRow(row);
    setEditResult(null);
    setEditValues(Object.fromEntries(databasePreviewColumns(preview).map((column) => [column, serializeEditableDbValue(row[column])])));
    window.setTimeout(() => editRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }
  async function saveEditedRow() {
    if (!selected || !editRow) return;
    const rowId = String(editRow.__rowid || "");
    setEditResult({ status: "running", title: "Saving Row..." });
    try {
      const originalValues = Object.fromEntries(databasePreviewColumns(preview).map((column) => [column, editRow[column]]));
      const nextValues = Object.fromEntries(Object.entries(editValues).map(([key, value]) => [key, parseEditableDbValue(value, originalValues[key])]));
      const result = await databaseApi.updateRow(schema, selected, rowId, nextValues);
      await refreshTablePreview(selected);
      setEditRow(null);
      setEditResult(result.updatedRows > 0
        ? { status: "succeeded", title: "Row Saved Successfully", message: result.message }
        : { status: "failed", title: "Row Save Failed", message: "The row was not updated. Refresh the table and try again." });
    } catch (error) {
      setEditResult({ status: "failed", title: "Row Save Failed", message: error instanceof Error ? error.message : String(error) });
    }
  }
  async function runQuery() {
    setQueryRan(true);
    setQueryError("");
    try {
      setQueryResult(await databaseApi.query(sql));
    } catch (error) {
      setQueryResult(null);
      setQueryError(error instanceof Error ? error.message : String(error));
    }
  }
  async function exportQueryJson() {
    setQueryRan(true);
    setQueryError("");
    try {
      const result = await databaseApi.export(sql);
      setQueryResult(result);
      downloadText("query-export.json", JSON.stringify(result, null, 2));
    } catch (error) {
      setQueryResult(null);
      setQueryError(error instanceof Error ? error.message : String(error));
    }
  }
  async function searchColumns() {
    setSearchRan(true);
    setSearchRows(await databaseApi.search(search));
  }
  const databaseServer = databaseStatus?.server as Record<string, unknown> | undefined;
  const databaseConfig = databaseStatus?.config as Record<string, unknown> | undefined;
  const showDefaultDatabasePasswordNote = !databaseStatus || databaseStatus.usesDefaultPassword !== false;
  const previewColumns = databasePreviewColumns(preview);
  const previewRows = preview?.rows || [];
  const previewRowCount = Number(count || 0);
  const previewIsTruncated = previewRowCount > previewRows.length;
  const queryColumns = queryResult?.columns?.map((column) => column.name).filter((name) => name !== "__rowid");
  const queryRows = (queryResult?.rows || []).map((row) => omitInternalRowFields(row));
  const queryAffectedRows = Number(queryResult?.rowCount ?? queryRows.length);
  const tableSearchTerm = tableSearch.trim().toLowerCase();
  const filteredTables = tableSearchTerm
    ? tables.filter((table) => `${String(table.schema || "")}.${String(table.name || "")}`.toLowerCase().includes(tableSearchTerm))
    : tables;
  const tablesSort = useSortableRows(filteredTables);
  const columnsSort = useSortableRows(columns);
  const previewSort = useSortableRows(previewRows);
  const searchSort = useSortableRows(searchRows);
  const querySort = useSortableRows(queryRows);
  return <section className="panel">
    <h2>Database Browser</h2>
    <p className="database-browser-note">
      Database edits may require relog or map/server restart.
    </p>
    <div className="action-row"><button onClick={loadTables}>Refresh Tables</button><button onClick={() => setPasswordPanelOpen((open) => !open)}>Change Password</button><button disabled={databaseStatusLoading} onClick={loadDatabaseStatus}>{databaseStatusLoading ? "Checking..." : "Status"}</button></div>
    {passwordPanelOpen && <section className="result-panel database-password-panel">
      <div className="panel-title database-status-title"><strong>Change Database Password</strong><StatusPill value={databasePasswordResult?.status === "failed" ? "Failed" : databasePasswordResult?.status === "succeeded" ? "Saved" : "Info"} /></div>
      {showDefaultDatabasePasswordNote && <p className="muted">The default password is "dune".</p>}
      <div className="action-line">
        <label className="wide-field">New Password<SecretInput value={databasePassword} onChange={(event) => setDatabasePassword(event.target.value)} placeholder="New password" /></label>
        <label className="wide-field">Confirm Password<SecretInput value={databasePasswordConfirm} onChange={(event) => setDatabasePasswordConfirm(event.target.value)} placeholder="Confirm password" /></label>
        <button disabled={databasePasswordResult?.status === "running"} onClick={changeDatabasePassword}>Save Password</button>
      </div>
      {databasePasswordResult && <span className={`inline-task-result result-${databasePasswordResult.status === "succeeded" ? "ok" : databasePasswordResult.status === "failed" ? "fail" : "running"}`}>
        <strong className={databasePasswordResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(databasePasswordResult.title, databasePasswordResult.status === "running")}</strong>
        {databasePasswordResult.message && <span className="inline-task-message">{formatResultMessage(databasePasswordResult.message)}</span>}
      </span>}
    </section>}
    {(databaseStatus || databaseStatusError) && <section className={`result-panel transient-result ${databaseStatusError ? "result-fail" : "result-ok"}`}>
      <div className="panel-title database-status-title"><strong>Database Status</strong><StatusPill value={databaseStatusError ? "Failed" : "Connected"} /></div>
      {databaseStatusError ? <p>{databaseStatusError}</p> : <KeyValueGrid items={[
        ["Connected", databaseStatus?.connected ? "Yes" : "No"],
        ["Database", databaseServer?.current_database || databaseConfig?.database || "Unknown"],
        ["User", databaseServer?.current_user || databaseConfig?.user || "Unknown"],
        ["Dune Tables", databaseStatus?.duneTableCount ?? "Unknown"],
        ["Host", databaseConfig?.host || "Unknown"],
        ["Port", databaseConfig?.port || "Unknown"]
      ]} />}
      {!databaseStatusError && Boolean(databaseServer?.version) && <TechnicalDetails title="Postgres version" text={String(databaseServer?.version)} />}
    </section>}
    <h3>Tables</h3>
    <div className="action-row database-table-search-row">
      <input value={tableSearch} onChange={(event) => setTableSearch(event.target.value)} placeholder="Search table names" />
      {tableSearch && <button onClick={() => setTableSearch("")}>Clear</button>}
    </div>
    {filteredTables.length
      ? <DataTable rows={tablesSort.sortedRows} columns={["schema", "name", "row_count"]} onRowClick={(row) => open(String(row.name))} sortColumn={tablesSort.sortColumn} sortDirection={tablesSort.sortDirection} onSort={tablesSort.onSort} />
      : <div className="empty database-empty">No matching tables found.</div>}
    <h3 ref={previewRef}>{selected ? `${schema}.${selected} (${count} rows)` : "Table Preview"}</h3>
    {!selected && <div className="empty database-empty">No table selected. Select a table to preview and edit rows.</div>}
    {selected && <section className="database-table-panel">
      {previewLoading && <div className="empty database-empty">Loading full table preview...</div>}
      {previewError && <div className="empty database-empty danger-note">Preview failed: {formatResultMessage(previewError)}</div>}
      {!previewLoading && !previewError && <p className="muted database-preview-count">
        Showing {previewRows.length.toLocaleString()} of {previewRowCount.toLocaleString()} rows.
        {previewIsTruncated ? ` Full preview is capped at ${DATABASE_PREVIEW_MAX_ROWS.toLocaleString()} rows to keep the browser responsive.` : ""}
      </p>}
      <details className="technical-details">
        <summary>Columns</summary>
        <DataTable rows={columnsSort.sortedRows} sortColumn={columnsSort.sortColumn} sortDirection={columnsSort.sortDirection} onSort={columnsSort.onSort} />
      </details>
      {!previewLoading && !previewError && (previewRows.length ? <DataTable rows={previewSort.sortedRows} columns={previewColumns} action={(row) => <button onClick={(event) => { event.stopPropagation(); startEdit(row); }}>Edit</button>} actionClassName="backup-table-actions" tableClassName="backup-table" sortColumn={previewSort.sortColumn} sortDirection={previewSort.sortDirection} onSort={previewSort.onSort} /> : <div className="empty database-empty">This table has no rows to preview.</div>)}
      {!editRow && editResult && <section className={`result-panel ${editResult.status === "running" ? "" : "transient-result"} ${editResult.status === "succeeded" ? "result-ok" : editResult.status === "failed" ? "result-fail" : "result-running"}`}>
        <div className="panel-title"><strong>{formatResultTitle(editResult.title, editResult.status === "running")}</strong><StatusPill value={editResult.status === "succeeded" ? "Saved" : editResult.status === "failed" ? "Failed" : "Saving"} /></div>
        {editResult.message && <p>{formatResultMessage(editResult.message)}</p>}
      </section>}
      {editRow && <section ref={editRef} className="result-panel database-edit-panel">
        <div className="panel-title"><strong>Edit Row</strong><StatusPill value={editResult?.status === "failed" ? "Failed" : editResult?.status === "succeeded" ? "Saved" : "Editing"} /></div>
        <div className="database-edit-grid">
          {previewColumns.map((column) => <label key={column}>{column}<textarea rows={2} value={editValues[column] || ""} onChange={(event) => setEditValues({ ...editValues, [column]: event.target.value })} /></label>)}
        </div>
        <div className="action-line">
          <button disabled={editResult?.status === "running"} onClick={saveEditedRow}>Save Row</button>
          <button onClick={() => setEditRow(null)}>Cancel</button>
        </div>
        {editResult && <span className={`inline-task-result result-${editResult.status === "succeeded" ? "ok" : editResult.status === "failed" ? "fail" : "running"}`}>
          <strong className={editResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(editResult.title, editResult.status === "running")}</strong>
          {editResult.message && <span className="inline-task-message">{formatResultMessage(editResult.message)}</span>}
        </span>}
      </section>}
    </section>}
    <h3>Search Tables and Columns</h3>
    <div className="action-row"><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tables or columns" /><button onClick={searchColumns}>Search</button></div>
    {searchRan && (searchRows.length ? <DataTable rows={searchSort.sortedRows} sortColumn={searchSort.sortColumn} sortDirection={searchSort.sortDirection} onSort={searchSort.onSort} /> : <div className="empty database-empty">No matching tables or columns found.</div>)}
    <div className={`playerAdmin_toggle database-advanced-section ${advancedSqlOpen ? "open" : ""}`}>
      <button className="playerAdmin_toggleHeader" aria-label={advancedSqlOpen ? "Collapse Advanced SQL Console" : "Expand Advanced SQL Console"} onClick={() => setAdvancedSqlOpen(!advancedSqlOpen)}>{advancedSqlOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}<span>Advanced SQL Console</span></button>
      {advancedSqlOpen && <div className="playerAdmin_toggleBody">
        <textarea value={sql} onChange={(event) => setSql(event.target.value)} rows={5} />
        <div className="action-row"><button onClick={runQuery}>Run Query</button><button onClick={exportQueryJson}>Export Query JSON</button></div>
        {queryRan && queryError && <div className="empty database-empty danger-note">{formatResultMessage(`Query failed: ${queryError}`)}</div>}
        {queryRan && !queryError && queryResult && (queryRows.length
          ? <DataTable rows={querySort.sortedRows} columns={queryColumns} sortColumn={querySort.sortColumn} sortDirection={querySort.sortDirection} onSort={querySort.onSort} />
          : <div className="result-panel transient-result result-ok database-query-result">Query completed. Rows affected: {queryAffectedRows}.</div>)}
      </div>}
    </div>
  </section>;
}

function compareTableValues(a: unknown, b: unknown, direction: "asc" | "desc") {
  const aNum = Number(a);
  const bNum = Number(b);
  const bothNumeric = a !== null && a !== undefined && a !== "" && b !== null && b !== undefined && b !== "" && !Number.isNaN(aNum) && !Number.isNaN(bNum);
  const result = bothNumeric ? aNum - bNum : String(a ?? "").localeCompare(String(b ?? ""), undefined, { sensitivity: "base" });
  return direction === "asc" ? result : -result;
}

function databasePreviewColumns(preview: { columns?: { name: string }[] } | null) {
  return (preview?.columns || []).map((column) => column.name).filter((name) => name !== "__rowid");
}

function omitInternalRowFields(row: Record<string, unknown>) {
  const { __rowid, ...visible } = row;
  void __rowid;
  return visible;
}

function serializeEditableDbValue(value: unknown) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function parseEditableDbValue(value: string, original: unknown) {
  const text = String(value);
  if (/^NULL$/i.test(text.trim())) return null;
  if (typeof original === "object" && original !== null) {
    try { return JSON.parse(text); } catch { return text; }
  }
  return text;
}
