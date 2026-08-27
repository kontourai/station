import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import {
  interruptOrchestrationTurn,
  sendOrchestrationTurn,
} from '@kontourai/station-sdk';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { sessionAnswerabilityView } from '../../utils/answerability';
import { sessionStatusWord } from '../../utils/session-state';
import {
  delegationTargetLabel,
  displayEnvironment,
  isStreamingSession,
  isTerminalSession,
  sessionTitle,
} from '../../utils/sessionDisplay';
import { Button } from '../Button';

/**
 * The sessions list's "Delegated work" intro card — the single
 * highest-priority delegated task, with its own inline follow-up composer
 * and controls. Split out of `SessionsView` per station#1204.
 */
export function DelegatedTaskCoordinator({
  apiBase,
  tasks,
  onOpen,
  onDelegate,
  onTaskChanged,
}: {
  apiBase: string;
  tasks: OrchestrationSessionSummary[];
  onOpen: (threadId: string) => void;
  onDelegate: (trigger: HTMLButtonElement) => void;
  onTaskChanged: () => void;
}) {
  const task = tasks[0];
  const [input, setInput] = useState('');

  const sendTurn = useMutation({
    mutationFn: () =>
      sendOrchestrationTurn({
        threadId: task.threadId,
        text: input,
        apiBase,
      }),
    onSuccess: () => {
      setInput('');
      onTaskChanged();
    },
  });
  const stopTask = useMutation({
    mutationFn: () =>
      interruptOrchestrationTurn({ threadId: task.threadId, apiBase }),
    onSuccess: onTaskChanged,
  });

  // station#3139: this card rendered `lifecycleState` verbatim, so the wire
  // identifier (`needs_input`, `review_pending`) was the status a user read.
  // station#3227 A1: routing through `sessionLifecycleLabel` fixed the
  // vocabulary but not the FACT — that helper knows nothing about
  // `hasActiveTurn`, `status: 'closed'` or answerability, so this card could
  // say "Running" for a task the Sessions list had already filed under
  // Recently finished. `sessionStatusWord` is the shared fold every session
  // surface now prints; there is no second spelling of a session's state.
  const state = sessionStatusWord(task);
  const isStreaming = isStreamingSession(task);
  const isTerminal = isTerminalSession(task);
  // station#1781: `needsReview` is the raw fold, and since station#1791 it
  // stays true forever for a session nothing can answer. `liveReview` is the
  // one that may drive an affordance; `needsReview` still drives the copy,
  // because the request IS still open and saying otherwise would be the
  // silent filtering ADR 0012 forbids.
  const needsReview =
    task.pendingReview || task.lifecycleState === 'review_pending';
  // Scoped to a review that is actually pending, and to a non-terminal task
  // (review's blocking finding). `answerability` answers a question about an
  // OPEN REQUEST: a detached `completed` task takes the `past_resume` arm, so
  // after any restart every cleanly-finished delegated task reads
  // `answerable: false`. Reading it unscoped annotated all of them with "the
  // session cannot resume" — true, and about nothing the user asked for.
  const answerability = sessionAnswerabilityView(task);
  const isUnanswerable = answerability.status === 'unanswerable';
  // Both derive from the same independent facts. Deriving `liveReview` from
  // `unanswerableNotice === null` instead made the terminal case lie: the
  // `!isTerminal` term forced the notice to null before `answerability` was
  // consulted, so a stale-`pendingReview` completed task read as "not
  // unanswerable" and rendered a live "waiting for your response" plus an
  // active Review request — the exact false attention claim this scoping
  // exists to remove, and with the View task fallback suppressed too.
  const unanswerableNotice =
    needsReview && !isTerminal && isUnanswerable ? answerability.notice : null;
  const liveReview = needsReview && !isTerminal && !isUnanswerable;
  const environment =
    task.delegation?.environmentName ??
    displayEnvironment(task.delegation?.environmentId);
  const mutationError = sendTurn.error ?? stopTask.error;

  return (
    <section
      className="sessions-coordinator"
      data-testid="delegated-task-coordinator"
      aria-labelledby="delegated-task-coordinator-title"
    >
      <header className="sessions-coordinator__header">
        <div>
          <p className="sessions-coordinator__eyebrow">Delegated work</p>
          {/*
            station#3227 C1: this was `humanizeId(taskId ?? threadId)`, and
            `humanizeId` is a NO-OP on a content-derived thread id — so a
            delegated session with no `taskId` put a raw hash in this heading
            while the list row beside it showed the session's real name. It
            also ignored `displayTitle` entirely, so a session the server HAD
            named read as its bare task id here. `sessionTitle` is the one
            name a session is listed under, and the coordinator heading is
            now that same name.
          */}
          <h3 id="delegated-task-coordinator-title">{sessionTitle(task)}</h3>
        </div>
        <span className="sessions-coordinator__count">
          {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
        </span>
      </header>

      <div className="sessions-coordinator__meta">
        <span>{delegationTargetLabel(task)}</span>
        <span>{task.model ?? task.provider}</span>
        {environment && <span>{environment}</span>}
        <span>{state}</span>
      </div>

      {liveReview && (
        <p className="sessions-coordinator__notice">
          This worker is waiting for your response.
        </p>
      )}
      {unanswerableNotice && (
        <p
          className="sessions-coordinator__notice"
          data-testid="coordinator-answerability"
        >
          {unanswerableNotice}
        </p>
      )}
      {task.blockedReason && (
        <p className="sessions-coordinator__notice">{task.blockedReason}</p>
      )}
      {mutationError && (
        <p className="sessions-coordinator__error" role="alert">
          {mutationError instanceof Error
            ? mutationError.message
            : 'Unable to update this task'}
        </p>
      )}

      {/* station#1781: gated on `liveReview`, not `needsReview`. A request
          nothing can answer no longer owns the response affordance, so
          suppressing the composer for it left the card with no way to act at
          all. Sending still round-trips and fails loudly server-side —
          enforcement stays there, never here. */}
      {!liveReview && !isStreaming && !isTerminal && (
        <form
          className="sessions-coordinator__compose"
          onSubmit={(event) => {
            event.preventDefault();
            if (input.trim() && !sendTurn.isPending) sendTurn.mutate();
          }}
        >
          <input
            aria-label="Direct worker follow-up"
            placeholder="Give the next instruction…"
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
          <Button
            type="submit"
            variant="primary"
            disabled={!input.trim() || sendTurn.isPending}
          >
            {sendTurn.isPending ? 'Sending…' : 'Send follow-up'}
          </Button>
        </form>
      )}

      <div className="sessions-coordinator__actions">
        {liveReview && (
          <Button variant="primary" onClick={() => onOpen(task.threadId)}>
            Review request
          </Button>
        )}
        {isStreaming && !isTerminal && (
          <Button
            variant="danger-outline"
            disabled={stopTask.isPending}
            onClick={() => stopTask.mutate()}
          >
            {stopTask.isPending ? 'Stopping…' : 'Stop active task'}
          </Button>
        )}
        {/* station#1781 AC2: navigation stays available for an unanswerable
            task — the annotation replaces the action, not the route to it. */}
        {!liveReview && (
          <Button variant="secondary" onClick={() => onOpen(task.threadId)}>
            View task
          </Button>
        )}
        <Button
          variant="secondary"
          onClick={(event) => onDelegate(event.currentTarget)}
        >
          Delegate subtask
        </Button>
      </div>
    </section>
  );
}

/**
 * The sessions list's "Delegated work" intro card before any delegated
 * task exists yet — a single call to action that opens the same delegation
 * launcher `DelegatedTaskCoordinator` uses.
 */
export function DelegatedTaskStarter({
  onDelegate,
}: {
  onDelegate: (trigger: HTMLButtonElement) => void;
}) {
  return (
    <section
      className="sessions-coordinator sessions-coordinator--starter"
      data-testid="delegated-task-starter"
      aria-labelledby="delegated-task-starter-title"
    >
      <div>
        <p className="sessions-coordinator__eyebrow">Delegated work</p>
        <h3 id="delegated-task-starter-title">Hand off a bounded task</h3>
      </div>
      <p className="sessions-coordinator__notice">
        Start a resumable worker on this Station or a saved SSH environment.
      </p>
      <div className="sessions-coordinator__actions">
        <Button
          variant="primary"
          onClick={(event) => onDelegate(event.currentTarget)}
        >
          Delegate worker
        </Button>
      </div>
    </section>
  );
}
