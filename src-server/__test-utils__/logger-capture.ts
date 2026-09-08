/**
 * Capture the lines a module-scope Station logger writes, for tests that used
 * to assert on `console.warn`/`console.debug` before those call sites moved
 * onto the logger seam.
 *
 * Reads through the same durable-sink seam production uses
 * (`installLoggerLineSink`), so an assertion here fails if the call site stops
 * logging — which is what the console spies it replaces were for.
 */

import { getInstalledServerLogSink } from '../services/infra/server-log-store.js';
import {
  type ConfigurableLogLevel,
  installLoggerLineSink,
  setGlobalLogLevel,
} from '../utils/logger.js';

export interface CapturedLogLine {
  level: string;
  msg: string;
  [key: string]: unknown;
}

export interface LoggerCapture {
  /** Every line written since the capture started, in write order. */
  lines(): CapturedLogLine[];
  /** Only the lines at one level. */
  at(level: string): CapturedLogLine[];
  /** Stops capturing and restores the tee to the installed store (see
   * `captureLoggerLines`). Safe to call more than once. */
  stop(): void;
}

let active: LoggerCapture | undefined;

/**
 * Stops whatever capture is currently installed. Call it from a file-level
 * `afterEach` when tests assert BEFORE their own `stop()`: a failing
 * assertion skips the inline stop, and the sink is process-wide.
 */
export function stopLoggerCaptures(): void {
  active?.stop();
  active = undefined;
}

/**
 * `level` raises EVERY logger in the process to that level for the duration,
 * which is what makes `debug` call sites observable at all — the seam drops a
 * line below the logger's own level before it reaches the sink. `stop()`
 * restores the seam default (`info`), NOT each logger's own prior level, so
 * only pass `level` from a file whose loggers are all default-level. Omit it
 * (the default) for `warn`/`error` call sites, which need no level change.
 *
 * `stop()` puts the tee back on `getInstalledServerLogSink()` rather than
 * clearing it. `installServerLogSink` is documented as the one call that
 * keeps the store registry and the logger tee in step
 * (`services/infra/server-log-store.ts`), and clearing the tee to `undefined`
 * would break exactly that invariant for a file that installs a real store
 * AND captures: the registry would still name the store while the logger
 * wrote nowhere. Restoring from the registry re-establishes the invariant
 * instead of inventing a second one, and reduces to today's behaviour
 * (`undefined`) when no store is installed.
 */
export function captureLoggerLines(
  level?: ConfigurableLogLevel,
): LoggerCapture {
  stopLoggerCaptures();
  const captured: CapturedLogLine[] = [];
  let stopped = false;
  if (level) setGlobalLogLevel(level);
  installLoggerLineSink({
    writeLine: (line) => {
      captured.push(JSON.parse(line) as CapturedLogLine);
    },
  });
  const capture: LoggerCapture = {
    lines: () => [...captured],
    at: (wanted) => captured.filter((line) => line.level === wanted),
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (active === capture) active = undefined;
      installLoggerLineSink(getInstalledServerLogSink());
      if (level) setGlobalLogLevel('info');
    },
  };
  active = capture;
  return capture;
}
