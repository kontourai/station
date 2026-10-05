import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { expect, test } from 'vitest';
import { settledChildWorkFromHistory } from '../child-work-history.js';

test('cold child-work history ignores a late settle after exit until a new session starts', () => {
  const threadId = 'thread-1';
  const at = '2026-09-24T00:00:00.000Z';
  const event = (
    eventId: string,
    method: string,
    extra: Record<string, unknown> = {},
  ) =>
    ({
      eventId,
      provider: 'claude',
      threadId,
      createdAt: at,
      method,
      ...extra,
    }) as CanonicalRuntimeEvent;
  const upsert = (childId: string) =>
    event(`upsert-${childId}`, 'child-work.updated', {
      delta: {
        kind: 'upsert',
        item: {
          producer: 'engine-subagent',
          reporterThreadId: threadId,
          childId,
          status: 'running',
          title: 'Explore',
        },
      },
    });
  const settle = (childId: string) =>
    event(`settle-${childId}`, 'child-work.updated', {
      delta: {
        kind: 'settle',
        producer: 'engine-subagent',
        reporterThreadId: threadId,
        childId,
        status: 'completed',
      },
    });
  const exited = event('exit', 'session.exited', { sessionId: threadId });
  const started = event('restart', 'session.started', { sessionId: threadId });

  expect(
    settledChildWorkFromHistory(threadId, [
      upsert('old'),
      exited,
      settle('old'),
    ]).settlements,
  ).toEqual([]);
  expect(
    settledChildWorkFromHistory(threadId, [
      upsert('old'),
      exited,
      settle('old'),
      started,
      upsert('new'),
      settle('new'),
    ]).settlements,
  ).toMatchObject([{ childId: 'new', status: 'completed' }]);
});

test('#3163: after a restart, the session view restores each settled subagent with its own model and transcript', async () => {
  const { replayClaudeTaskCapture, loadClaudeTaskCapture } = await import(
    '../../../providers/__tests__/claude-task-captures.js'
  );
  const { ChildWorkProjection } = await import('../child-work-projection.js');
  const outerCall = loadClaudeTaskCapture('nested-agent')
    .map((line) => line.message as { subtype?: string; tool_use_id?: string })
    .find((message) => message?.subtype === 'task_started')?.tool_use_id;
  // The capture, with only the outer agent's own replies on another model.
  const { events } = replayClaudeTaskCapture('nested-agent', {
    threadId: 'thread-claude',
    rewrite: (lines) =>
      lines.map((line) => {
        const message = line.message as
          | {
              type?: string;
              parent_tool_use_id?: string | null;
              message?: object;
            }
          | undefined;
        if (
          message?.type !== 'assistant' ||
          message.parent_tool_use_id !== outerCall
        )
          return line;
        return {
          message: {
            ...message,
            message: {
              ...message.message,
              model: 'claude-sonnet-4-5-20250929',
            },
          },
        } as typeof line;
      }),
  });
  // A fresh projection holds no adapter state: only the persisted facts.
  const restarted = new ChildWorkProjection();
  restarted.seedHistoricalSettled('thread-claude', events);
  const view = restarted.read('thread-claude', 'claude');
  if (view?.observability !== 'reported') throw new Error('no view');
  const outer = view.settled?.find((item) => item.depth === 1);
  expect(outer).toMatchObject({
    status: 'completed',
    model: { id: 'claude-sonnet-4-5-20250929', source: 'subagent-reply' },
    transcript: { kind: 'claude-subagent', agentId: outer?.childId },
  });
  // The nested agents replied on the session's model: theirs is reported as
  // that, from their own replies, and never as the outer agent's.
  for (const nested of view.settled?.filter((item) => item.depth === 2) ?? [])
    expect(nested.model).toEqual({
      id: 'claude-haiku-4-5-20251001',
      source: 'subagent-reply',
    });
});

test('#3308 a child settled without usage is seeded with its running figure marked provisional', () => {
  const threadId = 'thread-1';
  const base = {
    provider: 'claude',
    threadId,
    createdAt: '2026-09-24T00:00:00.000Z',
    method: 'child-work.updated',
  };
  const key = {
    producer: 'engine-subagent',
    reporterThreadId: threadId,
    childId: 'bg',
  };
  const { settlements } = settledChildWorkFromHistory(threadId, [
    {
      ...base,
      eventId: 'up',
      delta: {
        kind: 'upsert',
        item: { ...key, status: 'running', usage: { totalTokens: 40141 } },
      },
    },
    {
      ...base,
      eventId: 'settle',
      delta: { kind: 'settle', ...key, status: 'completed' },
    },
  ] as CanonicalRuntimeEvent[]);
  expect(settlements).toEqual([
    expect.objectContaining({
      ...key,
      status: 'completed',
      usage: { totalTokens: 40141 },
      usageProvisional: true,
    }),
  ]);
});
