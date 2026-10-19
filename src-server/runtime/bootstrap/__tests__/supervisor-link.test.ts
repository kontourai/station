// @vitest-environment node
/**
 * The core side of the supervisor IPC protocol, driven through a fake IPC
 * process (send / message / disconnect) and real loopback listeners.
 */
import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { STATION_HOME_SUPERVISOR_RUN_DIR } from '@kontourai/station-shared/station-home-schema';
import { resolveControlEndpoint } from '@kontourai/station-supervisor/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeStableListener,
  DIRECT_LISTENER_LINK,
  parkUnderSupervisor,
  type SupervisorChannelProcess,
  SupervisorLink,
} from '../supervisor-link.js';

const HOST = '127.0.0.1';

interface Sent {
  message: { type: string } & Record<string, unknown>;
  handle: unknown;
}

class FakeChannel extends EventEmitter {
  readonly env: NodeJS.ProcessEnv;
  connected = true;
  readonly sent: Sent[] = [];
  readonly exit = vi.fn((_code: number) => {});
  readonly send = vi.fn(
    (
      message: Sent['message'],
      handle?: unknown,
      _options?: undefined,
      callback?: (error: Error | null) => void,
    ) => {
      this.sent.push({ message, handle });
      callback?.(null);
      return true;
    },
  );

  constructor(env: NodeJS.ProcessEnv = { STATION_SUPERVISOR_IPC: '1' }) {
    super();
    this.env = env;
  }

  deliver(message: unknown, handle?: unknown): void {
    this.emit('message', message, handle);
  }

  types(): string[] {
    return this.sent.map((entry) => entry.message.type);
  }
}

function asProcess(channel: FakeChannel): SupervisorChannelProcess {
  return channel as unknown as SupervisorChannelProcess;
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function track<T extends net.Server>(server: T): T {
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        (server as unknown as http.Server).closeAllConnections?.();
        if (server.listening) server.close(() => resolve());
        else resolve();
      }),
  );
  return server;
}

function quietLink(channel: FakeChannel, extra = {}): SupervisorLink {
  return new SupervisorLink({
    process: asProcess(channel),
    log: () => {},
    ...extra,
  });
}

/** A real listening TCP wrap, as the supervisor would hand one over. */
async function rawListeningHandle(): Promise<{
  handle: unknown;
  port: number;
}> {
  const owner = new net.Server();
  await new Promise<void>((resolve) => owner.listen(0, HOST, resolve));
  const address = owner.address() as net.AddressInfo;
  const handle = (owner as unknown as { _handle: unknown })._handle;
  // The adopting server owns the wrap from here; the probe owner lets go.
  (owner as unknown as { _handle: unknown })._handle = null;
  return { handle, port: address.port };
}

function get(
  port: number,
  agent?: http.Agent,
): Promise<{ status: number; connection: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: HOST, port, path: '/', agent }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          connection: res.headers.connection,
          body,
        }),
      );
    });
    request.on('error', reject);
  });
}

function okServer(): http.Server {
  return track(
    http.createServer((_req, res) => {
      res.end('ok');
    }),
  );
}

async function promoted(
  channel: FakeChannel,
  listeners: string[] = [],
  handles: Record<string, unknown> = {},
  extra = {},
): Promise<SupervisorLink> {
  const link = quietLink(channel, extra);
  const parked = link.park();
  channel.deliver({ type: 'promote', listeners });
  for (const name of listeners) {
    channel.deliver({ type: 'listener.adopt', name }, handles[name]);
  }
  await parked;
  return link;
}

