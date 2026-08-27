import type { AgentId } from '@kontourai/station-contracts/agent-identity';

/**
 * Resolve an Agent's display name by exact persisted identity. Agent IDs are
 * opaque: no namespace, prefix, suffix, or short-name parsing participates.
 */
export function getAgentDisplayName(
  id: AgentId,
  agents?: Array<{ slug: AgentId; name?: string }>,
): string {
  return agents?.find((agent) => agent.slug === id)?.name ?? id;
}
