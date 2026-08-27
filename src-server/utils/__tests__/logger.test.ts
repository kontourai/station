// @vitest-environment node

import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createServerLogStore,
  installServerLogSink,
  resetServerLogSinkForTests,
} from '../../services/infra/server-log-store.js';
import { serverLogStoreWriteErrors } from '../../telemetry/metrics.js';
import {
  applyConfiguredLogLevel,
  createLogger,
  envLogLevelOverride,
  invalidEnvLogLevelValue,
  logStartupLogLevelDiagnostics,
  resolveLogLevel,
  setGlobalLogLevel,
} from '../logger.js';

const dirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'station-logger-test-'));
  dirs.push(dir);
  return dir;
}

/** Reads the single today-dated NDJSON file the store just wrote and parses
 * every line, in write order. */
function readTodayLines(directory: string): any[] {
  const files = readdirSync(directory).filter((name) =>
    /^server-\d{4}-\d{2}-\d{2}\.ndjson$/.test(name),
  );
  expect(files.length).toBe(1);
  const content = readFileSync(join(directory, files[0]), 'utf8');
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

const originalEnvLevel = process.env.STATION_LOG_LEVEL;

afterEach(() => {
  resetServerLogSinkForTests();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  if (originalEnvLevel === undefined) delete process.env.STATION_LOG_LEVEL;
  else process.env.STATION_LOG_LEVEL = originalEnvLevel;
});

describe('createLogger — level filtering and the store tee', () => {
  it('suppresses debug lines below the configured info level, but keeps info+', async () => {
    const directory = createTempDir();
    installServerLogSink({ directory });
    const logger = createLogger({ name: 'test-logger', level: 'info' });

    logger.debug('a debug line that should be filtered');
    logger.info('an info line that should land');
    // pino writes are async-ish via the multistream tee; give the event loop
    // a turn so the store tee's write has actually happened.
    await new Promise((resolve) => setImmediate(resolve));

    const lines = readTodayLines(directory);
    const msgs = lines.map((line) => line.msg);
    expect(msgs).not.toContain('a debug line that should be filtered');
    expect(msgs).toContain('an info line that should land');
  });

  it('preserves the msg-first convention and merges a plain-object context', async () => {
    const directory = createTempDir();
    installServerLogSink({ directory });
    const logger = createLogger({ name: 'test-logger', level: 'info' });

    logger.info('agent started', { agentSlug: 'demo', port: 3141 });
    await new Promise((resolve) => setImmediate(resolve));

    const [line] = readTodayLines(directory);
    expect(line.msg).toBe('agent started');
    expect(line.agentSlug).toBe('demo');
    expect(line.port).toBe(3141);
    expect(line.level).toBe('info');
    expect(typeof line.timestamp).toBe('string');
    expect(line.name).toBe('test-logger');
  });

  it("normalizes an Error context into pino's `err` stdSerializer shape", async () => {
    const directory = createTempDir();
    installServerLogSink({ directory });
    const logger = createLogger({ name: 'test-logger', level: 'info' });

    logger.error('boom happened', new Error('kaboom'));
    await new Promise((resolve) => setImmediate(resolve));

    const [line] = readTodayLines(directory);
    expect(line.msg).toBe('boom happened');
    expect(line.err).toBeDefined();
    expect(line.err.message).toBe('kaboom');
    expect(line.err.type).toBe('Error');
  });

  it('persists unsanitized provider errors in the durable store (redaction is at read for non-local callers)', async () => {
    const directory = createTempDir();
    installServerLogSink({ directory });
    const logger = createLogger({ name: 'test-logger', level: 'info' });
    const unsafeUrl = `https://${'provider'}.example.test/private/path?${'token'}=secret-value#fragment`;
    const error = new Error(`engine stderr: ${unsafeUrl}`);
    error.stack = [
      error.message,
      ...Array.from({ length: 40 }, (_, index) => `at ${unsafeUrl}:${index}`),
    ].join('\n');

    logger.error(`engine stderr: ${unsafeUrl}`, error);
    await new Promise((resolve) => setImmediate(resolve));

    const [line] = readTodayLines(directory);
    const persisted = JSON.stringify(line);
    expect(persisted).toContain('secret-value');
    expect(persisted).toContain('private/path');
    expect(line.err.message).toContain(unsafeUrl);
    expect(line.err.stack.split('\n').length).toBeGreaterThan(25);
  });

  it('persists quoted ENOENT and unquoted V8 stack labels WITH source paths in the store', async () => {
    const directory = createTempDir();
    installServerLogSink({ directory });
    const logger = createLogger({ name: 'test-logger', level: 'info' });
    const error = new Error(
      "ENOENT: no such file or directory, open '/Users/brian/station/private/config.json'",
    );
    error.stack = [
      error.message,
      'at loadProvider (/Users/brian/Station Data/private/provider.ts:42:7)',
      'at executeEngine (C:\\Station Data\\private\\engine.ts:19:2)',
    ].join('\n');

    logger.error('engine failed', error);
    await new Promise((resolve) => setImmediate(resolve));

    const [line] = readTodayLines(directory);
    expect(line.err.stack).toContain('loadProvider');
    expect(line.err.stack).toContain('executeEngine');
    expect(line.err.stack).toContain('/Users/brian');
    expect(line.err.message).toContain(
      '/Users/brian/station/private/config.json',
    );
  });

  it('normalizes a non-object, non-Error context into { value }', async () => {
    const directory = createTempDir();
    installServerLogSink({ directory });
    const logger = createLogger({ name: 'test-logger', level: 'info' });

    logger.warn('raw string context', 'just a string');
    await new Promise((resolve) => setImmediate(resolve));

    const [line] = readTodayLines(directory);
    expect(line.value).toBe('just a string');
  });

  it('a cyclic context does not throw and serializes the cycle', async () => {
    const directory = createTempDir();
    installServerLogSink({ directory });
    const logger = createLogger({ name: 'cycle-logger', level: 'info' });
    const cyclic: Record<string, unknown> = { ok: true };
    cyclic.self = cyclic;
    expect(
      () => logger.info('cyclic', cyclic),
      'cyclic log context escaped the never-throw boundary',
    ).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    const [line] = readTodayLines(directory);
    expect(line.msg).toBe('cyclic');
    expect(line.self, 'cyclic log context escaped serialization').toBe(
      '[Circular]',
    );
  });

  it('merges child bindings into every write, on top of the same pino instance', async () => {
    const directory = createTempDir();
    installServerLogSink({ directory });
    const logger = createLogger({ name: 'test-logger', level: 'info' });
    const child = logger.child({ requestId: 'req-1' });

    child.info('child line');
    await new Promise((resolve) => setImmediate(resolve));

    const [line] = readTodayLines(directory);
    expect(line.requestId).toBe('req-1');
  });

  it('a CHILD logger given an Error context serializes err with message+stack, in stdout and store (station#1895 review round 2, verifier-d)', async () => {
    const directory = createTempDir();
    installServerLogSink({ directory });
    const logger = createLogger({ name: 'test-logger', level: 'info' });
    const child = logger.child({ requestId: 'req-child-err' });

    child.error('child error test', new Error('kaboom-child'));
    await new Promise((resolve) => setImmediate(resolve));

    const [line] = readTodayLines(directory);
    expect(line.requestId).toBe('req-child-err');
    expect(line.err).toBeDefined();
    expect(line.err.message).toBe('kaboom-child');
    expect(line.err.type).toBe('Error');
    expect(typeof line.err.stack).toBe('string');
  });

  it('setLevel on the parent instantly changes filtering for an existing child', async () => {
    const directory = createTempDir();
    installServerLogSink({ directory });
    const logger = createLogger({ name: 'test-logger', level: 'info' });
    const child = logger.child({ scope: 'child' });

    child.debug('should be filtered before setLevel');
    logger.setLevel('debug');
    child.debug('should land after setLevel');
    await new Promise((resolve) => setImmediate(resolve));

    const msgs = readTodayLines(directory).map((line) => line.msg);
    expect(msgs).not.toContain('should be filtered before setLevel');
    expect(msgs).toContain('should land after setLevel');
    expect(logger.getLevel()).toBe('debug');
    expect(child.getLevel()).toBe('debug');
  });

  it('emits a fatal line even when the configured level is error', async () => {
    const directory = createTempDir();
    installServerLogSink({ directory });
    const logger = createLogger({ name: 'test-logger', level: 'error' });

    logger.info('filtered');
    logger.fatal('this must always land');
    await new Promise((resolve) => setImmediate(resolve));

    const msgs = readTodayLines(directory).map((line) => line.msg);
    expect(msgs).not.toContain('filtered');
    expect(msgs).toContain('this must always land');
  });

  it('writes secret-named context keys UNREDACTED to the durable store', async () => {
    const directory = createTempDir();
    installServerLogSink({ directory });
    const logger = createLogger({ name: 'test-logger', level: 'info' });

    logger.info('credential attached', { token: 'super-secret-value' });
    await new Promise((resolve) => setImmediate(resolve));

    const [line] = readTodayLines(directory);
    expect(line.token).toBe('super-secret-value');
  });

  it('writes a tool-server secret-bearing config UNREDACTED to the durable store', async () => {
    const directory = createTempDir();
    installServerLogSink({ directory });
    const logger = createLogger({
      name: 'tool-server-secret-test',
      level: 'info',
    });
    logger.info('tool server config', {
      config: { secretEnv: { API_TOKEN: 'logger-canary-material' } },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const serialized = JSON.stringify(readTodayLines(directory));
    expect(serialized).toContain('logger-canary-material');
    expect(serialized).not.toContain('[REDACTED]');
  });

  it('the default ServerLogReader still redacts a secret that the store file holds', async () => {
    const directory = createTempDir();
    installServerLogSink({ directory });
    const logger = createLogger({ name: 'test-logger', level: 'info' });
    const canary = 'local-operator-canary-material';
    logger.info('app config updated', {
      config: { apiKey: canary },
    });
    await new Promise((resolve) => setImmediate(resolve));

    const { createServerLogReader } = await import(
      '../../services/infra/server-log-reader.js'
    );
    const reader = createServerLogReader({ directory });
    const redacted = await reader.query();
    expect((redacted.entries[0].config as Record<string, unknown>).apiKey).toBe(
      '[REDACTED]',
    );
    const local = await reader.query({ redact: false });
    expect((local.entries[0].config as Record<string, unknown>).apiKey).toBe(
      canary,
    );
  });

  it('keeps NESTED secret-shaped fields in the STORE FILE so a local operator can read them (UX audit D6)', async () => {
    const directory = createTempDir();
    installServerLogSink({ directory });
    const logger = createLogger({ name: 'test-logger', level: 'info' });

    logger.info('app config updated', {
      config: { apiKey: 'nested-secret-value', region: 'us-east-1' },
      nested: { deeper: { api_key: 'snake-case-nested-secret' } },
    });
    await new Promise((resolve) => setImmediate(resolve));

    const [line] = readTodayLines(directory);
    expect(line.config.apiKey).toBe('nested-secret-value');
    expect(line.config.region).toBe('us-east-1');
    expect(line.nested.deeper.api_key).toBe('snake-case-nested-secret');
  });

  it('deep-redacts nested secret-shaped fields in STDOUT serialization too', async () => {
    // The dev-mode stdout stream is pino-pretty, which writes to fd 1
    // through its own SonicBoom destination — bypassing the JS-level
    // `process.stdout.write` entirely, so it can't be spied on directly.
    // Forcing the NODE_ENV=production branch makes `buildDestination` use
    // `process.stdout` as a plain object instead, which IS spyable, and
    // proves redaction happens before the object ever reaches pino (so it
    // applies to every destination, not just the store tee).
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      const logger = createLogger({ name: 'test-logger', level: 'info' });
      logger.info('nested secret', { a: { b: { api_key: 'stdout-secret' } } });
      await new Promise((resolve) => setImmediate(resolve));
      const rendered = writeSpy.mock.calls
        .map((call) => String(call[0]))
        .join('');
      expect(rendered).not.toContain('stdout-secret');
      expect(rendered).toContain('[REDACTED]');
    } finally {
      writeSpy.mockRestore();
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('still writes to stdout-only (no throw) when no sink has been installed', () => {
    const logger = createLogger({ name: 'unsinked-logger', level: 'info' });
    expect(() => logger.info('no sink yet')).not.toThrow();
  });

  it('a module-scope logger created before boot lands in the store once installed', async () => {
    // Mirrors how ~57 files in this codebase create a logger at import time,
    // before `index.ts` has installed the durable sink.
    const logger = createLogger({ name: 'early-logger', level: 'info' });
    const directory = createTempDir();
    installServerLogSink({ directory });

    logger.info('written after the sink was installed');
    await new Promise((resolve) => setImmediate(resolve));

    const msgs = readTodayLines(directory).map((line) => line.msg);
    expect(msgs).toContain('written after the sink was installed');
  });
});

describe('log level precedence and diagnostics', () => {
  beforeEach(() => {
    delete process.env.STATION_LOG_LEVEL;
  });

  it('defaults to info when nothing is configured', () => {
    expect(resolveLogLevel()).toBe('info');
    expect(resolveLogLevel(undefined)).toBe('info');
  });

  it('uses the configured level when no env override is set', () => {
    expect(resolveLogLevel('debug')).toBe('debug');
  });

  it('STATION_LOG_LEVEL env takes precedence over configured', () => {
    process.env.STATION_LOG_LEVEL = 'warn';
    expect(resolveLogLevel('debug')).toBe('warn');
    expect(envLogLevelOverride()).toBe('warn');
    expect(invalidEnvLogLevelValue()).toBeUndefined();
  });

  it('an invalid STATION_LOG_LEVEL falls back to configured, and is reported as invalid', () => {
    process.env.STATION_LOG_LEVEL = 'this-is-not-a-level';
    expect(resolveLogLevel('debug')).toBe('debug');
    expect(envLogLevelOverride()).toBeUndefined();
    expect(invalidEnvLogLevelValue()).toBe('this-is-not-a-level');
  });

  it('an invalid STATION_LOG_LEVEL falls back to info when nothing else is configured', () => {
    process.env.STATION_LOG_LEVEL = 'nope';
    expect(resolveLogLevel()).toBe('info');
  });

  it('rejects `fatal` as an env override — fatal is emit-only, never a filter floor', () => {
    process.env.STATION_LOG_LEVEL = 'fatal';
    expect(envLogLevelOverride()).toBeUndefined();
    expect(invalidEnvLogLevelValue()).toBe('fatal');
    expect(resolveLogLevel('warn')).toBe('warn');
  });

  it('logStartupLogLevelDiagnostics warns exactly once for an invalid env value', () => {
    process.env.STATION_LOG_LEVEL = 'bogus';
    const logger = { warn: vi.fn(), info: vi.fn() };

    logStartupLogLevelDiagnostics(logger, 'debug');

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [msg, context] = logger.warn.mock.calls[0];
    expect(msg).toMatch(/Invalid STATION_LOG_LEVEL/);
    expect(context).toMatchObject({ value: 'bogus' });
    // Falls through to `configured`, not silently forced to 'info'.
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('logStartupLogLevelDiagnostics announces a valid env override at info', () => {
    process.env.STATION_LOG_LEVEL = 'trace';
    const logger = { warn: vi.fn(), info: vi.fn() };

    logStartupLogLevelDiagnostics(logger, 'info');

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0][1]).toMatchObject({ level: 'trace' });
  });

  it('logStartupLogLevelDiagnostics is silent when nothing is overridden or invalid', () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    logStartupLogLevelDiagnostics(logger, 'info');
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe('createLogger resolves STATION_LOG_LEVEL from creation, for EVERY logger (station#1895 review round 2, HIGH-1)', () => {
  beforeEach(() => {
    delete process.env.STATION_LOG_LEVEL;
  });

  it('a logger created with no explicit level honors STATION_LOG_LEVEL without its caller resolving it — the module-scope-logger shape used at ~57 call sites', () => {
    process.env.STATION_LOG_LEVEL = 'debug';
    // No `level` option at all — mirrors `createLogger({ name: 'config-loader' })`
    // and the ~13 other module-scope call sites the review named.
    const logger = createLogger({ name: 'module-scope-style' });
    expect(logger.getLevel()).toBe('debug');
  });

  it('two independently-created loggers (no shared parent instance) both follow setGlobalLogLevel', async () => {
    const directory = createTempDir();
    installServerLogSink({ directory });
    const loggerA = createLogger({ name: 'independent-a', level: 'info' });
    const loggerB = createLogger({ name: 'independent-b', level: 'info' });

    loggerA.debug('A: filtered before global change');
    loggerB.debug('B: filtered before global change');
    setGlobalLogLevel('debug');
    loggerA.debug('A: lands after global change');
    loggerB.debug('B: lands after global change');
    await new Promise((resolve) => setImmediate(resolve));

    const msgs = readTodayLines(directory).map((line) => line.msg);
    expect(msgs).not.toContain('A: filtered before global change');
    expect(msgs).not.toContain('B: filtered before global change');
    expect(msgs).toContain('A: lands after global change');
    expect(msgs).toContain('B: lands after global change');
    expect(loggerA.getLevel()).toBe('debug');
    expect(loggerB.getLevel()).toBe('debug');
  });

  it('a module-scope-style logger created BEFORE setGlobalLogLevel is ever called still follows a later call', async () => {
    const directory = createTempDir();
    installServerLogSink({ directory });
    // Constructed well before any config/env-driven level change — the
    // exact shape of a logger built once at module import time.
    const earlyLogger = createLogger({ name: 'early-module-scope' });
    expect(earlyLogger.getLevel()).toBe('info');

    setGlobalLogLevel('trace');
    earlyLogger.trace('trace line after a later global change');
    await new Promise((resolve) => setImmediate(resolve));

    expect(earlyLogger.getLevel()).toBe('trace');
    const msgs = readTodayLines(directory).map((line) => line.msg);
    expect(msgs).toContain('trace line after a later global change');
  });

  it('applyConfiguredLogLevel: STATION_LOG_LEVEL still wins over an app.json application, and does not call setGlobalLogLevel', async () => {
    const directory = createTempDir();
    installServerLogSink({ directory });
    process.env.STATION_LOG_LEVEL = 'warn';
    // HIGH-1(a): createLogger resolves STATION_LOG_LEVEL itself, so both
    // loggers already start at 'warn' (the env override), not the 'info'
    // passed here — proving the env win happens at creation, not just in
    // this guard.
    const logger = createLogger({ name: 'app-config-consumer', level: 'info' });
    const bystander = createLogger({ name: 'bystander', level: 'info' });
    expect(logger.getLevel()).toBe('warn');
    expect(bystander.getLevel()).toBe('warn');
    const infoSpy = vi.spyOn(logger, 'info');

    // app.json says 'debug', but the env override must win — neither this
    // logger nor any OTHER logger in the process should move to 'debug'.
    applyConfiguredLogLevel('debug', logger);

    expect(logger.getLevel()).toBe('warn');
    expect(bystander.getLevel()).toBe('warn');
    expect(infoSpy).toHaveBeenCalledWith(
      'STATION_LOG_LEVEL environment variable pins the log level; ignoring configured level',
      { configured: 'debug', envLevel: 'warn' },
    );
  });

  it('applyConfiguredLogLevel: with no env override, applies the configured level globally', () => {
    const logger = createLogger({
      name: 'app-config-consumer-2',
      level: 'info',
    });
    const bystander = createLogger({ name: 'bystander-2', level: 'info' });

    applyConfiguredLogLevel('debug', logger);

    expect(logger.getLevel()).toBe('debug');
    expect(bystander.getLevel()).toBe('debug');
  });
});

describe('createLogger against an unwritable sink directory', () => {
  it('never throws from the logging call path when the sink cannot write, and counts the failure', async () => {
    // A file (not a directory) at the target path makes every open() inside
    // it fail — the store degrades to stdout-only rather than throwing.
    const parent = createTempDir();
    const blockerFile = join(parent, 'blocked');
    writeFileSync(blockerFile, 'not a directory');
    const store = createServerLogStore({
      directory: join(blockerFile, 'nested'),
    });
    const addSpy = vi.spyOn(serverLogStoreWriteErrors, 'add');

    expect(() => store.writeLine('{"msg":"should not throw"}')).not.toThrow();
    // Counting loads the OTel instruments lazily (the static import would
    // break vi.mock hoisting in every suite that transitively imports the
    // logger seam), so the first increment lands asynchronously.
    await vi.waitFor(() => expect(addSpy).toHaveBeenCalled());

    addSpy.mockRestore();
  });

  it('the logger call path itself never throws through a broken sink', () => {
    const parent = createTempDir();
    const blockerFile = join(parent, 'blocked-via-logger');
    writeFileSync(blockerFile, 'not a directory');
    installServerLogSink({ directory: join(blockerFile, 'nested') });
    const logger = createLogger({ name: 'broken-sink-logger', level: 'info' });

    expect(() => logger.error('this must not throw')).not.toThrow();
  });
});

describe('a log call never throws (station#2502 sibling: the ACP probe outage)', () => {
  /**
   * The live failure this pins: `acp-probe.ts` called
   * `logger.warn({ err, id }, 'message')` — pino's argument order — while this
   * interface is `(msg, context)`. `sanitizeFreeText` rejects a non-string, so
   * the log statement THREW, inside an async probe, surfacing as an unhandled
   * rejection that killed ACP probing. Engines then never registered and every
   * chat failed with "Agent not found".
   *
   * The call sites are fixed and the logger is now typed at that boundary, but
   * the durable guarantee is this one: a logging call cannot take down the path
   * that was trying to report a problem. Same doctrine as `logFatalAndFlush` —
   * the crash path must never crash.
   */
  it.each([
    [
      'an object, as pino-order callers pass',
      { err: new Error('boom'), id: 'x' },
    ],
    ['undefined', undefined],
    ['a number', 42],
    ['null', null],
  ])('survives a %s message', (_label, message) => {
    const logger = createLogger({ name: 'misuse-logger', level: 'info' });
    expect(
      () => logger.warn(message as unknown as string, { context: true }),
      'a miscalled logger threw instead of logging — this is what killed ACP probing',
    ).not.toThrow();
  });

  it('still renders a correct string message unchanged', () => {
    const logger = createLogger({ name: 'ordinary-logger', level: 'info' });
    expect(() => logger.warn('an ordinary message', { a: 1 })).not.toThrow();
  });
});
