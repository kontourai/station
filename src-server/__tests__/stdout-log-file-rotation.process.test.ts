/**
 * #4995: the real server entrypoint bounds the stdout log file the launcher
 * hands it (`STATION_LOG_FILE`).
 *
 * Boots `src-server/index.ts` as a child process the way `station start`
 * does: stdout and stderr are an append-only descriptor on the log file, and
 * `STATION_LOG_FILE` names it. The file is pre-filled past a tiny cap, so
 * the boot-time check must rotate it, and the server's later output must
 * land in the same, truncated file.
 */
import { spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { localLabEnvironment } from '../../scripts/lib/local-collaboration-process.mjs';
import {
  executeOwnedCommand,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from '../../scripts/lib/owned-process.mjs';
import { trackTempDirs } from '../__test-utils__/temp-dirs.js';

const repoRoot = resolve(import.meta.dirname, '../..');
const readyPrefix = '{"event":"listening",';
// Created before the hook below, so the directories outlive the server.
const makeTempDir = trackTempDirs();
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function waitFor(check: () => boolean, label: string, ms: number) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${label} exceeded ${ms}ms`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

describe('stdout log file at real server startup', () => {
  test('rotates an oversized STATION_LOG_FILE at boot and keeps writing to it', async () => {
    const root = makeTempDir('station-stdout-log-');
    chmodSync(root, 0o700);
    const osHome = join(root, 'os-home');
    const temp = join(root, 'tmp');
    const logs = join(root, 'logs');
    for (const dir of [osHome, temp, logs]) mkdirSync(dir, { recursive: true });
    const logFile = join(logs, 'default.log');
    const previousRun = `previous run output\n${'x'.repeat(8192)}\n`;
    writeFileSync(logFile, previousRun, { mode: 0o600 });
    const fd = openSync(
      logFile,
      fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY,
      0o600,
    );

    const owned = executeOwnedCommand(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        join(repoRoot, 'src-server/index.ts'),
      ],
      spawn,
      'stdout-log Station',
      {
        cwd: repoRoot,
        windowsHide: true,
        stdio: ['ignore', fd, fd],
        env: {
          ...localLabEnvironment(),
          TSX_TSCONFIG_PATH: join(repoRoot, 'tsconfig.json'),
          DOTENV_CONFIG_PATH: join(root, 'missing.env'),
          HOME: osHome,
          USERPROFILE: osHome,
          TMPDIR: temp,
          TMP: temp,
          TEMP: temp,
          XDG_CONFIG_HOME: join(osHome, 'config'),
          XDG_CACHE_HOME: join(osHome, 'cache'),
          STATION_HOME: join(root, 'home'),
          STATION_ROOT: join(root, 'station-root'),
          STATION_HOST: '127.0.0.1',
          PORT: '0',
          STATION_INSTANCE: 'stdout-log-fixture',
          STATION_INSTANCE_ID: 'stdout-log-fixture',
          STATION_STDOUT_HANDSHAKE: '1',
          STATION_LOG_LEVEL: 'error',
          OTEL_SDK_DISABLED: 'true',
          AWS_EC2_METADATA_DISABLED: 'true',
          STATION_LOG_FILE: logFile,
          STATION_LOG_FILE_MAX_BYTES: '4000',
          STATION_LOG_FILE_GENERATIONS: '2',
        },
      },
    );
    // The child holds its own copy of the descriptor.
    closeSync(fd);
    cleanups.push(async () => {
      const result = await terminateSuiteExecution(owned, {
        waitForSuiteSettlement,
        terminationGraceMs: 15_000,
        terminationForceMs: 5_000,
        processLabel: 'stdout-log Station',
      });
      expect(result.errors).toEqual([]);
    });
    let exited = false;
    void owned.completion.then(() => {
      exited = true;
    });

    await waitFor(
      () =>
        exited ||
        (existsSync(logFile) &&
          readFileSync(logFile, 'utf8').includes(readyPrefix)),
      'readiness',
      150_000,
    );
    expect(exited, readFileSync(logFile, 'utf8').slice(-3000)).toBe(false);

    // The previous run's output moved to the newest generation…
    expect(readFileSync(`${logFile}.1`, 'utf8')).toBe(previousRun);
    // …and the current file holds only this boot's output, from the start.
    const current = readFileSync(logFile, 'utf8');
    expect(current).not.toContain('previous run output');
    expect(current.startsWith('\u0000')).toBe(false);
    expect(current).toContain(readyPrefix);
  });
});
