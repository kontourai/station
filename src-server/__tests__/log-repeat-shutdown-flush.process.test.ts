/**
 * #5054: a "Suppressed K repeats" summary still pending when the server
 * stops is written during graceful shutdown, not lost.
 *
 * Boots the real `src-server/index.ts` with a one-record limit and an
 * hour-long window, provokes the same warning several times over HTTP, sends
 * SIGTERM well inside the window, and reads both the durable server log and
 * the stdout log file the launcher would hand it.
 */
import { spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
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
const deniedMessage = 'Remote authentication denied';
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

function readDurableLog(directory: string): string {
  if (!existsSync(directory)) return '';
  return readdirSync(directory)
    .filter((name) => /^server-.*\.ndjson$/.test(name))
    .sort()
    .map((name) => readFileSync(join(directory, name), 'utf8'))
    .join('');
}

describe('repeat summaries at real server shutdown', () => {
  test('SIGTERM inside an open repeat window still writes the "Suppressed K repeats" line', async () => {
    const root = makeTempDir('station-repeat-flush-');
    chmodSync(root, 0o700);
    const osHome = join(root, 'os-home');
    const temp = join(root, 'tmp');
    const logs = join(root, 'logs');
    const stationHome = join(root, 'home');
    for (const dir of [osHome, temp, logs]) mkdirSync(dir, { recursive: true });
    const logFile = join(logs, 'default.log');
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
      'repeat-flush Station',
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
          STATION_HOME: stationHome,
          STATION_ROOT: join(root, 'station-root'),
          STATION_HOST: '127.0.0.1',
          PORT: '0',
          STATION_INSTANCE: 'repeat-flush-fixture',
          STATION_INSTANCE_ID: 'repeat-flush-fixture',
          STATION_STDOUT_HANDSHAKE: '1',
          STATION_LOG_LEVEL: 'warn',
          // One record per identity, and a window no test outlives: only
          // the shutdown flush can write the summary.
          STATION_LOG_REPEAT_LIMIT: '1',
          STATION_LOG_REPEAT_WINDOW_SECONDS: '3600',
          OTEL_SDK_DISABLED: 'true',
          AWS_EC2_METADATA_DISABLED: 'true',
          STATION_LOG_FILE: logFile,
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
        processLabel: 'repeat-flush Station',
      });
      expect(result.errors).toEqual([]);
    });
    let exited = false;
    let exitStatus: unknown;
    void owned.completion.then((result: { status?: unknown }) => {
      exited = true;
      exitStatus = result.status;
    });
    const stdoutLog = () =>
      existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';

    await waitFor(
      () => exited || stdoutLog().includes(readyPrefix),
      'readiness',
      150_000,
    );
    expect(exited, stdoutLog().slice(-3000)).toBe(false);
    const readyLine = stdoutLog()
      .split('\n')
      .find((line) => line.startsWith(readyPrefix));
    const { port } = JSON.parse(readyLine ?? '{}') as { port: number };

    // Each refused credential is the same warning identity.
    const attempts = 4;
    for (let index = 0; index < attempts; index += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/api/agents`, {
        headers: { Authorization: 'Bearer not-a-station-credential' },
      });
      expect(response.status).toBe(401);
      await response.body?.cancel();
    }
    const durableDirectory = join(stationHome, 'logs', 'server');
    await waitFor(
      () => readDurableLog(durableDirectory).includes(deniedMessage),
      'first denial warning',
      10_000,
    );
    const beforeStop = readDurableLog(durableDirectory);
    expect(beforeStop).not.toContain('Suppressed');

    // The owned-process helper types a launch that never spawned as
    // `{ pid: undefined }`; this server started, so a missing `kill` is a bug.
    const child = owned.child;
    if (!('kill' in child)) throw new Error('Station server never spawned');
    expect(child.kill('SIGTERM')).toBe(true);
    await waitFor(() => exited, 'graceful exit', 60_000);
    expect(exitStatus).toBe(0);

    const summary = `Suppressed ${attempts - 1} repeats of: ${deniedMessage}`;
    const durable = readDurableLog(durableDirectory)
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(
      durable.filter((record) => record.msg === deniedMessage),
    ).toHaveLength(1);
    const summaryRecord = durable.find((record) => record.msg === summary);
    expect(summaryRecord, JSON.stringify(durable.slice(-5))).toMatchObject({
      level: 'warn',
      suppressedRepeats: attempts - 1,
      windowSeconds: 3600,
    });
    // The stdout log the launcher keeps receives it too.
    expect(stdoutLog()).toContain(summary);
  });
});
