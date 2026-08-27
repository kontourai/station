/**
 * Structured readiness handshake for a supervising parent process.
 *
 * When Station is spawned by a supervisor (the desktop app) with
 * `STATION_STDOUT_HANDSHAKE=1`, it writes exactly one line of JSON to stdout
 * once every listener is bound. The supervisor parses this line to learn the
 * actually-bound base port (which is self-allocated when `PORT=0`) without
 * scanning the human-readable banner.
 */
export interface ReadinessHandshake {
  event: 'listening';
  port: number;
  host: string;
}

export interface ErrorObservableWritable {
  write(chunk: string): boolean;
  on?(event: 'error', listener: (error: unknown) => void): unknown;
}

/** True only for the broken-pipe error a departed desktop supervisor causes. */
export function isBrokenPipeError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'EPIPE'
  );
}

/**
 * Consume stdout EPIPE without logging from the error callback. Logging from
 * an error caused by stdout writes recursively writes to the same broken pipe
 * and can turn an ordinary supervised-parent loss into a fatal loop. The
 * notification is once-only; callers can begin their normal shutdown path
 * without ever attempting to describe the EPIPE on stdout.
 */
export function installStdoutEpipeGuard(
  stream: ErrorObservableWritable,
  onBrokenPipe: () => void,
): void {
  let notified = false;
  stream.on?.('error', (error) => {
    if (!isBrokenPipeError(error) || notified) return;
    notified = true;
    onBrokenPipe();
  });
}

/** Serializes the handshake as a single newline-terminated JSON line. */
export function formatReadinessHandshake(port: number, host: string): string {
  const payload: ReadinessHandshake = { event: 'listening', port, host };
  return `${JSON.stringify(payload)}\n`;
}

/**
 * Writes the readiness handshake to `stream` when `enabled`. A no-op otherwise,
 * so the normal foreground/dev path prints nothing extra.
 */
export function writeReadinessHandshake(
  stream: ErrorObservableWritable,
  port: number,
  host: string,
  enabled: boolean,
): boolean {
  if (!enabled) return true;
  try {
    stream.write(formatReadinessHandshake(port, host));
  } catch (error) {
    // Streams can report EPIPE asynchronously *or* synchronously depending
    // on platform and timing. The listener above handles the former; the
    // latter is equally non-actionable once the supervising stdout pipe is
    // gone. Do not call console/logger here — that would write the same pipe.
    if (!isBrokenPipeError(error)) throw error;
    return false;
  }
  return true;
}
