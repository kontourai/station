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

/**
 * v2 binds the attestation to the proposal it stamps (#2323 S5 delta
 * review): the kind and the target (the install source, or the plugin
 * name) are MAC inputs, so one attestation from a conversation cannot vouch
 * for a different proposal. The input is a JSON array, so no field's content
 * can shift a boundary between fields.
 */
const DOMAIN = 'station.plugin-proposal.source-context.v2';

/** What a proposal asks for, as the attestation binds it. */
export interface AttestedProposalSubject {
  kind: 'install' | 'update' | 'remove';
  /** The install source, or the plugin name. Trimmed before binding. */
  target: string;
}

function mac(
  agentSlug: string,
  conversationId: string | undefined,
  subject: AttestedProposalSubject,
): string {
  return createHmac('sha256', getInternalApiToken())
    .update(
      JSON.stringify([
        DOMAIN,
        subject.kind,
        subject.target.trim(),
        agentSlug,
        conversationId ?? '',
      ]),
    )
    .digest('base64url');
}

export function attestProposalSourceContext(
  agentSlug: string,
  conversationId: string | undefined,
  subject: AttestedProposalSubject,
): string {
  return mac(agentSlug, conversationId, subject);
}

export function verifyProposalSourceContext(
  context: {
    agentSlug?: string;
    conversationId?: string;
    attestation?: string;
  },
  subject: AttestedProposalSubject,
): boolean {
  if (!context.agentSlug || typeof context.attestation !== 'string')
    return false;
  const expected = Buffer.from(
    mac(context.agentSlug, context.conversationId, subject),
  );
  const actual = Buffer.from(context.attestation);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
