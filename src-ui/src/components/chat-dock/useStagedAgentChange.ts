import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import { STAGED_CONVERSATION_HANDOFF_PREVIEW } from '@kontourai/station-contracts/orchestration';
import { useFeaturePreviewsQuery } from '@kontourai/station-sdk';
import type { ClientRequestOptions } from '@kontourai/station-sdk/client';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useRef, useState } from 'react';
import {
  activeChatsStore,
  useActiveChatActions,
} from '../../contexts/ActiveChatsContext';
import type { AgentData } from '../../contexts/AgentsContext';
import { chatDraftsStore } from '../../contexts/chat-drafts-store';
import type { useChatInput } from '../../hooks/useChatInput';
import type { StagedHandoffAttempt } from '../../lib/staged-handoff-attempt-store';
import type { ChatSession } from '../../types';
import { describeStationFailure } from '../../utils/stationFailure';

function retainedSendKey(storageKey: string): string | undefined {
  try {
    return localStorage.getItem(storageKey) ?? undefined;
  } catch {
    return undefined;
  }
}

function isStationRefusal(error: unknown, status?: number): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'stationEnvelope' in error &&
    error.stationEnvelope === true &&
    'status' in error &&
    typeof error.status === 'number' &&
    (status === undefined ? error.status < 500 : error.status === status) &&
    (!('outcome' in error) || error.outcome !== 'indeterminate')
  );
}

type Selection = {
  agent: AgentData;
  executionAgent?: AgentData;
  connectionId?: string;
  sourceSessionId: string;
  modelId?: string;
  options: Record<string, unknown>;
};

