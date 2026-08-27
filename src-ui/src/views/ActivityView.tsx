import {
  WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
  WORKSPACE_ACTIVITY_PANE_INSTANCE,
} from '@kontourai/station-contracts/workspace-activity-pane';
import { ErrorState } from '../components/state';
import { useConfig } from '../contexts/ConfigContext';
import { WorkspacePaneAwayState } from '../workspace-panes/WorkspacePaneAwayState';
import {
  isAmbientDockOccupant,
  useWorkspacePaneDockAction,
} from '../workspace-panes/WorkspacePaneDockContext';
import { selectClientWorkspacePaneRenderer } from '../workspace-panes/workspacePaneRendererSelection';
import { ActivityWorkspacePane } from './activity/ActivityWorkspacePane';
import { ActivityWorkspacePaneBindingProvider } from './activity/ActivityWorkspacePaneBinding';

/**
 * `/activity`, the standalone placement of the Activity Workspace Pane
 * (epic station#4142 M3, following M2's route-as-placement shape for `/`).
 *
 * A route is a placement, not an identity (`docs/design/pane-or-shell.md`):
 * this host mounts the pane renderer with the canonical occurrence directly
 * — no `WorkspacePaneHost`, because a standalone route placement has exactly
 * one code-determined occupant and no user-arrangeable document. The
 * built-in renders because `selectClientWorkspacePaneRenderer` admitted it
 * for this build's fixed Activity descriptor, not because this file names a
 * surface; mounting directly rather than through
 * `getBuiltinWorkspacePaneRenderer` only skips the registry LOOKUP (whose
 * component table statically reaches ~800kB of chunk), never the shared
 * authorization.
 *
 * The routed `sessionId` is presentation state of THIS placement — which row
 * the deep link selects — handed to the renderer through the binding
 * context, never smuggled onto the pane occurrence.
 */
export function ActivityView({
  apiBase,
  sessionId,
  focusHint,
}: {
  apiBase: string;
  sessionId?: string;
  focusHint?: 'evidence';
}) {
  const config = useConfig();
  const dock = useWorkspacePaneDockAction();
  const selection = selectClientWorkspacePaneRenderer(
    WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
    {
      mcpAppsEnabled: config?.mcpUiHost !== false,
      instance: WORKSPACE_ACTIVITY_PANE_INSTANCE,
    },
  );
  // While Activity's canonical occurrence occupies the ambient dock, this
  // route renders the away state instead of a second live copy of the pane
  // (station#4090 M5). Derived from the host's own published occupant state
  // through `isAmbientDockOccupant` — never a route-local flag — so choosing
  // another dock occupant clears this state without route-side bookkeeping.
  if (isAmbientDockOccupant(dock, WORKSPACE_ACTIVITY_PANE_INSTANCE)) {
    return (
      <WorkspacePaneAwayState
        paneName={WORKSPACE_ACTIVITY_PANE_DESCRIPTOR.name}
      />
    );
  }
  const builtinSelected =
    selection.state === 'selected' &&
    selection.candidate.source === 'primary' &&
    selection.candidate.renderer.kind === 'builtin-component';
  if (!builtinSelected) {
    // No fallback when selection refuses, deliberately (Home's stance):
    // rendering the surface anyway would make the selection decorative.
    return (
      <ErrorState
        title="Activity is unavailable"
        description="This build registers no renderer that Activity’s declaration admits."
      />
    );
  }
  return (
    <ActivityWorkspacePaneBindingProvider
      binding={{ apiBase, sessionId, focusHint }}
    >
      <ActivityWorkspacePane
        descriptor={WORKSPACE_ACTIVITY_PANE_DESCRIPTOR}
        instance={WORKSPACE_ACTIVITY_PANE_INSTANCE}
      />
    </ActivityWorkspacePaneBindingProvider>
  );
}
