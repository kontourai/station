/**
 * #3406: the filesystem reads attached-session discovery makes about a
 * session's folder (its real path, and the repository it belongs to), run in
 * a helper process with a deadline instead of on Station's main thread.
 *
 * Those reads are `realpath` and `lstat` calls on whatever folder a
 * transcript names. On a network or FUSE mount that has stopped answering
 * (NFS, SMB, a cloud drive) such a call blocks until the mount answers, and
 * on the main thread that froze the whole server, every two seconds.
 *
 * Why a child process, and not the alternatives:
 *
 * - Asynchronous `fs` runs on libuv's shared thread pool (four threads by
 *   default). A hung call holds its thread until the mount answers, so four
 *   hung folders would stall every file read, hash and DNS lookup Station
 *   makes. A deadline on the promise frees the caller, not the thread.
 * - A worker thread keeps its own thread blocked instead, but Node joins
 *   every worker thread on exit, so one worker stuck in a syscall keeps
 *   Station from exiting at all (checked on Node 24: `terminate()` does not
 *   interrupt a blocked syscall, and the process stays alive).
 * - Skipping folders on a network filesystem (`statfs`) is neither safe nor
 *   correct: `statfs` is itself a call on the mount and hangs the same way,
 *   and a healthy network home directory is a normal place to work.
 *
 * A child process blocks only itself and is killed outright (SIGKILL to its
 * process group, as `plugin-draft-build-process.ts` does for the same
 * reason), so Station neither stalls nor waits for it on exit. It also has
 * its own libuv pool, so the asynchronous `.git` reads of
 * `locateRepository` cannot exhaust Station's.
 *
 * One long-lived child answers every poll; spawning one per poll would cost
 * a Node start every two seconds. When it stops making progress for the
 * deadline, the oldest unanswered folder is taken to be the hung one: the
 * child is killed, everything still waiting is "unread", and that folder is
 * not asked about again for a back-off period, nor while the child stuck on
 * it is still alive. The next request starts a fresh child.
 *
 * Unread is not missing. A folder that does not exist keeps its lexical path
 * (see `canonicalPath` in `attached-session-follow-service.ts`); an unread
 * one takes no part in that poll's matching (`AttachedPollPaths.canonical`):
 * its session is unattributed, which never replaces a project the log
 * already names, and its Project is not matched. Matching by the path as
 * written instead could pick a different Project than the real path would,
 * through a symlink or a nested root. A later poll that can read the folder
 * corrects a new session's attribution.
 *
 * Accepted gap: a helper stuck in a syscall cannot run its own exit-on-
 * disconnect handler, so it is killed by this process: when a hang is
 * declared, by `close()` at shutdown, and on `process.on('exit')`. If this
 * process is itself SIGKILLed or crashes natively, a helper stuck on a hung
 * mount outlives it until the mount answers.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../utils/logger.js';
import { expandTilde } from '../../utils/paths.js';
import {
  createPollRepositoryLookup,
  locateRepository,
  type RepositoryLocation,
  type RepositoryLookup,
} from './attached-session-repository.js';

const logger = createLogger({ name: 'attached-session-path-probe' });

const CHILD_ENTRY = new URL(
  `./attached-session-path-child.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`,
  import.meta.url,
);

/**
 * How long the child may go without answering anything while a request is
 * waiting. A healthy child answers a `realpath` in microseconds, so this only
 * has to be long enough not to mistake a briefly loaded host for a hung
 * mount; it is the most one hung folder can add to a poll.
 */
const DEFAULT_DEADLINE_MS = 1_500;
/** How long a folder that hung is answered as unread without asking. */
const DEFAULT_BACKOFF_MS = 60_000;
/**
 * How many killed helpers may still be alive before no new one starts. On a
 * hard NFS mount a process in an uninterruptible read ignores even SIGKILL
 * until the mount answers, so each new hung folder could otherwise leave one
 * more process behind, without bound. At the limit (logged once when
 * reached and once when it clears) only folders under one a stuck helper
 * hung on read as unread; every other folder reads as a missing folder does.
 */
