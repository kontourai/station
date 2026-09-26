import { describe, expect, test } from 'vitest';
import {
  LIVE_ACTIVITY_MAX_DISMISS_MS,
  LIVE_ACTIVITY_ROLLOVER_AFTER_MS,
  type LiveActivityPlanInput,
  planLiveActivity,
} from '../live-activity-planner.js';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

const activeCard = {
  active: true,
  rows: ['Working\tFix the login test\tLogin App'],
  expiresAt: NOW + 2 * HOUR,
  contentKey: 'active-1',
};
const finishedCard = {
  active: false,
  rows: ['Done\tFix the login test\tLogin App'],
  expiresAt: NOW + 15 * 60 * 1000,
  contentKey: 'finished-1',
};
const emptyCard = {
  active: false,
  rows: [],
  expiresAt: NOW,
  contentKey: 'empty',
};

function plan(input: Partial<LiveActivityPlanInput>) {
  return planLiveActivity({
    now: NOW,
    card: activeCard,
    readable: true,
    pendingAlert: false,
    ...input,
  });
}

const started = { startedAt: NOW - HOUR };

describe('planLiveActivity', () => {
  test('no activity + active card: start, stale at the card expiry', () => {
    expect(plan({})).toEqual([
      { event: 'start', alert: false, staleAtMs: activeCard.expiresAt },
    ]);
    expect(plan({ pendingAlert: true })).toEqual([
      { event: 'start', alert: true, staleAtMs: activeCard.expiresAt },
    ]);
  });

  test('no activity + a card already sent (a start the gateway refused): nothing until it changes', () => {
    const lastSent = { contentKey: 'active-1', expiresAt: NOW + HOUR };
    expect(plan({ lastSent })).toEqual([]);
    expect(
      plan({ lastSent, card: { ...activeCard, contentKey: 'active-2' } }),
    ).toHaveLength(1);
  });

  test.each([
    ['inactive with rows', finishedCard],
    ['empty', emptyCard],
  ])('no activity + %s card: nothing', (_label, card) => {
    expect(plan({ card })).toEqual([]);
    expect(plan({ card, pendingAlert: true })).toEqual([]);
  });

  test('no activity + unreadable: nothing, even for an active card', () => {
    expect(plan({ readable: false })).toEqual([]);
  });

  test('activity + changed active card: update, alerting only with a pending alert', () => {
    const lastSent = { contentKey: 'active-0', expiresAt: NOW + 2 * HOUR };
    expect(plan({ activity: started, lastSent })).toEqual([
      { event: 'update', alert: false, staleAtMs: activeCard.expiresAt },
    ]);
    expect(
      plan({
        activity: started,
        lastSent: { ...lastSent, contentKey: 'active-1' },
        pendingAlert: true,
      }),
    ).toEqual([
      { event: 'update', alert: true, staleAtMs: activeCard.expiresAt },
    ]);
  });

  test('activity + unchanged active card: nothing until 30 min before it goes stale', () => {
    const lastSent = { contentKey: 'active-1', expiresAt: NOW + 31 * 60_000 };
    expect(plan({ activity: started, lastSent })).toEqual([]);
    expect(
      plan({
        activity: started,
        lastSent: { ...lastSent, expiresAt: NOW + 30 * 60_000 },
      }),
    ).toEqual([
      { event: 'update', alert: false, staleAtMs: activeCard.expiresAt },
    ]);
  });

  test('activity after a restart (nothing known as sent): update, never a second start', () => {
    expect(plan({ activity: started })).toEqual([
      { event: 'update', alert: false, staleAtMs: activeCard.expiresAt },
    ]);
  });

  test('activity + finished card: end with it, dismissed at its expiry, alerting a pending finish', () => {
    expect(plan({ activity: started, card: finishedCard })).toEqual([
      { event: 'end', alert: false, dismissAtMs: finishedCard.expiresAt },
    ]);
    expect(
      plan({ activity: started, card: finishedCard, pendingAlert: true }),
    ).toEqual([
      { event: 'end', alert: true, dismissAtMs: finishedCard.expiresAt },
    ]);
  });

  test('the dismissal is capped at 4 h from now', () => {
    const late = { ...finishedCard, expiresAt: NOW + 10 * HOUR };
    expect(plan({ activity: started, card: late })).toEqual([
      {
        event: 'end',
        alert: false,
        dismissAtMs: NOW + LIVE_ACTIVITY_MAX_DISMISS_MS,
      },
    ]);
  });

  test('activity + empty card, or read access lost: end, dismissed now, never alerting', () => {
    expect(
      plan({ activity: started, card: emptyCard, pendingAlert: true }),
    ).toEqual([{ event: 'end', alert: false, dismissAtMs: NOW }]);
    expect(
      plan({ activity: started, readable: false, pendingAlert: true }),
    ).toEqual([{ event: 'end', alert: false, dismissAtMs: NOW }]);
  });

  test('rollover: an activity started 7 h 30 m ago is ended now and started again', () => {
    const old = { startedAt: NOW - LIVE_ACTIVITY_ROLLOVER_AFTER_MS };
    const lastSent = { contentKey: 'active-1', expiresAt: NOW + 2 * HOUR };
    expect(plan({ activity: old, lastSent, pendingAlert: true })).toEqual([
      { event: 'end', alert: false, dismissAtMs: NOW },
      { event: 'start', alert: true, staleAtMs: activeCard.expiresAt },
    ]);
    // One millisecond younger: an ordinary (here: no-op) plan.
    expect(
      plan({ activity: { startedAt: old.startedAt + 1 }, lastSent }),
    ).toEqual([]);
  });

  test('rollover does not apply to a finished card: it just ends', () => {
    const old = { startedAt: NOW - 8 * HOUR };
    expect(plan({ activity: old, card: finishedCard })).toEqual([
      { event: 'end', alert: false, dismissAtMs: finishedCard.expiresAt },
    ]);
  });
});
