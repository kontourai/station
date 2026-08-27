/**
 * Console bridge derivation tests (S4 item 1).
 *
 * Record schema validity is asserted against the REAL validator shipped in
 * the published @kontourai/console tarball (`validateEvent` from the
 * console-foundation dist), not a hand-rolled copy — if upstream tightens
 * the contract, these tests fail honestly.
 */

import { createRequire } from 'node:module';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test } from 'vitest';
import type { PersistedRuntimeEvent } from '../../orchestration/event-store.js';
import {
  CONSOLE_BRIDGED_METHODS,
  deriveConsoleEventRecords,
  resolveThreadWorkspace,
} from '../console-bridge.js';

const require = createRequire(import.meta.url);
// The published package has no root entry (`main`/`exports` are absent —
// upstream C1), so the shipped dist is loaded by file path.
const { validateEvent } =
  require('@kontourai/console/console-server/dist/src/console-foundation/index.js') as {
    validateEvent: (
      event: unknown,
      basePath: string,
    ) => Array<{ severity: string; path: string; message: string }>;
  };

const THREAD = 'thread-console-1';

function persisted(
  sequence: number,
  event: CanonicalRuntimeEvent,
): PersistedRuntimeEvent {
  return {
    id: event.eventId,
    provider: event.provider,
    threadId: event.threadId,
    method: event.method,
    payload: event,
    createdAt: event.createdAt,
    sequence,
    globalSequence: sequence,
  };
}

function gatedSessionEvents(): PersistedRuntimeEvent[] {
  const base = { provider: 'claude' as const, threadId: THREAD };
  return [
    persisted(1, {
      ...base,
      eventId: 'evt-1',
      createdAt: '2026-06-12T10:00:00.000Z',
      method: 'session.started',
      sessionId: THREAD,
    }),
    persisted(2, {
      ...base,
      eventId: 'evt-2',
      createdAt: '2026-06-12T10:00:01.000Z',
      method: 'flow.run-attached',
      runId: 'session-thread-console-1',
      definitionId: 'station-delivery',
      cwd: '/tmp/workspace-a',
      resumed: false,
    }),
    persisted(3, {
      ...base,
      eventId: 'evt-3',
      createdAt: '2026-06-12T10:05:00.000Z',
      method: 'flow.gate-verdict',
      runId: 'session-thread-console-1',
      verdict: 'route-back',
      gateId: 'implement-gate',
      routeBackTo: 'implement',
      attempt: 1,
      maxAttempts: 3,
      summary: 'implement-gate routed back.',
    }),
    persisted(4, {
      ...base,
      eventId: 'evt-4',
      createdAt: '2026-06-12T10:20:00.000Z',
      method: 'workflow.state-changed',
      taskSlug: 'console-emission',
      cwd: '/tmp/workspace-a',
      ownership: 'station-owned',
      status: 'in_progress',
      phase: 'execution',
      nextActionStatus: 'continue',
      nextActionSummary: 'Address the gate verdict.',
      trigger: 'gate-verdict',
      resumed: false,
    }),
    persisted(5, {
      ...base,
      eventId: 'evt-5',
      createdAt: '2026-06-12T10:25:00.000Z',
      method: 'platform.mutation',
      tool: 'create_agent',
      argsSummary: '{"slug":"demo"}',
      outcome: 'allowed',
      decision: 'allow',
      profile: 'standard',
      cwd: '/tmp/workspace-a',
      runId: 'session-thread-console-1',
      gateId: 'implement-gate',
    }),
    persisted(6, {
      ...base,
      eventId: 'evt-6',
      createdAt: '2026-06-12T10:30:00.000Z',
      method: 'flow.gate-verdict',
      runId: 'session-thread-console-1',
      verdict: 'pass',
      gateId: 'readiness-gate',
      reportPaths: {
        json: '.kontourai/flow/runs/session-thread-console-1/report.json',
        markdown: '.kontourai/flow/runs/session-thread-console-1/report.md',
      },
    }),
    persisted(7, {
      ...base,
      eventId: 'evt-7',
      createdAt: '2026-06-12T10:30:01.000Z',
      method: 'session.state-changed',
      sessionId: THREAD,
      from: 'review_pending',
      to: 'completed',
    }),
    persisted(8, {
      ...base,
      eventId: 'evt-8',
      createdAt: '2026-06-12T10:30:02.000Z',
      method: 'session.exited',
      sessionId: THREAD,
      exitCode: 0,
    }),
  ];
}

