import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const connectMCP = vi.fn();
const mcpLifecycle = { add: vi.fn() };
const mcpNegotiations = { add: vi.fn() };
const mcpNegotiationDuration = { record: vi.fn() };

vi.mock('@kontourai/station-shared/mcp', async (original) => {
  const actual =
    await original<typeof import('@kontourai/station-shared/mcp')>();
  const { fixtureMCPCustody } = await import(
    '../../../test-support/mcp-custody-fixture.js'
  );
  return {
    ...actual,
    connectMCP,
    MCPLocalConnectionCustody: fixtureMCPCustody(
      actual.MCPLocalConnectionCustody,
      connectMCP,
    ),
  };
});
vi.mock('../../../telemetry/metrics.js', () => ({
  mcpLifecycle,
  mcpNegotiations,
  mcpNegotiationDuration,
  // The MCP-UI resolver reads the same status map this loader writes; one test
  // below carries a failed load through to a resolution.
  mcpUiResolveTotal: { add: vi.fn() },
  mcpUiRenderPermissionChecks: { add: vi.fn() },
}));
vi.mock('../../../services/evidence/platform-mutation-gate.js', () => ({
  wrapPlatformMutationGatedTools: (tools: unknown[]) => tools,
}));

const {
  createRuntimeOAuthProvider,
  loadAgentTools: loadAgentToolsImplementation,
  releaseAllNativeStationControlConnections,
} = await import('../mcp-manager.js');
const { MCPLocalConnectionCustody } = await import(
  '@kontourai/station-shared/mcp'
);
const { createMCPToolProvenanceGeneration } = await import(
  '../../../services/orchestration/mcp-tool-provenance.js'
);
const { withTenantExecutionContext } = await import(
  '../../bootstrap/runtime-tenant-context.js'
);
const { builtinStationControlServerPath } = await import(
  '../../bootstrap/station-control-runtime-env.js'
);
const { isTrustedNativeStationControlTool } = await import(
  '../../tools/tool-provenance.js'
);
const { createBuiltinVendedToolDef } = await import(
  '../../tools/vended-tool-compat.js'
);
const { resolveMCPToolUIRef } = await import('../mcp-ui-resolver.js');
const { LOADER_FAILURE_CLASS_LIMIT, LOADER_WITHHELD_STATUS_REASON } =
  await import('../tool-load-failure.js');

/** All six methods of the Station logger contract (src-server/utils/logger.ts). */
const LOGGER_METHODS = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
] as const;

type LoggerSpy = Record<
  (typeof LOGGER_METHODS)[number],
  ReturnType<typeof vi.fn<(...args: unknown[]) => void>>
>;

function loggerSpy(): LoggerSpy {
  return Object.fromEntries(
    LOGGER_METHODS.map((method) => [method, vi.fn()]),
  ) as LoggerSpy;
}

/**
 * `JSON.stringify(new Error('CANARY'))` is `{}` for a plain Error — no
 * enumerable own properties — so a bare stringify of the logger's calls cannot
 * see text that rode in on an Error object. Expand every Error to its name,
 * message and stack AND its own enumerable properties, because that is where
 * the interesting text actually lives. `cause` and an AggregateError's `errors`
 * are returned as-is so the replacer recurses into them, guarded against a
 * cycle.
 */
function loggedText(logger: LoggerSpy, ...extra: unknown[]): string {
  const seen = new WeakSet<Error>();
  return JSON.stringify(
    [...LOGGER_METHODS.map((method) => logger[method].mock.calls), ...extra],
    (_key, value) => {
      if (!(value instanceof Error)) return value;
      if (seen.has(value)) return '[circular Error]';
      seen.add(value);
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
        cause: (value as Error & { cause?: unknown }).cause,
        errors: (value as Error & { errors?: unknown }).errors,
        // Where the interesting text actually lives: a node:assert
        // AssertionError carries the compared values on `actual`/`expected`,
        // and Node's argument validation carries `code`.
        ...Object.fromEntries(Object.entries(value)),
      };
    },
  );
}

/**
 * `integrationMetadata` is a loader collaborator, not a tool server. Breaking
 * it for one id reproduces #1482's shape inside the built-in vended-tool
 * branch: a genuine runtime `TypeError`, raised after that branch has already
 * pushed its tool and marked the integration connected, on a path that never
 * opens a connection.
 */
function metadataBrokenFor(brokenId: string) {
  const metadata = new Map<
    string,
    { type: string; transport?: string; toolCount?: number }
  >();
  const set = metadata.set.bind(metadata);
  metadata.set = (key, value) => {
    if (key === brokenId) {
      return (undefined as unknown as typeof metadata).set(key, value);
    }
    return set(key, value);
  };
  return metadata;
}

/** The payload of the loader's preconnect failure log record, if it was made. */
function loaderLogPayload(logger: LoggerSpy): unknown {
  return logger.error.mock.calls.find(
    ([message]) =>
      message === 'Failed to load agent tool before any connection',
  )?.[1];
}

function unreachableIntegrationMessage(toolId: string): string {
  return `Could not connect to integration '${toolId}'. The server command or endpoint could not be reached. Check its setup and credentials.`;
}

