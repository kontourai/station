import { agentId } from '@kontourai/station-contracts/agent-identity';
import type {
  ConversationInboxEntry,
  ConversationInboxQueuedReceipt,
  OrchestrationSessionSummary,
} from '@kontourai/station-contracts/orchestration';
import { isFirstSendFailure } from '@kontourai/station-contracts/session-attention';
import type { SkillExperienceStartInputV1 } from '@kontourai/station-contracts/skill-experience';
import { orchestrationQueries } from '@kontourai/station-sdk';
import {
  type ApiRequestScope,
  type ApprovalPickCarry,
  ForegroundMessageQueuedError,
  queueExecutionMessage,
  sendExecutionMessage,
} from '@kontourai/station-sdk/client';
import { skillExperienceAttachmentInputs } from '@kontourai/station-shared/skill-experience-values';
import type { QueryClient } from '@tanstack/react-query';
import {
  type InboxScope,
  inboxQueryKey,
  inboxReceiptsKey,
} from '../hooks/useConversationInboxSnapshot';
import type { ComposerAttachmentStageSnapshot, FileAttachment } from '../types';
import { resolveTurnModel } from './turnModel';

/**
 * Foreground execution Adapter. This intent-shaped Interface keeps target and
 * attachment mapping beside the canonical `/api/orchestration/chat` call and
 * is loaded only when a user actually sends a message.
 */
type ForegroundInput = {
  apiBase: string;
  sessionId: string;
  agentSlug: string;
  executionAgentId?: string;
  executionOnCurrentStation?: boolean;
  expectedDefinitionFingerprint?: string;
  /**
   * The engine the composer's snapshot showed for this Agent, as a
   * precondition (`ExecutionTarget.expectedEngine`). Sent only for the first
   * send of a chat and only to this Station: it can refuse, never select.
   */
  expectedEngine?: import('@kontourai/station-contracts/execution-target').ResolvedExecutionEngine;
  projectSlug?: string;
  conversationId?: string;
  requestedModel?: string | null;
  requestedProviderOptions?: Record<string, unknown>;
  model?: string;
  providerOptions?: Record<string, unknown>;
  /**
   * #2436: an approval pick the server has not received yet (the chat's
   * `queuedApprovalMode`), with its compare-and-set basis: the sequence of
   * the latest decision the chat had folded when the user picked, `null`
   * when it had folded none. A pick without its basis is refused below.
   */
  setApprovalMode?: import('@kontourai/station-contracts/provider').ApprovalMode;
  setApprovalModeBasedOn?: number | null;
  /**
   * The person's personal per-engine default on a chat's first send: a hint
   * the server applies below the Agent's and the Project's defaults, never a
   * pick (`recordPersonalApprovalDefault`).
   */
  personalApprovalDefault?: import('@kontourai/station-contracts/provider').ApprovalMode;
  message: string;
  mcpPromptOrigin?: import('@kontourai/station-contracts/mcp-prompts').AgentMcpPromptOrigin;
  attachments?: FileAttachment[];
  attachmentStages?: ComposerAttachmentStageSnapshot[];
  ambientContext?: string;
  clientTurnId: string;
  automaticBackground?: boolean;
  skillExperience?: SkillExperienceStartInputV1;
  skillExperienceAttachmentRoles?: string[];
  skillExperienceAttachmentAssignments?: Record<string, string[]>;
  requestScope?: import('@kontourai/station-sdk/client').ClientRequestOptions['requestScope'];
  signal?: AbortSignal;
  /**
   * Called once, immediately before the request is made. A failure thrown
   * before it (a send this Adapter refused to build) reached nothing; one
   * after it proves nothing about delivery.
   */
  onRequest?: () => void;
};

