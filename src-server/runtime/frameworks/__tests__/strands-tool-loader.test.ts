import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { MCPLocalConnectionCustody } from '@kontourai/station-shared/mcp';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { withTenantExecutionContext } from '../../bootstrap/runtime-tenant-context.js';
import { builtinStationControlServerPath } from '../../bootstrap/station-control-runtime-env.js';
import {
  createNativeOutputGrantAuthority,
  currentNativeOutputCallScope,
  runWithNativeOutputTurnContext,
} from '../../native-output-turn-grant.js';
import {
  applyStrandsAvailableToolFilter,
  createStrandsFunctionTools,
  destroyStrandsAgentTools,
  loadStrandsTools,
  releaseAllNativeStationControlClients,
} from '../strands-tool-loader.js';

const { strandsMcpClients } = vi.hoisted(() => ({
  strandsMcpClients: [] as any[],
}));
const strandsMcpTestState = vi.hoisted(() => ({
  deferNextClient: false,
  resolveDeferredClient: undefined as (() => void) | undefined,
  rejectNextListTools: undefined as Error | undefined,
}));

vi.mock('@strands-agents/sdk', () => ({
  FunctionTool: class {
    config: any;

    constructor(config: any) {
      this.config = config;
    }

    callback(input: unknown, toolContext: any) {
      return this.config.callback(input, toolContext);
    }
  },
  McpClient: class {
    transport: unknown;
    callTool: ReturnType<typeof vi.fn>;
    disconnect = vi.fn().mockResolvedValue(undefined);

    constructor(config: any) {
      this.transport = config.transport;
      const ordinal = strandsMcpClients.length;
      this.callTool = vi.fn().mockResolvedValue(ordinal);
      strandsMcpClients.push(this);
    }

    async connect() {
      if (strandsMcpTestState.deferNextClient) {
        strandsMcpTestState.deferNextClient = false;
        await new Promise<void>((resolve) => {
          strandsMcpTestState.resolveDeferredClient = resolve;
        });
      }
    }

    async listTools() {
      if (strandsMcpTestState.rejectNextListTools) {
        const error = strandsMcpTestState.rejectNextListTools;
        strandsMcpTestState.rejectNextListTools = undefined;
        throw error;
      }
      return [
        {
          toolSpec: {
            name: 'demoServer_render',
            description: 'Render UI',
            inputSchema: { type: 'object' },
            _meta: { ui: { resourceUri: 'ui://demoServer/render.html' } },
          },
        },
      ];
    }
  },
}));

afterEach(async () => {
  await releaseAllNativeStationControlClients();
  strandsMcpClients.splice(0);
  strandsMcpTestState.deferNextClient = false;
  strandsMcpTestState.resolveDeferredClient = undefined;
  strandsMcpTestState.rejectNextListTools = undefined;
  delete process.env.STATION_HOSTED_TENANT_REGISTRY_FILE;
});

