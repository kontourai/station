import type { AgentId } from '@kontourai/station-contracts/agent-identity';
import type { StagedAttachmentReference } from '@kontourai/station-contracts/attachment-staging';
import type { ChatAttachmentInput } from '@kontourai/station-contracts/chat-attachment';
import type {
  ConversationContextBoundaryProjection,
  ConversationContextBoundaryRequest,
} from '@kontourai/station-contracts/conversation-context-boundary';
import type {
  EnvironmentRef,
  ExecutionModelRequest,
  ExecutionResolutionReceipt,
  ExecutionTarget,
} from '@kontourai/station-contracts/execution-target';
import {
  type ConversationHandoffStatusProjection,
  FOREGROUND_MESSAGE_INDETERMINATE_CODE,
  type ForegroundMessageIndeterminate,
} from '@kontourai/station-contracts/orchestration';
import { apiErrorMessage } from './api-error-message';
import { ChatHttpError } from './chatHttpError';
import { type ClientRequestOptions, getJson, mutateJson } from './http';
export interface ForegroundMessageInput {
  target: Omit<ExecutionTarget, 'environment'> & {
    environment?: EnvironmentRef;
  };
  message: string;
  conversationId?: string;
  attachments?: ChatAttachmentInput[];
  /** Byte-free current-host staging references; hydrated only at provider dispatch. */
  attachmentRefs?: StagedAttachmentReference[];
  /** Ambient model context kept out of the persisted/rendered user turn. */
  ambientContext?: string;
  /** Stable client idempotency key reused for retry and offline replay. */
  clientTurnId?: string;
}

export interface ForegroundMessageReceipt {
  conversationId: string;
  sessionId: string;
  /** Exact provider identity required for accepted outbound settlement. */
  providerTurnId: string;
  target: { kind: 'agent'; id: AgentId };
  resolution: ExecutionResolutionReceipt;
  handoff?: ConversationHandoffReceipt;
}

export interface ConversationHandoffReceipt {
  predecessorSessionId: string;
  sessionId: string;
  currentSessionId: string;
  outcome: 'created' | 'existing';
  target: {
    agentId: AgentId;
    engine: ExecutionResolutionReceipt['engine'];
    modelId?: string;
  };
  carried: readonly string[];
  reset: readonly string[];
}

/** Typed foreground refusal: inspect the returned session; do not retry start. */
export class ForegroundMessageIndeterminateError extends ChatHttpError {
  readonly code = FOREGROUND_MESSAGE_INDETERMINATE_CODE;
  readonly outcome = 'indeterminate' as const;

  constructor(
    status: number,
    message: string,
    readonly detail: ForegroundMessageIndeterminate,
  ) {
    super(status, message, FOREGROUND_MESSAGE_INDETERMINATE_CODE);
    this.name = 'ForegroundMessageIndeterminateError';
  }
}

type ExecutionErrorResponse = {
  success: boolean;
  data?: ForegroundMessageReceipt;
  error?: string;
  code?: string;
  outcome?: unknown;
  receipt?: unknown;
  receiptStatus?: unknown;
  session?: unknown;
};

function providerTurnIdentityUnavailable(message: string): ChatHttpError & {
  outcome: 'indeterminate';
} {
  const error = new ChatHttpError(
    409,
    message,
    FOREGROUND_MESSAGE_INDETERMINATE_CODE,
  ) as ChatHttpError & { outcome: 'indeterminate' };
  error.outcome = 'indeterminate';
  return error;
}

function indeterminateDetail(
  result: ExecutionErrorResponse,
): ForegroundMessageIndeterminate | null {
  if (
    result.code !== FOREGROUND_MESSAGE_INDETERMINATE_CODE ||
    result.outcome !== 'indeterminate' ||
    result.receiptStatus !== 'unavailable' ||
    typeof result.receipt !== 'object' ||
    result.receipt === null ||
    typeof result.session !== 'object' ||
    result.session === null
  ) {
    return null;
  }
  return {
    code: FOREGROUND_MESSAGE_INDETERMINATE_CODE,
    outcome: 'indeterminate',
    receipt: result.receipt as ForegroundMessageIndeterminate['receipt'],
    receiptStatus: 'unavailable',
    session: result.session as ForegroundMessageIndeterminate['session'],
  };
}

function readExecutionReceipt(
  response: Response,
  result: ExecutionErrorResponse,
): ForegroundMessageReceipt {
  if (!response.ok || !result.success || !result.data) {
    const detail = indeterminateDetail(result);
    if (detail) {
      throw new ForegroundMessageIndeterminateError(
        response.status,
        apiErrorMessage(result, 'Foreground session start is indeterminate.'),
        detail,
      );
    }
    if (
      result.code === FOREGROUND_MESSAGE_INDETERMINATE_CODE &&
      result.outcome === 'indeterminate'
    ) {
      throw providerTurnIdentityUnavailable(
        apiErrorMessage(result, 'Foreground message may have started.'),
      );
    }
    throw new ChatHttpError(
      response.status,
      apiErrorMessage(result, `Execution API error: ${response.status}`),
      result.code,
    );
  }
  if (
    typeof result.data.providerTurnId !== 'string' ||
    !result.data.providerTurnId
  ) {
    // A response can only be an accepted foreground receipt when it carries
    // the exact provider turn terminal correlation. Treat an older/broken
    // peer response as possible-effect rather than allowing a queue Adapter
    // to settle it by session identity.
    throw providerTurnIdentityUnavailable(
      'Foreground message may have started but the provider turn id is unavailable.',
    );
  }
  return result.data;
}

