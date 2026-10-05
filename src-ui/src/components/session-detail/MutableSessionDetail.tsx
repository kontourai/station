import { flowRunDisplayIdentity } from '@kontourai/station-contracts';
import {
  type OrchestrationSessionSummary,
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
import { useAgents } from '../../contexts/AgentsContext';
import { openChatsStore } from '../../contexts/open-chats-store';
import {
  getStreamConnectionState,
  subscribeStreamConnectionState,
} from '../../hooks/orchestration/streamConnectionState';
import type { OrchestrationEvent } from '../../hooks/orchestration/types';
import type { useMobileVisualViewport } from '../../hooks/useMobileVisualViewport';
import { useMutableSessionDetailState } from '../../hooks/useMutableSessionDetailState';
import {
  clientOriginDetail,
  clientOriginSummary,
  clientOriginSurfaceLabel,
} from '../../utils/clientOrigin';
import { errorAgentDraft } from '../../utils/errorAgentDraft';
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
import { WorkflowStatusLineList } from '../flow/WorkflowStatusLine';
import { LazyBoundary } from '../LazyBoundary';
import { ConfirmModal } from '../modals/ConfirmModal';
import { SkeletonBlock } from '../state';
import { SessionDetailAttention } from './SessionDetailAttention';
import { SessionDetailDiagnostics } from './SessionDetailDiagnostics';
import { SessionDetailErrors } from './SessionDetailErrors';
import { SessionDetailHeader } from './SessionDetailHeader';
import { SessionTranscript } from './SessionTranscript';
import {
  isPeerDelegationRecord,
  PEER_TRANSCRIPT_ELSEWHERE,
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

/**
 * The mutable (station-owned, still-live-or-terminal) session detail page.
 * State/query/mutation wiring lives in `useMutableSessionDetailState`
 * (archive#1204); this component owns only the render tree.
 *
 * Reading order, top to bottom: the header (what this is, its state, Open in
 * chat / Stop… / ⋯); what needs you (the one failure card, attention items);
 * the conversation itself (read-only, live while a turn streams); then a
 * collapsed Details disclosure holding the evidence rows, the session id,
 * linked pull requests and the raw event log. The live request card and the
 * reply composer stay pinned below the scroll region so they are reachable
 * without scrolling, including on a phone with the keyboard open.
 */
export function MutableSessionDetail({
  apiBase,
  session,
  onTaskChanged,
  events,
  visualViewport,
  evidenceReveal,
  historyNotices,
}: {
  apiBase: string;
  session: OrchestrationSessionSummary;
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
    sendTurn,
    sendTurnPending,
    sendTurnError,
    respond,
    stopTask,
    pendingRequest,
    pendingRequestPresentation,
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
    canSend,
    linkedFlowRun,
    builderRun,
    workflowEntries,
    workflowMoreCount,
  } = useMutableSessionDetailState({
    apiBase,
    session,
    onTaskChanged,
    events,
    visualViewport,
  });

  const threadId = session.threadId;
  const sendError = sendTurnError ?? sendTurn.error;
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const livePhase = useSyncExternalStore(
    subscribeStreamConnectionState,
    () => getStreamConnectionState(apiBase).phase,
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
    failureText ||
      attentionCheckFailed ||
      visibleAttentionItems.length ||
      sendError ||
      respond.error ||
      stopTask.error,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new request failure must reveal its notice even when an earlier notice keeps the boolean true.
  useEffect(() => {
    if (importantNotice && transcriptScrollRef.current) {
      transcriptScrollRef.current.scrollTop = 0;
    }
  }, [importantNotice, sendError, respond.error]);
  const agentLabel = sessionAgentLabel(session, useAgents());
  // Open in chat goes through the shared open-chat focus (archive#1297), the
  // seam Home and the project page use: the chat dock rehydrates the real
  // conversation. Absent when there is no chat to rehydrate.
  // A delegated task running on a PAIRED Station: this Station only records
  // its lifecycle. The stored agent slug and conversation id are the PEER's,
  // so opening, stopping, replying or delegating from here would act on a
  // local id that names nothing (or something else). None are offered; the
  // detail says where the transcript lives instead.
  const isPeerRecord = isPeerDelegationRecord(session);
  const chatOpenTarget = isPeerRecord ? null : sessionChatOpenTarget(session);
  const openInChat = chatOpenTarget
    ? () => openChatsStore.focus(chatOpenTarget)
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
    // Same shape as `revealHomeRegion` (views/home/home-reveal.ts): a plain
    // positioned scroll — jsdom implements none of it, hence the guard —
    // then focus, so a keyboard or screen-reader user lands IN the region
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

  const [confirmStop, setConfirmStop] = useState(false);
  const [delegating, setDelegating] = useState(false);
  const canStop = !isPeerRecord && !isStopped && isStreaming;
  // The turn ended while the confirmation was open: there is nothing left to
  // stop, so the question is withdrawn rather than answered against a turn
  // that already finished.
  useEffect(() => {
    if (confirmStop && !canStop && !stopTask.isPending) setConfirmStop(false);
  }, [confirmStop, canStop, stopTask.isPending]);

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
    ? 'Loading receipt provenance…'
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
        title={title}
        meta={meta}
        isStopped={isStopped}
        isStreaming={canStop}
        connected={livePhase === 'caught-up'}
        connectionLabel={connectionLabel}
        currentActivity={currentTool ? `Using ${currentTool}` : undefined}
        stopTaskPending={stopTask.isPending}
        onRequestStop={() => setConfirmStop(true)}
        onOpenInChat={openInChat}
        menuActions={menuActions}
      />

      {/* Open requests stay above the transcript; stopped-session and
          answerability gates still belong to the canonical owner. */}
      {!isPeerRecord &&
        !isStopped &&
        pendingRequest &&
        pendingRequestPresentation && (
          <div
            className="sessions-detail__request"
            data-testid="session-request"
          >
            <div className="sessions-detail__request-copy">
              <span className="sessions-detail__request-label">
                {pendingRequestPresentation.label}
              </span>
              <strong>{pendingRequest.title}</strong>
            </div>
            {/* archive#1781: the card RENDERS for an unanswerable session —
              deleting it would be the silent filtering ADR 0012 forbids, and
              the request really is still open. What it must not do is offer
              Approve/Deny that dispatch into nothing, so the buttons are
              disabled and the observation that disabled them is named. */}
            {sessionUnanswerableNotice && (
              <p
                id="session-request-answerability-note"
                className="sessions-detail__request-note"
                data-testid="session-request-answerability"
              >
                {sessionUnanswerableNotice}
              </p>
            )}
            <div className="sessions-detail__request-actions">
              <Button
                variant="primary"
                disabled={respond.isPending || sessionUnanswerable}
                aria-describedby={
                  sessionUnanswerable
                    ? 'session-request-answerability-note'
                    : undefined
                }
                onClick={() => respond.mutate('accept')}
              >
                {pendingRequestPresentation.accept}
              </Button>
              <Button
                variant="secondary"
                disabled={respond.isPending || sessionUnanswerable}
                aria-describedby={
                  sessionUnanswerable
                    ? 'session-request-answerability-note'
                    : undefined
                }
                onClick={() => respond.mutate('decline')}
              >
                {pendingRequestPresentation.decline}
              </Button>
            </div>
          </div>
        )}

      {/* archive#3305: one scroll region for everything between the pinned
          header and the pinned request/compose controls. The previous fixed
          grid template assigned one flexible row by position, so any other
          section that grew (error stacks, multiple attention cards, the
          context grid) was clipped with no way to reach it. */}
      <div className="sessions-detail__scroll" ref={transcriptScrollRef}>
        <SessionDetailErrors
          failureText={failureText}
          failureNote={failureNote}
          onDismissFailure={acknowledgeFailure}
          dismissFailurePending={acknowledgeFailurePending}
          dismissFailureError={acknowledgeFailureError}
          stopTaskError={confirmStop ? null : stopTask.error}
          sendTurnError={sendError}
          respondError={respond.error}
          onDraftSendError={
            sendError && !hideGenericCompose && !isStreaming
              ? () => {
                  const draft = errorAgentDraft({
                    attempted: 'Continue session',
                    error: sendError,
                    context: {
                      threadId,
                      provider: session.provider,
                      lifecycleState: session.lifecycleState,
                    },
                  });
                  setInput((current) =>
                    current.trim() ? `${current}\n\n${draft}` : draft,
                  );
                }
              : undefined
          }
        />

        <SessionDetailAttention
          checkFailed={attentionCheckFailed}
          errorMessage={attentionErrorMessage}
          onRetry={attentionRefetch}
          items={visibleAttentionItems}
          answerHere={!isPeerRecord}
        />

        {isPeerRecord ? (
          <p
            className="sessions-detail__peer-note"
            data-testid="session-peer-transcript-note"
          >
            {PEER_TRANSCRIPT_ELSEWHERE}
          </p>
        ) : (
          <SessionTranscript
            apiBase={apiBase}
            session={session}
            agentLabel={agentLabel}
            isStreaming={isStreaming}
            failureShownAbove={Boolean(failureText)}
            notices={historyNotices}
            onSettledChange={onTranscriptSettledChange}
            scrollContainerRef={transcriptScrollRef}
            preserveReading={importantNotice || Boolean(evidenceReveal)}
          />
        )}

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
                    latestOrigin ? clientOriginDetail(latestOrigin) : undefined
                  }
                >
                  {lastUserAction}
                  {lastUserActionWhen ? ` · ${lastUserActionWhen}` : ''}
                </dd>
              </div>
              {rows.map((row) => (
                <div className="sessions-detail__context-item" key={row.label}>
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
                        {sidecarWriteProvenance(builderRun.sidecarUpdatedAt)}
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
                <div className="sessions-detail__context-item" key="workflow">
                  <dt>Project workflows</dt>
                  <dd>
                    <p className="sessions-detail__workflow-hint">
                      Not linked to this session — active flow-agents tasks in
                      this project workspace.
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
                <SkeletonBlock label="Reading linked pull requests" count={1} />
              }
            />

            <SessionDetailDiagnostics
              eventCount={events.length}
              entries={diagnosticsLog}
            />
          </div>
        </details>
      </div>

      {!hideGenericCompose && !isPeerRecord && (
        <>
          <div className="sessions-detail__compose">
            <textarea
              className="sessions-detail__input"
              placeholder={
                isDelegated
                  ? 'Add a follow-up for this task…'
                  : `Reply to ${agentLabel}…`
              }
              aria-label={
                isDelegated
                  ? 'Continue delegated task'
                  : 'Send input to session'
              }
              aria-describedby={
                isStreaming ? 'session-compose-turn-note' : undefined
              }
              value={input}
              disabled={isStreaming}
              onChange={(e) => setInput(e.target.value)}
            />
            <Button
              variant="primary"
              disabled={!canSend}
              onClick={() => sendTurn.mutate({ text: input })}
            >
              {sendTurnPending ? 'Sending…' : 'Send'}
            </Button>
          </div>
          {/* Honest limit: there is no mid-turn steering here, and this
              composer is disabled while a turn runs. Said only then. */}
          {isStreaming && (
            <p id="session-compose-turn-note" className="sessions-detail__note">
              You can reply when the current turn finishes.
            </p>
          )}
        </>
      )}

      <ConfirmModal
        isOpen={confirmStop}
        title="Stop this task?"
        message="Station interrupts the turn that is running now. The session stays open, so you can send it another message afterward."
        confirmLabel="Stop task"
        cancelLabel="Keep running"
        variant="danger"
        role="alertdialog"
        pending={stopTask.isPending}
        error={
          stopTask.error
            ? stopTask.error instanceof Error
              ? stopTask.error.message
              : 'Unable to stop this task'
            : null
        }
        onCancel={() => setConfirmStop(false)}
        confirmDisabled={!canStop}
        onConfirm={() => {
          if (!canStop) return;
          stopTask.mutate(undefined, {
            onSuccess: () => setConfirmStop(false),
          });
        }}
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
