/**
 * The `opencode serve` processes Station's native OpenCode transport runs:
 * one per (connection, real working directory, launch environment), shared
 * by every session with that key, stopped once unused for a while.
 *
 * Each server is started the way OpenCode starts its own private one
 * (`cli/src/services/standalone.ts`):
 *
 * - `serve --stdio --hostname 127.0.0.1 --port 0`: always an OS-chosen
 *   loopback port, never OpenCode's default (4096) or one a person uses.
 *   `--stdio` makes the server print `{"url": ...}` when ready and exit when
 *   its stdin closes, so Station's end of that pipe is the server's lease:
 *   if Station dies, the OS closes it and the server goes too.
 * - `OPENCODE_PASSWORD`: 32 random bytes, held only in memory. An inherited
 *   `OPENCODE_SERVER_PASSWORD` is dropped, so nothing outside Station can
 *   name the credential.
 * - cwd: the real path. OpenCode keys locations by the path it is given, so
 *   `/tmp/x` and `/private/tmp/x` would be two projects (seen on 2.3.0).
 * - Spawned through `spawnOwnedChild`, so the startup sweep reaps a server a
 *   crashed Station left behind, with `TMPDIR` the engine spawn directory.
 *
 * Readiness is the `{url}` line, then `GET /api/info` answering 200 (a 503
 * means still booting), within {@link OPENCODE_SERVE_READY_TIMEOUT_MS}.
 */
import type { ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { spawnOwnedChild } from '../../services/infra/process-utils.js';
import {
  OpenCodeServeClient,
  OpenCodeServeHttpError,
} from './opencode-serve-client.js';

export const OPENCODE_SERVE_READY_TIMEOUT_MS = 10_000;
/** How long an unused server stays up for the next session. */
export const OPENCODE_SERVE_IDLE_STOP_MS = 5 * 60_000;
/** After stdin closes, how long the server has to exit before SIGTERM, then SIGKILL. */
const STOP_GRACE_MS = 3_000;

export class OpenCodeServeStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenCodeServeStartError';
  }
}

export interface OpenCodeServeAcquireInput {
  readonly connectionId: string;
  /** The resolved `opencode` binary. */
  readonly binary: string;
  readonly cwd: string;
  /** The launch environment, before Station adds the password and TMPDIR. */
  readonly env: NodeJS.ProcessEnv;
  /** The engine spawn tmp dir. */
  readonly tmpDir: string;
}

export interface OpenCodeServeLease {
  readonly url: string;
  readonly client: OpenCodeServeClient;
  /** The real working directory the server was started in. */
  readonly cwd: string;
  /** Settles when the server process exits, for whatever reason. */
  readonly exited: Promise<void>;
  /** Give the lease back; the server stops once unused past the idle bound. */
  release(): void;
}

type Spawn = typeof spawnOwnedChild;

interface ServerEntry {
  readonly key: string;
  refs: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  stopping?: Promise<void>;
  readonly started: Promise<{
    url: string;
    client: OpenCodeServeClient;
    cwd: string;
  }>;
  proc?: ChildProcess;
  release?: () => void;
  exited: Promise<void>;
}

export interface OpenCodeServePoolOptions {
  spawn?: Spawn;
  realpath?: (path: string) => Promise<string>;
  /** Asked before every spawn: the Feature Preview gate. A `false` refuses. */
  allowSpawn?: () => boolean;
  idleStopMs?: number;
  readyTimeoutMs?: number;
  fetch?: typeof fetch;
}

/** Variables that would let a launch environment name the server's credential. */
const STRIPPED_ENV = ['OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD'];

