import type { AgentSummary } from '../types';

/**
 * The agents that run on this engine connection: those whose saved binding
 * (`execution.agentConnectionId`) names it. An agent's slug says nothing
 * about its engine, so a prefix match both missed renamed agents and caught
 * unrelated ones (`opencode-helper` beside an `opencode` engine).
 */
export function agentsUsingEngine(
  agents: readonly AgentSummary[],
  connectionId: string,
): AgentSummary[] {
  return agents.filter(
    (agent) => agent.execution?.agentConnectionId === connectionId,
  );
}
