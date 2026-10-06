/**
 * A live Browser session's console (#90): what the page logged, its uncaught
 * exceptions, and the browser's own messages about it (network failures,
 * CSP, deprecations), captured from CDP `Runtime` and `Log` events on the
 * page's session.
 *
 * Bounded twice, and the bounds refuse rather than grow:
 * - at most {@link BROWSER_CONSOLE_LIMIT} entries: a new entry evicts the
 *   OLDEST, and `dropped` counts every eviction, so a reader can say how
 *   much it is not showing;
 * - every entry's text is cut to {@link BROWSER_CONSOLE_TEXT_MAX} characters
 *   and marked `truncated`.
 *
 * Everything here is page content: untrusted text, shown as text, never
 * interpreted. It lives in memory for one browser generation only (a
 * reopened session starts empty) and is never written to disk.
 */
import type { CdpTransport } from './browser-host.js';

export type BrowserConsoleLevel = 'error' | 'warning' | 'info' | 'debug';
export type BrowserConsoleSource = 'console' | 'exception' | 'browser';

export interface BrowserConsoleEntry {
  /** Increases by one per captured entry, across evictions. */
  seq: number;
  /** Capture time (server clock, ms since the epoch). */
  at: number;
  level: BrowserConsoleLevel;
  source: BrowserConsoleSource;
  text: string;
  truncated?: true;
  /** Where the page said it came from (its script URL, 1-based line). */
  url?: string;
  line?: number;
}

export interface BrowserConsoleSnapshot {
  /** Entries with `seq > after`, oldest first. */
  entries: BrowserConsoleEntry[];
  /** Entries evicted to keep the bound, since capture began. */
  dropped: number;
  /** The newest `seq` captured so far (0 when none). */
  latestSeq: number;
}

export const BROWSER_CONSOLE_LIMIT = 500;
const BROWSER_CONSOLE_TEXT_MAX = 2_000;
const URL_MAX = 500;
/** Arguments of one console call rendered into its text. */
const ARGS_MAX = 20;

interface RemoteObjectLike {
  type?: unknown;
  subtype?: unknown;
  value?: unknown;
  unserializableValue?: unknown;
  description?: unknown;
}

interface StackLike {
  callFrames?: Array<{ url?: unknown; lineNumber?: unknown }>;
}

/** Console API call type → level, as DevTools groups them. */
function consoleLevel(type: unknown): BrowserConsoleLevel {
  switch (type) {
    case 'error':
    case 'assert':
      return 'error';
    case 'warning':
      return 'warning';
    case 'debug':
    case 'trace':
    case 'profile':
    case 'profileEnd':
    case 'count':
    case 'timeEnd':
      return 'debug';
    default:
      return 'info';
  }
}

function logLevel(level: unknown): BrowserConsoleLevel {
  switch (level) {
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    case 'verbose':
      return 'debug';
    default:
      return 'info';
  }
}

/** One argument as text: a primitive's value, anything else its description. */
function describeArg(arg: RemoteObjectLike): string {
  if (typeof arg.unserializableValue === 'string')
    return arg.unserializableValue;
  if (arg.type === 'string' && typeof arg.value === 'string') return arg.value;
  if (arg.type === 'undefined') return 'undefined';
  if (
    arg.value === null ||
    typeof arg.value === 'number' ||
    typeof arg.value === 'boolean'
  )
    return String(arg.value);
  if (typeof arg.description === 'string') return arg.description;
  if (typeof arg.type === 'string') return arg.type;
  return '';
}

function firstFrame(stack: StackLike | undefined): {
  url?: string;
  line?: number;
} {
  const frame = stack?.callFrames?.[0];
  if (!frame) return {};
  return location(frame.url, frame.lineNumber);
}

/** A script URL and 0-based CDP line as a bounded URL and 1-based line. */
function location(
  url: unknown,
  zeroBasedLine: unknown,
): { url?: string; line?: number } {
  const out: { url?: string; line?: number } = {};
  if (typeof url === 'string' && url !== '') out.url = url.slice(0, URL_MAX);
  if (
    typeof zeroBasedLine === 'number' &&
    Number.isInteger(zeroBasedLine) &&
    zeroBasedLine >= 0
  )
    out.line = zeroBasedLine + 1;
  return out;
}

