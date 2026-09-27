/**
 * #562: a JSON-RPC reply must carry the peer's request id exactly as it was
 * sent — value AND type. Codex issues its server requests (approvals) with
 * numeric ids and silently drops a reply whose id is `"0"` for request `0`,
 * so an approval Station recorded as resolved never reached the engine and
 * the delegated task stalled in `running`.
 *
 * Every case drives the real `CodexAdapter` through its child's stdout and
 * reads the reply off its stdin, asserting the parsed id's value and
 * `typeof`. The id table covers numeric zero, a non-zero number, an ordinary
 * string, and a numeric-looking string (which must stay a string).
 */
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { CodexAdapter } from '../adapters/codex-adapter.js';

class FakeWritable extends Writable {
  readonly lines: string[] = [];

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) this.lines.push(line);
    }
    callback();
  }
}

class FakeCodexProcess extends EventEmitter {
  readonly stdin = new FakeWritable();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor() {
    super();
    this.stdout.setEncoding('utf8');
    this.stderr.setEncoding('utf8');
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true;
    this.signalCode = signal;
    this.emit('exit', 0);
    return true;
  }
}

const THREAD = 'thread-rpc-id';

async function flushIo(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out: ${label}`)), 1_000),
    ),
  ]);
}

/** Write one line on the fake child's stdout, as Codex would. */
async function emit(process: FakeCodexProcess, message: unknown) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
  await flushIo();
}

/** Every stdin line whose `id` is exactly (value and type) `id`. */
function repliesTo(process: FakeCodexProcess, id: string | number) {
  return process.stdin.lines
    .map((line) => JSON.parse(line))
    .filter((line) => line.id === id && !('method' in line));
}

async function waitFor<T>(
  read: () => T | undefined,
  label: string,
): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const value = read();
    if (value !== undefined) return value;
    await flushIo();
  }
  throw new Error(`Never observed: ${label}`);
}

async function startedAdapter() {
  const process = new FakeCodexProcess();
  const adapter = new CodexAdapter({ processFactory: () => process as never });
  const events: any[] = [];
  const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
  void (async () => {
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      events.push(next.value);
    }
  })();
  const session = adapter.startSession({
    provider: 'codex',
    threadId: THREAD,
    cwd: '/tmp/project',
  });
  await flushIo();
  await emit(process, { id: '1', result: { userAgent: 'test' } });
  await emit(process, { id: '2', result: { thread: { id: 'codex-thread' } } });
  await withTimeout(session, 'startSession');
  const turn = adapter.sendTurn({ threadId: THREAD, input: 'go' });
  await flushIo();
  await emit(process, { id: '3', result: { turn: { id: 'turn-1' } } });
  await withTimeout(turn, 'sendTurn');
  return { adapter, process, events };
}

function commandApproval(id: string | number, itemId = 'cmd-1') {
  return {
    id,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'codex-thread',
      turnId: 'turn-1',
      itemId,
      command: 'touch probe.txt',
    },
  };
}

async function openedRequestId(events: any[], nth = 0): Promise<string> {
  const opened = await waitFor(
    () => events.filter((event) => event.method === 'request.opened')[nth],
    'request.opened',
  );
  return opened.requestId;
}

const IDS: Array<[string, string | number]> = [
  ['numeric zero', 0],
  ['non-zero number', 7],
  ['string', 'approval-1'],
  ['numeric-looking string', '0'],
];

describe('#562: Codex JSON-RPC replies echo the request id with its type', () => {
  test.each(IDS)(
    'respond accept answers a %s id unchanged',
    async (_name, id) => {
      const { adapter, process, events } = await startedAdapter();
      await emit(process, commandApproval(id));
      const requestId = await openedRequestId(events);

      await adapter.respondToRequest(THREAD, requestId, 'accept');

      const [reply] = repliesTo(process, id);
      expect(reply).toEqual({
        jsonrpc: '2.0',
        id,
        result: { decision: 'accept' },
      });
      expect(typeof reply.id).toBe(typeof id);
      await adapter.stopAll();
    },
  );

  test.each(IDS)(
    'respond decline answers a %s id unchanged',
    async (_name, id) => {
      const { adapter, process, events } = await startedAdapter();
      await emit(process, commandApproval(id));
      const requestId = await openedRequestId(events);

      await adapter.respondToRequest(THREAD, requestId, 'decline');

      const [reply] = repliesTo(process, id);
      expect(reply).toEqual({
        jsonrpc: '2.0',
        id,
        result: { decision: 'decline' },
      });
      expect(typeof reply.id).toBe(typeof id);
      await adapter.stopAll();
    },
  );

  test.each(IDS)(
    'a session-grant auto-approval answers a %s id unchanged',
    async (_name, id) => {
      const { adapter, process, events } = await startedAdapter();
      // Seed the grant with a distinct id so only the auto-approval can
      // produce a reply carrying `id`.
      await emit(process, commandApproval('grant-seed', 'cmd-seed'));
      const seedRequestId = await openedRequestId(events);
      await adapter.respondToRequest(THREAD, seedRequestId, 'acceptForSession');

      await emit(process, commandApproval(id, 'cmd-2'));

      const reply = await waitFor(
        () => repliesTo(process, id)[0],
        'auto-approval reply',
      );
      expect(reply).toEqual({
        jsonrpc: '2.0',
        id,
        result: { decision: 'accept' },
      });
      expect(typeof reply.id).toBe(typeof id);
      // Auto-approved: no second prompt was opened.
      expect(
        events.filter((event) => event.method === 'request.opened'),
      ).toHaveLength(1);
      await adapter.stopAll();
    },
  );

  test.each(IDS)(
    'an interrupt cancels an open approval (#2316) on a %s id unchanged',
    async (_name, id) => {
      const { adapter, process, events } = await startedAdapter();
      await emit(process, commandApproval(id));
      await openedRequestId(events);

      const interrupt = adapter.interruptTurn(THREAD, 'turn-1');
      await flushIo();
      const interruptRpc = await waitFor(
        () =>
          process.stdin.lines
            .map((line) => JSON.parse(line))
            .find((line) => line.method === 'turn/interrupt'),
        'turn/interrupt',
      );
      await emit(process, { id: interruptRpc.id, result: {} });
      await withTimeout(interrupt, 'interruptTurn');

      const [reply] = repliesTo(process, id);
      expect(reply).toEqual({
        jsonrpc: '2.0',
        id,
        result: { decision: 'cancel' },
      });
      expect(typeof reply.id).toBe(typeof id);
      await adapter.stopAll();
    },
  );

  test.each(IDS)(
    'an unsupported server request is refused on a %s id unchanged',
    async (_name, id) => {
      const { adapter, process } = await startedAdapter();
      await emit(process, {
        id,
        method: 'station/test/unsupportedRequest',
        params: {},
      });

      const [reply] = repliesTo(process, id);
      expect(reply).toMatchObject({
        jsonrpc: '2.0',
        id,
        error: { code: -32601 },
      });
      expect(typeof reply.id).toBe(typeof id);
      await adapter.stopAll();
    },
  );

  test('a numeric id never settles a pending Station request with the same digits', async () => {
    const process = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => process as never,
    });
    let settled = false;
    const session = adapter
      .startSession({ provider: 'codex', threadId: THREAD, cwd: '/tmp/p' })
      .finally(() => {
        settled = true;
      });
    await flushIo();
    // Station's `initialize` went out as id "1". A numeric 1 is a different
    // JSON-RPC id and must not be taken as its reply.
    const initialize = JSON.parse(process.stdin.lines[0]);
    expect(initialize).toMatchObject({ id: '1', method: 'initialize' });
    await emit(process, { id: 1, result: { userAgent: 'wrong-id' } });
    await flushIo();
    expect(
      process.stdin.lines
        .map((line) => JSON.parse(line))
        .some((line) => line.method === 'thread/start'),
    ).toBe(false);
    expect(settled).toBe(false);

    await emit(process, { id: '1', result: { userAgent: 'test' } });
    await emit(process, { id: '2', result: { thread: { id: 'codex-thread' } } });
    await withTimeout(session, 'startSession');
    await adapter.stopAll();
  });
});
