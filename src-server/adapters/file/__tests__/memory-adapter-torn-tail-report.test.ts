/**
 * #3564 — a read that finds a torn transcript tail reports it as a typed
 * recovery event, not only as a log line.
 *
 * Consumer: `readStoredMessages`, the one path behind
 * `FileMemoryAdapter.getMessages`, hands the event to the
 * `station.memory.transcript_tail_recoveries` counter (OTel, what operators
 * query) and logs it. VoltAgent's `getMessages` returns only messages, so the
 * counter is the surface a caller of that interface can observe.
 *
 * Fixtures are the bytes an interrupted append leaves: a prefix of
 * `json + "\n"`, written raw with no terminator.
 */

import {
  appendFile as appendRaw,
  mkdir,
  readdir,
  readFile,
  rm,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import type { UIMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

const loggerCalls: Array<{ level: string; msg: string; context: unknown }> = [];

vi.mock('../../../utils/logger.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../utils/logger.js')>();
  return {
    ...actual,
    createLogger: (
      options: Parameters<typeof actual.createLogger>[0],
    ): ReturnType<typeof actual.createLogger> => {
      const real = actual.createLogger(options);
      if (options.name !== 'memory-adapter-messages') return real;
      return {
        ...real,
        warn: (msg: string, context?: unknown) => {
          loggerCalls.push({ level: 'warn', msg, context });
          real.warn(msg, context);
        },
        error: (msg: string, context?: unknown) => {
          loggerCalls.push({ level: 'error', msg, context });
          real.error(msg, context);
        },
      };
    },
  };
});

const { FileMemoryAdapter } = await import('../memory-adapter.js');
const { withFileMutation } = await import(
  '../memory-adapter-mutation-queue.js'
);
const { transcriptTailRecoveries } = await import(
  '../../../telemetry/metrics.js'
);

const USER = 'u1';
const CONVERSATION = 'c1';

function message(id: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text: id }] } as UIMessage;
}

