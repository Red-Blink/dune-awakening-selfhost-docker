import { Component, Suspense, type ReactNode } from "react";

const CHUNK_RELOAD_KEY = "dune-console:lazy-chunk-reload-at";
const CHUNK_RELOAD_COOLDOWN_MS = 60_000;

type ReloadStorage = Pick<Storage, "getItem" | "setItem">;
type LazyTabBoundaryProps = {
  children: ReactNode;
  label?: string;
  // Injection points keep reload/cooldown behavior testable without replacing
  // jsdom's non-configurable Location object. App callers use the defaults.
  reload?: () => void;
  storage?: ReloadStorage | null;
  now?: () => number;
};
type LazyTabErrorBoundaryState = { failed: boolean; chunkFailure: boolean };

export function isLazyChunkLoadError(error: unknown) {
  const text = `${error instanceof Error ? error.name : ""} ${error instanceof Error ? error.message : String(error || "")}`;
  return /ChunkLoadError|Loading chunk .* failed|dynamically imported module|Importing a module script failed|Failed to load module script|Unable to preload CSS/i.test(text);
}

function browserStorage(): ReloadStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    // Privacy/security settings can deny storage access. Without a durable
    // cooldown marker, stay on the manual fallback instead of risking a loop.
    return null;
  }
}

function browserReload() {
  window.location.reload();
}

// A lazy-loaded tab's dynamic import() rejects outright -- it never resolves
// to a component -- when the console was updated since this page loaded and
// the chunk hash this bundle asks for no longer exists on the server. Suspense
// only handles the pending state. Recognized chunk/preload failures get one
// automatic normal reload per browser tab per minute; a recurring failure or
// an ordinary render bug stays on a manual recovery panel instead of looping.
class LazyTabErrorBoundary extends Component<LazyTabBoundaryProps, LazyTabErrorBoundaryState> {
  state: LazyTabErrorBoundaryState = { failed: false, chunkFailure: false };

  static getDerivedStateFromError(error: unknown): LazyTabErrorBoundaryState {
    return { failed: true, chunkFailure: isLazyChunkLoadError(error) };
  }

  componentDidCatch(error: unknown) {
    console.error(`Failed to load section: ${this.props.label || "section"}`, error);
    if (!isLazyChunkLoadError(error)) return;

    const storage = this.props.storage === undefined ? browserStorage() : this.props.storage;
    if (!storage) return;
    const now = this.props.now?.() ?? Date.now();
    let lastAttempt = 0;
    try {
      lastAttempt = Number(storage.getItem(CHUNK_RELOAD_KEY) || 0);
    } catch {
      return;
    }
    const elapsed = now - lastAttempt;
    if (Number.isFinite(lastAttempt) && lastAttempt > 0 && elapsed >= 0 && elapsed < CHUNK_RELOAD_COOLDOWN_MS) return;

    try {
      // Write before reload. If the current bundle is genuinely broken, the
      // next page load sees the marker and cannot enter a refresh loop.
      storage.setItem(CHUNK_RELOAD_KEY, String(now));
    } catch {
      return;
    }
    (this.props.reload || browserReload)();
  }

  render() {
    if (this.state.failed) {
      return <section className="panel loading-panel tab-loading-panel" role="alert">
        <strong>Could not load this section.</strong>
        <p className="muted">{this.state.chunkFailure
          ? "The console may have been updated since this page was loaded. Refresh to load the current version."
          : "This section encountered an unexpected error. Refresh and try again."}</p>
        <button onClick={this.props.reload || browserReload}>Refresh Now</button>
      </section>;
    }
    return this.props.children;
  }
}

export function LazyTabBoundary({ children, label = "Loading Section", reload, storage, now }: LazyTabBoundaryProps) {
  return <LazyTabErrorBoundary label={label} reload={reload} storage={storage} now={now}>
    <Suspense fallback={<section className="panel loading-panel tab-loading-panel"><span className="spinner" aria-hidden="true" /><strong className="loading-dots">{label}</strong></section>}>
      {children}
    </Suspense>
  </LazyTabErrorBoundary>;
}

export const lazyTabBoundaryInternals = Object.freeze({ CHUNK_RELOAD_KEY, CHUNK_RELOAD_COOLDOWN_MS });
