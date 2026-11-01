import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import {
  TERMINAL_SOCKET_PROTOCOL,
  TERMINAL_TICKET_PROTOCOL_PREFIX,
  terminalScopeAllows,
} from '@kontourai/station-contracts/terminal-transport';
import {
  type TerminalSession,
  TerminalSessionError,
  TerminalSessionStore,
} from '@kontourai/station-sdk/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  type IPtyProcess,
  PtyUnavailableError,
} from '../../../domain/pty-adapter.js';
import type { ShellHost, ShellLaunch } from '../shell-host.js';
import { closeTerminalSocket } from '../terminal-channel-connection.js';
import { TerminalGateway } from '../terminal-gateway.js';
import { TerminalSessions } from '../terminal-sessions.js';
import { TerminalTickets } from '../terminal-tickets.js';

const temp = trackTempDirs();
const scope = { projectId: 'alpha', bindingKey: 'project' };

/** An echoing PTY: what is typed comes back as output. No native backend. */
class EchoPty implements IPtyProcess {
  pid = 4242;
  private data = new Set<(data: string) => void>();
  private exits = new Set<
    (event: { exitCode: number; signal: number | null }) => void
  >();
  written: string[] = [];
  constructor(
    readonly cwd: string,
    readonly launch?: ShellLaunch,
  ) {}
  getCwd = async () => this.cwd;
  write(data: string) {
    this.written.push(data);
    if (data.includes('exit')) {
      for (const exit of this.exits) exit({ exitCode: 7, signal: null });
      return;
    }
    queueMicrotask(() => {
      for (const listener of this.data) listener(`echo:${data}`);
    });
  }
  resize() {}
  kill() {
    for (const exit of this.exits) exit({ exitCode: 0, signal: null });
  }
  onData(cb: (data: string) => void) {
    this.data.add(cb);
    return () => this.data.delete(cb);
  }
  onExit(cb: (event: { exitCode: number; signal: number | null }) => void) {
    this.exits.add(cb);
    return () => this.exits.delete(cb);
  }
}

