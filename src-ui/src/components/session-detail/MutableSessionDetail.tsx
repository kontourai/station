import { flowRunDisplayIdentity } from '@kontourai/station-contracts';
import {
  type OrchestrationSessionSummary,
  useAgentsQuery,
  useOrchestrationCommandReceiptsQuery,
} from '@kontourai/station-sdk';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { openChatsStore } from '../../contexts/open-chats-store';
import {
  getStreamConnectionState,
  subscribeStreamConnectionState,
} from '../../hooks/orchestration/streamConnectionState';
import type { OrchestrationEvent } from '../../hooks/orchestration/types';
import type { useMobileVisualViewport } from '../../hooks/useMobileVisualViewport';
import { useMutableSessionDetailState } from '../../hooks/useMutableSessionDetailState';
import { requestTaskShaping } from '../../lib/task-shaping';
import {
  clientOriginDetail,
  clientOriginSummary,
  clientOriginSurfaceLabel,
} from '../../utils/clientOrigin';
import { relativeTime } from '../../utils/relativeTime';
import {
  builderRunIdentityLabel,
  builderRunMatchLabel,
  humanizeId,
  linkedFlowStateLabel,
  sessionProjectLabel,
  sidecarWriteProvenance,
} from '../../utils/sessionDisplay';
import { Button } from '../Button';
import { DelegationLauncher } from '../chat-dock/DelegationLauncher';
import { ConversationBody } from '../conversation/ConversationBody';
import { useOptionalConversationConnection } from '../conversation/ConversationConnectionContext';
import { WorkflowStatusLineList } from '../flow/WorkflowStatusLine';
import { LazyBoundary } from '../LazyBoundary';
import { SkeletonBlock } from '../state';
import { OwnedWorkCleanup } from './OwnedWorkCleanup';
import { SessionDetailAttention } from './SessionDetailAttention';
import { SessionDetailDiagnostics } from './SessionDetailDiagnostics';
import { SessionDetailErrors } from './SessionDetailErrors';
import { SessionDetailHeader } from './SessionDetailHeader';
import {
  isPeerDelegationRecord,
  sessionAgentLabel,
  sessionChatOpenTarget,
} from './sessionDetailPresentation';
import './SessionDetail.css';

const loadConversationPullRequestLinks = () =>
  import('../pull-requests/ConversationPullRequestLinks').then((module) => ({
    default: module.ConversationPullRequestLinks,
  }));

/**
 * One-shot route intent: land the reader on this session's evidence.
 *
 * `token` is a fresh nonce per ACTIVATION (not per render): the detail honors
 * each token exactly once, so later re-renders — new events streaming in, the
 * receipts query settling — can never scroll the reader away from wherever
 * they have since moved. A fresh activation mints a fresh token and fires
 * again. See `SessionsView`'s `focusHint` consumption for where tokens are
 * minted.
 */
export type SessionEvidenceReveal = {
  threadId: string;
  token: number;
};

