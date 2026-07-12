import { useEffect, useState } from "react";
import { Circle, X } from "lucide-react";
import { playersApi } from "../../api/players";
import { adminApi } from "../../api/admin";
import { DataTable, useSortableRows } from "../../components/common/DataTable";
import { TechnicalDetails } from "../../components/common/DisplayPrimitives";
import { AugmentDropdown } from "../../components/common/AugmentDropdown";
import { ItemGradeSelect } from "../../components/common/ItemCatalog";
import { formatUiSentence, friendlyColumnName } from "../../lib/display";
import { serializeEditableDbValue, parseEditableDbValue } from "../../lib/dbValues";
import { augmentLimitForItem, filterAugmentsForItem, formatAugmentOptions, itemCanUseAugments } from "../../lib/augmentEligibility";

const EDITABLE_INVENTORY_COLUMNS = ["stack_size", "quality_level", "position_index", "current_durability", "max_durability"];
const INVENTORY_COLUMNS = ["id", "inventory_id", "template_id", "stack_size", "quality_level", "position_index", "current_durability", "max_durability", "augments"];

function inventoryAugmentLimit(templateId: string) {
  return augmentLimitForItem({ templateId });
}

function normalizeInventoryAugmentGrade(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 5;
  return Math.max(1, Math.min(5, Math.trunc(parsed)));
}

function inventoryRowAugmentLimit(row: Record<string, unknown>) {
  return augmentLimitForItem({
    templateId: String(row.template_id || ""),
    category: String(row.category || ""),
    source: String(row.source || "")
  });
}

function inventoryItemCanUseAugments(row: Record<string, unknown>) {
  const templateId = String(row.template_id || "");
  return Boolean(templateId) && itemCanUseAugments({
    templateId,
    category: String(row.category || ""),
    source: String(row.source || "")
  });
}

function inventoryAugments(row: Record<string, unknown>) {
  const raw = row.augments;
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return raw.split(",").map((item) => item.trim()).filter(Boolean);
  }
}

function appliedAugmentMessage(response: unknown, fallbackTemplateId: string, fallbackAugments: string[]) {
  const result = response && typeof response === "object" && "result" in response
    ? (response as { result?: Record<string, unknown> }).result || {}
    : response && typeof response === "object"
      ? response as Record<string, unknown>
      : {};
  const templateId = String(result.templateId || fallbackTemplateId || "item");
  const augments = Array.isArray(result.augments) ? result.augments : fallbackAugments;
  const totalCount = augments.length || fallbackAugments.length;
  const totalText = `${totalCount} augment${totalCount === 1 ? "" : "s"}`;
  return `Set ${totalText} on ${templateId}.`;
}

