import assert from 'node:assert';
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
import { createBuiltinVendedToolDef } from '../../tools/vended-tool-compat.js';
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

  /**
   * #1485. The loader's per-tool catch is the only failure seam for phases
   * that never connect to anything. These cover the classification in both
   * directions: which throws escape redaction, what of them is surfaced, and
   * every arm that must stay redacted.
   */
  const LOGGER_METHODS = [
    'trace',
    'debug',
    'info',
    'warn',
    'error',
    'fatal',
  ] as const;

  /** All six methods of the Station logger contract (src-server/utils/logger.ts). */
  function loggerSpy(): Record<
    (typeof LOGGER_METHODS)[number],
    ReturnType<typeof vi.fn>
  > {
    return Object.fromEntries(
      LOGGER_METHODS.map((method) => [method, vi.fn()]),
    ) as Record<(typeof LOGGER_METHODS)[number], ReturnType<typeof vi.fn>>;
  }

  /**
   * `JSON.stringify(new Error('CANARY'))` is `{}` for a plain Error — no
   * enumerable own properties — so a bare stringify of the logger's calls
   * cannot see text that rode in on an Error object. Expand every Error to its
   * name, message and stack AND its own enumerable properties, because that is
   * where the interesting text actually lives: a `node:assert` AssertionError
   * carries the compared values on `actual`/`expected`, and Node's argument
   * validation carries `code`. `cause` and an AggregateError's `errors` are
   * returned as-is so the replacer recurses into them.
   */
  function loggedText(
    logger: Record<(typeof LOGGER_METHODS)[number], ReturnType<typeof vi.fn>>,
    ...extra: unknown[]
  ): string {
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
          ...Object.fromEntries(Object.entries(value)),
        };
      },
    );
  }

  function custodyBrokenFor(
    brokenId: string,
    thrown: () => never,
    real = new MCPLocalConnectionCustody(),
  ) {
    return {
      acquire: (id: string, purpose: 'managed') =>
        id === brokenId ? thrown() : real.acquire(id, purpose),
      release: (claim: unknown) => real.release(claim as never),
      releaseClaims: (claims: unknown[]) => real.releaseClaims(claims as never),
      // A cast: production supplies a real custody owner, and the point of this
      // fixture is a loader option broken in a way the type system would
      // otherwise refuse to express (#1482's actual shape — the loader
      // dereferences `opts.mcpCustody.acquire` with no guard).
    } as unknown as MCPLocalConnectionCustody;
  }

  test('reports a TypeError from custody acquisition with its own class and keeps loading the rest (#1485)', async () => {
    // This one throws from `mcpCustody.acquire`, so it never reaches the
    // built-in branch — it is #1482's own shape, a broken loader OPTION. The
    // built-in branch itself is exercised by the next test.
    const mcpConnectionStatus = new Map();
    const logger = loggerSpy();
    const notebook = createBuiltinVendedToolDef('notebook');
    const brokenOption = { acquire: undefined } as unknown as {
      acquire: (id: string, purpose: string) => never;
    };

    const tools = await loadStrandsTools({
      slug: 'agent-a',
      spec: {
        tools: { mcpServers: ['broken-option', 'notebook'], available: ['*'] },
      } as any,
      opts: {
        mcpCustody: custodyBrokenFor('broken-option', () =>
          brokenOption.acquire('broken-option', 'managed'),
        ),
        configLoader: {
          loadIntegration: vi.fn().mockResolvedValue(notebook),
        } as any,
        mcpConnectionStatus,
        integrationMetadata: new Map(),
        toolNameMapping: new Map(),
        toolNameReverseMapping: new Map(),
        logger,
      },
      state: { mcpClients: new Map(), agentMcpClients: new Map() },
    });

    const status = mcpConnectionStatus.get('broken-option');
    expect(status.connected).toBe(false);
    expect(status.error).toMatch(/^TypeError: /);
    expect(status.error).not.toContain('Tool server connection failed');
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to load agent tool before any connection',
      expect.objectContaining({
        toolId: 'broken-option',
        failure: 'loader',
        errorClass: 'TypeError',
        messageWithheld: false,
        error: expect.any(TypeError),
      }),
    );
    // The throw must not escape the per-tool loop: the sibling built-in tool
    // still loads.
    expect(tools.map((tool) => tool.name)).toEqual(['notebook']);
    expect(mcpConnectionStatus.get('notebook')).toEqual({ connected: true });
  });

  test('reports a TypeError raised INSIDE the built-in vended-tool branch with its own class (#1485)', async () => {
    // The built-in branch runs to completion — `createBuiltinVendedTool`
    // returns a real tool and `mcpConnectionStatus.set(id, {connected:true})`
    // has already run — and then a broken `integrationMetadata` option throws.
    // Nothing here has connected to anything, so this is the assignment site of
    // `phase = 'connect'` under test: moving that flip any earlier (e.g. to
    // just after `mcpCustody.acquire`) redacts this throw and reddens here.
    const mcpConnectionStatus = new Map();
    const logger = loggerSpy();
    const brokenMetadata = { set: undefined } as unknown as Map<string, never>;

    await expect(
      loadStrandsTools({
        slug: 'agent-a',
        spec: {
          tools: { mcpServers: ['notebook'], available: ['*'] },
        } as any,
        opts: {
          mcpCustody: new MCPLocalConnectionCustody(),
          configLoader: {
            loadIntegration: vi
              .fn()
              .mockResolvedValue(createBuiltinVendedToolDef('notebook')),
          } as any,
          mcpConnectionStatus,
          integrationMetadata: brokenMetadata,
          toolNameMapping: new Map(),
          toolNameReverseMapping: new Map(),
          logger,
        },
        state: { mcpClients: new Map(), agentMcpClients: new Map() },
      }),
      // Incidental, not the pinned property: the tool happened to be pushed
      // before the throw and the loop does not unwind it. What this test pins
      // is the status below.
    ).resolves.toHaveLength(1);

    const status = mcpConnectionStatus.get('notebook');
    expect(status.connected).toBe(false);
    expect(status.error).toMatch(/^TypeError: /);
    expect(status.error).not.toContain('Tool server connection failed');
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to load agent tool before any connection',
      expect.objectContaining({
        toolId: 'notebook',
        failure: 'loader',
        errorClass: 'TypeError',
      }),
    );
  });

  test('names a SyntaxError class but never its message, which quotes secret-bearing config (#1485)', async () => {
    // `configLoader.loadIntegration` runs preconnect and reaches unguarded
    // JSON.parse calls on integration.json and the tool-server credential
    // store. V8 composes a SyntaxError message from a WINDOW OF THE PARSED
    // SOURCE, so surfacing it would publish file bytes through
    // GET /agents/:slug/health and the log store.
    //
    // The window is only ~12 characters wide, which is why this fixture uses a
    // short stored value and a leading pad standing in for the rest of a real
    // integration.json: a long secret leaks a tail fragment instead of the
    // whole thing, which is the same defect and merely harder to assert on.
    const secret = 'sekr';
    const mcpConnectionStatus = new Map();
    const logger = loggerSpy();
    let thrown: SyntaxError | undefined;
    try {
      JSON.parse(`{"pad":"${'a'.repeat(30)}","TOKEN":"${secret}","b":x}`);
    } catch (error) {
      thrown = error as SyntaxError;
    }
    // Not hypothetical: the real V8 message quotes the stored value verbatim.
    expect(thrown).toBeInstanceOf(SyntaxError);
    expect(thrown?.message).toContain(`"${secret}"`);
    const leakedMessage = thrown?.message as string;

    await expect(
      loadStrandsTools({
        slug: 'agent-a',
        spec: {
          tools: { mcpServers: ['demoServer'], available: ['*'] },
        } as any,
        opts: {
          mcpCustody: new MCPLocalConnectionCustody(),
          configLoader: {
            loadIntegration: vi.fn().mockRejectedValue(thrown),
          } as any,
          mcpConnectionStatus,
          integrationMetadata: new Map(),
          toolNameMapping: new Map(),
          toolNameReverseMapping: new Map(),
          logger,
        },
        state: { mcpClients: new Map(), agentMcpClients: new Map() },
      }),
    ).resolves.toEqual([]);

    // A Station-composed reason plus the class — not a connection outcome,
    // not the runtime's message.
    expect(mcpConnectionStatus.get('demoServer')).toEqual({
      connected: false,
      error:
        'Tool load failed before any connection; detail withheld (SyntaxError)',
    });
    const [, context] = logger.error.mock.calls.at(-1) as [
      string,
      Record<string, unknown>,
    ];
    expect(context).toMatchObject({
      errorClass: 'SyntaxError',
      messageWithheld: true,
    });
    // The Error object never reaches the log record...
    expect(context).not.toHaveProperty('error');
    // ...but the call frames do, so an operator can find the corrupt file.
    expect(context.stackFrames).toEqual(
      expect.arrayContaining([expect.stringMatching(/^at\s/)]),
    );
    const observable = loggedText(logger, [...mcpConnectionStatus]);
    expect(observable).not.toContain(leakedMessage);
    expect(observable).not.toContain(`"${secret}"`);
  });

  test('withholds a Node ERR_INVALID_ARG_TYPE message, which util.inspects the rejected value (#1485)', async () => {
    // Node's own argument validation throws a plain TypeError — a class the
    // program-text arm would surface — whose message embeds util.inspect of the
    // value it rejected. Nothing preconnect calls Buffer/crypto/new URL today,
    // which is exactly why the withhold set is matched by CODE as well as name:
    // the set is complete only for the current call graph.
    const canary = 'ghp_rejected_value_canary';
    const mcpConnectionStatus = new Map();
    const logger = loggerSpy();
    const nodeArgError = Object.assign(
      new TypeError(
        `The "value" argument must be of type string. Received '${canary}'`,
      ),
      { code: 'ERR_INVALID_ARG_TYPE' },
    );

    await expect(
      loadStrandsTools({
        slug: 'agent-a',
        spec: {
          tools: { mcpServers: ['demoServer'], available: ['*'] },
        } as any,
        opts: {
          mcpCustody: new MCPLocalConnectionCustody(),
          configLoader: {
            loadIntegration: vi.fn().mockRejectedValue(nodeArgError),
          } as any,
          mcpConnectionStatus,
          integrationMetadata: new Map(),
          toolNameMapping: new Map(),
          toolNameReverseMapping: new Map(),
          logger,
        },
        state: { mcpClients: new Map(), agentMcpClients: new Map() },
      }),
    ).resolves.toEqual([]);

    expect(mcpConnectionStatus.get('demoServer')).toEqual({
      connected: false,
      error:
        'Tool load failed before any connection; detail withheld (TypeError)',
    });
    const [, context] = logger.error.mock.calls.at(-1) as [
      string,
      Record<string, unknown>,
    ];
    expect(context).toMatchObject({ messageWithheld: true });
    expect(context).not.toHaveProperty('error');
    expect(loggedText(logger, [...mcpConnectionStatus])).not.toContain(canary);
  });

  test('flattens and bounds a hostile class label in both the status and the log (#1485)', async () => {
    // `name` is a writable own property on any Error, so the class label is not
    // automatically a safe identifier just because it is "the class".
    const mcpConnectionStatus = new Map();
    const logger = loggerSpy();
    const hostile = new RangeError('boom');
    hostile.name = `Range\nError${'Z'.repeat(200)}`;

    await expect(
      loadStrandsTools({
        slug: 'agent-a',
        spec: {
          tools: { mcpServers: ['demoServer'], available: ['*'] },
        } as any,
        opts: {
          mcpCustody: new MCPLocalConnectionCustody(),
          configLoader: {
            loadIntegration: vi.fn().mockRejectedValue(hostile),
          } as any,
          mcpConnectionStatus,
          integrationMetadata: new Map(),
          toolNameMapping: new Map(),
          toolNameReverseMapping: new Map(),
          logger,
        },
        state: { mcpClients: new Map(), agentMcpClients: new Map() },
      }),
    ).resolves.toEqual([]);

    // A renamed Error no longer matches the escape set, so it is redacted —
    // but if it ever does escape, the label must already be safe. Assert the
    // label treatment where it is reachable: the log field.
    const surfaced = mcpConnectionStatus.get('demoServer').error as string;
    expect(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(surfaced)).toBe(false);
    expect(surfaced.length).toBeLessThanOrEqual(300);

    // And directly, on a class that DOES escape: a hostile name on a code-
    // matched Node error still reaches the withheld branch.
    const coded = Object.assign(new Error('boom'), {
      name: `Type Error${'Z'.repeat(200)}`,
      code: 'ERR_OUT_OF_RANGE',
    });
    const codedStatus = new Map();
    const codedLogger = loggerSpy();
    await expect(
      loadStrandsTools({
        slug: 'agent-a',
        spec: {
          tools: { mcpServers: ['demoServer'], available: ['*'] },
        } as any,
        opts: {
          mcpCustody: new MCPLocalConnectionCustody(),
          configLoader: {
            loadIntegration: vi.fn().mockRejectedValue(coded),
          } as any,
          mcpConnectionStatus: codedStatus,
          integrationMetadata: new Map(),
          toolNameMapping: new Map(),
          toolNameReverseMapping: new Map(),
          logger: codedLogger,
        },
        state: { mcpClients: new Map(), agentMcpClients: new Map() },
      }),
    ).resolves.toEqual([]);

    const codedDetail = codedStatus.get('demoServer').error as string;
    expect(codedDetail).toContain('detail withheld (');
    expect(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(codedDetail)).toBe(false);
    const [, codedContext] = codedLogger.error.mock.calls.at(-1) as [
      string,
      Record<string, unknown>,
    ];
    const errorClass = codedContext.errorClass as string;
    expect(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(errorClass)).toBe(false);
    expect(errorClass).toHaveLength(60);
    expect(errorClass.endsWith('… (truncated)')).toBe(true);
  });

  test('names an AssertionError class but never its message or compared values (#1485)', async () => {
    const canary = 'assertion-compared-value-canary';
    const mcpConnectionStatus = new Map();
    const logger = loggerSpy();
    // A REAL node:assert AssertionError, not a hand-shaped stand-in: it carries
    // the compared values on own enumerable `actual`/`expected`, so a plain
    // JSON.stringify of it is NOT `{}` and the canary is reachable by any log
    // sink that serializes the object.
    let assertion: Error | undefined;
    try {
      assert.strictEqual(canary, 'expected-other-value');
    } catch (error) {
      assertion = error as Error;
    }
    expect(assertion?.name).toBe('AssertionError');
    expect((assertion as unknown as { actual: string }).actual).toBe(canary);
    expect(assertion?.message).toContain(canary);
    expect(JSON.stringify(assertion)).toContain(canary);

    await expect(
      loadStrandsTools({
        slug: 'agent-a',
        spec: {
          tools: { mcpServers: ['demoServer'], available: ['*'] },
        } as any,
        opts: {
          mcpCustody: new MCPLocalConnectionCustody(),
          configLoader: {
            loadIntegration: vi.fn().mockRejectedValue(assertion),
          } as any,
          mcpConnectionStatus,
          integrationMetadata: new Map(),
          toolNameMapping: new Map(),
          toolNameReverseMapping: new Map(),
          logger,
        },
        state: { mcpClients: new Map(), agentMcpClients: new Map() },
      }),
    ).resolves.toEqual([]);

    expect(mcpConnectionStatus.get('demoServer')).toEqual({
      connected: false,
      error:
        'Tool load failed before any connection; detail withheld (AssertionError)',
    });
    const [, context] = logger.error.mock.calls.at(-1) as [
      string,
      Record<string, unknown>,
    ];
    expect(context).toMatchObject({
      errorClass: 'AssertionError',
      messageWithheld: true,
    });
    expect(context).not.toHaveProperty('error');
    // An AssertionError message is multi-line, which is why the frame filter
    // cannot be `stack.split('\n').slice(1)`.
    expect(assertion?.message.includes('\n')).toBe(true);
    expect(context.stackFrames).toEqual(
      expect.arrayContaining([expect.stringMatching(/^at\s/)]),
    );
    expect(loggedText(logger, [...mcpConnectionStatus])).not.toContain(canary);
  });

  test('reports that a non-Error was thrown without surfacing the value (#1485)', async () => {
    const canary = 'builtin-loader-thrown-value-canary';
    const mcpConnectionStatus = new Map();
    const logger = loggerSpy();

    await expect(
      loadStrandsTools({
        slug: 'agent-a',
        spec: {
          tools: { mcpServers: ['broken-option'], available: ['*'] },
        } as any,
        opts: {
          // A non-Error throw is the case under test, not an accident. The
          // thrown value IS data, so it is named by type and withheld.
          mcpCustody: custodyBrokenFor('broken-option', () => {
            throw canary as unknown as Error;
          }),
          configLoader: {
            loadIntegration: vi
              .fn()
              .mockResolvedValue(createBuiltinVendedToolDef('notebook')),
          } as any,
          mcpConnectionStatus,
          integrationMetadata: new Map(),
          toolNameMapping: new Map(),
          toolNameReverseMapping: new Map(),
          logger,
        },
        state: { mcpClients: new Map(), agentMcpClients: new Map() },
      }),
    ).resolves.toEqual([]);

    expect(mcpConnectionStatus.get('broken-option')).toEqual({
      connected: false,
      error:
        'Tool load failed before any connection; detail withheld (Non-Error thrown (string))',
    });
    const [, context] = logger.error.mock.calls.at(-1) as [
      string,
      Record<string, unknown>,
    ];
    expect(context).toMatchObject({
      failure: 'loader',
      errorClass: 'non-error:string',
      messageWithheld: true,
    });
    expect(context).not.toHaveProperty('error');
    expect(loggedText(logger, [...mcpConnectionStatus])).not.toContain(canary);
  });

  test('flattens control characters and bounds a surfaced message to exactly the limit (#1485)', async () => {
    const mcpConnectionStatus = new Map();
    // Multi-line, like a real assertion or validation message.
    const long = `head\nline\ttwo${'x'.repeat(500)}`;

    await expect(
      loadStrandsTools({
        slug: 'agent-a',
        spec: {
          tools: { mcpServers: ['broken-option'], available: ['*'] },
        } as any,
        opts: {
          mcpCustody: custodyBrokenFor('broken-option', () => {
            throw new RangeError(long);
          }),
          configLoader: {
            loadIntegration: vi
              .fn()
              .mockResolvedValue(createBuiltinVendedToolDef('notebook')),
          } as any,
          mcpConnectionStatus,
          integrationMetadata: new Map(),
          toolNameMapping: new Map(),
          toolNameReverseMapping: new Map(),
          logger: loggerSpy(),
        },
        state: { mcpClients: new Map(), agentMcpClients: new Map() },
      }),
    ).resolves.toEqual([]);

    const surfaced = mcpConnectionStatus.get('broken-option').error as string;
    expect(surfaced.startsWith('RangeError: head line two')).toBe(true);
    expect(surfaced.endsWith('… (truncated)')).toBe(true);
    // The limit is the TOTAL length, truncation marker included.
    expect(surfaced).toHaveLength(300);
    expect(/[\p{Cc}\p{Cf}]/u.test(surfaced)).toBe(false);
  });

  test('keeps an ordinary preconnect Error redacted rather than widening the escape (#1485)', async () => {
    const canary = 'integration-config-loader-canary';
    const mcpConnectionStatus = new Map();
    const logger = loggerSpy();

    await expect(
      loadStrandsTools({
        slug: 'agent-a',
        spec: {
          tools: { mcpServers: ['demoServer'], available: ['*'] },
        } as any,
        opts: {
          mcpCustody: new MCPLocalConnectionCustody(),
          configLoader: {
            // Preconnect, but a plain Error is not a class the runtime raises
            // for a defect in the program, so it keeps today's bounded message.
            loadIntegration: vi
              .fn()
              .mockRejectedValue(new Error(`load failed ${canary}`)),
          } as any,
          mcpConnectionStatus,
          integrationMetadata: new Map(),
          toolNameMapping: new Map(),
          toolNameReverseMapping: new Map(),
          logger,
        },
        state: { mcpClients: new Map(), agentMcpClients: new Map() },
      }),
    ).resolves.toEqual([]);

    expect(mcpConnectionStatus.get('demoServer')).toEqual({
      connected: false,
      error: 'Tool server connection failed',
    });
    expect(loggedText(logger, [...mcpConnectionStatus])).not.toContain(canary);
  });

  test('keeps a genuine connect-path failure redacted, whatever its class (#1485)', async () => {
    const canary = 'remote-listtools-provider-canary';
    const mcpConnectionStatus = new Map();
    const logger = loggerSpy();
    // A provider-derived TypeError raised by the connect/listTools path: the
    // class is one the preconnect rule would surface, so this is the case that
    // proves phase — not class alone — gates the redaction #1428 installed.
    strandsMcpTestState.rejectNextListTools = new TypeError(
      `upstream rejected ${canary}`,
    );

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
              args: [],
            }),
          } as any,
          mcpConnectionStatus,
          integrationMetadata: new Map(),
          toolNameMapping: new Map(),
          toolNameReverseMapping: new Map(),
          logger,
        },
        state: { mcpClients: new Map(), agentMcpClients: new Map() },
      }),
    ).resolves.toEqual([]);

    expect(mcpConnectionStatus.get('demoServer')).toEqual({
      connected: false,
      error: 'Tool server connection failed',
    });
    expect(loggedText(logger, [...mcpConnectionStatus])).not.toContain(canary);
  });
});
