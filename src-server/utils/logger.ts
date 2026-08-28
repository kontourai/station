/**
 * Station's own trace/debug/info/warn/error/fatal logging seam (archive#1895,
 * logging slice 1).
 *
 * This is the ONE file in the codebase that talks to pino directly. Every
 * other file imports `Logger`/`createLogger` from here — never from `pino`
 * and never (any more) from `@voltagent/logger`. That package's
 * `createPinoLogger` silently discards `options.pinoOptions`, and its
 * `getLogBuffer()` throws unconditionally ("Buffer management has been
 * replaced by OpenTelemetry Logs API") — it cannot host a durable sink, so
 * Station owns this seam directly instead of depending on it. VoltAgent and
 * Strands consume a logger structurally (msg-first `trace..fatal` + `child`),
 * so this stays a drop-in for both frameworks' logger options.
 *
 * Write-time redaction applies to stdout/pino only. The durable NDJSON
 * store receives unredacted bytes (directory 0700, files 0600) so a local
 * operator can read their own logs; `ServerLogReader` redacts at read for
 * every remote/paired caller. See `docs/reference/config.md#logging`.
 */

import {
  redactDeep,
  sanitizeError,
  sanitizeFreeText,
} from '@kontourai/station-shared/redaction';
import pino from 'pino';
import pinoPretty from 'pino-pretty';
import { getInstalledServerLogSink } from '../services/infra/server-log-store.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * The settings-registry `logLevel` enum
 * (`packages/contracts/src/settings-registry.ts`) intentionally stays five
 * values — `fatal` is emit-only, never a configurable filter ceiling, so it
 * is excluded here rather than added there.
 */
export type ConfigurableLogLevel = Exclude<LogLevel, 'fatal'>;

const CONFIGURABLE_LOG_LEVELS: readonly ConfigurableLogLevel[] = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
];

const EMIT_LEVELS: readonly LogLevel[] = [...CONFIGURABLE_LOG_LEVELS, 'fatal'];

/**
 * The full trace..fatal severity ordering, ascending — the single seam any
 * caller uses to compare `LogLevel`s (archive#1896 logging slice 2: the
 * server-log reader's `level` query param is a MINIMUM severity floor, and
 * needs the same ordering the emit path already uses rather than a second,
 * possibly-drifting copy of `trace < debug < info < warn < error < fatal`).
 * Exported (not just `EMIT_LEVELS`, which stays module-private) so a
 * `fatal` floor — a valid read-side filter even though it is never a
 * configurable emit ceiling — is expressible without re-deriving the
 * vocabulary.
 */
export const LOG_LEVEL_ORDER: readonly LogLevel[] = EMIT_LEVELS;

/** Type guard over the full `trace..fatal` vocabulary (unlike
 * `isConfigurableLogLevel`, `fatal` is accepted here — a read-side minimum
 * severity floor of `fatal` is meaningful even though nothing can be
 * *configured* to emit at that floor). */
export function isLogLevel(value: unknown): value is LogLevel {
  return (
    typeof value === 'string' &&
    (LOG_LEVEL_ORDER as readonly string[]).includes(value)
  );
}

/** `level` is at least as severe as `minimum` (`isLogLevelAtLeast('warn', 'info') === true`). */
export function isLogLevelAtLeast(level: LogLevel, minimum: LogLevel): boolean {
  return LOG_LEVEL_ORDER.indexOf(level) >= LOG_LEVEL_ORDER.indexOf(minimum);
}

function isConfigurableLogLevel(value: unknown): value is ConfigurableLogLevel {
  return (
    typeof value === 'string' &&
    (CONFIGURABLE_LOG_LEVELS as readonly string[]).includes(value)
  );
}

/** Station-owned logger contract. Route DI, module-level loggers, and
 * framework adapters all import this — extended, never renamed, so the
 * ~336 existing `logger.info('msg', {meta})`-shaped call sites keep working
 * unchanged. */
export interface Logger {
  trace(msg: string, context?: unknown): void;
  debug(msg: string, context?: unknown): void;
  info(msg: string, context?: unknown): void;
  warn(msg: string, context?: unknown): void;
  error(msg: string, context?: unknown): void;
  fatal(msg: string, context?: unknown): void;
  /** Returns a logger whose calls carry `bindings` merged into every write.
   * Implemented as a wrapper around the SAME underlying pino instance (not a
   * real `pino.child()`), so a later `setLevel`/`setGlobalLogLevel` is
   * visible to every child instantly. */
  child(bindings: Record<string, unknown>): Logger;
  setLevel(level: ConfigurableLogLevel): void;
  getLevel(): LogLevel;
}

