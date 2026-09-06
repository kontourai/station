import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { setGrantedPairingScope } from '../../../security/pairing-route-scopes.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  configOps: { add: vi.fn() },
}));

const { createConfigRoutes } = await import('../config.js');
const { ConfigLoader } = await import('../../../domain/config-loader.js');
const { defaultTerminalShell } = await import(
  '../../../services/terminal/terminal-shells.js'
);

function createMockConfigLoader(
  initial: Record<string, any> = {
    defaultModel: 'claude-3',
    region: 'us-east-1',
  },
) {
  let config = initial;
  const projectHome = mkdtempSync(join(tmpdir(), 'station-config-route-'));
  return {
    getProjectHomeDir: vi.fn(() => projectHome),
    loadAppConfig: vi.fn().mockImplementation(async () => ({ ...config })),
    updateAppConfig: vi.fn().mockImplementation(async (updates: any) => {
      config = { ...config, ...updates };
      return config;
    }),
  };
}

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn().mockReturnThis(),
  setLevel: vi.fn(),
  getLevel: vi.fn(() => 'info' as const),
};

describe('Config Routes', () => {
  test('log-level edit requires revision and idempotency, deduplicates replay, and conflicts on stale revision', async () => {
    const loader = createMockConfigLoader();
    const app = createConfigRoutes(loader as any, mockLogger);
    const initial = await json(await app.request('/app/log-level'));

    const headers = {
      'Content-Type': 'application/json',
      'If-Match': initial.revision,
      'Idempotency-Key': 'config-edit-00000001',
    };
    const first = await app.request('/app/log-level', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ value: 'debug' }),
    });
    expect(first.status).toBe(200);
    const firstBody = await json(first);

    // Re-create the route/service to prove the receipt survives a process restart.
    const restartedApp = createConfigRoutes(loader as any, mockLogger);
    const replay = await restartedApp.request('/app/log-level', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ value: 'debug' }),
    });
    expect(replay.status).toBe(200);
    expect(await json(replay)).toEqual(firstBody);
    expect(loader.updateAppConfig).toHaveBeenCalledTimes(1);

    const reusedWithDifferentPayload = await restartedApp.request(
      '/app/log-level',
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({ value: 'warn' }),
      },
    );
    expect(reusedWithDifferentPayload.status).toBe(409);
    expect(await json(reusedWithDifferentPayload)).toMatchObject({
      error: 'idempotency_key_conflict',
    });

    const stale = await app.request('/app/log-level', {
      method: 'PUT',
      headers: { ...headers, 'Idempotency-Key': 'config-edit-00000002' },
      body: JSON.stringify({ value: 'trace' }),
    });
    expect(stale.status).toBe(409);
    expect(await json(stale)).toMatchObject({
      error: 'config_conflict',
      currentValue: 'debug',
      currentRevision: firstBody.revision,
    });
  });

  test('GET /app returns config', async () => {
    const loader = createMockConfigLoader();
    const app = createConfigRoutes(loader as any, mockLogger);
    const body = await json(await app.request('/app'));
    expect(body.success).toBe(true);
    expect(body.data.defaultModel).toBe('claude-3');
  });

  test('GET /app omits legacy credential application authority', async () => {
    const loader = createMockConfigLoader();
    loader.loadAppConfig.mockResolvedValueOnce({
      defaultModel: 'claude-3',
      agentConnections: {
        codex: {
          credentialRecovery: {
            pendingApplication: {
              candidateProfileRef: 'candidate',
              attemptId: 'opaque-attempt',
            },
            applicationReceipts: [
              {
                attemptId: 'opaque-receipt',
                candidateProfileRef: 'candidate',
                outcome: 'adopted',
                recordedAt: '2026-08-13T00:00:00.000Z',
              },
            ],
          },
        },
      },
    });
    const app = createConfigRoutes(loader as any, mockLogger);
    const body = await json(await app.request('/app'));
    expect(JSON.stringify(body)).not.toContain('opaque-attempt');
    expect(JSON.stringify(body)).not.toContain('opaque-receipt');
    expect(
      body.data.agentConnections.codex.credentialRecovery,
    ).not.toHaveProperty('pendingApplication');
  });

  test('GET followed by an unrelated PUT cannot preserve legacy application authority', async () => {
    const loader = createMockConfigLoader({
      defaultModel: 'claude-3',
      region: 'us-east-1',
      agentConnections: {
        codex: {
          credentialRecovery: {
            pendingApplication: {
              candidateProfileRef: 'candidate',
              attemptId: 'private-pending',
            },
            applicationReceipts: [
              {
                attemptId: 'private-receipt',
                candidateProfileRef: 'candidate',
                outcome: 'adopted',
                recordedAt: '2026-08-13T00:00:00.000Z',
              },
            ],
          },
        },
      },
    });
    const app = createConfigRoutes(loader as any, mockLogger);
    const get = await json(await app.request('/app'));
    const put = await json(
      await app.request('/app', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...get.data, region: 'us-west-2' }),
      }),
    );
    const persisted = await loader.loadAppConfig();
    expect(
      persisted.agentConnections.codex.credentialRecovery,
    ).not.toHaveProperty('pendingApplication');
    expect(
      persisted.agentConnections.codex.credentialRecovery,
    ).not.toHaveProperty('applicationReceipts');
    for (const value of [
      JSON.stringify(get),
      JSON.stringify(put),
      JSON.stringify(mockLogger.info.mock.calls),
    ]) {
      expect(value).not.toContain('private-pending');
      expect(value).not.toContain('private-receipt');
    }
  });

  test('GET /app injects mcpUiFrameOrigin when the frame server is running', async () => {
    const loader = createMockConfigLoader();
    const app = createConfigRoutes(
      loader as any,
      mockLogger,
      undefined,
      undefined,
      () => 'http://127.0.0.1:4555',
    );
    const body = await json(await app.request('/app'));
    expect(body.data.mcpUiFrameOrigin).toBe('http://127.0.0.1:4555');
  });

  test('GET /app omits mcpUiFrameOrigin when no frame server is running', async () => {
    const loader = createMockConfigLoader();
    const app = createConfigRoutes(
      loader as any,
      mockLogger,
      undefined,
      undefined,
      () => undefined,
    );
    const body = await json(await app.request('/app'));
    expect('mcpUiFrameOrigin' in body.data).toBe(false);
  });

  // #1582 D9: the Settings "Terminal shell" input had no hint at all, and a
  // hard-coded one would be wrong on any host whose SHELL differs. The value
  // is derived from the same resolver a terminal spawn walks, and it is the
  // DEFAULT (what happens if the field is left empty) — never the configured
  // value, which the input renders itself.
  test('GET /app reports the shell this host would try when terminalShell is unset', async () => {
    const loader = createMockConfigLoader({ terminalShell: '/usr/bin/nu' });
    const app = createConfigRoutes(loader as any, mockLogger);
    const body = await json(await app.request('/app'));
    // Pinned independently of the derivation, or the assertion moves with it:
    // on a host that sets SHELL that is the answer, and on one that does not
    // it is the platform's own first fallback.
    const expected =
      process.env.SHELL ??
      (process.platform === 'win32'
        ? (process.env.COMSPEC ?? 'C:\\Program Files\\Git\\bin\\bash.exe')
        : '/bin/zsh');
    expect(body.data.defaultTerminalShell).toBe(expected);
    // ...and it agrees with the resolver a spawn walks, which is the point.
    expect(body.data.defaultTerminalShell).toBe(
      defaultTerminalShell({ platform: process.platform, env: process.env })
        ?.shell,
    );
    // The configured value is reported separately and must not become the
    // default it is an override of.
    expect(body.data.terminalShell).toBe('/usr/bin/nu');
    expect(body.data.defaultTerminalShell).not.toBe('/usr/bin/nu');
  });

  test('GET /app injects the runtime-only pluginFrameOrigin', async () => {
    const loader = createMockConfigLoader();
    const app = createConfigRoutes(
      loader as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => 'http://127.0.0.1:4555',
    );
    const body = await json(await app.request('/app'));
    expect(body.data.pluginFrameOrigin).toBe('http://127.0.0.1:4555');
  });

  test('station#980: GET /app injects managedChatOrchestration when the flag is enabled', async () => {
    const loader = createMockConfigLoader();
    const app = createConfigRoutes(
      loader as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      () => true,
    );
    const body = await json(await app.request('/app'));
    expect(body.data.managedChatOrchestration).toBe(true);
  });

  test('station#980: GET /app omits managedChatOrchestration when the flag is disabled or unset (default OFF, byte-identical response)', async () => {
    const loaderOff = createMockConfigLoader();
    const appOff = createConfigRoutes(
      loaderOff as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      () => false,
    );
    const bodyOff = await json(await appOff.request('/app'));
    expect('managedChatOrchestration' in bodyOff.data).toBe(false);

    const loaderUnset = createMockConfigLoader();
    const appUnset = createConfigRoutes(loaderUnset as any, mockLogger);
    const bodyUnset = await json(await appUnset.request('/app'));
    expect('managedChatOrchestration' in bodyUnset.data).toBe(false);
  });

  test('PUT /app updates config', async () => {
    const loader = createMockConfigLoader();
    const app = createConfigRoutes(loader as any, mockLogger);
    const res = await app.request('/app', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultModel: 'gpt-4' }),
    });
    const body = await json(res);
    expect(body.success).toBe(true);
    expect(body.data.defaultModel).toBe('gpt-4');
  });

  test('PUT /app rejects injected legacy credential application authority', async () => {
    const loader = createMockConfigLoader();
    const app = createConfigRoutes(loader as any, mockLogger);
    const response = await app.request('/app', {
      method: 'PUT',
      body: JSON.stringify({
        agentConnections: {
          codex: {
            credentialRecovery: {
              pendingApplication: {
                attemptId: 'forged',
                candidateProfileRef: 'candidate',
              },
            },
          },
        },
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(400);
    await expect(json(response)).resolves.toMatchObject({ success: false });
  });

  test('PUT /app refuses logLevel without mutating any settings', async () => {
    const loader = createMockConfigLoader();
    const app = createConfigRoutes(loader as any, mockLogger);
    const response = await app.request('/app', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logLevel: 'debug', region: 'eu-west-1' }),
    });
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({
      error: expect.stringContaining('/api/config/app/log-level'),
    });
    expect(loader.updateAppConfig).not.toHaveBeenCalled();
  });

  test('PUT /app emits event when eventBus provided', async () => {
    const loader = createMockConfigLoader();
    const eventBus = { emit: vi.fn() };
    const app = createConfigRoutes(loader as any, mockLogger, eventBus as any);
    await app.request('/app', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ region: 'us-west-2' }),
    });
    expect(eventBus.emit).toHaveBeenCalledWith('system:status-changed', {
      source: 'config',
    });
  });

  test('PUT /app keeps persistence inside the configuration mutation', async () => {
    const loader = createMockConfigLoader();
    const mutationObserved = vi.fn();
    const applyConfigurationMutation = async <T>(
      operation: (beginMutation: () => void) => Promise<T>,
    ): Promise<T> => {
      mutationObserved();
      return operation(() => undefined);
    };
    const app = createConfigRoutes(
      loader as any,
      mockLogger,
      undefined,
      applyConfigurationMutation,
    );
    await app.request('/app', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ region: 'eu-west-1' }),
    });
    expect(mutationObserved).toHaveBeenCalledOnce();
    expect(loader.updateAppConfig).toHaveBeenCalledOnce();
  });

  test('GET /app includes provenance, with source "env" for injected runtime-derived keys', async () => {
    const loader = createMockConfigLoader();
    const app = createConfigRoutes(
      loader as any,
      mockLogger,
      undefined,
      undefined,
      () => 'http://127.0.0.1:4555',
      () => true,
    );
    const body = await json(await app.request('/app'));
    expect(body.provenance.defaultModel).toEqual({ source: 'file' });
    expect(body.provenance.mcpUiFrameOrigin).toEqual({
      source: 'env',
      envVar: 'MCP_UI_FRAME_PORT',
    });
    expect(body.provenance.managedChatOrchestration).toEqual({
      source: 'env',
      envVar: 'STATION_FEATURES',
    });
  });

  test('PUT /app strips runtime-derived keys (managedChatOrchestration) and reports them as ignoredKeys, so a GET-then-PUT round trip cannot persist them', async () => {
    const loader = createMockConfigLoader();
    const app = createConfigRoutes(loader as any, mockLogger);
    const res = await app.request('/app', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        defaultModel: 'gpt-4',
        managedChatOrchestration: true,
      }),
    });
    const body = await json(res);
    expect(body.success).toBe(true);
    expect(loader.updateAppConfig).toHaveBeenCalledWith({
      defaultModel: 'gpt-4',
    });
    expect('managedChatOrchestration' in body.data).toBe(false);
    expect(body.ignoredKeys).toEqual([
      { key: 'managedChatOrchestration', reason: 'runtime-derived' },
    ]);
  });

  test('PUT /app with an invalid enum value returns 400 with violations, and does not call updateAppConfig', async () => {
    const loader = createMockConfigLoader();
    const app = createConfigRoutes(loader as any, mockLogger);
    const res = await app.request('/app', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logLevel: 'nope' }),
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain('/api/config/app/log-level');
    expect(loader.updateAppConfig).not.toHaveBeenCalled();
  });

  test('PUT /app rejects an invalid engine connection identity before persistence', async () => {
    const loader = createMockConfigLoader();
    const app = createConfigRoutes(loader as any, mockLogger);
    const res = await app.request('/app', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ builtinAgentEngineConnectionId: 'bad_id' }),
    });

    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain('builtinAgentEngineConnectionId');
    expect(loader.updateAppConfig).not.toHaveBeenCalled();
  });

  describe('station#1194: rebindBuiltinAgents wiring', () => {
    test('PUT /app calls rebindBuiltinAgents when the update touches builtinAgentEngineConnectionId', async () => {
      const loader = createMockConfigLoader();
      const rebindBuiltinAgents = vi.fn().mockResolvedValue(undefined);
      const app = createConfigRoutes(
        loader as any,
        mockLogger,
        undefined,
        undefined,
        undefined,
        undefined,
        rebindBuiltinAgents,
      );
      const res = await app.request('/app', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          builtinAgentEngineConnectionId: 'codex',
        }),
      });
      expect(res.status).toBe(200);
      expect(rebindBuiltinAgents).toHaveBeenCalledOnce();
    });

    test('PUT /app does NOT call rebindBuiltinAgents for an unrelated field', async () => {
      const loader = createMockConfigLoader();
      const rebindBuiltinAgents = vi.fn().mockResolvedValue(undefined);
      const app = createConfigRoutes(
        loader as any,
        mockLogger,
        undefined,
        undefined,
        undefined,
        undefined,
        rebindBuiltinAgents,
      );
      await app.request('/app', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultModel: 'gpt-4' }),
      });
      expect(rebindBuiltinAgents).not.toHaveBeenCalled();
    });

    test('PUT /app setting builtinAgentEngineConnectionId to null (explicit Station) still triggers the rebind', async () => {
      const loader = createMockConfigLoader();
      const rebindBuiltinAgents = vi.fn().mockResolvedValue(undefined);
      const app = createConfigRoutes(
        loader as any,
        mockLogger,
        undefined,
        undefined,
        undefined,
        undefined,
        rebindBuiltinAgents,
      );
      const res = await app.request('/app', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ builtinAgentEngineConnectionId: null }),
      });
      expect(res.status).toBe(200);
      expect(rebindBuiltinAgents).toHaveBeenCalledOnce();
    });

    test('a full-config round trip with an UNCHANGED builtinAgentEngineConnectionId does not rebind (SettingsView saves every registered key)', async () => {
      const loader = createMockConfigLoader();
      const rebindBuiltinAgents = vi.fn().mockResolvedValue(undefined);
      const app = createConfigRoutes(
        loader as any,
        mockLogger,
        undefined,
        undefined,
        undefined,
        undefined,
        rebindBuiltinAgents,
      );
      await app.request('/app', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          builtinAgentEngineConnectionId: 'codex',
        }),
      });
      expect(rebindBuiltinAgents).toHaveBeenCalledOnce();

      // A settings-page save round-trips the whole config, including the
      // unchanged binding — presence alone must not rebind again (it made
      // every save serialize behind an engine rebind; caught live by
      // tests/settings.spec.ts 'save persists changes').
      await app.request('/app', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          defaultModel: 'claude-4',
          builtinAgentEngineConnectionId: 'codex',
        }),
      });
      expect(rebindBuiltinAgents).toHaveBeenCalledOnce();
    });
  });

  describe('station#1194 review round 2 (HIGH): cache invalidation on rebind', () => {
    test('PUT /app emits CONFIG_CHANGED (invalidates client agents cache) when builtinAgentEngineConnectionId changes', async () => {
      const loader = createMockConfigLoader();
      const eventBus = { emit: vi.fn() };
      const app = createConfigRoutes(
        loader as any,
        mockLogger,
        eventBus as any,
      );
      await app.request('/app', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          builtinAgentEngineConnectionId: 'codex',
        }),
      });
      expect(eventBus.emit).toHaveBeenCalledWith('system:status-changed', {
        source: 'config',
      });
      expect(eventBus.emit).toHaveBeenCalledWith('config:changed', {
        source: 'config',
      });
    });

    test('PUT /app does NOT emit CONFIG_CHANGED for an unrelated field (SYSTEM_STATUS_CHANGED alone still fires)', async () => {
      const loader = createMockConfigLoader();
      const eventBus = { emit: vi.fn() };
      const app = createConfigRoutes(
        loader as any,
        mockLogger,
        eventBus as any,
      );
      await app.request('/app', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultModel: 'gpt-4' }),
      });
      expect(eventBus.emit).toHaveBeenCalledWith('system:status-changed', {
        source: 'config',
      });
      expect(eventBus.emit).not.toHaveBeenCalledWith(
        'config:changed',
        expect.anything(),
      );
    });
  });
});

