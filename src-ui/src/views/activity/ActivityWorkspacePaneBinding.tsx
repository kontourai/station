import { createContext, type ReactNode, useContext } from 'react';

/**
 * What the built-in Activity renderer needs that a Pane host cannot supply.
 *
 * Same seam as Home's (`HomeWorkspacePaneBinding`): a descriptor is inert
 * data, so a renderer's live inputs reach it through context owned by the
 * placement that has them, read by the renderer that needs them. For
 * Activity those inputs are the API base its session queries and mutations
 * are addressed to, and the deep-linked intent. Since #928 retired the
 * standalone `/activity` route, the region placement is the only one that
 * carries that intent — it receives it as a region-model surface intent
 * (`ActivityRegionShell`), which is also why the repeat-activation fields
 * below are its alone. The Developer archive embed (`ArchiveTab`) supplies
 * the API base and nothing else. A routed selection is presentation state of
 * a placement, never pane identity, which is why it lives here and not on
 * the occurrence.
 *
 * Unlike Home's, the context lives in its own module rather than beside the
 * renderer: the ambient dock host must provide this binding for a docked
 * Activity occupant WITHOUT statically importing the renderer module, whose
 * import graph is the whole sessions surface. Keeping the context here keeps
 * that surface behind the dock host's lazy boundary. Consuming it is still a
 * deliberate act — it is exported for the Activity placements, not as an
 * app-wide context.
 */
export interface ActivityWorkspacePaneBinding {
  apiBase: string;
  /** Deep-linked session id of whichever placement supplied it, if any. */
  sessionId?: string;
  /** Routed focus target, forwarded to the sessions surface untouched. */
  focusHint?: 'evidence';
  /**
   * Monotonic activation identity, including repeated intents for the same
   * session. Supplied by the region placement, which is the only one that
   * delivers an intent at all.
   */
  intentToken?: number;
  /** Region placement only, for the same reason as `intentToken`. */
  onFocusConsumed?: () => void;
}

const ActivityWorkspacePaneContext =
  createContext<ActivityWorkspacePaneBinding | null>(null);

export function ActivityWorkspacePaneBindingProvider({
  binding,
  children,
}: {
  binding: ActivityWorkspacePaneBinding;
  children: ReactNode;
}) {
  return (
    <ActivityWorkspacePaneContext.Provider value={binding}>
      {children}
    </ActivityWorkspacePaneContext.Provider>
  );
}

export function useActivityWorkspacePaneBinding(): ActivityWorkspacePaneBinding | null {
  return useContext(ActivityWorkspacePaneContext);
}
