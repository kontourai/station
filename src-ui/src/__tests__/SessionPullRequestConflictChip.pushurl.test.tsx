/**
 * @vitest-environment jsdom
 *
 * #2937: the chip matches a pull request by the checkout's LOCAL branch name,
 * exactly as before this change. Two real layouts pin that:
 * - fetch `o/r`, push `me/r` through `remote.origin.pushurl`, branch `feat`
 *   tracking `origin/feat`: the conflicting `feat` pull request lights it;
 * - branch `feat` tracking `origin/main`: a conflicting `main` pull request
 *   (the upstream's name, not this branch) does not.
 *
 * Everything below the forge is real: a temporary git repository, the
 * pull-request context resolver, the pull-request routes, the GitHub
 * provider's normalization, the SDK hooks and the chip. Only `gh` is faked.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { _setApiBase } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../src-server/__test-utils__/temp-dirs';
import { createPullRequestRoutes } from '../../../src-server/routes/pull-requests/pull-request-routes';
import { GitHubPullRequestProvider } from '../../../src-server/services/pull-requests/github-pull-request-provider';
import { PullRequestRepositoryContextResolver } from '../../../src-server/services/pull-requests/pull-request-repository-context-resolver';
import { SessionPullRequestConflictChip } from '../components/session/SessionPullRequestConflictChip';
import { stationQueryDefaults } from '../lib/queryDefaults';

const ORIGIN = 'https://station.example.test';
const makeTempDir = trackTempDirs();

function git(cwd: string, ...args: string[]) {
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Station Test',
      '-c',
      'user.email=station-test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd, stdio: 'pipe', windowsHide: true },
  );
}

/** A checkout of `o/r` on branch `feat`, tracking `origin/<upstream>`. */
function checkout(options: { upstream: string; pushurl?: string }) {
  const repository = join(makeTempDir('station-pr-branch-'), 'checkout');
  mkdirSync(repository);
  git(repository, 'init', '-q', '-b', 'main');
  git(repository, 'commit', '-q', '--allow-empty', '-m', 'base');
  git(repository, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
  if (options.pushurl)
    git(repository, 'config', 'remote.origin.pushurl', options.pushurl);
  git(repository, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(
    repository,
    'symbolic-ref',
    'refs/remotes/origin/HEAD',
    'refs/remotes/origin/main',
  );
  git(repository, 'checkout', '-q', '-b', 'feat');
  git(
    repository,
    'update-ref',
    `refs/remotes/origin/${options.upstream}`,
    'HEAD',
  );
  git(repository, 'config', 'branch.feat.remote', 'origin');
  git(
    repository,
    'config',
    'branch.feat.merge',
    `refs/heads/${options.upstream}`,
  );
  return realpathSync(repository);
}

/** The real routes over the real resolver; only `gh` answers from `openPullRequests`. */
function station(checkoutRoot: string, openPullRequests: object[]) {
  const resolver = new PullRequestRepositoryContextResolver();
  const gh = vi.fn(async (args: string[]) => ({
    stdout: args[0] === 'pr' ? JSON.stringify(openPullRequests) : '',
  }));
  const routes = createPullRequestRoutes(
    () => [new GitHubPullRequestProvider(gh)],
    async (_c, request) =>
      resolver.resolve({
        projectWorkingDirectory: checkoutRoot,
        requireBranchState: request.requireBranchState,
        ...(request.repository?.owner && request.repository.name
          ? { repository: request.repository }
          : {}),
      }),
    { operatorIdentityForRequest: () => undefined },
  );
  return { routes, gh };
}

async function renderChip(routes: ReturnType<typeof station>['routes']) {
  _setApiBase(ORIGIN);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const path = url.pathname.replace(/^\/api\/pull-requests/, '');
      return routes.request(`${path}${url.search}`);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { ...stationQueryDefaults(), retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SessionPullRequestConflictChip
        session={{ threadId: 't1', projectSlug: 'station' } as any}
      />
    </QueryClientProvider>,
  );
  return client;
}

const contextOf = async (routes: ReturnType<typeof station>['routes']) =>
  (await routes.request('/context?project=station&thread=t1')).json();

const pullRequest = (headRefName: string, mergeable: string) => ({
  number: headRefName === 'feat' ? 7 : 8,
  headRefName,
  mergeable,
});

describe('session conflict chip matches the local branch (#2937)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('a pushurl checkout lights for its conflicting branch pull request', async () => {
    const { routes } = station(
      checkout({ upstream: 'feat', pushurl: 'https://github.com/me/r.git' }),
      [pullRequest('feat', 'CONFLICTING')],
    );
    await expect(contextOf(routes)).resolves.toEqual({
      success: true,
      data: {
        available: true,
        provider: 'github',
        host: 'github.com',
        repository: { owner: 'o', name: 'r' },
        branch: 'feat',
      },
    });
    const client = await renderChip(routes);
    await waitFor(() => expect(screen.getByText('PR conflict')).toBeTruthy());
    client.clear();
  });

  test("an upstream of another name does not borrow that name's pull request", async () => {
    const { routes, gh } = station(checkout({ upstream: 'main' }), [
      pullRequest('main', 'CONFLICTING'),
      pullRequest('feat', 'MERGEABLE'),
    ]);
    await expect(contextOf(routes)).resolves.toMatchObject({
      data: { available: true, branch: 'feat' },
    });
    const client = await renderChip(routes);
    // The observation completed: both reads answered, and nothing lit.
    await waitFor(() =>
      expect(
        gh.mock.calls.filter(
          ([args]) => args[0] === 'pr' && args[1] === 'list',
        ),
      ).toHaveLength(1),
    );
    await waitFor(() =>
      expect(
        client
          .getQueryCache()
          .findAll({ queryKey: ['pull-request-mergeability'] })
          .some((query) => query.state.status === 'success'),
      ).toBe(true),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByText('PR conflict')).toBeNull();
    client.clear();
  });
});
