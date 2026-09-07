import { MCPLocalConnectionCustody } from '@kontourai/station-shared/mcp';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpClient } from '@strands-agents/sdk';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createCustodiedStrandsClient } from '../strands-mcp-custody.js';
import { loadStrandsTools } from '../strands-tool-loader.js';

const injection = vi.hoisted(() => ({ constructorFailure: false }));
vi.mock('@strands-agents/sdk', async (original) => {
  const actual = await original<typeof import('@strands-agents/sdk')>();
  return {
    ...actual,
    McpClient: class extends actual.McpClient {
      constructor(options: ConstructorParameters<typeof actual.McpClient>[0]) {
        if (injection.constructorFailure)
          throw new Error('constructor failure');
        super(options);
      }
    },
  };
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let custody: MCPLocalConnectionCustody;
beforeEach(() => {
  custody = new MCPLocalConnectionCustody({ waitMs: 5 });
  vi.spyOn(McpClient.prototype, 'listTools').mockResolvedValue([]);
  vi.spyOn(McpClient.prototype, 'disconnect').mockResolvedValue(undefined);
  vi.spyOn(StdioClientTransport.prototype, 'close').mockResolvedValue(
    undefined,
  );
});
afterEach(async () => {
  injection.constructorFailure = false;
  expect((await custody.shutdown()).state).toBe('settled');
  vi.restoreAllMocks();
});
function fixture() {
  const state = {
    mcpClients: new Map<string, McpClient>(),
    agentMcpClients: new Map<string, string[]>(),
  };
  const def = {
    id: 'fixture',
    kind: 'mcp',
    transport: 'stdio',
    command: process.execPath,
  };
  const opts = {
    mcpCustody: custody,
    configLoader: { loadIntegration: vi.fn(async () => def) } as never,
    mcpConnectionStatus: new Map(),
    integrationMetadata: new Map(),
    toolNameMapping: new Map(),
    toolNameReverseMapping: new Map(),
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  };
  const run = () =>
    loadStrandsTools({
      slug: 'fixture-agent',
      spec: { tools: { mcpServers: ['fixture'], available: ['*'] } } as never,
      opts,
      state,
    });
  return { run, state, opts };
}
test('actual Strands loader owns pending discovery and refuses late publication after reset', async () => {
  const entered = deferred<void>();
  const blocked = deferred<[]>();
  vi.mocked(McpClient.prototype.listTools).mockImplementation(() => {
    entered.resolve();
    return blocked.promise;
  });
  const { run, state } = fixture();
  const loading = run();
  await entered.promise;
  expect(custody.inspect().retained).toBe(1);
  expect((await custody.reset()).state).toBe('pending');
  expect((await custody.reset()).state).toBe('pending');
  expect(McpClient.prototype.disconnect).toHaveBeenCalledTimes(1);
  blocked.resolve([]);
  expect(await loading).toEqual([]);
  expect(state.mcpClients.size).toBe(0);
  expect((await custody.reset()).state).toBe('settled');
  expect(McpClient.prototype.disconnect).toHaveBeenCalledTimes(2);
});
test('actual loader retains rejected discovery cleanup and retries only settled disconnect', async () => {
  vi.mocked(McpClient.prototype.listTools).mockRejectedValue(
    new Error('discovery failure'),
  );
  vi.mocked(McpClient.prototype.disconnect).mockRejectedValueOnce(
    new Error('disconnect failure'),
  );
  const { run, state } = fixture();
  expect(await run()).toEqual([]);
  expect(state.mcpClients.size).toBe(0);
  expect(custody.inspect()).toMatchObject({
    retained: 1,
    phases: { 'close-failed': 1 },
  });
  expect(() => custody.acquire('fixture', 'managed')).toThrow();
  expect((await custody.reset()).state).toBe('settled');
  expect(McpClient.prototype.disconnect).toHaveBeenCalledTimes(2);
});
test('actual constructor partial failure leaves its already-created transport owned and closed', async () => {
  injection.constructorFailure = true;
  const claim = custody.acquire('fixture', 'managed');
  expect(() =>
    createCustodiedStrandsClient(claim, { command: process.execPath }),
  ).toThrow('constructor failure');
  expect((await custody.release(claim)).state).toBe('settled');
  expect(StdioClientTransport.prototype.close).toHaveBeenCalledTimes(1);
  expect(McpClient.prototype.disconnect).not.toHaveBeenCalled();
});
test('a pending disconnect is joined and a previously returned Strands facade rejects new calls', async () => {
  const blocked = deferred<void>();
  vi.mocked(McpClient.prototype.disconnect).mockReturnValueOnce(
    blocked.promise,
  );
  const client = createCustodiedStrandsClient(
    custody.acquire('fixture', 'managed'),
    { command: process.execPath },
  );
  await client.listTools();
  expect((await custody.reset()).state).toBe('pending');
  expect((await custody.reset()).state).toBe('pending');
  expect(() => client.listTools()).toThrow();
  expect(McpClient.prototype.disconnect).toHaveBeenCalledTimes(1);
  blocked.resolve();
  expect((await custody.reset()).state).toBe('settled');
});
test('a reset during the loader configuration read prevents SDK construction/admission', async () => {
  const blocked = deferred<any>();
  const { run, opts } = fixture();
  vi.mocked((opts.configLoader as any).loadIntegration).mockReturnValue(
    blocked.promise,
  );
  const loading = run();
  expect((await custody.reset()).state).toBe('settled');
  blocked.resolve({
    id: 'fixture',
    kind: 'mcp',
    transport: 'stdio',
    command: process.execPath,
  });
  expect(await loading).toEqual([]);
  expect(McpClient.prototype.listTools).not.toHaveBeenCalled();
});
