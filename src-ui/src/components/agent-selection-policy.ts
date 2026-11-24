import {
  type AgentId,
  STATION_AGENT_ID,
} from '@kontourai/station-contracts/agent-identity';
import { projectAllowsAgent } from '@kontourai/station-contracts/project-reference-integrity';
import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import type { AgentData } from '../contexts/AgentsContext';
import { canAgentStartChat } from '../utils/execution';
import { agentRunnability } from './agent-runnability';

/**
 * §3.3 two-input rule (archive#1004, unification): an owned agent
 * (`agent.project` set) is available only inside its own project — the
 * `ProjectConfig.agents` filter never applies to it, and absent project
 * context (`selectedProjectSlug` undefined) is the global context, where an
 * owned agent never appears (A1 resolution). A global agent (no `project`)
 * uses exact clean Agent ids in the project filter.
 */
function projectAgentScopeAllows(
  selectedProjectSlug: string | undefined,
  selectedProjectAgentFilter: readonly AgentId[] | undefined,
  agent: Pick<AgentData, 'slug' | 'project'>,
): boolean {
  if (agent.project !== undefined) return agent.project === selectedProjectSlug;
  if (selectedProjectAgentFilter === undefined) return true;
  return projectAllowsAgent(selectedProjectAgentFilter, agent.slug);
}

/**
 * The eligible set in the GLOBAL (no-project) context — §3.3 A1: an owned
 * agent never appears outside its own project, and with no project selected
 * there is no `ProjectConfig.agents` filter to apply either.
 *
 * Exists so a caller that is inherently global (the first-run engines
 * chapter, archive#3027 — first run has no project context) can apply the
 * same two-input rule as the pickers without re-deriving it or fabricating a
 * `selectedProjectSlug`. Deliberately not the bucketed
 * `selectProjectScopedChatAgents`: that one needs live connections to sort
 * agents into chat-ready/unavailable, which is a readiness question this
 * caller does not ask.
 */
export function selectGlobalContextAgents(agents: AgentData[]): AgentData[] {
  return agents.filter((agent) =>
    projectAgentScopeAllows(undefined, undefined, agent),
  );
}

export function selectProjectScopedChatAgents({
  agents,
  agentConnections,
  selectedProjectSlug,
  selectedProjectAgentFilter,
  providerManagedAgentSlugs = [],
}: {
  agents: AgentData[];
  agentConnections: ConnectionConfig[];
  selectedProjectSlug?: string;
  selectedProjectAgentFilter?: AgentId[];
  providerManagedAgentSlugs?: AgentId[];
}): {
  chatReadyAgents: AgentData[];
  providerManagedAgents: AgentData[];
  unavailableAgents: AgentData[];
} {
  const chatReadyAgents = selectChatReadyAgents({
    agents,
    agentConnections,
    selectedProjectSlug,
    selectedProjectAgentFilter,
  });
  const providerManagedSet = new Set(providerManagedAgentSlugs);
  const providerManagedAgents = agents.filter(
    (agent) =>
      providerManagedSet.has(agent.slug) &&
      projectAgentScopeAllows(
        selectedProjectSlug,
        selectedProjectAgentFilter,
        agent,
      ),
  );
  // An unavailable persisted Agent still belongs in New Chat: hiding a custom
  // Agent whose connection was removed also hides its reason and repair path.
  // Apply the same project-scope rule used for launchable Agents.
  const unavailableAgents = agents.filter(
    (agent) =>
      agent.available === false &&
      projectAgentScopeAllows(
        selectedProjectSlug,
        selectedProjectAgentFilter,
        agent,
      ),
  );
  return { chatReadyAgents, providerManagedAgents, unavailableAgents };
}

/**
 * Both questions, in the order that matters: the shared STATE predicate
 * (`agentRunnability` — what every surface reports) and then the stricter
 * DISPATCH check (`canAgentStartChat` — is the bound connection selectable
 * this instant). Composing them rather than folding one into the other is
 * deliberate; `agent-runnability.ts` explains why a surface must not label an
 * engine broken merely because its connection has not finished connecting.
 *
 * The predicate is the addition here: this bucket used to say "can start" for
 * a row the SERVER had already marked `available: false`, so a quick-start
 * could open a chat with an Agent the picker rendered disabled.
 */
export function selectChatReadyAgents({
  agents,
  agentConnections,
  selectedProjectSlug,
  selectedProjectAgentFilter,
}: {
  agents: AgentData[];
  agentConnections: ConnectionConfig[];
  selectedProjectSlug?: string;
  selectedProjectAgentFilter?: AgentId[];
}): AgentData[] {
  return agents.filter(
    (agent) =>
      agentRunnability(agent).runnable &&
      canAgentStartChat(agent, agentConnections) &&
      projectAgentScopeAllows(
        selectedProjectSlug,
        selectedProjectAgentFilter,
        agent,
      ),
  );
}

export function selectFirstChatTarget({
  agents,
  agentConnections,
  selectedProjectSlug,
}: {
  agents: AgentData[];
  agentConnections: ConnectionConfig[];
  /**
   * §3.3 A3 (archive#1004 MED): the project identity the header
   * currently renders inside, if any (threaded from
   * `getHeaderBreadcrumb(currentView)?.projectSlug` — absent = global
   * context). Without this, the header's quick-start prompt picked the
   * first agent that could start a chat from the FULL unfiltered catalog,
   * including an agent owned by a project the header isn't even inside —
   * the same two-input rule the dock's own `selectChatReadyAgents` path
   * already enforces.
   */
  selectedProjectSlug?: string;
}): AgentData | undefined {
  return agents.find(
    (agent) =>
      (agent.project === undefined || agent.project === selectedProjectSlug) &&
      agentRunnability(agent).runnable &&
      canAgentStartChat(agent, agentConnections),
  );
}

/**
 * Where the header's "Ask Station" prompts start. Each one runs Station's own
 * tools (`system_status`, `list_active_work`, …), which the built-in Station
 * Assistant receives, so the Assistant is the target whenever a click can
 * start a chat on it. It is a global Agent: a Project the header is inside
 * scopes the chat, not the choice.
 *
 * This used to be `selectFirstChatTarget`, which answers with whichever
 * chat-ready Agent the catalog lists first. It still does when the Assistant
 * cannot start a chat (no engine yet, or the server marks it unavailable), so
 * the menu keeps working on a Station that has not set the Assistant up.
 */
export function selectHelpPromptTarget({
  agents,
  agentConnections,
  selectedProjectSlug,
}: {
  agents: AgentData[];
  agentConnections: ConnectionConfig[];
  selectedProjectSlug?: string;
}): AgentData | undefined {
  const station = agents.find((agent) => agent.slug === STATION_AGENT_ID);
  if (
    station &&
    selectChatReadyAgents({
      agents: [station],
      agentConnections,
      selectedProjectSlug,
    }).length > 0
  )
    return station;
  return selectFirstChatTarget({
    agents,
    agentConnections,
    selectedProjectSlug,
  });
}
