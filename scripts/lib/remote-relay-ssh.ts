/**
 * Local SSH owner for Mac Chromium -> isolated Linux Station/Pion acceptance.
 * TEST FIXTURE ONLY (scripts/): owns the local `ssh` child processes that
 * carry encrypted DTLS/TURN bytes and fixture-operator control. SSH never
 * carries plaintext browser application frames and this module makes no
 * global SSH/network changes.
 *
 * Two owners:
 * - startRemoteRelayForwards: `ssh -T -N -v` with two `-R 0:127.0.0.1:port`
 *   mappings (Mac broker + TURN) and one `-L` loopback mapping for the
 *   fixture operator control ONLY. The browser is blocked from controlOrigin.
 * - startRemoteRelayProcess: `ssh -T <host> <remote command>` that runs the
 *   remote supervisor; stdin is KEPT OPEN so stop() ends it first and the
 *   remote supervisor gracefully joins Station/Pion while forwards stay alive.
 *
 * Every spawn uses `windowsHide: true` and the owned-process helpers with
 * bounded capture and joined cleanup. Never calls process.exit.
 */
import { spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import {
  captureOwnedProcessOutput,
  executeOwnedCommand,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from './owned-process.mjs';

const READINESS_TIMEOUT_MS = 30_000;
const READINESS_MAX_BYTES = 64 * 1024;
const GRACE_MS = 5_000;
const FORCE_MS = 5_000;
const EXIT_GRACE_MS = 15_000;

function assertPort(value: unknown, code: string): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 65535
  ) {
    throw new Error(code);
  }
}

function assertHost(host: unknown, code: string): asserts host is string {
  if (
    typeof host !== 'string' ||
    !host ||
    host.includes('\0') ||
    host.includes('\n')
  ) {
    throw new Error(code);
  }
  // No option injection: host must not look like an ssh flag or carry spaces.
  if (
    host.startsWith('-') ||
    /[\s]/.test(host) ||
    !/^[A-Za-z0-9._@:-]+$/.test(host)
  ) {
    throw new Error(code);
  }
}

function quotePath(value: string, code: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\0') ||
    /[\r\n]/.test(value)
  ) {
    throw new Error(code);
  }
  if (!isAbsolute(value)) throw new Error(code);
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface OwnedHandle {
  stop: () => Promise<void>;
}

function memoizedStop(stop: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => (pending ??= Promise.resolve().then(stop));
}

export interface RemoteRelayForwardsInput {
  host: string;
  brokerPort: number;
  turnPort: number;
  remoteStationPort: number;
  localControlPort: number;
  directory: string;
  signal: AbortSignal;
}

export interface RemoteRelayForwards extends OwnedHandle {
  brokerOrigin: string;
  turnPort: number;
  controlOrigin: string;
}

