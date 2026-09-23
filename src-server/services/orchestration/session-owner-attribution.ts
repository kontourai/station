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
