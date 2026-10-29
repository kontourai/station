import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_GRANT_PAIRING_SCOPE,
  pairingScopePresetString,
} from '@kontourai/station-contracts';
import type { PullRequestReviewSnapshot } from '@kontourai/station-contracts/pull-request-provider';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import { RUNTIME_CREDENTIAL_AUTHORITY_VAR } from '../../../security/runtime-request-security.js';
import { guideFixture } from '../../../services/pull-requests/__tests__/guide-fixture.js';
import { GitHubPullRequestProvider } from '../../../services/pull-requests/github-pull-request-provider.js';
import { GitLabPullRequestProvider } from '../../../services/pull-requests/gitlab-pull-request-provider.js';
import { PullRequestReviewGuideService } from '../../../services/pull-requests/pull-request-review-guide.js';
import { PullRequestReviewGuideStore } from '../../../services/pull-requests/pull-request-review-guide-store.js';
import { createPullRequestRoutes } from '../pull-request-routes.js';

const makeTempDir = trackTempDirs();
const caps = {
  list: true,
  detail: true,
  open: true,
  comment: true,
  approve: true,
  merge: true,
  autoMerge: true,
};
const context = async () => ({
  available: true,
  context: {
    repository: { owner: 'o', name: 'r', remote: 'https://github.com/o/r.git' },
    workingDirectory: '/x',
    branch: 'b',
    baseRef: 'main',
  },
});
function app(
  operator?: string,
  authority: { current: boolean; operator?: string } = {
    current: true,
    operator,
  },
) {
  const providerResult = {
    available: true,
    effectiveCapabilities: caps,
    effectiveMergeMethods: ['merge', 'squash', 'rebase'],
    mergeMethodsSource: 'provider-default',
  };
  const provider: any = {
    id: 'github',
    canServeHost: () => true,
    getHost: () => 'github.com',
    offeredCapabilities: caps,
    offeredMergeMethods: ['merge', 'squash', 'rebase'],
    getAvailability: vi.fn().mockResolvedValue({
      available: true,
      effectiveCapabilities: caps,
      effectiveMergeMethods: ['merge', 'squash', 'rebase'],
      mergeMethodsSource: 'provider-default',
    }),
    getReviewSnapshot: vi.fn().mockResolvedValue(providerResult),
    submitReview: vi.fn().mockResolvedValue(providerResult),
    mergePullRequest: vi.fn().mockResolvedValue(providerResult),
    createComment: vi.fn().mockResolvedValue(providerResult),
    approvePullRequest: vi.fn().mockResolvedValue(providerResult),
    listPullRequests: vi.fn().mockResolvedValue(providerResult),
    getPullRequest: vi.fn().mockResolvedValue(providerResult),
    openPullRequest: vi.fn().mockResolvedValue(providerResult),
  };
  return {
    provider,
    app: createPullRequestRoutes(() => [provider], context, {
      operatorIdentityForRequest: () => authority.operator ?? operator,
      isRequestPrincipalCurrent: () => authority.current,
    }),
  };
}
describe('pull request operator gate', () => {
  test('exposes server-resolved forge identity and preserves unavailable reasons', async () => {
    const x = app();
    const available = await x.app.request('/context?project=station');
    await expect(available.json()).resolves.toEqual({
      success: true,
      data: {
        available: true,
        provider: 'github',
        host: 'github.com',
        repository: { owner: 'o', name: 'r' },
        branch: 'b',
      },
    });

    const unavailable = createPullRequestRoutes(
      () => [x.provider],
      async () => ({ available: false, reason: 'Checkout has no remote' }),
      { operatorIdentityForRequest: () => undefined },
    );
    const response = await unavailable.request('/context?project=station');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { available: false, reason: 'Checkout has no remote' },
    });
  });

  test('merge route enforces narrowed merge and autoMerge capabilities', async () => {
    const x = app('operator');
    x.provider.offeredCapabilities = { ...caps, autoMerge: false };
    const denied = await x.app.request('/github/github.com/o/r/7/merge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'squash', autoMerge: true }),
    });
    expect(denied.status).toBe(409);
    expect(x.provider.mergePullRequest).not.toHaveBeenCalled();

    x.provider.offeredCapabilities = caps;
    const accepted = await x.app.request('/github/github.com/o/r/7/merge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'squash' }),
    });
    expect(accepted.status).toBe(200);
    expect(x.provider.mergePullRequest).toHaveBeenCalledWith(
      expect.any(Object),
      '7',
      { method: 'squash' },
    );
  });

  test.each([
    [{ method: 'squash', autoMerge: 'false' }, 'autoMerge'],
    [{ method: 'octopus' }, 'method'],
  ])(
    'rejects invalid merge input without dispatch: %s',
    async (body, field) => {
      const x = app('operator');
      const response = await x.app.request('/github/github.com/o/r/7/merge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        success: false,
        error: 'Validation failed',
        details: { fieldErrors: { [field]: expect.any(Array) } },
      });
      expect(x.provider.mergePullRequest).not.toHaveBeenCalled();
    },
  );

  test('merge route still enforces canServeHost before dispatch', async () => {
    const x = app('operator');
    x.provider.canServeHost = () => false;
    expect(
      (
        await x.app.request('/github/github.com/o/r/7/merge', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method: 'merge' }),
        })
      ).status,
    ).toBe(404);
    expect(x.provider.mergePullRequest).not.toHaveBeenCalled();
  });
  test('real providers refuse the other hosted forge before CLI dispatch', async () => {
    const githubTransport = vi.fn().mockResolvedValue({ stdout: '[]' });
    const gitlabTransport = vi.fn().mockResolvedValue({ stdout: '[]' });
    const github = new GitHubPullRequestProvider(githubTransport);
    const gitlab = new GitLabPullRequestProvider(gitlabTransport);
    const githubRoutes = createPullRequestRoutes(
      () => [github, gitlab],
      context,
      {
        operatorIdentityForRequest: () => undefined,
      },
    );
    expect((await githubRoutes.request('/gitlab/github.com/o/r')).status).toBe(
      404,
    );

    const gitlabContext = async () => ({
      available: true,
      context: {
        repository: {
          owner: 'o',
          name: 'r',
          remote: 'https://gitlab.com/o/r.git',
        },
        workingDirectory: '/x',
        branch: 'b',
        baseRef: 'main',
      },
    });
    const gitlabRoutes = createPullRequestRoutes(
      () => [github, gitlab],
      gitlabContext,
      {
        operatorIdentityForRequest: () => undefined,
      },
    );
    expect((await gitlabRoutes.request('/github/gitlab.com/o/r')).status).toBe(
      404,
    );
    expect(githubTransport).not.toHaveBeenCalled();
    expect(gitlabTransport).not.toHaveBeenCalled();
  });

  test('real GitHub provider retains an unknown host as a GHE candidate', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: '[]' });
    const provider = new GitHubPullRequestProvider(transport);
    const routes = createPullRequestRoutes(
      () => [provider],
      async () => ({
        available: true,
        context: {
          repository: {
            owner: 'o',
            name: 'r',
            remote: 'https://code.example.test/o/r.git',
          },
          workingDirectory: '/x',
          branch: 'b',
          baseRef: 'main',
        },
      }),
      { operatorIdentityForRequest: () => undefined },
    );
    expect((await routes.request('/github/code.example.test/o/r')).status).toBe(
      200,
    );
    expect(transport).toHaveBeenCalledWith(
      ['auth', 'status', '--hostname', 'code.example.test'],
      expect.any(Object),
    );
  });

  test('session rows of one repository share one gh list, yet every request is still admitted (#2937)', async () => {
    const transport = vi.fn(async (args: string[]) => ({
      stdout: args[0] === 'pr' ? '[]' : '',
    }));
    const provider = new GitHubPullRequestProvider(transport);
    const admitted: string[] = [];
    const routes = createPullRequestRoutes(
      () => [provider],
      async (c: any) => {
        const thread = c.req.query('thread');
        admitted.push(thread);
        if (thread === 'refused')
          return { available: false, reason: 'Conversation unavailable' };
        return context();
      },
      { operatorIdentityForRequest: () => undefined },
    );
    const responses = await Promise.all(
      ['t1', 't2', 't3', 't4', 't5', 'refused'].map((thread) =>
        routes.request(`/github/github.com/o/r?thread=${thread}&state=OPEN`),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200, 200, 200, 404,
    ]);
    // The cache sits after admission: every request met the resolver, and
    // the refused one was refused even though the forge answer was cached.
    expect(admitted).toEqual(['t1', 't2', 't3', 't4', 't5', 'refused']);
    const spawned = transport.mock.calls.map(([args]) => args.slice(0, 2));
    expect(spawned).toEqual([
      ['auth', 'status'],
      ['pr', 'list'],
    ]);
  });

  test('the mergeability route answers the narrow read, not a pull request named "mergeability" (#2937)', async () => {
    const transport = vi.fn(async (args: string[]) => ({
      stdout:
        args[0] === 'pr'
          ? JSON.stringify([
              { number: 7, headRefName: 'b', mergeable: 'CONFLICTING' },
            ])
          : '',
    }));
    const provider = new GitHubPullRequestProvider(transport);
    const getPullRequest = vi.spyOn(provider, 'getPullRequest');
    const routes = createPullRequestRoutes(() => [provider], context, {
      operatorIdentityForRequest: () => undefined,
    });
    const response = await routes.request(
      '/github/github.com/o/r/mergeability?project=p',
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        available: true,
        data: [{ ref: '7', sourceBranch: 'b', mergeability: 'conflicting' }],
      },
    });
    expect(getPullRequest).not.toHaveBeenCalled();
    expect(transport.mock.calls.at(-1)?.[0]).toContain(
      'number,headRefName,mergeable,headRepositoryOwner',
    );
  });

  test('a provider without the narrow read is refused, not answered with the full list', async () => {
    const x = app();
    const response = await x.app.request('/github/github.com/o/r/mergeability');
    expect(response.status).toBe(404);
    expect(x.provider.listPullRequests).not.toHaveBeenCalled();
    expect(x.provider.getPullRequest).not.toHaveBeenCalled();
  });

  test('returns the provider result effective capability layer to surfaces', async () => {
    const x = app();
    x.provider.offeredCapabilities = { ...caps, approve: false };
    const effectiveCapabilities = { ...caps };
    x.provider.listPullRequests.mockResolvedValue({
      available: true,
      data: [],
      effectiveCapabilities,
      effectiveMergeMethods: ['merge'],
      mergeMethodsSource: 'repository',
    });
    const response = await x.app.request('/github/github.com/o/r');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        effectiveCapabilities: { ...effectiveCapabilities, approve: false },
      },
    });
  });

  test.each([
    '/github/github.com/o/r/open',
    '/github/github.com/o/r/1/comments',
    '/github/github.com/o/r/1/approve',
  ])('device or absent authority cannot mutate %s', async (path) => {
    const x = app();
    const r = await x.app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(403);
    expect(x.provider.createComment).not.toHaveBeenCalled();
    expect(x.provider.approvePullRequest).not.toHaveBeenCalled();
  });
  test('operator may comment', async () => {
    const x = app('operator');
    await x.app.request('/github/github.com/o/r/1/comments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"body":"ok"}',
    });
    expect(x.provider.createComment).toHaveBeenCalledTimes(1);
  });
  test('rejects a URL repository that does not match the resolved checkout', async () => {
    const x = app('operator');
    const r = await x.app.request('/github/github.com/other/repo/1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(404);
    expect(x.provider.approvePullRequest).not.toHaveBeenCalled();
  });
});