/** Activity retains metadata and evidence around the shared record body. */
export function MutableSessionDetail({
  apiBase,
  session,
  onTaskChanged,
  events,
  visualViewport,
  evidenceReveal,
  historyNotices,
  draftScope,
  onOpenConversation,
  conversationSession,
  conversationWritable,
}: {
  apiBase: string;
  draftScope?: string;
  onOpenConversation?: () => void;
  session: OrchestrationSessionSummary;
  conversationSession?: OrchestrationSessionSummary;
  conversationWritable?: boolean;
  onTaskChanged: () => void;
  events: OrchestrationEvent[];
  connected: boolean;
  visualViewport: ReturnType<typeof useMobileVisualViewport>;
  evidenceReveal?: SessionEvidenceReveal | null;
  /** History-read notices, rendered at the head of the conversation. */
  historyNotices?: ReactNode;
}) {
  const {
    input,
    setInput,
    isDelegated,
    isStreaming,
    isStopped,
    sessionUnanswerable,
    sessionUnanswerableNotice,
    rows,
    viewportIsCompact,
    title,
    diagnosticsLog,
    attentionCheckFailed,
    attentionErrorMessage,
    attentionRefetch,
    visibleAttentionItems,
    hideGenericCompose,
    failureText,
    failureNote,
    acknowledgeFailure,
    acknowledgeFailurePending,
    acknowledgeFailureError,
    copySessionId,
    linkedFlowRun,
    builderRun,
    workflowEntries,
    workflowMoreCount,
  } = useMutableSessionDetailState({
    apiBase,
    draftScope,
    session,
    onTaskChanged,
    events,
    visualViewport,
  });

  const threadId = session.threadId;
  const inheritedConnection = useOptionalConversationConnection();
  const connection = inheritedConnection ?? { apiBase };
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const livePhase = useSyncExternalStore(
    subscribeStreamConnectionState,
    () => getStreamConnectionState(connection.apiBase).phase,
  );
  const connectionLabel = {
    unknown: 'Connecting…',
    receiving: 'Catching up…',
    'caught-up': 'Live',
    interrupted: 'Reconnecting…',
    closed: 'Connection needs attention',
  }[livePhase];
  const currentTool = session.hasActiveTurn
    ? session.conversationActivity?.runningTools?.at(-1)?.name
    : undefined;
  const importantNotice = Boolean(
    failureText || attentionCheckFailed || visibleAttentionItems.length,
  );
  useEffect(() => {
    if (importantNotice && transcriptScrollRef.current) {
      transcriptScrollRef.current.scrollTop = 0;
    }
  }, [importantNotice]);
  const agents =
    useAgentsQuery(
      connection.requestScope
        ? {
            readTarget: {
              targetApiBase: connection.apiBase,
              requestScope: connection.requestScope,
              runtimeKey: connection.station?.runtimeKey,
            },
          }
        : undefined,
    ).data ?? [];
  const agentLabel = sessionAgentLabel(session, agents);
  // Open in chat goes through the shared open-chat focus (archive#1297), the
  // seam Home and the project page use: the chat dock rehydrates the real
  // conversation. Absent when there is no chat to rehydrate.
  // A peer Task uses its receiver connection for reads; Task writes keep their own protocol.
  const isPeerRecord = isPeerDelegationRecord(session);
  const chatOpenTarget = isPeerRecord ? null : sessionChatOpenTarget(session);
  const openInChat = chatOpenTarget
    ? (onOpenConversation ?? (() => openChatsStore.focus(chatOpenTarget)))
    : undefined;

  // The evidence region lives inside the collapsed Details disclosure. A
  // reveal therefore OPENS the disclosure first — scrolling to, or focusing,
  // content inside a closed <details> lands on nothing — then scrolls the
  // region's start into view and focuses it. The linked pull requests and the
  // event log sit directly under it in the same disclosure.
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const evidenceRegionRef = useRef<HTMLDListElement | null>(null);
  const revealedEvidenceTokenRef = useRef<number | null>(null);
  const transcriptSettledRef = useRef(false);
  const revealAwaitsTranscriptRef = useRef(false);
  useEffect(() => {
    if (!evidenceReveal || evidenceReveal.threadId !== threadId) return;
    if (revealedEvidenceTokenRef.current === evidenceReveal.token) return;
    // Consume the token BEFORE acting: an intent whose target is absent is a
    // completed no-op, never a scroll deferred to some surprising later
    // render.
    revealedEvidenceTokenRef.current = evidenceReveal.token;
    const region = evidenceRegionRef.current;
    if (!region) return;
    // Uncontrolled on purpose: React never writes `open`, so opening it here
    // is synchronous and the reader's own later toggles are left alone.
    if (detailsRef.current) detailsRef.current.open = true;
    // A plain positioned scroll — jsdom implements none of it, hence the
    // guard — then focus, so a keyboard or screen-reader user lands IN the region
    // rather than having it painted behind a still-parked focus ring.
    if (typeof region.scrollIntoView === 'function') {
      region.scrollIntoView({ block: 'start' });
    }
    region.focus({ preventScroll: true });
    // The conversation above is usually still being read when a reveal lands
    // on mount. When it arrives the content above grows, and a WebView with
    // no scroll anchoring (WKWebView) pushes the region off-screen. Re-assert
    // the scroll ONCE when that read settles — never the focus again.
    revealAwaitsTranscriptRef.current = !transcriptSettledRef.current;
  }, [evidenceReveal, threadId]);
  const stopFollowingRevealRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopFollowingRevealRef.current?.(), []);
  const onTranscriptSettledChange = useCallback((settled: boolean) => {
    transcriptSettledRef.current = settled;
    if (!settled || !revealAwaitsTranscriptRef.current) return;
    revealAwaitsTranscriptRef.current = false;
    const region = evidenceRegionRef.current;
    if (!region || typeof region.scrollIntoView !== 'function') return;
    region.scrollIntoView({ block: 'start' });
    // Rendered markdown and tool rows load lazily and can grow the
    // conversation again just after it settles. For at most one second, and
    // only until the reader scrolls, drags, touches or types, follow that growth —
    // scroll only, never focus. Bounded on purpose: after that the reader
    // owns the scroll position.
    const transcript = region
      .closest('.sessions-detail__scroll')
      ?.querySelector('[data-testid="session-transcript"]');
    const scroller = region.closest('.sessions-detail__scroll');
    if (!transcript || !scroller || typeof ResizeObserver === 'undefined')
      return;
    stopFollowingRevealRef.current?.();
    const observer = new ResizeObserver(() =>
      region.scrollIntoView({ block: 'start' }),
    );
    // The reader taking over: wheel, touch or a scrollbar drag (pointerdown)
    // on the scroll region, or any key anywhere in the document.
    const scrollerMoves = ['wheel', 'touchstart', 'pointerdown'] as const;
    const stop = () => {
      observer.disconnect();
      clearTimeout(timer);
      for (const type of scrollerMoves)
        scroller.removeEventListener(type, stop);
      document.removeEventListener('keydown', stop, true);
      if (stopFollowingRevealRef.current === stop)
        stopFollowingRevealRef.current = null;
    };
    const timer = setTimeout(stop, 1_000);
    for (const type of scrollerMoves)
      scroller.addEventListener(type, stop, { passive: true });
    document.addEventListener('keydown', stop, true);
    observer.observe(transcript);
    stopFollowingRevealRef.current = stop;
  }, []);

  const [delegating, setDelegating] = useState(false);
  const receipts = useOrchestrationCommandReceiptsQuery(threadId, {
    enabled: threadId.length > 0,
  });
  // #765 D6: the tile reads as the derived summary (actor kind · surface ·
  // when), never the raw device UUID; the exact detail string — UUID and
  // build included — stays reachable as the tile's tooltip.
  const latestOriginReceipt = receipts.data
    ?.slice()
    .reverse()
    .find((receipt) => receipt.clientOrigin !== undefined);
  const latestOrigin = latestOriginReceipt?.clientOrigin;
  const lastUserAction = receipts.isLoading
    ? 'Loading…'
    : receipts.isError
      ? 'unavailable'
      : clientOriginSummary(latestOrigin);
  const lastUserActionAtMs = latestOriginReceipt
    ? Date.parse(latestOriginReceipt.createdAt)
    : Number.NaN;
  const lastUserActionWhen =
    latestOrigin && Number.isFinite(lastUserActionAtMs)
      ? relativeTime(lastUserActionAtMs, Date.now())
      : null;

  // "Started from": the first recorded command origin, surface only. An
  // absent origin leaves the clause out; it is never printed as "unknown".
  const startedFrom = clientOriginSurfaceLabel(
    receipts.data?.find((receipt) => receipt.clientOrigin !== undefined)
      ?.clientOrigin,
  );
  const createdAtMs = Date.parse(session.createdAt);
  const meta = [
    agentLabel,
    // `reportedModel ?? effectiveModel ?? model` (archive#1249): the engine's
    // own report first; `model` alone is empty for a session started on an
    // agent's default model.
    session.reportedModel ?? session.effectiveModel ?? session.model,
    sessionProjectLabel(session),
    startedFrom ? `from ${startedFrom}` : null,
    // The compact time, last, where every row keeps it.
    Number.isFinite(createdAtMs) ? relativeTime(createdAtMs, Date.now()) : null,
  ];

  const parentTaskId = session.delegation?.taskId ?? threadId;
  const delegationProjectSlug =
    session.delegation?.projectSlug ?? session.projectSlug;
  const menuActions = [
    ...(chatOpenTarget
      ? [
          {
            key: 'turn-into-task',
            label: 'New Task from this',
            onSelect: () =>
              requestTaskShaping({
                projectSlug: session.projectSlug,
                source: {
                  sessionId: session.threadId,
                  conversationId: session.conversationId,
                  agentSlug: session.assignedAgentSlug,
                  agentName: agentLabel,
                },
              }),
          },
        ]
      : []),
    { key: 'copy-id', label: 'Copy session ID', onSelect: copySessionId },
    ...(isDelegated && !isPeerRecord
      ? [
          {
            key: 'delegate',
            label: 'Delegate subtask',
            onSelect: () => setDelegating(true),
          },
        ]
      : []),
  ];

  return (
    <section
      className={`sessions-detail${viewportIsCompact ? ' sessions-detail--viewport-compact' : ''}`}
      data-testid="session-detail"
      style={visualViewport.style}
    >
      <SessionDetailHeader
        session={session}
        agents={agents}
        title={title}
        meta={meta}
        isStopped={isStopped}
        connected={livePhase === 'caught-up'}
        connectionLabel={connectionLabel}
        currentActivity={currentTool ? `Using ${currentTool}` : undefined}
        onOpenInChat={openInChat}
        menuActions={menuActions}
      />

      <ConversationBody
        density="record"
        connection={connection}
        session={conversationSession ?? session}
        readOnly={isPeerRecord || conversationWritable === false}
        answeringDeniedReason={sessionUnanswerableNotice ?? undefined}
        reader={{
          agentLabel,
          agents,
          isStreaming,
          failureShownAbove: !isPeerRecord && Boolean(failureText),
          notices: historyNotices,
          onSettledChange: onTranscriptSettledChange,
          preserveReading: importantNotice || Boolean(evidenceReveal),
        }}
        scrollContainerRef={transcriptScrollRef}
        onChanged={onTaskChanged}
        composer={
          hideGenericCompose || isPeerRecord
            ? undefined
            : {
                input,
                onInputChange: setInput,
                onSent: (submitted) =>
                  setInput((current) => (current === submitted ? '' : current)),
                disabled: sessionUnanswerable || conversationWritable === false,
                reason:
                  sessionUnanswerableNotice ??
                  (conversationWritable === false
                    ? 'This conversation is read only for this connection.'
                    : undefined),
              }
        }
        beforeTranscript={
          <>
            <SessionDetailErrors
              failureText={failureText}
              failureNote={failureNote}
              onDismissFailure={acknowledgeFailure}
              dismissFailurePending={acknowledgeFailurePending}
              dismissFailureError={acknowledgeFailureError}
            />

            <OwnedWorkCleanup
              session={session}
              apiBase={apiBase}
              onRemoved={onTaskChanged}
            />

            <SessionDetailAttention
              checkFailed={attentionCheckFailed}
              errorMessage={attentionErrorMessage}
              onRetry={attentionRefetch}
              items={visibleAttentionItems}
              answerHere={!isPeerRecord}
            />
          </>
        }
        afterTranscript={
          <>
            <details
              ref={detailsRef}
              className="sessions-detail__disclosure"
              data-testid="session-details-disclosure"
            >
              <summary>Details</summary>
              <div className="sessions-detail__disclosure-body">
                <p className="sessions-detail__session-id">
                  <span>Session ID</span>
                  <code>{threadId}</code>
                  <Button variant="secondary" onClick={copySessionId}>
                    Copy ID
                  </Button>
                </p>
                <dl
                  className="sessions-detail__context"
                  aria-label="Task context"
                  ref={evidenceRegionRef}
                  tabIndex={-1}
                  data-testid="session-evidence-region"
                >
                  <div className="sessions-detail__context-item">
                    <dt>Last user action</dt>
                    <dd
                      title={
                        latestOrigin
                          ? clientOriginDetail(latestOrigin)
                          : undefined
                      }
                    >
                      {lastUserAction}
                      {lastUserActionWhen ? ` · ${lastUserActionWhen}` : ''}
                    </dd>
                  </div>
                  {rows.map((row) => (
                    <div
                      className="sessions-detail__context-item"
                      key={row.label}
                    >
                      <dt>{row.label}</dt>
                      <dd>{row.value}</dd>
                    </div>
                  ))}
                  {linkedFlowRun && (
                    <div
                      className="sessions-detail__context-item"
                      key="linked-flow"
                    >
                      <dt>Linked Flow</dt>
                      <dd>
                        <strong>
                          {flowRunDisplayIdentity(linkedFlowRun.definitionId)}
                        </strong>
                        <p className="sessions-detail__workflow-hint">
                          {linkedFlowStateLabel(linkedFlowRun.run.state)}
                          {linkedFlowRun.run.openGates.length > 0
                            ? ` · gates: ${linkedFlowRun.run.openGates.map((gate) => gate.id).join(', ')}`
                            : ''}
                        </p>
                      </dd>
                    </div>
                  )}
                  {/* archive#189. Its own row, always — never merged into "Linked
                Flow" above and never suppressed by it. They are two different
                runs with independent lifecycles, and a session routinely has
                one and not the other; one combined figure is how a
                permanently stalled delivery run came to read as builder
                progress. No freshness is claimed: `flow_run` carries no
                currency stamp upstream, so the row says where the values came
                from and stops. */}
                  {builderRun && (
                    <div className="sessions-detail__context-item">
                      <dt>Builder run</dt>
                      <dd>
                        <strong>{builderRun.taskSlug ?? 'Unavailable'}</strong>
                        <p className="sessions-detail__workflow-hint">
                          {builderRunMatchLabel(builderRun.matchKind)} ·{' '}
                          {builderRunIdentityLabel(builderRun.identityStatus)}
                        </p>
                        {builderRun.flowRun ? (
                          <p className="sessions-detail__workflow-hint">
                            {flowRunDisplayIdentity(
                              builderRun.flowRun.definition_id,
                            )}{' '}
                            · {builderRun.flowRun.current_step} ·{' '}
                            {builderRun.flowRun.status}
                            {builderRun.flowRun.open_gate_ids.length > 0
                              ? ` · gates: ${builderRun.flowRun.open_gate_ids.join(', ')}`
                              : ''}
                            {sidecarWriteProvenance(
                              builderRun.sidecarUpdatedAt,
                            )}
                          </p>
                        ) : (
                          /* Only for a sidecar that was actually READ. A binding
                       whose sidecar could not be opened is a broken binding,
                       not a run that has yet to publish, and saying otherwise
                       would assert a currency nobody has — directly above the
                       true reason. */
                          builderRun.taskSlug &&
                          !builderRun.taskSidecarUnreadable && (
                            <p className="sessions-detail__workflow-hint">
                              No run has been published for this task yet.
                            </p>
                          )
                        )}
                        {builderRun.reason && (
                          <p className="sessions-detail__workflow-hint">
                            {builderRun.reason}
                          </p>
                        )}
                      </dd>
                    </div>
                  )}
                  {!linkedFlowRun && workflowEntries.length > 0 && (
                    <div
                      className="sessions-detail__context-item"
                      key="workflow"
                    >
                      <dt>Project workflows</dt>
                      <dd>
                        <p className="sessions-detail__workflow-hint">
                          Active in this Project (not linked to this session).
                        </p>
                        <WorkflowStatusLineList
                          entries={workflowEntries}
                          moreCount={workflowMoreCount}
                        />
                      </dd>
                    </div>
                  )}
                </dl>

                <LazyBoundary
                  load={loadConversationPullRequestLinks}
                  // The durable conversation, not this Session's own thread: a
                  // successor Session (after a context reset or a handoff) is not
                  // a conversation id, and the links belong to the conversation.
                  componentProps={{
                    conversationId: session.conversationId ?? threadId,
                    linkFormCollapsed: true,
                  }}
                  pending={
                    <SkeletonBlock
                      label="Reading linked pull requests"
                      count={1}
                    />
                  }
                />

                <SessionDetailDiagnostics
                  eventCount={events.length}
                  entries={diagnosticsLog}
                />
              </div>
            </details>
          </>
        }
      />

      {isDelegated && !isPeerRecord && (
        <DelegationLauncher
          isOpen={delegating}
          apiBase={apiBase}
          projectSlug={delegationProjectSlug}
          projectName={
            delegationProjectSlug ? humanizeId(delegationProjectSlug) : null
          }
          currentAgentId={
            session.delegation?.targetId ?? session.assignedAgentSlug
          }
          currentModel={session.model}
          parentTaskId={parentTaskId}
          parentTaskLabel={humanizeId(parentTaskId)}
          onClose={() => setDelegating(false)}
          onDelegated={() => {
            setDelegating(false);
            onTaskChanged();
          }}
        />
      )}
    </section>
  );
}
