import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { playersApi } from "../../api/players";
import { DataTable, useSortableRows } from "../../components/common/DataTable";
import { TechnicalDetails } from "../../components/common/DisplayPrimitives";
import { formatUiSentence } from "../../lib/display";

type ConfirmAction = (
  message: string,
  options?: {
    title?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[];
  }
) => Promise<boolean>;

export function PlayerDetailTab({
  playerId,
  data,
  onReload,
  onError,
  onActionLog,
  confirmAction,
  formatMutationResult
}: {
  playerId: string;
  data: Record<string, unknown> | null;
  onReload: () => void;
  onError: (text: string) => void;
  onActionLog?: (actionType: string, target: string, amount: string, notes: string) => void;
  confirmAction: ConfirmAction;
  formatMutationResult: (result: unknown) => string;
}) {
  const [message, setMessage] = useState("");
  const [messageDetails, setMessageDetails] = useState("");

  useEffect(() => {
    if (!message) return undefined;
    const timer = window.setTimeout(() => {
      setMessage("");
      setMessageDetails("");
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [message]);

  async function deleteItem(row: Record<string, unknown>) {
    const itemId = String(row.id || "");
    const templateId = String(row.template_id || "Unknown item");
    if (!(await confirmAction("Delete this inventory item?", {
      title: "Delete Inventory Item",
      confirmLabel: "Delete",
      danger: true,
      details: [
        { label: "Item ID", value: itemId, tone: "danger" },
        { label: "Template", value: templateId, tone: "accent" }
      ]
    }))) return;

    try {
      const response = await playersApi.deleteInventoryItem(playerId, itemId, "DELETE ITEM");
      setMessage(formatMutationResult(response));
      setMessageDetails(JSON.stringify(response, null, 2));
      onActionLog?.("Delete Inventory Item", templateId, "1", "Succeeded");
      onReload();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessage(text);
      setMessageDetails("");
      onActionLog?.("Delete Inventory Item", templateId, "1", `Failed: ${text}`);
      onError(text);
    }
  }

  const rows = Array.isArray(data?.rows) ? data.rows as Record<string, unknown>[] : [];
  const inventorySort = useSortableRows(rows);

  return <div>
    {data?.reason ? <p className="danger-note">{formatUiSentence(data.reason)}</p> : null}
    <p className="action-help-note">A relog is required to see the change.</p>
    {message && <div className="result-panel transient-result"><strong>Mutation Result.</strong><p>{formatUiSentence(message)}</p>{messageDetails && <TechnicalDetails text={messageDetails} />}</div>}
    <DataTable
      rows={inventorySort.sortedRows}
      emptyMessage="No inventory items were found."
      actionClassName="actions-column"
      action={(row) => <button className="icon-toggle-button danger" title="Delete item" aria-label="Delete item" onClick={(event) => { event.stopPropagation(); void deleteItem(row); }}><X size={16} /></button>}
      sortColumn={inventorySort.sortColumn}
      sortDirection={inventorySort.sortDirection}
      onSort={inventorySort.onSort}
      resizableColumns
    />
  </div>;
}
