import { describe, expect, test } from 'vitest';
import {
  applyChildWorkDelta,
  CHILD_WORK_ITEMS_MAX_PER_REPORTER,
  CHILD_WORK_SUMMARY_MAX_CHARS,
  type ChildWorkDelta,
  type ChildWorkItem,
  type ChildWorkRegistryState,
  childWorkForReporter,
  childWorkKey,
  createEmptyChildWorkRegistry,
  forgetChildWorkReporter,
  projectDelegateChildWork,
} from '../child-work.js';

const REPORTER = 'thread-1';

function item(childId: string, extra: Partial<ChildWorkItem> = {}) {
  return {
    producer: 'engine-subagent',
    reporterThreadId: REPORTER,
    childId,
    status: 'running',
    ...extra,
  } as ChildWorkItem;
}

function snapshot(...running: ChildWorkItem[]): ChildWorkDelta {
  return {
    kind: 'snapshot',
    producer: 'engine-subagent',
    reporterThreadId: REPORTER,
    running,
  };
}

function settle(
  childId: string,
  status: Extract<ChildWorkDelta, { kind: 'settle' }>['status'],
  extra: Partial<Extract<ChildWorkDelta, { kind: 'settle' }>> = {},
): ChildWorkDelta {
  return {
    kind: 'settle',
    producer: 'engine-subagent',
    reporterThreadId: REPORTER,
    childId,
    status,
    ...extra,
  };
}

function fold(...deltas: ChildWorkDelta[]): ChildWorkRegistryState {
  return deltas.reduce(applyChildWorkDelta, createEmptyChildWorkRegistry());
}

function get(state: ChildWorkRegistryState, childId: string) {
  return state.items[
    childWorkKey({
      producer: 'engine-subagent',
      reporterThreadId: REPORTER,
      childId,
    })
  ];
}

