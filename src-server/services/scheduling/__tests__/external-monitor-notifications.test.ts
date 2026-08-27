import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { BuiltinScheduler } from '../builtin-scheduler.js';
import { createSchedulerLedger } from '../scheduler-ledger.js';

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);

function seedProbeTerminal(root: string, name: string) {
  const ledger = createSchedulerLedger({ directory: root });
  expect(
    ledger.create({
      name,
      schedule: { kind: 'every', everyMs: 60_000 },
      prompt: 'observe',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      monitor: {
        kind: 'github-pull-request',
        objective: 'review-ready',
        target: 'https://github.com/kontourai/station/pull/4210',
        projectId: 'personal',
        agentId: 'station',
      },
    }),
  ).toEqual({ kind: 'created' });
  const views = ledger.listViews();
  if (views.kind !== 'available') throw new Error('expected scheduler view');
  const monitorId = views.value[0]!.unattendedPrincipal!.jobId;
  expect(
    ledger.recordMonitorProbeTerminal({
      name,
      monitorId,
      outcome: 'terminal',
      monitorState: {
        lastOutcome: 'terminal',
        nextAction: 'The pull request is closed or merged.',
      },
    }),
  ).toMatchObject({ kind: 'recorded' });
  return ledger;
}

test('a refused terminal bell stays owed, retries once, and encodes its Schedule link', async () => {
  const root = mkdtempSync(join(tmpdir(), 'station-monitor-notification-'));
  roots.push(root);
  const name = 'monitor?next=/outside&mode=unsafe';
  const firstLedger = seedProbeTerminal(root, name);
  const refused = new BuiltinScheduler({
    ledger: firstLedger,
    turnAdapter: { invoke: vi.fn() },
    notificationService: {
      dispatch: vi.fn(() => false),
      schedule: vi.fn(),
    } as never,
  });
  (refused as any).sweepOwedMonitorProbeTerminalAnnouncements();
  await refused.stop();

  const retryLedger = createSchedulerLedger({ directory: root });
  const schedule = vi.fn().mockResolvedValue(undefined);
  const retried = new BuiltinScheduler({
    ledger: retryLedger,
    turnAdapter: { invoke: vi.fn() },
    notificationService: {
      dispatch: (_operation: string, task: () => Promise<unknown>) => {
        void task().catch(() => undefined);
        return true;
      },
      schedule,
    } as never,
  });
  (retried as any).sweepOwedMonitorProbeTerminalAnnouncements();
  await retried.stop();

  expect(schedule).toHaveBeenCalledOnce();
  expect(schedule).toHaveBeenCalledWith(
    'scheduler',
    expect.objectContaining({
      dedupeTag: expect.stringMatching(/^external-monitor:terminal:/),
      metadata: {
        jobName: name,
        link: '/schedule?job=monitor%3Fnext%3D%2Foutside%26mode%3Dunsafe',
      },
    }),
  );

  const confirmedLedger = createSchedulerLedger({ directory: root });
  const confirmed = new BuiltinScheduler({
    ledger: confirmedLedger,
    turnAdapter: { invoke: vi.fn() },
    notificationService: {
      dispatch: vi.fn(() => true),
      schedule,
    } as never,
  });
  (confirmed as any).sweepOwedMonitorProbeTerminalAnnouncements();
  await confirmed.stop();
  expect(schedule).toHaveBeenCalledOnce();
});