describe('mounted pull request authority boundary', () => {
  test('real runtime credential stamping permits only an operator mutation', async () => {
    const provider: any = {
      id: 'github',
      canServeHost: () => true,
      getHost: () => 'github.com',
      offeredCapabilities: caps,
      offeredMergeMethods: ['merge', 'squash', 'rebase'],
      createComment: vi.fn().mockResolvedValue({
        available: true,
        effectiveCapabilities: caps,
        effectiveMergeMethods: ['merge', 'squash', 'rebase'],
        mergeMethodsSource: 'provider-default',
      }),
      approvePullRequest: vi.fn(),
      listPullRequests: vi.fn(),
      getPullRequest: vi.fn(),
      openPullRequest: vi.fn(),
    };
    const mounted = new Hono();
    configureRuntimeHttp({
      app: mounted as never,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
        trace() {},
        fatal() {},
        child() {
          return this;
        },
        setLevel() {},
        getLevel() {
          return 'info' as const;
        },
      },
      eventBus: { emit() {} },
      security: {
        verifyCredential: (credential: string) =>
          [
            'operator',
            'access-manage-device',
            'read-only',
            'unattended',
            'internal',
          ].includes(credential),
        resolveCredentialAuthority: ((credential: string) =>
          credential === 'operator'
            ? 'operator-credential'
            : credential === 'access-manage-device' ||
                credential === 'read-only'
              ? 'device-credential'
              : credential === 'unattended'
                ? 'unattended-authority'
                : credential === 'internal'
                  ? 'internal-authority'
                  : undefined) as any,
        resolveGrantedScope: (credential: string) =>
          credential === 'read-only'
            ? pairingScopePresetString('read-only')
            : [
                  'operator',
                  'access-manage-device',
                  'unattended',
                  'internal',
                ].includes(credential)
              ? DEFAULT_GRANT_PAIRING_SCOPE
              : undefined,
        allowedOrigins: [],
      },
    } as any);
    mounted.route(
      '/api/pull-requests',
      createPullRequestRoutes(() => [provider], context, {
        operatorIdentityForRequest: (c) =>
          c.get(RUNTIME_CREDENTIAL_AUTHORITY_VAR) === 'operator-credential'
            ? 'operator'
            : undefined,
      }),
    );
    const post = (path: string, credential?: string) =>
      mounted.request(`/api/pull-requests/github/github.com/o/r${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        },
        body: '{"body":"ok"}',
      });
    expect((await post('/1/comments', 'operator')).status).toBe(200);
    expect(provider.createComment).toHaveBeenCalledTimes(1);
    for (const path of ['/open', '/1/comments', '/1/approve']) {
      // This credential clears the outer access:manage scope but has no
      // operator authority, so this specifically exercises the inner gate.
      expect((await post(path, 'access-manage-device')).status).toBe(403);
      expect((await post(path, 'unattended')).status).toBe(403);
      expect((await post(path, 'internal')).status).toBe(403);
      expect((await post(path)).status).toBe(401);
    }
    expect(provider.openPullRequest).not.toHaveBeenCalled();
    expect(provider.createComment).toHaveBeenCalledTimes(1);
    expect(provider.approvePullRequest).not.toHaveBeenCalled();
    // A read-only credential remains denied at the outer scope boundary.
    expect((await post('/1/comments', 'read-only')).status).toBe(403);
    expect(provider.createComment).toHaveBeenCalledTimes(1);
  });
});

describe('revision-bound review routes', () => {
  test('reads a snapshot at the exact repository route and disables caching', async () => {
    const fixture = app('operator');
    const response = await fixture.app.request(
      '/github/github.com/o/r/17/review',
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(fixture.provider.getReviewSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: expect.objectContaining({ owner: 'o', name: 'r' }),
      }),
      '17',
    );
  });
  test('validates input and denies missing operators before invoking a review write', async () => {
    const unauth = app();
    const input = { action: 'approve', expectedHeadSha: 'a'.repeat(40) };
    expect(
      (
        await unauth.app.request('/github/github.com/o/r/17/review', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        })
      ).status,
    ).toBe(403);
    expect(unauth.provider.submitReview).not.toHaveBeenCalled();
    const fixture = app('operator');
    for (const body of [
      { ...input, expectedHeadSha: 'branch' },
      { ...input, action: 'merge' },
      { ...input, extra: true },
    ]) {
      expect(
        (
          await fixture.app.request('/github/github.com/o/r/17/review', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(400);
    }
    expect(fixture.provider.submitReview).not.toHaveBeenCalled();
  });
  test('capability refusal and repository mismatch cannot submit; approved input reaches provider exactly', async () => {
    const fixture = app('operator');
    const input = { action: 'approve', expectedHeadSha: 'a'.repeat(40) };
    const send = (owner = 'o') =>
      fixture.app.request(`/github/github.com/${owner}/r/17/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
    expect((await send('different')).status).toBe(404);
    expect(fixture.provider.submitReview).not.toHaveBeenCalled();
    fixture.provider.getAvailability.mockResolvedValueOnce({
      available: true,
      effectiveCapabilities: { ...caps, approve: false },
      effectiveMergeMethods: [],
      mergeMethodsSource: 'provider-default',
    });
    expect((await send()).status).toBe(409);
    expect(fixture.provider.submitReview).not.toHaveBeenCalled();
    expect((await send()).status).toBe(200);
    expect(fixture.provider.submitReview).toHaveBeenCalledWith(
      expect.anything(),
      '17',
      input,
      { isCurrent: expect.any(Function) },
    );
  });

  test('does not publish a review read after Station authority changes', async () => {
    const authority = { current: true, operator: 'operator' };
    const fixture = app('operator', authority);
    fixture.provider.getReviewSnapshot.mockImplementationOnce(async () => {
      authority.current = false;
      return { available: true, data: { secret: 'provider response' } };
    });
    const response = await fixture.app.request(
      '/github/github.com/o/r/17/review',
    );
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('provider response');
  });

  test('rechecks operator and principal immediately before review and merge effects', async () => {
    const authority = { current: true, operator: 'operator' };
    const fixture = app('operator', authority);
    const input = { action: 'approve', expectedHeadSha: 'a'.repeat(40) };
    fixture.provider.submitReview.mockImplementationOnce(
      async (
        _context: unknown,
        _ref: string,
        _input: unknown,
        admission: { isCurrent: () => boolean },
      ) => {
        authority.current = false;
        expect(admission.isCurrent()).toBe(false);
        return {
          available: false,
          reason: 'stale authority',
          effectiveCapabilities: caps,
          effectiveMergeMethods: ['squash'],
          mergeMethodsSource: 'provider-default',
        };
      },
    );
    expect(
      (
        await fixture.app.request('/github/github.com/o/r/17/review', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        })
      ).status,
    ).toBe(200);

    authority.current = true;
    fixture.provider.mergePullRequest.mockImplementationOnce(
      async (
        _context: unknown,
        _ref: string,
        _input: unknown,
        admission: { isCurrent: () => boolean },
      ) => {
        authority.operator = 'different';
        expect(admission.isCurrent()).toBe(false);
        return {
          available: false,
          reason: 'stale operator',
          effectiveCapabilities: caps,
          effectiveMergeMethods: ['squash'],
          mergeMethodsSource: 'provider-default',
        };
      },
    );
    expect(
      (
        await fixture.app.request('/github/github.com/o/r/17/merge', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            method: 'squash',
            expectedHeadSha: 'a'.repeat(40),
          }),
        })
      ).status,
    ).toBe(200);
  });
});