const DEFAULT_MAX_STUCK_CHILDREN = 4;
/** How long a starting child may take to say it is ready (a dev `tsx` start is slow). */
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

type ProbeOperation = 'canonical' | 'repository';

interface ProbeRequest {
  id: number;
  op: ProbeOperation;
  path: string;
}

type ProbeAnswer =
  | { ready: true }
  | { id: number; value: string | RepositoryLocation | null };

/** The reads the child performs, injectable so a test child can make one hang. */
export interface AttachedPathReads {
  canonical(path: string): string | null;
  repository(path: string): Promise<RepositoryLocation | null>;
}

export const realAttachedPathReads: AttachedPathReads = {
  canonical: (path) => realpathSync.native(path),
  repository: async (path) => (await locateRepository(path)) ?? null,
};

/**
 * The child side: answer requests one at a time, in the order asked, then
 * exit with the parent.
 *
 * One at a time, and the next only once the previous answer has left: an IPC
 * send is written asynchronously, so an answer sent just before a read that
 * blocks would otherwise never leave, and the parent would lose a folder that
 * did answer. It also makes the parent's "the oldest unanswered request is
 * the stuck one" exact.
 */
export function serveAttachedPathReads(reads: AttachedPathReads): void {
  const queue: ProbeRequest[] = [];
  let running = false;
  const drain = async () => {
    running = true;
    for (let next = queue.shift(); next; next = queue.shift()) {
      const value = await answer(reads, next);
      await new Promise<void>((sent) => {
        if (!process.send) return sent();
        process.send({ id: next.id, value } satisfies ProbeAnswer, () =>
          sent(),
        );
      });
    }
    running = false;
  };
  process.on('message', (message: unknown) => {
    if (!isProbeRequest(message)) return;
    queue.push(message);
    if (!running) void drain();
  });
  // The parent exited or killed the channel: nothing is left to answer.
  process.on('disconnect', () => process.exit(0));
  process.send?.({ ready: true } satisfies ProbeAnswer);
}

async function answer(
  reads: AttachedPathReads,
  request: ProbeRequest,
): Promise<string | RepositoryLocation | null> {
  try {
    return request.op === 'canonical'
      ? reads.canonical(request.path)
      : await reads.repository(request.path);
  } catch {
    return null;
  }
}

function isProbeRequest(value: unknown): value is ProbeRequest {
  if (typeof value !== 'object' || value === null) return false;
  const { id, op, path } = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(id) &&
    (op === 'canonical' || op === 'repository') &&
    typeof path === 'string' &&
    path.length > 0
  );
}

/** The lexically absolute form of a folder: the answer when it does not exist. */
function lexicalPath(path: string): string {
  return resolve(expandTilde(path));
}

/** The folder answers one poll uses; see {@link AttachedPathProbe.forPoll}. */
export interface AttachedPollPaths {
  /** Reads the real path of every folder given (deduplicated, in the child). */
  prepare(paths: readonly (string | undefined)[]): Promise<void>;
  /**
   * A prepared folder's real path; its lexical one when it does not exist;
   * `undefined` when it could not be read this poll (it hung, is backed off,
   * or no helper could ask), so it matches nothing. Never touches the
   * filesystem.
   */
  canonical(path: string): string | undefined;
  /** The repository a folder belongs to, read in the child; once per folder per poll. */
  repository: RepositoryLookup;
}

export interface AttachedPathProbeOptions {
  /** For tests: the child entry to run instead of the real one. */
  childEntry?: URL;
  deadlineMs?: number;
  backoffMs?: number;
  startupTimeoutMs?: number;
  /** How many killed helpers may still be alive before no new one starts. */
  maxStuckChildren?: number;
  now?: () => number;
  /** For tests: observes each helper started. */
  onSpawn?: (child: ChildProcess) => void;
  /** For tests: how a hung helper is killed (default: SIGKILL to its group). */
  killChild?: (child: ChildProcess) => void;
}

/** A request the helper did not answer: hung, backed off, or not asked. */
const UNREAD = Symbol('unread');
type Answer = string | RepositoryLocation | null | typeof UNREAD;

