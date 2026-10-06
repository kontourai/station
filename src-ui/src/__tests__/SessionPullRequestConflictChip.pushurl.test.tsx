/**
 * @vitest-environment jsdom
 *
 * #2941: local branch and push-target owner identify the conflicting PR.
 * Real checkouts cover fetch-only, pushurl, push-remote precedence, base-branch
 * tracking and unknown-owner fallbacks without replacing git or the resolver.
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
function checkout(options: {
  upstream: string;
  pushurl?: string;
  branch?: string;
}) {
  const branch = options.branch ?? 'feat';
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
  if (branch !== 'main') git(repository, 'checkout', '-q', '-b', branch);
  git(
    repository,
    'update-ref',
    `refs/remotes/origin/${options.upstream}`,
    'HEAD',
  );
  git(repository, 'config', `branch.${branch}.remote`, 'origin');
  git(
    repository,
    'config',
    `branch.${branch}.merge`,
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

async function expectUnlit(
  routes: ReturnType<typeof station>['routes'],
  gh: ReturnType<typeof station>['gh'],
) {
  const client = await renderChip(routes);
  await waitFor(() =>
    expect(
      gh.mock.calls.filter(([args]) => args[0] === 'pr' && args[1] === 'list'),
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
}

const contextOf = async (routes: ReturnType<typeof station>['routes']) =>
  (await routes.request('/context?project=station&thread=t1')).json();

const pullRequest = (
  headRefName: string,
  mergeable: string,
  owner?: string,
) => ({
  ...(owner ? { headRepositoryOwner: { login: owner } } : {}),
  number: headRefName === 'feat' ? 7 : 8,
  headRefName,
  mergeable,
});

describe('session conflict chip matches local branch and push target (#2941)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('a pushurl checkout lights for its conflicting branch pull request', async () => {
    const { routes } = station(
      checkout({ upstream: 'feat', pushurl: 'https://github.com/me/r.git' }),
      [pullRequest('feat', 'CONFLICTING', 'ME')],
    );
    await expect(contextOf(routes)).resolves.toEqual({
      success: true,
      data: {
        available: true,
        provider: 'github',
        host: 'github.com',
        repository: { owner: 'o', name: 'r' },
        branch: 'feat',
        pushTargetOwner: 'me',
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
    await expectUnlit(routes, gh);
  });
  test('fetch-only origin lights for a same-repository PR', async () => {
    const { routes } = station(checkout({ upstream: 'feat' }), [
      pullRequest('feat', 'CONFLICTING', 'o'),
    ]);
    await expect(contextOf(routes)).resolves.toMatchObject({
      data: { pushTargetOwner: 'o' },
    });
    const client = await renderChip(routes);
    await waitFor(() => expect(screen.getByText('PR conflict')).toBeTruthy());
    client.clear();
  });

  test('pushurl fork ignores a same-name PR from another owner', async () => {
    const { routes, gh } = station(
      checkout({ upstream: 'feat', pushurl: 'https://github.com/me/r.git' }),
      [pullRequest('feat', 'CONFLICTING', 'other')],
    );
    await expect(contextOf(routes)).resolves.toMatchObject({
      data: { branch: 'feat', pushTargetOwner: 'me' },
    });
    await expectUnlit(routes, gh);
  });

  test('main tracking origin/main ignores a conflicting fork main', async () => {
    const { routes, gh } = station(
      checkout({ upstream: 'main', branch: 'main' }),
      [pullRequest('main', 'CONFLICTING', 'other')],
    );
    await expect(contextOf(routes)).resolves.toMatchObject({
      data: { branch: 'main', pushTargetOwner: 'o' },
    });
    await expectUnlit(routes, gh);
  });

  test('unknown push owner retains branch-only matching', async () => {
    const { routes } = station(
      checkout({ upstream: 'feat', pushurl: '/unidentified/local/repository' }),
      [pullRequest('feat', 'CONFLICTING', 'other')],
    );
    const context = await contextOf(routes);
    expect(context.data.branch).toBe('feat');
    expect(context.data).not.toHaveProperty('pushTargetOwner');
    const client = await renderChip(routes);
    await waitFor(() => expect(screen.getByText('PR conflict')).toBeTruthy());
    client.clear();
  });

  test.each([
    { branchRemote: 'named', pushDefault: 'origin', expected: 'me' },
    { branchRemote: undefined, pushDefault: 'named', expected: 'me' },
    { branchRemote: undefined, pushDefault: undefined, expected: 'o' },
  ])(
    'push remote precedence: $branchRemote / $pushDefault',
    async ({ branchRemote, pushDefault, expected }) => {
      const root = checkout({ upstream: 'feat' });
      // A second fetch URL for the same repository preserves repository resolution.
      git(root, 'remote', 'add', 'named', 'https://github.com/o/r.git');
      git(
        root,
        'config',
        'remote.named.pushurl',
        'https://github.com/me/r.git',
      );
      if (branchRemote)
        git(root, 'config', 'branch.feat.pushRemote', branchRemote);
      if (pushDefault) git(root, 'config', 'remote.pushDefault', pushDefault);
      const { routes } = station(root, [
        pullRequest('feat', 'CONFLICTING', expected),
      ]);
      await expect(contextOf(routes)).resolves.toMatchObject({
        data: {
          repository: { owner: 'o', name: 'r' },
          pushTargetOwner: expected,
        },
      });
      const client = await renderChip(routes);
      await waitFor(() => expect(screen.getByText('PR conflict')).toBeTruthy());
      client.clear();
    },
  );
});
