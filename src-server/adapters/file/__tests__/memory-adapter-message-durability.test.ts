/**
 * #3564 — a transcript append lands whole or leaves the file readable, and a
 * whole-file rewrite is durable once it returns.
 *
 * Separate file because it mocks `node:fs/promises` and the shared directory
 * fsync helper, and a module mock is file-scoped. Every mock here passes
 * through to the real filesystem and only RECORDS what the module asked for,
 * so the torn-tail cases below exercise real bytes on disk.
 *
 * What a crash leaves behind is simulated directly rather than inferred:
 *
 * - A torn append is a prefix of `json + "\n"`. It is written into the
 *   transcript as raw bytes with no trailing newline, which is exactly the
 *   state an interrupted `write(2)` or a power loss leaves.
 * - A crash during a rewrite is a `rename` that never happens AND a cleanup
 *   that never runs: a dead process does not reach its `catch`.
 *
 * Durability itself (bytes surviving power loss) is not observable from a
 * test, so the fsync contract is pinned by recording the calls on the fs
 * layer the module actually uses, in order.
 */

import { readdirSync, statSync } from 'node:fs';
import { appendFile as appendRaw, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { UIMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

interface FsEvent {
  op: string;
  path: string;
  from?: string;
  /** Which `open` produced the handle this call went through. */
  handle?: number;
  /** The flags of that `open`, as passed. */
  flags?: string;
}

const events: FsEvent[] = [];
const messageLoggerWarnings: Array<[string, unknown]> = [];
let crashAtRename = false;
let nextHandle = 0;

class SimulatedCrash extends Error {
  constructor() {
    super('simulated crash before rename');
  }
}

/** FileHandle methods whose call order is the durability contract. */
const RECORDED_HANDLE_METHODS = new Set([
  'write',
  'writeFile',
  'appendFile',
  'truncate',
  'sync',
  'datasync',
]);

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const open: typeof actual.open = async (...args) => {
    const path = String(args[0]);
    const flags = String(args[1] ?? 'r');
    const id = ++nextHandle;
    const handle = await actual.open(...args);
    events.push({ op: 'open', path, handle: id, flags });
    return new Proxy(handle, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        return (...callArgs: unknown[]) => {
          if (RECORDED_HANDLE_METHODS.has(String(key))) {
            events.push({ op: String(key), path, handle: id, flags });
          }
          return value.apply(target, callArgs);
        };
      },
    });
  };
  const rename: typeof actual.rename = async (from, to) => {
    if (crashAtRename) throw new SimulatedCrash();
    events.push({ op: 'rename', path: String(to), from: String(from) });
    return actual.rename(from, to);
  };
  const rmMock: typeof actual.rm = async (path, options) => {
    // A crashed process never reaches its cleanup.
    if (crashAtRename) return;
    return actual.rm(path, options);
  };
  const mocked = { ...actual, open, rename, rm: rmMock };
  return { ...mocked, default: mocked };
});

vi.mock(
  '@kontourai/station-shared/fs-windows-compat',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@kontourai/station-shared/fs-windows-compat')
      >();
    return {
      ...actual,
      fsyncDirectorySync: (
        ...args: Parameters<typeof actual.fsyncDirectorySync>
      ) => {
        events.push({ op: 'fsyncDirectory', path: String(args[0]) });
        return actual.fsyncDirectorySync(...args);
      },
    };
  },
);

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
          messageLoggerWarnings.push([msg, context]);
          real.warn(msg, context);
        },
      };
    },
  };
});

const { FileMemoryAdapter } = await import('../memory-adapter.js');
const { MAX_COMPLETABLE_TAIL_BYTES } = await import(
  '../memory-adapter-messages.js'
);

/**
 * 2 x CHAT_ATTACHMENT_MAX_COMMAND_JSON_BYTES (22 MiB): the largest record
 * Station can write, with headroom. Pinned as a literal so a change to the
 * derivation is a visible decision here, not a silent shift.
 */
const COMPLETABLE_TAIL_LIMIT = 46_137_344;

/** An ASCII JSON message record of exactly `bytes` bytes. */
function recordOfExactly(bytes: number, id: string): string {
  const prefix = `{"id":"${id}","role":"user","parts":[{"type":"text","text":"`;
  const suffix = '"}]}';
  return `${prefix}${'x'.repeat(bytes - prefix.length - suffix.length)}${suffix}`;
}

const USER = 'u1';
const CONVERSATION = 'c1';

function message(id: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text: id }] } as UIMessage;
}

