import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireStationHomeMaintenanceLease,
  acquireStationHomeMaintenanceLeaseAsync,
  acquireStationHomeRuntimeLease,
  StationHomeActiveError,
} from '../station-home-lifecycle.js';

const roots: string[] = [];
const PROCESS_TIMEOUT_MS = 15_000;

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'station-home-lifecycle-'));
  roots.push(value);
  return value;
}

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  while (!existsSync(path)) {
    if (Date.now() >= deadline)
      throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});

describe('Station home lifecycle authority', () => {
  it('waits asynchronously behind a real sync maintenance holder, then hands off', async () => {
    const home = join(root(), 'home');
    const sync = acquireStationHomeMaintenanceLease(home);
    const pending = acquireStationHomeMaintenanceLeaseAsync(home);
    setTimeout(() => sync.release(), 10);
    const asyncLease = await pending;
    await asyncLease.release();
    const reacquired = acquireStationHomeMaintenanceLease(home);
    reacquired.release();
  });

  it('rejects async maintenance while a live runtime owns the home, then releases cleanly', async () => {
    const home = join(root(), 'home');
    const identity = {
      alive: () => 'alive' as const,
      lookup: () => 'same-process-birth',
    };
    const runtime = acquireStationHomeRuntimeLease(home, {
      processIdentity: identity,
    });
    await expect(
      acquireStationHomeMaintenanceLeaseAsync(home, {
        processIdentity: identity,
      }),
    ).rejects.toBeInstanceOf(StationHomeActiveError);
    runtime.release();
    const maintenance = await acquireStationHomeMaintenanceLeaseAsync(home, {
      processIdentity: identity,
    });
    await maintenance.release();
  });

  it('releases async maintenance after an acquisition callback rejects', async () => {
    const home = join(root(), 'home');
    await expect(
      acquireStationHomeMaintenanceLeaseAsync(home, {
        afterMaintenanceAcquired: () => {
          throw new Error('callback failed');
        },
      }),
    ).rejects.toMatchObject({ code: 'STATION_HOME_LIFECYCLE_UNAVAILABLE' });
    const maintenance = await acquireStationHomeMaintenanceLeaseAsync(home);
    await maintenance.release();
  });

  it('makes async maintenance release idempotent and interoperable with sync reacquisition', async () => {
    const home = join(root(), 'home');
    const maintenance = await acquireStationHomeMaintenanceLeaseAsync(home);
    await maintenance.release();
    await maintenance.release();
    const sync = acquireStationHomeMaintenanceLease(home);
    sync.release();
  });

  it('allows multiple runtimes but excludes maintenance until every lease releases', () => {
    const home = join(root(), 'home');
    const identity = {
      alive: () => 'alive' as const,
      lookup: () => 'same-process-birth',
    };
    const first = acquireStationHomeRuntimeLease(home, {
      processIdentity: identity,
    });
    const second = acquireStationHomeRuntimeLease(home, {
      processIdentity: identity,
    });
    expect(() =>
      acquireStationHomeMaintenanceLease(home, {
        processIdentity: identity,
      }),
    ).toThrow(StationHomeActiveError);
    first.release();
    expect(() =>
      acquireStationHomeMaintenanceLease(home, {
        processIdentity: identity,
      }),
    ).toThrow(StationHomeActiveError);
    second.release();
    const maintenance = acquireStationHomeMaintenanceLease(home, {
      processIdentity: identity,
    });
    maintenance.release();
  });

  it(
    'keeps a late runtime start behind maintenance and admits it only after release',
    async () => {
      const directory = root();
      const home = join(directory, 'home');
      const attempted = join(directory, 'attempted');
      const acquired = join(directory, 'acquired');
      const resume = join(directory, 'resume');
      const maintenance = acquireStationHomeMaintenanceLease(home);
      const tsx = resolve(
        import.meta.dirname,
        '..',
        '..',
        '..',
        '..',
        'node_modules',
        'tsx',
        'dist',
        'cli.mjs',
      );
      const modulePath = resolve(
        import.meta.dirname,
        '..',
        'station-home-lifecycle.ts',
      );
      const source = `import {existsSync,writeFileSync} from 'node:fs'; import {acquireStationHomeRuntimeLease} from ${JSON.stringify(modulePath)}; writeFileSync(process.env.ATTEMPTED,''); const lease=acquireStationHomeRuntimeLease(process.env.HOME_DIR); writeFileSync(process.env.ACQUIRED,''); while(!existsSync(process.env.RESUME)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10); lease.release();`;
      const child = spawn(process.execPath, [tsx, '-e', source], {
        windowsHide: true,
        env: {
          ...process.env,
          HOME_DIR: home,
          ATTEMPTED: attempted,
          ACQUIRED: acquired,
          RESUME: resume,
        },
      });
      try {
        await waitFor(attempted);
        expect(existsSync(acquired)).toBe(false);
        maintenance.release();
        await waitFor(acquired);
        writeFileSync(resume, '');
        const exit = await new Promise<number | null>((resolveExit) =>
          child.once('exit', resolveExit),
        );
        expect(exit).toBe(0);
      } finally {
        maintenance.release();
        if (child.exitCode === null) child.kill('SIGKILL');
      }
    },
    PROCESS_TIMEOUT_MS,
  );

  it('reclaims a lease only after exact owner liveness proves it dead', () => {
    const home = join(root(), 'home');
    const liveIdentity = {
      alive: () => 'alive' as const,
      lookup: () => 'fixture-birth',
    };
    const lease = acquireStationHomeRuntimeLease(home, {
      processIdentity: liveIdentity,
    });
    expect(() =>
      acquireStationHomeMaintenanceLease(home, {
        processIdentity: liveIdentity,
      }),
    ).toThrow(StationHomeActiveError);
    const maintenance = acquireStationHomeMaintenanceLease(home, {
      processIdentity: { alive: () => 'dead' },
    });
    maintenance.release();
    lease.release();
  });
});
