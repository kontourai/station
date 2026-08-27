import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { sessionAttentionDisposition } from '@kontourai/station-contracts/session-attention';
import { describe, expect, test } from 'vitest';
import {
  orchestrationLifecycleLabel,
  sessionStatusWord,
} from '../session-state';

/**
 * station#3227 A1. `orchestrationLifecycleLabel` is the fold every lane
 * heading, project badge and project page is built from; `sessionStatusWord`
 * is the word a ROW prints. Before this slice the row printed
 * `sessionLifecycleLabel(session.lifecycleState)` — the raw wire state, with
 * none of the fold's four overrides — so a row could contradict the heading
 * it sat under. These pin the fold's overrides and the refinement rule that
 * makes the finer row word safe.
 */

const NOW = Date.parse('2026-08-18T12:00:00.000Z');

function session(
  overrides: Partial<OrchestrationSessionSummary> = {},
): OrchestrationSessionSummary {
  return {
    threadId: 'thread-1',
    provider: 'claude',
    status: 'ready',
    controlMode: 'station-owned',
    // station#1778: required decoration, supplied rather than cast away.
    answerability: { answerable: true },
    isLoaded: true,
    isPersisted: true,
    eventCount: 4,
    createdAt: new Date(NOW - 3_600_000).toISOString(),
    updatedAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

const UNANSWERABLE = {
  answerable: false,
  qualification: 'provider_absent',
  observedBy: 'station-test',
  observedAt: '2026-08-18T11:00:00.000Z',
} as const;

describe('the four shapes where the raw state and the fold disagree', () => {
  /**
   * Each case names the word the OLD row label printed. That word is asserted
   * absent, not merely "the new one is present": a row that printed both
   * would still be a contradiction.
   */

  test('#1069 — `running` with no turn in flight is Ready, never Running', () => {
    // Observed live: 13 of 24 sessions carried lifecycleState 'running' with
    // `hasActiveTurn: false`, because `session.configured` moves the state and
    // only `turn.completed` moves it back.
    const idle = session({ lifecycleState: 'running', hasActiveTurn: false });
    expect(orchestrationLifecycleLabel(idle)).toBe('Ready');
    expect(sessionStatusWord(idle)).toBe('Ready');
    expect(sessionStatusWord(idle)).not.toBe('Running');
  });

  test('a pending review outranks a live turn — Needs attention, never Running', () => {
    const reviewing = session({
      lifecycleState: 'running',
      hasActiveTurn: true,
      pendingReview: true,
    });
    expect(orchestrationLifecycleLabel(reviewing)).toBe('Needs attention');
    expect(sessionStatusWord(reviewing)).toBe('Needs attention');
    expect(sessionStatusWord(reviewing)).not.toBe('Running');
  });

  test('a closed board session is Completed, never Running', () => {
    const closed = session({
      lifecycleState: 'running',
      hasActiveTurn: true,
      status: 'closed',
    });
    expect(orchestrationLifecycleLabel(closed)).toBe('Completed');
    expect(sessionStatusWord(closed)).toBe('Completed');
    expect(sessionStatusWord(closed)).not.toBe('Running');
  });

  test('#1783 — nothing can answer it, so it never says "Waiting on you"', () => {
    const stranded = session({
      lifecycleState: 'needs_input',
      answerability: UNANSWERABLE,
    });
    expect(orchestrationLifecycleLabel(stranded)).toBe('Unanswerable');
    // `lifecycleLabelText`'s translation, not this system's own term: the
    // same wording the chat-dock inbox and the mobile switcher already use.
    expect(sessionStatusWord(stranded)).toBe("Can't answer here");
    expect(sessionStatusWord(stranded)).not.toBe('Waiting on you');
  });

  test('#1296 — a failed run that was then torn down stays Failed', () => {
    const crashed = session({ lifecycleState: 'failed', status: 'closed' });
    expect(orchestrationLifecycleLabel(crashed)).toBe('Failed');
    expect(sessionStatusWord(crashed)).toBe('Failed');
  });
});

describe('the refinement the row legitimately adds', () => {
  /**
   * A lane heading is coarser than a row word and that is worth keeping —
   * "Recently finished" does not say Completed from Failed, and "Needs you"
   * does not say whether you owe a reply or a review. The rule is that a row
   * may only be finer WITHIN what the fold decided.
   */

  test.each([
    ['needs_input', 'Needs attention', 'Waiting on you'],
    ['review_pending', 'Needs attention', 'Review pending'],
    ['blocked', 'Needs attention', 'Blocked'],
    ['canceled', 'Stopped', 'Stopped'],
    ['queued', 'Ready', 'Queued'],
  ] as const)(
    '`%s` folds to %s and the row still says %s',
    (lifecycleState, canonical, word) => {
      const subject = session({ lifecycleState });
      expect(orchestrationLifecycleLabel(subject)).toBe(canonical);
      expect(sessionStatusWord(subject)).toBe(word);
    },
  );

  test('a finer word that CONTRADICTS its state loses to the state', () => {
    // A turn is in flight while the state still reads `queued`. "Queued"
    // would say work has not started; the fold says it has.
    const starting = session({ lifecycleState: 'queued', hasActiveTurn: true });
    expect(orchestrationLifecycleLabel(starting)).toBe('Running');
    expect(sessionStatusWord(starting)).toBe('Running');
    expect(sessionStatusWord(starting)).not.toBe('Queued');
  });
});

describe('a session with no lifecycleState', () => {
  /**
   * The four render sites used to fall back to `session.status` here, which
   * is a TRANSPORT identifier — so an undecorated closed session literally
   * printed the word "closed" under a "Recently finished" heading. That is
   * the raw-token leak `sessionLifecycleLabel`'s docblock exists to prevent,
   * arriving through the fallback rather than the label.
   */

  test('a closed session reads Completed, not the wire word "closed"', () => {
    const undecorated = session({ status: 'closed' });
    expect(sessionStatusWord(undecorated)).toBe('Completed');
  });

  test.each(['connecting', 'ready', 'running', 'error', 'dead'] as const)(
    'status `%s` never reaches the screen verbatim',
    (status) => {
      expect(sessionStatusWord(session({ status }))).not.toBe(status);
    },
  );
});

describe('the row word is always product vocabulary', () => {
  const LIFECYCLE_STATES = [
    'queued',
    'running',
    'needs_input',
    'review_pending',
    'blocked',
    'completed',
    'failed',
    'canceled',
    undefined,
  ] as const;
  const STATUSES = [
    'connecting',
    'ready',
    'running',
    'error',
    'dead',
    'closed',
  ] as const;

  /**
   * Every word this function can print, written out rather than derived from
   * the implementation's own table — a test that recomputes the map it is
   * checking cannot catch the map being wrong.
   */
  const VOCABULARY = new Set([
    'Needs attention',
    'Waiting on you',
    'Review pending',
    'Blocked',
    "Can't answer here",
    'Running',
    'Ready',
    'Queued',
    'Completed',
    'Stopped',
    'Failed',
  ]);

  test('across every state × status × flag combination', () => {
    for (const lifecycleState of LIFECYCLE_STATES) {
      for (const status of STATUSES) {
        for (const hasActiveTurn of [true, false, undefined]) {
          for (const pendingReview of [true, false]) {
            for (const answerability of [
              { answerable: true } as const,
              UNANSWERABLE,
            ]) {
              const word = sessionStatusWord(
                session({
                  lifecycleState,
                  status,
                  hasActiveTurn,
                  pendingReview,
                  answerability,
                }),
              );
              expect(VOCABULARY).toContain(word);
            }
          }
        }
      }
    }
  });
});

/*
 * station#3227 B1. The failed → finished → awaiting → active adjudication
 * inside `orchestrationLifecycleLabel` is the SHARED
 * `sessionAttentionDisposition` fold — the same derivation the server's
 * attention projection counts the bell from (its own matrix test asserts item
 * kinds against the same fold, so the two surfaces agreeing is transitive
 * through these two pins). This matrix reds — naming the shape — if the fold
 * here ever stops being that shared derivation's rendering.
 */
describe('the label is the shared attention disposition, rendered (station#3227 B1)', () => {
  const LIFECYCLE_STATES = [
    'queued',
    'running',
    'needs_input',
    'review_pending',
    'blocked',
    'completed',
    'failed',
    'canceled',
    undefined,
  ] as const;
  const STATUSES = [
    'connecting',
    'ready',
    'running',
    'error',
    'dead',
    'closed',
  ] as const;

  test('across every state × status × flag shape', () => {
    for (const lifecycleState of LIFECYCLE_STATES) {
      for (const status of STATUSES) {
        for (const hasActiveTurn of [true, false, undefined]) {
          for (const pendingReview of [true, false]) {
            for (const answerability of [
              { answerable: true } as const,
              UNANSWERABLE,
            ]) {
              const subject = session({
                lifecycleState,
                status,
                hasActiveTurn,
                pendingReview,
                answerability,
              });
              const disposition = sessionAttentionDisposition(subject);
              const expected =
                lifecycleState === 'canceled'
                  ? 'Stopped'
                  : disposition.state === 'failed'
                    ? 'Failed'
                    : disposition.state === 'finished'
                      ? 'Completed'
                      : disposition.state === 'awaiting'
                        ? answerability.answerable
                          ? 'Needs attention'
                          : 'Unanswerable'
                        : hasActiveTurn
                          ? 'Running'
                          : 'Ready';
              const shape = `${lifecycleState ?? 'none'}/${status}/turn=${hasActiveTurn}/review=${pendingReview}/answerable=${answerability.answerable}`;
              expect({
                shape,
                label: orchestrationLifecycleLabel(subject),
              }).toEqual({ shape, label: expected });
            }
          }
        }
      }
    }
  });

  test('the two B1 shapes, pinned by name', () => {
    // The bell now counts this one: blocked was under "Needs you" here while
    // the server projected nothing.
    const blocked = session({ lifecycleState: 'blocked', status: 'running' });
    expect(orchestrationLifecycleLabel(blocked)).toBe('Needs attention');
    // And no longer counts this one: every client surface files it under
    // Recently finished while the server kept projecting the stale ask.
    const closedStale = session({
      lifecycleState: 'needs_input',
      status: 'closed',
    });
    expect(orchestrationLifecycleLabel(closedStale)).toBe('Completed');
  });
});
