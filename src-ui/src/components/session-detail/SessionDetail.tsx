import {
  type AdoptedSessionResult,
  type OrchestrationSessionSummary,
  OrchestrationSessionsContext,
} from '@kontourai/station-sdk';
import { resolveConversationOpen } from '@kontourai/station-sdk/conversation-open';
import { useQuery } from '@tanstack/react-query';
import {
  type ComponentProps,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useStationConnectionsOptional } from '../../connections/StationConnectionsContext';
import type { StationConnection } from '../../connections/station-connection';
import { useSessionEventStream } from '../../hooks/orchestration/useSessionEventStream';
import { useMobileVisualViewport } from '../../hooks/useMobileVisualViewport';
import { elidedHistoryNoticeText } from '../../utils/elidedHistory';
import { describeStationFailure } from '../../utils/stationFailure';
import { Button } from '../Button';
import { ConversationConnectionProvider } from '../conversation/ConversationConnectionContext';
import { ErrorState, SkeletonBlock } from '../state';
import { AttachedSessionDetail } from './AttachedSessionDetail';
import {
  MutableSessionDetail,
  type SessionEvidenceReveal,
} from './MutableSessionDetail';
import '../../views/SessionsView.css';

/** Resolve the record owner here; surfaces cannot turn a peer id into a host id. */
export function SessionDetail(
  props: ComponentProps<typeof SessionDetailContent>,
) {
  const connections = useStationConnectionsOptional();
  const requestScope = useContext(OrchestrationSessionsContext)?.scope;
  const environmentId =
    props.session.delegation?.environmentKind === 'peer'
      ? props.session.delegation.environmentId
      : undefined;
  const remote = props.session.delegation?.environmentKind === 'peer';
  const [attempt, setAttempt] = useState(0);
  const [owner, setOwner] = useState<{
    key: string;
    station?: StationConnection;
    error?: unknown;
  }>();
  const key = JSON.stringify([
    props.apiBase,
    requestScope?.authorityKey,
    environmentId,
    remote,
    attempt,
  ]);
  useEffect(() => {
    if (!connections || (remote && !environmentId)) return;
    let active = true;
    let release = () => {};
    void connections
      .resolve({ environmentId })
      .then((lease) => {
        release = lease.release;
        if (!active) {
          release();
          return;
        }
        setOwner({ key, station: lease.connection });
      })
      .catch((error) => {
        if (active) setOwner({ key, error });
      });
    return () => {
      active = false;
      release();
    };
  }, [connections, environmentId, remote, key]);
  const station =
    owner?.key === key && owner.station?.isCurrent()
      ? owner.station
      : undefined;
  const value = useMemo(
    () =>
      station
        ? {
            apiBase: station.targetApiBase,
            station,
            requestScope: {
              ...station.requestScope,
              isCurrent: station.isCurrent,
            },
          }
        : {
            apiBase: props.apiBase,
            requestScope: requestScope?.isCurrent
              ? { ...requestScope, isCurrent: requestScope.isCurrent }
              : undefined,
          },
    [station, props.apiBase, requestScope],
  );
  const open = useQuery({
    queryKey: [
      'conversation-record-open',
      value.apiBase,
      station?.runtimeKey ?? requestScope?.authorityKey,
      props.session.conversationId,
      props.session.threadId,
      props.session.lifecycleState ?? props.session.status,
    ],
    enabled: Boolean(
      props.session.controlMode !== 'read-only-attached' &&
        station &&
        props.session.conversationId,
    ),
    queryFn: async ({ signal }) => {
      if (!station?.isCurrent() || !props.session.conversationId)
        throw new Error('Station unavailable');
      const result = await resolveConversationOpen(
        props.session.conversationId,
        station.targetApiBase,
        { signal, requestScope: station.requestScope },
      );
      if (!station.isCurrent()) throw new Error('Station connection changed');
      return result;
    },
    retry: false,
  });
  if (!remote && connections && !station) {
    if (owner?.key !== key || !owner.error)
      return <SkeletonBlock label="Connecting to Station" />;
    return (
      <ErrorState
        title="Station unavailable"
        description={describeStationFailure(owner.error).body}
        action={<Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>}
      />
    );
  }
  if (remote && (!station || open.isError || !props.session.conversationId)) {
    if (
      connections &&
      environmentId &&
      !owner?.error &&
      !open.isError &&
      props.session.conversationId
    )
      return <SkeletonBlock label="Connecting to Station" />;
    return (
      <ErrorState
        title="Station unavailable"
        description={
          describeStationFailure(open.error ?? owner?.error, station).body
        }
        action={
          <Button
            onClick={() => {
              setAttempt((n) => n + 1);
              void open.refetch();
            }}
          >
            Retry
          </Button>
        }
      />
    );
  }
  if (remote && open.isPending)
    return <SkeletonBlock label="Reading the conversation" />;
  const targetSession =
    remote && open.data?.status === 'resolved'
      ? {
          ...props.session,
          threadId: open.data.currentSessionId,
          conversationId: open.data.conversation.id,
        }
      : undefined;
  if (remote && !targetSession)
    return (
      <ErrorState
        title="Conversation unavailable"
        description="This connection cannot read the conversation."
        action={<Button onClick={() => void open.refetch()}>Retry</Button>}
      />
    );
  const conversationWritable =
    station && props.session.controlMode !== 'read-only-attached'
      ? open.data?.status === 'resolved' &&
        (open.data.canContinue || open.data.continuationPending === true) &&
        open.data.callerAccess?.continue !== false
      : undefined;
  const accessNotice = open.isError ? (
    <ErrorState
      title="Conversation access could not be checked"
      description={describeStationFailure(open.error, station).body}
      action={<Button onClick={() => void open.refetch()}>Retry</Button>}
    />
  ) : undefined;
  return (
    <ConversationConnectionProvider value={value}>
      <SessionDetailContent
        {...props}
        conversationSession={targetSession}
        conversationWritable={conversationWritable}
        accessNotice={accessNotice}
      />
    </ConversationConnectionProvider>
  );
}

