import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { OrchestrationConversationEventWindow } from '@kontourai/station-contracts/orchestration';
import {
  fetchOrchestrationConversationEventWindow,
  interruptOrchestrationTurn,
} from '@kontourai/station-sdk';
import {
  StationHttpError,
  sendExecutionMessage,
} from '@kontourai/station-sdk/client';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import {
  activeChatsStore,
  useActiveChatActions,
} from '../../contexts/ActiveChatsContext';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { TranscriptAppWorkspaceContext } from '../../contexts/TranscriptAppWorkspaceContext';
import {
  answerOrchestrationRequest,
  inspectApprovalAnswer,
} from '../../hooks/orchestration/answerRequest';
import type { PendingApprovalRequest } from '../../hooks/orchestration/pendingRequestRows';
import { unansweredApprovalRequests } from '../../hooks/orchestration/pendingRequestRows';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import type { NewChatIntent } from '../../lib/newChatIntent';
import { type PeerChatBinding, peerChatApiBase } from '../../lib/peer-chat';
import type { ChatSession } from '../../types';
import { isStreamingSession } from '../../utils/sessionDisplay';
import { Button } from '../Button';
import { ApprovalSheetProvider } from '../chat/ApprovalSheetProvider';
import { ChatRequestContext } from '../chat/ChatRequestContext';
import { MarkdownLinkContext } from '../chat/MarkdownLinkContext';
import { PendingApprovalStrip } from '../chat/PendingApprovalStrip';
import {
  READ_ONLY_UI_BLOCK_ACTIONS,
  UIBlockActionsContext,
} from '../chat/UIBlockActionsContext';
import { SessionReplyComposer } from '../session-detail/SessionReplyComposer';
import { SessionTranscript } from '../session-detail/SessionTranscript';
import { describeReadFailure, ErrorState, SkeletonBlock } from '../state';
import '../session-detail/SessionDetail.css';
import './PeerChatBody.css';

