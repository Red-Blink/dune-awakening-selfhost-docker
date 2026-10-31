import { useEffect, useMemo, useState } from "react";
import { playersApi } from "../../api/players";
import { DataTable, useSortableRows } from "../../components/common/DataTable";
import { InlineActionResult, type InlineActionResultState } from "../../components/common/InlineActionResult";
import { CatalogItemThumb } from "../../components/common/ItemCatalog";
import { friendlyInlineError } from "./playerAdminUtils";

type CustomizationRow = {
  itemId: string;
  name: string;
  groupId: string;
  group: string;
  status: "Available" | "Pending" | "Delivered" | "Processing" | "Unlocked";
  directUnlock?: boolean;
  image?: string;
  requiredDlc?: string;
  entitlementControlled?: boolean;
};

type CustomizationGroup = { id: string; name: string; count: number };

type ConfirmAction = (message: string, options?: {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[];
}) => Promise<boolean>;

export function CustomizationsTab({ dbPlayerId, playerName, confirmAction, onActionLog }: {
  dbPlayerId: string;
  playerName: string;
  confirmAction: ConfirmAction;
  onActionLog?: (actionType: string, target: string, amount: string, notes: string) => void;
}) {
  const [rows, setRows] = useState<CustomizationRow[]>([]);
  const [groups, setGroups] = useState<CustomizationGroup[]>([]);
  const [selectedGroup, setSelectedGroup] = useState("");
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<InlineActionResultState | null>(null);

  async function load() {
    if (!dbPlayerId) {
      setRows([]);
      setGroups([]);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await playersApi.customizations(dbPlayerId);
      setGroups(response.groups || []);
      setRows((response.rows || []).map((row) => ({
        itemId: String(row.itemId || row.id || ""),
        name: String(row.name || row.itemId || row.id || "Customization"),
        groupId: String(row.groupId || ""),
        group: String(row.group || "Customizations"),
        status: String(row.status || "Available") as CustomizationRow["status"],
        image: String(row.image || ""),
        requiredDlc: String(row.requiredDlc || ""),
        entitlementControlled: Boolean(row.entitlementControlled),
        directUnlock: Boolean(row.directUnlock)
      })).filter((row) => row.itemId && row.groupId));
    } catch (loadError) {
      setRows([]);
      setGroups([]);
      setError(friendlyInlineError(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [dbPlayerId]);

  async function grant(selection: { itemId?: string; groupId?: string; label: string; count: number }) {
    const selectedRows = rows.filter((row) => selection.itemId ? row.itemId === selection.itemId : selection.groupId === "all" || row.groupId === selection.groupId);
    const pending = selectedRows.filter((row) => row.status === "Pending").length;
    const owned = selectedRows.filter((row) => row.status === "Unlocked").length;
    const direct = selectedRows.filter((row) => row.directUnlock && row.status !== "Unlocked").length;
    const deliverable = Math.max(0, selection.count - pending - owned - direct);
    const requiredDlcs = [...new Set(selectedRows.map((row) => row.requiredDlc).filter(Boolean))];
    const entitlementControlled = selectedRows.some((row) => row.entitlementControlled);
    const dlcWarning = requiredDlcs.length
      ? ` The player must own ${requiredDlcs.join(" and ")}; delivering its token does not grant DLC ownership.`
      : entitlementControlled
        ? " These cosmetics are entitlement-controlled. Delivering their tokens does not grant or verify the required account entitlement."
        : "";
    if (!(await confirmAction(`Grant ${selection.label} to ${playerName}?\n\n${deliverable} token${deliverable === 1 ? "" : "s"} will be delivered. ${direct ? `${direct} event cosmetics will be unlocked directly. The player must be fully offline. ` : ""}${pending ? `${pending} already pending ${pending === 1 ? "token will" : "tokens will"} be skipped.` : ""}${owned ? ` ${owned} already unlocked will be skipped.` : ""}${dlcWarning}`, {
      title: selection.itemId ? "Grant Customization" : "Grant Customization Set",
      confirmLabel: "Grant",
      details: [
        { label: "Player", value: playerName, tone: "accent" },
        { label: selection.itemId ? "Customization" : "Set", value: selection.label },
        { label: "Tokens", value: String(deliverable) },
        ...(direct ? [{ label: "Direct Unlocks", value: String(direct) }] : []),
        ...(requiredDlcs.length
          ? [{ label: "Requires", value: requiredDlcs.join(", ") }]
          : entitlementControlled
            ? [{ label: "Requires", value: "Account Entitlement" }]
            : [])
      ]
    }))) return;

    const key = selection.itemId ? `item:${selection.itemId}` : `group:${selection.groupId}`;
    setBusyKey(key);
    setResult({ key: "customizations", tone: "neutral", text: `Granting ${selection.label}`, pending: true });
    try {
      const response = await playersApi.grantCustomizations(dbPlayerId, {
        itemId: selection.itemId,
        groupId: selection.groupId,
        confirmation: "GRANT CUSTOMIZATIONS"
      });
      const statuses = new Map((response.results || []).map((entry) => [String(entry.itemId || ""), String(entry.status || "Available") as CustomizationRow["status"]]));
      setRows((current) => current.map((row) => statuses.has(row.itemId) ? { ...row, status: statuses.get(row.itemId)! } : row));
      const delivered = response.delivered ?? response.granted;
      const parts: string[] = [];
      if (delivered) parts.push(`${delivered} delivered`);
      if (response.unlocked) parts.push(`${response.unlocked} unlocked`);
      if (response.requested) parts.push(`${response.requested} delivery requested`);
      if (response.skipped) parts.push(`${response.skipped} already pending or unlocked`);
      if (response.failed) parts.push(`${response.failed} failed`);
      if (!parts.length) parts.push("No changes");
      const firstFailure = response.results?.find((entry) => entry.ok === false && entry.error);
      const detail = response.failed
        ? String(firstFailure?.error || "Some requests could not be delivered.")
        : response.unlocked
          ? "Event cosmetics were unlocked for the character. They will be available at the next login."
        : response.requested
          ? "Dune accepted the delivery request, but persistent ownership cannot be verified. The player may need to relog."
          : delivered
            ? entitlementControlled
              ? "Token delivery was verified, but persistent ownership requires the player's account entitlement and cannot be verified by the Console."
              : "Token delivery was verified. Dune will process it for the character."
            : "All selected cosmetics are already pending or unlocked. No duplicates were added.";
      setResult({ key: "customizations", tone: response.failed ? "danger" : "success", text: `${parts.join(" · ")}. ${detail}` });
      onActionLog?.("Grant Customizations", selection.label, String(delivered + (response.requested || 0) + (response.unlocked || 0)), response.failed ? `${response.failed} Failed` : response.unlocked ? `${response.unlocked} Unlocked` : response.requested ? `${response.requested} Delivery Requested` : response.skipped ? `${response.skipped} Already Pending Or Unlocked` : `${delivered} Delivered`);
    } catch (grantError) {
      const message = friendlyInlineError(grantError);
      setResult({ key: "customizations", tone: "danger", text: message });
      onActionLog?.("Grant Customizations", selection.label, "0", `Failed: ${message}`);
    } finally {
      setBusyKey("");
    }
  }

  const filteredRows = useMemo(() => {
    const terms = filter.toLowerCase().split(/\s+/).map((term) => term.trim()).filter(Boolean);
    return rows.filter((row) => (!selectedGroup || row.groupId === selectedGroup) && terms.every((term) => `${row.name} ${row.itemId} ${row.group} ${row.status}`.toLowerCase().includes(term)));
  }, [filter, rows, selectedGroup]);
  const sorted = useSortableRows(filteredRows.map((row) => ({
    ...row,
    customizationName: row.name,
    requirement: row.requiredDlc || (row.entitlementControlled ? "Account Entitlement" : "None")
  })));

  return <div className="playerAdmin_content">
    <section className="playerAdmin_box playerAdmin_customizations">
      <div className="playerAdmin_boxHeaderLine playerAdmin_customizationHeader">
        <div>
          <h4>Customizations</h4>
          <p>Grant complete cosmetic sets or choose individual variants and swatches.</p>
        </div>
        <button disabled={!dbPlayerId || loading || Boolean(busyKey)} onClick={() => void grant({ groupId: "all", label: "all customization sets", count: rows.length })}>Grant All Sets</button>
      </div>
      <p className="playerAdmin_note">Halloween 2026 cosmetics unlock directly while the player is offline. Other cosmetics use tokens; token delivery does not grant or verify DLC or account entitlements. Available means no matching token is currently pending.</p>
      <div className="playerAdmin_customizationCards">
        {groups.map((group) => {
          const groupRows = rows.filter((row) => row.groupId === group.id);
          const pending = groupRows.filter((row) => row.status === "Pending").length;
          const requiredDlcs = [...new Set(groupRows.map((row) => row.requiredDlc).filter(Boolean))];
          const requirement = requiredDlcs.length ? `Requires ${requiredDlcs.join(", ")}` : groupRows.some((row) => row.entitlementControlled) ? "Entitlement Controlled" : "";
          return <article className={`playerAdmin_customizationCard${selectedGroup === group.id ? " active" : ""}`} key={group.id}>
            <button className="playerAdmin_customizationCardSelect" type="button" onClick={() => setSelectedGroup((current) => current === group.id ? "" : group.id)}>
              <strong>{group.name}</strong>
              <span>{group.count} Cosmetics{requirement ? ` · ${requirement}` : ""}{pending ? ` · ${pending} Pending` : ""}</span>
            </button>
            <button disabled={!dbPlayerId || Boolean(busyKey) || groupRows.length === 0} onClick={() => void grant({ groupId: group.id, label: group.name, count: groupRows.length })}>{busyKey === `group:${group.id}` ? "Granting..." : "Grant Set"}</button>
          </article>;
        })}
      </div>
      <div className="playerAdmin_filterRow playerAdmin_filterActionLine">
        <div className="playerAdmin_filterToolsRow">
          <input className="playerAdmin_filterTextInput" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter by name, item ID, set, or status" aria-label="Filter Customizations" />
          {filter && <button type="button" onClick={() => setFilter("")}>Clear</button>}
          <span className="playerAdmin_note">{filteredRows.length} of {rows.length} Cosmetics</span>
        </div>
        <div className="playerAdmin_filterActionsRight">
          <select value={selectedGroup} onChange={(event) => setSelectedGroup(event.target.value)} aria-label="Customization Set">
            <option value="">All Sets</option>
            {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
          <button disabled={!dbPlayerId || loading || Boolean(busyKey)} onClick={() => void load()}>{loading ? "Loading..." : "Reload"}</button>
        </div>
      </div>
      <InlineActionResult result={result} resultKey="customizations" />
      {error ? <p className="playerAdmin_note danger">{error}</p> : <DataTable
        rows={sorted.sortedRows}
        columns={["image", "customizationName", "itemId", "group", "requirement", "status"]}
        columnLabels={{ image: "Preview", customizationName: "Customization", itemId: "Item ID", group: "Set", requirement: "Requires" }}
        emptyMessage={loading ? "Loading customizations..." : "No customizations match this filter."}
        sortColumn={sorted.sortColumn}
        sortDirection={sorted.sortDirection}
        onSort={sorted.onSort}
        resizableColumns
        tableClassName="playerAdmin_schematicTable playerAdmin_previewTable playerAdmin_customizationTable"
        rowKey={(item) => String(item.itemId)}
        renderCell={(item, column) => column === "image"
          ? <CatalogItemThumb item={{ id: String(item.itemId), name: String(item.name), image: String(item.image || "") }} small />
          : column === "itemId" ? <code title={String(item.itemId)}>{String(item.itemId)}</code> : column === "status" ? <span className={`badge ${item.status === "Available" ? "ok" : "warn"}`}>{item.status === "Pending" ? "Pending Login" : item.status === "Processing" ? "Delivered" : String(item.status)}</span> : String(item[column] || "")}
        actionClassName="playerAdmin_schematicActionCell"
        action={(item) => {
          const row = item as unknown as CustomizationRow;
          const disabled = row.status !== "Available" || Boolean(busyKey);
          const label = busyKey === `item:${row.itemId}` ? "Granting..." : row.status === "Available" ? "Grant" : row.status === "Pending" ? "Pending" : row.status === "Unlocked" ? "Unlocked" : "Delivered";
          return <button className="playerAdmin_stateActionButton" disabled={disabled} onClick={() => void grant({ itemId: row.itemId, label: row.name, count: 1 })}>{label}</button>;
        }}
      />}
    </section>
  </div>;
}
