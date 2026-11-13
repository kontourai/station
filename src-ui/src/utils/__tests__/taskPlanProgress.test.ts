import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test } from 'vitest';
import type { WorkLane } from '../../views/home/work-status';
import {
  projectTaskPlanProgress,
  sessionPlanProgressRead,
  taskPlanProgressLabel,
} from '../taskPlanProgress';

type Status = 'pending' | 'in_progress' | 'completed';

const base = {
  provider: 'acp',
  threadId: 'thread-1',
  createdAt: '2026-11-10T12:00:00.000Z',
} as const;

function turnStarted(turnId: string): CanonicalRuntimeEvent {
  return {
    ...base,
    eventId: `start-${turnId}`,
    method: 'turn.started',
    turnId,
  } as CanonicalRuntimeEvent;
}

function plan(turnId: string, statuses: string[]): CanonicalRuntimeEvent {
  return {
    ...base,
    eventId: `plan-${turnId}-${statuses.join('.')}`,
    method: 'plan.updated',
    turnId,
    entries: statuses.map((status, index) => ({
      content: `Step ${index + 1}`,
      status: status as Status,
    })),
  } as CanonicalRuntimeEvent;
}

function sequenced(events: CanonicalRuntimeEvent[]) {
  return events.map((event, index) => ({ sequence: 100 + index, event }));
}

describe('projectTaskPlanProgress', () => {
  test('projects a plan.updated sequence to the newest full-replace fraction', () => {
    // The shape the ACP adapter publishes: each update replaces the plan.
    const events = sequenced([
      turnStarted('turn-1'),
      plan('turn-1', [
        'in_progress',
        'pending',
        'pending',
        'pending',
        'pending',
      ]),
      plan('turn-1', [
        'completed',
        'in_progress',
        'pending',
        'pending',
        'pending',
      ]),
      plan('turn-1', [
        'completed',
        'completed',
        'in_progress',
        'pending',
        'pending',
      ]),
    ]);
    const progress = projectTaskPlanProgress(events, 'running');
    expect(progress).toEqual({ done: 2, total: 5, active: true, stale: false });
    expect(taskPlanProgressLabel(progress!)).toBe(
      'Agent-reported plan: 2 of 5 steps done',
    );
  });

  test('uses the highest sequence even when the window is out of order', () => {
    const events = [
      { sequence: 3, event: plan('turn-1', ['completed', 'completed']) },
      { sequence: 1, event: turnStarted('turn-1') },
      { sequence: 2, event: plan('turn-1', ['pending', 'pending']) },
    ];
    expect(projectTaskPlanProgress(events)?.done).toBe(2);
  });

  test('shows nothing without a plan, for an empty plan, or for entries stored out of line', () => {
    expect(
      projectTaskPlanProgress(sequenced([turnStarted('turn-1')])),
    ).toBeNull();
    expect(
      projectTaskPlanProgress(
        sequenced([turnStarted('turn-1'), plan('turn-1', [])]),
      ),
    ).toBeNull();
    const spilled = {
      ...plan('turn-1', ['completed']),
      entries: { kind: 'ref', ref: 'content-1' },
    } as unknown as CanonicalRuntimeEvent;
    expect(
      projectTaskPlanProgress(sequenced([turnStarted('turn-1'), spilled])),
    ).toBeNull();
  });

  test('reports a finished plan without a halt even when the Session then failed', () => {
    const progress = projectTaskPlanProgress(
      sequenced([
        turnStarted('turn-1'),
        plan('turn-1', ['completed', 'completed', 'completed']),
      ]),
      'failed',
    );
    expect(progress).toEqual({
      done: 3,
      total: 3,
      active: false,
      stale: false,
    });
    expect(taskPlanProgressLabel(progress!)).toBe(
      'Agent-reported plan: 3 of 3 steps done',
    );
  });

  test('marks open steps stopped after an aborted turn or a failed or canceled Session', () => {
    const aborted = {
      ...base,
      eventId: 'abort-1',
      method: 'turn.aborted',
      turnId: 'turn-1',
      reason: 'interrupted',
    } as CanonicalRuntimeEvent;
    const open = plan('turn-1', ['completed', 'in_progress', 'pending']);
    const viaAbort = projectTaskPlanProgress(
      sequenced([turnStarted('turn-1'), open, aborted]),
      'idle',
    );
    expect(viaAbort).toMatchObject({ done: 1, total: 3, halted: 'stopped' });
    expect(taskPlanProgressLabel(viaAbort!)).toBe(
      'Agent-reported plan: 1 of 3 steps done, stopped',
    );
    for (const state of ['failed', 'canceled'] as const)
      expect(
        projectTaskPlanProgress(sequenced([turnStarted('turn-1'), open]), state)
          ?.halted,
      ).toBe('stopped');
  });

  test('marks open steps waiting while the Session is blocked or waits on input or approval', () => {
    const open = sequenced([
      turnStarted('turn-1'),
      plan('turn-1', ['completed', 'pending']),
    ]);
    for (const state of ['blocked', 'needs_input', 'review_pending'] as const)
      expect(projectTaskPlanProgress(open, state)?.halted).toBe('waiting');
    expect(projectTaskPlanProgress(open, 'running')?.halted).toBeUndefined();
  });

  test('counts an unrecognized step status, never as done', () => {
    const progress = projectTaskPlanProgress(
      sequenced([
        turnStarted('turn-1'),
        plan('turn-1', ['completed', 'failed', 'blocked']),
      ]),
    );
    expect(progress).toMatchObject({ done: 1, total: 3, active: false });
  });

  test('marks the plan stale when its newest update predates the latest turn', () => {
    const progress = projectTaskPlanProgress(
      sequenced([
        turnStarted('turn-1'),
        plan('turn-1', ['completed', 'pending']),
        turnStarted('turn-2'),
      ]),
    );
    expect(progress?.stale).toBe(true);
    expect(taskPlanProgressLabel(progress!)).toBe(
      'Agent-reported plan: 1 of 2 steps done, from an earlier turn',
    );
  });

  test('uses the singular for a one-step plan', () => {
    const progress = projectTaskPlanProgress(
      sequenced([turnStarted('turn-1'), plan('turn-1', ['pending'])]),
    );
    expect(taskPlanProgressLabel(progress!)).toBe(
      'Agent-reported plan: 0 of 1 step done',
    );
  });
});

describe('sessionPlanProgressRead', () => {
  test('reads every lane the ladder files a Session in but Drafts, refreshing running and needs-you rows', () => {
    const lanes: Record<WorkLane, true> = {
      needsYou: true,
      running: true,
      idle: true,
      finished: true,
      drafts: true,
      external: true,
    };
    const reads = Object.fromEntries(
      (Object.keys(lanes) as WorkLane[]).map((lane) => [
        lane,
        sessionPlanProgressRead({ lane }),
      ]),
    );
    expect(reads).toEqual({
      needsYou: 'live',
      running: 'live',
      idle: 'settled',
      finished: 'settled',
      drafts: 'skip',
      external: 'settled',
    });
  });
});
