/**
 * The first-run transition rule (UX audit RT-02, review M1).
 *
 * `firstRun` used to be an ordinary composite setting on `PUT /config/app`,
 * which meant the "only home creation writes `pending`" invariant was a
 * sentence in a comment. These are the cases that make it a rule.
 */
import { describe, expect, test } from 'vitest';
import {
  describeFirstRunTransitionViolation,
  type FirstRunState,
  firstRunStateForTransition,
} from '../config.js';

const PENDING: FirstRunState = { status: 'pending' };
const SKIPPED: FirstRunState = { status: 'skipped', skippedAt: 'then' };
const COMPLETED: FirstRunState = { status: 'completed', completedAt: 'then' };

describe('describeFirstRunTransitionViolation', () => {
  test('the forward moves a real run makes are allowed', () => {
    expect(
      describeFirstRunTransitionViolation(PENDING, { status: 'skipped' }),
    ).toBeUndefined();
    expect(
      describeFirstRunTransitionViolation(PENDING, { status: 'completed' }),
    ).toBeUndefined();
    // Deferred, then finished later from Home's card.
    expect(
      describeFirstRunTransitionViolation(SKIPPED, { status: 'completed' }),
    ).toBeUndefined();
  });

  test('a home cannot be re-armed as pending', () => {
    // The one that matters most: a caller who could write `pending` could
    // re-run the guided chapter on someone else's Station at will.
    for (const current of [PENDING, SKIPPED, COMPLETED]) {
      expect(
        describeFirstRunTransitionViolation(current, { status: 'pending' }),
      ).toContain('cannot be re-armed');
    }
  });

  test('a home that was never offered the run cannot record one', () => {
    // Absent means "this config predates the field". A `completed` there
    // states that something happened which never did.
    expect(
      describeFirstRunTransitionViolation(undefined, { status: 'completed' }),
    ).toContain('never offered');
  });

  test('completed is terminal, and a status is not re-recorded', () => {
    expect(
      describeFirstRunTransitionViolation(COMPLETED, { status: 'skipped' }),
    ).toContain('already completed');
    expect(
      describeFirstRunTransitionViolation(COMPLETED, { status: 'completed' }),
    ).toContain('already completed');
    // Re-recording would move `skippedAt` to a moment when nothing happened.
    expect(
      describeFirstRunTransitionViolation(SKIPPED, { status: 'skipped' }),
    ).toContain('already recorded');
  });

  test('a caller may not supply the timestamp, and is told so', () => {
    // Refused rather than silently stripped: quietly dropping a field a caller
    // sent is how a caller comes to believe it was honoured.
    expect(
      describeFirstRunTransitionViolation(PENDING, {
        status: 'completed',
        completedAt: '2020-01-01T00:00:00.000Z',
      }),
    ).toContain('completedAt');
    expect(
      describeFirstRunTransitionViolation(PENDING, {
        status: 'skipped',
        skippedAt: 'whenever',
      }),
    ).toContain('skippedAt');
  });

  test('shapes that are not a decision at all are refused', () => {
    for (const body of [undefined, null, 'completed', 42, ['completed'], {}]) {
      expect(describeFirstRunTransitionViolation(PENDING, body)).toBeDefined();
    }
    expect(
      describeFirstRunTransitionViolation(PENDING, { status: 'finished' }),
    ).toContain('"skipped" or "completed"');
  });
});

describe('firstRunStateForTransition', () => {
  const now = new Date('2026-08-21T01:02:03.000Z');

  test('stamps only the timestamp that belongs to the new status', () => {
    expect(firstRunStateForTransition({ status: 'completed' }, now)).toEqual({
      status: 'completed',
      completedAt: '2026-08-21T01:02:03.000Z',
    });
    expect(firstRunStateForTransition({ status: 'skipped' }, now)).toEqual({
      status: 'skipped',
      skippedAt: '2026-08-21T01:02:03.000Z',
    });
  });
});
