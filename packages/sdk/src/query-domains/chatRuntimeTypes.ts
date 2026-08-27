import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import type {
  ConversationListItem,
  OrchestrationSessionDetail,
  OrchestrationSessionSummary,
  RequestAnswerability,
  RequestAnswerabilityQualification,
  SessionBoardItem,
  SessionControlMode,
  TerminalProcessDetail,
  TerminalProcessSummary,
} from '@kontourai/station-contracts/orchestration';
import type { ProviderKind } from '@kontourai/station-contracts/provider';
import type { UIBlock } from '@kontourai/station-contracts/ui-block';

export type OrchestrationProviderKind = ProviderKind;
export type {
  ConversationListItem,
  OrchestrationSessionDetail,
  OrchestrationSessionSummary,
  RequestAnswerability,
  RequestAnswerabilityQualification,
  SessionBoardItem,
  SessionControlMode,
  TerminalProcessDetail,
  TerminalProcessSummary,
};

export interface ConversationSummary {
  id: string;
  resourceId?: string;
  /** S1 of #1302: the project this conversation was created in/for, if any. */
  projectSlug?: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
  /** False when the transcript is owned by an external runtime event store. */
  mutable?: boolean;
}

export interface ConversationLookup {
  id: string;
  agentSlug: string;
  projectSlug?: string;
  title?: string;
  /** Engine-reported identity preferred for a resumed conversation header. */
  model?: string;
  /** Adapter-accepted model restored for the next turn. */
  acceptedModel?: string;
  /** Server-resolved Station/Environment namespace that owns this record. */
  environmentId?: string;
}

export interface ConversationMessagePart {
  type: string;
  content?: string;
  url?: string;
  mediaType?: string;
  name?: string;
  server?: string;
  toolName?: string;
  originalName?: string;
  toolCallId?: string;
  uiBlock?: UIBlock;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
  traceId?: string;
  contentParts?: ConversationMessagePart[];
  /** station#1410: the canonical turn this assistant row projects, when known. */
  turnId?: string;
  /** Execution Session that produced this row; distinct from active chat. */
  sessionId?: string;
  /** Durable authored user-event identity; omitted from optimistic client rows. */
  sourceEventId?: string;
  answerEligible?: boolean;
  /**
   * station#1410: the turn's provenance envelope as the server sent it,
   * intentionally untyped here. Consumers must narrow it through
   * `isSupportedTurnProvenanceEnvelope` rather than casting: an envelope
   * from a different Station version must degrade to an honest unavailable
   * state, not be partially read (#1410 AC5).
   */
  provenance?: unknown;
}

export interface ChatAttachmentInput {
  data: string;
  type: string;
}

export interface OrchestrationProviderSummary {
  provider: OrchestrationProviderKind;
  activeSessions: number;
  prerequisites: Array<{
    id?: string;
    key?: string;
    name: string;
    status: string;
    description?: string;
  }>;
}

/**
 * station#1778: DERIVED from the contracts declaration, not re-listed.
 *
 * This used to be a hand-copied literal union beside a hand-copied
 * `SessionBoardItem` that had already drifted from the server's shape —
 * `transitionReason`/`transitionSource` widened to `string`, and five
 * top-level fields (`environmentId`, `environmentName`, `connectionId`,
 * `taskId`, `parentTaskId`) that no route has ever emitted and no consumer
 * has ever read. A required wire member is only enforcement if the type the
 * client compiles against is the type the server emits; a parallel copy
 * quietly exempts every client from it.
 */
export type SessionBoardLifecycleState = SessionBoardItem['lifecycleState'];

export type OrchestrationCommandInput =
  | {
      type: 'adoptSession';
      sourceThreadId: string;
      idempotencyKey?: string;
    }
  | {
      type: 'respondToRequest';
      threadId: string;
      requestId: string;
      decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel';
    }
  | {
      type: 'interruptTurn';
      threadId: string;
      turnId?: string;
    }
  | {
      type: 'steerTurn';
      threadId: string;
      input: string;
      turnId?: string;
    }
  | {
      type: 'stopSession';
      threadId: string;
    };

export interface OrchestrationCommandReceipt {
  commandId: string;
  threadId: string;
  commandType: OrchestrationCommandInput['type'];
  status: 'accepted' | 'rejected' | 'failed';
  createdAt: string;
  clientOrigin?: ClientOrigin;
}

export interface OrchestrationCommandDispatchResult<T = unknown> {
  receipt: OrchestrationCommandReceipt;
  result: T;
  receiptStatus?: 'unavailable';
}
