import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { addonsApi, type AddonLifecycle, type CommunityAddonSummary, type InstalledAddon } from "../../api/addons";
import { addonUpdateAvailable, hasAddonUpdates } from "./addonVersions";
const PreviewAddon = import.meta.env.VITE_CONSOLE_PREVIEW === "true" ? lazy(() => import("../../../preview/AddonSample")) : null;
import type { PinnedAddon } from "./pinnedAddons";

type AddonsPanelProps = {
  pinnedAddons: PinnedAddon[];
  setPinnedAddons: Dispatch<SetStateAction<PinnedAddon[]>>;
  selectedAddonId: string;
  clearSelectedAddon: () => void;
  setAddonUpdateAvailable: Dispatch<SetStateAction<boolean>>;
  confirmAction: (message: string, options?: { danger?: boolean; confirmLabel?: string }) => Promise<boolean>;
};

export function AddonsPanel({ pinnedAddons, setPinnedAddons, selectedAddonId, clearSelectedAddon, setAddonUpdateAvailable, confirmAction }: AddonsPanelProps) {
  const [addons, setAddons] = useState<CommunityAddonSummary[]>([]);
  const [installed, setInstalled] = useState<InstalledAddon[]>([]);
  const [loading, setLoading] = useState(false);
  const [installedLoaded, setInstalledLoaded] = useState(false);
  const [installingId, setInstallingId] = useState("");
  const [busyAddonId, setBusyAddonId] = useState("");
  const [openAddonId, setOpenAddonId] = useState("");
  const [expandedDescriptions, setExpandedDescriptions] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<{ title: string; message: string; tone: "ok" | "fail" } | null>(null);
  const addonFrameRef = useRef<HTMLIFrameElement | null>(null);

  async function load() {
    setLoading(true);
    setNotice(null);
    try {
      const [result, installedResult] = await Promise.all([addonsApi.community(), addonsApi.installed()]);
      const catalogAddons = result.addons || [];
      const installedAddons = installedResult.addons || [];
      setAddons(catalogAddons);
      setAddonUpdateAvailable(hasAddonUpdates(catalogAddons, installedAddons));
      setInstalled(installedAddons);
      setInstalledLoaded(true);
    } catch (err) {
      setNotice({ title: "Addons Unavailable", message: formatAddonError(err), tone: "fail" });
      setAddons([]);
      setAddonUpdateAvailable(false);
      setInstalled([]);
      setInstalledLoaded(false);
    } finally {
      setLoading(false);
    }
  }

  async function installAddon(addon: CommunityAddonSummary) {
    if (isInstallBlocked(addon.lifecycle)) {
      setNotice({ title: "Install Blocked", message: lifecycleInstallMessage(addon), tone: "fail" });
      return;
    }
    const permissions = addon.permissions || [];
    const permissionText = permissions.length
      ? ` It requests: ${permissions.map(formatPermissionLabel).join(", ")}.`
      : " It does not request console permissions.";
    if (!(await confirmAction(`Install ${addon.name}? The addon archive will be downloaded, verified, and installed disabled.${permissionText}`))) return;
    setInstallingId(addon.id);
    setNotice(null);
    try {
      const result = await addonsApi.installCommunity(addon.id, permissions);
      await load();
      setNotice({ title: "Addon Installed", message: `${result.addon.name} was installed successfully.`, tone: "ok" });
    } catch (err) {
      setNotice({ title: "Install Failed", message: formatAddonError(err), tone: "fail" });
    } finally {
      setInstallingId("");
    }
  }

  async function updateAddon(addon: CommunityAddonSummary, installedAddon: InstalledAddon) {
    if (isInstallBlocked(addon.lifecycle)) {
      setNotice({ title: "Update Blocked", message: lifecycleInstallMessage(addon), tone: "fail" });
      return;
    }
    const approved = new Set(installedAddon.approvedPermissions || []);
    const addedPermissions = (addon.permissions || []).filter((permission) => !approved.has(permission));
    const permissionText = addedPermissions.length
      ? ` This update requests additional access: ${addedPermissions.map(formatPermissionLabel).join(", ")}. Continuing approves this additional access.`
      : " Its approved permissions will remain unchanged.";
    const message = `Update ${addon.name} from ${installedAddon.version} to ${addon.version}? Existing addon settings, schedules, enabled state, and browser preferences will be preserved.${permissionText}`;
    if (!(await confirmAction(message, { confirmLabel: "Update Addon" }))) return;
    setBusyAddonId(addon.id);
    setNotice(null);
    if (openAddonId === addon.id) setOpenAddonId("");
    try {
      const result = await addonsApi.updateCommunity(addon.id, addon.permissions || []);
      await load();
      setNotice({ title: "Addon Updated", message: `${addon.name} was updated from ${result.previousVersion} to ${result.addon.version}. Existing configuration was preserved.`, tone: "ok" });
    } catch (err) {
      setNotice({ title: "Update Failed", message: formatAddonError(err), tone: "fail" });
    } finally {
      setBusyAddonId("");
    }
  }

  async function setAddonEnabled(addon: InstalledAddon, enabled: boolean) {
    setBusyAddonId(addon.id);
    setNotice(null);
    try {
      const result = enabled ? await addonsApi.enable(addon.id) : await addonsApi.disable(addon.id);
      await load();
      setNotice({
        title: enabled ? "Addon Enabled" : "Addon Disabled",
        message: `${result.addon.name} was ${enabled ? "enabled" : "disabled"}.`,
        tone: "ok"
      });
    } catch (err) {
      setNotice({ title: enabled ? "Enable Failed" : "Disable Failed", message: formatAddonError(err), tone: "fail" });
    } finally {
      setBusyAddonId("");
    }
  }

  async function removeAddon(addon: InstalledAddon) {
    if (!(await confirmAction(`Uninstall ${addon.name}? ${addon.uninstallNotice || "This removes the addon files, Console jobs, and stored addon data. Any manually installed external services must be removed separately."}`, { danger: true, confirmLabel: "Uninstall" }))) return;
    setBusyAddonId(addon.id);
    setNotice(null);
    try {
      await addonsApi.remove(addon.id);
      if (openAddonId === addon.id) setOpenAddonId("");
      await load();
      setNotice({ title: "Addon Uninstalled", message: `${addon.name} was uninstalled.`, tone: "ok" });
    } catch (err) {
      await load();
      setNotice({ title: "Uninstall Failed", message: formatAddonError(err), tone: "fail" });
    } finally {
      setBusyAddonId("");
    }
  }

  function toggleAddonPin(addon: InstalledAddon, pinned: boolean) {
    if (pinned) {
      setPinnedAddons((current) => current.some((item) => item.id === addon.id) ? current : [...current, { id: addon.id, name: addon.name, entryPath: addon.entryPath, enabled: addon.enabled }]);
    } else {
      setPinnedAddons((current) => current.filter((item) => item.id !== addon.id));
      if (selectedAddonId === addon.id) clearSelectedAddon();
      if (openAddonId === addon.id) setOpenAddonId("");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (selectedAddonId) setOpenAddonId(selectedAddonId);
  }, [selectedAddonId]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const installedById = new Map(installed.map((addon) => [addon.id, addon]));
  const communityById = new Map(addons.map((addon) => [addon.id, addon]));
  const openAddon = installed.find((addon) => addon.id === openAddonId && addon.enabled);

  useEffect(() => {
    if (!installedLoaded) return;
    setPinnedAddons((current) => current
      .map((item) => {
        const installedAddon = installed.find((addon) => addon.id === item.id && addon.enabled);
        return installedAddon ? { id: installedAddon.id, name: installedAddon.name, entryPath: installedAddon.entryPath, enabled: installedAddon.enabled } : null;
      })
      .filter((item): item is PinnedAddon => Boolean(item)));
  }, [installed, installedLoaded, setPinnedAddons]);

  useEffect(() => {
    if (!openAddon) return undefined;
    const activeAddon = openAddon;
    function onMessage(event: MessageEvent) {
      if (!addonFrameRef.current || event.source !== addonFrameRef.current.contentWindow) return;
      const fromSameOrigin = event.origin === window.location.origin;
      const fromSandboxedFrame = event.origin === "null" && Boolean(addonFrameRef.current && event.source === addonFrameRef.current.contentWindow);
      if (!fromSameOrigin && !fromSandboxedFrame) return;
      const request = normalizeAddonBridgeRequest(event.data);
      if (!request || request.addonId !== activeAddon.id) return;
      const source = event.source as Window | null;
      if (!source) return;
      const targetOrigin = event.origin === "null" ? "*" : event.origin;
      void (async () => {
        try {
          const response = await addonsApi.bridge(activeAddon.id, request.action, request.payload);
          source.postMessage({ type: "dune-addon-response", requestId: request.requestId, ok: true, result: response.result }, targetOrigin);
        } catch (err) {
          source.postMessage({ type: "dune-addon-response", requestId: request.requestId, ok: false, error: formatAddonError(err) }, targetOrigin);
        }
      })();
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [openAddon]);

  const rows: AddonTableRow[] = addons.filter((addon) => addon.lifecycle !== "removed").map((addon) => {
    const installedAddon = installedById.get(addon.id);
    return { ...addon, status: installedAddon ? installedAddon.status || "Installed" : "Available", installedOnly: false };
  });
  rows.push(...installed
    .filter((addon) => !communityById.has(addon.id))
    .map((addon) => ({
      id: addon.id,
      name: addon.name,
      description: addon.description,
      author: addon.author,
      version: addon.version,
      sourceUrl: "",
      manifestUrl: "",
      lifecycle: addon.lifecycle || "removed",
      lifecycleMessage: addon.lifecycleMessage || "This addon is installed locally but is no longer listed in the community catalog.",
      lifecycleUrl: addon.lifecycleUrl || "",
      permissions: addon.permissions,
      provenance: addon.provenance || {},
      status: addon.status || "Installed",
      installedOnly: true
    }))
    .filter((addon) => addon.lifecycle !== "removed"));
  const lifecycleSummary = addonLifecycleSummary(rows);

  if (selectedAddonId) {
    return <section className="panel addon-view-panel">
      {openAddon
        ? <>
          <div className="panel-title"><h2>{openAddon.name}</h2></div>
          {PreviewAddon ? <Suspense fallback={<p>Loading...</p>}><PreviewAddon id={openAddon.id} /></Suspense> : <iframe ref={addonFrameRef} className="addon-frame" title={openAddon.name} src={addonContentUrl(openAddon)} sandbox="allow-scripts" referrerPolicy="no-referrer" />}
        </>
        : <div className="result-panel result-fail"><strong>Addon unavailable.</strong><p>This pinned addon is not installed, enabled, or fully loaded yet.</p></div>}
    </section>;
  }

  return <section className="panel">
    <div className="panel-title addons-page-header"><h2>Addons <span className="addons-title-status">Experimental: Permissioned</span></h2><div className="addons-title-actions"><a className="button-link" href="https://github.com/Red-Blink/dune-docker-addon-template" target="_blank" rel="noreferrer">For Developers</a><button disabled={loading} onClick={() => void load()}>{loading ? "Refreshing..." : "Refresh Addons"}</button></div></div>
    <section className="action-section info-panel addons-intro-panel">
      <h4>Community Addons</h4>
      <div className="addons-owner-copy">
        <p>Add community-built tools into your Dune Docker Console. Discover addons created by the community, see what each one adds, review what it can access, and enable new features whenever you're ready to expand your console.</p>
      </div>
      <div className="badge-row addon-catalog-status-row" aria-label="Addon catalog lifecycle summary">
        {lifecycleSummary.map((item) => <span key={item.lifecycle} className={`badge ${lifecycleBadgeKind(item.lifecycle)}`}>{formatLifecycleLabel(item.lifecycle)}: {item.count}</span>)}
      </div>
    </section>
    {notice && <div className={`result-panel addon-result-panel result-${notice.tone}`}><strong>{notice.title}.</strong><p>{notice.message}</p></div>}
    <AddonsTable
      rows={rows}
      loading={loading}
      installedById={installedById}
      pinnedAddons={pinnedAddons}
      installingId={installingId}
      busyAddonId={busyAddonId}
      openAddonId={openAddonId}
      expandedDescriptions={expandedDescriptions}
      setExpandedDescriptions={setExpandedDescriptions}
      installAddon={installAddon}
      updateAddon={updateAddon}
      setAddonEnabled={setAddonEnabled}
      removeAddon={removeAddon}
      setOpenAddonId={setOpenAddonId}
      toggleAddonPin={toggleAddonPin}
    />
    {openAddon && <section className="action-section">
      <div className="panel-title"><h4>{openAddon.name}</h4></div>
      {PreviewAddon ? <Suspense fallback={<p>Loading...</p>}><PreviewAddon id={openAddon.id} /></Suspense> : <iframe ref={addonFrameRef} className="addon-frame" title={openAddon.name} src={addonContentUrl(openAddon)} sandbox="allow-scripts" referrerPolicy="no-referrer" />}
    </section>}
  </section>;
}

type AddonTableRow = CommunityAddonSummary & { status: string; installedOnly: boolean };

function AddonsTable({ rows, loading, installedById, pinnedAddons, installingId, busyAddonId, openAddonId, expandedDescriptions, setExpandedDescriptions, installAddon, updateAddon, setAddonEnabled, removeAddon, setOpenAddonId, toggleAddonPin }: {
  rows: AddonTableRow[];
  loading: boolean;
  installedById: Map<string, InstalledAddon>;
  pinnedAddons: PinnedAddon[];
  installingId: string;
  busyAddonId: string;
  openAddonId: string;
  expandedDescriptions: Record<string, boolean>;
  setExpandedDescriptions: Dispatch<SetStateAction<Record<string, boolean>>>;
  installAddon: (addon: CommunityAddonSummary) => void;
  updateAddon: (addon: CommunityAddonSummary, installedAddon: InstalledAddon) => void;
  setAddonEnabled: (addon: InstalledAddon, enabled: boolean) => void;
  removeAddon: (addon: InstalledAddon) => void;
  setOpenAddonId: Dispatch<SetStateAction<string>>;
  toggleAddonPin: (addon: InstalledAddon, pinned: boolean) => void;
}) {
  if (!rows.length) return <div className="empty addons-empty-state">{loading ? "Loading community addons..." : "No community addons are listed yet."}</div>;
  return <div className="table-wrap addons-table-wrap"><table className="addons-table" aria-label="Addons">
    <colgroup>
      <col className="addon-col-identity" />
      <col className="addon-col-version" />
      <col className="addon-col-permissions" />
      <col className="addon-col-status" />
      <col className="addon-col-actions" />
    </colgroup>
    <thead><tr><th scope="col">Addon</th><th scope="col">Version</th><th scope="col">Permissions</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead><tbody>{rows.map((row) => {
    const installedAddon = installedById.get(row.id);
    const busy = busyAddonId === row.id;
    const pinned = Boolean(installedAddon && pinnedAddons.some((addon) => addon.id === installedAddon.id));
    const updateAvailable = Boolean(installedAddon && addonUpdateAvailable(installedAddon.version, row.version));
    return <tr key={row.id}>
      <td data-label="Addon" className="addon-identity-cell">
        <div className="addon-identity-content">
          <div className="addon-name-line"><AddonNameCell addon={row} />{row.lifecycle !== "active" && (installedAddon || !isInstallBlocked(row.lifecycle)) && <LifecyclePill lifecycle={installedAddon?.lifecycle || row.lifecycle} />}</div>
          <small className="addon-author-cell">{row.author}</small>
          <AddonDescriptionCell addon={row} expanded={Boolean(expandedDescriptions[row.id])} onToggle={() => setExpandedDescriptions((current) => ({ ...current, [row.id]: !current[row.id] }))} />
        </div>
      </td>
      <td data-label="Version" className="addon-version-column"><AddonVersionCell catalogVersion={row.version} installedAddon={installedAddon} updateAvailable={updateAvailable} /></td>
      <td data-label="Permissions" className="addon-permissions-cell"><PermissionList permissions={updateAvailable ? row.permissions || [] : installedAddon?.permissions || row.permissions || []} approvedPermissions={installedAddon?.approvedPermissions || []} /></td>
      <td data-label="Status" className="addon-status-column">
        {installedAddon ? <div className="addon-status-cell"><label className={`switch-checkbox addon-status-toggle ${installedAddon.enabled ? "enabled" : "disabled"}`}><input type="checkbox" disabled={busy || installedAddon.lifecycle === "blocked"} checked={installedAddon.enabled} onChange={(event) => void setAddonEnabled(installedAddon, event.target.checked)} /><span className="switch-label">{busy ? "Working" : installedAddon.enabled ? "Enabled" : "Disabled"}</span><strong className="switch-state" aria-hidden="true" /></label></div> : <div className="addon-status-cell">{isInstallBlocked(row.lifecycle) ? <LifecyclePill lifecycle={row.lifecycle} /> : <StatusPill value="Available" />}</div>}
      </td>
      <td data-label="Actions" className="addon-actions-column"><div className="addon-actions-cell"><div className="service-actions">
        {!installedAddon && <button disabled={installingId === row.id || isInstallBlocked(row.lifecycle)} title={isInstallBlocked(row.lifecycle) ? lifecycleInstallMessage(row) : undefined} onClick={() => void installAddon(row)}>{installingId === row.id ? "Installing..." : "Install"}</button>}
        {installedAddon && updateAvailable && <button disabled={busy || isInstallBlocked(row.lifecycle)} title={isInstallBlocked(row.lifecycle) ? lifecycleInstallMessage(row) : `Update ${installedAddon.version} to ${row.version}`} onClick={() => void updateAddon(row, installedAddon)}>{busy ? "Updating..." : "Update"}</button>}
        {installedAddon?.enabled && <button disabled={busy} onClick={() => setOpenAddonId(openAddonId === installedAddon.id ? "" : installedAddon.id)}>{openAddonId === installedAddon.id ? "Close" : "Open"}</button>}
        {installedAddon && <button className="danger addon-uninstall-button" aria-label="Uninstall" title="Uninstall" disabled={busy} onClick={() => void removeAddon(installedAddon)}><Trash2 size={16} aria-hidden="true" /></button>}
      </div>
      {installedAddon?.enabled && <label className={`switch-checkbox addon-pin-toggle ${pinned ? "enabled" : "disabled"}`}><input type="checkbox" checked={pinned} onChange={(event) => toggleAddonPin(installedAddon, event.target.checked)} /><span className="switch-label">Sub-Menu</span><strong className="switch-state">{pinned ? "ON" : "OFF"}</strong></label>}
      </div></td>
    </tr>;
  })}</tbody></table></div>;
}

function AddonVersionCell({ catalogVersion, installedAddon, updateAvailable }: { catalogVersion: string; installedAddon?: InstalledAddon; updateAvailable: boolean }) {
  if (!installedAddon) return <span>{catalogVersion}</span>;
  return <div className="addon-version-cell">
    {updateAvailable
      ? <span className="addon-version-upgrade" aria-label={`Update available: ${installedAddon.version} to ${catalogVersion}`} title={`Update available: ${installedAddon.version} to ${catalogVersion}`}>
        <span>{installedAddon.version}</span><span className="addon-version-arrow" aria-hidden="true">→</span><strong>{catalogVersion}</strong>
      </span>
      : <strong>{installedAddon.version}</strong>}
  </div>;
}

function AddonNameCell({ addon }: { addon: CommunityAddonSummary }) {
  const sourceUrl = String(addon.sourceUrl || "").trim();
  if (!sourceUrl) return <strong>{addon.name}</strong>;
  return <a className="addon-source-link" href={sourceUrl} target="_blank" rel="noreferrer" title="Open addon source on GitHub">{addon.name}</a>;
}

function PermissionList({ permissions, approvedPermissions }: { permissions: string[]; approvedPermissions: string[] }) {
  if (!permissions.length) return <span className="muted">None</span>;
  const approved = new Set(approvedPermissions);
  return <div className="addon-permissions-list">{groupPermissions(permissions).map((group) => (
    <span key={group.key} className={`addon-permission-chip ${group.permissions.every((permission) => approved.has(permission)) ? "approved" : ""}`}>{group.label}</span>
  ))}</div>;
}

function groupPermissions(permissions: string[]) {
  const groups = new Map<string, { scope: string; actions: string[]; permissions: string[] }>();
  for (const permission of permissions) {
    const [scope, action] = String(permission || "").split(":");
    const key = scope && action ? scope : permission;
    const current = groups.get(key) || { scope: scope && action ? scope : "", actions: [], permissions: [] };
    if (action && !current.actions.includes(action)) current.actions.push(action);
    current.permissions.push(permission);
    groups.set(key, current);
  }
  return [...groups.entries()].map(([key, group]) => ({
    key,
    permissions: group.permissions,
    label: group.scope
      ? `${formatPermissionPart(group.scope)} ${group.actions.map(formatPermissionPart).join(" & ")}`
      : key
  }));
}

function formatPermissionPart(value: string) {
  return value.replaceAll("-", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatPermissionLabel(permission: string) {
  const [scope, action] = String(permission || "").split(":");
  if (!scope || !action) return permission;
  return `${formatPermissionPart(scope)} ${formatPermissionPart(action)}`;
}

function StatusPill({ value }: { value: unknown }) {
  const text = String(value ?? "");
  const normalized = text.toLowerCase();
  const kind = normalized.includes("ready") || normalized.includes("running") || normalized.includes("ok") || normalized.includes("enabled") || normalized.includes("available") ? "ok"
    : normalized.includes("fail") || normalized.includes("missing") || normalized.includes("stopped") || normalized.includes("disabled") || normalized.includes("error") ? "bad"
      : "warn";
  return <span className={`badge ${kind}`}>{text || "Unknown"}</span>;
}

function normalizeAddonBridgeRequest(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.type !== "dune-addon-request") return null;
  const addonId = typeof record.addonId === "string" ? record.addonId : "";
  const requestId = typeof record.requestId === "string" ? record.requestId : "";
  const action = typeof record.action === "string" ? record.action : "";
  if (!addonId || !requestId || !action) return null;
  const payload = record.payload && typeof record.payload === "object" && !Array.isArray(record.payload) ? record.payload as Record<string, unknown> : {};
  return { addonId, requestId, action, payload };
}

function AddonDescriptionCell({ addon, expanded, onToggle }: { addon: Pick<AddonTableRow, "description" | "lifecycle" | "lifecycleMessage" | "lifecycleUrl" | "installedOnly">; expanded: boolean; onToggle: () => void }) {
  const text = String(addon.description ?? "").trim();
  const lifecycleText = addonLifecycleMessage(addon);
  const fullText = [text, lifecycleText].filter(Boolean).join(" ");
  const measureRef = useRef<HTMLSpanElement>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const element = measureRef.current;
    if (!element) return;
    const measure = () => setOverflows(element.scrollWidth > element.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    let active = true;
    void document.fonts?.ready.then(() => { if (active) measure(); });
    return () => { active = false; observer.disconnect(); };
  }, [fullText]);
  if (!fullText) return "";
  return <div className={`addon-description-field ${expanded ? "expanded" : ""} ${addon.lifecycle !== "active" ? "addon-lifecycle-description" : ""}`}>
    <span className="addon-description-measure" ref={measureRef} aria-hidden="true">{fullText}</span>
    <span className="addon-description-text" title={fullText}>{fullText}{addon.lifecycleUrl && expanded ? <> <a href={addon.lifecycleUrl} target="_blank" rel="noreferrer">Details</a></> : null}</span>
    {overflows ? <button className="addon-description-more" type="button" aria-expanded={expanded} onClick={onToggle}>{expanded ? "Less" : "More"}</button> : null}
  </div>;
}

function LifecyclePill({ lifecycle }: { lifecycle: AddonLifecycle }) {
  return <span className={`badge addon-lifecycle-pill ${lifecycleBadgeKind(lifecycle || "active")}`}>{formatLifecycleLabel(lifecycle || "active")}</span>;
}

function lifecycleBadgeKind(lifecycle: AddonLifecycle) {
  if (lifecycle === "active") return "ok";
  if (lifecycle === "blocked" || lifecycle === "removed") return "bad";
  return "warn";
}

function addonLifecycleSummary(rows: AddonTableRow[]) {
  const counts = rows.reduce<Record<AddonLifecycle, number>>((current, row) => {
    const lifecycle = row.lifecycle || "active";
    current[lifecycle] += 1;
    return current;
  }, { active: 0, deprecated: 0, unsupported: 0, removed: 0, blocked: 0 });
  return (Object.entries(counts) as [AddonLifecycle, number][])
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => lifecycleSortOrder(left) - lifecycleSortOrder(right))
    .map(([lifecycle, count]) => ({ lifecycle, count }));
}

function lifecycleSortOrder(lifecycle: AddonLifecycle) {
  return ["active", "deprecated", "unsupported", "removed", "blocked"].indexOf(lifecycle);
}

function addonLifecycleMessage(addon: Pick<AddonTableRow, "lifecycle" | "lifecycleMessage" | "installedOnly">) {
  if (!addon.lifecycle || addon.lifecycle === "active") return "";
  if (addon.lifecycleMessage) return addon.lifecycleMessage;
  if (addon.installedOnly) return "This addon is installed locally but is no longer listed in the community catalog.";
  if (addon.lifecycle === "deprecated") return "This addon is deprecated and may stop receiving updates.";
  if (addon.lifecycle === "unsupported") return "This addon is no longer supported by its maintainer.";
  if (addon.lifecycle === "removed") return "This addon was removed from the community catalog.";
  if (addon.lifecycle === "blocked") return "This addon was blocked for safety and cannot be installed or opened.";
  return "";
}

function isInstallBlocked(lifecycle: AddonLifecycle) {
  return lifecycle === "unsupported" || lifecycle === "removed" || lifecycle === "blocked";
}

function lifecycleInstallMessage(addon: Pick<AddonTableRow | CommunityAddonSummary, "name" | "lifecycle" | "lifecycleMessage">) {
  return addon.lifecycleMessage || `${addon.name} cannot be installed because its community status is ${formatLifecycleLabel(addon.lifecycle)}.`;
}

function formatLifecycleLabel(lifecycle: AddonLifecycle) {
  return lifecycle.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function addonContentUrl(addon: InstalledAddon) {
  return `/api/addons/installed/${encodeURIComponent(addon.id)}/content/${addon.entryPath.split("/").map(encodeURIComponent).join("/")}`;
}

function formatAddonError(value: unknown) {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "Action failed.";
  }
}
