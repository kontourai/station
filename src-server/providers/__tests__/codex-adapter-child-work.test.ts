/**
 * #2458: Codex subagents as child work, driven through
 * `CodexAdapterTransport`'s own stdout routing — the real captures where one
 * exists, and capture-shaped synthetic streams for the statuses no capture
 * produced.
 */
import {
  applyChildWorkDelta,
  CHILD_WORK_SUMMARY_MAX_CHARS,
  type ChildWorkDelta,
  type ChildWorkItem,
  childWorkForReporter,
  createEmptyChildWorkRegistry,
} from '@kontourai/station-contracts/child-work';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test } from 'vitest';
import {
  CODEX_CHILD_PENDING_BYTES_MAX,
  codexChildHeldStats,
} from '../adapters/codex-adapter-child-work.js';
import {
  CodexAdapterTransport,
  createCodexSessionRecord,
} from '../adapters/codex-adapter-transport.js';
import {
  CODEX_COLLAB_STATION_THREAD,
  CODEX_COLLAB_V1_CLIENT_TURN_INTERRUPT,
  CODEX_COLLAB_V1_MODEL_CLOSE_AGENT,
  CODEX_COLLAB_V1_SPAWN_WAIT_COMPLETED,
  CODEX_COLLAB_V2_CLIENT_TURN_INTERRUPT,
  CODEX_COLLAB_V2_MODEL_INTERRUPT_AGENT,
  CODEX_COLLAB_V2_SPAWN_REJECTED,
  CODEX_COLLAB_V2_SPAWN_WAIT_COMPLETED,
  codexCaptureIds,
  InertCodexProcess,
  replayCodexCapture,
} from './codex-collab-fixtures.js';

/** The one child every capture spawns (scrubbed id). */
const CHILD = '00000000-0000-7000-8000-000000000004';
const PARENT = '00000000-0000-7000-8000-000000000001';
const PARENT_TURN = '00000000-0000-7000-8000-000000000002';

function deltasOf(events: CanonicalRuntimeEvent[]): ChildWorkDelta[] {
  return events.flatMap((event) =>
    event.method === 'child-work.updated' ? [event.delta] : [],
  );
}

function fold(
  events: CanonicalRuntimeEvent[],
  reporter = CODEX_COLLAB_STATION_THREAD,
): ChildWorkItem[] {
  let state = createEmptyChildWorkRegistry();
  for (const delta of deltasOf(events)) {
    state = applyChildWorkDelta(state, delta);
  }
  return childWorkForReporter(state, reporter);
}

function child(
  events: CanonicalRuntimeEvent[],
  id = CHILD,
  reporter = CODEX_COLLAB_STATION_THREAD,
): ChildWorkItem {
  const found = fold(events, reporter).find((item) => item.childId === id);
  if (!found) throw new Error(`no child ${id}`);
  return found;
}

type Msg = { method: string; params: Record<string, unknown> };

/** A capture-shaped stream: the parent's thread/turn responses, then `msgs`. */
function synthetic(msgs: Msg[]): string[] {
  return [
    {
      dir: 'server->client',
      msg: { id: 2, result: { thread: { id: PARENT } } },
    },
    {
      dir: 'server->client',
      msg: { id: 3, result: { turn: { id: PARENT_TURN } } },
    },
    ...msgs.map((msg) => ({ dir: 'server->client', msg })),
  ].map((line) => JSON.stringify(line));
}

const parentItem = (
  phase: 'started' | 'completed',
  item: Record<string, unknown>,
): Msg => ({
  method: `item/${phase}`,
  params: { threadId: PARENT, turnId: PARENT_TURN, item },
});

const collab = (
  tool: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: 'collabAgentToolCall',
  id: `call-${tool}`,
  tool,
  status: 'completed',
  senderThreadId: PARENT,
  receiverThreadIds: [CHILD],
  prompt: null,
  model: null,
  reasoningEffort: null,
  agentsStates: {},
  ...fields,
});