interface PendingRequest {
  path: string;
  resolve: (value: Answer) => void;
}

interface RunningChild {
  process: ChildProcess;
  ready: Promise<boolean>;
  pending: Map<number, PendingRequest>;
  watchdog?: NodeJS.Timeout;
  /** Answers received so far; the watchdog compares it across a loop turn. */
  progress: number;
}

export class AttachedPathProbe {
  private readonly childEntry: URL;
  private readonly deadlineMs: number;
  private readonly backoffMs: number;
  private readonly startupTimeoutMs: number;
  private readonly now: () => number;
  private readonly maxStuckChildren: number;
  private readonly onSpawn?: (child: ChildProcess) => void;
  private readonly killChild: (child: ChildProcess) => void;
  /** Folder → when it may be asked about again, and the helper stuck on it. */
  private readonly backoff = new Map<
    string,
    { until: number; stuck: ChildProcess }
  >();
  /** Killed helpers whose exit has not been observed yet. */
  private readonly stuck = new Set<ChildProcess>();
  private child: RunningChild | undefined;
  /** A child that would not start is not respawned for every request. */
  private unavailableUntil = 0;
  private nextId = 0;
  private closed = false;
  /** Whether the stuck-helper limit was reached and logged, and not yet cleared. */
  private atStuckLimit = false;

  constructor(options: AttachedPathProbeOptions = {}) {
    this.childEntry = options.childEntry ?? CHILD_ENTRY;
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.startupTimeoutMs =
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.maxStuckChildren =
      options.maxStuckChildren ?? DEFAULT_MAX_STUCK_CHILDREN;
    this.now = options.now ?? Date.now;
    this.onSpawn = options.onSpawn;
    this.killChild = options.killChild ?? killGroup;
  }

  /** The real path of an absolute folder; `undefined` when it does not exist, hung, or could not be asked. */
  async canonical(path: string): Promise<string | undefined> {
    const value = await this.request('canonical', path);
    return typeof value === 'string' ? value : undefined;
  }

  /** The repository a folder belongs to; `undefined` when in none, hung, or could not be asked. */
  async repository(path: string): Promise<RepositoryLocation | undefined> {
    const value = await this.request('repository', path);
    return value !== null && typeof value === 'object' ? value : undefined;
  }

  /**
   * One poll's view. Answers are kept for that poll only: a folder can be
   * created, removed or remounted between polls (`src-server/AGENTS.md`).
   */
  forPoll(): AttachedPollPaths {
    // `undefined`: the folder could not be read this poll.
    const canonical = new Map<string, string | undefined>();
    return {
      prepare: async (paths) => {
        const wanted = new Set<string>();
        for (const path of paths) {
          if (path && !canonical.has(path)) wanted.add(path);
        }
        await Promise.all(
          [...wanted].map(async (path) => {
            const absolute = lexicalPath(path);
            const answer = await this.request('canonical', absolute);
            canonical.set(
              path,
              answer === UNREAD
                ? undefined
                : typeof answer === 'string'
                  ? answer
                  : absolute,
            );
          }),
        );
      },
      canonical: (path) => {
        if (!path) return undefined;
        return canonical.has(path) ? canonical.get(path) : lexicalPath(path);
      },
      repository: createPollRepositoryLookup((path) => this.repository(path)),
    };
  }

  /**
   * Kills the helper, and again any killed one not yet seen to exit. Final:
   * a poll still in flight at shutdown gets unread answers and starts no new
   * helper afterwards.
   */
  close(): void {
    this.closed = true;
    if (this.child) this.abandon(this.child);
    for (const stuck of this.stuck) this.killChild(stuck);
  }

