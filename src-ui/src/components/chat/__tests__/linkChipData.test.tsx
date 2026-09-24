/** @vitest-environment jsdom */

/**
 * The two network-backed facts a link chip shows: whether a mentioned file
 * exists (batched into one request per project per tick) and the state of a
 * pull request the conversation has linked (only ever from an observation).
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const listExistingProjectWorkspaceFiles = vi.fn();
const getConversationPullRequestLinks = vi.fn();
const scope = {
  apiBase: 'http://station.test',
  authorityKey: 'authority-1',
  isCurrent: () => true,
};

vi.mock('@kontourai/station-sdk/workspace-file-preview', () => ({
  WORKSPACE_FILE_EXISTENCE_MAX_PATHS: 3,
  listExistingProjectWorkspaceFiles: (...args: unknown[]) =>
    listExistingProjectWorkspaceFiles(...args),
}));
vi.mock('@kontourai/station-sdk/conversation-pull-request-links', () => ({
  getConversationPullRequestLinks: (...args: unknown[]) =>
    getConversationPullRequestLinks(...args),
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => scope,
}));

import { PullRequestLinkState } from '../ChatLinkChip';
import { workspaceFileExistenceBatcher } from '../useWorkspaceFileExists';

beforeEach(() => {
  listExistingProjectWorkspaceFiles.mockImplementation(
    async (_api: string, _slug: string, paths: string[]) => ({
      files: paths.filter((path) => path.startsWith('real/')),
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the existence batcher', () => {
  test('mentions asked in one tick share a request, chunked at the cap', async () => {
    const paths = ['real/a.ts', 'fake/b.ts', 'real/c.ts', 'real/d.ts'];
    const answers = await Promise.all([
      ...paths.map((path) =>
        workspaceFileExistenceBatcher.exists(scope, 'alpha', path),
      ),
      // The same path twice resolves both askers from one entry.
      workspaceFileExistenceBatcher.exists(scope, 'alpha', 'real/a.ts'),
    ]);
    expect(answers).toEqual([true, false, true, true, true]);
    // Four distinct paths at a cap of three: two requests, not five.
    expect(listExistingProjectWorkspaceFiles).toHaveBeenCalledTimes(2);
    expect(listExistingProjectWorkspaceFiles.mock.calls[0]?.[2]).toEqual([
      'real/a.ts',
      'fake/b.ts',
      'real/c.ts',
    ]);
  });

  test('projects never share a request', async () => {
    await Promise.all([
      workspaceFileExistenceBatcher.exists(scope, 'alpha', 'real/a.ts'),
      workspaceFileExistenceBatcher.exists(scope, 'beta', 'real/a.ts'),
    ]);
    expect(
      listExistingProjectWorkspaceFiles.mock.calls.map((call) => call[1]),
    ).toEqual(['alpha', 'beta']);
  });

  test('a failed check rejects every asker rather than answering "missing"', async () => {
    listExistingProjectWorkspaceFiles.mockRejectedValueOnce(new Error('down'));
    const results = await Promise.allSettled([
      workspaceFileExistenceBatcher.exists(scope, 'alpha', 'real/a.ts'),
      workspaceFileExistenceBatcher.exists(scope, 'alpha', 'real/b.ts'),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      'rejected',
      'rejected',
    ]);
  });
});

describe('a linked pull request’s state', () => {
  function renderState(pullRequestRef = '7') {
    const client = new QueryClient();
    return render(
      <QueryClientProvider client={client}>
        <PullRequestLinkState
          conversationId="conversation-1"
          host="GitHub.com"
          owner="o"
          repository="r"
          pullRequestRef={pullRequestRef}
        />
      </QueryClientProvider>,
    );
  }

  test('shows the state the server observed, matched case-insensitively', async () => {
    getConversationPullRequestLinks.mockResolvedValue({
      links: [
        {
          host: 'github.com',
          repository: { owner: 'O', name: 'R' },
          ref: '7',
          status: {
            state: 'current',
            title: 'Fix it',
            pullRequestState: 'merged',
          },
        },
      ],
    });
    renderState();
    const pill = await screen.findByText('Merged');
    expect(pill.getAttribute('title')).toBe('Fix it');
    expect(getConversationPullRequestLinks).toHaveBeenCalledWith(
      scope.apiBase,
      'conversation-1',
      expect.anything(),
    );
  });

  test('shows nothing for an unlinked or unobservable pull request', async () => {
    getConversationPullRequestLinks.mockResolvedValue({
      links: [
        {
          host: 'github.com',
          repository: { owner: 'o', name: 'r' },
          ref: '8',
          status: { state: 'unavailable', reason: 'no auth' },
        },
        {
          host: 'github.com',
          repository: { owner: 'o', name: 'r' },
          ref: '9',
          status: { state: 'current', title: 'T', pullRequestState: 'OPEN' },
        },
      ],
    });
    const client = new QueryClient();
    const { container } = render(
      <QueryClientProvider client={client}>
        {['7', '8', '9'].map((ref) => (
          <PullRequestLinkState
            conversationId="conversation-1"
            host="github.com"
            key={ref}
            owner="o"
            repository="r"
            pullRequestRef={ref}
          />
        ))}
      </QueryClientProvider>,
    );
    // #9 is the control: once its state shows, the shared answer has landed,
    // so #7 (never linked) and #8 (unobservable) showing nothing is a verdict.
    await screen.findByText('Open');
    expect(container.textContent).toBe('Open');
  });
});