export function useStagedAgentChange({
  apiBase,
  chat,
  composer,
  scope,
  scopeIsCurrent,
  recoveryAuthority,
  agents,
  blockedReason,
  onAccepted,
  report,
}: {
  apiBase: string;
  chat: ChatSession | null;
  composer: Pick<
    ReturnType<typeof useChatInput>,
    | 'prepareOutgoingText'
    | 'attachments'
    | 'attachmentStages'
    | 'handleClearInput'
    | 'cancelAttachmentStage'
  >;
  scope: ClientRequestOptions['requestScope'];
  scopeIsCurrent?: () => boolean;
  recoveryAuthority?: string;
  agents: readonly AgentData[];
  blockedReason?: string;
  onAccepted: () => void;
  report: (message: string) => void;
}) {
  const { updateChat } = useActiveChatActions();
  const previews = useFeaturePreviewsQuery(
    apiBase,
    { enabled: Boolean(chat && scope) },
    scope,
  );
  const enabled =
    Boolean(recoveryAuthority && scopeIsCurrent?.()) &&
    previews.data?.some(
      (preview) =>
        preview.id === STAGED_CONVERSATION_HANDOFF_PREVIEW.id &&
        preview.enabled,
    ) === true;
  const key = JSON.stringify([
    apiBase,
    recoveryAuthority,
    chat?.conversationId,
  ]);
  const storageKey = `station.staged-handoff.v1:${key}`;
  const restoredKey =
    chat?.conversationId && recoveryAuthority
      ? retainedSendKey(storageKey)
      : undefined;
  const [plan, setPlan] = useState<{ key: string; selection: Selection }>();
  const [attemptState, setAttemptState] = useState<{
    key: string;
    sending: boolean;
  }>();
  const attempt = useRef<StagedHandoffAttempt | undefined>(undefined);
  const [retryKey, setRetryKey] = useState<string>();
  const sending = useRef(false);
  const selected = plan?.key === key ? plan.selection : undefined;
  const pending =
    attemptState?.key === key && attemptState.sending
      ? { sending: true }
      : restoredKey
        ? { sending: false }
        : undefined;
  const clearAttempt = async () => {
    const { stagedHandoffAttempts } = await import(
      '../../lib/staged-handoff-attempt-store'
    );

    await stagedHandoffAttempts.remove(storageKey);
    localStorage.removeItem(storageKey);
    if (attempt.current?.key === key) attempt.current = undefined;
    setRetryKey(undefined);
  };

  const stage = (
    agent: AgentData,
    executionAgent?: AgentData,
    modelId?: string,
    resetEngine = false,
  ) => {
    if (
      sending.current ||
      !chat?.currentSessionId ||
      !chat.conversationId ||
      !scopeIsCurrent?.() ||
      pending
    )
      return;
    if (
      !resetEngine &&
      agent.slug === chat.agentSlug &&
      (!executionAgent || executionAgent.slug === chat.executionAgentId)
    ) {
      setPlan(undefined);
      return;
    }
    setPlan({
      key,
      selection: {
        agent,
        executionAgent,
        connectionId:
          (executionAgent ?? agent).execution?.agentConnectionId ?? undefined,
        sourceSessionId: chat.currentSessionId,
        modelId,
        options: {},
      },
    });
  };

  const changeModel = (modelId?: string) => {
    if (selected && !pending)
      setPlan({ key, selection: { ...selected, modelId, options: {} } });
  };

  const changeOption = (option: string, value: unknown) => {
    if (!selected || pending) return;
    const options = { ...selected.options };
    if (value === undefined) delete options[option];
    else options[option] = value;
    setPlan({ key, selection: { ...selected, options } });
  };

  const send = async (ambientContext?: string) => {
    if (
      !chat?.conversationId ||
      !scope ||
      !recoveryAuthority ||
      !scopeIsCurrent?.() ||
      sending.current
    )
      return;
    const conversationId = chat.conversationId;
    let retry = attempt.current?.key === key ? attempt.current : undefined;
    if (!restoredKey && !selected) return;
    if (attempt.current && attempt.current.key !== key && !restoredKey) {
      report('Check the earlier Agent change before sending another one.');
      return;
    }
    if (
      !retry &&
      !restoredKey &&
      (!enabled ||
        blockedReason ||
        chat.currentSessionId !== selected?.sourceSessionId)
    ) {
      report(
        blockedReason ??
          'The Agent change is no longer current. Choose the Agent again.',
      );
      return;
    }
    sending.current = true;
    setAttemptState({ key, sending: true });
    let dispatched = false;
    try {
      const [
        { createStagedHandoffTransport },
        { outboundDispatch },
        { acceptConversationHandoffUiState },
      ] = await Promise.all([
        import('../conversation/conversation-transport'),
        import('../../lib/outboundQueue'),
        import('./conversationHandoffUiState'),
      ]);
      const transport = createStagedHandoffTransport(
        apiBase,
        scope,
        scopeIsCurrent,
      );
      const { stagedHandoffAttempts } = await import(
        '../../lib/staged-handoff-attempt-store'
      );
      if (restoredKey) {
        const observed = await transport
          .read(conversationId, restoredKey)
          .catch((error: unknown) => {
            if (!isStationRefusal(error, 404)) throw error;
            return null;
          });
        if (!scopeIsCurrent()) return;
        if (
          observed?.providerTurnId &&
          ['accepted', 'completed', 'failed'].includes(observed.status)
        ) {
          await clearAttempt();
          setPlan(undefined);
          onAccepted();
          report(
            'Station found the earlier message. Review the conversation before sending the draft again.',
          );
          return;
        }
        if (observed && observed.status !== 'reserved') {
          report(
            'Station has not confirmed the earlier message. Your draft is still here.',
          );
          return;
        }
        if (!retry) {
          const retained = await stagedHandoffAttempts.read(storageKey);
          if (
            !retained ||
            retained.key !== key ||
            retained.request.idempotencyKey !== restoredKey
          ) {
            report(
              'The original request is unavailable. Your draft is still here.',
            );
            return;
          }
          if (retryKey !== restoredKey) {
            setRetryKey(restoredKey);
            report('Retry Send to submit the original request.');
            return;
          }
          retry = retained;
        }
      }
      let submission = retry;
      if (!submission) {
        if (!selected) return;
        const prepared = await composer.prepareOutgoingText();
        if (!prepared) return;
        if ('refused' in prepared) {
          report(prepared.refused);
          return;
        }
        const { attachments, attachmentStages } = composer;
        if (
          attachments.some((file) => !file.data) ||
          attachmentStages.some(
            (stage) =>
              stage.state !== 'complete' ||
              !attachments.some(
                (file) => file.id === stage.clientAttachmentId && file.data,
              ),
          )
        ) {
          report(
            'Reattach the files in this draft before sending to the new Agent.',
          );
          return;
        }
        const { inlineComposerAttachments } = await import(
          '../../lib/attachment-staging-queue'
        );
        if (!prepared.text.trim() && !attachments.length) return;
        if (prepared.draft.startsWith('/')) {
          report('Undo the Agent change before sending a command.');
          return;
        }
        const idempotencyKey = randomCorrelationId();
        const model = {
          override: selected.modelId,
          options: Object.keys(selected.options).length
            ? selected.options
            : undefined,
        };
        submission = {
          key,
          draft: prepared.draft,
          quotes: prepared.quotes,
          attachmentIds: attachments.map((file) => file.id),
          request: {
            idempotencyKey,
            clientTurnId: `handoff:${idempotencyKey}`,
            message: prepared.text,
            ambientContext,
            attachments: inlineComposerAttachments(attachments),
            stagedHandoff: {
              expectedCurrentSessionId: selected.sourceSessionId,
              contextPolicy: 'continue-from-history',
            },
            target: {
              environment: { kind: 'current' },
              agent: selected.executionAgent
                ? {
                    kind: 'agent-execution-override',
                    agent: selected.agent.slug,
                    executionAgent: selected.executionAgent.slug,
                    expectedDefinitionFingerprint:
                      selected.agent.definitionFingerprint,
                  }
                : agentId(selected.agent.slug),
              expectedEngine: selected.connectionId
                ? {
                    kind: 'connection',
                    connectionId: engineConnectionId(selected.connectionId),
                  }
                : { kind: 'station' },
              model,
              ...(chat.projectSlug
                ? {
                    workspace: {
                      kind: 'project',
                      projectSlug: chat.projectSlug,
                    },
                  }
                : {}),
            },
          },
        };
      }
      const exact = submission;
      const result = await outboundDispatch.fenceConversationHandoff(
        { conversationId, sessionId: chat.id },
        async () => {
          if (!scopeIsCurrent())
            throw new Error('The Station connection changed.');
          if (
            activeChatsStore.getSnapshot()[chat.id]?.queuedApprovalMode !==
            undefined
          )
            throw new Error(
              'Settle the queued approval choice before switching Agents.',
            );
          const earlier = retainedSendKey(storageKey);
          if (earlier && earlier !== exact.request.idempotencyKey)
            throw new Error(
              'Check the earlier Agent change before sending another one.',
            );
          await stagedHandoffAttempts.write(storageKey, exact);
          try {
            localStorage.setItem(storageKey, exact.request.idempotencyKey);
          } catch (error) {
            await stagedHandoffAttempts.remove(storageKey);
            throw error;
          }
          attempt.current = exact;
          if (!scopeIsCurrent())
            throw new Error('The Station connection changed.');
          if (
            activeChatsStore.getSnapshot()[chat.id]?.queuedApprovalMode !==
            undefined
          )
            throw new Error(
              'Settle the queued approval choice before switching Agents.',
            );
          dispatched = true;
          return transport.send(conversationId, exact.request);
        },
      );
      if (result.status === 'blocked') {
        report('Send or discard queued messages before switching Agents.');
        return;
      }
      if (!scopeIsCurrent()) return;
      const state = activeChatsStore.getSnapshot()[chat.id];
      const receipt = result.value.handoff;
      if (state?.currentSessionId === receipt.predecessorSessionId) {
        updateChat(
          chat.id,
          acceptConversationHandoffUiState(
            state,
            agents.find((agent) => agent.slug === receipt.target.agentId),
            receipt,
            agents.find(
              (agent) => agent.slug === receipt.target.executionAgentId,
            ),
          ),
        );
      }
      if (
        state?.currentSessionId !== receipt.predecessorSessionId &&
        state?.currentSessionId !== receipt.currentSessionId
      ) {
        await clearAttempt();
        setPlan(undefined);
        onAccepted();
        return;
      }
      const quotes = chatDraftsStore.getQuotes(chat.id);
      if (
        state?.input === exact.draft &&
        quotes.every((quote) => exact.quotes.includes(quote))
      ) {
        composer.handleClearInput();
      }
      chatDraftsStore.consumeQuotes(chat.id, exact.quotes);
      if (state && exact.attachmentIds.length) {
        const consumed = new Set(
          state.attachments
            .filter((file) =>
              exact.attachmentIds.some(
                (id, index) =>
                  id === file.id &&
                  exact.request.attachments?.[index]?.dataUrl === file.data,
              ),
            )
            .map((file) => file.id),
        );
        for (const id of consumed) void composer.cancelAttachmentStage(id);
        updateChat(chat.id, {
          attachments: state.attachments.filter(
            (file) => !consumed.has(file.id),
          ),
          attachmentStages: (state.attachmentStages ?? []).filter(
            (stage) => !consumed.has(stage.clientAttachmentId),
          ),
        });
      }
      await clearAttempt();
      setPlan(undefined);
      onAccepted();
    } catch (error) {
      if (scopeIsCurrent() && dispatched && !retry && isStationRefusal(error)) {
        const exact = attempt.current;
        if (exact) {
          const { createStagedHandoffTransport } = await import(
            '../conversation/conversation-transport'
          );
          const transport = createStagedHandoffTransport(
            apiBase,
            scope,
            scopeIsCurrent,
          );
          await transport
            .read(conversationId, exact.request.idempotencyKey)
            .catch(async (statusError: unknown) => {
              if (scopeIsCurrent() && isStationRefusal(statusError, 404))
                await clearAttempt();
            });
        }
      }
      report(
        attempt.current
          ? 'Station has not confirmed the Agent change. Send again to retry the same request.'
          : describeStationFailure(error).body,
      );
    } finally {
      sending.current = false;
      setAttemptState({ key, sending: false });
    }
  };

  return {
    enabled,
    previewChecking: Boolean(
      chat &&
        scope &&
        (previews.data === undefined ||
          (!recoveryAuthority &&
            previews.data.some(
              (preview) =>
                preview.id === STAGED_CONVERSATION_HANDOFF_PREVIEW.id &&
                preview.enabled,
            ))),
    ),
    selected,
    pending,
    canRetry: Boolean(
      attempt.current?.key === key || (restoredKey && retryKey === restoredKey),
    ),
    stage,
    changeModel,
    changeOption,
    send,
    undo: () => {
      if (!pending) setPlan(undefined);
    },
  };
}
