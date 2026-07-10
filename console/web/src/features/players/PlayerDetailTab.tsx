import { useEffect, useState } from "react";
import { Circle, X } from "lucide-react";
import { playersApi } from "../../api/players";
import { adminApi } from "../../api/admin";
import { DataTable, useSortableRows } from "../../components/common/DataTable";
import { TechnicalDetails } from "../../components/common/DisplayPrimitives";
import { augmentLimit, AugmentPicker, friendlyCatalogName } from "../../components/common/ItemCatalog";
import { formatUiSentence, formatCell, friendlyColumnName } from "../../lib/display";
import { serializeEditableDbValue, parseEditableDbValue } from "../../lib/dbValues";

const EDITABLE_INVENTORY_COLUMNS = ["stack_size", "quality_level", "position_index", "current_durability", "max_durability"];

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
  formatMutationResult
}: {
  playerId: string;
  data: Record<string, unknown> | null;
  rows: Record<string, unknown>[];
  emptyMessage: string;
  onReload: () => void;
  onError: (text: string) => void;
  onActionLog?: (actionType: string, target: string, amount: string, notes: string) => void;
  confirmAction: ConfirmAction;
  formatMutationResult: (result: unknown) => string;
}) {
  const [message, setMessage] = useState("");
  const [messageDetails, setMessageDetails] = useState("");
  const [editRow, setEditRow] = useState<Record<string, unknown> | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [editSaving, setEditSaving] = useState(false);
  const [augmentTargetRow, setAugmentTargetRow] = useState<Record<string, unknown> | null>(null);
  const [augmentSelected, setAugmentSelected] = useState<string[]>([]);
  const [augmentCatalog, setAugmentCatalog] = useState<{ id: string; name: string }[]>([]);
  const [augmentApplying, setAugmentApplying] = useState(false);

  useEffect(() => {
    adminApi.itemCatalog("", 10000).then((result) => {
      const augs = (result.rows || []).filter((item) =>
        /T\d+_Augment/i.test(item.id || "") && ((item.category || "").toLowerCase() || "").includes("schematics")
      ).map((item) => ({ id: item.itemId || item.id, name: item.name }));
      setAugmentCatalog(augs);
    }).catch(() => setAugmentCatalog([]));
  }, []);

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

  function startEditItem(row: Record<string, unknown>) {
    setEditRow(row);
    const hasCurrentAtLoad = row.current_durability != null;
    setEditValues(Object.fromEntries(EDITABLE_INVENTORY_COLUMNS.map((column) => {
      if (column === "max_durability" && row.max_durability == null) return [column, hasCurrentAtLoad ? "100" : ""];
      if (column === "current_durability" && row.current_durability == null) return [column, ""];
      return [column, serializeEditableDbValue(row[column])];
    })));
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
      setMessageDetails("");
      return;
    }
    if (hasCurrent) {
      const currentDurability = Number(editValues.current_durability);
      const upperBound = hasMax ? maxDurability! : Number.POSITIVE_INFINITY;
      if (!Number.isFinite(currentDurability) || currentDurability < 0 || currentDurability > upperBound) {
        setMessage("Current Durability must be a number between 0 and Max Durability.");
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
      setMessage(formatMutationResult(response));
      setMessageDetails(JSON.stringify(response, null, 2));
      onActionLog?.("Edit Inventory Item", templateId, "1", "Succeeded");
      setEditRow(null);
      onReload();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
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
    const itemId = String(augmentTargetRow.id || "");
    const templateId = String(augmentTargetRow.template_id || "Unknown item");
    if (!(await confirmAction(`Apply ${augmentSelected.length} augment(s) to this item?`, {
      title: "Apply Augments",
      confirmLabel: "Apply",
      details: [
        { label: "Item ID", value: itemId, tone: "accent" },
        { label: "Template", value: templateId, tone: "accent" },
        { label: "Augments", value: augmentSelected.map((augId) => { const found = augmentCatalog.find((a) => a.id === augId); return found ? found.name : augId; }).join(", "), tone: "success" }
      ]
    }))) return;

    setAugmentApplying(true);
    try {
      const response = await playersApi.augmentInventoryItem(playerId, itemId, augmentSelected, "APPLY AUGMENTS");
      setMessage(formatMutationResult(response));
      setMessageDetails(JSON.stringify(response, null, 2));
      onActionLog?.("Apply Augments", templateId, String(augmentSelected.length), "Succeeded");
      setAugmentTargetRow(null);
      setAugmentSelected([]);
      onReload();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessage(text);
      setMessageDetails("");
      onActionLog?.("Apply Augments", templateId, String(augmentSelected.length), `Failed: ${text}`);
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
      <p className="playerAdmin_note">Item ID: {String(row.id)} · {String(row.template_id)}</p>
      <div className="database-edit-grid">
        {EDITABLE_INVENTORY_COLUMNS.map((column) => {
          const isDisabled = column === "current_durability" ? !hasCurrentAtLoad : column === "max_durability" ? !hasMaxAtLoad : false;
          const isDurability = column === "current_durability" || column === "max_durability";
          return <label key={column}>{friendlyColumnName(column)}
            <input type="number" step="any" min={isDurability ? 0 : undefined} max={column === "max_durability" ? 100 : undefined} value={editValues[column] || ""} disabled={isDisabled} placeholder={isDisabled ? "N/A" : undefined} onChange={(event) => setEditValues({ ...editValues, [column]: event.target.value })} />
          </label>;
        })}
      </div>
      <div className="action-line">
        <button disabled={editSaving} onClick={() => void saveEditItem()}>{editSaving ? "Saving..." : "Save Item"}</button>
        <button onClick={() => setEditRow(null)}>Cancel</button>
      </div>
    </div>;
  }

  const inventorySort = useSortableRows(rows);

  return <div>
    {data?.reason ? <p className="danger-note">{formatUiSentence(data.reason)}</p> : null}
    {message && <div className="result-panel transient-result"><strong>Mutation Result.</strong><p>{formatUiSentence(message)}</p>{messageDetails && <TechnicalDetails text={messageDetails} />}</div>}
    <DataTable
      rows={inventorySort.sortedRows}
      emptyMessage={emptyMessage}
      actionClassName="actions-column"
      renderCell={(row, col) => col === "template_id" ? friendlyCatalogName(String(row.template_id || "")) : formatCell(row[col])}
      action={(row) => <span className="icon-toggle-group">
        <button className="icon-toggle-button success" title="Edit item" aria-label="Edit item" onClick={(event) => { event.stopPropagation(); startEditItem(row); }}><Circle size={16} /></button>
        <button className="icon-toggle-button accent" title="Apply Augments" aria-label="Apply Augments" onClick={(event) => { event.stopPropagation(); setAugmentTargetRow(row); setAugmentSelected([]); }}>+A</button>
        <button className="icon-toggle-button danger" title="Delete item" aria-label="Delete item" onClick={(event) => { event.stopPropagation(); void deleteItem(row); }}><X size={16} /></button>
      </span>}
      sortColumn={inventorySort.sortColumn}
      sortDirection={inventorySort.sortDirection}
      onSort={inventorySort.onSort}
      resizableColumns
      rowKey={(row) => String(row.id)}
      isRowExpanded={(row) => (editRow !== null && String(row.id) === String(editRow.id)) || (augmentTargetRow !== null && String(row.id) === String(augmentTargetRow.id))}
      renderExpandedRow={(row) => augmentTargetRow !== null && String(row.id) === String(augmentTargetRow.id) ? (
        <div className="result-panel database-edit-panel">
          <div className="panel-title"><strong>Apply Augments</strong></div>
          <p className="playerAdmin_note">Item ID: {String(row.id)} · {String(row.template_id)}</p>
          {(() => {
            const itemTemplate = String(row.template_id || "");
            const all = augmentCatalog;
            const name = itemTemplate.toLowerCase();
            if (/_schematic$/i.test(name) || /_augment_/i.test(name)) return <p>Schematics and augment items cannot be augmented.</p>;
            const isWeapon = /lasgun|spitdart|jabal|disruptor|smg|karpov|rifle|drillshot|shotgun|grda|scattergun|vulcan|lmg|pyrocket|fireball|flamethrower|rocket|missile|pistol|snubnose|rafiq|maula|melee|sword|blade|knife|fremen/i.test(name);
            const isArmor = /chest|armor|guard|garment|helmet|boots|gloves|suit/i.test(name);
            const isMelee = /melee|sword|blade|knife|fremen/i.test(name);
            const rangedGeneric = new Set(["Damage","Acuracy","Shielddamage","Range","Recoil","ReloadSpeed","Rateoffire","Magazinecapacity","Headshotdamage"]); const commonGeneric = new Set(["DeathDurability","Ch5"]);
            const wp = (id: string) => { const trimmed = id.replace(/_Schematic$/i, ""); const m = trimmed.match(/^T\d+_Augment_(.+?)\d+$/); return m ? m[1] : ""; };
            const weaponMap: [RegExp, Set<string>][] = [
              [/lasgun/i, new Set(["Lasgun"])], [/spitdart|jabal/i, new Set(["Spitdartrifle","SpitdartRifle"])],
              [/disruptor| smg/i, new Set(["smg","Smg"])], [/karpov|battle.?rifle/i, new Set(["BR"])],
              [/drillshot|shotgun/i, new Set(["Shotgun"])], [/grda|scattergun/i, new Set(["Scattergun"])],
              [/vulcan|lmg/i, new Set(["Lmg"])], [/pyrocket|fireball/i, new Set(["Fireballer"])],
              [/flamethrower/i, new Set(["Flamethrower"])], [/rocket|missile/i, new Set(["RocketLauncher"])],
              [/maula|pistol|snubnose|rafiq/i, new Set(["HeavyPistol","MaulaPistol"])],
            ];
            const filtered = all.filter((aug) => {
              const p = wp(aug.id);
              if (isArmor) return /^Armor/i.test(p);
              if (isMelee) return p === "Melee" || commonGeneric.has(p);
              if (isWeapon) {
                if (rangedGeneric.has(p) || commonGeneric.has(p)) return true;
                for (const [rx, set] of weaponMap) { if (rx.test(name) && set.has(p)) return true; }
                return false;
              }
              return true;
            });
            return augmentLimit(String(row.template_id)) === 0 ? <p>Augments only available for weapons and armor.</p> : filtered.length === 0 ? <p>No matching augments for this item type.</p> : <>
            <label>Augments ({augmentSelected.length}/{augmentLimit(String(row.template_id))})</label>
            <AugmentPicker augments={filtered} selected={augmentSelected} onChange={setAugmentSelected} limit={augmentLimit(String(row.template_id))} />
          </>;
          })()}
          <div className="action-line">
            <button disabled={augmentSelected.length === 0 || augmentApplying} onClick={() => void applyAugments()}>{augmentApplying ? "Applying..." : `Apply ${augmentSelected.length} Augment(s)`}</button>
            <button onClick={() => { setAugmentTargetRow(null); setAugmentSelected([]); }}>Cancel</button>
          </div>
        </div>
      ) : renderEditPanel(row)}
    />
  </div>;
}
