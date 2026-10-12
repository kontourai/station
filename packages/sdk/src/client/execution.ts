import type {
  AgentId,
  EngineId,
} from '@kontourai/station-contracts/agent-identity';
import type { StagedAttachmentReference } from '@kontourai/station-contracts/attachment-staging';
import type { AttentionRequestReference } from '@kontourai/station-contracts/attention';
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
import type {
  SkillExperienceInventoryV1,
  SkillExperienceStartInputV1,
} from '@kontourai/station-contracts/skill-experience';
import {
  readSkillExperienceStartInput,
  sameSkillExperienceIdentity,
  skillExperiencesCanExecute,
} from '@kontourai/station-shared/skill-experience-values';
import {
  envelopeError,
  readEnvelopeFailure,
  StationHttpError,
} from './api-error-message';
import { ChatHttpError } from './chatHttpError';
import { type ClientRequestOptions, getJson, mutateJson } from './http';
import { rethrowDeadline } from './request-deadline';
import { isStationAnswer } from './station-envelope';
/**
 * #2436: an approval-posture decision a send carries (a pick made before the
 * chat had a session, or while offline), and its compare-and-set basis: the
 * sequence of the latest decision the client had folded when the user
 * picked, `null` when it had folded none. The two travel together; a pick
 * without its basis is refused by the server rather than recorded
 * unconditionally.
 */
export type ApprovalPickCarry =
  | { setApprovalMode?: undefined; setApprovalModeBasedOn?: undefined }
  | {
      setApprovalMode: import('@kontourai/station-contracts/provider').ApprovalMode;
      setApprovalModeBasedOn: number | null;
    };

export type ForegroundMessageInput = ForegroundMessageFields &
  ApprovalPickCarry & { skillExperience?: SkillExperienceStartInputV1 };

interface ForegroundMessageFields {
  expectedInputRequest?: AttentionRequestReference;
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
  /** Uses the fixed, more-restrictive automatic replay route. */
  automaticBackground?: boolean;
}

export interface ForegroundMessageReceipt {
  conversationId: string;
  sessionId: string;
  /** Exact provider identity required for accepted outbound settlement. */
  providerTurnId: string;
  target: { kind: 'agent'; id: AgentId };
  resolution: ExecutionResolutionReceipt;
  handoff?: ConversationHandoffReceipt;
  /**
   * #2436: what became of the approval pick the send carried. Absent when it
   * carried none, or the Station that ran it predates the command; a client
   * must then treat the pick as not yet received.
   */
  approvalMode?: import('@kontourai/station-contracts/orchestration').SetApprovalModeResult;
}

export interface ConversationHandoffReceipt {
  predecessorSessionId: string;
  sessionId: string;
  currentSessionId: string;
  outcome: 'created' | 'existing';
  target: {
    agentId: AgentId;
    executionAgentId?: AgentId;
    provider?: EngineId;
    expectedDefinitionFingerprint?: string;
    engine: ExecutionResolutionReceipt['engine'];
    modelId?: string;
  };
  carried: readonly string[];
  reset: readonly string[];
}

/** Typed foreground refusal: inspect the returned session; do not retry start. */
export class ForegroundMessageIndeterminateError extends ChatHttpError {
  override readonly code = FOREGROUND_MESSAGE_INDETERMINATE_CODE;
  readonly outcome = 'indeterminate' as const;
  readonly detail: ForegroundMessageIndeterminate;

  /**
   * The client builds it from the envelope helper's error (#2708), keeping
   * status, `details` and `Retry-After`; Station's server code keeps the
   * positional form.
   */
  constructor(
    failure: StationHttpError,
    detail: ForegroundMessageIndeterminate,
  );
  constructor(
    status: number,
    message: string,
    detail: ForegroundMessageIndeterminate,
  );
  constructor(
    first: number | StationHttpError,
    second: string | ForegroundMessageIndeterminate,
    third?: ForegroundMessageIndeterminate,
  ) {
    super(
      typeof first === 'number'
        ? new StationHttpError(first, second as string, {
            code: FOREGROUND_MESSAGE_INDETERMINATE_CODE,
          })
        : first,
      // Only Station's own answer names this outcome with its detail.
      true,
    );
    this.detail = (
      typeof first === 'number' ? third : second
    ) as ForegroundMessageIndeterminate;
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

/** A refused execution request, marked with whether Station answered it. */
function chatRefusal(
  response: Response,
  body: unknown,
  fallback: string,
): ChatHttpError {
  return new ChatHttpError(
    envelopeError(response, body, fallback),
    isStationAnswer(response, body),
  );
}

/**
 * The parsed body. A failure whose body is not JSON (a proxy's HTML 502)
 * throws a `ChatHttpError` with the status it arrived under (#2708); an
 * unreadable 2xx is a protocol failure and rethrows the parse error.
 */
async function readExecutionBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    rethrowDeadline(error);
    if (!response.ok) {
      const failed = `Execution API error: ${response.status}`;
      throw chatRefusal(response, undefined, failed);
    }
    throw error;
  }
}

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
        envelopeError(
          response,
          result,
          'Foreground session start is indeterminate.',
        ),
        detail,
      );
    }
    if (
      result.code === FOREGROUND_MESSAGE_INDETERMINATE_CODE &&
      result.outcome === 'indeterminate'
    ) {
      const failure = readEnvelopeFailure(
        response,
        result,
        'Foreground message may have started.',
      );
      throw providerTurnIdentityUnavailable(failure.message);
    }
    const failed = `Execution API error: ${response.status}`;
    throw chatRefusal(response, result, failed);
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

