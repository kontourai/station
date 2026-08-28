import {
  createWorkspaceBoardPaneInstance,
  WORKSPACE_BOARD_PANE_DESCRIPTOR,
} from '@kontourai/station-board-pane/workspace-board-pane';
import type { ProjectMetadata } from '@kontourai/station-contracts';
import { useProjectsQuery } from '@kontourai/station-sdk';
import { useMemo } from 'react';
import { describeReadFailure, ErrorState, Skeleton } from '../components/state';
import { useConfig } from '../contexts/ConfigContext';
import { selectClientWorkspacePaneRenderer } from '../workspace-panes/workspacePaneRendererSelection';
import { BoardWorkspacePane } from './board/BoardWorkspacePane';

/**
 * The `project-session-board` route (and the `session-board` layout
 * adapter's body): the standalone placement of the Board Workspace Pane
 * (archive#4142, following the route-as-placement shape for
 * `/` and `/activity`).
 *
 * A route is a placement, not an identity (`docs/design/pane-or-shell.md`):
 * this host mounts the pane renderer with the Board's canonical occurrence
 * directly — no `WorkspacePaneHost`, because a standalone route placement
 * has exactly one code-determined occupant and no user-arrangeable
 * document. The built-in renders because `selectClientWorkspacePaneRenderer`
 * admitted it for this build's fixed Board descriptor, not because this file
 * names a surface; mounting directly rather than through
 * `getBuiltinWorkspacePaneRenderer` only skips the registry LOOKUP (whose
 * component table statically reaches ~800kB of chunk), never the shared
 * authorization.
 *
 * Unlike Home and Activity, the Board binds a Project, so this placement
 * first resolves the routed slug to the Project's stable id — the occurrence
 * captures identity (`boundContext.projectId`), never route state — and the
 * renderer re-derives the Project from that id through
 * `useWorkspacePaneBoundIdentity` like every other Project-bound built-in.
 */
export function ConsoleBoardView({ projectSlug }: { projectSlug: string }) {
  const config = useConfig();
  const {
    data: projects = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useProjectsQuery();
  const project = (projects as ProjectMetadata[]).find(
    (candidate) => candidate.slug === projectSlug,
  );
  const instance = useMemo(
    () => (project ? createWorkspaceBoardPaneInstance(project.id) : null),
    [project],
  );
  if (!project || !instance) {
    if (isLoading) {
      // The same pending shell the Board itself renders while its queries
      // are in flight, so resolving the Project first costs no new state.
      return (
        <div className="page-layout console-board-view">
          <Skeleton />
        </div>
      );
    }
    // archive#771: an errored projects read with no
    // cached data used to fall straight through to "This host has no
    // Project with that slug." — a fabricated negative fact indistinguishable
    // from a genuine bad slug. Cached data from a prior successful load still
    // resolves `project` normally above and never reaches this branch.
    if (isError && projects.length === 0) {
      return (
        <ErrorState
          title="Could not load projects"
          description={describeReadFailure(error)}
          action={
            <button type="button" onClick={() => refetch()}>
              Retry
            </button>
          }
        />
      );
    }
    return (
      <ErrorState
        title="The Board is unavailable"
        description="This host has no Project with that slug."
      />
    );
  }
  const selection = selectClientWorkspacePaneRenderer(
    WORKSPACE_BOARD_PANE_DESCRIPTOR,
    {
      mcpAppsEnabled: config?.mcpUiHost !== false,
      instance,
    },
  );
  const builtinSelected =
    selection.state === 'selected' &&
    selection.candidate.source === 'primary' &&
    selection.candidate.renderer.kind === 'builtin-component';
  if (!builtinSelected) {
    // No fallback when selection refuses, deliberately (Home's stance):
    // rendering the surface anyway would make the selection decorative.
    return (
      <ErrorState
        title="The Board is unavailable"
        description="This build registers no renderer that the Board’s declaration admits."
      />
    );
  }
  return (
    <BoardWorkspacePane
      descriptor={WORKSPACE_BOARD_PANE_DESCRIPTOR}
      instance={instance}
    />
  );
}
