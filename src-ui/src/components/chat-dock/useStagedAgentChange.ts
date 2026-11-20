import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import { STAGED_CONVERSATION_HANDOFF_PREVIEW } from '@kontourai/station-contracts/orchestration';
import { useFeaturePreviewsQuery } from '@kontourai/station-sdk';
import type {
  ClientRequestOptions,
  handoffExecutionMessage,
} from '@kontourai/station-sdk/client';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useRef, useState } from 'react';
import {
  activeChatsStore,
  useActiveChatActions,
} from '../../contexts/ActiveChatsContext';
import type { AgentData } from '../../contexts/AgentsContext';
import { chatDraftsStore } from '../../contexts/chat-drafts-store';
import type { useChatInput } from '../../hooks/useChatInput';
import type { ChatSession } from '../../types';
import { describeStationFailure } from '../../utils/stationFailure';

type Request = Parameters<typeof handoffExecutionMessage>[2];
function retainedSendKey(storageKey: string): string | undefined {
  try {
    return sessionStorage.getItem(storageKey) ?? undefined;
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
    Boolean(scopeIsCurrent?.()) &&
    previews.data?.some(
      (preview) =>
        preview.id === STAGED_CONVERSATION_HANDOFF_PREVIEW.id &&
        preview.enabled,
    ) === true;
  const key = JSON.stringify([
    apiBase,
    scope?.authorityKey,
    chat?.conversationId,
  ]);
  const storageKey = `station.staged-handoff.v1:${key}`;
  const restoredKey = chat?.conversationId
    ? retainedSendKey(storageKey)
    : undefined;
  const [plan, setPlan] = useState<{ key: string; selection: Selection }>();
  const [attemptState, setAttemptState] = useState<{
    key: string;
    sending: boolean;
  }>();
  const attempt = useRef<
    | {
        key: string;
        request: Request;
        draft: string;
        quotes: ReturnType<typeof chatDraftsStore.getQuotes>;
        attachments: ReturnType<typeof useChatInput>['attachments'];
      }
    | undefined
  >(undefined);
  const sending = useRef(false);
  const selected = plan?.key === key ? plan.selection : undefined;
  const pending =
    attemptState?.key === key && attemptState.sending
      ? { sending: true }
      : restoredKey
        ? { sending: false }
        : undefined;
  const clearAttempt = () => {
    sessionStorage.removeItem(storageKey);
    attempt.current = undefined;
  };

  const stage = (
    agent: AgentData,
    executionAgent?: AgentData,
    modelId?: string,
    resetEngine = false,
  ) => {
    if (
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
      !scopeIsCurrent?.() ||
      sending.current
    )
      return;
    const conversationId = chat.conversationId;
    const retry = attempt.current?.key === key ? attempt.current : undefined;
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
      if (restoredKey && !retry) {
        const observed = await transport.read(conversationId, restoredKey);
        if (!scopeIsCurrent()) return;
        if (
          observed.providerTurnId &&
          ['accepted', 'completed', 'failed'].includes(observed.status)
        ) {
          clearAttempt();
          setPlan(undefined);
          onAccepted();
          report(
            'Station found the earlier message. Review the conversation before sending the draft again.',
          );
        } else {
          report(
            'Station has not confirmed the earlier message. Your draft is still here.',
          );
        }
        return;
      }
      if (!selected) return;
      let submission = retry;
      if (!submission) {
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
          attachments: [...attachments],
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
        () => {
          if (!scopeIsCurrent())
            throw new Error('The Station connection changed.');
          sessionStorage.setItem(storageKey, exact.request.idempotencyKey);
          attempt.current = exact;
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
      if (state?.currentSessionId === selected.sourceSessionId) {
        updateChat(
          chat.id,
          acceptConversationHandoffUiState(
            state,
            selected.agent,
            result.value.handoff,
            selected.executionAgent,
          ),
        );
      }
      if (
        state?.currentSessionId !== selected.sourceSessionId &&
        state?.currentSessionId !== result.value.handoff.currentSessionId
      ) {
        clearAttempt();
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
      if (state && exact.attachments.length) {
        const consumed = new Set(
          state.attachments
            .filter((file) =>
              exact.attachments.some(
                (original) =>
                  original.id === file.id && original.data === file.data,
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
      clearAttempt();
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
            .catch((statusError: unknown) => {
              if (scopeIsCurrent() && isStationRefusal(statusError, 404))
                clearAttempt();
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
    selected,
    pending,
    stage,
    changeModel,
    changeOption,
    send,
    undo: () => {
      if (!pending) setPlan(undefined);
    },
  };
}
