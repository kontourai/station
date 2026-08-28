import { type AgentId, agentId } from './agent-identity.js';
import type { ProjectConfig } from './project.js';

export type ProjectReferenceIntegrityCode =
  | 'unknown_project_agent'
  | 'unknown_layout_agent'
  | 'layout_agent_outside_project_scope'
  | 'layout_default_agent_not_available'
  | 'agent_owned_by_other_project';

export type ProjectReferenceIntegritySeverity = 'warning' | 'error';

export interface ProjectReferenceIntegrityDiagnostic {
  code: ProjectReferenceIntegrityCode;
  severity: ProjectReferenceIntegritySeverity;
  message: string;
  path: string;
  refType: 'agent';
  refId: string;
}

/**
 * Minimal ownership shape `project-reference-integrity` needs from an agent
 * (archive#1004 / agent-engine-unification.md §3.3):
 * the agent's slug plus its owning project slug, if any. `project`
 * undefined means the agent is global.
 */
export interface AgentOwnershipRef {
  slug: AgentId;
  /** Owning project slug; absent = global (agent-engine-unification.md §3.3). */
  project?: string;
}

export interface ProjectReferenceIntegrityOptions {
  knownAgents: Iterable<AgentOwnershipRef>;
  severity?: ProjectReferenceIntegritySeverity;
}

export interface LayoutAgentReferenceShape {
  config?: Record<string, unknown> | null;
}

export function normalizeProjectAgentScope(
  agents: readonly AgentId[] | undefined,
): AgentId[] | undefined {
  if (agents === undefined) return undefined;
  return [...new Set(agents.filter(Boolean))];
}

export function projectAllowsAgent(
  projectAgents: readonly AgentId[] | undefined,
  agentSlug: AgentId,
): boolean {
  return projectAgents === undefined || projectAgents.includes(agentSlug);
}

/**
 * §3.3 two-input rule: an agent is available in a project context if it is
 * owned by that project, or it is global and passes the project's opt-in
 * `ProjectConfig.agents` filter. Neither input alone can answer this — an
 * owned agent ignores the filter entirely (it is implicitly available in
 * its own project and unavailable everywhere else), and a global agent
 * never reads ownership.
 */
export function agentAvailableInProject(
  currentProjectSlug: string | undefined,
  projectAgents: readonly AgentId[] | undefined,
  agent: AgentOwnershipRef,
): boolean {
  if (agent.project !== undefined) return agent.project === currentProjectSlug;
  return projectAllowsAgent(projectAgents, agent.slug);
}

export function availableAgentSlugsForProject(
  currentProjectSlug: string | undefined,
  projectAgents: readonly AgentId[] | undefined,
  knownAgents: Iterable<AgentOwnershipRef>,
): AgentId[] {
  const available: AgentId[] = [];
  for (const agent of knownAgents) {
    if (agentAvailableInProject(currentProjectSlug, projectAgents, agent)) {
      available.push(agent.slug);
    }
  }
  return available;
}

export function validateProjectAgentScope(
  project: Pick<ProjectConfig, 'slug' | 'agents'>,
  options: ProjectReferenceIntegrityOptions,
): ProjectReferenceIntegrityDiagnostic[] {
  const severity = options.severity ?? 'error';
  const known = new Map<AgentId, AgentOwnershipRef>();
  for (const agent of options.knownAgents) known.set(agent.slug, agent);
  const scoped = normalizeProjectAgentScope(project.agents);
  if (!scoped) return [];

  const diagnostics: ProjectReferenceIntegrityDiagnostic[] = [];
  scoped.forEach((agentSlug, index) => {
    const agent = known.get(agentSlug);
    if (!agent) {
      diagnostics.push({
        code: 'unknown_project_agent',
        severity,
        message: `Project references unknown agent '${agentSlug}'.`,
        path: `agents[${index}]`,
        refType: 'agent',
        refId: agentSlug,
      });
      return;
    }
    if (agent.project !== undefined && agent.project !== project.slug) {
      diagnostics.push({
        code: 'agent_owned_by_other_project',
        severity,
        message: `Agent '${agentSlug}' is owned by project '${agent.project}' and cannot be selected here.`,
        path: `agents[${index}]`,
        refType: 'agent',
        refId: agentSlug,
      });
    }
  });
  return diagnostics;
}

