import { agentId } from '@kontourai/station-contracts/agent-identity';
import { sendExecutionMessage } from '@kontourai/station-sdk/client';
import type { ComposerAttachmentStageSnapshot, FileAttachment } from '../types';
import { resolveTurnModel } from './turnModel';

/**
 * Foreground execution Adapter. This intent-shaped Interface keeps target and
 * attachment mapping beside the canonical `/api/orchestration/chat` call and
 * is loaded only when a user actually sends a message.
 */
export async function dispatchForeground(input: {
  apiBase: string;
  sessionId: string;
  agentSlug: string;
  projectSlug?: string;
  conversationId?: string;
  requestedModel?: string | null;
  requestedProviderOptions?: Record<string, unknown>;
  model?: string;
  providerOptions?: Record<string, unknown>;
  /**
   * #2436: an approval pick the server has not received yet (the chat's
   * `queuedApprovalMode`). It is a server-ordered decision, not a model
   * option: it travels as the message's own `setApprovalMode`, which the
   * server records on receipt before the turn, and it survives the
   * `engine-selected` branch below — resetting the model does not withdraw
   * an approval pick.
   */
  setApprovalMode?: import('@kontourai/station-contracts/provider').ApprovalMode;
  /**
   * The sequence of the latest decision the chat had folded when the user
   * picked (`null`: none): the server records the pick only if no newer
   * decision exists (compare-and-set).
   */
  setApprovalModeBasedOn?: number | null;
  message: string;
  attachments?: FileAttachment[];
  attachmentStages?: ComposerAttachmentStageSnapshot[];
  ambientContext?: string;
  clientTurnId: string;
  automaticBackground?: boolean;
  signal?: AbortSignal;
}) {
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
  return sendExecutionMessage(
    input.apiBase,
    {
      target: {
        ...(!input.projectSlug
          ? { environment: { kind: 'current' as const } }
          : {}),
        agent: agentId(input.agentSlug),
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
      conversationId: input.conversationId ?? input.sessionId,
      ...attachmentDispatch,
      ambientContext: input.ambientContext,
      clientTurnId: input.clientTurnId,
      automaticBackground: input.automaticBackground,
      ...(input.setApprovalMode
        ? {
            setApprovalMode: input.setApprovalMode,
            setApprovalModeBasedOn: input.setApprovalModeBasedOn ?? null,
          }
        : {}),
    },
    { signal: input.signal },
  );
}
