import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { upsertProfile } from '../commands/profile-store.js';
import { runTargetCommand } from '../commands/target-command.js';

let home: string;
let previousHome: string | undefined;
let previousRoot: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'station-target-'));
  previousHome = process.env.STATION_HOME;
  previousRoot = process.env.STATION_ROOT;
  process.env.STATION_HOME = home;
  process.env.STATION_ROOT = home;
  upsertProfile({
    name: 'remote',
    endpoint: 'https://remote.example.test',
    environmentId: 'env-remote',
    makeDefault: true,
  });
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.STATION_HOME;
  else process.env.STATION_HOME = previousHome;
  if (previousRoot === undefined) delete process.env.STATION_ROOT;
  else process.env.STATION_ROOT = previousRoot;
  rmSync(home, { recursive: true, force: true });
});

describe('station target', () => {
  test('reports an unreachable remote Station without starting or falling back to local', async () => {
    const stdout = vi.fn();
    const localServiceStatus = vi.fn();
    await runTargetCommand([], {
      stdout,
      localServiceStatus,
      fetch: vi
        .fn()
        .mockRejectedValue(new Error('offline')) as unknown as typeof fetch,
    });
    expect(JSON.parse(stdout.mock.calls[0][0])).toMatchObject({
      station: 'remote',
      endpoint: 'https://remote.example.test',
      environmentId: 'env-remote',
      reachability: { reachable: false, reason: 'offline' },
      localService: { state: 'not-applicable-remote' },
    });
    expect(localServiceStatus).not.toHaveBeenCalled();
  });

  test('uses a local service observer only for a local selected endpoint', async () => {
    const stdout = vi.fn();
    const localServiceStatus = vi.fn().mockResolvedValue({ state: 'healthy' });
    await runTargetCommand(['--api-base=http://127.0.0.1:3141'], {
      stdout,
      localServiceStatus,
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      }) as unknown as typeof fetch,
    });
    expect(JSON.parse(stdout.mock.calls[0][0])).toMatchObject({
      station: null,
      endpoint: 'http://127.0.0.1:3141',
      localService: { state: 'healthy' },
      reachability: { reachable: true },
    });
    expect(localServiceStatus).toHaveBeenCalledTimes(1);
  });

  test('reports the exact persisted local service identity for a local Station', async () => {
    upsertProfile({
      name: 'kontour',
      endpoint: 'http://127.0.0.1:43141',
      localService: {
        instanceId: 'kontour-dev',
        baseDir: '/tmp/kontour-dev',
        serverPort: 43141,
        uiPort: 43000,
      },
      force: true,
    });
    const stdout = vi.fn();
    const localServiceStatus = vi.fn().mockResolvedValue({ state: 'healthy' });
    await runTargetCommand(['--station=kontour'], {
      stdout,
      localServiceStatus,
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      }) as unknown as typeof fetch,
    });
    expect(localServiceStatus).toHaveBeenCalledWith(expect.any(URL), {
      instanceId: 'kontour-dev',
      baseDir: '/tmp/kontour-dev',
      serverPort: 43141,
      uiPort: 43000,
    });
  });
});
