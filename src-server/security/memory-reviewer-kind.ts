import type { MemoryReviewerKind } from '@kontourai/station-contracts/knowledge-memory';
import { isOperatorInPersonNotAgent } from './coding-authority.js';

/**
 * The host's attestation of who is deciding a memory review, read from the
 * authenticated request and never from anything the caller sends.
 *
 * `human` only for the operator in person (the operator credential, a
 * credential minted by proving possession of this Station's home, or one of
 * the owner's own paired devices) on a request that does not declare itself an
 * agent's. Station's internal token and any agent tool call are `agent`, as is
 * a request no auth boundary saw. An agent decision is kept as an annotation
 * and promotes nothing.
 */
export function memoryReviewerKindForRequest(
  request: Request,
): MemoryReviewerKind {
  return isOperatorInPersonNotAgent(request) ? 'human' : 'agent';
}
