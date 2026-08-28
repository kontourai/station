import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { sessionStatusWord } from '../../utils/session-state';
import { displayProvider, sessionKindLabel } from '../../utils/sessionDisplay';
import { Button } from '../Button';

/**
 * The session detail page's identity block — kind label, title, thread id
 * (with copy affordance), provider/model/status/live-indicator meta row,
 * and the Stop task action. Split out of `MutableSessionDetail` per
 * archive#1204; the compact-viewport CSS contract
 * (`.sessions-detail--viewport-compact .sessions-detail__eyebrow` etc. in
 * SessionsView.css) depends on these exact class names staying put here.
 */
export function SessionDetailHeader({
  session,
  title,
  threadId,
  eventCount,
  isFailed,
  isStopped,
  isStreaming,
  connected,
  stopTaskPending,
  onStopTask,
  onCopySessionId,
}: {
  session: OrchestrationSessionSummary;
  title: string;
  threadId: string;
  eventCount: number;
  isFailed: boolean;
  /**
   * `isSessionLifecycleStateStopped` semantics — the session records a run
   * outcome (`completed`/`failed`/`canceled`) and is not doing work. The
   * live indicator and Stop task are gated on this, NOT on terminality
   * (archive#3244): a failed session is retryable, so its composer stays,
   * but "failed AND live AND Stop task" is still the contradiction
   * archive#1170 removed.
   */
  isStopped: boolean;
  isStreaming: boolean;
  connected: boolean;
  stopTaskPending: boolean;
  onStopTask: () => void;
  onCopySessionId: () => void;
}) {
  return (
    <header className="sessions-detail__header">
      <div>
        <p className="sessions-detail__eyebrow">{sessionKindLabel(session)}</p>
        <h2>{title}</h2>
        <p className="sessions-detail__subtle-id">
          <span>{threadId}</span>
          <button
            type="button"
            className="sessions-detail__copy-id"
            onClick={onCopySessionId}
          >
            Copy ID
          </button>
        </p>
        <p className="sessions-detail__meta">
          <span>{displayProvider(session)}</span>
          {/*
           * `reportedModel ?? effectiveModel ?? model`, not `model` alone.
           * The external engine's reported model is the clearest runtime
           * identity and also protects historical sessions from a malformed
           * selector that was persisted before catalog normalization. `model` is only
           * populated when a caller supplied an explicit `modelId` at session
           * start; `effectiveModel` is resolved later from
           * `session.configured`/`turn.started` metadata and is what a
           * session started on an agent's default model carries. The context
           * card this replaces used the same fallback, so reading `model`
           * only here made the model render NOWHERE for those sessions
           * (review of archive#1249, probe-confirmed).
           */}
          {(session.reportedModel ??
            session.effectiveModel ??
            session.model) && (
            <span>
              {session.reportedModel ?? session.effectiveModel ?? session.model}
            </span>
          )}
          <span
            className={
              isFailed
                ? 'sessions-detail__status sessions-detail__status--failed'
                : 'sessions-detail__status'
            }
          >
            {sessionStatusWord(session)}
          </span>
          <span>
            {eventCount} event{eventCount === 1 ? '' : 's'}
          </span>
          {!isStopped && (
            <span className="sessions-detail__live-indicator">
              {connected ? '● live' : '○ connecting'}
            </span>
          )}
        </p>
      </div>
      {!isStopped && isStreaming && (
        <Button
          variant="secondary"
          className="sessions-detail__stop-task"
          disabled={stopTaskPending}
          onClick={onStopTask}
        >
          {stopTaskPending ? 'Stopping…' : 'Stop task'}
        </Button>
      )}
    </header>
  );
}