const spawn = (): Msg =>
  parentItem(
    'completed',
    collab('spawnAgent', {
      prompt: 'Do the thing',
      model: 'gpt-5.5',
      agentsStates: { [CHILD]: { status: 'pendingInit', message: null } },
    }),
  );

const wait = (status: string, message: string | null = null): Msg =>
  parentItem(
    'completed',
    collab('wait', { agentsStates: { [CHILD]: { status, message } } }),
  );

const childTurnCompleted = (turn: Record<string, unknown>): Msg => ({
  method: 'turn/completed',
  params: {
    threadId: CHILD,
    turn: { id: 'child-turn', items: [], ...turn },
  },
});

const childUsage = (totalTokens: number): Msg => ({
  method: 'thread/tokenUsage/updated',
  params: {
    threadId: CHILD,
    turnId: 'child-turn',
    tokenUsage: { total: { totalTokens, inputTokens: 1, outputTokens: 1 } },
  },
});

/** Whether any delta AFTER the child's first settle lists it as running. */
function relistedAfterSettle(events: CanonicalRuntimeEvent[]): boolean {
  let settled = false;
  for (const delta of deltasOf(events)) {
    if (delta.kind === 'settle' && delta.childId === CHILD) settled = true;
    if (!settled) continue;
    if (
      delta.kind === 'snapshot' &&
      delta.running.some((item) => item.childId === CHILD)
    ) {
      return true;
    }
    if (delta.kind === 'upsert' && delta.item.childId === CHILD) return true;
  }
  return false;
}

