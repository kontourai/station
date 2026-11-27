import { isProjectChatApprovalPosture } from '@kontourai/station-contracts/project-chat-defaults';
import type { ProjectConfig } from '../../contexts/ProjectsContext';
import { relativeTimeAgoFromIso } from '../../utils/relativeTime';
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

/**
 * #5062/#5068: the brief and model fields, sent only while the host offers
 * the `project-coordination` preview. An older host stores unknown fields
 * verbatim, and its strict Project file schema would then refuse to load the
 * Project, so they never reach a host that does not know them.
 */
function projectCoordinationPayload(form: ProjectForm) {
  return {
    goal: form.goal.trim() ? form.goal.trim() : null,
    instructions: form.instructions.trim() ? form.instructions : null,
    coordinatorEffort:
      form.coordinatorEffort === 'inherit' ? null : form.coordinatorEffort,
    taskEffort: form.taskEffort === 'inherit' ? null : form.taskEffort,
    taskModel: form.taskModel.trim() ? form.taskModel.trim() : null,
    taskProviderId:
      form.taskModel.trim() && form.taskProviderId ? form.taskProviderId : null,
  };
}

export function buildProjectSavePayload(
  form: ProjectForm,
  workingDirectory?: string,
  savedForm?: ProjectForm | null,
  options: { projectCoordination?: boolean } = {},
) {
  const {
    goal: _goal,
    instructions: _instructions,
    coordinatorEffort: _coordinatorEffort,
    taskEffort: _taskEffort,
    taskModel: _taskModel,
    taskProviderId: _taskProviderId,
    defaultEnvironment,
    defaultWorkspaceIsolation,
    defaultModelSelection,
    defaultApprovalModeSelection,
    defaultApprovalMode,
    icon,
    iconDisabled,
    ...rest
  } = form;
  return {
    ...rest,
    // Sent only when it changed. An unchanged icon is left to the stored
    // record, so a rename never re-submits (and is never refused for) a
    // legacy value the icon rule now refuses. `''` is sent as is: it is the
    // route's "clear the icon", which `JSON.stringify` would drop as
    // `undefined`.
    ...(savedForm &&
    icon === savedForm.icon &&
    iconDisabled === savedForm.iconDisabled
      ? {}
      : { icon, iconDisabled: iconDisabled ?? false }),
    // `'inherit'` is the form's spelling of "this project makes no choice";
    // `null` is the route's, which drops the override rather than storing it
    // (#2144 slice 2). Sent explicitly rather than omitted: `JSON.stringify`
    // drops an `undefined`, so an omitted field would leave a previously
    // stored mode in place and make "use the Station default" do nothing.
    defaultWorkspaceIsolation:
      defaultWorkspaceIsolation === 'inherit'
        ? null
        : defaultWorkspaceIsolation,
    // `fixed` and `'inherit'` are the absent stored values; `null` drops a
    // stored one, as for the workspace mode above.
    defaultModelSelection:
      defaultModelSelection === 'last-used' ? 'last-used' : null,
    defaultApprovalModeSelection:
      defaultApprovalModeSelection === 'last-used' ? 'last-used' : null,
    defaultApprovalMode:
      defaultApprovalMode === 'inherit' ? null : defaultApprovalMode,
    defaultEnvironment: defaultEnvironment ?? { kind: 'current' as const },
    workingDirectory: workingDirectory ?? form.workingDirectory ?? '',
    agents: form.agents ?? null,
    defaultAgent: form.defaultAgent ?? null,
    ...(options.projectCoordination ? projectCoordinationPayload(form) : {}),
  };
}

export function buildProjectForm(project: ProjectConfig): ProjectForm {
  return {
    name: project.name,
    icon: project.icon ?? '',
    iconDisabled: project.iconDisabled ?? false,
    description: project.description ?? '',
    defaultAgent: project.defaultAgent,
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
    defaultModelSelection:
      project.defaultModelSelection === 'last-used' ? 'last-used' : 'fixed',
    defaultApprovalModeSelection:
      project.defaultApprovalModeSelection === 'last-used'
        ? 'last-used'
        : 'fixed',
    defaultApprovalMode: isProjectChatApprovalPosture(
      project.defaultApprovalMode,
    )
      ? project.defaultApprovalMode
      : 'inherit',
    defaultEnvironment: project.defaultEnvironment ?? { kind: 'current' },
    workingDirectory: project.workingDirectory ?? '',
    agents: project.agents,
    toolDefaults: project.toolDefaults,
    goal: project.goal ?? '',
    instructions: project.instructions ?? '',
    coordinatorEffort: project.coordinatorEffort ?? 'inherit',
    taskEffort: project.taskEffort ?? 'inherit',
    taskModel: project.taskModel ?? '',
    taskProviderId: project.taskProviderId ?? '',
  };
}

/** The shared sentence form, for "indexed 5m ago". */
export function getKnowledgeTimeAgo(iso: string, now = Date.now()): string {
  return relativeTimeAgoFromIso(iso, now);
}

/** What a directory scan reported; an older server omits `alreadyIndexed`. */
export interface KnowledgeScanResult {
  indexed: number;
  alreadyIndexed?: number;
  skipped: number;
}

/** The result line after "Index directory", e.g. "Indexed 0 files, 3 already indexed, skipped 0". */
export function knowledgeScanResultText(result: KnowledgeScanResult): string {
  const already = result.alreadyIndexed
    ? `, ${result.alreadyIndexed} already indexed`
    : '';
  return `Indexed ${result.indexed} files${already}, skipped ${result.skipped}`;
}
