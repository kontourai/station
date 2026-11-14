/**
 * #2494: the Claude adapter's Seatbelt seam (and, #4770, the same seam for
 * a plan naming `bubblewrap`). A start whose plan names `seatbelt` must spawn its engine through the provider's `confine`, take
 * its posture from the provider's `pending.observe` once the engine has
 * answered its handshake, and only then run at full access. Every other
 * start is untouched. The real adapter and the real spawn wrapper run here
 * over a fake child (no real process starts); the provider is the
 * production one, so the profile and the posture rules are real. The kernel
 * side is `seatbelt.process.test.ts`.
 */
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  ConfinementPlan,
  ExecutionConfinementRecord,
} from '@kontourai/station-contracts/execution-confinement';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { createEngineOAuthProxyRoutes } from '../../routes/mcp/engine-oauth-proxy-route.js';
import { revokeStationControlMcpToken } from '../../runtime/mcp/station-control-mcp-token.js';
import { withSessionToolRestriction } from '../../services/orchestration/session-tool-restriction.js';
import type { EngineMcpOAuthResolver } from '../../services/plugins/engine-mcp-oauth.js';
import { createEngineMcpOAuthResolver } from '../../services/plugins/engine-mcp-oauth.js';
import { ToolServerCredentialStore } from '../../services/plugins/tool-server-credential-store.js';
import { StationToolServerOAuthProvider } from '../../services/plugins/tool-server-oauth.js';
import { nativeResumeBindingKey } from '../adapters/native-resume-binding.js';

const { mockForkSession, mockQuery, mockPlatform } = vi.hoisted(() => ({
  mockForkSession: vi.fn(),
  mockQuery: vi.fn(),
  mockPlatform: vi.fn(() => 'linux'),
}));

vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  platform: () => mockPlatform(),
}));

vi.mock('../adapters/claude-code-spawn.js', async (importOriginal) => {
  const { fakeEngineProcessModule } = await import(
    './claude-engine-process-test-utils.js'
  );
  return fakeEngineProcessModule(
    await importOriginal<typeof import('../adapters/claude-code-spawn.js')>(),
  );
});

// chat-host-images: observe how often a start records its launch.
vi.mock('../../services/infra/session-tmpdir.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../services/infra/session-tmpdir.js')
    >();
  return { ...actual, commitEngineLaunch: vi.fn(actual.commitEngineLaunch) };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  deleteSession: vi.fn(),
  forkSession: mockForkSession,
  listSessions: vi.fn(),
  query: (args: unknown) => mockQuery(args),
}));

vi.mock('../auth/cli-auth.js', () => ({
  buildCliRuntimePrerequisites: vi.fn(async () => []),
  augmentedSpawnEnv: vi.fn(async () => undefined),
  findCliBinaryAsync: vi.fn(async () => null),
  runCliCommand: vi.fn(async () => null),
}));

import {
  builtinStationControlServerPath,
  builtinStationKnowledgeServerPath,
} from '../../runtime/bootstrap/station-control-runtime-env.js';
import {
  type ConfinementProvider,
  ConfinementRefusedError,
} from '../../security/confinement/confinement-provider.js';
import {
  canonicalPath,
  createSeatbeltConfinementProvider,
  type SeatbeltEvidence,
} from '../../security/confinement/seatbelt.js';
import {
  commitEngineLaunch,
  installSessionTmpDirPolicy,
  launchedRootOf,
  sessionTempRoot,
  sessionTmpRoot,
} from '../../services/infra/session-tmpdir.js';
import {
  RESTRICTED_NETWORK_STATION_CONTROL_TOOLS,
  restrictedNetworkStationControlTools,
  STATION_CONTROL_TOOL_POLICY,
} from '../../tools/station-control-policy.js';
import {
  SendTurnRefusedError,
  SessionStartRefusedError,
} from '../adapter-shape.js';
import { ClaudeAdapter } from '../adapters/claude-adapter.js';
import {
  FAKE_CLAUDE_COMMAND,
  FakeClaudeChild,
  startFakeClaudeEngine,
} from './claude-engine-process-test-utils.js';

const SEATBELT_PLAN: ConfinementPlan = {
  requiredLevel: 'os-profile',
  policyBasis: 'workspace-floor',
  mechanism: 'seatbelt',
  level: 'os-profile',
  workspaceAccess: 'mounted',
};
const BUBBLEWRAP_PLAN: ConfinementPlan = {
  ...SEATBELT_PLAN,
  mechanism: 'bubblewrap',
};
/** #4769: a Seatbelt plan under a restricted network policy. */
const RESTRICTED_PLAN: ConfinementPlan = {
  ...SEATBELT_PLAN,
  network: { policy: 'restricted', allowedHosts: ['registry.npmjs.org'] },
};

/** Sends `request` to a loopback port and reads until the socket closes. */
function exchange(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let text = '';
    socket.on('data', (chunk) => {
      text += chunk.toString('latin1');
    });
    socket.on('close', () => resolve(text));
    socket.on('error', reject);
    socket.write(request);
  });
}

/** Masks every credential an ambient environment could carry. */
const NO_CREDENTIAL = {
  ANTHROPIC_API_KEY: '',
  ANTHROPIC_AUTH_TOKEN: '',
  CLAUDE_CODE_OAUTH_TOKEN: '',
};
const FAKE_ENV_CREDENTIAL = {
  ...NO_CREDENTIAL,
  ANTHROPIC_API_KEY: 'sk-ant-api03-fake-for-tests',
};

type QueryOptions = Record<string, unknown> & {
  spawnClaudeCodeProcess?: unknown;
};

/**
 * A Query that starts its engine the way the SDK does (through the
 * adapter's spawner) and answers `initializationResult` when told to.
 */
