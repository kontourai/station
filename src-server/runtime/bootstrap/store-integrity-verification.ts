import {
  type ChildProcess,
  type SpawnOptions,
  spawn,
} from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MS_PER_HOUR, MS_PER_MINUTE } from '@kontourai/station-contracts/time';
import { recordCorruptionObserved } from '@kontourai/station-shared/sqlite-corruption-marker';
import {
  STORE_INTEGRITY_VERDICTS,
  type StoreIntegrityReport,
  type StoreIntegrityResult,
  storeIntegrityExitCode,
} from '@kontourai/station-shared/sqlite-store-integrity';
import { orchestrationStoreCorruptionObserved } from '../../telemetry/metrics.js';

/**
 * Verify the store on a schedule, in a child process.
 *
 * The reactive watch (archive#3215) notices corruption a query TOUCHES. Damage
 * to a page nothing reads can sit undetected indefinitely, and that is the
 * coverage the per-boot `PRAGMA quick_check` was actually buying — so it has
 * to be bought somewhere else before the boot check can be removed
 * (archive#3219).
 *
 * It cannot be bought on this thread. `node:sqlite`'s `DatabaseSync` is
 * synchronous, so the check would stall the event loop for its whole duration
 * — SSE frames, the terminal WebSocket, and every in-flight turn — and the
 * runtime already instruments exactly that failure
 * (`startRuntimeEventLoopLagMonitoring`). So the work goes to the bundled
 * `store-integrity-probe` sidecar and this file only reads its verdict.
 *
 * The SCHEDULE is deliberately the same shape as `startRuntimeHealthChecks`:
 * one `setInterval` pushed onto the runtime's existing `timers`, cleared by
 * the existing `shutdownRuntimeServices`.
 *
 * Clearing the interval stops the NEXT probe; it does not stop one already
 * running, and `gracefulShutdown` ends in `process.exit`, which takes this
 * process's kill-timer with it. A probe in flight at shutdown would be
 * reparented to init, unbounded, still reading the store — and that window is
 * exactly the one where the probe is slowest (a stalled volume). Hence the
 * returned disposer: it aborts the child too, and the runtime calls it before
 * it tears anything else down (archive#3218 adversarial review).
 */

/**
 * Six hours. Long enough that the spawn is invisible next to a Station
 * session, short enough that a long-lived desktop instance verifies several
 * times a day. Page damage does not heal, so the cost of a wider window is
 * only latency to the finding.
 */
export const STORE_INTEGRITY_VERIFICATION_INTERVAL_MS = 6 * MS_PER_HOUR;

/**
 * A probe that has not answered in ten minutes is not answering. The bound is
 * a safety valve on a wedged child, not a performance budget — `quick_check`
 * on the largest store observed took under a second.
 */
export const STORE_INTEGRITY_PROBE_TIMEOUT_MS = 10 * MS_PER_MINUTE;

export interface StoreIntegrityProbeOutcome {
  results: StoreIntegrityResult[];
  /** Why no verdict could be read, when none could. */
  unreadable?: string;
}

interface Logger {
  debug: (message: string, metadata?: Record<string, unknown>) => void;
  warn: (message: string, metadata?: Record<string, unknown>) => void;
  error: (message: string, metadata?: Record<string, unknown>) => void;
}

export interface StoreIntegrityVerificationContext {
  timers: NodeJS.Timeout[];
  /** The store to verify. The runtime passes the one it opened. */
  databasePath: string;
  logger: Logger;
  intervalMs?: number;
  /** Where the bundled probe lives; defaults to this module's own directory. */
  moduleDir?: string;
  scheduleInterval?: (callback: () => void, interval: number) => NodeJS.Timeout;
  runProbe?: (databasePath: string) => Promise<StoreIntegrityProbeOutcome>;
  onCorruptionObserved?: (result: StoreIntegrityResult) => void;
}

/**
 * Starts the schedule and returns a disposer that stops it — including a probe
 * that is currently running. Idempotent.
 */
