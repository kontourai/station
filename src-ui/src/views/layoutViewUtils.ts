import type { AgentId } from '@kontourai/station-contracts/agent-identity';
import { agentAvailableInProject } from '@kontourai/station-contracts/project-reference-integrity';
import type { AgentData } from '../contexts/AgentsContext';

/**
 * Discriminates "the project's `ProjectConfig.agents` filter is known"
 * (`ready`, `agents` is the real filter value — `undefined` here
 * legitimately means "no filter, every global agent allowed") from "not
 * settled yet, or errored" (`unknown`). Collapsing these into a single
 * `readonly string[] | undefined` (the original fix's mistake, and
 * the closure- residual) makes an in-flight or failed
 * `useProjectQuery` indistinguishable from a project that legitimately has
 * no filter — both looked like "allow every global agent," which fails
 * OPEN during the exact window the filter can't yet be trusted.
 */
export type ProjectAgentFilterState =
  | { status: 'ready'; agents: readonly AgentId[] | undefined }
  | { status: 'unknown' };

/**
 * §3.3 two-input rule applied at layout prompt/action launch time
* (archive#1004): a prompt/action's
 * `agent` ref (or the layout's `defaultAgent` fallback) must resolve to an
 * agent actually AVAILABLE in this project under the SAME rule the
 * new-chat picker and project-settings filter apply — owned by this
 * project (ignoring the opt-in filter entirely), or global AND passing
 * `ProjectConfig.agents`. `projectFilter.status === 'unknown'` refuses to
 * resolve ANYTHING (including an agent owned by this project) — fail
 * closed while the filter can't yet be trusted, rather than guessing.
 */
export function resolveLayoutLaunchAgent(
  agentSlug: AgentId | undefined,
  agents: readonly AgentData[],
  projectSlug: string,
  projectFilter: ProjectAgentFilterState,
): AgentData | undefined {
  if (!agentSlug) return undefined;
  if (projectFilter.status === 'unknown') return undefined;
  const found = agents.find((agent) => agent.slug === agentSlug);
  if (!found) return undefined;
  return agentAvailableInProject(projectSlug, projectFilter.agents, found)
    ? found
    : undefined;
}

/**
 * Visible-unavailable marker for a layout prompt/action whose `agent` ref
 * is not available in this project — never silently hidden (the orphan-
 * visibility family's discipline elsewhere in archive#1004), so the user
 * can see the layout authored a reference that doesn't resolve here rather
 * than wondering why a button vanished. While `projectFilter.status` is
 * `'unknown'`, the marker reads "pending" rather than "unavailable" — the
 * launch is refused either way (`resolveLayoutLaunchAgent`), but the
 * button shouldn't claim a settled "no" for a question that hasn't
 * resolved yet.
 */
export function annotateUnavailableAgentLabel<
  T extends { label: string; agent?: AgentId },
>(
  item: T,
  agents: readonly AgentData[],
  projectSlug: string,
  projectFilter: ProjectAgentFilterState,
): T {
  if (!item.agent) return item;
  if (resolveLayoutLaunchAgent(item.agent, agents, projectSlug, projectFilter))
    return item;
  if (projectFilter.status === 'unknown') {
    return { ...item, label: `${item.label} (availability pending)` };
  }
  return { ...item, label: `${item.label} (unavailable in this project)` };
}
