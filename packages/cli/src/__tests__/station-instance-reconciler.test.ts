import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireFileMutationLock } from '@kontourai/station-shared/lifecycle-events';
import { describe, expect, test, vi } from 'vitest';
import {
  createStationInstanceReconciler,
  type ObservedInstanceState,
  STATION_INSTANCE_STATE_VERSION,
  type StationInstancePlatformAdapter,
} from '../commands/station-instance-reconciler.js';

const instance = {
  version: STATION_INSTANCE_STATE_VERSION,
  instanceId: 'station-test',
} as const;

function observed(
  overrides: Partial<ObservedInstanceState> = {},
): ObservedInstanceState {
  return {
    version: STATION_INSTANCE_STATE_VERSION,
    instance,
    manifest: 'present',
    manifestDetails: {
      host: '127.0.0.1',
      installedAt: '2026-08-13T00:00:00.000Z',
      instanceId: instance.instanceId,
      nodePath: '/node',
      platform: 'darwin',
      repoPath: '/station',
      serverPort: 3141,
      uiPort: 3000,
      unitPath: '/tmp/station.plist',
    },
    allowedOrigins: [],
    registry: null,
    installation: 'managed',
    supervisor: {
      state: 'inactive',
      present: true,
      enabled: true,
      linger: null,
      error: null,
    },
    unit: { active: false, present: true, error: null },
    identity: {
      state: 'absent',
      healthy: false,
      found: false,
      instanceId: instance.instanceId,
      server: {
        listening: false,
        pid: null,
        probe: 'unreachable',
        reachable: false,
      },
      ui: {
        listening: false,
        pid: null,
        probe: 'unreachable',
        reachable: false,
      },
    },
    ready: false,
    ports: { server: 3141, ui: 3000 },
    ...overrides,
  };
}

function platform(
  states: ObservedInstanceState[],
): StationInstancePlatformAdapter {
  return {
    inspect: vi.fn(async () => states.shift() ?? observed()),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    waitForRunning: vi.fn(async () => true),
  };
}

