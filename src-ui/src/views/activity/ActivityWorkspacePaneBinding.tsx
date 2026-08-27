import { createContext, type ReactNode, useContext } from 'react';

/**
 * What the built-in Activity renderer needs that a Pane host cannot supply.
 *
 * Same seam as Home's (`HomeWorkspacePaneBinding`): a descriptor is inert
 * data, so a renderer's live inputs reach it through context owned by the
 * placement that has them, read by the renderer that needs them. For
 * Activity those inputs are the API base its session queries and mutations
 * are addressed to, and — only for the standalone route placement — the
 * deep-linked session id (`/activity/:sessionId`). A routed selection is
 * presentation state of that placement, never pane identity, which is why it
 * lives here and not on the occurrence.
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
  /** Deep-linked session id of the standalone route placement, if any. */
  sessionId?: string;
  /** Routed focus target, forwarded to the sessions surface untouched. */
  focusHint?: 'evidence';
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
