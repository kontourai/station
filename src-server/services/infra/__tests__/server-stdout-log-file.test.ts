// @vitest-environment node

import {
  closeSync,
  existsSync,
  constants as fsConstants,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { serverStdoutLogRotations } from '../../../telemetry/metrics.js';
import { createLogger } from '../../../utils/logger.js';
import { DiagnosticsService } from '../diagnostics-service.js';
import {
  resolveStdoutLogFileLimits,
  rotateStdoutLogFileIfOversized,
  startStdoutLogFileRotation,
} from '../server-stdout-log-file.js';

const makeTempDir = trackTempDirs();
const openFds: number[] = [];

/** Opens `path` the way `station start` hands it to the server. */
function openLikeLauncher(path: string): number {
  const fd = openSync(
    path,
    fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY,
    0o600,
  );
  openFds.push(fd);
  return fd;
}

afterEach(() => {
  for (const fd of openFds.splice(0)) {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
  }
  vi.restoreAllMocks();
});

const silentLogger = { info: () => undefined, warn: () => undefined };

describe('server stdout log file rotation (#4995)', () => {
  it('rotates at the threshold, keeps writing to the same path, and the diagnostics reader still finds current output', async () => {
    const home = makeTempDir('station-stdout-log-');
    const path = join(home, 'default.log');
    const fd = openLikeLauncher(path);
    const limits = { maxBytes: 1024, generations: 3 };

    writeSync(fd, 'a'.repeat(1000));
    expect(rotateStdoutLogFileIfOversized(path, fd, limits).outcome).toBe(
      'under_limit',
    );
    writeSync(fd, `${'b'.repeat(23)}\nlast old line\n`);
    expect(rotateStdoutLogFileIfOversized(path, fd, limits).outcome).toBe(
      'rotated',
    );

    expect(statSync(path).size).toBe(0);
    expect(readFileSync(`${path}.1`, 'utf8')).toContain('last old line');
    if (process.platform !== 'win32') {
      expect(statSync(`${path}.1`).mode & 0o777).toBe(0o600);
    }

    // The same append-only descriptor now writes at the start of the file.
    writeSync(fd, 'first new line\n');
    expect(readFileSync(path, 'utf8')).toBe('first new line\n');

    const diagnostics = new DiagnosticsService(home, {
      collectDoctor: async () => ({}) as never,
      readConfig: async () => ({}) as never,
      logPath: path,
    });
    const bundle = await diagnostics.generateBundle();
    expect(bundle.logs).toContain('first new line');
    expect(bundle.logs).not.toContain('last old line');
  });

  it('keeps at most the configured generations and drops older ones', () => {
    const home = makeTempDir('station-stdout-log-');
    const path = join(home, 'default.log');
    const fd = openLikeLauncher(path);
    // A generation left by a larger earlier limit.
    writeFileSync(`${path}.7`, 'stale');
    for (let round = 1; round <= 5; round += 1) {
      writeSync(fd, `round ${round}\n`.padEnd(64, '.'));
      expect(
        rotateStdoutLogFileIfOversized(path, fd, {
          maxBytes: 32,
          generations: 2,
        }).outcome,
      ).toBe('rotated');
    }
    const rotated = readdirSync(home)
      .filter((name) => name.startsWith('default.log.'))
      .sort();
    expect(rotated).toEqual(['default.log.1', 'default.log.2']);
    expect(readFileSync(`${path}.1`, 'utf8')).toContain('round 5');
    expect(readFileSync(`${path}.2`, 'utf8')).toContain('round 4');
  });

  it('truncates without a copy when no generations are kept', () => {
    const home = makeTempDir('station-stdout-log-');
    const path = join(home, 'default.log');
    const fd = openLikeLauncher(path);
    writeSync(fd, 'x'.repeat(100));
    expect(
      rotateStdoutLogFileIfOversized(path, fd, { maxBytes: 10, generations: 0 })
        .outcome,
    ).toBe('rotated');
    expect(statSync(path).size).toBe(0);
    expect(existsSync(`${path}.1`)).toBe(false);
  });

  it('never rotates a file its descriptor does not write', () => {
    const home = makeTempDir('station-stdout-log-');
    const path = join(home, 'default.log');
    const other = join(home, 'other.log');
    writeFileSync(path, 'y'.repeat(100));
    const fd = openLikeLauncher(other);
    writeSync(fd, 'z'.repeat(100));
    expect(
      rotateStdoutLogFileIfOversized(path, fd, { maxBytes: 10, generations: 3 })
        .outcome,
    ).toBe('not_owned');
    expect(statSync(path).size).toBe(100);
    expect(statSync(other).size).toBe(100);
    expect(existsSync(`${path}.1`)).toBe(false);
  });

  it('checks at start and on its interval, and counts rotations', async () => {
    vi.useFakeTimers();
    try {
      const add = vi.spyOn(serverStdoutLogRotations, 'add');
      const home = makeTempDir('station-stdout-log-');
      const path = join(home, 'default.log');
      const fd = openLikeLauncher(path);
      writeSync(fd, 'o'.repeat(200));
      const rotation = startStdoutLogFileRotation({
        path,
        fd,
        limits: { maxBytes: 100, generations: 1 },
        intervalMs: 1_000,
        logger: silentLogger,
      });
      try {
        expect(statSync(path).size).toBe(0);
        writeSync(fd, 'p'.repeat(200));
        vi.advanceTimersByTime(1_000);
        expect(statSync(path).size).toBe(0);
        expect(readFileSync(`${path}.1`, 'utf8')).toBe('p'.repeat(200));
      } finally {
        rotation.stop();
      }
      vi.useRealTimers();
      await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(2));
      expect(add).toHaveBeenCalledWith(1, { outcome: 'rotated' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs the rotation through the Station logger', () => {
    const home = makeTempDir('station-stdout-log-');
    const path = join(home, 'default.log');
    const fd = openLikeLauncher(path);
    writeSync(fd, 'q'.repeat(200));
    const logger = createLogger({ name: 'stdout-log-test' });
    const info = vi.spyOn(logger, 'info');
    const rotation = startStdoutLogFileRotation({
      path,
      fd,
      limits: { maxBytes: 100, generations: 1 },
      logger,
    });
    rotation.stop();
    expect(info).toHaveBeenCalledWith('Rotated the server stdout log file', {
      rotatedBytes: 200,
      maxBytes: 100,
      generations: 1,
    });
  });

  it('reads its limits from the environment and bounds them', () => {
    expect(
      resolveStdoutLogFileLimits({
        STATION_LOG_FILE_MAX_BYTES: '2048',
        STATION_LOG_FILE_GENERATIONS: '0',
      }),
    ).toEqual({ maxBytes: 2048, generations: 0 });
    expect(
      resolveStdoutLogFileLimits({
        STATION_LOG_FILE_MAX_BYTES: '0',
        STATION_LOG_FILE_GENERATIONS: '999',
      }),
    ).toEqual({ maxBytes: 64 * 1024 * 1024, generations: 20 });
  });
});
