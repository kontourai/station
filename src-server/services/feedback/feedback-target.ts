import { createHash } from 'node:crypto';
import { canonicalJson } from '@kontourai/relay';
import type { FeedbackRatingTarget } from '@kontourai/station-contracts/feedback';
import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';

/** Canonical content and execution coordinate only; projection position is deliberately excluded. */
export function createFeedbackRatingTarget(
  conversationId: string,
  message: Pick<ConversationMessage, 'role' | 'parts' | 'metadata'>,
): FeedbackRatingTarget | undefined {
  const sessionId = message.metadata?.sessionId;
  const turnId = message.metadata?.turnId;
  if (
    !conversationId ||
    message.role !== 'assistant' ||
    !sessionId ||
    !turnId ||
    !message.parts.length
  )
    return undefined;
  const contentDigest = createHash('sha256')
    .update(
      canonicalJson({
        role: message.role,
        parts: message.parts,
        sessionId,
        turnId,
      }),
    )
    .digest('hex');
  return { conversationId, sessionId, turnId, contentDigest };
}

/** Raw feedback facts only; derived analysis and projection positions never change evidence identity. */
export function feedbackRatingEvidenceDigest(
  record: import('@kontourai/station-contracts/feedback').FeedbackRatingRecord,
): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        id: record.id,
        conversationId: record.conversationId,
        rating: record.rating,
        reason: record.reason ?? null,
        createdAt: record.createdAt,
        target: record.target ?? null,
      }),
    )
    .digest('hex');
}
