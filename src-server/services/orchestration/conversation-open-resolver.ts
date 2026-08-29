/**
 * The one read authority for opening a conversation selected from inventory.
 *
 * Inventory is deliberately discovery only.  A caller passes the exact row it
 * rendered and one request-derived authority; this Module then reads the
 * current lineage child and its transcript through the same authority.  It
 * never lets a route stitch together an alias-authorized inventory read with
 * a principal-authorized Session read.
 */
import type {
  ConversationListItem,
  ConversationOpenResolution,
} from '@kontourai/station-contracts/orchestration';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';

export interface ConversationOpenResolver {
  resolve(input: {
    conversation: ConversationListItem;
    authority: SessionReadAuthority;
  }): Promise<ConversationOpenResolution>;
}

export function createConversationOpenResolver(deps: {
  currentSessionId(conversationId: string): string;
  readCurrent(input: {
    conversationId: string;
    authority: SessionReadAuthority;
  }): Promise<{
    messages: readonly ConversationMessage[];
    answerability: ConversationListItem['answerability'];
    canContinue: boolean;
  } | null>;
  reportUnavailable?(error: unknown): void;
}): ConversationOpenResolver {
  return {
    async resolve({ conversation, authority }) {
      if (conversation.source === 'store') {
        // Store transcripts are real durable history, but have no
        // orchestration session/continuation authority.  The route hydrates
        // their messages under the same request authority before returning.
        return {
          status: 'unavailable',
          conversation,
          transcript: { available: false, owner: 'store' },
          canContinue: false,
          answerability: conversation.answerability,
          recoveryActions: ['retry', 'start-new'],
        };
      }
      try {
        const currentSessionId = deps.currentSessionId(conversation.id);
        const current = await deps.readCurrent({
          conversationId: conversation.id,
          authority,
        });
        if (!current) {
          return {
            status: 'missing-session',
            conversation,
            transcript: { available: false, owner: 'runtime' },
            canContinue: false,
            answerability: conversation.answerability,
            recoveryActions: ['retry', 'start-new'],
          };
        }
        return {
          status: 'resolved',
          conversation,
          currentSessionId,
          transcript: {
            available: true,
            owner: 'runtime',
            messageCount: current.messages.length,
          },
          canContinue: current.canContinue,
          answerability: current.answerability,
          recoveryActions: [],
        };
      } catch (error) {
        deps.reportUnavailable?.(error);
        return {
          status: 'unavailable',
          conversation,
          transcript: { available: false, owner: 'runtime' },
          canContinue: false,
          answerability: conversation.answerability,
          recoveryActions: ['retry', 'start-new'],
        };
      }
    },
  };
}
