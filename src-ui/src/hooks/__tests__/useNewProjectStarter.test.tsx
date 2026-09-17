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

  /**
   * The settle means the query can be describing a path the field no longer
   * holds. When `gitWorkspaceDetected` ignored that, replacing a settled git
   * repo with a plain folder re-selected Coding from the stale answer and then
   * left it selected after detection flipped false — no card on screen, "Start
   * without a layout" unpressed, and Create applying Coding to a non-git
   * folder. E4 again, reached through the selection rather than the submit.
   */
  test('replacing a settled git repo with a plain folder withdraws the recommendation', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result, rerender } = renderStarter('/tmp/repo');
      await settleDiscovery();
      await waitFor(() =>
        expect(result.current.selectedLayoutId).toBe('builtin:coding'),
      );

      // Paste-over: the field changes, and the modal resets its non-explicit
      // choice exactly as `NewProjectModalContent` does on a directory edit.
      respondWithRepos([]);
      act(() => result.current.resetForDirectory());
      rerender({ normalizedDirectory: '/tmp/notes' });

      // Mid-settle: the query still answers for /tmp/repo, so the ONLY thing
      // that can keep the recommendation off the new folder is the
      // discovery-is-current check.
      expect(result.current.gitWorkspaceDetected).toBe(false);
      expect(result.current.selectedLayoutId).toBeNull();

      await settleDiscovery();
      await waitFor(() =>
        expect(discoveryPaths()).toEqual(['/tmp/repo', '/tmp/notes']),
      );
      expect(result.current.gitWorkspaceDetected).toBe(false);
      expect(result.current.selectedLayoutId).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The same directory change WITHOUT `resetForDirectory`.
   *
   * Nothing in this hook's contract requires a caller to call that — today
   * exactly one does (`NewProjectModalContent`'s directory field), and while it
   * does, it nulls the selection before the effect could withdraw it, which is
   * why a set-only effect passes the two tests above. That coupling is the
   * defect underneath D1: the selection was a residue of whoever remembered to
   * reset rather than a derivation of the detected fact. Drive the hook the way
   * a caller that does not reset would, and the selection must still track the
   * recommendation.
   */
  test('withdraws the recommendation on a directory change even with no reset', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result, rerender } = renderStarter('/tmp/repo');
      await settleDiscovery();
      await waitFor(() =>
        expect(result.current.selectedLayoutId).toBe('builtin:coding'),
      );

      respondWithRepos([]);
      rerender({ normalizedDirectory: '/tmp/notes' });

      expect(result.current.gitWorkspaceDetected).toBe(false);
      expect(result.current.selectedLayoutId).toBeNull();

      await settleDiscovery();
      await waitFor(() =>
        expect(discoveryPaths()).toEqual(['/tmp/repo', '/tmp/notes']),
      );
      expect(result.current.selectedLayoutId).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The variant with no correcting answer at all: the replacement value fails
   * `looksLikeWorkspacePath`, so the query is DISABLED and its last answer
   * ("repo") simply stays. Nothing later flips detection false, so a
   * set-only derivation leaves Coding selected forever.
   */
  test('replacing a settled git repo with a non-path withdraws it too, with no new query', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result, rerender } = renderStarter('/tmp/repo');
      await settleDiscovery();
      await waitFor(() =>
        expect(result.current.selectedLayoutId).toBe('builtin:coding'),
      );

      rerender({ normalizedDirectory: 'notes' });
      await settleDiscovery();

      expect(discoveryPaths()).toEqual(['/tmp/repo']);
      expect(result.current.gitWorkspaceDetected).toBe(false);
      expect(result.current.selectedLayoutId).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test('the deselect arm never reaches an explicit choice (the modal itself resets on directory change)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result, rerender } = renderStarter('/tmp/repo');
      await settleDiscovery();
      await waitFor(() =>
        expect(result.current.selectedLayoutId).toBe('builtin:coding'),
      );

      // The deselect arm must never reach a choice the user made themselves.
      act(() => result.current.selectLayout('builtin:coding'));
      respondWithRepos([]);
      rerender({ normalizedDirectory: '/tmp/notes' });
      await settleDiscovery();

      expect(result.current.gitWorkspaceDetected).toBe(false);
      expect(result.current.selectedLayoutId).toBe('builtin:coding');
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