function editedInventoryItemMessage(fallbackTemplateId: string) {
  const templateId = fallbackTemplateId || "item";
  return `Updated ${templateId}.`;
}

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
  rows,
  emptyMessage,
  onReload,
  onError,
  onActionLog,
  confirmAction,
  formatMutationResult,
  playerIsOnline = false
}: {
  playerId: string;
  data: Record<string, unknown> | null;
  rows: Record<string, unknown>[];
  emptyMessage: string;
  onReload: () => void | Promise<void>;
  onError: (text: string) => void;
  onActionLog?: (actionType: string, target: string, amount: string, notes: string) => void;
  confirmAction: ConfirmAction;
  formatMutationResult: (result: unknown) => string;
  playerIsOnline?: boolean;
}) {
  const [message, setMessage] = useState("");
  const [messageDetails, setMessageDetails] = useState("");
  const [messageTone, setMessageTone] = useState<"default" | "success">("default");
  const [editRow, setEditRow] = useState<Record<string, unknown> | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [editSaving, setEditSaving] = useState(false);
  const [augmentTargetRow, setAugmentTargetRow] = useState<Record<string, unknown> | null>(null);
  const [augmentSelected, setAugmentSelected] = useState<string[]>([]);
  const [augmentGrade, setAugmentGrade] = useState("5");
  const [augmentCatalog, setAugmentCatalog] = useState<{ id: string; name: string }[]>([]);
  const [augmentApplying, setAugmentApplying] = useState(false);

  useEffect(() => {
    adminApi.itemCatalog("", 10000).then((result) => {
      const augs = (result.rows || []).filter((item) =>
        (item.category || "").toLowerCase().includes("augment") ||
        (item.source || "").toLowerCase() === "augments"
      ).map((item) => ({ id: item.itemId || item.id, name: item.name }));
      setAugmentCatalog(augs);
    }).catch(() => setAugmentCatalog([]));
  }, []);

  useEffect(() => {
    if (!message) return undefined;
    const timer = window.setTimeout(() => {
      setMessage("");
      setMessageDetails("");
      setMessageTone("default");
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
      setMessageTone("default");
      setMessage(formatMutationResult(response));
      setMessageDetails(JSON.stringify(response, null, 2));
      onActionLog?.("Delete Inventory Item", templateId, "1", "Succeeded");
      onReload();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessageTone("default");
      setMessage(text);
      setMessageDetails("");
      onActionLog?.("Delete Inventory Item", templateId, "1", `Failed: ${text}`);
      onError(text);
    }
  }

  function startEditItem(row: Record<string, unknown>) {
    if (editRow && String(editRow.id) === String(row.id)) {
      closeEditItem();
      return;
    }
    setAugmentTargetRow(null);
    setAugmentSelected([]);
    setEditRow(row);
    const hasCurrentAtLoad = row.current_durability != null;
    setEditValues(Object.fromEntries(EDITABLE_INVENTORY_COLUMNS.map((column) => {
      if (column === "max_durability" && row.max_durability == null) return [column, hasCurrentAtLoad ? "100" : ""];
      if (column === "current_durability" && row.current_durability == null) return [column, ""];
      return [column, serializeEditableDbValue(row[column])];
    })));
  }

  function closeEditItem() {
    setEditRow(null);
  }

  function startApplyAugments(row: Record<string, unknown>) {
    if (augmentTargetRow && String(augmentTargetRow.id) === String(row.id)) {
      closeApplyAugments();
      return;
    }
    setEditRow(null);
    setAugmentTargetRow(row);
    setAugmentSelected([]);
    setAugmentGrade("5");
  }

  function closeApplyAugments() {
    setAugmentTargetRow(null);
    setAugmentSelected([]);
    setAugmentGrade("5");
  }

  async function saveEditItem() {
    if (!editRow) return;
    const itemId = String(editRow.id || "");
    const templateId = String(editRow.template_id || "Unknown item");

    const hasCurrent = editRow.current_durability != null;
    const hasMax = editRow.max_durability != null || hasCurrent;
    const maxDurability = hasMax ? Number(editValues.max_durability) : undefined;
    if (hasMax && (!Number.isFinite(maxDurability) || maxDurability! < 0 || maxDurability! > 100)) {
      setMessage("Max Durability must be a number between 0 and 100.");
      setMessageTone("default");
      setMessageDetails("");
      return;
    }
    if (hasCurrent) {
      const currentDurability = Number(editValues.current_durability);
      const upperBound = hasMax ? maxDurability! : Number.POSITIVE_INFINITY;
      if (!Number.isFinite(currentDurability) || currentDurability < 0 || currentDurability > upperBound) {
        setMessage("Current Durability must be a number between 0 and Max Durability.");
        setMessageTone("default");
        setMessageDetails("");
        return;
      }
    }

    if (!(await confirmAction("Save changes to this inventory item?", {
      title: "Edit Inventory Item",
      confirmLabel: "Save",
      details: [
        { label: "Item ID", value: itemId, tone: "accent" },
        { label: "Template", value: templateId, tone: "accent" }
      ]
    }))) return;

    setEditSaving(true);
    try {
      const values = Object.fromEntries(EDITABLE_INVENTORY_COLUMNS
        .filter((column) => !((column === "current_durability" && !hasCurrent) || (column === "max_durability" && !hasMax)))
        .map((column) => [column, parseEditableDbValue(editValues[column] ?? "", editRow[column])]));
      const response = await playersApi.updateInventoryItem(playerId, itemId, values, "SAVE ITEM");
      setMessageTone("success");
      setMessage(editedInventoryItemMessage(templateId));
      setMessageDetails(JSON.stringify(response, null, 2));
      onActionLog?.("Edit Inventory Item", templateId, "1", "Succeeded");
      closeEditItem();
      onReload();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessageTone("default");
      setMessage(text);
      setMessageDetails("");
      onActionLog?.("Edit Inventory Item", templateId, "1", `Failed: ${text}`);
      onError(text);
    } finally {
      setEditSaving(false);
    }
  }

  async function applyAugments() {
    if (!augmentTargetRow || augmentSelected.length === 0) return;
    if (playerIsOnline) {
      const text = "Apply augments requires the player to be offline. Have the player log out fully, wait until their status is Offline, then apply the edit.";
      setMessageTone("default");
      setMessage(text);
      setMessageDetails("");
      onError(text);
      return;
    }
    const itemId = String(augmentTargetRow.id || "");
    const templateId = String(augmentTargetRow.template_id || "Unknown item");
    const allowedAugments = augmentSelected.slice(0, inventoryRowAugmentLimit(augmentTargetRow));
    const selectedAugmentGrade = normalizeInventoryAugmentGrade(augmentGrade);
    if (allowedAugments.length === 0) return;
    const displayOptions = formatAugmentOptions(
      augmentCatalog.filter((augment) => allowedAugments.includes(augment.id)),
      selectedAugmentGrade
    );
    const augmentLabel = allowedAugments.map((augId) => {
      const found = displayOptions.find((augment) => augment.id === augId);
      return found?.displayName || found?.name || augId;
    }).join(", ");
    if (!(await confirmAction(`Apply ${allowedAugments.length} augment(s) to this item?`, {
      title: "Apply Augments",
      confirmLabel: "Apply",
      details: [
        { label: "Item ID", value: itemId, tone: "accent" },
        { label: "Template", value: templateId, tone: "accent" },
        { label: "Aug. Grade", value: String(selectedAugmentGrade), tone: "accent" },
        { label: "Augments", value: augmentLabel, tone: "success" }
      ]
    }))) return;

    setAugmentApplying(true);
    try {
      const response = await playersApi.augmentInventoryItem(playerId, itemId, allowedAugments, selectedAugmentGrade, "APPLY AUGMENTS");
      setMessageTone("success");
      setMessage(appliedAugmentMessage(response, templateId, allowedAugments));
      setMessageDetails(JSON.stringify(response, null, 2));
      onActionLog?.("Apply Augments", templateId, String(allowedAugments.length), "Succeeded");
      closeApplyAugments();
      await onReload();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessageTone("default");
      setMessage(text);
      setMessageDetails("");
      onActionLog?.("Apply Augments", templateId, String(allowedAugments.length), `Failed: ${text}`);
      onError(text);
    } finally {
      setAugmentApplying(false);
    }
  }

  function renderEditPanel(row: Record<string, unknown>) {
    const hasCurrentAtLoad = row.current_durability != null;
    const hasMaxAtLoad = row.max_durability != null || hasCurrentAtLoad;
    return <div className="result-panel database-edit-panel">
      <div className="panel-title"><strong>Edit Inventory Item</strong></div>
      <div className="database-edit-grid inventory-edit-grid">
        {EDITABLE_INVENTORY_COLUMNS.map((column) => {
          const isDisabled = column === "current_durability" ? !hasCurrentAtLoad : column === "max_durability" ? !hasMaxAtLoad : false;
          const isDurability = column === "current_durability" || column === "max_durability";
          if (column === "quality_level") {
            return <label key={column}>Grade
              <ItemGradeSelect value={editValues[column] || "0"} minGrade={0} onChange={(value) => setEditValues({ ...editValues, [column]: value })} />
            </label>;
          }
          return <label key={column}>{friendlyColumnName(column)}
            <input type="number" step="any" min={isDurability ? 0 : undefined} max={column === "max_durability" ? 100 : undefined} value={editValues[column] || ""} disabled={isDisabled} placeholder={isDisabled ? "N/A" : undefined} onChange={(event) => setEditValues({ ...editValues, [column]: event.target.value })} />
          </label>;
        })}
      </div>
      <div className="action-line">
        <button disabled={editSaving} onClick={() => void saveEditItem()}>{editSaving ? "Saving..." : "Save Item"}</button>
        <button onClick={closeEditItem}>Cancel</button>
      </div>
    </div>;
  }

  const inventorySort = useSortableRows(rows);
  const augmentNameById = new Map(augmentCatalog.map((augment) => [augment.id, augment.name]));

  function renderInventoryCell(row: Record<string, unknown>, column: string) {
    if (column !== "augments") {
      const value = row[column];
      if (column === "template_id") {
        const text = value == null || value === "" ? "—" : String(value);
        return <span className="inventory-template-id" title={text}>{text}</span>;
      }
      if (Array.isArray(value)) return value.join(", ");
      return value == null || value === "" ? "—" : String(value);
    }
    const augments = inventoryAugments(row);
    if (!augments.length) return <span className="muted">—</span>;
    return <span className="inventory-augment-list">{augments.map((id) => <span key={id}>{augmentNameById.get(id) || id}</span>)}</span>;
  }

  return <div>
    {data?.reason ? <p className="danger-note">{formatUiSentence(data.reason)}</p> : null}
    {message && <div className={`result-panel transient-result ${messageTone === "success" ? "success-result" : ""}`}><strong>{messageTone === "success" ? "Applied Successfully" : "Mutation Result."}</strong><p>{formatUiSentence(message)}</p>{messageDetails && <TechnicalDetails text={messageDetails} />}</div>}
    <DataTable
      rows={inventorySort.sortedRows}
      columns={INVENTORY_COLUMNS}
      emptyMessage={emptyMessage}
      renderCell={renderInventoryCell}
      tableClassName="player-inventory-table"
      actionClassName="actions-column"
      action={(row) => {
        const canUseAugments = inventoryItemCanUseAugments(row);
        return <span className="icon-toggle-group">
          <button className="icon-toggle-button success" title="Edit item" aria-label="Edit item" onClick={(event) => { event.stopPropagation(); startEditItem(row); }}><Circle size={16} /></button>
          {canUseAugments && <button className="icon-toggle-button accent" title={playerIsOnline ? "Player must be offline to apply augments" : "Apply Augments"} aria-label="Apply Augments" disabled={playerIsOnline} onClick={(event) => { event.stopPropagation(); startApplyAugments(row); }}>+A</button>}
          <button className="icon-toggle-button danger" title="Delete item" aria-label="Delete item" onClick={(event) => { event.stopPropagation(); void deleteItem(row); }}><X size={16} /></button>
        </span>;
      }}
      sortColumn={inventorySort.sortColumn}
      sortDirection={inventorySort.sortDirection}
      onSort={inventorySort.onSort}
      resizableColumns
      rowKey={(row) => String(row.id)}
      isRowExpanded={(row) => (editRow !== null && String(row.id) === String(editRow.id)) || (augmentTargetRow !== null && String(row.id) === String(augmentTargetRow.id))}
      renderExpandedRow={(row) => augmentTargetRow !== null && String(row.id) === String(augmentTargetRow.id) ? (
        <div className="result-panel database-edit-panel">
          <div className="panel-title"><strong>Apply Augments</strong></div>
          {playerIsOnline && <p className="danger-note">The player must be offline so live server state cannot overwrite this database edit.</p>}
          {(() => {
            const itemTemplate = String(row.template_id || "");
            const all = augmentCatalog;
            if (/_schematic$/i.test(itemTemplate)) return <p>Schematics cannot be augmented.</p>;
            const itemMeta = {
              templateId: itemTemplate,
              category: String(row.category || ""),
              source: String(row.source || "")
            };
            if (!itemCanUseAugments(itemMeta)) return <p>Only weapons and clothing can be augmented.</p>;
            const limit = inventoryRowAugmentLimit(row);
            const filtered = formatAugmentOptions(filterAugmentsForItem(itemMeta, all), augmentGrade);
            return filtered.length === 0 ? <p>No matching augments for this item type.</p> : <>
            <div className="playerAdmin_itemInputLine inventory-augment-input-line">
              <div className="playerAdmin_itemNumberField inventory-augment-select-field">
                <span>Augments</span>
                <AugmentDropdown options={filtered} value={augmentSelected} maxSelected={limit} onChange={(selected) => setAugmentSelected(selected.slice(0, limit))} />
              </div>
              <label className="playerAdmin_itemNumberField inventory-augment-grade-field">Aug. Grade
                <ItemGradeSelect value={augmentGrade} minGrade={1} disabled={augmentSelected.length === 0} emptyWhenDisabled onChange={setAugmentGrade} />
              </label>
            </div>
            <p className="playerAdmin_note" style={{ marginTop: 8 }}>Selected {augmentSelected.length} of {limit} allowed augment(s).</p>
          </>;
          })()}
          <div className="action-line">
            <button disabled={playerIsOnline || augmentSelected.length === 0 || augmentApplying} onClick={() => void applyAugments()}>{augmentApplying ? "Applying..." : `Apply ${augmentSelected.length} Augment(s)`}</button>
            <button onClick={closeApplyAugments}>Cancel</button>
          </div>
        </div>
      ) : renderEditPanel(row)}
    />
  </div>;
}