export function startStoreIntegrityVerification(
  context: StoreIntegrityVerificationContext,
): () => void {
  const interval =
    context.intervalMs ?? STORE_INTEGRITY_VERIFICATION_INTERVAL_MS;
  if (!Number.isSafeInteger(interval) || interval <= 0) {
    throw new Error(
      'Store integrity verification interval must be a positive integer',
    );
  }
  const moduleDir =
    context.moduleDir ?? dirname(fileURLToPath(import.meta.url));
  const teardown = new AbortController();
  const runProbe =
    context.runProbe ??
    ((databasePath: string) =>
      spawnStoreIntegrityProbe({
        moduleDir,
        databasePath,
        signal: teardown.signal,
      }));
  const onCorruptionObserved =
    context.onCorruptionObserved ??
    ((result: StoreIntegrityResult) => {
      // Marker FIRST, counter second. The marker is the durable record the
      // next start acts on; the counter is telemetry. A test whose metrics
      // mock is missing this instrument throws on `.add`, and with the order
      // reversed that throw is caught upstream as "verification failed" and
      // silently costs the marker — the same defect the reactive path had to
      // fix in `event-store.ts`.
      recordCorruptionObserved({
        databasePath: result.databasePath,
        observedAt: new Date().toISOString(),
        ...(result.errcode === undefined ? {} : { errcode: result.errcode }),
        ...(result.detail === undefined ? {} : { detail: result.detail }),
      });
      orchestrationStoreCorruptionObserved.add(1, {
        errcode: result.errcode ?? 'unknown',
        source: 'scheduled-probe',
      });
    });
  const scheduleInterval = context.scheduleInterval ?? setInterval;

  // One run at a time. The interval is hours and the probe is sub-second, so
  // an overlap means the child is wedged — and starting a second one against
  // a store the first has not finished reading only doubles the I/O nobody is
  // waiting on.
  let running = false;
  const verify = async (): Promise<void> => {
    if (running) {
      context.logger.warn(
        'Store integrity verification skipped: previous probe still running',
        { databasePath: context.databasePath },
      );
      return;
    }
    running = true;
    try {
      const outcome = await runProbe(context.databasePath);
      if (outcome.unreadable !== undefined) {
        // A probe that produced no verdict has said NOTHING about the bytes.
        // Reading its failure as corruption is how a missing bundle or a
        // spawn error would quarantine a healthy database.
        context.logger.warn(
          'Store integrity verification produced no verdict',
          {
            databasePath: context.databasePath,
            reason: outcome.unreadable,
          },
        );
        return;
      }
      for (const result of outcome.results) {
        if (result.verdict === 'corrupt') {
          context.logger.error(
            'Store integrity verification found corruption',
            {
              databasePath: result.databasePath,
              errcode: result.errcode,
            },
          );
          onCorruptionObserved(result);
          continue;
        }
        if (result.verdict !== 'ok') {
          // `unavailable` and `absent` are both statements about the CHECK,
          // not about the bytes, so neither reaches the marker. The runtime
          // opened this store moments ago, so either is still worth saying.
          context.logger.warn(
            'Store integrity verification did not reach a verdict on a store',
            {
              databasePath: result.databasePath,
              verdict: result.verdict,
              detail: result.detail,
            },
          );
          continue;
        }
        context.logger.debug('Store integrity verified', {
          databasePath: result.databasePath,
          durationMs: result.durationMs,
        });
      }
    } catch (error) {
      // A scheduled diagnostic must never take the runtime with it.
      context.logger.warn('Store integrity verification failed', {
        databasePath: context.databasePath,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
    }
  };

  // Deliberately not awaited. The first verification is what replaces the
  // per-boot check's coverage for a Station that restarts more often than the
  // interval, and the whole point of the sidecar is that waiting for it is
  // never something this process has to do.
  void verify();
  const timer = scheduleInterval(() => {
    void verify();
  }, interval);
  context.timers.push(timer);
  context.logger.debug('Store integrity verification started', {
    interval,
    databasePath: context.databasePath,
  });
  return () => {
    clearInterval(timer);
    teardown.abort();
  };
}

/**
 * Runs the bundled probe and reads its verdict from STDOUT, not from its exit
 * code.
 *
 * That distinction is load-bearing. The probe's `corrupt` exit code is 1,
 * which is also what Node exits with when it cannot find the entry file at
 * all — the dev/`tsx` case, where no bundle exists. Deriving the verdict from
 * the exit status would turn a missing sidecar into a corruption report
 * against the user's history. So the JSON is the verdict, the exit code is
 * only a cross-check, and a disagreement between them means neither is
 * trusted.
 */
export async function spawnStoreIntegrityProbe(input: {
  moduleDir: string;
  databasePath: string;
  timeoutMs?: number;
  /**
   * Aborting kills the child. Node's `spawn` honours this itself, so there is
   * no child handle to track here and nothing to leak once the probe is done.
   */
  signal?: AbortSignal;
  /**
   * Narrowed to the one call shape this makes, rather than `typeof spawn`:
   * the seam a test substitutes should be the contract this depends on, not
   * every overload `node:child_process` happens to export.
   */
  spawnFn?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
}): Promise<StoreIntegrityProbeOutcome> {
  const entry = join(input.moduleDir, 'store-integrity-probe.js');
  const spawnFn = input.spawnFn ?? spawn;
  const timeoutMs = input.timeoutMs ?? STORE_INTEGRITY_PROBE_TIMEOUT_MS;

  let child: ChildProcess;
  try {
    child = spawnFn(process.execPath, [entry, input.databasePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      // SIGTERM is `spawn`'s default, and a `quick_check` blocked on a
      // stalled volume is exactly the child that would not act on it.
      killSignal: 'SIGKILL',
    });
  } catch (error) {
    return {
      results: [],
      unreadable: `probe could not be spawned: ${message(error)}`,
    };
  }

  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const exit = await new Promise<{ code: number | null; failure?: string }>(
    (resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ code: null, failure: `probe exceeded ${timeoutMs}ms` });
      }, timeoutMs);
      timer.unref?.();
      child.once('error', (error) => {
        clearTimeout(timer);
        resolve({
          code: null,
          failure: `probe failed to run: ${message(error)}`,
        });
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({ code });
      });
    },
  );

  if (exit.failure !== undefined)
    return { results: [], unreadable: exit.failure };

  const report = parseReport(stdout);
  if (report === undefined) {
    return {
      results: [],
      unreadable: `probe printed no verdict (exit ${String(exit.code)})${
        stderr.trim() === '' ? '' : `: ${stderr.trim().slice(0, 500)}`
      }`,
    };
  }

  // The exit code is derived from the same results the JSON carries, so a
  // mismatch means the two halves of the probe's answer disagree and neither
  // can be acted on.
  const expected = storeIntegrityExitCode(report.results);
  if (exit.code !== expected) {
    return {
      results: [],
      unreadable: `probe verdict and exit code disagree (exit ${String(exit.code)}, expected ${expected})`,
    };
  }
  return { results: report.results };
}

function parseReport(stdout: string): StoreIntegrityReport | undefined {
  const line = stdout.trim();
  if (line === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Partial<StoreIntegrityReport>;
  if (typeof record.checkedAt !== 'string' || !Array.isArray(record.results))
    return undefined;
  // A result whose verdict is not one this runtime understands is not a
  // verdict. Dropping the whole report is right: a partial read of a
  // corruption report is the half nobody wants to be missing.
  for (const result of record.results) {
    if (
      typeof result !== 'object' ||
      result === null ||
      typeof (result as StoreIntegrityResult).databasePath !== 'string' ||
      !STORE_INTEGRITY_VERDICTS.includes(
        (result as StoreIntegrityResult).verdict,
      )
    )
      return undefined;
  }
  return { checkedAt: record.checkedAt, results: record.results };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
