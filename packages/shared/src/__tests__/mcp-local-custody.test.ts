import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { type MCPLocalClaim, MCPLocalConnectionCustody } from '../mcp.js';

const injection = vi.hoisted(() => ({ constructorFailure: false }));
vi.mock('@modelcontextprotocol/client', async (original) => {
  const actual =
    await original<typeof import('@modelcontextprotocol/client')>();
  return {
    ...actual,
    Client: class extends actual.Client {
      constructor(...options: ConstructorParameters<typeof actual.Client>) {
        if (injection.constructorFailure)
          throw new Error('client constructor failure');
        super(...options);
      }
    },
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const def = {
  id: 'fixture',
  kind: 'mcp' as const,
  transport: 'stdio' as const,
  command: process.execPath,
  args: ['unused-disposable-fixture'],
};
const owners: MCPLocalConnectionCustody[] = [];
const owner = () => {
  const value = new MCPLocalConnectionCustody({ waitMs: 5 });
  owners.push(value);
  return value;
};
beforeEach(() => {
  vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [] });
  vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined);
  vi.spyOn(StdioClientTransport.prototype, 'close').mockResolvedValue(
    undefined,
  );
});
afterEach(async () => {
  injection.constructorFailure = false;
  for (const value of owners.splice(0))
    expect((await value.shutdown()).state).toBe('settled');
  vi.restoreAllMocks();
});

