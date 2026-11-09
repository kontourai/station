/**
 * A Windows command session's process custody (#4624). The command runs
 * inside a kill-on-close Job Object with no breakaway limit, created by the
 * Station Job guard (`scripts/windows-owned-guard.cs`, `--session` mode)
 * before the command's first instruction runs. Every process the command
 * starts is in that Job, including one whose parent has already exited, which
 * no parent-pid census can attribute. Stop and the output cap end the whole
 * Job, and the guard reports `ENDED` only once the Job holds no live process.
 * After natural leader exit, the Job is released only when bounded output
 * accounting confirms uncapped, complete output and no termination request.
 * Otherwise the Job ends; a valid release leaves background children running.
 *
 * The guard passes the command its own std handles: stdout and stderr on the
 * guard's fds 3 and 4, and stdin on fd 5, so a command tab still takes typing.
 * Its own stdin and stdout carry the control protocol (BOUND, RESUME, ABORT,
 * EXIT, RELEASE_UNCAPPED, COMPLETE, ENDED).
 */
import {
  type ChildProcess,
  execFile,
  type SpawnOptions,
} from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import { mkdtemp, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { Duplex, type Readable, type Writable } from 'node:stream';
import { resolveWindowsBirthHelper } from '@kontourai/station-shared/process-identity';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger({ name: 'terminal-command-guard' });

const GUARD_SOURCE = join('scripts', 'windows-owned-guard.cs');
const COMPILE_TIMEOUT_MS = 120_000;
const IDENTITY_TIMEOUT_MS = 30_000;

/** The surface `CommandProcess` uses from a spawned command. */
export interface CommandChild {
  readonly pid?: number | undefined;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  once(
    event: 'exit' | 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal?: NodeJS.Signals): boolean;
  /**
   * Ends the command's whole Job and resolves once none of it is alive;
   * rejects when that cannot be confirmed. Only a command in a Job has it.
   */
  endJob?(): Promise<void>;
  /** Release a naturally exited Job only after its bounded output verdict. */
  completeOutput?(): Promise<void>;
}

function run(
  file: string,
  args: string[],
  timeout: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: 'utf8', timeout, windowsHide: true },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(`${error.message}${stderr ? `: ${stderr.trim()}` : ''}`),
          );
        else resolve({ stdout, stderr });
      },
    );
  });
}

/** The guard source of a source checkout or unpacked build tree, if any. */
function findGuardSource(from: string): string | null {
  let directory = from;
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(directory, GUARD_SOURCE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

/**
 * Compiles the guard with the .NET Framework compiler every Windows host
 * carries, into a directory private to this process, removed on exit.
 */
async function compileGuard(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'station-command-guard-'));
  process.once('exit', () => {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // A crash can leave it; its random name is never trusted again.
    }
  });
  const staged = join(directory, 'guard.partial.exe');
  const output = join(directory, 'station-windows-owned-guard.exe');
  const compiler = join(
    process.env.WINDIR ?? 'C:\\Windows',
    'Microsoft.NET',
    'Framework64',
    'v4.0.30319',
    'csc.exe',
  );
  await run(
    compiler,
    ['/nologo', '/target:exe', `/out:${staged}`, source],
    COMPILE_TIMEOUT_MS,
  );
  await rename(staged, output);
  return output;
}

let resolvedGuard: Promise<string | null> | undefined;

/**
 * The guard this process runs commands through: the archive's staged guard
 * (verified against its digest), else one compiled from the source tree
 * this server runs from. Null when neither is available; commands then run
 * without a Job and Stop ends only the processes it can prove descend from
 * the command (`command-process.ts`).
 */
export function resolveWindowsCommandGuard(): Promise<string | null> {
  resolvedGuard ??= (async () => {
    const staged = resolveWindowsBirthHelper();
    if (staged) return staged;
    const source = findGuardSource(import.meta.dirname);
    if (!source) {
      logger.warn(
        'No Station Job guard is available: Stop cannot reach a command process whose parent has exited',
      );
      return null;
    }
    try {
      return await compileGuard(source);
    } catch (error) {
      logger.warn(
        'The Station Job guard could not be compiled: Stop cannot reach a command process whose parent has exited',
        { error },
      );
      return null;
    }
  })();
  return resolvedGuard;
}

const identities = new Map<string, Promise<string>>();

