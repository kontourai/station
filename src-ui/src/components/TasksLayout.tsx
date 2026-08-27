import { useProjectQuery } from '@kontourai/station-sdk';
import { ProjectTasksSection } from '../views/project-page/ProjectTasksSection';
import './TasksLayout.css';

/**
 * The Tasks starter is deliberately a thin layout adapter: task records,
 * dispatch, and Flow status all remain owned by the existing project task UI.
 */
export function TasksLayout({
  projectSlug,
}: {
  projectSlug: string;
  layoutSlug: string;
  config: Record<string, unknown>;
}) {
  const { data: project } = useProjectQuery(projectSlug);

  return (
    <main className="tasks-layout" aria-label="Tasks">
      <ProjectTasksSection
        slug={projectSlug}
        projectWorkingDirectory={project?.workingDirectory}
        agents={project?.agents}
      />
    </main>
  );
}
