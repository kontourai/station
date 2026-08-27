/**
 * The plugin dev watcher's fallback (#970).
 *
 * The failure this covers is not "the watcher throws" — it is a watch layer
 * that arms successfully and then delivers nothing, which on the reporting host
 * was true of `fs.watch` recursive, `fs.watch` non-recursive, and the native
 * `fsevents` binding at the same time. From inside the process that is
 * indistinguishable from an idle developer, so the watch layer is replaced here
 * by one that arms and stays silent, and the assertion is that a real edit
 * still reaches `onRebuild`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  describeWatchStatus,
  fallbackNotice,
  POLL_INTERVAL_MS,
  type WatchHandle,
  type WatchStatus,
  watchSourceChanges,
} from '../dev/watchers.js';

type WatchBehaviour = 'silent' | 'throws' | 'live';

const fsWatchMock = vi.hoisted(() => ({
  behaviour: 'silent' as WatchBehaviour,
  /** Callbacks armed by the code under test, for the `live` behaviour. */
  callbacks: [] as ((event: string, filename: string) => void)[],
  closeCount: 0,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    watch: (
      _path: string,
      _options: unknown,
      listener?: (event: string, filename: string) => void,
    ) => {
      if (fsWatchMock.behaviour === 'throws') {
        throw new Error('ENOSYS: watch not supported');
      }
      if (fsWatchMock.behaviour === 'live' && listener) {
        fsWatchMock.callbacks.push(listener);
      }
      return {
        close: () => {
          fsWatchMock.closeCount += 1;
        },
      };
    },
  };
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let root = '';
const handles: WatchHandle[] = [];

function makePluginTree(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'station-dev-watch-'));
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src/index.tsx'), 'export const version = 1;\n');
  return cwd;
}

beforeEach(() => {
  fsWatchMock.behaviour = 'silent';
  fsWatchMock.callbacks.length = 0;
  fsWatchMock.closeCount = 0;
  root = makePluginTree();
});

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

function watch(
  onRebuild: (filename: string) => void,
  pollIntervalMs = 100,
): WatchHandle {
  const handle = watchSourceChanges({
    cwd: root,
    pollIntervalMs,
    onRebuild: async (filename) => onRebuild(filename),
  });
  handles.push(handle);
  return handle;
}

describe('plugin dev source watcher', () => {
  test('rebuilds when the watch layer arms but delivers no events', async () => {
    const rebuilt: string[] = [];
    const handle = watch((filename) => rebuilt.push(filename));

    await sleep(120);
    writeFileSync(join(root, 'src/index.tsx'), 'export const version = 2;\n');

    const deadline = Date.now() + 5000;
    while (rebuilt.length === 0 && Date.now() < deadline) await sleep(50);

    expect(rebuilt).toEqual([join('src', 'index.tsx')]);
    const status = handle.status();
    expect(status.nativeArmed).toBe(true);
    expect(status.nativeDelivered).toBe(false);
    expect(status.pollingDelivered).toBe(true);
  }, 15000);

  test('ignores files the rebuild does not care about', async () => {
    const rebuilt: string[] = [];
    watch((filename) => rebuilt.push(filename));

    await sleep(120);
    writeFileSync(join(root, 'src/notes.md'), '# not a source file\n');
    await sleep(500);

    expect(rebuilt).toEqual([]);
  }, 15000);

  test('does not rebuild twice when native events are live', async () => {
    fsWatchMock.behaviour = 'live';
    const rebuilt: string[] = [];
    const handle = watch((filename) => rebuilt.push(filename), 300);

    writeFileSync(join(root, 'src/index.tsx'), 'export const version = 3;\n');
    for (const callback of fsWatchMock.callbacks) {
      callback('change', 'index.tsx');
    }

    // Well past the debounce and several scan intervals.
    await sleep(1200);

    expect(rebuilt).toEqual(['index.tsx']);
    const status = handle.status();
    expect(status.nativeDelivered).toBe(true);
    expect(status.pollingDelivered).toBe(false);
  }, 15000);

  test('polls when the watch layer refuses to arm', async () => {
    fsWatchMock.behaviour = 'throws';
    const rebuilt: string[] = [];
    const handle = watch((filename) => rebuilt.push(filename));

    expect(handle.status().nativeArmed).toBe(false);
    expect(handle.status().nativeError).toContain('ENOSYS');
    expect(handle.status().pollingActive).toBe(true);

    await sleep(120);
    writeFileSync(join(root, 'src/index.tsx'), 'export const version = 4;\n');

    const deadline = Date.now() + 5000;
    while (rebuilt.length === 0 && Date.now() < deadline) await sleep(50);
    expect(rebuilt).toEqual([join('src', 'index.tsx')]);
  }, 15000);

  test('close stops the scan and releases the native watcher', async () => {
    const rebuilt: string[] = [];
    const handle = watch((filename) => rebuilt.push(filename));
    handle.close();

    expect(fsWatchMock.closeCount).toBe(1);
    writeFileSync(join(root, 'src/index.tsx'), 'export const version = 5;\n');
    await sleep(500);
    expect(rebuilt).toEqual([]);
  }, 15000);

  test('the scan timer never holds the process open', () => {
    const realSetInterval = globalThis.setInterval;
    const timers: ReturnType<typeof setInterval>[] = [];
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      ...args: Parameters<typeof setInterval>
    ) => {
      const timer = realSetInterval(...args);
      timers.push(timer);
      return timer;
    }) as typeof setInterval);

    try {
      watch(() => {});
    } finally {
      spy.mockRestore();
    }

    expect(timers).toHaveLength(1);
    expect(timers[0].hasRef()).toBe(false);
  });
});

