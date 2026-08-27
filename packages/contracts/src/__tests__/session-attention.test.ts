import { describe, expect, test } from 'vitest';
import type { ProviderSession } from '../provider.js';
import {
  type SessionAttentionSubject,
  sessionAttentionDisposition,
} from '../session-attention.js';
import { SESSION_LIFECYCLE_STATES } from '../session-lifecycle.js';

/**
 * station#3227 B1. This fold is the ONE ordered adjudication of "does this
 * session need the user", consumed by both the client's canonical label
 * (`src-ui/src/utils/session-state.ts`) and the server's attention
 * projection (`src-server/services/projects/attention-projection.ts`). Each
 * consumer carries its own matrix test asserting its output against THIS
 * fold, so agreement between the two is transitive through these pins —
 * which is why the ordering assertions here are written out as properties
 * over the full input space rather than spot-checked.
 */

// Written out, not imported from the implementation's own vocabulary — a
// test that enumerates from the map it checks cannot catch the map being
// wrong. `undefined` is a real wire shape (`lifecycleState` is optional).
const LIFECYCLE_STATES = [...SESSION_LIFECYCLE_STATES, undefined] as const;
const STATUSES: readonly ProviderSession['status'][] = [
  'connecting',
  'ready',
  'running',
  'error',
  'dead',
  'closed',
];
const FLAGS = [true, false, undefined] as const;

function* allSubjects(): Generator<SessionAttentionSubject> {
  for (const lifecycleState of LIFECYCLE_STATES) {
    for (const status of STATUSES) {
      for (const pendingReview of FLAGS) {
        yield { lifecycleState, status, pendingReview };
      }
    }
  }
}

describe('sessionAttentionDisposition ordering (station#3227 B1)', () => {
  test('`failed` outranks everything — including a closed transport status and a sticky pendingReview (#1296)', () => {
    for (const subject of allSubjects()) {
      if (subject.lifecycleState !== 'failed') continue;
      expect(sessionAttentionDisposition(subject)).toEqual({
        state: 'failed',
      });
    }
  });

  test('a finished session can never be awaiting — closed status or terminal state beats every attention shadow', () => {
    for (const subject of allSubjects()) {
      if (subject.lifecycleState === 'failed') continue;
      const finished =
        subject.status === 'closed' ||
        subject.lifecycleState === 'completed' ||
        subject.lifecycleState === 'canceled';
      if (!finished) continue;
      expect(sessionAttentionDisposition(subject)).toEqual({
        state: 'finished',
      });
    }
  });

  test('the awaiting arm: needs_input, then pending review (flag or state), then blocked', () => {
    // The three doors, each with the door it must NOT take also present
    // where the precedence is the contract.
    expect(
      sessionAttentionDisposition({
        lifecycleState: 'needs_input',
        status: 'running',
        pendingReview: true,
      }),
    ).toEqual({ state: 'awaiting', via: 'needs_input' });
    expect(
      sessionAttentionDisposition({
        lifecycleState: 'review_pending',
        status: 'running',
      }),
    ).toEqual({ state: 'awaiting', via: 'review_pending' });
    // blocked + pendingReview: the review is the more specific ask — the
    // same precedence the server's item kinds have always projected.
    expect(
      sessionAttentionDisposition({
        lifecycleState: 'blocked',
        status: 'running',
        pendingReview: true,
      }),
    ).toEqual({ state: 'awaiting', via: 'review_pending' });
    // THE B1 ARM: a bare blocked session is awaiting, never active.
    expect(
      sessionAttentionDisposition({
        lifecycleState: 'blocked',
        status: 'running',
      }),
    ).toEqual({ state: 'awaiting', via: 'blocked' });
    // pendingReview alone is a door even from a state with no shadow of its
    // own.
    expect(
      sessionAttentionDisposition({
        lifecycleState: 'running',
        status: 'running',
        pendingReview: true,
      }),
    ).toEqual({ state: 'awaiting', via: 'review_pending' });
  });

  test('everything else is active — never a fabricated attention or finish', () => {
    for (const subject of allSubjects()) {
      const claimed =
        subject.lifecycleState === 'failed' ||
        subject.lifecycleState === 'completed' ||
        subject.lifecycleState === 'canceled' ||
        subject.status === 'closed' ||
        subject.pendingReview === true ||
        ['needs_input', 'review_pending', 'blocked'].includes(
          subject.lifecycleState ?? '',
        );
      if (claimed) continue;
      expect(sessionAttentionDisposition(subject)).toEqual({
        state: 'active',
      });
    }
  });

  test('every subject lands in exactly one arm (total over the full matrix)', () => {
    let count = 0;
    for (const subject of allSubjects()) {
      const disposition = sessionAttentionDisposition(subject);
      expect(['failed', 'finished', 'awaiting', 'active']).toContain(
        disposition.state,
      );
      count += 1;
    }
    // 9 lifecycle shapes (8 states + undefined) × 6 statuses × 3 flags.
    expect(count).toBe(9 * 6 * 3);
  });
});
