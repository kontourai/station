/**
 * Running the device-host program over ssh (#1973).
 *
 * One ssh process per run, from the fixed argument vectors in
 * `ssh-device-target.ts`, launched through `spawnOwnedChild` (the orphan
 * registry reaps it if Station dies; `windowsHide`; detached, so ssh has no
 * controlling terminal to prompt on) with an allowlisted environment.
 *
 * stdin carries ONE header line — `{s: <program>, p: <params>}` — then any
 * payload (the install's files). stdout carries the program's JSON events;
 * stderr is OpenSSH's own diagnostics, read only to classify a failure and
 * never returned.
 */
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { DeviceSshHostFailure } from '@kontourai/station-contracts/mobile-device';
import { spawnOwnedChild } from '../../infra/process-utils.js';
import {
  REMOTE_DEVICE_HOST_SCRIPT,
  type RemoteDeviceHostParams,
} from './ssh-device-remote-script.js';
import {
  buildSshDeviceCommandArgs,
  classifySshDeviceFailure,
  type SshDeviceTarget,
  sshDeviceEnvironment,
} from './ssh-device-target.js';

/** The slice of an ssh child process Station drives. */
export interface SshChild {
  readonly pid: number | undefined;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  onError(listener: (error: Error) => void): void;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
  /** Remove the orphan-registry record once the child is gone. */
  release(): void;
}

export type SpawnSsh = (args: string[]) => SshChild;

export const spawnSystemSsh: SpawnSsh = (args) => {
  const { proc, release } = spawnOwnedChild('ssh', args, {
    env: sshDeviceEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    pid: proc.pid,
    stdin: proc.stdin,
    stdout: proc.stdout,
    stderr: proc.stderr,
    onExit: (listener) => {
      proc.once('exit', (code, signal) => listener(code, signal));
    },
    onError: (listener) => {
      proc.once('error', listener);
    },
    kill: (signal) => {
      try {
        proc.kill(signal);
      } catch {
        // Already gone.
      }
    },
    release,
  };
};

export class SshDeviceHostError extends Error {
  constructor(readonly failure: DeviceSshHostFailure) {
    super(`SSH device host: ${failure}`);
    this.name = 'SshDeviceHostError';
  }
}

const REMOTE_FAILURES: readonly DeviceSshHostFailure[] = [
  'unsupported-node',
  'hub-not-installed',
  'install-failed',
  'start-failed',
  'protocol',
];

/** The program's own typed failure, if an event names one it may send. */
export function remoteFailure(
  event: unknown,
): DeviceSshHostFailure | undefined {
  const value = event as { event?: unknown; failure?: unknown } | null;
  if (value?.event !== 'error') return undefined;
  return (
    REMOTE_FAILURES.find((failure) => failure === value.failure) ?? 'protocol'
  );
}

/** The header line: the program and its parameters, as data. */
export function remoteHeader(params: RemoteDeviceHostParams): string {
  return `${JSON.stringify({ s: REMOTE_DEVICE_HOST_SCRIPT, p: params })}\n`;
}

const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;

/**
 * Parse newline-delimited JSON events; anything else on stdout is ignored.
 *
 * Linear in what it reads (#2442 review L3): each chunk is searched for a
 * newline on its own, and the pieces of an unfinished line are joined once,
 * when its newline arrives — a multi-megabyte event read in 16 KB chunks is
 * never re-scanned or re-copied per chunk. An unfinished line past
 * `maxBytes` keeps only its tail (it can then never parse as an event).
 */
export function createEventReader(
  onEvent: (event: Record<string, unknown>) => void,
  maxBytes: number = MAX_STDOUT_BYTES,
): (chunk: Buffer | string) => void {
  const decoder = new StringDecoder('utf8');
  let pending: string[] = [];
  let pendingSize = 0;
  const emit = (line: string) => {
    const text = line.trim();
    if (!text.startsWith('{')) return;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        onEvent(parsed as Record<string, unknown>);
    } catch {
      // Not an event.
    }
  };
  return (chunk) => {
    let text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let newline = text.indexOf('\n');
    while (newline !== -1) {
      pending.push(text.slice(0, newline));
      const line = pending.join('');
      pending = [];
      pendingSize = 0;
      emit(line);
      text = text.slice(newline + 1);
      newline = text.indexOf('\n');
    }
    if (text === '') return;
    pending.push(text);
    pendingSize += text.length;
    if (pendingSize > maxBytes) {
      const tail = pending.join('').slice(-maxBytes);
      pending = [tail];
      pendingSize = tail.length;
    }
  };
}

