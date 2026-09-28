/**
 * @vitest-environment jsdom
 *
 * #2937 delta review: a checkout that fetches `o/r` and pushes to `me/r`
 * through `remote.origin.pushurl` resolves to repository `o/r` with a head of
 * `{ branch }` and no owner, while GitHub reports the pull request's source
 * owner as `me`. The chip must still light for that session's conflict.
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
import { render, screen, waitFor } from '@testing-library/react';
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

/** Fetch from `o/r`, push to `me/r`, on branch `feat` tracking `origin/feat`. */
function pushurlCheckout() {
  const repository = join(makeTempDir('station-pr-pushurl-'), 'checkout');
  mkdirSync(repository);
  git(repository, 'init', '-q', '-b', 'main');
  git(repository, 'commit', '-q', '--allow-empty', '-m', 'base');
  git(repository, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
  git(
    repository,
    'config',
    'remote.origin.pushurl',
    'https://github.com/me/r.git',
  );
  git(repository, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(
    repository,
    'symbolic-ref',
    'refs/remotes/origin/HEAD',
    'refs/remotes/origin/main',
  );
  git(repository, 'checkout', '-q', '-b', 'feat');
  git(repository, 'update-ref', 'refs/remotes/origin/feat', 'HEAD');
  git(repository, 'config', 'branch.feat.remote', 'origin');
  git(repository, 'config', 'branch.feat.merge', 'refs/heads/feat');
  return realpathSync(repository);
}

describe('session conflict chip for a pushurl checkout (#2937)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('lights for the conflict of the pull request its branch was pushed to', async () => {
    const checkout = pushurlCheckout();
    const resolver = new PullRequestRepositoryContextResolver();
    const gh = vi.fn(async (args: string[]) => ({
      stdout:
        args[0] === 'pr'
          ? JSON.stringify([
              {
                number: 7,
                headRefName: 'feat',
                headRepositoryOwner: { login: 'me' },
                mergeable: 'CONFLICTING',
              },
            ])
          : '',
    }));
    const routes = createPullRequestRoutes(
      () => [new GitHubPullRequestProvider(gh)],
      async (_c, request) =>
        resolver.resolve({
          projectWorkingDirectory: checkout,
          requireBranchState: request.requireBranchState,
          ...(request.repository?.owner && request.repository.name
            ? { repository: request.repository }
            : {}),
        }),
      { operatorIdentityForRequest: () => undefined },
    );

    // The real context for this layout: base repository, head with no owner.
    const context = await (
      await routes.request('/context?project=station&thread=t1')
    ).json();
    expect(context).toEqual({
      success: true,
      data: {
        available: true,
        provider: 'github',
        host: 'github.com',
        repository: { owner: 'o', name: 'r' },
        branch: 'feat',
        head: { branch: 'feat' },
      },
    });

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
    await waitFor(() => expect(screen.getByText('PR conflict')).toBeTruthy());
    expect(gh.mock.calls.map(([args]) => args.slice(0, 2))).toContainEqual([
      'pr',
      'list',
    ]);
    client.clear();
  });
});
