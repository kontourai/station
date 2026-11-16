/**
 * Rate limit for repeated identical warnings (#4995).
 *
 * One stuck loop logging the same warning every few seconds filled a day's
 * server log with tens of thousands of identical lines. The logger seam
 * (`utils/logger.ts`) asks this limiter before it writes a `warn` record: the
 * first `limit` records with the same identity inside one window are
 * written, later ones are counted, and when the window ends one summary line
 * reports how many were suppressed.
 *
 * Identity is the logger's component, the message, and a normalized error
 * identity (name, code and the first characters of the error message with
 * digit runs folded). Nothing else from the context is read or kept, so a
 * suppressed record's payload is never captured.
 *
 * Only `warn` is limited. `error` and `fatal` are always written, and
 * `info`/`debug`/`trace` call sites routinely reuse one constant message for
 * distinct events, which an identity without context would merge.
 *
 * Memory is bounded: at most `maxKeys` identities are tracked, each holding
 * a capped key string, two numbers and one callback. The oldest identity is
 * evicted (its pending summary written first) when the bound is reached.
 */

export interface LogRepeatLimitPolicy {
  /** Records with one identity written per window; `0` disables limiting. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Most identities tracked at once. */
  maxKeys: number;
}

export const DEFAULT_LOG_REPEAT_LIMIT: LogRepeatLimitPolicy = {
  limit: 5,
  windowMs: 60_000,
  maxKeys: 512,
};

const MAX_MESSAGE_KEY_CHARS = 300;
const MAX_ERROR_KEY_CHARS = 200;

/** Writes the "suppressed K repeats" line for one identity. */
export type RepeatSummaryWriter = (
  suppressed: number,
  windowMs: number,
) => void;

interface RepeatEntry {
  windowStart: number;
  count: number;
  suppressed: number;
  summarize?: RepeatSummaryWriter;
}

export interface LogRepeatLimiter {
  readonly policy: LogRepeatLimitPolicy;
  /**
   * Whether a record with `key` may be written now. When it may not, the
   * record is counted and `summarize` is kept to report the count once the
   * window ends.
   */
  admit(key: string, summarize: RepeatSummaryWriter): boolean;
  /** Writes every pending summary whose window has ended and forgets idle
   * identities. Runs on a timer while anything is suppressed. */
  sweep(): void;
  /** Writes every pending summary now and forgets all identities. */
  flush(): void;
  /** Number of identities currently tracked (for bound tests). */
  size(): number;
}

export function createLogRepeatLimiter(
  policy: LogRepeatLimitPolicy,
  now: () => number = Date.now,
): LogRepeatLimiter {
  const entries = new Map<string, RepeatEntry>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const writeSummary = (entry: RepeatEntry): void => {
    if (entry.suppressed === 0 || !entry.summarize) return;
    const suppressed = entry.suppressed;
    entry.suppressed = 0;
    try {
      entry.summarize(suppressed, policy.windowMs);
    } catch {
      // A summary must never throw out of a log call.
    }
  };

  const stopTimerIfIdle = (): void => {
    if (timer && entries.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const sweep = (): void => {
    const at = now();
    for (const [key, entry] of entries) {
      if (at - entry.windowStart < policy.windowMs) continue;
      writeSummary(entry);
      entries.delete(key);
    }
    stopTimerIfIdle();
  };

  const ensureTimer = (): void => {
    if (timer) return;
    timer = setInterval(sweep, policy.windowMs);
    timer.unref?.();
  };

  return {
    policy,
    admit(key, summarize) {
      if (policy.limit <= 0) return true;
      const at = now();
      let entry = entries.get(key);
      if (entry && at - entry.windowStart >= policy.windowMs) {
        writeSummary(entry);
        entries.delete(key);
        entry = undefined;
      }
      if (!entry) {
        while (entries.size >= policy.maxKeys) {
          const oldest = entries.entries().next().value;
          if (!oldest) break;
          writeSummary(oldest[1]);
          entries.delete(oldest[0]);
        }
        entry = { windowStart: at, count: 0, suppressed: 0 };
        entries.set(key, entry);
      }
      entry.count += 1;
      if (entry.count <= policy.limit) return true;
      entry.suppressed += 1;
      entry.summarize = summarize;
      ensureTimer();
      return false;
    },
    sweep,
    flush() {
      for (const entry of entries.values()) writeSummary(entry);
      entries.clear();
      stopTimerIfIdle();
    },
    size: () => entries.size,
  };
}

/** Folds digit runs so a pid, port or timestamp inside an error message does
 * not make every repeat a new identity. */
function normalizeErrorText(text: string): string {
  return text.slice(0, MAX_ERROR_KEY_CHARS).replace(/\d+/g, '#');
}

function errorIdentity(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    return `${value.name}|${typeof code === 'string' || typeof code === 'number' ? code : ''}|${normalizeErrorText(value.message)}`;
  }
  if (typeof value === 'string') return normalizeErrorText(value);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : '';
    const type = typeof record.type === 'string' ? record.type : '';
    const code =
      typeof record.code === 'string' || typeof record.code === 'number'
        ? String(record.code)
        : '';
    const message =
      typeof record.message === 'string'
        ? normalizeErrorText(record.message)
        : '';
    return `${name || type}|${code}|${message}`;
  }
  return '';
}

/**
 * The identity of one log record: component, message and the error the
 * context carries (`context` itself when it is an Error, else its `err` or
 * `error` field). No other context field takes part.
 */
export function logRepeatKey(
  component: string,
  msg: unknown,
  context: unknown,
): string {
  const message =
    typeof msg === 'string' ? msg.slice(0, MAX_MESSAGE_KEY_CHARS) : typeof msg;
  let error: unknown;
  if (context instanceof Error) error = context;
  else if (context && typeof context === 'object') {
    const record = context as Record<string, unknown>;
    error = record.err ?? record.error;
  }
  return `${component}\u0000${message}\u0000${errorIdentity(error)}`;
}

function readNonNegativeInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || !/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

/**
 * `STATION_LOG_REPEAT_LIMIT` (records per window, `0` turns limiting off)
 * and `STATION_LOG_REPEAT_WINDOW_SECONDS` (positive). Invalid values fall
 * back to the defaults.
 */
export function resolveLogRepeatLimitPolicy(
  env: NodeJS.ProcessEnv = process.env,
): LogRepeatLimitPolicy {
  const windowSeconds = readNonNegativeInteger(
    env.STATION_LOG_REPEAT_WINDOW_SECONDS,
    DEFAULT_LOG_REPEAT_LIMIT.windowMs / 1000,
  );
  return {
    limit: readNonNegativeInteger(
      env.STATION_LOG_REPEAT_LIMIT,
      DEFAULT_LOG_REPEAT_LIMIT.limit,
    ),
    windowMs:
      windowSeconds > 0
        ? windowSeconds * 1000
        : DEFAULT_LOG_REPEAT_LIMIT.windowMs,
    maxKeys: DEFAULT_LOG_REPEAT_LIMIT.maxKeys,
  };
}
