import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
import type { ResolvedExecutionEngine } from '@kontourai/station-contracts/execution-target';

/** What the agent catalog query holds under `['agents']`. */
export interface ObservedAgentCatalog {
  agents?: ReadonlyArray<{
    slug: string;
    kind?: string;
    execution?: { agentConnectionId?: string | null; approvalMode?: string };
  }>;
  catalogState?: string;
}

/**
 * The engine the composer's own snapshot of an Agent showed it running on, as
 * a precondition for the first send (`ExecutionTarget.expectedEngine`).
 *
 * It mirrors what the target Environment derives from the same Agent record
 * (`execution.agentConnectionId`: present means that connection, absent means
 * Station's own engine) and reads the RAW catalog row, never the New Chat
 * overlay, which rewrites an unbound Agent's connection for display.
 *
 * It states nothing when it cannot be sure the snapshot is what the user saw:
 * no catalog, no such Agent, or a catalog that is serving its last stable
 * answer while the runtime reconciles. A refusal here would strand a send that
 * would have run fine, so uncertainty omits the expectation.
 */
export function observedEngine(
  catalog: ObservedAgentCatalog | undefined,
  agentSlug: string,
): ResolvedExecutionEngine | undefined {
  if (!catalog?.agents || catalog.catalogState === 'reconciling') {
    return undefined;
  }
  const agent = catalog.agents.find((entry) => entry.slug === agentSlug);
  if (!agent) return undefined;
  // A member's view of an Agent carries no `execution` at all, so reading it
  // as unbound would state Station's own engine for every engine-bound Agent.
  if (agent.kind === 'member-agent') return undefined;
  const bound = agent.execution?.agentConnectionId;
  if (typeof bound !== 'string' || bound.length === 0) {
    return { kind: 'station' };
  }
  // An id the identity grammar rejects names no engine the target could have
  // resolved, and an expectation must never be what fails a send.
  try {
    return { kind: 'connection', connectionId: engineConnectionId(bound) };
  } catch {
    return undefined;
  }
}
