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
  ConversationOpenExecution,
  ConversationOpenResolution,
  ConversationTurnActivity,
} from '@kontourai/station-contracts/orchestration';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';

export interface ConversationOpenResolver {
  resolve(input: {
    conversation: ConversationListItem;
    authority: SessionReadAuthority;
    expectedSessionId?: string;
  }): Promise<ConversationOpenResolution>;
}

export function createConversationOpenResolver(deps: {
  currentSessionId(conversationId: string): string;
  readCurrent(input: {
    conversationId: string;
    authority: SessionReadAuthority;
  }): Promise<{
    sessionId: string;
    /**
     * #2424: set when `sessionId` is the authorized predecessor of a reserved
     * lineage child that has not started yet. The conversation is then
     * described by that predecessor; the reservation is the next send's.
     */
    reservedSuccessorSessionId?: string;
    execution?: ConversationOpenExecution;
    messages: readonly ConversationMessage[];
    answerability: ConversationListItem['answerability'];
    canContinue: boolean;
    continuationPending?: boolean;
    /** #2309: the conversation's activity, read with the current child. */
    activity?: ConversationTurnActivity;
  } | null>;
  reportUnavailable?(error: unknown): void;
}): ConversationOpenResolver {
  return {
    async resolve({ conversation, authority, expectedSessionId }) {
      if (conversation.source === 'store') {
        // The runtime picker filters store rows and the point-read route never
        // guesses their owner. Keep this defensive arm total if another caller
        // accidentally supplies one, without promising transcript hydration.
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
        if (
          expectedSessionId !== undefined &&
          currentSessionId !== expectedSessionId
        )
          throw new Error('Conversation child changed during open');
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
        const describedSessionId =
          current.reservedSuccessorSessionId === currentSessionId
            ? current.sessionId
            : currentSessionId;
        if (
          current.sessionId !== describedSessionId ||
          deps.currentSessionId(conversation.id) !== currentSessionId ||
          (current.execution &&
            (current.execution.sessionId !== describedSessionId ||
              current.execution.agentId !== conversation.agentSlug))
        )
          throw new Error('Conversation child changed during open');
        return {
          status: 'resolved',
          conversation,
          currentSessionId: describedSessionId,
          ...(current.execution ? { execution: current.execution } : {}),
          transcript: {
            available: true,
            owner: 'runtime',
            messageCount: current.messages.length,
          },
          canContinue: current.canContinue,
          ...(!current.canContinue && current.continuationPending
            ? { continuationPending: true }
            : {}),
          ...(current.activity ? { activity: current.activity } : {}),
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
