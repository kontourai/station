import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { cpus, freemem, loadavg, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSyncBounded } from './bounded-capture.mjs';

const GUARD_COMPILER_TIMEOUT_MS = 10_000;
const SOURCE_DIAGNOSTIC_MAX_BYTES = 1024 * 1024;

function fileObservation(path, digest = false) {
  try {
    const info = lstatSync(path);
    const observation = {
      path,
      size: info.size,
      modifiedMs: info.mtimeMs,
      regularFile: info.isFile(),
      symbolicLink: info.isSymbolicLink(),
    };
    if (digest && info.isFile() && info.size <= SOURCE_DIAGNOSTIC_MAX_BYTES) {
      const descriptor = openSync(path, 'r');
      try {
        const bytes = Buffer.alloc(info.size + 1);
        const length = readSync(descriptor, bytes, 0, bytes.length, 0);
        if (length === info.size) {
          observation.sha256 = createHash('sha256')
            .update(bytes.subarray(0, length))
            .digest('hex');
        }
      } finally {
        closeSync(descriptor);
      }
    }
    return observation;
  } catch (error) {
    return { path, unavailable: error.code ?? error.name };
  }
}

function hostObservation() {
  try {
    const processors = cpus();
    const cpuMs = { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
    for (const processor of processors) {
      for (const key of Object.keys(cpuMs)) cpuMs[key] += processor.times[key];
    }
    return {
      cpuCount: processors.length,
      cpuMs,
      freeMemoryBytes: freemem(),
      totalMemoryBytes: totalmem(),
      loadAverage: process.platform === 'win32' ? null : loadavg(),
      coordinatorCpuUs: process.cpuUsage(),
      coordinatorRssBytes: process.memoryUsage.rss(),
    };
  } catch (error) {
    return { unavailable: error.code ?? error.name };
  }
}

function assertRegularPrivateFile(path) {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    throw new Error(
      'Windows Job guard compiler did not publish a regular executable',
    );
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1)
    throw new Error(
      'Windows Job guard compiler did not publish a regular executable',
    );
  chmodSync(path, 0o700);
}

function compilerDiagnostic(compiled, evidence) {
  return [
    compiled.error?.code === 'ETIMEDOUT'
      ? `compiler timed out after ${GUARD_COMPILER_TIMEOUT_MS}ms`
      : undefined,
    compiled.error?.message,
    `compiler pid ${compiled.pid ?? 'unavailable'}; status ${compiled.status ?? 'null'}; signal ${compiled.signal ?? 'none'}`,
    compiled.stdout?.trim(),
    compiled.stderr?.trim(),
    compiled.status == null ? undefined : `exit ${compiled.status}`,
    `compiler evidence ${JSON.stringify(evidence)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Build a per-owner guard; never trust a predictable shared executable.
 * @param {{
 *   source?: string,
 *   spawnProcess?: (command: string, args: string[], options: import('node:child_process').SpawnSyncOptionsWithStringEncoding) => {
 *     status: number | null,
 *     pid?: number,
 *     signal?: NodeJS.Signals | null,
 *     error?: Error,
 *     stdout?: string,
 *     stderr?: string,
 *   },
 *   tempDirectory?: string,
 *   windir?: string,
 * }} [options]
 */
export function buildWindowsOwnedGuard({
  source = resolve(import.meta.dirname, '../windows-owned-guard.cs'),
  spawnProcess = spawnSync,
  tempDirectory = tmpdir(),
  windir = process.env.WINDIR,
} = {}) {
  const directory = mkdtempSync(join(tempDirectory, 'station-owned-guard-'));
  const staged = join(directory, `${randomUUID()}.partial.exe`);
  const output = join(directory, 'station-windows-owned-guard.exe');
  const compiler = windir
    ? join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
    : 'csc.exe';
  try {
    const sourceIdentity = fileObservation(source, true);
    const compilerIdentity = fileObservation(compiler);
    const before = hostObservation();
    const started = performance.now();
    const compiled = spawnSyncBounded(
      compiler,
      ['/nologo', '/target:exe', `/out:${staged}`, source],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: GUARD_COMPILER_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
      { run: spawnProcess },
    );
    const elapsedMs = performance.now() - started;
    if (compiled.error || compiled.status !== 0) {
      const diagnostic = compilerDiagnostic(compiled, {
        schemaVersion: 1,
        timeoutMs: GUARD_COMPILER_TIMEOUT_MS,
        elapsedMs,
        coordinator: {
          pid: process.pid,
          platform: process.platform,
          arch: process.arch,
          node: process.version,
        },
        source: sourceIdentity,
        compiler: compilerIdentity,
        before,
        after: hostObservation(),
        stagedOutput: fileObservation(staged),
      });
      throw new Error(
        `Windows Job guard compilation failed: ${diagnostic || 'unknown compiler failure'}`,
        { cause: compiled.error },
      );
    }
    assertRegularPrivateFile(staged);
    renameSync(staged, output);
    assertRegularPrivateFile(output);
  } catch (error) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${error.message}\nWindows Job guard cleanup failed for ${directory}: ${cleanupError.message}`,
        { cause: error },
      );
    }
    throw error;
  }
  return {
    path: output,
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
