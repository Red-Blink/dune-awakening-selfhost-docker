import { useCallback, useEffect, useState } from "react";
import { basesApi, type PendingChildAccess, type PendingRefills } from "../api/bases";

// The queue is a small file read on the API side, and it changes without the
// operator doing anything: any restart -- from this console, the scheduler, or
// the CLI -- lets the background flush drain it.
const PENDING_REFILL_POLL_MS = 10_000;

// Shared by the Bases banner, the Maps panel badges, and the battlegroup
// buttons so every surface reports the same counts from one endpoint.
export function usePendingRefills(enabled = true) {
  const [pending, setPending] = useState<PendingRefills | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await basesApi.pendingRefills();
      setPending(next);
      return next;
    } catch {
      // Informational only: a failed poll must never surface an error banner.
      return null;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const tick = () => { if (!cancelled) void refresh(); };
    tick();
    const intervalId = window.setInterval(tick, PENDING_REFILL_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [enabled, refresh]);

  return { pending, refresh };
}

// Mirrors usePendingRefills above for the water refill queue -- a separate
// hook rather than a parameterized fetcher, matching the rest of this
// codebase's per-resource duplication (WATER_TYPES vs GENERATOR_TYPES,
// autoRefillWater.js vs autoRefill.js) over a shared abstraction.
export function usePendingWaterRefills(enabled = true) {
  const [pending, setPending] = useState<PendingRefills | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await basesApi.pendingWaterRefills();
      setPending(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const tick = () => { if (!cancelled) void refresh(); };
    tick();
    const intervalId = window.setInterval(tick, PENDING_REFILL_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [enabled, refresh]);

  return { pending, refresh };
}

// Mirrors usePendingRefills for the pending base-delete queue -- same
// per-resource duplication as the water hook above rather than a
// parameterized fetcher.
export function usePendingBaseDeletes(enabled = true) {
  const [pending, setPending] = useState<PendingRefills | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await basesApi.pendingDeletes();
      setPending(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const tick = () => { if (!cancelled) void refresh(); };
    tick();
    const intervalId = window.setInterval(tick, PENDING_REFILL_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [enabled, refresh]);

  return { pending, refresh };
}

// Mirrors usePendingBaseDeletes for the pending base-permission queue. Its
// entries carry a payload (which pieces, to which level), so this one is typed
// PendingChildAccess rather than PendingRefills.
export function usePendingChildAccess(enabled = true) {
  const [pending, setPending] = useState<PendingChildAccess | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await basesApi.pendingChildAccess();
      setPending(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const tick = () => { if (!cancelled) void refresh(); };
    tick();
    const intervalId = window.setInterval(tick, PENDING_REFILL_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [enabled, refresh]);

  return { pending, refresh };
}

export function pendingRefillCountForPartition(pending: PendingRefills | null, partitionId: number) {
  if (!pending || !partitionId) return 0;
  return pending.pending.filter((entry) => entry.partitionId === partitionId).length;
}

// Totals every partition belonging to one world_partition map, so a map whose
// only restart path is a per-partition respawn still shows what is waiting on it.
// Matches on partitionMap, not the queue entry's own map name -- those are
// different namespaces (see partitionRestartTargets in duneDb.js).
export function pendingRefillCountForMap(pending: PendingRefills | null, partitionMap: string) {
  const key = String(partitionMap || "").trim().toLowerCase();
  if (!pending || !key) return 0;
  return pending.byTarget
    .filter((group) => group.partitionMap.trim().toLowerCase() === key)
    .reduce((total, group) => total + group.count, 0);
}

// The permission queue counts pieces, not bases: one base with six queued
// pieces is six pending writes, and a restart applies all six. byTarget counts
// queued bases, so these three read the entries instead -- the count the
// operator sees must mean the same thing on every surface.
export function childAccessPieceCount(pending: PendingChildAccess | null) {
  if (!pending) return 0;
  return pending.pending.reduce((total, entry) => total + entry.updates.length, 0);
}

export function childAccessPieceCountForPartition(pending: PendingChildAccess | null, partitionId: number) {
  if (!pending || !partitionId) return 0;
  return pending.pending
    .filter((entry) => entry.partitionId === partitionId)
    .reduce((total, entry) => total + entry.updates.length, 0);
}

// Mirrors pendingRefillCountForMap's partitionMap matching, but resolves each
// entry's partition through byTarget first, since an entry only carries its own
// map name (a different namespace from partitionMap).
export function childAccessPieceCountForMap(pending: PendingChildAccess | null, partitionMap: string) {
  const key = String(partitionMap || "").trim().toLowerCase();
  if (!pending || !key) return 0;
  const partitions = new Set(pending.byTarget
    .filter((group) => group.partitionMap.trim().toLowerCase() === key)
    .map((group) => group.partitionId));
  return pending.pending
    .filter((entry) => partitions.has(entry.partitionId))
    .reduce((total, entry) => total + entry.updates.length, 0);
}

// One aggregate hook so a surface that offers a restart cannot accidentally
// poll three of the four queues -- which is exactly how the Server battlegroup
// note ended up showing fuel and water but never deletes or permissions.
export function usePendingQueues(enabled = true) {
  const fuel = usePendingRefills(enabled);
  const water = usePendingWaterRefills(enabled);
  const deletes = usePendingBaseDeletes(enabled);
  const permissions = usePendingChildAccess(enabled);
  return { fuel, water, deletes, permissions };
}
