import { once } from 'node:events';
import { terminalPtyUnavailableReason } from '@kontourai/station-shared/terminal-capability';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { PtyUnavailableError } from '../../../domain/pty-adapter.js';
import { TerminalWebSocketServer } from '../terminal-ws-server.js';

const TEST_CREDENTIAL = 'terminal-test-credential-not-for-production';

async function listeningPort(terminal: TerminalWebSocketServer): Promise<{
  port: number;
  wss: ReturnType<TerminalWebSocketServer['start']>;
}> {
  const wss = terminal.start(0, '127.0.0.1');
  await once(wss, 'listening');
  const address = wss.address();
  if (!address || typeof address === 'string')
    throw new Error('missing address');
  return { port: address.port, wss };
}

function remoteAuthOptions() {
  return {
    classifyPeer: vi.fn((): 'remote' => 'remote'),
    verifyCredential: vi.fn((value: string) => value === TEST_CREDENTIAL),
    authTimeoutMs: 50,
    maxAuthFailures: 2,
  };
}

async function closeServer(
  terminal: TerminalWebSocketServer,
  wss: ReturnType<TerminalWebSocketServer['start']>,
) {
  await terminal.stop();
  expect(wss.address()).toBeNull();
}

async function closesWithin(ws: WebSocket, timeoutMs = 200): Promise<boolean> {
  return Promise.race([
    once(ws, 'close').then(() => true),
    new Promise<false>((resolve) =>
      setTimeout(() => resolve(false), timeoutMs),
    ),
  ]);
}