export interface BrowserConsoleLogOptions {
  cdp: CdpTransport;
  cdpSessionId: string;
  limit?: number;
  textMax?: number;
  now?: () => number;
  onError?: (message: string, error: unknown) => void;
}

export class BrowserConsoleLog {
  private readonly entries: BrowserConsoleEntry[] = [];
  private readonly limit: number;
  private readonly textMax: number;
  private readonly now: () => number;
  private readonly off: Array<() => void>;
  private seq = 0;
  private dropped = 0;
  private disposed = false;

  constructor(private readonly options: BrowserConsoleLogOptions) {
    this.limit = options.limit ?? BROWSER_CONSOLE_LIMIT;
    this.textMax = options.textMax ?? BROWSER_CONSOLE_TEXT_MAX;
    this.now = options.now ?? Date.now;
    const { cdp, cdpSessionId } = options;
    const mine =
      (handle: (params: Record<string, unknown>) => void) =>
      (params: unknown, sessionId?: string) => {
        if (sessionId !== cdpSessionId || this.disposed) return;
        if (typeof params !== 'object' || params === null) return;
        handle(params as Record<string, unknown>);
      };
    this.off = [
      cdp.on(
        'Runtime.consoleAPICalled',
        mine((p) => {
          const args = Array.isArray(p.args)
            ? (p.args as RemoteObjectLike[]).slice(0, ARGS_MAX)
            : [];
          this.push({
            level: consoleLevel(p.type),
            source: 'console',
            text: args.map(describeArg).join(' '),
            ...firstFrame(p.stackTrace as StackLike | undefined),
          });
        }),
      ),
      cdp.on(
        'Runtime.exceptionThrown',
        mine((p) => {
          const details = (p.exceptionDetails ?? {}) as {
            text?: unknown;
            exception?: RemoteObjectLike;
            url?: unknown;
            lineNumber?: unknown;
            stackTrace?: StackLike;
          };
          const described =
            typeof details.exception?.description === 'string'
              ? details.exception.description
              : '';
          const text =
            described ||
            (typeof details.text === 'string' ? details.text : 'Uncaught');
          const where =
            details.url !== undefined
              ? location(details.url, details.lineNumber)
              : firstFrame(details.stackTrace);
          this.push({ level: 'error', source: 'exception', text, ...where });
        }),
      ),
      cdp.on(
        'Log.entryAdded',
        mine((p) => {
          const entry = (p.entry ?? {}) as {
            source?: unknown;
            level?: unknown;
            text?: unknown;
            url?: unknown;
            lineNumber?: unknown;
          };
          // Console API calls arrive as Runtime events; never count twice.
          if (entry.source === 'console-api') return;
          this.push({
            level: logLevel(entry.level),
            source: 'browser',
            text: typeof entry.text === 'string' ? entry.text : '',
            ...location(entry.url, entry.lineNumber),
          });
        }),
      ),
    ];
  }

  /**
   * Turn the page's console and log domains on. Best effort: a page that
   * refuses leaves the console empty (and says so through `onError`), never
   * the session broken.
   */
  async enable(): Promise<void> {
    const { cdp, cdpSessionId } = this.options;
    for (const method of ['Runtime.enable', 'Log.enable']) {
      try {
        await cdp.send(method, {}, cdpSessionId);
      } catch (error) {
        this.options.onError?.(`console capture: ${method} failed`, error);
      }
    }
  }

  /** Entries newer than `after` (all when absent), plus the bound's counts. */
  read(after = 0): BrowserConsoleSnapshot {
    return {
      entries: this.entries
        .filter((entry) => entry.seq > after)
        .map((entry) => ({ ...entry })),
      dropped: this.dropped,
      latestSeq: this.seq,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.off) off();
    this.entries.length = 0;
  }

  private push(
    entry: Omit<BrowserConsoleEntry, 'seq' | 'at' | 'truncated'>,
  ): void {
    this.seq += 1;
    const cut = entry.text.length > this.textMax;
    this.entries.push({
      ...entry,
      text: cut ? entry.text.slice(0, this.textMax) : entry.text,
      ...(cut ? { truncated: true as const } : {}),
      seq: this.seq,
      at: this.now(),
    });
    while (this.entries.length > this.limit) {
      this.entries.shift();
      this.dropped += 1;
    }
  }
}
