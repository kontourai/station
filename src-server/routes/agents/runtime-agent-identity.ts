import {
  type AgentId,
  agentId,
} from '@kontourai/station-contracts/agent-identity';
import { ReservedAgentIdentityError } from '../../domain/agent-registry.js';

/**
 * Translate a public persisted Agent ID to the current managed-runtime key.
 * `station` is the only intentional mismatch: it is the clean public Agent
 * identity while the in-process managed runtime still uses `default` as an
 * implementation key. This is not a public alias or a generic parser.
 */
export function runtimeAgentKey(agentId: string): string {
  if (agentId === 'default') throw new ReservedAgentIdentityError(agentId);
  return agentId === 'station' ? 'default' : agentId;
}

/** Project the one internal runtime-key mismatch back to public Agent identity. */
export function publicAgentIdFromRuntimeKey(runtimeKey: string): AgentId {
  return agentId(runtimeKey === 'default' ? 'station' : runtimeKey);
}

/**
 * View an active-agent set (keyed by internal runtime keys) through public
 * Agent identity. `has('station')` consults the internal `default` entry —
 * the registry-declared default agent has no persisted file, so an
 * untranslated lookup misses it entirely (station#1992). The reserved
 * internal key is not a public identity: `has('default')` is false here even
 * though the underlying set contains it, matching `runtimeAgentKey`'s
 * ReservedAgentIdentityError refusal on the route path.
 */
export function publicIdentityAgentSetView(activeAgents: {
  has(runtimeKey: string): boolean;
}): { has(agentId: string): boolean } {
  return {
    has: (id: string): boolean => {
      try {
        return activeAgents.has(runtimeAgentKey(id));
      } catch {
        return false;
      }
    },
  };
}