describe('applyChildWorkDelta', () => {
  test('a settle before any listing is a tombstone a later snapshot or upsert cannot resurrect', () => {
    const settled = fold(settle('a', 'completed'));
    expect(get(settled, 'a')?.status).toBe('completed');

    const afterSnapshot = applyChildWorkDelta(settled, snapshot(item('a')));
    expect(get(afterSnapshot, 'a')?.status).toBe('completed');
    const afterUpsert = applyChildWorkDelta(settled, {
      kind: 'upsert',
      item: item('a', { progress: 'still going?' }),
    });
    expect(afterUpsert).toBe(settled);
  });

  test('a duplicate settle enriches absent result/usage once and never changes the status', () => {
    const first = fold(
      snapshot(item('a', { title: 'Explore', backgrounded: true })),
      settle('a', 'completed'),
    );
    expect(get(first, 'a')?.result).toBeUndefined();

    const enriched = applyChildWorkDelta(
      first,
      settle('a', 'failed', {
        result: { summary: 'done: 3 files' },
        usage: { totalTokens: 12 },
      }),
    );
    expect(get(enriched, 'a')).toMatchObject({
      status: 'completed',
      title: 'Explore',
      result: { summary: 'done: 3 files' },
      usage: { totalTokens: 12 },
    });

    // A later settle cannot overwrite what the enrichment filled…
    const again = applyChildWorkDelta(
      enriched,
      settle('a', 'completed', {
        result: { summary: 'different' },
        usage: { totalTokens: 99 },
      }),
    );
    expect(again).toBe(enriched);
    // …and a third identical settle is the same reference.
    const identical = applyChildWorkDelta(
      enriched,
      settle('a', 'failed', {
        result: { summary: 'done: 3 files' },
        usage: { totalTokens: 12 },
      }),
    );
    expect(identical).toBe(enriched);
  });

  test('a reconnect snapshot that omits a running child marks it unresolved, not completed', () => {
    const state = fold(snapshot(item('a'), item('b')), snapshot(item('b')));
    expect(get(state, 'a')?.status).toBe('unresolved');
    expect(get(state, 'b')?.status).toBe('running');
  });

  test('a snapshot only speaks for its own producer', () => {
    const state = fold(snapshot(item('a')), {
      kind: 'snapshot',
      producer: 'station-delegate',
      reporterThreadId: REPORTER,
      running: [],
    });
    expect(get(state, 'a')?.status).toBe('running');
  });

  test('a later real settle corrects unresolved; other terminals stay sticky', () => {
    const unresolved = fold(snapshot(item('a')), snapshot());
    const corrected = applyChildWorkDelta(
      unresolved,
      settle('a', 'failed', { result: { summary: 'boom' } }),
    );
    expect(get(corrected, 'a')).toMatchObject({
      status: 'failed',
      result: { summary: 'boom' },
    });
    // stopped-unconfirmed is correctable too.
    const unconfirmed = fold(
      snapshot(item('b')),
      settle('b', 'stopped-unconfirmed'),
    );
    expect(
      get(applyChildWorkDelta(unconfirmed, settle('b', 'cancelled')), 'b')
        ?.status,
    ).toBe('cancelled');
    // But a real terminal is sticky against another real terminal.
    const done = fold(settle('c', 'completed'));
    expect(
      get(applyChildWorkDelta(done, settle('c', 'failed')), 'c')?.status,
    ).toBe('completed');
  });

  test('not-reported records the reason, clears nothing, and differs from reported-empty', () => {
    const reported = fold(snapshot());
    const notReported = applyChildWorkDelta(fold(snapshot(item('a'))), {
      kind: 'not-reported',
      reporterThreadId: REPORTER,
      reason: 'The engine reports no subagent identity.',
    });
    expect(notReported.notReported[REPORTER]).toBe(
      'The engine reports no subagent identity.',
    );
    expect(get(notReported, 'a')?.status).toBe('running');
    expect(reported.notReported[REPORTER]).toBeUndefined();
    expect(childWorkForReporter(reported, REPORTER)).toEqual([]);
  });

  test('a summary past the bound is cut and flagged; a short one is not', () => {
    const long = 'x'.repeat(CHILD_WORK_SUMMARY_MAX_CHARS + 10);
    const cut = get(
      fold(settle('a', 'completed', { result: { summary: long } })),
      'a',
    );
    expect(cut?.result?.summary).toHaveLength(CHILD_WORK_SUMMARY_MAX_CHARS);
    expect(cut?.result?.summaryTruncated).toBe(true);
    const short = get(
      fold(settle('b', 'completed', { result: { summary: 'ok' } })),
      'b',
    );
    expect(short?.result).toEqual({ summary: 'ok' });
  });

  test('absent usage stays absent; invalid figures are dropped, not zeroed', () => {
    const none = get(fold(settle('a', 'completed')), 'a');
    expect(none).not.toHaveProperty('usage');
    const partial = get(
      fold(
        settle('b', 'completed', {
          usage: { totalTokens: Number.NaN, toolUses: -1, durationMs: 40 },
        }),
      ),
      'b',
    );
    expect(partial?.usage).toEqual({ durationMs: 40 });
  });

  test('depth ≤ 0 is dropped as unreported', () => {
    const state = fold(
      snapshot(item('a', { depth: 0 }), item('b', { depth: 2 })),
    );
    expect(get(state, 'a')).not.toHaveProperty('depth');
    expect(get(state, 'b')?.depth).toBe(2);
  });

  test('upsert merges progress into a running child and a later snapshot keeps it', () => {
    const state = fold(
      snapshot(item('a', { title: 'Explore' })),
      { kind: 'upsert', item: item('a', { progress: 'Reading files' }) },
      snapshot(item('a', { title: 'Explore' })),
    );
    expect(get(state, 'a')).toMatchObject({
      title: 'Explore',
      progress: 'Reading files',
      status: 'running',
    });
  });

  test('a no-op delta returns the same reference', () => {
    const state = fold(snapshot(item('a')));
    expect(applyChildWorkDelta(state, snapshot(item('a')))).toBe(state);
    const notReported = applyChildWorkDelta(state, {
      kind: 'not-reported',
      reporterThreadId: REPORTER,
      reason: 'r',
    });
    expect(
      applyChildWorkDelta(notReported, {
        kind: 'not-reported',
        reporterThreadId: REPORTER,
        reason: 'r',
      }),
    ).toBe(notReported);
  });

  test('the running set per reporter is bounded', () => {
    const many = Array.from(
      { length: CHILD_WORK_ITEMS_MAX_PER_REPORTER + 5 },
      (_, i) => item(`c${i}`),
    );
    const state = fold(snapshot(...many));
    expect(childWorkForReporter(state, REPORTER)).toHaveLength(
      CHILD_WORK_ITEMS_MAX_PER_REPORTER,
    );
    expect(
      applyChildWorkDelta(state, { kind: 'upsert', item: item('extra') }),
    ).toBe(state);
  });

  test('a settle identity cannot re-key the child', () => {
    const state = fold(
      snapshot(item('a')),
      settle('a', 'completed', {
        identity: { childId: 'evil' } as never,
      }),
    );
    expect(get(state, 'a')?.childId).toBe('a');
  });

  test('forgetChildWorkReporter drops the reporter only', () => {
    const other = { ...item('z'), reporterThreadId: 'thread-2' };
    const state = fold(snapshot(item('a')), {
      kind: 'snapshot',
      producer: 'engine-subagent',
      reporterThreadId: 'thread-2',
      running: [other],
    });
    const forgotten = forgetChildWorkReporter(state, REPORTER);
    expect(childWorkForReporter(forgotten, REPORTER)).toEqual([]);
    expect(childWorkForReporter(forgotten, 'thread-2')).toHaveLength(1);
  });
});