describe('#2458 Codex subagents as child work — real captures', () => {
  test('v1 (collabAgentToolCall): spawn, wait, completed — identity, usage and result from the wire', () => {
    const { events } = replayCodexCapture(CODEX_COLLAB_V1_SPAWN_WAIT_COMPLETED);
    const item = child(events);
    expect(item).toMatchObject({
      producer: 'engine-subagent',
      reporterThreadId: CODEX_COLLAB_STATION_THREAD,
      status: 'completed',
      depth: 1,
      kindLabel: 'gpt-5.5',
      parent: { turnId: PARENT_TURN, toolCallId: 'call_0001' },
      // The child thread's own last `thread/tokenUsage/updated` total and
      // its `turn/completed.turn.durationMs`.
      usage: { totalTokens: 36688, durationMs: 5726 },
      result: { summary: 'done' },
    });
    expect(item.title).toMatch(/^In the current working directory, create/);
    // Nothing can open a Codex child thread, so no handle is invented.
    expect(item.result?.handle).toBeUndefined();
    expect(item.usage?.toolUses).toBeUndefined();
    expect(item.controls).toBeUndefined();
  });

  test('v2 (subAgentActivity): spawn, wait, completed — depth and title from agentPath', () => {
    const { events } = replayCodexCapture(CODEX_COLLAB_V2_SPAWN_WAIT_COMPLETED);
    expect(child(events)).toMatchObject({
      status: 'completed',
      depth: 1,
      title: 'create_hello',
      parent: { turnId: PARENT_TURN, toolCallId: 'call_0001' },
      usage: { totalTokens: 42764 },
      result: { summary: 'done' },
    });
    expect(child(events).usage?.durationMs).toBeGreaterThan(0);
  });

  for (const [label, capture] of [
    ['v1', CODEX_COLLAB_V1_SPAWN_WAIT_COMPLETED],
    ['v2', CODEX_COLLAB_V2_SPAWN_WAIT_COMPLETED],
  ] as const) {
    test(`${label}: the child's stream never produces a parent turn, tool, text or usage event`, () => {
      const { events } = replayCodexCapture(capture);
      const nonChildWork = events.filter(
        (event) => event.method !== 'child-work.updated',
      );
      // Every turn-scoped event is the parent's turn.
      for (const event of nonChildWork) {
        if (event.turnId !== undefined) expect(event.turnId).toBe(PARENT_TURN);
      }
      expect(
        nonChildWork.filter((event) => event.method === 'turn.completed'),
      ).toHaveLength(1);
      // Parent usage is exactly the parent thread's own figures.
      const parentTotals = capture.flatMap((line) => {
        const { msg } = JSON.parse(line) as {
          msg: {
            method?: string;
            params?: {
              threadId?: string;
              tokenUsage?: { total?: { totalTokens?: number } };
            };
          };
        };
        return msg.method === 'thread/tokenUsage/updated' &&
          msg.params?.threadId === PARENT
          ? [msg.params.tokenUsage?.total?.totalTokens]
          : [];
      });
      expect(
        nonChildWork.flatMap((event) =>
          event.method === 'token-usage.updated' ? [event.totalTokens] : [],
        ),
      ).toEqual(parentTotals);
      // The child ran a tool and wrote text; neither reached the parent.
      expect(
        nonChildWork.filter((event) => event.method === 'tool.started'),
      ).toEqual([]);
      const childItemIds = new Set(
        capture.flatMap((line) => {
          const { msg } = JSON.parse(line);
          const params = msg.params ?? {};
          if (params.threadId !== CHILD) return [];
          return [params.item?.id, params.itemId].filter(
            (id): id is string => typeof id === 'string',
          );
        }),
      );
      // The premise: the child really did stream items of its own.
      expect(childItemIds.size).toBeGreaterThan(0);
      expect(
        nonChildWork.filter(
          (event) =>
            event.itemId !== undefined && childItemIds.has(event.itemId),
        ),
      ).toEqual([]);
    });
  }

  test("the child's turn/completed leaves the parent's active turn alone", () => {
    const capture = CODEX_COLLAB_V1_SPAWN_WAIT_COMPLETED;
    const childDone = capture.findIndex((line) => {
      const { msg } = JSON.parse(line);
      return msg.method === 'turn/completed' && msg.params.threadId === CHILD;
    });
    expect(childDone).toBeGreaterThan(0);
    const { record, events } = replayCodexCapture(capture, {
      limit: childDone + 1,
    });
    expect(child(events).status).toBe('completed');
    expect(record.activeTurnId).toBe(PARENT_TURN);
    expect(record.terminalPublishedForTurnId).toBeUndefined();
    expect(events.some((event) => event.method === 'turn.completed')).toBe(
      false,
    );
  });

  test('a client turn/interrupt of the child is cancelled, from the child turn itself (v1 and v2)', () => {
    for (const capture of [
      CODEX_COLLAB_V1_CLIENT_TURN_INTERRUPT,
      CODEX_COLLAB_V2_CLIENT_TURN_INTERRUPT,
    ]) {
      const { events } = replayCodexCapture(capture);
      expect(child(events).status).toBe('cancelled');
      expect(child(events).usage?.durationMs).toBeGreaterThan(0);
    }
  });

  test('a model interruptAgent (v2 activity `interrupted`) is a stop request the child turn confirms as cancelled', () => {
    const capture = CODEX_COLLAB_V2_MODEL_INTERRUPT_AGENT;
    const childDone = capture.findIndex((line) => {
      const { msg } = JSON.parse(line);
      return msg.method === 'turn/completed' && msg.params.threadId === CHILD;
    });
    // Before the child's own turn says so, only the request is known.
    expect(
      child(replayCodexCapture(capture, { limit: childDone }).events).status,
    ).toBe('stopped-unconfirmed');
    expect(child(replayCodexCapture(capture).events).status).toBe('cancelled');
  });

  test('closeAgent echoing the previous status `running` is not read: the child stays cancelled and is never re-listed', () => {
    const { events } = replayCodexCapture(CODEX_COLLAB_V1_MODEL_CLOSE_AGENT);
    expect(child(events).status).toBe('cancelled');
    expect(relistedAfterSettle(events)).toBe(false);
  });

  test('a rejected spawn has no subagent on the wire, and so no child work', () => {
    const { events } = replayCodexCapture(CODEX_COLLAB_V2_SPAWN_REJECTED);
    expect(deltasOf(events)).toEqual([]);
  });

  test('session end with the child still open settles it unresolved, before session.exited', async () => {
    const capture = CODEX_COLLAB_V1_CLIENT_TURN_INTERRUPT;
    const childDone = capture.findIndex((line) => {
      const { msg } = JSON.parse(line);
      return msg.method === 'turn/completed' && msg.params.threadId === CHILD;
    });
    const replay = replayCodexCapture(capture, { limit: childDone });
    expect(child(replay.events).status).toBe('running');
    await replay.stop();
    expect(child(replay.events).status).toBe('unresolved');
    const settleAt = replay.events.findIndex(
      (event) =>
        event.method === 'child-work.updated' && event.delta.kind === 'settle',
    );
    const exitedAt = replay.events.findIndex(
      (event) => event.method === 'session.exited',
    );
    expect(settleAt).toBeGreaterThanOrEqual(0);
    expect(settleAt).toBeLessThan(exitedAt);
  });

  test('child notifications that arrive before the linking item are held and applied once it claims the thread', () => {
    // Move the child's entire stream ahead of the parent item naming it.
    const capture = CODEX_COLLAB_V2_SPAWN_WAIT_COMPLETED;
    const isChild = (line: string) =>
      JSON.parse(line).msg.params?.threadId === CHILD;
    const firstParentLink = capture.findIndex((line) =>
      line.includes('"subAgentActivity"'),
    );
    const reordered = [
      ...capture.slice(0, firstParentLink).filter((line) => !isChild(line)),
      ...capture.filter(isChild),
      ...capture.slice(firstParentLink).filter((line) => !isChild(line)),
    ];
    // Ensure the premise: the child's turn/completed now precedes the link.
    const childDone = reordered.findIndex(
      (line) => isChild(line) && line.includes('"turn/completed"'),
    );
    expect(childDone).toBeLessThan(
      reordered.findIndex((line) => line.includes('"subAgentActivity"')),
    );
    const { events } = replayCodexCapture(reordered);
    expect(child(events)).toMatchObject({
      status: 'completed',
      usage: { totalTokens: 42764 },
      result: { summary: 'done' },
    });
    expect(codexCaptureIds(reordered).parentThreadId).toBe(PARENT);
  });
});