describe('pull request reads say why they cannot be served', () => {
  test('a refused checkout carries the resolver reason, not "Provider unavailable"', async () => {
    const routes = createPullRequestRoutes(
      () => [],
      async () => ({
        available: false,
        reason: 'Checkout forge host is ambiguous or unsupported',
      }),
      { operatorIdentityForRequest: () => undefined },
    );
    const response = await routes.request(
      '/github/github.com/o/r/7/review?project=station',
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Checkout forge host is ambiguous or unsupported',
    });
  });

  test('another repository is named as such', async () => {
    const response = await app().app.request(
      '/github/github.com/o/other/7/review?project=station',
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/different repository/);
  });

  test('owner and repository match case-insensitively, as on the forge', async () => {
    const x = app();
    const response = await x.app.request(
      '/github/github.com/O/R/7/review?project=station',
    );
    expect(response.status).toBe(200);
    // The provider reads with the checkout's own spelling.
    expect(x.provider.getReviewSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: expect.objectContaining({ owner: 'o', name: 'r' }),
      }),
      '7',
    );
  });
});

describe('what each route asks of the checkout (#2474, #2475)', () => {
  function recording() {
    const requests: { requireBranchState: boolean; repository?: unknown }[] =
      [];
    const routes = createPullRequestRoutes(
      () => [],
      async (_c, request) => {
        requests.push(request);
        return { available: false, reason: 'recorded' };
      },
      { operatorIdentityForRequest: () => 'operator' },
    );
    return { routes, requests };
  }

  test('reads and actions on pull request #N resolve without branch state', async () => {
    const { routes, requests } = recording();
    await routes.request('/github/github.com/o/r?project=p');
    await routes.request('/github/github.com/o/r/7?project=p');
    await routes.request('/github/github.com/o/r/7/review?project=p');
    await routes.request('/context?project=p');
    const post = (path: string, body: unknown) =>
      routes.request(`/github/github.com/o/r/7/${path}?project=p`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const sha = 'a'.repeat(40);
    await post('comments', { body: 'hi' });
    await post('approve', {});
    await post('merge', { method: 'merge' });
    await post('review', { action: 'approve', expectedHeadSha: sha });
    expect(requests).toHaveLength(8);
    expect(requests.map((r) => r.requireBranchState)).toEqual(
      Array(8).fill(false),
    );
    expect(requests[2]?.repository).toEqual({
      host: 'github.com',
      owner: 'o',
      name: 'r',
    });
  });

  test('opening a pull request from the current branch still requires it', async () => {
    const { routes, requests } = recording();
    await routes.request('/github/github.com/o/r/open?project=p', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't' }),
    });
    expect(requests).toEqual([
      expect.objectContaining({ requireBranchState: true }),
    ]);
  });
});

