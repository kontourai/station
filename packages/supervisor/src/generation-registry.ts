/**
 * Defense in depth for a supervisor that was killed outright. Every core must
 * exit when its IPC channel closes (see protocol.ts); one that does not would
 * keep holding the instance's ports. The supervisor records each generation's
 * pid with a start-time fingerprint, and the next supervisor (holding the
 * instance lock, so no other supervisor for the instance is alive) terminates
 * any recorded generation that is still the same process, with its process
 * group. A pid whose fingerprint differs has been reused and is never
 * touched; one that cannot be fingerprinted is left alone and kept on record.
 */
import { execFile } from 'node:child_process';
import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';

export interface GenerationRecord {
  pid: number;
  generation: number;
  fingerprint: string;
}

export type Fingerprint =
  | { status: 'ok'; value: string }
  | { status: 'gone' }
  | { status: 'unknown'; reason: string };

interface RunResult {
  /** Exit code, or a system error code such as ENOENT; null on success. */
  code: number | string | null;
  stdout: string;
}

interface FingerprintDeps {
  platform?: NodeJS.Platform;
  readFile?: (path: string) => Promise<string>;
  run?: (file: string, args: string[]) => Promise<RunResult>;
}

function run(file: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: 10_000 },
      (error, stdout) => {
        const code = error
          ? (error as NodeJS.ErrnoException & { killed?: boolean }).killed
            ? 'TIMEOUT'
            : ((error as { code?: number | string }).code ?? 'ERROR')
          : null;
        resolve({ code, stdout: String(stdout ?? '').trim() });
      },
    );
  });
}

/**
 * The process's start time as an opaque value. `gone` means no such process;
 * `unknown` means it could not be determined (tool missing, timeout), in
 * which case nothing may be concluded about the pid. On Linux the boot id is
 * part of the value, so a record from before a reboot never matches.
 */
export async function processFingerprint(
  pid: number,
  deps: FingerprintDeps = {},
): Promise<Fingerprint> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: 'gone' };
  const platform = deps.platform ?? process.platform;
  const readFile =
    deps.readFile ?? ((path: string) => readFileAsync(path, 'utf8'));
  const exec = deps.run ?? run;
  if (platform === 'linux') {
    let bootId: string;
    try {
      bootId = (await readFile('/proc/sys/kernel/random/boot_id')).trim();
    } catch (error) {
      return {
        status: 'unknown',
        reason: `boot id unreadable: ${String(error)}`,
      };
    }
    let stat: string;
    try {
      stat = await readFile(`/proc/${pid}/stat`);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? { status: 'gone' }
        : { status: 'unknown', reason: String(error) };
    }
    // Fields after the parenthesised command; starttime is field 22 overall.
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return start
      ? { status: 'ok', value: `linux:${bootId}:${start}` }
      : { status: 'unknown', reason: 'unparseable /proc stat' };
  }
  if (platform === 'win32') {
    const result = await exec('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
    ]);
    if (result.code === null && /^\d+$/.test(result.stdout)) {
      return { status: 'ok', value: `win32:${result.stdout}` };
    }
    return result.code === 1
      ? { status: 'gone' }
      : { status: 'unknown', reason: `powershell: ${String(result.code)}` };
  }
  const result = await exec('ps', ['-o', 'lstart=', '-p', String(pid)]);
  if (result.code === null && result.stdout)
    return { status: 'ok', value: `ps:${result.stdout}` };
  // ps exits 1 with no output when the pid does not exist.
  return result.code === 1 && !result.stdout
    ? { status: 'gone' }
    : { status: 'unknown', reason: `ps: ${String(result.code)}` };
}

/**
 * Sends a signal to the generation's process group (generations are their
 * own group leaders on POSIX), falling back to the pid alone. On Windows the
 * whole tree is killed with taskkill.
 */
export function signalGenerationTree(
  pid: number,
  signal: 'SIGTERM' | 'SIGKILL',
): void {
  if (process.platform === 'win32') {
    execFile(
      'taskkill',
      ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true },
      () => {},
    );
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

function exists(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True while the process, or any member of its process group, is alive. */
function treeRunning(pid: number): boolean {
  return exists(pid) || (process.platform !== 'win32' && exists(-pid));
}

function parseRecords(text: string): GenerationRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is GenerationRecord =>
      typeof entry === 'object' &&
      entry !== null &&
      Number.isSafeInteger(entry.pid) &&
      entry.pid > 0 &&
      Number.isSafeInteger(entry.generation) &&
      typeof entry.fingerprint === 'string' &&
      entry.fingerprint.length > 0,
  );
}

