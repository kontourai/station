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
import type { EventBus } from '../../services/orchestration/event-bus.js';
import { EnvironmentSecurityService } from '../../services/ssh/environment-security-service.js';
import { createLogger } from '../../utils/logger.js';
import { createToolRoutes } from '../agents/tools.js';
import { createACPRoutes } from '../connections/acp.js';
import { createFlowRunRoutes } from '../evidence/flow-runs.js';
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
    getIntegration: vi.fn(async () => ({
      id: 'tool-1',
      name: 'Tool',
      type: 'stdio',
      command: 'server',
      args: ['--x'],
    })),
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
  app.route(
    '/config',
    createConfigRoutes(
      configLoader as never,
      createLogger({ name: 'c', level: 'error' }),
    ),
  );

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