test('guide route resolves the forge head, strips obsolete anchors, classifies read failures and refuses unauthenticated generation', async () => {
  const home = makeTempDir('station-guide-route-');
  try {
    const store = new PullRequestReviewGuideStore(home);
    const identity = {
      provider: 'github',
      host: 'github.com',
      repository: { owner: 'o', name: 'r' },
      ref: '17',
    };
    store.write(identity, {
      headSha: 'a'.repeat(40),
      generatedAt: new Date().toISOString(),
      modelSelection: 'model',
      stops: [
        {
          title: 'Old tour',
          summary: '',
          attention: null,
          excerpts: [
            { path: 'a.ts', side: 'new', start: 1, end: 1, caption: '' },
          ],
          files: [],
          notes: [],
          questions: [],
        },
      ],
    });
    const snapshot: PullRequestReviewSnapshot = {
      headSha: 'b'.repeat(40),
      baseSha: 'c'.repeat(40),
      observedAt: new Date().toISOString(),
      pullRequest: {
        provider: 'github',
        host: 'github.com',
        ref: '17',
        title: 'Changed',
        body: null,
        url: 'https://github.com/o/r/pull/17',
        repository: identity.repository,
        author: { login: 'author' },
        sourceBranch: 'feature',
        targetBranch: 'main',
        state: 'OPEN',
        commits: 1,
        reviewStatus: '',
        comments: 0,
        nativeId: '17',
        mergeability: 'unknown',
      },
      diff: { state: 'available', patch: '', completeness: 'provider-output' },
      discussion: [],
      discussionPartial: false,
      checks: { state: 'available', checks: [], partial: false },
    };
    const provider = new GitHubPullRequestProvider();
    vi.spyOn(provider, 'getReviewSnapshot').mockResolvedValue({
      available: true,
      data: snapshot,
      effectiveCapabilities: caps,
      effectiveMergeMethods: [],
      mergeMethodsSource: 'provider-default',
    });
    let enabled = true;
    const generate = vi.fn();
    const guides = new PullRequestReviewGuideService(
      store,
      () => ({ enabled, model: 'model', instructions: '' }),
      generate,
      () => {},
    );
    const routes = createPullRequestRoutes(() => [provider], context, {
      operatorIdentityForRequest: () => undefined,
      guides,
    });
    const url = '/github/github.com/o/r/17/guide?project=p';
    const read = await routes.request(url);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      success: true,
      data: {
        currentHeadSha: snapshot.headSha,
        guide: { headSha: 'a'.repeat(40), stops: [{ excerpts: [] }] },
        excerptContents: [],
      },
    });
    expect((await routes.request(url, { method: 'POST' })).status).toBe(403);
    expect(
      (await routes.request('/github/github.com/other/r/17/guide?project=p'))
        .status,
    ).toBe(404);
    writeFileSync(
      join(home, 'pull-request-guides', store.key(identity), 'latest.json'),
      '{broken',
    );
    const corrupt = await routes.request(url);
    expect(corrupt.status).toBe(409);
    expect(await corrupt.json()).toEqual({
      success: false,
      error:
        'The saved guide could not be read. Check server storage or rewrite the guide.',
    });
    vi.spyOn(provider, 'getReviewSnapshot').mockImplementation(async () => {
      enabled = false;
      return {
        available: true,
        data: snapshot,
        effectiveCapabilities: caps,
        effectiveMergeMethods: [],
        mergeMethodsSource: 'provider-default',
      };
    });
    const disabled = await routes.request(url);
    expect(disabled.status).toBe(409);
    expect(await disabled.json()).toEqual({
      success: false,
      error:
        'Enable review guides and configure a review guide or structure model.',
    });
    expect(generate).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

test('authorized guide POST retains its access lease until the model result is saved', async () => {
  const f = await guideFixture(makeTempDir);
  let current = true;
  let finish!: (value: unknown) => void;
  const answer = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  const generate = vi.fn(() => answer);
  const guides = new PullRequestReviewGuideService(
    f.store,
    () => ({ enabled: true, model: 'model', instructions: '' }),
    generate,
    () => {},
  );
  const provider = new GitHubPullRequestProvider();
  const snapshot = vi.spyOn(provider, 'getReviewSnapshot').mockResolvedValue({
    available: true,
    data: f.snapshot,
    effectiveCapabilities: caps,
    effectiveMergeMethods: [],
    mergeMethodsSource: 'provider-default',
  });
  const routes = createPullRequestRoutes(
    () => [provider],
    async () => ({ available: true, context: f.context }),
    {
      guides,
      operatorIdentityForRequest: () => 'operator',
      isRequestPrincipalCurrent: () => current,
    },
  );
  const response = await routes.request(
    '/github/github.com/team/repo/17/guide?project=p',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    success: true,
    data: {
      enabled: true,
      run: { state: 'Running', headSha: f.snapshot.headSha },
    },
  });
  expect(snapshot).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce(), {
    timeout: 15_000,
  });
  current = false;
  finish({
    stops: [
      {
        title: 'Tour',
        summary: '',
        attention: null,
        excerpts: [],
        files: [],
        notes: [],
        questions: [],
      },
    ],
  });
  const identity = {
    provider: 'github',
    host: 'github.com',
    repository: { owner: 'team', name: 'repo' },
    ref: '17',
  };
  await vi.waitFor(() =>
    expect(guides.status(identity).run).toMatchObject({
      state: 'Failed',
      detail: expect.stringContaining('access changed'),
    }),
  );
  expect(f.store.read(identity, f.snapshot.headSha)).toBeNull();
  vi.restoreAllMocks();
});

