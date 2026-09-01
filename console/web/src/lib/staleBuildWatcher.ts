import { useEffect } from "react";
import { fetchConsoleAuthState } from "../api/client";

const RELOAD_COOLDOWN_KEY = "dune-console:stale-build-reload-at";
const RELOAD_COOLDOWN_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 120_000;
// Returning to the tab is the moment a stale page is most likely to mislead --
// someone rebuilds, switches back, and reads old code as a failed change. The
// two-minute poll is right for an idle tab but far too slow for that loop, so a
// visible/focused tab re-checks immediately. Throttled so rapid tab switching
// cannot turn into a burst of requests.
const FOCUS_RECHECK_MIN_GAP_MS = 5_000;

type StaleBuildStorage = Pick<Storage, "getItem" | "setItem">;

export type StaleBuildWatcherOptions = {
  enabled?: boolean;
  intervalMs?: number;
  // Injection points keep this testable with fake timers, matching the
  // pattern LazyTabBoundary uses for the same reason.
  fetchVersion?: () => Promise<string | null>;
  reload?: () => void;
  storage?: StaleBuildStorage | null;
  now?: () => number;
};

async function defaultFetchVersion(): Promise<string | null> {
  const state = await fetchConsoleAuthState();
  const version = typeof state?.config?.version === "string" ? state.config.version.trim() : "";
  const buildId = typeof state?.config?.buildId === "string" ? state.config.buildId.trim() : "";
  if (!version && !buildId) return null;
  // Keep the release version in the identity so official upgrades still
  // trigger a reload even when they contain no frontend changes. The build
  // ID additionally catches rebuilt frontend assets within the same version.
  return `${version || "dev"}:${buildId || version}`;
}

function browserStorage(): StaleBuildStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function browserReload() {
  window.location.reload();
}

// Once loaded, a browser tab has no way to know the server's files changed
// underneath it -- there is no push, and nothing else in this app watches
// for a build change on an already-open, idle tab (LazyTabBoundary only
// reacts when a lazy chunk it tries to load is already gone, and the
// Updates panel's own reload flow only runs in the tab that triggered the
// update). This closes that gap: poll the running console version and
// reload automatically the first time it changes, so a tab left open
// during someone else's console update or a same-version rebuild recovers
// on its own instead of running stale code indefinitely.
export function useStaleBuildWatcher(options: StaleBuildWatcherOptions = {}) {
  const {
    enabled = true,
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
    fetchVersion = defaultFetchVersion,
    reload = browserReload,
    storage = browserStorage(),
    now = Date.now
  } = options;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let baselineVersion: string | null = null;
    let lastPollStartedAt = 0;

    async function poll() {
      lastPollStartedAt = now();
      const version = await fetchVersion().catch(() => null);
      if (cancelled || !version) return;
      if (baselineVersion === null) {
        baselineVersion = version;
        return;
      }
      if (version === baselineVersion) return;

      // Without a durable cooldown marker, don't risk an uncontrolled reload
      // loop against a flapping deploy -- same fail-closed choice
      // LazyTabBoundary makes when storage is unavailable.
      if (!storage) return;
      try {
        const lastAttempt = Number(storage.getItem(RELOAD_COOLDOWN_KEY) || 0);
        const elapsed = now() - lastAttempt;
        if (Number.isFinite(lastAttempt) && lastAttempt > 0 && elapsed >= 0 && elapsed < RELOAD_COOLDOWN_MS) return;
        storage.setItem(RELOAD_COOLDOWN_KEY, String(now()));
      } catch {
        return;
      }
      reload();
    }

    function recheckOnReturn() {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      if (now() - lastPollStartedAt < FOCUS_RECHECK_MIN_GAP_MS) return;
      void poll();
    }

    void poll();
    const id = window.setInterval(poll, intervalMs);
    document.addEventListener("visibilitychange", recheckOnReturn);
    window.addEventListener("focus", recheckOnReturn);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", recheckOnReturn);
      window.removeEventListener("focus", recheckOnReturn);
    };
  }, [enabled, intervalMs, fetchVersion, reload, storage, now]);
}

export const staleBuildWatcherInternals = Object.freeze({ RELOAD_COOLDOWN_KEY, RELOAD_COOLDOWN_MS, DEFAULT_POLL_INTERVAL_MS, FOCUS_RECHECK_MIN_GAP_MS });