export async function sendExecutionMessage(
  apiBase: string,
  input: ForegroundMessageInput,
  opts?: ClientRequestOptions,
): Promise<ForegroundMessageReceipt> {
  const response = await mutateJson(
    `${apiBase}/api/orchestration/chat`,
    'POST',
    opts,
    input,
  );
  const result = (await response.json()) as ExecutionErrorResponse;
  return readExecutionReceipt(response, result);
}

export type ContinueForegroundMessageInput = Omit<
  ForegroundMessageInput,
  'target' | 'conversationId'
> & { environment?: EnvironmentRef; model?: ExecutionModelRequest };

/** Continue an existing conversation through its server-verified Agent binding. */
export async function continueExecutionMessage(
  apiBase: string,
  conversationId: string,
  input: ContinueForegroundMessageInput,
  opts?: ClientRequestOptions,
): Promise<ForegroundMessageReceipt> {
  const response = await mutateJson(
    `${apiBase}/api/orchestration/chat/${encodeURIComponent(conversationId)}/continue`,
    'POST',
    opts,
    input,
  );
  const result = (await response.json()) as ExecutionErrorResponse;
  return readExecutionReceipt(response, result);
}

/** Explicitly hand a durable conversation to another configured Agent/engine. */
export async function handoffExecutionMessage(
  apiBase: string,
  conversationId: string,
  input: Omit<ForegroundMessageInput, 'conversationId'> & {
    idempotencyKey: string;
  },
  opts?: ClientRequestOptions,
): Promise<ForegroundMessageReceipt & { handoff: ConversationHandoffReceipt }> {
  const response = await mutateJson(
    `${apiBase}/api/orchestration/conversations/${encodeURIComponent(conversationId)}/handoff`,
    'POST',
    opts,
    input,
  );
  const result = (await response.json()) as ExecutionErrorResponse;
  const receipt = readExecutionReceipt(response, result);
  if (!receipt.handoff) {
    throw providerTurnIdentityUnavailable(
      'Agent/engine handoff may have started but did not return its durable marker.',
    );
  }
  return receipt as ForegroundMessageReceipt & {
    handoff: ConversationHandoffReceipt;
  };
}

/** Observe durable handoff effect truth without replaying mutable target setup. */
export async function getConversationHandoffStatus(
  apiBase: string,
  conversationId: string,
  idempotencyKey: string,
  opts?: ClientRequestOptions,
): Promise<ConversationHandoffStatusProjection> {
  const response = await getJson(
    `${apiBase}/api/orchestration/conversations/${encodeURIComponent(conversationId)}/handoffs/${encodeURIComponent(idempotencyKey)}`,
    opts,
  );
  const result = (await response.json()) as {
    success?: boolean;
    data?: ConversationHandoffStatusProjection;
    error?: string;
    code?: string;
  };
  if (!response.ok || !result.success || !result.data) {
    throw new ChatHttpError(
      response.status,
      apiErrorMessage(result, 'Conversation handoff status is unavailable.'),
      result.code,
    );
  }
  return result.data;
}

/** Reserve one deliberate next-context replacement; the following cold start consumes it. */
export async function reserveConversationContextBoundary(
  apiBase: string,
  conversationId: string,
  input: ConversationContextBoundaryRequest,
  opts?: ClientRequestOptions,
): Promise<ConversationContextBoundaryProjection> {
  const response = await mutateJson(
    `${apiBase}/api/orchestration/conversations/${encodeURIComponent(conversationId)}/context-boundary`,
    'POST',
    opts,
    input,
  );
  const result = (await response.json()) as {
    success?: boolean;
    data?: ConversationContextBoundaryProjection;
    error?: string;
    code?: string;
  };
  if (!response.ok || !result.success || !result.data)
    throw new ChatHttpError(
      response.status,
      apiErrorMessage(result, 'Conversation context boundary is unavailable.'),
      result.code,
    );
  return result.data;
}

export async function getConversationContextBoundaryStatus(
  apiBase: string,
  conversationId: string,
  idempotencyKey: string,
  opts?: ClientRequestOptions,
): Promise<ConversationContextBoundaryProjection> {
  const response = await getJson(
    `${apiBase}/api/orchestration/conversations/${encodeURIComponent(conversationId)}/context-boundary/${encodeURIComponent(idempotencyKey)}`,
    opts,
  );
  const result = (await response.json()) as {
    success?: boolean;
    data?: ConversationContextBoundaryProjection;
    error?: string;
    code?: string;
  };
  if (!response.ok || !result.success || !result.data)
    throw new ChatHttpError(
      response.status,
      apiErrorMessage(result, 'Conversation context boundary is unavailable.'),
      result.code,
    );
  return result.data;
}

export async function cancelConversationContextBoundary(
  apiBase: string,
  conversationId: string,
  idempotencyKey: string,
  opts?: ClientRequestOptions,
): Promise<ConversationContextBoundaryProjection> {
  const response = await mutateJson(
    `${apiBase}/api/orchestration/conversations/${encodeURIComponent(conversationId)}/context-boundary/${encodeURIComponent(idempotencyKey)}`,
    'DELETE',
    opts,
  );
  const result = (await response.json()) as {
    success?: boolean;
    data?: ConversationContextBoundaryProjection;
    error?: string;
    code?: string;
  };
  if (!response.ok || !result.success || !result.data)
    throw new ChatHttpError(
      response.status,
      apiErrorMessage(
        result,
        'Conversation context boundary cannot be cancelled.',
      ),
      result.code,
    );
  return result.data;
}
