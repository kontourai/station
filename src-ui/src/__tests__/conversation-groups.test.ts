import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { describe, expect, test } from 'vitest';
import { foldConversationTurns } from '../views/sessions/conversation-groups';
import type { ActivitySessionPresentation } from '../views/sessions/run-groups';

/**
 * #765 residue (A2-adjacent): the orchestration runtime opens one engine
 * session per continuation turn, so a multi-turn chat listed one Activity
 * row per turn. `foldConversationTurns` collapses sibling turn-sessions of
 * one conversation into the first member the caller ranked highest — purely
 * presentational, after run grouping, without touching the lane classifier.
 */

function summary(
  threadId: string,
  overrides: Partial<OrchestrationSessionSummary> = {},
): OrchestrationSessionSummary {
  const base: OrchestrationSessionSummary = {
    provider: 'claude',
    threadId,
    status: 'ready',
    controlMode: 'station-owned',
    answerability: { answerable: true },
    isLoaded: true,
    isPersisted: true,
    eventCount: 1,
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:01.000Z',
  };
  return { ...base, ...overrides };
}

function flat(
  session: OrchestrationSessionSummary,
): ActivitySessionPresentation {
  return { kind: 'session', session };
}

describe('foldConversationTurns', () => {
  test('folds sibling turn-sessions of one conversation into the first member and counts every member', () => {
    // Input order is the caller's lane-priority + recency order, so the
    // first member is the representative ("newest state wins").
    const newest = summary('conv-a:session:3', { conversationId: 'conv-a' });
    const middle = summary('conv-a:session:2', { conversationId: 'conv-a' });
    const root = summary('conv-a'); // the root's own thread id IS the identity
    const other = summary('thread-solo', { conversationId: 'conv-b' });

    const fold = foldConversationTurns([
      flat(newest),
      flat(other),
      flat(middle),
      flat(root),
    ]);

    expect(
      fold.presentations.map((p) =>
        p.kind === 'session' ? p.session.threadId : p,
      ),
    ).toEqual(['conv-a:session:3', 'thread-solo']);
    expect(fold.turnCounts.get('conv-a:session:3')).toBe(3);
    // A single-session conversation records no count at all — the row must
    // not grow a "1 turns" chip.
    expect(fold.turnCounts.has('thread-solo')).toBe(false);
  });

  test('never folds sessions that lack a shared conversation identity — absence is not corroboration', () => {
    const one = summary('thread-one');
    const two = summary('thread-two');

    const fold = foldConversationTurns([flat(one), flat(two)]);

    expect(fold.presentations).toHaveLength(2);
    expect(fold.turnCounts.size).toBe(0);
  });

  test('exempts delegated sessions and run groups — delegation folds as runs, never as turns', () => {
    const worker = summary('worker-thread', {
      conversationId: 'conv-a',
      delegation: {
        taskId: 'task:worker',
        mode: 'isolated-child',
      },
    });
    const chat = summary('conv-a:session:2', { conversationId: 'conv-a' });
    const runParent = summary('conv-a:session:1', { conversationId: 'conv-a' });
    const run: ActivitySessionPresentation = {
      kind: 'run',
      run: {
        id: 'run:conv-a:session:1',
        parent: runParent,
        members: [runParent, worker],
      },
    };

    const fold = foldConversationTurns([flat(chat), run, flat(worker)]);

    // The run passes through verbatim; the flat delegated worker and the run
    // members stay out of the conversation population, so the lone flat chat
    // session has no sibling to fold with.
    expect(fold.presentations).toHaveLength(3);
    expect(fold.turnCounts.size).toBe(0);
  });

  test('keeps every turn visible while one of them is selected', () => {
    const newest = summary('conv-a:session:2', { conversationId: 'conv-a' });
    const older = summary('conv-a:session:1', { conversationId: 'conv-a' });

    const fold = foldConversationTurns([flat(newest), flat(older)], {
      pinnedThreadId: 'conv-a:session:1',
    });

    expect(fold.presentations).toHaveLength(2);
    expect(fold.turnCounts.size).toBe(0);
  });
});
