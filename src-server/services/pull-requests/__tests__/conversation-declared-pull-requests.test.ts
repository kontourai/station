import { describe, expect, test } from 'vitest';
import { declaredPullRequestsForConversation } from '../conversation-declared-pull-requests.js';

const pr = (ref: string, owner = 'o') => ({
  provider: 'github',
  host: 'github.com',
  repository: { owner, name: 'r' },
  ref,
  keptAt: '2026-09-24T00:00:00Z',
});

describe('pull requests a conversation declared', () => {
  test('come from every Session in its lineage, once each', () => {
    const kept: Record<string, ReturnType<typeof pr>[]> = {
      'task-1|root': [pr('1')],
      'task-1|successor': [pr('2'), pr('1', 'O')],
      'task-2|handoff': [pr('3')],
      'task-2|unrelated': [pr('9')],
    };
    const links = declaredPullRequestsForConversation(
      {
        taskIds: () => ['task-1', 'task-2'],
        lineageSessionIds: (id) =>
          id === 'root' ? ['root', 'successor', 'handoff'] : [],
        keptForSession: (task, session) => kept[`${task}|${session}`] ?? [],
      },
      'root',
    );
    expect(links.map((link) => link.ref)).toEqual(['1', '2', '3']);
    expect(links[0]).toMatchObject({
      source: 'task-declared',
      linkedBy: 'station.task-graph',
    });
  });

  test('a conversation with no lineage asks its own id', () => {
    const links = declaredPullRequestsForConversation(
      {
        taskIds: () => ['task-1'],
        lineageSessionIds: () => [],
        keptForSession: (_task, session) =>
          session === 'legacy' ? [pr('5')] : [],
      },
      'legacy',
    );
    expect(links.map((link) => link.ref)).toEqual(['5']);
  });
});