describe('a read reports a torn transcript tail (#3564)', () => {
  const tempDir = trackTempDirs();
  let adapter: InstanceType<typeof FileMemoryAdapter>;
  let counted: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    loggerCalls.length = 0;
    counted = vi.spyOn(transcriptTailRecoveries, 'add');
    adapter = new FileMemoryAdapter({
      projectHomeDir: tempDir('station-memory-torn-report-'),
    });
    await adapter.createConversation({
      id: CONVERSATION,
      resourceId: 'agent-a',
      userId: USER,
      title: 'T',
      metadata: {},
    });
  });

  afterEach(() => {
    counted.mockRestore();
  });

  async function messagesPath(): Promise<string> {
    const internals = adapter as unknown as {
      paths: { getMessagesPath(r: string, c: string): string };
    };
    return internals.paths.getMessagesPath('agent-a', CONVERSATION);
  }

  test('a fragment at the end is reported as an observed tail, and nothing is rewritten', async () => {
    await adapter.addMessage(message('a'), USER, CONVERSATION);
    const path = await messagesPath();
    const torn = '{"id":"b","role":"user","parts":[{"type":"te';
    await appendRaw(path, torn, 'utf-8');
    const before = await readFile(path, 'utf-8');
    counted.mockClear();

    const read = await adapter.getMessages(USER, CONVERSATION);

    expect(read.map((m) => m.id)).toEqual(['a']);
    expect(counted).toHaveBeenCalledTimes(1);
    expect(counted).toHaveBeenCalledWith(1, { kind: 'observed' });
    const event = loggerCalls.find(
      (call) => call.level === 'warn' && call.msg.includes('fragment'),
    );
    expect(event?.context).toEqual({
      recovery: {
        kind: 'observed',
        path,
        offset: before.length - torn.length,
        bytes: torn.length,
      },
    });
    // A read repairs nothing: the next append owns the quarantine.
    expect(await readFile(path, 'utf-8')).toBe(before);
    expect(await readdir(dirname(path))).not.toContain('c1.ndjson.torn');
  });

  test('the next append quarantines what the read reported, and the report stops', async () => {
    await adapter.addMessage(message('a'), USER, CONVERSATION);
    await appendRaw(await messagesPath(), '{"id":"b","ro', 'utf-8');
    await adapter.getMessages(USER, CONVERSATION);
    counted.mockClear();

    await adapter.addMessage(message('c'), USER, CONVERSATION);
    expect(counted).toHaveBeenCalledWith(1, { kind: 'quarantined' });
    counted.mockClear();

    const read = await adapter.getMessages(USER, CONVERSATION);
    expect(read.map((m) => m.id)).toEqual(['a', 'c']);
    expect(counted).not.toHaveBeenCalled();
  });

  test('a whole record missing only its newline is read, not reported', async () => {
    await adapter.addMessage(message('a'), USER, CONVERSATION);
    await appendRaw(
      await messagesPath(),
      JSON.stringify(message('b')),
      'utf-8',
    );
    counted.mockClear();

    const read = await adapter.getMessages(USER, CONVERSATION);

    expect(read.map((m) => m.id)).toEqual(['a', 'b']);
    expect(counted).not.toHaveBeenCalled();
  });

  test('an unparseable line in the middle is not a torn tail', async () => {
    await adapter.addMessage(message('a'), USER, CONVERSATION);
    await appendRaw(await messagesPath(), 'not json\n', 'utf-8');
    await adapter.addMessage(message('c'), USER, CONVERSATION);
    counted.mockClear();

    const read = await adapter.getMessages(USER, CONVERSATION);

    expect(read.map((m) => m.id)).toEqual(['a', 'c']);
    expect(counted).not.toHaveBeenCalled();
  });

  test('a tail check that hits an fs error does not fail the read', async () => {
    await adapter.addMessage(message('a'), USER, CONVERSATION);
    const path = await messagesPath();
    await appendRaw(path, '{"id":"b","role":"us', 'utf-8');
    counted.mockClear();

    // The file is replaced under the reader between its parse and the
    // queued re-check, as another process truncating or swapping it would.
    // The directory opens and stats, then fails the first read (EISDIR), the
    // same class of error as the short read of a truncation.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held: () => void = () => {};
    const holding = new Promise<void>((resolve) => {
      held = resolve;
    });
    const swapper = withFileMutation(path, async () => {
      held();
      await gate;
      await rm(path);
      await mkdir(path);
    });
    await holding;

    const reading = adapter.getMessages(USER, CONVERSATION);
    await vi.waitFor(() =>
      expect(
        loggerCalls.some(
          (call) =>
            call.level === 'error' && call.msg === 'Failed to parse message',
        ),
      ).toBe(true),
    );
    release();
    await swapper;

    expect((await reading).map((m) => m.id)).toEqual(['a']);
    expect(counted).not.toHaveBeenCalled();
  });

  test('an append still being written is not reported as torn', async () => {
    await adapter.addMessage(message('a'), USER, CONVERSATION);
    const path = await messagesPath();
    const record = JSON.stringify(message('b'));
    const half = Math.floor(record.length / 2);
    counted.mockClear();

    // An append mid-flight: half the bytes are on disk and the writer still
    // holds the path's queue slot, as `appendMessageRecords` does.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fragmentWritten: () => void = () => {};
    const written = new Promise<void>((resolve) => {
      fragmentWritten = resolve;
    });
    const inFlight = withFileMutation(path, async () => {
      await appendRaw(path, record.slice(0, half), 'utf-8');
      fragmentWritten();
      await gate;
      await appendRaw(path, `${record.slice(half)}\n`, 'utf-8');
    });
    await written;

    const reading = adapter.getMessages(USER, CONVERSATION);
    // The reader has parsed the fragment and failed on it; only now does the
    // writer finish.
    await vi.waitFor(() =>
      expect(
        loggerCalls.some(
          (call) =>
            call.level === 'error' && call.msg === 'Failed to parse message',
        ),
      ).toBe(true),
    );
    release();
    await inFlight;
    await reading;

    expect(counted).not.toHaveBeenCalled();
    expect(
      (await adapter.getMessages(USER, CONVERSATION)).map((m) => m.id),
    ).toEqual(['a', 'b']);
  });
});
