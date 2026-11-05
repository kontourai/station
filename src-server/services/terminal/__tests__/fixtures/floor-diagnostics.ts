/**
 * TEMPORARY (#3994): breadcrumbs for a forked Vitest worker that dies on the
 * hosted Windows floor without a word. Active only when the floor's wrapper
 * sets STATION_FLOOR_DIAGNOSTICS to a directory; each line is appended
 * synchronously, so the last ones survive a native crash or a forced kill.
 * Records the worker's pid and parent, each test's start and end, every
 * node-pty spawn, kill() and exit, every taskkill and its result, and the
 * worker's own exit, uncaught exception or unhandled rejection.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { afterEach, beforeEach, expect } from 'vitest';

const directory = process.env.STATION_FLOOR_DIAGNOSTICS;

function install(root: string): void {
  mkdirSync(root, { recursive: true });
  const file = join(root, `worker-${process.pid}.log`);
  const log = (...parts: unknown[]) =>
    appendFileSync(
      file,
      `${new Date().toISOString()} ${parts
        .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
        .join(' ')}\n`,
    );
  log('worker', {
    pid: process.pid,
    ppid: process.ppid,
    argv: process.argv.slice(1, 3),
  });
  process.on('exit', (code) => log('exit', { code }));
  process.on('uncaughtException', (error) =>
    log('uncaughtException', String(error?.stack ?? error)),
  );
  process.on('unhandledRejection', (reason) =>
    log('unhandledRejection', String((reason as Error)?.stack ?? reason)),
  );
  beforeEach(() => log('test start', expect.getState().currentTestName ?? ''));
  afterEach(() => log('test end', expect.getState().currentTestName ?? ''));

  const require = createRequire(import.meta.url);
  const childProcess =
    require('node:child_process') as typeof import('node:child_process');
  const execFile = childProcess.execFile;
  childProcess.execFile = ((
    command: string,
    args: readonly string[],
    ...rest: unknown[]
  ) => {
    if (/taskkill/i.test(command)) {
      log('taskkill', args);
      const callback = rest.at(-1);
      if (typeof callback === 'function')
        rest[rest.length - 1] = (error: unknown, ...out: unknown[]) => {
          log('taskkill done', args, String(error ?? 'ok'));
          return (callback as (...a: unknown[]) => unknown)(error, ...out);
        };
    }
    return (execFile as (...a: unknown[]) => unknown)(command, args, ...rest);
  }) as typeof execFile;
  const spawnSync = childProcess.spawnSync;
  childProcess.spawnSync = ((
    command: string,
    args: readonly string[],
    ...rest: unknown[]
  ) => {
    if (/taskkill/i.test(command)) log('taskkill sync', args);
    const result = (
      spawnSync as (...a: unknown[]) => { status: number | null }
    )(command, args, ...rest);
    if (/taskkill/i.test(command))
      log('taskkill sync done', args, result.status);
    return result;
  }) as typeof spawnSync;
  syncBuiltinESMExports();

  const nodePty = require('node-pty') as typeof import('node-pty');
  const spawn = nodePty.spawn;
  nodePty.spawn = ((...args: Parameters<typeof spawn>) => {
    const pty = spawn(...args);
    log('pty spawn', { pid: pty.pid, shell: args[0] });
    pty.onExit((event) => log('pty exit', { pid: pty.pid, ...event }));
    const kill = pty.kill.bind(pty);
    pty.kill = (signal?: string) => {
      log('pty kill', { pid: pty.pid, signal: signal ?? null });
      kill(signal);
      log('pty kill returned', { pid: pty.pid });
    };
    return pty;
  }) as typeof spawn;
}

if (directory) install(directory);
