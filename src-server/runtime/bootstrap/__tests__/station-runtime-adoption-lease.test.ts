// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  NATIVE_ENGINE_ADOPTION_SHUTDOWN_BUDGET_MS,
  StationRuntime,
} from '../station-runtime.js';

const repoRoot = join(import.meta.dirname, '../../../..');
const source = (path: string) => readFileSync(join(repoRoot, path), 'utf-8');

/**
 * Every shutdown grace Station actually runs under, READ from its own source
 * rather than transcribed (station#1815 review round 2).
 *
 * The budget's docblock used to derive itself from "the time this process
 * has", citing the 5 s Unix stop — a quantity that does not exist, and whose
 * assertion was wrong by 5x for the primary desktop product. Transcribing the
 * real numbers into a comment would have the same failure mode one revision
 * later, so they are extracted here and the relationship is what gets pinned.
 */
function supervisorGraceMs(): Record<string, number> {
  const platform = source('packages/cli/src/commands/platform.ts');
  const desktop = source('src-desktop/src/lib.rs');
  const desktopTerminate = desktop.slice(
    desktop.indexOf('fn terminate_desktop_child'),
  );
  const read = (label: string, pattern: RegExp, text: string): number => {
    const match = pattern.exec(text);
    if (!match?.[1]) {
      throw new Error(
        `${label}: '${pattern}' no longer matches its source. The grace moved, ` +
          'or the code did — either way this table has stopped being true.',
      );
    }
    return Number(match[1]);
  };

  return {
    // `taskkill /F` is the forced form: no graceful phase at all.
    'station-stop-windows': /'taskkill',\s*\[\s*'\/F'/.test(platform) ? 0 : NaN,
    'desktop-quit':
      read('desktop-quit attempts', /for _ in 0\.\.(\d+)/, desktopTerminate) *
      read(
        'desktop-quit interval',
        /Duration::from_millis\((\d+)\)/,
        desktopTerminate,
      ),
    'station-stop-unix': read(
      'station-stop-unix',
      /const deadline = Date\.now\(\) \+ (\d+);/,
      platform,
    ),
    systemd:
      read(
        'systemd',
        /TimeoutStopSec=(\d+)/,
        source('packages/cli/src/commands/service-systemd.ts'),
      ) * 1000,
    launchd:
      read(
        'launchd',
        /LAUNCHD_EXIT_TIMEOUT_SECONDS = (\d+)/,
        source('packages/cli/src/commands/service-launchd.ts'),
      ) * 1000,
    // A bare SIGTERM has no supervisor and no deadline.
    'bare-sigterm': Number.POSITIVE_INFINITY,
  };
}

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
 * What these cases have to hold is an ORDER, and it has two halves. The wait
 * comes AFTER every teardown step the window cannot affect — a stop SIGKILLs
 * 5 s after SIGTERM, so a wait at the front of teardown means none of it runs
 * — and BEFORE the only two steps that depend on the window: the loader
 * dispose and the lease release.
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
 *
 * `orchestrationEventStore.close`, `configLoader.dispose` and the lease
 * release all record into one array, so the order between them is the
 * observable. The event-store close is the marker for "teardown that does not
 * depend on the window": it is the last such step before the wait.
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
  runtime.configLoader = {
    getProjectHomeDir: () => '/tmp/station-home-under-test',
    dispose: vi.fn(async () => {
      log.push('loader-disposed');
    }),
  };
  runtime.stationEnvironmentId = 'env-under-test';
  // Set because `stationEnvironmentId` is: `recordRuntimeLifecycle` returns
  // early without one, and a double that carries an identity but cannot
  // record its own lifecycle is not a shape the runtime ever has.
  runtime.operationalEventPublisher = {
    append: vi.fn(() => ({ kind: 'appended' as const })),
  };
  runtime.pluginOperationalEventSubscriptions = {
    close: vi.fn(async () => ({ kind: 'closed' as const })),
  };
  runtime.orchestrationEventStore = {
    close: vi.fn(() => {
      log.push('event-store-closed');
    }),
  };
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
  test('tears down everything else first, then waits, then disposes and releases', async () => {
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
    runtime.nativeEngineAdoptionSettleBudgetMs = () => 60_000;

    let shutdownResolved = false;
    const shutdown = runtime.shutdown().then(() => {
      shutdownResolved = true;
    });

    await letShutdownRunToQuiescence();
    // The half the reviewer's I7 probe defeats: with the wait at the front of
    // teardown this array is still EMPTY here, and a stop that SIGKILLs at 5 s
    // would have taken the event-store close, the service shutdown and the
    // plugin subscription close down with it.
    expect(log).toEqual(['event-store-closed']);
    expect(shutdownResolved).toBe(false);
    expect(runtime.configLoader.dispose).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();

    landWrite();
    await shutdown;
    expect(log).toEqual([
      'event-store-closed',
      'registry-write',
      'loader-disposed',
      'lease-released',
    ]);
  });

  test('aborts the window before waiting on it', async () => {
    const { runtime } = shutdownDouble();
    let abortedWhenObserved: boolean | undefined;
    runtime.nativeEngineAdoptionSettled = Promise.resolve().then(() => {
      abortedWhenObserved = runtime.nativeEngineAdoptionAbort.signal.aborted;
    });
    runtime.nativeEngineAdoptionSettleBudgetMs = () => 60_000;

    await runtime.shutdown();

    // A wait that did not cancel first would wait out the window's whole
    // ~2.2 minute retry schedule.
    expect(abortedWhenObserved).toBe(true);
  });

  test('discloses a window it ran out of time for without failing the shutdown', async () => {
    const { runtime, log, release } = shutdownDouble();
    // A writer that never settles. This is NOT only the wedged case: the
    // registry write takes two file mutation locks at a 10 s admission
    // deadline each and retries up to 8 times, so ordinary contention reaches
    // here too — which is why expiry must not report a wedge, and must not
    // make an otherwise clean shutdown reject.
    runtime.nativeEngineAdoptionSettled = new Promise<void>(() => {});
    runtime.nativeEngineAdoptionSettleBudgetMs = () => 25;

    // Fake timers so the ONE thing this case cannot observe any other way —
    // that the wait ends at the budget it was given — is settled by advancing
    // exactly that far, not by out-waiting it. Nothing else on this double's
    // teardown path depends on a timer firing. Under a real clock a budget
    // widened by a defect is indistinguishable from a slow host until the
    // runner's own deadline expires, which reports a timeout rather than the
    // condition.
    vi.useFakeTimers();
    try {
      let outcome: unknown = 'still waiting on the adoption window';
      void runtime.shutdown().then(
        (value: unknown) => {
          outcome = value ?? 'resolved';
        },
        (error: unknown) => {
          outcome = error;
        },
      );
      // Exactly the budget. A budget that has been widened leaves `outcome`
      // untouched and this case names that, rather than expiring on the
      // runner's deadline with a timeout that says nothing.
      await vi.advanceTimersByTimeAsync(25);
      await vi.advanceTimersByTimeAsync(0);

      expect(outcome).toBe('resolved');
    } finally {
      vi.useRealTimers();
    }

    const [message, fields] = runtime.logger.warn.mock.calls.at(-1) ?? [];
    expect(message).toMatch(/still running when shutdown ran out of time/);
    // The claim has to stay the one that is derivable. Naming only a wedge
    // here would be #1814's mistake with a different subject.
    expect(message).toMatch(/contention or a wedge/);
    expect(message).toMatch(
      /reaped by the next lease scan after this process is gone/,
    );
    // Which home, on a host running several instances.
    expect(fields).toEqual({
      budgetMs: 25,
      homeDir: '/tmp/station-home-under-test',
      environmentId: 'env-under-test',
      leaseOwnerId: 'test-owner',
    });

    // Neither claim the runtime can no longer make is made.
    expect(release).not.toHaveBeenCalled();
    expect(runtime.configLoader.dispose).not.toHaveBeenCalled();
    // Everything that does not depend on the writer still ran.
    expect(log).toEqual(['event-store-closed']);
    expect(runtime.orchestrationEventStore.close).toHaveBeenCalledTimes(1);
  });

  test('waits the shipped budget when nothing overrides it', async () => {
    const { runtime, release } = shutdownDouble();
    runtime.nativeEngineAdoptionSettled = new Promise<void>(() => {});
    // No override: this case reads whatever the runtime itself would use.

    vi.useFakeTimers();
    try {
      let resolved = false;
      void runtime.shutdown().then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(
        NATIVE_ENGINE_ADOPTION_SHUTDOWN_BUDGET_MS - 1,
      );
      expect(resolved).toBe(false);
      expect(runtime.logger.warn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(true);
      expect(runtime.logger.warn.mock.calls.at(-1)?.[1]).toMatchObject({
        budgetMs: NATIVE_ENGINE_ADOPTION_SHUTDOWN_BUDGET_MS,
      });
    } finally {
      vi.useRealTimers();
    }
    expect(release).not.toHaveBeenCalled();
  });

  test('outlasts exactly the two graces its docblock says it outlasts', () => {
    const graces = supervisorGraceMs();
    // A misread regex must red as a missing grace, never pass as a NaN that
    // silently drops out of the comparison below.
    for (const [supervisor, ms] of Object.entries(graces)) {
      expect(`${supervisor}=${ms}`).not.toMatch(/NaN/);
    }

    // The property, computed rather than asserted: this budget does NOT fit
    // every supervisor, and these are the ones it exceeds. Moving the budget,
    // or any of those graces, changes this set — which is the moment the
    // docblock's table has to be looked at again. The first version of that
    // docblock claimed the budget WAS the grace, and this list is what made
    // that false.
    const outlasted = Object.entries(graces)
      .filter(([, ms]) => ms < NATIVE_ENGINE_ADOPTION_SHUTDOWN_BUDGET_MS)
      .map(([supervisor]) => supervisor)
      .sort();
    expect(outlasted).toEqual(['desktop-quit', 'station-stop-windows']);

    // And the literal, beside the computed case for the reason my own notes
    // give: a test written only against the constant follows the constant
    // anywhere.
    expect(NATIVE_ENGINE_ADOPTION_SHUTDOWN_BUDGET_MS).toBe(5_000);
    expect(graces['station-stop-unix']).toBe(5_000);
  });

  test('a window that already settled costs shutdown nothing', async () => {
    const { runtime, log, release } = shutdownDouble();
    runtime.nativeEngineAdoptionSettled = Promise.resolve();
    runtime.nativeEngineAdoptionSettleBudgetMs = () => 25;

    await runtime.shutdown();

    expect(release).toHaveBeenCalledTimes(1);
    expect(runtime.logger.warn).not.toHaveBeenCalled();
    expect(log).toEqual([
      'event-store-closed',
      'loader-disposed',
      'lease-released',
    ]);
  });
});
