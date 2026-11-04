import {
  encodeTerminalFrame,
  TERMINAL_MAX_OUTSTANDING_OUTPUT_FRAMES,
  TERMINAL_OUTPUT,
} from '@kontourai/station-contracts/terminal-transport';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type ClientCredential,
  setClientRawEgressPolicyResolver,
} from '../client/http';
import {
  TerminalOutputSession,
  terminalOutputSocketURL,
} from '../client/terminal-output-session';

const id = '62b97fa1-b690-4d77-82b1-747dc86d3c11';
const TICKET = 'T'.repeat(43);
/** The host's ticket mint: one single-use ticket per authenticated POST. */
const ticketed = () =>
  new Response(
    JSON.stringify({ success: true, data: { ticket: TICKET, expiresAt: 1 } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
const sessions: TerminalOutputSession[] = [];
class Socket extends EventTarget {
  readyState = 0;
  protocols: string[] = [];
  binaryType = 'arraybuffer';
  sent: Record<string, unknown>[] = [];
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }
  message(value: object | ArrayBuffer) {
    this.dispatchEvent(
      new MessageEvent('message', {
        data: value instanceof ArrayBuffer ? value : JSON.stringify(value),
      }),
    );
  }
  close() {
    this.drop(1000);
  }
  drop(code: number) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code }));
  }
}
const flush = async () => {
  await vi.advanceTimersByTimeAsync(0);
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture(
  extra: Partial<ConstructorParameters<typeof TerminalOutputSession>[0]> = {},
) {
  const sockets: Socket[] = [];
  const states: string[] = [];
  const output: string[] = [];
  let current = true;
  const resolver = vi.fn(
    async (): Promise<ClientCredential> => ({
      credential: 'test-operator',
      origin: 'http://127.0.0.1:4198',
      requestAuthority: {
        apiBase: 'http://127.0.0.1:4198',
        authorityKey: 'owner-1',
        isCurrent: () => current,
      },
    }),
  );
  const session = new TerminalOutputSession({
    apiBase: 'http://127.0.0.1:4198',
    projectId: 'alpha',
    bindingKey: 'project',
    terminalId: id,
    requestScope: { apiBase: 'http://127.0.0.1:4198', authorityKey: 'owner-1' },
    resolveCredential: resolver,
    createSocket: (_url, protocols) => {
      const socket = new Socket();
      socket.protocols = protocols;
      sockets.push(socket);
      return socket;
    },
    onOutput: (bytes) => {
      output.push(new TextDecoder().decode(bytes));
    },
    onReset: () => {
      output.length = 0;
    },
    onState: (state) => states.push(state),
    ...extra,
  });
  sessions.push(session);
  return {
    session,
    sockets,
    states,
    output,
    resolver,
    revoke: () => {
      current = false;
    },
  };
}
async function authenticate(socket: Socket, replayThrough?: number) {
  socket.open();
  await flush();
  socket.message({ type: 'authenticated', protocolVersion: 1 });
  await flush();
  const attach = socket.sent[socket.sent.length - 1]!;
  socket.message({
    type: 'attached',
    channel: 1,
    requestId: attach.requestId,
    terminalId: id,
    replayThrough: replayThrough ?? attach.fromSeq,
    maxOutstandingOutputFrames: TERMINAL_MAX_OUTSTANDING_OUTPUT_FRAMES,
  });
  await flush();
}
async function ready(socket: Socket, sequence = 0) {
  socket.message({
    type: 'progress',
    channel: 1,
    sentThrough: sequence,
    replayThrough: sequence,
  });
  socket.message({ type: 'ready', channel: 1, seq: sequence });
  await flush();
}
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ticketed()),
  );
});
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  setClientRawEgressPolicyResolver(undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('terminal output session', () => {
  test('foreign-origin credentials are refused before the HTTP probe or socket', async () => {
    vi.useFakeTimers();
    const f = fixture({
      resolveCredential: () => ({
        credential: 'foreign',
        origin: 'https://other.example',
        requestAuthority: {
          apiBase: 'http://127.0.0.1:4198',
          authorityKey: 'owner-1',
          isCurrent: () => true,
        },
      }),
    });
    await expect(f.session.connect()).rejects.toMatchObject({
      code: 'authority-changed',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(f.sockets).toHaveLength(0);
  });

  test('a native HTTP transport mints the ticket; the socket never carries its bearer', async () => {
    vi.useFakeTimers();
    const transport = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      return ticketed();
    });
    const f = fixture({
      resolveCredential: () => ({
        origin: 'http://127.0.0.1:4198',
        transport,
        requestAuthority: {
          apiBase: 'http://127.0.0.1:4198',
          authorityKey: 'owner-1',
          isCurrent: () => true,
        },
      }),
    });
    const connected = f.session.connect();
    await flush();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(String(transport.mock.calls[0]![0])).toBe(
      'http://127.0.0.1:4198/api/terminal/tickets',
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(f.sockets).toHaveLength(1);
    expect(f.sockets[0].protocols).toEqual([
      'station.terminal.v1',
      `station.terminal.ticket.${TICKET}`,
    ]);
    await authenticate(f.sockets[0]);
    await ready(f.sockets[0]);
    await connected;
    expect(f.sockets[0].sent.map((item) => item.type)).toEqual([
      'attach',
      'ack',
    ]);
  });

  test('a state-notification failure settles its caller without leaving a connection timer', async () => {
    vi.useFakeTimers();
    const f = fixture({
      onState: () => {
        throw new Error('view failed');
      },
      onError: () => {
        throw new Error('notification failed');
      },
    });
    await expect(f.session.connect()).rejects.toMatchObject({
      code: 'output-failed',
    });
    expect(f.sockets).toHaveLength(0);
    expect(f.resolver).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('ready cannot skip the attached replay target', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const connected = f.session.connect();
    const rejected = expect(connected).rejects.toMatchObject({
      code: 'protocol',
    });
    await flush();
    await authenticate(f.sockets[0], 2);
    f.sockets[0].message({ type: 'ready', channel: 1, seq: 0 });
    await flush();
    await rejected;
    expect(f.output).toEqual([]);
  });

  test('an older host returns a distinct unsupported result without a socket attempt', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    const f = fixture();
    await expect(f.session.connect()).rejects.toMatchObject({
      code: 'unsupported-host',
    });
    expect(f.sockets).toHaveLength(0);
  });
  test('preserves API prefixes and never puts credentials in the endpoint', () => {
    expect(terminalOutputSocketURL('https://station.example/host/')).toBe(
      'wss://station.example/host/api/terminal/socket',
    );
    for (const base of [
      'https://x/?credential=value',
      'https://x/#value',
      'https://user:pass@x',
      'file:///tmp/x',
    ])
      expect(() => terminalOutputSocketURL(base)).toThrow();
  });

  test('a ticket admits the socket before attaching; only read/replay controls follow', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const connected = f.session.connect();
    await flush();
    const socket = f.sockets[0];
    expect(socket.protocols).toEqual([
      'station.terminal.v1',
      `station.terminal.ticket.${TICKET}`,
    ]);
    socket.open();
    await flush();
    // No credential frame: the bearer stayed on the authenticated mint.
    expect(socket.sent).toEqual([]);
    socket.message({ type: 'authenticated', protocolVersion: 1 });
    await flush();
    expect(socket.sent[0]).toMatchObject({
      type: 'attach',
      channel: 1,
      terminalId: id,
      projectId: 'alpha',
      bindingKey: 'project',
      fromSeq: 0,
    });
    socket.message({
      type: 'attached',
      channel: 1,
      requestId: socket.sent[0].requestId,
      terminalId: id,
      replayThrough: 0,
      maxOutstandingOutputFrames: TERMINAL_MAX_OUTSTANDING_OUTPUT_FRAMES,
    });
    await ready(socket);
    await connected;
    expect(f.states[f.states.length - 1]).toBe('ready');
    expect(socket.sent.map((item) => item.type)).toEqual(['attach', 'ack']);
    expect(JSON.stringify(socket.sent)).not.toContain('test-operator');
  });

  test('credits only applied output and reconnects from that cursor without duplicate rendering', async () => {
    vi.useFakeTimers();
    const applied = deferred<void>();
    const text: string[] = [];
    const f = fixture({
      onOutput: async (bytes) => {
        await applied.promise;
        text.push(new TextDecoder().decode(bytes));
      },
    });
    const connected = f.session.connect();
    await flush();
    await authenticate(f.sockets[0]);
    await ready(f.sockets[0]);
    await connected;
    const first = f.sockets[0];
    first.message(
      encodeTerminalFrame(
        TERMINAL_OUTPUT,
        1,
        1,
        new TextEncoder().encode('one'),
      ).buffer as ArrayBuffer,
    );
    await flush();
    first.drop(1006);
    const resumed = f.session.connect();
    await flush();
    expect(f.session.appliedThrough).toBe(0);
    expect(f.sockets).toHaveLength(1);
    applied.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(250);
    expect(f.sockets).toHaveLength(2);
    await authenticate(f.sockets[1]);
    expect(f.sockets[1].sent[0]).toMatchObject({
      type: 'attach',
      terminalId: id,
      fromSeq: 1,
    });
    await ready(f.sockets[1], 1);
    await resumed;
    expect(text).toEqual(['one']);
    expect(f.resolver).toHaveBeenCalledTimes(2);
  });

  test('allows a fresh reconnect budget after each successful ready', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const connected = f.session.connect();
    await flush();
    await authenticate(f.sockets[0]);
    await ready(f.sockets[0]);
    await connected;
    for (let i = 0; i < 4; i++) {
      f.sockets[i].drop(1006);
      await flush();
      await vi.advanceTimersByTimeAsync(250);
      expect(f.sockets).toHaveLength(i + 2);
      await authenticate(f.sockets[i + 1]);
      await ready(f.sockets[i + 1]);
    }
    expect(f.states[f.states.length - 1]).toBe('ready');
  });

  test('consecutive failed connections exhaust the reconnect budget', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const connected = f.session.connect();
    const rejected = expect(connected).rejects.toMatchObject({
      code: 'reconnect-exhausted',
    });
    await flush();
    for (let i = 0; i < 4; i++) {
      f.sockets[i].drop(1006);
      await flush();
      await vi.advanceTimersByTimeAsync(250);
    }
    await rejected;
    expect(f.sockets).toHaveLength(4);
  });

  test('retries a probe network failure and preserves a bounded failure', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network')));
    const f = fixture();
    const rejected = expect(f.session.connect()).rejects.toMatchObject({
      code: 'reconnect-exhausted',
    });
    await flush();
    await vi.advanceTimersByTimeAsync(750);
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(f.sockets).toHaveLength(0);
  });

  test('refuses an old host without the enforced frame capability', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const rejected = expect(f.session.connect()).rejects.toMatchObject({
      code: 'unsupported-host',
    });
    await flush();
    const socket = f.sockets[0];
    socket.open();
    socket.message({ type: 'authenticated', protocolVersion: 1 });
    await flush();
    socket.message({
      type: 'attached',
      channel: 1,
      requestId: socket.sent[0].requestId,
      terminalId: id,
      replayThrough: 0,
    });
    await flush();
    await rejected;
  });

  test('refuses a frame flood while rendering is stalled', async () => {
    vi.useFakeTimers();
    const applied = deferred<void>();
    const f = fixture({ onOutput: () => applied.promise });
    const rejected = expect(f.session.connect()).rejects.toMatchObject({
      code: 'protocol',
    });
    await flush();
    const socket = f.sockets[0];
    await authenticate(socket, 200);
    for (let i = 1; i <= TERMINAL_MAX_OUTSTANDING_OUTPUT_FRAMES + 1; i++)
      socket.message(
        encodeTerminalFrame(TERMINAL_OUTPUT, 1, i, new Uint8Array([65]))
          .buffer as ArrayBuffer,
      );
    await rejected;
    applied.resolve();
    await flush();
  });

  test('refuses a control flood while rendering is stalled', async () => {
    vi.useFakeTimers();
    const applied = deferred<void>();
    const f = fixture({ onOutput: () => applied.promise });
    const rejected = expect(f.session.connect()).rejects.toMatchObject({
      code: 'protocol',
    });
    await flush();
    const socket = f.sockets[0];
    await authenticate(socket, 1);
    socket.message(
      encodeTerminalFrame(TERMINAL_OUTPUT, 1, 1, new Uint8Array([65]))
        .buffer as ArrayBuffer,
    );
    await flush();
    for (let i = 0; i < 2 * TERMINAL_MAX_OUTSTANDING_OUTPUT_FRAMES + 9; i++)
      socket.message({
        type: 'progress',
        channel: 1,
        sentThrough: 1,
        replayThrough: 1,
      });
    await rejected;
    applied.resolve();
    await flush();
  });

  test('replay progresses for longer than five seconds without duplicating frame acknowledgements', async () => {
    vi.useFakeTimers();
    const f = fixture({
      onOutput: () => new Promise<void>((resolve) => setTimeout(resolve, 100)),
    });
    const connected = f.session.connect();
    await flush();
    const socket = f.sockets[0];
    await authenticate(socket, 60);
    for (let i = 1; i <= 60; i++)
      socket.message(
        encodeTerminalFrame(TERMINAL_OUTPUT, 1, i, new Uint8Array([65]))
          .buffer as ArrayBuffer,
      );
    socket.message({
      type: 'progress',
      channel: 1,
      sentThrough: 60,
      replayThrough: 60,
    });
    socket.message({ type: 'ready', channel: 1, seq: 60 });
    await vi.advanceTimersByTimeAsync(6100);
    await connected;
    expect(f.session.appliedThrough).toBe(60);
    expect(socket.sent.filter((item) => item.type === 'ack')).toHaveLength(60);
  });

  test('live rendering applies backpressure beyond the replay deadline and acknowledges only after apply', async () => {
    vi.useFakeTimers();
    const applied = deferred<void>();
    const onError = vi.fn();
    const f = fixture({ onOutput: () => applied.promise, onError });
    const connected = f.session.connect();
    await flush();
    const socket = f.sockets[0];
    await authenticate(socket);
    await ready(socket);
    await connected;
    socket.message(
      encodeTerminalFrame(TERMINAL_OUTPUT, 1, 1, new Uint8Array([65]))
        .buffer as ArrayBuffer,
    );
    await flush();
    await vi.advanceTimersByTimeAsync(6000);
    const stateWhileBlocked = f.states[f.states.length - 1];
    const cursorWhileBlocked = f.session.appliedThrough;
    const prematureAcknowledgements = socket.sent.filter(
      (item) => item.type === 'ack' && item.seq === 1,
    );
    applied.resolve();
    await flush();
    expect(stateWhileBlocked).toBe('ready');
    expect(cursorWhileBlocked).toBe(0);
    expect(prematureAcknowledgements).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
    expect(f.session.appliedThrough).toBe(1);
    expect(
      socket.sent.filter((item) => item.type === 'ack' && item.seq === 1),
    ).toHaveLength(1);
    await expect(f.session.connect()).resolves.toBeUndefined();
  });

  test('a probe 401 reports only to the captured current credential owner', async () => {
    vi.useFakeTimers();
    const owner = vi.fn();
    const f = fixture({
      requestScope: undefined,
      resolveCredential: () => ({
        origin: 'http://127.0.0.1:4198',
        credential: 'owned',
        onUnauthorized: owner,
      }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    await expect(f.session.connect()).rejects.toMatchObject({
      code: 'terminal-refused',
    });
    expect(owner).toHaveBeenCalledTimes(1);
  });

  test('a stale captured owner receives no 401 report after authority changes', async () => {
    vi.useFakeTimers();
    const owner = vi.fn();
    const response = deferred<Response>();
    const f = fixture({
      resolveCredential: () => ({
        origin: 'http://127.0.0.1:4198',
        credential: 'owned',
        onUnauthorized: owner,
        requestAuthority: {
          apiBase: 'http://127.0.0.1:4198',
          authorityKey: 'owner-1',
          isCurrent: () => current,
        },
      }),
    });
    let current = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => response.promise),
    );
    const rejected = expect(f.session.connect()).rejects.toMatchObject({
      code: 'authority-changed',
    });
    await flush();
    current = false;
    response.resolve(new Response(null, { status: 401 }));
    await flush();
    await rejected;
    expect(owner).not.toHaveBeenCalled();
  });

  test('empty reset acknowledges its new baseline once and ignores duplicate progress', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const connected = f.session.connect();
    await flush();
    const socket = f.sockets[0];
    await authenticate(socket);
    await ready(socket);
    await connected;
    socket.message({ type: 'reset', channel: 1, fromSeq: 8, replayThrough: 8 });
    socket.message({
      type: 'progress',
      channel: 1,
      sentThrough: 8,
      replayThrough: 8,
    });
    socket.message({
      type: 'progress',
      channel: 1,
      sentThrough: 8,
      replayThrough: 8,
    });
    socket.message({ type: 'ready', channel: 1, seq: 8 });
    await flush();
    expect(
      socket.sent.filter((item) => item.type === 'ack').map((item) => item.seq),
    ).toEqual([0, 8]);
    expect(f.states[f.states.length - 1]).toBe('ready');
  });

  test('progress for the last applied frame cannot send a late ACK across reset', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const connected = f.session.connect();
    await flush();
    const socket = f.sockets[0];
    await authenticate(socket, 1);
    socket.message(
      encodeTerminalFrame(TERMINAL_OUTPUT, 1, 1, new Uint8Array([65]))
        .buffer as ArrayBuffer,
    );
    socket.message({
      type: 'progress',
      channel: 1,
      sentThrough: 1,
      replayThrough: 1,
    });
    socket.message({ type: 'ready', channel: 1, seq: 1 });
    await flush();
    await connected;
    socket.message({ type: 'reset', channel: 1, fromSeq: 8, replayThrough: 8 });
    socket.message({
      type: 'progress',
      channel: 1,
      sentThrough: 8,
      replayThrough: 8,
    });
    socket.message({ type: 'ready', channel: 1, seq: 8 });
    await flush();
    expect(
      socket.sent.filter((item) => item.type === 'ack').map((item) => item.seq),
    ).toEqual([1, 8]);
    expect(f.states[f.states.length - 1]).toBe('ready');
  });

  test('a 4401 close before open is a terminal refusal and later connect stays failed', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const rejected = expect(f.session.connect()).rejects.toMatchObject({
      code: 'terminal-refused',
    });
    await flush();
    f.sockets[0].drop(4401);
    await rejected;
    await expect(f.session.connect()).rejects.toMatchObject({
      code: 'terminal-refused',
    });
  });

  test('clears the old renderer epoch before applying or acknowledging reset replay', async () => {
    vi.useFakeTimers();
    const cleared = deferred<void>();
    const view = ['old'];
    const f = fixture({
      fromSeq: 9,
      onReset: async () => {
        await cleared.promise;
        view.length = 0;
      },
      onOutput: (bytes) => {
        view.push(new TextDecoder().decode(bytes));
      },
    });
    const connected = f.session.connect();
    await flush();
    const socket = f.sockets[0];
    await authenticate(socket);
    socket.message({ type: 'reset', channel: 1, fromSeq: 0, replayThrough: 1 });
    socket.message(
      encodeTerminalFrame(
        TERMINAL_OUTPUT,
        1,
        1,
        new TextEncoder().encode('new'),
      ).buffer as ArrayBuffer,
    );
    await flush();
    expect(view).toEqual(['old']);
    expect(socket.sent.some((item) => item.type === 'ack')).toBe(false);
    cleared.resolve();
    await flush();
    await ready(socket, 1);
    await connected;
    expect(view).toEqual(['new']);
    expect(f.session.appliedThrough).toBe(1);
  });

  test('authority lost during rendering leaves the cursor unacknowledged and the caller rejected', async () => {
    vi.useFakeTimers();
    const applied = deferred<void>();
    const f = fixture({ onOutput: () => applied.promise });
    const connected = f.session.connect();
    const rejected = expect(connected).rejects.toMatchObject({
      code: 'authority-changed',
    });
    await flush();
    const socket = f.sockets[0];
    await authenticate(socket);
    socket.message(
      encodeTerminalFrame(TERMINAL_OUTPUT, 1, 1, new Uint8Array([65]))
        .buffer as ArrayBuffer,
    );
    await flush();
    f.revoke();
    applied.resolve();
    await flush();
    await rejected;
    expect(f.session.appliedThrough).toBe(0);
    expect(socket.sent.some((item) => item.type === 'ack')).toBe(false);
    expect(f.states[f.states.length - 1]).toBe('failed');
  });

  test('dispose settles a waiting caller and cannot start a late credential socket', async () => {
    vi.useFakeTimers();
    const credential = deferred<ClientCredential>();
    const f = fixture({ resolveCredential: () => credential.promise });
    const connected = f.session.connect();
    const rejected = expect(connected).rejects.toMatchObject({
      code: 'disposed',
    });
    f.session.dispose();
    await rejected;
    credential.resolve({ credential: 'late', origin: 'http://127.0.0.1:4198' });
    await flush();
    expect(f.sockets).toHaveLength(0);
    expect(f.states[f.states.length - 1]).toBe('disposed');
  });

  test('broker refusal occurs before credential resolution or raw socket creation', async () => {
    vi.useFakeTimers();
    setClientRawEgressPolicyResolver(() => ({
      kind: 'broker',
      apiBase: 'http://127.0.0.1:4198',
      connectionId: 'broker',
      activationEpoch: '1',
      authorityKey: 'owner-1',
      isCurrent: () => true,
    }));
    const f = fixture();
    await expect(f.session.connect()).rejects.toMatchObject({
      code: 'raw-egress-unavailable',
    });
    expect(f.resolver).not.toHaveBeenCalled();
    expect(f.sockets).toHaveLength(0);
  });

  test('credential resolution has the same finite connection deadline', async () => {
    vi.useFakeTimers();
    const credential = deferred<ClientCredential>();
    const f = fixture({ resolveCredential: () => credential.promise });
    const connected = f.session.connect();
    const rejected = expect(connected).rejects.toMatchObject({
      code: 'connection-timeout',
    });
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    credential.resolve({ credential: 'late', origin: 'http://127.0.0.1:4198' });
    await flush();
    expect(f.sockets).toHaveLength(0);
  });
});
