/** @vitest-environment jsdom */

/**
 * #1536 E4, the discovery gate itself.
 *
 * `__tests__/NewProjectModal.test.tsx` mocks `useReposQuery` wholesale, so the
 * `enabled` option — the thing that decides whether the recommendation can be
 * SHOWN at all — is invisible there: the mock answers with repos no matter what
 * the gate says. That is exactly how the reported defect survived a green suite.
 * These tests keep the real `useReposQuery` and mock only the HTTP boundary
 * beneath it, so a request either happens or it does not.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
const availableLayoutsState = vi.hoisted(() => ({
  data: [
    {
      id: 'builtin:coding',
      name: 'Coding',
      slug: 'coding',
      source: 'builtin',
      type: 'coding',
      tabCount: 3,
      visible: true,
      enabled: true,
      lifecycle: { state: 'installed' },
      sourceIdentity: { id: 'builtin' },
    },
  ] as unknown[],
}));

vi.mock('@kontourai/station-sdk', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
  useAvailableProjectLayoutsQuery: () => ({
    data: availableLayoutsState.data,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  telemetry: { track: vi.fn() },
}));

vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({
    apiBase: 'http://localhost:3141',
    credentialState: 'ok',
  }),
}));

import { useNewProjectStarter } from '../useNewProjectStarter';

/** The repo-discovery answer for `GET /api/coding/repos?path=…`. */
function respondWithRepos(repos: Array<{ root: string }>) {
  fetchMock.mockImplementation((url: string) => {
    if (!String(url).includes('/api/coding/repos')) {
      throw new Error(`unexpected request: ${url}`);
    }
    return Promise.resolve({
      json: () =>
        Promise.resolve({
          success: true,
          data: { workspace: '/tmp/repo', workspaceIsRepo: true, repos },
        }),
    });
  });
}

function discoveryPaths(): string[] {
  return fetchMock.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.includes('/api/coding/repos'))
    .map((url) =>
      decodeURIComponent(new URL(url).searchParams.get('path') ?? ''),
    );
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderStarter(normalizedDirectory: string) {
  return renderHook(
    (props: { normalizedDirectory: string }) =>
      useNewProjectStarter({ isOpen: true, ...props }),
    { initialProps: { normalizedDirectory }, wrapper },
  );
}

/** Lets the idle settle elapse, then the discovery query resolve. */
async function settleDiscovery() {
  await act(async () => {
    vi.advanceTimersByTime(1_000);
  });
}

describe('useNewProjectStarter repo discovery gate (#1536 E4)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    respondWithRepos([{ root: '/tmp/repo' }]);
    localStorage.clear();
  });

  test('a bare typed absolute path with a repository selects the Coding starter', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // Mounted with the value already in the field, which is not typing: the
      // settle only delays a value that CHANGES (the two tests below).
      const { result } = renderStarter('/Users/me/code/myrepo');

      await settleDiscovery();
      await waitFor(() =>
        expect(result.current.selectedLayoutId).toBe('builtin:coding'),
      );
      expect(result.current.gitWorkspaceDetected).toBe(true);
      // No trailing slash anywhere: the shape the audit was reported against.
      expect(discoveryPaths()).toEqual(['/Users/me/code/myrepo']);
    } finally {
      vi.useRealTimers();
    }
  });

  test('the same path with no repository leaves "Start without a layout" chosen', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      respondWithRepos([]);
      const { result } = renderStarter('/Users/me/code/notes');

      await settleDiscovery();
      await waitFor(() =>
        expect(discoveryPaths()).toEqual(['/Users/me/code/notes']),
      );
      expect(result.current.gitWorkspaceDetected).toBe(false);
      expect(result.current.selectedLayoutId).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a half-typed value is never asked about, and asks once typing settles', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { rerender } = renderStarter('');
      for (const partial of ['~', 'code/', '/']) {
        rerender({ normalizedDirectory: partial });
        await settleDiscovery();
      }
      expect(discoveryPaths()).toEqual([]);

      rerender({ normalizedDirectory: '/Users/me/code/myrepo' });
      await settleDiscovery();
      await waitFor(() =>
        expect(discoveryPaths()).toEqual(['/Users/me/code/myrepo']),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test('typing a path one character at a time asks once, for the settled value', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const target = '/tmp/repo';
      const { rerender } = renderStarter('');
      for (let i = 1; i <= target.length; i += 1) {
        rerender({ normalizedDirectory: target.slice(0, i) });
        // Well inside the idle window: a per-keystroke gate would fire here.
        await act(async () => {
          vi.advanceTimersByTime(50);
        });
      }
      expect(discoveryPaths()).toEqual([]);

      await settleDiscovery();
      await waitFor(() => expect(discoveryPaths()).toEqual([target]));
    } finally {
      vi.useRealTimers();
    }
  });
});
