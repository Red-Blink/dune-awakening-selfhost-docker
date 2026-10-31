import { useEffect, useMemo, useState } from "react";
import { playersApi } from "../../api/players";
import { DataTable, useSortableRows } from "../../components/common/DataTable";
import { InlineActionResult, type InlineActionResultState } from "../../components/common/InlineActionResult";
import { CatalogItemThumb } from "../../components/common/ItemCatalog";
import { friendlyInlineError } from "./playerAdminUtils";

type BuildingUnlockRow = {
  itemId: string;
  name: string;
  group: string;
  status: "Available" | "Pending" | "Delivered" | "Processing" | "Owned" | "Unknown";
  experimental: boolean;
  image?: string;
  requiredDlc?: string;
  entitlementControlled?: boolean;
};

type ConfirmAction = (message: string, options?: {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[];
}) => Promise<boolean>;

export function BuildingUnlocksTab({ dbPlayerId, playerName, confirmAction, onActionLog }: {
  dbPlayerId: string;
  playerName: string;
  confirmAction: ConfirmAction;
  onActionLog?: (actionType: string, target: string, amount: string, notes: string) => void;
}) {
  const [rows, setRows] = useState<BuildingUnlockRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [group, setGroup] = useState("");
  const [showExperimental, setShowExperimental] = useState(true);
  const [ownershipSupported, setOwnershipSupported] = useState(true);
  const [busyItemId, setBusyItemId] = useState("");
  const [result, setResult] = useState<InlineActionResultState | null>(null);

  async function load() {
    if (!dbPlayerId) {
      setRows([]);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await playersApi.buildingUnlocks(dbPlayerId);
      setOwnershipSupported(Boolean(response.capabilities?.buildingUnlockOwnership));
      setRows((response.rows || []).map((row) => ({
        itemId: String(row.itemId || row.id || ""),
        name: String(row.name || row.itemId || row.id || "Building Set"),
        group: String(row.group || "Structures & Building Sets"),
        status: String(row.status || "Unknown") as BuildingUnlockRow["status"],
        experimental: Boolean(row.experimental),
        image: String(row.image || ""),
        requiredDlc: String(row.requiredDlc || ""),
        entitlementControlled: Boolean(row.entitlementControlled)
      })).filter((row) => row.itemId));
    } catch (loadError) {
      setRows([]);
      setError(friendlyInlineError(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [dbPlayerId]);

  async function grant(row: BuildingUnlockRow) {
    const warning = row.experimental
      ? "This building set is marked experimental because its game metadata is incomplete or developer-only. It may remain as an ordinary inventory item."
      : "Dune will consume the patent token and add the building set to this character. Offline players receive it on their next login.";
    const dlcWarning = row.requiredDlc
      ? ` The player must own ${row.requiredDlc}; delivering its token does not grant DLC ownership.`
      : row.entitlementControlled
        ? " This is entitlement-controlled content. Delivering its token does not grant or verify the required account entitlement."
        : "";
    if (!(await confirmAction(`Grant ${row.name} to ${playerName}?\n\n${warning}${dlcWarning}`, {
      title: row.experimental ? "Grant Experimental Building Set" : "Grant Building Set",
      confirmLabel: "Grant",
      details: [
        { label: "Building Set", value: row.name, tone: "accent" },
        { label: "Item ID", value: row.itemId },
        ...(row.requiredDlc ? [{ label: "Requires", value: row.requiredDlc }] : [])
      ]
    }))) return;

    const key = `building:${row.itemId}`;
    setBusyItemId(row.itemId);
    setResult({ key, tone: "neutral", text: `Granting ${row.name}`, pending: true });
    try {
      const response = await playersApi.grantBuildingUnlock(dbPlayerId, {
        itemId: row.itemId,
        confirmation: "GRANT BUILDING UNLOCK"
      });
      const nextStatus = String(response.status || "Pending") as BuildingUnlockRow["status"];
      setRows((current) => current.map((item) => item.itemId === row.itemId ? { ...item, status: nextStatus } : item));
      const message = response.alreadyOwned
        ? row.entitlementControlled
          ? "Recorded in the character database. The Console cannot verify whether the account entitlement makes this content usable."
          : "Already owned. No duplicate token was granted."
        : response.alreadyPending
          ? "Already pending in the player's inventory. No duplicate token was granted."
          : nextStatus === "Delivered" || nextStatus === "Processing"
            ? row.entitlementControlled
              ? "Token delivery verified. Persistent ownership still requires the player's account entitlement and cannot be verified by the Console."
              : "Token delivery verified. Reload after Dune processes it to confirm the building unlock."
            : "Queued in the player's inventory. Dune will process it on the next login.";
      setResult({ key, tone: "success", text: message });
      onActionLog?.("Grant Building Set", row.name, "1", response.alreadyOwned ? "Already Owned" : response.alreadyPending ? "Already Pending" : nextStatus);
    } catch (grantError) {
      const message = friendlyInlineError(grantError);
      setResult({ key, tone: "danger", text: message });
      onActionLog?.("Grant Building Set", row.name, "1", `Failed: ${message}`);
    } finally {
      setBusyItemId("");
    }
  }

  const groups = useMemo(() => [...new Set(rows.filter((row) => showExperimental || !row.experimental).map((row) => row.group))].sort(), [rows, showExperimental]);
  const filterTerms = filter.toLowerCase().split(/\s+/).map((term) => term.trim()).filter(Boolean);
  const filteredRows = rows.filter((row) => {
    if (!showExperimental && row.experimental) return false;
    if (group && row.group !== group) return false;
    const haystack = `${row.name} ${row.itemId} ${row.group} ${row.status}`.toLowerCase();
    return filterTerms.every((term) => haystack.includes(term));
  });
  const displayRows = filteredRows.map((row) => ({
    ...row,
    unlockName: row.name,
    requirement: row.requiredDlc || (row.entitlementControlled ? "Account Entitlement" : "None")
  }));
  const sorted = useSortableRows(displayRows);

  return <div className="playerAdmin_content">
    <section className="playerAdmin_box">
      <h4>Building Sets</h4>
      <div className="playerAdmin_boxHeaderLine playerAdmin_filterHeaderLine">
        <p>Delivers the patent token for Dune to process. Token delivery cannot grant or verify DLC and other account entitlements. Research entries remain in the Research tab.</p>
      </div>
      {!ownershipSupported && <p className="playerAdmin_note danger">This game database cannot report building-set ownership. Grants are disabled to prevent duplicate or misleading entries.</p>}
      <div className="playerAdmin_filterRow playerAdmin_filterActionLine">
        <div className="playerAdmin_filterToolsRow">
          <input className="playerAdmin_filterTextInput" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter by name, item ID, group, or status" aria-label="Filter Building Sets" />
          {filter && <button type="button" onClick={() => setFilter("")}>Clear</button>}
          <span className="playerAdmin_note">{filteredRows.length} of {rows.filter((row) => showExperimental || !row.experimental).length} Unlocks</span>
        </div>
        <div className="playerAdmin_filterActionsRight">
          <select value={group} onChange={(event) => setGroup(event.target.value)} aria-label="Building Set Group">
            <option value="">All Groups</option>
            {groups.map((option) => <option key={option}>{option}</option>)}
          </select>
          <label className="playerAdmin_buildingExperimentalToggle"><input type="checkbox" checked={showExperimental} onChange={(event) => { setShowExperimental(event.target.checked); setGroup(""); }} /> Show Experimental</label>
          <button disabled={!dbPlayerId || loading} onClick={() => void load()}>{loading ? "Loading..." : "Reload"}</button>
        </div>
      </div>
      {error ? <p className="playerAdmin_note danger">{error}</p> : <DataTable
        rows={sorted.sortedRows}
        columns={["image", "unlockName", "itemId", "group", "requirement", "status"]}
        columnLabels={{ image: "Preview", unlockName: "Building Set", itemId: "Item ID", requirement: "Requires" }}
        emptyMessage={loading ? "Loading building sets..." : "No building sets match this filter."}
        sortColumn={sorted.sortColumn}
        sortDirection={sorted.sortDirection}
        onSort={sorted.onSort}
        resizableColumns
        tableClassName="playerAdmin_schematicTable playerAdmin_previewTable playerAdmin_buildingUnlockTable"
        rowKey={(item) => String(item.itemId)}
        renderCell={(item, column) => column === "image"
          ? <CatalogItemThumb item={{ id: String(item.itemId), name: String(item.name), image: String(item.image || "") }} small />
          : column === "itemId"
          ? <code>{String(item.itemId)}</code>
          : column === "status"
            ? <span className={`badge ${item.status === "Owned" && !item.entitlementControlled ? "ok" : item.status === "Available" ? "" : item.status === "Unknown" ? "bad" : "warn"}`}>{item.status === "Pending" ? "Pending Login" : item.status === "Owned" && item.entitlementControlled ? "Recorded" : String(item.status)}</span>
            : String(item[column] || "")}
        secondaryAction={(item) => <InlineActionResult result={result} resultKey={`building:${item.itemId}`} />}
        secondaryActionLabel="Result"
        secondaryActionClassName="playerAdmin_schematicResultCell"
        actionClassName="playerAdmin_schematicActionCell"
        action={(item) => {
          const row = item as unknown as BuildingUnlockRow;
          const disabled = !ownershipSupported || row.status !== "Available" || Boolean(busyItemId);
          const label = busyItemId === row.itemId ? "Granting..." : row.status === "Owned" ? row.entitlementControlled ? "Recorded" : "Owned" : row.status === "Pending" ? "Pending" : row.status === "Delivered" || row.status === "Processing" ? "Delivered" : row.status === "Unknown" ? "Unavailable" : "Grant";
          return <button className="playerAdmin_stateActionButton" disabled={disabled} onClick={() => void grant(row)}>{label}</button>;
        }}
      />}
    </section>
  </div>;
}