/** This process's creation time as the guard reads it; it binds the guard to us. */
function parentIdentity(guard: string): Promise<string> {
  let identity = identities.get(guard);
  if (!identity) {
    identity = run(
      guard,
      ['--identity', String(process.pid)],
      IDENTITY_TIMEOUT_MS,
    ).then(({ stdout }) => {
      const value = stdout.trim();
      if (!value) throw new Error('The Job guard reported no identity');
      return value;
    });
    // A failed read is retried by the next command, not kept.
    identity.catch(() => identities.delete(guard));
    identities.set(guard, identity);
  }
  return identity;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function environmentPath(env: NodeJS.ProcessEnv): string {
  for (const [key, value] of Object.entries(env))
    if (key.toUpperCase() === 'PATH' && value !== undefined) return value;
  return '';
}

/**
 * Where Node would find `file` on Windows (libuv's `search_path`): a name
 * with a directory is looked up there; a bare name in `cwd`, then each `PATH`
 * entry of the command's environment. A name with an extension is tried as
 * is, then with `.com` and `.exe` appended. Null when Node would answer
 * ENOENT.
 */
export function resolveWindowsExecutable(
  file: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const nameStart =
    Math.max(
      file.lastIndexOf('\\'),
      file.lastIndexOf('/'),
      file.lastIndexOf(':'),
    ) + 1;
  const name = file.slice(nameStart);
  if (!name || name === '.') return null;
  const dot = name.indexOf('.');
  const hasExtension = dot !== -1 && dot < name.length - 1;
  const directories =
    nameStart > 0
      ? [file.slice(0, nameStart)]
      : [
          '',
          ...environmentPath(env)
            .split(';')
            .map((entry) => entry.replace(/"/g, ''))
            .filter(Boolean),
        ];
  for (const directory of directories) {
    const base = win32.resolve(cwd, directory, name);
    for (const candidate of [
      ...(hasExtension ? [base] : []),
      `${base}.com`,
      `${base}.exe`,
    ])
      if (isFile(candidate)) return candidate;
  }
  return null;
}

/** One argument as Node quotes it on Windows (libuv's `quote_cmd_arg`). */
function quoteWindowsArgument(argument: string): string {
  if (argument === '') return '""';
  if (!/[ \t"]/.test(argument)) return argument;
  if (!/["\\]/.test(argument)) return `"${argument}"`;
  let quoted = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === '\\') {
      backslashes++;
      continue;
    }
    quoted +=
      character === '"'
        ? `${'\\'.repeat(backslashes * 2 + 1)}"`
        : '\\'.repeat(backslashes) + character;
    backslashes = 0;
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`;
}

/** The command line Node would build for `file args` (verbatim for cmd.exe). */
export function windowsCommandLine(
  file: string,
  args: readonly string[],
  verbatim: boolean,
): string {
  return [file, ...args]
    .map((argument) => (verbatim ? argument : quoteWindowsArgument(argument)))
    .join(' ');
}

/** A guard failure before the command started, as the spawn errno Node would give. */
function spawnErrorCode(diagnostic: string): string | undefined {
  const win32Error = /create-process win32=(\d+)/.exec(diagnostic)?.[1];
  if (win32Error === '2' || win32Error === '3') return 'ENOENT';
  if (win32Error === '5') return 'EACCES';
  return undefined;
}

export class GuardSpawnError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
  }
}

function stream(guard: ChildProcess, fd: number): Duplex {
  const value = guard.stdio[fd];
  if (!(value instanceof Duplex))
    throw new GuardSpawnError('The Job guard has no command pipes', undefined);
  return value;
}

/**
 * The command as `CommandProcess` sees it: the command's pid and std
 * streams, and its exit as the guard reports it.
 */
class GuardedCommandChild implements CommandChild {
  pid: number | undefined;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly started: Promise<void>;
  private completed: number | null = null;
  private ended = false;
  private diagnostic = '';
  private readonly guardExited: Promise<number | null>;
  private readonly leaderExited: Promise<
    [number | null, NodeJS.Signals | null]
  >;
  private ending: Promise<void> | undefined;

  constructor(private readonly guard: ChildProcess) {
    this.stdout = stream(guard, 3);
    this.stderr = stream(guard, 4);
    this.stdin = stream(guard, 5);
    guard.stdin?.on('error', () => {});
    guard.stderr?.setEncoding('utf8');
    guard.stderr?.on('data', (text: string) => {
      if (this.diagnostic.length < 4096) this.diagnostic += text;
    });
    // Node can report the guard's exit before the last control line has
    // been read; its outcome is final only once its control output closed.
    this.guardExited = new Promise((resolve) => {
      let code: number | null = null;
      let exited = false;
      let drained = !guard.stdout;
      const settle = () => {
        if (exited && drained) resolve(code);
      };
      guard.once('exit', (status) => {
        code = status;
        exited = true;
        settle();
      });
      guard.stdout?.once('close', () => {
        drained = true;
        settle();
      });
      guard.once('error', () => resolve(null));
    });
    let leaderExited!: (
      outcome: [number | null, NodeJS.Signals | null],
    ) => void;
    this.leaderExited = new Promise((resolve) => {
      leaderExited = resolve;
    });
    let bound!: () => void;
    let refused!: (error: GuardSpawnError) => void;
    this.started = new Promise<void>((resolve, reject) => {
      bound = resolve;
      refused = reject;
    });
    let buffered = '';
    guard.stdout?.setEncoding('utf8');
    guard.stdout?.on('data', (text: string) => {
      buffered += text;
      for (
        let newline = buffered.indexOf('\n');
        newline !== -1;
        newline = buffered.indexOf('\n')
      ) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        const binding = /^BOUND (\d+) \S+$/.exec(line);
        if (binding && this.pid === undefined) {
          this.pid = Number(binding[1]);
          guard.stdin?.write('RESUME\n');
          bound();
        } else if (/^EXIT \d+$/.test(line))
          leaderExited([Number(line.slice('EXIT '.length)), null]);
        else if (/^COMPLETE \d+$/.test(line))
          this.completed = Number(line.slice('COMPLETE '.length));
        else if (line === 'ENDED') this.ended = true;
      }
    });
    void this.guardExited.then(() => {
      leaderExited(this.outcome());
      if (this.pid === undefined) {
        const diagnostic = this.diagnostic.trim();
        refused(
          new GuardSpawnError(
            `spawn failed: ${diagnostic || 'the Job guard did not start the command'}`,
            spawnErrorCode(diagnostic),
          ),
        );
      }
    });
    guard.once('error', (error: NodeJS.ErrnoException) =>
      refused(
        new GuardSpawnError(`spawn failed: ${error.message}`, error.code),
      ),
    );
  }

  /** The command's exit code, or SIGKILL when its Job was ended for it. */
  private outcome(): [number | null, NodeJS.Signals | null] {
    return this.completed === null ? [null, 'SIGKILL'] : [this.completed, null];
  }

  once(
    event: 'exit' | 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this {
    if (event === 'close')
      void this.guardExited.then((code) => {
        if (code === 0) listener(...this.outcome());
        else listener(null, 'SIGKILL');
      });
    else void this.leaderExited.then((outcome) => listener(...outcome));
    return this;
  }

  kill(): boolean {
    void this.endJob().catch(() => undefined);
    return true;
  }

  endJob(): Promise<void> {
    this.ending ??= (async () => {
      this.guard.stdin?.write('ABORT\n');
      const code = await this.guardExited;
      if (!(this.ended && code === 0))
        throw new Error(
          `The command or a process it started could not be confirmed ended${
            this.diagnostic.trim() ? ` (${this.diagnostic.trim()})` : ''
          }`,
        );
    })();
    return this.ending;
  }

  async completeOutput(): Promise<void> {
    if (this.ending) return this.ending;
    this.guard.stdin?.write('RELEASE_UNCAPPED\n');
    const code = await this.guardExited;
    if (this.completed === null || code !== 0 || this.ending)
      throw new Error(
        'The command Job was not released after its output verdict',
      );
  }
}

/**
 * Starts `file args` inside a Job through `guard`, resolved and quoted as
 * Node would start it directly, and resolves once the command is running.
 */
export async function spawnGuardedCommand(
  guard: string,
  input: {
    command: string;
    args: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    verbatim: boolean;
  },
  spawn: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess,
): Promise<CommandChild> {
  const application = resolveWindowsExecutable(
    input.command,
    input.cwd,
    input.env,
  );
  if (!application)
    throw new GuardSpawnError(
      `spawn failed: spawn ${input.command} ENOENT`,
      'ENOENT',
    );
  let identity: string;
  try {
    identity = await parentIdentity(guard);
  } catch (error) {
    throw new GuardSpawnError(
      `spawn failed: the Job guard could not read this process (${(error as Error).message})`,
      undefined,
    );
  }
  let guardProcess: ChildProcess;
  try {
    guardProcess = spawn(
      guard,
      [
        '--session',
        String(process.pid),
        identity,
        application,
        windowsCommandLine(input.command, input.args, input.verbatim),
      ],
      {
        cwd: input.cwd,
        env: input.env,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
  } catch (error) {
    throw new GuardSpawnError(
      `spawn failed: ${(error as Error).message}`,
      (error as NodeJS.ErrnoException).code,
    );
  }
  const child = new GuardedCommandChild(guardProcess);
  await child.started;
  return child;
}
