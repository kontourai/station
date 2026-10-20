// @vitest-environment node
/**
 * The core side of the supervisor IPC protocol, driven through a fake IPC
 * process (send / message / disconnect) and real loopback listeners.
 */
import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { posix, win32 } from 'node:path';
import {
  MAX_LISTENER_SPARES,
  resolveControlEndpoint,
  supervisorRunDir,
} from '@kontourai/station-supervisor/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeStableListener,
  DIRECT_LISTENER_LINK,
  DRAIN_QUIET_CAP_MS,
  DRAIN_QUIET_CLOSE_MS,
  type DrainRequest,
  drainWaitBoundMs,
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
    // Protocol 1.1: connections held for it during a handoff come here now.
    expect(channel.sent.at(-1)?.message).toEqual({
      type: 'listener.listening',
      name: 'api',
    });
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

describe('adopted listener details', () => {
  it('closes an adopted handle that fails to listen, and warns when configuration names another port or host', async () => {
    const channel = new FakeChannel();
    const logs: string[] = [];
    const held = await rawListeningHandle();
    const broken = { close: vi.fn() };
    const link = await promoted(
      channel,
      ['api', 'voice'],
      { api: held.handle, voice: broken },
      { log: (message: string) => logs.push(message) },
    );
    await expect(
      link.listen('voice', okServer(), { port: 0, host: HOST }),
    ).rejects.toThrow();
    expect(broken.close).toHaveBeenCalledTimes(1);
    await link.listen('api', okServer(), { port: 1, host: '0.0.0.0' });
    expect(logs.join('\n')).toContain(
      `configured port 1 differs from the supervisor-held port ${held.port}`,
    );
    expect(logs.join('\n')).toContain(
      'configured host 0.0.0.0 differs from the supervisor-held address 127.0.0.1',
    );
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

  it('lets a request whose headers have started arriving finish, then settles', async () => {
    const channel = new FakeChannel();
    const link = await promoted(channel, [], {}, { drainIdleGraceMs: 100 });
    const { port } = await link.listen('api', okServer(), {
      port: 0,
      host: HOST,
    });
    let settled: DrainRequest['connectionsSettled'] | undefined;
    link.onDrain((request) => {
      settled = request.connectionsSettled;
    });
    const socket = net.connect(port, HOST);
    cleanups.push(() => socket.destroy());
    await new Promise((resolve) => socket.once('connect', resolve));
    let reply = '';
    const errors: string[] = [];
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      reply += chunk;
    });
    socket.on('error', (error: NodeJS.ErrnoException) =>
      errors.push(error.code ?? error.message),
    );
    const ended = new Promise((resolve) => socket.once('close', resolve));
    socket.write('GET / HTTP/1.1\r\nHost: x');
    await new Promise((resolve) => setTimeout(resolve, 50));
    channel.deliver({ type: 'drain', deadlineMs: 10_000 });
    let early = false;
    void settled?.then(() => {
      early = true;
    });
    // Well past the idle grace and several sweeps: still waiting for us.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(socket.destroyed).toBe(false);
    expect(early).toBe(false);
    socket.write('\r\n\r\n');
    await ended;
    expect(errors).toEqual([]);
    expect(reply).toMatch(/^HTTP\/1\.1 200/);
    expect(reply.toLowerCase()).toContain('connection: close');
    await expect(settled).resolves.toEqual({ lingering: 0 });
  });

  it('waits for a slow handler, ends event streams cleanly, and ignores upgraded sockets', async () => {
    const channel = new FakeChannel();
    const link = await promoted(channel, [], {}, { drainIdleGraceMs: 100 });
    const server = track(
      http.createServer((req, res) => {
        if (req.url === '/events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: hello\n\n');
          return;
        }
        setTimeout(() => res.end('slow'), 700);
      }),
    );
    // As startWebSocketListener does for the sockets ws upgrades.
    server.on('upgrade', (_req, socket) => {
      link.upgraded(socket as net.Socket);
      socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n');
    });
    const { port } = await link.listen('terminal', server, {
      port: 0,
      host: HOST,
    });
    let settled: DrainRequest['connectionsSettled'] | undefined;
    link.onDrain((request) => {
      settled = request.connectionsSettled;
    });

    const stream = new Promise<{ body: string; error?: string }>((resolve) => {
      http.get({ host: HOST, port, path: '/events', agent: false }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ body }));
        res.on('error', (error) => resolve({ body, error: error.message }));
      });
    });
    const upgraded = net.connect(port, HOST);
    cleanups.push(() => upgraded.destroy());
    await new Promise((resolve) => upgraded.once('connect', resolve));
    upgraded.write(
      'GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n',
    );
    const slow = get(port);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const drainedAt = Date.now();
    channel.deliver({ type: 'drain', deadlineMs: 10_000 });
    let settledAt = 0;
    void settled?.then(() => {
      settledAt = Date.now();
    });
    let slowAt = 0;
    void slow.then(() => {
      slowAt = Date.now();
    });

    await expect(stream).resolves.toEqual({ body: 'data: hello\n\n' });
    await expect(slow).resolves.toMatchObject({ status: 200, body: 'slow' });
    // The upgraded socket stays open; it is its WebSocket server's to end.
    await expect(settled).resolves.toEqual({ lingering: 0 });
    expect(settledAt).toBeGreaterThanOrEqual(slowAt);
    expect(Date.now() - drainedAt).toBeLessThan(5_000);
    expect(upgraded.destroyed).toBe(false);
  });

  it('answers a Connection: Upgrade request on a server with no upgrade handler', async () => {
    const channel = new FakeChannel();
    const link = await promoted(channel);
    const { port } = await link.listen('api', okServer(), {
      port: 0,
      host: HOST,
    });
    // What `curl --http2` sends to a cleartext server.
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, HOST);
      cleanups.push(() => socket.destroy());
      let text = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        text += chunk;
        if (text.includes('\r\n\r\n')) resolve(text);
      });
      socket.on('error', reject);
      // A request Node handed to an absent upgrade handler is never answered.
      socket.setTimeout(5_000, () =>
        reject(new Error(`no response to the Upgrade request: ${text}`)),
      );
      socket.write(
        'GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade, HTTP2-Settings\r\nUpgrade: h2c\r\nHTTP2-Settings: AAMAAABkAARAAAAAAAIAAAAA\r\n\r\n',
      );
    });
    expect(reply).toMatch(/^HTTP\/1\.1 200/);
  });

  it('stops waiting at the deadline less its margin', async () => {
    const channel = new FakeChannel();
    const link = await promoted(channel, [], {}, { drainIdleGraceMs: 100 });
    const server = track(http.createServer(() => {}));
    const { port } = await link.listen('api', server, { port: 0, host: HOST });
    let settled: DrainRequest['connectionsSettled'] | undefined;
    link.onDrain((request) => {
      settled = request.connectionsSettled;
    });
    const arrived = new Promise((resolve) => server.once('request', resolve));
    const hung = http.get({ host: HOST, port, path: '/', agent: false });
    hung.on('error', () => {});
    cleanups.push(() => hung.destroy());
    await arrived;
    // A request that never finishes, timed on a fake clock so the bound is
    // exact: drainWaitBoundMs(1500, 100) is 1500 - 300.
    expect(drainWaitBoundMs(1_500, 100)).toBe(1_200);
    vi.useFakeTimers();
    try {
      let result: { lingering: number } | undefined;
      channel.deliver({ type: 'drain', deadlineMs: 1_500 });
      void settled?.then((value) => {
        result = value;
      });
      await vi.advanceTimersByTimeAsync(1_199);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toEqual({ lingering: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds its wait by the deadline itself, never past it', () => {
    // Literals pinned beside the derivation: margin is min(2000, deadline/5).
    expect(drainWaitBoundMs(10_000, 1_000)).toBe(8_000);
    expect(drainWaitBoundMs(1_500, 100)).toBe(1_200);
    // Shorter than the grace: the deadline wins.
    expect(drainWaitBoundMs(500, 1_000)).toBe(500);
    expect(drainWaitBoundMs(0, 1_000)).toBe(0);
    expect(drainWaitBoundMs(-5, 1_000)).toBe(0);
    expect(drainWaitBoundMs(Number.NaN, 1_000)).toBe(0);
    for (const deadline of [1, 50, 999, 1_000, 3_000, 10_000, 60_000]) {
      expect(drainWaitBoundMs(deadline, 1_000)).toBeLessThanOrEqual(deadline);
    }
  });

  it('with a zero deadline, settles without waiting out the grace', async () => {
    const channel = new FakeChannel();
    const link = await promoted(channel, [], {}, { drainIdleGraceMs: 5_000 });
    await link.listen('api', okServer(), { port: 0, host: HOST });
    let settled: DrainRequest['connectionsSettled'] | undefined;
    link.onDrain((request) => {
      settled = request.connectionsSettled;
    });
    const drainedAt = Date.now();
    channel.deliver({ type: 'drain', deadlineMs: 0 });
    await expect(settled).resolves.toEqual({ lingering: 0 });
    expect(Date.now() - drainedAt).toBeLessThan(2_000);
  });

  it('starts the same drain from SIGTERM', async () => {
    const channel = new FakeChannel();
    const link = await promoted(channel, [], {}, { drainIdleGraceMs: 10 });
    const server = okServer();
    await link.listen('api', server, { port: 0, host: HOST });
    const sources: string[] = [];
    link.onDrain((request) => sources.push(request.source));
    const request = link.beginDrain(5_000);
    expect(request).toMatchObject({ source: 'signal', deadlineMs: 5_000 });
    expect(sources).toEqual(['signal']);
    expect(server.listening).toBe(false);
    expect(link.draining).toBe(true);
    // A later supervisor drain is the same drain, not a second one.
    channel.deliver({ type: 'drain', deadlineMs: 1_000 });
    expect(sources).toEqual(['signal']);
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

describe('the supervisor run directory', () => {
  it("lies beside the Station home, never inside it, in its platform's path flavor", () => {
    const linux = resolveControlEndpoint({
      home: '/station/instances/stable',
      instance: 'default',
      platform: 'linux',
    });
    expect(posix.dirname(linux.tokenPath)).toBe(
      '/station/instances/.stable.station-supervisor',
    );
    expect(linux.path.startsWith('/station/instances/stable/')).toBe(false);
    const windows = resolveControlEndpoint({
      home: 'C:\\Station\\instances\\stable',
      instance: 'default',
      platform: 'win32',
    });
    expect(win32.dirname(windows.tokenPath)).toBe(
      'C:\\Station\\instances\\.stable.station-supervisor',
    );
  });

  it('names the run directory for the default home and for a home of ~/.station', () => {
    // The default home is <root>/instances/<channel>.
    expect(
      supervisorRunDir('/Users/me/.station/instances/stable', 'darwin'),
    ).toBe('/Users/me/.station/instances/.stable.station-supervisor');
    // STATION_HOME=~/.station itself: a doubled dot, still beside the home.
    expect(supervisorRunDir('/Users/me/.station', 'darwin')).toBe(
      '/Users/me/..station.station-supervisor',
    );
  });
});

describe('connection catching (protocol 1.1)', () => {
  /**
   * A connection accepted by another listener and not read, as the
   * supervisor holds one, with `request` already sent by its client.
   */
  async function heldConnection(request: string): Promise<{
    socket: net.Socket;
    reply: Promise<string>;
  }> {
    const holder = track(net.createServer({ pauseOnConnect: true }));
    await new Promise<void>((resolve) => holder.listen(0, HOST, resolve));
    const accepted = new Promise<net.Socket>((resolve) =>
      holder.once('connection', resolve),
    );
    const client = net.connect(
      (holder.address() as net.AddressInfo).port,
      HOST,
    );
    cleanups.push(() => client.destroy());
    let reply = '';
    client.setEncoding('utf8');
    client.on('data', (chunk: string) => {
      reply += chunk;
    });
    client.on('error', () => {});
    const closed = new Promise<void>((resolve) =>
      client.once('close', () => resolve()),
    );
    client.write(request);
    const socket = await accepted;
    cleanups.push(() => socket.destroy());
    return { socket, reply: closed.then(() => reply) };
  }
  const GET_CLOSE = 'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n';
  const spares = (channel: FakeChannel) =>
    channel.sent.filter(({ message }) => message.type === 'listener.spare');

  it('parks saying it adopts connections', async () => {
    const channel = new FakeChannel();
    void quietLink(channel).park();
    expect(channel.sent.map(({ message }) => message)).toEqual([
      { type: 'parked', adoptsConnections: true },
    ]);
  });

  it('answers listener.spares with that many copies of the raw handle, and refuses a bad count, a listener it lacks, or a drain in progress', async () => {
    const channel = new FakeChannel();
    const link = await promoted(channel);
    const server = okServer();
    await link.listen('api', server, { port: 0, host: HOST });
    const raw = (server as unknown as { _handle: unknown })._handle;
    channel.deliver({ type: 'listener.spares', name: 'api', count: 3 });
    expect(spares(channel)).toEqual(
      Array.from({ length: 3 }, () => ({
        message: { type: 'listener.spare', name: 'api' },
        handle: raw,
      })),
    );
    expect(MAX_LISTENER_SPARES).toBe(32);
    for (const count of [0, MAX_LISTENER_SPARES + 1, 1.5, '2', undefined]) {
      channel.deliver({ type: 'listener.spares', name: 'api', count });
    }
    channel.deliver({ type: 'listener.spares', name: 'voice', count: 1 });
    channel.deliver({ type: 'listener.spares', name: 'nope', count: 1 });
    expect(spares(channel)).toHaveLength(3);
    channel.deliver({
      type: 'listener.spares',
      name: 'api',
      count: MAX_LISTENER_SPARES,
    });
    expect(spares(channel)).toHaveLength(3 + MAX_LISTENER_SPARES);
    channel.deliver({ type: 'drain', deadlineMs: 5_000 });
    channel.deliver({ type: 'listener.spares', name: 'api', count: 1 });
    expect(spares(channel)).toHaveLength(3 + MAX_LISTENER_SPARES);
  });

  it('serves an adopted connection on the named listener, and closes one for a listener it lacks or a message without a socket', async () => {
    const channel = new FakeChannel();
    const link = await promoted(channel);
    await link.listen('api', okServer(), { port: 0, host: HOST });
    const served = await heldConnection(GET_CLOSE);
    channel.deliver({ type: 'connection.adopt', name: 'api' }, served.socket);
    expect(await served.reply).toMatch(/^HTTP\/1\.1 200 OK/);
    const unknown = await heldConnection(GET_CLOSE);
    channel.deliver(
      { type: 'connection.adopt', name: 'voice' },
      unknown.socket,
    );
    expect(await unknown.reply).toBe('');
    expect(unknown.socket.destroyed).toBe(true);
    const notASocket = { close: vi.fn() };
    channel.deliver({ type: 'connection.adopt', name: 'api' }, notASocket);
    expect(notASocket.close).toHaveBeenCalled();
  });

  it('waits for an adopted connection to finish its request before a drain settles, though net.Server does not count it', async () => {
    const channel = new FakeChannel();
    const link = await promoted(channel, [], {}, { drainIdleGraceMs: 100 });
    const server = track(
      http.createServer((_req, res) => {
        setTimeout(() => res.end('slow'), 700);
      }),
    );
    await link.listen('api', server, { port: 0, host: HOST });
    let settled: DrainRequest['connectionsSettled'] | undefined;
    link.onDrain((request) => {
      settled = request.connectionsSettled;
    });
    const held = await heldConnection(GET_CLOSE);
    channel.deliver({ type: 'connection.adopt', name: 'api' }, held.socket);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise<void>((resolve) =>
      server.getConnections((_error, count) => {
        expect(count).toBe(0);
        resolve();
      }),
    );
    channel.deliver({ type: 'drain', deadlineMs: 10_000 });
    let settledAt = 0;
    void settled?.then(() => {
      settledAt = Date.now();
    });
    const reply = await held.reply;
    const repliedAt = Date.now();
    expect(reply).toMatch(/^HTTP\/1\.1 200 OK[\s\S]*slow$/);
    await expect(settled).resolves.toEqual({ lingering: 0 });
    expect(settledAt).toBeGreaterThanOrEqual(repliedAt);
  });

  it('after sending spares, a drain keeps accepting until no connection has arrived for the quiet window', async () => {
    expect(DRAIN_QUIET_CLOSE_MS).toBe(50);
    const channel = new FakeChannel();
    const link = await promoted(channel, [], {}, { drainIdleGraceMs: 100 });
    const server = okServer();
    const accepts: number[] = [];
    const { port } = await link.listen('api', server, { port: 0, host: HOST });
    channel.deliver({ type: 'listener.spares', name: 'api', count: 1 });
    // Drain the moment a connection is accepted, so it is not yet quiet.
    let listeningAtDrain: boolean | undefined;
    server.on('connection', () => {
      accepts.push(Date.now());
      if (listeningAtDrain !== undefined) return;
      channel.deliver({ type: 'drain', deadlineMs: 7_000 });
      listeningAtDrain = server.listening;
    });
    // Its request arrives after the drain began: answered, and told to close.
    expect(await get(port, new http.Agent({ keepAlive: false }))).toMatchObject(
      { status: 200, connection: 'close' },
    );
    expect(listeningAtDrain).toBe(true);
    await vi.waitFor(() => expect(server.listening).toBe(false), {
      timeout: 3_000,
      interval: 5,
    });
    expect(Date.now() - Math.max(...accepts)).toBeGreaterThanOrEqual(
      DRAIN_QUIET_CLOSE_MS - 5,
    );
  });

  it('after sending spares, a drain under steady connections closes only after a quiet window or at the cap', async () => {
    expect(DRAIN_QUIET_CAP_MS).toBe(1_000);
    const channel = new FakeChannel();
    const link = await promoted(channel, [], {}, { drainIdleGraceMs: 100 });
    const server = okServer();
    const accepts: number[] = [];
    server.on('connection', () => accepts.push(Date.now()));
    const { port } = await link.listen('api', server, { port: 0, host: HOST });
    channel.deliver({ type: 'listener.spares', name: 'api', count: 1 });
    // When the link stops accepting (it calls net.Server's close directly).
    let closedAt = 0;
    const original = net.Server.prototype.close;
    const close = vi
      .spyOn(net.Server.prototype, 'close')
      .mockImplementation(function (this: net.Server, callback) {
        if (this === server && closedAt === 0) closedAt = Date.now();
        return original.call(this, callback);
      });
    cleanups.push(() => close.mockRestore());
    let connecting = true;
    // A new connection each time: reusing one would not reach the listener.
    const fresh = new http.Agent({ keepAlive: false });
    const loops = Array.from({ length: 4 }, async () => {
      while (connecting) {
        await get(port, fresh).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    await vi.waitFor(() => expect(accepts.length).toBeGreaterThan(4));
    const drainedAt = Date.now();
    channel.deliver({ type: 'drain', deadlineMs: 7_000 });
    await vi.waitFor(() => expect(closedAt).toBeGreaterThan(0), {
      timeout: 5_000,
      interval: 5,
    });
    connecting = false;
    await Promise.all(loops);
    const lastAccept = Math.max(...accepts.filter((at) => at <= closedAt));
    const quiet = closedAt - lastAccept >= DRAIN_QUIET_CLOSE_MS - 5;
    const capped = closedAt - drainedAt >= DRAIN_QUIET_CAP_MS - 5;
    expect({ quiet, capped }).not.toEqual({ quiet: false, capped: false });
    // The cap bounds it (with room for late timers on a loaded host).
    expect(closedAt - drainedAt).toBeLessThan(DRAIN_QUIET_CAP_MS + 2_000);
    // Accepting went on after the drain began, unless it was quiet at once.
    expect(accepts.some((at) => at > drainedAt) || quiet).toBe(true);
  });
});
