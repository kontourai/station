import { describe, expect, test, vi } from 'vitest';
import { declaredPullRequestsForConversation } from '../conversation-declared-pull-requests.js';

const pr = (ref: string, session: string, owner = 'o') => ({
  provider: 'github',
  host: 'github.com',
  repository: { owner, name: 'r' },
  ref,
  keptAt: '2026-09-24T00:00:00Z',
  session,
});

describe('pull requests a conversation declared', () => {
  test('come from every Session in its lineage, once each, in one read', () => {
    const kept = [
      pr('1', 'root'),
      pr('2', 'successor'),
      pr('1', 'successor', 'O'),
      pr('3', 'handoff'),
      pr('9', 'unrelated'),
    ];
    const keptForSessions = vi.fn((ids: readonly string[]) =>
      kept.filter((keep) => ids.includes(keep.session)),
    );
    const links = declaredPullRequestsForConversation(
      {
        lineageSessionIds: (id) =>
          id === 'root' ? ['root', 'successor', 'handoff'] : [],
        keptForSessions,
      },
      'root',
    );
    expect(links.map((link) => link.ref)).toEqual(['1', '2', '3']);
    expect(links[0]).toMatchObject({
      source: 'task-declared',
      linkedBy: 'station.task-graph',
    });
    expect(keptForSessions).toHaveBeenCalledTimes(1);
  });

  test('a conversation with no lineage asks its own id', () => {
    const links = declaredPullRequestsForConversation(
      {
        lineageSessionIds: () => [],
        keptForSessions: (ids) =>
          ids.includes('legacy') ? [pr('5', 'legacy')] : [],
      },
      'legacy',
    );
    expect(links.map((link) => link.ref)).toEqual(['5']);
  });
});
