// @vitest-environment node

/**
 * #4517: the settings write paths refuse a setting the managed policy locks,
 * and the read path reports the managed source.
 *
 * Real pieces: the policy comes from the real decoder, a real `ConfigLoader`
 * reads and writes a temp Station home, and requests go through the real
 * config routes. The agent case registers the real station-control
 * `update_config` tool and forwards its HTTP call into those routes, so the
 * refusal is observed where an agent meets it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { summarizeManagedPolicy } from '@kontourai/station-contracts/managed-policy';
import {
  decodeManagedPolicy,
  type LoadedManagedPolicy,
  managedPolicyDigest,
} from '@kontourai/station-shared/managed-policy';
import { McpServer } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { asStationControlCaller } from '../../../__test-utils__/station-control-caller-fixture.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { installManagedAppSettings } from '../../../domain/managed-settings.js';
import { createConfigRoutes } from '../config.js';

const makeTempDir = trackTempDirs();

const DENIAL =
  "Acme's policy manages this setting. For help, visit https://help.example/station";

function policy(
  settings: Record<string, { value: unknown; locked: boolean }>,
): LoadedManagedPolicy {
  const document = decodeManagedPolicy('/test/policy.json', {
    kind: 'value',
    value: {
      schemaVersion: 1,
      organization: 'Acme',
      supportUrl: 'https://help.example/station',
      settings,
    },
  });
  return {
    source: { kind: 'test-override', location: '/test/policy.json' },
    document,
    digest: managedPolicyDigest(document),
    summary: summarizeManagedPolicy(document),
  };
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as never;

async function station(app: Record<string, unknown>) {
  const dir = makeTempDir('station-managed-settings-route-');
  const loader = new ConfigLoader({ projectHomeDir: dir });
  await loader.loadAppConfig();
  const path = join(dir, 'config', 'app.json');
  writeFileSync(
    path,
    JSON.stringify(
      { ...JSON.parse(readFileSync(path, 'utf8')), ...app },
      null,
      2,
    ),
  );
  const routes = new Hono();
  routes.route('/config', createConfigRoutes(loader, logger));
  return {
    routes,
    stored: () => JSON.parse(readFileSync(path, 'utf8')),
    raw: () => readFileSync(path, 'utf8'),
  };
}

const put = (body: unknown) => ({
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

afterEach(() => {
  installManagedAppSettings(null);
  vi.unstubAllGlobals();
});

describe('PUT /config/app with a managed policy', () => {
  test('refuses a locked setting with 403 and the one sentence, and writes nothing', async () => {
    const s = await station({ defaultMaxTurns: 7 });
    installManagedAppSettings(
      policy({ defaultMaxTurns: { value: 40, locked: true } }),
    );
    const before = s.raw();
    const response = await s.routes.request(
      '/config/app',
      put({ defaultMaxTurns: 9, checkoutStaleAfterDays: 4 }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      code: 'managed_setting_locked',
      key: 'defaultMaxTurns',
      error: DENIAL,
    });
    // The whole request is refused, the unlocked key included.
    expect(s.raw()).toBe(before);

    const cleared = await s.routes.request(
      '/config/app',
      put({ defaultMaxTurns: null }),
    );
    expect(cleared.status).toBe(403);
    expect(s.stored().defaultMaxTurns).toBe(7);
  });

  test('resending the locked value is a no-op, and other settings save', async () => {
    const s = await station({ defaultMaxTurns: 7 });
    installManagedAppSettings(
      policy({ defaultMaxTurns: { value: 40, locked: true } }),
    );
    const response = await s.routes.request(
      '/config/app',
      put({ defaultMaxTurns: 40, checkoutStaleAfterDays: 4 }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.defaultMaxTurns).toBe(40);
    // The policy value never reaches the user's file.
    expect(s.stored()).toMatchObject({
      defaultMaxTurns: 7,
      checkoutStaleAfterDays: 4,
    });
  });

  test('a managed default stays changeable', async () => {
    const s = await station({});
    installManagedAppSettings(
      policy({ defaultMaxTurns: { value: 40, locked: false } }),
    );
    const response = await s.routes.request(
      '/config/app',
      put({ defaultMaxTurns: 12 }),
    );
    expect(response.status).toBe(200);
    expect(s.stored().defaultMaxTurns).toBe(12);
  });

  test('the log-level endpoint refuses a locked logLevel the same way', async () => {
    const s = await station({ logLevel: 'info' });
    installManagedAppSettings(
      policy({ logLevel: { value: 'warn', locked: true } }),
    );
    const current = await (
      await s.routes.request('/config/app/log-level')
    ).json();
    const response = await s.routes.request('/config/app/log-level', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': current.revision,
        'Idempotency-Key': 'managed-policy-log-level-01',
      },
      body: JSON.stringify({ value: 'debug' }),
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe(DENIAL);
    expect(s.stored().logLevel).toBe('info');
  });
});

describe('GET /config/app with a managed policy', () => {
  test('returns the managed values and names the managed source, value-free', async () => {
    const s = await station({
      defaultMaxTurns: 7,
      workspaceCheckpoints: false,
    });
    installManagedAppSettings(
      policy({
        defaultMaxTurns: { value: 40, locked: true },
        checkoutStaleAfterDays: { value: 9, locked: false },
        workspaceCheckpoints: { value: true, locked: false },
      }),
    );
    const body = await (await s.routes.request('/config/app')).json();
    expect(body.data.defaultMaxTurns).toBe(40);
    expect(body.data.checkoutStaleAfterDays).toBe(9);
    expect(body.data.workspaceCheckpoints).toBe(false);
    const managed = (locked: boolean) => ({
      source: 'managed',
      locked,
      organization: 'Acme',
      supportUrl: 'https://help.example/station',
    });
    expect(body.provenance.defaultMaxTurns).toEqual(managed(true));
    expect(body.provenance.checkoutStaleAfterDays).toEqual(managed(false));
    expect(body.provenance.workspaceCheckpoints).toEqual({ source: 'file' });
  });
});

describe('the agent tool path', () => {
  test('station-control update_config meets the same refusal', async () => {
    const s = await station({ defaultMaxTurns: 7 });
    installManagedAppSettings(
      policy({ defaultMaxTurns: { value: 40, locked: true } }),
    );
    vi.stubGlobal(
      'fetch',
      (input: string | URL | Request, init?: RequestInit) =>
        s.routes.request(new URL(String(input)).pathname, init),
    );
    const { registerOperationsTools } = await import(
      '../../../tools/station-control-operations-tools.js'
    );
    const { StationControlToolRegistry } = await import(
      '../../../tools/station-control-mcp-server.js'
    );
    const server = new McpServer({
      name: 'managed-settings',
      version: '0.0.0',
    });
    registerOperationsTools(new StationControlToolRegistry(server));
    const registered = (
      server as unknown as {
        _registeredTools: Record<
          string,
          {
            handler: (
              input: unknown,
            ) => Promise<{ content: { text: string }[] }>;
          }
        >;
      }
    )._registeredTools;
    const tools = asStationControlCaller({
      update_config: registered.update_config!.handler,
    });
    const result = await tools.update_config!({
      updates: { defaultMaxTurns: 9 },
    });
    expect(result.content[0]!.text).toContain(DENIAL);
    expect(s.stored().defaultMaxTurns).toBe(7);
  });
});
