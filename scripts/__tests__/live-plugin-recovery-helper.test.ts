import { describe, expect, test } from 'vitest';
import { recoverPluginOnce } from '../../tests/live/helpers/station-instance.mjs';

/**
 * A fake paired page: `api()` runs its fetch inside `page.evaluate`, so the
 * page answers each request from a route table and records what was sent.
 */
function pageFixture(
  routes: Record<string, (body?: unknown) => [number, unknown]>,
) {
  const sent: Array<{ method: string; path: string; body?: unknown }> = [];
  const page = {
    evaluate: async (
      _fn: unknown,
      args: { method: string; path: string; body?: unknown },
    ) => {
      sent.push({ method: args.method, path: args.path, body: args.body });
      const route = routes[`${args.method} ${args.path}`];
      if (!route) return { status: 404, payload: { success: false } };
      const [status, payload] = route(args.body);
      return { status, payload };
    },
  };
  return { page, sent };
}

const review = {
  recoveryRevision: 'review-1',
  contentDigest: 'sha256:retained',
  grantRevision: 'grant-1',
  permissions: { required: ['plugin.server'] },
  dependencies: [
    {
      id: 'child',
      consent: {
        contentDigest: 'sha256:child',
        permissions: [],
        dependencies: [],
      },
    },
  ],
};

describe('recoverPluginOnce', () => {
  test('approves exactly what the review shows and passes once the plugin is ready', async () => {
    const { page, sent } = pageFixture({
      'GET /api/plugins/demo/recovery-preview': () => [200, review],
      'POST /api/plugins/demo/recover': () => [200, { success: true }],
      'GET /api/plugins': () => [
        200,
        {
          plugins: [
            { name: 'demo', installationReadiness: { state: 'ready' } },
          ],
        },
      ],
    });
    await recoverPluginOnce(page, 'demo');
    expect(sent[1]).toEqual({
      method: 'POST',
      path: '/api/plugins/demo/recover',
      body: {
        recoveryRevision: 'review-1',
        consent: {
          contentDigest: 'sha256:retained',
          grantRevision: 'grant-1',
          permissions: ['plugin.server'],
          dependencies: ['child'],
          dependencyApprovals: [
            { id: 'child', ...review.dependencies[0]!.consent },
          ],
        },
      },
    });
  });

  test('a recovery stopped again fails the suite with the readiness named, not as an API failure', async () => {
    const { page } = pageFixture({
      'GET /api/plugins/demo/recovery-preview': () => [200, review],
      'POST /api/plugins/demo/recover': () => [
        202,
        {
          success: false,
          configurationActivation: { status: 'pending', recovery: 'required' },
        },
      ],
      'GET /api/plugins': () => [
        200,
        {
          plugins: [
            {
              name: 'demo',
              installationReadiness: { state: 'pending', recovery: 'review' },
            },
          ],
        },
      ],
    });
    await expect(recoverPluginOnce(page, 'demo')).rejects.toThrow(
      'demo was installed but is not active (readiness pending) after one recovery',
    );
  });
});
