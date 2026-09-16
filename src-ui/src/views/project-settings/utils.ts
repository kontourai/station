import type { ProjectConfig } from '../../contexts/ProjectsContext';
import type { ProjectForm } from './types';

/**
 * §3.3 (archive#1004, unification): the project availability filter
 * selects among GLOBAL agents only — a project-owned agent is implicitly
 * available in its own project and never subject to this opt-in filter
 * (agent-engine-unification.md §3.3).
 */
export function globalAgentsOnly<T extends { project?: string }>(
  agents: readonly T[],
): T[] {
  return agents.filter((agent) => agent.project === undefined);
}

export function buildProjectSavePayload(
  form: ProjectForm,
  workingDirectory?: string,
) {
  const { defaultEnvironment, defaultWorkspaceIsolation, ...rest } = form;
  return {
    ...rest,
    // `'inherit'` is the form's spelling of "this project makes no choice";
    // `null` is the route's, which drops the override rather than storing it
    // (#2144 slice 2). Sent explicitly rather than omitted: `JSON.stringify`
    // drops an `undefined`, so an omitted field would leave a previously
    // stored mode in place and make "use the Station default" do nothing.
    defaultWorkspaceIsolation:
      defaultWorkspaceIsolation === 'inherit'
        ? null
        : defaultWorkspaceIsolation,
    defaultEnvironment: defaultEnvironment ?? { kind: 'current' as const },
    workingDirectory: workingDirectory || undefined,
    agents: form.agents ?? null,
  };
}

export function buildProjectForm(project: ProjectConfig): ProjectForm {
  return {
    name: project.name,
    icon: project.icon ?? '',
    description: project.description ?? '',
    defaultModel: project.defaultModel ?? '',
    // Both fields are required for a project default to apply: the resolvers
    // (`resolveProjectProviderManagedExecution`, `ProviderService`) read
    // `defaultProviderId && defaultModel`. An empty string is sent verbatim on
    // save, which is what makes "clear it" reach the server at all —
    // `JSON.stringify` drops an `undefined` and the old value would survive.
    defaultProviderId: project.defaultProviderId ?? '',
    // NOT `?? 'shared'`: a record with no mode has not chosen the shared
    // checkout, it has chosen nothing, and seeding a concrete value made
    // every unrelated save write one (#2144 slice 2).
    defaultWorkspaceIsolation: project.defaultWorkspaceIsolation ?? 'inherit',
    defaultEnvironment: project.defaultEnvironment ?? { kind: 'current' },
    workingDirectory: project.workingDirectory ?? '',
    agents: project.agents,
  };
}

export function getKnowledgeTimeAgo(iso: string, now = Date.now()): string {
  const diff = now - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
