/**
 * Who proposed a plugin change, and whether Station can vouch for it
 * (#2323 S5 review M3).
 *
 * Station's own agent runtime knows the agent and conversation a proposing
 * tool call came from (`mcp-manager.ts` stamps them). An external engine
 * calling station-control supplies whatever its model wrote. Both arrive at
 * the route as the same `_sourceContext` fields, so the stamp also carries
 * an HMAC keyed by the per-boot internal token. Station's runtime can compute
 * it; a model cannot, because the token never enters a model's context. The
 * route records `reportedBy: 'runtime'` only when the attestation verifies,
 * and `'caller'` otherwise, and the review labels a caller-supplied name as
 * self-reported.
 *
 * Limit, same as every other claim in this slice: code running as Station's
 * own OS user can read the token and forge an attestation. It labels
 * provenance for a person reading a proposal; it authorizes nothing.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getInternalApiToken } from '../../utils/internal-api-token.js';

const DOMAIN = 'station.plugin-proposal.source-context.v1';

function mac(agentSlug: string, conversationId: string | undefined): string {
  return createHmac('sha256', getInternalApiToken())
    .update(`${DOMAIN}\0${agentSlug}\0${conversationId ?? ''}`)
    .digest('base64url');
}

export function attestProposalSourceContext(
  agentSlug: string,
  conversationId: string | undefined,
): string {
  return mac(agentSlug, conversationId);
}

export function verifyProposalSourceContext(context: {
  agentSlug?: string;
  conversationId?: string;
  attestation?: string;
}): boolean {
  if (!context.agentSlug || typeof context.attestation !== 'string')
    return false;
  const expected = Buffer.from(mac(context.agentSlug, context.conversationId));
  const actual = Buffer.from(context.attestation);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