export interface CreateLoggerOptions {
  name: string;
  level?: ConfigurableLogLevel;
}

const REDACT_PATHS = [
  'password',
  'token',
  'apiKey',
  'secret',
  'authorization',
  'cookie',
];

/**
 * Every root pino instance this seam has ever created, so `setGlobalLogLevel`
 * can reach loggers built independently of each other — most of the
 * codebase's ~57 `createLogger({name: '...'})` call sites are module-scope
 * singletons created once at import time with no reference to Station's
 * "root" runtime logger, so a per-instance `logger.setLevel()` call on just
 * one of them (the prior behavior) never reached the rest. Bounded by
 * construction: every call site here creates its logger once at module load
 * or runtime-instance construction, never per-request, so this registry's
 * size tracks the number of `createLogger` call sites in the source tree
 * (dozens), not request/session volume.
 */
const rootPinoInstances = new Set<pino.Logger>();

function buildBaseBindings(): Record<string, unknown> {
  const base: Record<string, unknown> = { pid: process.pid };
  const instanceId = process.env.STATION_INSTANCE_ID;
  if (instanceId) base.instanceId = instanceId;
  const bootId = process.env.STATION_BOOT_ID;
  if (bootId) base.bootId = bootId;
  return base;
}

function buildDestination(level: ConfigurableLogLevel): pino.DestinationStream {
  const isProduction = process.env.NODE_ENV === 'production';
  const stdoutStream: NodeJS.WritableStream = isProduction
    ? // NODE_ENV=production is not set by anything in this codebase today
      // (see resolveHomeDir/boot wiring), so this branch is currently
      // unreachable in practice. The lowercase `level` label below (this
      // seam's `formatters.level`) differs from the old @voltagent/logger
      // wrapper, which uppercased labels — a real activation of this branch
      // should revisit whether downstream JSON-log consumers expect
      // uppercase and adjust deliberately, not by rediscovering it live.
      process.stdout
    : (pinoPretty({
        colorize: true,
        translateTime: 'yyyy-mm-dd HH:MM:ss.l o',
        ignore: 'pid,hostname',
        errorLikeObjectKeys: ['err', 'error', 'exception'],
        errorProps: '',
        singleLine: !['debug', 'trace'].includes(level),
        messageFormat:
          '{msg}{if userId} | user={userId}{end}{if conversationId} | conv={conversationId}{end}{if executionId} | exec={executionId}{end}',
        messageKey: 'msg',
      }) as unknown as NodeJS.WritableStream);

  // Stdout only. The durable store is written unredacted from
  // `wrapPinoInstance` so a local operator can read secrets the stdout
  // path still censors. pino remains the source of truth for level
  // filtering; the store write in `emit` runs only after pino would.
  return stdoutStream as unknown as pino.DestinationStream;
}

function sanitizedLoggerError(error: Error): Error {
  const sanitized = sanitizeError(error);
  const safe = new Error(sanitized.message);
  safe.name = sanitized.type;
  if (sanitized.stack) safe.stack = sanitized.stack;
  return safe;
}

function enumerableError(error: Error): Record<string, unknown> {
  return {
    type: error.name,
    message: error.message,
    ...(typeof error.stack === 'string' ? { stack: error.stack } : {}),
  };
}

function jsonSafe(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value instanceof Error) return enumerableError(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return value.map((item) => jsonSafe(item, seen));
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = jsonSafe(child, seen);
    }
    return out;
  }
  return value;
}

function normalizeContext(context: unknown): Record<string, unknown> {
  if (context === undefined) return {};
  if (context instanceof Error) return { err: sanitizedLoggerError(context) };
  if (typeof context === 'object' && context !== null) {
    return context as Record<string, unknown>;
  }
  return { value: context };
}

function normalizeContextForStore(context: unknown): Record<string, unknown> {
  if (context === undefined) return {};
  if (context instanceof Error) return { err: enumerableError(context) };
  if (typeof context === 'object' && context !== null) {
    return jsonSafe(context) as Record<string, unknown>;
  }
  return { value: context };
}

function rawMessage(msg: unknown): string {
  if (typeof msg === 'string') return msg;
  try {
    return `[non-string log message: ${JSON.stringify(msg)?.slice(0, 500) ?? typeof msg}]`;
  } catch {
    return '[unrenderable log message]';
  }
}