describe('projectDelegateChildWork', () => {
  const base = {
    threadId: 'del-1',
    createdAt: '2026-09-23T10:00:00.000Z',
    lastEventAt: '2026-09-23T10:05:00.000Z',
  };

  test('a delegate with a parent is a running child of that parent while its turn is open', () => {
    expect(
      projectDelegateChildWork({
        ...base,
        hasActiveTurn: true,
        lifecycleState: 'running',
        delegation: {
          taskId: 'del-1',
          parentTaskId: 'chat-1',
          title: 'Review the diff',
          targetId: 'reviewer',
        },
      }),
    ).toEqual({
      producer: 'station-delegate',
      reporterThreadId: 'del-1',
      childId: 'del-1',
      status: 'running',
      parent: { taskId: 'chat-1' },
      title: 'Review the diff',
      kindLabel: 'reviewer',
      startedAt: '2026-09-23T10:00:00.000Z',
      controls: { stop: 'delegate-interrupt' },
    });
  });

  test('a CLI delegate with no parent is a root-level child (no parent)', () => {
    const child = projectDelegateChildWork({
      ...base,
      hasActiveTurn: false,
      lifecycleState: 'completed',
      delegation: { taskId: 'del-1' },
    });
    expect(child).toMatchObject({
      status: 'completed',
      endedAt: base.lastEventAt,
    });
    expect(child).not.toHaveProperty('parent');
  });

  test('terminal status derives from lifecycle; no terminal lifecycle is unresolved', () => {
    const status = (lifecycleState: string) =>
      projectDelegateChildWork({
        ...base,
        hasActiveTurn: false,
        lifecycleState,
        delegation: { taskId: 'del-1', parentTaskId: 'chat-1' },
      })?.status;
    expect(status('failed')).toBe('failed');
    expect(status('canceled')).toBe('cancelled');
    expect(status('needs_input')).toBe('unresolved');
  });

  test('a peer delegation carries no local stop control', () => {
    expect(
      projectDelegateChildWork({
        ...base,
        hasActiveTurn: true,
        delegation: {
          taskId: 'del-1',
          parentTaskId: 'chat-1',
          environmentKind: 'peer',
        },
      }),
    ).not.toHaveProperty('controls');
  });

  test('a session that is not a delegate projects nothing', () => {
    expect(projectDelegateChildWork({ ...base, hasActiveTurn: true })).toBe(
      undefined,
    );
  });
});