// station#settings-revamp slice-1 review findings 1 & 2: these run against a
// REAL ConfigLoader + real filesystem instead of the mock loader above,
// because both findings are about behavior that only exists at that layer
// (the on-load purge in `loadAppConfigFile`, the null-clearing merge in
// `mergeAppConfigUpdate`) — a mock loader can't exercise either.
describe('Config Routes (real ConfigLoader + filesystem)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'station-config-routes-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('finding 1: GET /app never leaks a persisted runtime-derived field back when the live flag is off, even from a home polluted by the pre-fix round trip', async () => {
    const configDir = join(tempDir, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'app.json'),
      JSON.stringify({
        defaultModel: 'x',
        invokeModel: 'y',
        structureModel: 'z',
        managedChatOrchestration: true,
        mcpUiFrameOrigin: 'http://stale-frame-origin',
      }),
      'utf8',
    );
    const loader = new ConfigLoader({ projectHomeDir: tempDir });
    const app = createConfigRoutes(
      loader as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      () => false,
    );

    const body = await json(await app.request('/app'));
    expect('managedChatOrchestration' in body.data).toBe(false);
    expect('mcpUiFrameOrigin' in body.data).toBe(false);

    const persisted = JSON.parse(
      readFileSync(join(configDir, 'app.json'), 'utf8'),
    );
    expect('managedChatOrchestration' in persisted).toBe(false);
    expect('mcpUiFrameOrigin' in persisted).toBe(false);
  });

  test('finding 1: GET /app with the live flag ON still injects managedChatOrchestration: true, independent of what got purged from the file', async () => {
    const configDir = join(tempDir, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'app.json'),
      JSON.stringify({
        defaultModel: 'x',
        invokeModel: 'y',
        structureModel: 'z',
        managedChatOrchestration: true,
      }),
      'utf8',
    );
    const loader = new ConfigLoader({ projectHomeDir: tempDir });
    const app = createConfigRoutes(
      loader as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      () => true,
    );

    const body = await json(await app.request('/app'));
    expect(body.data.managedChatOrchestration).toBe(true);
  });

  test('finding 2: PUT { region: null } through the real route+loader clears the field from both the response and the persisted file (200, not a 400 from AJV)', async () => {
    const loader = new ConfigLoader({ projectHomeDir: tempDir });
    const app = createConfigRoutes(loader as any, mockLogger);

    await app.request('/app', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ region: 'eu-west-1' }),
    });

    const res = await app.request('/app', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ region: null }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.success).toBe(true);
    expect('region' in body.data).toBe(false);

    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'config', 'app.json'), 'utf8'),
    );
    expect('region' in persisted).toBe(false);
  });

  test('finding 2: PUT { defaultModel: null } is rejected as a required-key violation, naming the key', async () => {
    const loader = new ConfigLoader({ projectHomeDir: tempDir });
    const app = createConfigRoutes(loader as any, mockLogger);
    // Seed the file so there's something to assert stayed untouched below —
    // a fresh tempDir has no app.json until something actually persists.
    await loader.loadAppConfig();

    const res = await app.request('/app', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultModel: null }),
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.success).toBe(false);
    expect(body.violations).toEqual([
      {
        key: 'defaultModel',
        message: 'defaultModel: required — cannot be cleared',
      },
    ]);

    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'config', 'app.json'), 'utf8'),
    );
    expect(typeof persisted.defaultModel).toBe('string');
  });

  test('merge resolution (#1194 × slice 1): PUT { builtinAgentEngineConnectionId: null } persists a literal null (sticky explicit-Station) and still triggers the rebind', async () => {
    const loader = new ConfigLoader({ projectHomeDir: tempDir });
    const rebindBuiltinAgents = vi.fn().mockResolvedValue(undefined);
    const app = createConfigRoutes(
      loader as any,
      mockLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      rebindBuiltinAgents,
    );

    const res = await app.request('/app', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ builtinAgentEngineConnectionId: null }),
    });
    expect(res.status).toBe(200);
    expect(rebindBuiltinAgents).toHaveBeenCalledOnce();

    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'config', 'app.json'), 'utf8'),
    );
    expect('builtinAgentEngineConnectionId' in persisted).toBe(true);
    expect(persisted.builtinAgentEngineConnectionId).toBeNull();
  });
});