function writeUnredactedStoreLine(
  pinoInstance: pino.Logger,
  level: LogLevel,
  msg: unknown,
  context: Record<string, unknown>,
): void {
  try {
    const sink = getInstalledServerLogSink();
    if (!sink) return;
    const bindings = pinoInstance.bindings() as Record<string, unknown>;
    const record: Record<string, unknown> = {
      ...bindings,
      ...context,
      level,
      timestamp: new Date().toISOString(),
      msg: rawMessage(msg),
    };
    sink.writeLine(JSON.stringify(record));
  } catch {
    // A logging call must never throw; a broken sink degrades to stdout.
  }
}

/**
 * Deep-redacts the merged context before it reaches pino. `normalizeContext`
 * runs first so an `Error` context becomes `{ err: <Error instance> }`, and
 * `redactDeep` preserves Errors as bounded, free-text-sanitized plain data
 * rather than walking their non-enumerable `message`/`stack` into `{}` or
 * handing raw provider/CLI text to pino. pino's own flat `redact.paths`
 * remains a second layer underneath this.
 */
function redactContext(
  context: Record<string, unknown>,
): Record<string, unknown> {
  const redacted = redactDeep(context) as Record<string, unknown>;
  // Keep the conventional top-level `err` as an Error instance so Pino's
  // standard serializer continues to emit `type: Error`, after sanitizing it
  // before stdout can observe it. The durable store is written separately
  // from the unsanitized context.
  return context.err instanceof Error
    ? { ...redacted, err: sanitizedLoggerError(context.err) }
    : redacted;
}

/**
 * Renders any `msg` as sanitizable text. A correct caller passes a string and
 * this is a no-op; an incorrect one gets a labelled line rather than an
 * exception thrown out of a log statement.
 */
function safeMessage(msg: unknown): string {
  if (typeof msg === 'string') return sanitizeFreeText(msg);
  try {
    return sanitizeFreeText(
      `[non-string log message: ${JSON.stringify(msg)?.slice(0, 500) ?? typeof msg}]`,
    );
  } catch {
    return '[unrenderable log message]';
  }
}

function wrapPinoInstance(
  pinoInstance: pino.Logger,
  bindings: Record<string, unknown> = {},
): Logger {
  const hasBindings = Object.keys(bindings).length > 0;
  const emit =
    (level: LogLevel) =>
    (msg: string, context?: unknown): void => {
      if (!pinoInstance.isLevelEnabled(level)) return;
      try {
        const storeContext = hasBindings
          ? {
              ...(jsonSafe(bindings) as Record<string, unknown>),
              ...normalizeContextForStore(context),
            }
          : normalizeContextForStore(context);
        writeUnredactedStoreLine(pinoInstance, level, msg, storeContext);
      } catch {
        // jsonSafe / store write must never throw out of a log call.
      }

      const normalized = normalizeContext(context);
      const merged = hasBindings ? { ...bindings, ...normalized } : normalized;
      const redacted = redactContext(merged);
      // A logging call must never throw. `sanitizeFreeText` rejects a
      // non-string, and a caller using pino's (obj, msg) argument order
      // instead of this interface's (msg, context) hands it an object — which
      // threw INSIDE an async error path, surfaced as an unhandled rejection,
      // and killed the ACP probe that was trying to report a failure. Engines
      // then never registered and chats failed with "Agent not found".
      // Coercing keeps the miscall visible in the logs instead of destroying
      // the path that reported it: the same doctrine as `logFatalAndFlush`,
      // where the crash path must never crash.
      (pinoInstance[level] as (obj: object, msg?: string) => void)(
        redacted,
        safeMessage(msg),
      );
    };

  return {
    trace: emit('trace'),
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    fatal: emit('fatal'),
    child(childBindings: Record<string, unknown>): Logger {
      return wrapPinoInstance(pinoInstance, { ...bindings, ...childBindings });
    },
    setLevel(level: ConfigurableLogLevel): void {
      pinoInstance.level = level;
    },
    getLevel(): LogLevel {
      return pinoInstance.level as LogLevel;
    },
  };
}

