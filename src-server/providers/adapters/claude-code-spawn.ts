import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type {
  SpawnedProcess,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import { redactSecrets } from '@kontourai/station-shared/redaction';
import {
  ClaudePermissionAsks,
  ClaudePermissionFrameTap,
  noteClaudeHostFrame,
} from './claude-permission-frames.js';

/** Characters of stderr kept for an exit error (the SDK's own bound). */
const STDERR_TAIL_LENGTH = 2048;
/** How long an exit waits for stderr to close (the SDK's own grace). */
const STDERR_DRAIN_GRACE_MS = 200;
/** Delivered to `exit` listeners once stderr has drained. */
const EXIT_AFTER_STDERR_DRAINED = 'station-exit-after-stderr-drained';

type SpawnChild = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof nodeSpawn>[2],
) => ChildProcess;

/** The engine process of one Claude session and what Station reads from it. */
export type ClaudeEngineProcess = {
  /** The permission asks read from the engine's stdout (#2932). */
  asks: ClaudePermissionAsks;
  /** The SDK's `spawnClaudeCodeProcess` option. */
  spawn: (options: SpawnOptions) => SpawnedProcess;
  /** The redacted end of the engine's stderr, empty when it wrote none. */
  stderrTail: () => string;
};

function tailOf(text: string): string {
  if (text.length <= STDERR_TAIL_LENGTH) return text;
  const tail = text.slice(-STDERR_TAIL_LENGTH);
  const first = tail.charCodeAt(0);
  // Never start on the low half of a surrogate pair.
  return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
}

/**
 * #2932: owns the Claude CLI spawn so Station can read the permission asks
 * on its stdout. Agent SDK 0.3.278 reads `stdout` from whatever its
 * `spawnClaudeCodeProcess` option returns, and gives a custom spawner none
 * of its default handling. This reproduces that default
 * (`ProcessTransport.spawnLocalProcess`), with stdout piped through
 * {@link ClaudePermissionFrameTap}:
 *
 * - the same `spawn` call: piped stdio, the SDK's forwarded abort signal, the
 *   env as given, no shell, `windowsHide: true`;
 * - `exit` reaches listeners only after stderr has closed, or 200 ms after
 *   the process exit, and stderr is then unreferenced;
 * - `kill`, `killed`, `exitCode`, `signalCode` and `stdin` are the child's
 *   own. Writes to stdin are observed, never changed.
 *
 * One thing cannot be reproduced. The SDK appends its own stderr tail to the
 * exit error it builds, and that tail is private to its transport, so with a
 * custom spawner the error carries none. The tail is kept here instead, and
 * {@link claudeExitDetailWithStderr} appends it where Station reports the
 * error. The SDK also adds its `--debug-file` argument only for its own
 * spawn; that applies when SDK debug logging is on.
 */
export function createClaudeEngineProcess(
  spawnChild: SpawnChild = nodeSpawn,
): ClaudeEngineProcess {
  const asks = new ClaudePermissionAsks();
  let stderrTail = '';

  const spawn = (options: SpawnOptions): SpawnedProcess => {
    const child = spawnChild(options.command, options.args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: options.signal,
      env: options.env,
      windowsHide: true,
    });
    const { stdin, stdout, stderr } = child;
    if (!stdin || !stdout || !stderr)
      throw new Error('Claude Code process was spawned without piped stdio.');

    // The SDK keeps the child's own stdin; its writes are only observed, to
    // learn which response answers `initialize` (it carries replayed asks).
    const writeToStdin = stdin.write.bind(stdin) as (
      ...args: unknown[]
    ) => boolean;
    stdin.write = ((...args: unknown[]) => {
      noteClaudeHostFrame(asks, args[0]);
      return writeToStdin(...args);
    }) as typeof stdin.write;

    const tap = new ClaudePermissionFrameTap(asks);
    stdout.pipe(tap);
    // `pipe` forwards no errors; the SDK's reader must still see one.
    stdout.on('error', (error) => tap.destroy(error));

    stderrTail = '';
    const decoder = new StringDecoder('utf8');
    let stderrClosed = false;
    let exited = false;
    let delivered = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    stderr.on('data', (chunk: Buffer) => {
      if (delivered) return;
      stderrTail += decoder.write(chunk);
      if (stderrTail.length > 2 * STDERR_TAIL_LENGTH)
        stderrTail = tailOf(stderrTail);
    });
    stderr.on('error', () => undefined);
    const deliverExit = () => {
      if (delivered) return;
      delivered = true;
      if (graceTimer) clearTimeout(graceTimer);
      child.emit(EXIT_AFTER_STDERR_DRAINED, child.exitCode, child.signalCode);
      const socket = stderr as { unref?: () => void };
      if (typeof socket.unref === 'function') socket.unref();
      else stderr.destroy();
    };
    stderr.once('close', () => {
      stderrTail += decoder.end();
      stderrClosed = true;
      if (exited) deliverExit();
    });
    child.once('exit', () => {
      exited = true;
      if (stderrClosed) deliverExit();
      else graceTimer = setTimeout(deliverExit, STDERR_DRAIN_GRACE_MS);
    });

    const eventName = (event: 'exit' | 'error') =>
      event === 'exit' ? EXIT_AFTER_STDERR_DRAINED : event;
    type Listener = (...args: never[]) => void;
    return {
      stdin,
      stdout: tap,
      get killed() {
        return child.killed;
      },
      get exitCode() {
        return child.exitCode;
      },
      get signalCode() {
        return child.signalCode;
      },
      kill: child.kill.bind(child),
      on: (event: 'exit' | 'error', listener: Listener) => {
        child.on(eventName(event), listener as (...args: unknown[]) => void);
      },
      once: (event: 'exit' | 'error', listener: Listener) => {
        child.once(eventName(event), listener as (...args: unknown[]) => void);
      },
      off: (event: 'exit' | 'error', listener: Listener) => {
        child.off(eventName(event), listener as (...args: unknown[]) => void);
      },
    };
  };

  return {
    asks,
    spawn,
    stderrTail: () => tailOf(redactSecrets(stderrTail)).trim(),
  };
}

/** The SDK's exit errors, as it words them without a stderr tail. */
const CLAUDE_EXIT_WITHOUT_STDERR =
  /^Claude Code process (?:exited with code \S+|terminated by signal \S+)$/;

/**
 * The SDK's exit error text with the engine's stderr tail appended the way
 * the SDK's own spawn words it (`. stderr: <tail>`). Any other text, and an
 * exit with no stderr, is returned unchanged.
 */
export function claudeExitDetailWithStderr(
  detail: string,
  stderrTail: string | undefined,
): string {
  return stderrTail && CLAUDE_EXIT_WITHOUT_STDERR.test(detail)
    ? `${detail}. stderr: ${stderrTail}`
    : detail;
}
