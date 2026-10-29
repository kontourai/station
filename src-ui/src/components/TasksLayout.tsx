import { useScopedProjectQuery } from '../contexts/ProjectsContext';
import { useGitStatus } from '../hooks/useGitStatus';
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
  const { data: project } = useScopedProjectQuery(projectSlug);

  const { data: gitStatus } = useGitStatus(
    projectSlug,
    project?.workingDirectory,
  );

  return (
    <section className="tasks-layout" aria-label="Tasks">
      <ProjectTasksSection
        slug={projectSlug}
        projectId={project?.id}
        projectWorkingDirectory={project?.workingDirectory}
        gitStatus={gitStatus}
        agents={project?.agents}
        presentation="board"
      />
    </section>
  );
}
