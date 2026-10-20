// @vitest-environment jsdom
/**
 * The git and repository domain as a plug-in consumes it: everything under
 * test comes from the published package entry, `@kontourai/station-sdk`,
 * never from a path inside the package. A plug-in that ships the Coding
 * layout gets exactly this surface.
 *
 * Fixtures are the shapes `src-server/routes/projects/coding.ts` writes for
 * `GET /api/coding/repos`, `GET /api/coding/git/branches` and the three
 * `POST /api/coding/git/*` writes, including the operator-only refusal
 * `operatorOnly` returns for commit and push.
 */
import {
  _setApiBase,
  type DiscoveredRepo,
  type GitBranch,
  type GitCheckoutResult,
  type GitCommitResult,
  type GitPushResult,
  type ReposResult,
  setClientCredentialResolver,
  useGitBranchesQuery,
  useGitCheckoutMutation,
  useGitCommitMutation,
  useGitPushMutation,
  useReposQuery,
} from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const ORIGIN = 'https://station.example.test';

const API_REPO: DiscoveredRepo = {
  root: '/work/acme/api',
  name: 'api',
  relativePath: 'api',
  branch: 'main',
};
const WEB_REPO: DiscoveredRepo = {
  root: '/work/acme/web',
  name: 'web',
  relativePath: 'web',
  // A detached HEAD lists with an empty branch.
  branch: '',
};
const REPOS: ReposResult = {
  workspace: '/work/acme',
  workspaceIsRepo: false,
  repos: [API_REPO, WEB_REPO],
};
const BRANCHES: GitBranch[] = [
  { name: 'main', sha: 'a1b2c3d', date: '2 days ago', current: true },
  {
    name: 'origin/feature',
    sha: 'e4f5a6b',
    date: '3 hours ago',
    current: false,
  },
];

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function stubFetch(
  respond: (url: string, init?: RequestInit) => Response,
): FetchMock {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) =>
    respond(String(input instanceof Request ? input.url : input), init),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function client() {
  return new QueryClient({
    defaultOptions: {
      // Seeded reads have no observer; keep them so a test can read their state.
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
}

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

function urls(fetchMock: FetchMock): string[] {
  return fetchMock.mock.calls.map(([input]) => String(input));
}

function sentBody(fetchMock: FetchMock, call = 0): unknown {
  return JSON.parse(String(fetchMock.mock.calls[call]?.[1]?.body));
}

beforeEach(() => {
  _setApiBase(ORIGIN);
});

afterEach(() => {
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

describe('useReposQuery', () => {
  test('discovers repositories in a Project folder with the current credential', async () => {
    setClientCredentialResolver(() => ({
      credential: 'remote-repo-credential',
      origin: ORIGIN,
    }));
    const fetchMock = stubFetch(() =>
      json(200, { success: true, data: REPOS }),
    );

    const { result } = renderHook(
      () => useReposQuery('/work/acme', { projectSlug: 'acme' }),
      { wrapper: wrapperFor(client()) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(REPOS);
    expect(urls(fetchMock)).toEqual([
      `${ORIGIN}/api/coding/repos?projectSlug=acme&path=%2Fwork%2Facme`,
    ]);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer remote-repo-credential',
    );
  });

  test('without a Project the request names only the folder', async () => {
    const fetchMock = stubFetch(() =>
      json(200, { success: true, data: REPOS }),
    );
    const { result } = renderHook(() => useReposQuery('/work/new'), {
      wrapper: wrapperFor(client()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(urls(fetchMock)).toEqual([
      `${ORIGIN}/api/coding/repos?path=%2Fwork%2Fnew`,
    ]);
  });

  test('a refused discovery reads as no repositories, and recovers with a replacement credential', async () => {
    let credential = 'expired-repo-credential';
    const onUnauthorized = vi.fn();
    setClientCredentialResolver(() => ({
      credential,
      origin: ORIGIN,
      onUnauthorized,
    }));
    const fetchMock = stubFetch(() =>
      credential === 'expired-repo-credential'
        ? json(401, { success: false, error: 'Unauthorized' })
        : json(200, { success: true, data: REPOS }),
    );

    const { result } = renderHook(
      () => useReposQuery('/work/acme', { projectSlug: 'acme' }),
      { wrapper: wrapperFor(client()) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      workspace: '/work/acme',
      workspaceIsRepo: false,
      repos: [],
    });
    expect(onUnauthorized).toHaveBeenCalledOnce();

    credential = 'replacement-repo-credential';
    const recovery = await result.current.refetch();
    expect(recovery.data).toEqual(REPOS);
    const init = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]?.[1];
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer replacement-repo-credential',
    );
  });

  test('does not run without a folder or when disabled', async () => {
    const fetchMock = stubFetch(() =>
      json(200, { success: true, data: REPOS }),
    );
    const queryClient = client();
    renderHook(() => useReposQuery(null, { projectSlug: 'acme' }), {
      wrapper: wrapperFor(queryClient),
    });
    renderHook(
      () =>
        useReposQuery('/work/acme', { projectSlug: 'acme', enabled: false }),
      { wrapper: wrapperFor(queryClient) },
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('useGitBranchesQuery', () => {
  test('lists branches for a folder in a Project', async () => {
    const fetchMock = stubFetch(() =>
      json(200, { success: true, data: BRANCHES }),
    );
    const { result } = renderHook(
      () =>
        useGitBranchesQuery({
          projectSlug: 'acme',
          workingDir: API_REPO.root,
        }),
      { wrapper: wrapperFor(client()) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(BRANCHES);
    expect(urls(fetchMock)).toEqual([
      `${ORIGIN}/api/coding/git/branches?projectSlug=acme&path=%2Fwork%2Facme%2Fapi`,
    ]);
  });

  test('a refused read becomes an empty list', async () => {
    stubFetch(() =>
      json(403, {
        success: false,
        error: 'That folder is outside this Project',
        code: 'outside-project',
      }),
    );
    const { result } = renderHook(
      () => useGitBranchesQuery({ projectSlug: 'acme', workingDir: '/etc' }),
      { wrapper: wrapperFor(client()) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });

  test('a location missing its Project or folder issues no request', async () => {
    const fetchMock = stubFetch(() =>
      json(200, { success: true, data: BRANCHES }),
    );
    const queryClient = client();
    renderHook(() => useGitBranchesQuery(null), {
      wrapper: wrapperFor(queryClient),
    });
    renderHook(
      () => useGitBranchesQuery({ projectSlug: '', workingDir: API_REPO.root }),
      { wrapper: wrapperFor(queryClient) },
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('git writes', () => {
  test('checkout sends the branch and refreshes that folder’s status, branches and log', async () => {
    const checkout: GitCheckoutResult = { branch: 'feature' };
    const fetchMock = stubFetch((url) =>
      url.includes('/git/checkout')
        ? json(200, { success: true, data: checkout })
        : json(200, { success: true, data: BRANCHES }),
    );
    const queryClient = client();
    const other = '/work/acme/web';
    for (const read of ['git-status', 'git-log']) {
      queryClient.setQueryData([read, API_REPO.root], { seeded: true });
      queryClient.setQueryData([read, other], { seeded: true });
    }
    const { result } = renderHook(
      () => ({
        branches: useGitBranchesQuery({
          projectSlug: 'acme',
          workingDir: API_REPO.root,
        }),
        checkout: useGitCheckoutMutation('acme', API_REPO.root),
      }),
      { wrapper: wrapperFor(queryClient) },
    );
    await waitFor(() => expect(result.current.branches.isSuccess).toBe(true));
    const branchReads = () =>
      urls(fetchMock).filter((url) => url.includes('/git/branches')).length;
    expect(branchReads()).toBe(1);

    let answer: GitCheckoutResult | undefined;
    await act(async () => {
      answer = await result.current.checkout.mutateAsync({
        branch: 'feature',
        create: true,
      });
    });

    expect(answer).toEqual(checkout);
    expect(
      urls(fetchMock).filter((url) => url.endsWith('/api/coding/git/checkout')),
    ).toHaveLength(1);
    const checkoutCall = fetchMock.mock.calls.findIndex(([input]) =>
      String(input).endsWith('/git/checkout'),
    );
    expect(fetchMock.mock.calls[checkoutCall]?.[1]?.method).toBe('POST');
    expect(sentBody(fetchMock, checkoutCall)).toEqual({
      projectSlug: 'acme',
      path: API_REPO.root,
      branch: 'feature',
      create: true,
    });
    // The mounted branch list re-reads; the folder's other reads are stale.
    await waitFor(() => expect(branchReads()).toBe(2));
    for (const read of ['git-status', 'git-log']) {
      expect(
        queryClient.getQueryState([read, API_REPO.root])?.isInvalidated,
      ).toBe(true);
      // Another folder's reads are not this write's to refresh.
      expect(queryClient.getQueryState([read, other])?.isInvalidated).toBe(
        false,
      );
    }
  });

  test('commit names the Project, and the repository only as a selection inside it', async () => {
    const commit: GitCommitResult = { sha: 'abc1234' };
    const fetchMock = stubFetch(() =>
      json(200, { success: true, data: commit }),
    );
    const { result } = renderHook(
      () => useGitCommitMutation('acme', API_REPO.root),
      { wrapper: wrapperFor(client()) },
    );
    let answer: GitCommitResult | undefined;
    await act(async () => {
      answer = await result.current.mutateAsync({ message: 'change' });
    });
    expect(answer).toEqual(commit);
    expect(urls(fetchMock)).toEqual([`${ORIGIN}/api/coding/git/commit`]);
    expect(sentBody(fetchMock)).toEqual({
      projectSlug: 'acme',
      path: API_REPO.root,
      message: 'change',
    });
  });

  test("a refused commit rejects with the server's sentence, naming the files", async () => {
    const error =
      'Not committed: .env (environment file) looks like secrets. Add them to .gitignore or remove them, then commit again';
    stubFetch(() =>
      json(409, {
        success: false,
        code: 'secrets',
        error,
        files: [{ path: '.env', reason: 'environment file' }],
      }),
    );
    const { result } = renderHook(() => useGitCommitMutation('acme', '/w'), {
      wrapper: wrapperFor(client()),
    });
    act(() => result.current.mutate({ message: 'change' }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe(error);
  });

  test('a validation refusal reaches the caller with its reason, not "Validation failed" alone', async () => {
    // The shape the shared zod middleware answers a rejected body with.
    stubFetch(() =>
      json(400, {
        success: false,
        error: 'Validation failed',
        details: {
          formErrors: [],
          fieldErrors: { branch: ['Branch name is required'] },
        },
      }),
    );
    const { result } = renderHook(() => useGitCheckoutMutation('acme', '/w'), {
      wrapper: wrapperFor(client()),
    });
    act(() => result.current.mutate({ branch: '' }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('Branch name is required');
  });

  test('push names the Project and returns the remote it pushed to', async () => {
    const push: GitPushResult = { output: 'main -> main', remote: 'origin' };
    const fetchMock = stubFetch(() => json(200, { success: true, data: push }));
    const { result } = renderHook(() => useGitPushMutation('acme', '/w'), {
      wrapper: wrapperFor(client()),
    });
    let answer: GitPushResult | undefined;
    await act(async () => {
      answer = await result.current.mutateAsync({ setUpstream: true });
    });
    expect(answer).toEqual(push);
    expect(urls(fetchMock)).toEqual([`${ORIGIN}/api/coding/git/push`]);
    expect(sentBody(fetchMock)).toEqual({
      projectSlug: 'acme',
      path: '/w',
      setUpstream: true,
    });
  });

  test.each([
    ['commit', 'Only the Station operator can commit from Station.'],
    ['push', 'Only the Station operator can push from Station.'],
  ] as const)(
    'a non-operator %s is refused by the server, and the refusal reaches the caller',
    async (write, error) => {
      // The SDK grants nothing: it sends the request and reports the 403
      // `operatorOnly` answers with. Authorization is the server's.
      const fetchMock = stubFetch(() => json(403, { success: false, error }));
      const queryClient = client();
      queryClient.setQueryData(['git-status', '/w'], { seeded: true });
      const { result } = renderHook(
        () => ({
          commit: useGitCommitMutation('acme', '/w'),
          push: useGitPushMutation('acme', '/w'),
        }),
        { wrapper: wrapperFor(queryClient) },
      );
      await act(async () => {
        await expect(
          write === 'commit'
            ? result.current.commit.mutateAsync({ message: 'x' })
            : result.current.push.mutateAsync({}),
        ).rejects.toThrow(error);
      });
      expect(urls(fetchMock)).toEqual([`${ORIGIN}/api/coding/git/${write}`]);
      expect(fetchMock).toHaveBeenCalledOnce();
      // A refused write changed nothing, so nothing is refreshed.
      expect(
        queryClient.getQueryState(['git-status', '/w'])?.isInvalidated,
      ).toBe(false);
    },
  );
});
