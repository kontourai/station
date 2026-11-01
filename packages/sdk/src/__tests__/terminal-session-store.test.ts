import {
  decodeTerminalFrame,
  encodeTerminalFrame,
  TERMINAL_MAX_OUTSTANDING_OUTPUT_FRAMES,
  TERMINAL_OUTPUT,
} from '@kontourai/station-contracts/terminal-transport';
import { afterEach, expect, test, vi } from 'vitest';
import { setClientRawEgressPolicyResolver } from '../client/http';
import {
  TerminalSessionError,
  TerminalSessionStore,
} from '../client/terminal-session-store';

const id = '62b97fa1-b690-4d77-82b1-747dc86d3c11';
const target = { projectId: 'alpha', bindingKey: 'project' };

class Socket extends EventTarget {
  readyState = 0;
  binaryType = 'arraybuffer';
  sent: (Record<string, unknown> | Uint8Array)[] = [];
  constructor(readonly protocols: string[]) {
    super();
  }
  send(value: string | Uint8Array) {
    this.sent.push(typeof value === 'string' ? JSON.parse(value) : value);
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
    this.message({ type: 'authenticated', protocolVersion: 1 });
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
  controls() {
    return this.sent.filter(
      (item): item is Record<string, unknown> => !(item instanceof Uint8Array),
    );
  }
  inputs() {
    return this.sent
      .filter((item): item is Uint8Array => item instanceof Uint8Array)
      .map((item) => {
        const frame = decodeTerminalFrame(item);
        return { seq: frame.seq, text: new TextDecoder().decode(frame.data) };
      });
  }
}

const stores: TerminalSessionStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  setClientRawEgressPolicyResolver(undefined);
  vi.useRealTimers();
});

function fixture(ticket: () => Promise<{ ticket: string; expiresAt: number }>) {
  const sockets: Socket[] = [];
  const frames: (() => void)[] = [];
  const store = new TerminalSessionStore({
    apiBase: 'http://127.0.0.1:4198/prefix',
    requestTicket: ticket,
    createSocket: (_url, protocols) => {
      const socket = new Socket(protocols);
      sockets.push(socket);
      return socket;
    },
    scheduleFrame: (callback) => frames.push(callback),
    maxBufferedBytes: 8,
  });
  stores.push(store);
  return {
    store,
    sockets,
    frame: () => {
      for (const callback of frames.splice(0)) callback();
    },
  };
}
const ticket = async () => ({ ticket: 'T'.repeat(43), expiresAt: 1 });
const flush = () => vi.advanceTimersByTimeAsync(0);

function attachedReady(socket: Socket, replayThrough = 0) {
  const command = socket.controls().slice(-1)[0]!;
  socket.message({
    type: 'attached',
    requestId: command.requestId,
    channel: command.channel,
    terminalId: id,
    status: 'running',
    replayThrough,
    readOnly: false,
    maxOutstandingOutputFrames: TERMINAL_MAX_OUTSTANDING_OUTPUT_FRAMES,
  });
  socket.message({
    type: 'ready',
    channel: command.channel,
    seq: replayThrough,
  });
  return command.channel as number;
}
function output(socket: Socket, channel: number, seq: number, text: string) {
  socket.message(
    encodeTerminalFrame(
      TERMINAL_OUTPUT,
      channel,
      seq,
      new TextEncoder().encode(text),
    ).buffer as ArrayBuffer,
  );
}

test('input is coalesced per frame, held until ready, and never resent after a drop', async () => {
  vi.useFakeTimers();
  const f = fixture(ticket);
  const session = f.store.open(target, { cols: 80, rows: 24 });
  await flush();
  const first = f.sockets[0]!;
  first.open();
  session.write('a');
  session.write('b');
  f.frame();
  // Not ready yet: nothing typed reaches the socket.
  expect(first.inputs()).toEqual([]);
  const channel = attachedReady(first);
  f.frame();
  expect(first.inputs()).toEqual([{ seq: 1, text: 'ab' }]);
  output(first, channel, 1, 'out');
  first.drop(1006);
  expect(session.state).toBe('reconnecting');
  session.write('c');
  await vi.advanceTimersByTimeAsync(250);
  const second = f.sockets[1]!;
  second.open();
  // Resumes the same session from its applied sequence on a new channel.
  expect(second.controls().slice(-1)[0]).toMatchObject({
    type: 'attach',
    terminalId: id,
    fromSeq: 1,
  });
  attachedReady(second, 1);
  f.frame();
  // Only input never sent before is delivered, from sequence 1 again.
  expect(second.inputs()).toEqual([{ seq: 1, text: 'c' }]);
});

