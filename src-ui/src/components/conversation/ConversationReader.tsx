import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { OrchestrationConversationEventWindow } from '@kontourai/station-contracts/orchestration';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { isSessionLifecycleStateStopped } from '@kontourai/station-contracts/session-lifecycle';
import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import {
  memo,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { useAgents } from '../../contexts/AgentsContext';
import { conversationMessageToChatMessage } from '../../hooks/orchestration/conversationTranscriptParts';
import { useSessionTranscriptEvents } from '../../hooks/orchestration/useSessionTranscriptEvents';
import { useIsMobile } from '../../hooks/useIsMobile';
import type { ChatMessage, ChatSession } from '../../types';
import { describeStationFailure } from '../../utils/stationFailure';
import { Button } from '../Button';
import { describeStationControlCall } from '../chat/agent-message/station-control-calls';
import { ChatMessageList } from '../chat/ChatMessageList';
import {
  projectTranscriptMessages,
  type TranscriptRow,
} from '../chat/transcriptProjection';
import { Empty, ErrorState, SkeletonBlock } from '../state';
import {
  ConversationConnectionProvider,
  useConversationConnection,
  useOptionalConversationConnection,
} from './ConversationConnectionContext';
import { useSessionReaderBinding } from './SessionReaderBinding';

export interface ConversationReaderProps {
  apiBase?: string;
  session: Pick<OrchestrationSessionSummary, 'threadId' | 'conversationId'> &
    Partial<
      Pick<OrchestrationSessionSummary, 'lifecycleState' | 'assignedAgentSlug'>
    >;
  agentLabel: string;
  agents?: ReturnType<typeof useAgents>;
  isStreaming: boolean;
  failureShownAbove?: boolean;
  notices?: ReactNode;
  onSettledChange?: (settled: boolean) => void;
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
  preserveReading?: boolean;
  observation?: { live: false; revision: number };
  fontSize?: number;
  pendingMessages?: ChatMessage[];
}

/** A durable window and live stream feed the same reader as imported records. */
export function SessionConversationReader(props: ConversationReaderProps) {
  const inherited = useOptionalConversationConnection();
  const target = inherited ?? { apiBase: props.apiBase ?? '' };
  const source = useSessionTranscriptEvents(
    target.apiBase,
    props.session,
    props.isStreaming,
    props.observation,
  );
  const value = useMemo(
    () => ({ ...target, record: target.record ?? { readOnly: true } }),
    [target],
  );
  return (
    <ConversationConnectionProvider value={value}>
      <ConversationReader {...props} {...source} />
    </ConversationConnectionProvider>
  );
}

export interface ConversationReaderState {
  sessionLineage?: OrchestrationConversationEventWindow['sessionLineage'];
  events: readonly CanonicalRuntimeEvent[];
  partialTurnStartEventIds?: ReadonlySet<string>;
  hasMore?: boolean;
  loadOlder?: () => Promise<void>;
  settled: boolean;
  error?: Error;
  upgradeRequired?: boolean;
  retry?: () => void | Promise<void>;
  loading?: boolean;
}

/** Record density changes framing; bubbles, approval policy and history remain shared. */
export const ConversationReader = memo(function ConversationReader({
  session,
  agentLabel,
  agents,
  isStreaming,
  failureShownAbove = false,
  notices,
  onSettledChange,
  scrollContainerRef,
  preserveReading = false,
  fontSize = 14,
  pendingMessages = [],
  events,
  sessionLineage,
  partialTurnStartEventIds,
  hasMore = false,
  loadOlder = async () => {},
  settled,
  error,
  upgradeRequired = false,
  retry,
  loading = false,
}: ConversationReaderProps & ConversationReaderState) {
  const target = useConversationConnection();
  const requestsReadOnly =
    target.record?.readOnly ||
    (session.lifecycleState !== undefined &&
      isSessionLifecycleStateStopped(session.lifecycleState));
  const contentRef = useRef<HTMLElement | null>(null);
  const isMobile = useIsMobile();
  useEffect(() => {
    if (error && scrollContainerRef?.current)
      scrollContainerRef.current.scrollTop = 0;
  }, [error, scrollContainerRef]);
  useEffect(() => {
    onSettledChange?.(settled);
  }, [onSettledChange, settled]);
  const previousRows = useRef<readonly TranscriptRow[]>([]);
  const rows = useMemo(() => {
    const identities = new Map(
      sessionLineage?.map((entry) => [entry.sessionId, entry]),
    );
    let projected = projectRuntimeEventsToMessages([...events], {
      stableIds: true,
      markEndedTurns: true,
      partialTurnStartEventIds,
    })
      .map((message) => ({
        ...conversationMessageToChatMessage(message),
        // A record's immutable Session is the same identity source the dock's
        // session map uses. Never label a different Session after a handoff.
        agentSlug:
          identities.get(message.metadata?.sessionId ?? '')?.agentSlug ??
          (message.metadata?.sessionId === session.threadId
            ? session.assignedAgentSlug
            : undefined),
        agentDisplayName: identities.get(message.metadata?.sessionId ?? '')
          ?.agentDisplayName,
        agentIcon: identities.get(message.metadata?.sessionId ?? '')?.agentIcon,
      }))
      .map((message) =>
        requestsReadOnly
          ? {
              ...message,
              contentParts: message.contentParts?.map((part) => ({
                ...part,
                needsApproval: false,
                approvalId: undefined,
                approvalThreadId: undefined,
                approvalEventId: undefined,
                approvalContentEvent: undefined,
                inputRequest: undefined,
              })),
            }
          : message,
      );
    if (failureShownAbove) {
      const last = projected.at(-1);
      if (last?.role === 'assistant') {
        const kept = (last.contentParts ?? []).filter(
          (part) => !part.runtimeError,
        );
        if (kept.length !== (last.contentParts ?? []).length) {
          projected =
            kept.length === 0
              ? projected.slice(0, -1)
              : [...projected.slice(0, -1), { ...last, contentParts: kept }];
        }
      }
    }
    const next = projectTranscriptMessages(
      session.threadId,
      projected,
      previousRows.current,
    );
    previousRows.current = next;
    return next;
  }, [
    events,
    sessionLineage,
    partialTurnStartEventIds,
    failureShownAbove,
    session.threadId,
    session.assignedAgentSlug,
    requestsReadOnly,
  ]);
  const activityBinding = useSessionReaderBinding();
  const anchor = useMemo(
    () =>
      activityBinding?.sessionId &&
      activityBinding.messageAnchor &&
      (activityBinding.sessionId === session.threadId ||
        activityBinding.sessionId === session.conversationId)
        ? {
            ...activityBinding.messageAnchor,
            sessionId: activityBinding.sessionId,
          }
        : undefined,
    [
      activityBinding?.sessionId,
      activityBinding?.messageAnchor,
      session.threadId,
      session.conversationId,
    ],
  );
  const anchoredRows = anchor
    ? rows.flatMap((row) =>
        anchor.direction === 'received'
          ? row.message.role === 'user' &&
            row.message.sender?.requestKey === anchor.requestKey
            ? [row]
            : []
          : (row.message.contentParts ?? [])
              .filter(
                (part) =>
                  describeStationControlCall(part)?.requestKey ===
                  anchor.requestKey,
              )
              .map(() => row),
      )
    : [];
  const anchorKey = anchor
    ? JSON.stringify([
        anchor.sessionId,
        anchor.direction,
        anchor.requestKey,
        activityBinding?.intentToken,
      ])
    : undefined;
  const anchorReads = useRef<{ key?: string; pages: number }>({ pages: 0 });
  const [anchorLimit, setAnchorLimit] = useState(false);
  const announcedAnchor = useRef<string | undefined>(undefined);
  const anchorId =
    anchoredRows.length === 1 ? anchoredRows[0]?.message.id : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each arriving page advances bounded lookup even without a matched anchor.
  useEffect(() => {
    if (anchorReads.current.key !== anchorKey) {
      anchorReads.current = { key: anchorKey, pages: 0 };
      announcedAnchor.current = undefined;
      setAnchorLimit(false);
    }
    if (!anchor || loading || !settled || error || upgradeRequired) return;
    if (announcedAnchor.current === anchorKey) return;

    if (hasMore) {
      if (anchorReads.current.pages >= 20) {
        setAnchorLimit(true);
        return;
      }
      anchorReads.current.pages += 1;
      void loadOlder();
      return;
    }
    if (anchorId) {
      const row = [
        ...(contentRef.current?.querySelectorAll<HTMLElement>(
          '[data-transcript-message-id]',
        ) ?? []),
      ].find((node) => node.dataset.transcriptMessageId === anchorId);
      const target =
        anchor.direction === 'sent'
          ? ([
              ...(row?.querySelectorAll<HTMLElement>(
                '[data-station-send-request]',
              ) ?? []),
            ].find(
              (node) => node.dataset.stationSendRequest === anchor.requestKey,
            ) ?? row)
          : row;
      if (anchor.direction === 'received') {
        const details = target?.querySelector<HTMLDetailsElement>(
          'details.agent-cause-disclosure',
        );
        if (details) details.open = true;
      }
      target?.scrollIntoView?.({ block: 'center' });
      if (target) {
        target.tabIndex = -1;
        target.focus({ preventScroll: true });
        announcedAnchor.current = anchorKey;
      }
    }
  }, [
    anchor,
    anchorKey,
    anchorId,
    loading,
    settled,
    error,
    upgradeRequired,
    hasMore,
    loadOlder,
    events,
  ]);

  const activeSession = useMemo<ChatSession>(
    () => ({
      id: JSON.stringify([
        'record',
        target.station?.runtimeKey ?? target.apiBase,
        session.threadId,
      ]),
      conversationId: session.conversationId ?? session.threadId,
      currentSessionId: session.threadId,
      agentSlug: session.assignedAgentSlug ?? agentId('record'),
      agentName: agentLabel,
      title: agentLabel,
      source: 'manual',
      messages: [
        ...rows.map((row) => row.message),
        ...pendingMessages.filter(
          (message) =>
            !rows.some((row) => row.message.clientId === message.clientId),
        ),
      ],
      input: '',
      attachments: [],
      queuedMessages: [],
      inputHistory: [],
      status: 'idle',
      error: null,
      createdAt: 0,
      updatedAt: 0,
      orchestrationTurnOpen: isStreaming,
    }),
    [
      target,
      session.threadId,
      session.conversationId,
      session.assignedAgentSlug,
      rows,
      agentLabel,
      isStreaming,
      pendingMessages,
    ],
  );
  const failure = error
    ? describeStationFailure(error, target.station)
    : undefined;
  return (
    <section
      className="conversation-reader"
      aria-label="Recorded conversation"
      data-testid="session-transcript"
      data-transcript-mobile={isMobile}
      ref={contentRef}
    >
      <ChatMessageList
        recordAgents={agents}
        activeSession={activeSession}
        fontSize={fontSize}
        showReasoning={false}
        showToolDetails
        suppressStreamingRow
        externalScrollContainerRef={scrollContainerRef}
        preserveReading={preserveReading}
        hasOlderMessages={hasMore}
        historyLoading={loading}
        onLoadOlder={loadOlder}
        approvalEvents={
          requestsReadOnly ? [] : events.map((event) => ({ event }))
        }
        approvalEventsSettled={settled}
        historyNotice={
          <>
            {error && (
              <ErrorState
                variant="compact"
                title={
                  upgradeRequired
                    ? 'Update Station to read this conversation'
                    : 'Conversation could not be loaded'
                }
                description={failure?.body}
                action={
                  retry ? (
                    <Button disabled={loading} onClick={() => void retry()}>
                      Retry
                    </Button>
                  ) : undefined
                }
              />
            )}
            {notices}
          </>
        }
        emptyState={
          error || upgradeRequired ? null : !settled ? (
            <SkeletonBlock label="Reading the conversation" count={2} />
          ) : (
            <Empty
              label={
                isStreaming
                  ? 'Waiting for the first message…'
                  : 'No messages in this session yet.'
              }
            />
          )
        }
      />
      {anchorLimit && (
        <p role="status">
          Exact message lookup reached its 20-page limit. Load older messages to
          continue; no target has been selected.
        </p>
      )}
      {anchor && !hasMore && anchorId && (
        <p className="sr-only" role="status">
          Opened the exact{' '}
          {anchor.direction === 'sent' ? 'sending call' : 'received message'}.
        </p>
      )}
      {anchor &&
        settled &&
        !loading &&
        !error &&
        !upgradeRequired &&
        !hasMore &&
        !anchorId && (
          <p role="status">
            {anchoredRows.length > 1
              ? 'Message anchor is ambiguous: more than one recorded call or input has this request key.'
              : 'The exact message is not available in this conversation.'}
          </p>
        )}
    </section>
  );
});
