/**
 * Station's own engine vouches for the delegation context it derived (#2601).
 *
 * `mcp-manager.ts` derives a child's context from the running conversation and
 * hands it to the built-in station-control child as the `_delegation` tool
 * argument. That child is pooled per tenant, so its REST call carries no
 * per-session caller credential, and the route cannot tell the runtime's
 * derivation from a context a model wrote into the same argument. The stamp
 * therefore travels with an HMAC keyed by the per-boot internal token:
 * Station's runtime can compute it, a model cannot, because the token never
 * enters a model's context. The route keeps an unverified caller's context
 * only when this attestation verifies.
 *
 * Every field of the context is a MAC input (a JSON array, so no field's
 * content can shift a boundary), so an attestation vouches for exactly the
 * context it was minted for and no other.
 *
 * Limit, shared with `plugin-proposal-provenance.ts`: code running as
 * Station's OS user can read the token and forge one. Such code already holds
 * the internal token and can reach every route directly.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AgentDelegationContext } from '@kontourai/station-contracts/agent';
import { getInternalApiToken } from '../../utils/internal-api-token.js';

const DOMAIN = 'station.delegation-context.v1';

function mac(context: AgentDelegationContext): string {
  return createHmac('sha256', getInternalApiToken())
    .update(
      JSON.stringify([
        DOMAIN,
        context.mode,
        context.depth,
        context.maxDepth,
        context.parentAgentSlug,
        context.parentConversationId ?? null,
        context.rootAgentSlug,
        context.rootConversationId ?? null,
        context.allowedTools ?? null,
        context.blockedTools ?? null,
        context.denyApprovals ?? null,
      ]),
    )
    .digest('base64url');
}

export function attestDelegationContext(
  context: AgentDelegationContext,
): string {
  return mac(context);
}

export function verifyDelegationContextAttestation(
  context: AgentDelegationContext,
  attestation: string | undefined,
): boolean {
  if (typeof attestation !== 'string' || attestation.length === 0) return false;
  const expected = Buffer.from(mac(context));
  const actual = Buffer.from(attestation);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
