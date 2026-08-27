import { describe, expect, test, vi } from 'vitest';
import type { IntegrationSecretResolution } from '../../secrets/secret-binding-administration.js';
import {
  decideExternalMonitor,
  parseGitHubPullRequestTarget,
  probeGitHubPullRequest,
} from '../external-monitor.js';

const config = {
  kind: 'github-pull-request' as const,
  objective: 'review-ready' as const,
  target: 'https://github.com/kontourai/station/pull/4210',
  projectId: 'project-1',
  agentId: 'review-agent',
};

const pull = () => ({
  id: 1,
  number: 4210,
  state: 'open',
  draft: false,
  head: { sha: 'a' },
  updated_at: '2026-01-01T00:00:00Z',
  mergeable: true,
  mergeable_state: 'clean',
});

function githubResponse(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), init);
}

describe('external GitHub monitor', () => {
  test('accepts only a fixed GitHub pull-request target', () => {
    expect(parseGitHubPullRequestTarget(config.target)).toEqual({
      owner: 'kontourai',
      repository: 'station',
      number: 4210,
    });
    for (const target of [
      'http://github.com/kontourai/station/pull/1',
      'https://github.com/kontourai/station/issues/1',
      'https://api.github.com/repos/kontourai/station/pulls/1',
      'https://github.com/kontourai/station/pull/1?next=x',
    ])
      expect(() => parseGitHubPullRequestTarget(target)).toThrow();
  });

  test('records a first actionable revision as a zero-turn baseline', () => {
    const decision = decideExternalMonitor({
      observation: {
        outcome: 'pending',
        observedAt: '2026-01-01T00:00:00.000Z',
        fingerprint: 'a',
      },
      actionable: true,
    });
    expect(decision).toMatchObject({
      outcome: 'baseline',
      shouldDispatch: false,
    });
  });

  test('is deterministic and dispatches only a changed actionable revision', () => {
    const observation = {
      outcome: 'pending' as const,
      observedAt: '2026-01-01T00:00:00.000Z',
      fingerprint: 'b',
    };
    expect(
      decideExternalMonitor({
        state: { lastSuccessfulFingerprint: 'b', usageKnown: true },
        observation,
        actionable: true,
      }).outcome,
    ).toBe('unchanged');
    expect(
      decideExternalMonitor({
        state: { lastSuccessfulFingerprint: 'a', usageKnown: true },
        observation,
        actionable: true,
      }),
    ).toMatchObject({ outcome: 'actionable', shouldDispatch: true });
    expect(
      decideExternalMonitor({
        state: { lastSuccessfulFingerprint: 'a', usageKnown: false },
        observation,
        actionable: true,
      }).outcome,
    ).toBe('budget-exhausted');
  });

  test('refuses redirects and bounds probe body diagnostics', async () => {
    const result = await probeGitHubPullRequest(
      config,
      async () => new Response('x'.repeat(130_000), { status: 200 }),
    );
    expect(result.observation.outcome).toBe('unavailable');
    expect(result.observation.detail).not.toContain('x'.repeat(20));
  });

  test('uses and settles only the exact secret binding', async () => {
    const settle = vi.fn();
    const resolver = {
      resolveForIntegration: vi.fn().mockResolvedValue({
        environment: { GITHUB_TOKEN: 'not-retained' },
        settlement: { settle },
      }),
    };
    const result = await probeGitHubPullRequest(
      { ...config, credentialSecretBinding: 'github-token' },
      async (url, init) => {
        expect((init.headers as Record<string, string>).Authorization).toBe(
          'Bearer not-retained',
        );
        if (url.includes('/check-runs'))
          return new Response(JSON.stringify({ check_runs: [] }));
        if (url.includes('/reviews')) return new Response(JSON.stringify([]));
        return new Response(
          JSON.stringify({
            id: 1,
            number: 4210,
            state: 'open',
            draft: false,
            head: { sha: 'a' },
            updated_at: '2026-01-01T00:00:00Z',
            mergeable: true,
            mergeable_state: 'clean',
          }),
        );
      },
      resolver,
    );
    expect(result.actionable).toBe(false);
    expect(resolver.resolveForIntegration).toHaveBeenCalledWith({
      integrationId: 'external-monitor:github-pull-request',
      secretEnvRefs: { GITHUB_TOKEN: 'github-token' },
    });
    expect(settle).toHaveBeenCalledWith({ outcome: 'success' });
  });

  test('treats a clean review-ready pull request as a terminal success', async () => {
    const result = await probeGitHubPullRequest(config, async (url) => {
      if (url.includes('/pulls/4210') && !url.includes('/reviews'))
        return githubResponse(pull());
      if (url.includes('/check-runs'))
        return githubResponse({ total_count: 0, check_runs: [] });
      return githubResponse([]);
    });
    expect(result).toMatchObject({
      actionable: false,
      observation: {
        outcome: 'terminal',
        detail: 'Pull request is review-ready.',
      },
    });
  });

  test('leaves an actually pending pull request nonterminal', async () => {
    const result = await probeGitHubPullRequest(config, async (url) => {
      if (url.includes('/pulls/4210') && !url.includes('/reviews'))
        return githubResponse({ ...pull(), draft: true });
      if (url.includes('/check-runs'))
        return githubResponse({ total_count: 0, check_runs: [] });
      return githubResponse([]);
    });
    expect(result).toMatchObject({
      actionable: false,
      observation: { outcome: 'pending' },
    });
  });

  test('treats GitHub authorization separately from rate limits', async () => {
    expect(
      (
        await probeGitHubPullRequest(
          config,
          async () => new Response('', { status: 401 }),
        )
      ).observation.outcome,
    ).toBe('unauthorized');
    expect(
      (
        await probeGitHubPullRequest(
          config,
          async () => new Response('', { status: 429 }),
        )
      ).observation.outcome,
    ).toBe('unavailable');
  });

  test('reads the decisive 101st check page within the bounded page budget', async () => {
    const rows = Array.from({ length: 100 }, (_, id) => ({
      name: `ok-${id}`,
      status: 'completed',
      conclusion: 'success',
    }));
    const result = await probeGitHubPullRequest(config, async (url) => {
      if (url.includes('/pulls/4210') && !url.includes('/reviews'))
        return githubResponse(pull());
      if (url.includes('/check-runs') && url.includes('page=2'))
        return githubResponse({
          total_count: 101,
          check_runs: [
            { name: 'decisive', status: 'completed', conclusion: 'failure' },
          ],
        });
      if (url.includes('/check-runs'))
        return githubResponse(
          { total_count: 101, check_runs: rows },
          {
            headers: {
              Link: '<https://api.github.com/repos/kontourai/station/commits/a/check-runs?per_page=100&page=2>; rel="next"',
            },
          },
        );
      return githubResponse([]);
    });
    expect(result.actionable).toBe(true);
  });

  test('folds reviews to each reviewer’s latest state', async () => {
    const result = await probeGitHubPullRequest(config, async (url) => {
      if (url.includes('/pulls/4210') && !url.includes('/reviews'))
        return githubResponse(pull());
      if (url.includes('/check-runs'))
        return githubResponse({ total_count: 0, check_runs: [] });
      return githubResponse([
        {
          id: 1,
          state: 'CHANGES_REQUESTED',
          submitted_at: '2026-01-01T00:00:00Z',
          user: { login: 'reviewer' },
        },
        {
          id: 2,
          state: 'APPROVED',
          submitted_at: '2026-01-02T00:00:00Z',
          user: { login: 'reviewer' },
        },
      ]);
    });
    expect(result.actionable).toBe(false);
  });

  test('refuses a paginated response whose declared total is incomplete', async () => {
    const result = await probeGitHubPullRequest(config, async (url) => {
      if (url.includes('/pulls/4210') && !url.includes('/reviews'))
        return githubResponse(pull());
      if (url.includes('/check-runs'))
        return githubResponse({ total_count: 101, check_runs: [] });
      return githubResponse([]);
    });
    expect(result.observation.outcome).toBe('unavailable');
  });

  test('bounds secret establishment by the same total deadline', async () => {
    vi.useFakeTimers();
    try {
      const resolver = {
        resolveForIntegration: vi.fn(() => new Promise<never>(() => {})),
      };
      const pending = probeGitHubPullRequest(
        { ...config, credentialSecretBinding: 'github-token' },
        vi.fn(),
        resolver,
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toMatchObject({
        observation: { outcome: 'unavailable' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('settles a secret grant that resolves after the probe deadline', async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (value: IntegrationSecretResolution) => void;
      const settle = vi.fn();
      const resolver = {
        resolveForIntegration: vi.fn(
          () =>
            new Promise<IntegrationSecretResolution>((done) => {
              resolve = done;
            }),
        ),
      };
      const pending = probeGitHubPullRequest(
        { ...config, credentialSecretBinding: 'github-token' },
        vi.fn(),
        resolver,
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toMatchObject({
        observation: { outcome: 'unavailable' },
      });
      resolve({
        environment: { GITHUB_TOKEN: 'never-retained' },
        settlement: { settle },
      });
      await Promise.resolve();
      expect(settle).toHaveBeenCalledWith({
        outcome: 'failure',
        reason: 'child_establishment_failed',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('classifies secondary-limit 403 as unavailable, not authorization', async () => {
    const result = await probeGitHubPullRequest(
      config,
      async () =>
        new Response('', { status: 403, headers: { 'retry-after': '60' } }),
    );
    expect(result.observation).toMatchObject({
      outcome: 'unavailable',
      detail: 'GitHub rate limit prevented this probe.',
    });
    const abuse = await probeGitHubPullRequest(config, async () =>
      githubResponse(
        { message: 'You have exceeded a secondary rate limit.' },
        { status: 403 },
      ),
    );
    expect(abuse.observation.outcome).toBe('unavailable');
  });
});
