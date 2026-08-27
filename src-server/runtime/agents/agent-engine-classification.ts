import { isStationAgentIdentity } from '@kontourai/station-contracts/agent-identity';
import { resolveEngineCapabilityMatrix } from '@kontourai/station-contracts/engine-capability-matrix';

/**
 * True for an agent record bound to an external engine connection (a native
 * connected runtime like Claude Code/Codex, or an ACP connection) — as
 * opposed to Station's own managed engine (VoltAgent/Strands over a Model
 * connection), which is the only case Station can build a VoltAgent instance
 * for.
 *
 * Mirrors `resolveEngineCapabilityMatrix` (`engine-capability-matrix.ts`,
 * already the shared classifier for the editor's tab/profile derivation;
 * station#1003 Phase B — replaces the retired
 * `resolveAgentTypeFromRuntimeConnection`) rather than re-deriving the
 * managed-runtime-id/engine rules here. Classifying from `agentConnectionId`
 * alone (no live connection lookup) is sufficient: the resolver's own
 * fallback treats ANY unbound-but-present `agentConnectionId` as a non-
 * station engine, which is exactly "external" for this purpose — callers
 * don't need to know WHICH external engine, only that it isn't Station's own.
 *
 * Shared (station#977) between cold boot (`runtime-agent-registry.ts`) and
 * the reload lifecycle (`runtime-agent-lifecycle.ts`) so both skip building
 * a Station-engine VoltAgent instance for the same records — the reload
 * path previously lacked this skip, which surfaced as an incorrectly
 * "unlaunchable" managed external agent after any agent-reload.
 */
export function isExternalEngineBoundAgent(metadata: {
  execution?: { agentConnectionId?: string };
}): boolean {
  return (
    resolveEngineCapabilityMatrix(metadata.execution?.agentConnectionId)
      .engineId !== 'station'
  );
}

/**
 * Whether Station must NOT build a Station-engine (VoltAgent) instance from
 * this agent record — the question both the cold-boot registry
 * (`runtime-agent-registry.ts`) and the reload lifecycle
 * (`runtime-agent-lifecycle.ts`) actually ask.
 *
 * Two disjoint reasons, and naming them separately matters (station#3662):
 *
 *  - it is bound to an EXTERNAL engine, so there is no Station-engine model to
 *    build (`isExternalEngineBoundAgent`, station#954/#977);
 *  - it IS the reserved Station identity, whose single instance is built by
 *    `bootstrapRuntimeDefaultAgent` under the internal runtime key `default`
 *    (see `enriched-agents.ts`'s `isActive`, which reads the same pair as one
 *    agent). A second instance under the public slug would answer chats with a
 *    different object than every Station-engine seam resolves — and without
 *    the built-in `station-control`/`station-docs` tool servers the runtime's
 *    own spec gives it.
 *
 * The station case used to be covered by accident: the seeded record named a
 * `station` engine connection that cannot exist, so the capability matrix
 * classified Station's own Agent as an unknown EXTERNAL engine and it was
 * skipped for a reason that was not true. Dropping that binding is what makes
 * the record honest, so the skip has to state its real reason.
 */
export function hasNoStationEngineInstanceToBuild(metadata: {
  slug?: string;
  execution?: { agentConnectionId?: string };
}): boolean {
  return (
    isStationAgentIdentity(metadata.slug) ||
    isExternalEngineBoundAgent(metadata)
  );
}