export interface SshScriptRun {
  events: Record<string, unknown>[];
  exitCode: number | null;
  /** Classified from OpenSSH's stderr when the run failed before an event. */
  failure?: DeviceSshHostFailure;
  /** stdout passed `maxStdoutBytes`: the run was killed (#2442). */
  overflow?: true;
}

/**
 * Run the program once to completion: header, optional payload writer, then
 * stdin closes. Resolves with every event; a transport failure is typed.
 */
export function runSshDeviceScript(input: {
  target: SshDeviceTarget;
  params: RemoteDeviceHostParams;
  spawn?: SpawnSsh;
  /** Writes the payload after the header; stdin is closed when it resolves. */
  payload?: (stdin: Writable) => Promise<void>;
  timeoutMs: number;
  /** Aborting kills the ssh child at once (a cancelled install, M3). */
  signal?: AbortSignal;
  /**
   * The most stdout the run may print (default 64 KB, events then keep only
   * the tail). Past an explicit bound the ssh child is killed and the run
   * ends `overflow` — a tool's output is never read unbounded (#2442).
   */
  maxStdoutBytes?: number;
  /**
   * Keep stdin open until the run ends, instead of closing it after the
   * header (#2442 review M1): the program's `tool` mode takes stdin closing
   * as "Station gave up" and stops, so killing this ssh child also stops the
   * run on the host rather than leaving it to finish.
   */
  holdStdin?: boolean;
}): Promise<SshScriptRun> {
  const spawnSsh = input.spawn ?? spawnSystemSsh;
  return new Promise((resolve) => {
    const events: Record<string, unknown>[] = [];
    let stderr = '';
    let settled = false;
    let child: SshChild;
    try {
      child = spawnSsh(buildSshDeviceCommandArgs(input.target));
    } catch {
      resolve({ events, exitCode: null, failure: 'ssh-unavailable' });
      return;
    }
    const finish = (result: SshScriptRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      if (input.holdStdin)
        try {
          child.stdin?.end();
        } catch {
          // Already closed.
        }
      child.release();
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ events, exitCode: null, failure: 'timeout' });
    }, input.timeoutMs);
    // A deadline never keeps the process alive on its own (L-e).
    timer.unref?.();
    const onAbort = () => {
      child.kill('SIGKILL');
      finish({ events, exitCode: null, failure: 'install-failed' });
    };
    if (input.signal?.aborted) onAbort();
    input.signal?.addEventListener('abort', onAbort, { once: true });
    const maxStdout = input.maxStdoutBytes;
    const readEvents = createEventReader(
      (event) => events.push(event),
      maxStdout ?? MAX_STDOUT_BYTES,
    );
    let stdoutBytes = 0;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (maxStdout !== undefined && stdoutBytes > maxStdout) {
        child.kill('SIGKILL');
        finish({ events, exitCode: null, overflow: true });
        return;
      }
      readEvents(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-MAX_STDERR_BYTES);
    });
    child.onError(() =>
      finish({ events, exitCode: null, failure: 'ssh-unavailable' }),
    );
    child.onExit((code) => {
      // Let buffered stdout drain before judging the run.
      setImmediate(() => {
        const reported = events.find((event) => event.event === 'error');
        if (reported) {
          finish({ events, exitCode: code, failure: remoteFailure(reported) });
          return;
        }
        if (code === 0 || events.length > 0) {
          finish({ events, exitCode: code });
          return;
        }
        finish({
          events,
          exitCode: code,
          failure: classifySshDeviceFailure({ stderr, exitCode: code }),
        });
      });
    });
    const stdin = child.stdin;
    if (!stdin) {
      child.kill('SIGKILL');
      finish({ events, exitCode: null, failure: 'ssh-unavailable' });
      return;
    }
    stdin.on('error', () => {
      // The remote end closed early; the exit handler reports why.
    });
    stdin.write(remoteHeader(input.params));
    void (async () => {
      try {
        if (input.payload) await input.payload(stdin);
      } catch {
        child.kill('SIGKILL');
      } finally {
        if (!input.holdStdin) stdin.end();
      }
    })();
  });
}
