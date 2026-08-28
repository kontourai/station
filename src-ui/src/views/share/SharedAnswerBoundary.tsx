import { Component, type ErrorInfo, type ReactNode, Suspense } from 'react';
import { SkeletonBlock } from '../../components/state';
import { reloadSharePage } from './share-token';

/**
 * Crash and chunk-load boundary for the shared-answer permalink page
 * (archive#1423).
 *
 * The share page is mounted ABOVE the app shell, so none of the app's own
 * boundaries sit between it and the root. Without this, a failed lazy-chunk
 * fetch (an interrupted network, a stale asset after a redeploy) and a throw
 * inside the page render as the same blank white document — and the two mean
 * opposite things to a recipient. "This link is broken" and "your connection
 * dropped, try again" are different messages, and an empty page makes an
 * honest one impossible.
 *
 * Deliberately NOT `RouteViewBoundary`: that belongs to the app shell's
 * routing (it takes a `routeKey` and resets on navigation), and this page has
 * no router, no navigation, and no shell. Reusing it would also pull shell
 * chrome into the standalone page's dependency graph.
 *
 * **Inline styles here, against the repo's CSS-class preference, and the
 * exception is the whole point.** This component must be in the ENTRY chunk
 * to catch the share page's own chunk failing to load — so a stylesheet
 * import here would put the share page's CSS in front of every operator on
 * first paint. Worse, the failure it exists to report is precisely the one
 * where that stylesheet may not have loaded either, so class-based markup
 * would render unstyled exactly when it matters. A handful of inline
 * declarations is the only styling that is guaranteed to be there.
 *
 * The Suspense fallback is non-null for the same reason a blank error page is
 * unacceptable: a null fallback on a slow chunk is another silent white page.
 */

const SHELL: React.CSSProperties = {
  maxWidth: '46rem',
  margin: '0 auto',
  padding: '2rem 1.5rem',
  fontFamily: 'system-ui, sans-serif',
  lineHeight: 1.5,
};

const NOTICE: React.CSSProperties = {
  padding: '1rem',
  border: '1px solid currentColor',
  borderRadius: '8px',
  opacity: 0.9,
};

class SharedAnswerErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Shared answer page failed:', error, info);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <main style={SHELL} aria-label="Shared answer">
        <section style={NOTICE} role="alert">
          <h2>This shared answer could not be displayed</h2>
          <p>
            Something went wrong loading this page. The share itself may be
            perfectly valid — nothing about the answer is being shown, because
            nothing was successfully read.
          </p>
          {/* `reloadSharePage`, never a bare `location.reload`. The
              page clears the token out of the address bar as soon as it has
              read it, so a plain reload would land on the missing-token
              state — a recovery button guaranteed to fail. */}
          <button type="button" onClick={reloadSharePage}>
            Reload
          </button>
        </section>
      </main>
    );
  }
}

export function SharedAnswerBoundary({ children }: { children: ReactNode }) {
  return (
    <SharedAnswerErrorBoundary>
      <Suspense
        fallback={
          <main style={SHELL} aria-label="Shared answer">
            <SkeletonBlock count={3} label="Loading the shared answer" />
          </main>
        }
      >
        {children}
      </Suspense>
    </SharedAnswerErrorBoundary>
  );
}
