import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { describe, expect, test } from 'vitest';
import { isSessionUnanswerable } from '../utils/answerability';
import {
  delegatedTaskPriority,
  isTerminalSession,
  prioritizedDelegatedTasks,
} from '../utils/sessionDisplay';

/**
 * archive#1781 — the session-display fold family, made answerability-aware.
 *
 * The live regression this closes: archive#1791 retired the boot-time
 * cancellation write, so a dead session's `pendingReview` /
 * `lifecycleState: 'review_pending'` never converge. `delegatedTaskPriority`
 * returned 0 — the HIGHEST rank — for exactly that shape, and
 * `DelegatedTaskCoordinator` renders `tasks[0]` only. One stranded task
 * therefore occupied the single coordinator slot indefinitely while live
 * work sat behind it.
 */

const observation = {
  answerable: false,
  qualification: 'provider_absent',
  observedBy: 'station-7f3a',
  observedAt: '2026-08-03T12:04:03.000Z',
} as const;

function task(
  overrides: Partial<OrchestrationSessionSummary>,
): OrchestrationSessionSummary {
  return {
    provider: 'acme',
    threadId: 'thread-x',
    status: 'ready',
    controlMode: 'station-owned',
    answerability: { answerable: true },
    delegation: { taskId: 'task-x' },
    isLoaded: true,
    isPersisted: true,
    eventCount: 1,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:01.000Z',
    ...overrides,
  };
}

describe('delegatedTaskPriority', () => {
  test('AC1: a dead review_pending session ranks BELOW every live session', () => {
    const dead = task({
      threadId: 'dead',
      lifecycleState: 'review_pending',
      pendingReview: true,
      answerability: observation,
    });
    const liveReview = task({
      threadId: 'live-review',
      lifecycleState: 'review_pending',
      pendingReview: true,
    });
    const streaming = task({ threadId: 'streaming', hasActiveTurn: true });
    const idle = task({ threadId: 'idle', lifecycleState: 'queued' });

    expect(delegatedTaskPriority(dead)).toBeGreaterThan(
      delegatedTaskPriority(liveReview),
    );
    expect(delegatedTaskPriority(dead)).toBeGreaterThan(
      delegatedTaskPriority(streaming),
    );
    expect(delegatedTaskPriority(dead)).toBeGreaterThan(
      delegatedTaskPriority(idle),
    );
  });

  test('AC1 rejection path: leaving it at rank 0 would put the dead task first', () => {
    // The exact ordering assertion the rejection path names: the dead
    // session must not be `tasks[0]`, because that slot is the whole
    // coordinator card.
    const dead = task({
      threadId: 'dead',
      lifecycleState: 'review_pending',
      pendingReview: true,
      answerability: observation,
      updatedAt: '2026-08-03T23:59:59.000Z', // newest, so recency cannot rescue it
    });
    const live = task({ threadId: 'live', lifecycleState: 'queued' });
    const ordered = prioritizedDelegatedTasks([dead, live]);
    expect(ordered[0]?.threadId).toBe('live');
  });

  test('AC1 (anti-filter): the dead task is still IN the list, just lower', () => {
    // De-prioritize, never delete: its card is where the annotation lives.
    const dead = task({ threadId: 'dead', answerability: observation });
    const live = task({ threadId: 'live' });
    expect(
      prioritizedDelegatedTasks([dead, live])
        .map((s) => s.threadId)
        .sort(),
    ).toEqual(['dead', 'live']);
  });

  test('an unanswerable non-terminal task still outranks a finished one', () => {
    const unanswerable = task({ answerability: observation });
    const completed = task({ lifecycleState: 'completed' });
    expect(delegatedTaskPriority(unanswerable)).toBeLessThan(
      delegatedTaskPriority(completed),
    );
  });

  test('AC5 (control): an answerable session ranks exactly as it did', () => {
    expect(
      delegatedTaskPriority(
        task({ lifecycleState: 'review_pending', pendingReview: true }),
      ),
    ).toBe(0);
    expect(delegatedTaskPriority(task({ hasActiveTurn: true }))).toBe(1);
    expect(delegatedTaskPriority(task({ lifecycleState: 'queued' }))).toBe(2);
    expect(delegatedTaskPriority(task({ lifecycleState: 'completed' }))).toBe(
      4,
    );
  });
});

describe('terminal and unanswerable are independent facts', () => {
  test('AC5 (control): a failed session is terminal but NOT unanswerable', () => {
    // `past_resume` is `{completed, canceled}` only — `failed -> queued |
    // running` is a live retry path (archive#1090). A predicate that treated
    // `failed` as unanswerable would defeat that retry design, which is why
    // `open-requests.ts` carries a predicate pin for it.
    const failed = task({ lifecycleState: 'failed' });
    expect(isTerminalSession(failed)).toBe(true);
    expect(isSessionUnanswerable(failed)).toBe(false);
  });

  test('and a non-terminal session can be unanswerable', () => {
    // The two questions cross, which is why the surfaces read them
    // separately rather than through one conjunction — see the note in
    // `sessionDisplay.ts` on archive#1781's suggested `isActionableSession`.
    const stranded = task({
      lifecycleState: 'needs_input',
      answerability: observation,
    });
    expect(isTerminalSession(stranded)).toBe(false);
    expect(isSessionUnanswerable(stranded)).toBe(true);
    expect(isSessionUnanswerable(task({ lifecycleState: 'needs_input' }))).toBe(
      false,
    );
  });
});