function SessionDetailContent({
  apiBase,
  chatFontSize = 14,
  session,
  onTaskChanged,
  onAdopted,
  onContinueInChat,
  getSelectionIntent,
  evidenceReveal,
  presentation = 'inspector',
  openingContinuation,
  continuationCreated,
  draftScope,
  handoffScope,
  onOpenConversation,
  conversationSession,
  conversationWritable,
  accessNotice,
}: {
  /** Activity hands an external conversation's message to the dock. */
  onContinueInChat?:
    | ((draft: string) => void)
    | ((draft: string) => boolean | Promise<boolean>);
  onOpenConversation?: () => void;
  /** Where the detail is hosted: Activity's pane, or the chat dock. */
  presentation?: 'inspector' | 'chat';
  openingContinuation?: boolean;
  continuationCreated?: boolean;
  draftScope?: string;
  handoffScope?: string;
  apiBase: string;
  conversationSession?: OrchestrationSessionSummary;
  conversationWritable?: boolean;
  accessNotice?: import('react').ReactNode;
  chatFontSize?: number;
  session: OrchestrationSessionSummary;
  onTaskChanged: () => void;
  onAdopted: (
    session: AdoptedSessionResult,
    intent: number,
    message: string,
  ) => void;
  getSelectionIntent: () => number;
  evidenceReveal?: SessionEvidenceReveal | null;
}) {
  const authority = useContext(OrchestrationSessionsContext)?.scope;
  const {
    events,
    connected,
    hasMore,
    loadOlder,
    upgradeRequired,
    error,
    historyRetrying,
    elidedHistory,
    liveStreamStoppedTerminal,
    connectionInterrupted,
    historyLoaded,
    historyStoppedTerminal,
    capabilityRecoveryExhausted,
    retryCapabilityRecovery,
  } = useSessionEventStream(
    apiBase,
    session.threadId,
    true,
    authority?.isCurrent,
    authority?.authorityKey ?? 'unscoped',
  );
  // archive#3386: the same bounded read feeds this surface and
  // the chat dock. The dock disclosed what its budget withheld and this one
  // rendered the identical amputated turn in silence, because both readers in
  // `useSessionEventStream` unwrapped `item.event` and dropped the envelope.
  const elidedHistoryText = elidedHistoryNoticeText(elidedHistory);
  const elidedHistoryNotice = elidedHistoryText ? (
    <p
      className="history-elided"
      role="status"
      data-testid="session-history-elided"
    >
      {elidedHistoryText}
    </p>
  ) : null;
  const visualViewport = useMobileVisualViewport();
  // The Station-owned detail's conversation pages its own durable window
  // (`ConversationReader`), so only these notices about THIS feed's history
  // read are handed down; its "Show older messages" would page a feed the
  // transcript no longer reads.
  const historyNotices =
    upgradeRequired || elidedHistoryNotice || error ? (
      <>
        {upgradeRequired && (
          <p role="alert">Update Station to view this session history.</p>
        )}
        {elidedHistoryNotice}
        {error && !upgradeRequired && (
          <p role="alert">
            {/* archive#3378: the two outcomes read identically before this —
                a history read that is coming back and one that has stopped
                both printed the raw cause and nothing else. */}
            {historyRetrying
              ? `${describeStationFailure(error).body} Retrying session history…`
              : describeStationFailure(error).body}
          </p>
        )}
      </>
    ) : null;

  if (session.controlMode === 'read-only-attached') {
    return (
      <>
        {/* Upgrade/error stories render INSIDE the detail for attached
            sessions — only the pagination control and the elision notice
            belong up here, or the update requirement renders twice (sol delta
            review, #2630). The notice is safe in both places precisely
            because it is NOT among the props handed to
            `AttachedSessionDetail`: nothing downstream can render it a second
            time, and these two branches are mutually exclusive anyway. */}
        {presentation !== 'chat' && elidedHistoryNotice && (
          <div className="session-history-controls">{elidedHistoryNotice}</div>
        )}
        <AttachedSessionDetail
          key={session.threadId}
          apiBase={apiBase}
          draftScope={draftScope}
          handoffScope={handoffScope}
          showHeader={presentation !== 'chat'}
          chatFontSize={chatFontSize}
          openingContinuation={openingContinuation}
          continuationCreated={continuationCreated}
          onLoadOlder={hasMore ? loadOlder : undefined}
          session={session}
          onAdopted={onAdopted}
          onContinueInChat={onContinueInChat}
          getSelectionIntent={getSelectionIntent}
          events={events}
          connected={connected}
          upgradeRequired={upgradeRequired}
          streamError={error}
          liveStreamStoppedTerminal={liveStreamStoppedTerminal}
          connectionInterrupted={connectionInterrupted}
          historyLoaded={historyLoaded}
          historyStoppedTerminal={historyStoppedTerminal}
          capabilityRecoveryExhausted={capabilityRecoveryExhausted}
          onRetryCapabilityRecovery={retryCapabilityRecovery}
          visualViewport={visualViewport}
        />
      </>
    );
  }

  // A Station-owned session opens as its real chat from the detail's own
  // header (`useMutableSessionDetailState`'s `openInChat`, the shared
  // rehydrate policy), not through `onOpenInChat`: that callback shows the
  // `chat` surface for a thread id, which for a Station-owned session is this
  // same inspector rendered in the dock. It stays the attached-session
  // continuation hand-off above.
  return (
    <MutableSessionDetail
      onOpenConversation={onOpenConversation}
      apiBase={apiBase}
      draftScope={draftScope}
      session={session}
      conversationSession={conversationSession}
      conversationWritable={conversationWritable}
      onTaskChanged={onTaskChanged}
      events={events}
      connected={connected}
      visualViewport={visualViewport}
      evidenceReveal={evidenceReveal}
      historyNotices={
        <>
          {accessNotice}
          {historyNotices}
        </>
      }
    />
  );
}
