import type { ProjectWorkingContext } from '@kontourai/station-contracts/project-working-configuration';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import {
  ProjectWorkingConfigurationRefusal,
  ProjectWorkingConfigurationService,
} from '../services/projects/project-working-configuration.js';

export interface ProjectWorkingRuntime {
  service: ProjectWorkingConfigurationService;
  forTask(
    task: TaskRecord,
    viewerUserId: string | undefined,
  ): Promise<ProjectWorkingContext>;
}

/** One storage owner feeds Sources and both Task brief callers. */
export function composeProjectWorkingRuntime(options: {
  home: string;
  hosted: boolean;
  projects(): readonly { id: string; slug: string }[];
  resolveDirectory(
    slug: string,
  ): string | undefined | Promise<string | undefined>;
  canRead(projectId: string, principalId: string): boolean | Promise<boolean>;
}): ProjectWorkingRuntime | undefined {
  if (options.hosted) return undefined;
  const projectFor = (identity: string) =>
    options.projects().find((project) => project.id === identity) ??
    options.projects().find((project) => project.slug === identity);
  const service = new ProjectWorkingConfigurationService(
    options.home,
    async (slug) => {
      const project = options.projects().find((entry) => entry.slug === slug);
      if (!project) throw new ProjectWorkingConfigurationRefusal('unavailable');
      const cwd = await options.resolveDirectory(slug);
      return { projectId: project.id, cwd };
    },
  );
  return {
    service,
    async forTask(task, viewerUserId) {
      const project = projectFor(task.projectId);
      if (!project || !viewerUserId)
        throw new ProjectWorkingConfigurationRefusal('unavailable');
      const current = async () =>
        projectFor(task.projectId)?.id === project.id &&
        (await options.canRead(project.id, viewerUserId));
      if (!(await current()))
        throw new ProjectWorkingConfigurationRefusal('unavailable');
      return service.forTask(project.slug, current);
    },
  };
}
