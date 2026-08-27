import { describe, expect, test } from 'vitest';
// The grouping module is UI presentation code but PURE (contracts types only) —
// this server-side test exists so its fixtures come from the REAL projection
// builder (#1715 rule) without dragging the server graph into the UI compile.
import { groupDelegatedSessionRuns } from '../../../../src-ui/src/views/sessions/run-groups';
import { buildOrchestrationSessionSummary } from '../orchestration-session-state';

const ANSWERABILITY = {
  threadAttachment: 'detached',
  providerRegistered: true,
  observedBy: 'sessions-run-groups-test',
  observedAt: '2026-08-24T00:00:00.000Z',
} as const;

function projectedSession(options: {
  threadId: string;
  taskId?: string;
  parentTaskId?: string;
  projectSlug?: string;
  environmentId?: string;
  connectionId?: string;
}) {
  return buildOrchestrationSessionSummary({
    persisted: {
      provider: 'codex',
      threadId: options.threadId,
      status: 'running',
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:01.000Z',
    },
    events: [
      {
        provider: 'codex',
        threadId: options.threadId,
        eventId: `${options.threadId}:configured`,
        createdAt: '2026-08-24T00:00:00.000Z',
        method: 'session.configured',
        sessionId: options.threadId,
        metadata: options.taskId
          ? {
              taskId: options.taskId,
              targetKind: 'agent',
              targetId: 'codex',
              ...(options.projectSlug
                ? { projectSlug: options.projectSlug }
                : {}),
              ...(options.environmentId
                ? { environmentId: options.environmentId }
                : {}),
              ...(options.connectionId
                ? { connectionId: options.connectionId }
                : {}),
              ...(options.parentTaskId
                ? { parentTaskId: options.parentTaskId }
                : {}),
            }
          : {},
      } as never,
    ],
    eventCount: 1,
    answerability: ANSWERABILITY,
  });
}

function everyPermutation<T>(items: readonly T[]): T[][] {
  if (items.length < 2) return [[...items]];
  return items.flatMap((item, index) =>
    everyPermutation([...items.slice(0, index), ...items.slice(index + 1)]).map(
      (rest) => [item, ...rest],
    ),
  );
}

describe('groupDelegatedSessionRuns', () => {
  test('groups real serialized session summaries by the launcher parent-task link', () => {
    // These are the real server projection's serialized summaries, not a UI
    // lookalike: a direct parent is identified by its thread id, while its
    // delegated children carry distinct task ids plus that parentTaskId.
    const parent = projectedSession({ threadId: 'parent-thread' });
    const firstDelegate = projectedSession({
      threadId: 'delegate-a',
      taskId: 'task:delegate-a',
      parentTaskId: 'parent-thread',
    });
    const secondDelegate = projectedSession({
      threadId: 'delegate-b',
      taskId: 'task:delegate-b',
      parentTaskId: 'parent-thread',
    });

    expect(
      groupDelegatedSessionRuns([parent, firstDelegate, secondDelegate]),
    ).toEqual([
      {
        kind: 'run',
        run: expect.objectContaining({
          parent,
          members: [parent, firstDelegate, secondDelegate],
        }),
      },
    ]);
  });

  test('keeps sessions without an honest parent-task join flat', () => {
    const first = projectedSession({
      threadId: 'first',
      taskId: 'task:first',
    });
    const second = projectedSession({ threadId: 'second' });

    expect(groupDelegatedSessionRuns([first, second])).toEqual([
      { kind: 'session', session: first },
      { kind: 'session', session: second },
    ]);
  });

  test('prefers the direct parent thread over a cross-project task-id collision in every input order', () => {
    const projectAParent = projectedSession({
      threadId: 'project-a-parent',
      projectSlug: 'project-a',
    });
    const projectBTaskOwner = projectedSession({
      threadId: 'project-b-unrelated',
      taskId: 'project-a-parent',
      projectSlug: 'project-b',
    });
    const projectAChild = projectedSession({
      threadId: 'project-a-child',
      taskId: 'task:project-a-child',
      parentTaskId: 'project-a-parent',
      projectSlug: 'project-a',
    });

    for (const input of everyPermutation([
      projectAParent,
      projectBTaskOwner,
      projectAChild,
    ])) {
      const run = groupDelegatedSessionRuns(input).find(
        (entry) => entry.kind === 'run',
      );
      expect(run).toMatchObject({
        kind: 'run',
        run: {
          parent: projectAParent,
          members: expect.arrayContaining([projectAParent, projectAChild]),
        },
      });
      expect(run?.kind === 'run' && run.run.members).not.toContain(
        projectBTaskOwner,
      );
    }
  });

  // Delta-review D1: absence is not corroboration — two scope-less legacy
  // summaries must not join on undefined === undefined.
  test('keeps a task-id parent flat when neither side carries any scope', () => {
    const unrelated = projectedSession({
      threadId: 'unrelated',
      taskId: 'task:shared',
    });
    const child = projectedSession({
      threadId: 'child',
      // taskId is required for the fixture to carry a delegation context at
      // all — without it the parentTaskId never reaches the join logic and
      // this test would pass without exercising the corroboration guard
      // (proven by an uncaught injection).
      taskId: 'task:child',
      parentTaskId: 'task:shared',
    });
    // The guard under test must actually be reachable: both sides carry a
    // delegation context and NO scope dimension.
    expect(child.delegation?.parentTaskId).toBe('task:shared');
    expect(child.delegation?.projectSlug).toBeUndefined();
    expect(unrelated.delegation?.projectSlug).toBeUndefined();
    for (const order of [
      [unrelated, child],
      [child, unrelated],
    ]) {
      expect(groupDelegatedSessionRuns(order)).toEqual(
        order.map((session) => ({ kind: 'session', session })),
      );
    }
  });

  test('keeps a task-id parent flat when its only owner disagrees on scope', () => {
    const projectBParent = projectedSession({
      threadId: 'project-b-parent',
      taskId: 'task:shared-parent',
      projectSlug: 'project-b',
      environmentId: 'env-b',
    });
    const projectAChild = projectedSession({
      threadId: 'project-a-child',
      taskId: 'task:project-a-child',
      parentTaskId: 'task:shared-parent',
      projectSlug: 'project-a',
      environmentId: 'env-a',
    });

    expect(groupDelegatedSessionRuns([projectBParent, projectAChild])).toEqual([
      { kind: 'session', session: projectBParent },
      { kind: 'session', session: projectAChild },
    ]);
  });

  test('never promotes a delegate with an absent ancestor into a run parent', () => {
    const nested = projectedSession({
      threadId: 'nested',
      taskId: 'task:nested',
      parentTaskId: 'task:top-absent',
      projectSlug: 'project-a',
    });
    const leaf = projectedSession({
      threadId: 'leaf',
      taskId: 'task:leaf',
      parentTaskId: 'task:nested',
      projectSlug: 'project-a',
    });

    for (const input of everyPermutation([nested, leaf])) {
      expect(groupDelegatedSessionRuns(input)).toEqual([
        { kind: 'session', session: input[0] },
        { kind: 'session', session: input[1] },
      ]);
    }
  });
});