describe('transcript appends and rewrites survive a crash (#3564)', () => {
  const tempDir = trackTempDirs();
  let projectHomeDir: string;
  let adapter: InstanceType<typeof FileMemoryAdapter>;

  beforeEach(async () => {
    crashAtRename = false;
    events.length = 0;
    messageLoggerWarnings.length = 0;
    projectHomeDir = tempDir('station-memory-durable-');
    adapter = new FileMemoryAdapter({ projectHomeDir });
    await adapter.createConversation({
      id: CONVERSATION,
      resourceId: 'agent-a',
      userId: USER,
      title: 'T',
      metadata: {},
    });
  });

  afterEach(() => {
    crashAtRename = false;
  });

  async function messagesPath(): Promise<string> {
    const paths = (adapter as unknown as { paths: MessagePaths }).paths;
    const conversations = (
      adapter as unknown as { conversations: ConversationResolver }
    ).conversations;
    return paths.getMessagesPath(
      await conversations.resolveResourceId(CONVERSATION, USER),
      CONVERSATION,
    );
  }

  async function storedIds(): Promise<string[]> {
    const messages = await adapter.getMessages(USER, CONVERSATION);
    return messages.map((m) => String(m.id));
  }

  test('a torn tail does not take the next message with it, and is reported', async () => {
    await adapter.addMessage(message('a'), USER, CONVERSATION);
    const path = await messagesPath();
    // The prefix of a message whose write was interrupted: no closing
    // brace, no newline.
    const torn = '{"id":"b","role":"user","parts":[{"type":"te';
    await appendRaw(path, torn, 'utf-8');

    await adapter.addMessage(message('c'), USER, CONVERSATION);

    // Before the fix `c` was glued onto the torn bytes and the reader
    // dropped the merged line: both were gone.
    expect(await storedIds()).toEqual(['a', 'c']);

    // The torn bytes are moved aside verbatim, not destroyed...
    expect(await readFile(`${path}.torn`, 'utf-8')).toBe(`${torn}\n`);
    // ...and the transcript itself is clean NDJSON again.
    const lines = (await readFile(path, 'utf-8')).split('\n');
    expect(lines.at(-1)).toBe('');
    expect(lines.slice(0, -1).map((line) => JSON.parse(line).id)).toEqual([
      'a',
      'c',
    ]);

    // The recovery is disclosed, with the torn byte count.
    const disclosure = messageLoggerWarnings.find(([, context]) => {
      const recovery = context as { recovery?: { kind?: string } } | undefined;
      return recovery?.recovery?.kind === 'quarantined';
    });
    expect(disclosure).toBeDefined();
    expect(disclosure?.[1]).toMatchObject({
      recovery: {
        kind: 'quarantined',
        path,
        bytes: Buffer.byteLength(torn),
        quarantinePath: `${path}.torn`,
      },
    });
  });

  test('a whole record missing only its newline is kept, not quarantined', async () => {
    await adapter.addMessage(message('a'), USER, CONVERSATION);
    const path = await messagesPath();
    // Every byte of the record landed except the terminator.
    await appendRaw(path, JSON.stringify(message('b')), 'utf-8');

    await adapter.addMessage(message('c'), USER, CONVERSATION);

    expect(await storedIds()).toEqual(['a', 'b', 'c']);
    expect(readdirSync(dirname(path))).not.toContain('c1.ndjson.torn');
    expect(messageLoggerWarnings).toContainEqual([
      expect.any(String),
      expect.objectContaining({
        recovery: expect.objectContaining({ kind: 'completed', path }),
      }),
    ]);
  });

  test('a bulk append after a torn tail keeps every new message', async () => {
    await adapter.addMessage(message('a'), USER, CONVERSATION);
    const path = await messagesPath();
    await appendRaw(path, '{"id":"b","rol', 'utf-8');

    await adapter.addMessages([message('c'), message('d')], USER, CONVERSATION);

    expect(await storedIds()).toEqual(['a', 'c', 'd']);
  });

  test('a torn tail longer than one scan chunk is moved aside whole', async () => {
    await adapter.addMessage(message('a'), USER, CONVERSATION);
    const path = await messagesPath();
    // A long streamed reply cut off mid-write: well past the 64 KiB backward
    // scan window, so finding its start crosses several chunks.
    const torn = `{"id":"b","role":"assistant","parts":[{"type":"text","text":"${'x'.repeat(200_000)}`;
    await appendRaw(path, torn, 'utf-8');

    await adapter.addMessage(message('c'), USER, CONVERSATION);

    expect(await storedIds()).toEqual(['a', 'c']);
    expect(await readFile(`${path}.torn`, 'utf-8')).toBe(`${torn}\n`);
  });

  test('a complete record exactly at the parse cap keeps its place', async () => {
    expect(MAX_COMPLETABLE_TAIL_BYTES).toBe(COMPLETABLE_TAIL_LIMIT);
    await adapter.addMessage(message('a'), USER, CONVERSATION);
    const path = await messagesPath();
    const record = recordOfExactly(COMPLETABLE_TAIL_LIMIT, 'b');
    expect(Buffer.byteLength(record)).toBe(COMPLETABLE_TAIL_LIMIT);
    await appendRaw(path, record, 'utf-8');

    await adapter.addMessage(message('c'), USER, CONVERSATION);

    expect(await storedIds()).toEqual(['a', 'b', 'c']);
    expect(readdirSync(dirname(path))).not.toContain('c1.ndjson.torn');
  }, 120_000);

  test('a complete record one byte over the parse cap is quarantined whole', async () => {
    await adapter.addMessage(message('a'), USER, CONVERSATION);
    const path = await messagesPath();
    const record = recordOfExactly(COMPLETABLE_TAIL_LIMIT + 1, 'b');
    expect(Buffer.byteLength(record)).toBe(COMPLETABLE_TAIL_LIMIT + 1);
    await appendRaw(path, record, 'utf-8');

    await adapter.addMessage(message('c'), USER, CONVERSATION);

    // Over the cap the tail is not parsed, so even a complete record leaves
    // the transcript. Its bytes are kept, newline-terminated, in quarantine.
    expect(await storedIds()).toEqual(['a', 'c']);
    expect(statSync(`${path}.torn`).size).toBe(COMPLETABLE_TAIL_LIMIT + 2);
    expect(messageLoggerWarnings).toContainEqual([
      expect.any(String),
      expect.objectContaining({
        recovery: expect.objectContaining({
          kind: 'quarantined',
          bytes: COMPLETABLE_TAIL_LIMIT + 1,
        }),
      }),
    ]);
  }, 120_000);

  test('a torn tail with no complete line before it is moved aside', async () => {
    await adapter.addMessage(message('a'), USER, CONVERSATION);
    const path = await messagesPath();
    await adapter.clearMessages(USER, CONVERSATION);
    await appendRaw(path, '{"id":"b"', 'utf-8');

    await adapter.addMessage(message('c'), USER, CONVERSATION);

    expect(await storedIds()).toEqual(['c']);
    expect(await readFile(`${path}.torn`, 'utf-8')).toBe('{"id":"b"\n');
  });

  test('deleting the conversation removes its quarantined torn records', async () => {
    await adapter.addMessage(message('a'), USER, CONVERSATION);
    const path = await messagesPath();
    await appendRaw(path, '{"id":"b","rol', 'utf-8');
    await adapter.addMessage(message('c'), USER, CONVERSATION);
    expect(readdirSync(dirname(path))).toContain('c1.ndjson.torn');

    await adapter.deleteConversation(CONVERSATION);

    expect(readdirSync(dirname(path))).not.toContain('c1.ndjson.torn');
  });

  test('a fragment is durable in quarantine before the transcript is truncated', async () => {
    await adapter.addMessage(message('a'), USER, CONVERSATION);
    const path = await messagesPath();
    const tornPath = `${path}.torn`;
    await appendRaw(path, '{"id":"b","rol', 'utf-8');
    events.length = 0;

    await adapter.addMessage(message('c'), USER, CONVERSATION);
    expect(await storedIds()).toEqual(['a', 'c']);

    type Match = (event: FsEvent, index: number) => boolean;
    const indexOf = (predicate: Match) => events.findIndex(predicate);
    const lastIndexOf = (predicate: Match) => {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (predicate(events[index], index)) return index;
      }
      return -1;
    };

    const tornWrite = lastIndexOf(
      (event) => event.path === tornPath && event.op === 'writeFile',
    );
    const tornSync = indexOf(
      (event) => event.path === tornPath && event.op === 'sync',
    );
    const directorySync = indexOf(
      (event, index) =>
        index > tornSync &&
        event.op === 'fsyncDirectory' &&
        event.path === dirname(tornPath),
    );
    const truncate = indexOf(
      (event) => event.path === path && event.op === 'truncate',
    );

    // "Never in neither": the copy is written, flushed and its directory
    // entry made durable, and only then is the transcript cut.
    expect(tornWrite).toBeGreaterThan(-1);
    expect(tornSync).toBeGreaterThan(tornWrite);
    expect(directorySync).toBeGreaterThan(tornSync);
    expect(truncate).toBeGreaterThan(directorySync);

    // The cut goes through a descriptor opened without O_APPEND: Windows
    // refuses to truncate an append handle. The cut is flushed on it.
    const cut = events[truncate];
    expect(cut.flags).not.toMatch(/a/);
    expect(
      events.some(
        (event, index) =>
          index > truncate &&
          event.handle === cut.handle &&
          event.op === 'sync',
      ),
    ).toBe(true);
  });

  test('a crash between writing the rewrite and renaming it leaves the original intact', async () => {
    await adapter.addMessages(
      [message('m1'), message('m2'), message('m3')],
      USER,
      CONVERSATION,
    );
    const path = await messagesPath();
    const before = await readFile(path, 'utf-8');

    crashAtRename = true;
    await expect(
      adapter.deleteMessages(['m2'], USER, CONVERSATION),
    ).rejects.toBeInstanceOf(SimulatedCrash);
    crashAtRename = false;

    // The transcript is byte-identical and still reads whole.
    expect(await readFile(path, 'utf-8')).toBe(before);
    expect(await storedIds()).toEqual(['m1', 'm2', 'm3']);

    // The stranded temporary holds the complete rewrite: a crash here can
    // only leave a stray file, never a half-published transcript.
    const strays = readdirSync(dirname(path)).filter((name) =>
      name.endsWith('.tmp'),
    );
    expect(strays).toHaveLength(1);
    const stray = await readFile(join(dirname(path), strays[0]), 'utf-8');
    expect(
      stray
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line).id),
    ).toEqual(['m1', 'm3']);
  });

  test('a rewrite fsyncs the temporary before rename and the directory after', async () => {
    await adapter.addMessages(
      [message('m1'), message('m2')],
      USER,
      CONVERSATION,
    );
    const path = await messagesPath();
    events.length = 0;

    await adapter.deleteMessages(['m1'], USER, CONVERSATION);
    expect(await storedIds()).toEqual(['m2']);

    const renameIndex = events.findIndex(
      (event) => event.op === 'rename' && event.path === path,
    );
    expect(renameIndex).toBeGreaterThan(-1);
    const temporaryPath = events[renameIndex].from;
    expect(temporaryPath).toMatch(/\.tmp$/);

    const forTemporary = events
      .slice(0, renameIndex)
      .filter((event) => event.path === temporaryPath)
      .map((event) => event.op);
    // Data is written, then flushed, before the rename can publish it.
    expect(forTemporary).toContain('sync');
    expect(forTemporary.lastIndexOf('sync')).toBeGreaterThan(
      Math.max(
        forTemporary.lastIndexOf('writeFile'),
        forTemporary.lastIndexOf('write'),
      ),
    );

    // The directory entry the rename created is flushed after it.
    const directorySync = events.findIndex(
      (event, index) =>
        index > renameIndex &&
        event.op === 'fsyncDirectory' &&
        event.path === dirname(path),
    );
    expect(directorySync).toBeGreaterThan(renameIndex);
  });

  test('remove-last publishes through the same durable rewrite', async () => {
    await adapter.addMessages(
      [message('m1'), message('m2')],
      USER,
      CONVERSATION,
    );
    const path = await messagesPath();
    events.length = 0;

    await adapter.removeLastMessage(USER, CONVERSATION);
    expect(await storedIds()).toEqual(['m1']);

    const renameIndex = events.findIndex(
      (event) => event.op === 'rename' && event.path === path,
    );
    expect(renameIndex).toBeGreaterThan(-1);
    const temporaryPath = events[renameIndex].from;
    expect(
      events
        .slice(0, renameIndex)
        .some((event) => event.op === 'sync' && event.path === temporaryPath),
    ).toBe(true);
    expect(
      events
        .slice(renameIndex + 1)
        .some(
          (event) =>
            event.op === 'fsyncDirectory' && event.path === dirname(path),
        ),
    ).toBe(true);
  });

  test('an append is flushed before it returns, and a new transcript flushes its directory', async () => {
    await adapter.addMessage(message('a'), USER, CONVERSATION);
    const path = await messagesPath();

    const forTranscript = events.filter((event) => event.path === path);
    const ops = forTranscript.map((event) => event.op);
    const lastWrite = Math.max(
      ops.lastIndexOf('write'),
      ops.lastIndexOf('writeFile'),
      ops.lastIndexOf('appendFile'),
    );
    expect(lastWrite).toBeGreaterThan(-1);
    expect(ops.lastIndexOf('sync')).toBeGreaterThan(lastWrite);

    // The first append created the file; its directory entry must be
    // durable too, or a crash can lose the whole transcript.
    expect(events).toContainEqual({
      op: 'fsyncDirectory',
      path: dirname(path),
    });
    // So must the new sessions directory's own entry, in its parent.
    expect(events).toContainEqual({
      op: 'fsyncDirectory',
      path: dirname(dirname(path)),
    });

    // A later append to the existing file still flushes its data.
    events.length = 0;
    await adapter.addMessages([message('b')], USER, CONVERSATION);
    const laterOps = events
      .filter((event) => event.path === path)
      .map((event) => event.op);
    expect(laterOps.at(-1)).toBe('sync');
    expect(await storedIds()).toEqual(['a', 'b']);
  });
});

interface MessagePaths {
  getMessagesPath(resourceId: string, conversationId: string): string;
}

interface ConversationResolver {
  resolveResourceId(conversationId?: string, userId?: string): Promise<string>;
}