test('guide status polling and over-capacity admission do not read a forge snapshot', async () => {
  const f = await guideFixture(makeTempDir);
  let finish!: (value: unknown) => void;
  const answer = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  const generate = vi.fn(() => answer);
  const guides = new PullRequestReviewGuideService(
    f.store,
    () => ({ enabled: true, model: 'model', instructions: '' }),
    generate,
    () => {},
  );
  const provider = new GitHubPullRequestProvider();
  const read = vi.spyOn(provider, 'getReviewSnapshot').mockResolvedValue({
    available: true,
    data: f.snapshot,
    effectiveCapabilities: caps,
    effectiveMergeMethods: [],
    mergeMethodsSource: 'provider-default',
  });
  const identity = {
    provider: 'github',
    host: 'github.com',
    repository: { owner: 'team', name: 'repo' },
    ref: '17',
  };
  const routes = createPullRequestRoutes(
    () => [provider],
    async () => ({ available: true, context: f.context }),
    { guides, operatorIdentityForRequest: () => 'operator' },
  );
  try {
    for (const ref of ['17', '18'])
      guides.start({
        identity: { ...identity, ref },
        context: f.context,
        snapshot: f.snapshot,
      });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2), {
      timeout: 15_000,
    });
    for (let i = 0; i < 3; i++) {
      const response = await routes.request(
        '/github/github.com/team/repo/17/guide?project=p&status=1',
      );
      expect(await response.json()).toMatchObject({
        data: { run: { state: 'Running' } },
      });
    }
    const refused = await routes.request(
      '/github/github.com/team/repo/19/guide?project=p',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: expect.stringContaining('Two review guides'),
    });
    expect(read).not.toHaveBeenCalled();
    expect(
      (await routes.request('/github/github.com/team/repo/17/guide?project=p'))
        .status,
    ).toBe(200);
    expect(read).toHaveBeenCalledOnce();
  } finally {
    finish({
      stops: [
        {
          title: 'Tour',
          summary: '',
          attention: null,
          excerpts: [],
          files: [],
          notes: [],
          questions: [],
        },
      ],
    });
    await vi.waitFor(
      () =>
        expect(
          ['17', '18'].every(
            (ref) =>
              guides.status({ ...identity, ref }).run?.state !== 'Running',
          ),
        ).toBe(true),
      { timeout: 15_000 },
    );
    vi.restoreAllMocks();
  }
});