describe('#2458 Codex agent status mapping (capture-shaped streams)', () => {
  const statusCases: Array<[string, string | null, ChildWorkItem['status']]> = [
    ['completed', 'all good', 'completed'],
    ['errored', 'boom', 'failed'],
    ['interrupted', null, 'cancelled'],
    ['shutdown', null, 'cancelled'],
    ['notFound', null, 'unresolved'],
    ['someStatusThisBuildDoesNotKnow', null, 'unresolved'],
    ['running', null, 'running'],
    ['pendingInit', null, 'running'],
  ];
  for (const [status, message, expected] of statusCases) {
    test(`a wait result naming the child \`${status}\` reads as ${expected}`, () => {
      const { events } = replayCodexCapture(
        synthetic([spawn(), wait(status, message)]),
      );
      const item = child(events);
      expect(item.status).toBe(expected);
      if (message) expect(item.result?.summary).toBe(message);
    });
  }

  test('shutdown after an observed outcome keeps the outcome', () => {
    const { events } = replayCodexCapture(
      synthetic([spawn(), wait('completed', 'ok'), wait('shutdown')]),
    );
    expect(child(events)).toMatchObject({
      status: 'completed',
      result: { summary: 'ok' },
    });
  });

  const turnCases: Array<[Record<string, unknown>, ChildWorkItem['status']]> = [
    [
      {
        status: 'completed',
        items: [{ type: 'agentMessage', text: 'final', phase: 'final_answer' }],
      },
      'completed',
    ],
    [{ status: 'failed', error: { message: 'usage limit' } }, 'failed'],
    [{ status: 'interrupted' }, 'cancelled'],
    [{ status: 'somethingNew' }, 'unresolved'],
  ];
  for (const [turn, expected] of turnCases) {
    test(`the child's own turn/completed status \`${String(turn.status)}\` reads as ${expected}`, () => {
      const { events } = replayCodexCapture(
        synthetic([
          spawn(),
          childUsage(123),
          childTurnCompleted({ ...turn, durationMs: 42 }),
        ]),
      );
      const item = child(events);
      expect(item.status).toBe(expected);
      expect(item.usage).toEqual({ totalTokens: 123, durationMs: 42 });
      if (expected === 'completed') expect(item.result?.summary).toBe('final');
      if (expected === 'failed') {
        expect(item.result?.summary).toBe('usage limit');
      }
    });
  }

  for (const echo of ['running', 'completed', 'errored']) {
    test(`closeAgent / interruptAgent echoing \`${echo}\` for a running child is a stop request, never its status`, () => {
      for (const tool of ['closeAgent', 'interruptAgent']) {
        const { events } = replayCodexCapture(
          synthetic([
            spawn(),
            parentItem(
              'completed',
              collab(tool, {
                agentsStates: { [CHILD]: { status: echo, message: 'echo' } },
              }),
            ),
          ]),
        );
        const item = child(events);
        expect(item.status).toBe('stopped-unconfirmed');
        expect(item.result).toBeUndefined();
        // The child's own turn then decides.
        const confirmed = replayCodexCapture(
          synthetic([
            spawn(),
            parentItem(
              'completed',
              collab(tool, {
                agentsStates: { [CHILD]: { status: echo, message: 'echo' } },
              }),
            ),
            childTurnCompleted({ status: 'interrupted' }),
          ]),
        );
        expect(child(confirmed.events).status).toBe('cancelled');
      }
    });
  }

  test('a failed closeAgent call requests nothing', () => {
    const { events } = replayCodexCapture(
      synthetic([
        spawn(),
        parentItem('completed', collab('closeAgent', { status: 'failed' })),
      ]),
    );
    expect(child(events).status).toBe('running');
  });

  test('thread/closed: after a stop request it confirms cancelled; with no outcome it is unresolved', () => {
    const closed: Msg = {
      method: 'thread/closed',
      params: { threadId: CHILD },
    };
    expect(
      child(
        replayCodexCapture(
          synthetic([
            spawn(),
            parentItem('completed', collab('closeAgent')),
            closed,
          ]),
        ).events,
      ).status,
    ).toBe('cancelled');
    expect(
      child(replayCodexCapture(synthetic([spawn(), closed])).events).status,
    ).toBe('unresolved');
  });

  test('child usage is upserted while running and never reported as the parent’s', () => {
    const { events } = replayCodexCapture(
      synthetic([spawn(), childUsage(10), childUsage(25)]),
    );
    expect(child(events)).toMatchObject({
      status: 'running',
      usage: { totalTokens: 25 },
    });
    expect(events.some((event) => event.method === 'token-usage.updated')).toBe(
      false,
    );
  });

  test('nesting: a v2 agentPath one level down, and a v1 spawn on a child stream, are depth 2', () => {
    const GRANDCHILD = 'grandchild-thread';
    const v2 = replayCodexCapture(
      synthetic([
        parentItem('completed', {
          type: 'subAgentActivity',
          id: 'a1',
          kind: 'started',
          agentThreadId: GRANDCHILD,
          agentPath: '/root/outer/inner',
        }),
      ]),
    );
    expect(child(v2.events, GRANDCHILD)).toMatchObject({
      depth: 2,
      title: 'inner',
    });
    const v1 = replayCodexCapture(
      synthetic([
        spawn(),
        {
          method: 'item/completed',
          params: {
            threadId: CHILD,
            turnId: 'child-turn',
            item: collab('spawnAgent', {
              id: 'nested-call',
              senderThreadId: CHILD,
              receiverThreadIds: [GRANDCHILD],
              agentsStates: {
                [GRANDCHILD]: { status: 'pendingInit', message: null },
              },
            }),
          },
        },
      ]),
    );
    expect(child(v1.events, GRANDCHILD)).toMatchObject({
      status: 'running',
      depth: 2,
      parent: { taskId: CHILD, toolCallId: 'nested-call' },
    });
    expect(child(v1.events).depth).toBe(1);
  });

  test('thread/started with a subAgent thread_spawn source registers the child', () => {
    const { events } = replayCodexCapture(
      synthetic([
        {
          method: 'thread/started',
          params: {
            thread: {
              id: CHILD,
              source: {
                subAgent: {
                  thread_spawn: {
                    parent_thread_id: PARENT,
                    depth: 1,
                    agent_path: '/root/worker',
                    agent_nickname: 'Euler',
                    agent_role: 'explorer',
                  },
                },
              },
            },
          },
        },
        childTurnCompleted({ status: 'completed' }),
      ]),
    );
    expect(child(events)).toMatchObject({
      status: 'completed',
      depth: 1,
      title: 'Euler',
      kindLabel: 'explorer',
    });
  });

  test('past the hold bound a late claim still gets the newest facts, including the outcome', () => {
    const early = Array.from({ length: 40 }, (_, index) =>
      childUsage(index + 1),
    );
    const { events } = replayCodexCapture(
      synthetic([
        ...early,
        childTurnCompleted({
          status: 'completed',
          items: [
            { type: 'agentMessage', text: 'late', phase: 'final_answer' },
          ],
        }),
        spawn(),
      ]),
    );
    expect(child(events)).toMatchObject({
      status: 'completed',
      usage: { totalTokens: 40 },
      result: { summary: 'late' },
    });
  });

  test('notifications for a thread nobody ever claims produce nothing', () => {
    const { events } = replayCodexCapture(
      synthetic([
        {
          method: 'turn/completed',
          params: {
            threadId: 'stranger',
            turn: { id: 't', status: 'completed' },
          },
        },
        {
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: 'stranger',
            tokenUsage: { total: { totalTokens: 9 } },
          },
        },
      ]),
    );
    expect(events).toEqual([]);
  });
});

