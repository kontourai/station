/**
 * Which surface the shell is still waiting on, derived from the one fact that
 * means it: `RouteViewBoundary`'s Suspense fallback is mounted. The fallback
 * renders if and only if the route outlet is suspended (its lazy chunk has not
 * arrived, or a view inside it suspended on data), so this is the suspension
 * itself rather than a timer or an optimistic flag set at click time.
 *
 * Measured on the audited build: clicking a sidebar row swaps the URL and
 * hides the previous route within one frame, then holds a generic skeleton for
 * ~1.4 s while the route chunk downloads. The nav row the user clicked showed
 * nothing at all for that window; this store is what lets it say so.
 *
 * The value is a DESTINATION ID from `APP_DESTINATION_REGISTRY`, not a pathname. The
 * sidebar already resolves the row it highlights through
 * `getDestinationForView`, so publishing the same id makes "the pending row" and
 * "the active row" two readings of one derivation — and a deep route
 * (`/registry/agents`, `/connections/providers/x`) marks its owning row,
 * which a pathname equality check silently never did.
 */
type Listener = () => void;

class RouteTransitionStore {
  private pendingSurfaceId: string | null = null;
  private listeners = new Set<Listener>();

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.pendingSurfaceId;

  /** Called from the suspended route outlet's fallback. */
  setPending(surfaceId: string) {
    if (this.pendingSurfaceId === surfaceId) return;
    this.pendingSurfaceId = surfaceId;
    this.notify();
  }

  /**
   * Called when a fallback stops representing `surfaceId`. Guarded on the id
   * it was published for: a second navigation while the first is still
   * pending can publish the newer surface before the older one releases, and
   * an unguarded clear would erase the newer route's pending state.
   */
  clearPending(surfaceId: string) {
    if (this.pendingSurfaceId !== surfaceId) return;
    this.pendingSurfaceId = null;
    this.notify();
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }
}

export const routeTransitionStore = new RouteTransitionStore();
