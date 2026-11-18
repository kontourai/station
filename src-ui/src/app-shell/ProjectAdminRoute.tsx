import { lazy } from 'react';
import type { NavigationView } from '../types';

const NewProjectModal = lazy(() =>
  import('../components/modals/NewProjectModal').then((module) => ({
    default: module.NewProjectModal,
  })),
);
const ProjectSettingsView = lazy(() =>
  import('../views/ProjectSettingsView').then((module) => ({
    default: module.ProjectSettingsView,
  })),
);

export function ProjectAdminRoute({
  route,
  onReturnToOutlet,
}: {
  route: Extract<NavigationView, { type: 'project-new' | 'project-edit' }>;
  onReturnToOutlet: () => void;
}) {
  if (route.type === 'project-edit')
    return <ProjectSettingsView slug={route.slug} />;
  return (
    <NewProjectModal
      isOpen
      onClose={() => {
        if (window.location.pathname === '/projects/new') onReturnToOutlet();
      }}
    />
  );
}
