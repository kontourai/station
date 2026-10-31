import type { ProjectWorkingContext } from '@kontourai/station-contracts/project-working-configuration';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import type {
  FeaturePreviewRegistry,
  FeaturePreviewSelector,
} from '../services/feature-previews/feature-preview-registry.js';
import {
  ProjectWorkingConfigurationRefusal,
  ProjectWorkingConfigurationService,
} from '../services/projects/project-working-configuration.js';

export interface ProjectWorkingRuntime {
  service: ProjectWorkingConfigurationService;
  preview: FeaturePreviewSelector;
  forTask(
    task: TaskRecord,
    viewerUserId: string | undefined,
  ): Promise<ProjectWorkingContext>;
}

/** One live selector and storage owner feed Sources and both Task brief callers. */
export function composeProjectWorkingRuntime(
  registry: FeaturePreviewRegistry,
  options: {
    home: string;
    hosted: boolean;
    projects(): readonly { id: string; slug: string }[];
    resolveDirectory(
      slug: string,
    ): string | undefined | Promise<string | undefined>;
    canRead(projectId: string, principalId: string): boolean | Promise<boolean>;
  },
): ProjectWorkingRuntime | undefined {
  if (options.hosted) return undefined;
  const preview = registry.bind({
    id: 'project-working-configuration',
    label: 'Project working configuration',
    description:
      'Review repository guidance, validation commands and completion criteria for focused Task context. Applying a configuration runs no commands.',
  });
  const projectFor = (identity: string) =>
    options.projects().find((project) => project.id === identity) ??
    options.projects().find((project) => project.slug === identity);
  const service = new ProjectWorkingConfigurationService(
    options.home,
    async (slug) => {
      const project = options.projects().find((entry) => entry.slug === slug);
      if (!project) throw new ProjectWorkingConfigurationRefusal('unavailable');
      const cwd = await options.resolveDirectory(slug);
      if (!cwd) throw new ProjectWorkingConfigurationRefusal('unavailable');
      return { projectId: project.id, cwd };
    },
  );
  return {
    service,
    preview,
    async forTask(task, viewerUserId) {
      const enabled = () =>
        preview.select({ enabled: () => true, disabled: () => false });
      if (!enabled()) return { state: 'disabled', text: '', omittedRules: 0 };
      const project = projectFor(task.projectId);
      if (!project || !viewerUserId)
        throw new ProjectWorkingConfigurationRefusal('unavailable');
      const current = async () =>
        enabled() &&
        projectFor(task.projectId)?.id === project.id &&
        (await options.canRead(project.id, viewerUserId));
      if (!(await current()))
        throw new ProjectWorkingConfigurationRefusal('unavailable');
      return service.forTask(project.slug, current);
    },
  };
}