  private async request(op: ProbeOperation, path: string): Promise<Answer> {
    if (this.closed) return UNREAD;
    const backedOff = this.backoff.get(path);
    if (backedOff) {
      // Not while the helper stuck on it is alive: the folder still hangs.
      if (this.now() < backedOff.until || this.stuck.has(backedOff.stuck))
        return UNREAD;
      this.backoff.delete(path);
    }
    if (!this.child && this.stuck.size >= this.maxStuckChildren) {
      // #3406 delta D2: no helper can be started, possibly for good on a dead
      // hard mount. Only folders under one the stuck helpers hung on stay
      // unread; any other folder reads as a missing folder does, by its path
      // as written and with no repository, never by its real path.
      this.noteStuckLimit();
      return this.underStuckFolder(path) ? UNREAD : null;
    }
    const child = this.ensureChild();
    if (!child || !(await child.ready) || this.child !== child) return UNREAD;
    const id = this.nextId++;
    return await new Promise((resolve) => {
      child.pending.set(id, { path, resolve });
      // Keep the process alive only while an answer is awaited.
      child.process.channel?.ref();
      this.armWatchdog(child);
      try {
        child.process.send({ id, op, path } satisfies ProbeRequest, (error) => {
          if (error) this.abandon(child);
        });
      } catch {
        this.abandon(child);
      }
    });
  }

  private ensureChild(): RunningChild | undefined {
    if (this.child) return this.child;
    if (this.now() < this.unavailableUntil) return undefined;
    if (this.closed || this.stuck.size >= this.maxStuckChildren)
      return undefined;
    let spawned: ChildProcess;
    try {
      // `spawn` with an IPC slot rather than `fork`: only spawn's options
      // carry `windowsHide`, which every process this server launches sets.
      spawned = spawn(
        process.execPath,
        [
          ...(this.childEntry.pathname.endsWith('.ts')
            ? ['--import', 'tsx']
            : []),
          fileURLToPath(this.childEntry),
        ],
        {
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          serialization: 'json',
          windowsHide: true,
          env: childEnv(),
        },
      );
    } catch {
      this.unavailableUntil = this.now() + this.backoffMs;
      return undefined;
    }
    // The channel keeps this process alive only while it waits for the
    // child: to start (here), or to answer (`request`).
    spawned.unref();
    trackForExit(spawned);
    this.onSpawn?.(spawned);
    const child: RunningChild = {
      process: spawned,
      pending: new Map(),
      ready: Promise.resolve(false),
      progress: 0,
    };
    let started = false;
    child.ready = new Promise<boolean>((settle) => {
      const timer = setTimeout(() => {
        logger.warn('Attached-session path reader did not start', {
          timeoutMs: this.startupTimeoutMs,
        });
        this.unavailableUntil = this.now() + this.backoffMs;
        this.abandon(child);
        settle(false);
      }, this.startupTimeoutMs);
      timer.unref();
      const done = (ready: boolean) => {
        clearTimeout(timer);
        started ||= ready;
        settle(ready);
      };
      spawned.on('message', (message: ProbeAnswer | null) => {
        if (typeof message !== 'object' || message === null) return;
        if ('ready' in message) {
          if (child.pending.size === 0) spawned.channel?.unref();
          done(true);
          return;
        }
        if (Number.isSafeInteger(message.id))
          this.settle(child, message.id, message.value);
      });
      // `on`, not `once`: an IPC send to a dying child can raise more than
      // one 'error', and an unheard one would crash the server.
      spawned.on('error', () => {
        if (!started) this.unavailableUntil = this.now() + this.backoffMs;
        this.abandon(child);
        done(false);
      });
      spawned.once('exit', () => {
        // A child that dies before it is ready would die again at once.
        if (!started) this.unavailableUntil = this.now() + this.backoffMs;
        this.abandon(child);
        this.stuck.delete(spawned);
        if (this.atStuckLimit && this.stuck.size < this.maxStuckChildren) {
          this.atStuckLimit = false;
          logger.info('Attached-session path reader can start again', {
            stuckHelpers: this.stuck.size,
          });
        }
        done(false);
      });
    });
    this.child = child;
    return child;
  }

  private settle(
    child: RunningChild,
    id: number,
    value: string | RepositoryLocation | null,
  ): void {
    const pending = child.pending.get(id);
    if (!pending) return;
    child.pending.delete(id);
    child.progress += 1;
    pending.resolve(value);
    // Progress: the deadline restarts for whatever is still waiting.
    if (child.watchdog) clearTimeout(child.watchdog);
    child.watchdog = undefined;
    if (child.pending.size > 0) this.armWatchdog(child);
    else child.process.channel?.unref();
  }