async function loadBuiltinStationControlTools(
  custody = new MCPLocalConnectionCustody(),
) {
  return loadStrandsTools({
    slug: 'agent-a',
    spec: {
      tools: { mcpServers: ['station-control'], available: ['*'] },
    } as any,
    opts: {
      mcpCustody: custody,
      configLoader: {
        loadIntegration: vi.fn().mockResolvedValue({
          id: 'station-control',
          kind: 'mcp',
          transport: 'stdio',
          command: 'node',
          args: [builtinStationControlServerPath()],
        }),
      } as any,
      mcpConnectionStatus: new Map(),
      integrationMetadata: new Map(),
      toolNameMapping: new Map(),
      toolNameReverseMapping: new Map(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
    state: { mcpClients: new Map(), agentMcpClients: new Map() },
  });
}

describe('applyStrandsAvailableToolFilter', () => {
  test('keeps exact and wildcard tool matches', () => {
    const tools = [
      { name: 'read_file', execute: vi.fn() },
      { name: 'edit_file', execute: vi.fn() },
      { name: 'mcp__github__search', execute: vi.fn() },
    ] as any;

    expect(
      applyStrandsAvailableToolFilter(tools, ['read_file', 'mcp__github__*']),
    ).toEqual([tools[0], tools[2]]);
  });

  test('returns all tools for wildcard availability', () => {
    const tools = [{ name: 'read_file', execute: vi.fn() }] as any;

    expect(applyStrandsAvailableToolFilter(tools, ['*'])).toEqual(tools);
  });
});

describe('createStrandsFunctionTools', () => {
  test('binds only Strands real toolUseId into the private native-output scope', async () => {
    const authority = createNativeOutputGrantAuthority();
    const grant = authority.issue(
      {
        threadId: 'session-a',
        turnId: 'turn-a',
        adapterId: 'station-agent',
        principal: { ...humanPrincipal('test', 'owner-a', 'Owner A') },
        configurationLease: { revision: 1 },
      },
      { isCurrent: () => true },
    )!;
    const execute = vi.fn(() => currentNativeOutputCallScope());
    const [tool] = createStrandsFunctionTools(
      [{ name: 'native', parameters: {}, execute }] as any,
      new Map(),
    ) as any[];

    const scope = await runWithNativeOutputTurnContext(
      { grant, authority },
      () => tool.callback({}, { toolUse: { toolUseId: 'strands-real-id' } }),
    );
    expect(authority.admit(scope)).toMatchObject({ callId: 'strands-real-id' });
    expect(
      await runWithNativeOutputTurnContext({ grant, authority }, () =>
        tool.callback({}, { toolUse: {} }),
      ),
    ).toBeUndefined();
  });
  test('surfaces a denial as an ERROR tool result carrying the real gate reason (station#1834)', async () => {
    const execute = vi.fn();
    const reason =
      "Tool 'read_file' requires approval, but this run has no approval channel to ask.";
    const deniedToolCalls = new Map([
      ['tool-1', { allowed: false as const, reason }],
    ]);
    const [tool] = createStrandsFunctionTools(
      [
        { name: 'read_file', description: 'Read', parameters: {}, execute },
      ] as any,
      deniedToolCalls,
    ) as any[];

    // The SDK's FunctionTool is mocked in this file, so assert the loader's
    // contract at its own layer: a denied call THROWS the gate's reason
    // instead of returning the old fabricated success string. (The real
    // FunctionTool.stream() catches that throw and wraps it in a
    // status:'error' ToolResultBlock — pinned end-to-end against the real
    // SDK in strands-agent-hooks.test.ts.)
    await expect(
      tool.callback({}, { toolUse: { toolUseId: 'tool-1' } }),
    ).rejects.toThrow(reason);
    expect(execute).not.toHaveBeenCalled();
    expect(deniedToolCalls.has('tool-1')).toBe(false);
  });

  // archive#3091: the policy-denied badge derives from this marker riding
  // along on the thrown Error. Prove it survives the throw itself here
  // (loader layer); strands-agent-hooks.test.ts proves it survives the REAL
  // SDK's own error-wrapping on top of this.
  test('a policy-authored denial throws an Error carrying `policyDenied: true`', async () => {
    const execute = vi.fn();
    const reason =
      "Tool 'read_file' was blocked by the config-protection policy.";
    const deniedToolCalls = new Map([
      [
        'tool-1',
        { allowed: false as const, reason, policyDenied: true as const },
      ],
    ]);
    const [tool] = createStrandsFunctionTools(
      [
        { name: 'read_file', description: 'Read', parameters: {}, execute },
      ] as any,
      deniedToolCalls,
    ) as any[];

    await expect(
      tool.callback({}, { toolUse: { toolUseId: 'tool-1' } }),
    ).rejects.toMatchObject({ message: reason, policyDenied: true });
  });

  // Negative control (archive#3091): a denial with no `policyDenied` marker
  // (e.g. a human declining via the approval requester) must NOT throw an
  // error carrying the marker — collapsing the two would mislabel a user's
  // own choice as a policy block.
  test('a non-policy denial throws an Error with no `policyDenied` marker', async () => {
    const execute = vi.fn();
    const reason = 'the user declined the approval request.';
    const deniedToolCalls = new Map([
      ['tool-1', { allowed: false as const, reason }],
    ]);
    const [tool] = createStrandsFunctionTools(
      [
        { name: 'read_file', description: 'Read', parameters: {}, execute },
      ] as any,
      deniedToolCalls,
    ) as any[];

    await expect(
      tool.callback({}, { toolUse: { toolUseId: 'tool-1' } }),
    ).rejects.not.toMatchObject({ policyDenied: true });
  });

  test('passes tool context through to the underlying tool implementation', async () => {
    const execute = vi.fn().mockResolvedValue('ok');
    const [tool] = createStrandsFunctionTools(
      [
        { name: 'read_file', description: 'Read', parameters: {}, execute },
      ] as any,
      new Map(),
    ) as any[];
    const toolContext = { toolUse: { toolUseId: 'tool-2' }, extra: true };

    await tool.callback({}, toolContext);

    expect(execute).toHaveBeenCalledWith({}, toolContext);
  });
});

describe('destroyStrandsAgentTools', () => {
  test('disconnects tracked MCP clients and clears agent ownership', async () => {
    const client = { disconnect: vi.fn().mockResolvedValue(undefined) };
    const state = {
      mcpClients: new Map([['tool-1', client as any]]),
      agentMcpClients: new Map([['agent-a', ['tool-1']]]),
    };

    await destroyStrandsAgentTools('agent-a', state);

    expect(client.disconnect).toHaveBeenCalledTimes(1);
    expect(state.mcpClients.has('tool-1')).toBe(false);
    expect(state.agentMcpClients.has('agent-a')).toBe(false);
  });
});

describe('loadStrandsTools', () => {
  test('tenant-native publication is owner-qualified and old catalog facades cannot reconnect after reset', async () => {
    const firstOwner = new MCPLocalConnectionCustody();
    const secondOwner = new MCPLocalConnectionCustody();
    try {
      const [first] = await loadBuiltinStationControlTools(firstOwner);
      const [second] = await loadBuiltinStationControlTools(secondOwner);
      const context = {
        tenantId: 'same-tenant' as any,
        source: 'request' as const,
      };
      expect(
        await withTenantExecutionContext(context, () => first!.execute!({})),
      ).toBe(2);
      expect(
        await withTenantExecutionContext(context, () => second!.execute!({})),
      ).toBe(3);
      expect(strandsMcpClients).toHaveLength(4);
      expect((await firstOwner.reset()).state).toBe('settled');
      await expect(
        withTenantExecutionContext(context, () => first!.execute!({})),
      ).rejects.toMatchObject({ state: 'stale' });
      expect(
        await withTenantExecutionContext(context, () => second!.execute!({})),
      ).toBe(3);
      expect(strandsMcpClients).toHaveLength(4);
    } finally {
      await firstOwner.shutdown();
      await secondOwner.shutdown();
    }
  });
  test('settles a first listTools failure once and does not cache the failed child', async () => {
    const settlement = { settle: vi.fn() };
    const state = { mcpClients: new Map(), agentMcpClients: new Map() };
    strandsMcpTestState.rejectNextListTools = new Error('list tools failed');
    await expect(
      loadStrandsTools({
        slug: 'agent-a',
        spec: {
          tools: { mcpServers: ['demoServer'], available: ['*'] },
        } as any,
        opts: {
          mcpCustody: new MCPLocalConnectionCustody(),
          configLoader: {
            loadIntegration: vi.fn().mockResolvedValue({
              id: 'demoServer',
              kind: 'mcp',
              transport: 'stdio',
              command: 'demo',
              secretEnvRefs: { TOKEN: 'demo-token' },
            }),
          } as any,
          integrationSecretResolver: {
            resolveForIntegration: vi.fn().mockResolvedValue({
              environment: { TOKEN: 'secret-sentinel' },
              settlement,
            }),
          },
          mcpConnectionStatus: new Map(),
          integrationMetadata: new Map(),
          toolNameMapping: new Map(),
          toolNameReverseMapping: new Map(),
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        },
        state,
      }),
    ).resolves.toEqual([]);
    expect(state.mcpClients.has('demoServer')).toBe(false);
    expect(strandsMcpClients[0]!.disconnect).toHaveBeenCalledOnce();
    expect(settlement.settle).toHaveBeenCalledExactlyOnceWith({
      outcome: 'failure',
      reason: 'child_establishment_failed',
    });
  });

  test('bounds a resolved remote failure before FunctionTool, logs, or health can observe its text', async () => {
    const canary = 'remote-strands-client-function-tool-canary';
    const mcpConnectionStatus = new Map();
    const integrationMetadata = new Map();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const tools = await loadStrandsTools({
      slug: 'agent-a',
      spec: { tools: { mcpServers: ['demoServer'], available: ['*'] } } as any,
      opts: {
        mcpCustody: new MCPLocalConnectionCustody(),
        configLoader: {
          loadIntegration: vi.fn().mockResolvedValue({
            id: 'demoServer',
            kind: 'mcp',
            transport: 'stdio',
            command: 'demo',
            args: [],
          }),
        } as any,
        mcpConnectionStatus,
        integrationMetadata,
        toolNameMapping: new Map(),
        toolNameReverseMapping: new Map(),
        logger,
      },
      state: { mcpClients: new Map(), agentMcpClients: new Map() },
    });
    strandsMcpClients[0]!.callTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: 'text', text: canary }],
      structuredContent: { diagnostic: canary },
    });
    const [functionTool] = createStrandsFunctionTools(
      tools,
      new Map(),
    ) as any[];

    await expect(
      functionTool.callback({}, { toolUse: { toolUseId: 'remote-1' } }),
    ).rejects.toThrow('MCP tool call failed');
    expect(mcpConnectionStatus.get('demoServer')).toEqual({ connected: true });
    expect(integrationMetadata.get('demoServer')).toMatchObject({
      type: 'mcp',
      toolCount: 1,
    });
    expect(
      JSON.stringify([
        ...logger.debug.mock.calls,
        ...logger.info.mock.calls,
        ...logger.warn.mock.calls,
        ...logger.error.mock.calls,
        [...mcpConnectionStatus],
        [...integrationMetadata],
      ]),
    ).not.toContain(canary);
  });

  test('routes direct built-in calls through isolated tenant clients and single-flights each tenant', async () => {
    const [tool] = await loadBuiltinStationControlTools();
    const alpha = { tenantId: 'alpha' as any, source: 'request' as const };
    const bravo = { tenantId: 'bravo' as any, source: 'request' as const };

    await expect(
      Promise.all([
        withTenantExecutionContext(alpha, () => tool!.execute!({})),
        withTenantExecutionContext(alpha, () => tool!.execute!({})),
        withTenantExecutionContext(bravo, () => tool!.execute!({})),
      ]),
    ).resolves.toEqual([1, 1, 2]);
    expect(strandsMcpClients).toHaveLength(3); // catalog, alpha, bravo
    expect(strandsMcpClients[1]!.callTool).toHaveBeenCalledTimes(2);
    expect(strandsMcpClients[2]!.callTool).toHaveBeenCalledOnce();
  });

  test('rejects a hosted direct built-in call with no execution context', async () => {
    process.env.STATION_HOSTED_TENANT_REGISTRY_FILE = '/hosted-tenants.json';
    const [tool] = await loadBuiltinStationControlTools();

    await expect(tool!.execute!({})).rejects.toThrow(
      'Tenant execution context is required for station-control',
    );
    expect(strandsMcpClients).toHaveLength(1); // context-free catalog only
  });

  test('retains a failed native cleanup for retry and disposes an in-flight client', async () => {
    const [tool] = await loadBuiltinStationControlTools();
    const alpha = { tenantId: 'alpha' as any, source: 'request' as const };
    await withTenantExecutionContext(alpha, () => tool!.execute!({}));
    const activeClient = strandsMcpClients[1]!;
    activeClient.disconnect.mockRejectedValueOnce(new Error('temporary close'));

    await expect(releaseAllNativeStationControlClients()).rejects.toThrow(
      'Native station-control cleanup failed',
    );
    await expect(
      releaseAllNativeStationControlClients(),
    ).resolves.toBeUndefined();
    expect(activeClient.disconnect).toHaveBeenCalledTimes(2);

    const [raceTool] = await loadBuiltinStationControlTools();
    strandsMcpTestState.deferNextClient = true;
    const pending = withTenantExecutionContext(alpha, () =>
      raceTool!.execute!({}),
    );
    await vi.waitFor(() =>
      expect(strandsMcpTestState.resolveDeferredClient).toBeTypeOf('function'),
    );
    const cleanup = releaseAllNativeStationControlClients();
    strandsMcpTestState.resolveDeferredClient!();
    await expect(cleanup).resolves.toBeUndefined();
    await expect(pending).rejects.toThrow(
      'released while creation was pending',
    );
    const staleClient = strandsMcpClients[3]!;
    // A close while connect is outstanding is followed by a final close after
    // actual late settlement; the second call does not overlap the first.
    expect(staleClient.disconnect).toHaveBeenCalledTimes(2);

    await expect(
      withTenantExecutionContext(alpha, () => raceTool!.execute!({})),
    ).resolves.toBe(4);

    await releaseAllNativeStationControlClients();
    const [failedRaceTool] = await loadBuiltinStationControlTools();
    strandsMcpTestState.resolveDeferredClient = undefined;
    strandsMcpTestState.deferNextClient = true;
    const failedPending = withTenantExecutionContext(alpha, () =>
      failedRaceTool!.execute!({}),
    );
    await vi.waitFor(() =>
      expect(strandsMcpTestState.resolveDeferredClient).toBeTypeOf('function'),
    );
    const failedStaleClient = strandsMcpClients[6]!;
    failedStaleClient.disconnect.mockRejectedValueOnce(
      new Error('stale disconnect'),
    );
    const failedPendingExpectation = expect(failedPending).rejects.toThrow(
      'released while creation was pending',
    );
    const failedCleanup = releaseAllNativeStationControlClients();
    strandsMcpTestState.resolveDeferredClient!();
    await expect(failedCleanup).rejects.toThrow(
      'Native station-control cleanup failed.',
    );
    await failedPendingExpectation;
    expect(failedStaleClient.disconnect).toHaveBeenCalledOnce();
    await expect(
      releaseAllNativeStationControlClients(),
    ).resolves.toBeUndefined();
    expect(failedStaleClient.disconnect).toHaveBeenCalledTimes(2);
  });

  test('preserves MCP UI metadata from Strands toolSpec records', async () => {
    const mcpConnectionStatus = new Map();
    const integrationMetadata = new Map();
    const toolNameMapping = new Map();
    const tools = await loadStrandsTools({
      slug: 'agent-a',
      spec: { tools: { mcpServers: ['demoServer'], available: ['*'] } } as any,
      opts: {
        mcpCustody: new MCPLocalConnectionCustody(),
        configLoader: {
          loadIntegration: vi.fn().mockResolvedValue({
            id: 'demoServer',
            kind: 'mcp',
            transport: 'stdio',
            command: 'demo',
            args: [],
          }),
        } as any,
        mcpConnectionStatus,
        integrationMetadata,
        toolNameMapping,
        toolNameReverseMapping: new Map(),
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
      state: { mcpClients: new Map(), agentMcpClients: new Map() },
    });

    expect(tools[0]).toMatchObject({
      name: 'demoServer_render',
      description: 'Render UI',
      parameters: { type: 'object' },
      _meta: { ui: { resourceUri: 'ui://demoServer/render.html' } },
      ui: { resourceUri: 'ui://demoServer/render.html' },
      resource: { uri: 'ui://demoServer/render.html' },
    });
    expect(mcpConnectionStatus.get('demoServer')).toEqual({ connected: true });
    expect(integrationMetadata.get('demoServer')).toMatchObject({
      type: 'mcp',
      toolCount: 1,
    });
  });
});