export function PeerChatBody({
  chat,
  binding,
  onEditDraft,
}: {
  chat: Pick<ChatSession, 'id' | 'input' | 'agentName'>;
  binding: PeerChatBinding;
  onEditDraft?: (intent: NewChatIntent) => void;
}) {
  const host = useHostRequestAuthorityScope();
  const scope = host;
  const apiBase = scope
    ? peerChatApiBase(scope.apiBase, binding.environmentId)
    : undefined;
  const enabled = useSurfaceVisibilityFlags().has('paired-station-chats');
  const { updateChat } = useActiveChatActions();
  const scrollRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const current = useCallback(
    () =>
      scope?.isCurrent() === true &&
      activeChatsStore.getSnapshot()[chat.id]?.peerChat?.conversationId ===
        binding.conversationId,
    [scope, chat.id, binding.conversationId],
  );
  const options = { requestScope: scope };
  const history = useQuery<OrchestrationConversationEventWindow>({
    queryKey: [
      'peer-chat-history',
      apiBase,
      scope?.authorityKey,
      binding.conversationId,
    ],
    enabled: enabled && !!scope?.isCurrent(),
    retry: false,
    refetchInterval: (query) => {
      const error = query.state.error;
      if (
        error instanceof StationHttpError &&
        ([401, 403].includes(error.status) ||
          (error.status === 404 && !binding.pending))
      )
        return false;
      return binding.pending || query.state.data?.session.hasActiveTurn
        ? 1000
        : 3000;
    },
    queryFn: ({ signal }) =>
      fetchOrchestrationConversationEventWindow(
        binding.conversationId,
        apiBase!,
        { turnLimit: 1 },
        { ...options, signal },
      ),
  });
  const sessionId = history.data?.currentSessionId ?? binding.sessionId;
  const session = history.data?.session;
  const busy = session ? isStreamingSession(session) : !!binding.pending;
  const refresh = () => {
    void history.refetch();
  };
  const send = useMutation({
    mutationKey: [
      'peer-chat-send',
      apiBase,
      scope?.authorityKey,
      binding.conversationId,
    ],
    retry: false,
    mutationFn: async (pending: NonNullable<PeerChatBinding['pending']>) => {
      if (!enabled || !current() || !scope)
        throw new Error('Reconnect to this Station before sending.');
      return sendExecutionMessage(
        apiBase!,
        {
          target: {
            environment: { kind: 'current' },
            agent: binding.executionAgentId
              ? {
                  kind: 'agent-execution-override',
                  agent: agentId(binding.agentId),
                  executionAgent: agentId(binding.executionAgentId),
                  expectedDefinitionFingerprint:
                    binding.expectedDefinitionFingerprint,
                }
              : agentId(binding.agentId),
            ...(binding.projectSlug
              ? {
                  workspace: {
                    kind: 'project',
                    projectSlug: binding.projectSlug,
                  } as const,
                }
              : {}),
            ...(binding.model
              ? {
                  model: {
                    override: binding.model,
                    options: binding.providerOptions,
                  },
                }
              : {}),
          },
          conversationId: binding.conversationId,
          clientTurnId: pending.id,
          message: pending.text,
        },
        options,
      );
    },
    onSuccess: (receipt, pending) => {
      if (!current()) return;
      const latest = activeChatsStore.getSnapshot()[chat.id]?.peerChat;
      if (!latest || (latest.pending && latest.pending.id !== pending.id))
        return;
      updateChat(chat.id, {
        peerChat: {
          ...latest,
          conversationId: receipt.conversationId,
          sessionId: receipt.sessionId,
          pending: undefined,
        },
      });
      refresh();
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });
  const dispatch = (pending: NonNullable<PeerChatBinding['pending']>) => {
    if (inFlight.current || !current()) return;
    inFlight.current = true;
    updateChat(chat.id, {
      peerChat: { ...binding, pending: { ...pending, dispatched: true } },
    });
    send.mutate(pending);
  };
  useEffect(() => {
    if (enabled && binding.pending?.dispatched === false)
      dispatch(binding.pending);
  });
  useEffect(() => {
    const pending = binding.pending;
    if (
      !pending ||
      !current() ||
      !history.data?.events.some(
        ({ event }) =>
          event.method === 'turn.started' && event.clientTurnId === pending.id,
      )
    )
      return;
    updateChat(chat.id, {
      peerChat: {
        ...binding,
        sessionId: history.data.currentSessionId,
        pending: undefined,
      },
    });
    send.reset();
  }, [history.data, binding, chat.id, updateChat, current, send.reset]);
  const stop = useMutation({
    retry: false,
    mutationFn: () => {
      if (!enabled || !current() || !scope || !sessionId)
        throw new Error('Reconnect before stopping the turn.');
      return interruptOrchestrationTurn({
        apiBase: apiBase!,
        threadId: sessionId,
        requestScope: scope,
      });
    },
    onSuccess: refresh,
  });
  if (!enabled)
    return (
      <ErrorState
        title="Paired Station chats is off"
        description="Enable it in Settings → Advanced → Feature previews to continue this chat."
      />
    );
  if (!scope?.isCurrent())
    return (
      <ErrorState
        title="Reconnect to this Station"
        description="Your conversation and unsent message are kept."
      />
    );
  const requests = unansweredApprovalRequests(
    [],
    (history.data?.events ?? []).map(({ event }) => event),
  );
  const error =
    send.error ??
    stop.error ??
    (binding.pending && send.isPending ? null : history.error);
  const approve = async (
    request: PendingApprovalRequest,
    action: 'once' | 'trust' | 'trust-server' | 'deny',
  ) => {
    if (
      !current() ||
      !request.approvalThreadId ||
      !request.approvalId ||
      !request.approvalEventId
    )
      throw new Error('Reconnect and check this request before answering.');
    const outcome = await answerOrchestrationRequest(apiBase!, {
      threadId: request.approvalThreadId,
      requestId: request.approvalId,
      requestEventId: request.approvalEventId,
      decision:
        action === 'deny'
          ? 'decline'
          : action === 'once'
            ? 'accept'
            : 'acceptForSession',
      ...(action === 'trust-server'
        ? { sessionGrantScope: 'server' as const }
        : {}),
      requestScope: scope,
    });
    refresh();
    return outcome;
  };
  return (
    <ChatRequestContext.Provider
      value={{ apiBase: apiBase!, requestScope: scope }}
    >
      <MarkdownLinkContext.Provider value={null}>
        <TranscriptAppWorkspaceContext.Provider value={undefined}>
          <UIBlockActionsContext.Provider value={READ_ONLY_UI_BLOCK_ACTIONS}>
            <ApprovalSheetProvider
              apiBase={apiBase}
              requests={requests}
              onApprove={approve}
              onCheck={(request) => {
                if (
                  !current() ||
                  !request.approvalThreadId ||
                  !request.approvalId ||
                  !request.approvalEventId
                )
                  return Promise.reject(
                    new Error('Reconnect before checking this request.'),
                  );
                return inspectApprovalAnswer(apiBase!, {
                  threadId: request.approvalThreadId,
                  requestId: request.approvalId,
                  requestEventId: request.approvalEventId,
                  requestScope: scope,
                });
              }}
            >
              <section
                className="peer-chat"
                aria-label={`Chat on ${binding.stationName}`}
              >
                <div className="peer-chat__location">
                  <span>
                    {binding.stationName}
                    {binding.projectName
                      ? ` · ${binding.projectName}`
                      : ' · No project'}
                  </span>
                  {binding.model && <span>{binding.model}</span>}
                  {busy && sessionId && (
                    <Button
                      onClick={() => stop.mutate()}
                      pending={stop.isPending}
                      pendingLabel="Stopping…"
                    >
                      Stop
                    </Button>
                  )}
                </div>
                {error && (
                  <ErrorState
                    variant="compact"
                    title="Couldn’t confirm the Station’s response"
                    description={describeReadFailure(error)}
                    action={
                      <Button onClick={refresh}>Check conversation</Button>
                    }
                  />
                )}
                <div className="peer-chat__transcript" ref={scrollRef}>
                  {sessionId ? (
                    <SessionTranscript
                      apiBase={apiBase!}
                      session={{
                        threadId: sessionId,
                        conversationId: binding.conversationId,
                      }}
                      agentLabel={chat.agentName || binding.agentId}
                      isStreaming={busy}
                      scrollContainerRef={scrollRef}
                      observation={{
                        live: false,
                        revision: history.data?.watermark ?? 0,
                      }}
                    />
                  ) : (
                    !error && (
                      <SkeletonBlock
                        count={1}
                        label="Starting the remote chat"
                      />
                    )
                  )}
                  {binding.pending && (
                    <div className="peer-chat__pending">
                      <p>{binding.pending.text}</p>
                      <p role="status">
                        {send.isPending
                          ? 'Sending…'
                          : 'This message is awaiting confirmation.'}
                      </p>
                      {!send.isPending && binding.pending.dispatched && (
                        <>
                          <Button onClick={() => dispatch(binding.pending!)}>
                            Retry this message
                          </Button>
                          {onEditDraft && (
                            <Button
                              onClick={() => {
                                if (!current()) return;
                                onEditDraft({
                                  initialPrompt: binding.pending!.text,
                                  selection: {
                                    context: '__global__',
                                    agentSlug: binding.agentId,
                                    model: {
                                      ...(binding.model
                                        ? { modelId: binding.model }
                                        : {}),
                                      environmentId: binding.environmentId,
                                      executionAgentId:
                                        binding.executionAgentId,
                                      expectedDefinitionFingerprint:
                                        binding.expectedDefinitionFingerprint,
                                      providerOptions:
                                        binding.providerOptions ?? {},
                                    },
                                  },
                                });
                              }}
                            >
                              Edit in New Chat
                            </Button>
                          )}
                          <p>
                            Check the conversation before sending a changed
                            message; it may have arrived.
                          </p>
                        </>
                      )}
                    </div>
                  )}
                </div>
                <PendingApprovalStrip
                  requests={requests}
                  settled={history.isSuccess}
                  onApprove={approve}
                />
                <SessionReplyComposer
                  allowDraftWhileBusy
                  input={chat.input || ''}
                  onInputChange={(input) => updateChat(chat.id, { input })}
                  busy={busy || send.isPending}
                  pending={send.isPending}
                  disabled={!!binding.pending || history.isError || !session}
                  placeholder={`Reply on ${binding.stationName}…`}
                  onSend={() => {
                    const text = activeChatsStore
                      .getSnapshot()
                      [chat.id]?.input?.trim();
                    if (!text || binding.pending || busy || !current()) return;
                    updateChat(chat.id, { input: '' });
                    dispatch({
                      id: randomCorrelationId(),
                      text,
                      dispatched: false,
                    });
                  }}
                />
              </section>
            </ApprovalSheetProvider>
          </UIBlockActionsContext.Provider>
        </TranscriptAppWorkspaceContext.Provider>
      </MarkdownLinkContext.Provider>
    </ChatRequestContext.Provider>
  );
}