async function foregroundRequest(input: ForegroundInput) {
  // #2436: the pick travels as the message's own `setApprovalMode` with its
  // basis, never as a model option. It survives the `engine-selected` branch
  // below: resetting the model does not withdraw an approval pick.
  if (
    input.setApprovalMode !== undefined &&
    input.setApprovalModeBasedOn === undefined
  ) {
    throw new Error(
      'An approval pick needs the decision it was based on (null when none had been seen).',
    );
  }
  const resolved = resolveTurnModel(input);
  const defaultRequested = resolved.kind === 'engine-selected';
  // No approval posture rides the options (#2436): the server applies the
  // conversation's recorded pick, else the Agent's and this Station's
  // defaults at a session start, whatever path sends the turn.
  const modelOptions = defaultRequested
    ? undefined
    : (input.requestedProviderOptions ?? input.providerOptions);
  const requestedModel = defaultRequested ? undefined : resolved.modelId;
  const attachments = input.attachments ?? [];
  const stages = input.attachmentStages ?? [];
  let attachmentDispatch:
    | { attachments: [] }
    | {
        attachments: import('@kontourai/station-contracts/chat-attachment').ChatAttachmentInput[];
      }
    | {
        attachmentRefs: NonNullable<
          ComposerAttachmentStageSnapshot['reference']
        >[];
      } = { attachments: [] };
  if (attachments.length > 0 || stages.length > 0) {
    const { inlineComposerAttachments } = await import(
      './attachment-staging-queue'
    );
    attachmentDispatch = (() => {
      if (attachments.length === 0) return { attachments: [] };
      const selected = attachments.map((attachment) =>
        stages.find((stage) => stage.clientAttachmentId === attachment.id),
      );
      if (selected.some((stage) => stage?.state !== 'complete')) {
        throw new Error(
          'Attachments must complete supervised staging before Send.',
        );
      }
      if (selected.every((stage) => stage?.delivery === 'legacy-inline')) {
        return { attachments: inlineComposerAttachments(attachments) };
      }
      const references = selected.map((stage) => stage?.reference);
      if (references.some((reference) => !reference)) {
        throw new Error(
          'Completed attachment staging did not provide a safe reference.',
        );
      }
      return {
        attachmentRefs: references as NonNullable<
          ComposerAttachmentStageSnapshot['reference']
        >[],
      };
    })();
    if (attachments.length === 0 && stages.length > 0) {
      if (stages.some((stage) => stage.state !== 'complete')) {
        throw new Error(
          'Attachments must complete supervised staging before Send.',
        );
      }
      if (stages.some((stage) => !stage.reference)) {
        throw new Error(
          'Choose the file again before sending this attachment.',
        );
      }
      attachmentDispatch = {
        attachmentRefs: stages.map((stage) => stage.reference!),
      };
    }
  }
  const approvalPick: ApprovalPickCarry =
    input.setApprovalMode !== undefined
      ? {
          setApprovalMode: input.setApprovalMode,
          setApprovalModeBasedOn: input.setApprovalModeBasedOn ?? null,
        }
      : {};
  const outgoingAttachmentIds =
    'attachmentRefs' in attachmentDispatch
      ? attachmentDispatch.attachmentRefs.map(
          (reference) => reference.clientAttachmentId,
        )
      : attachments.map((attachment) => attachment.id);
  if (
    input.skillExperience &&
    new Set(outgoingAttachmentIds).size !== outgoingAttachmentIds.length
  )
    throw new Error(
      'Composer files must have distinct identities before assigning visual skill roles.',
    );
  const body = {
    target: {
      ...(!input.projectSlug ||
      input.executionAgentId ||
      input.executionOnCurrentStation
        ? { environment: { kind: 'current' as const } }
        : {}),
      agent: input.executionAgentId
        ? {
            kind: 'agent-execution-override' as const,
            agent: agentId(input.agentSlug),
            executionAgent: agentId(input.executionAgentId),
            ...(input.expectedDefinitionFingerprint
              ? {
                  expectedDefinitionFingerprint:
                    input.expectedDefinitionFingerprint,
                }
              : {}),
          }
        : agentId(input.agentSlug),
      ...(input.expectedEngine &&
      (!input.projectSlug ||
        input.executionAgentId ||
        input.executionOnCurrentStation)
        ? { expectedEngine: input.expectedEngine }
        : {}),
      ...(requestedModel || Object.keys(modelOptions ?? {}).length > 0
        ? {
            model: {
              ...(requestedModel ? { override: requestedModel } : {}),
              ...(modelOptions ? { options: modelOptions } : {}),
            },
          }
        : {}),
      ...(input.projectSlug
        ? {
            workspace: {
              kind: 'project' as const,
              projectSlug: input.projectSlug,
            },
          }
        : {}),
    },
    message: input.message,
    ...(input.mcpPromptOrigin
      ? { mcpPromptOrigin: input.mcpPromptOrigin }
      : {}),
    conversationId: input.conversationId ?? input.sessionId,
    ...attachmentDispatch,
    ambientContext: input.ambientContext,
    clientTurnId: input.clientTurnId,
    automaticBackground: input.automaticBackground,
    ...(input.skillExperience
      ? {
          skillExperience: {
            ...input.skillExperience,
            ...(input.skillExperienceAttachmentRoles?.length
              ? {
                  attachmentInputs: skillExperienceAttachmentInputs(
                    input.skillExperienceAttachmentRoles,
                    outgoingAttachmentIds,
                    input.skillExperienceAttachmentAssignments,
                  ),
                }
              : {}),
          },
        }
      : {}),
    ...approvalPick,
    ...(input.personalApprovalDefault &&
    input.personalApprovalDefault !== 'connection-default' &&
    input.setApprovalMode === undefined
      ? { personalApprovalDefault: input.personalApprovalDefault }
      : {}),
  };
  return {
    body,
    options: {
      signal: input.signal,
      ...(input.requestScope ? { requestScope: input.requestScope } : {}),
    },
  };
}

