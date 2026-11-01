// @vitest-environment jsdom
import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { render, screen, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  sessions: [] as OrchestrationSessionSummary[],
}));
vi.mock('@kontourai/station-sdk', async (original) => ({
  ...(await original<typeof import('@kontourai/station-sdk')>()),
  useTasksQuery: () => ({ data: [], isLoading: false, isError: false }),
  useBoardAttentionQuery: () => ({
    data: { items: [], pendingCount: 0 },
    isLoading: false,
    isError: false,
  }),
  useBoardRecentWorkQuery: () => ({
    data: state.sessions,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'station-a',
    isCurrent: () => true,
  }),
}));
vi.mock('../../../contexts/ProjectsContext', () => ({
  useScopedProjectsQuery: () => ({ data: [], isLoading: false }),
}));
vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

import { PersonalBoardSectionContent } from '../PersonalBoardSections';

function summary(
  threadId: string,
  updatedAt: string,
  overrides: Partial<OrchestrationSessionSummary> = {},
): OrchestrationSessionSummary {
  return {
    provider: 'codex',
    threadId,
    status: 'ready',
    controlMode: 'station-owned',
    answerability: { answerable: true },
    isLoaded: true,
    isPersisted: true,
    eventCount: 1,
    createdAt: '2026-10-31T10:00:00.000Z',
    updatedAt,
    displayTitle: 'Say hi in 5 words',
    ...overrides,
  };
}

test('#4386: a conversation whose engine session was continued is one Recent work row, linked to its newest session', () => {
  state.sessions = [
    // The root's own thread id IS the conversation identity.
    summary('codex:abc', '2026-10-31T10:01:00.000Z'),
    summary('codex:abc:session:1111', '2026-10-31T10:05:00.000Z', {
      conversationId: 'codex:abc',
    }),
    summary('codex:other', '2026-10-31T10:03:00.000Z', {
      displayTitle: 'Another chat',
    }),
  ];

  render(
    <PersonalBoardSectionContent
      section={{
        id: 's1',
        kind: 'recent-work',
        title: 'Recent work',
        width: 'half',
        limit: 8,
      }}
    />,
  );

  const links = within(screen.getByRole('list')).getAllByRole('link');
  expect(links.map((link) => link.textContent)).toEqual([
    'Say hi in 5 words',
    'Another chat',
  ]);
  expect(links[0].getAttribute('href')).toBe(
    `/?surface=activity&session=${encodeURIComponent('codex:abc:session:1111')}`,
  );
});