test('an open interrupted before its acknowledgement fails instead of opening a second shell', async () => {
  vi.useFakeTimers();
  const f = fixture(ticket);
  const session = f.store.open(target, { cols: 80, rows: 24 });
  await flush();
  f.sockets[0]!.open();
  expect(f.sockets[0]!.controls().slice(-1)[0]).toMatchObject({ type: 'open' });
  f.sockets[0]!.drop(1006);
  await vi.advanceTimersByTimeAsync(250);
  f.sockets[1]?.open();
  expect(session.state).toBe('failed');
  expect(session.error?.code).toBe('connection-lost');
  expect(
    (f.sockets[1]?.controls() ?? []).some((item) => item.type === 'open'),
  ).toBe(false);
});

test('resize is latest-wins and a late subscriber receives bounded earlier output', async () => {
  vi.useFakeTimers();
  const f = fixture(ticket);
  const session = f.store.attach(target, id);
  await flush();
  const socket = f.sockets[0]!;
  socket.open();
  const channel = attachedReady(socket);
  session.resize(90, 30);
  session.resize(100, 40);
  f.frame();
  expect(
    socket.controls().filter((item) => item.type === 'resize'),
  ).toMatchObject([{ cols: 100, rows: 40 }]);
  output(socket, channel, 1, '12345');
  output(socket, channel, 2, '6789');
  const seen: string[] = [];
  session.subscribe({
    output: (data) => seen.push(new TextDecoder().decode(data)),
  });
  // maxBufferedBytes is 8: the oldest chunk was dropped.
  expect(seen).toEqual(['6789']);
  // A reset clears the buffer and tells the view.
  const reset = vi.fn();
  session.subscribe({ reset });
  socket.message({ type: 'reset', channel, fromSeq: 10, replayThrough: 10 });
  expect(reset).toHaveBeenCalledOnce();
  const late: string[] = [];
  session.subscribe({
    output: (data) => late.push(new TextDecoder().decode(data)),
  });
  expect(late).toEqual([]);
  // Each applied frame is acknowledged; the reset baseline too.
  expect(
    socket
      .controls()
      .filter((item) => item.type === 'ack')
      .map((item) => item.seq),
  ).toEqual([0, 1, 2, 10]);
});

test('a read-only session refuses input locally', async () => {
  vi.useFakeTimers();
  const f = fixture(ticket);
  const session = f.store.attach(target, id);
  await flush();
  const socket = f.sockets[0]!;
  socket.open();
  const command = socket.controls().slice(-1)[0]!;
  socket.message({
    type: 'attached',
    requestId: command.requestId,
    channel: command.channel,
    terminalId: id,
    status: 'running',
    replayThrough: 0,
    readOnly: true,
    maxOutstandingOutputFrames: TERMINAL_MAX_OUTSTANDING_OUTPUT_FRAMES,
  });
  expect(session.readOnly).toBe(true);
  expect(session.write('ls')).toBe(false);
});

test('a refused ticket stops every session without retrying; a broker route never dials', async () => {
  vi.useFakeTimers();
  const refused = fixture(async () => {
    throw new TerminalSessionError('refused');
  });
  const session = refused.store.open(target, { cols: 80, rows: 24 });
  await flush();
  expect(session.state).toBe('failed');
  expect(session.error?.code).toBe('refused');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(refused.sockets).toHaveLength(0);

  setClientRawEgressPolicyResolver(() => ({
    kind: 'broker',
    apiBase: 'http://127.0.0.1:4198/prefix',
    connectionId: 'broker-1',
    activationEpoch: '1',
    isCurrent: () => true,
  }));
  const requestTicket = vi.fn(ticket);
  const broker = fixture(requestTicket);
  const brokered = broker.store.open(target, { cols: 80, rows: 24 });
  await flush();
  expect(brokered.error?.code).toBe('raw-egress-unavailable');
  expect(requestTicket).not.toHaveBeenCalled();
  expect(broker.sockets).toHaveLength(0);
});

test('the ticket rides a subprotocol and the socket keeps the API prefix', async () => {
  vi.useFakeTimers();
  const urls: string[] = [];
  const store = new TerminalSessionStore({
    apiBase: 'https://phone.example.ts.net/station/',
    requestTicket: ticket,
    createSocket: (url, protocols) => {
      urls.push(url);
      return new Socket(protocols);
    },
  });
  stores.push(store);
  store.attach(target, id);
  await flush();
  expect(urls).toEqual([
    'wss://phone.example.ts.net/station/api/terminal/socket',
  ]);
});