describe('terminal websocket health', () => {
  it('does not resolve stop until the websocket listener has closed', async () => {
    const service = { subscribe: vi.fn(() => vi.fn()), close: vi.fn() };
    const terminal = new TerminalWebSocketServer(service as any);
    let releaseClose!: () => void;
    const close = vi.fn((callback: (error?: Error) => void) => {
      releaseClose = () => callback();
    });
    const unauthenticatedTerminate = vi.fn();
    (
      terminal as unknown as {
        wss: {
          close: typeof close;
          clients: Set<{ terminate: typeof unauthenticatedTerminate }>;
        };
      }
    ).wss = {
      close,
      clients: new Set([{ terminate: unauthenticatedTerminate }]),
    };
    const businessTerminate = vi.fn();
    (
      terminal as unknown as {
        clients: Set<{ terminate: typeof businessTerminate }>;
      }
    ).clients.add({ terminate: businessTerminate });

    const firstStop = terminal.stop();
    const secondStop = terminal.stop();
    let firstStopped = false;
    let secondStopped = false;
    void firstStop.then(() => {
      firstStopped = true;
    });
    void secondStop.then(() => {
      secondStopped = true;
    });
    await Promise.resolve();

    expect(close).toHaveBeenCalledTimes(1);
    expect(businessTerminate).toHaveBeenCalledTimes(1);
    expect(unauthenticatedTerminate).toHaveBeenCalledTimes(1);
    expect(firstStop).toBe(secondStop);
    expect(firstStopped).toBe(false);
    expect(secondStopped).toBe(false);
    releaseClose();
    await Promise.all([firstStop, secondStop]);
    expect(firstStopped).toBe(true);
    expect(secondStopped).toBe(true);
  });

  it('does not register business clients or allocate sessions for health upgrades', async () => {
    const service = { subscribe: vi.fn(() => vi.fn()), close: vi.fn() };
    const terminal = new TerminalWebSocketServer(service as any);
    const wss = terminal.start(0, '127.0.0.1');
    await once(wss, 'listening');
    const address = wss.address();
    if (!address || typeof address === 'string')
      throw new Error('missing address');
    for (let index = 0; index < 3; index += 1) {
      const serverClosed = new Promise<void>((resolve) => {
        wss.once('connection', (serverSocket) => {
          serverSocket.once('close', () => resolve());
        });
      });
      const ws = new WebSocket(
        `ws://127.0.0.1:${address.port}/__station/health`,
      );
      const upgrade = once(ws, 'upgrade');
      const [[response]] = await Promise.all([
        upgrade,
        once(ws, 'close'),
        serverClosed,
      ]);
      expect(response.headers).not.toHaveProperty('x-station-instance');
      expect(response.headers).not.toHaveProperty('x-station-build-sha');
      expect(response.headers).not.toHaveProperty('x-station-boot-id');
      expect(wss.clients.size).toBe(0);
    }
    expect(service.close).not.toHaveBeenCalled();
    expect(service.subscribe).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it('fails closed when the central declaration does not classify health as public', async () => {
    const service = { subscribe: vi.fn(() => vi.fn()), close: vi.fn() };
    const terminal = new TerminalWebSocketServer(service as any, {
      verifyCredential: vi.fn(),
      resolveCapability: () => undefined,
    });
    const { port, wss } = await listeningPort(terminal);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/__station/health`);
    const [code] = await once(ws, 'close');

    expect(code).toBe(4404);
    expect(service.subscribe).not.toHaveBeenCalled();
    await closeServer(terminal, wss);
  });
});

describe('terminal websocket remote authentication', () => {
  it('rejects a transport-oversized pre-auth payload before business allocation', async () => {
    const service = {
      subscribe: vi.fn(() => vi.fn()),
      open: vi.fn(),
      close: vi.fn(),
    };
    const terminal = new TerminalWebSocketServer(service as any, {
      ...remoteAuthOptions(),
      maxPayloadBytes: 4_096,
    });
    const { port, wss } = await listeningPort(terminal);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(ws, 'open');
    ws.send('x'.repeat(8_192));
    const [code] = await once(ws, 'close');

    await closeServer(terminal, wss);
    expect(code).toBe(1009);
    expect(service.open).not.toHaveBeenCalled();
    expect(service.subscribe).not.toHaveBeenCalled();
  });

  it.each([
    ['per-peer', 4, 1],
    ['global', 1, 4],
  ] as const)(
    'caps %s unauthenticated connections and recovers after cleanup',
    async (_kind, globalLimit, peerLimit) => {
      const service = {
        subscribe: vi.fn(() => vi.fn()),
        open: vi.fn(),
        close: vi.fn(),
      };
      const terminal = new TerminalWebSocketServer(service as any, {
        ...remoteAuthOptions(),
        authTimeoutMs: 1_000,
        maxUnauthenticatedConnections: globalLimit,
        maxUnauthenticatedConnectionsPerPeer: peerLimit,
      });
      const { port, wss } = await listeningPort(terminal);
      const pending = new WebSocket(`ws://127.0.0.1:${port}`);
      await once(pending, 'open');
      const rejected = new WebSocket(`ws://127.0.0.1:${port}`);
      await once(rejected, 'open');
      const [code, reason] = await once(rejected, 'close');
      expect(code).toBe(4429);
      expect(reason.toString()).toBe('authentication_capacity_exceeded');

      pending.close();
      await once(pending, 'close');
      const recovered = new WebSocket(`ws://127.0.0.1:${port}`);
      await once(recovered, 'open');
      recovered.send(
        JSON.stringify({
          type: 'auth',
          protocolVersion: 1,
          credential: TEST_CREDENTIAL,
        }),
      );
      const [ack] = await once(recovered, 'message');
      expect(JSON.parse(ack.toString()).type).toBe('authenticated');

      recovered.close();
      await once(recovered, 'close');
      await closeServer(terminal, wss);
    },
  );

  it('cannot authenticate after the timeout wins a credential-verification race', async () => {
    let resolveVerification!: (valid: boolean) => void;
    const verification = new Promise<boolean>((resolve) => {
      resolveVerification = resolve;
    });
    const service = {
      subscribe: vi.fn(() => vi.fn()),
      open: vi.fn(),
      close: vi.fn(),
    };
    const terminal = new TerminalWebSocketServer(service as any, {
      ...remoteAuthOptions(),
      authTimeoutMs: 20,
      verifyCredential: vi.fn(() => verification),
    });
    const { port, wss } = await listeningPort(terminal);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(ws, 'open');
    ws.send(
      JSON.stringify({
        type: 'auth',
        protocolVersion: 1,
        credential: TEST_CREDENTIAL,
      }),
    );
    const [code] = await once(ws, 'close');
    resolveVerification(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await closeServer(terminal, wss);
    expect(code).toBe(4401);
    expect(service.open).not.toHaveBeenCalled();
    expect(service.subscribe).not.toHaveBeenCalled();
  });

  it.each(['client', 'server'] as const)(
    'cannot authenticate after a %s close wins verification and releases replacement admission',
    async (initiator) => {
      let resolveVerification!: (valid: boolean) => void;
      const verification = new Promise<boolean>((resolve) => {
        resolveVerification = resolve;
      });
      const verifyCredential = vi.fn(() => verification);
      const service = {
        subscribe: vi.fn(() => vi.fn()),
        open: vi.fn(),
        close: vi.fn(),
      };
      const terminal = new TerminalWebSocketServer(service as any, {
        ...remoteAuthOptions(),
        authTimeoutMs: 1_000,
        maxUnauthenticatedConnections: 1,
        maxUnauthenticatedConnectionsPerPeer: 1,
        verifyCredential,
      });
      const { port, wss } = await listeningPort(terminal);
      const serverConnection = once(wss, 'connection');
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await once(ws, 'open');
      const [serverSocket] = await serverConnection;
      ws.send(
        JSON.stringify({
          type: 'auth',
          protocolVersion: 1,
          credential: TEST_CREDENTIAL,
        }),
      );
      await vi.waitFor(() => expect(verifyCredential).toHaveBeenCalledTimes(1));
      if (initiator === 'client') ws.close();
      else serverSocket.close(1000, 'server_shutdown');
      await once(ws, 'close');
      resolveVerification(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(service.subscribe).not.toHaveBeenCalled();

      const replacement = new WebSocket(`ws://127.0.0.1:${port}`);
      await once(replacement, 'open');
      replacement.send(
        JSON.stringify({
          type: 'auth',
          protocolVersion: 1,
          credential: TEST_CREDENTIAL,
        }),
      );
      const [ack] = await once(replacement, 'message');
      expect(JSON.parse(ack.toString()).type).toBe('authenticated');
      expect(service.subscribe).toHaveBeenCalledTimes(1);

      replacement.close();
      await once(replacement, 'close');
      await closeServer(terminal, wss);
      expect(service.open).not.toHaveBeenCalled();
    },
  );

  it('guards the auth commit when client close state precedes the server close event', async () => {
    const service = {
      subscribe: vi.fn(() => vi.fn()),
      open: vi.fn(),
      close: vi.fn(),
    };
    const verifyCredential = vi.fn(async () => true);
    const terminal = new TerminalWebSocketServer(service as any, {
      ...remoteAuthOptions(),
      authTimeoutMs: 1_000,
      maxUnauthenticatedConnections: 1,
      maxUnauthenticatedConnectionsPerPeer: 1,
      verifyCredential,
    });
    const { port, wss } = await listeningPort(terminal);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      let resolveVerification!: (valid: boolean) => void;
      const verification = new Promise<boolean>((resolve) => {
        resolveVerification = resolve;
      });
      verifyCredential.mockImplementationOnce(() => verification);
      const serverConnection = once(wss, 'connection');
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const received = vi.fn();
      ws.on('message', received);
      await once(ws, 'open');
      const [serverSocket] = await serverConnection;
      ws.send(
        JSON.stringify({
          type: 'auth',
          protocolVersion: 1,
          credential: TEST_CREDENTIAL,
        }),
      );
      await vi.waitFor(() =>
        expect(verifyCredential).toHaveBeenCalledTimes(attempt + 1),
      );

      const closed = once(ws, 'close');
      ws.close();
      await vi.waitFor(() =>
        expect(serverSocket.readyState).not.toBe(WebSocket.OPEN),
      );
      resolveVerification(true);
      await closed;
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(received).not.toHaveBeenCalled();
      expect(service.subscribe).not.toHaveBeenCalled();
      expect(service.open).not.toHaveBeenCalled();
    }

    const replacement = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(replacement, 'open');
    replacement.send(
      JSON.stringify({
        type: 'auth',
        protocolVersion: 1,
        credential: TEST_CREDENTIAL,
      }),
    );
    const [ack] = await once(replacement, 'message');
    expect(JSON.parse(ack.toString()).type).toBe('authenticated');
    expect(service.subscribe).toHaveBeenCalledTimes(1);

    replacement.close();
    await once(replacement, 'close');
    await closeServer(terminal, wss);
  });

  it('preserves the current open flow for a loopback socket', async () => {
    const service = {
      subscribe: vi.fn(() => vi.fn()),
      open: vi.fn(async () => ({ sessionId: 'local-session', cwd: '/tmp' })),
      close: vi.fn(),
    };
    const terminal = new TerminalWebSocketServer(service as any);
    const { port, wss } = await listeningPort(terminal);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(ws, 'open');
    const snapshotMessage = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'open', cwd: '/tmp' }));
    const [rawSnapshot] = await snapshotMessage;

    ws.close();
    await once(ws, 'close');
    await closeServer(terminal, wss);
    expect(JSON.parse(rawSnapshot.toString())).toEqual(
      expect.objectContaining({ type: 'snapshot', sessionId: 'local-session' }),
    );
  });

  it('returns the running terminal cwd only through an explicit live-CWD request', async () => {
    const service = {
      subscribe: vi.fn(() => vi.fn()),
      getCwd: vi.fn(async () => '/workspace/after-cd'),
      close: vi.fn(),
    };
    const terminal = new TerminalWebSocketServer(service as any);
    const listeners = new Map<string, (raw: Buffer) => Promise<void>>();
    const ws = {
      on: vi.fn((event: string, listener: (raw: Buffer) => Promise<void>) => {
        listeners.set(event, listener);
      }),
      send: vi.fn(),
      readyState: WebSocket.OPEN,
    };
    (terminal as any).acceptBusinessClient(ws);

    await listeners.get('message')!(
      Buffer.from(
        JSON.stringify({
          type: 'cwd',
          sessionId: 'project-a:terminal-one',
          requestId: 'request-1',
        }),
      ),
    );

    expect(service.getCwd).toHaveBeenCalledWith('project-a:terminal-one');
    expect(JSON.parse(ws.send.mock.calls[0]![0])).toEqual({
      type: 'cwd',
      requestId: 'request-1',
      cwd: '/workspace/after-cd',
    });
  });

  it('never sends terminal stderr, credentials, or paths over a WebSocket failure', async () => {
    const service = {
      subscribe: vi.fn(() => vi.fn()),
      open: vi.fn(async () => {
        throw new Error(
          'terminal stderr https://provider.example.test/private?token=secret /Users/operator/private-key',
        );
      }),
      close: vi.fn(),
    };
    const terminal = new TerminalWebSocketServer(service as any);
    const { port, wss } = await listeningPort(terminal);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(ws, 'open');
    const response = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'open', cwd: '/tmp' }));
    const [raw] = await response;

    ws.close();
    await once(ws, 'close');
    await closeServer(terminal, wss);
    const message = raw.toString();
    expect(JSON.parse(message)).toEqual(
      expect.objectContaining({
        type: 'error',
        message: 'The terminal request failed.',
        correlationId: expect.any(String),
      }),
    );
    expect(message).not.toContain('provider.example');
    expect(message).not.toContain('token=secret');
    expect(message).not.toContain('/Users/operator');
  });

  it('reports the specific degraded-terminal reason when the PTY backend is unavailable (#1244)', async () => {
    const service = {
      subscribe: vi.fn(() => vi.fn()),
      open: vi.fn(async () => {
        // The adapter's error carries a dynamic loader cause; only the
        // product-owned constant text may cross the socket.
        throw new PtyUnavailableError(
          'node-pty failed to load. Rebuild it. (cause: Failed to load native module from /Users/operator/checkout)',
        );
      }),
      close: vi.fn(),
    };
    const terminal = new TerminalWebSocketServer(service as any);
    const { port, wss } = await listeningPort(terminal);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(ws, 'open');
    const response = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'open', cwd: '/tmp' }));
    const [raw] = await response;

    ws.close();
    await once(ws, 'close');
    await closeServer(terminal, wss);
    const message = raw.toString();
    expect(JSON.parse(message)).toEqual(
      expect.objectContaining({
        type: 'error',
        code: 'terminal-unavailable',
        message: terminalPtyUnavailableReason(),
        correlationId: expect.any(String),
      }),
    );
    // Outward doctrine still holds: the dynamic loader cause stays server-side.
    expect(message).not.toContain('/Users/operator');
  });

  it('closes an unauthenticated remote socket before allocating a PTY', async () => {
    const service = {
      subscribe: vi.fn(() => vi.fn()),
      open: vi.fn(),
      close: vi.fn(),
    };
    const terminal = new (TerminalWebSocketServer as any)(
      service,
      remoteAuthOptions(),
    ) as TerminalWebSocketServer;
    const { port, wss } = await listeningPort(terminal);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const upgrade = once(ws, 'upgrade');
    await once(ws, 'open');
    const [response] = await upgrade;
    expect(response.headers).not.toHaveProperty('x-station-instance');
    expect(response.headers).not.toHaveProperty('x-station-build-sha');
    expect(response.headers).not.toHaveProperty('x-station-boot-id');
    ws.send(JSON.stringify({ type: 'open', cwd: '/tmp' }));
    const closed = await closesWithin(ws);

    if (!closed) ws.close();
    if (!closed) await once(ws, 'close');
    await closeServer(terminal, wss);
    expect(closed).toBe(true);
    expect(service.open).not.toHaveBeenCalled();
    expect(service.subscribe).not.toHaveBeenCalled();
  });

  it('accepts a valid first auth frame before opening a terminal', async () => {
    const service = {
      subscribe: vi.fn(() => vi.fn()),
      open: vi.fn(async () => ({ sessionId: 'terminal-session', cwd: '/tmp' })),
      close: vi.fn(),
    };
    const terminal = new (TerminalWebSocketServer as any)(
      service,
      remoteAuthOptions(),
    ) as TerminalWebSocketServer;
    const { port, wss } = await listeningPort(terminal);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(ws, 'open');
    const firstMessage = once(ws, 'message');
    ws.send(
      JSON.stringify({
        type: 'auth',
        protocolVersion: 1,
        credential: TEST_CREDENTIAL,
      }),
    );
    const [rawAck] = await firstMessage;
    const ack = JSON.parse(rawAck.toString());
    ws.send(JSON.stringify({ type: 'open', cwd: '/tmp' }));
    await vi.waitFor(() => expect(service.open).toHaveBeenCalledTimes(1));

    ws.close();
    await once(ws, 'close');
    await closeServer(terminal, wss);
    expect(ack).toEqual({ type: 'authenticated', protocolVersion: 1 });
    expect(service.subscribe).toHaveBeenCalledTimes(1);
  });

  it('rejects query credentials without allocating a PTY', async () => {
    const service = {
      subscribe: vi.fn(() => vi.fn()),
      open: vi.fn(),
      close: vi.fn(),
    };
    const terminal = new (TerminalWebSocketServer as any)(
      service,
      remoteAuthOptions(),
    ) as TerminalWebSocketServer;
    const { port, wss } = await listeningPort(terminal);
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/?credential=${encodeURIComponent(TEST_CREDENTIAL)}`,
    );
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'open', cwd: '/tmp' }));
    const closed = await closesWithin(ws);

    if (!closed) ws.close();
    if (!closed) await once(ws, 'close');
    await closeServer(terminal, wss);
    expect(closed).toBe(true);
    expect(service.open).not.toHaveBeenCalled();
  });

  it('bounds an idle remote auth handshake with a timeout', async () => {
    const service = {
      subscribe: vi.fn(() => vi.fn()),
      open: vi.fn(),
      close: vi.fn(),
    };
    const terminal = new (TerminalWebSocketServer as any)(
      service,
      remoteAuthOptions(),
    ) as TerminalWebSocketServer;
    const { port, wss } = await listeningPort(terminal);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(ws, 'open');
    const closed = await closesWithin(ws);

    if (!closed) ws.close();
    if (!closed) await once(ws, 'close');
    await closeServer(terminal, wss);
    expect(closed).toBe(true);
    expect(service.open).not.toHaveBeenCalled();
  });

  it('closes after a bounded number of invalid auth frames', async () => {
    const service = {
      subscribe: vi.fn(() => vi.fn()),
      open: vi.fn(),
      close: vi.fn(),
    };
    const auth = remoteAuthOptions();
    const terminal = new (TerminalWebSocketServer as any)(
      service,
      auth,
    ) as TerminalWebSocketServer;
    const { port, wss } = await listeningPort(terminal);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(ws, 'open');
    for (let attempt = 0; attempt < auth.maxAuthFailures; attempt += 1) {
      ws.send(
        JSON.stringify({
          type: 'auth',
          protocolVersion: 1,
          credential: `invalid-${attempt}`,
        }),
      );
    }
    const closed = await closesWithin(ws);

    if (!closed) ws.close();
    if (!closed) await once(ws, 'close');
    await closeServer(terminal, wss);
    expect(closed).toBe(true);
    expect(service.open).not.toHaveBeenCalled();
  });
});