describe('plugin dev watch status', () => {
  function fakeHandle(
    overrides: Partial<WatchStatus>,
    targets = ['src/'],
  ): WatchHandle {
    return {
      targets,
      pollIntervalMs: POLL_INTERVAL_MS,
      status: () => ({
        nativeArmed: true,
        nativeDelivered: false,
        nativeError: null,
        pollingActive: true,
        pollingError: null,
        pollingDelivered: false,
        ...overrides,
      }),
      close: () => {},
    };
  }

  test('names both mechanisms when both are available', () => {
    expect(describeWatchStatus([fakeHandle({})])).toEqual([
      '   Watching: src/ (native file events, 2s polling fallback)',
    ]);
  });

  test('does not claim native watching once the fallback is carrying changes', () => {
    const lines = describeWatchStatus([
      fakeHandle({ pollingDelivered: true, nativeDelivered: false }),
    ]);
    expect(lines).toEqual([
      '   Watching: src/ (polling every 2s — no native file events have arrived)',
    ]);
    expect(lines.join('\n')).not.toContain('native file events,');
  });

  test('does not claim native watching when native never armed', () => {
    const lines = describeWatchStatus([
      fakeHandle({ nativeArmed: false, nativeError: 'ENOSYS' }),
    ]);
    expect(lines).toEqual([
      '   Watching: src/ (polling every 2s — native file watching is unavailable: ENOSYS)',
    ]);
    expect(lines.join('\n')).not.toContain('native file events');
  });

  test('says so plainly when nothing is watching', () => {
    expect(
      describeWatchStatus([
        fakeHandle({
          nativeArmed: false,
          nativeError: 'ENOSYS',
          pollingActive: false,
          pollingError: 'more than 2000 files',
        }),
      ]),
    ).toEqual([
      '   Not watching src/ — file watching is unavailable (ENOSYS).',
      '   Edits will not rebuild; restart the dev server to pick them up.',
    ]);
  });

  test('reports a disabled fallback rather than implying full cover', () => {
    expect(
      describeWatchStatus([
        fakeHandle({
          pollingActive: false,
          pollingError: 'more than 2000 files',
        }),
      ]),
    ).toEqual([
      '   Watching: src/ (native file events; polling fallback off — more than 2000 files)',
    ]);
  });

  test('says nothing when there is nothing to watch', () => {
    expect(describeWatchStatus([fakeHandle({}, [])])).toEqual([]);
  });

  test('the runtime notice fires only when the fallback is the one delivering', () => {
    expect(fallbackNotice([fakeHandle({})])).toBeNull();
    expect(
      fallbackNotice([
        fakeHandle({ pollingDelivered: true, nativeDelivered: true }),
      ]),
    ).toBeNull();
    expect(fallbackNotice([fakeHandle({ pollingDelivered: true })])).toBe(
      '   ⚠ No native file events have arrived — changes are being picked up by the 2s polling fallback.',
    );
  });
});