/** Tests name their provenance issuer explicitly rather than using production fallback. */
type LoadAgentToolsFixtureArgs = [
  Parameters<typeof loadAgentToolsImplementation>[0],
  Parameters<typeof loadAgentToolsImplementation>[1],
  Parameters<typeof loadAgentToolsImplementation>[2],
  Parameters<typeof loadAgentToolsImplementation>[3],
  Parameters<typeof loadAgentToolsImplementation>[4],
  Parameters<typeof loadAgentToolsImplementation>[5],
  Parameters<typeof loadAgentToolsImplementation>[6],
  Parameters<typeof loadAgentToolsImplementation>[7],
  Parameters<typeof loadAgentToolsImplementation>[8],
  Parameters<typeof loadAgentToolsImplementation>[9]?,
  Parameters<typeof loadAgentToolsImplementation>[11]?,
];

function loadAgentTools(...args: LoadAgentToolsFixtureArgs) {
  return loadAgentToolsImplementation(
    args[0],
    args[1],
    args[2],
    args[3],
    args[4],
    args[5],
    args[6],
    args[7],
    args[8],
    args[9],
    createMCPToolProvenanceGeneration(),
    args[10],
    new MCPLocalConnectionCustody(),
  );
}

describe('Station-owned MCP manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    return releaseAllNativeStationControlConnections();
  });

  test('the session tool-loading path excludes a disabled server before connecting', async () => {
    const tools = await loadAgentTools(
      'agent-one',
      { tools: { mcpServers: ['parked'], available: ['*'] } } as any,
      {
        loadIntegration: vi.fn().mockResolvedValue({
          id: 'parked',
          kind: 'mcp',
          enabled: false,
          command: 'parked-mcp',
        }),
      } as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
    );
    expect(tools).toEqual([]);
    expect(connectMCP).not.toHaveBeenCalled();
  });

  test('resolves a binding exactly once when establishing a child, lets it override legacy env, and does not reread for a cached child', async () => {
    const connection = {
      client: { callTool: vi.fn() },
      serverId: 'github',
      tools: [],
      negotiation: {
        era: 'modern',
        extensionIds: [],
        fellBackToLegacy: false,
      },
      disconnect: vi.fn(),
    };
    connectMCP.mockResolvedValue(connection);
    const resolver = {
      resolveForIntegration: vi.fn().mockResolvedValue({
        environment: { TOKEN: 'sentinel' },
        settlement: { settle: vi.fn() },
      }),
    };
    const def = {
      id: 'github',
      kind: 'mcp',
      transport: 'stdio',
      command: 'github-mcp',
      env: { TOKEN: 'legacy-value', SAFE: 'preserved' },
      secretEnvRefs: { TOKEN: 'github-token' },
    };
    const configs = new Map();
    const loader = { loadIntegration: vi.fn().mockResolvedValue(def) };
    const args = [
      'agent-one',
      { tools: { mcpServers: ['github'], available: ['*'] } } as any,
      loader as any,
      configs,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
      undefined,
      resolver,
    ] as const;

    await loadAgentTools(...args);
    await loadAgentTools(...args);

    expect(resolver.resolveForIntegration).toHaveBeenCalledOnce();
    expect(connectMCP).toHaveBeenCalledOnce();
    expect(connectMCP).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ TOKEN: 'sentinel', SAFE: 'preserved' }),
      }),
      expect.anything(),
    );
    expect(def.env).toEqual({ TOKEN: 'legacy-value', SAFE: 'preserved' });
  });

  test('settles a failed reconnect once and does not retain a failed child', async () => {
    const settlement = { settle: vi.fn() };
    connectMCP.mockRejectedValueOnce(new Error('reconnect failed'));
    const configs = new Map();
    const statuses = new Map([['github', { connected: false }]]);
    const resolver = {
      resolveForIntegration: vi.fn().mockResolvedValue({
        environment: { TOKEN: 'sentinel' },
        settlement,
      }),
    };
    await expect(
      loadAgentTools(
        'agent-one',
        { tools: { mcpServers: ['github'], available: ['*'] } } as any,
        {
          loadIntegration: vi.fn().mockResolvedValue({
            id: 'github',
            kind: 'mcp',
            transport: 'stdio',
            command: 'github-mcp',
            secretEnvRefs: { TOKEN: 'github-token' },
          }),
        } as any,
        configs,
        statuses,
        new Map(),
        new Map(),
        new Map(),
        { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
        undefined,
        resolver,
      ),
    ).resolves.toEqual([]);
    expect(configs).toEqual(new Map());
    expect(settlement.settle).toHaveBeenCalledExactlyOnceWith({
      outcome: 'failure',
      reason: 'child_establishment_failed',
    });
  });

  test('refuses secret refs on a non-stdio integration before resolver or transport', async () => {
    const resolver = { resolveForIntegration: vi.fn() };
    const logger = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    await loadAgentTools(
      'agent-one',
      { tools: { mcpServers: ['remote'], available: ['*'] } } as any,
      {
        loadIntegration: vi.fn().mockResolvedValue({
          id: 'remote',
          kind: 'mcp',
          transport: 'streamable-http',
          endpoint: 'https://example.test/mcp',
          secretEnvRefs: { TOKEN: 'binding-id' },
        }),
      } as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      logger,
      undefined,
      resolver,
    );
    expect(resolver.resolveForIntegration).not.toHaveBeenCalled();
    expect(connectMCP).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('binding-id');
  });

  test('refuses authored bindings for the exact built-in station-control child before transport', async () => {
    const resolver = { resolveForIntegration: vi.fn() };
    await loadAgentTools(
      'agent-one',
      { tools: { mcpServers: ['station-control'], available: ['*'] } } as any,
      {
        loadIntegration: vi.fn().mockResolvedValue({
          id: 'station-control',
          kind: 'mcp',
          transport: 'stdio',
          command: 'node',
          args: [builtinStationControlServerPath()],
          secretEnvRefs: { TOKEN: 'binding-id' },
        }),
      } as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
      undefined,
      resolver,
    );
    expect(resolver.resolveForIntegration).not.toHaveBeenCalled();
    expect(connectMCP).not.toHaveBeenCalled();
  });

  test('the real runtime HTTP connection receives an endpoint-bound OAuth provider', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-runtime-oauth-'));
    connectMCP.mockResolvedValueOnce({
      client: { callTool: vi.fn() },
      serverId: 'remote',
      tools: [],
      negotiation: {
        era: 'modern',
        protocolVersion: '2026-07-28',
        serverCapabilities: {},
        extensionIds: [],
        fellBackToLegacy: false,
      },
      disconnect: vi.fn(),
    });
    expect(() =>
      createRuntimeOAuthProvider(
        { getProjectHomeDir: () => home } as any,
        {
          id: 'remote',
          kind: 'mcp',
          transport: 'streamable-http',
          endpoint: 'https://resource.example/mcp',
        },
        4555,
      ),
    ).not.toThrow();
    const logger = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    await loadAgentTools(
      'agent-one',
      { tools: { mcpServers: ['remote'], available: ['*'] } } as any,
      {
        getProjectHomeDir: () => home,
        loadIntegration: vi.fn().mockResolvedValue({
          id: 'remote',
          kind: 'mcp',
          transport: 'streamable-http',
          endpoint: 'https://resource.example/mcp',
        }),
      } as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      logger,
      4555,
    );

    expect(logger.error.mock.calls).toEqual([]);
    expect(connectMCP).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'https://resource.example/mcp' }),
      expect.objectContaining({
        authProvider: expect.objectContaining({
          redirectUrl:
            'http://127.0.0.1:4555/integrations/remote/oauth/callback',
        }),
      }),
    );
  });

  test('routes concurrent built-in station-control calls through isolated tenant clients', async () => {
    const catalog = {
      client: { callTool: vi.fn() },
      serverId: 'station-control',
      tools: [
        {
          name: 'station-control_list_agents',
          originalName: 'list_agents',
          serverId: 'station-control',
          description: 'List agents.',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      negotiation: {
        era: 'modern',
        protocolVersion: '2026-07-28',
        serverInfo: { name: 'station-control', version: '1.0.0' },
        serverCapabilities: { tools: {}, extensions: {} },
        extensionIds: [],
        fellBackToLegacy: false,
      },
      disconnect: vi.fn(),
    };
    const alpha = {
      client: { callTool: vi.fn().mockResolvedValue('alpha') },
      disconnect: vi.fn(),
    };
    const bravo = {
      client: { callTool: vi.fn().mockResolvedValue('bravo') },
      disconnect: vi.fn(),
    };
    connectMCP
      .mockResolvedValueOnce(catalog)
      .mockResolvedValueOnce(alpha)
      .mockResolvedValueOnce(bravo);

    const tools = await loadAgentTools(
      'agent-one',
      { tools: { mcpServers: ['station-control'], available: ['*'] } } as any,
      {
        loadIntegration: vi.fn().mockResolvedValue({
          id: 'station-control',
          kind: 'mcp',
          transport: 'stdio',
          command: 'node',
          args: [builtinStationControlServerPath()],
        }),
      } as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
    );

    expect(isTrustedNativeStationControlTool(tools[0])).toBe(true);

    await Promise.all([
      withTenantExecutionContext(
        { tenantId: 'alpha' as any, source: 'request' },
        () => tools[0]!.execute!({}),
      ),
      withTenantExecutionContext(
        { tenantId: 'bravo' as any, source: 'request' },
        () => tools[0]!.execute!({}),
      ),
    ]);

    expect(alpha.client.callTool).toHaveBeenCalledWith({
      name: 'list_agents',
      arguments: {},
    });
    expect(bravo.client.callTool).toHaveBeenCalledWith({
      name: 'list_agents',
      arguments: {},
    });
    expect(connectMCP.mock.calls.slice(1)).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            env: expect.objectContaining({ STATION_INTERNAL_TENANT: 'alpha' }),
          }),
        ],
        [
          expect.objectContaining({
            env: expect.objectContaining({ STATION_INTERNAL_TENANT: 'bravo' }),
          }),
        ],
      ]),
    );
  });

  test('single-flights concurrent first calls for the same tenant', async () => {
    let resolveConnection: ((value: any) => void) | undefined;
    const catalog = {
      client: { callTool: vi.fn() },
      serverId: 'station-control',
      tools: [
        {
          name: 'station-control_list_agents',
          originalName: 'list_agents',
          serverId: 'station-control',
          inputSchema: { type: 'object' },
        },
      ],
      negotiation: {
        era: 'modern',
        protocolVersion: '2026-07-28',
        serverInfo: { name: 'station-control', version: '1' },
        serverCapabilities: { tools: {}, extensions: {} },
        extensionIds: [],
        fellBackToLegacy: false,
      },
      disconnect: vi.fn(),
    };
    const tenantConnection = {
      client: { callTool: vi.fn().mockResolvedValue('ok') },
      disconnect: vi.fn(),
    };
    connectMCP.mockResolvedValueOnce(catalog).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveConnection = resolve;
        }),
    );
    const tools = await loadAgentTools(
      'agent-one',
      { tools: { mcpServers: ['station-control'], available: ['*'] } } as any,
      {
        loadIntegration: vi.fn().mockResolvedValue({
          id: 'station-control',
          kind: 'mcp',
          transport: 'stdio',
          command: 'node',
          args: [builtinStationControlServerPath()],
        }),
      } as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
    );
    const context = { tenantId: 'alpha' as any, source: 'request' as const };
    const first = withTenantExecutionContext(context, () =>
      tools[0]!.execute!({}),
    );
    const second = withTenantExecutionContext(context, () =>
      tools[0]!.execute!({}),
    );
    await vi.waitFor(() => expect(connectMCP).toHaveBeenCalledTimes(2));
    resolveConnection!(tenantConnection);
    await Promise.all([first, second]);
    expect(tenantConnection.client.callTool).toHaveBeenCalledTimes(2);
  });

  test('disposes an in-flight tenant connection during release-all instead of caching it afterward', async () => {
    let resolveConnection: ((value: any) => void) | undefined;
    const catalog = {
      client: { callTool: vi.fn() },
      serverId: 'station-control',
      tools: [
        {
          name: 'station-control_list_agents',
          originalName: 'list_agents',
          serverId: 'station-control',
          inputSchema: { type: 'object' },
        },
      ],
      negotiation: {
        era: 'modern',
        protocolVersion: '2026-07-28',
        serverInfo: { name: 'station-control', version: '1' },
        serverCapabilities: { tools: {}, extensions: {} },
        extensionIds: [],
        fellBackToLegacy: false,
      },
      disconnect: vi.fn(),
    };
    const pendingConnection = {
      client: { callTool: vi.fn().mockResolvedValue('stale') },
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const freshConnection = {
      client: { callTool: vi.fn().mockResolvedValue('fresh') },
      disconnect: vi.fn(),
    };
    connectMCP
      .mockResolvedValueOnce(catalog)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveConnection = resolve;
          }),
      )
      .mockResolvedValueOnce(freshConnection);
    const tools = await loadAgentTools(
      'agent-one',
      { tools: { mcpServers: ['station-control'], available: ['*'] } } as any,
      {
        loadIntegration: vi.fn().mockResolvedValue({
          id: 'station-control',
          kind: 'mcp',
          transport: 'stdio',
          command: 'node',
          args: [builtinStationControlServerPath()],
        }),
      } as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
    );
    const context = { tenantId: 'alpha' as any, source: 'request' as const };
    const pending = withTenantExecutionContext(context, () =>
      tools[0]!.execute!({}),
    );
    await vi.waitFor(() => expect(connectMCP).toHaveBeenCalledTimes(2));

    const cleanup = releaseAllNativeStationControlConnections();
    resolveConnection!(pendingConnection);
    await cleanup;
    await expect(pending).rejects.toThrow(
      'released while creation was pending',
    );
    expect(pendingConnection.disconnect).toHaveBeenCalledOnce();

    await expect(
      withTenantExecutionContext(context, () => tools[0]!.execute!({})),
    ).resolves.toBe('fresh');
    expect(freshConnection.client.callTool).toHaveBeenCalledOnce();
    expect(connectMCP).toHaveBeenCalledTimes(3);

    await releaseAllNativeStationControlConnections();
    let resolveFailedConnection: ((value: any) => void) | undefined;
    const failedConnection = {
      client: { callTool: vi.fn().mockResolvedValue('failed-stale') },
      disconnect: vi.fn().mockRejectedValueOnce(new Error('stale disconnect')),
    };
    connectMCP.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFailedConnection = resolve;
        }),
    );
    const failedPending = withTenantExecutionContext(context, () =>
      tools[0]!.execute!({}),
    );
    await vi.waitFor(() => expect(connectMCP).toHaveBeenCalledTimes(4));
    const failedPendingExpectation = expect(failedPending).rejects.toThrow(
      'released while creation was pending',
    );
    const failedCleanup = releaseAllNativeStationControlConnections();
    resolveFailedConnection!(failedConnection);
    await expect(failedCleanup).rejects.toThrow(
      'Native station-control cleanup failed.',
    );
    await failedPendingExpectation;
    expect(failedConnection.disconnect).toHaveBeenCalledOnce();
    await expect(
      releaseAllNativeStationControlConnections(),
    ).resolves.toBeUndefined();
    expect(failedConnection.disconnect).toHaveBeenCalledTimes(2);
  });

  test('shares one negotiated connection and adapts tools into the engine boundary', async () => {
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { ok: true },
    });
    const connection = {
      client: { callTool },
      serverId: 'review',
      tools: [
        {
          name: 'review_decide',
          originalName: 'decide',
          serverId: 'review',
          description: 'Decide a review item.',
          inputSchema: {
            type: 'object',
            properties: { decision: { type: 'string' } },
          },
          _meta: { ui: { resourceUri: 'ui://review/panel' } },
          ui: { resourceUri: 'ui://review/panel' },
        },
        {
          name: 'review_app_action',
          originalName: 'app_action',
          serverId: 'review',
          description: 'Only callable by the rendered app.',
          inputSchema: { type: 'object', properties: {} },
          _meta: { ui: { visibility: ['app'] } },
          ui: { visibility: ['app'] },
        },
      ],
      negotiation: {
        era: 'modern',
        protocolVersion: '2026-07-28',
        serverInfo: { name: 'survey', version: '2.5.0' },
        serverCapabilities: { tools: {}, extensions: {} },
        extensionIds: ['io.modelcontextprotocol/ui'],
        fellBackToLegacy: false,
      },
      close: vi.fn(),
      disconnect: vi.fn(),
    };
    connectMCP.mockResolvedValue(connection);

    const configLoader = {
      loadIntegration: vi.fn().mockResolvedValue({
        id: 'review',
        kind: 'mcp',
        transport: 'stdio',
        command: 'survey-review-mcp',
      }),
    };
    const mcpConfigs = new Map();
    const connectionStatus = new Map();
    const integrationMetadata = new Map();
    const toolNameMapping = new Map();
    const toolNameReverseMapping = new Map();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };
    const spec = {
      tools: { mcpServers: ['review'], available: ['*'] },
    } as any;

    const first = await loadAgentTools(
      'agent-one',
      spec,
      configLoader as any,
      mcpConfigs,
      connectionStatus,
      integrationMetadata,
      toolNameMapping,
      toolNameReverseMapping,
      logger,
    );
    const second = await loadAgentTools(
      'agent-two',
      spec,
      configLoader as any,
      mcpConfigs,
      connectionStatus,
      integrationMetadata,
      toolNameMapping,
      toolNameReverseMapping,
      logger,
    );

    expect(connectMCP).toHaveBeenCalledTimes(1);
    expect(mcpConfigs.get('review')).toMatchObject({
      client: connection.client,
      tools: connection.tools,
      negotiation: connection.negotiation,
    });
    expect(first[0]).toMatchObject({
      name: 'review_decide',
      description: 'Decide a review item.',
      _meta: { ui: { resourceUri: 'ui://review/panel' } },
    });
    await first[0].execute?.({ decision: 'accept' });
    expect(callTool).toHaveBeenCalledWith({
      name: 'decide',
      arguments: { decision: 'accept' },
    });
    expect(second).toHaveLength(1);
    expect(first.map((tool) => tool.name)).not.toContain('review_app_action');
    expect(mcpNegotiations.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        era: 'modern',
        protocol_version: '2026-07-28',
        fallback: 'false',
        outcome: 'success',
      }),
    );
    expect(mcpNegotiationDuration.record).toHaveBeenCalled();
  });

  test('records a bounded failure and never logs the raw process error', async () => {
    connectMCP.mockRejectedValue(
      new Error('spawn /secret/path ENOENT token=super-secret'),
    );
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };
    const connectionStatus = new Map();

    const tools = await loadAgentTools(
      'agent-one',
      { tools: { mcpServers: ['broken'], available: ['*'] } } as any,
      {
        loadIntegration: vi.fn().mockResolvedValue({
          id: 'broken',
          kind: 'mcp',
          transport: 'stdio',
          command: '/secret/path',
        }),
      } as any,
      new Map(),
      connectionStatus,
      new Map(),
      new Map(),
      new Map(),
      logger,
    );

    expect(tools).toEqual([]);
    expect(connectionStatus.get('broken')).toEqual({
      connected: false,
      error:
        "Could not connect to integration 'broken'. The server command or endpoint could not be reached. Check its setup and credentials.",
    });
    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).not.toContain('/secret/path');
    expect(logged).not.toContain('super-secret');
    expect(mcpNegotiations.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        outcome: 'failure',
        error_class: 'transport',
      }),
    );
  });

  test('bounds resolved runtime tool-call failures at the canonical conversion seam', async () => {
    const remoteText = 'tool failed refresh-token-canary-from-remote-server';
    const callTool = vi.fn().mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: remoteText }],
      structuredContent: { health: remoteText },
    });
    connectMCP.mockResolvedValueOnce({
      client: { callTool },
      serverId: 'remote',
      tools: [
        {
          name: 'remote_read',
          originalName: 'read',
          serverId: 'remote',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      negotiation: {
        era: 'modern',
        protocolVersion: '2026-07-28',
        extensionIds: [],
        fellBackToLegacy: false,
      },
      disconnect: vi.fn(),
    });
    const logger = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    const tools = await loadAgentTools(
      'agent-one',
      { tools: { mcpServers: ['remote'], available: ['*'] } } as any,
      {
        loadIntegration: vi.fn().mockResolvedValue({
          id: 'remote',
          kind: 'mcp',
          transport: 'streamable-http',
          endpoint: 'https://resource.example/mcp',
        }),
        getProjectHomeDir: () => mkdtempSync(join(tmpdir(), 'runtime-bound-')),
      } as any,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      logger,
    );

    await expect(tools[0]?.execute?.({})).rejects.toThrow(
      'MCP tool call failed',
    );
    expect(
      JSON.stringify(
        Object.values(logger).map((loggerMethod) => loggerMethod.mock.calls),
      ),
    ).not.toContain(remoteText);
    expect(logger.debug).toHaveBeenCalledWith(
      'Tool server operation failed',
      expect.objectContaining({
        serverId: 'remote',
        operation: 'tool-call',
      }),
    );
  });

  /**
   * #1486. The per-tool catch in `loadAgentTools` is the single failure seam
   * for every phase of a tool load, and before this it did two wrong things:
   * it named every failure a connection failure — including the built-in
   * branch, which never connects — and it wrote no status at all, so
   * `GET /agents/:slug/health` kept serving whatever the previous load left.
   * These cover the classification in both directions and the status write.
   */
  test('reports a TypeError raised inside the built-in vended-tool branch with its own class and keeps loading the rest (#1486)', async () => {
    const logger = loggerSpy();
    const connectionStatus = new Map<
      string,
      { connected: boolean; error?: string }
    >();
    const integrationMetadata = metadataBrokenFor('notebook');
    const defs = new Map(
      ['notebook', 'render-component'].map((id) => [
        id,
        createBuiltinVendedToolDef(id),
      ]),
    );

    const tools = await loadAgentTools(
      'agent-one',
      {
        tools: {
          mcpServers: ['notebook', 'render-component'],
          available: ['*'],
        },
      } as any,
      { loadIntegration: vi.fn(async (id: string) => defs.get(id)) } as any,
      new Map(),
      connectionStatus,
      integrationMetadata,
      new Map(),
      new Map(),
      logger,
    );

    // Nothing here connected to anything, so the failure is named by its own
    // class rather than asserted as an unreachable server. The built-in branch
    // had already written `{ connected: true }`; the catch must replace it.
    expect(connectionStatus.get('notebook')?.connected).toBe(false);
    expect(connectionStatus.get('notebook')?.error).toMatch(/^TypeError: /);
    expect(connectionStatus.get('notebook')?.error).not.toContain(
      'Could not connect',
    );
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to load agent tool before any connection',
      expect.objectContaining({
        toolId: 'notebook',
        failure: 'loader',
        errorClass: 'TypeError',
        messageWithheld: false,
        error: expect.any(TypeError),
      }),
    );
    // The throw does not escape the per-tool loop: the sibling built-in still
    // loads, and the tool pushed before the throw is not unwound.
    expect(connectionStatus.get('render-component')).toEqual({
      connected: true,
    });
    expect(integrationMetadata.get('render-component')).toEqual({
      type: 'builtin',
      toolCount: 1,
    });
    expect(tools).toHaveLength(2);
    expect(connectMCP).not.toHaveBeenCalled();
  });

  test('writes a failure status for a load that threw before connecting, replacing a stale success (#1486)', async () => {
    const canary = 'integration-config-loader-canary';
    const logger = loggerSpy();
    // `previously-ok` carries a success from an earlier load — the staleness
    // `GET /agents/:slug/health` used to serve. `never-seen` has no entry at
    // all, which is the other half of the same absence.
    const connectionStatus = new Map<
      string,
      { connected: boolean; error?: string }
    >([['previously-ok', { connected: true }]]);

    const tools = await loadAgentTools(
      'agent-one',
      {
        tools: {
          mcpServers: ['previously-ok', 'never-seen'],
          available: ['*'],
        },
      } as any,
      {
        loadIntegration: vi
          .fn()
          .mockRejectedValue(new Error(`load failed ${canary}`)),
      } as any,
      new Map(),
      connectionStatus,
      new Map(),
      new Map(),
      new Map(),
      logger,
    );

    expect(tools).toEqual([]);
    expect(connectionStatus.get('previously-ok')).toEqual({
      connected: false,
      error: unreachableIntegrationMessage('previously-ok'),
    });
    expect(connectionStatus.get('never-seen')).toEqual({
      connected: false,
      error: unreachableIntegrationMessage('never-seen'),
    });
    // A plain Error is not a class the runtime raises for a program defect, so
    // it keeps the redacted vocabulary rather than widening the escape.
    expect(loggedText(logger, [...connectionStatus])).not.toContain(canary);
  });

  test('names a SyntaxError class but never its message, which quotes secret-bearing config (#1486)', async () => {
    // `configLoader.loadIntegration` runs preconnect and reaches unguarded
    // JSON.parse calls on integration.json and the tool-server credential
    // store. V8 composes a SyntaxError message from a WINDOW OF THE PARSED
    // SOURCE, so surfacing it would publish file bytes through
    // GET /agents/:slug/health and the log store.
    const secret = 'sekr';
    let thrown: SyntaxError | undefined;
    try {
      JSON.parse(`{"pad":"${'a'.repeat(30)}","TOKEN":"${secret}","b":x}`);
    } catch (error) {
      thrown = error as SyntaxError;
    }
    // Not hypothetical: the real V8 message quotes the stored value verbatim.
    expect(thrown?.message).toContain(`"${secret}"`);
    const leakedMessage = thrown?.message as string;
    const logger = loggerSpy();
    const connectionStatus = new Map<
      string,
      { connected: boolean; error?: string }
    >();

    await expect(
      loadAgentTools(
        'agent-one',
        { tools: { mcpServers: ['demoServer'], available: ['*'] } } as any,
        { loadIntegration: vi.fn().mockRejectedValue(thrown) } as any,
        new Map(),
        connectionStatus,
        new Map(),
        new Map(),
        new Map(),
        logger,
      ),
    ).resolves.toEqual([]);

    // Class named — this is not a connection failure — message dropped, and
    // the status says WHY it is short rather than reading as a bare class.
    expect(connectionStatus.get('demoServer')).toEqual({
      connected: false,
      error: `${LOADER_WITHHELD_STATUS_REASON} (SyntaxError)`,
    });
    const payload = loaderLogPayload(logger);
    expect(payload).toMatchObject({
      errorClass: 'SyntaxError',
      messageWithheld: true,
    });
    // Withheld means withheld: `error.stack` opens with the message, so the
    // Error object cannot ride into the log store either — but the call FRAMES
    // are program text and are what let an operator find the corrupt file.
    expect(payload).not.toHaveProperty('error');
    expect(
      (payload as { stackFrames?: string[] })?.stackFrames?.length,
    ).toBeGreaterThan(0);
    const observable = loggedText(logger, [...connectionStatus]);
    expect(observable).not.toContain(leakedMessage);
    expect(observable).not.toContain(`"${secret}"`);
  });

  test("withholds a real Node argument-validation TypeError's inspected value end to end (#1486)", async () => {
    // `name` is 'TypeError' — a class the name set surfaces in full — while
    // the message embeds util.inspect of the value Node rejected. Only the
    // ERR_INVALID_ARG_TYPE code separates the two, so removing the code set
    // publishes this value through GET /agents/:slug/health.
    const canary = 987654321;
    let thrown: unknown;
    try {
      Buffer.from(canary as unknown as string);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toContain(String(canary));
    const logger = loggerSpy();
    const connectionStatus = new Map<
      string,
      { connected: boolean; error?: string }
    >();

    await expect(
      loadAgentTools(
        'agent-one',
        { tools: { mcpServers: ['argcheck'], available: ['*'] } } as any,
        { loadIntegration: vi.fn().mockRejectedValue(thrown) } as any,
        new Map(),
        connectionStatus,
        new Map(),
        new Map(),
        new Map(),
        logger,
      ),
    ).resolves.toEqual([]);

    expect(connectionStatus.get('argcheck')).toEqual({
      connected: false,
      error: `${LOADER_WITHHELD_STATUS_REASON} (TypeError)`,
    });
    expect(loaderLogPayload(logger)).toMatchObject({
      errorClass: 'TypeError',
      messageWithheld: true,
    });
    expect(loaderLogPayload(logger)).not.toHaveProperty('error');
    expect(loggedText(logger, [...connectionStatus])).not.toContain(
      String(canary),
    );
  });

  test("withholds an AssertionError's compared values, which live on own properties (#1486)", async () => {
    // node:assert puts the compared values on `actual`/`expected`, which a
    // name/message/stack-only sweep cannot see — so the sweep below expands
    // own enumerable properties, and the control proves it actually reads them.
    const canary = 'assertion-actual-canary';
    let thrown: Error | undefined;
    try {
      assert.strictEqual(canary, 'expected-value');
    } catch (error) {
      thrown = error as Error;
    }
    expect((thrown as unknown as { actual?: unknown })?.actual).toBe(canary);
    const control = loggerSpy();
    control.error('carrying the error object', { error: thrown });
    expect(loggedText(control)).toContain(canary);

    const logger = loggerSpy();
    const connectionStatus = new Map<
      string,
      { connected: boolean; error?: string }
    >();
    await expect(
      loadAgentTools(
        'agent-one',
        { tools: { mcpServers: ['asserted'], available: ['*'] } } as any,
        { loadIntegration: vi.fn().mockRejectedValue(thrown) } as any,
        new Map(),
        connectionStatus,
        new Map(),
        new Map(),
        new Map(),
        logger,
      ),
    ).resolves.toEqual([]);

    expect(connectionStatus.get('asserted')).toEqual({
      connected: false,
      error: `${LOADER_WITHHELD_STATUS_REASON} (AssertionError)`,
    });
    expect(loggedText(logger, [...connectionStatus])).not.toContain(canary);
  });

  test('bounds and flattens a hostile class name before it reaches the status (#1486)', async () => {
    // `name` is a writable own property, so the class label is attacker- (or
    // bug-) controlled text on the same egress path as a message.
    const thrown = Object.assign(new TypeError('ignored'), {
      name: `Evil Name ${'x'.repeat(300)}`,
      code: 'ERR_INVALID_ARG_VALUE',
    });
    const logger = loggerSpy();
    const connectionStatus = new Map<
      string,
      { connected: boolean; error?: string }
    >();

    await loadAgentTools(
      'agent-one',
      { tools: { mcpServers: ['hostile'], available: ['*'] } } as any,
      { loadIntegration: vi.fn().mockRejectedValue(thrown) } as any,
      new Map(),
      connectionStatus,
      new Map(),
      new Map(),
      new Map(),
      logger,
    );

    const recorded = connectionStatus.get('hostile')?.error as string;
    expect(
      recorded.startsWith(`${LOADER_WITHHELD_STATUS_REASON} (Evil Name `),
    ).toBe(true);
    expect(recorded).toContain('… (truncated)');
    expect(recorded.length).toBeLessThanOrEqual(
      `${LOADER_WITHHELD_STATUS_REASON} ()`.length + LOADER_FAILURE_CLASS_LIMIT,
    );
    expect(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(recorded)).toBe(false);
    expect(loaderLogPayload(logger)).toMatchObject({ messageWithheld: true });
    expect(
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(
        (loaderLogPayload(logger) as { errorClass: string }).errorClass,
      ),
    ).toBe(false);
  });

  test("preserves the connect seam's own timeout classification instead of overwriting it (#1486)", async () => {
    // The connect seam still holds the ORIGINAL error and classifies it as a
    // timeout; the catch only ever sees the wrapped ToolServerOperationError
    // and would recompose the generic reachability line. The seam signals what
    // it recorded through a callback, so a concurrent agent load writing the
    // same runtime-wide key cannot be mistaken for this call's own record.
    connectMCP.mockRejectedValueOnce(new Error('the request timed out'));
    const logger = loggerSpy();
    const connectionStatus = new Map<
      string,
      { connected: boolean; error?: string }
    >();

    await expect(
      loadAgentTools(
        'agent-one',
        { tools: { mcpServers: ['slowpoke'], available: ['*'] } } as any,
        {
          loadIntegration: vi.fn().mockResolvedValue({
            id: 'slowpoke',
            kind: 'mcp',
            transport: 'stdio',
            command: 'slowpoke-mcp',
          }),
        } as any,
        new Map(),
        connectionStatus,
        new Map(),
        new Map(),
        new Map(),
        logger,
      ),
    ).resolves.toEqual([]);

    expect(connectionStatus.get('slowpoke')?.error).toContain(
      'did not respond in time',
    );
    expect(connectionStatus.get('slowpoke')?.error).not.toContain(
      'could not be reached',
    );
  });

  test('a preconnect failure now resolves an MCP-UI ref to missing_server rather than falling through (#1486)', async () => {
    // Disclosed downstream consequence of writing a status where there was
    // none: mcp-ui-resolver short-circuits on `connected === false`, so a
    // VoltAgent preconnect failure that previously left no entry — and let the
    // resolver go on to a catalog read — now stops at the connection gate.
    const logger = loggerSpy();
    const connectionStatus = new Map<
      string,
      { connected: boolean; error?: string }
    >();
    const getMCPUIToolCatalog = vi
      .fn()
      .mockResolvedValue({ available: true, tools: [] });
    const resolverService = {
      listIntegrations: async () => [{ id: 'panels' }],
      getConnectionStatus: (_agent: string, toolId: string) =>
        connectionStatus.get(toolId),
      getMCPUIToolCatalog,
    };

    // Before the load, no status exists and resolution reaches the catalog.
    await expect(
      resolveMCPToolUIRef(resolverService as any, 'panels/show', 'agent-one'),
    ).resolves.toMatchObject({ status: 'missing_tool' });
    expect(getMCPUIToolCatalog).toHaveBeenCalled();
    getMCPUIToolCatalog.mockClear();

    await loadAgentTools(
      'agent-one',
      { tools: { mcpServers: ['panels'], available: ['*'] } } as any,
      {
        loadIntegration: vi
          .fn()
          .mockRejectedValue(new Error("Tool 'panels' not found")),
      } as any,
      new Map(),
      connectionStatus,
      new Map(),
      new Map(),
      new Map(),
      logger,
    );

    await expect(
      resolveMCPToolUIRef(resolverService as any, 'panels/show', 'agent-one'),
    ).resolves.toMatchObject({
      status: 'missing_server',
      reason: 'MCP server is not connected',
    });
    expect(getMCPUIToolCatalog).not.toHaveBeenCalled();
  });

  test('keeps a post-connection failure redacted whatever its class, and still writes a failure status (#1486)', async () => {
    const canary = 'remote-normalization-provider-canary';
    connectMCP.mockResolvedValueOnce({
      client: { callTool: vi.fn() },
      serverId: 'remote',
      tools: [
        {
          name: 'remote_read',
          originalName: 'read',
          serverId: 'remote',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      negotiation: {
        era: 'modern',
        protocolVersion: '2026-07-28',
        extensionIds: [],
        fellBackToLegacy: false,
      },
      disconnect: vi.fn(),
    });
    const logger = loggerSpy();
    const connectionStatus = new Map<
      string,
      { connected: boolean; error?: string }
    >();
    // The connection succeeded and `listTools` returned; this TypeError comes
    // out of the normalization that runs over the server's response, so its
    // text can be composed from remote data. It is the case that proves PHASE,
    // not class, gates redaction: `TypeError` is a class the preconnect rule
    // surfaces, and moving or removing the `phase = 'connect'` flip publishes
    // the canary here.
    const toolNameMapping = new Map<string, any>();
    toolNameMapping.set = () => {
      throw new TypeError(`cannot index runtime tool name ${canary}`);
    };

    await expect(
      loadAgentTools(
        'agent-one',
        { tools: { mcpServers: ['remote'], available: ['*'] } } as any,
        {
          loadIntegration: vi.fn().mockResolvedValue({
            id: 'remote',
            kind: 'mcp',
            transport: 'stdio',
            command: 'remote-mcp',
          }),
        } as any,
        new Map(),
        connectionStatus,
        new Map(),
        toolNameMapping,
        new Map(),
        logger,
      ),
    ).resolves.toEqual([]);

    expect(connectMCP).toHaveBeenCalledOnce();
    expect(connectionStatus.get('remote')).toEqual({
      connected: false,
      error: unreachableIntegrationMessage('remote'),
    });
    expect(loggedText(logger, [...connectionStatus])).not.toContain(canary);
  });
});
