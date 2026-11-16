import type { ChildWorkItem } from '@kontourai/station-contracts/child-work';
import { describe, expect, test } from 'vitest';
import {
  childWorkHoldsFinishedAlert,
  finishedAlertHoldReasons,
} from '../finished-alert-hold.js';

const base = {
  producer: 'engine-subagent' as const,
  reporterThreadId: 'thread-1',
  status: 'running' as const,
};
const reported = (running: ChildWorkItem[]) => ({
  observability: 'reported' as const,
  observedAt: '2026-11-15T00:00:00.000Z',
  running,
});

describe('finishedAlertHoldReasons', () => {
  test('an agent child holds whether or not it is backgrounded', () => {
    for (const backgrounded of [true, false, undefined]) {
      expect(
        finishedAlertHoldReasons({
          childWork: reported([
            { ...base, childId: 'a', workKind: 'agent', backgrounded },
          ]),
        }),
      ).toEqual(['child-agent']);
    }
  });

  test('a command or monitor holds only while not backgrounded', () => {
    for (const workKind of ['command', 'monitor'] as const) {
      expect(
        finishedAlertHoldReasons({
          childWork: reported([
            { ...base, childId: 'c', workKind, backgrounded: true },
          ]),
        }),
      ).toEqual([]);
      expect(
        finishedAlertHoldReasons({
          childWork: reported([{ ...base, childId: 'c', workKind }]),
        }),
      ).toEqual(['foreground-command']);
    }
    // Claude history before `workKind`: the raw `local_bash` label.
    expect(
      childWorkHoldsFinishedAlert({
        status: 'running',
        kindLabel: 'local_bash',
        backgrounded: true,
      }),
    ).toBe(false);
  });

  test('a settled child holds nothing', () => {
    expect(
      childWorkHoldsFinishedAlert({ status: 'completed', workKind: 'agent' }),
    ).toBe(false);
  });

  test('open engine work holds only when the record cannot classify it', () => {
    expect(finishedAlertHoldReasons({ openEngineWork: true })).toEqual([
      'engine-work',
    ]);
    expect(
      finishedAlertHoldReasons({
        openEngineWork: true,
        childWork: { observability: 'not-reported', reason: 'none' },
      }),
    ).toEqual(['engine-work']);
    expect(
      finishedAlertHoldReasons({
        openEngineWork: true,
        childWork: reported([]),
      }),
    ).toEqual(['engine-work']);
    expect(
      finishedAlertHoldReasons({
        openEngineWork: true,
        childWork: reported([
          { ...base, childId: 'c', workKind: 'command', backgrounded: true },
        ]),
      }),
    ).toEqual([]);
  });

  test('owned sessions, pending stops, follow-ups', () => {
    expect(
      finishedAlertHoldReasons({
        ownedWork: { runningChildCount: 0, pendingStopCount: 1 },
        followUpPending: true,
        queuedFollowUp: true,
      }),
    ).toEqual(['owned-session', 'follow-up-pending', 'queued-follow-up']);
    expect(
      finishedAlertHoldReasons({
        ownedWork: { runningChildCount: 0, pendingStopCount: 0 },
      }),
    ).toEqual([]);
  });
});
