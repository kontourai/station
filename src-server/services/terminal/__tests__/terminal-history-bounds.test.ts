import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { IPtyAdapter } from '../../../domain/pty-adapter.js';
import type { ITerminalHistoryStore } from '../../../domain/terminal-history-store.js';
import { TerminalHistory } from '../terminal-history.js';
import { TerminalService } from '../terminal-service.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  terminalOps: { add: vi.fn() },
}));

const BYTE_CAP = 2 * 1024 * 1024;
const input = {
  projectSlug: 'test',
  terminalId: 'bounds',
  cwd: '/tmp',
  cols: 80,
  rows: 24,
};

describe('TerminalService history bounds', () => {
  let service: TerminalService;
  let emitData: (data: string) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    emitData = () => {
      throw new Error('PTY data listener is not registered');
    };
    const pty: IPtyAdapter = {
      async spawn() {
        return {
          pid: 12345,
          write() {},
          resize() {},
          kill() {},
          onData(cb) {
            emitData = cb;
            return () => {};
          },
          onExit() {
            return () => {};
          },
        };
      },
    };
    const store: ITerminalHistoryStore = {
      async load() {
        return '';
      },
      async save() {},
      async delete() {},
    };
    service = new TerminalService(pty, store);
  });

  afterEach(async () => {
    await service.dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('evicting PTY appends never inspect retained content beyond the bounded front and tail', async () => {
    const append = vi.spyOn(TerminalHistory.prototype, 'append');
    await service.open(input);
    emitData('x'.repeat(3 * 1024 * 1024));
    const history = append.mock.contexts.at(-1);
    append.mockRestore();
    if (!(history instanceof TerminalHistory))
      throw new Error('Service did not append to its history');
    expect((await service.open(input)).history.length).toBe(BYTE_CAP);

    const chunks: unknown = Reflect.get(history, 'chunks');
    const head: unknown = Reflect.get(history, 'head');
    if (!Array.isArray(chunks) || typeof head !== 'number')
      throw new Error('Expected chunk storage');
    const originals = new Map<object, string>();
    const middleReads = new Set<number>();
    const appendCount = 100;
    const data = 'a'.repeat(64);
    // Allow both 64 KiB recovery windows, incoming eviction, and a partial chunk.
    const frontWindow = 2 * 64 * 1024 + appendCount * data.length + 4096;
    let frontBytes = 0;
    let protectedBytes = 0;
    let measuring = false;
    for (let i = head; i < chunks.length; i++) {
      const text: unknown = chunks[i];
      if (typeof text !== 'string')
        throw new Error('Expected a retained text chunk');
      const allowed = frontBytes < frontWindow || i === chunks.length - 1;
      frontBytes += Buffer.byteLength(text);
      if (!allowed) protectedBytes += Buffer.byteLength(text);
      const observe = () => {
        if (measuring && !allowed) middleReads.add(i);
      };
      // Box content, not array access: moving references during compaction is free,
      // but +=, indexing, iteration and string methods all expose text reads.
      const wrapped = new Proxy<object>(Object(text), {
        get(target, key) {
          if (key === Symbol.toPrimitive)
            return () => {
              observe();
              return text;
            };
          const value: unknown = Reflect.get(target, key, target);
          if (typeof value === 'function')
            return (...args: unknown[]) => {
              observe();
              return Reflect.apply(value, target, args);
            };
          if (typeof key === 'string' && /^\d+$/.test(key)) observe();
          return value;
        },
      });
      originals.set(wrapped, text);
      chunks[i] = wrapped;
    }
    expect(protectedBytes).toBeGreaterThan(BYTE_CAP / 2);
    try {
      measuring = true;
      for (let i = 0; i < appendCount; i++) emitData(data);
    } finally {
      measuring = false;
      const current: unknown = Reflect.get(history, 'chunks');
      if (Array.isArray(current))
        for (let i = 0; i < current.length; i++) {
          const value: unknown = current[i];
          if (
            typeof value === 'object' &&
            value !== null &&
            originals.has(value)
          )
            current[i] = originals.get(value);
        }
    }
    expect(Array.isArray(Reflect.get(history, 'chunks'))).toBe(true);
    expect(middleReads.size).toBe(0);
    const replay = (await service.open(input)).history;
    expect(replay.length).toBe(BYTE_CAP);
    expect(replay.startsWith('x'.repeat(100))).toBe(true);
    expect(replay.endsWith(data.repeat(appendCount))).toBe(true);
  });

  test.each([
    {
      name: 'snaps exactly to a newline inside the preference window',
      initial: 'discard\n',
      data: 'T'.repeat(BYTE_CAP - 4),
      expected: 'T'.repeat(BYTE_CAP - 4),
    },
    {
      name: 'cuts exactly at the byte cap when the newline is beyond the preference window',
      initial: `${'A'.repeat(BYTE_CAP - 10)}\nshort-tail`,
      data: 'B'.repeat(20),
      expected: `${'A'.repeat(BYTE_CAP - 31)}\nshort-tail${'B'.repeat(20)}`,
    },
  ])('$name', async ({ initial, data, expected }) => {
    await service.open(input);
    emitData(initial);
    emitData(data);
    const replay = (await service.open(input)).history;
    expect(replay.length).toBe(expected.length);
    expect(replay === expected).toBe(true);
  });

  test.each([
    ['OSC 52', '\x1b]52;c;'],
    ['OSC 8', '\x1b]8;;https://example.test/'],
  ])(
    'skips a terminated 32 KiB %s payload at the replay cutoff',
    async (_name, prefix) => {
      await service.open(input);
      emitData(prefix);
      emitData('p'.repeat(32 * 1024));
      emitData('\x1b\\');
      const visible = 'v'.repeat(BYTE_CAP - 32 * 1024);
      emitData(visible);
      const replay = (await service.open(input)).history;
      expect(replay.length).toBe(visible.length);
      expect(replay === visible).toBe(true);
    },
  );
});
