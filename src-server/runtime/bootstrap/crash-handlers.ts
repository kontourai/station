import {
  type BuildProvenanceSnapshot,
  readBuildProvenanceSnapshot,
} from '../../routes/system/build-provenance.js';

/**
 * Process-level crash logging (archive#1895, logging slice 1 review round 2).
 *
 * Factored out of `src-server/index.ts` so the REAL wiring — not a
 * hand-written replica — is what the crash-integration test exercises, and
 * so the "logger itself must never crash the crash path" contract has its
 * own direct unit coverage.
 */

/** The subset of `Logger` the crash path needs. Deliberately narrow — see
 * `src-server/utils/logger.ts`'s `Pick<Logger, ...>` pattern elsewhere in
 * this seam. */
export interface CrashLogger {
  fatal(msg: string, context?: unknown): void;
  error(msg: string, context?: unknown): void;
}

export interface InstallCrashHandlersDeps {
  /** Best-effort synchronous drain of the durable log sink, called after a
   * `fatal` line so it survives a process that exits immediately after. */
  flushSync: () => void;
  /** Invoked after an uncaught exception has been logged and flushed —
   * `index.ts` wires this to its own graceful-shutdown sequence. */
  onUncaughtException?: (err: unknown) => void;
  /** Immutable identity captured during bootstrap. Its absence must never
   * suppress a crash record. */
  buildProvenanceSnapshot?: BuildProvenanceSnapshot;
}

/** Minimal shape of the thing `installCrashHandlers` registers listeners on
 * — `process` by default, or a fake in tests so a test run never mutates
 * the real global `process`'s listener list. */
export interface CrashHandlerTarget {
  on(
    event: 'unhandledRejection' | 'uncaughtException',
    listener: (...args: any[]) => void,
  ): unknown;
}

/**
 * Logs a `fatal` line and force-flushes the durable sink, in a way that can
 * never itself throw: if `logger.fatal` throws (a broken logger), falls back
 * to `console.error` with the ORIGINAL message/context preserved, plus a
 * second line naming the logging failure. `flushSync` failures are likewise
 * swallowed — the crash path must never crash.
 */
export function logFatalAndFlush(
  logger: Pick<CrashLogger, 'fatal'>,
  msg: string,
  context: unknown,
  flushSync: () => void,
  buildProvenanceSnapshot?: BuildProvenanceSnapshot,
): void {
  let crashContext = context;
  const build = readBuildProvenanceSnapshot(buildProvenanceSnapshot);
  if (build) {
    crashContext =
      typeof context === 'object' && context !== null
        ? { ...context, build }
        : { context, build };
  }
  try {
    logger.fatal(msg, crashContext);
  } catch (loggingError) {
    console.error(msg, crashContext);
    console.error(
      '(logger itself failed to emit the line above)',
      loggingError,
    );
  }
  try {
    flushSync();
  } catch {
    // best-effort flush; the crash path must never throw
  }
}

/**
 * Installs the two process-level crash listeners:
 * - `unhandledRejection` logs at `error` and does NOT exit (a plugin/provider
 *   promise rejection must not crash the server).
 * - `uncaughtException` logs a `fatal` line, force-flushes the sink, then
 *   calls `deps.onUncaughtException` (typically the caller's graceful
 *   shutdown) — never re-throws.
 *
 * `target` defaults to the real `process` but is injectable so tests can
 * assert the wiring without registering listeners on the real process.
 */
export function installCrashHandlers(
  logger: CrashLogger,
  deps: InstallCrashHandlersDeps,
  target: CrashHandlerTarget = process,
): void {
  target.on('unhandledRejection', (reason: unknown) => {
    console.error('Unhandled rejection (non-fatal):', reason);
    // Log only — do not exit. Plugin provider failures should not crash the server.
    try {
      logger.error('Unhandled rejection', { err: reason });
    } catch {
      // never let logging itself turn a non-fatal rejection into a crash
    }
  });
  target.on('uncaughtException', (err: unknown) => {
    console.error('Uncaught exception:', err);
    logFatalAndFlush(
      logger,
      'Uncaught exception',
      { err },
      deps.flushSync,
      deps.buildProvenanceSnapshot,
    );
    deps.onUncaughtException?.(err);
  });
}