/** Own the `ssh -N` forward set. Requires two exact allocated-port mappings. */
export async function startRemoteRelayForwards(
  input: RemoteRelayForwardsInput,
): Promise<RemoteRelayForwards> {
  input.signal.throwIfAborted();
  assertHost(input.host, 'remote_relay_host_invalid');
  assertPort(input.brokerPort, 'remote_relay_port_invalid');
  assertPort(input.turnPort, 'remote_relay_port_invalid');
  assertPort(input.remoteStationPort, 'remote_relay_port_invalid');
  assertPort(input.localControlPort, 'remote_relay_port_invalid');
  if (
    input.brokerPort === input.turnPort ||
    [3000, 3141].includes(input.localControlPort) ||
    [3000, 3141].includes(input.remoteStationPort)
  )
    throw new Error('remote_relay_port_invalid');
  if (typeof input.directory !== 'string' || !input.directory) {
    throw new Error('remote_relay_directory_invalid');
  }
  const args = [
    '-T',
    '-N',
    '-v',
    '-o',
    'BatchMode=yes',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-R',
    `127.0.0.1:0:127.0.0.1:${input.brokerPort}`,
    '-R',
    `127.0.0.1:0:127.0.0.1:${input.turnPort}`,
    '-L',
    `127.0.0.1:${input.localControlPort}:127.0.0.1:${input.remoteStationPort}`,
    input.host,
  ];
  const execution = executeOwnedCommand(
    'ssh',
    args,
    spawn,
    'remote relay ssh forwards',
    {
      cwd: input.directory,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  const capture = captureOwnedProcessOutput(execution, {
    maxBytes: READINESS_MAX_BYTES,
  });
  const stop = memoizedStop(async () => {
    const errors: unknown[] = [];
    try {
      const result = await terminateSuiteExecution(execution, {
        waitForSuiteSettlement,
        terminationGraceMs: GRACE_MS,
        terminationForceMs: FORCE_MS,
        processLabel: 'remote relay ssh forwards',
      });
      if (!result.settled || result.errors.length) {
        throw new Error('remote_relay_forwards_cleanup_unconfirmed');
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      const output = capture.finish();
      if (output.truncated || output.invalidUtf8)
        throw new Error('remote_relay_output_invalid');
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(errors, 'remote_relay_forwards_cleanup_failed');
  });
  try {
    const stdout =
      'stdout' in execution.child ? execution.child.stdout : undefined;
    const stderr =
      'stderr' in execution.child ? execution.child.stderr : undefined;
    if (!stderr) throw new Error('remote_relay_forward_stream_unavailable');
    void stdout;
    const found = await new Promise<Map<number, number>>(
      (resolveReady, rejectReady) => {
        const targets = new Map<number, number>();
        let text = '';
        let finished = false;
        const finish = (error?: unknown, value?: Map<number, number>): void => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          stderr.off('data', onData);
          input.signal.removeEventListener('abort', onAbort);
          if (error) rejectReady(error);
          else resolveReady(value as Map<number, number>);
        };
        const onAbort = (): void => {
          finish(
            input.signal.reason ??
              new Error('remote_relay_forward_startup_aborted'),
          );
        };
        const onData = (chunk: Buffer): void => {
          text += chunk.toString('utf8');
          if (Buffer.byteLength(text) > READINESS_MAX_BYTES) {
            finish(new Error('remote_relay_forward_readiness_overflow'));
            return;
          }
          const re =
            /Allocated port (\d+) for remote forward to 127\.0\.0\.1:(\d+)/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(text)) !== null) {
            const allocated = Number(m[1]);
            const target = Number(m[2]);
            if (
              !Number.isSafeInteger(allocated) ||
              allocated < 1 ||
              allocated > 65535
            ) {
              finish(new Error('remote_relay_forward_readiness_invalid'));
              return;
            }
            if (
              ![input.brokerPort, input.turnPort].includes(target) ||
              [3000, 3141].includes(allocated) ||
              (targets.has(target) && targets.get(target) !== allocated)
            ) {
              finish(new Error('remote_relay_forward_readiness_invalid'));
              return;
            }
            targets.set(target, allocated);
          }
          if (
            targets.has(input.brokerPort) &&
            targets.has(input.turnPort) &&
            // Require the two exact expected mappings, each observed once.
            (targets.get(input.brokerPort) !== targets.get(input.turnPort) ||
              input.brokerPort === input.turnPort)
          ) {
            // When broker and TURN share one target port both mappings coincide;
            // otherwise allocated ends must differ so frames cannot cross.
            if (input.brokerPort !== input.turnPort && targets.size >= 2) {
              finish(undefined, targets);
            } else if (input.brokerPort === input.turnPort) {
              finish(undefined, targets);
            }
          }
        };
        const timer = setTimeout(
          () => finish(new Error('remote_relay_forward_startup_timeout')),
          READINESS_TIMEOUT_MS,
        );
        timer.unref?.();
        stderr.on('data', onData);
        input.signal.addEventListener('abort', onAbort, { once: true });
        if (input.signal.aborted) onAbort();
        void execution.completion.then(
          () => finish(new Error('remote_relay_forward_exited_before_ready')),
          finish,
        );
      },
    );
    const brokerRemote = found.get(input.brokerPort) as number;
    const turnRemote = found.get(input.turnPort) as number;
    return {
      brokerOrigin: `http://127.0.0.1:${brokerRemote}`,
      turnPort: turnRemote,
      controlOrigin: `http://127.0.0.1:${input.localControlPort}`,
      stop,
    };
  } catch (primary) {
    try {
      await stop();
    } catch (cleanup) {
      throw new AggregateError(
        [primary, cleanup],
        'remote_relay_forward_startup_failed',
      );
    }
    throw primary;
  }
}

export interface RemoteRelayProcessInput {
  host: string;
  checkout: string;
  nodeExecutable: string;
  configPath: string;
  directory: string;
  signal: AbortSignal;
}

export interface RemoteRelayProcess extends OwnedHandle {
  port: number;
  stationId: string;
  supervisorPid: number;
  provenance: Record<string, unknown>;
}

/** Own the remote supervisor over SSH. stdin stays open until stop(). */
export async function startRemoteRelayProcess(
  input: RemoteRelayProcessInput,
): Promise<RemoteRelayProcess> {
  input.signal.throwIfAborted();
  assertHost(input.host, 'remote_relay_host_invalid');
  if (typeof input.directory !== 'string' || !input.directory) {
    throw new Error('remote_relay_directory_invalid');
  }
  const checkout = quotePath(input.checkout, 'remote_relay_path_invalid');
  const nodeExecutable = quotePath(
    input.nodeExecutable,
    'remote_relay_path_invalid',
  );
  const configPath = quotePath(input.configPath, 'remote_relay_path_invalid');
  const relayScript = quotePath(
    join(input.checkout, 'scripts', 'lib', 'remote-relay-station.ts'),
    'remote_relay_path_invalid',
  );
  const remoteCommand = `cd -- ${checkout} && exec ${nodeExecutable} --import tsx ${relayScript} run ${configPath}`;
  const execution = executeOwnedCommand(
    'ssh',
    [
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPath=none',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      input.host,
      remoteCommand,
    ],
    spawn,
    'remote relay ssh process',
    {
      cwd: input.directory,
      env: { ...process.env },
      // stdin PIPE KEPT OPEN: stop() ends it first for graceful remote join.
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  const capture = captureOwnedProcessOutput(execution, {
    maxBytes: READINESS_MAX_BYTES,
  });
  let ready: Omit<RemoteRelayProcess, 'stop'> | undefined;
  let readySettled = false;
  const stop = memoizedStop(async () => {
    const errors: unknown[] = [];
    try {
      // FIRST end stdin so the remote supervisor gracefully joins
      // Station/Pion and withdraws while forwards remain alive.
      try {
        const stdin = (
          execution.child as {
            stdin?: { end: (cb?: () => void) => void; destroy: () => void };
          }
        ).stdin;
        await new Promise<void>((resolve) => {
          if (!stdin) {
            resolve();
            return;
          }
          const timer = setTimeout(resolve, GRACE_MS);
          timer.unref?.();
          try {
            stdin.end(() => {
              clearTimeout(timer);
              resolve();
            });
          } catch {
            clearTimeout(timer);
            resolve();
          }
        });
      } catch (error) {
        errors.push(error);
      }
      let exitTimer: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        execution.completion,
        new Promise<null>((resolve) => {
          exitTimer = setTimeout(() => resolve(null), EXIT_GRACE_MS);
        }),
      ]).finally(() => clearTimeout(exitTimer));
      if (settled === null) {
        try {
          const result = await terminateSuiteExecution(execution, {
            waitForSuiteSettlement,
            terminationGraceMs: GRACE_MS,
            terminationForceMs: FORCE_MS,
            processLabel: 'remote relay ssh process',
          });
          if (!result.settled || result.errors.length) {
            throw new Error('remote_relay_remote_cleanup_unconfirmed');
          }
        } catch (error) {
          errors.push(error);
        }
        errors.push(new Error('remote_relay_remote_cleanup_unconfirmed'));
      } else if (
        settled === undefined ||
        (typeof settled === 'object' &&
          settled !== null &&
          ((settled as { status?: number | null }).status !== 0 ||
            (settled as { error?: unknown }).error !== undefined))
      ) {
        errors.push(new Error('remote_relay_remote_cleanup_unconfirmed'));
        try {
          const retired = await terminateSuiteExecution(execution, {
            waitForSuiteSettlement,
            terminationGraceMs: GRACE_MS,
            terminationForceMs: FORCE_MS,
            processLabel: 'remote relay ssh process',
          });
          if (!retired.settled || retired.errors.length)
            throw new Error('remote_relay_remote_cleanup_unconfirmed');
        } catch (error) {
          errors.push(error);
        }
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      const output = capture.finish();
      if (output.truncated || output.invalidUtf8)
        throw new Error('remote_relay_output_invalid');
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(errors, 'remote_relay_process_cleanup_failed');
  });
  try {
    const stdout =
      'stdout' in execution.child ? execution.child.stdout : undefined;
    if (!stdout) throw new Error('remote_relay_process_stream_unavailable');
    ready = await new Promise<Omit<RemoteRelayProcess, 'stop'>>(
      (resolveReady, rejectReady) => {
        let text = '';
        let finished = false;
        const finish = (
          error?: unknown,
          value?: Omit<RemoteRelayProcess, 'stop'>,
        ): void => {
          if (finished || readySettled) return;
          finished = true;
          readySettled = true;
          clearTimeout(timer);
          stdout.off('data', onData);
          input.signal.removeEventListener('abort', onAbort);
          if (error) rejectReady(error);
          else resolveReady(value as Omit<RemoteRelayProcess, 'stop'>);
        };
        const onAbort = (): void => {
          finish(
            input.signal.reason ??
              new Error('remote_relay_process_startup_aborted'),
          );
        };
        const onData = (chunk: Buffer): void => {
          text += chunk.toString('utf8');
          if (Buffer.byteLength(text) > READINESS_MAX_BYTES) {
            finish(new Error('remote_relay_readiness_overflow'));
            return;
          }
          const lines = text.split('\n');
          text = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.includes('"remote-relay-ready"')) continue;
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(line) as Record<string, unknown>;
            } catch {
              finish(new Error('remote_relay_readiness_invalid'));
              return;
            }
            if (parsed['event'] !== 'remote-relay-ready') continue;
            const port = parsed['port'];
            const stationId = parsed['stationId'];
            const supervisorPid = parsed['supervisorPid'];
            if (
              !Number.isSafeInteger(port) ||
              (port as number) < 1 ||
              (port as number) > 65535 ||
              typeof stationId !== 'string' ||
              !stationId ||
              !Number.isSafeInteger(supervisorPid) ||
              (supervisorPid as number) < 1
            ) {
              finish(new Error('remote_relay_readiness_invalid'));
              return;
            }
            const {
              event: _event,
              port: _p,
              stationId: _s,
              supervisorPid: _pid,
              ...provenance
            } = parsed;
            void _event;
            void _p;
            void _s;
            void _pid;
            finish(undefined, {
              port: port as number,
              stationId: stationId as string,
              supervisorPid: supervisorPid as number,
              provenance,
            });
            return;
          }
        };
        const timer = setTimeout(
          () => finish(new Error('remote_relay_process_startup_timeout')),
          READINESS_TIMEOUT_MS,
        );
        timer.unref?.();
        stdout.on('data', onData);
        input.signal.addEventListener('abort', onAbort, { once: true });
        if (input.signal.aborted) onAbort();
        void execution.completion.then(
          () => finish(new Error('remote_relay_process_exited_before_ready')),
          finish,
        );
      },
    );
    return { ...(ready as Omit<RemoteRelayProcess, 'stop'>), stop };
  } catch (primary) {
    try {
      await stop();
    } catch (cleanup) {
      throw new AggregateError(
        [primary, cleanup],
        'remote_relay_process_startup_failed',
      );
    }
    throw primary;
  }
}
