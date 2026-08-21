import { Component, Suspense, type ReactNode } from "react";

type LazyTabBoundaryProps = { children: ReactNode; label?: string };
type LazyTabErrorBoundaryState = { failed: boolean };

// A lazy-loaded tab's dynamic import() rejects outright -- it never resolves
// to a component -- when the console was updated since this page loaded and
// the chunk hash this bundle asks for no longer exists on the server. React's
// Suspense only handles the pending state; an unhandled import rejection
// otherwise crashes the whole app to a blank screen, and the only way out a
// user finds is a hard refresh. Catch it here and offer a normal reload
// instead, which is enough on its own once the server stops mislabeling the
// SPA fallback as an immutable asset (see console/api/src/http/staticFiles.js).
class LazyTabErrorBoundary extends Component<LazyTabBoundaryProps, LazyTabErrorBoundaryState> {
  state: LazyTabErrorBoundaryState = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(`Failed to load section: ${this.props.label || "section"}`, error);
  }

  render() {
    if (this.state.failed) {
      return <section className="panel loading-panel tab-loading-panel">
        <strong>Could not load this section.</strong>
        <p className="muted">The console was updated since this page was loaded. Refresh to load the current version.</p>
        <button onClick={() => window.location.reload()}>Refresh Now</button>
      </section>;
    }
    return this.props.children;
  }
}

export function LazyTabBoundary({ children, label = "Loading Section" }: LazyTabBoundaryProps) {
  return <LazyTabErrorBoundary label={label}>
    <Suspense fallback={<section className="panel loading-panel tab-loading-panel"><span className="spinner" aria-hidden="true" /><strong className="loading-dots">{label}</strong></section>}>
      {children}
    </Suspense>
  </LazyTabErrorBoundary>;
}
