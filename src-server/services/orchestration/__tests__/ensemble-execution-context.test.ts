import { createHash } from 'node:crypto';
import { mkdir, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentExecutionConfig } from '@kontourai/station-contracts/agent';
import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import { ENSEMBLE_PRESET_VERSION } from '@kontourai/station-contracts/ensemble';
import type { ExecutionTarget } from '@kontourai/station-contracts/execution-target';
import type {
  AgentConnectionSettings,
  ConnectionConfig,
} from '@kontourai/station-contracts/tool';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod/v3';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ClaudeAdapter } from '../../../providers/adapters/claude-adapter.js';
import { CodexAdapter } from '../../../providers/adapters/codex-adapter.js';
import { createCredentialProfileAppHomeEnvResolver } from '../../../providers/app-home/credential-profile-env.js';
import { credentialProfileAppHomeDir } from '../../../providers/app-home/credential-profile-registry.js';
import { observeExecutableInvocation } from '../../../providers/auth/executable-observation.js';
import { createEnsemblePreparationRoutes } from '../../../routes/orchestration/ensemble-preparation.js';
import { createOrchestrationRequestPrincipalResolver } from '../../../runtime/bootstrap/orchestration-request-principal.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import { createLogger } from '../../../utils/logger.js';
import { engineProxyLaunch } from '../../connections/engine-proxy-routing.js';
import { resolveExecutionTarget } from '../../execution-target/execution-target-resolver.js';
import { EnvironmentSecurityService } from '../../ssh/environment-security-service.js';
import {
  createLocalEnsembleInventory,
  EnsembleExecutionContext,
} from '../ensemble-execution-context.js';
import { EventBus } from '../event-bus.js';

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (command: string, ...args: unknown[]) => {
      const argv = args[0];
      if (
        /\/(codex|claude)$/.test(command) ||
        (command === process.execPath &&
          Array.isArray(argv) &&
          typeof argv[0] === 'string' &&
          argv[0].includes('/ensemble-context-') &&
          argv[0].endsWith('.js'))
      )
        return execFile(command, ...args);
      if (command === 'ps' || command === '/bin/ps')
        return Reflect.apply(actual.execFile, undefined, [command, ...args]);
      throw new Error(`Unexpected external process: ${command}`);
    },
  };
});
const tempDir = trackTempDirs();
const endpoint = '/api/orchestration/ensembles/prepare';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('STATION_DISABLE_LOGIN_PATH_RESOLVE', '1');
  vi.stubEnv('STATION_HOSTED_TENANT_REGISTRY_FILE', undefined);
  execFile.mockImplementation((_command, args, _options, callback) => {
    const argv = args[0]?.endsWith('.js') ? args.slice(1) : args;
    callback(null, {
      stdout:
        argv[0] === '--version'
          ? '99.0.0 (Claude Code)'
          : argv[0] === 'auth'
            ? '{"loggedIn":true}'
            : 'Logged in using ChatGPT',
      stderr: '',
    });
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function fixture(
  engine: 'claude' | 'codex' = 'codex',
  javascript = false,
) {
  const root = await realpath(tempDir('ensemble-context-'));
  vi.stubEnv('STATION_HOME', join(root, 'station-home'));
  const bin = join(root, 'bin');
  await mkdir(bin);
  const executable = join(bin, javascript ? 'cli.js' : engine);
  await writeFile(executable, '', { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  const cwd = join(root, 'project');
  await mkdir(cwd);
  const settings: AgentConnectionSettings = {
    config: {
      configHome: join(root, 'connection-home'),
      env: {
        ROUTING_LAYER: 'connection',
        ...(engine === 'claude'
          ? { ANTHROPIC_API_KEY: 'connection-credential' }
          : { OPENAI_API_KEY: 'connection-credential' }),
      },
    },
    credentialRecovery: {
      profiles: [
        {
          ref: 'selected',
          env:
            engine === 'claude'
              ? {
                  ANTHROPIC_BASE_URL: 'https://selected.example',
                  ANTHROPIC_API_KEY: '',
                }
              : {
                  OPENAI_BASE_URL: 'https://selected.example',
                  OPENAI_API_KEY: '',
                },
        },
      ],
      activeProfileRef: 'selected',
    },
  };
  const homeDir = join(root, 'credentials');
  const getAppHomeEnv = createCredentialProfileAppHomeEnvResolver({
    engine,
    homeDir,
    loadConnectionSettings: async () => settings,
  });
  let onConnectionRead: (() => Promise<void>) | undefined;
  const getConnectionLaunch = async () => {
    await onConnectionRead?.();
    return engineProxyLaunch(engine, settings.config, []);
  };
  const adapter =
    engine === 'claude'
      ? new ClaudeAdapter({
          getAppHomeEnv,
          getConnectionLaunch,
          ...(javascript ? { findBinary: async () => executable } : {}),
        })
      : new CodexAdapter({ getAppHomeEnv, getConnectionLaunch });
  const starts = vi.spyOn(adapter, 'startSession');
  const turns = vi.spyOn(adapter, 'sendTurn');
  const connection: ConnectionConfig = {
    id: engine,
    name: engine,
    kind: 'agent',
    type: engine,
    enabled: true,
    status: 'ready',
    capabilities: ['agent-runtime'],
    config: { provider: engine },
    prerequisites: [],
  };
  const execution: AgentExecutionConfig = {
    agentConnectionId: engineConnectionId(engine),
  };
  const modelCatalog = vi.spyOn(adapter, 'listModelCatalog');
  const inventory = createLocalEnsembleInventory({
    environmentId: () => 'test-station',
    getAgent: async (id) => ({ slug: id, execution }),
    listEngineConnectionIdentities: async () => [
      { id: engineConnectionId(connection.id), engineId: engine, type: engine },
    ],
    loadAppConfig: async () => ({
      defaultModel: '',
      invokeModel: '',
      structureModel: '',
      agentConnections: { [engine]: settings },
    }),
    getProject: () => ({
      workingDirectory: cwd,
      defaultWorkspaceIsolation: 'shared',
    }),
    getProviderAdapter: (provider) =>
      provider === engine ? adapter : undefined,
  });
  const security = new EnvironmentSecurityService({
    homeDir: join(root, 'security'),
  });
  const { credential: rawOperator } = await security.initialize();
  const offer = security.devicePairing.createOffer({
    endpoint: 'http://127.0.0.1',
  });
  const requested = security.devicePairing.requestPairing({
    requesterPosition: 'off-box',
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: 'Local host grant',
  });
  security.devicePairing.confirmRequest(requested.requestId, {
    kind: 'local-grant',
  });
  const local = security.devicePairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: requested.requestId,
    locality: 'home-possession',
    mintKind: 'local-grant',
  });
  const operator = local.credential;
  const revokeCurrent = async () => {
    security.devicePairing.revokeDevice(local.device.id, 'operator-credential');
  };
  const service = new EnsembleExecutionContext({ inventory, security });
  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    eventBus: new EventBus(),
    logger: createLogger({ name: 'ensemble-test', level: 'error' }),
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
  app.route(
    '/api/orchestration/ensembles',
    createEnsemblePreparationRoutes(
      service,
      createOrchestrationRequestPrincipalResolver({
        environmentSecurityService: security,
      }),
    ),
  );
  const preset = {
    version: ENSEMBLE_PRESET_VERSION,
    id: 'team',
    name: 'Team',
    stationmaster: 'lead',
    members: [
      {
        id: 'lead',
        codename: 'Rune',
        color: '#123ABC',
        role: 'coordinate',
        engine: String(engine),
        model: engine === 'codex' ? 'gpt-6.1-sol' : 'claude-opus-4-6',
        reasoning: null,
        options: {},
        promptAppends: [],
      },
    ],
  };
  const path = join(root, 'team.json');
  const body = {
    path,
    expectedPresetHash: '',
    brief: 'Prepare only',
    bindings: { lead: { agent: 'coordinator', projectSlug: 'project' } },
  };
  const save = async () => {
    const json = JSON.stringify(preset);
    await writeFile(path, json);
    body.expectedPresetHash = `sha256:${createHash('sha256').update(json).digest('hex')}`;
  };
  await save();
  const send = async (
    credential = operator,
    input: unknown = body,
    remoteAddress = '127.0.0.1',
    headers: Record<string, string> = {},
  ) => {
    const response = await app.request(
      endpoint,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential}`,
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(input),
      },
      { incoming: { socket: { remoteAddress } } },
    );
    return {
      status: response.status,
      body: z
        .object({
          code: z.string().optional(),
          observation: z
            .object({
              state: z.string(),
              contextHash: z.string(),
              modelEntitlement: z.string(),
              outputTokenLimitFidelity: z.string(),
            })
            .optional(),
        })
        .passthrough()
        .parse(await response.json()),
    };
  };
  const assertNoInvocations = () => {
    expect(modelCatalog.mock.calls.length).toBe(0);
    expect(starts).not.toHaveBeenCalled();
    expect(turns).not.toHaveBeenCalled();
  };
  return {
    engine,
    root,
    cwd,
    executable,
    settings,
    homeDir,
    connection,
    execution,
    inventory,
    security,
    operator,
    rawOperator,
    revokeCurrent,
    setConnectionRead: (read: () => Promise<void>) => {
      onConnectionRead = read;
    },
    preset,
    path,
    body,
    send,
    save,
    adapter,
    assertNoInvocations,
  };
}

describe('production Ensemble preparation authentication', () => {
  test.each(['codex', 'claude'] as const)(
    'probes %s in its selected profile and workspace, then refuses unsupported guarantees',
    async (engine) => {
      const f = await fixture(engine);
      const result = await f.send();
      expect(result.status).toBe(422);
      expect(result.body).toMatchObject({
        code: 'ensemble_execution_guarantees_unavailable',
        observation: {
          state: 'authenticated',
          modelEntitlement: 'not-checked',
          outputTokenLimitFidelity: 'unavailable',
          contextHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        },
      });
      const call = execFile.mock.calls.find((call) =>
        call[1].includes('status'),
      );
      expect(call).toBeDefined();
      const profile = credentialProfileAppHomeDir(
        engine,
        'selected',
        f.homeDir,
      );
      expect(call?.slice(0, 2)).toEqual([
        f.executable,
        engine === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'],
      ]);
      expect(call?.[2]).toMatchObject({
        cwd: f.cwd,
        windowsHide: true,
        killSignal: 'SIGKILL',
        timeout: expect.any(Number),
        maxBuffer: expect.any(Number),
        env: {
          ROUTING_LAYER: 'connection',
          ...(engine === 'codex'
            ? {
                CODEX_HOME: profile,
                OPENAI_BASE_URL: 'https://selected.example',
                OPENAI_API_KEY: '',
              }
            : {
                CLAUDE_CONFIG_DIR: profile,
                CLAUDE_SECURESTORAGE_CONFIG_DIR: profile,
                ANTHROPIC_BASE_URL: 'https://selected.example',
                ANTHROPIC_API_KEY: '',
              }),
        },
      });
      expect(JSON.stringify(result.body)).not.toContain(profile);
      expect(JSON.stringify(result.body)).not.toContain(
        'connection-credential',
      );
      f.assertNoInvocations();
    },
  );

  test.each([
    ['Not logged in', '', 1, 'unauthenticated'],
    ['You are not currently logged in', '', 0, 'unauthenticated'],
    ['inventory ready', '', 0, 'unknown'],
    ['Logged in using ChatGPT', 'Not logged in', 1, 'unauthenticated'],
  ])(
    'does not turn Codex status %s into readiness or entitlement',
    async (stdout, stderr, code, state) => {
      const f = await fixture();
      execFile.mockImplementation((_command, _args, _options, callback) =>
        callback(
          code
            ? Object.assign(new Error('exit'), { code, stdout, stderr })
            : null,
          { stdout, stderr },
        ),
      );
      const result = await f.send();
      expect(result.body).toMatchObject({
        code: 'ensemble_auth_unverified',
        observation: { state },
      });
      f.assertNoInvocations();
    },
  );

  test('binds the selected model to the opaque login context without claiming model entitlement', async () => {
    const f = await fixture();
    const first = await f.send();
    f.preset.members[0].model = 'gpt-6-sol';
    await f.save();
    const second = await f.send();
    expect(first.body.observation?.contextHash).not.toBe(
      second.body.observation?.contextHash,
    );
    expect(second.body.observation?.modelEntitlement).toBe('not-checked');
    f.assertNoInvocations();
  });

  test('refuses a profile mutation during the external CLI probe', async () => {
    const f = await fixture();
    execFile.mockImplementation((_command, _args, _options, callback) => {
      f.settings.credentialRecovery = {
        profiles: [{ ref: 'replacement' }],
        activeProfileRef: 'replacement',
      };
      callback(null, { stdout: 'Logged in using ChatGPT', stderr: '' });
    });
    const result = await f.send();
    expect(result.body).toMatchObject({
      code: 'ensemble_auth_unverified',
      observation: { state: 'unknown' },
    });
    f.assertNoInvocations();
  });

  test('refuses stale preset bytes and option discovery before any native process', async () => {
    const f = await fixture();
    await writeFile(f.path, `${JSON.stringify(f.preset)}\n`);
    expect((await f.send()).body.code).toBe('ensemble_preset_stale');
    f.preset.members[0].options = { fastMode: true };
    await f.save();
    expect((await f.send()).body.code).toBe(
      'ensemble_model_options_unverified',
    );
    expect(execFile.mock.calls.length).toBe(0);
    f.assertNoInvocations();
  });

  test('refuses a connection identity the native singleton does not own', async () => {
    const f = await fixture();
    f.connection.id = 'another-codex';
    expect((await f.send()).body.code).toBe('ensemble_auth_unsupported');
    expect(execFile.mock.calls.length).toBe(0);
    f.assertNoInvocations();
  });

  test('requires the actual operator credential; a device and spoofed body cannot borrow it', async () => {
    const f = await fixture();
    const offer = f.security.devicePairing.createOffer({
      endpoint: 'https://station.test',
      scope: 'orchestration:read orchestration:operate',
    });
    const requested = f.security.devicePairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Device',
    });
    f.security.devicePairing.confirmRequest(requested.requestId, {
      kind: 'presented-credential',
    });
    const device = f.security.devicePairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: requested.requestId,
    });
    expect((await f.send(device.credential)).body.code).toBe(
      'ensemble_preparation_authority_required',
    );
    expect(
      (
        await f.send(f.operator, {
          ...f.body,
          principalId: 'human:local:operator',
        })
      ).status,
    ).toBe(400);
    expect(execFile.mock.calls.length).toBe(0);
    f.assertNoInvocations();
  });

  test.each(['codex', 'claude'] as const)(
    'uses the receiver Agent pin for %s instead of connection default, and retires it when the Agent changes',
    async (engine) => {
      const f = await fixture(engine);
      f.settings.credentialRecovery = {
        profiles: [{ ref: 'default-b' }, { ref: 'pinned-a' }],
        activeProfileRef: 'default-b',
      };
      f.execution.credentialProfileRef = 'pinned-a';
      expect((await f.send()).body.code).toBe(
        'ensemble_execution_guarantees_unavailable',
      );
      const call = execFile.mock.calls.find((call) =>
        call[1].includes('status'),
      );
      expect(
        call?.[2].env[
          f.engine === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'
        ],
      ).toBe(credentialProfileAppHomeDir(f.engine, 'pinned-a', f.homeDir));
      execFile.mockImplementation((_command, _args, _options, callback) => {
        f.execution.credentialProfileRef = 'default-b';
        callback(null, {
          stdout:
            f.engine === 'claude'
              ? '{"loggedIn":true}'
              : 'Logged in using ChatGPT',
          stderr: '',
        });
      });
      expect((await f.send()).body.code).toBe('ensemble_context_changed');
      f.assertNoInvocations();
    },
  );

  test('preparation observes unknown status without changing normal execution admission', async () => {
    const f = await fixture();
    const target: ExecutionTarget = {
      environment: { kind: 'current' },
      agent: agentId('coordinator'),
      model: { override: 'gpt-6.1-sol' },
      workspace: { kind: 'project', projectSlug: 'project' },
    };
    await expect(resolveExecutionTarget(target, f.inventory)).rejects.toThrow(
      'not ready for execution (status: unknown)',
    );
    await expect(
      resolveExecutionTarget(target, f.inventory, { purpose: 'preparation' }),
    ).resolves.toMatchObject({ provider: 'codex', modelId: 'gpt-6.1-sol' });
    expect(execFile.mock.calls.length).toBe(0);
    f.assertNoInvocations();
  });

  test.each(['execution', 'preparation'] as const)(
    'preserves disabled, kind and capability checks for %s',
    async (purpose) => {
      const f = await fixture();
      const target: ExecutionTarget = {
        environment: { kind: 'current' },
        agent: agentId('coordinator'),
        model: { override: 'gpt-6.1-sol' },
      };
      const original = f.inventory.getConnection;
      const connection = await original(
        await f.inventory.resolveEnvironmentAccess(target),
        engineConnectionId('codex'),
      );
      for (const [invalid, reason] of [
        [
          { ...connection, status: 'ready' as const, enabled: false },
          'is disabled',
        ],
        [
          { ...connection, status: 'ready' as const, kind: 'model' as const },
          'does not resolve to an engine connection',
        ],
        [
          { ...connection, status: 'ready' as const, capabilities: [] },
          'does not advertise the agent-runtime capability',
        ],
      ] as const) {
        f.inventory.getConnection = async () => ({
          ...invalid,
          capabilities: [...invalid.capabilities],
        });
        await expect(
          resolveExecutionTarget(target, f.inventory, { purpose }),
        ).rejects.toThrow(reason);
      }
      expect(execFile.mock.calls.length).toBe(0);
      f.assertNoInvocations();
    },
  );

  test.each(['claude', 'codex'] as const)(
    'a timed-out %s command cannot authenticate from partial success output',
    async (engine) => {
      const f = await fixture(engine);
      execFile.mockImplementation((_command, args, _options, callback) => {
        if (args[0] === '--version')
          return callback(null, { stdout: '99.0.0 (Claude Code)', stderr: '' });
        callback(
          Object.assign(new Error('deadline'), {
            killed: true,
            code: null,
            stdout:
              engine === 'claude'
                ? '{"loggedIn":true}'
                : 'Logged in using ChatGPT',
            stderr: '',
          }),
        );
      });
      expect((await f.send()).body).toMatchObject({
        code: 'ensemble_auth_unverified',
        observation: { state: 'unknown' },
      });
      f.assertNoInvocations();
    },
  );

  test('refuses Claude executable fallback instead of probing another installed or bundled CLI', async () => {
    const f = await fixture('claude');
    execFile.mockImplementation((_command, _args, _options, callback) =>
      callback(null, { stdout: 'unparseable version', stderr: '' }),
    );
    expect((await f.send()).body).toMatchObject({
      code: 'ensemble_auth_unverified',
      observation: { state: 'unknown' },
    });
    expect(execFile.mock.calls.some((call) => call[1].includes('status'))).toBe(
      false,
    );
    f.assertNoInvocations();
  });

  test('refuses API engines before discovery instead of substituting a native engine', async () => {
    const f = await fixture();
    f.preset.members[0].engine = 'bedrock';
    await f.save();
    expect((await f.send()).body.code).toBe('ensemble_auth_unsupported');
    expect(execFile.mock.calls.length).toBe(0);
    f.assertNoInvocations();
  });

  test('refuses a symlink Project folder and worktree isolation before any auth command', async () => {
    const f = await fixture();
    const alias = join(f.root, 'alias');
    await symlink(f.cwd, alias);
    f.inventory.getProject = async () => ({
      workingDirectory: alias,
      defaultWorkspaceIsolation: 'shared',
    });
    expect((await f.send()).body.code).toBe('ensemble_workspace_unsupported');
    f.inventory.getProject = async () => ({
      workingDirectory: f.cwd,
      defaultWorkspaceIsolation: 'worktree',
    });
    expect((await f.send()).body.code).toBe('ensemble_workspace_unsupported');
    expect(execFile.mock.calls.length).toBe(0);
    f.assertNoInvocations();
  });

  test.each(['127.0.0.1', '203.0.113.42'])(
    'refuses raw operator credentials from %s before opening a preset, even with local-looking headers',
    async (address) => {
      const f = await fixture();
      const result = await f.send(
        f.rawOperator,
        { ...f.body, path: '/missing/preset.json' },
        address,
        {
          Host: '127.0.0.1',
          'X-Forwarded-For': '127.0.0.1',
          'X-Station-Client-Origin': 'local',
        },
      );
      expect(result.status).toBe(403);
      expect(result.body.code).toBe('ensemble_preparation_authority_required');
      expect(execFile.mock.calls.length).toBe(0);
      f.assertNoInvocations();
    },
  );

  test.each(['codex', 'claude'] as const)(
    'a credential revoked during %s private connection resolution starts no CLI, including version commands',
    async (engine) => {
      const f = await fixture(engine);
      f.setConnectionRead(async () => {
        await Promise.resolve();
        await f.revokeCurrent();
      });
      const result = await f.send();
      expect(result.status).toBe(403);
      expect(result.body.code).toBe('ensemble_preparation_authority_required');
      expect(execFile.mock.calls.length).toBe(0);
      f.assertNoInvocations();
    },
  );

  test('a credential revoked during the fresh Claude version command cannot start login status', async () => {
    const f = await fixture('claude');
    execFile.mockImplementation((_command, args, _options, callback) => {
      expect(args).toEqual(['--version']);
      void f
        .revokeCurrent()
        .then(() =>
          callback(null, { stdout: '99.0.0 (Claude Code)', stderr: '' }),
        );
    });
    expect((await f.send()).body.code).toBe(
      'ensemble_preparation_authority_required',
    );
    expect(execFile.mock.calls.map((call) => call[1])).toEqual([['--version']]);
    f.assertNoInvocations();
  });

  test.each([
    'slug',
    'missing-slug',
    'connection',
    'profile',
    'fingerprint',
  ] as const)(
    'rejects a substituted receiver %s at the pre-spawn definition read before using its profile',
    async (change) => {
      const f = await fixture();
      const original = f.inventory.getAgent;
      let reads = 0;
      f.inventory.getAgent = async (...args) => {
        const agent = await original(...args);
        if (++reads !== 3) return agent;
        if (change === 'slug') return { ...agent, slug: 'different-agent' };
        if (change === 'missing-slug') return { ...agent, slug: undefined };
        if (change === 'connection')
          return {
            ...agent,
            execution: {
              agentConnectionId: engineConnectionId('claude'),
              credentialProfileRef: 'untrusted-pin',
            },
          };
        if (change === 'profile')
          return {
            ...agent,
            execution: {
              ...agent.execution,
              credentialProfileRef: 'untrusted-pin',
            },
          };
        return { ...agent, definitionFingerprint: `sha256:${'1'.repeat(64)}` };
      };
      const result = await f.send();
      expect(result.status).toBe(422);
      expect(result.body.observation).toBeUndefined();
      expect(execFile.mock.calls.length).toBe(0);
      f.assertNoInvocations();
    },
  );

  test.each(['codex', 'claude'] as const)(
    'revalidates the full %s receiver binding after private asynchronous setup',
    async (engine) => {
      const f = await fixture(engine);
      f.setConnectionRead(async () => {
        await Promise.resolve();
        f.execution.agentConnectionId = engineConnectionId(
          engine === 'codex' ? 'claude' : 'codex',
        );
        f.execution.credentialProfileRef = 'changed-pin';
      });
      const result = await f.send();
      expect(result.status).toBe(422);
      expect(result.body.observation).toBeUndefined();
      expect(execFile.mock.calls.length).toBe(0);
      f.assertNoInvocations();
    },
  );

  test.each([
    ['{"loggedIn":true}', 'Not logged in', 1, 'unauthenticated'],
    ['{"loggedIn":true}', '', 1, 'unknown'],
    ['{"loggedIn":true}', '{"loggedIn":false}', 0, 'unauthenticated'],
    ['{"loggedIn":false}', '{"loggedIn":true}', 1, 'unauthenticated'],
    ['{"loggedIn":true}', '', 0, 'authenticated'],
  ] as const)(
    'Claude status %s / %s with exit %s reports %s',
    async (stdout, stderr, code, state) => {
      const f = await fixture('claude');
      execFile.mockImplementation((_command, args, _options, callback) => {
        if (args[0] === '--version')
          return callback(null, { stdout: '99.0.0 (Claude Code)', stderr: '' });
        callback(
          code
            ? Object.assign(new Error('status exit'), { code, stdout, stderr })
            : null,
          { stdout, stderr },
        );
      });
      const result = await f.send();
      expect(result.body.observation?.state).toBe(state);
      expect(result.body.code).toBe(
        state === 'authenticated'
          ? 'ensemble_execution_guarantees_unavailable'
          : 'ensemble_auth_unverified',
      );
      f.assertNoInvocations();
    },
  );

  test.each(['codex', 'claude'] as const)(
    'rejects same-path %s executable byte replacement during the CLI probe',
    async (engine) => {
      const f = await fixture(engine);
      execFile.mockImplementation((_command, args, _options, callback) => {
        if (args[0] === '--version')
          return callback(null, { stdout: '99.0.0 (Claude Code)', stderr: '' });
        void writeFile(f.executable, 'replacement executable bytes').then(() =>
          callback(null, {
            stdout:
              engine === 'codex'
                ? 'Logged in using ChatGPT'
                : '{"loggedIn":true}',
            stderr: '',
          }),
        );
      });
      const result = await f.send();
      expect(result.body).toMatchObject({
        code: 'ensemble_auth_unverified',
        observation: { state: 'unknown' },
      });
      f.assertNoInvocations();
    },
  );

  test.each(['codex', 'claude'] as const)(
    'rejects replacement of the %s executable inode even when its bytes are identical',
    async (engine) => {
      const f = await fixture(engine);
      execFile.mockImplementation((_command, args, _options, callback) => {
        if (args[0] === '--version')
          return callback(null, { stdout: '99.0.0 (Claude Code)', stderr: '' });
        void rename(f.executable, `${f.executable}.old`)
          .then(() => writeFile(f.executable, '', { mode: 0o755 }))
          .then(() =>
            callback(null, {
              stdout:
                engine === 'codex'
                  ? 'Logged in using ChatGPT'
                  : '{"loggedIn":true}',
              stderr: '',
            }),
          );
      });
      expect((await f.send()).body).toMatchObject({
        code: 'ensemble_auth_unverified',
        observation: { state: 'unknown' },
      });
      f.assertNoInvocations();
    },
  );

  test('Claude authentication does not reuse a successful readiness version cache', async () => {
    const f = await fixture('claude');
    await f.adapter.getPrerequisites();
    expect(execFile.mock.calls.map((call) => call[1])).toEqual([['--version']]);
    execFile.mockClear();
    execFile.mockImplementation((_command, args, _options, callback) => {
      expect(args).toEqual(['--version']);
      callback(null, { stdout: 'version unavailable', stderr: '' });
    });
    expect((await f.send()).body).toMatchObject({
      code: 'ensemble_auth_unverified',
      observation: { state: 'unknown' },
    });
    expect(execFile.mock.calls.map((call) => call[1])).toEqual([['--version']]);
    f.assertNoInvocations();
  });

  test.each(['codex', 'claude'] as const)(
    'an unbound shebang interpreter for %s is refused without executing it',
    async (engine) => {
      const f = await fixture(engine);
      await writeFile(f.executable, '#!/unbound/interpreter\n');
      expect((await f.send()).body).toMatchObject({
        code: 'ensemble_auth_unverified',
        observation: { state: 'unknown' },
      });
      expect(execFile.mock.calls.length).toBe(0);
      f.assertNoInvocations();
    },
  );

  test('a Claude JavaScript entry binds the exact script and Node interpreter argv, then refuses script replacement', async () => {
    const f = await fixture('claude', true);
    const result = await f.send();
    expect(result.body.observation?.state).toBe('authenticated');
    expect(execFile.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      [process.execPath, [f.executable, '--version']],
      [process.execPath, [f.executable, 'auth', 'status', '--json']],
    ]);
    execFile.mockImplementation((_command, args, _options, callback) => {
      if (args.includes('--version'))
        return callback(null, { stdout: '99.0.0 (Claude Code)', stderr: '' });
      void writeFile(f.executable, '// replaced JavaScript entry').then(() =>
        callback(null, { stdout: '{"loggedIn":true}', stderr: '' }),
      );
    });
    expect((await f.send()).body).toMatchObject({
      code: 'ensemble_auth_unverified',
      observation: { state: 'unknown' },
    });
    f.assertNoInvocations();
  });

  test('the shared invocation observation binds interpreter bytes as well as JavaScript source', async () => {
    const root = await realpath(tempDir('ensemble-interpreter-'));
    const interpreter = join(root, 'node');
    const script = join(root, 'cli.js');
    await writeFile(interpreter, 'fixture interpreter');
    await writeFile(script, '// fixture source');
    const before = await observeExecutableInvocation(interpreter, script);
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    await writeFile(interpreter, 'replacement interpreter');
    expect(await observeExecutableInvocation(interpreter, script)).not.toBe(
      before,
    );
  });

  test.each(['codex', 'claude'] as const)(
    'an explicit null Agent pin for %s retains the connection active profile',
    async (engine) => {
      const f = await fixture(engine);
      f.execution.credentialProfileRef = null;
      expect((await f.send()).body.observation?.state).toBe('authenticated');
      const call = execFile.mock.calls.find((entry) =>
        entry[1].includes('status'),
      );
      expect(
        call?.[2].env[engine === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'],
      ).toBe(credentialProfileAppHomeDir(engine, 'selected', f.homeDir));
      f.assertNoInvocations();
    },
  );

  test('rechecks the actual credential after asynchronous resolution, before any auth command', async () => {
    const f = await fixture();
    const original = f.inventory.getProject;
    let resolutions = 0;
    f.inventory.getProject = async (...args) => {
      const project = await original(...args);
      if (++resolutions === 2) await f.revokeCurrent();
      return project;
    };
    expect((await f.send()).body.code).toBe(
      'ensemble_preparation_authority_required',
    );
    expect(execFile.mock.calls.length).toBe(0);
    f.assertNoInvocations();
  });

  test('rechecks credential currency after the process observation', async () => {
    const f = await fixture();
    execFile.mockImplementation((_command, _args, _options, callback) => {
      void f
        .revokeCurrent()
        .then(() =>
          callback(null, { stdout: 'Logged in using ChatGPT', stderr: '' }),
        );
    });
    expect((await f.send()).body.code).toBe(
      'ensemble_preparation_authority_required',
    );
    f.assertNoInvocations();
  });
});
