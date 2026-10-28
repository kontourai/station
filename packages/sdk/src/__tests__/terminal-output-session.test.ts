import {
  encodeTerminalFrame,
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
const sessions: TerminalOutputSession[] = [];
class Socket extends EventTarget {
  readyState = 0;
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
    createSocket: () => {
      const socket = new Socket();
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
  const attach = socket.sent.at(-1)!;
  socket.message({
    type: 'attached',
    channel: 1,
    requestId: attach.requestId,
    terminalId: id,
    replayThrough: replayThrough ?? attach.fromSeq,
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
    vi.fn(async () => new Response(null, { status: 204 })),
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

  test('a native HTTP transport cannot silently fall back to a raw credential socket', async () => {
    vi.useFakeTimers();
    const transport = vi.fn(async () => new Response());
    const f = fixture({
      resolveCredential: () => ({
        credential: 'not-a-raw-fallback',
        origin: 'http://127.0.0.1:4198',
        transport,
      }),
    });
    await expect(f.session.connect()).rejects.toMatchObject({
      code: 'credential-unavailable',
    });
    expect(transport).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(f.sockets).toHaveLength(0);
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

  test('loopback authenticates before attaching and sends only read/replay controls', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const connected = f.session.connect();
    await flush();
    const socket = f.sockets[0];
    socket.open();
    await flush();
    expect(socket.sent).toEqual([
      { type: 'auth', protocolVersion: 1, credential: 'test-operator' },
    ]);
    socket.message({ type: 'authenticated', protocolVersion: 1 });
    await flush();
    expect(socket.sent[1]).toMatchObject({
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
      requestId: socket.sent[1].requestId,
      terminalId: id,
      replayThrough: 0,
    });
    await ready(socket);
    await connected;
    expect(f.states.at(-1)).toBe('ready');
    expect(socket.sent.map((item) => item.type)).toEqual([
      'auth',
      'attach',
      'ack',
    ]);
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
    expect(f.sockets[1].sent[0]).toMatchObject({ type: 'auth' });
    expect(f.sockets[1].sent[1]).toMatchObject({
      type: 'attach',
      terminalId: id,
      fromSeq: 1,
    });
    await ready(f.sockets[1], 1);
    await resumed;
    expect(text).toEqual(['one']);
    expect(f.resolver).toHaveBeenCalledTimes(2);
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
    expect(f.states.at(-1)).toBe('failed');
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
    expect(f.states.at(-1)).toBe('disposed');
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
      code: 'credential-unavailable',
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
