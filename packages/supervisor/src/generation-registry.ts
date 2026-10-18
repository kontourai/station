/**
 * Defense in depth for a supervisor that was killed outright. Every core must
 * exit when its IPC channel closes (see protocol.ts); one that does not would
 * keep holding the instance's ports. The supervisor records each generation's
 * pid with a start-time fingerprint, and the next supervisor terminates any
 * recorded generation that is still the same process. A pid whose
 * fingerprint differs has been reused and is never touched.
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
import { readFile } from 'node:fs/promises';

interface GenerationRecord {
  pid: number;
  generation: number;
  fingerprint: string;
}

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: 10_000 },
      (error, stdout) => {
        resolve(error ? null : String(stdout).trim() || null);
      },
    );
  });
}

/**
 * The process's start time as an opaque string, or null if no such process.
 * Linux reads /proc; macOS and other Unixes ask `ps`; Windows asks PowerShell.
 */
export async function processFingerprint(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      // Fields after the parenthesised command; starttime is field 22 overall.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const start = fields[19];
      return start ? `linux:${start}` : null;
    } catch {
      return null;
    }
  }
  if (process.platform === 'win32') {
    const ticks = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
    ]);
    return ticks && /^\d+$/.test(ticks) ? `win32:${ticks}` : null;
  }
  const started = await run('ps', ['-o', 'lstart=', '-p', String(pid)]);
  return started ? `ps:${started}` : null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
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

/**
 * Terminates every recorded generation that is still the same process, waits
 * for each to go, then removes the record file. Returns the pids it reaped.
 */
export async function reapStaleGenerations(
  path: string,
  options: { log: (message: string) => void; waitMs?: number },
): Promise<number[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const reaped: number[] = [];
  for (const record of parseRecords(text)) {
    if (record.pid === process.pid) continue;
    const current = await processFingerprint(record.pid);
    if (current === null) continue;
    if (current !== record.fingerprint) {
      options.log(
        `not touching pid ${record.pid}: it was reused since generation ${record.generation} recorded it`,
      );
      continue;
    }
    try {
      process.kill(record.pid, 'SIGKILL');
    } catch {
      continue;
    }
    const deadline = Date.now() + (options.waitMs ?? 5_000);
    while (isAlive(record.pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    options.log(
      `reaped stale generation ${record.generation} (pid ${record.pid})`,
    );
    reaped.push(record.pid);
  }
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
  return reaped;
}

/** The live record of this supervisor's generations. */
export class GenerationRegistry {
  private readonly path: string;
  private readonly records = new Map<number, GenerationRecord>();

  constructor(path: string) {
    this.path = path;
  }

  /** Records a generation once its fingerprint is known, if it is still running. */
  async record(
    pid: number,
    generation: number,
    stillRunning: () => boolean,
  ): Promise<void> {
    const fingerprint = await processFingerprint(pid);
    if (!fingerprint || !stillRunning()) return;
    this.records.set(pid, { pid, generation, fingerprint });
    this.write();
  }

  remove(pid: number): void {
    if (this.records.delete(pid)) this.write();
  }

  private write(): void {
    if (this.records.size === 0) {
      try {
        unlinkSync(this.path);
      } catch {
        // Already gone.
      }
      return;
    }
    const temp = `${this.path}.${process.pid}.tmp`;
    const fd = openSync(temp, 'w', 0o600);
    try {
      writeSync(fd, JSON.stringify([...this.records.values()]));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.path);
  }
}