/** Reads installed visual skill inventory for a source-bound start. */
export type SkillExperienceInventoryReader = (
  apiBase: string,
  opts?: ClientRequestOptions,
) => Promise<SkillExperienceInventoryV1>;

/**
 * `sendExecutionMessage` with the inventory reader supplied by the caller.
 * This module does not import the static reader (#3209): first-paint code
 * imports it for the other execution calls, and an import here would carry
 * the canonical validator into that chunk.
 */
export async function sendExecutionMessageWithInventory(
  apiBase: string,
  input: ForegroundMessageInput,
  readInventory: SkillExperienceInventoryReader,
  opts?: ClientRequestOptions,
): Promise<ForegroundMessageReceipt> {
  if (input.skillExperience) {
    if (input.automaticBackground)
      throw new Error(
        'Visual skill starts require an explicit foreground send.',
      );
    if (!readSkillExperienceStartInput(input.skillExperience))
      throw new Error('The selected visual skill input is unsupported.');
    const inventory = await readInventory(apiBase, opts);
    if (!skillExperiencesCanExecute(inventory))
      throw new Error(
        'This Station cannot execute visual skill starts. Your selection has not been sent.',
      );
    if (
      !inventory.experiences.some((entry) =>
        sameSkillExperienceIdentity(
          entry.identity,
          input.skillExperience!.identity,
        ),
      )
    )
      throw new Error(
        'The selected visual skill source changed or is unavailable. Review it before starting.',
      );
  }
  const { automaticBackground, ...body } = input;
  const response = await mutateJson(
    `${apiBase}/api/orchestration/chat${automaticBackground ? '/background' : ''}`,
    'POST',
    opts,
    body,
  );
  const result = (await readExecutionBody(response)) as ExecutionErrorResponse;
  return readExecutionReceipt(response, result);
}

export type ContinueForegroundMessageInput = Omit<
  ForegroundMessageFields,
  'target' | 'conversationId'
> & { environment?: EnvironmentRef; model?: ExecutionModelRequest };

/** Continue an existing conversation through its server-verified Agent binding. */
export async function continueExecutionMessage(
  apiBase: string,
  conversationId: string,
  input: ContinueForegroundMessageInput,
  opts?: ClientRequestOptions,
): Promise<ForegroundMessageReceipt> {
  if ('skillExperience' in input && input.skillExperience !== undefined)
    throw new Error(
      'Visual skill starts use the canonical foreground chat route.',
    );
  const response = await mutateJson(
    `${apiBase}/api/orchestration/chat/${encodeURIComponent(conversationId)}/continue`,
    'POST',
    opts,
    input,
  );
  const result = (await readExecutionBody(response)) as ExecutionErrorResponse;
  return readExecutionReceipt(response, result);
}

/** Explicitly hand a durable conversation to another configured Agent/engine. */
export async function handoffExecutionMessage(
  apiBase: string,
  conversationId: string,
  input: Omit<ForegroundMessageFields, 'conversationId'> &
    ApprovalPickCarry & {
      idempotencyKey: string;
    },
  opts?: ClientRequestOptions,
): Promise<ForegroundMessageReceipt & { handoff: ConversationHandoffReceipt }> {
  if ('skillExperience' in input && input.skillExperience !== undefined)
    throw new Error(
      'Visual skill starts use the canonical foreground chat route.',
    );
  const response = await mutateJson(
    `${apiBase}/api/orchestration/conversations/${encodeURIComponent(conversationId)}/handoff`,
    'POST',
    opts,
    input,
  );
  const result = (await readExecutionBody(response)) as ExecutionErrorResponse;
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
  const result = (await readExecutionBody(response)) as {
    success?: boolean;
    data?: ConversationHandoffStatusProjection;
    error?: string;
    code?: string;
  };
  if (!response.ok || !result.success || !result.data) {
    throw chatRefusal(
      response,
      result,
      'Conversation handoff status is unavailable.',
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
  const result = (await readExecutionBody(response)) as {
    success?: boolean;
    data?: ConversationContextBoundaryProjection;
    error?: string;
    code?: string;
  };
  if (!response.ok || !result.success || !result.data)
    throw chatRefusal(
      response,
      result,
      'Conversation context boundary is unavailable.',
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
  const result = (await readExecutionBody(response)) as {
    success?: boolean;
    data?: ConversationContextBoundaryProjection;
    error?: string;
    code?: string;
  };
  if (!response.ok || !result.success || !result.data)
    throw chatRefusal(
      response,
      result,
      'Conversation context boundary is unavailable.',
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
  const result = (await readExecutionBody(response)) as {
    success?: boolean;
    data?: ConversationContextBoundaryProjection;
    error?: string;
    code?: string;
  };
  if (!response.ok || !result.success || !result.data)
    throw chatRefusal(
      response,
      result,
      'Conversation context boundary cannot be cancelled.',
    );
  return result.data;
}
