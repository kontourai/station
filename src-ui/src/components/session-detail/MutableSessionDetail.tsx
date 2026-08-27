import { flowRunDisplayIdentity } from '@kontourai/station-contracts';
import {
  type OrchestrationSessionSummary,
  useOrchestrationCommandReceiptsQuery,
} from '@kontourai/station-sdk';
import { useEffect, useRef } from 'react';
import type { OrchestrationEvent } from '../../hooks/orchestration/types';
import type { useMobileVisualViewport } from '../../hooks/useMobileVisualViewport';
import { useMutableSessionDetailState } from '../../hooks/useMutableSessionDetailState';
import { clientOriginDetail } from '../../utils/clientOrigin';
import {
  builderRunIdentityLabel,
  builderRunMatchLabel,
  linkedFlowStateLabel,
  sidecarWriteProvenance,
} from '../../utils/sessionDisplay';
import { Button } from '../Button';
import { WorkflowStatusLineList } from '../flow/WorkflowStatusLine';
import { SessionDetailAttention } from './SessionDetailAttention';
import { SessionDetailDiagnostics } from './SessionDetailDiagnostics';
import { SessionDetailErrors } from './SessionDetailErrors';
import { SessionDetailHeader } from './SessionDetailHeader';

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
 * (station#1204 AC1); this component owns only the render tree, composed
 * from the header/errors/attention/diagnostics sections (AC2) plus the
 * task-context, live-request, and compose blocks that don't warrant their
 * own file yet.
 */
export function MutableSessionDetail({
  apiBase,
  session,
  onTaskChanged,
  events,
  connected,
  visualViewport,
  evidenceReveal,
}: {
  apiBase: string;
  session: OrchestrationSessionSummary;
  onTaskChanged: () => void;
  events: OrchestrationEvent[];
  connected: boolean;
  visualViewport: ReturnType<typeof useMobileVisualViewport>;
  evidenceReveal?: SessionEvidenceReveal | null;
}) {
  const {
    input,
    setInput,
    isDelegated,
    sendTurn,
    respond,
    stopTask,
    pendingRequest,
    pendingRequestPresentation,
    isStreaming,
    isStopped,
    isFailed,
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

  // The evidence region: the context list below holds the receipts-backed
  // "Last user action" row (plus linked flow/builder runs), and the
  // diagnostics log sits directly under it in the same scroll region — so
  // scrolling the list's start into view presents both.
  const evidenceRegionRef = useRef<HTMLDListElement | null>(null);
  const revealedEvidenceTokenRef = useRef<number | null>(null);
  useEffect(() => {
    if (!evidenceReveal || evidenceReveal.threadId !== threadId) return;
    if (revealedEvidenceTokenRef.current === evidenceReveal.token) return;
    // Consume the token BEFORE acting: an intent whose target is absent is a
    // completed no-op, never a scroll deferred to some surprising later
    // render.
    revealedEvidenceTokenRef.current = evidenceReveal.token;
    const region = evidenceRegionRef.current;
    if (!region) return;
    // Same shape as `revealHomeRegion` (views/home/home-reveal.ts): a plain
    // positioned scroll — jsdom implements none of it, hence the guard —
    // then focus, so a keyboard or screen-reader user lands IN the region
    // rather than having it painted behind a still-parked focus ring.
    if (typeof region.scrollIntoView === 'function') {
      region.scrollIntoView({ block: 'start' });
    }
    region.focus({ preventScroll: true });
  }, [evidenceReveal, threadId]);

  const receipts = useOrchestrationCommandReceiptsQuery(threadId, {
    enabled: threadId.length > 0,
  });
  const latestOrigin = receipts.data
    ?.slice()
    .reverse()
    .find((receipt) => receipt.clientOrigin !== undefined)?.clientOrigin;
  const lastUserAction = receipts.isLoading
    ? 'Loading receipt provenance…'
    : receipts.isError
      ? 'unavailable'
      : clientOriginDetail(latestOrigin);

  return (
    <section
      className={`sessions-detail${viewportIsCompact ? ' sessions-detail--viewport-compact' : ''}`}
      data-testid="session-detail"
      style={visualViewport.style}
    >
      <SessionDetailHeader
        session={session}
        title={title}
        threadId={threadId}
        eventCount={events.length}
        isFailed={isFailed}
        isStopped={isStopped}
        isStreaming={isStreaming}
        connected={connected}
        stopTaskPending={stopTask.isPending}
        onStopTask={() => stopTask.mutate()}
        onCopySessionId={copySessionId}
      />

      {/* station#3305: one scroll region for everything between the pinned
          header and the pinned request/compose controls. The previous fixed
          grid template assigned one flexible row by position, so any other
          section that grew (error stacks, multiple attention cards, the
          context grid) was clipped with no way to reach it. */}
      <div className="sessions-detail__scroll">
        <SessionDetailErrors
          failureText={failureText}
          stopTaskError={stopTask.error}
          sendTurnError={sendTurn.error}
          respondError={respond.error}
        />

        <SessionDetailAttention
          checkFailed={attentionCheckFailed}
          errorMessage={attentionErrorMessage}
          onRetry={attentionRefetch}
          items={visibleAttentionItems}
        />

        <dl
          className="sessions-detail__context"
          aria-label="Task context"
          ref={evidenceRegionRef}
          tabIndex={-1}
          data-testid="session-evidence-region"
        >
          <div className="sessions-detail__context-item">
            <dt>Last user action</dt>
            <dd>{lastUserAction}</dd>
          </div>
          {rows.map((row) => (
            <div className="sessions-detail__context-item" key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
          {linkedFlowRun && (
            <div className="sessions-detail__context-item" key="linked-flow">
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
          {/* station#189 S4. Its own row, always — never merged into "Linked
            Flow" above and never suppressed by it. They are two different
            runs with independent lifecycles, and a session routinely has one
            and not the other; one combined figure is how a permanently
            stalled delivery run came to read as builder progress. No
            freshness is claimed: `flow_run` carries no currency stamp
            upstream, so the row says where the values came from and stops. */}
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
                    {flowRunDisplayIdentity(builderRun.flowRun.definition_id)} ·{' '}
                    {builderRun.flowRun.current_step} ·{' '}
                    {builderRun.flowRun.status}
                    {builderRun.flowRun.open_gate_ids.length > 0
                      ? ` · gates: ${builderRun.flowRun.open_gate_ids.join(', ')}`
                      : ''}
                    {sidecarWriteProvenance(builderRun.sidecarUpdatedAt)}
                  </p>
                ) : (
                  /* Only for a sidecar that was actually READ. A binding whose
                   sidecar could not be opened is a broken binding, not a run
                   that has yet to publish, and saying otherwise would assert
                   a currency nobody has — directly above the true reason. */
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
                  Not linked to this session — active flow-agents tasks in this
                  project workspace.
                </p>
                <WorkflowStatusLineList
                  entries={workflowEntries}
                  moreCount={workflowMoreCount}
                />
              </dd>
            </div>
          )}
        </dl>

        <SessionDetailDiagnostics
          eventCount={events.length}
          entries={diagnosticsLog}
        />
      </div>

      {/* Review MEDIUM (station#1170): guarded on !isStopped like Stop task
          and the live indicator above — a session that crashes mid-request
          must not leave Approve/Decline clickable against a dead session.
          Stopped (`completed`/`failed`/`canceled`), not terminal
          (station#3244): the composer below reappears on a retryable failed
          session, but this card kept #1170's behavior. Disclosed tension,
          not resolved here: the server's own answerability model
          (`open-requests.ts`, `canSessionLifecycleStateResume`) holds that a
          request open when a session FAILED is still pertinent — the retry
          re-enters `running` directly — so hiding this card on `failed` can
          hide an answerable request. A `pendingReview` approval survives as
          an attention item (station#1548), but a bare in-turn request does
          not. Aligning this gate with the resume predicate is a deliberate
          product call for its own issue, exactly as #3213 treated #3244. */}
      {!isStopped && pendingRequest && pendingRequestPresentation && (
        <div className="sessions-detail__request" data-testid="session-request">
          <div className="sessions-detail__request-copy">
            <span className="sessions-detail__request-label">
              {pendingRequestPresentation.label}
            </span>
            <strong>{pendingRequest.title}</strong>
          </div>
          {/* station#1781 AC4: the card RENDERS for an unanswerable session —
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

      {!hideGenericCompose && (
        <>
          <div className="sessions-detail__compose">
            <textarea
              className="sessions-detail__input"
              placeholder={
                isStreaming
                  ? 'Session is mid-turn — wait for it to finish…'
                  : isDelegated
                    ? 'Add a follow-up for this task…'
                    : 'Send input to this session…'
              }
              aria-label={
                isDelegated
                  ? 'Continue delegated task'
                  : 'Send input to session'
              }
              value={input}
              disabled={isStreaming}
              onChange={(e) => setInput(e.target.value)}
            />
            <Button
              variant="primary"
              disabled={!canSend}
              onClick={() => sendTurn.mutate()}
            >
              {isDelegated ? 'Continue' : 'Send'}
            </Button>
          </div>
          {/* Honest limit: there is no mid-turn steering server-side
              (SDK-blocked); input lands as the next turn once the current
              one settles. */}
          <p className="sessions-detail__note">
            Turn-based: messages are delivered between turns, not injected
            mid-stream.
          </p>
        </>
      )}
    </section>
  );
}
