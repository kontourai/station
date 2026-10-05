/**
 * Choosing a command Station will run takes the same authority as running
 * commands (`coding:exec`, or the operator in person): an engine connection's
 * command, arguments and folder, a tool server's command and arguments, a
 * Flow evidence command line, and the terminal shell. Answered
 * `403 command-not-granted` with nothing saved or run.
 *
 * Real pairing service and runtime auth boundary in front of the real route
 * modules; the services behind them are recorders.
 */
import { join } from 'node:path';
import {
  PAIRING_SCOPE_CODING_EXEC,
  PAIRING_SCOPE_PRESETS,
  type PairingScopePreset,
  pairingScopePresetString,
} from '@kontourai/station-contracts/environment-security';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { configureRuntimeHttp } from '../../runtime/bootstrap/runtime-http.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import { EnvironmentSecurityService } from '../../services/ssh/environment-security-service.js';
import { createLogger } from '../../utils/logger.js';
import { createToolRoutes } from '../agents/tools.js';
import { createACPRoutes } from '../connections/acp.js';
import { createFlowRunRoutes } from '../evidence/flow-runs.js';
import { TEST_OPERATOR_PRINCIPAL } from '../plugins/__tests__/plugin-visibility-test-support.js';
import { createPluginRoutes } from '../plugins/plugins.js';
import { createRegistryRoutes } from '../plugins/registry.js';
import { createConfigRoutes } from '../system/config.js';

