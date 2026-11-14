import { errorMessage } from '../../utils/error-message.js';
import { ACPCommandNotFoundError } from './acp-process.js';

/**
 * Why an engine check failed, as people read it: the setup dialog, the
 * engine card and Retry check show `lastError.message`. Names the engine,
 * says what happened in plain words, and never says "ACP" (the protocol is
 * not a user concept). The raw error stays in the server log.
 */
export function engineFacingProbeMessage(
  error: unknown,
  engine: { name: string; command: string },
  /**
   * The last line the engine wrote to stderr before it stopped. An engine
   * that refuses to start (Kiro CLI signed out: "Not logged in. … run
   * `kiro-cli login` first.") says why only there, so a closed connection
   * quotes it rather than leaving the person to guess.
   */
  lastStderrLine?: string,
): string {
  if (error instanceof ACPCommandNotFoundError) return error.message;
  const { budgetMs, code, syscall } = (error ?? {}) as {
    budgetMs?: unknown;
    code?: unknown;
    syscall?: unknown;
  };
  if (typeof budgetMs === 'number') {
    return `${engine.name} didn't answer within ${waitPhrase(budgetMs)}.`;
  }
  const spawnFailed =
    typeof syscall === 'string' && syscall.startsWith('spawn');
  if (spawnFailed && code === 'ENOENT') {
    return new ACPCommandNotFoundError(engine.command).message;
  }
  if (spawnFailed && code === 'EACCES') {
    return `Station could not run ${engine.command}: it is not executable on the computer Station runs on. Make it executable, then check the engine again.`;
  }
  const message = errorMessage(error);
  if (message === 'ACP connection closed') {
    return lastStderrLine
      ? `${engine.name} stopped before it finished starting. It said: ${lastStderrLine}`
      : `${engine.name} closed the connection before it finished starting.`;
  }
  return /\bACP\b/.test(message)
    ? `${engine.name}: ${message.replace(/\bACP\b\s*/g, '')}`
    : message;
}

function waitPhrase(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return minutes === 1 ? 'a minute' : `${minutes} minutes`;
  }
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds === 1 ? '1 second' : `${seconds} seconds`;
}

const ANSI_ESCAPE_SEQUENCE = new RegExp(
  `${String.fromCharCode(0x1b)}(?:\\[[0-?]*[ -/]*[@-~]|[@-_][0-?]*[ -/]*[@-~])`,
  'g',
);
/** How long a startup failure waits for the engine's stderr to end. */
export const STDERR_SETTLE_MS = 500;
/** Longest stderr line quoted in a probe message. */
const STDERR_LINE_MAX = 300;
/** Bytes of trailing stderr kept per probe run. */
const STDERR_TAIL_MAX = 4096;

/**
 * Keeps the tail of an engine's stderr so a startup failure can quote the
 * engine's own last words. Bounded: only the trailing {@link STDERR_TAIL_MAX}
 * characters are kept, and the quoted line is cut to {@link STDERR_LINE_MAX}.
 */
export function createStderrTail(): {
  push: (chunk: string) => void;
  /** Marks the stream ended; pass as `ACPProcessOptions.onStderrEnd`. */
  end: () => void;
  /**
   * Resolves once stderr has ended or `maxMs` has passed. A closed stdout and
   * the last stderr chunk arrive on separate pipes in no fixed order, so a
   * failure waits for this before quoting.
   */
  settled: (maxMs: number) => Promise<void>;
  lastLine: () => string | undefined;
} {
  let tail = '';
  let ended = false;
  const waiters = new Set<() => void>();
  return {
    push(chunk) {
      tail = (tail + chunk).slice(-STDERR_TAIL_MAX);
    },
    end() {
      ended = true;
      for (const wake of waiters) wake();
      waiters.clear();
    },
    settled(maxMs) {
      if (ended) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(done, maxMs);
        function done() {
          clearTimeout(timer);
          waiters.delete(done);
          resolve();
        }
        waiters.add(done);
      });
    },
    lastLine() {
      const lines = tail
        // A CLI's error is often styled; quote the text, not the escapes.
        .replace(ANSI_ESCAPE_SEQUENCE, '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const last = lines.at(-1);
      if (!last) return undefined;
      return last.length > STDERR_LINE_MAX
        ? `${last.slice(0, STDERR_LINE_MAX - 1)}…`
        : last;
    },
  };
}