/** Builds a Station logger. Direct pino behind this seam: stdout (pretty in
 * development, JSON in production) is redacted at write; the durable NDJSON
 * store under `<STATION_HOME>/logs/server/` receives the unredacted line
 * once `installServerLogSink` has run (UX audit D6 — local operators read
 * their own logs; remote/paired callers are redacted at read). Every logger
 * this seam creates resolves its OWN level through `resolveLogLevel` — so
 * `STATION_LOG_LEVEL` is honored from creation, not only by the one or two
 * loggers whose callers happened to resolve it themselves — and is
 * registered so a later `setGlobalLogLevel` reaches it. */
export function createLogger(options: CreateLoggerOptions): Logger {
  const level = resolveLogLevel(options.level);
  const pinoOptions: pino.LoggerOptions = {
    name: options.name,
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
      exception: pino.stdSerializers.err,
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    base: buildBaseBindings(),
  };
  const pinoInstance = pino(pinoOptions, buildDestination(level));
  rootPinoInstances.add(pinoInstance);
  return wrapPinoInstance(pinoInstance);
}

/**
 * Sets the level on EVERY root pino instance this seam has ever created —
 * the codebase-wide counterpart to a single logger's own `setLevel()`.
 * Children created via `child()` share their root's pino instance, so they
 * follow automatically; this reaches the independent instances too (the
 * ~57 module-scope `createLogger()` call sites are each their own root).
 */
export function setGlobalLogLevel(level: ConfigurableLogLevel): void {
  for (const instance of rootPinoInstances) {
    instance.level = level;
  }
}

/** `STATION_LOG_LEVEL`, validated against the emit-level vocabulary (a
 * `fatal` env value is invalid — fatal is emit-only, never a filter floor). */
export function envLogLevelOverride(): ConfigurableLogLevel | undefined {
  const raw = process.env.STATION_LOG_LEVEL;
  return isConfigurableLogLevel(raw) ? raw : undefined;
}

/** The raw `STATION_LOG_LEVEL` value when it is set but not a valid
 * `ConfigurableLogLevel` — callers use this to emit exactly one warning
 * through their own (by-then-constructed) logger. `undefined` when the env
 * var is unset, empty, or valid. */
export function invalidEnvLogLevelValue(): string | undefined {
  const raw = process.env.STATION_LOG_LEVEL;
  if (raw === undefined || raw === '') return undefined;
  return isConfigurableLogLevel(raw) ? undefined : raw;
}

/** Precedence: `STATION_LOG_LEVEL` env (validated) > `configured` > `'info'`. */
export function resolveLogLevel(configured?: string): ConfigurableLogLevel {
  const envLevel = envLogLevelOverride();
  if (envLevel) return envLevel;
  if (isConfigurableLogLevel(configured)) return configured;
  return 'info';
}

/** Emits the boot-time diagnostics for log-level resolution: a warning when
 * `STATION_LOG_LEVEL` was set but invalid (precedence still falls through to
 * `configured`/`'info'`), and an info line when a valid env override is
 * pinning the level ahead of `app.json`. Call once, after the root logger
 * exists — not from every module-scope `createLogger` call site. */
export function logStartupLogLevelDiagnostics(
  logger: Pick<Logger, 'warn' | 'info'>,
  configured?: string,
): void {
  const invalid = invalidEnvLogLevelValue();
  if (invalid) {
    logger.warn(
      'Invalid STATION_LOG_LEVEL value ignored; falling back to configured level',
      { value: invalid, configured: configured ?? 'info' },
    );
  }
  const envLevel = envLogLevelOverride();
  if (envLevel) {
    logger.info('STATION_LOG_LEVEL environment variable pins the log level', {
      level: envLevel,
    });
  }
}

/**
 * The single guard both `station-runtime.ts` and `runtime-initialize.ts`
 * apply when `app.json`'s `logLevel` field changes: `STATION_LOG_LEVEL`
 * always wins (with a one-line explanation of why the configured value was
 * ignored), otherwise the configured level is applied globally via
 * `setGlobalLogLevel` so every logger in the process — not just the caller's
 * own instance — picks it up.
 */
export function applyConfiguredLogLevel(
  configured: ConfigurableLogLevel | undefined,
  logger: Pick<Logger, 'info'>,
): void {
  if (!configured) return;
  const envLevel = envLogLevelOverride();
  if (envLevel) {
    logger.info(
      'STATION_LOG_LEVEL environment variable pins the log level; ignoring configured level',
      { configured, envLevel },
    );
    return;
  }
  setGlobalLogLevel(configured);
}

export const EMIT_LOG_LEVELS = EMIT_LEVELS;
