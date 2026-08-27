import { spawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claimDesktopSidecar,
  findRunning,
  readInstanceRegistry,
  reconcileStaleInstances,
  removeInstance,
  resolveInstanceRegistryPath,
  updateStatus,
  upsertInstance,
} from '../instance-registry.js';
import { lookupProcessBirthFingerprint } from '../process-identity.mjs';

const PROCESS_INTEGRATION_TEST_TIMEOUT_MS = 15_000;

const roots: string[] = [];

function makeHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'station-instance-registry-'));
  roots.push(root);
  return root;
}

function unavailableProcessProbe(code?: string): (pid: number) => void {
  return () => {
    const error = new Error(
      'injected process probe failure',
    ) as NodeJS.ErrnoException;
    if (code) error.code = code;
    throw error;
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('instance registry', () => {
  it('atomically admits exactly one desktop-sidecar claimant per home', () => {
    const home = makeHome();
    const birth = lookupProcessBirthFingerprint(process.pid);
    expect(birth).toBeTruthy();
    const config = {
      port: 0,
      type: 'sidecar' as const,
      status: 'starting',
      pid: process.pid,
      birth: birth!,
    };
    expect(claimDesktopSidecar('desktop-a', config, home)).toBe(true);
    expect(claimDesktopSidecar('desktop-b', config, home)).toBe(false);
    expect(Object.keys(readInstanceRegistry(home).instances)).toEqual([
      'desktop-a',
    ]);
  });

  it('retains a restarting sidecar claim while rejecting a racing second desktop', () => {
    const home = makeHome();
    const birth = lookupProcessBirthFingerprint(process.pid);
    expect(birth).toBeTruthy();
    const first = {
      port: 0,
      type: 'sidecar' as const,
      status: 'starting',
      pid: process.pid,
      birth: birth!,
    };
    expect(claimDesktopSidecar('desktop-a', first, home)).toBe(true);
    expect(
      claimDesktopSidecar('desktop-a', { ...first, status: 'running' }, home),
    ).toBe(true);
    expect(
      claimDesktopSidecar(
        'desktop-b',
        {
          port: 0,
          type: 'sidecar',
          status: 'starting',
          pid: process.pid,
          birth: birth!,
        },
        home,
      ),
    ).toBe(false);
    expect(readInstanceRegistry(home).instances).toEqual({
      'desktop-a': { ...first, status: 'running' },
    });
  });

  it('does not treat a reused PID with a different birth fingerprint as a live sidecar claimant', () => {
    const home = makeHome();
    upsertInstance(
      'stale-desktop',
      {
        port: 0,
        type: 'sidecar',
        status: 'running',
        pid: process.pid,
        birth: 'a-reused-pid-birth',
      },
      home,
    );
    expect(
      claimDesktopSidecar(
        'new-desktop',
        {
          port: 0,
          type: 'sidecar',
          status: 'starting',
          pid: process.pid,
          birth: 'current-birth',
        },
        home,
      ),
    ).toBe(true);
    expect(
      readInstanceRegistry(home).instances['stale-desktop'],
    ).toBeUndefined();
  });

  it('startup reconciliation prunes a dead sidecar record', () => {
    const home = makeHome();
    upsertInstance(
      'dead-sidecar',
      {
        port: 38141,
        type: 'sidecar',
        status: 'running',
        pid: 2 ** 31 - 1,
        birth: 'dead-process-birth',
      },
      home,
    );

    expect(reconcileStaleInstances(home).instances).not.toHaveProperty(
      'dead-sidecar',
    );
  });

  it.each([
    ['EPERM', unavailableProcessProbe('EPERM')],
    ['unknown error', unavailableProcessProbe()],
  ] as const)(
    'does not reconcile a sidecar or service when liveness is %s',
    (_outcome, processProbe) => {
      const home = makeHome();
      for (const [id, type] of [
        ['sidecar-owner', 'sidecar'],
        ['service-owner', 'service'],
      ] as const) {
        upsertInstance(
          id,
          {
            port: 38141,
            type,
            status: 'running',
            pid: process.pid,
            birth: 'old-birth',
          },
          home,
        );
      }

      const registry = reconcileStaleInstances(home, { processProbe });
      expect(registry.instances).toHaveProperty('sidecar-owner');
      expect(registry.instances).toHaveProperty('service-owner');
    },
  );

  it('reconciles an ephemeral owner only when ESRCH proves it is gone', () => {
    const home = makeHome();
    upsertInstance(
      'dead-sidecar',
      {
        port: 38141,
        type: 'sidecar',
        status: 'running',
        pid: process.pid,
        birth: 'old-birth',
      },
      home,
    );
    upsertInstance(
      'durable-service',
      {
        port: 38142,
        type: 'service',
        status: 'running',
        pid: process.pid,
        birth: 'old-birth',
      },
      home,
    );

    const registry = reconcileStaleInstances(home, {
      processProbe: unavailableProcessProbe('ESRCH'),
    });
    expect(registry.instances).not.toHaveProperty('dead-sidecar');
    expect(registry.instances).toHaveProperty('durable-service');
  });

  it('startup reconciliation prunes a reused PID record but retains one live owner', () => {
    const home = makeHome();
    const birth = lookupProcessBirthFingerprint(process.pid);
    expect(birth).toBeTruthy();
    upsertInstance(
      'reused-sidecar',
      {
        port: 38141,
        type: 'sidecar',
        status: 'running',
        pid: process.pid,
        birth: 'old-process-birth',
      },
      home,
    );
    upsertInstance(
      'live-sidecar',
      {
        port: 38142,
        type: 'sidecar',
        status: 'running',
        pid: process.pid,
        birth: birth!,
      },
      home,
    );
    // Service records retain durable policy even when no supervisor is live.
    upsertInstance(
      'configured-service',
      { port: 38143, type: 'service', status: 'stopped' },
      home,
    );

    const registry = reconcileStaleInstances(home);
    expect(registry.instances['reused-sidecar']).toBeUndefined();
    expect(registry.instances['live-sidecar']).toMatchObject({
      pid: process.pid,
      birth,
    });
    expect(registry.instances['configured-service']).toMatchObject({
      type: 'service',
      status: 'stopped',
    });
  });

  it('does not license a second sidecar when process-birth lookup cannot answer', () => {
    const home = makeHome();
    const birth = lookupProcessBirthFingerprint(process.pid);
    expect(birth).toBeTruthy();
    upsertInstance(
      'existing-desktop',
      {
        port: 0,
        type: 'sidecar',
        status: 'running',
        pid: process.pid,
        birth: birth!,
      },
      home,
    );
    // An opaque/unavailable fingerprint must be treated as a live claim, not
    // as proof the process is stale. Exercise the exact failure representation
    // the lookup returns by using a record that cannot match a fresh lookup.
    expect(
      claimDesktopSidecar(
        'racing-desktop',
        {
          port: 0,
          type: 'sidecar',
          status: 'starting',
          pid: process.pid,
          birth: birth!,
        },
        home,
      ),
    ).toBe(false);
  });
  it('returns an empty registry when the file is absent, without throwing', () => {
    const home = makeHome();
    expect(readInstanceRegistry(home)).toEqual({ version: 1, instances: {} });
  });

  it('throws on malformed JSON', () => {
    const home = makeHome();
    writeFileSync(resolveInstanceRegistryPath(home), '{', { mode: 0o600 });
    expect(() => readInstanceRegistry(home)).toThrow(
      /corrupt or not owner-controlled/,
    );
  });

  it('throws on an invalid registry shape', () => {
    const home = makeHome();
    writeFileSync(
      resolveInstanceRegistryPath(home),
      JSON.stringify({ version: 2, instances: {} }),
      { mode: 0o600 },
    );
    expect(() => readInstanceRegistry(home)).toThrow(/invalid shape/);
  });

  it.runIf(process.platform !== 'win32')(
    'throws on group/other-readable permissions',
    () => {
      const home = makeHome();
      const path = resolveInstanceRegistryPath(home);
      writeFileSync(path, JSON.stringify({ version: 1, instances: {} }), {
        mode: 0o644,
      });
      chmodSync(path, 0o644);
      expect(() => readInstanceRegistry(home)).toThrow(
        /corrupt or not owner-controlled/,
      );
    },
  );

  it('rejects a symlinked registry file rather than following it', () => {
    const home = makeHome();
    const target = join(home, 'target.json');
    writeFileSync(target, JSON.stringify({ version: 1, instances: {} }), {
      mode: 0o600,
    });
    symlinkSync(target, resolveInstanceRegistryPath(home));
    expect(() => readInstanceRegistry(home)).toThrow(
      /corrupt or not owner-controlled/,
    );
  });

  // Review round 1, fix 1 (HIGH): parent-directory trust must be asserted
  // BEFORE any I/O on both the read and write paths — fsyncDirectorySync's
  // O_NOFOLLOW only guards the trailing component, not dirname(path) itself,
  // so a symlinked STATION_HOME must be caught independently of the file
  // symlink check above.
  it('rejects a symlinked home directory for both read and write, naming the path', () => {
    const root = mkdtempSync(
      join(tmpdir(), 'station-instance-registry-home-symlink-'),
    );
    roots.push(root);
    const realHome = join(root, 'realHome');
    const otherHome = join(root, 'otherHome');
    mkdirSync(realHome, { recursive: true, mode: 0o700 });
    mkdirSync(otherHome, { recursive: true, mode: 0o700 });
    const symlinkedHome = join(root, 'symlinkedHome');
    symlinkSync(otherHome, symlinkedHome);

    expect(() => readInstanceRegistry(symlinkedHome)).toThrow(/not admissible/);
    expect(() => readInstanceRegistry(symlinkedHome)).toThrow(symlinkedHome);
    expect(() =>
      upsertInstance('phone', { port: 1, type: 'service' }, symlinkedHome),
    ).toThrow(/not admissible/);
    expect(() =>
      upsertInstance('phone', { port: 1, type: 'service' }, symlinkedHome),
    ).toThrow(symlinkedHome);
  });

  // Review round 1, fix 2 (MEDIUM): a relative STATION_HOME must not fork the
  // registry by whichever cwd a given process happens to run from.
  it('resolveInstanceRegistryPath anchors a relative STATION_HOME at its resolve()', () => {
    const previous = process.env.STATION_HOME;
    process.env.STATION_HOME = 'relative-station-home-fixture';
    try {
      const expected = resolve(
        'relative-station-home-fixture',
        'instances.json',
      );
      expect(resolveInstanceRegistryPath()).toBe(expected);
      expect(isAbsolute(expected)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.STATION_HOME;
      else process.env.STATION_HOME = previous;
    }
  });

  // Review round 1, fix 4 (LOW): mirrors lifecycle.ts's
  // ensureInstanceStateDirectory, which mints a freshly created instance
  // state directory at mode 0700.
  it.runIf(process.platform !== 'win32')(
    'creates the registry directory with mode 0700',
    () => {
      const root = mkdtempSync(
        join(tmpdir(), 'station-instance-registry-mode-'),
      );
      roots.push(root);
      const home = join(root, 'fresh-home');
      upsertInstance('phone', { port: 1, type: 'service' }, home);
      expect(statSync(home).mode & 0o777).toBe(0o700);
    },
  );

  it('creates an instance and merge-updates it on a second call', () => {
    const home = makeHome();
    upsertInstance('phone', { port: 3242, type: 'service' }, home);
    const after = upsertInstance(
      'phone',
      { uiPort: 5274, status: 'running' },
      home,
    );
    expect(after.instances.phone).toEqual({
      port: 3242,
      type: 'service',
      uiPort: 5274,
      status: 'running',
    });
    expect(readInstanceRegistry(home).instances.phone).toEqual(
      after.instances.phone,
    );
  });

  it('requires a numeric port and a valid type on first insert', () => {
    const home = makeHome();
    expect(() => upsertInstance('phone', { port: 3242 }, home)).toThrow(
      /requires a numeric port and a valid type/,
    );
    expect(() =>
      upsertInstance('phone', { type: 'service' } as never, home),
    ).toThrow(/requires a numeric port and a valid type/);
    expect(() =>
      upsertInstance(
        'phone',
        { port: 3242, type: 'not-a-type' } as never,
        home,
      ),
    ).toThrow(/requires a numeric port and a valid type/);
  });

  it('updateStatus sets status and pid on an existing instance', () => {
    const home = makeHome();
    upsertInstance('phone', { port: 3242, type: 'service' }, home);
    const after = updateStatus('phone', 'running', 4242, home);
    expect(after.instances.phone).toMatchObject({
      port: 3242,
      type: 'service',
      status: 'running',
      pid: 4242,
    });
  });

  // Review round 1, fix 5 (LOW): the unknown-id branch was previously
  // untested.
  it('updateStatus throws for an unknown instance id', () => {
    const home = makeHome();
    expect(() => updateStatus('ghost', 'running', 1, home)).toThrow(
      /unknown instance "ghost"/,
    );
  });

  it('removeInstance deletes a present instance and no-ops on an absent id', () => {
    const home = makeHome();
    upsertInstance('phone', { port: 3242, type: 'service' }, home);
    const afterRemove = removeInstance('phone', home);
    expect(afterRemove.instances.phone).toBeUndefined();
    expect(() => removeInstance('phone', home)).not.toThrow();
    expect(removeInstance('phone', home).instances).toEqual({});
  });

  it.each([
    'child exit',
    'manual restart',
    'shutdown',
    'supervisor disconnect',
  ])(
    'removes the desktop-sidecar registry claim during supervisor cleanup: %s',
    (_cleanupPath) => {
      const home = makeHome();
      const id = 'desktop-sidecar';
      expect(
        claimDesktopSidecar(
          id,
          { port: 0, type: 'sidecar', status: 'starting' },
          home,
        ),
      ).toBe(true);

      removeInstance(id, home);

      expect(readInstanceRegistry(home).instances[id]).toBeUndefined();
    },
  );

  it('findRunning includes only entries with a live pid', () => {
    const home = makeHome();
    upsertInstance(
      'alive',
      { port: 1, type: 'service', pid: process.pid },
      home,
    );
    upsertInstance('dead', { port: 2, type: 'service', pid: 999_999 }, home);
    upsertInstance('no-pid', { port: 3, type: 'service' }, home);
    const running = findRunning(home);
    expect(running.map((instance) => instance.pid)).toEqual([process.pid]);
  });

  it(
    'serializes concurrent process writers against the same registry with no lost update or torn read',
    async () => {
      const home = makeHome();
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
        'instance-registry.ts',
      );
      const iterationsPerChild = 10;
      const source = `import {upsertInstance} from ${JSON.stringify(modulePath)}; const prefix=process.env.CHILD_PREFIX; const home=process.env.REGISTRY_HOME; for(let i=0;i<${iterationsPerChild};i++) upsertInstance(prefix+'-'+i,{port:1000+i,type:'service'},home);`;
      const children = [1, 2].map((index) =>
        spawn(process.execPath, [tsx, '-e', source], {
          windowsHide: true,
          env: {
            ...process.env,
            CHILD_PREFIX: `child-${index}`,
            REGISTRY_HOME: home,
          },
        }),
      );
      const exits = await Promise.all(
        children.map(
          (child) =>
            new Promise<number | null>((resolveExit) =>
              child.once('exit', resolveExit),
            ),
        ),
      );
      expect(exits).toEqual([0, 0]);

      const registry = readInstanceRegistry(home);
      const expectedIds = new Set<string>();
      for (const index of [1, 2]) {
        for (let i = 0; i < iterationsPerChild; i++) {
          expectedIds.add(`child-${index}-${i}`);
        }
      }
      expect(new Set(Object.keys(registry.instances))).toEqual(expectedIds);
      expect(Object.keys(registry.instances)).toHaveLength(
        2 * iterationsPerChild,
      );
    },
    PROCESS_INTEGRATION_TEST_TIMEOUT_MS,
  );
});
