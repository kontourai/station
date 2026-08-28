// @vitest-environment node

import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  serverLogStoreRetentionRemovedFiles,
  serverLogStoreWriteErrors,
} from '../../../telemetry/metrics.js';
import {
  createServerLogStore,
  getInstalledServerLogSink,
  installServerLogSink,
  resetServerLogSinkForTests,
} from '../server-log-store.js';

const dirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'station-log-store-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  resetServerLogSinkForTests();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fileNames(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => /^server-\d{4}-\d{2}-\d{2}\.ndjson$/.test(name))
    .sort();
}

describe('createServerLogStore — NDJSON writes', () => {
  it('writes one valid JSON object per line, with a trailing newline added when missing', () => {
    const directory = createTempDir();
    const store = createServerLogStore({ directory });

    store.writeLine('{"msg":"first"}');
    store.writeLine('{"msg":"second"}\n');

    const files = fileNames(directory);
    expect(files).toHaveLength(1);
    const content = readFileSync(join(directory, files[0]), 'utf8');
    const lines = content.split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ msg: 'first' });
    expect(JSON.parse(lines[1])).toEqual({ msg: 'second' });
  });

  it('creates the directory (0700) and file (0600) with the expected modes', () => {
    if (process.platform === 'win32') return; // POSIX mode bits only
    const parent = createTempDir();
    const directory = join(parent, 'nested', 'logs');
    const store = createServerLogStore({ directory });

    store.writeLine('{"msg":"hi"}');

    const dirMode = statSync(directory).mode & 0o777;
    expect(dirMode).toBe(0o700);
    const [file] = fileNames(directory);
    const fileMode = statSync(join(directory, file)).mode & 0o777;
    expect(fileMode).toBe(0o600);
  });

  it('re-asserts 0700/0600 on a pre-existing too-open directory and file', () => {
    if (process.platform === 'win32') return;
    const directory = createTempDir();
    chmodSync(directory, 0o755);
    const today = new Date().toISOString().split('T')[0];
    const path = join(directory, `server-${today}.ndjson`);
    writeFileSync(path, '', { mode: 0o644 });
    chmodSync(path, 0o644);

    const store = createServerLogStore({ directory });
    store.writeLine('{"msg":"secret-bearing"}');

    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('flushSync is a safe no-op (writes are already synchronous)', () => {
    const directory = createTempDir();
    const store = createServerLogStore({ directory });
    store.writeLine('{"msg":"durable"}');
    expect(() => store.flushSync()).not.toThrow();
  });
});

describe('createServerLogStore — day rollover', () => {
  it('rolls over to a new dated file when the injected now() crosses a day boundary', () => {
    const directory = createTempDir();
    let current = new Date('2026-01-01T12:00:00.000Z');
    const store = createServerLogStore({
      directory,
      now: () => current,
      retention: { maxAgeDays: 30, maxBytes: 256 * 1024 * 1024 },
    });

    store.writeLine('{"msg":"day one"}');
    current = new Date('2026-01-02T00:30:00.000Z');
    store.writeLine('{"msg":"day two"}');

    const files = fileNames(directory);
    expect(files).toEqual([
      'server-2026-01-01.ndjson',
      'server-2026-01-02.ndjson',
    ]);
    expect(readFileSync(join(directory, files[0]), 'utf8')).toContain(
      'day one',
    );
    expect(readFileSync(join(directory, files[1]), 'utf8')).toContain(
      'day two',
    );
  });
});

