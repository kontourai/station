import { isCanonicalWorkspaceActivityPaneInstance } from '@kontourai/station-contracts/workspace-activity-pane';
import type { BuiltinWorkspacePaneProps } from '../../workspace-panes/builtinWorkspacePaneRegistry';
import { WorkspacePaneBindingUnavailable } from '../../workspace-panes/WorkspacePaneBindingUnavailable';
import { SessionsView } from '../SessionsView';
import { useActivityWorkspacePaneBinding } from './ActivityWorkspacePaneBinding';

/**
 * The built-in Activity Workspace Pane renderer — the ONE mounter of the
 * sessions surface (`SessionsView`), pinned by
 * `__tests__/activity-surface-single-mounter.test.ts`. Every placement
 * (the `/activity` route, the ambient dock, the Developer archive embed)
 * reaches the surface through this renderer and its canonical-occurrence
 * check, so the pre-pane route/surface split cannot silently re-form.
 *
 * Like Home, Activity binds no Project, so it never consults
 * `useWorkspacePaneBoundIdentity` — there is no captured identity whose
 * resolution could fail. Its one derivable failure is the occurrence check
 * every built-in performs: a placed instance that is not Activity's
 * canonical one does not match the renderer it was opened with, and says so.
 *
 * A missing context binding renders nothing rather than narrating a state no
 * supported host produces — the same programming-error stance as Home's
 * renderer: this context's only producers are Activity's placements.
 *
 * Placement belongs to shell chrome. This renderer contributes only Activity
 * content, regardless of whether a route or region host mounts it.
 */
export function ActivityWorkspacePane({ instance }: BuiltinWorkspacePaneProps) {
  const binding = useActivityWorkspacePaneBinding();
  if (!isCanonicalWorkspaceActivityPaneInstance(instance))
    return (
      <WorkspacePaneBindingUnavailable
        identity={{ state: 'pane-instance-invalid' }}
      />
    );
  if (!binding) return null;
  return (
    <SessionsView
      apiBase={binding.apiBase}
      sessionId={binding.sessionId}
      focusHint={binding.focusHint}
    />
  );
}
