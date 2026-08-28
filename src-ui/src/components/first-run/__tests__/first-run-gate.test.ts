import type { FirstRunState } from '@kontourai/station-contracts/config';
import { describe, expect, test } from 'vitest';
import {
  FIRST_RUN_COMPLETED,
  FIRST_RUN_DEFERRED,
  isKnownFirstRunStatus,
  resolveFirstRunOffer,
} from '../first-run-gate';

describe('resolveFirstRunOffer — the one read', () => {
  test('a home that has never answered is auto-opened and offered', () => {
    expect(resolveFirstRunOffer({ status: 'pending' })).toEqual({
      autoOpen: true,
      offered: true,
    });
  });

  test('a deferred home is offered from Home, never auto-opened', () => {
// The whole point of "Not now": a decision is a decision, and the card is
// what makes deferring safe rather than lossy.
    expect(resolveFirstRunOffer({ status: 'skipped', skippedAt: 'x' })).toEqual(
      { autoOpen: false, offered: true },
    );
  });

  test('a completed home is offered nothing', () => {
    expect(
      resolveFirstRunOffer({ status: 'completed', completedAt: 'x' }),
    ).toEqual({ autoOpen: false, offered: false });
  });

  test('absent is NOT pending', () => {
// A home whose config predates the field has already been in use. Reading
// absent as `pending` would re-run the guided chapter on every Station
// that upgrades — the ambush the old launcher rule was reaching for.
    expect(resolveFirstRunOffer(undefined)).toEqual({
      autoOpen: false,
      offered: false,
    });
    expect(resolveFirstRunOffer(null)).toEqual({
      autoOpen: false,
      offered: false,
    });
  });

  test('an unreadable record fails closed', () => {
// Written by a newer Station, or hand-edited. Opening a guided run because
// we could not read our own record is the worst of the three options.
    expect(
      resolveFirstRunOffer({ status: 'from-a-newer-station' } as never),
    ).toEqual({ autoOpen: false, offered: false });
  });

  test('the answer is a pure function of the field — same in, same out', () => {
 // pure half: nothing here reads a probe, a clock, or a query, so a
// flapping `/api/system/status` cannot reach this decision at all.
    const state: FirstRunState = { status: 'pending' };
    const first = resolveFirstRunOffer(state);
    const second = resolveFirstRunOffer(state);
    expect(first).toEqual(second);
  });
});

describe('isKnownFirstRunStatus', () => {
  test('names exactly the three states this build can act on', () => {
    expect(isKnownFirstRunStatus('pending')).toBe(true);
    expect(isKnownFirstRunStatus('skipped')).toBe(true);
    expect(isKnownFirstRunStatus('completed')).toBe(true);
    expect(isKnownFirstRunStatus('done')).toBe(false);
    expect(isKnownFirstRunStatus(undefined)).toBe(false);
  });
});

describe('what the chapter asks the server to record', () => {
  test('a status, and nothing else', () => {
 // these used to build the whole record, timestamp included, and
// hand it to the generic config write — so the moment a decision was said
// to have happened came from the browser. `POST /config/first-run` refuses
// a request carrying a timestamp and stamps its own observation.
    expect(FIRST_RUN_DEFERRED).toEqual({ status: 'skipped' });
    expect(FIRST_RUN_COMPLETED).toEqual({ status: 'completed' });
    expect(Object.keys(FIRST_RUN_DEFERRED)).toEqual(['status']);
    expect(Object.keys(FIRST_RUN_COMPLETED)).toEqual(['status']);
  });

  test('neither can ask for pending', () => {
// Re-arming is home creation's job alone; the server refuses it too.
    for (const request of [FIRST_RUN_DEFERRED, FIRST_RUN_COMPLETED]) {
      expect(request.status).not.toBe('pending');
    }
  });
});
