import {
  assertMemoryClaim,
  type MemoryAgreement,
  type MemoryClaim,
} from '@kontourai/flow-agents/memory-claims';

/**
 * A distilled claim travels in a Corpus create proposal as one JSON envelope
 * (flow-agents `kits/knowledge/dream/envelope.js`, version 1.2). Station reads
 * that shape; it never writes it. Flow Agents 9.14 publishes the Kit's decoder
 * (`@kontourai/flow-agents/memory-envelope`, kontourai/flow-agents#1611), but
 * adopting it is a separate decision; until then this reads only the fields
 * the host needs and rejects anything that does not verify:
 *
 * - the claim must pass the Kit's own `assertMemoryClaim`, which recomputes the
 *   content-addressed id, so an edited body is refused;
 * - agreement must be absent or two non-negative integers.
 *
 * The routing decision stored in the envelope is not used at all. It was made
 * against whatever the store held at proposal time, so Station routes again
 * against the store as it is now. Nothing in the envelope says who could see the
 * source: that comes from the root's owner (see `MemoryReviewService`), because
 * a decision that recomputes proves only that it is self-consistent.
 */
export const MEMORY_CLAIM_CATEGORY = 'memory.claim';
const ENVELOPE_VERSION = '1.2';
/** Same ceiling as the Kit's writer, so an honest envelope always fits. */
const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024;

export interface DecodedMemoryEnvelope {
  claim: MemoryClaim;
  agreement: MemoryAgreement | null;
  /** The producer's run: the sitting the claim was distilled from. */
  sittingId: string | null;
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

export function decodeMemoryEnvelope(
  body: unknown,
): DecodedMemoryEnvelope | null {
  if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_ENVELOPE_BYTES)
    return null;
  try {
    const value = JSON.parse(body) as Record<string, unknown> | null;
    if (!value || typeof value !== 'object' || value.dream !== ENVELOPE_VERSION)
      return null;
    assertMemoryClaim(value.claim);
    const agreement = value.agreement as Record<string, unknown> | null;
    if (agreement !== null && agreement !== undefined) {
      if (!isCount(agreement.passes) || !isCount(agreement.agreeing))
        return null;
    }
    const claim = value.claim as MemoryClaim;
    const sitting = value.sitting as { id?: unknown } | null | undefined;
    return {
      claim,
      agreement: (agreement ?? null) as MemoryAgreement | null,
      sittingId:
        typeof sitting?.id === 'string' && sitting.id ? sitting.id : null,
    };
  } catch {
    return null;
  }
}