  private armWatchdog(child: RunningChild): void {
    if (child.watchdog) return;
    child.watchdog = setTimeout(() => {
      // A main thread that was itself blocked runs this expired timer before
      // it reads an answer that arrived in the meantime: timers come before
      // I/O in a loop turn. So look again after one I/O turn, and call it a
      // hang only if nothing was answered then either.
      const progress = child.progress;
      setImmediate(() => {
        if (child.progress !== progress || this.child !== child) return;
        child.watchdog = undefined;
        this.declareHung(child);
      });
    }, this.deadlineMs);
  }

  private noteStuckLimit(): void {
    if (this.atStuckLimit) return;
    this.atStuckLimit = true;
    logger.warn(
      'Attached-session path reader stopped: too many helpers are stuck on folders that do not answer',
      {
        stuckHelpers: this.stuck.size,
        stuckFolders: this.stuckFolders(),
      },
    );
  }

  /** The folders a still-alive stuck helper hung on. */
  private stuckFolders(): string[] {
    const folders: string[] = [];
    for (const [path, { stuck }] of this.backoff)
      if (this.stuck.has(stuck)) folders.push(path);
    return folders;
  }

  private underStuckFolder(path: string): boolean {
    return this.stuckFolders().some(
      (folder) => path === folder || path.startsWith(`${folder}${sep}`),
    );
  }

  private declareHung(child: RunningChild): void {
    // The child answers one request at a time, in order, so the oldest
    // unanswered folder is the one it is stuck on.
    const [stuck] = child.pending.values();
    if (stuck) {
      this.backoff.set(stuck.path, {
        until: this.now() + this.backoffMs,
        stuck: child.process,
      });
      logger.warn(
        'Attached-session folder did not answer; skipping it for a while',
        {
          path: stuck.path,
          deadlineMs: this.deadlineMs,
          backoffMs: this.backoffMs,
        },
      );
    }
    this.abandon(child);
  }

  /** Kills a child and answers everything it still owed as unread. */
  private abandon(child: RunningChild): void {
    if (this.child === child) this.child = undefined;
    if (child.watchdog) clearTimeout(child.watchdog);
    child.watchdog = undefined;
    const { process: helper } = child;
    if (helper.exitCode === null && helper.signalCode === null) {
      // Until its 'exit' is seen it counts as stuck: SIGKILL does not end a
      // process in an uninterruptible read.
      this.stuck.add(helper);
      this.killChild(helper);
    }
    const owed = [...child.pending.values()];
    child.pending.clear();
    for (const pending of owed) pending.resolve(UNREAD);
  }
}

/** Every helper this process started that has not exited, for `process.on('exit')`. */
const liveHelpers = new Set<ChildProcess>();

function trackForExit(helper: ChildProcess): void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // Synchronous, as an 'exit' listener must be: a helper stuck in a
    // syscall never sees the channel close, so it is killed here.
    process.on('exit', () => {
      for (const live of liveHelpers) killGroup(live);
    });
  }
  liveHelpers.add(helper);
  helper.once('exit', () => liveHelpers.delete(helper));
}

let exitHookInstalled = false;

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/**
 * Only what Node and `tsx` need. The child is handed absolute folders, so
 * it does not need the home directory, and the server's environment carries
 * provider keys and tokens it has no use for.
 */
const CHILD_ENV_KEYS = [
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'windir',
  'ComSpec',
  'PATHEXT',
] as const;

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

let shared: AttachedPathProbe | undefined;

/** The process's one probe, started on first use. */
export function sharedAttachedPathProbe(): AttachedPathProbe {
  shared ??= new AttachedPathProbe();
  return shared;
}

/**
 * Station shutdown (`runtime-shutdown.ts`): closes the shared probe, which a
 * poll still in flight may hold, and forgets it, so a runtime started later
 * in this process gets a new one.
 */
export function closeSharedAttachedPathProbe(): void {
  shared?.close();
  shared = undefined;
}
