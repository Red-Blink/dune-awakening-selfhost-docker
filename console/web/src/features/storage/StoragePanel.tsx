import { PermissionGate } from "../../lib/consoleAccess";
import { useEffect, useState } from "react";
import { worldDataApi } from "../../api/worldData";
import { DataTable } from "../../components/common/DataTable";

type StoragePanelProps = {
  onError: (text: string) => void;
  confirmAction: (message: string) => Promise<boolean>;
  formatMutationResult: (result: unknown) => string;
};

export function StoragePanel({ onError, confirmAction, formatMutationResult }: StoragePanelProps) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [itemName, setItemName] = useState("");
  const [canGiveItem, setCanGiveItem] = useState(false);
  const [storageResult, setStorageResult] = useState("Give Item to Storage runs only when the backend verifies the storage schema.");

  async function load() {
    onError("");
    try {
      const result = await worldDataApi.storage();
      setRows(result.rows || []);
      setCanGiveItem(Boolean(result.capabilities?.storageGiveItem));
      if (!result.capabilities?.storageGiveItem) setStorageResult("Storage give-item is unsupported until this database exposes compatible dune.inventories and dune.items insert columns.");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  async function open(row: Record<string, unknown>) {
    setSelected(row);
    setItems((await worldDataApi.storageItems(String(row.id))).rows || []);
  }

  async function giveStorageItem() {
    if (!selected) return;
    onError("");
    try {
      if (!(await confirmAction(`Give 1 x ${itemName} to storage ${String(selected.id)}?`))) return;
      const response = await worldDataApi.storageGiveItem(String(selected.id), { itemName, quantity: 1, confirmation: "GIVE ITEM TO STORAGE" });
      setStorageResult(formatMutationResult(response));
      setItems((await worldDataApi.storageItems(String(selected.id))).rows || []);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setStorageResult(text);
      onError(text);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return <section className="panel"><div className="panel-title"><h2>Storage</h2><button onClick={() => void load()}>Refresh Storage</button></div><p className="danger-note">{storageResult}</p><DataTable rows={rows} onRowClick={open} />{selected && <section className="drawer"><h3>Storage {String(selected.id)}</h3><div className="action-row"><a className="button-link" href={worldDataApi.storageExportUrl(String(selected.id))}>Export JSON</a><input value={itemName} onChange={(event) => setItemName(event.target.value)} placeholder="Item name" /><PermissionGate action="storage:mutate"><button disabled={!canGiveItem} onClick={() => void giveStorageItem()}>Give Item to Storage</button></PermissionGate></div><DataTable rows={items} /></section>}</section>;
}
