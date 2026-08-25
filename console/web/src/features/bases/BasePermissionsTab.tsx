import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  basesApi,
  type BaseChildAccessAudit,
  type BasePermissionCandidate,
  type BasePermissionEntry,
  type BasePermissionRank
} from "../../api/bases";
import {
  ASSOCIATE_RANK,
  CO_OWNER_RANK,
  EntryName,
  OWNER_RANK,
  OwnerHeroCard,
  RANK_OPTIONS,
  RANK_LABELS,
  RankSegments,
  type DraftEntry,
  demoteOtherOwners,
  errorText,
  formatShareBreakdown,
  sameRoster,
  sortDraft,
  toDraft
} from "../permissions/rosterEditor";

type BasePermissionsTabProps = {
  baseId: string;
  baseName: string;
  onSaved: () => void;
  confirmAction: (message: string, options?: { title?: string; confirmLabel?: string; warning?: string; danger?: boolean; details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[] }) => Promise<boolean>;
};

export function BasePermissionsTab({ baseId, baseName, onSaved, confirmAction }: BasePermissionsTabProps) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saved, setSaved] = useState<DraftEntry[]>([]);
  const [draft, setDraft] = useState<DraftEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [statusKind, setStatusKind] = useState<"" | "ok" | "fail">("");
  const [candidateQuery, setCandidateQuery] = useState("");
  const [candidates, setCandidates] = useState<BasePermissionCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [addRank, setAddRank] = useState<BasePermissionRank>(ASSOCIATE_RANK);
  const [systemCustodian, setSystemCustodian] = useState<{ available: boolean; canCreate?: boolean; playerId?: string; name?: string; reason?: string }>({ available: false });
  // The server's explanation when the base has no permission_actor row, empty
  // otherwise. A string rather than a boolean so the banner and every disabled
  // control's tooltip read back the same sentence the API chose.
  const [unclaimed, setUnclaimed] = useState("");
  const [childAccess, setChildAccess] = useState<BaseChildAccessAudit>({ supported: false, inspected: 0, baselined: 0, anomalies: [] });
  const [selectedChildActors, setSelectedChildActors] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const result = await basesApi.permissions(baseId);
      const entries = toDraft(result.entries || []);
      setSaved(entries);
      setDraft(entries);
      // Only an explicit false locks the tab down. An API that predates the
      // flag omits it, and reading that as unclaimed would disable editing on
      // every base it serves.
      setUnclaimed(result.claimed === false
        ? result.unclaimedReason || "This base is not claimed, so its permissions cannot be edited."
        : "");
      setSystemCustodian(result.systemCustodian || { available: false, reason: "System custodian detection is unavailable." });
      setChildAccess(result.childAccess || { supported: false, inspected: 0, baselined: 0, anomalies: [], reason: "Child access auditing is unavailable." });
      setSelectedChildActors(new Set());
    } catch (error) {
      setLoadError(errorText(error));
    } finally {
      setLoading(false);
    }
  }, [baseId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!status || statusKind !== "ok") return undefined;
    // Keep this aligned with .inline-task-result.result-ok's 10.4s animation.
    // CSS opacity does not release layout space, so retire successful results
    // from React state when their visual lifetime ends. The animation handler
    // below normally wins; this timer also covers reduced-motion/missed events.
    const retire = window.setTimeout(() => {
      setStatus("");
      setStatusKind("");
    }, 10_400);
    return () => window.clearTimeout(retire);
  }, [status, statusKind]);

  const dirty = !sameRoster(saved, draft);
  const owner = draft.find((entry) => entry.rank === OWNER_RANK);

  // Promoting to Owner demotes whoever currently holds it, in the same local
  // edit. The server enforces the one-owner rule too, but doing it here means
  // the invariant can never be broken on screen -- there is no intermediate
  // state showing two Owners for the user to try to save. If the incumbent is
  // the system custodian, it is removed rather than demoted -- see
  // demoteOtherOwners.
  function changeRank(playerId: string, nextRank: BasePermissionRank) {
    setDraft((current) => {
      const promoted = current.map((entry) => entry.playerId === playerId ? { ...entry, rank: nextRank } : entry);
      return nextRank === OWNER_RANK
        ? demoteOtherOwners(promoted, playerId, systemCustodian.available ? systemCustodian.playerId : undefined)
        : promoted;
    });
  }

  function removeEntry(playerId: string) {
    setDraft((current) => current.filter((entry) => entry.playerId !== playerId));
  }

  function addCandidate(candidate: BasePermissionCandidate) {
    setDraft((current) => {
      if (current.some((entry) => entry.playerId === candidate.playerId)) return current;
      // No label: the rank is one this editor picked, so RANK_LABELS covers it.
      const next = [...current, { playerId: candidate.playerId, name: candidate.name, rank: addRank, canonical: true, label: "" }];
      // Adding straight to Owner has to demote (or remove) the incumbent for
      // the same reason changeRank does.
      return addRank === OWNER_RANK
        ? demoteOtherOwners(next, candidate.playerId, systemCustodian.available ? systemCustodian.playerId : undefined)
        : next;
    });
    // Adding completes the search interaction. Reset it instead of leaving a
    // stale query and result list sitting beneath the newly-added roster row.
    setCandidateQuery("");
    setCandidates([]);
    setSearched(false);
  }

  // Explicit submit rather than search-as-you-type: this queries the server, and
  // a debounced field would fire a request per keystroke.
  async function submitCandidateSearch() {
    setSearching(true);
    try {
      const result = await basesApi.permissionCandidates(candidateQuery);
      setCandidates(result.rows || []);
      setSearched(true);
    } catch (error) {
      setStatus(errorText(error));
      setStatusKind("fail");
    } finally {
      setSearching(false);
    }
  }

  function clearCandidateSearch() {
    setCandidateQuery("");
    setCandidates([]);
    setSearched(false);
  }

  async function save() {
    if (!owner) return;
    setSaving(true);
    setStatus("");
    setStatusKind("");
    try {
      const response = await basesApi.setPermissions(baseId, draft.map((entry) => ({ playerId: entry.playerId, rank: entry.rank })));
      setSaved(draft);
      setStatus(response.result?.message || "Permissions were updated.");
      setStatusKind("ok");
      onSaved();
    } catch (error) {
      setStatus(errorText(error));
      setStatusKind("fail");
    } finally {
      setSaving(false);
    }
  }

  async function transferToSystemCustodian() {
    if ((!systemCustodian.available && !systemCustodian.canCreate) || !systemCustodian.playerId) return;
    const custodianName = systemCustodian.name || "System";
    const confirmed = await confirmAction(
      `Transfer this base to the reserved ${custodianName} identity? Existing access entries will be preserved and the current Owner will become a Co-Owner.`,
      {
        title: `Transfer to ${custodianName} Custodian`,
        confirmLabel: "Transfer Ownership",
        warning: "This is an administrative parking owner. Verify building access in-game after the transfer before using it broadly.",
        details: [
          { label: "Base", value: baseName },
          { label: "New Owner", value: `${custodianName} (System Custodian)`, tone: "accent" }
        ]
      }
    );
    if (!confirmed) return;
    setSaving(true);
    setStatus("");
    setStatusKind("");
    try {
      const response = await basesApi.transferToSystemCustodian(baseId);
      setStatus(response.result?.message || `Ownership was transferred to the ${custodianName} system custodian.`);
      setStatusKind("ok");
      await load();
      onSaved();
    } catch (error) {
      setStatus(errorText(error));
      setStatusKind("fail");
    } finally {
      setSaving(false);
    }
  }

  async function resetSelectedChildAccess() {
    const selected = childAccess.anomalies.filter((row) => selectedChildActors.has(row.actorId));
    if (!selected.length) return;
    const confirmed = await confirmAction(
      `Reset access on ${selected.length} unusual ${selected.length === 1 ? "door or device" : "doors or devices"}?`,
      {
        title: "Reset Child Access",
        confirmLabel: "Reset Access",
        warning: "Only the selected objects will be changed. Any intentional custom access setting on them will be replaced with the detected server standard.",
        details: [
          { label: "Base", value: baseName },
          { label: "Selected", value: String(selected.length), tone: "accent" }
        ]
      }
    );
    if (!confirmed) return;
    setSaving(true);
    setStatus("");
    setStatusKind("");
    try {
      const response = await basesApi.resetChildAccess(baseId, selected.map((row) => row.actorId));
      setStatus(response.result?.message || "Child access settings were reset.");
      setStatusKind("ok");
      await load();
      onSaved();
    } catch (error) {
      setStatus(errorText(error));
      setStatusKind("fail");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="muted" role="status">Loading permissions…</p>;
  }
  if (loadError) {
    return <p className="bases-permissions-error" role="alert">
      {loadError} <button onClick={() => void load()}>Retry</button>
    </p>;
  }

  const alreadyOnRoster = new Set(draft.map((entry) => entry.playerId));
  // The roster holds every entry except the one the hero card is showing --
  // keyed on that entry's id, not on "rank is not Owner". A base whose rows the
  // game wrote directly can carry a second rank-1 row (permission_set_player_rank
  // is a plain upsert), and filtering by rank would drop it from the screen while
  // leaving it in the draft that Save submits. Keeping it as a row makes it
  // visible, removable, and fixable: its "Own" segment demotes the incumbent.
  const nonOwners = sortDraft(draft.filter((entry) => entry.playerId !== owner?.playerId));
  const coOwnerCount = nonOwners.filter((entry) => entry.rank === CO_OWNER_RANK).length;
  const associateCount = nonOwners.filter((entry) => entry.rank === ASSOCIATE_RANK).length;
  // Anything the game stored outside 1-3, plus any duplicate Owner row. Counted
  // separately rather than folded into the associate tally, which would state
  // something false about a rank nobody chose.
  const otherRankCount = nonOwners.length - coOwnerCount - associateCount;
  const shareBreakdown = formatShareBreakdown(coOwnerCount, associateCount, otherRankCount);
  const ownerIsCustodian = Boolean(systemCustodian.available && owner && owner.playerId === systemCustodian.playerId);

  return (
    <div className="bases-permissions" onClick={(event) => event.stopPropagation()}>
      <div className="bases-permissions-content">
        <div className="bases-permissions-intro">
          <p className="action-help-note">
            Exactly one Owner. Promoting a player demotes the current Owner to Co-Owner. Changes apply to the running map immediately. Transferring to the system custodian parks ownership on a reserved identity and keeps the roster intact.
          </p>
          <OwnerHeroCard
            owner={owner}
            isCustodian={ownerIsCustodian}
            systemCustodian={systemCustodian}
            saving={saving}
            dirty={dirty}
            unclaimed={unclaimed}
            onTransfer={() => void transferToSystemCustodian()}
          />
        </div>

        <div className="bases-permissions-toolbar">
          <div className="bases-permissions-add">
            <div className="action-row bases-permissions-search-row">
              <input
                value={candidateQuery}
                placeholder="Search a player to add"
                disabled={saving}
                onChange={(event) => setCandidateQuery(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") void submitCandidateSearch(); }}
              />
              <button disabled={searching || saving} onClick={() => void submitCandidateSearch()}>Search</button>
              <button disabled={!candidateQuery && !searched} onClick={clearCandidateSearch}>Clear</button>
              <label className="compact-select">
                Add as
                <select value={String(addRank)} disabled={saving} onChange={(event) => setAddRank(Number(event.target.value) as BasePermissionRank)}>
                  {RANK_OPTIONS.map((rank) => <option key={rank} value={rank}>{RANK_LABELS[rank]}</option>)}
                </select>
              </label>
            </div>
            {searched && !candidates.length && <p className="muted">No players matched that search.</p>}
            {candidates.length > 0 && <ul className="bases-permissions-candidates">
              {candidates.map((candidate) => (
                <li key={candidate.playerId}>
                  <span>{candidate.name}</span>
                  <button
                    className="icon-toggle-button"
                    disabled={alreadyOnRoster.has(candidate.playerId) || saving || Boolean(unclaimed)}
                    title={unclaimed || (alreadyOnRoster.has(candidate.playerId) ? "Already on this base" : `Add ${candidate.name} as ${RANK_LABELS[addRank]}`)}
                    aria-label={`Add ${candidate.name}`}
                    onClick={() => addCandidate(candidate)}
                  ><Plus size={15} /></button>
                </li>
              ))}
            </ul>}
          </div>

          <div className="bases-permissions-actions">
            <span className="muted">{dirty ? "Unsaved changes" : ""}</span>
            <button disabled={!dirty || saving} onClick={() => setDraft(saved)}>Revert</button>
            <button
              className="update-action"
              disabled={!dirty || !owner || saving || Boolean(unclaimed)}
              title={unclaimed || `Save permissions for ${baseName}`}
              onClick={() => void save()}
            >{saving ? "Saving…" : "Save changes"}</button>
          </div>
        </div>

        {/* Do not reserve an empty message area. Warnings and results appear
            only when they have useful information, matching the compact action
            layouts elsewhere in the console. */}
        {(dirty || !owner || unclaimed || status) && <div className="bases-permissions-banner-slot">
          {dirty && <p className="confirm-modal-warning bases-permissions-warning" role="status">
            Saving writes to the live database and notifies the running map server. An online player may need to reopen the base's panel to see the change.
          </p>}
          {unclaimed && <p className="bases-permissions-error" role="alert">{unclaimed}</p>}
          {/* Suppressed on an unclaimed base: it has no Owner either, but
              "set one before saving" describes an action that cannot be
              completed there and would bury the reason that can. */}
          {!owner && !unclaimed && <p className="bases-permissions-error" role="alert">
            This base has no Owner. Set one before saving.
          </p>}
          {status && <p
            className={`inline-task-result${statusKind ? ` result-${statusKind}` : ""}`}
            role={statusKind === "fail" ? "alert" : "status"}
            onAnimationEnd={() => {
              if (statusKind !== "ok") return;
              setStatus("");
              setStatusKind("");
            }}
          >
            <strong>{status}</strong>
          </p>}
        </div>}

        <div className="bases-permissions-section-head">
          <span className="bases-permissions-section-title">Shared with · {nonOwners.length}</span>
          {shareBreakdown && <span className="bases-permissions-section-meta">{shareBreakdown}</span>}
        </div>

        <div className="bases-permissions-roster">
          {nonOwners.map((entry) => (
            <div className="bases-permissions-row" key={entry.playerId}>
              <EntryName
                entry={entry}
                className="bases-permissions-name"
                isSystemCustodian={systemCustodian.available && entry.playerId === systemCustodian.playerId}
              />
              <RankSegments
                entry={entry}
                scopeId={baseId}
                disabled={saving || Boolean(unclaimed)}
                onChange={(rank) => changeRank(entry.playerId, rank)}
              />
              <button
                className="icon-toggle-button bases-permissions-remove"
                disabled={saving || Boolean(unclaimed)}
                title={unclaimed || `Remove ${entry.name || entry.playerId}`}
                aria-label={`Remove ${entry.name || entry.playerId}`}
                onClick={() => removeEntry(entry.playerId)}
              ><Trash2 size={15} /></button>
            </div>
          ))}
          {!nonOwners.length && <p className="muted">This base is not shared with anyone else.</p>}
        </div>

        <div className="bases-child-access-head">
          <div>
            <span className="bases-permissions-section-title">Child Access{childAccess.supported ? ` · ${childAccess.anomalies.length} Unusual` : ""}</span>
            <p className="muted">Checks doors and devices without changing intentional custom settings automatically.</p>
          </div>
          {childAccess.supported && childAccess.anomalies.length > 0 && <div className="bases-child-access-actions">
            <button
              disabled={saving}
              onClick={() => setSelectedChildActors(selectedChildActors.size === childAccess.anomalies.length
                ? new Set()
                : new Set(childAccess.anomalies.map((row) => row.actorId)))}
            >{selectedChildActors.size === childAccess.anomalies.length ? "Clear" : "Select All"}</button>
            <button className="warning" disabled={saving || selectedChildActors.size === 0} onClick={() => void resetSelectedChildAccess()}>
              {saving ? "Resetting…" : "Reset Selected"}
            </button>
          </div>}
        </div>
        {!childAccess.supported && <p className="muted">{childAccess.reason || "Child access auditing is unavailable for this database."}</p>}
        {childAccess.supported && childAccess.anomalies.length === 0 && <p className="bases-child-access-clean">No unusual child access settings were detected across {childAccess.inspected} checked object{childAccess.inspected === 1 ? "" : "s"}.</p>}
        {childAccess.supported && childAccess.anomalies.length > 0 && <div className="bases-child-access-list">
          {childAccess.anomalies.map((row) => <label className="bases-child-access-row" key={row.actorId}>
            <input
              type="checkbox"
              checked={selectedChildActors.has(row.actorId)}
              disabled={saving}
              onChange={(event) => setSelectedChildActors((current) => {
                const next = new Set(current);
                if (event.target.checked) next.add(row.actorId); else next.delete(row.actorId);
                return next;
              })}
            />
            <span className="bases-child-access-name"><strong>{row.name}</strong><em>{row.kind}</em></span>
            <span className="bases-child-access-level">Access {row.currentAccess} <span aria-hidden="true">→</span> Standard {row.expectedAccess}</span>
          </label>)}
        </div>}
      </div>
    </div>
  );
}