export function validateLayoutAgentReferences(
  project: Pick<ProjectConfig, 'slug' | 'agents'>,
  layout: LayoutAgentReferenceShape,
  options: ProjectReferenceIntegrityOptions,
): ProjectReferenceIntegrityDiagnostic[] {
  const severity = options.severity ?? 'error';
  const knownAgents = [...options.knownAgents];
  const known = new Set<AgentId>(knownAgents.map((agent) => agent.slug));
  const availableByProject = new Set(
    availableAgentSlugsForProject(project.slug, project.agents, knownAgents),
  );
  const config = layout.config ?? {};
  const availableAgents = Array.isArray(config.availableAgents)
    ? config.availableAgents
        .filter((value): value is string => typeof value === 'string')
        .map(agentId)
    : [];
  const defaultAgent =
    typeof config.defaultAgent === 'string'
      ? agentId(config.defaultAgent)
      : undefined;

  const diagnostics: ProjectReferenceIntegrityDiagnostic[] = [];

  /**
   * Shared by every agent-ref site below (`availableAgents` AND layout
   * prompt/action agent refs, which otherwise bypass
   * this check entirely). Same diagnostics family regardless of where the
   * reference lives in the layout.
   */
  function pushAgentRefDiagnostic(agentSlug: AgentId, path: string): void {
    if (!known.has(agentSlug)) {
      diagnostics.push({
        code: 'unknown_layout_agent',
        severity,
        message: `Layout references unknown agent '${agentSlug}'.`,
        path,
        refType: 'agent',
        refId: agentSlug,
      });
      return;
    }
    if (!availableByProject.has(agentSlug)) {
      diagnostics.push({
        code: 'layout_agent_outside_project_scope',
        severity,
        message: `Layout agent '${agentSlug}' is outside the project agent scope.`,
        path,
        refType: 'agent',
        refId: agentSlug,
      });
    }
  }

  availableAgents.forEach((agentSlug, index) => {
    pushAgentRefDiagnostic(agentSlug, `config.availableAgents[${index}]`);
  });

  /**
   * Layout tabs/prompts/actions each carry their
   * own optional `agent` ref (`LayoutAction`/`LayoutSkill` in
   * `packages/contracts/src/layout.ts`) — a two-input-rule seam the
   * `availableAgents`/`defaultAgent` checks above never covered. Scanned
   * defensively against the raw config shape (this function's `layout`
   * input is untyped JSON, not the typed `LayoutDefinition`).
   */
  function agentRefFrom(entry: unknown): AgentId | undefined {
    if (!entry || typeof entry !== 'object') return undefined;
    const agent = (entry as { agent?: unknown }).agent;
    return typeof agent === 'string' && agent.length > 0
      ? agentId(agent)
      : undefined;
  }

  function scanAgentRefList(list: unknown, pathPrefix: string): void {
    if (!Array.isArray(list)) return;
    list.forEach((entry, index) => {
      const agentSlug = agentRefFrom(entry);
      if (agentSlug)
        pushAgentRefDiagnostic(agentSlug, `${pathPrefix}[${index}]`);
    });
  }

  scanAgentRefList(config.actions, 'config.actions');
  scanAgentRefList(config.globalSkills, 'config.globalSkills');
  if (Array.isArray(config.tabs)) {
    config.tabs.forEach((tab, tabIndex) => {
      if (!tab || typeof tab !== 'object') return;
      scanAgentRefList(
        (tab as { actions?: unknown }).actions,
        `config.tabs[${tabIndex}].actions`,
      );
      scanAgentRefList(
        (tab as { skills?: unknown }).skills,
        `config.tabs[${tabIndex}].skills`,
      );
    });
  }

  if (defaultAgent) {
    const layoutAvailable =
      availableAgents.length > 0
        ? new Set(availableAgents)
        : availableByProject;
    if (!known.has(defaultAgent)) {
      diagnostics.push({
        code: 'unknown_layout_agent',
        severity,
        message: `Layout default agent '${defaultAgent}' is unknown.`,
        path: 'config.defaultAgent',
        refType: 'agent',
        refId: defaultAgent,
      });
    } else if (
      !availableByProject.has(defaultAgent) ||
      !layoutAvailable.has(defaultAgent)
    ) {
      diagnostics.push({
        code: 'layout_default_agent_not_available',
        severity,
        message: `Layout default agent '${defaultAgent}' is not available in this project layout.`,
        path: 'config.defaultAgent',
        refType: 'agent',
        refId: defaultAgent,
      });
    }
  }

  return diagnostics;
}

export interface AgentOwnershipFinding {
  code: 'unknown_owner_project';
  project: string;
  message: string;
}

/**
 * §3.3 orphan visibility: an agent whose `project` names a project that no
 * longer exists. Returns undefined for a global agent (`agentProject`
 * undefined) or one whose owning project is known — the finding names the
 * missing project verbatim, shared byte-identical across the API payload,
 * editor banner, and Agents-list marker.
 */
export function agentOwnershipFinding(
  agentProject: string | undefined,
  knownProjectSlugs: ReadonlySet<string>,
): AgentOwnershipFinding | undefined {
  if (agentProject === undefined) return undefined;
  if (knownProjectSlugs.has(agentProject)) return undefined;
  return {
    code: 'unknown_owner_project',
    project: agentProject,
    message: `This agent's owning project '${agentProject}' no longer exists.`,
  };
}
