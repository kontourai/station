import {
  DEFAULT_GRANT_PAIRING_SCOPE,
  pairingScopePresetString,
} from '@kontourai/station-contracts';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import { RUNTIME_CREDENTIAL_AUTHORITY_VAR } from '../../../security/runtime-request-security.js';
import { GitHubPullRequestProvider } from '../../../services/pull-requests/github-pull-request-provider.js';
import { GitLabPullRequestProvider } from '../../../services/pull-requests/gitlab-pull-request-provider.js';
import { createPullRequestRoutes } from '../pull-request-routes.js';

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
function app(operator?: string) {
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
      operatorIdentityForRequest: () => operator,
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
