import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test } from 'vitest';
import { replayClaudeTaskCapture } from '../../../providers/__tests__/claude-task-captures.js';
import { ChildWorkProjection } from '../child-work-projection.js';
import { buildOrchestrationSessionSummary } from '../orchestration-session-state.js';

const THREAD = 'thread-1';
let seq = 0;

function event(
  fields: Record<string, unknown>,
  threadId = THREAD,
  provider = 'claude',
): CanonicalRuntimeEvent {
  seq += 1;
  return {
    eventId: `e-${seq}`,
    provider,
    threadId,
    createdAt: `2026-09-23T00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    ...fields,
  } as CanonicalRuntimeEvent;
}

const legacy = (type: string, payload: unknown, threadId = THREAD) =>
  event(
    {
      method: 'extension.notification',
      namespace: 'claude-code',
      type,
      payload,
    },
    threadId,
  );

describe('ChildWorkProjection', () => {
  test('reports a settled child alongside the current running set', () => {
    const projection = new ChildWorkProjection();
    projection.observe(
      event({
        method: 'child-work.updated',
        delta: {
          kind: 'upsert',
          item: {
            producer: 'engine-subagent',
            reporterThreadId: THREAD,
            childId: 'child-1',
            status: 'running',
            title: 'Explore',
            backgrounded: true,
          },
        },
      }),
    );
    projection.observe(
      event({
        method: 'child-work.updated',
        delta: {
          kind: 'settle',
          producer: 'engine-subagent',
          reporterThreadId: THREAD,
          childId: 'child-1',
          status: 'completed',
          result: { summary: 'Done.' },
        },
      }),
    );
    expect(projection.read(THREAD, 'claude')).toMatchObject({
      observability: 'reported',
      running: [],
      settled: [
        {
          childId: 'child-1',
          status: 'completed',
          result: { summary: 'Done.' },
        },
      ],
    });
  });
  test('R2: with no report of its own (a fresh process after a restart) the view still speaks for every engine session', () => {
    const projection = new ChildWorkProjection();
    // A declared engine: reported, nothing running — truthful, because an
    // engine's children die with the process that ran them.
    expect(projection.read(THREAD, 'claude', 'now')).toEqual({
      observability: 'reported',
      running: [],
      observedAt: 'now',
    });
    // A `none` engine: not-reported, with the matrix's own reason.
    expect(projection.read(THREAD, 'muse')).toEqual({
      observability: 'not-reported',
      reason: 'The engine reports no subagent identity.',
    });
    // #2458: Codex's subagents are mapped, so it speaks like any declared
    // engine — reported, nothing running.
    expect(projection.read(THREAD, 'codex', 'now')).toEqual({
      observability: 'reported',
      running: [],
      observedAt: 'now',
    });
    // A provider the matrix does not know: no claim either way.
    expect(projection.read(THREAD, 'bedrock')).toBeUndefined();
    expect(projection.read(THREAD, undefined)).toBeUndefined();
  });

  test("replay: folds pre-#2457 Claude history's legacy task tuples through the contract translator", () => {
    const projection = new ChildWorkProjection();
    projection.observe(
      legacy('task/registry', {
        active: [
          {
            taskId: 'a',
            toolCallId: 'toolu-a',
            description: 'Explore',
            backgrounded: true,
            spawnDepth: 1,
          },
        ],
      }),
    );
    const live = projection.read(THREAD, 'claude');
    expect(live).toMatchObject({
      observability: 'reported',
      running: [
        {
          producer: 'engine-subagent',
          reporterThreadId: THREAD,
          childId: 'a',
          status: 'running',
          title: 'Explore',
          depth: 1,
          parent: { toolCallId: 'toolu-a' },
        },
      ],
    });

    projection.observe(
      legacy('task/settled', { taskId: 'a', status: 'success' }),
    );
    projection.observe(legacy('task/registry', { active: [] }));
    expect(projection.read(THREAD, 'claude')).toMatchObject({
      observability: 'reported',
      running: [],
    });
  });

  test('a tuple from another namespace is not child work', () => {
    const projection = new ChildWorkProjection();
    projection.observe(
      event({
        method: 'extension.notification',
        namespace: '_kiro.dev',
        type: 'task/registry',
        payload: { active: [{ taskId: 'a' }] },
      }),
    );
    expect(projection.read(THREAD, 'bedrock')).toBeUndefined();
  });

  test('session.exited forgets the thread', () => {
    const projection = new ChildWorkProjection();
    projection.observe(legacy('task/registry', { active: [{ taskId: 'a' }] }));
    projection.observe(event({ method: 'session.exited' }));
    expect(projection.read(THREAD, 'claude')).toMatchObject({
      observability: 'reported',
      running: [],
    });
  });

  test('a child-work delta naming another reporter is not recorded under this thread', () => {
    const projection = new ChildWorkProjection();
    projection.observe(
      event({
        method: 'child-work.updated',
        delta: {
          kind: 'snapshot',
          producer: 'engine-subagent',
          reporterThreadId: 'other',
          running: [],
        },
      }),
    );
    expect(projection.read(THREAD, 'bedrock')).toBeUndefined();
    expect(projection.read('other', 'bedrock')).toBeUndefined();
  });

  test('the real captured Claude run: the backgrounded task reads as running mid-run and nothing is left running at the end', () => {
    const projection = new ChildWorkProjection();
    const { events } = replayClaudeTaskCapture('task-subagents', {
      threadId: THREAD,
    });
    let sawBackgroundRunning = false;
    for (const published of events) {
      projection.observe(published);
      const view = projection.read(THREAD, 'claude');
      if (
        view?.observability === 'reported' &&
        view.running.some(
          (item) => item.title === '[haiku] Background task test',
        )
      ) {
        sawBackgroundRunning = true;
      }
    }
    expect(sawBackgroundRunning).toBe(true);
    expect(projection.read(THREAD, 'claude')).toMatchObject({
      observability: 'reported',
      running: [],
    });
  });

  test('#2457 D1: a late settle after session.exited recreates nothing; a restarted thread is live again', () => {
    const settled: string[] = [];
    const projection = new ChildWorkProjection({
      onChildSettled: (item) => settled.push(item.childId),
    });
    const key = {
      producer: 'engine-subagent' as const,
      reporterThreadId: THREAD,
    };
    const listed = () =>
      event({
        method: 'child-work.updated',
        delta: {
          kind: 'snapshot',
          ...key,
          running: [{ ...key, childId: 'a', status: 'running' }],
        },
      });
    projection.observe(listed());
    projection.observe(event({ method: 'session.exited' }));
    // The adapter drains the real outcome after the session ended.
    projection.observe(
      event({
        method: 'child-work.updated',
        delta: { kind: 'settle', ...key, childId: 'a', status: 'cancelled' },
      }),
    );
    const internals = projection as unknown as {
      state: { items: Record<string, unknown> };
      observedAt: Map<string, string>;
    };
    expect(internals.state.items).toEqual({});
    expect(internals.observedAt.has(THREAD)).toBe(false);
    expect(projection.read(THREAD, 'claude', 'now')).toEqual({
      observability: 'reported',
      running: [],
      observedAt: 'now',
    });
    expect(settled).toEqual([]);

    // The same thread starting again reports normally.
    projection.observe(event({ method: 'session.started' }));
    projection.observe(listed());
    expect(projection.read(THREAD, 'claude')).toMatchObject({
      running: [{ childId: 'a', status: 'running' }],
    });
  });

  test('#2457: onChildSettled fires once per child, on its running → terminal fold, with the settling provider', () => {
    const settled: Array<[string, string, string]> = [];
    const projection = new ChildWorkProjection({
      onChildSettled: (item, provider) =>
        settled.push([item.childId, item.status, provider]),
    });
    const key = {
      producer: 'engine-subagent' as const,
      reporterThreadId: THREAD,
    };
    const running = (childId: string) => ({
      ...key,
      childId,
      status: 'running' as const,
    });
    projection.observe(
      event({
        method: 'child-work.updated',
        delta: {
          kind: 'snapshot',
          ...key,
          running: [running('a'), running('b')],
        },
      }),
    );
    // The station#1892 pair: the second terminal only enriches.
    for (const summary of [undefined, 'done']) {
      projection.observe(
        event({
          method: 'child-work.updated',
          delta: {
            kind: 'settle',
            ...key,
            childId: 'a',
            status: 'completed',
            ...(summary ? { result: { summary } } : {}),
          },
        }),
      );
    }
    // `b` is dropped from the listing (unresolved), then its real outcome
    // corrects that: one settle, not two.
    projection.observe(
      event({
        method: 'child-work.updated',
        delta: { kind: 'snapshot', ...key, running: [] },
      }),
    );
    projection.observe(
      event({
        method: 'child-work.updated',
        delta: { kind: 'settle', ...key, childId: 'b', status: 'failed' },
      }),
    );
    // A settle for a child this process never saw running is not counted.
    projection.observe(
      event({
        method: 'child-work.updated',
        delta: { kind: 'settle', ...key, childId: 'c', status: 'completed' },
      }),
    );
    expect(settled).toEqual([
      ['a', 'completed', 'claude'],
      ['b', 'unresolved', 'claude'],
    ]);
  });
});

describe('session summary child work', () => {
  const persisted = (threadId: string) =>
    ({
      provider: 'claude',
      threadId,
      status: 'ready',
      createdAt: '2026-09-23T00:00:00.000Z',
      updatedAt: '2026-09-23T00:00:00.000Z',
    }) as never;

  test('reads the projection with its own thread and provider into childWork.children', () => {
    const summary = buildOrchestrationSessionSummary({
      persisted: persisted(THREAD),
      events: [],
      answerability: { answerable: false } as never,
      readChildWork: (threadId, provider) =>
        threadId === THREAD && provider === 'claude'
          ? { observability: 'not-reported', reason: 'r' }
          : undefined,
    });
    expect(summary.childWork).toEqual({
      children: { observability: 'not-reported', reason: 'r' },
    });
  });

  test('a delegated session carries itself as childWork.asChild; an ordinary one carries nothing', () => {
    const delegate = buildOrchestrationSessionSummary({
      persisted: persisted('del-1'),
      events: [
        {
          eventId: 'b',
          provider: 'claude',
          threadId: 'del-1',
          createdAt: '2026-09-23T00:00:01.000Z',
          method: 'session.started',
          sessionId: 'del-1',
          metadata: {
            taskId: 'del-1',
            parentTaskId: 'chat-1',
            // AgentDelegationContext, as the launch stamps it.
            delegation: { mode: 'isolated-child', depth: 2, maxDepth: 3 },
          },
        } as CanonicalRuntimeEvent,
        {
          eventId: 't',
          provider: 'claude',
          threadId: 'del-1',
          createdAt: '2026-09-23T00:00:02.000Z',
          method: 'turn.started',
          turnId: 'turn-1',
          prompt: 'go',
        } as CanonicalRuntimeEvent,
      ],
      answerability: { answerable: false } as never,
    });
    expect(delegate.childWork?.asChild).toMatchObject({
      producer: 'station-delegate',
      childId: 'del-1',
      status: 'running',
      parent: { taskId: 'chat-1' },
      depth: 2,
      result: { handle: { kind: 'session', threadId: 'del-1' } },
      controls: { stop: 'delegate-interrupt' },
    });

    const ordinary = buildOrchestrationSessionSummary({
      persisted: persisted(THREAD),
      events: [],
      answerability: { answerable: false } as never,
    });
    expect(ordinary).not.toHaveProperty('childWork');
  });
});
