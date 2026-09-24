import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test } from 'vitest';
import {
  type ClaudeMessageState,
  mapClaudeSdkMessage,
} from '../../../providers/adapters/claude-adapter-events.js';
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
  test('nothing observed reads as absent — neither reported-empty nor not-reported', () => {
    expect(new ChildWorkProjection().read(THREAD)).toBeUndefined();
  });

  test("folds the Claude adapter's legacy task tuples through the contract translator", () => {
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
    const live = projection.read(THREAD);
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
    expect(projection.read(THREAD)).toMatchObject({
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
    expect(projection.read(THREAD)).toBeUndefined();
  });

  test('a session on an engine whose matrix cell is none is not-reported; claude and matrix-less providers make no such claim', () => {
    const projection = new ChildWorkProjection();
    projection.observe(
      event({ method: 'session.started' }, 'thread-muse', 'muse'),
    );
    projection.observe(
      event({ method: 'session.started' }, 'thread-claude', 'claude'),
    );
    projection.observe(
      event({ method: 'session.started' }, 'thread-bedrock', 'bedrock'),
    );
    expect(projection.read('thread-muse')).toEqual({
      observability: 'not-reported',
      reason: 'The engine reports no subagent identity.',
    });
    expect(projection.read('thread-claude')).toBeUndefined();
    expect(projection.read('thread-bedrock')).toBeUndefined();
  });

  test('session.exited forgets the thread', () => {
    const projection = new ChildWorkProjection();
    projection.observe(legacy('task/registry', { active: [{ taskId: 'a' }] }));
    projection.observe(event({ method: 'session.exited' }));
    expect(projection.read(THREAD)).toBeUndefined();
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
    expect(projection.read(THREAD)).toBeUndefined();
    expect(projection.read('other')).toBeUndefined();
  });

  test('the real captured Claude run: the backgrounded task reads as running mid-run and nothing is left running at the end', () => {
    const projection = new ChildWorkProjection();
    const record: ClaudeMessageState = {
      session: {
        provider: 'claude',
        threadId: THREAD,
        status: 'running',
        createdAt: '2026-09-23T00:00:00.000Z',
        updatedAt: '2026-09-23T00:00:00.000Z',
      },
      activeTurnId: 'turn-1',
      dispatchedTurnId: 'turn-1',
      lastSessionState: 'running',
    };
    const lines = readFileSync(
      resolve(
        process.cwd(),
        'src-server/providers/__tests__/fixtures/claude-task-subagents.jsonl',
      ),
      'utf8',
    )
      .split('\n')
      .filter(Boolean);
    let sawBackgroundRunning = false;
    for (const line of lines) {
      mapClaudeSdkMessage({
        provider: 'claude',
        record,
        message: JSON.parse(line) as SDKMessage,
        publish: (published) => projection.observe(published),
      });
      const view = projection.read(THREAD);
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
    expect(projection.read(THREAD)).toMatchObject({
      observability: 'reported',
      running: [],
    });
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

  test('carries the projection read as childWork.children', () => {
    const summary = buildOrchestrationSessionSummary({
      persisted: persisted(THREAD),
      events: [],
      answerability: { answerable: false } as never,
      childWork: {
        observability: 'not-reported',
        reason: 'r',
      },
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
          metadata: { taskId: 'del-1', parentTaskId: 'chat-1' },
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
