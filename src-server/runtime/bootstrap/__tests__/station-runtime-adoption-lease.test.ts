// @vitest-environment node

import { describe, expect, test, vi } from 'vitest';
import { StationRuntime } from '../station-runtime.js';

/**
 * station#1815. The runtime holds this home's runtime lease from construction
 * until shutdown releases it, and boot fires a native-engine adoption window
 * that probes the host PATH and then WRITES the agent registry. Aborting that
 * window ends its retry schedule; it does not end a probe or a write already
 * running. Releasing the lease on the abort alone therefore handed the home
 * away — to a maintenance holder in production, to `rm -rf` in a test — with a
 * writer still live, observed as `STATION_HOME_RESET_REQUIRED` and `ENOENT:
 * rename` attributed to whichever case happened to be running (#1791).
 *
 * What these cases have to hold is an ORDER, not a duration: the last
 * registry write settles before the lease is released, or shutdown says it
 * could not establish that.
 */

interface ShutdownDouble {
  runtime: any;
  log: string[];
  release: ReturnType<typeof vi.fn>;
}

/**
 * The teardown steps `shutdownAfterConfigurationDrain` walks, reduced to the
 * ones it cannot skip. Everything here settles synchronously or in
 * microtasks, which is what makes the adoption window the ONLY outstanding
 * work in these cases — see `letShutdownRunToQuiescence`.
 */
function shutdownDouble(): ShutdownDouble {
  const log: string[] = [];
  const runtime = Object.create(StationRuntime.prototype) as any;
  const release = vi.fn(() => {
    log.push('lease-released');
  });

  runtime.logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  runtime.timers = [];
  runtime.nativeEngineAdoptionAbort = new AbortController();
  runtime.enginePrerequisitePrimingAbort = new AbortController();
  runtime.agentConfigurationPersistenceQueue = Promise.resolve();
  runtime.agentConfigurationMutationQueue = Promise.resolve();
  runtime.configurationSourceUnsubscribers = [];
  runtime.mcpConfigs = new Map();
  runtime.activeAgents = new Map();
  runtime.acpBridge = { shutdown: vi.fn(async () => {}) };
  runtime.feedbackService = { stop: vi.fn() };
  runtime.voiceService = { stop: vi.fn(async () => {}) };
  runtime.terminalWsServer = { stop: vi.fn() };
  runtime.terminalService = { dispose: vi.fn(async () => {}) };
  runtime.configLoader = { dispose: vi.fn(async () => {}) };
  runtime.pluginOperationalEventSubscriptions = {
    close: vi.fn(async () => ({ kind: 'closed' as const })),
  };
  runtime.orchestrationEventStore = { close: vi.fn() };
  runtime.stationHomeRuntimeLease = { ownerId: 'test-owner', release };
  return { runtime, log, release };
}

/**
 * Let the whole teardown run out.
 *
 * Deliberately not a budget on the behaviour under test: the adoption window
 * is the only thing in this double that has not settled, so a shutdown that
 * is NOT waiting for it has nothing left to do and has already released the
 * lease. The slack only ever helps the defect show itself — a slower host
 * gives an unfixed shutdown more time to release early, never less — so this
 * cannot pass by luck the way a deadline polled against the fixed behaviour
 * could.
 */
async function letShutdownRunToQuiescence(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('shutdown and the native-engine adoption window (station#1815)', () => {
  test('releases the home lease only after the last registry write lands', async () => {
    const { runtime, log, release } = shutdownDouble();
    let landWrite!: () => void;
    // Stands in for the exact thing the abort cannot stop: an
    // `adoptNativeEngineConnection` call that was already running when
    // shutdown began. Its resolution IS the write.
    runtime.nativeEngineAdoptionSettled = new Promise<void>((resolve) => {
      landWrite = () => {
        log.push('registry-write');
        resolve();
      };
    });
    runtime.nativeEngineAdoptionShutdownBudgetMs = 60_000;

    let shutdownResolved = false;
    const shutdown = runtime.shutdown().then(() => {
      shutdownResolved = true;
    });

    await letShutdownRunToQuiescence();
    expect(log).toEqual([]);
    expect(shutdownResolved).toBe(false);
    expect(release).not.toHaveBeenCalled();

    landWrite();
    await shutdown;
    expect(log).toEqual(['registry-write', 'lease-released']);
  });

  test('aborts the window before waiting on it', async () => {
    const { runtime } = shutdownDouble();
    let abortedWhenObserved: boolean | undefined;
    runtime.nativeEngineAdoptionSettled = Promise.resolve().then(() => {
      abortedWhenObserved = runtime.nativeEngineAdoptionAbort.signal.aborted;
    });
    runtime.nativeEngineAdoptionShutdownBudgetMs = 60_000;

    await runtime.shutdown();

    // A wait that did not cancel first would wait out the window's whole
    // ~2.2 minute retry schedule.
    expect(abortedWhenObserved).toBe(true);
  });

  test('reports the expired bound as itself and keeps the lease', async () => {
    const { runtime, log, release } = shutdownDouble();
    // A writer that never settles: the one state in which the runtime cannot
    // establish that the home is free.
    runtime.nativeEngineAdoptionSettled = new Promise<void>(() => {});
    runtime.nativeEngineAdoptionShutdownBudgetMs = 25;

    // Fake timers so the ONE thing this case cannot observe any other way —
    // that the bound fires at the value it was given — is settled by advancing
    // exactly that far, not by out-waiting it. Nothing else on this double's
    // teardown path depends on a timer firing. Under a real clock a bound
    // widened by a defect is indistinguishable from a slow host until the
    // runner's own deadline expires, which reports a timeout rather than the
    // condition.
    vi.useFakeTimers();
    try {
      let outcome: unknown = 'still waiting on the adoption window';
      void runtime.shutdown().then(
        (value: unknown) => {
          outcome = value ?? 'resolved without reporting the condition';
        },
        (error: unknown) => {
          outcome = error;
        },
      );
      // Exactly the budget. A bound that has been widened leaves `outcome`
      // untouched and this case names that, rather than expiring on the
      // runner's deadline with a timeout that says nothing.
      await vi.advanceTimersByTimeAsync(25);
      await vi.advanceTimersByTimeAsync(0);

      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(
        /Native engine adoption did not settle within 25ms .* lease was retained/s,
      );
    } finally {
      vi.useRealTimers();
    }
    expect(release).not.toHaveBeenCalled();
    expect(log).toEqual([]);
    // The rest of the teardown still ran — an unaccounted writer must not
    // strand the services this process is holding open.
    expect(runtime.orchestrationEventStore.close).toHaveBeenCalledTimes(1);
    expect(runtime.configLoader.dispose).toHaveBeenCalledTimes(1);
  });

  test('a window that already settled costs shutdown nothing', async () => {
    const { runtime, log, release } = shutdownDouble();
    runtime.nativeEngineAdoptionSettled = Promise.resolve();
    runtime.nativeEngineAdoptionShutdownBudgetMs = 25;

    await runtime.shutdown();

    expect(release).toHaveBeenCalledTimes(1);
    expect(log).toEqual(['lease-released']);
  });
});