/**
 * archive#1398, §5.4 — the beneficiary-cannot-flip guard.
 *
 * §5.4's disposition (contribution keeps riding `orchestration:operate`)
 * holds only while a credential that can ENABLE contribution cannot also
 * INVOKE it. A single grant carrying `orchestration:operate inference:invoke`
 * breaks that precondition: it could enable contribution, name a billable
 * hosted connection, and then spend the owner's money through
 * `/api/inference/**` with no operator involved at any step. These tests pin
 * the guard in both directions, because a guard that also blocked the
 * operate-only peer would be a different (and unrecorded) decision.
 */
describe('PUT /config/app: fleet-contribution beneficiary guard (station#1398 §5.4)', () => {
  const OPERATE_ONLY = 'orchestration:read orchestration:operate';
  const OPERATE_AND_INVOKE =
    'orchestration:read orchestration:operate inference:invoke';

  function appWithPresentedScope(
    loader: ReturnType<typeof createMockConfigLoader>,
    scope?: string,
  ) {
    const routes = createConfigRoutes(loader as any, mockLogger);
    const outer = new Hono();
    // Mirrors what `runtime-http.ts`'s auth middleware publishes once a
    // presented credential has been verified and cleared the route's tier.
    outer.use('*', async (c, next) => {
      if (scope !== undefined) {
        setGrantedPairingScope(c as never, scope);
      }
      await next();
    });
    outer.route('/', routes);
    return outer;
  }

  const put = (app: Hono, payload: unknown) =>
    app.request('/app', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

  test('an operate-only credential CAN still enable contribution (the §5.4 case, unchanged)', async () => {
    const loader = createMockConfigLoader();
    const response = await put(appWithPresentedScope(loader, OPERATE_ONLY), {
      fleetContribution: { enabled: true, connectionIds: ['ollama-local'] },
    });

    expect(response.status).toBe(200);
    expect(loader.updateAppConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        fleetContribution: { enabled: true, connectionIds: ['ollama-local'] },
      }),
    );
  });

  test('a credential holding inference:invoke CANNOT enable contribution', async () => {
    const loader = createMockConfigLoader();
    const response = await put(
      appWithPresentedScope(loader, OPERATE_AND_INVOKE),
      { fleetContribution: { enabled: true } },
    );

    expect(response.status).toBe(403);
    const body = await json(response);
    expect(body.success).toBe(false);
    expect(body.error).toContain('fleet inference');
    // Refused before any persistence — a guard that returned 403 after
    // writing would be theatre.
    expect(loader.updateAppConfig).not.toHaveBeenCalled();
  });

  test('the guard covers connectionIds too, not just enabled', async () => {
    // Naming a new (possibly billable, possibly hosted) connection on an
    // already-enabled Station is the same act as switching it on.
    const loader = createMockConfigLoader();
    const response = await put(
      appWithPresentedScope(loader, OPERATE_AND_INVOKE),
      { fleetContribution: { connectionIds: ['bedrock-expensive'] } },
    );

    expect(response.status).toBe(403);
    expect(loader.updateAppConfig).not.toHaveBeenCalled();
  });

  test('the guard is scoped to that one field — the same credential writes other settings normally', async () => {
    const loader = createMockConfigLoader();
    const response = await put(
      appWithPresentedScope(loader, OPERATE_AND_INVOKE),
      { defaultModel: 'claude-4' },
    );

    expect(response.status).toBe(200);
    expect(loader.updateAppConfig).toHaveBeenCalledWith(
      expect.objectContaining({ defaultModel: 'claude-4' }),
    );
  });

  // ── archive#1500 / archive#1503 review M6 + L7 ────────────────

  test('the invoke guard also covers the SCOPED contribution map', async () => {
    // Its `inference` axis names billable connections exactly as
    // `fleetContribution` does; the key was added to the guard when the key was
    // added, before any consumer of it exists.
    const loader = createMockConfigLoader();
    const response = await put(
      appWithPresentedScope(loader, OPERATE_AND_INVOKE),
      {
        contribution: {
          'project:prj_1': { inference: { connectionIds: ['bedrock-pricey'] } },
        },
      },
    );

    expect(response.status).toBe(403);
    expect(loader.updateAppConfig).not.toHaveBeenCalled();
  });

  test('a `contribution.fleet` entry is REFUSED, and told where the value belongs', async () => {
    // The refusal existed on the read (`resolveScopedContribution`) and was
    // undiscoverable: no consumer, no UI, and the schema permitted any key — so
    // an operator writing consent under the wrong key got a 200, offered
    // nothing, and was told nothing.
    const loader = createMockConfigLoader();
    const response = await put(appWithPresentedScope(loader, undefined), {
      contribution: { fleet: { enabled: true } },
    });
    const body = await json(response);

    expect(response.status).toBe(400);
    expect(body.error).toContain('fleetContribution');
    expect(loader.updateAppConfig).not.toHaveBeenCalled();
  });

  test.each([
    ['a future channel key', 'channel:chn_1'],
    ['a bare project id', 'prj_7f3a'],
    ['an empty project suffix', 'project:'],
  ])('a key this Station cannot name is REFUSED (%s)', async (_label, key) => {
    // Fail-closed by construction was already true — an unparseable key is
    // never merged. What was missing is the REPORT: the docblock claimed such a
    // key "is reported as an ignored key" while nothing enumerated the map.
    const loader = createMockConfigLoader();
    const response = await put(appWithPresentedScope(loader, undefined), {
      contribution: { [key]: { enabled: true } },
    });
    const body = await json(response);

    expect(response.status).toBe(400);
    expect(body.error).toContain(key);
    expect(loader.updateAppConfig).not.toHaveBeenCalled();
  });

  test('a well-formed project scope key is accepted', async () => {
    const loader = createMockConfigLoader();
    const response = await put(appWithPresentedScope(loader, undefined), {
      contribution: {
        'project:prj_7f3a': {
          enabled: true,
          execution: { repoIds: ['github.com/acme/api'] },
        },
      },
    });

    expect(response.status).toBe(200);
    expect(loader.updateAppConfig).toHaveBeenCalled();
  });

  test('an exact internal caller with no pairing scope is unaffected', async () => {
    // This handler-level harness represents the exact internal-token path.
    // Production runtime authentication rejects an ordinary loopback caller
    // before it can reach this branch.
    const loader = createMockConfigLoader();
    const response = await put(appWithPresentedScope(loader, undefined), {
      fleetContribution: { enabled: true },
    });

    expect(response.status).toBe(200);
    expect(loader.updateAppConfig).toHaveBeenCalled();
  });
});