async function waitUntilGone(
  pid: number,
  isRunning: (pid: number) => boolean,
  ms: number,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (isRunning(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

/**
 * Reaps every recorded generation that is still the same process: SIGTERM to
 * its tree, a grace, then SIGKILL. A generation is reported reaped only once
 * it is confirmed gone; one that survives SIGKILL makes this throw, so the
 * supervisor refuses to start instead of crash-looping on a held port.
 * Records that cannot be fingerprinted are kept in the file and returned.
 */
export async function reapStaleGenerations(
  path: string,
  options: {
    log: (message: string) => void;
    fingerprint?: (pid: number) => Promise<Fingerprint>;
    signal?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
    isRunning?: (pid: number) => boolean;
    graceMs?: number;
    waitMs?: number;
  },
): Promise<{ reaped: number[]; kept: GenerationRecord[] }> {
  const fingerprint =
    options.fingerprint ?? ((pid: number) => processFingerprint(pid));
  const signal = options.signal ?? signalGenerationTree;
  const isRunning = options.isRunning ?? treeRunning;
  let text: string;
  try {
    text = await readFileAsync(path, 'utf8');
  } catch {
    return { reaped: [], kept: [] };
  }
  const reaped: number[] = [];
  const kept: GenerationRecord[] = [];
  for (const record of parseRecords(text)) {
    if (record.pid === process.pid) continue;
    const current = await fingerprint(record.pid);
    if (current.status === 'gone') continue;
    if (current.status === 'unknown') {
      options.log(
        `could not fingerprint pid ${record.pid} (${current.reason}); leaving it alone and keeping its record`,
      );
      kept.push(record);
      continue;
    }
    if (current.value !== record.fingerprint) {
      options.log(
        `not touching pid ${record.pid}: it was reused since generation ${record.generation} recorded it`,
      );
      continue;
    }
    signal(record.pid, 'SIGTERM');
    if (
      !(await waitUntilGone(record.pid, isRunning, options.graceMs ?? 2_000))
    ) {
      signal(record.pid, 'SIGKILL');
      if (
        !(await waitUntilGone(record.pid, isRunning, options.waitMs ?? 5_000))
      ) {
        throw new Error(
          `stale generation ${record.generation} (pid ${record.pid}) is still running after SIGKILL; refusing to start`,
        );
      }
    }
    options.log(
      `reaped stale generation ${record.generation} (pid ${record.pid})`,
    );
    reaped.push(record.pid);
  }
  try {
    if (kept.length > 0) writeRecords(path, kept);
    else unlinkSync(path);
  } catch (error) {
    options.log(
      `could not update the generation registry ${path}: ${String(error)}`,
    );
  }
  return { reaped, kept };
}

function writeRecords(path: string, records: GenerationRecord[]): void {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    const fd = openSync(temp, 'w', 0o600);
    try {
      writeSync(fd, JSON.stringify(records));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Never created.
    }
    throw error;
  }
}

/**
 * The live record of this supervisor's generations. Every write is
 * best-effort: a failure is logged and the supervisor carries on.
 */
export class GenerationRegistry {
  private readonly path: string;
  private readonly log: (message: string) => void;
  private readonly records = new Map<number, GenerationRecord>();

  /** `kept` are records a reap could not judge; they stay on file. */
  constructor(path: string, log: (message: string) => void) {
    this.path = path;
    this.log = log;
  }

  /** Keeps records a reap could not judge, so they stay on file. */
  keep(records: GenerationRecord[]): void {
    for (const record of records) this.records.set(record.pid, record);
  }

  /** Records a generation once its fingerprint is known, if it is still running. */
  async record(
    pid: number,
    generation: number,
    stillRunning: () => boolean,
  ): Promise<void> {
    try {
      const fingerprint = await processFingerprint(pid);
      if (fingerprint.status !== 'ok' || !stillRunning()) {
        if (fingerprint.status === 'unknown') {
          this.log(
            `could not fingerprint generation ${generation} (pid ${pid}): ${fingerprint.reason}`,
          );
        }
        return;
      }
      this.records.set(pid, {
        pid,
        generation,
        fingerprint: fingerprint.value,
      });
      this.write();
    } catch (error) {
      this.log(`could not record generation ${generation}: ${String(error)}`);
    }
  }

  remove(pid: number): void {
    if (this.records.delete(pid)) this.write();
  }

  private write(): void {
    try {
      if (this.records.size === 0) {
        try {
          unlinkSync(this.path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        return;
      }
      writeRecords(this.path, [...this.records.values()]);
    } catch (error) {
      this.log(
        `could not write the generation registry ${this.path}: ${String(error)}`,
      );
    }
  }
}