describe('#2458 fix round: routing and bounds', () => {
  test('R1: a thread id another session owns, streamed by THIS process as its child, never reaches that session', () => {
    const transport = new CodexAdapterTransport(
      () => new Date('2026-09-23T00:00:00.000Z'),
      async () => {},
    );
    const events: CanonicalRuntimeEvent[] = [];
    transport.publish = (event) => {
      events.push(event);
    };
    const session = (externalThreadId: string, codexThreadId: string) => {
      const record = createCodexSessionRecord({
        externalThreadId,
        process: new InertCodexProcess(),
        provider: 'codex',
        threadId: externalThreadId,
        model: 'gpt-5.5',
        nowIso: () => '2026-09-23T00:00:00.000Z',
      });
      transport.registerSession(record);
      transport.setCodexThreadId(record, codexThreadId);
      record.activeTurnId = `${externalThreadId}-turn`;
      return record;
    };
    const a = session('thread-a', 'codex-a');
    // Session B's own codex thread id is the id A's process reports as its
    // child: the collision.
    const b = session('thread-b', CHILD);
    const line = (msg: Msg) => JSON.stringify(msg);
    transport.handleStdoutLine(
      a,
      line({
        method: 'item/completed',
        params: {
          threadId: 'codex-a',
          turnId: 'thread-a-turn',
          item: collab('spawnAgent', {
            senderThreadId: 'codex-a',
            agentsStates: { [CHILD]: { status: 'pendingInit', message: null } },
          }),
        },
      }),
    );
    transport.handleStdoutLine(a, line(childUsage(77)));
    transport.handleStdoutLine(
      a,
      line(childTurnCompleted({ status: 'completed', durationMs: 5 })),
    );
    // Nothing reached B: no event on its thread, its turn still open.
    expect(events.filter((event) => event.threadId === 'thread-b')).toEqual([]);
    expect(b.activeTurnId).toBe('thread-b-turn');
    expect(b.terminalPublishedForTurnId).toBeUndefined();
    // It was A's child all along.
    expect(child(events, CHILD, 'thread-a')).toMatchObject({
      status: 'completed',
      usage: { totalTokens: 77, durationMs: 5 },
    });
    // B's OWN process still owns B's thread.
    transport.handleStdoutLine(
      b,
      line({
        method: 'turn/completed',
        params: {
          threadId: CHILD,
          turn: { id: 'thread-b-turn', status: 'completed' },
        },
      }),
    );
    expect(
      events.filter(
        (event) =>
          event.threadId === 'thread-b' && event.method === 'turn.completed',
      ),
    ).toHaveLength(1);
  });

  test('R2: a child keeps facts only while its outcome can still change; session end clears everything', async () => {
    const capture = CODEX_COLLAB_V1_SPAWN_WAIT_COMPLETED;
    const childDone = capture.findIndex((line) => {
      const { msg } = JSON.parse(line);
      return msg.method === 'turn/completed' && msg.params.threadId === CHILD;
    });
    const running = replayCodexCapture(capture, { limit: childDone });
    expect(codexChildHeldStats(running.record).facts).toBe(1);
    const settled = replayCodexCapture(capture);
    expect(child(settled.events).status).toBe('completed');
    expect(codexChildHeldStats(settled.record).facts).toBe(0);
    // A correctable terminal keeps its facts (a later outcome may correct it).
    const stopped = replayCodexCapture(
      synthetic([spawn(), parentItem('completed', collab('closeAgent'))]),
    );
    expect(child(stopped.events).status).toBe('stopped-unconfirmed');
    expect(codexChildHeldStats(stopped.record).facts).toBe(1);
    await running.stop();
    expect(codexChildHeldStats(running.record)).toEqual({
      threads: 0,
      notifications: 0,
      bytes: 0,
      facts: 0,
    });
  });

  test('R2: the fallback summary is capped at the contract bound and flagged truncated', () => {
    const long = 'x'.repeat(CHILD_WORK_SUMMARY_MAX_CHARS * 3);
    const { events } = replayCodexCapture(
      synthetic([
        spawn(),
        {
          method: 'item/completed',
          params: {
            threadId: CHILD,
            turnId: 'child-turn',
            item: { type: 'agentMessage', id: 'm', text: long },
          },
        },
        childTurnCompleted({ status: 'completed' }),
      ]),
    );
    const settle = deltasOf(events).find((delta) => delta.kind === 'settle');
    expect(
      settle?.kind === 'settle' ? settle.result?.summary?.length : 0,
    ).toBeLessThanOrEqual(CHILD_WORK_SUMMARY_MAX_CHARS + 1);
    expect(child(events).result).toMatchObject({ summaryTruncated: true });
    expect(child(events).result?.summary).toHaveLength(
      CHILD_WORK_SUMMARY_MAX_CHARS,
    );
  });

  test('R2: held payloads are bounded in bytes, oldest first; an oversized one is never held', () => {
    const big = (threadId: string, size: number, totalTokens: number): Msg => ({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId,
        padding: 'p'.repeat(size),
        tokenUsage: { total: { totalTokens } },
      },
    });
    const register = (threadId: string): Msg =>
      parentItem('completed', {
        type: 'subAgentActivity',
        id: `a-${threadId}`,
        kind: 'started',
        agentThreadId: threadId,
        agentPath: `/root/${threadId}`,
      });
    const share = Math.floor(CODEX_CHILD_PENDING_BYTES_MAX * 0.6);
    const heldOnly = replayCodexCapture(
      synthetic([
        big('first', share, 1),
        big('second', share, 2),
        big('huge', CODEX_CHILD_PENDING_BYTES_MAX + 1, 3),
      ]),
    );
    const stats = codexChildHeldStats(heldOnly.record);
    expect(stats.bytes).toBeLessThanOrEqual(CODEX_CHILD_PENDING_BYTES_MAX);
    expect(stats).toMatchObject({ threads: 1, notifications: 1 });
    const claimed = replayCodexCapture(
      synthetic([
        big('first', share, 1),
        big('second', share, 2),
        big('huge', CODEX_CHILD_PENDING_BYTES_MAX + 1, 3),
        register('first'),
        register('second'),
        register('huge'),
      ]),
    );
    // The oldest was dropped to make room, the oversized one never held.
    expect(child(claimed.events, 'first').usage).toBeUndefined();
    expect(child(claimed.events, 'second').usage).toEqual({ totalTokens: 2 });
    expect(child(claimed.events, 'huge').usage).toBeUndefined();
    expect(codexChildHeldStats(claimed.record).bytes).toBe(0);
  });
});