describe('terminal gateway admission (#3994)', () => {
  let server: Server;
  let gateway: TerminalGateway<string>;
  let sessions: TerminalSessions<string>;
  let tickets: TerminalTickets<string>;
  let apiBase: string;
  let socketURL: string;
  let spawned: EchoPty[];
  let home: string;
  let host: ShellHost;
  const stores: TerminalSessionStore[] = [];
  const sockets: WebSocket[] = [];
  const grants = new Map<string, string>();

  async function start(
    limits: ConstructorParameters<typeof TerminalGateway>[0]['limits'] = {},
  ) {
    home = temp('terminal-gateway-admission-');
    const root = join(home, 'project');
    await mkdir(root);
    spawned = [];
    host = {
      spawn: async (input) => {
        const pty = new EchoPty(input.cwd, input.launch);
        spawned.push(pty);
        return pty;
      },
    };
    sessions = new TerminalSessions(
      home,
      { spawn: (input) => host.spawn(input) },
      {
        authorize: (principal, _target, operation) =>
          terminalScopeAllows(grants.get(principal) ?? '', operation),
        resolveRoot: async () => root,
        legacyProjectSlug: async () => 'alpha-slug',
        resolveLaunch: async (_principal, _scope, profile) => {
          if (profile.connectionId !== 'claude' || profile.mode !== 'code')
            throw new Error('unknown profile');
          return { file: 'claude-cli', args: ['--mode', profile.mode] };
        },
      },
    );
    tickets = new TerminalTickets<string>();
    server = createServer((req, res) => {
      // The ticket mint stands in for the authenticated HTTP route: the
      // bearer is the principal, refused unless it holds a terminal grant.
      if (req.method === 'POST' && req.url === '/api/terminal/tickets') {
        const principal = req.headers.authorization?.replace(/^Bearer /, '');
        if (!principal || !grants.has(principal)) {
          res.writeHead(403).end();
          return;
        }
        const ticket = tickets.mint(principal, principal);
        res.writeHead(ticket ? 200 : 429, {
          'content-type': 'application/json',
        });
        res.end(JSON.stringify({ success: true, data: ticket }));
        return;
      }
      res.writeHead(404).end();
    });
    gateway = new TerminalGateway({
      sessions,
      tickets,
      reserved: (principal) => principal === 'operator',
      limits,
    });
    gateway.mount(server, { upgraded: () => undefined });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    apiBase = `http://127.0.0.1:${address.port}`;
    socketURL = `ws://127.0.0.1:${address.port}/api/terminal/socket`;
  }

  beforeEach(() => {
    grants.clear();
    grants.set('operator', 'terminal:operate');
    grants.set('phone', 'terminal:operate');
    grants.set('watcher', 'terminal:observe');
  });
  afterEach(async () => {
    for (const store of stores.splice(0)) store.dispose();
    for (const socket of sockets.splice(0)) socket.terminate();
    gateway.stop();
    await sessions.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.useRealTimers();
  });

  function rawSocket(protocols: string[], options = {}) {
    const socket = new WebSocket(socketURL, protocols, options);
    socket.on('error', () => undefined);
    sockets.push(socket);
    return socket;
  }
  async function upgradeStatus(protocols: string[]) {
    const socket = rawSocket(protocols);
    const [, response] = (await Promise.race([
      once(socket, 'unexpected-response'),
      once(socket, 'open').then(() => [undefined, { statusCode: 101 }]),
    ])) as [unknown, { statusCode: number }];
    return { status: response.statusCode, socket };
  }
  function ticketFor(principal: string) {
    return tickets.mint(principal, principal)!.ticket;
  }
  function storeFor(principal: string) {
    const store = new TerminalSessionStore({
      apiBase,
      requestTicket: async () => {
        const response = await fetch(`${apiBase}/api/terminal/tickets`, {
          method: 'POST',
          headers: { authorization: `Bearer ${principal}` },
        });
        // The SDK's own mint maps a 403 to a refusal that is not retried.
        if (response.status === 403) throw new TerminalSessionError('refused');
        if (!response.ok) throw new Error(`ticket ${response.status}`);
        return (
          (await response.json()) as {
            data: { ticket: string; expiresAt: number };
          }
        ).data;
      },
      createSocket: (url, protocols) =>
        new WebSocket(url, protocols) as unknown as ReturnType<
          NonNullable<
            ConstructorParameters<
              typeof TerminalSessionStore
            >[0]['createSocket']
          >
        >,
      scheduleFrame: (callback) => setTimeout(callback, 0),
    });
    stores.push(store);
    return store;
  }
  function collect(session: TerminalSession) {
    const output: string[] = [];
    session.subscribe({
      output: (data) => output.push(new TextDecoder().decode(data)),
      reset: () => {
        output.length = 0;
      },
    });
    return output;
  }

  test('an upgrade without a valid single-use ticket is refused before any socket exists', async () => {
    await start();
    expect((await upgradeStatus([TERMINAL_SOCKET_PROTOCOL])).status).toBe(401);
    expect(
      (
        await upgradeStatus([
          TERMINAL_SOCKET_PROTOCOL,
          `${TERMINAL_TICKET_PROTOCOL_PREFIX}${'A'.repeat(43)}`,
        ])
      ).status,
    ).toBe(401);
    const ticket = ticketFor('phone');
    // A ticket without the version subprotocol is not an admission.
    expect(
      (await upgradeStatus([`${TERMINAL_TICKET_PROTOCOL_PREFIX}${ticket}`]))
        .status,
    ).toBe(401);
    // That attempt consumed it: redemption is single-use whatever follows.
    expect(
      (
        await upgradeStatus([
          TERMINAL_SOCKET_PROTOCOL,
          `${TERMINAL_TICKET_PROTOCOL_PREFIX}${ticket}`,
        ])
      ).status,
    ).toBe(401);
    const fresh = ticketFor('phone');
    const admitted = await upgradeStatus([
      TERMINAL_SOCKET_PROTOCOL,
      `${TERMINAL_TICKET_PROTOCOL_PREFIX}${fresh}`,
    ]);
    expect(admitted.status).toBe(101);
    // The selected subprotocol never echoes the ticket.
    expect(admitted.socket.protocol).toBe(TERMINAL_SOCKET_PROTOCOL);
    expect(
      (
        await upgradeStatus([
          TERMINAL_SOCKET_PROTOCOL,
          `${TERMINAL_TICKET_PROTOCOL_PREFIX}${fresh}`,
        ])
      ).status,
    ).toBe(401);
  });

  test('an expired ticket is refused', async () => {
    await start();
    let now = 1_000;
    tickets = new TerminalTickets<string>({ now: () => now, ttlMs: 100 });
    // Rebuild the gateway around the clock-controlled store.
    gateway.stop();
    gateway = new TerminalGateway({
      sessions,
      tickets,
      reserved: () => false,
    });
    gateway.mount(server, { upgraded: () => undefined });
    const ticket = ticketFor('phone');
    now += 100;
    expect(
      (
        await upgradeStatus([
          TERMINAL_SOCKET_PROTOCOL,
          `${TERMINAL_TICKET_PROTOCOL_PREFIX}${ticket}`,
        ])
      ).status,
    ).toBe(401);
  });

  test('one identity cannot take every slot and reserved slots keep the operator in', async () => {
    await start({ connections: 4, perIdentity: 2, reserved: 1 });
    grants.set('tablet', 'terminal:operate');
    const admit = async (principal: string) =>
      (
        await upgradeStatus([
          TERMINAL_SOCKET_PROTOCOL,
          `${TERMINAL_TICKET_PROTOCOL_PREFIX}${ticketFor(principal)}`,
        ])
      ).status;
    expect(await admit('phone')).toBe(101);
    expect(await admit('phone')).toBe(101);
    // Per-identity fairness: a third socket for the same device is refused.
    expect(await admit('phone')).toBe(429);
    // Unreserved capacity is connections - reserved = 3.
    expect(await admit('tablet')).toBe(101);
    expect(await admit('tablet')).toBe(429);
    // The operator in person still gets the reserved slot.
    expect(await admit('operator')).toBe(101);
    expect(await admit('operator')).toBe(429);
  });

  test('a half-open peer that stops answering pings is terminated', async () => {
    await start({ heartbeatMs: 50 });
    const socket = rawSocket(
      [
        TERMINAL_SOCKET_PROTOCOL,
        `${TERMINAL_TICKET_PROTOCOL_PREFIX}${ticketFor('phone')}`,
      ],
      { autoPong: false },
    );
    await once(socket, 'open');
    const [code] = (await once(socket, 'close')) as [number];
    // Terminated, not closed by handshake.
    expect(code).toBe(1006);
  });

  test('a connection is closed at its maximum lifetime', async () => {
    await start({ maxLifetimeMs: 100 });
    const socket = rawSocket([
      TERMINAL_SOCKET_PROTOCOL,
      `${TERMINAL_TICKET_PROTOCOL_PREFIX}${ticketFor('phone')}`,
    ]);
    await once(socket, 'open');
    const [code] = (await once(socket, 'close')) as [number];
    expect(code).toBe(4000);
  });

  test('a refused peer that ignores the close handshake is terminated', () => {
    vi.useFakeTimers();
    const listeners = new Map<string, () => void>();
    const peer = {
      readyState: WebSocket.OPEN,
      close: vi.fn(),
      terminate: vi.fn(),
      once: (event: string, listener: () => void) =>
        listeners.set(event, listener),
    };
    closeTerminalSocket(peer as unknown as WebSocket, 4429, 'capacity', 100);
    expect(peer.close).toHaveBeenCalledWith(4429, 'capacity');
    vi.advanceTimersByTime(99);
    expect(peer.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(peer.terminate).toHaveBeenCalledOnce();
  });

  test('the SDK store opens, types, resizes, reads cwd and closes through a ticket', async () => {
    await start();
    const store = storeFor('phone');
    const session = store.open(scope, { cols: 80, rows: 24 });
    const output = collect(session);
    await expect.poll(() => session.state).toBe('ready');
    expect(session.terminalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.readOnly).toBe(false);
    // Coalesced: two writes in one frame arrive as one input.
    session.write('ls ');
    session.write('-la');
    await expect.poll(() => output.join('')).toContain('echo:ls -la');
    expect(spawned[0]!.written).toEqual(['ls -la']);
    expect(await session.cwd()).toBe(spawned[0]!.cwd);
    // The shell itself was chosen by the server, never by the request.
    expect(spawned[0]!.launch).toBeUndefined();
    await session.close();
    expect(session.state).toBe('detached');
    const [record] = await store.list(scope);
    expect(record).toMatchObject({ status: 'exited' });
  });

  test('a named agent profile is resolved by the server and an unknown one is refused', async () => {
    await start();
    const store = storeFor('phone');
    const agent = store.open(scope, {
      cols: 80,
      rows: 24,
      launch: { kind: 'agent', connectionId: 'claude', mode: 'code' },
    });
    await expect.poll(() => agent.state).toBe('ready');
    expect(spawned.at(-1)!.launch).toEqual({
      file: 'claude-cli',
      args: ['--mode', 'code'],
    });
    const unknown = store.open(scope, {
      cols: 80,
      rows: 24,
      launch: { kind: 'agent', connectionId: 'claude', mode: '--evil' },
    });
    await expect.poll(() => unknown.state).toBe('failed');
    expect(unknown.error?.code).toBe('refused');
    expect(spawned).toHaveLength(1);
  });

  test('a missing PTY backend is reported distinctly from a refusal', async () => {
    await start();
    host.spawn = async () => {
      throw new PtyUnavailableError('node-pty could not load on this host');
    };
    const store = storeFor('phone');
    const session = store.open(scope, { cols: 80, rows: 24 });
    await expect.poll(() => session.state).toBe('failed');
    expect(session.error).toMatchObject({
      code: 'pty-unavailable',
      message: 'node-pty could not load on this host',
    });
  });

  test('a reconnect resumes output without resending input and a second device sees the session', async () => {
    await start();
    const desktop = storeFor('operator');
    const session = desktop.open(scope, { cols: 80, rows: 24 });
    const output = collect(session);
    await expect.poll(() => session.state).toBe('ready');
    session.write('one');
    await expect.poll(() => output.join('')).toContain('echo:one');
    // Drop every socket: the store resumes from its applied sequence.
    gateway.stop();
    gateway = new TerminalGateway({
      sessions,
      tickets,
      reserved: (principal) => principal === 'operator',
    });
    gateway.mount(server, { upgraded: () => undefined });
    await expect.poll(() => session.state, { timeout: 10_000 }).toBe('ready');
    session.write('two');
    await expect.poll(() => output.join('')).toContain('echo:two');
    expect(output.join('').match(/echo:one/g)).toHaveLength(1);
    expect(spawned[0]!.written).toEqual(['one', 'two']);
    // The operator's phone lists and attaches to the same session.
    const phone = storeFor('phone');
    const [listed] = await phone.list(scope);
    expect(listed!.terminalId).toBe(session.terminalId);
    const view = phone.attach(scope, listed!.terminalId);
    const replay = collect(view);
    await expect.poll(() => view.state).toBe('ready');
    expect(replay.join('')).toContain('echo:one');
    expect(replay.join('')).toContain('echo:two');
  });

  test('an observer watches but cannot type, and an unknown device gets no ticket', async () => {
    await start();
    const operator = storeFor('operator');
    const shell = operator.open(scope, { cols: 80, rows: 24 });
    await expect.poll(() => shell.state).toBe('ready');
    const watcher = storeFor('watcher');
    const view = watcher.attach(scope, shell.terminalId!);
    await expect.poll(() => view.state).toBe('ready');
    expect(view.readOnly).toBe(true);
    expect(view.write('rm -rf /')).toBe(false);
    const stranger = storeFor('stranger');
    const refused = stranger.open(scope, { cols: 80, rows: 24 });
    await expect.poll(() => refused.state).toBe('failed');
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.written).toEqual([]);
  });

  test('legacy history without an ownership receipt is refused through the socket open', async () => {
    await start();
    // A raw pre-socket history file this Project cannot prove it owns.
    await mkdir(join(home, 'terminal-history'), { recursive: true });
    await writeFile(
      join(home, 'terminal-history', 'alpha-slug-term-1700000000000.txt'),
      "someone else's output",
    );
    const store = storeFor('operator');
    const session = store.open(scope, {
      cols: 80,
      rows: 24,
      legacyTerminalId: 'term-1700000000000',
    });
    await expect.poll(() => session.state).toBe('failed');
    expect(session.error?.code).toBe('refused');
    expect(spawned).toHaveLength(0);
    // Control: an id with no saved history imports nothing and opens.
    const fresh = store.open(scope, {
      cols: 80,
      rows: 24,
      legacyTerminalId: 'term-1700000000001',
    });
    await expect.poll(() => fresh.state).toBe('ready');
    const [record] = (await store.list(scope)).filter(
      (item) => item.terminalId === fresh.terminalId,
    );
    expect(record?.legacy).toMatchObject({
      projectSlug: 'alpha-slug',
      terminalId: 'term-1700000000001',
      imported: true,
    });
  });

  test('a server-owned launch exits with its code and is attachable by id', async () => {
    await start();
    const signIn = {
      projectId: '.engine-sign-in',
      bindingKey: 'engine-sign-in',
    };
    const opened = await sessions.openInternal(signIn, {
      cwd: join(temp('terminal-sign-in-'), '.'),
      cols: 100,
      rows: 30,
      launch: { file: 'engine', args: ['login'], env: {} },
    });
    const store = storeFor('operator');
    const view = store.attach(signIn, opened.terminalId);
    await expect.poll(() => view.state).toBe('ready');
    expect(view.write('exit\r')).toBe(true);
    await expect(opened.exited).resolves.toEqual({ exitCode: 7 });
    await expect.poll(() => view.status).toBe('exited');
    // Another scope cannot close it.
    await expect(
      sessions.closeInternal(scope, opened.terminalId),
    ).rejects.toThrow('Terminal not found');
  });
});