function envDigest(env: NodeJS.ProcessEnv, tmpDir: string): string {
  const entries = Object.entries(env)
    .filter(
      ([key, value]) => value !== undefined && !STRIPPED_ENV.includes(key),
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256')
    .update(JSON.stringify([entries, tmpDir]))
    .digest('hex');
}

export class OpenCodeServePool {
  private readonly servers = new Map<string, ServerEntry>();
  private readonly spawn: Spawn;
  private readonly realpath: (path: string) => Promise<string>;
  private readonly idleStopMs: number;
  private readonly readyTimeoutMs: number;
  private closed = false;

  constructor(private readonly options: OpenCodeServePoolOptions = {}) {
    this.spawn = options.spawn ?? spawnOwnedChild;
    this.realpath = options.realpath ?? realpath;
    this.idleStopMs = options.idleStopMs ?? OPENCODE_SERVE_IDLE_STOP_MS;
    this.readyTimeoutMs =
      options.readyTimeoutMs ?? OPENCODE_SERVE_READY_TIMEOUT_MS;
  }

  /** A lease on the server for this key, starting one if none runs. */
  async acquire(input: OpenCodeServeAcquireInput): Promise<OpenCodeServeLease> {
    if (this.closed) throw new OpenCodeServeStartError('The pool is closed.');
    const cwd = await this.realpath(input.cwd);
    const key = JSON.stringify([
      input.connectionId,
      cwd,
      envDigest(input.env, input.tmpDir),
    ]);
    let entry = this.servers.get(key);
    if (!entry || entry.stopping) {
      if (this.options.allowSpawn && !this.options.allowSpawn())
        throw new OpenCodeServeStartError(
          'The native OpenCode transport is turned off.',
        );
      entry = this.start(key, input, cwd);
      this.servers.set(key, entry);
    }
    entry.refs += 1;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    let started: Awaited<ServerEntry['started']>;
    try {
      started = await entry.started;
    } catch (error) {
      entry.refs -= 1;
      throw error;
    }
    const held = entry;
    let released = false;
    return {
      ...started,
      exited: held.exited,
      release: () => {
        if (released) return;
        released = true;
        this.releaseRef(held);
      },
    };
  }

  /** Stop every server now. */
  async stopAll(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.servers.values()].map((entry) => this.stop(entry)),
    );
  }

  private start(
    key: string,
    input: OpenCodeServeAcquireInput,
    cwd: string,
  ): ServerEntry {
    const password = randomBytes(32).toString('base64url');
    const env: NodeJS.ProcessEnv = { ...input.env };
    for (const name of STRIPPED_ENV) delete env[name];
    env.OPENCODE_PASSWORD = password;
    env.TMPDIR = input.tmpDir;
    const { proc, release } = this.spawn(
      input.binary,
      ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'],
      { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    let markExited!: () => void;
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    const started = this.ready(proc, password, cwd).catch(
      async (error: unknown) => {
        await this.stop(entry);
        throw error;
      },
    );
    started.catch(() => undefined);
    const entry: ServerEntry = { key, refs: 0, proc, release, exited, started };
    proc.once('exit', () => {
      release();
      if (this.servers.get(key) === entry) this.servers.delete(key);
      markExited();
    });
    proc.on('error', () => undefined);
    return entry;
  }

  private async ready(
    proc: ChildProcess,
    password: string,
    cwd: string,
  ): Promise<{ url: string; client: OpenCodeServeClient; cwd: string }> {
    const deadline = Date.now() + this.readyTimeoutMs;
    const url = await readReadyLine(proc, this.readyTimeoutMs);
    // Keep draining stdout so a later write never blocks the server.
    proc.stdout?.resume();
    const client = new OpenCodeServeClient({
      baseUrl: url,
      password,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
    let wait = 50;
    for (;;) {
      try {
        await client.request('GET', '/api/info', undefined, {
          signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        });
        return { url, client, cwd };
      } catch (error) {
        const booting =
          !(error instanceof OpenCodeServeHttpError) || error.status === 503;
        if (!booting || Date.now() + wait > deadline)
          throw new OpenCodeServeStartError(
            `OpenCode serve did not become ready: ${error instanceof Error ? error.message : String(error)}`,
          );
      }
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait = Math.min(wait * 2, 1_000);
    }
  }

  private releaseRef(entry: ServerEntry): void {
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0 || entry.stopping) return;
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (entry.refs === 0) void this.stop(entry);
    }, this.idleStopMs);
    entry.idleTimer.unref?.();
  }

  private stop(entry: ServerEntry): Promise<void> {
    if (entry.stopping) return entry.stopping;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (this.servers.get(entry.key) === entry) this.servers.delete(entry.key);
    entry.stopping = (async () => {
      const proc = entry.proc;
      if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
      proc.stdin?.end();
      if (await settlesWithin(entry.exited, STOP_GRACE_MS)) return;
      signalGroup(proc, 'SIGTERM');
      if (await settlesWithin(entry.exited, STOP_GRACE_MS)) return;
      signalGroup(proc, 'SIGKILL');
      await settlesWithin(entry.exited, STOP_GRACE_MS);
    })();
    return entry.stopping;
  }
}

function signalGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  const pid = proc.pid;
  if (!pid) return;
  try {
    // spawnOwnedChild spawns detached: the server leads its own group.
    process.kill(-pid, signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {}
  }
}

async function settlesWithin(
  done: Promise<void>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      done.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The `{"url": ...}` line `serve --stdio` prints when it listens. */
function readReadyLine(proc: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdout = proc.stdout;
    if (!stdout) {
      reject(new OpenCodeServeStartError('OpenCode serve has no stdout.'));
      return;
    }
    let buffer = '';
    const finish = (error?: Error, url?: string) => {
      clearTimeout(timer);
      stdout.off('data', onData);
      proc.off('exit', onExit);
      if (error) reject(error);
      else resolve(url as string);
    };
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const end = buffer.indexOf('\n');
      if (end < 0) {
        if (buffer.length > 64 * 1024)
          finish(
            new OpenCodeServeStartError(
              'OpenCode serve printed no ready line.',
            ),
          );
        return;
      }
      const line = buffer.slice(0, end).trim();
      try {
        const url = (JSON.parse(line) as { url?: unknown }).url;
        if (typeof url !== 'string') throw new Error('no url');
        finish(undefined, url);
      } catch {
        finish(
          new OpenCodeServeStartError(
            'OpenCode serve printed something other than its ready line.',
          ),
        );
      }
    };
    const onExit = (code: number | null) =>
      finish(
        new OpenCodeServeStartError(
          `OpenCode serve exited (${code ?? 'signal'}) before it was ready.`,
        ),
      );
    const timer = setTimeout(
      () =>
        finish(
          new OpenCodeServeStartError(
            `OpenCode serve was not ready within ${timeoutMs}ms.`,
          ),
        ),
      timeoutMs,
    );
    stdout.on('data', onData);
    proc.once('exit', onExit);
  });
}
