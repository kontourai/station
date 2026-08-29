/**
 * Bounded console capture for the Report-a-problem dialog (#766 item 4).
 *
 * Keeps the last `CONSOLE_CAPTURE_LIMIT` `console.error` / `console.warn`
 * emissions (plus uncaught errors and unhandled rejections) in a ring
 * buffer so the dialog can SHOW the user what a report would include before
 * anything leaves the device. The original console methods are always
 * invoked first — capture never changes what a developer sees.
 *
 * Installed from `ReportProblemHost` (the `DeferredAppOverlays` chunk),
 * which loads right after first paint. Errors emitted before that chunk
 * resolves are not captured; that narrow gap is the price of keeping this
 * out of the entry bundle, and the dialog renders exactly what was captured
 * rather than claiming completeness.
 */

export interface CapturedConsoleEntry {
  level: 'error' | 'warn';
  message: string;
  /** ISO timestamp of when the entry was observed. */
  at: string;
}

export const CONSOLE_CAPTURE_LIMIT = 20;

/**
 * Per-entry cap. A single pathological error (a serialized payload, a stack
 * with a data URI) must not dominate the dialog or the issue URL; the full
 * text is still on the developer console it was copied from.
 */
export const CONSOLE_ENTRY_MAX_CHARS = 600;

const buffer: CapturedConsoleEntry[] = [];

let installed = false;
let originalError: typeof console.error | null = null;
let originalWarn: typeof console.warn | null = null;
let onWindowError: ((event: ErrorEvent) => void) | null = null;
let onUnhandledRejection: ((event: PromiseRejectionEvent) => void) | null =
  null;

function formatArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncateEntryText(text: string): string {
  if (text.length <= CONSOLE_ENTRY_MAX_CHARS) return text;
  return `${text.slice(0, CONSOLE_ENTRY_MAX_CHARS)}… [truncated]`;
}

function record(level: CapturedConsoleEntry['level'], args: unknown[]): void {
  buffer.push({
    level,
    message: truncateEntryText(args.map(formatArg).join(' ')),
    at: new Date().toISOString(),
  });
  if (buffer.length > CONSOLE_CAPTURE_LIMIT) {
    buffer.splice(0, buffer.length - CONSOLE_CAPTURE_LIMIT);
  }
}

/** Idempotent. Wraps console.error/warn and observes uncaught failures. */
export function installConsoleCapture(): void {
  if (installed) return;
  installed = true;

  originalError = console.error;
  originalWarn = console.warn;
  console.error = (...args: unknown[]) => {
    originalError?.apply(console, args);
    record('error', args);
  };
  console.warn = (...args: unknown[]) => {
    originalWarn?.apply(console, args);
    record('warn', args);
  };

  onWindowError = (event: ErrorEvent) => {
    record('error', [
      `Uncaught: ${event.message}`,
      event.filename ? `(${event.filename}:${event.lineno})` : '',
    ]);
  };
  onUnhandledRejection = (event: PromiseRejectionEvent) => {
    record('error', ['Unhandled rejection:', event.reason]);
  };
  window.addEventListener('error', onWindowError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);
}

/** Snapshot (oldest first) of what a report would include right now. */
export function readCapturedConsoleEntries(): CapturedConsoleEntry[] {
  return [...buffer];
}

/** Restores the real console methods and empties the buffer. Test-only. */
export function resetConsoleCaptureForTests(): void {
  if (installed) {
    if (originalError) console.error = originalError;
    if (originalWarn) console.warn = originalWarn;
    if (onWindowError) window.removeEventListener('error', onWindowError);
    if (onUnhandledRejection) {
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    }
  }
  installed = false;
  originalError = null;
  originalWarn = null;
  onWindowError = null;
  onUnhandledRejection = null;
  buffer.length = 0;
}
