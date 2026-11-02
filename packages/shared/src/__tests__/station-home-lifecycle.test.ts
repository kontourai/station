import childProcess, { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireStationHomeMaintenanceLease,
  acquireStationHomeMaintenanceLeaseAsync,
  acquireStationHomeRuntimeLease,
  assertStationHomeRuntimeProof,
  captureStationHomeRuntimeProof,
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
  it.skipIf(process.platform !== 'darwin')(
    'does not re-spawn an own-process birth probe for each runtime proof',
    async () => {
      const home = root();
      const exec = vi.spyOn(childProcess, 'execFileSync');
      syncBuiltinESMExports();
      let lease: ReturnType<typeof acquireStationHomeRuntimeLease> | undefined;
      const ownProbes = () =>
        exec.mock.calls.filter(
          ([file, args]) =>
            file === 'ps' &&
            Array.isArray(args) &&
            args.includes(String(process.pid)),
        );
      try {
        lease = acquireStationHomeRuntimeLease(home);
        const proof = captureStationHomeRuntimeProof(home, lease);
        expect(ownProbes().length).toBeGreaterThan(0);
        exec.mockClear();
        for (let i = 0; i < 3; i++) {
          await Promise.resolve();
          assertStationHomeRuntimeProof(proof);
        }
        expect(ownProbes()).toHaveLength(0);
      } finally {
        lease?.release();
        exec.mockRestore();
        syncBuiltinESMExports();
      }
    },
  );

  it('re-reads its runtime lease record before accepting a captured proof', () => {
    const home = root();
    const lease = acquireStationHomeRuntimeLease(home);
    const proof = captureStationHomeRuntimeProof(home, lease);
    const canonicalHome = realpathSync(home);
    const identity =
      process.platform === 'win32'
        ? canonicalHome.toLowerCase()
        : canonicalHome;
    const path = join(
      tmpdir(),
      'kontourai-station-home-lifecycle',
      createHash('sha256').update(identity).digest('hex'),
      'runtime-leases',
      `${lease.ownerId}.json`,
    );
    const original = readFileSync(path, 'utf8');
    const record: unknown = JSON.parse(original);
    expect(record).toBeTypeOf('object');
    if (!record || typeof record !== 'object')
      throw new Error('Lease record missing');
    try {
      for (const changed of [
        { ownerId: randomUUID() },
        { pid: process.pid + 1 },
        { birth: 'foreign-process-birth' },
      ]) {
        writeFileSync(path, JSON.stringify({ ...record, ...changed }));
        expect(() => assertStationHomeRuntimeProof(proof)).toThrow(
          'Runtime lease ownership changed',
        );
        writeFileSync(path, original);
        expect(() => assertStationHomeRuntimeProof(proof)).not.toThrow();
      }
    } finally {
      writeFileSync(path, original);
      lease.release();
    }
    expect(() => assertStationHomeRuntimeProof(proof)).toThrow(
      'Runtime lease is released',
    );
  });

  it('captures only an exact live runtime lease for the same home', () => {
    const home = join(root(), 'home');
    const other = join(root(), 'other');
    const lease = acquireStationHomeRuntimeLease(home);
    const proof = captureStationHomeRuntimeProof(home, lease);
    expect(() => assertStationHomeRuntimeProof(proof)).not.toThrow();
    expect(() => captureStationHomeRuntimeProof(other, lease)).toThrow();
    expect(() =>
      captureStationHomeRuntimeProof(home, {
        ownerId: lease.ownerId,
        release() {},
      }),
    ).toThrow();
    expect(() =>
      assertStationHomeRuntimeProof({ assertCurrent() {} }),
    ).toThrow();
    lease.release();
    const replacement = acquireStationHomeRuntimeLease(home);
    try {
      expect(() => assertStationHomeRuntimeProof(proof)).toThrow();
      expect(() => captureStationHomeRuntimeProof(home, lease)).toThrow();
      const replacementProof = captureStationHomeRuntimeProof(
        home,
        replacement,
      );
      expect(() =>
        assertStationHomeRuntimeProof(replacementProof),
      ).not.toThrow();
    } finally {
      replacement.release();
    }
  });

  it('publishes its own exact lease after a transient Windows birth-probe miss', () => {
    const home = join(root(), 'home');
    let probes = 0;
    const runtime = acquireStationHomeRuntimeLease(home, {
      processIdentity: {
        platform: 'win32',
        alive: () => 'alive',
        lookup: () => (++probes === 1 ? null : 'same-process-birth'),
        wait: () => {},
      },
    });
    expect(probes).toBe(2);
    runtime.release();
  });

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
    try {
      await maintenance.release();
      expect(() => acquireStationHomeMaintenanceLease(home)).toThrow();
    } finally {
      sync.release();
    }
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
