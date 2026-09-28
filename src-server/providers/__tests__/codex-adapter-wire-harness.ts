/**
 * A `CodexAdapter` driven through a fake app-server child: lines written to
 * its stdout reach the adapter's real reader, and every reply the adapter
 * writes is kept on its stdin. Shared by the wire-level Codex tests (#562,
 * #2880) so each asserts on what actually crosses the pipe.
 */
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
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

export class FakeCodexProcess extends EventEmitter {
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

export const THREAD = 'thread-codex-wire';

export async function flushIo(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export async function withTimeout<T>(
  promise: Promise<T>,
  label: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out: ${label}`)), 1_000),
    ),
  ]);
}

/** Write one line on the fake child's stdout, as Codex would. */
export async function emit(process: FakeCodexProcess, message: unknown) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
  await flushIo();
}

/** Every stdin line whose `id` is exactly (value and type) `id`. */
export function repliesTo(process: FakeCodexProcess, id: string | number) {
  return process.stdin.lines
    .map((line) => JSON.parse(line))
    .filter((line) => line.id === id && !('method' in line));
}

export async function waitFor<T>(
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

export async function startedAdapter() {
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

export function commandApproval(id: string | number, itemId = 'cmd-1') {
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

export async function openedRequestId(events: any[], nth = 0): Promise<string> {
  const opened = await waitFor(
    () => events.filter((event) => event.method === 'request.opened')[nth],
    'request.opened',
  );
  return opened.requestId;
}
