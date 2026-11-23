/**
 * @vitest-environment jsdom
 *
 * What an Automations row says about a one-time automation, read from the
 * real SQLite ledger's list read: one that Station missed while it was off
 * (the late-skip record) is Missed, not "Done · Ran"; one that ran is Done.
 */
import { AUTOMATION_RUN_POLICY } from '@kontourai/station-contracts/scheduler';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../src-server/__test-utils__/temp-dirs.js';
import { createSchedulerLedger } from '../../../src-server/services/scheduling/scheduler-ledger.js';
import {
  automationStatus,
  nextRunText,
  statusRank,
} from '../views/schedule/automationRow';

const makeTempDir = trackTempDirs();

function oneTimeLedger(dueAt: number) {
  const ledger = createSchedulerLedger({
    directory: makeTempDir('station-row-once-'),
  });
  ledger.create({
    name: 'once',
    prompt: 'x',
    enabled: true,
    retryCount: 0,
    schedule: { kind: 'at', timeMs: dueAt },
    target: { kind: 'conversation', conversationId: 'chat-1' },
    createdBy: { userId: 'human:local:operator' },
    createdAt: new Date(dueAt - 60_000).toISOString(),
  } as never);
  const listed = (now: number) => {
    const read = ledger.listViews(now);
    if (read.kind !== 'available') throw new Error('list unavailable');
    return read.value[0]!;
  };
  return { ledger, listed };
}

describe('a one-time automation read from the ledger', () => {
  test('missed while Station was off reads Missed with its due time, never Ran', () => {
    const dueAt = Date.parse('2026-11-23T15:00:00.000Z');
    const { ledger, listed } = oneTimeLedger(dueAt);
    const later = dueAt + AUTOMATION_RUN_POLICY.latenessCutoffMs + 60_000;
    // Station starts again past the lateness cutoff: the ledger records the
    // occurrence missed (its `skipped: 'late'` row) instead of running it.
    expect(ledger.claimDue(later)).toMatchObject({
      kind: 'available',
      value: [],
    });
    const job = listed(later);
    expect(job.recentOutcomes?.outcomes).toEqual(['skipped']);
    expect(automationStatus(job, false, later)).toBe('Missed');
    const text = nextRunText(job, later);
    expect(text).toMatch(/^Missed /);
    expect(text).not.toMatch(/^Ran/);
    expect(statusRank(job, later)).toBe(2);
    ledger.close();
  });

  test('one that ran at its time reads Done and Ran', () => {
    const dueAt = Date.parse('2026-11-23T15:00:00.000Z');
    const { ledger, listed } = oneTimeLedger(dueAt);
    const claimed = ledger.claimDue(dueAt + 1_000);
    if (claimed.kind !== 'available' || !claimed.value[0])
      throw new Error('expected the due occurrence to be claimed');
    const receipt = claimed.value[0];
    receipt.beginInvocation();
    receipt.settle({
      success: true,
      state: 'completed',
      completedAt: new Date(dueAt + 3_000).toISOString(),
      durationSecs: 2,
    });
    const job = listed(dueAt + 60_000);
    expect(job.recentOutcomes?.outcomes).toEqual(['worked']);
    expect(automationStatus(job, false, dueAt + 60_000)).toBe('Done');
    expect(nextRunText(job, dueAt + 60_000)).toMatch(/^Ran /);
    ledger.close();
  });
});
