import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  mkdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  AgentExecutionConfig,
  AgentMetadata,
} from '@kontourai/station-contracts/agent';
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
import { ConfigLoader } from '../../../domain/config-loader.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { ClaudeAdapter } from '../../../providers/adapters/claude-adapter.js';
import { CodexAdapter } from '../../../providers/adapters/codex-adapter.js';
import { createCredentialProfileAppHomeEnvResolver } from '../../../providers/app-home/credential-profile-env.js';
import { credentialProfileAppHomeDir } from '../../../providers/app-home/credential-profile-registry.js';
import { observeExecutableInvocation } from '../../../providers/auth/executable-observation.js';
import { createEnsembleInspectionRoutes } from '../../../routes/orchestration/ensemble-inspection.js';
import { createEnsemblePreparationRoutes } from '../../../routes/orchestration/ensemble-preparation.js';
import { createOrchestrationRequestPrincipalResolver } from '../../../runtime/bootstrap/orchestration-request-principal.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import { createLogger } from '../../../utils/logger.js';
import { AgentService } from '../../agents/agent-service.js';
import { engineProxyLaunch } from '../../connections/engine-proxy-routing.js';
import { ProviderService } from '../../connections/provider-service.js';
import { resolveExecutionTarget } from '../../execution-target/execution-target-resolver.js';
import { EnvironmentSecurityService } from '../../ssh/environment-security-service.js';
import {
  createLocalEnsembleInventory,
  EnsembleExecutionContext,
} from '../ensemble-execution-context.js';
import { EnsembleInspectionService } from '../ensemble-inspection.js';
import {
  authenticateEnsembleSessionGroup,
  type EnsembleSessionAuthenticationObserver,
} from '../ensemble-session-group-authentication.js';
import { EventBus } from '../event-bus.js';

const { execFile, nativeSpawn, nativeQuery } = vi.hoisted(() => ({
  execFile: vi.fn(),
  nativeSpawn: vi.fn(),
  nativeQuery: vi.fn(),
}));
// File-store fixtures must not depend on this host's Keychain or managed preferences.
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  platform: () => 'linux',
}));
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: nativeQuery,
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: nativeSpawn,
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
const loaders = new Set<ConfigLoader>();
const endpoint = '/api/orchestration/ensembles/prepare';

beforeEach(() => {
  vi.clearAllMocks();
  nativeSpawn.mockImplementation(() => {
    throw new Error('native_spawn_control');
  });
  vi.stubEnv('CLAUDE_AGENT_SDK_VERSION', undefined);
  nativeQuery.mockImplementation(({ options }) => {
    vi.stubEnv('CLAUDE_AGENT_SDK_VERSION', '0.3.302');
    return options.spawnClaudeCodeProcess({
      command: options.pathToClaudeCodeExecutable?.endsWith('.js')
        ? 'node'
        : options.pathToClaudeCodeExecutable,
      args: [
        ...(options.pathToClaudeCodeExecutable?.endsWith('.js')
          ? [options.pathToClaudeCodeExecutable]
          : []),
        '--model',
        options.model,
      ],
      cwd: options.cwd,
      env: {
        ...options.env,
        CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
        CLAUDE_AGENT_SDK_VERSION: '0.3.302',
        CLAUDE_CODE_SDK_READS_SESSION_STATE:
          options.env.CLAUDE_CODE_SDK_READS_SESSION_STATE ?? '1',
      },
    });
  });
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
afterEach(async () => {
  try {
    const outcomes = await Promise.allSettled(
      [...loaders].map(async (loader) => {
        await loader.dispose();
        await loader.whenWatcherClosed();
      }),
    );
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason] : [],
    );
    if (failures.length)
      throw new AggregateError(
        failures,
        'Ensemble configuration fixture cleanup failed',
      );
  } finally {
    loaders.clear();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  }
});

