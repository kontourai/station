import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type MCPConnection,
  MCPLocalConnectionCustody,
} from '@kontourai/station-shared/mcp';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { shutdownRuntimeServices } from '../../../runtime/bootstrap/runtime-shutdown.js';
import { loadAgentTools } from '../../../runtime/mcp/mcp-manager.js';
import { createMCPToolProvenanceGeneration } from '../../orchestration/mcp-tool-provenance.js';
import { SecretBindingIntegrationService } from '../../secrets/secret-binding-administration.js';
import { MCPService } from '../mcp-service.js';
import { StationToolServerOAuthProvider } from '../tool-server-oauth.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
let home: string;
let loader: ConfigLoader;
let custody: MCPLocalConnectionCustody;
let service: MCPService;
let connections: Map<string, MCPConnection>;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'station-mcp-local-custody-'));
  loader = new ConfigLoader({ projectHomeDir: home });
  custody = new MCPLocalConnectionCustody({ waitMs: 5 });
  connections = new Map();
  service = new MCPService(
    loader,
    connections,
    new Map(),
    new Map(),
    new Map(),
    new Map(),
    logger,
    undefined,
    43141,
    undefined,
    undefined,
    custody,
  );
  await loader.saveIntegration('fixture', {
    id: 'fixture',
    kind: 'mcp',
    transport: 'stdio',
    command: process.execPath,
  });
  vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({
    tools: [{ name: 'read', inputSchema: { type: 'object' } }],
  });
  vi.spyOn(Client.prototype, 'callTool').mockResolvedValue({
    content: [{ type: 'text', text: 'fixture' }],
  });
  vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined);
  vi.spyOn(StdioClientTransport.prototype, 'close').mockResolvedValue(
    undefined,
  );
  vi.spyOn(StreamableHTTPClientTransport.prototype, 'close').mockResolvedValue(
    undefined,
  );
});
afterEach(async () => {
  try {
    expect((await custody.shutdown()).state).toBe('settled');
  } finally {
    vi.restoreAllMocks();
    await loader.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
test('real probe/reset refuses late discovery publication and keeps cleanup visibly pending', async () => {
  const entered = deferred<void>(),
    blocked = deferred<any>();
  vi.mocked(Client.prototype.listTools).mockImplementation(() => {
    entered.resolve();
    return blocked.promise;
  });
  const probe = service.probeIntegration('fixture');
  const refusal = expect(probe).rejects.toMatchObject({ state: 'stale' });
  await entered.promise;
  expect(service.inspectLocalConnections().retained).toBe(1);
  expect(await service.resetRuntimeState()).toMatchObject({
    rebuilt: false,
    localCleanup: { state: 'pending', retained: 1 },
  });
  blocked.resolve({ tools: [] });
  await refusal;
  expect((await loader.loadIntegration('fixture')).probe).toBeUndefined();
  expect((await service.resetRuntimeState()).localCleanup.state).toBe(
    'settled',
  );
});
test('config replacement refuses before durable write until old discovery actually settles', async () => {
  const entered = deferred<void>(),
    blocked = deferred<any>();
  vi.mocked(Client.prototype.listTools).mockImplementation(() => {
    entered.resolve();
    return blocked.promise;
  });
  const probe = service.probeIntegration('fixture');
  const refusal = expect(probe).rejects.toMatchObject({ state: 'stale' });
  await entered.promise;
  const original = await loader.loadIntegration('fixture');
  const replacement = { ...original, args: ['replacement-fixture'] };
  await expect(service.saveIntegration(replacement)).rejects.toMatchObject({
    state: 'pending',
  });
  expect((await loader.loadIntegration('fixture')).args).toBeUndefined();
  blocked.resolve({ tools: [] });
  await refusal;
  await service.saveIntegration(replacement);
  expect((await loader.loadIntegration('fixture')).args).toEqual([
    'replacement-fixture',
  ]);
});

test('binding config writes cross the injected local custody fence, preserving unrelated clients and partial grant truth', async () => {
  const original = await loader.loadIntegration('fixture');
  await loader.saveIntegration('fixture', { ...original, env: { TOKEN: '' } });
  const claim = custody.acquire('fixture', 'managed');
  const bound = await claim.connect({ ...original, env: { TOKEN: '' } });
  const other = await custody
    .acquire('unrelated', 'managed')
    .connect({ ...original, id: 'unrelated' });
  const blocked = deferred<void>();
  vi.mocked(Client.prototype.close).mockReturnValueOnce(blocked.promise);
  let binding: any = {
    id: 'fixture-binding',
    name: 'Fixture binding',
    revision: 1,
    grants: [],
    authRef: { env: 'FIXTURE_TOKEN' },
    availability: { backend: 'env', available: true },
    createdAt: '2026-09-04T00:00:00Z',
    updatedAt: '2026-09-04T00:00:00Z',
  };
  const bindings = {
    get: vi.fn(async () => binding),
    grant: vi.fn(async ({ grant }: any) => {
      binding = { ...binding, revision: 2, grants: [grant] };
      return binding;
    }),
    ungrant: vi.fn(async () => {
      binding = { ...binding, revision: 3, grants: [] };
      return binding;
    }),
  };
  const write = vi.spyOn(loader, 'updateIntegration');
  const administration = new SecretBindingIntegrationService(
    bindings as never,
    loader,
    logger,
    (id, operation) => custody.mutate(id, operation),
  );
  const input = {
    id: 'fixture-binding' as any,
    integrationId: 'fixture',
    envName: 'TOKEN',
    expectedRevision: 1,
  };
  try {
    expect(await administration.bind(input)).toMatchObject({
      outcome: 'safe-partial',
    });
    expect(bindings.grant).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    expect(
      (await loader.loadIntegration('fixture')).secretEnvRefs,
    ).toBeUndefined();
    expect(bound.isUsable?.()).toBe(false);
    expect(other.isUsable?.()).toBe(true);
    blocked.resolve();
    expect(
      await administration.bind({ ...input, expectedRevision: 2 }),
    ).toMatchObject({ outcome: 'complete' });
    expect(write).toHaveBeenCalledTimes(1);
    expect((await loader.loadIntegration('fixture')).secretEnvRefs).toEqual({
      TOKEN: 'fixture-binding',
    });
    expect(other.isUsable?.()).toBe(true);
    const active = await custody
      .acquire('fixture', 'managed')
      .connect({ ...original, env: { TOKEN: '' } });
    vi.mocked(Client.prototype.close).mockRejectedValueOnce(
      new Error('unbind cleanup failure'),
    );
    write.mockClear();
    await expect(
      administration.unbind({ ...input, expectedRevision: 2 }),
    ).rejects.toMatchObject({ state: 'failed' });
    expect(write).not.toHaveBeenCalled();
    expect(bindings.ungrant).not.toHaveBeenCalled();
    expect(active.isUsable?.()).toBe(false);
    expect((await loader.loadIntegration('fixture')).secretEnvRefs).toEqual({
      TOKEN: 'fixture-binding',
    });
    expect(
      await administration.unbind({ ...input, expectedRevision: 2 }),
    ).toMatchObject({ outcome: 'complete' });
    expect(bindings.ungrant).toHaveBeenCalledTimes(1);
    expect(other.isUsable?.()).toBe(true);
  } finally {
    blocked.resolve();
  }
});
test('successful probe does not report cleanup success after a failed close; retry reaches retained handle', async () => {
  vi.mocked(Client.prototype.close).mockRejectedValueOnce(
    new Error('fixture close failure'),
  );
  await expect(service.probeIntegration('fixture')).rejects.toMatchObject({
    state: 'failed',
  });
  expect(service.inspectLocalConnections()).toMatchObject({
    retained: 1,
    phases: { 'close-failed': 1 },
  });
  await expect(service.probeIntegration('fixture')).rejects.toMatchObject({
    state: 'pending',
  });
  expect((await service.resetRuntimeState()).localCleanup.state).toBe(
    'settled',
  );
  expect(Client.prototype.close).toHaveBeenCalledTimes(2);
});

test('runtime shutdown fences admission immediately and retains live projection until actual SDK close settles', async () => {
  const connection = await custody
    .acquire('fixture', 'managed')
    .connect(await loader.loadIntegration('fixture'));
  connections.set('fixture', connection);
  const blocked = deferred<void>();
  vi.mocked(Client.prototype.close).mockReturnValueOnce(blocked.promise);
  const shutdown = shutdownRuntimeServices({
    logger,
    timers: [],
    mcpConfigs: connections,
    mcpCustody: custody,
    activeAgents: new Map(),
    acpBridge: { shutdown: vi.fn(async () => undefined) },
    feedbackService: { stop: vi.fn() },
    voiceService: { stop: vi.fn(async () => undefined) },
    terminalWsServer: { stop: vi.fn() },
    terminalService: { dispose: vi.fn(async () => undefined) },
    configLoader: { dispose: vi.fn(async () => undefined) },
  });
  expect(() => custody.acquire('other', 'probe')).toThrow();
  try {
    await expect(shutdown).rejects.toThrow('Station Runtime shutdown failed');
    expect(connections.get('fixture')).toBe(connection);
    expect(service.inspectLocalConnections()).toMatchObject({
      accepting: false,
      retained: 1,
    });
    expect(Client.prototype.close).toHaveBeenCalledTimes(1);
  } finally {
    blocked.resolve();
  }
  expect((await custody.shutdown()).state).toBe('settled');
});
test('transient Apps use is fenced and retained through a reset during an actual client method', async () => {
  const entered = deferred<void>(),
    blocked = deferred<any>();
  vi.mocked(Client.prototype.callTool).mockImplementation(() => {
    entered.resolve();
    return blocked.promise;
  });
  const call = service.callMCPUITool('fixture', 'read');
  const refusal = expect(call).rejects.toThrow();
  await entered.promise;
  expect((await service.resetRuntimeState()).localCleanup.state).toBe(
    'pending',
  );
  blocked.resolve({ content: [] });
  await refusal;
  expect((await service.resetRuntimeState()).localCleanup.state).toBe(
    'settled',
  );
  expect(connections.size).toBe(0);
});
test('managed runtime loader reserves custody before its asynchronous config read', async () => {
  const blocked = deferred<any>();
  const load = vi
    .spyOn(loader, 'loadIntegration')
    .mockReturnValueOnce(blocked.promise);
  const tools = loadAgentTools(
    'fixture-agent',
    { tools: { mcpServers: ['fixture'] } } as never,
    loader,
    connections,
    new Map(),
    new Map(),
    new Map(),
    new Map(),
    logger,
    43141,
    createMCPToolProvenanceGeneration(),
    undefined,
    custody,
  );
  expect(load).toHaveBeenCalledTimes(1);
  expect((await service.resetRuntimeState()).localCleanup.state).toBe(
    'settled',
  );
  blocked.resolve({
    id: 'fixture',
    kind: 'mcp',
    transport: 'stdio',
    command: process.execPath,
  });
  expect(await tools).toEqual([]);
  expect(Client.prototype.connect).not.toHaveBeenCalled();
});
test('OAuth full-handle continuation survives initial authorization response then drains exchange before replacement', async () => {
  await loader.saveIntegration('fixture', {
    id: 'fixture',
    kind: 'mcp',
    transport: 'streamable-http',
    endpoint: 'https://fixture.invalid/mcp',
  });
  vi.mocked(Client.prototype.connect).mockRejectedValue(
    new Error('consent required'),
  );
  vi.spyOn(
    StationToolServerOAuthProvider.prototype,
    'takeAuthorizationUrl',
  ).mockReturnValue(new URL('https://fixture.invalid/authorize'));
  vi.spyOn(
    StationToolServerOAuthProvider.prototype,
    'expectedState',
  ).mockResolvedValue('fixture-state');
  vi.spyOn(
    StationToolServerOAuthProvider.prototype,
    'consumeState',
  ).mockResolvedValue(undefined);
  const entered = deferred<void>(),
    blocked = deferred<void>();
  vi.spyOn(
    StreamableHTTPClientTransport.prototype,
    'finishAuth',
  ).mockImplementation(() => {
    entered.resolve();
    return blocked.promise;
  });
  expect(await service.startOAuth('fixture', 'remote')).toMatchObject({
    mode: 'remote-manual-open',
  });
  expect(Client.prototype.close).not.toHaveBeenCalled();
  expect(service.inspectLocalConnections()).toMatchObject({
    retained: 1,
    phases: { oauth: 1 },
  });
  const exchange = service.finishOAuth(
    'fixture',
    'http://127.0.0.1:43141/integrations/fixture/oauth/callback?code=fixture&state=fixture-state',
  );
  const refusal = expect(exchange).rejects.toThrow();
  await entered.promise;
  const original = await loader.loadIntegration('fixture');
  await expect(
    service.saveIntegration({
      ...original,
      endpoint: 'https://replacement.invalid/mcp',
    }),
  ).rejects.toMatchObject({ state: 'pending' });
  expect((await loader.loadIntegration('fixture')).endpoint).toBe(
    original.endpoint,
  );
  blocked.resolve();
  await refusal;
  await service.saveIntegration({
    ...original,
    endpoint: 'https://replacement.invalid/mcp',
  });
  expect(service.inspectLocalConnections().retained).toBe(0);
});