function startingQuery(handshake: Promise<unknown>) {
  handshake.catch(() => undefined);
  let closed = false;
  const query = {
    options: undefined as QueryOptions | undefined,
    async *[Symbol.asyncIterator]() {
      while (!closed) await new Promise((resolve) => setTimeout(resolve, 5));
    },
    initializationResult: vi.fn(() => handshake),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    applyFlagSettings: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn().mockResolvedValue(undefined),
    supportedModels: vi.fn().mockResolvedValue([]),
    close: vi.fn(() => {
      closed = true;
    }),
  };
  mockQuery.mockImplementation((args: { options: QueryOptions }) => {
    query.options = args.options;
    startFakeClaudeEngine(args.options as never);
    return query;
  });
  return query;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('#2494: the Claude adapter confines a full-access workspace start with Seatbelt', () => {
  const makeTempDir = trackTempDirs();
  let stationHome: string;
  let workspace: string;
  let adapter: ClaudeAdapter;
  let events: CanonicalRuntimeEvent[];
  /** #4769: what the adapter kept in the Station log. */
  let decisionLog: Record<string, unknown>[] = [];

  function createAdapter(
    options: {
      /** Serve Station's in-process browser to agent sessions. */
      stationBrowser?: true;
      /** Records the tools each in-process station-control server was given. */
      stationControl?: (allowedTools: readonly string[] | undefined) => void;
      /** Further adapter options, as given. */
      extra?: Partial<ConstructorParameters<typeof ClaudeAdapter>[0]>;
      connectionEnv?: Record<string, string>;
      provider?: ConfinementProvider<SeatbeltEvidence>;
      /** Inject nothing: the adapter picks the server's own provider. */
      serverProvider?: true;
      appHomeDir?: string;
      resolveMcpOAuth?: EngineMcpOAuthResolver;
    } = {},
  ) {
    decisionLog = [];
    adapter = new ClaudeAdapter({
      ...options.extra,
      logNetworkDecision: (details) => decisionLog.push(details),
      ...(options.stationBrowser
        ? { createInProcessStationBrowser: () => ({}) as never }
        : {}),
      ...(options.stationControl
        ? {
            createInProcessStationControl: (
              _threadId: string,
              _tenant?: unknown,
              allowedTools?: readonly string[],
            ) => {
              options.stationControl!(allowedTools);
              return { connect: vi.fn(), close: vi.fn() } as never;
            },
          }
        : {}),
      resolveMcpOAuth: options.resolveMcpOAuth,
      revokeStationControlCallerToken: revokeStationControlMcpToken,
      ...(options.appHomeDir
        ? {
            getAppHomeEnv: async () => ({
              env: {
                CLAUDE_CONFIG_DIR: options.appHomeDir!,
                CLAUDE_SECURESTORAGE_CONFIG_DIR: options.appHomeDir!,
              },
              profileRef: 'work',
            }),
          }
        : {}),
      confinedStationHome: stationHome,
      confinementHandshakeTimeoutMs: 2_000,
      getConnectionEnv: async () =>
        options.connectionEnv ?? FAKE_ENV_CREDENTIAL,
      ...(options.serverProvider
        ? {}
        : {
            seatbeltProvider:
              options.provider ?? createSeatbeltConfinementProvider(),
          }),
    });
    events = [];
    void (async () => {
      for await (const event of adapter.streamEvents()) events.push(event);
    })();
    return adapter;
  }

  beforeEach(() => {
    const root = canonicalPath(makeTempDir('claude-seatbelt-'));
    stationHome = join(root, 'station-home');
    workspace = join(root, 'workspace');
    mkdirSync(stationHome, { recursive: true });
    mkdirSync(workspace);
    mockPlatform.mockReturnValue('linux');
  });

  afterEach(async () => {
    await adapter?.stopAll();
    mockQuery.mockReset();
    mockForkSession.mockReset();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  /** The environment the latest engine process was spawned with. */
  const spawnedEnv = () =>
    FakeClaudeChild.newest!.spawnArgs.options.env as Record<string, string>;

  function startConfined(threadId = 'confined', extra: object = {}) {
    return adapter.startSession({
      provider: 'claude',
      threadId,
      cwd: workspace,
      confinement: 'workspace',
      modelOptions: { approvalMode: 'never' },
      confinementPlan: SEATBELT_PLAN,
      ...extra,
    });
  }

  /** The metadata of `method` for `threadId`, once it is published. */
  async function published(
    method: 'session.started' | 'session.configured',
    threadId: string,
  ) {
    let event: CanonicalRuntimeEvent | undefined;
    await vi.waitFor(() => {
      event = events.find(
        (e) => e.method === method && e.threadId === threadId,
      );
      expect(event).toBeDefined();
    });
    return (event as { metadata?: Record<string, unknown> }).metadata ?? {};
  }
  const started = (threadId: string) => published('session.started', threadId);
  const configured = (threadId: string) =>
    published('session.configured', threadId);
  /** Whether `session.started` has been published for `threadId` yet. */
  const announced = (threadId: string) =>
    events.some(
      (e) => e.method === 'session.started' && e.threadId === threadId,
    );

  test('the confined spawn carries a working authenticated proxy route without remote bearer env', async () => {
    const endpoint = 'https://confined-mcp.example/mcp';
    const def = {
      id: 'remote',
      kind: 'mcp' as const,
      transport: 'streamable-http' as const,
      endpoint,
    };
    const provider = new StationToolServerOAuthProvider(
      new ToolServerCredentialStore(stationHome),
      'remote',
      endpoint,
      'http://127.0.0.1:43143/callback',
    );
    await provider.saveTokens({
      access_token: 'remote-bearer-canary',
      token_type: 'Bearer',
    });
    const resolver = createEngineMcpOAuthResolver({
      homeDir: () => stationHome,
      port: () => 43143,
      getIntegration: async () => def,
    });
    createAdapter({
      resolveMcpOAuth: (input) =>
        resolver(
          input.agent?.toolServers ?? [],
          undefined,
          undefined,
          input.threadId,
        ),
    });
    const handshake = deferred<unknown>();
    const query = startingQuery(handshake.promise);
    // Use the real SDK to construct the CLI argv, stopping only at the actual spawn.
    const sdk = await vi.importActual<
      typeof import('@anthropic-ai/claude-agent-sdk')
    >('@anthropic-ai/claude-agent-sdk');
    let actual: ReturnType<typeof sdk.query> | undefined;
    mockQuery.mockImplementation((args) => {
      query.options = args.options;
      actual = sdk.query({
        ...args,
        options: {
          ...args.options,
          pathToClaudeCodeExecutable: FAKE_CLAUDE_COMMAND,
        },
      });
      void actual.initializationResult().catch(() => undefined);
      return query;
    });
    const starting = startConfined('confined-proxy', {
      agent: { slug: 'oauth-agent', toolServers: [def] },
    });
    await vi.waitFor(() =>
      expect(FakeClaudeChild.newest?.spawnArgs.args).toContain('--mcp-config'),
    );
    const child = FakeClaudeChild.newest!;
    expect(child.spawnArgs.command).toBe('/usr/bin/sandbox-exec');
    const args = child.spawnArgs.args;
    const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]!);
    const url = config.mcpServers.remote.url;
    expect(url).toContain('/mcp/oauth-proxy/remote/confined-proxy?token=');
    expect(JSON.stringify(child.spawnArgs)).not.toContain(
      'remote-bearer-canary',
    );
    expect(JSON.stringify(spawnedEnv())).not.toContain('STATION_MCP_OAUTH_');
    vi.stubGlobal(
      'fetch',
      async (input: string | URL | Request, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        expect(request.url).toBe(endpoint);
        expect(request.headers.get('authorization')).toBe(
          'Bearer remote-bearer-canary',
        );
        return Response.json({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
      },
    );
    const proxy = createEngineOAuthProxyRoutes();
    const response = await proxy.request(
      url,
      {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        headers: { 'content-type': 'application/json' },
      },
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
    );
    expect(await response.json()).toMatchObject({ result: { tools: [] } });
    handshake.resolve({});
    await starting;
    actual?.close();
    await adapter.stopAll();
    expect(
      (
        await proxy.request(
          url,
          {},
          { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
        )
      ).status,
    ).toBe(401);
    vi.unstubAllGlobals();
  });

  test('a confined never session spawns through sandbox-exec, and runs bypassPermissions only after the handshake is observed', async () => {
    createAdapter();
    const handshake = deferred<unknown>();
    const query = startingQuery(handshake.promise);
    const starting = startConfined();
    await vi.waitFor(() =>
      expect(query.initializationResult).toHaveBeenCalled(),
    );

    const child = FakeClaudeChild.newest!;
    expect(child.spawnArgs.command).toBe('/usr/bin/sandbox-exec');
    expect(child.spawnArgs.args[0]).toBe('-p');
    expect(child.spawnArgs.args[1]).toContain('(deny default)');
    expect(child.spawnArgs.args[2]).toBe(FAKE_CLAUDE_COMMAND);
    const env = child.spawnArgs.options.env as Record<string, string>;
    expect(env.CLAUDE_CONFIG_DIR).toBe(
      join(stationHome, 'confined-homes', 'claude'),
    );
    expect(env.TMPDIR).toContain(
      join(stationHome, 'tmp', 'confined-sessions', 'session-'),
    );
    expect(env).not.toHaveProperty('CLAUDE_SECURESTORAGE_CONFIG_DIR');
    expect(child.spawnArgs.options.cwd).toBe(workspace);
    // Spawned at Auto, with the grant the SDK only takes at spawn.
    expect(query.options).toMatchObject({
      permissionMode: 'acceptEdits',
      allowDangerouslySkipPermissions: true,
    });
    // Nothing is lifted or announced before the engine has answered.
    expect(query.setPermissionMode).not.toHaveBeenCalled();
    expect(announced('confined')).toBe(false);

    handshake.resolve({});
    await starting;
    expect(query.setPermissionMode).toHaveBeenCalledExactlyOnceWith(
      'bypassPermissions',
    );
    const record = (await started('confined')).stationConfinementRecord as
      | ExecutionConfinementRecord
      | undefined;
    expect(record).toEqual({
      level: 'os-profile',
      required: true,
      posture: 'confined',
      mechanism: 'seatbelt',
      workspaceAccess: 'mounted',
      policyBasis: 'workspace-floor',
      writeGrants: ['station-config', 'station-temp', 'workspace'],
    });
    expect(await configured('confined')).toMatchObject({
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      approvalMode: 'never',
      confinement: 'workspace',
    });
  });

  test('the spawn goes through the provider’s confine, and the posture is the provider’s own observation', async () => {
    const real = createSeatbeltConfinementProvider();
    const observe = vi.fn(
      (): 'configured-but-failed' => 'configured-but-failed',
    );
    const confine = vi.fn((spec: Parameters<typeof real.confine>[0]) => ({
      spec: real.confine(spec).spec,
      pending: { observe },
    }));
    createAdapter({ provider: { ...real, confine } });
    const query = startingQuery(Promise.resolve({}));
    const refused = startConfined('observed');
    await expect(refused).rejects.toBeInstanceOf(ConfinementRefusedError);
    await expect(refused).rejects.toBeInstanceOf(SessionStartRefusedError);
    await expect(refused).rejects.toMatchObject({
      code: 'confinement_not_observed',
    });
    expect(confine).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        handshake: 'completed',
        spawned: expect.objectContaining({ command: '/usr/bin/sandbox-exec' }),
      }),
    );
    // Even with a completed handshake, the provider said no: never lifted.
    expect(query.setPermissionMode).not.toHaveBeenCalled();
    expect(query.close).toHaveBeenCalled();
    await expect(adapter.hasSession('observed')).resolves.toBe(false);
    expect(announced('observed')).toBe(false);
  });

  test('a profile that fails to apply is configured-but-failed: refused, with no unconfined fallback spawn', async () => {
    createAdapter();
    // sandbox-exec refused the profile: the engine never answers.
    const query = startingQuery(
      Promise.reject(new Error('Claude Code process exited with code 65')),
    );
    await expect(startConfined('apply-failed')).rejects.toMatchObject({
      name: 'ConfinementRefusedError',
      code: 'confinement_not_observed',
      message: expect.stringContaining('(configured-but-failed)'),
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(FakeClaudeChild.newest!.spawnArgs.command).toBe(
      '/usr/bin/sandbox-exec',
    );
    expect(query.setPermissionMode).not.toHaveBeenCalled();
    await expect(adapter.hasSession('apply-failed')).resolves.toBe(false);
    // The refusal settles the start: the same thread starts again.
    startingQuery(Promise.resolve({}));
    await startConfined('apply-failed');
    await expect(adapter.hasSession('apply-failed')).resolves.toBe(true);
  });

  test('a failure after the posture is observed (lifting to full access) stops the engine, cleans up and settles the start', async () => {
    const revoke = vi.fn();
    createAdapter();
    adapter = new ClaudeAdapter({
      confinedStationHome: stationHome,
      confinementHandshakeTimeoutMs: 2_000,
      getConnectionEnv: async () => FAKE_ENV_CREDENTIAL,
      seatbeltProvider: createSeatbeltConfinementProvider(),
      revokeStationControlCallerToken: revoke,
    });
    const query = startingQuery(Promise.resolve({}));
    query.setPermissionMode.mockRejectedValueOnce(
      new Error('Claude Code process exited with code 1'),
    );
    const failed = startConfined('lift-fails');
    await expect(failed).rejects.toBeInstanceOf(SessionStartRefusedError);
    await expect(failed).rejects.toMatchObject({
      code: 'confinement_not_observed',
    });
    const child = FakeClaudeChild.newest!;
    const tmpDir = (child.spawnArgs.options.env as Record<string, string>)
      .TMPDIR;
    expect(child.killed).toBe(true);
    expect(query.close).toHaveBeenCalled();
    expect(existsSync(tmpDir)).toBe(false);
    expect(revoke).toHaveBeenCalledWith('lift-fails');
    await expect(adapter.hasSession('lift-fails')).resolves.toBe(false);
    // The thread is not fenced: the same thread starts again.
    startingQuery(Promise.resolve({}));
    await startConfined('lift-fails');
    await expect(adapter.hasSession('lift-fails')).resolves.toBe(true);
  });

  test('a never start with no confinement field and no plan counts as workspace and runs at Auto', async () => {
    createAdapter();
    const query = startingQuery(Promise.resolve({}));
    await adapter.startSession({
      provider: 'claude',
      threadId: 'absent-confinement',
      cwd: workspace,
      modelOptions: { approvalMode: 'never' },
    });
    expect(query.options).toMatchObject({ permissionMode: 'acceptEdits' });
    expect(query.options?.allowDangerouslySkipPermissions).toBeUndefined();
  });

  test('a workspace session at another mode is unchanged: no wrapper, no grant, no record from the adapter', async () => {
    createAdapter();
    const query = startingQuery(Promise.resolve({}));
    await adapter.startSession({
      provider: 'claude',
      threadId: 'auto',
      cwd: workspace,
      confinement: 'workspace',
      modelOptions: { approvalMode: 'auto' },
    });
    expect(FakeClaudeChild.newest!.spawnArgs.command).toBe(FAKE_CLAUDE_COMMAND);
    expect(query.options).toMatchObject({ permissionMode: 'acceptEdits' });
    expect(query.options?.allowDangerouslySkipPermissions).toBeUndefined();
    expect(query.initializationResult).not.toHaveBeenCalled();
    expect(await started('auto')).not.toHaveProperty(
      'stationConfinementRecord',
    );
  });

  test('with no confined credential, the start runs at Auto with nothing engaged, and says why and how to fix it', async () => {
    createAdapter({ connectionEnv: NO_CREDENTIAL });
    const query = startingQuery(Promise.resolve({}));
    await startConfined('no-credential');
    expect(FakeClaudeChild.newest!.spawnArgs.command).toBe(FAKE_CLAUDE_COMMAND);
    expect(query.options).toMatchObject({ permissionMode: 'acceptEdits' });
    expect(query.options?.allowDangerouslySkipPermissions).toBeUndefined();
    expect((await started('no-credential')).stationConfinementRecord).toEqual({
      level: 'host',
      required: false,
      posture: 'no-mechanism',
      workspaceAccess: 'mounted',
      policyBasis: 'workspace-floor',
      fallback: 'confined-credential-unavailable',
    });
    await vi.waitFor(() =>
      expect(
        events.find(
          (e) =>
            e.method === 'runtime.warning' && e.threadId === 'no-credential',
        ),
      ).toMatchObject({
        code: 'confined_full_access_unavailable',
        message: expect.stringContaining('claude setup-token'),
      }),
    );
    // A turn asking for full access is refused, not applied.
    await adapter.sendTurn({
      threadId: 'no-credential',
      input: 'go',
      modelOptions: { approvalMode: 'never' },
    });
    expect(query.setPermissionMode).not.toHaveBeenCalled();
  });

  test('a credential enrolled in the Station-owned config dir is enough; the operator Keychain is never consulted', async () => {
    const configDir = join(stationHome, 'confined-homes', 'claude');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-fake',
          refreshToken: 'sk-ant-ort01-fake',
        },
      }),
    );
    createAdapter({ connectionEnv: NO_CREDENTIAL });
    startingQuery(Promise.resolve({}));
    await startConfined('file-credential');
    expect(
      (
        (await started('file-credential')).stationConfinementRecord as {
          posture?: string;
        }
      )?.posture,
    ).toBe('confined');
  });

  test.each([
    ['seatbelt', SEATBELT_PLAN],
    ['bubblewrap', BUBBLEWRAP_PLAN],
  ] as const)(
    'a workspace that is the home folder is too broad to confine under %s: Auto, recorded, and the warning says why',
    async (mechanism, plan) => {
      createAdapter();
      startingQuery(Promise.resolve({}));
      const threadId = `home-${mechanism}`;
      await adapter.startSession({
        provider: 'claude',
        threadId,
        cwd: homedir(),
        confinement: 'workspace',
        modelOptions: { approvalMode: 'never' },
        confinementPlan: plan,
      });
      expect(FakeClaudeChild.newest!.spawnArgs.command).toBe(
        FAKE_CLAUDE_COMMAND,
      );
      expect((await started(threadId)).stationConfinementRecord).toMatchObject({
        posture: 'no-mechanism',
        fallback: 'workspace-too-broad',
      });
      const warning = events.find(
        (e) => e.method === 'runtime.warning' && e.threadId === threadId,
      ) as { message?: string } | undefined;
      // The Seatbelt text is unchanged; bubblewrap adds its own rule.
      const seatbeltText =
        "Full access runs as Auto: this session's folder is or contains your home folder or Station's data, so confining it to that folder would confine nothing.";
      expect(warning?.message).toBe(
        mechanism === 'seatbelt'
          ? seatbeltText
          : `${seatbeltText} Under the bubblewrap sandbox this also covers a folder inside, or containing, a secret store the sandbox hides.`,
      );
    },
  );

  test('#4770: a bubblewrap workspace whose .git is a symbolic link is refused before spawning, naming why', async () => {
    createAdapter({ serverProvider: true });
    const real = join(workspace, '..', 'real-git');
    mkdirSync(real);
    symlinkSync(real, join(workspace, '.git'));
    startingQuery(Promise.resolve({}));
    await expect(
      startConfined('symlinked-git', { confinementPlan: BUBBLEWRAP_PLAN }),
    ).rejects.toMatchObject({
      code: 'confinement_not_observed',
      message: expect.stringContaining(
        'Its bubblewrap sandbox cannot be built: .git is a symbolic link',
      ),
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test.each([
    ['seatbelt', SEATBELT_PLAN],
    ['bubblewrap', BUBBLEWRAP_PLAN],
  ] as const)(
    'adoption pins the global config root, so a %s plan is never confined: Auto, recorded',
    async (mechanism, plan) => {
      // The server's own provider for the mechanism, as production picks it.
      createAdapter({ serverProvider: true });
      mockForkSession.mockResolvedValue({ sessionId: 'vendor-child' });
      const query = startingQuery(Promise.resolve({}));
      const threadId = `adopted-${mechanism}`;
      await adapter.adoptSession({
        provider: 'claude',
        threadId,
        sourceSessionId: 'vendor-source',
        sourceKind: 'claude-transcript',
        cwd: workspace,
        confinement: 'workspace',
        modelOptions: { approvalMode: 'never' },
        confinementPlan: plan,
      });
      expect(FakeClaudeChild.newest!.spawnArgs.command).toBe(
        FAKE_CLAUDE_COMMAND,
      );
      // Never full access outside a sandbox.
      expect(query.options).toMatchObject({ permissionMode: 'acceptEdits' });
      expect(query.options?.permissionMode).not.toBe('bypassPermissions');
      expect((await started(threadId)).stationConfinementRecord).toMatchObject({
        posture: 'no-mechanism',
        required: false,
        fallback: 'config-root-pinned',
      });
    },
  );

  test('chat-host-images: a confined session image root is exactly its Seatbelt TMPDIR, and no unused session-tmp folder is created', async () => {
    vi.stubEnv('STATION_HOME', stationHome);
    const uninstall = installSessionTmpDirPolicy(() => true);
    try {
      createAdapter();
      startingQuery(Promise.resolve({}));
      vi.mocked(commitEngineLaunch).mockClear();
      await startConfined('confined-images');
      // Recorded once for this start, not again when it is announced.
      expect(vi.mocked(commitEngineLaunch)).toHaveBeenCalledTimes(1);
      const tmpdir = spawnedEnv().TMPDIR;
      expect(tmpdir).toContain(
        join(stationHome, 'tmp', 'confined-sessions', 'session-'),
      );
      expect(sessionTempRoot('confined-images')).toBe(tmpdir);
      expect(existsSync(sessionTmpRoot(stationHome))).toBe(false);
      await adapter.stopSession('confined-images');
      // Seatbelt removes its directory at stop; the root goes with it.
      expect(sessionTempRoot('confined-images')).toBeUndefined();
    } finally {
      uninstall();
    }
  });

  test('failed confined startup retires only its host-image launch', async () => {
    vi.stubEnv('STATION_HOME', stationHome);
    const uninstall = installSessionTmpDirPolicy(() => true);
    try {
      createAdapter();
      startingQuery(Promise.resolve({ claude_code_version: '2.1.307' }));
      const threadId = 'restricted-images';
      const restriction = {
        threadId,
        nativeSessionId: 'native-sync',
        nativeBindingKey: nativeResumeBindingKey(
          'claude',
          join(stationHome, 'confined-homes', 'claude'),
          null,
        ),
        generation: 'generation',
        clientTurnId: 'reserved',
        assertCurrent() {},
      };
      await expect(
        withSessionToolRestriction(restriction, () =>
          startConfined(threadId, { resumeCursor: 'native-sync' }),
        ),
      ).rejects.toThrow('group_sync_policy_unavailable');
      expect(launchedRootOf(threadId)).toBeUndefined();
      expect(existsSync(spawnedEnv().TMPDIR)).toBe(false);

      const failedHandshake = deferred<unknown>();
      startingQuery(failedHandshake.promise);
      const failing = startConfined('refused-images');
      await vi.waitFor(() =>
        expect(launchedRootOf('refused-images')).toBeDefined(),
      );
      const refusedDir = spawnedEnv().TMPDIR;
      failedHandshake.reject(new Error('handshake failed'));
      await expect(failing).rejects.toBeInstanceOf(ConfinementRefusedError);
      expect(launchedRootOf('refused-images')).toBeUndefined();
      expect(existsSync(refusedDir)).toBe(false);

      const handshake = deferred<unknown>();
      startingQuery(handshake.promise);
      const starting = startConfined('abandoned-images');
      await vi.waitFor(() =>
        expect(launchedRootOf('abandoned-images')).toBeDefined(),
      );
      const abandoned = launchedRootOf('abandoned-images');
      const newerDir = join(stationHome, 'newer-launch');
      mkdirSync(newerDir, { mode: 0o700 });
      commitEngineLaunch('abandoned-images', { confined: newerDir });
      const newer = launchedRootOf('abandoned-images');
      expect(newer).not.toBe(abandoned);
      handshake.reject(new Error('handshake failed'));
      await expect(starting).rejects.toBeInstanceOf(ConfinementRefusedError);
      expect(launchedRootOf('abandoned-images')).toBe(newer);
      expect(sessionTempRoot('abandoned-images')).toBe(newerDir);
    } finally {
      uninstall();
    }
  });

  test('the confined engine gets an allowlisted environment: no ambient GH_TOKEN, cloud keys or SSH agent', async () => {
    vi.stubEnv('GH_TOKEN', 'ghp_planted_for_this_test');
    vi.stubEnv('NPM_TOKEN', 'npm_planted');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'aws-planted');
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/planted-agent.sock');
    createAdapter({
      connectionEnv: {
        ...FAKE_ENV_CREDENTIAL,
        // Configured for this engine by the operator: passes as set.
        STATION_TEST_CONFIGURED: 'kept',
        CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
      },
    });
    startingQuery(Promise.resolve({}));
    await startConfined('env');
    const env = spawnedEnv();
    for (const key of [
      'GH_TOKEN',
      'NPM_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'SSH_AUTH_SOCK',
      'CLAUDE_SECURESTORAGE_CONFIG_DIR',
    ])
      expect(env, key).not.toHaveProperty(key);
    expect(env).toMatchObject({
      ANTHROPIC_API_KEY: FAKE_ENV_CREDENTIAL.ANTHROPIC_API_KEY,
      STATION_TEST_CONFIGURED: 'kept',
      PATH: expect.any(String),
    });
    // The unconfined spawn keeps today's full environment.
    await adapter.startSession({
      provider: 'claude',
      threadId: 'env-unconfined',
      cwd: workspace,
      confinement: 'workspace',
      modelOptions: { approvalMode: 'auto' },
    });
    expect(spawnedEnv().GH_TOKEN).toBe('ghp_planted_for_this_test');
  });

  test("a selected credential profile's confined home is its own, never the profile's app home an unconfined session uses", async () => {
    const profileHome = join(
      stationHome,
      'app-homes',
      'credential-profile-abc',
    );
    mkdirSync(profileHome, { recursive: true });
    createAdapter({ appHomeDir: profileHome });
    startingQuery(Promise.resolve({}));
    await adapter.startSession({
      provider: 'claude',
      threadId: 'profile-unconfined',
      cwd: workspace,
      confinement: 'workspace',
      modelOptions: { approvalMode: 'auto' },
    });
    const unconfinedHome = spawnedEnv().CLAUDE_CONFIG_DIR;
    expect(unconfinedHome).toBe(profileHome);
    startingQuery(Promise.resolve({}));
    await startConfined('profile-confined');
    const confinedHome = spawnedEnv().CLAUDE_CONFIG_DIR;
    expect(confinedHome).toBe(
      join(stationHome, 'confined-homes', 'credential-profile-abc'),
    );
    expect(confinedHome).not.toBe(unconfinedHome);
    expect(spawnedEnv()).not.toHaveProperty('CLAUDE_SECURESTORAGE_CONFIG_DIR');
  });

  test('a turn sent before the start is observed is refused, and never runs at bypassPermissions', async () => {
    createAdapter();
    const handshake = deferred<unknown>();
    const query = startingQuery(handshake.promise);
    const starting = startConfined('racing');
    await vi.waitFor(() =>
      expect(query.initializationResult).toHaveBeenCalled(),
    );
    await expect(
      adapter.sendTurn({
        threadId: 'racing',
        input: 'go',
        modelOptions: { approvalMode: 'never' },
      }),
    ).rejects.toBeInstanceOf(SendTurnRefusedError);
    expect(query.setPermissionMode).not.toHaveBeenCalled();
    handshake.resolve({});
    await starting;
    // Once observed, the same turn is accepted at the lifted mode.
    expect(query.setPermissionMode).toHaveBeenCalledExactlyOnceWith(
      'bypassPermissions',
    );
  });

  test('a resumed confined session is confined and observed again, never resumed unconfined', async () => {
    createAdapter();
    startingQuery(Promise.resolve({}));
    await startConfined('resumed');
    const binding = (await started('resumed')).nativeResumeBindingKey as string;
    await adapter.stopSession('resumed');
    events.length = 0;
    const query = startingQuery(Promise.resolve({}));
    await startConfined('resumed', {
      resumeCursor: 'native-session-1',
      nativeResumeBindingKey: binding,
    });
    expect(FakeClaudeChild.newest!.spawnArgs.command).toBe(
      '/usr/bin/sandbox-exec',
    );
    expect(query.setPermissionMode).toHaveBeenCalledWith('bypassPermissions');
    expect((await started('resumed')).stationConfinementRecord).toMatchObject({
      posture: 'confined',
    });
  });

  test('a resume recorded under another config home falls back to Auto, recorded as resume-bound-elsewhere', async () => {
    createAdapter();
    // Started before confinement applied: recorded under the global home.
    startingQuery(Promise.resolve({}));
    await adapter.startSession({
      provider: 'claude',
      threadId: 'elsewhere',
      cwd: workspace,
      confinement: 'workspace',
      modelOptions: { approvalMode: 'auto' },
    });
    const binding = (await started('elsewhere'))
      .nativeResumeBindingKey as string;
    await adapter.stopSession('elsewhere');
    events.length = 0;
    const query = startingQuery(Promise.resolve({}));
    await startConfined('elsewhere', {
      resumeCursor: 'native-session-2',
      nativeResumeBindingKey: binding,
    });
    expect(FakeClaudeChild.newest!.spawnArgs.command).toBe(FAKE_CLAUDE_COMMAND);
    expect(query.options).toMatchObject({ permissionMode: 'acceptEdits' });
    expect((await started('elsewhere')).stationConfinementRecord).toMatchObject(
      { fallback: 'resume-bound-elsewhere' },
    );
  });

  test('a workspace start at never that arrives without a Seatbelt plan runs at Auto, never unconfined at full access', async () => {
    createAdapter();
    const query = startingQuery(Promise.resolve({}));
    await adapter.startSession({
      provider: 'claude',
      threadId: 'no-plan',
      cwd: workspace,
      confinement: 'workspace',
      modelOptions: { approvalMode: 'never' },
    });
    expect(FakeClaudeChild.newest!.spawnArgs.command).toBe(FAKE_CLAUDE_COMMAND);
    expect(query.options).toMatchObject({ permissionMode: 'acceptEdits' });
    expect(query.options?.allowDangerouslySkipPermissions).toBeUndefined();
    // The operator's own (host) start is unchanged.
    const host = startingQuery(Promise.resolve({}));
    await adapter.startSession({
      provider: 'claude',
      threadId: 'host',
      cwd: workspace,
      confinement: 'host',
      modelOptions: { approvalMode: 'never' },
    });
    expect(host.options).toMatchObject({
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    });
  });

  test('#4770: a plan naming bubblewrap spawns through bwrap with the server’s own provider, lifted only once observed', async () => {
    createAdapter({ serverProvider: true });
    const handshake = deferred<unknown>();
    const query = startingQuery(handshake.promise);
    const starting = startConfined('bubblewrap', {
      confinementPlan: BUBBLEWRAP_PLAN,
    });
    await vi.waitFor(() =>
      expect(query.initializationResult).toHaveBeenCalled(),
    );
    const child = FakeClaudeChild.newest!;
    expect(child.spawnArgs.command).toBe('/usr/bin/bwrap');
    const args = child.spawnArgs.args;
    expect(args.slice(0, 3)).toEqual([
      '--unshare-user',
      '--unshare-pid',
      '--unshare-ipc',
    ]);
    expect(args[args.indexOf('--') + 1]).toBe(FAKE_CLAUDE_COMMAND);
    expect(args).toEqual(
      expect.arrayContaining(['--bind', workspace, workspace]),
    );
    expect(spawnedEnv().CLAUDE_CONFIG_DIR).toBe(
      join(stationHome, 'confined-homes', 'claude'),
    );
    expect(query.options).toMatchObject({
      permissionMode: 'acceptEdits',
      allowDangerouslySkipPermissions: true,
    });
    expect(query.setPermissionMode).not.toHaveBeenCalled();
    expect(announced('bubblewrap')).toBe(false);

    handshake.resolve({});
    await starting;
    expect(query.setPermissionMode).toHaveBeenCalledExactlyOnceWith(
      'bypassPermissions',
    );
    expect((await started('bubblewrap')).stationConfinementRecord).toEqual({
      level: 'os-profile',
      required: true,
      posture: 'confined',
      mechanism: 'bubblewrap',
      workspaceAccess: 'mounted',
      policyBasis: 'workspace-floor',
      writeGrants: ['station-config', 'station-temp', 'workspace'],
    });
  });

  test('#4770: a bubblewrap start whose engine never answers is refused, with no unconfined fallback spawn', async () => {
    createAdapter({ serverProvider: true });
    const query = startingQuery(
      Promise.reject(new Error('Claude Code process exited with code 1')),
    );
    await expect(
      startConfined('bubblewrap-failed', { confinementPlan: BUBBLEWRAP_PLAN }),
    ).rejects.toMatchObject({
      name: 'ConfinementRefusedError',
      code: 'confinement_not_observed',
      message: expect.stringContaining(
        'not observed inside its bubblewrap sandbox (configured-but-failed)',
      ),
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(FakeClaudeChild.newest!.spawnArgs.command).toBe('/usr/bin/bwrap');
    expect(query.setPermissionMode).not.toHaveBeenCalled();
    await expect(adapter.hasSession('bubblewrap-failed')).resolves.toBe(false);
  });

  test('#4769: a restricted plan spawns the broker-only profile, points the engine at its broker, records it, and reports a refusal once', async () => {
    createAdapter({
      connectionEnv: { ...FAKE_ENV_CREDENTIAL, NO_PROXY: '*' },
    });
    const handshake = deferred<unknown>();
    const query = startingQuery(handshake.promise);
    const starting = startConfined('restricted', {
      confinementPlan: RESTRICTED_PLAN,
    });
    await vi.waitFor(() =>
      expect(query.initializationResult).toHaveBeenCalled(),
    );
    const child = FakeClaudeChild.newest!;
    const profile = child.spawnArgs.args[1]!;
    expect(profile).not.toContain('(allow network*)');
    const port = Number(
      /\(allow network-outbound \(remote tcp4 "localhost:(\d+)"\)\)/.exec(
        profile,
      )?.[1],
    );
    expect(port).toBeGreaterThan(0);
    const env = spawnedEnv();
    expect(env.HTTPS_PROXY).toBe(`http://127.0.0.1:${port}`);
    expect(env.HTTP_PROXY).toBe(`http://127.0.0.1:${port}`);
    expect(env).not.toHaveProperty('NO_PROXY');
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    handshake.resolve({});
    await starting;
    expect((await started('restricted')).stationConfinementRecord).toEqual({
      level: 'os-profile',
      required: true,
      posture: 'confined',
      mechanism: 'seatbelt',
      workspaceAccess: 'mounted',
      policyBasis: 'workspace-floor',
      writeGrants: ['station-config', 'station-temp', 'workspace'],
      network: 'restricted',
    });
    // The session's broker refuses a host its policy does not list, and the
    // person is told once, with the host and port and nothing else.
    for (let attempt = 0; attempt < 2; attempt += 1)
      expect(
        await exchange(port, 'CONNECT exfil.example:443 HTTP/1.1\r\n\r\n'),
      ).toMatch(/^HTTP\/1\.1 403/);
    await vi.waitFor(() =>
      expect(
        events.filter(
          (event) =>
            event.method === 'runtime.warning' &&
            (event as { code?: string }).code === 'confined_network_denied',
        ),
      ).toEqual([
        expect.objectContaining({
          threadId: 'restricted',
          message: expect.stringContaining('exfil.example:443'),
          details: { reason: 'not-allowed', host: 'exfil.example', port: 443 },
        }),
      ]),
    );
    // Kept once in the Station log, content-free.
    expect(decisionLog).toEqual([
      {
        threadId: 'restricted',
        at: expect.any(String),
        verdict: 'denied',
        reason: 'not-allowed',
        host: 'exfil.example',
        port: 443,
      },
    ]);
    // Stopping the session closes its broker.
    await adapter.stopSession('restricted');
    await vi.waitFor(() =>
      expect(exchange(port, 'x')).rejects.toMatchObject({
        code: 'ECONNREFUSED',
      }),
    );
  });

  test('#4769: a restricted start whose provider spawned an open network is configured-but-failed: refused', async () => {
    const real = createSeatbeltConfinementProvider();
    // A provider that drops the restriction it was asked for.
    const confine = (spec: Parameters<typeof real.confine>[0]) =>
      real.confine({ ...spec, network: 'full' });
    createAdapter({ provider: { ...real, confine } });
    const query = startingQuery(Promise.resolve({}));
    const refused = await startConfined('opened', {
      confinementPlan: RESTRICTED_PLAN,
    }).catch((error: unknown) => error);
    expect(refused).toMatchObject({
      name: 'ConfinementRefusedError',
      code: 'confinement_not_observed',
      message: expect.stringContaining('(configured-but-failed)'),
    });
    expect(FakeClaudeChild.newest!.spawnArgs.args[1]).toContain(
      '(allow network*)',
    );
    expect(query.setPermissionMode).not.toHaveBeenCalled();
    await expect(adapter.hasSession('opened')).resolves.toBe(false);
  });

  test('#4769: a restricted start is refused before spawning when its model endpoint or an allowed host cannot be read', async () => {
    createAdapter({
      connectionEnv: { ...FAKE_ENV_CREDENTIAL, CLAUDE_CODE_USE_BEDROCK: '1' },
    });
    await expect(
      startConfined('bedrock', { confinementPlan: RESTRICTED_PLAN }),
    ).rejects.toMatchObject({
      name: 'ConfinementRefusedError',
      code: 'confinement_mechanism_unavailable',
      message: expect.stringContaining('CLAUDE_CODE_USE_BEDROCK'),
    });
    createAdapter({
      connectionEnv: {
        ...FAKE_ENV_CREDENTIAL,
        ANTHROPIC_BASE_URL: 'http://gateway.example:4000',
      },
    });
    await expect(
      startConfined('plain-http', { confinementPlan: RESTRICTED_PLAN }),
    ).rejects.toMatchObject({
      code: 'confinement_mechanism_unavailable',
      message: expect.stringContaining('HTTPS only'),
    });
    createAdapter();
    await expect(
      startConfined('bad-host', {
        confinementPlan: {
          ...SEATBELT_PLAN,
          network: {
            policy: 'restricted',
            allowedHosts: ['https://x.example'],
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'confinement_mechanism_unavailable',
      message: expect.stringContaining('https://x.example'),
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('#4769: under a restricted network, a start that would fall back to Auto is refused, naming why, and nothing is spawned', async () => {
    const refusedFor = async (reason: string, start: Promise<unknown>) => {
      await expect(start).rejects.toMatchObject({
        name: 'ConfinementRefusedError',
        code: 'confinement_mechanism_unavailable',
        message: expect.stringContaining(
          `requires a restricted network, which cannot be applied to this start`,
        ),
      });
      await expect(start).rejects.toThrow(`(${reason})`);
    };
    // No confined credential.
    createAdapter({ connectionEnv: NO_CREDENTIAL });
    await refusedFor(
      'confined-credential-unavailable',
      startConfined('no-credential-restricted', {
        confinementPlan: RESTRICTED_PLAN,
      }),
    );
    // A folder too broad to confine.
    createAdapter();
    await refusedFor(
      'workspace-too-broad',
      adapter.startSession({
        provider: 'claude',
        threadId: 'home-restricted',
        cwd: homedir(),
        confinement: 'workspace',
        modelOptions: { approvalMode: 'never' },
        confinementPlan: RESTRICTED_PLAN,
      }),
    );
    expect(mockQuery).not.toHaveBeenCalled();
    // A resume recorded under another configuration home.
    startingQuery(Promise.resolve({}));
    await adapter.startSession({
      provider: 'claude',
      threadId: 'elsewhere-restricted',
      cwd: workspace,
      confinement: 'workspace',
      modelOptions: { approvalMode: 'auto' },
    });
    const binding = (await started('elsewhere-restricted'))
      .nativeResumeBindingKey as string;
    await adapter.stopSession('elsewhere-restricted');
    mockQuery.mockClear();
    await refusedFor(
      'resume-bound-elsewhere',
      startConfined('elsewhere-restricted', {
        confinementPlan: RESTRICTED_PLAN,
        resumeCursor: 'native-session-2',
        nativeResumeBindingKey: binding,
      }),
    );
    expect(mockQuery).not.toHaveBeenCalled();
    // Without the restriction the same fallbacks still run at Auto.
    createAdapter({ connectionEnv: NO_CREDENTIAL });
    startingQuery(Promise.resolve({}));
    await startConfined('no-credential-open');
    expect(
      (await started('no-credential-open')).stationConfinementRecord,
    ).toMatchObject({ fallback: 'confined-credential-unavailable' });
  });

  test('#4769: under a restricted network, an adoption (which pins the global config root) is refused, not run open', async () => {
    createAdapter({ serverProvider: true });
    mockForkSession.mockResolvedValue({ sessionId: 'vendor-child' });
    startingQuery(Promise.resolve({}));
    const adopting = adapter.adoptSession({
      provider: 'claude',
      threadId: 'adopted-restricted',
      sourceSessionId: 'vendor-source',
      sourceKind: 'claude-transcript',
      cwd: workspace,
      confinement: 'workspace',
      modelOptions: { approvalMode: 'never' },
      confinementPlan: RESTRICTED_PLAN,
    });
    await expect(adopting).rejects.toMatchObject({
      name: 'ConfinementRefusedError',
      code: 'confinement_mechanism_unavailable',
      message: expect.stringContaining('(config-root-pinned)'),
    });
    // Refused before the transcript is forked or an engine spawned.
    expect(mockForkSession).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('#4769: a restricted session gets station-control without the tools that act outside its sandbox (devices, previews, delegation, settings)', async () => {
    const given: Array<readonly string[] | undefined> = [];
    const knowledge: Array<readonly string[] | undefined> = [];
    createAdapter({
      stationControl: (tools) => given.push(tools),
      extra: {
        createInProcessStationKnowledge: (
          _threadId: string,
          _tenant?: unknown,
          allowedTools?: readonly string[],
        ) => {
          knowledge.push(allowedTools);
          return { connect: vi.fn(), close: vi.fn() } as never;
        },
      },
    });
    const toolServers = [
      {
        id: 'station-control',
        transport: 'stdio' as const,
        command: 'node',
        args: [builtinStationControlServerPath()],
      },
      {
        id: 'station-knowledge',
        transport: 'stdio' as const,
        command: 'node',
        args: [builtinStationKnowledgeServerPath()],
      },
    ];
    for (const [threadId, plan] of [
      ['control-open', SEATBELT_PLAN],
      ['control-restricted', RESTRICTED_PLAN],
    ] as const) {
      startingQuery(Promise.resolve({}));
      await startConfined(threadId, {
        confinementPlan: plan,
        agent: { slug: 'agent', toolServers },
      });
    }
    // Unrestricted: every tool, as before.
    expect(given[0]).toBeUndefined();
    const restricted = given[1]!;
    expect(restricted.length).toBeGreaterThan(0);
    for (const withheld of [
      'device_open',
      'device_input',
      'device_open_url',
      'device_launch_app',
      'html_preview',
      'html_render',
      'send_message',
      'delegate_task',
      'update_config',
      'install_skill',
    ])
      expect(restricted, withheld).not.toContain(withheld);
    expect(restricted).toContain('task_record');
    expect(
      restricted.every((name) =>
        RESTRICTED_NETWORK_STATION_CONTROL_TOOLS.has(name),
      ),
    ).toBe(true);
    // The knowledge server is held to the same allow-list.
    expect(knowledge[0]).toBeUndefined();
    expect(knowledge[1]).toEqual(restrictedNetworkStationControlTools());
    expect(knowledge[1]).toContain('search_knowledge');
  });

  test('#4769: a coordinator session restricted at its start keeps the narrow station-control set when its tools are connected live', async () => {
    const given = new Map<string, readonly string[] | undefined>();
    createAdapter({
      extra: {
        isCoordinatorSession: () => true,
        resolveCoordinatorStationControl: async () => ({
          id: 'station-control',
          transport: 'stdio' as const,
          command: 'node',
          args: [builtinStationControlServerPath()],
          coordinatorDerived: true,
          coordinatorGeneration: 0,
        }),
        createInProcessCoordinatorStationControl: (
          threadId: string,
          _tenant?: unknown,
          allowedTools?: readonly string[],
        ) => {
          given.set(threadId, allowedTools);
          return { connect: vi.fn(), close: vi.fn() } as never;
        },
      },
    });
    for (const [threadId, plan] of [
      ['coordinator-open', SEATBELT_PLAN],
      ['coordinator-restricted', RESTRICTED_PLAN],
    ] as const) {
      const query = startingQuery(Promise.resolve({})) as ReturnType<
        typeof startingQuery
      > & {
        setMcpServers?: ReturnType<typeof vi.fn>;
        mcpServerStatus?: ReturnType<typeof vi.fn>;
      };
      query.setMcpServers = vi.fn().mockResolvedValue({
        added: ['station-control'],
        removed: [],
        errors: {},
      });
      query.mcpServerStatus = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([
          {
            name: 'station-control',
            source: 'sdk',
            status: 'connected',
            tools: Object.keys(STATION_CONTROL_TOOL_POLICY).map((name) => ({
              name,
            })),
          },
        ]);
      await startConfined(threadId, {
        confinementPlan: plan,
        agent: { slug: 'agent', toolServers: [] },
      });
      // The live connection happens before the turn is dispatched; what the
      // turn does after it is not under test.
      void adapter.sendTurn({ threadId, input: 'go' }).catch(() => undefined);
      await vi.waitFor(() => expect(given.has(threadId)).toBe(true));
    }
    expect(given.get('coordinator-open')).toBeUndefined();
    const restricted = given.get('coordinator-restricted')!;
    expect(restricted).toEqual(restrictedNetworkStationControlTools());
    expect(restricted).not.toContain('device_open');
    expect(restricted).not.toContain('delegate_task');
  });

  test("#4769: a restricted session is not given Station's in-process browser, which runs outside the sandbox", async () => {
    createAdapter({ stationBrowser: true });
    for (const [threadId, plan, expected] of [
      ['browser-open', SEATBELT_PLAN, true],
      ['browser-restricted', RESTRICTED_PLAN, false],
    ] as const) {
      const query = startingQuery(Promise.resolve({}));
      await startConfined(threadId, {
        confinementPlan: plan,
        agent: { slug: 'agent' },
      });
      const servers = (query.options?.mcpServers ?? {}) as Record<
        string,
        unknown
      >;
      expect(Object.hasOwn(servers, 'station-browser'), threadId).toBe(
        expected,
      );
    }
  });

  test('readiness says, on macOS, whether a confined credential exists, without a login', async () => {
    mockPlatform.mockReturnValue('darwin');
    createAdapter({ connectionEnv: NO_CREDENTIAL });
    const missing = (await adapter.getPrerequisites()).find(
      (p) => p.id === 'claude-confined-credential',
    );
    expect(missing).toMatchObject({
      status: 'missing',
      category: 'optional',
      installGuide: { commands: ['claude setup-token'] },
    });
    createAdapter({ connectionEnv: FAKE_ENV_CREDENTIAL });
    expect(
      (await adapter.getPrerequisites()).find(
        (p) => p.id === 'claude-confined-credential',
      )?.status,
    ).toBe('installed');
    mockPlatform.mockReturnValue('linux');
    expect(
      (await adapter.getPrerequisites()).find(
        (p) => p.id === 'claude-confined-credential',
      ),
    ).toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
