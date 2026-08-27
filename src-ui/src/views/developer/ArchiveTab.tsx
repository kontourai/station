import {
  WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
  WORKSPACE_ACTIVITY_PANE_INSTANCE,
} from '@kontourai/station-contracts/workspace-activity-pane';
import { authenticatedFetch } from '@kontourai/station-sdk';
import { useMutation } from '@tanstack/react-query';
import { PageHeaderScope } from '../../components/page-frame';
import { WorkspacePaneDockContext } from '../../workspace-panes/WorkspacePaneDockContext';
import { ActivityWorkspacePane } from '../activity/ActivityWorkspacePane';
import { ActivityWorkspacePaneBindingProvider } from '../activity/ActivityWorkspacePaneBinding';
import { downloadDiagnosticsBundle } from '../settings/diagnostics-download';

/**
 * Session archive plus a one-click diagnostics bundle download. Reuses the same
 * `GET /api/diagnostics/bundle` + `downloadDiagnosticsBundle` helper that
 * Settings → Diagnostics uses (the bundle is a redacted health/config snapshot
 * that includes recent server logs).
 */
export default function ArchiveTab({ apiBase }: { apiBase: string }) {
  const diagnosticsBundle = useMutation({
    mutationFn: async () => {
      const response = await authenticatedFetch(
        `${apiBase}/api/diagnostics/bundle`,
      );
      if (!response.ok) {
        throw new Error('The diagnostics bundle could not be generated.');
      }
      return response.blob();
    },
    onSuccess: downloadDiagnosticsBundle,
  });

  return (
    <section
      className="developer-tab developer-tab--archive"
      aria-label="Archive"
    >
      <div className="developer-tab__header-row">
        <button
          type="button"
          className="editor-btn"
          disabled={diagnosticsBundle.isPending}
          onClick={() => diagnosticsBundle.mutate(undefined)}
        >
          {diagnosticsBundle.isPending
            ? 'Preparing…'
            : 'Download diagnostics bundle'}
        </button>
      </div>
      {diagnosticsBundle.isError ? (
        <p role="alert">Unable to generate the diagnostics bundle.</p>
      ) : null}
      {/* Embedded, so the Activity collection is a section of this tab, not
          the page. Without this scope its split pane would publish "Activity"
          over the Developer route's own title. The surface is reached
          through its pane renderer with the canonical occurrence (M3: one
          mounter of SessionsView, ever), with the dock context nulled: on a
          page that is not the pane's placement, a header "Dock this pane"
          would have an ambiguous referent — the same suppression the dock's
          own occupant applies. */}
      <PageHeaderScope>
        <ActivityWorkspacePaneBindingProvider binding={{ apiBase }}>
          <WorkspacePaneDockContext.Provider value={null}>
            <ActivityWorkspacePane
              descriptor={WORKSPACE_ACTIVITY_PANE_DESCRIPTOR}
              instance={WORKSPACE_ACTIVITY_PANE_INSTANCE}
            />
          </WorkspacePaneDockContext.Provider>
        </ActivityWorkspacePaneBindingProvider>
      </PageHeaderScope>
    </section>
  );
}
