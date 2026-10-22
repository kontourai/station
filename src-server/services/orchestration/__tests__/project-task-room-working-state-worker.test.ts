import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

const port = vi.hoisted(() => ({
  databasePath: '',
  on: vi.fn(),
  postMessage: vi.fn(),
}));
vi.mock('node:worker_threads', () => ({
  parentPort: port,
  workerData: {
    get databasePath() {
      return port.databasePath;
    },
  },
}));

const makeTempDir = trackTempDirs();
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('watched worker backs off idle database probes, still notices another connection, and stops on unwatch', async () => {
  port.databasePath = join(makeTempDir('station-room-poll-'), 'room.sqlite');
  const databases = new Set<DatabaseSync>();
  const prepare = DatabaseSync.prototype.prepare;
  let probes = 0;
  vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    databases.add(this);
    const statement = prepare.call(this, sql);
    if (sql === 'PRAGMA data_version') {
      const get = statement.get;
      statement.get = function (...args: Parameters<typeof get>) {
        probes++;
        return get.apply(this, args);
      };
    }
    return statement;
  });
  vi.useFakeTimers();
  try {
    await import('../project-task-room-working-state-worker.js');
    const message = port.on.mock.calls.find(
      ([event]) => event === 'message',
    )?.[1];
    expect(message).toBeTypeOf('function');
    message({ value: { type: 'watch' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'changed' });
    port.postMessage.mockClear();
    probes = 0;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(probes).toBeLessThanOrEqual(8);
    expect(probes).toBeGreaterThan(0);
    expect(port.postMessage).not.toHaveBeenCalled();
    const writer = new DatabaseSync(port.databasePath);
    databases.add(writer);
    writer.exec('CREATE TABLE poll_probe (value TEXT)');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'changed' });
    const before = probes;
    await vi.advanceTimersByTimeAsync(500);
    expect(probes).toBe(before + 1);
    message({ value: { type: 'unwatch' } });
    await vi.advanceTimersByTimeAsync(0);
    const stopped = probes;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(probes).toBe(stopped);
  } finally {
    for (const db of databases) db.close();
  }
});
