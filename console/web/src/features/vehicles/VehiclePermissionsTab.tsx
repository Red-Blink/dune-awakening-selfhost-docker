import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  vehiclesApi,
  type VehiclePermissionCandidate,
  type VehiclePermissionRank
} from "../../api/vehicles";
import {
  ASSOCIATE_RANK,
  CO_OWNER_RANK,
  EntryName,
  OWNER_RANK,
  RANK_OPTIONS,
  RANK_LABELS,
  RankSegments,
  type DraftEntry,
  errorText,
  formatShareBreakdown,
  sameRoster,
  sortDraft,
  toDraft
} from "../permissions/rosterEditor";

type VehiclePermissionsTabProps = {
  vehicleId: string;
  vehicleName: string;
  onSaved: () => void;
};

export function VehiclePermissionsTab({ vehicleId, vehicleName, onSaved }: VehiclePermissionsTabProps) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saved, setSaved] = useState<DraftEntry[]>([]);
  const [draft, setDraft] = useState<DraftEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [statusKind, setStatusKind] = useState<"" | "ok" | "fail">("");
  const [candidateQuery, setCandidateQuery] = useState("");
  const [candidates, setCandidates] = useState<VehiclePermissionCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [addRank, setAddRank] = useState<VehiclePermissionRank>(ASSOCIATE_RANK);
  // The server's explanation when the vehicle has no permission_actor row,
  // empty otherwise. A string rather than a boolean so the banner and every
  // disabled control's tooltip read back the same sentence the API chose.
  const [unclaimed, setUnclaimed] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const result = await vehiclesApi.permissions(vehicleId);
      const entries = toDraft(result.entries || []);
      setSaved(entries);
      setDraft(entries);
      // Only an explicit false locks the tab down. An API that predates the
      // flag omits it, and reading that as unclaimed would disable editing on
      // every vehicle it serves.
      setUnclaimed(result.claimed === false
        ? result.unclaimedReason || "This vehicle is not claimed, so its permissions cannot be edited."
        : "");
    } catch (error) {
      setLoadError(errorText(error));
    } finally {
      setLoading(false);
    }
  }, [vehicleId]);

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
  // state showing two Owners for the user to try to save.
  function changeRank(playerId: string, nextRank: VehiclePermissionRank) {
    setDraft((current) => current.map((entry) => {
      if (entry.playerId === playerId) return { ...entry, rank: nextRank };
      if (nextRank === OWNER_RANK && entry.rank === OWNER_RANK) return { ...entry, rank: CO_OWNER_RANK };
      return entry;
    }));
  }

  function removeEntry(playerId: string) {
    setDraft((current) => current.filter((entry) => entry.playerId !== playerId));
  }

  function addCandidate(candidate: VehiclePermissionCandidate) {
    setDraft((current) => {
      if (current.some((entry) => entry.playerId === candidate.playerId)) return current;
      // No label: the rank is one this editor picked, so RANK_LABELS covers it.
      const next = [...current, { playerId: candidate.playerId, name: candidate.name, rank: addRank, canonical: true, label: "" }];
      // Adding straight to Owner has to demote the incumbent for the same
      // reason changeRank does.
      if (addRank !== OWNER_RANK) return next;
      return next.map((entry) => entry.playerId === candidate.playerId || entry.rank !== OWNER_RANK
        ? entry
        : { ...entry, rank: CO_OWNER_RANK });
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
      const result = await vehiclesApi.permissionCandidates(candidateQuery);
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
      const response = await vehiclesApi.setPermissions(vehicleId, draft.map((entry) => ({ playerId: entry.playerId, rank: entry.rank })));
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

  if (loading) {
    return <p className="muted" role="status">Loading permissions…</p>;
  }
  if (loadError) {
    return <p className="vehicles-permissions-error" role="alert">
      {loadError} <button onClick={() => void load()}>Retry</button>
    </p>;
  }

  const alreadyOnRoster = new Set(draft.map((entry) => entry.playerId));
  // The roster holds every entry except the one the Owner card is showing --
  // keyed on that entry's id, not on "rank is not Owner". A vehicle whose rows
  // the game wrote directly can carry a second rank-1 row (permission_set_
  // player_rank is a plain upsert), and filtering by rank would drop it from
  // the screen while leaving it in the draft that Save submits. Keeping it as
  // a row makes it visible, removable, and fixable: its "Own" segment demotes
  // the incumbent.
  const nonOwners = sortDraft(draft.filter((entry) => entry.playerId !== owner?.playerId));
  const coOwnerCount = nonOwners.filter((entry) => entry.rank === CO_OWNER_RANK).length;
  const associateCount = nonOwners.filter((entry) => entry.rank === ASSOCIATE_RANK).length;
  // Anything the game stored outside 1-3, plus any duplicate Owner row. Counted
  // separately rather than folded into the associate tally, which would state
  // something false about a rank nobody chose.
  const otherRankCount = nonOwners.length - coOwnerCount - associateCount;
  const shareBreakdown = formatShareBreakdown(coOwnerCount, associateCount, otherRankCount);

  return (
    <div className="vehicles-permissions" onClick={(event) => event.stopPropagation()}>
      <div className="vehicles-permissions-content">
        <div className="vehicles-permissions-intro">
          <p className="action-help-note">
            Exactly one Owner. Promoting a player demotes the current Owner to Co-Owner. Changes apply to the running map immediately.
          </p>
          <div className={`vehicles-permissions-owner-card${owner ? "" : " vehicles-permissions-owner-card-empty"}`}>
            <div className="vehicles-permissions-owner-identity">
              <span className="vehicles-permissions-owner-eyebrow">Owner</span>
              {owner
                ? <EntryName entry={owner} className="vehicles-permissions-owner-name" />
                : <span className="vehicles-permissions-owner-name vehicles-permissions-owner-none">No Owner set</span>}
            </div>
          </div>
        </div>

        <div className="vehicles-permissions-toolbar">
          <div className="vehicles-permissions-add">
            <div className="action-row vehicles-permissions-search-row">
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
                <select value={String(addRank)} disabled={saving} onChange={(event) => setAddRank(Number(event.target.value) as VehiclePermissionRank)}>
                  {RANK_OPTIONS.map((rank) => <option key={rank} value={rank}>{RANK_LABELS[rank]}</option>)}
                </select>
              </label>
            </div>
            {searched && !candidates.length && <p className="muted">No players matched that search.</p>}
            {candidates.length > 0 && <ul className="vehicles-permissions-candidates">
              {candidates.map((candidate) => (
                <li key={candidate.playerId}>
                  <span>{candidate.name}</span>
                  <button
                    className="icon-toggle-button"
                    disabled={alreadyOnRoster.has(candidate.playerId) || saving || Boolean(unclaimed)}
                    title={unclaimed || (alreadyOnRoster.has(candidate.playerId) ? "Already shared with this vehicle" : `Add ${candidate.name} as ${RANK_LABELS[addRank]}`)}
                    aria-label={`Add ${candidate.name}`}
                    onClick={() => addCandidate(candidate)}
                  ><Plus size={15} /></button>
                </li>
              ))}
            </ul>}
          </div>

          <div className="vehicles-permissions-actions">
            <span className="muted">{dirty ? "Unsaved changes" : ""}</span>
            <button disabled={!dirty || saving} onClick={() => setDraft(saved)}>Revert</button>
            <button
              className="update-action"
              disabled={!dirty || !owner || saving || Boolean(unclaimed)}
              title={unclaimed || `Save permissions for ${vehicleName}`}
              onClick={() => void save()}
            >{saving ? "Saving…" : "Save changes"}</button>
          </div>
        </div>

        {/* Do not reserve an empty message area. Warnings and results appear
            only when they have useful information, matching the compact action
            layouts elsewhere in the console. */}
        {(dirty || !owner || unclaimed || status) && <div className="vehicles-permissions-banner-slot">
          {dirty && <p className="confirm-modal-warning vehicles-permissions-warning" role="status">
            Saving writes to the live database and notifies the running map server. An online player may need to reopen the vehicle's interaction panel to see the change.
          </p>}
          {unclaimed && <p className="vehicles-permissions-error" role="alert">{unclaimed}</p>}
          {/* Suppressed on an unclaimed vehicle: it has no Owner either, but
              "set one before saving" describes an action that cannot be
              completed there and would bury the reason that can. */}
          {!owner && !unclaimed && <p className="vehicles-permissions-error" role="alert">
            This vehicle has no Owner. Set one before saving.
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

        <div className="vehicles-permissions-section-head">
          <span className="vehicles-permissions-section-title">Shared with · {nonOwners.length}</span>
          {shareBreakdown && <span className="vehicles-permissions-section-meta">{shareBreakdown}</span>}
        </div>

        <div className="vehicles-permissions-roster">
          {nonOwners.map((entry) => (
            <div className="vehicles-permissions-row" key={entry.playerId}>
              <EntryName
                entry={entry}
                className="vehicles-permissions-name"
              />
              <RankSegments
                entry={entry}
                scopeId={vehicleId}
                disabled={saving || Boolean(unclaimed)}
                onChange={(rank) => changeRank(entry.playerId, rank)}
                groupClassName="vehicles-rank-segments"
                segmentClassName="vehicles-rank-segment"
              />
              <button
                className="icon-toggle-button vehicles-permissions-remove"
                disabled={saving || Boolean(unclaimed)}
                title={unclaimed || `Remove ${entry.name || entry.playerId}`}
                aria-label={`Remove ${entry.name || entry.playerId}`}
                onClick={() => removeEntry(entry.playerId)}
              ><Trash2 size={15} /></button>
            </div>
          ))}
          {!nonOwners.length && <p className="muted">This vehicle is not shared with anyone else.</p>}
        </div>
      </div>
    </div>
  );
}
