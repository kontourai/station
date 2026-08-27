/**
 * Which model connection Station's managed engine binds for an agent — the ONE
 * rule, in the one place both the runtime and the editor can import it.
 *
 * This used to live only in `src-server/runtime/plugins/runtime-provider-
 * resolution.ts`, and station#3743's fix re-expressed it in the agent editor as
 * `resolveStationModelBinding`. Re-expressed, not shared: the two immediately
 * disagreed about the case that matters. One READY connection plus one enabled
 * but degraded connection, no app default — the editor picked "the sole ready
 * one", enabled Create and persisted no explicit binding, while the runtime
 * counts every ENABLED candidate, calls two of them ambiguous, and refuses to
 * run the agent the editor just said was fine (sol review, HIGH). A client
 * mirror of a server rule is a second rule with a delay on it.
 *
 * So candidacy and classification live here and nothing re-implements them:
 *
 *  - a CANDIDATE is an enabled connection that can serve an LLM. Readiness is
 *    deliberately not part of this: the runtime does not consult it when
 *    deciding WHICH connection is bound, and a client that folded it in was
 *    answering a different question with the same name.
 *  - the DECISION over those candidates is the agent's explicit choice, else
 *    the app default, else the only candidate, else unanswerable.
 *
 * "Can the bound connection run right now" is a separate question, asked by
 * surfaces that gate on it (the editor's Create button) about the connection
 * this returns. Separate question, separate step, applied after — never a
 * different rule about which connection is bound.
 */

import { isLlmModelConnection } from './model-inventory.js';

/** The minimum a connection has to expose to be classified. */
export interface ManagedModelConnectionRef {
  id: string;
  enabled: boolean;
  capabilities: readonly string[];
}

/**
 * An enabled connection that can serve an LLM. Note what is absent: `status`.
 * Filtering candidates by readiness is what let the editor resolve a binding
 * the runtime calls ambiguous.
 */
export function isManagedModelCandidate(
  connection: ManagedModelConnectionRef,
): boolean {
  return Boolean(connection.enabled && isLlmModelConnection(connection));
}

/** Where a resolved binding came from, for callers that explain themselves. */
export type ManagedModelBindingSource =
  | 'explicit'
  | 'app-default'
  | 'only-candidate';

/**
 * `ambiguous` and `invalid` are NOT "no opinion": in both, the agent resolves
 * to nothing. A caller that treats them like an absent answer reports
 * readiness through a connection the agent could never reach.
 */
export type ManagedModelBinding =
  | {
      kind: 'resolved';
      connectionId: string;
      source: ManagedModelBindingSource;
    }
  | { kind: 'none' }
  | { kind: 'ambiguous' }
  | {
      kind: 'invalid';
      declaredConnectionId: string;
      source: 'explicit' | 'app-default';
    };

function trimmed(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function classifyManagedModelBinding(input: {
  /** The agent's own `execution.modelConnectionId`, if it declared one. */
  declaredConnectionId?: string | null;
  /** `AppConfig.defaultLLMProvider`, if one is set. */
  appDefaultConnectionId?: string | null;
  /** Every connection in the home; candidacy is applied here, not by callers. */
  connections: readonly ManagedModelConnectionRef[];
}): ManagedModelBinding {
  const candidates = input.connections.filter(isManagedModelCandidate);

  const declaredConnectionId = trimmed(input.declaredConnectionId);
  if (declaredConnectionId) {
    return candidates.some((candidate) => candidate.id === declaredConnectionId)
      ? {
          kind: 'resolved',
          connectionId: declaredConnectionId,
          source: 'explicit',
        }
      : { kind: 'invalid', declaredConnectionId, source: 'explicit' };
  }

  const appDefaultConnectionId = trimmed(input.appDefaultConnectionId);
  if (appDefaultConnectionId) {
    return candidates.some(
      (candidate) => candidate.id === appDefaultConnectionId,
    )
      ? {
          kind: 'resolved',
          connectionId: appDefaultConnectionId,
          source: 'app-default',
        }
      : {
          kind: 'invalid',
          declaredConnectionId: appDefaultConnectionId,
          source: 'app-default',
        };
  }

  if (candidates.length === 1) {
    return {
      kind: 'resolved',
      connectionId: candidates[0]!.id,
      source: 'only-candidate',
    };
  }
  return candidates.length === 0 ? { kind: 'none' } : { kind: 'ambiguous' };
}