async function fixture(
  engine: 'claude' | 'codex' = 'codex',
  javascript = false,
) {
  const root = await realpath(tempDir('ensemble-context-'));
  vi.stubEnv('HOME', root);
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
  const execution: AgentExecutionConfig = {
    agentConnectionId: engineConnectionId(engine),
  };
  const configurationHome = join(root, 'configuration');
  await mkdir(configurationHome);
  const configLoader = new ConfigLoader({ projectHomeDir: configurationHome });
  loaders.add(configLoader);
  await configLoader.loadStoredAppConfig();
  const storage = new FileStorageAdapter(configurationHome);
  const metadata = new Map<string, AgentMetadata>();
  const agentService = new AgentService(
    configLoader,
    storage,
    new Map(),
    metadata,
    new Map(),
    createLogger({ name: 'ensemble-agent-test', level: 'error' }),
  );
  const providers = new ProviderService(storage, () =>
    configLoader.loadAppConfig(),
  );
  let persistedSettings = '';
  let persistedExecution = '';
  const persist = async () => {
    const nextSettings = JSON.stringify(settings);
    const nextExecution = JSON.stringify(execution);
    if (nextSettings !== persistedSettings) {
      await configLoader.saveAppConfig({
        defaultModel: 'default/model',
        invokeModel: '',
        structureModel: '',
        systemPrompt: 'Fixture',
        agentConnections: { [engine]: settings },
      });
      persistedSettings = nextSettings;
    }
    if (nextExecution !== persistedExecution) {
      await configLoader.saveAgent('coordinator', {
        name: 'Coordinator',
        prompt: 'Fixture',
        execution,
      });
      persistedExecution = nextExecution;
    }
  };
  await persist();
  await storage.createProject({
    id: 'project-1',
    name: 'Project',
    slug: 'project',
    workingDirectory: cwd,
    defaultWorkspaceIsolation: 'shared',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const homeDir = join(root, 'credentials');
  const getAppHomeEnv = createCredentialProfileAppHomeEnvResolver({
    engine,
    homeDir,
    loadConnectionSettings: async () =>
      (await configLoader.loadAppConfig()).agentConnections?.[engine],
  });
  let profileOverride: string | undefined;
  const resolveAppHome = async (ref?: string) => {
    const home = await getAppHomeEnv(ref);
    return home && profileOverride
      ? { ...home, profileRef: profileOverride }
      : home;
  };
  let connectionArgsOverride: string[] | undefined;
  let onConnectionRead: (() => Promise<void>) | undefined;
  const getConnectionLaunch = async () => {
    await onConnectionRead?.();
    await persist();
    const launch = engineProxyLaunch(
      engine,
      (await configLoader.loadAppConfig()).agentConnections?.[engine]?.config,
      providers.listProviderConnections(),
    );
    return { ...launch, args: connectionArgsOverride ?? launch.args };
  };
  const adapter =
    engine === 'claude'
      ? new ClaudeAdapter({
          getAppHomeEnv: resolveAppHome,
          getConnectionLaunch,
          ...(javascript ? { findBinary: async () => executable } : {}),
        })
      : new CodexAdapter({
          getAppHomeEnv: resolveAppHome,
          getConnectionLaunch,
        });
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
  const modelCatalog = vi.spyOn(adapter, 'listModelCatalog');
  const inventory = createLocalEnsembleInventory({
    environmentId: () => 'test-station',
    captureAgentConfigurationFence: (ids) =>
      agentService.capturePreparationConfigurationFence(ids),
    getProjectRevision: (slug) => storage.projectRevision(slug),
    getProviderRevision: () => providers.getLaunchabilityRevision(),
    getAgent: (id) => agentService.getAgent(id),
    listEngineConnectionIdentities: async () => [
      { id: engineConnectionId(connection.id), engineId: engine, type: engine },
    ],
    loadAppConfig: () => configLoader.loadAppConfig(),
    getProject: (slug) => storage.getProject(slug),
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
  app.route(
    '/api/orchestration/ensembles',
    createEnsembleInspectionRoutes(
      new EnsembleInspectionService({
        security,
        inventory,
        readIntegration: () => undefined,
        readProject: (slug) => storage.getProject(slug),
        verifyAuthentication: async (input, principal, current, observe) => {
          await authenticateEnsembleSessionGroup(
            input,
            inventory,
            principal.id,
            () => security.withCurrentAuthority(current),
            observe,
          );
        },
      }),
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
    route = endpoint,
  ) => {
    await persist();
    const response = await app.request(
      route,
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
    persist,
    configLoader,
    storage,
    agentService,
    providers,
    metadata,
    configurationHome,
    homeDir,
    connection,
    execution,
    inventory,
    security,
    operator,
    rawOperator,
    revokeCurrent,
    setConnectionArgs: (value: string[] | undefined) => {
      connectionArgsOverride = value;
    },
    setProfileOverride: (value: string) => {
      profileOverride = value;
    },
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

async function authenticateFixture(
  f: Awaited<ReturnType<typeof fixture>>,
  signal = new AbortController().signal,
  seats: readonly string[] = ['lead'],
  onObservation?: EnsembleSessionAuthenticationObserver,
) {
  return authenticateEnsembleSessionGroup(
    {
      groupId: 'native-spawn',
      intentDigest: 'native-intent',
      signal,
      members: seats.map((seatId) => ({
        seatId,
        target: {
          agent: agentId('coordinator'),
          environment: { kind: 'current' },
          expectedEngine: {
            kind: 'connection',
            connectionId: engineConnectionId(f.engine),
          },
          workspace: { kind: 'project', projectSlug: 'project' },
          model: { override: f.preset.members[0].model, options: {} },
        },
      })),
    },
    f.inventory,
    'fixture-principal',
    () => {},
    onObservation,
  );
}

describe('production Ensemble preparation authentication', () => {
  test.each(['authenticated', 'one-signed-out'] as const)(
    'roster probes overlap and drain before returning %s',
    async (outcome) => {
      const f = await fixture('codex');
      const held: Array<() => void> = [];
      let released = false;
      let statusCount = 0;
      execFile.mockImplementation((_command, args, _options, callback) => {
        if (args[0] === '--version') {
          callback(null, { stdout: '99.0.0', stderr: '' });
          return;
        }
        if (!args.includes('status'))
          throw new Error('Unexpected authentication command');
        const index = statusCount++;
        const reply = () =>
          callback(null, {
            stdout:
              outcome === 'one-signed-out' && index === 0
                ? 'Not logged in'
                : 'Logged in using ChatGPT',
            stderr: '',
          });
        if (released) reply();
        else held.push(reply);
      });
      let refused: () => void = () => {};
      const firstRefusal = new Promise<void>((resolve) => {
        refused = resolve;
      });
      const observations: Promise<unknown>[] = [];
      const observe = f.adapter.observeExecutionAuthentication.bind(f.adapter);
      vi.spyOn(f.adapter, 'observeExecutionAuthentication').mockImplementation(
        (input) => {
          const read = observe(input);
          observations.push(read);
          return read;
        },
      );
      let helperSettled = false;
      const settled = authenticateFixture(
        f,
        new AbortController().signal,
        ['lead', 'check', 'join'],
        (observation) => {
          if (observation.state === 'unauthenticated') refused();
        },
      ).then(
        (value) => {
          helperSettled = true;
          return { status: 'fulfilled' as const, value };
        },
        (reason: unknown) => {
          helperSettled = true;
          return { status: 'rejected' as const, reason };
        },
      );
      let completed: Awaited<typeof settled>;
      try {
        await vi.waitFor(() => expect(held).toHaveLength(3), {
          timeout: 3_000,
        });
        if (outcome === 'one-signed-out') {
          const first = held.shift();
          if (!first) throw new Error('Missing first authentication gate');
          first();
          await firstRefusal;
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(helperSettled).toBe(false);
        }
      } finally {
        released = true;
        for (const reply of held.splice(0)) reply();
        completed = await settled;
        await Promise.allSettled(observations);
      }
      expect(completed).toMatchObject(
        outcome === 'authenticated'
          ? { status: 'fulfilled' }
          : {
              status: 'rejected',
              reason: { code: 'ensemble_auth_unverified' },
            },
      );
      expect(statusCount).toBe(3);
      expect(nativeSpawn).not.toHaveBeenCalled();
      f.assertNoInvocations();
    },
  );
  test.each([
    ['inactive', false],
    ['selected', true],
    ['default-provider', true],
    ['openai-override', true],
    ['selected-in-workspace', true],
  ] as const)(
    'Codex %s provider configuration preserves the authenticated launch boundary',
    async (configuration, refused) => {
      const f = await fixture('codex');
      const config = join(
        credentialProfileAppHomeDir('codex', 'selected', f.homeDir),
        'config.toml',
      );
      const declarations = [
        '[model_providers.vibe]',
        'name = "Dormant provider"',
        'base_url = "https://dormant.example/v1"',
        'env_key = "DORMANT_FIXTURE_KEY"',
        '[profiles.vibe]',
        'model_provider = "vibe"',
      ].join('\n');
      const content =
        configuration === 'selected'
          ? `profile = "vibe"\n${declarations}`
          : configuration === 'default-provider'
            ? `model_provider = "vibe"\n${declarations}`
            : configuration === 'openai-override'
              ? '[model_providers.openai]\nbase_url = "https://different.example/v1"'
              : declarations;
      await mkdir(dirname(config), { recursive: true });
      await writeFile(config, content);
      if (configuration === 'selected-in-workspace') {
        const workspaceConfig = join(f.cwd, '.codex', 'config.toml');
        await mkdir(dirname(workspaceConfig), { recursive: true });
        await writeFile(workspaceConfig, 'profile = "vibe"');
      }
      if (refused) {
        await expect(authenticateFixture(f)).rejects.toThrow(
          'ensemble_auth_store_unsupported',
        );
        expect(
          execFile.mock.calls.filter((call) => call[1].includes('status')),
        ).toHaveLength(0);
        expect(nativeSpawn).not.toHaveBeenCalled();
        f.assertNoInvocations();
        return;
      }
      const admission = await authenticateFixture(f);
      const start = () =>
        admission.invokeDispatch!('lead', 'reserved-native', () =>
          f.adapter.startSession({
            provider: 'codex',
            threadId: 'reserved-native',
            cwd: f.cwd,
            modelId: f.preset.members[0].model,
            confinement: 'host',
          }),
        );
      await expect(start()).rejects.toThrow('native_spawn_control');
      expect(nativeSpawn).toHaveBeenCalledTimes(1);
      nativeSpawn.mockClear();
      f.setConnectionArgs(['--profile', 'vibe']);
      await expect(start()).rejects.toThrow('ensemble_auth_arguments_changed');
      expect(nativeSpawn).not.toHaveBeenCalled();
      f.setConnectionArgs(undefined);
      await writeFile(config, `profile = "vibe"\n${declarations}`);
      expect(start).toThrow('ensemble_auth_file_changed');
      expect(nativeSpawn).not.toHaveBeenCalled();
    },
  );
  test.each(['effective', 'fallback'] as const)(
    'refuses Claude %s remote policy cache before login status',
    async (location) => {
      const f = await fixture('claude');
      const cache = join(
        location === 'effective'
          ? credentialProfileAppHomeDir('claude', 'selected', f.homeDir)
          : join(f.root, '.claude'),
        'remote-settings.json',
      );
      await mkdir(dirname(cache), { recursive: true });
      await writeFile(cache, '{"apiKeyHelper":"remote-policy-helper"}');
      await expect(authenticateFixture(f)).rejects.toThrow(
        'ensemble_auth_store_unsupported',
      );
      expect(
        execFile.mock.calls.filter((call) => call[1].includes('status')),
      ).toHaveLength(0);
      expect(nativeSpawn).not.toHaveBeenCalled();
      f.assertNoInvocations();
    },
  );

  test.each([
    ['codex', false],
    ['claude', false],
    ['claude', true],
  ] as const)(
    '%s guards the actual spawn after login and receiver-resolution awaits (JavaScript: %s)',
    async (engine, javascript) => {
      const f = await fixture(engine, javascript);
      const admission = await authenticateFixture(f);
      const start = () =>
        admission.invokeDispatch!('lead', 'reserved-native', () =>
          f.adapter.startSession({
            provider: f.engine,
            threadId: 'reserved-native',
            cwd: f.cwd,
            modelId: f.preset.members[0].model,
            confinement: 'host',
          }),
        );
      await expect(start()).rejects.toThrow('native_spawn_control');
      expect(nativeSpawn).toHaveBeenCalledTimes(1);
      expect(nativeSpawn.mock.calls[0][2].cwd).toBe(f.cwd);
      nativeSpawn.mockClear();
      const sdkSpawn = nativeQuery.getMockImplementation();
      if (!sdkSpawn) throw new Error('missing SDK spawn fixture');
      if (engine === 'claude') {
        const previousApiKey = process.env.ANTHROPIC_API_KEY;
        nativeQuery.mockImplementationOnce(({ options }) => {
          vi.stubEnv('ANTHROPIC_API_KEY', 'changed-ambient-credential');
          return sdkSpawn({ options });
        });
        await expect(start()).rejects.toThrow(
          'Preparation runtime configuration changed',
        );
        expect(nativeSpawn).not.toHaveBeenCalled();
        vi.stubEnv('ANTHROPIC_API_KEY', previousApiKey);
        nativeQuery.mockImplementationOnce(({ options }) =>
          options.spawnClaudeCodeProcess({
            command: options.pathToClaudeCodeExecutable?.endsWith('.js')
              ? 'node'
              : options.pathToClaudeCodeExecutable,
            args: [
              ...(options.pathToClaudeCodeExecutable?.endsWith('.js')
                ? [options.pathToClaudeCodeExecutable]
                : []),
              '--model',
              options.model,
            ],
            cwd: options.cwd,
            env: { ...options.env, CLAUDE_CODE_SDK_READS_SESSION_STATE: '0' },
          }),
        );
        await expect(start()).rejects.toThrow(
          'ensemble_auth_native_context_changed',
        );
        expect(nativeSpawn).not.toHaveBeenCalled();
      }
      if (engine === 'codex') {
        f.setConnectionArgs(['-c', 'cli_auth_credentials_store="keyring"']);
      } else {
        nativeQuery.mockImplementationOnce(({ options }) =>
          options.spawnClaudeCodeProcess({
            command: options.pathToClaudeCodeExecutable?.endsWith('.js')
              ? 'node'
              : options.pathToClaudeCodeExecutable,
            args: [
              ...(options.pathToClaudeCodeExecutable?.endsWith('.js')
                ? [options.pathToClaudeCodeExecutable]
                : []),
              '--settings',
              '{"apiKeyHelper":"different-account"}',
            ],
            cwd: options.cwd,
            env: {
              ...options.env,
              CLAUDE_CODE_SDK_READS_SESSION_STATE:
                options.env.CLAUDE_CODE_SDK_READS_SESSION_STATE ?? '1',
            },
          }),
        );
      }
      await expect(start()).rejects.toThrow('ensemble_auth_arguments_changed');
      expect(nativeSpawn).not.toHaveBeenCalled();
      f.setConnectionArgs(undefined);
      if (engine === 'claude') {
        nativeQuery.mockImplementationOnce(({ options }) =>
          options.spawnClaudeCodeProcess({
            command: options.pathToClaudeCodeExecutable?.endsWith('.js')
              ? 'node'
              : options.pathToClaudeCodeExecutable,
            args: [
              ...(options.pathToClaudeCodeExecutable?.endsWith('.js')
                ? [options.pathToClaudeCodeExecutable]
                : []),
              '--model',
              options.model,
            ],
            cwd: options.cwd,
            env: {
              ...options.env,
              CLAUDE_CODE_SDK_READS_SESSION_STATE:
                options.env.CLAUDE_CODE_SDK_READS_SESSION_STATE ?? '1',
              ANTHROPIC_API_KEY: 'changed-after-query',
            },
          }),
        );
        await expect(start()).rejects.toThrow(
          'ensemble_auth_native_context_changed',
        );
        expect(nativeSpawn).not.toHaveBeenCalled();
      }
      f.setProfileOverride('different-profile-same-home');
      await expect(start()).rejects.toThrow(
        'ensemble_auth_native_context_changed',
      );
      expect(nativeSpawn).not.toHaveBeenCalled();
      f.setProfileOverride('selected');
      if (engine === 'claude') {
        for (const cache of [
          join(
            credentialProfileAppHomeDir('claude', 'selected', f.homeDir),
            'remote-settings.json',
          ),
          join(f.root, '.claude', 'remote-settings.json'),
        ]) {
          await mkdir(dirname(cache), { recursive: true });
          nativeQuery.mockImplementationOnce(({ options }) => {
            writeFileSync(cache, '{"apiKeyHelper":"unwitnessed-cache-helper"}');
            return sdkSpawn({ options });
          });
          await expect(start()).rejects.toThrow('ensemble_auth_file_changed');
          expect(nativeSpawn).not.toHaveBeenCalled();
          await rm(cache);
          await expect(start()).rejects.toThrow('native_spawn_control');
          expect(nativeSpawn).toHaveBeenCalledTimes(1);
          nativeSpawn.mockClear();
        }
      }
      let changed = false;
      if (engine === 'codex') {
        f.setConnectionRead(async () => {
          if (!changed) {
            changed = true;
            await writeFile(f.executable, 'changed during receiver resolution');
          }
        });
      } else {
        nativeQuery.mockImplementationOnce(({ options }) => {
          writeFileSync(f.executable, 'changed after lazy SDK capture');
          return sdkSpawn({ options });
        });
      }
      await expect(start()).rejects.toThrow(
        'Execution authentication executable changed',
      );
      expect(nativeSpawn).not.toHaveBeenCalled();
      expect(f.adapter.sendTurn).not.toHaveBeenCalled();
    },
  );

  test.each(['codex', 'claude'] as const)(
    '%s run admission refreshes stale login once and rejects expired, replaced-executable or aborted effect fences',
    async (engine) => {
      const f = await fixture(engine);
      const controller = new AbortController();
      const realNow = Date.now.bind(Date);
      let advance = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => realNow() + advance);
      const admission = await authenticateEnsembleSessionGroup(
        {
          groupId: 'run-auth',
          intentDigest: 'intent-auth',
          signal: controller.signal,
          members: [
            {
              seatId: 'lead',
              target: {
                agent: agentId('coordinator'),
                environment: { kind: 'current' },
                expectedEngine: {
                  kind: 'connection',
                  connectionId: engineConnectionId(engine),
                },
                workspace: { kind: 'project', projectSlug: 'project' },
                model: { override: f.preset.members[0].model, options: {} },
              },
            },
          ],
        },
        f.inventory,
        'fixture-principal',
        () => {},
      );
      const statusCount = () =>
        execFile.mock.calls.filter((call) => call[1].includes('status')).length;
      expect(statusCount()).toBe(1);
      const initial = await admission.prepareDispatch('lead');
      initial();
      expect(statusCount()).toBe(2);
      advance = 30_001;
      expect(initial).toThrow('ensemble_auth_stale');
      const refreshed = await Promise.all([
        admission.prepareDispatch('lead'),
        admission.prepareDispatch('lead'),
      ]);
      expect(statusCount()).toBe(3);
      refreshed.forEach((assertCurrent) => assertCurrent());
      const statusCall = execFile.mock.calls.find((call) =>
        call[1].includes('status'),
      );
      expect(statusCall?.[2].signal).toBe(controller.signal);
      const observedHome =
        statusCall?.[2].env[
          engine === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'
        ];
      expect(typeof observedHome).toBe('string');
      if (engine === 'claude') {
        const metadata = join(f.root, '.claude.json');
        await writeFile(metadata, '{"numStartups":1}');
        refreshed[0]();
        await writeFile(metadata, '{"oauthAccount":{"accountUuid":"changed"}}');
        expect(refreshed[0]).toThrow('ensemble_auth_file_changed');
        await rm(metadata);
        refreshed[0]();
      }
      const configFile = join(
        observedHome,
        engine === 'codex' ? 'config.toml' : 'settings.json',
      );
      await writeFile(
        configFile,
        engine === 'codex' ? 'model = "changed"' : '{"model":"changed"}',
      );
      expect(refreshed[0]).toThrow('ensemble_auth_file_changed');
      await rm(configFile);
      refreshed[0]();
      await writeFile(f.executable, 'replaced after login');
      expect(refreshed[0]).toThrow(
        'Execution authentication executable changed',
      );
      expect(statusCount()).toBe(3);
      controller.abort();
      expect(refreshed[0]).toThrow();
      await expect(admission.prepareDispatch('lead')).rejects.toThrow();
      expect(statusCount()).toBe(3);
      f.assertNoInvocations();
    },
  );

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
      void f
        .persist()
        .then(() =>
          callback(null, { stdout: 'Logged in using ChatGPT', stderr: '' }),
        );
    });
    const result = await f.send();
    expect(result.body.code).toBe('ensemble_context_changed');
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
        void f.persist().then(() =>
          callback(null, {
            stdout:
              f.engine === 'claude'
                ? '{"loggedIn":true}'
                : 'Logged in using ChatGPT',
            stderr: '',
          }),
        );
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
      expect(result.body.error).toBeUndefined();
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
    expect(before?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    await writeFile(interpreter, 'replacement interpreter');
    expect(
      (await observeExecutableInvocation(interpreter, script))?.fingerprint,
    ).not.toBe(before?.fingerprint);
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

  test.each(['codex', 'claude'] as const)(
    '%s finalizes original owner snapshots after the last Project await',
    async (engine) => {
      for (const change of [
        'pin',
        'pin-aba',
        'project-aba',
        'provider-aba',
        'connection',
        'active-profile',
        'profile-overlay',
        'project',
        'projection',
        'provider',
        'executable',
        'acp-config',
      ] as const) {
        const f = await fixture(engine);
        let privateSetup = false;
        let changed = false;
        f.setConnectionRead(async () => {
          privateSetup = true;
        });
        const original = f.inventory.getProject;
        f.inventory.getProject = async (...args) => {
          const result = await original(...args);
          if (!privateSetup || changed) return result;
          changed = true;
          await Promise.resolve();
          if (change === 'acp-config') {
            await f.configLoader.saveACPConfig({
              connections: [
                {
                  id: 'opencode',
                  name: 'Changed during preparation',
                  command: 'unused',
                  enabled: false,
                },
              ],
            });
          }
          if (change === 'pin') {
            f.execution.credentialProfileRef = 'new-pin';
            await f.persist();
          }
          if (change === 'pin-aba') {
            f.execution.credentialProfileRef = 'temporary';
            await f.persist();
            delete f.execution.credentialProfileRef;
            await f.persist();
          }
          if (change === 'project-aba') {
            const initial = f.storage.getProject('project');
            await f.storage
              .projectRevision('project')
              .replace({ ...initial, name: 'Temporary Project' });
            await f.storage.projectRevision('project').replace(initial);
          }
          if (change === 'provider-aba') {
            await f.providers.saveProviderConnection({
              id: 'temporary-proxy',
              type: 'openai-compat',
              name: 'Temporary',
              enabled: true,
              capabilities: ['llm'],
              config: {
                apiKey: 'fixture',
                baseUrl: 'https://example.invalid/v1',
              },
            });
            await f.providers.deleteProviderConnection('temporary-proxy');
          }
          if (change === 'connection') {
            f.execution.agentConnectionId = engineConnectionId(
              engine === 'codex' ? 'claude' : 'codex',
            );
            await f.persist();
          }
          if (change === 'active-profile') {
            f.settings.credentialRecovery = {
              profiles: [{ ref: 'changed' }],
              activeProfileRef: 'changed',
            };
            await f.persist();
          }
          if (change === 'profile-overlay') {
            f.settings.credentialRecovery = {
              profiles: [
                { ref: 'selected', env: { ROUTING_LAYER: 'new-profile' } },
              ],
              activeProfileRef: 'selected',
            };
            await f.persist();
          }
          if (change === 'project') {
            const revision = f.storage.projectRevision('project');
            await revision.replace({
              ...revision.value,
              name: 'Changed Project',
            });
          }
          if (change === 'projection')
            f.metadata.set('default', {
              slug: agentId('station'),
              name: 'Station',
              updatedAt: '2026-01-01T00:00:00.000Z',
              execution: { agentConnectionId: engineConnectionId(engine) },
            });
          if (change === 'provider')
            await f.providers.saveProviderConnection({
              id: 'unused-proxy',
              type: 'openai-compat',
              name: 'Unused',
              enabled: true,
              capabilities: ['llm'],
              config: {
                apiKey: 'fixture',
                baseUrl: 'https://example.invalid/v1',
              },
            });
          if (change === 'executable')
            await writeFile(
              f.executable,
              'changed during final asynchronous guard',
            );
          return result;
        };
        const response = await f.send();
        expect(changed, change).toBe(true);
        expect(response.body.observation, change).toBeUndefined();
        expect(response.status, change).toBe(422);
        expect(execFile.mock.calls.length, change).toBe(0);
        f.assertNoInvocations();
      }
    },
  );

  test.each(['codex', 'claude'] as const)(
    '%s refuses private active-profile and overlay drift after app-home capture',
    async (engine) => {
      for (const change of [
        'active-profile',
        'profile-overlay',
        'connection-env',
      ] as const) {
        const f = await fixture(engine);
        let changed = false;
        f.setConnectionRead(async () => {
          if (changed) return;
          changed = true;
          await Promise.resolve();
          if (change === 'active-profile')
            f.settings.credentialRecovery = {
              profiles: [{ ref: 'new-account' }],
              activeProfileRef: 'new-account',
            };
          if (change === 'profile-overlay')
            f.settings.credentialRecovery = {
              profiles: [
                { ref: 'selected', env: { ROUTING_LAYER: 'new-profile' } },
              ],
              activeProfileRef: 'selected',
            };
          if (change === 'connection-env')
            f.settings.config = { env: { ROUTING_LAYER: 'new-connection' } };
          await f.persist();
        });
        const response = await f.send();
        expect(response.body.code, change).toBe('ensemble_context_changed');
        expect(execFile.mock.calls.length, change).toBe(0);
        f.assertNoInvocations();
      }
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

describe('explicit Ensemble inspection login checks', () => {
  const inspectionPath = '/api/orchestration/ensembles/inspect';
  const inputFor = (f: Awaited<ReturnType<typeof fixture>>) => ({
    path: f.path,
    expectedPresetHash: f.body.expectedPresetHash,
    bindings: f.body.bindings,
  });
  test.each(['codex', 'claude'] as const)(
    '%s checks its real selected auth context without starting a member',
    async (engine) => {
      const f = await fixture(engine);
      const ordinary = await f.send(
        f.operator,
        inputFor(f),
        '127.0.0.1',
        {},
        inspectionPath,
      );
      expect(ordinary.status).toBe(200);
      expect(ordinary.body).toMatchObject({
        data: { authenticationCheck: { state: 'available' } },
      });
      expect(execFile).not.toHaveBeenCalled();
      const checked = await f.send(
        f.operator,
        { ...inputFor(f), verifyAuthentication: true },
        '127.0.0.1',
        {},
        inspectionPath,
      );
      expect(checked.status).toBe(200);
      expect(checked.body).toMatchObject({
        data: {
          facts: expect.arrayContaining([
            {
              id: 'authentication:lead',
              memberId: 'lead',
              category: 'members/models',
              label: 'Engine sign-in',
              value: expect.stringMatching(/^Signed in when checked/),
              origin: 'runtime-derived',
              state: 'configured',
              owner: expect.any(Object),
            },
          ]),
        },
      });
      expect(
        execFile.mock.calls.some((call) => call[1].includes('status')),
      ).toBe(true);
      f.assertNoInvocations();
    },
  );
  test('a signed-out engine stays unavailable and never becomes an execution grant', async () => {
    const f = await fixture('claude');
    execFile.mockImplementation((_command, args, _options, callback) =>
      callback(null, {
        stdout:
          args[0] === '--version'
            ? '99.0.0 (Claude Code)'
            : '{"loggedIn":false}',
        stderr: '',
      }),
    );
    const response = await f.send(
      f.operator,
      { ...inputFor(f), verifyAuthentication: true },
      '127.0.0.1',
      {},
      inspectionPath,
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      data: {
        facts: expect.arrayContaining([
          expect.objectContaining({
            id: 'authentication:lead',
            state: 'unavailable',
            value: expect.stringMatching(/^Not signed in/),
          }),
        ]),
      },
    });
    f.assertNoInvocations();
  });
  test('a browser can inspect uploaded configuration but cannot request a native auth command', async () => {
    const f = await fixture();
    const offer = f.security.devicePairing.createOffer({
      endpoint: 'http://127.0.0.1',
    });
    const pending = f.security.devicePairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Browser inspection',
    });
    f.security.devicePairing.confirmRequest(pending.requestId, {
      kind: 'ui-bootstrap',
    });
    const browser = f.security.devicePairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: pending.requestId,
      locality: 'home-possession',
      mintKind: 'ui-bootstrap',
    }).credential;
    const { path: _path, ...uploaded } = inputFor(f);
    const input = { ...uploaded, presetJson: JSON.stringify(f.preset) };
    expect(
      (await f.send(browser, input, '127.0.0.1', {}, inspectionPath)).status,
    ).toBe(200);
    const response = await f.send(
      browser,
      { ...input, verifyAuthentication: true },
      '127.0.0.1',
      {},
      inspectionPath,
    );
    expect(response).toMatchObject({
      status: 403,
      body: { code: 'ensemble_inspection_authority_required' },
    });
    expect(execFile).not.toHaveBeenCalled();
    f.assertNoInvocations();
  });
  test('an expired native observation returns a stale inspection instead of an unknown success', async () => {
    const f = await fixture('codex');
    const observe = f.adapter.observeExecutionAuthentication.bind(f.adapter);
    let restoreClock = () => {};
    vi.spyOn(f.adapter, 'observeExecutionAuthentication').mockImplementation(
      async (input) => {
        const observation = await observe(input);
        const clock = vi
          .spyOn(Date, 'now')
          .mockReturnValue(observation.checkedAt + 30_000);
        restoreClock = () => clock.mockRestore();
        return observation;
      },
    );
    try {
      const response = await f.send(
        f.operator,
        { ...inputFor(f), verifyAuthentication: true },
        '127.0.0.1',
        {},
        inspectionPath,
      );
      expect(response).toMatchObject({
        status: 409,
        body: { code: 'ensemble_inspection_stale' },
      });
      f.assertNoInvocations();
    } finally {
      restoreClock();
    }
  });

  test('a replaced native executable after login cannot publish an authenticated inspection', async () => {
    const f = await fixture('codex');
    let observed = false;
    execFile.mockImplementation((_command, _args, _options, callback) => {
      observed = true;
      callback(null, { stdout: 'Logged in using ChatGPT', stderr: '' });
    });
    const resolve = f.inventory.resolveEnvironmentAccess.bind(f.inventory);
    let replaced = false;
    f.inventory.resolveEnvironmentAccess = async (target) => {
      const access = await resolve(target);
      if (observed && target.agent === 'station') {
        await writeFile(f.executable, 'changed-after-probe');
        replaced = true;
      }
      return access;
    };
    const response = await f.send(
      f.operator,
      { ...inputFor(f), verifyAuthentication: true },
      '127.0.0.1',
      {},
      inspectionPath,
    );
    expect(replaced).toBe(true);
    expect(response).toMatchObject({
      status: 409,
      body: { code: 'ensemble_inspection_stale' },
    });
    f.assertNoInvocations();
  });

  test('revocation during the version probe prevents login and the checked projection', async () => {
    const f = await fixture('claude');
    execFile.mockImplementation((_command, args, _options, callback) => {
      expect(args).toEqual(['--version']);
      void f
        .revokeCurrent()
        .then(() =>
          callback(null, { stdout: '99.0.0 (Claude Code)', stderr: '' }),
        );
    });
    const response = await f.send(
      f.operator,
      { ...inputFor(f), verifyAuthentication: true },
      '127.0.0.1',
      {},
      inspectionPath,
    );
    expect(response).toMatchObject({
      status: 403,
      body: { code: 'ensemble_inspection_authority_required' },
    });
    expect(execFile.mock.calls.map((call) => call[1])).toEqual([['--version']]);
    f.assertNoInvocations();
  });
});
