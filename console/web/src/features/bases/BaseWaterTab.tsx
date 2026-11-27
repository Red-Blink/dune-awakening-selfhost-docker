import { useCallback, useEffect, useRef, useState } from "react";
import { PermissionGate } from "../../lib/consoleAccess";
import { basesApi, type WaterContainerEntry } from "../../api/bases";
import { InfoTooltip } from "../../components/common/DisplayPrimitives";

// Auto-refill state/handlers live in BasesPanel (mirrors generator
// Auto-Refill), which passes down whatever this tab needs to render its own
// toggle without owning any of that state itself.
export type BaseWaterAutoRefillProps = {
  supported: boolean;
  unavailable: boolean;
  enabled: boolean;
  saving: boolean;
  stalledAt: string;
  consecutiveQueues: number;
  canToggle: boolean;
  tooltip: string;
  onToggle: (enabled: boolean) => void;
  onRetry: () => void;
};

type BaseWaterTabProps = {
  baseId: string;
  autoRefill: BaseWaterAutoRefillProps;
  // Bumped by BasesPanel after an immediate (non-queued) refill -- water isn't
  // part of the row/list data this tab could otherwise pick up on its own, so
  // this is the only signal telling an already-open tab to refetch.
  refreshToken?: number;
};

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function BaseWaterTab({ baseId, autoRefill, refreshToken }: BaseWaterTabProps) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [containers, setContainers] = useState<WaterContainerEntry[]>([]);
  const [unsupportedReason, setUnsupportedReason] = useState("");

  // Only the newest request may write state. Two get to overlap here:
  // StrictMode double-invokes the effect, and refreshToken re-runs it on a
  // mounted instance after an immediate refill -- so whichever settles last
  // would otherwise win, and a first attempt failing after a second succeeded
  // would replace fresh levels with an error banner. Same requestIdRef pattern
  // BasesPanel and BaseInventoryTab use.
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setLoadError("");
    setUnsupportedReason("");
    try {
      const result = await basesApi.water(baseId);
      if (requestIdRef.current !== requestId) return;
      setUnsupportedReason(result.supported === false
        ? result.reason || "Water storage is unsupported by the detected schema."
        : "");
      setContainers(result.containers || []);
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setLoadError(errorText(error));
    } finally {
      // Left to the newest request too, so an early finisher cannot clear the
      // spinner while the request that will actually fill the tab is open.
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [baseId]);

  useEffect(() => { void load(); }, [load, refreshToken]);

  if (loading) {
    return <p className="muted" role="status">Loading water storage…</p>;
  }
  if (loadError) {
    return <p className="bases-permissions-error" role="alert">
      {loadError} <button onClick={() => void load()}>Retry</button>
    </p>;
  }
  // A settled answer, not a failure: this database cannot back the tab, so it
  // gets a plain statement and no Retry -- the request would fail identically
  // every time. Genuine failures still land in the branch above, where Retry
  // means something. The auto-refill toggle is suppressed with it, since it
  // acts on the same devices this schema cannot describe.
  if (unsupportedReason) {
    return <p className="muted" role="status">{unsupportedReason}</p>;
  }

  return (
    <div className="bases-water" onClick={(event) => event.stopPropagation()}>
      <div className="bases-tab-body">
        {autoRefill.supported && <div className="bases-auto-refill">
          {autoRefill.unavailable
            ? <p className="bases-auto-refill-unknown" role="status">
                Auto-refill state could not be read. <button onClick={autoRefill.onRetry}>Retry</button>
              </p>
            : <div className="memory-feature-toggle">
                <InfoTooltip id={`auto-refill-water-help-${baseId}`} label="About Auto-Refill">{autoRefill.tooltip}</InfoTooltip>
                <PermissionGate action="bases:mutate"><label className={`switch-checkbox bases-auto-refill-toggle ${autoRefill.enabled ? "enabled" : "disabled"}`}>
                  <input
                    type="checkbox"
                    checked={autoRefill.enabled}
                    disabled={autoRefill.saving || !autoRefill.canToggle}
                    onChange={(event) => autoRefill.onToggle(event.target.checked)}
                  />
                  <span className="switch-label">Auto-Refill</span>
                  <strong className="switch-state">{autoRefill.saving ? "Saving" : autoRefill.enabled ? "ON" : "OFF"}</strong>
                </label></PermissionGate>
              </div>}
          {autoRefill.stalledAt && <p className="bases-auto-refill-stalled" role="alert">
            Paused after {autoRefill.consecutiveQueues} refills that did not raise the water. Refill manually to check why, or turn auto-refill off and on to resume.
          </p>}
        </div>}

        {!containers.length && <p className="muted">No water storage at this base.</p>}

        <div className="bases-card-grid bases-water-cards">
          {containers.map((container) => (
            <div className="bases-card" key={container.type}>
              <div className="bases-card-title">{container.name}</div>
              <dl className="bases-card-stats">
                <dt>Containers</dt>
                <dd>{container.count.toLocaleString()}</dd>
                <dt>Water Volume</dt>
                <dd>{container.stored.toLocaleString()} / {container.capacity.toLocaleString()}</dd>
                <dt>Water Fill</dt>
                <dd>
                  <div className="progress-row">
                    <div className="progress-track"><div className="progress-fill progress-fill-water" style={{ width: `${container.percent}%` }} /></div>
                    <span>{container.percent}%</span>
                  </div>
                </dd>
                {container.bloodCapacity !== undefined && <>
                  <dt>Blood Volume</dt>
                  <dd>{(container.bloodStored ?? 0).toLocaleString()} / {container.bloodCapacity.toLocaleString()}</dd>
                  <dt>Blood Fill</dt>
                  <dd>
                    <div className="progress-row">
                      <div className="progress-track"><div className="progress-fill progress-fill-blood" style={{ width: `${container.bloodPercent ?? 0}%` }} /></div>
                      <span>{container.bloodPercent ?? 0}%</span>
                    </div>
                  </dd>
                </>}
              </dl>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
