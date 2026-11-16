/**
 * Size cap for the server's stdout log file (#4995).
 *
 * `station start` and the service supervisor open `STATION_LOG_FILE`
 * (`<home>/logs/<instance>.log`, or `station-<instance>.log`) once, append
 * only, and hand that descriptor to the server as stdout and stderr. Nothing
 * ever closed or reopened it, so a long-running server grew it without bound
 * (175 MB after 25 days on one home). The launcher has usually exited by
 * then, so the only process that can bound the file is the server writing
 * it, and it cannot reopen its own stdout. This module therefore rotates by
 * copy and truncate:
 *
 * 1. Every `intervalMs` (and once at start) it compares the size of its
 *    stdout descriptor with `maxBytes`.
 * 2. Over the cap, it confirms `STATION_LOG_FILE` names the same regular
 *    file as that descriptor (same device and inode), so it never touches a
 *    file it does not write.
 * 3. It shifts `<file>.1 … <file>.N-1` up one generation, copies the file to
 *    `<file>.1` (mode 0600), and truncates the descriptor to zero. The
 *    descriptor is append-only, so later writes land at the new end.
 *
 * Readers keep working without change: the current file stays at the same
 * path and always holds the newest output, which is all the diagnostics
 * bundle, `station start`'s failure report and the smoke diagnostics read
 * (each reads a bounded tail). They do not follow rotated generations; the
 * searchable history is the per-day NDJSON store (`server-log-store.ts`).
 *
 * Bytes another process writes between the copy and the truncate (a child
 * that inherited the descriptor) can be lost; the server's own writes are
 * synchronous on this thread and cannot interleave.
 */

import {
  chmodSync,
  copyFileSync,
  constants as fsConstants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createLogger, type Logger } from '../../utils/logger.js';

const MIB = 1024 * 1024;

const DEFAULT_STDOUT_LOG_FILE_LIMITS = {
  maxBytes: 64 * MIB,
  generations: 3,
  intervalMs: 30_000,
} as const;

/** Most rotated generations kept, whatever the environment asks for. */
const MAX_GENERATIONS = 20;

export interface StdoutLogFileLimits {
  /** Size at which the file is rotated. */
  maxBytes: number;
  /** Rotated copies kept (`<file>.1` newest); `0` truncates without a copy. */
  generations: number;
}

export interface StdoutLogFileRotationOptions {
  /** The file the descriptor was opened on (`STATION_LOG_FILE`). */
  path: string;
  /** The descriptor this process writes the file through. Default stdout. */
  fd?: number;
  limits?: Partial<StdoutLogFileLimits>;
  intervalMs?: number;
  logger?: Pick<Logger, 'info' | 'warn'>;
}

export type StdoutLogFileRotationOutcome =
  | 'rotated'
  | 'under_limit'
  | 'not_owned'
  | 'failed';

export interface StdoutLogFileRotation {
  /** Runs one check now. */
  check(): StdoutLogFileRotationOutcome;
  stop(): void;
}

type RotationCounter = {
  add(value: number, attributes: { outcome: string }): void;
};
let rotationCounter: RotationCounter | undefined;
let rotationCounterLoading: Promise<void> | undefined;
// Lazy like the log store's instruments: this module sits beside the logger
// seam on the boot path. Counting never blocks or throws.
function countRotation(outcome: 'rotated' | 'failed'): void {
  if (rotationCounter) {
    rotationCounter.add(1, { outcome });
    return;
  }
  rotationCounterLoading ??= import('../../telemetry/metrics.js')
    .then((module) => {
      rotationCounter = module.serverStdoutLogRotations;
    })
    .catch(() => {
      rotationCounterLoading = undefined;
    });
  void rotationCounterLoading.then(() => rotationCounter?.add(1, { outcome }));
}

function readNonNegativeInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || !/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

/** `STATION_LOG_FILE_MAX_BYTES` (positive) and `STATION_LOG_FILE_GENERATIONS`
 * (0–20); invalid values fall back to the defaults. */
