import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createSchedulerLedger } from '../scheduler-ledger.js';

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
function ledger() {
  const root = mkdtempSync(join(tmpdir(), 'station-monitor-ledger-'));
  roots.push(root);
  return createSchedulerLedger({ directory: root });
}

function monitorJob(name: string) {
  return {
    name,
    schedule: { kind: 'every' as const, everyMs: 60_000 },
    prompt: 'observe',
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    monitor: {
      kind: 'github-pull-request' as const,
      objective: 'review-ready' as const,
      target: 'https://github.com/kontourai/station/pull/4210',
      projectId: 'personal',
      agentId: 'station',
    },
  };
}

describe('SchedulerLedger external-monitor accounting', () => {
  test('atomically reserves and restart-adopts one fingerprint', () => {
    const store = ledger();
    const first = store.reserveMonitorTrigger({
      monitorId: 'm',
      ownerId: 'u',
      fingerprint: 'f',
    });
    const second = store.reserveMonitorTrigger({
      monitorId: 'm',
      ownerId: 'u',
      fingerprint: 'f',
    });
    expect(first).toMatchObject({ kind: 'dispatch', phase: 'reserved' });
    expect(second).toMatchObject({
      kind: 'adopt',
      triggerId: (first as any).triggerId,
    });
    store.close();
  });

  test('counts one settled turn once and fences unknown usage', () => {
    const store = ledger();
    const reserved = store.reserveMonitorTrigger({
      monitorId: 'm',
      ownerId: 'u',
      fingerprint: 'f',
    }) as any;
    expect(
      store.settleMonitorTrigger({
        triggerId: reserved.triggerId,
        terminal: 'completed',
        usage: { turns: 1, tokens: 2, runtimeMs: 3 },
      }),
    ).toEqual({ kind: 'applied' });
    expect(
      store.settleMonitorTrigger({
        triggerId: reserved.triggerId,
        terminal: 'completed',
        usage: { turns: 1, tokens: 2, runtimeMs: 3 },
      }),
    ).toEqual({ kind: 'stale' });
    const unknown = store.reserveMonitorTrigger({
      monitorId: 'm',
      ownerId: 'u',
      fingerprint: 'unknown',
    }) as any;
    expect(
      store.settleMonitorTrigger({
        triggerId: unknown.triggerId,
        terminal: 'indeterminate',
      }),
    ).toEqual({ kind: 'unknown-usage' });
    expect(
      store.reserveMonitorTrigger({
        monitorId: 'm',
        ownerId: 'u',
        fingerprint: 'later',
      }),
    ).toEqual({ kind: 'blocked', reason: 'unknown-usage' });
    store.close();
  });

  test('fills a previously unknown receipt with the exact turn.started id only', () => {
    const store = ledger();
    const reserved = store.reserveMonitorTrigger({
      monitorId: 'm',
      ownerId: 'u',
      fingerprint: 'turn-binding',
    });
    if (reserved.kind !== 'dispatch') throw new Error('expected dispatch');
    expect(
      store.attachMonitorTask({
        triggerId: reserved.triggerId,
        task: { taskId: 'task', sessionId: 'session' },
      }),
    ).toEqual({ kind: 'applied' });
    expect(
      store.attachMonitorTask({
        triggerId: reserved.triggerId,
        task: {
          taskId: 'task',
          sessionId: 'session',
          turnId: 'turn.started-id',
        },
      }),
    ).toEqual({ kind: 'applied' });
    // An early `turn.started` may bind before the dispatch caller gets back
    // to persist its otherwise-identical Task/session receipt. That late
    // writer is a no-op, not an attempt to erase the canonical turn id.
    expect(
      store.attachMonitorTask({
        triggerId: reserved.triggerId,
        task: { taskId: 'task', sessionId: 'session' },
      }),
    ).toEqual({ kind: 'applied' });
    expect(
      store.attachMonitorTask({
        triggerId: reserved.triggerId,
        task: { taskId: 'task', sessionId: 'session', turnId: 'other-turn' },
      }),
    ).toEqual({ kind: 'stale' });
    expect(
      store.readMonitorAccounting({ monitorId: 'm', ownerId: 'u' }),
    ).toMatchObject({
      kind: 'available',
      value: {
        task: {
          taskId: 'task',
          sessionId: 'session',
          turnId: 'turn.started-id',
        },
      },
    });
    store.close();
  });

  test('enforces owner-scoped daily budgets and active concurrency', () => {
    const store = ledger();
    const budget = { maxTurns: 1, maxActive: 1, maxConcurrency: 1 };
    const one = store.reserveMonitorTrigger({
      monitorId: 'm',
      ownerId: 'u',
      fingerprint: 'one',
      budget,
    }) as any;
    expect(
      store.reserveMonitorTrigger({
        monitorId: 'm',
        ownerId: 'u',
        fingerprint: 'two',
        budget,
      }),
    ).toEqual({ kind: 'blocked', reason: 'active' });
    store.settleMonitorTrigger({
      triggerId: one.triggerId,
      terminal: 'completed',
      usage: { turns: 1, tokens: 1, runtimeMs: 1 },
    });
    expect(
      store.reserveMonitorTrigger({
        monitorId: 'm',
        ownerId: 'u',
        fingerprint: 'three',
        budget,
      }),
    ).toEqual({ kind: 'blocked', reason: 'budget' });
    expect(
      store.reserveMonitorTrigger({
        monitorId: 'm',
        ownerId: 'other',
        fingerprint: 'three',
        budget,
      }),
    ).toMatchObject({ kind: 'dispatch' });
    store.close();
  });

  test('uses one owner-wide semaphore across distinct monitors', () => {
    const store = ledger();
    expect(
      store.reserveMonitorTrigger({
        monitorId: 'one',
        ownerId: 'u',
        fingerprint: 'a',
        budget: { maxConcurrency: 1 },
      }),
    ).toMatchObject({ kind: 'dispatch' });
    expect(
      store.reserveMonitorTrigger({
        monitorId: 'two',
        ownerId: 'u',
        fingerprint: 'b',
        budget: { maxConcurrency: 1 },
      }),
    ).toEqual({ kind: 'blocked', reason: 'active' });
    store.close();
  });

  test('atomically reserves the remaining turn and token envelope', () => {
    const store = ledger();
    const first = store.reserveMonitorTrigger({
      monitorId: 'one',
      ownerId: 'u',
      fingerprint: 'a',
      budget: {
        maxTurns: 2,
        maxTokens: 10,
        maxRuntimeMs: 10,
        maxConcurrency: 2,
      },
    });
    expect(first).toMatchObject({
      kind: 'dispatch',
      limits: { maxTurns: 2, maxTokens: 10, maxRuntimeMs: 10 },
    });
    // The first admitted Task owns the remaining envelope before it starts;
    // a concurrent monitor cannot spend the same tokens.
    expect(
      store.reserveMonitorTrigger({
        monitorId: 'two',
        ownerId: 'u',
        fingerprint: 'b',
        budget: {
          maxTurns: 2,
          maxTokens: 10,
          maxRuntimeMs: 10,
          maxConcurrency: 2,
        },
      }),
    ).toEqual({ kind: 'blocked', reason: 'budget' });
    store.close();
  });

  test('retains one exact Task/session receipt and appends terminal usage once', () => {
    const store = ledger();
    const reserved = store.reserveMonitorTrigger({
      monitorId: 'm',
      ownerId: 'u',
      fingerprint: 'task-receipt',
    });
    if (reserved.kind !== 'dispatch') throw new Error('expected dispatch');
    expect(
      store.attachMonitorTask({
        triggerId: reserved.triggerId,
        task: { taskId: 'task-1', sessionId: 'session-1', turnId: 'turn-1' },
      }),
    ).toEqual({ kind: 'applied' });
    expect(
      store.attachMonitorTask({
        triggerId: reserved.triggerId,
        task: { taskId: 'task-2', sessionId: 'session-2', turnId: 'turn-2' },
      }),
    ).toEqual({ kind: 'stale' });
    expect(
      store.reconcileMonitorTerminals({
        terminals: [
          {
            triggerId: reserved.triggerId,
            terminal: 'completed',
            usage: { turns: 1, tokens: 17, runtimeMs: 25 },
          },
        ],
      }),
    ).toEqual({ kind: 'available', value: 1 });
    expect(
      store.reconcileMonitorTerminals({
        terminals: [
          {
            triggerId: reserved.triggerId,
            terminal: 'completed',
            usage: { turns: 1, tokens: 17, runtimeMs: 25 },
          },
        ],
      }),
    ).toEqual({ kind: 'available', value: 0 });
    expect(
      store.readMonitorAccounting({ monitorId: 'm', ownerId: 'u' }),
    ).toMatchObject({
      kind: 'available',
      value: {
        task: { taskId: 'task-1', sessionId: 'session-1', turnId: 'turn-1' },
        completedTurns: 1,
        consumedTokens: 17,
        consumedRuntimeMs: 25,
      },
    });
    store.close();
  });

  test('refuses a target reset that would erase an unknown-usage fence', () => {
    const store = ledger();
    const reserved = store.reserveMonitorTrigger({
      monitorId: 'm',
      ownerId: 'u',
      fingerprint: 'old-target',
    });
    if (reserved.kind !== 'dispatch') throw new Error('expected dispatch');
    store.settleMonitorTrigger({
      triggerId: reserved.triggerId,
      terminal: 'indeterminate',
    });
    expect(
      store.resetMonitorAccounting({ monitorId: 'm', ownerId: 'u' }),
    ).toEqual({ kind: 'busy' });
    store.close();
  });

  test('resolves an indeterminate fence only with its exact Task receipt', () => {
    const store = ledger();
    const reserved = store.reserveMonitorTrigger({
      monitorId: 'm',
      ownerId: 'u',
      fingerprint: 'evidence',
    });
    if (reserved.kind !== 'dispatch') throw new Error('expected dispatch');
    store.attachMonitorTask({
      triggerId: reserved.triggerId,
      task: { taskId: 'task', sessionId: 'session', turnId: 'turn' },
    });
    store.settleMonitorTrigger({
      triggerId: reserved.triggerId,
      terminal: 'indeterminate',
    });
    expect(
      store.resolveIndeterminateMonitor({
        monitorId: 'm',
        ownerId: 'u',
        triggerId: reserved.triggerId,
        task: { taskId: 'other', sessionId: 'session', turnId: 'turn' },
        terminal: 'completed',
        usage: { turns: 1, tokens: 2, runtimeMs: 3 },
      }),
    ).toEqual({ kind: 'stale' });
    expect(
      store.resolveIndeterminateMonitor({
        monitorId: 'm',
        ownerId: 'u',
        triggerId: reserved.triggerId,
        task: { taskId: 'task', sessionId: 'session', turnId: 'turn' },
        terminal: 'completed',
        usage: { turns: 1, tokens: 2, runtimeMs: 3 },
      }),
    ).toEqual({ kind: 'applied' });
    expect(
      store.resetMonitorAccounting({ monitorId: 'm', ownerId: 'u' }),
    ).toEqual({
      kind: 'applied',
    });
    store.close();
  });

  test('refuses a reset while a Task is running or its usage is indeterminate', () => {
    const store = ledger();
    const running = store.reserveMonitorTrigger({
      monitorId: 'm',
      ownerId: 'u',
      fingerprint: 'running',
    });
    expect(
      store.resetMonitorAccounting({ monitorId: 'm', ownerId: 'u' }),
    ).toEqual({
      kind: 'busy',
    });
    if (running.kind !== 'dispatch') throw new Error('expected dispatch');
    store.settleMonitorTrigger({
      triggerId: running.triggerId,
      terminal: 'indeterminate',
    });
    expect(
      store.resetMonitorAccounting({ monitorId: 'm', ownerId: 'u' }),
    ).toEqual({
      kind: 'busy',
    });
    store.close();
  });

  test('keeps a terminal-task notification owed until a durable delivery mark', () => {
    const store = ledger();
    const reserved = store.reserveMonitorTrigger({
      monitorId: 'm',
      ownerId: 'u',
      fingerprint: 'terminal-bell',
    });
    if (reserved.kind !== 'dispatch') throw new Error('expected dispatch');
    store.settleMonitorTrigger({
      triggerId: reserved.triggerId,
      terminal: 'completed',
      usage: { turns: 1, tokens: 1, runtimeMs: 1 },
    });
    expect(store.owedMonitorTerminalAnnouncements()).toEqual({
      kind: 'available',
      value: [{ triggerId: reserved.triggerId, monitorId: 'm' }],
    });
    const outbox = store.monitorTerminalAnnouncementOutbox();
    const first = outbox.claim(reserved.triggerId);
    expect(first).toMatchObject({ kind: 'claimed' });
    expect(outbox.claim(reserved.triggerId)).toEqual({
      kind: 'leased-elsewhere',
    });
    if (first.kind !== 'claimed') throw new Error('expected claim');
    outbox.release(reserved.triggerId, first.token);
    const retry = outbox.claim(reserved.triggerId);
    if (retry.kind !== 'claimed') throw new Error('expected retry');
    outbox.markDelivered(reserved.triggerId, retry.token);
    expect(store.owedMonitorTerminalAnnouncements()).toEqual({
      kind: 'available',
      value: [],
    });
    store.close();
  });

  test('atomically terminalizes a probe outcome and retains one retryable bell', () => {
    const store = ledger();
    const job = monitorJob('probe terminal');
    expect(store.create(job)).toEqual({ kind: 'created' });
    const view = store.listViews();
    if (view.kind !== 'available') throw new Error('expected view');
    const monitorId = view.value[0]!.unattendedPrincipal!.jobId;
    const recorded = store.recordMonitorProbeTerminal({
      name: job.name,
      monitorId,
      outcome: 'unauthorized',
      monitorState: {
        lastObservedAt: '2026-01-01T01:00:00.000Z',
        lastOutcome: 'unauthorized',
        nextAction: 'GitHub did not authorize this monitor credential.',
      },
    });
    expect(recorded).toMatchObject({
      kind: 'recorded',
      announcement: { outcome: 'unauthorized', jobName: job.name },
    });
    expect(store.list()).toMatchObject({
      kind: 'available',
      value: [
        {
          monitorState: expect.objectContaining({
            lastOutcome: 'unauthorized',
          }),
        },
      ],
    });
    expect(store.owedMonitorProbeTerminalAnnouncements()).toMatchObject({
      kind: 'available',
      value: [expect.objectContaining({ outcome: 'unauthorized' })],
    });
    expect(
      store.recordMonitorProbeTerminal({
        name: job.name,
        monitorId,
        outcome: 'unauthorized',
        monitorState: { lastOutcome: 'unauthorized' },
      }),
    ).toEqual({ kind: 'already-terminal' });
    const owedRead = store.owedMonitorProbeTerminalAnnouncements();
    const [owed] = owedRead.kind === 'available' ? owedRead.value : [];
    if (!owed) throw new Error('expected owed announcement');
    const outbox = store.monitorProbeTerminalAnnouncementOutbox();
    const claim = outbox.claim(owed.id);
    if (claim.kind !== 'claimed') throw new Error('expected claim');
    outbox.release(owed.id, claim.token);
    const retry = outbox.claim(owed.id);
    if (retry.kind !== 'claimed') throw new Error('expected retry claim');
    outbox.markDelivered(owed.id, retry.token);
    expect(store.owedMonitorProbeTerminalAnnouncements()).toEqual({
      kind: 'available',
      value: [],
    });
    store.close();
  });

  test('preserves distinct probe terminal episodes after a healthy observation', () => {
    const store = ledger();
    const job = monitorJob('probe episodes');
    expect(store.create(job)).toEqual({ kind: 'created' });
    const view = store.listViews();
    if (view.kind !== 'available') throw new Error('expected view');
    const monitorId = view.value[0]!.unattendedPrincipal!.jobId;
    expect(
      store.recordMonitorProbeTerminal({
        name: job.name,
        monitorId,
        outcome: 'unauthorized',
        monitorState: { lastOutcome: 'unauthorized' },
      }),
    ).toMatchObject({ kind: 'recorded' });
    expect(
      store.update(job.name, { monitorState: { lastOutcome: 'pending' } }),
    ).toEqual({ kind: 'updated' });
    expect(
      store.recordMonitorProbeTerminal({
        name: job.name,
        monitorId,
        outcome: 'terminal',
        monitorState: { lastOutcome: 'terminal' },
      }),
    ).toMatchObject({ kind: 'recorded' });
    expect(store.owedMonitorProbeTerminalAnnouncements()).toMatchObject({
      kind: 'available',
      value: [
        expect.objectContaining({ outcome: 'unauthorized' }),
        expect.objectContaining({ outcome: 'terminal' }),
      ],
    });
    store.close();
  });

  test.each([
    ['terminal', 'The pull request is closed or merged.'],
    ['unauthorized', 'GitHub did not authorize this monitor credential.'],
    ['budget-exhausted', 'Monitor budget is exhausted.'],
  ] as const)(
    'records one owed terminal bell for the %s probe outcome',
    (outcome, nextAction) => {
      const store = ledger();
      const job = monitorJob(`probe ${outcome}`);
      expect(store.create(job)).toEqual({ kind: 'created' });
      const view = store.listViews();
      if (view.kind !== 'available') throw new Error('expected view');
      const monitorId = view.value[0]!.unattendedPrincipal!.jobId;
      expect(
        store.recordMonitorProbeTerminal({
          name: job.name,
          monitorId,
          outcome,
          monitorState: { lastOutcome: outcome, nextAction },
        }),
      ).toMatchObject({
        kind: 'recorded',
        announcement: { outcome, detail: nextAction },
      });
      expect(store.owedMonitorProbeTerminalAnnouncements()).toMatchObject({
        kind: 'available',
        value: [expect.objectContaining({ outcome })],
      });
      store.close();
    },
  );

  test('deleting a monitor deletes its probe announcement outbox in the same cleanup', () => {
    const store = ledger();
    const job = monitorJob('remove probe terminal');
    expect(store.create(job)).toEqual({ kind: 'created' });
    const view = store.listViews();
    if (view.kind !== 'available') throw new Error('expected view');
    const monitorId = view.value[0]!.unattendedPrincipal!.jobId;
    expect(
      store.recordMonitorProbeTerminal({
        name: job.name,
        monitorId,
        outcome: 'terminal',
        monitorState: {
          lastOutcome: 'unauthorized',
          nextAction: 'The pull request is closed or merged.',
        },
      }),
    ).toMatchObject({ kind: 'recorded' });
    expect(store.remove(job.name)).toEqual({ kind: 'removed' });
    expect(store.owedMonitorProbeTerminalAnnouncements()).toEqual({
      kind: 'available',
      value: [],
    });
    store.close();
  });

  test('expires a crashed reservation to an unknown-usage fence before a restart can dispatch', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-monitor-ledger-restart-'));
    roots.push(root);
    const started = new Date('2026-01-01T00:00:00.000Z');
    const first = createSchedulerLedger({ directory: root });
    expect(
      first.reserveMonitorTrigger({
        monitorId: 'm',
        ownerId: 'u',
        fingerprint: 'crashed',
        now: started,
        budget: { maxWallRuntimeMs: 1 },
      }),
    ).toMatchObject({ kind: 'dispatch' });
    first.close();
    const restarted = createSchedulerLedger({ directory: root });
    expect(
      restarted.reserveMonitorTrigger({
        monitorId: 'm',
        ownerId: 'u',
        fingerprint: 'later',
        now: new Date(started.getTime() + 2),
      }),
    ).toEqual({ kind: 'blocked', reason: 'unknown-usage' });
    restarted.close();
  });

  test('fails closed when the scheduler ledger is already corruption-latched', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-monitor-ledger-corrupt-'));
    roots.push(root);
    expect(() =>
      createSchedulerLedger({
        directory: root,
        integrityCheck: () => ({ kind: 'corrupt' }),
      }),
    ).toThrow('Scheduler storage is corrupt');
  });
});
