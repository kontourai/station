/**
 * The Codex app-server writes newline-delimited JSON-RPC, and serde_json
 * leaves U+2028/U+2029 raw inside strings. `node:readline` treats both as line
 * ends, so a message carrying one was split into two unparseable fragments
 * and silently lost. Every case drives the real `CodexAdapter` through its
 * child's stdout as raw bytes (no stream encoding, like a real child pipe)
 * and reads replies off its stdin.
 */
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { CodexAdapter } from '../adapters/codex-adapter.js';

const LS = ' ';
const PS = ' ';

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
  // No setEncoding: Buffers reach the adapter's framing exactly as a child
  // process pipe delivers them, so a chunk can end mid-character.
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signalCode = signal;
    this.emit('exit', 0);
    return true;
  }
}

const THREAD = 'thread-line-separators';

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

/** The bytes Codex would write: `JSON.stringify` keeps U+2028/U+2029 raw. */
function frame(message: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
}

async function emit(process: FakeCodexProcess, message: unknown) {
  process.stdout.write(frame(message));
  await flushIo();
}

/** Writes `bytes` in the given pieces, yielding to the event loop between. */
async function emitPieces(process: FakeCodexProcess, pieces: Buffer[]) {
  for (const piece of pieces) {
    process.stdout.write(piece);
    await flushIo();
  }
}

/** Splits `bytes` inside the UTF-8 encoding of the first `char`. */
function splitInsideChar(bytes: Buffer, char: string): [Buffer, Buffer] {
  const at = bytes.indexOf(Buffer.from(char, 'utf8'));
  expect(at).toBeGreaterThan(0);
  // U+2028/U+2029 encode as E2 80 A8 / E2 80 A9; cut after the first byte.
  return [bytes.subarray(0, at + 1), bytes.subarray(at + 1)];
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

describe('Codex stdio framing keeps U+2028/U+2029 inside JSON strings', () => {
  test('a command approval whose text carries U+2028 opens and is answered', async () => {
    const { adapter, process, events } = await startedAdapter();
    const command = `printf 'a${LS}b'`;
    const reason = `Line one${LS}line two${PS}para`;
    const bytes = frame({
      id: 77,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'codex-thread',
        turnId: 'turn-1',
        itemId: 'cmd-ls',
        command,
        reason,
      },
    });
    // One chunk ends inside the U+2028 encoding, so neither half is a line.
    await emitPieces(process, splitInsideChar(bytes, LS));

    const opened = await waitFor(
      () => events.find((event) => event.method === 'request.opened'),
      'request.opened',
    );
    expect(opened.description).toBe(reason);
    expect(JSON.stringify(opened)).toContain(command);
    expect(
      events.some(
        (event) =>
          event.method === 'runtime.warning' && event.code !== 'codex-stderr',
      ),
    ).toBe(false);

    await adapter.respondToRequest(THREAD, opened.requestId, 'accept');
    const reply = await waitFor(
      () =>
        process.stdin.lines
          .map((line) => JSON.parse(line))
          .find((message) => message.id === 77),
      'approval reply',
    );
    expect(reply.result).toEqual({ decision: 'accept' });
  });

  test('an agent message delta and the turn terminal survive mid-character and mid-line chunks', async () => {
    const { process, events } = await startedAdapter();
    const delta = `before${LS}middle${PS}after`;
    const deltaBytes = frame({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'codex-thread',
        turnId: 'turn-1',
        itemId: 'msg-1',
        delta,
      },
    });
    const completedBytes = frame({
      method: 'turn/completed',
      params: {
        threadId: 'codex-thread',
        turn: {
          id: 'turn-1',
          status: 'completed',
          items: [],
          error: null,
          note: `done${PS}`,
        },
      },
    });
    const [deltaHead, deltaTail] = splitInsideChar(deltaBytes, PS);
    const [completedHead, completedTail] = splitInsideChar(completedBytes, PS);
    // deltaTail and completedHead share a chunk: one line ends mid-chunk and
    // the next begins in it, then ends inside a split character.
    await emitPieces(process, [
      deltaHead,
      Buffer.concat([deltaTail, completedHead]),
      completedTail,
    ]);

    const deltaEvent = await waitFor(
      () => events.find((event) => event.method === 'content.text-delta'),
      'content.text-delta',
    );
    expect(deltaEvent).toMatchObject({ itemId: 'msg-1', delta });
    // The terminal carries the accumulated output the durable record keeps.
    expect(
      await waitFor(
        () => events.find((event) => event.method === 'turn.completed'),
        'turn.completed',
      ),
    ).toMatchObject({ turnId: 'turn-1', outputText: delta });
    expect(
      events.filter(
        (event) =>
          event.method === 'runtime.warning' && event.code !== 'codex-stderr',
      ),
    ).toEqual([]);
  });

  test('model/list keeps a display name carrying U+2028', async () => {
    const process = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => process as never,
    });
    const models = adapter.listModels();
    await flushIo();
    await emit(process, { id: '1', result: { userAgent: 'test' } });
    const listBytes = frame({
      id: '2',
      result: {
        data: [{ model: 'gpt-x', displayName: `GPT${LS}X` }],
        nextCursor: null,
      },
    });
    await emitPieces(process, splitInsideChar(listBytes, LS));
    await expect(withTimeout(models, 'listModels')).resolves.toEqual([
      { id: 'gpt-x', name: `GPT${LS}X`, originalId: 'gpt-x' },
    ]);
  });
});
