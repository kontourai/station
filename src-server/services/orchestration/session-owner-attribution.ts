/**
 * Station #90 lane D (station #122), security review B2: a session started by
 * a station-control agent tool that Station could not attribute to a
 * verified acting principal.
 *
 * Every station-control REST call authenticates as Station's internal
 * principal, which resolves to the local operator. So without this marker, a
 * session an agent started (from a pooled Station-engine child, or from a
 * session whose own principal is only inferred) was recorded as owned by the
 * operator, and `sessionActingPrincipal` then reported it as acting for the
 * operator with `session-owner` provenance: an agent acting for a paired
 * device user could mint an operator-eligible child.
 *
 * The dispatch routes stamp this marker in the new session's start metadata
 * (next to `userId`) instead of letting the child inherit a principal it was
 * never given. `userId` itself is left as today, so read access and
 * continuation behave exactly as before; only the acting-principal
 * derivation changes: a marked session acts for no one.
 *
 * Restrict-only by construction: a public caller that sets it only removes
 * its own session's acting principal, so it is not a reserved key.
 */
export const SESSION_OWNER_ATTRIBUTION_METADATA_KEY = 'ownerAttribution';
export const UNATTRIBUTED_AGENT_OWNER_ATTRIBUTION = 'unattributed-agent';
export type SessionOwnerAttribution =
  typeof UNATTRIBUTED_AGENT_OWNER_ATTRIBUTION;

/** Metadata fragment for a session start; empty unless the marker applies. */
export function sessionOwnerAttributionMetadata(
  attribution: SessionOwnerAttribution | undefined,
): Record<string, string> {
  return attribution === UNATTRIBUTED_AGENT_OWNER_ATTRIBUTION
    ? { [SESSION_OWNER_ATTRIBUTION_METADATA_KEY]: attribution }
    : {};
}

/**
 * Station #90 lane D (S1): what the HTTP seam knows about a start's cause.
 * `verified-bound` is the ONLY value that lets an internal-principal start
 * keep an acting principal; see {@link effectiveOwnerAttribution}.
 */
export type StartOwnerAttribution =
  | typeof UNATTRIBUTED_AGENT_OWNER_ATTRIBUTION
  | 'verified-bound';

/**
 * Station #90 lane D (S1): fail closed from a server fact. A start whose
 * client origin the auth middleware recorded as Station's internal actor
 * (the per-boot internal token, which any agent holding a stdio child's env
 * can present) is unattributed unless the seam explicitly vouched for a
 * verified, bound caller. Absence of an attribution is never trust.
 */
export function effectiveOwnerAttribution(context: {
  ownerAttribution?: StartOwnerAttribution;
  clientOrigin?: { actor?: { kind?: string } };
}): SessionOwnerAttribution | undefined {
  if (context.ownerAttribution === UNATTRIBUTED_AGENT_OWNER_ATTRIBUTION)
    return UNATTRIBUTED_AGENT_OWNER_ATTRIBUTION;
  if (
    context.clientOrigin?.actor?.kind === 'internal' &&
    context.ownerAttribution !== 'verified-bound'
  )
    return UNATTRIBUTED_AGENT_OWNER_ATTRIBUTION;
  return undefined;
}

/**
 * Who a session a request starts belongs to, and whether it acts for them.
 * `ownerUserId` is recorded as the session's owner (so its account can read
 * it); `ownerAttribution` rides the start so the one start choke point (or
 * a seeded record) marks an unverified agent's session to act for no one.
 */
export interface SessionOwnerStamp {
  readonly ownerUserId: string;
  readonly ownerAttribution?: StartOwnerAttribution;
}

/**
 * The same decision `/api/orchestration`'s `resolveDispatchActor` makes for
 * a start (Station #90 lane D, B2), for any other route that starts a
 * session:
 *
 * - no agent verdict (an operator or device credential): the request's own
 *   principal owns it and it acts for them;
 * - `verified` (a bound station-control caller acting for an authenticated
 *   session owner): that owner owns it and it acts for them;
 * - `unattributed` (any other request carrying Station's internal token):
 *   the request principal (the local operator) owns it, so the operator's
 *   account can read it, but it acts for no one.
 */
export function sessionOwnerStampFor(
  requestPrincipalId: string,
  agent:
    | { readonly kind: 'verified'; readonly principalId: string }
    | { readonly kind: 'unattributed' }
    | undefined,
): SessionOwnerStamp {
  if (!agent) return { ownerUserId: requestPrincipalId };
  if (agent.kind === 'verified')
    return {
      ownerUserId: agent.principalId,
      ownerAttribution: 'verified-bound',
    };
  return {
    ownerUserId: requestPrincipalId,
    ownerAttribution: UNATTRIBUTED_AGENT_OWNER_ATTRIBUTION,
  };
}