describe('actual prepared SDK handle custody', () => {
  test('a claim cannot replace an attached alternate-harness resource', async () => {
    const custody = owner();
    const claim = custody.acquire(def.id, 'managed');
    const close = vi.fn(async () => undefined);
    claim.attach({
      close,
      inspect: () => ({ phase: 'prepared', pendingOperations: 0 }),
    });
    expect(() => claim.connect(def)).toThrow();
    expect((await custody.release(claim)).state).toBe('settled');
    expect(close).toHaveBeenCalledTimes(1);
    expect(Client.prototype.connect).not.toHaveBeenCalled();
  });
  test('shutdown refuses later configuration writes before invoking the writer', async () => {
    const custody = owner();
    await custody.shutdown();
    const write = vi.fn(async () => undefined);
    await expect(custody.mutate(def.id, write)).rejects.toMatchObject({
      state: 'pending',
    });
    expect(write).not.toHaveBeenCalled();
  });
  test('client construction failure retains the transport created before it', async () => {
    const custody = owner();
    injection.constructorFailure = true;
    const claim = custody.acquire(def.id, 'probe');
    await expect(claim.connect(def)).rejects.toThrow(
      'client constructor failure',
    );
    expect((await custody.release(claim)).state).toBe('settled');
    expect(StdioClientTransport.prototype.close).toHaveBeenCalledTimes(1);
    expect(Client.prototype.close).not.toHaveBeenCalled();
  });
  test('owns the reservation before connect and refuses reset-before-construction', async () => {
    const custody = owner();
    const claim = custody.acquire(def.id, 'managed');
    const connection = claim.connect(def);
    const rejected = expect(connection).rejects.toThrow();
    expect((await custody.reset()).state).toBe('settled');
    await rejected;
    expect(Client.prototype.connect).not.toHaveBeenCalled();
    expect(custody.inspect().retained).toBe(0);
  });
  test.each(['connect', 'listTools'] as const)(
    'reset retains late %s until actual operation and final close settle',
    async (method) => {
      const custody = owner();
      const entered = deferred<void>();
      const blocked = deferred<any>();
      vi.mocked(Client.prototype[method]).mockImplementation(() => {
        entered.resolve();
        return blocked.promise;
      });
      const claim = custody.acquire(def.id, 'managed');
      const result = claim.connect(def);
      const rejected = expect(result).rejects.toThrow();
      await entered.promise;
      expect(await custody.reset()).toMatchObject({
        state: 'pending',
        retained: 1,
      });
      expect(() => custody.acquire('other', 'probe')).toThrow();
      blocked.resolve(method === 'connect' ? undefined : { tools: [] });
      await rejected;
      expect((await custody.reset()).state).toBe('settled');
      expect(custody.inspect().retained).toBe(0);
      expect(Client.prototype.close).toHaveBeenCalledTimes(2);
    },
  );
  test.each(['connect', 'listTools'] as const)(
    '%s failure retains both handles until explicit release',
    async (method) => {
      const custody = owner();
      vi.mocked(Client.prototype[method]).mockRejectedValue(
        new Error('fixture failure'),
      );
      const claim = custody.acquire(def.id, 'probe');
      await expect(claim.connect(def)).rejects.toThrow('fixture failure');
      expect(custody.inspect()).toMatchObject({
        retained: 1,
        phases: { failed: 1 },
      });
      expect((await custody.release(claim)).state).toBe('settled');
      expect(Client.prototype.close).toHaveBeenCalledTimes(1);
      expect(StdioClientTransport.prototype.close).toHaveBeenCalledTimes(1);
    },
  );
  test('a hanging close is joined across retries, then a settled rejection can retry', async () => {
    const custody = owner();
    const blocked = deferred<void>();
    vi.mocked(Client.prototype.close).mockReturnValueOnce(blocked.promise);
    const claim = custody.acquire(def.id, 'managed');
    const connection = await claim.connect(def);
    expect((await custody.reset()).state).toBe('pending');
    expect((await custody.reset()).state).toBe('pending');
    expect(Client.prototype.close).toHaveBeenCalledTimes(1);
    expect(() => connection.client.callTool({ name: 'denied' })).toThrow();
    blocked.reject(new Error('cleanup failure'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(custody.inspect()).toMatchObject({
      retained: 1,
      phases: { 'close-failed': 1 },
    });
    expect((await custody.reset()).state).toBe('settled');
    expect(Client.prototype.close).toHaveBeenCalledTimes(2);
  });
  test('observer constructor-boundary failure still retains and closes both resources', async () => {
    const custody = owner();
    const claim = custody.acquire(def.id, 'probe');
    await expect(
      claim.connect(def, {
        onTransport: () => {
          throw new Error('observer');
        },
      }),
    ).rejects.toThrow('observer');
    expect((await custody.release(claim)).state).toBe('settled');
    expect(Client.prototype.connect).not.toHaveBeenCalled();
    expect(Client.prototype.close).toHaveBeenCalledTimes(1);
    expect(StdioClientTransport.prototype.close).toHaveBeenCalledTimes(1);
  });
  test('OAuth retains its full failed-handshake handle through exchange and prevents replacement during exchange', async () => {
    const custody = owner();
    const blocked = deferred<void>();
    const entered = deferred<void>();
    vi.mocked(Client.prototype.connect).mockRejectedValue(
      new Error('consent required'),
    );
    vi.spyOn(
      StreamableHTTPClientTransport.prototype,
      'close',
    ).mockResolvedValue(undefined);
    vi.spyOn(
      StreamableHTTPClientTransport.prototype,
      'finishAuth',
    ).mockImplementation(() => {
      entered.resolve();
      return blocked.promise;
    });
    const claim = custody.acquire(def.id, 'oauth');
    await expect(
      claim.connect({
        id: def.id,
        kind: 'mcp',
        transport: 'streamable-http',
        endpoint: 'https://fixture.invalid/mcp',
      }),
    ).rejects.toThrow();
    claim.retainForOAuth();
    expect(Client.prototype.close).not.toHaveBeenCalled();
    const exchange = claim.finishAuth(new URLSearchParams('code=fixture'));
    const rejected = expect(exchange).rejects.toThrow();
    await entered.promise;
    const write = vi.fn(async () => undefined);
    await expect(custody.mutate(def.id, write)).rejects.toMatchObject({
      state: 'pending',
    });
    expect(write).not.toHaveBeenCalled();
    blocked.resolve();
    await rejected;
    await custody.mutate(def.id, write);
    expect(write).toHaveBeenCalledTimes(1);
  });
  test('unrelated integration mutation preserves a live connection', async () => {
    const custody = owner();
    const claim = custody.acquire(def.id, 'managed');
    const connection = await claim.connect(def);
    await custody.mutate('unrelated', async () => undefined);
    expect(connection.isUsable?.()).toBe(true);
    expect(Client.prototype.close).not.toHaveBeenCalled();
  });
  test('saturated reservations refuse before effects and inspection never emits identity/configuration', async () => {
    const custody = new MCPLocalConnectionCustody({ capacity: 1, waitMs: 5 });
    owners.push(custody);
    const claim: MCPLocalClaim = custody.acquire('secret-name', 'probe');
    expect(() => custody.acquire('other', 'app')).toThrow();
    expect(JSON.stringify(custody.inspect())).not.toContain('secret-name');
    await custody.release(claim);
    expect(Client.prototype.connect).not.toHaveBeenCalled();
  });
});
