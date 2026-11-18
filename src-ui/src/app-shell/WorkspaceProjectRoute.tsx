import { lazy } from 'react';
import type { NavigationView } from '../types';
import { WorkspacePaneHostActionsFrame } from '../workspace-panes/WorkspacePaneHostActions';

const ProjectLayoutRenderer = lazy(() =>
  import('./ProjectLayoutRenderer').then((module) => ({
    default: module.ProjectLayoutRenderer,
  })),
);
const WorkspacePaneRouteView = lazy(() =>
  import('../workspace-panes/WorkspacePaneRouteView').then((module) => ({
    default: module.WorkspacePaneRouteView,
  })),
);

export function WorkspaceProjectRoute({
  route,
}: {
  route: Extract<NavigationView, { type: 'layout' | 'workspace-pane' }>;
}) {
  const { projectSlug, layoutSlug } = route;
  return (
    <WorkspacePaneHostActionsFrame projectSlug={projectSlug}>
      {route.type === 'layout' ? (
        <ProjectLayoutRenderer
          projectSlug={projectSlug}
          layoutSlug={route.layoutSlug}
        />
      ) : (
        <WorkspacePaneRouteView
          projectSlug={projectSlug}
          layoutSlug={layoutSlug}
          descriptorId={route.descriptorId}
          instanceId={route.instanceId}
        />
      )}
    </WorkspacePaneHostActionsFrame>
  );
}
