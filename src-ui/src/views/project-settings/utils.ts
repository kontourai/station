import type { ProjectConfig } from '../../contexts/ProjectsContext';
import type { ProjectForm } from './types';

/**
 * §3.3 (station#1004, unification slice 7): the project availability filter
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
  const { defaultEnvironment, ...rest } = form;
  return {
    ...rest,
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
    defaultWorkspaceIsolation: project.defaultWorkspaceIsolation ?? 'shared',
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