describe('parkUnderSupervisor', () => {
  it('returns null without touching the channel when not supervised', async () => {
    const channel = new FakeChannel({});
    await expect(
      parkUnderSupervisor({ process: asProcess(channel) }),
    ).resolves.toBeNull();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('refuses a supervised environment that has no IPC channel', async () => {
    const channel = new FakeChannel();
    (channel as unknown as { send: undefined }).send = undefined;
    await expect(
      parkUnderSupervisor({ process: asProcess(channel) }),
    ).rejects.toThrow(
      /STATION_SUPERVISOR_IPC=1 but this process has no IPC channel/,
    );
  });

  it('reports parked, then waits for promote before resolving', async () => {
    const channel = new FakeChannel();
    let settled = false;
    const parked = parkUnderSupervisor({
      process: asProcess(channel),
      log: () => {},
    }).then((link) => {
      settled = true;
      return link;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(channel.types()).toEqual(['parked']);
    expect(settled).toBe(false);
    channel.deliver({ type: 'promote', listeners: [] });
    await expect(parked).resolves.toBeInstanceOf(SupervisorLink);
  });
});

describe('first generation: promote with no listeners', () => {
  it('binds normally and sends the raw handle, never the server, with listener.bound', async () => {
    const channel = new FakeChannel();
    const link = await promoted(channel);
    const server = okServer();
    const { port } = await link.listen('api', server, { port: 0, host: HOST });
    expect(port).toBe((server.address() as net.AddressInfo).port);
    const bound = channel.sent.find(
      (entry) => entry.message.type === 'listener.bound',
    );
    expect(bound?.message).toEqual({
      type: 'listener.bound',
      name: 'api',
      port,
    });
    expect(bound?.handle).toBe(
      (server as unknown as { _handle: unknown })._handle,
    );
    expect(bound?.handle).not.toBe(server);
    expect(bound?.handle).not.toBeInstanceOf(EventEmitter);
    await expect(get(port)).resolves.toMatchObject({ status: 200, body: 'ok' });
  });

  it('sends ready only after every started listener has settled', async () => {
    const channel = new FakeChannel();
    const link = await promoted(channel);
    const listening = link.listen('terminal', okServer(), {
      port: 0,
      host: HOST,
    });
    const ready = link.ready('boot-1', 4100);
    await Promise.all([listening, ready]);
    const types = channel.types();
    expect(types.indexOf('listener.bound')).toBeLessThan(
      types.indexOf('ready'),
    );
    expect(channel.sent.at(-1)?.message).toEqual({
      type: 'ready',
      bootId: 'boot-1',
      port: 4100,
    });
  });
});

describe('later generation: promote with held listeners', () => {
  it('listens on the adopted handle, reads its port, and reports no listener.bound for it', async () => {
    const channel = new FakeChannel();
    const held = await rawListeningHandle();
    const link = await promoted(channel, ['api'], { api: held.handle });
    expect(link.adoptedPort('api')).toBe(held.port);
    expect(link.adoptedPort('voice')).toBeNull();
    const server = okServer();
    // The requested port is ignored for an adopted listener.
    const { port } = await link.listen('api', server, { port: 1, host: HOST });
    expect(port).toBe(held.port);
    await expect(get(held.port)).resolves.toMatchObject({ body: 'ok' });
    expect(channel.types()).not.toContain('listener.bound');
  });

  it('binds and reports a listener the supervisor does not hold yet', async () => {
    const channel = new FakeChannel();
    const held = await rawListeningHandle();
    const link = await promoted(channel, ['api'], { api: held.handle });
    await link.listen('api', okServer(), { port: 0, host: HOST });
    await link.listen('consent', okServer(), { port: 0, host: HOST });
    expect(
      channel.sent
        .filter((entry) => entry.message.type === 'listener.bound')
        .map((entry) => entry.message.name),
    ).toEqual(['consent']);
  });

  it('fails the park when a promoted handle never arrives', async () => {
    const channel = new FakeChannel();
    const link = quietLink(channel, { adoptTimeoutMs: 20 });
    const parked = link.park();
    channel.deliver({ type: 'promote', listeners: ['api', 'terminal'] });
    const terminal = { close: vi.fn() };
    channel.deliver({ type: 'listener.adopt', name: 'terminal' }, terminal);
    await expect(parked).rejects.toThrow(/never sent: api/);
    expect(terminal.close).toHaveBeenCalledTimes(1);
  });
});

describe('unsolicited handles', () => {
  it('closes a handle for a name not promoted, a late adopt, an unknown listener, and a handle on any other message', async () => {
    const channel = new FakeChannel();
    const link = quietLink(channel);
    const parked = link.park();
    const early = { close: vi.fn() };
    // Before promote: nothing has been asked for yet.
    channel.deliver({ type: 'listener.adopt', name: 'api' }, early);
    channel.deliver({ type: 'promote', listeners: ['api', 'ui'] });
    const notPromoted = { close: vi.fn() };
    channel.deliver({ type: 'listener.adopt', name: 'voice' }, notPromoted);
    const unknownName = { close: vi.fn() };
    channel.deliver({ type: 'listener.adopt', name: 'ui' }, unknownName);
    const api = { close: vi.fn() };
    channel.deliver({ type: 'listener.adopt', name: 'api' }, api);
    await parked;
    const late = { close: vi.fn() };
    channel.deliver({ type: 'listener.adopt', name: 'api' }, late);
    const stray = { close: vi.fn() };
    channel.deliver(
      { type: 'handoff.refused', requestId: 'x', reason: 'busy' },
      stray,
    );
    const malformed = { close: vi.fn() };
    channel.deliver('not a message', malformed);
    for (const handle of [
      early,
      notPromoted,
      unknownName,
      late,
      stray,
      malformed,
    ]) {
      expect(handle.close).toHaveBeenCalledTimes(1);
    }
    expect(api.close).not.toHaveBeenCalled();
    // An adopted handle this generation never serves is released at ready.
    await link.ready('boot', 1);
    expect(api.close).toHaveBeenCalledTimes(1);
  });
});

describe('drain', () => {
  it('stops accepting, marks responses Connection: close, then closes idle connections after the grace', async () => {
    const channel = new FakeChannel();
    const link = await promoted(channel, [], {}, { drainIdleGraceMs: 150 });
    const server = okServer();
    const { port } = await link.listen('api', server, { port: 0, host: HOST });
    const drains: number[] = [];
    link.onDrain((request) => drains.push(request.deadlineMs));

    const busy = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const idle = new http.Agent({ keepAlive: true, maxSockets: 1 });
    cleanups.push(() => busy.destroy());
    cleanups.push(() => idle.destroy());
    expect((await get(port, busy)).connection).toBe('keep-alive');
    expect((await get(port, idle)).connection).toBe('keep-alive');
    const idleSocket = Object.values(idle.freeSockets).flat()[0];
    expect(idleSocket).toBeDefined();
    const idleClosed = new Promise<number>((resolve) =>
      idleSocket?.once('close', () => resolve(Date.now())),
    );

    const drainedAt = Date.now();
    channel.deliver({ type: 'drain', deadlineMs: 7_000 });
    expect(drains).toEqual([7_000]);
    expect(server.listening).toBe(false);
    // Nothing else holds this socket in a unit test, so a new connection is refused.
    await expect(get(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    // A keep-alive connection's next request is answered, and told to close.
    const reused = await get(port, busy);
    expect(reused).toMatchObject({ status: 200, connection: 'close' });
    // The idle connection survives the grace, then is closed.
    expect(await idleClosed).toBeGreaterThanOrEqual(drainedAt + 140);
  });

  it('reports progress and drained, and exits when nothing booted far enough to drain', async () => {
    const channel = new FakeChannel();
    const link = await promoted(channel, [], {}, { drainIdleGraceMs: 10 });
    link.reportDrainProgress(2);
    channel.deliver({ type: 'drain', deadlineMs: 1_000 });
    await vi.waitFor(() => expect(channel.exit).toHaveBeenCalledWith(0));
    expect(channel.sent.map((entry) => entry.message)).toContainEqual({
      type: 'drain.progress',
      voiceSessions: 2,
    });
    expect(channel.types().at(-1)).toBe('drained');
  });

  it('refuses to start a listener while draining', async () => {
    const channel = new FakeChannel();
    const link = await promoted(channel, [], {}, { drainIdleGraceMs: 10 });
    link.onDrain(() => {});
    channel.deliver({ type: 'drain', deadlineMs: 1_000 });
    await expect(
      link.listen('voice', okServer(), { port: 0, host: HOST }),
    ).rejects.toThrow(/draining/);
  });
});

describe('supervisor disconnect', () => {
  it('exits directly when no graceful shutdown is available yet', () => {
    const channel = new FakeChannel();
    quietLink(channel);
    channel.emit('disconnect');
    expect(channel.exit).toHaveBeenCalledWith(1);
  });

  it('routes through graceful shutdown, with a force exit if it hangs', async () => {
    const channel = new FakeChannel();
    const link = quietLink(channel, { disconnectForceExitMs: 200 });
    const shutdown = vi.fn(() => new Promise<void>(() => {}));
    link.setShutdownHandler(shutdown);
    channel.connected = false;
    const disconnectedAt = Date.now();
    channel.emit('disconnect');
    await Promise.resolve();
    await Promise.resolve();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(channel.exit).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(channel.exit).toHaveBeenCalledWith(1));
    expect(Date.now() - disconnectedAt).toBeGreaterThanOrEqual(190);
    // A closed channel is never written to.
    const before = channel.send.mock.calls.length;
    link.reportDrainProgress(0);
    expect(channel.send.mock.calls.length).toBe(before);
  });
});

describe('handoff requests', () => {
  it('settles on handoff.refused and on this generation draining', async () => {
    const channel = new FakeChannel();
    const link = await promoted(channel, [], {}, { drainIdleGraceMs: 10 });
    link.onDrain(() => {});
    const refused = link.requestHandoff({ entry: '/build/next.js' });
    const request = channel.sent.at(-1)?.message;
    expect(request).toMatchObject({
      type: 'handoff.request',
      entry: '/build/next.js',
    });
    channel.deliver({
      type: 'handoff.refused',
      requestId: request?.requestId,
      reason: 'busy',
    });
    await expect(refused).resolves.toEqual({
      status: 'refused',
      reason: 'busy',
    });
    const accepted = link.requestHandoff();
    channel.deliver({ type: 'drain', deadlineMs: 1_000 });
    await expect(accepted).resolves.toEqual({ status: 'draining' });
  });
});

describe('closeStableListener', () => {
  it('resolves for a listener that already stopped accepting', async () => {
    const server = okServer();
    await DIRECT_LISTENER_LINK.listen('api', server, { port: 0, host: HOST });
    net.Server.prototype.close.call(server);
    await expect(closeStableListener(server)).resolves.toBeUndefined();
    await expect(closeStableListener(server)).resolves.toBeUndefined();
  });
});

describe('the supervisor run directory inside the Station home', () => {
  it('is the directory the home schema gate accepts as scaffolding', () => {
    const endpoint = resolveControlEndpoint({
      home: '/station/home',
      instance: 'default',
      platform: 'linux',
    });
    expect(dirname(endpoint.tokenPath)).toBe(
      join('/station/home', STATION_HOME_SUPERVISOR_RUN_DIR),
    );
  });
});