describe('deriveConsoleEventRecords', () => {
  test('derivation is deterministic: same event-sourced state -> identical records', () => {
    const first = deriveConsoleEventRecords(gatedSessionEvents());
    const second = deriveConsoleEventRecords(gatedSessionEvents());
    expect(second).toEqual(first);
    expect(first.map((record) => record.id)).toEqual([
      'evt-stationbridge-thread-console-1-1',
      'evt-stationbridge-thread-console-1-2',
      'evt-stationbridge-thread-console-1-3',
      'evt-stationbridge-thread-console-1-4',
      'evt-stationbridge-thread-console-1-5',
      'evt-stationbridge-thread-console-1-6',
      'evt-stationbridge-thread-console-1-7',
      'evt-stationbridge-thread-console-1-8',
    ]);
  });

  test('every derived record validates against the published Console validator', () => {
    const records = deriveConsoleEventRecords(gatedSessionEvents());
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      const issues = validateEvent(record, record.id).filter(
        (issue) => issue.severity === 'error',
      );
      expect(issues).toEqual([]);
    }
  });

  test('maps session lifecycle into Console process vocabulary', () => {
    const records = deriveConsoleEventRecords(gatedSessionEvents());
    const started = records[0];
    expect(started.type).toBe('process.started');
    expect(started.subject).toMatchObject({
      product: 'station',
      kind: 'session',
      id: 'station-session-thread-console-1',
    });
    expect(started.payload.after).toMatchObject({ status: 'running' });

    const completed = records.find(
      (record) =>
        record.type === 'process.progressed' &&
        (record.payload.after as { sessionState?: string }).sessionState ===
          'completed',
    );
    expect(completed?.payload.after).toMatchObject({ status: 'completed' });
  });

  test('maps flow.run-attached to a session->run link', () => {
    const records = deriveConsoleEventRecords(gatedSessionEvents());
    const attached = records[1];
    expect(attached.links).toEqual([
      {
        from: expect.objectContaining({
          id: 'station-session-thread-console-1',
        }),
        relation: 'gated-by',
        to: expect.objectContaining({
          product: 'flow',
          kind: 'run',
          id: 'run-session-thread-console-1',
        }),
      },
    ]);
    expect(attached.links?.[0]?.to.label).toBe('Legacy delivery checks');
    expect(attached.payload.summary).toBe(
      'Session bound to Legacy delivery checks.',
    );
    expect(JSON.stringify(attached.links)).not.toContain('station-delivery');
  });

  test('maps gate verdicts onto Console gate event types with explicit statuses', () => {
    const records = deriveConsoleEventRecords(gatedSessionEvents());
    const routed = records[2];
    expect(routed.type).toBe('gate.routed_back');
    expect(routed.subject.id).toBe(
      'gate-session-thread-console-1-implement-gate',
    );
    expect(routed.payload.after).toMatchObject({
      status: 'routed_back',
      processRef: expect.objectContaining({
        id: 'station-session-thread-console-1',
      }),
    });

    const passed = records.find((record) => record.type === 'gate.passed');
    expect(passed?.payload).toMatchObject({
      verdict: 'pass',
      reportPaths: {
        json: '.kontourai/flow/runs/session-thread-console-1/report.json',
        markdown: '.kontourai/flow/runs/session-thread-console-1/report.md',
      },
    });
    expect(passed?.payload.after).toMatchObject({ status: 'passed' });
  });

  test('carries workflow and platform-mutation events as station.* timeline types', () => {
    const records = deriveConsoleEventRecords(gatedSessionEvents());
    const workflow = records.find(
      (record) => record.type === 'station.workflow.state-changed',
    );
    expect(workflow?.subject.id).toBe('workflow-console-emission');
    const mutation = records.find(
      (record) => record.type === 'station.platform.mutation',
    );
    expect(mutation?.payload.after).toMatchObject({
      tool: 'create_agent',
      outcome: 'allowed',
    });
  });

  test('skips chatter and non-terminal state changes', () => {
    const events: PersistedRuntimeEvent[] = [
      ...gatedSessionEvents(),
      persisted(9, {
        provider: 'claude',
        threadId: THREAD,
        eventId: 'evt-9',
        createdAt: '2026-06-12T10:31:00.000Z',
        method: 'content.text-delta',
        itemId: 'item-1',
        delta: 'hello',
      }),
      persisted(10, {
        provider: 'claude',
        threadId: THREAD,
        eventId: 'evt-10',
        createdAt: '2026-06-12T10:31:01.000Z',
        method: 'session.state-changed',
        sessionId: THREAD,
        from: 'idle',
        to: 'running',
      }),
    ];
    const records = deriveConsoleEventRecords(events);
    expect(records).toHaveLength(8);
    expect(CONSOLE_BRIDGED_METHODS.has('content.text-delta')).toBe(false);
  });

  test('resolveThreadWorkspace returns the latest cwd-bearing event', () => {
    expect(resolveThreadWorkspace(gatedSessionEvents())).toBe(
      '/tmp/workspace-a',
    );
    expect(resolveThreadWorkspace([gatedSessionEvents()[0]])).toBeUndefined();
  });
});
