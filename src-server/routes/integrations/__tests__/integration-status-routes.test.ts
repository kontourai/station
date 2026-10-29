import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IntegrationConnectionStatus } from '@kontourai/station-contracts/integration-status';
import { parseIntegrationStatus } from '@kontourai/station-contracts/integration-status';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  createIntegrationStatusProbes,
  createIntegrationStatusReader,
} from '../../../services/integrations/integration-status-service.js';
import { InboundWebhookConfigurationStore } from '../../../services/webhooks/inbound-webhook-store.js';
import type { execGitContextCommand } from '../../../utils/git-exec.js';
import { createIntegrationStatusRoutes } from '../integration-status-routes.js';

function route(
  readStatus: ReturnType<typeof createIntegrationStatusReader>,
  mayRead = () => true,
) {
  const app = new Hono();
  app.route(
    '/api/integrations/status',
    createIntegrationStatusRoutes({ readStatus, mayRead }),
  );
  return app;
}

async function read(app: Hono) {
  const response = await app.request('/api/integrations/status');
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const body = await readJson<{ success: boolean; data: unknown }>(response);
  const status = parseIntegrationStatus(body.data);
  expect(body.success).toBe(true);
  expect(status).not.toBeNull();
  return status!;
}

describe('integration status route', () => {
  const makeTempDir = trackTempDirs();
  test('no capability without a computation: every returned action is the result of a probe that ran', async () => {
    const expected: IntegrationConnectionStatus[] = [
      {
        connectionId: 'github',
        provider: 'github',
        actions: [
          {
            action: 'read',
            computedBy: 'github.probe',
            state: 'failed',
            reason: 'github probe failure',
          },
        ],
      },
      {
        connectionId: 'discord',
        provider: 'discord',
        actions: [
          {
            action: 'continue',
            computedBy: 'discord.probe',
            state: 'works',
            reason: 'discord probe result',
          },
        ],
      },
      {
        connectionId: 'slack',
        provider: 'slack',
        actions: [
          {
            action: 'notify',
            computedBy: 'slack.probe',
            state: 'unsupported',
            reason: 'slack probe result',
          },
        ],
      },
      {
        connectionId: 'webhook',
        provider: 'webhook',
        actions: [
          {
            action: 'start',
            computedBy: 'webhook.probe',
            state: 'failed',
            reason: 'webhook probe failure',
          },
        ],
      },
      {
        connectionId: 'linear',
        provider: 'linear',
        actions: [
          {
            action: 'write',
            computedBy: 'linear.probe',
            state: 'waiting-on-provider',
            reason: 'linear probe result',
          },
        ],
      },
      {
        connectionId: 'jira',
        provider: 'jira',
        actions: [
          {
            action: 'write',
            computedBy: 'jira.probe',
            state: 'waiting-on-provider',
            reason: 'jira probe result',
          },
        ],
      },
    ];
    const probes = expected.map((result) => ({
      run: vi.fn(async () => structuredClone(result)),
    }));
    const status = await read(route(createIntegrationStatusReader(probes)));
    expect(status.connections).toEqual(expected);
    for (const probe of probes) expect(probe.run).toHaveBeenCalledOnce();
  });

  test('reports live probe results, failures, and unavailable upstream actions', async () => {
    const exec = vi.fn(async () => {
      throw Object.assign(new Error('not signed in'), { code: 4 });
    });
    const discord = vi.fn(() => ({
      state: 'failed' as const,
      reason: 'Gateway authentication failed.',
    }));
    const webhook = vi.fn(() => ({
      schemaVersion: 1 as const,
      enabled: true,
      tokens: [
        {
          id: 'x',
          name: 'x',
          secret: 'x'.repeat(32),
          starts: [{ agentId: 'agent' }],
        },
      ],
    }));
    const app = route(
      createIntegrationStatusReader(
        createIntegrationStatusProbes({
          exec: exec as typeof execGitContextCommand,
          readDiscord: discord,
          readWebhook: webhook,
        }),
      ),
    );
    const status = await read(app);
    const byProvider = Object.fromEntries(
      status.connections.map((item) => [item.provider, item]),
    );
    expect(
      byProvider.github.actions.find((item) => item.action === 'read'),
    ).toEqual({
      action: 'read',
      computedBy: 'github.gh-auth-status',
      state: 'failed',
      reason: 'GitHub CLI is not signed in to github.com.',
    });
    expect(
      byProvider.discord.actions.find((item) => item.action === 'continue'),
    ).toEqual({
      action: 'continue',
      computedBy: 'discord.gateway',
      state: 'failed',
      reason: 'Gateway authentication failed.',
    });
    expect(byProvider.webhook.actions[0]).toMatchObject({
      action: 'start',
      computedBy: 'webhook.configuration',
      state: 'unverified',
    });
    expect(
      byProvider.slack.actions.every(
        (item) =>
          item.state === 'unsupported' &&
          item.reason.includes('not configured'),
      ),
    ).toBe(true);
    for (const provider of ['linear', 'jira']) {
      expect(
        byProvider[provider].actions.every(
          (item) =>
            item.state === 'waiting-on-provider' &&
            item.reason.includes('#1508') &&
            item.reason.includes('#1510'),
        ),
      ).toBe(true);
    }
    expect(discord).toHaveBeenCalledOnce();
    expect(webhook).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledWith(
      'gh',
      ['auth', 'status', '--hostname', 'github.com'],
      expect.objectContaining({ windowsHide: true, timeout: 5000 }),
    );
  });

  test('reports a GitHub output limit as the failure instead of a timeout', async () => {
    const exec = vi.fn<typeof execGitContextCommand>(async () => {
      throw Object.assign(new Error('output limit'), {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        killed: true,
      });
    });
    const app = route(
      createIntegrationStatusReader(
        createIntegrationStatusProbes({
          exec,
          readDiscord: () => ({
            state: 'unavailable',
            reason: 'Not configured.',
          }),
          readWebhook: () => ({ schemaVersion: 1 }),
        }),
      ),
    );
    expect((await read(app)).connections[0].actions[0]).toMatchObject({
      state: 'failed',
      reason: 'GitHub authentication check exceeded its output limit.',
    });
  });

  test('bounds a hung GitHub probe and returns a failed timeout', async () => {
    vi.useFakeTimers();
    try {
      const exec = vi.fn<typeof execGitContextCommand>(
        (_command, _args, options) =>
          new Promise<never>((_, reject) => {
            options?.signal?.addEventListener('abort', () =>
              reject(new Error('executor aborted')),
            );
          }),
      );
      const app = route(
        createIntegrationStatusReader(
          createIntegrationStatusProbes({
            exec,
            readDiscord: () => ({
              state: 'unavailable',
              reason: 'Not configured.',
            }),
            readWebhook: () => ({ schemaVersion: 1 }),
            githubTimeoutMs: 50,
          }),
        ),
      );
      const result = read(app);
      await vi.advanceTimersByTimeAsync(50);
      const status = await result;
      expect(status.connections[0].actions[0]).toMatchObject({
        state: 'failed',
        reason: 'GitHub authentication check timed out.',
      });
      expect(exec.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('coalesces concurrent checks and caches the GitHub result until TTL expires', async () => {
    let now = 1_000;
    const exec = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const app = route(
      createIntegrationStatusReader(
        createIntegrationStatusProbes({
          exec: exec as typeof execGitContextCommand,
          readDiscord: () => ({
            state: 'connected',
            reason: 'Gateway connected.',
          }),
          readWebhook: () => ({ schemaVersion: 1 }),
          now: () => now,
          githubCacheMs: 100,
        }),
      ),
    );
    const [first, second] = await Promise.all([read(app), read(app)]);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(first.connections[0].actions[0]).toMatchObject({
      state: 'unverified',
      reason: expect.stringContaining('permissions have not been checked'),
    });
    expect(second).toEqual(first);
    await read(app);
    expect(exec).toHaveBeenCalledTimes(1);
    now += 100;
    await read(app);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  test('rereads webhook configuration and reports disabled, revoked and unreadable states', async () => {
    const readWebhook = vi
      .fn()
      .mockReturnValueOnce({ schemaVersion: 1, enabled: false })
      .mockReturnValueOnce({
        schemaVersion: 1,
        enabled: true,
        tokens: [
          {
            id: 'x',
            name: 'x',
            secret: 'x'.repeat(32),
            revokedAt: '2026-01-01',
            starts: [{ agentId: 'agent' }],
          },
        ],
      })
      .mockImplementationOnce(() => {
        throw new Error('corrupt configuration');
      });
    const app = route(
      createIntegrationStatusReader(
        createIntegrationStatusProbes({
          exec: vi.fn<typeof execGitContextCommand>(async () => ({
            stdout: '',
            stderr: '',
          })),
          readDiscord: () => ({
            state: 'unavailable',
            reason: 'Not configured.',
          }),
          readWebhook,
        }),
      ),
    );
    const webhook = async () =>
      (await read(app)).connections.find((item) => item.provider === 'webhook')!
        .actions[0];
    expect(await webhook()).toMatchObject({
      state: 'unsupported',
      reason: 'Inbound webhooks are not enabled.',
    });
    expect(await webhook()).toMatchObject({
      state: 'unsupported',
      reason: 'No active webhook token has a start grant.',
    });
    expect(await webhook()).toMatchObject({
      state: 'failed',
      reason: 'Inbound webhook configuration could not be read.',
    });
    expect(readWebhook).toHaveBeenCalledTimes(3);
  });

  test('reads the real webhook store without exposing its secret', async () => {
    const home = makeTempDir('integration-status-webhook-');
    const store = new InboundWebhookConfigurationStore(home);
    const secret = 'private-webhook-secret-'.repeat(3);
    const token = {
      id: 'ci',
      name: 'CI',
      secret,
      starts: [{ agentId: 'agent' }],
    };
    store.write({ schemaVersion: 1, enabled: true, tokens: [token] });
    const app = route(
      createIntegrationStatusReader(
        createIntegrationStatusProbes({
          exec: vi.fn<typeof execGitContextCommand>(async () => ({
            stdout: '',
            stderr: '',
          })),
          readDiscord: () => ({
            state: 'unavailable',
            reason: 'Not configured.',
          }),
          readWebhook: () => store.read(),
        }),
      ),
    );
    const webhook = async () =>
      (await read(app)).connections.find((item) => item.provider === 'webhook')!
        .actions[0];
    const status = await read(app);
    expect(
      status.connections.find((item) => item.provider === 'webhook')
        ?.actions[0],
    ).toMatchObject({
      state: 'unverified',
      reason: expect.stringContaining('active start grant'),
    });
    expect(JSON.stringify(status)).not.toContain(secret);
    store.write({
      schemaVersion: 1,
      enabled: true,
      tokens: [{ ...token, revokedAt: '2026-01-01' }],
    });
    expect(await webhook()).toMatchObject({
      state: 'unsupported',
      reason: 'No active webhook token has a start grant.',
    });
    writeFileSync(join(home, 'security', 'inbound-webhooks.json'), '{invalid');
    expect(await webhook()).toMatchObject({
      state: 'failed',
      reason: 'Inbound webhook configuration could not be read.',
    });
  });

  test('refuses non-operators before probing and rechecks authority after a probe', async () => {
    let current = false;
    const run = vi.fn(async () => {
      current = false;
      return {
        connectionId: 'github',
        provider: 'github' as const,
        actions: [],
      };
    });
    const app = route(createIntegrationStatusReader([{ run }]), () => current);
    expect((await app.request('/api/integrations/status')).status).toBe(403);
    expect(run).not.toHaveBeenCalled();
    current = true;
    expect((await app.request('/api/integrations/status')).status).toBe(403);
    expect(run).toHaveBeenCalledOnce();
  });
});