describe('StationInstanceReconciler Interface', () => {
  test('is idempotent for already-running and already-stopped desired state', async () => {
    for (const [desired, state] of [
      [
        'running',
        observed({
          supervisor: { ...observed().supervisor, state: 'active' },
          identity: { ...observed().identity, state: 'healthy', found: true },
          ready: true,
        }),
      ],
      [
        'stopped',
        observed({
          supervisor: { ...observed().supervisor, state: 'inactive' },
        }),
      ],
    ] as const) {
      const adapter = platform([state]);
      const result = await createStationInstanceReconciler(adapter).reconcile({
        instance,
        desired: { version: STATION_INSTANCE_STATE_VERSION, kind: desired },
      });
      expect(result).toMatchObject({ kind: 'already-converged' });
      expect(adapter.start).not.toHaveBeenCalled();
      expect(adapter.stop).not.toHaveBeenCalled();
    }
  });

  test('converges start only after observed supervisor and identity agree', async () => {
    const adapter = platform([
      observed(),
      observed({
        supervisor: { ...observed().supervisor, state: 'active' },
        identity: { ...observed().identity, state: 'healthy', found: true },
        ready: true,
      }),
    ]);
    const result = await createStationInstanceReconciler(adapter).reconcile({
      instance,
      desired: { version: STATION_INSTANCE_STATE_VERSION, kind: 'running' },
      deadlineMs: 20,
    });
    expect(result).toMatchObject({ kind: 'converged' });
    expect(adapter.start).toHaveBeenCalledOnce();
    expect(adapter.waitForRunning).toHaveBeenCalledWith(
      instance,
      20,
      expect.any(AbortSignal),
    );
  });

  test('returns timed-out rather than claiming convergence when readiness expires', async () => {
    const adapter = platform([observed()]);
    adapter.waitForRunning = vi.fn(async () => false);
    await expect(
      createStationInstanceReconciler(adapter).reconcile({
        instance,
        desired: { version: STATION_INSTANCE_STATE_VERSION, kind: 'running' },
        deadlineMs: 1,
      }),
    ).resolves.toMatchObject({ kind: 'partial' });
  });

  test('maps platform throws and post-action disagreement to total failed or partial outcomes', async () => {
    const throwing = platform([observed()]);
    throwing.start = vi.fn(async () => {
      throw new Error('launchd denied');
    });
    await expect(
      createStationInstanceReconciler(throwing).reconcile({
        instance,
        desired: { version: STATION_INSTANCE_STATE_VERSION, kind: 'running' },
      }),
    ).resolves.toMatchObject({ kind: 'partial', reason: 'launchd denied' });

    const partial = platform([
      observed(),
      observed({
        supervisor: { ...observed().supervisor, state: 'active' },
        identity: { ...observed().identity, state: 'unhealthy', found: true },
      }),
    ]);
    await expect(
      createStationInstanceReconciler(partial).reconcile({
        instance,
        desired: { version: STATION_INSTANCE_STATE_VERSION, kind: 'running' },
      }),
    ).resolves.toMatchObject({ kind: 'partial' });
  });

  test('coalesces same desired state and rejects an opposing concurrent intent', async () => {
    let releaseStart!: () => void;
    const adapter = platform([
      observed(),
      observed({
        supervisor: { ...observed().supervisor, state: 'active' },
        identity: { ...observed().identity, state: 'healthy', found: true },
        ready: true,
      }),
    ]);
    adapter.start = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseStart = resolve;
        }),
    );
    const reconciler = createStationInstanceReconciler(adapter);
    const first = reconciler.reconcile({
      instance,
      desired: { version: STATION_INSTANCE_STATE_VERSION, kind: 'running' },
    });
    const same = reconciler.reconcile({
      instance,
      desired: { version: STATION_INSTANCE_STATE_VERSION, kind: 'running' },
    });
    await expect(
      reconciler.reconcile({
        instance,
        desired: { version: STATION_INSTANCE_STATE_VERSION, kind: 'stopped' },
      }),
    ).resolves.toMatchObject({ kind: 'contended' });
    releaseStart();
    await expect(Promise.all([first, same])).resolves.toEqual([
      expect.objectContaining({ kind: 'converged' }),
      expect.objectContaining({ kind: 'converged' }),
    ]);
    expect(adapter.start).toHaveBeenCalledOnce();
  });

  test('enforces an expired deadline before it starts a platform action', async () => {
    const adapter = platform([observed()]);
    adapter.acquireInstanceLock = vi.fn(() => () => undefined);
    await expect(
      createStationInstanceReconciler(adapter).reconcile({
        instance,
        desired: { version: STATION_INSTANCE_STATE_VERSION, kind: 'running' },
        deadlineMs: 0,
      }),
    ).resolves.toMatchObject({ kind: 'timed-out' });
    expect(adapter.acquireInstanceLock).not.toHaveBeenCalled();
    expect(adapter.inspect).not.toHaveBeenCalled();
    expect(adapter.start).not.toHaveBeenCalled();
  });

  test('checks the absolute deadline after a blocking lock and releases it', async () => {
    const timedInstance = { ...instance, instanceId: 'blocking-lock' };
    const release = vi.fn();
    const adapter = platform([observed()]);
    adapter.acquireInstanceLock = vi.fn(() => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      return release;
    });
    await expect(
      createStationInstanceReconciler(adapter).reconcile({
        instance: timedInstance,
        desired: { version: STATION_INSTANCE_STATE_VERSION, kind: 'running' },
        deadlineMs: 1,
      }),
    ).resolves.toMatchObject({ kind: 'timed-out' });
    expect(release).toHaveBeenCalledOnce();
    expect(adapter.inspect).not.toHaveBeenCalled();
  });

  test('does not claim convergence after a blocking platform action exceeds its deadline', async () => {
    const timedInstance = { ...instance, instanceId: 'blocking-action' };
    const adapter = platform([
      observed(),
      observed({
        supervisor: { ...observed().supervisor, state: 'active' },
        identity: {
          ...observed().identity,
          state: 'healthy',
          healthy: true,
          found: true,
        },
        ready: true,
      }),
    ]);
    adapter.start = vi.fn(() => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      return Promise.resolve();
    });
    await expect(
      createStationInstanceReconciler(adapter).reconcile({
        instance: timedInstance,
        desired: { version: STATION_INSTANCE_STATE_VERSION, kind: 'running' },
        deadlineMs: 1,
      }),
    ).resolves.toMatchObject({ kind: 'partial' });
  });

  test('gives a same-desired coalesced caller its own deadline without cancelling the owner', async () => {
    const sharedInstance = { ...instance, instanceId: 'coalesced-deadline' };
    let releaseStart!: () => void;
    const adapter = platform([
      observed(),
      observed({
        supervisor: { ...observed().supervisor, state: 'active' },
        identity: {
          ...observed().identity,
          state: 'healthy',
          healthy: true,
          found: true,
        },
        ready: true,
      }),
    ]);
    adapter.start = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseStart = resolve;
        }),
    );
    const first = createStationInstanceReconciler(adapter).reconcile({
      instance: sharedInstance,
      desired: { version: STATION_INSTANCE_STATE_VERSION, kind: 'running' },
    });
    await vi.waitFor(() => expect(adapter.start).toHaveBeenCalledOnce());
    await expect(
      createStationInstanceReconciler(adapter).reconcile({
        instance: sharedInstance,
        desired: { version: STATION_INSTANCE_STATE_VERSION, kind: 'running' },
        deadlineMs: 1,
      }),
    ).resolves.toMatchObject({ kind: 'partial' });
    releaseStart();
    await expect(first).resolves.toMatchObject({ kind: 'converged' });
  });

  test('makes lock release failure a total failed outcome', async () => {
    const adapter = platform([
      observed({
        supervisor: { ...observed().supervisor, state: 'active' },
        identity: {
          ...observed().identity,
          state: 'healthy',
          healthy: true,
          found: true,
        },
        ready: true,
      }),
    ]);
    adapter.acquireInstanceLock = vi.fn(() => () => {
      throw new Error('unlink denied');
    });
    await expect(
      createStationInstanceReconciler(adapter).reconcile({
        instance: { ...instance, instanceId: 'release-failure' },
        desired: { version: STATION_INSTANCE_STATE_VERSION, kind: 'running' },
      }),
    ).resolves.toMatchObject({
      kind: 'failed',
      reason: 'Reconciliation lock release failed: unlink denied',
    });
  });

  test('reports hung inspection before action without starting the platform', async () => {
    const timedInstance = { ...instance, instanceId: 'hung-inspect' };
    const adapter = platform([]);
    adapter.inspect = vi.fn(() => new Promise<ObservedInstanceState>(() => {}));
    await expect(
      createStationInstanceReconciler(adapter).reconcile({
        instance: timedInstance,
        desired: { version: STATION_INSTANCE_STATE_VERSION, kind: 'running' },
        deadlineMs: 1,
      }),
    ).resolves.toMatchObject({ kind: 'timed-out' });
    expect(adapter.start).not.toHaveBeenCalled();
  });

  test('threads the scoped signal into initial inspection and releases its lock after timeout', async () => {
    const timedInstance = { ...instance, instanceId: 'initial-inspect-signal' };
    let seenSignal: AbortSignal | undefined;
    const release = vi.fn();
    const adapter = platform([]);
    adapter.acquireInstanceLock = vi.fn(() => release);
    adapter.inspect = vi.fn((_ref, signal) => {
      seenSignal = signal;
      return new Promise<ObservedInstanceState>(() => {});
    });
    await expect(
      createStationInstanceReconciler(adapter).reconcile({
        instance: timedInstance,
        desired: { version: STATION_INSTANCE_STATE_VERSION, kind: 'running' },
        deadlineMs: 10,
      }),
    ).resolves.toMatchObject({ kind: 'timed-out' });
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal?.aborted).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  test('threads the scoped signal into post-action inspection and retains the lock until it settles', async () => {
    const timedInstance = { ...instance, instanceId: 'final-inspect-signal' };
    let inspections = 0;
    let seenSignal: AbortSignal | undefined;
    let settleFinal!: (state: ObservedInstanceState) => void;
    const release = vi.fn();
    const adapter = platform([]);
    adapter.acquireInstanceLock = vi.fn(() => release);
    adapter.inspect = vi.fn((_ref, signal) => {
      inspections += 1;
      if (inspections === 1) return Promise.resolve(observed());
      seenSignal = signal;
      return new Promise<ObservedInstanceState>((resolve) => {
        settleFinal = resolve;
      });
    });
    await expect(
      createStationInstanceReconciler(adapter).reconcile({
        instance: timedInstance,
        desired: { version: STATION_INSTANCE_STATE_VERSION, kind: 'running' },
        deadlineMs: 10,
      }),
    ).resolves.toMatchObject({ kind: 'partial' });
    expect(seenSignal?.aborted).toBe(true);
    expect(release).not.toHaveBeenCalled();
    settleFinal(observed());
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  });

  test('keeps a standalone process alive through a hung initial inspection deadline', () => {
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
      'commands',
      'station-instance-reconciler.ts',
    );
    const source = `import {createStationInstanceReconciler,STATION_INSTANCE_STATE_VERSION} from ${JSON.stringify(modulePath)}; const instance={version:STATION_INSTANCE_STATE_VERSION,instanceId:'standalone-hung'}; const adapter={inspect:()=>new Promise(()=>{}),start:async()=>{},stop:async()=>{},waitForRunning:async()=>true}; (async()=>{const outcome=await createStationInstanceReconciler(adapter).reconcile({instance,desired:{version:STATION_INSTANCE_STATE_VERSION,kind:'running'},deadlineMs:20}); console.log(JSON.stringify(outcome));})().catch((error)=>{console.error(error);process.exitCode=1});`;
    const child = spawnSync(process.execPath, [tsx, '-e', source], {
      encoding: 'utf8',
      timeout: 1_000,
    });
    expect(child.error?.message ?? child.stderr).toBeFalsy();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({ kind: 'timed-out' });
  });

  test('returns partial when readiness hangs after start may have acted', async () => {
    const timedInstance = { ...instance, instanceId: 'hung-readiness' };
    const adapter = platform([observed()]);
    adapter.waitForRunning = vi.fn(() => new Promise<boolean>(() => {}));
    await expect(
      createStationInstanceReconciler(adapter).reconcile({
        instance: timedInstance,
        desired: { version: STATION_INSTANCE_STATE_VERSION, kind: 'running' },
        deadlineMs: 10,
      }),
    ).resolves.toMatchObject({
      kind: 'partial',
      reason: 'Station service did not become identity healthy after start',
    });
  });

  test('returns partial when post-action inspection hangs', async () => {
    const timedInstance = { ...instance, instanceId: 'hung-post-inspect' };
    const adapter = platform([]);
    let inspections = 0;
    adapter.inspect = vi.fn(() => {
      inspections += 1;
      return inspections === 1
        ? Promise.resolve(observed())
        : new Promise<ObservedInstanceState>(() => {});
    });
    await expect(
      createStationInstanceReconciler(adapter).reconcile({
        instance: timedInstance,
        desired: { version: STATION_INSTANCE_STATE_VERSION, kind: 'running' },
        deadlineMs: 10,
      }),
    ).resolves.toMatchObject({ kind: 'partial' });
  });

  test('holds the production per-instance lock through a timed-out action settlement', async () => {
    const lockingInstance = { ...instance, instanceId: 'locking-instance' };
    const root = mkdtempSync(join(tmpdir(), 'station-instance-reconcile-'));
    const lock = join(root, 'station-test.reconcile');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      let enterStart!: () => void;
      const startEntered = new Promise<void>((resolve) => {
        enterStart = resolve;
      });
      let settleStart!: () => void;
      const startSettlement = new Promise<void>((resolve) => {
        settleStart = resolve;
      });
      const adapter = platform([observed()]);
      adapter.acquireInstanceLock = vi.fn((_ref, options) =>
        acquireFileMutationLock(lock, { timeoutMs: options.timeoutMs }),
      );
      adapter.start = vi.fn(() => {
        enterStart();
        return startSettlement;
      });
      const firstReconciler = createStationInstanceReconciler(adapter);
      const secondReconciler = createStationInstanceReconciler(adapter);
      const pending = firstReconciler.reconcile({
        instance: lockingInstance,
        desired: { version: STATION_INSTANCE_STATE_VERSION, kind: 'running' },
        deadlineMs: 100,
      });
      await startEntered;
      expect(adapter.start).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toEqual({
        kind: 'partial',
        reason: 'Reconciliation deadline expired after action may have acted',
      });

      expect(existsSync(lock)).toBe(true);
      expect(statSync(lock).mode & 0o777).toBe(0o600);
      // Exercise the filesystem Adapter's lock directly: sharedOperations is
      // deliberately bypassed, proving the production lock itself contends.
      expect(() => acquireFileMutationLock(lock, { timeoutMs: 0 })).toThrow();
      await expect(
        secondReconciler.reconcile({
          instance: lockingInstance,
          desired: {
            version: STATION_INSTANCE_STATE_VERSION,
            kind: 'stopped',
          },
        }),
      ).resolves.toMatchObject({ kind: 'contended' });

      settleStart();
      await startSettlement;
      await vi.runAllTimersAsync();
      expect(existsSync(lock)).toBe(false);
      const retryRelease = acquireFileMutationLock(lock, { timeoutMs: 0 });
      retryRelease();
      expect(existsSync(lock)).toBe(false);
    } finally {
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('recovers a stale production lock and cleans up its owned record', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-instance-reconcile-'));
    const lock = join(root, 'stale.reconcile');
    writeFileSync(
      lock,
      JSON.stringify({ pid: 999_999, birth: 'dead', token: 'stale' }),
      { mode: 0o600 },
    );
    const adapter = platform([
      observed(),
      observed({
        supervisor: { ...observed().supervisor, state: 'active' },
        identity: { ...observed().identity, state: 'healthy', found: true },
        ready: true,
      }),
    ]);
    adapter.acquireInstanceLock = vi.fn((_ref, options) =>
      acquireFileMutationLock(lock, { timeoutMs: options.timeoutMs }),
    );
    await expect(
      createStationInstanceReconciler(adapter).reconcile({
        instance: { ...instance, instanceId: 'stale-recovery' },
        desired: { version: STATION_INSTANCE_STATE_VERSION, kind: 'running' },
      }),
    ).resolves.toMatchObject({ kind: 'converged' });
    expect(existsSync(lock)).toBe(false);
  });

  test('reports coherent absent installation through the typed not-installed outcome', async () => {
    const adapter = platform([
      observed({
        manifest: 'absent',
        installation: 'absent',
        supervisor: { ...observed().supervisor, state: 'inactive' },
      }),
    ]);
    await expect(
      createStationInstanceReconciler(adapter).reconcile({
        instance,
        desired: { version: STATION_INSTANCE_STATE_VERSION, kind: 'running' },
      }),
    ).resolves.toMatchObject({
      kind: 'not-installed',
    });
    expect(adapter.start).not.toHaveBeenCalled();
  });

  test('does not mislabel an incoherent absent manifest as not-installed', async () => {
    const adapter = platform([
      observed({
        manifest: 'absent',
        installation: 'absent',
        supervisor: {
          ...observed().supervisor,
          state: 'unknown',
          error: 'backend probe failed',
        },
      }),
    ]);
    await expect(
      createStationInstanceReconciler(adapter).reconcile({
        instance: { ...instance, instanceId: 'absent-probe-failure' },
        desired: { version: STATION_INSTANCE_STATE_VERSION, kind: 'running' },
      }),
    ).resolves.toMatchObject({ kind: 'failed' });
  });
});