export async function dispatchForeground(input: ForegroundInput) {
  const { body, options } = await foregroundRequest(input);
  input.onRequest?.();
  return sendExecutionMessage(input.apiBase, body, options);
}

function matchesQueuedReceipt(
  input: ForegroundInput,
  { conversationId, clientTurnId, entry }: ConversationInboxQueuedReceipt,
) {
  return (
    !!entry &&
    conversationId === input.conversationId &&
    clientTurnId === input.clientTurnId &&
    entry.conversationId === conversationId &&
    entry.clientTurnId === clientTurnId
  );
}

export async function dispatchPossiblyQueuedForeground(input: ForegroundInput) {
  const { body, options } = await foregroundRequest(input);
  input.onRequest?.();
  try {
    const receipt = await sendExecutionMessage(
      input.apiBase,
      { ...body, whenBusy: 'queue' },
      options,
    );
    return { outcome: 'started' as const, receipt };
  } catch (error) {
    if (error instanceof ForegroundMessageQueuedError) {
      if (
        matchesQueuedReceipt(input, error.receipt) &&
        error.receipt.entry.message === input.message
      )
        return error.receipt;
      throw new TypeError('Station did not confirm this message identity.');
    }
    throw error;
  }
}

export async function dispatchQueuedForeground(input: ForegroundInput) {
  const { body, options } = await foregroundRequest(input);
  if (
    body.setApprovalMode !== undefined ||
    body.setApprovalModeBasedOn !== undefined
  )
    throw new Error(
      'Apply the pending approval choice before queuing a follow-up.',
    );
  input.onRequest?.();
  const result = await queueExecutionMessage(
    input.apiBase,
    {
      ...body,
      setApprovalMode: undefined,
      setApprovalModeBasedOn: undefined,
    },
    options,
  );
  if (result.outcome === 'queued' && !matchesQueuedReceipt(input, result))
    throw new TypeError('Station did not confirm this message identity.');
  return result;
}

export function publishConversationInboxReceipt(
  client: QueryClient,
  scope: InboxScope | undefined,
  apiBase: string,
  receipt: ConversationInboxQueuedReceipt,
) {
  if (!scope?.isCurrent() || scope.apiBase !== apiBase) return;
  const { entry, conversationId, clientTurnId } = receipt;

  const queryKey = inboxQueryKey(scope, conversationId, apiBase);
  const receiptsKey = inboxReceiptsKey(queryKey);
  if (client.getQueryState(receiptsKey)) {
    client.setQueryData<ConversationInboxEntry[]>(receiptsKey, (previous) => [
      ...(previous ?? []).filter((item) => item.clientTurnId !== clientTurnId),
      // The receipt confirms custody. The list read owns queue order.
      { ...entry, position: undefined },
    ]);
  }
  void client.invalidateQueries(
    { queryKey, exact: true },
    { cancelRefetch: false },
  );
}

/**
 * #2310 review H1/F4: whether the cached session list still describes one of
 * these identities as having never taken a send — a Draft, or a Failed row
 * whose only failure is that its sends did not take (`send_refused` /
 * `send_failed`). Either answer is stale the moment a send is accepted, so
 * the send path must re-read the list. Read-only; `undefined` ids skipped.
 */
export function cachedSummaryAwaitsFirstTurn(
  queryClient: QueryClient,
  ids: ReadonlyArray<string | undefined>,
  scope?: ApiRequestScope,
): boolean {
  const wanted = new Set(ids.filter((id): id is string => Boolean(id)));
  const cached =
    queryClient.getQueryData<OrchestrationSessionSummary[]>(
      orchestrationQueries.sessions(scope).queryKey,
    ) ?? [];
  return cached.some(
    (session) =>
      (wanted.has(session.threadId) ||
        (session.conversationId !== undefined &&
          wanted.has(session.conversationId))) &&
      (session.draft === true || isFirstSendFailure(session)),
  );
}