export function resolveStdoutLogFileLimits(
  env: NodeJS.ProcessEnv = process.env,
): StdoutLogFileLimits {
  const maxBytes = readNonNegativeInteger(
    env.STATION_LOG_FILE_MAX_BYTES,
    DEFAULT_STDOUT_LOG_FILE_LIMITS.maxBytes,
  );
  return {
    maxBytes: maxBytes > 0 ? maxBytes : DEFAULT_STDOUT_LOG_FILE_LIMITS.maxBytes,
    generations: Math.min(
      MAX_GENERATIONS,
      readNonNegativeInteger(
        env.STATION_LOG_FILE_GENERATIONS,
        DEFAULT_STDOUT_LOG_FILE_LIMITS.generations,
      ),
    ),
  };
}

function existsAsEntry(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Removes generations beyond the limit, so lowering it also shrinks disk. */
function removeExcessGenerations(path: string, generations: number): void {
  const base = basename(path);
  let names: string[];
  try {
    names = readdirSync(dirname(path));
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(`${base}.`)) continue;
    const suffix = name.slice(base.length + 1);
    if (!/^\d+$/.test(suffix) || Number(suffix) <= generations) continue;
    try {
      unlinkSync(join(dirname(path), name));
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

/**
 * Rotates `path` when the file behind `fd` has reached `limits.maxBytes`.
 * Never throws.
 */
export function rotateStdoutLogFileIfOversized(
  path: string,
  fd: number,
  limits: StdoutLogFileLimits,
): { outcome: StdoutLogFileRotationOutcome; bytes: number } {
  let bytes = 0;
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) return { outcome: 'not_owned', bytes };
    bytes = opened.size;
    if (opened.size < limits.maxBytes) return { outcome: 'under_limit', bytes };
    const named = lstatSync(path);
    if (
      !named.isFile() ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino
    ) {
      return { outcome: 'not_owned', bytes };
    }
    for (
      let generation = limits.generations;
      generation >= 2;
      generation -= 1
    ) {
      const from = `${path}.${generation - 1}`;
      if (existsAsEntry(from)) renameSync(from, `${path}.${generation}`);
    }
    removeExcessGenerations(path, limits.generations);
    if (limits.generations > 0) {
      const newest = `${path}.1`;
      if (existsAsEntry(newest)) unlinkSync(newest);
      copyFileSync(path, newest, fsConstants.COPYFILE_EXCL);
      if (process.platform !== 'win32') chmodSync(newest, 0o600);
    }
    ftruncateSync(fd, 0);
    countRotation('rotated');
    return { outcome: 'rotated', bytes };
  } catch {
    countRotation('failed');
    return { outcome: 'failed', bytes };
  }
}

/**
 * Runs one size check now, then every `intervalMs` on an unref'd timer. Boot
 * calls it only when `STATION_LOG_FILE` is set; without it (the desktop
 * sidecar, a server started by hand) there is no file to bound.
 */
export function startStdoutLogFileRotation(
  options: StdoutLogFileRotationOptions,
): StdoutLogFileRotation {
  const fd = options.fd ?? 1;
  const limits = { ...resolveStdoutLogFileLimits(), ...options.limits };
  const logger =
    options.logger ?? createLogger({ name: 'server-stdout-log-file' });
  let lastFailureLogged = false;
  const check = (): StdoutLogFileRotationOutcome => {
    const { outcome, bytes } = rotateStdoutLogFileIfOversized(
      options.path,
      fd,
      limits,
    );
    if (outcome === 'rotated') {
      lastFailureLogged = false;
      logger.info('Rotated the server stdout log file', {
        rotatedBytes: bytes,
        maxBytes: limits.maxBytes,
        generations: limits.generations,
      });
    } else if (outcome === 'failed' && !lastFailureLogged) {
      // Reported once per failure streak, not on every interval.
      lastFailureLogged = true;
      logger.warn('Could not rotate the server stdout log file', {
        path: options.path,
        maxBytes: limits.maxBytes,
      });
    }
    return outcome;
  };
  check();
  const timer = setInterval(
    check,
    options.intervalMs ?? DEFAULT_STDOUT_LOG_FILE_LIMITS.intervalMs,
  );
  timer.unref?.();
  return {
    check,
    stop: () => clearInterval(timer),
  };
}