const makeTempDir = trackTempDirs();
afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  vi.stubEnv('STATION_HOSTED_TENANT_REGISTRY_FILE', undefined);
  const root = makeTempDir('station-command-authority-');
  const security = new EnvironmentSecurityService({
    homeDir: join(root, 'home'),
  });
  const operator = await security.initialize();
  const pair = (preset: PairingScopePreset, extra: string[] = []) => {
    const offer = security.devicePairing.createOffer({
      endpoint: 'https://station.example.test',
      scope: pairingScopePresetString(preset),
    });
    const requested = security.devicePairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: preset,
    });
    security.devicePairing.confirmRequest(requested.requestId, {
      kind: 'presented-credential',
    });
    const paired = security.devicePairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: requested.requestId,
    });
    if (extra.length > 0)
      security.devicePairing.setDeviceScope(
        paired.device.id,
        [...PAIRING_SCOPE_PRESETS[preset], ...(extra as never[])],
        { kind: 'presented-credential' },
      );
    return paired.credential;
  };

  const store = {
    acp: [
      {
        id: 'existing',
        name: 'Existing',
        command: 'engine',
        args: ['--a'],
        icon: 'x',
        enabled: true,
      },
      // No `args` and no `cwd` at all, as an older record is stored.
      {
        id: 'plain',
        name: 'Plain',
        command: 'engine',
        icon: 'x',
        enabled: true,
      },
    ] as Array<Record<string, unknown>>,
  };
  const saveACPConfig = vi.fn(async () => undefined);
  const acpCtx = {
    acpBridge: {
      getStatus: () => ({
        connected: false,
        connections: [{ id: 'existing', status: 'available' }],
      }),
      addConnection: vi.fn(async () => false),
      removeConnection: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => true),
    },
    configLoader: {
      loadACPConfig: async () => ({ connections: store.acp }),
      saveACPConfig,
    },
    applyAgentConfigurationMutation: async <T>(
      operation: (begin: () => void) => Promise<T>,
    ) => operation(() => undefined),
  };

  const saveIntegration = vi.fn(async () => undefined);
  const mcpService = {
    saveIntegration,
    getIntegration: vi.fn(async (id: string) => {
      if (id === 'url-tool')
        return {
          id,
          name: 'Remote',
          transport: 'streamable-http',
          endpoint: 'https://tools.example.test/mcp',
        };
      if (id === 'url-with-command')
        return {
          id,
          name: 'Flip',
          transport: 'sse',
          endpoint: 'https://tools.example.test/sse',
          command: 'server',
        };
      if (id === 'tool-1')
        return {
          id,
          name: 'Tool',
          type: 'stdio',
          command: 'server',
          args: ['--x'],
        };
      throw new Error('not found');
    }),
    listIntegrations: vi.fn(async () => []),
    getToolAgentMap: vi.fn(async () => ({})),
  };

  const attachCommandEvidence = vi.fn(async () => ({ attached: true }));
  const updateAppConfig = vi.fn(async (updates: unknown) => updates);
  const configLoader = {
    getProjectHomeDir: () => join(root, 'project-home'),
    loadAppConfig: vi.fn(async () => ({ terminalShell: '/bin/zsh' })),
    updateAppConfig,
    mutateAppConfig: vi.fn(async (mutate: (c: object) => object) =>
      updateAppConfig(mutate({ terminalShell: '/bin/zsh' })),
    ),
  };

  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger: createLogger({ name: 'command-authority-test', level: 'error' }),
    eventBus: { emit() {} } as unknown as EventBus,
    security: {
      verifyCredential: (candidate, request) =>
        request !== undefined &&
        security.authorizeCredential(candidate, request),
      recognizeCredential: (candidate) => security.verifyCredential(candidate),
      resolveGrantedScope: (candidate) =>
        security.resolveGrantedScope(candidate),
      resolveCredentialAuthority: (candidate) =>
        security.verifyOperatorCredential(candidate)
          ? 'operator-credential'
          : security.identifyDevice(candidate)
            ? 'device-credential'
            : undefined,
      resolveCredentialDeviceId: (candidate) =>
        security.identifyDevice(candidate)?.id,
      resolveCredentialLocality: (candidate) =>
        security.credentialLocality(candidate),
      resolveCredentialMintKind: (candidate) =>
        security.credentialMintKind(candidate),
      resolveCredentialDeviceKind: (candidate) => {
        const kind = security.identifyDevice(candidate)?.kind;
        return kind === 'delegation' || kind === 'device' ? kind : undefined;
      },
      allowedOrigins: [],
    },
  });
  app.route('/acp', createACPRoutes(acpCtx as never));
  app.route(
    '/integrations',
    createToolRoutes(mcpService as never, async () => undefined),
  );
  app.route(
    '/api/projects/:slug/flow',
    createFlowRunRoutes(
      { attachCommandEvidence } as never,
      {
        getWorkspacePath: () => '/ws',
      } as never,
    ),
  );
  const pluginHome = join(root, 'plugin-home');
  app.route(
    '/api/plugins',
    createPluginRoutes(
      pluginHome,
      createLogger({ name: 'p', level: 'error' }),
      undefined,
      {
        visibility: {
          service: { canSee: () => true } as never,
          resolvePrincipal: () => TEST_OPERATOR_PRINCIPAL,
          listKnownPrincipals: () => [],
        },
        applyConfigurationMutation: undefined as never,
        settleProviderAdapterRetirements: async () => {},
      },
    ),
  );
  app.route(
    '/api/registry',
    createRegistryRoutes(
      {
        getProjectHomeDir: () => pluginHome,
        loadIntegration: vi.fn(async () => {
          throw new Error('none');
        }),
        saveIntegration: vi.fn(async () => undefined),
      } as never,
      async () => undefined,
    ),
  );
  const configRoutes = createConfigRoutes(
    configLoader as never,
    createLogger({ name: 'c', level: 'error' }),
  );
  app.route('/config', configRoutes);

  const send = async (
    credential: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> => {
    const res = await app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return {
    operator,
    pair,
    send,
    configRoutes,
    recorders: {
      saveACPConfig,
      saveIntegration,
      attachCommandEvidence,
      updateAppConfig,
    },
    acpCtx,
  };
}

type F = Awaited<ReturnType<typeof fixture>>;
const CODE = 'command-not-granted';

const CHOICES = [
  {
    name: 'POST /acp/connections',
    recorder: 'saveACPConfig',
    request: () =>
      [
        'POST',
        '/acp/connections',
        { id: 'mine', command: 'sh', args: ['-c', 'x'] },
      ] as const,
  },
  {
    name: 'PUT /acp/connections/:id changing the command',
    recorder: 'saveACPConfig',
    request: () =>
      ['PUT', '/acp/connections/existing', { command: 'sh' }] as const,
  },
  {
    name: 'PUT /acp/connections/:id changing the folder',
    recorder: 'saveACPConfig',
    request: () =>
      ['PUT', '/acp/connections/existing', { cwd: '/somewhere' }] as const,
  },
  {
    name: 'POST /integrations naming a command',
    recorder: 'saveIntegration',
    request: () =>
      [
        'POST',
        '/integrations',
        {
          id: 'new-tool',
          name: 'New',
          transport: 'stdio',
          command: 'sh',
          args: ['-c', 'x'],
        },
      ] as const,
  },
  {
    name: 'PUT /integrations/:id changing the command',
    recorder: 'saveIntegration',
    request: () => ['PUT', '/integrations/tool-1', { command: 'sh' }] as const,
  },
  {
    name: 'POST /integrations with env on a command-launching server',
    recorder: 'saveIntegration',
    request: () =>
      [
        'POST',
        '/integrations',
        {
          id: 'env-tool',
          name: 'E',
          transport: 'stdio',
          env: { NODE_OPTIONS: '--import=x' },
        },
      ] as const,
  },
  {
    name: 'POST /integrations with secretEnv on a command-launching server',
    recorder: 'saveIntegration',
    request: () =>
      [
        'POST',
        '/integrations',
        {
          id: 'env-tool',
          name: 'E',
          transport: 'stdio',
          secretEnv: { PATH: '/tmp/x' },
        },
      ] as const,
  },
  {
    name: 'PUT /integrations/:id with env on a stored command',
    recorder: 'saveIntegration',
    request: () =>
      ['PUT', '/integrations/tool-1', { env: { BASH_ENV: '/tmp/x' } }] as const,
  },
  {
    name: 'PUT /integrations/:id with secretEnv on a stored command',
    recorder: 'saveIntegration',
    request: () =>
      [
        'PUT',
        '/integrations/tool-1',
        { secretEnv: { LD_PRELOAD: '/tmp/x' } },
      ] as const,
  },
  {
    name: 'PUT /integrations/:id flipping a URL record that holds a command to stdio',
    recorder: 'saveIntegration',
    request: () =>
      [
        'PUT',
        '/integrations/url-with-command',
        { transport: 'stdio' },
      ] as const,
  },
  {
    name: 'POST /flow/runs/:runId/evidence/command',
    recorder: 'attachCommandEvidence',
    request: () =>
      [
        'POST',
        '/api/projects/p/flow/runs/run-1/evidence/command',
        { gate: 'g', command: 'echo hi', claimType: 'quality.static-checks' },
      ] as const,
  },
  {
    name: 'PUT /config/app changing terminalShell',
    recorder: 'updateAppConfig',
    request: () =>
      ['PUT', '/config/app', { terminalShell: '/bin/sh' }] as const,
  },
] as const;

describe.each(CHOICES)('$name', (choice) => {
  const calls = (f: F) => f.recorders[choice.recorder].mock.calls.length;

  test('refuses delegation and standard devices, saving and running nothing', async () => {
    const f = await fixture();
    for (const preset of ['delegation', 'standard'] as const) {
      const [method, path, body] = choice.request();
      const res = await f.send(f.pair(preset), method, path, body);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe(CODE);
    }
    expect(calls(f)).toBe(0);
  });

  test('admits a device holding coding:exec and the operator', async () => {
    const f = await fixture();
    const [method, path, body] = choice.request();
    const granted = await f.send(
      f.pair('delegation', [PAIRING_SCOPE_CODING_EXEC]),
      method,
      path,
      body,
    );
    expect(granted.status).toBeLessThan(300);
    expect(calls(f)).toBe(1);
    const operator = await f.send(f.operator.credential, method, path, body);
    expect(operator.status).toBeLessThan(300);
    // The second, identical ACP request is a no-op, so at least one write.
    expect(calls(f)).toBeGreaterThanOrEqual(1);
  });
});

describe('what a device may still do without choosing a command', () => {
  test('reads, deletes and reconnects ACP connections', async () => {
    const f = await fixture();
    const device = f.pair('delegation');
    expect((await f.send(device, 'GET', '/acp/connections')).status).toBe(200);
    expect((await f.send(device, 'GET', '/acp/status')).status).toBe(200);
    expect(
      (await f.send(device, 'POST', '/acp/connections/existing/reconnect'))
        .status,
    ).toBe(200);
    expect(f.acpCtx.acpBridge.reconnect).toHaveBeenCalledTimes(1);
    expect(
      (await f.send(device, 'DELETE', '/acp/connections/existing')).status,
    ).toBe(200);
  });

  test('renames an ACP connection or sends its command unchanged', async () => {
    const f = await fixture();
    const device = f.pair('delegation');
    const rename = await f.send(device, 'PUT', '/acp/connections/existing', {
      name: 'Renamed',
    });
    expect(rename.status).toBe(200);
    const same = await f.send(device, 'PUT', '/acp/connections/existing', {
      command: 'engine',
      args: ['--a'],
    });
    expect(same.status).toBe(200);
  });

  test('saves a tool server that names no command, and leaves its command alone on edit', async () => {
    const f = await fixture();
    const device = f.pair('delegation');
    expect(
      (
        await f.send(device, 'POST', '/integrations', {
          id: 'remote-tool',
          name: 'Remote',
          transport: 'streamable-http',
          endpoint: 'https://tools.example.test/mcp',
        })
      ).status,
    ).toBeLessThan(300);
    expect(
      (await f.send(device, 'PUT', '/integrations/tool-1', { name: 'Renamed' }))
        .status,
    ).toBeLessThan(300);
    expect(f.recorders.saveIntegration).toHaveBeenCalledTimes(2);
  });

  test('changes other app settings, and sets terminalShell to the value it already has', async () => {
    const f = await fixture();
    const device = f.pair('delegation');
    expect(
      (await f.send(device, 'PUT', '/config/app', { defaultModel: 'm' }))
        .status,
    ).toBeLessThan(300);
    expect(
      (
        await f.send(device, 'PUT', '/config/app', {
          terminalShell: '/bin/zsh',
        })
      ).status,
    ).toBeLessThan(300);
  });
});

describe('what stays allowed for a device', () => {
  test('env on a tool server that launches nothing (a URL transport)', async () => {
    const f = await fixture();
    const device = f.pair('delegation');
    const created = await f.send(device, 'POST', '/integrations', {
      id: 'remote-tool',
      name: 'Remote',
      transport: 'streamable-http',
      endpoint: 'https://tools.example.test/mcp',
      env: { API_KEY: 'k' },
    });
    expect(created.status).toBeLessThan(300);
    const updated = await f.send(device, 'PUT', '/integrations/url-tool', {
      env: { API_KEY: 'k2' },
    });
    expect(updated.status).toBeLessThan(300);
    expect(f.recorders.saveIntegration).toHaveBeenCalledTimes(2);
  });

  test('an empty env submission, which changes nothing, on a command-launching server', async () => {
    const f = await fixture();
    const res = await f.send(
      f.pair('delegation'),
      'PUT',
      '/integrations/tool-1',
      {
        env: {},
        name: 'Renamed',
      },
    );
    expect(res.status).toBeLessThan(300);
  });

  test('an empty args or folder is the same as none on an ACP connection', async () => {
    const f = await fixture();
    const device = f.pair('delegation');
    expect(
      (await f.send(device, 'PUT', '/acp/connections/plain', { args: [] }))
        .status,
    ).toBe(200);
    expect(
      (await f.send(device, 'PUT', '/acp/connections/plain', { cwd: '' }))
        .status,
    ).toBe(200);
    expect(
      (
        await f.send(device, 'PUT', '/acp/connections/plain', {
          args: [],
          cwd: '',
          name: 'Plain 2',
        })
      ).status,
    ).toBe(200);
    // ...while a real change to the same connection is still refused.
    expect(
      (await f.send(device, 'PUT', '/acp/connections/plain', { args: ['--x'] }))
        .status,
    ).toBe(403);
  });
});

const CODE_ROUTES = [
  {
    name: 'POST /api/plugins/install',
    method: 'POST',
    path: '/api/plugins/install',
    body: { source: '/nonexistent/plugin' },
  },
  {
    name: 'POST /api/plugins/:name/update',
    method: 'POST',
    path: '/api/plugins/demo/update',
    body: {},
  },
  {
    name: 'POST /api/plugins/:name/recover',
    method: 'POST',
    path: '/api/plugins/demo/recover',
    body: {},
  },
  {
    name: 'POST /api/registry/plugins/install',
    method: 'POST',
    path: '/api/registry/plugins/install',
    body: { id: 'demo' },
  },
  {
    name: 'POST /api/registry/integrations/install',
    method: 'POST',
    path: '/api/registry/integrations/install',
    body: { id: 'demo' },
  },
] as const;

describe.each(CODE_ROUTES)('$name (fetches and runs code)', (route) => {
  test('refuses a person device without coding:exec, ahead of any install work', async () => {
    const f = await fixture();
    const res = await f.send(
      f.pair('standard'),
      route.method,
      route.path,
      route.body,
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(CODE);
  });

  test('does not refuse a granted device or the operator on this ground', async () => {
    const f = await fixture();
    const granted = await f.send(
      f.pair('standard', [PAIRING_SCOPE_CODING_EXEC]),
      route.method,
      route.path,
      route.body,
    );
    expect(granted.body?.code).not.toBe(CODE);
    const operator = await f.send(
      f.operator.credential,
      route.method,
      route.path,
      route.body,
    );
    expect(operator.body?.code).not.toBe(CODE);
  });
});

describe('an agent changing the terminal shell (Station-internal principal)', () => {
  test('is refused by the route, and other settings are not', async () => {
    const f = await fixture();
    const agentApp = new Hono();
    agentApp.use('*', async (c, next) => {
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        kind: 'internal',
        credential: 'internal-token',
        authority: undefined,
        source: 'bearer',
      });
      await next();
    });
    agentApp.route('/config', f.configRoutes);
    const send = (body: unknown) =>
      agentApp.request('/config/app', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const refused = await send({ terminalShell: '/tmp/evil' });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe(CODE);
    expect(f.recorders.updateAppConfig).not.toHaveBeenCalled();
    expect((await send({ defaultModel: 'm' })).status).toBeLessThan(300);
  });
});