describe('createServerLogStore — retention', () => {
  it('removes files older than maxAgeDays, but keeps files within the window and the active day', () => {
    const directory = createTempDir();
    let current = new Date('2026-01-01T00:00:00.000Z');
    const store = createServerLogStore({
      directory,
      now: () => current,
      retention: { maxAgeDays: 2, maxBytes: 256 * 1024 * 1024 },
    });

    store.writeLine('{"msg":"day1"}'); // today = day1
    current = new Date('2026-01-02T00:00:00.000Z');
    store.writeLine('{"msg":"day2"}'); // today = day2, retention keeps day1 (== oldest retained)
    expect(fileNames(directory)).toEqual([
      'server-2026-01-01.ndjson',
      'server-2026-01-02.ndjson',
    ]);

    current = new Date('2026-01-03T00:00:00.000Z');
    store.writeLine('{"msg":"day3"}'); // today = day3, oldest retained = day2 -> day1 removed
    expect(fileNames(directory)).toEqual([
      'server-2026-01-02.ndjson',
      'server-2026-01-03.ndjson',
    ]);
  });

  it('removes the oldest files once total bytes exceed maxBytes, never the active day', () => {
    const directory = createTempDir();
    let current = new Date('2026-02-01T00:00:00.000Z');
    const bigLine = `{"msg":"${'x'.repeat(500)}"}`;
    const store = createServerLogStore({
      directory,
      now: () => current,
      retention: { maxAgeDays: 30, maxBytes: 200 },
    });

    store.writeLine(bigLine); // day1 file now well over 200 bytes, but it's the active day
    expect(fileNames(directory)).toEqual(['server-2026-02-01.ndjson']);

    current = new Date('2026-02-02T00:00:00.000Z');
    store.writeLine('{"msg":"small"}'); // day2 retention pass sees day1 over budget and not active -> removed
    expect(fileNames(directory)).toEqual(['server-2026-02-02.ndjson']);
  });

  it('never removes the active day even when it alone exceeds maxBytes — proven by BYTES surviving, not just presence', () => {
    // archive#1895 review round 2, verifier-c: asserting the file merely
    // exists/contains the new line cannot distinguish "protected and
    // appended to" from "deleted, then recreated containing only the new
    // write" — both leave a same-named file containing 'more today'. This
    // captures the ORIGINAL bytes and asserts they are still a PREFIX of
    // the file after the retention pass + a second write, which only a
    // genuine append (not a delete-and-recreate) can produce.
    const directory = createTempDir();
    const current = new Date('2026-03-01T00:00:00.000Z');
    const bigLine = `{"msg":"${'y'.repeat(5000)}"}`;

    // Simulate a prior process run already having written a large file for
    // "today" before this store instance exists, so the very first
    // ensureOpenForToday() on a fresh instance runs retention against it.
    const store1 = createServerLogStore({
      directory,
      now: () => current,
      retention: { maxAgeDays: 30, maxBytes: 100 },
    });
    store1.writeLine(bigLine);
    expect(fileNames(directory)).toEqual(['server-2026-03-01.ndjson']);
    const [activeFile] = fileNames(directory);
    const activePath = join(directory, activeFile);
    const originalBytes = readFileSync(activePath);
    expect(originalBytes.length).toBeGreaterThan(100); // over the maxBytes budget

    const store2 = createServerLogStore({
      directory,
      now: () => current,
      retention: { maxAgeDays: 30, maxBytes: 100 },
    });
    store2.writeLine('{"msg":"more today"}');

    const files = fileNames(directory);
    expect(files).toEqual(['server-2026-03-01.ndjson']);
    const finalBytes = readFileSync(activePath);
    // A delete-then-recreate would NOT start with the original bytes (the
    // file would contain only the new line). A genuine append does.
    expect(
      finalBytes.subarray(0, originalBytes.length).equals(originalBytes),
    ).toBe(true);
    expect(finalBytes.length).toBeGreaterThan(originalBytes.length);
    expect(finalBytes.toString('utf8')).toContain('more today');
  });

  it('reads retention knobs from STATION_SERVER_LOG_RETENTION_DAYS / STATION_SERVER_LOG_MAX_BYTES when not passed explicitly', () => {
    const directory = createTempDir();
    const originalDays = process.env.STATION_SERVER_LOG_RETENTION_DAYS;
    const originalBytes = process.env.STATION_SERVER_LOG_MAX_BYTES;
    try {
      process.env.STATION_SERVER_LOG_RETENTION_DAYS = '1';
      process.env.STATION_SERVER_LOG_MAX_BYTES = 'not-a-number';
      let current = new Date('2026-04-01T00:00:00.000Z');
      const store = createServerLogStore({ directory, now: () => current });
      store.writeLine('{"msg":"day1"}');
      current = new Date('2026-04-02T00:00:00.000Z');
      store.writeLine('{"msg":"day2"}');
      // maxAgeDays=1 keeps only today; an invalid maxBytes env falls back to
      // the default rather than throwing or disabling retention.
      expect(fileNames(directory)).toEqual(['server-2026-04-02.ndjson']);
    } finally {
      if (originalDays === undefined)
        delete process.env.STATION_SERVER_LOG_RETENTION_DAYS;
      else process.env.STATION_SERVER_LOG_RETENTION_DAYS = originalDays;
      if (originalBytes === undefined)
        delete process.env.STATION_SERVER_LOG_MAX_BYTES;
      else process.env.STATION_SERVER_LOG_MAX_BYTES = originalBytes;
    }
  });

  it('increments the retention-removed-files counter when files are actually removed', () => {
    const directory = createTempDir();
    let current = new Date('2026-05-01T00:00:00.000Z');
    const store = createServerLogStore({
      directory,
      now: () => current,
      retention: { maxAgeDays: 1, maxBytes: 256 * 1024 * 1024 },
    });
    const addSpy = vi.spyOn(serverLogStoreRetentionRemovedFiles, 'add');

    store.writeLine('{"msg":"day1"}');
    current = new Date('2026-05-02T00:00:00.000Z');
    store.writeLine('{"msg":"day2"}');

    expect(addSpy).toHaveBeenCalledWith(1);
    addSpy.mockRestore();
  });
});

describe('createServerLogStore — write failures', () => {
  it('does not throw when the target directory cannot be created, and counts the failure', () => {
    const parent = createTempDir();
    const blocker = join(parent, 'blocker-file');
    writeFileSync(blocker, 'not a directory');
    const store = createServerLogStore({ directory: join(blocker, 'nested') });
    const addSpy = vi.spyOn(serverLogStoreWriteErrors, 'add');

    expect(() => store.writeLine('{"msg":"never lands"}')).not.toThrow();
    expect(addSpy).toHaveBeenCalled();

    addSpy.mockRestore();
  });
});

describe('installServerLogSink / getInstalledServerLogSink', () => {
  it('is undefined before install, and returns the installed store afterward', () => {
    expect(getInstalledServerLogSink()).toBeUndefined();
    const directory = createTempDir();
    const installed = installServerLogSink({ directory });
    expect(getInstalledServerLogSink()).toBe(installed);
    expect(installed.directory).toBe(directory);
  });

  it('a later install call replaces the earlier sink', () => {
    const first = createTempDir();
    const second = createTempDir();
    installServerLogSink({ directory: first });
    const replaced = installServerLogSink({ directory: second });
    expect(getInstalledServerLogSink()).toBe(replaced);
    expect(getInstalledServerLogSink()?.directory).toBe(second);
  });

  it("closes the replaced sink's fd — a double-install must not orphan an open descriptor", () => {
    const first = createTempDir();
    const second = createTempDir();
    const firstSink = installServerLogSink({ directory: first });
    // Force the fd open before replacing it.
    firstSink.writeLine('{"msg":"before replace"}');
    expect(firstSink.isOpen()).toBe(true);

    installServerLogSink({ directory: second });

    expect(firstSink.isOpen()).toBe(false);
  });
});