/**
 * The first-run record is a TRANSITION, not a setting (review M1).
 *
 * Every case here was reachable through `PUT /config/app` before this: it
 * accepted `firstRun` as an ordinary composite, so an `orchestration:operate`
 * peer could re-arm a home as `pending` and re-run the guided chapter on it,
 * or write `completed` with a timestamp of its own choosing for a run that
 * never happened.
 */
describe('first-run decisions', () => {
  const firstRunPost = (app: Hono, payload: unknown) =>
    app.request('/first-run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

  test('the generic config route refuses firstRun outright', async () => {
    const loader = createMockConfigLoader({
      defaultModel: 'claude-3',
      firstRun: { status: 'pending' },
    });
    const app = createConfigRoutes(loader as any, mockLogger);
    const response = await app.request('/app', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        region: 'us-west-2',
        firstRun: { status: 'completed', completedAt: '1999-01-01T00:00:00Z' },
      }),
    });

    expect(response.status).toBe(400);
    expect((await json(response)).error).toContain('POST /config/first-run');
    // And nothing else in that body was saved either: a refusal is not a
    // partial write.
    expect(loader.updateAppConfig).not.toHaveBeenCalled();
  });

  test('a forward decision is recorded with Station’s own timestamp', async () => {
    const loader = createMockConfigLoader({
      defaultModel: 'claude-3',
      firstRun: { status: 'pending' },
    });
    const app = createConfigRoutes(loader as any, mockLogger);
    const before = Date.now();
    const response = await firstRunPost(app, { status: 'skipped' });

    expect(response.status).toBe(200);
    const written = loader.updateAppConfig.mock.calls[0][0].firstRun;
    expect(written.status).toBe('skipped');
    expect(Date.parse(written.skippedAt)).toBeGreaterThanOrEqual(before);
    expect(written).not.toHaveProperty('completedAt');
  });

  test('a deferred home can still complete later', async () => {
    const loader = createMockConfigLoader({
      defaultModel: 'claude-3',
      firstRun: { status: 'skipped', skippedAt: '2026-01-01T00:00:00.000Z' },
    });
    const app = createConfigRoutes(loader as any, mockLogger);

    expect((await firstRunPost(app, { status: 'completed' })).status).toBe(200);
    expect(loader.updateAppConfig.mock.calls[0][0].firstRun.status).toBe(
      'completed',
    );
  });

  test('an existing home cannot be re-armed as pending', async () => {
    const loader = createMockConfigLoader({
      defaultModel: 'claude-3',
      firstRun: { status: 'completed', completedAt: '2026-01-01T00:00:00Z' },
    });
    const app = createConfigRoutes(loader as any, mockLogger);
    const response = await firstRunPost(app, { status: 'pending' });

    expect(response.status).toBe(400);
    expect((await json(response)).error).toContain('cannot be re-armed');
    expect(loader.updateAppConfig).not.toHaveBeenCalled();
  });

  test('completed cannot be walked backwards', async () => {
    const loader = createMockConfigLoader({
      defaultModel: 'claude-3',
      firstRun: { status: 'completed', completedAt: '2026-01-01T00:00:00Z' },
    });
    const app = createConfigRoutes(loader as any, mockLogger);
    const response = await firstRunPost(app, { status: 'skipped' });

    expect(response.status).toBe(400);
    expect(loader.updateAppConfig).not.toHaveBeenCalled();
  });

  test('a home that was never offered the run cannot record one', async () => {
    const loader = createMockConfigLoader({ defaultModel: 'claude-3' });
    const app = createConfigRoutes(loader as any, mockLogger);
    const response = await firstRunPost(app, { status: 'completed' });

    expect(response.status).toBe(400);
    expect((await json(response)).error).toContain('never offered');
    expect(loader.updateAppConfig).not.toHaveBeenCalled();
  });

  test('a forged timestamp is refused, not quietly dropped', async () => {
    const loader = createMockConfigLoader({
      defaultModel: 'claude-3',
      firstRun: { status: 'pending' },
    });
    const app = createConfigRoutes(loader as any, mockLogger);
    const response = await firstRunPost(app, {
      status: 'completed',
      completedAt: '1999-01-01T00:00:00.000Z',
    });

    expect(response.status).toBe(400);
    expect(loader.updateAppConfig).not.toHaveBeenCalled();
  });
});
