/**
 * Wires the generation manager, the control channel, and real child
 * processes into one supervisor process.
 */
import { type ChildProcess, fork, type SendHandle } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import packageJson from '../package.json' with { type: 'json' };
import { createNetCatcher } from './catcher.ts';
import { ControlServer } from './control-server.ts';
import { createEntryBoundary } from './entry-boundary.ts';
import {
  type Clock,
  type GenerationLauncher,
  GenerationManager,
  type GenerationManagerOptions,
  systemClock,
} from './generation-manager.ts';
import {
  GenerationRegistry,
  reapStaleGenerations,
} from './generation-registry.ts';
import {
  acquireInstanceLock,
  breakLockCommandFor,
  collectOlderEpochs,
  type InstanceLock,
  releaseInstanceLock,
  SupervisorStartError,
  stillHolds,
} from './instance-lock.ts';
import { ensurePrivateDir } from './private-dir.ts';
import {
  type ControlEndpoint,
  SUPERVISOR_ENV,
  SUPERVISOR_PROTOCOL,
  type SupervisorEvent,
} from './protocol.ts';
import { startSelfCheck } from './self-check.ts';

export const SUPERVISOR_VERSION: string = packageJson.version;

export interface SupervisorOptions {
  /** The initial core entry; must already be inside `buildRoot`. */
  entry: string;
  /** How long an empty or half-written lock file counts as live. */
  lockPendingGraceMs?: number;
  /** How often the holder re-confirms its lock epoch and socket. */
  selfCheckIntervalMs?: number;
  /** Timers for the self-check and generation manager; tests inject one. */
  clock?: Clock;
  /** Install process signal, exit, and fatal-error handlers (false when embedded). */
  processHooks?: boolean;
  /** Every entry a handoff names must be a .js/.mjs file inside this directory. */
  buildRoot: string;
  endpoint: ControlEndpoint;
  /** The Station home this supervisor serves; its run directory is a sibling. */
  home: string;
  instance: string;
  handoff?: GenerationManagerOptions['handoff'];
  restart?: GenerationManagerOptions['restart'];
  log?: (message: string) => void;
  /** Called with the process exit code once the supervisor has shut down. */
  exit?: (code: number) => void;
}

/** Set by other Station supervisors (Desktop, `service run`) on their child. */
const INHERITED_SUPERVISOR_BIRTH_ENV = 'STATION_SUPERVISOR_BIRTH';
/**
 * Spares per held listener the supervisor listens on during a Windows
 * handoff. A listener received over IPC keeps a single accept posted, so each
 * spare adds one. On a Windows host, under 16 concurrent fresh-connection
 * clients, one spare still left a reset in a third of handoffs; eight left
 * none in 700 handoffs.
 */
export const CATCH_SPARES = 8;

/**
 * Whether handoffs catch connections: on Windows only, the one platform that
 * resets a connection completed into a closing listener's accept. Tests set
 * STATION_SUPERVISOR_TEST_CATCH_CONNECTIONS to 1 or 0 to run the same code
 * on any platform, or to turn it off.
 */
function catchesConnections(): boolean {
  const forced = process.env.STATION_SUPERVISOR_TEST_CATCH_CONNECTIONS;
  if (forced === '1') return true;
  if (forced === '0') return false;
  return process.platform === 'win32';
}

/** Signals a generation and, on POSIX, every process in its group. */
function killTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Not a group leader (or already gone): signal the process alone.
    }
  }
  child.kill(signal);
}

/** Forks core generations on the Node IPC channel; tracks them for exit cleanup. */
function createForkLauncher(options: {
  log: (message: string) => void;
  children: Set<ChildProcess>;
  registry: GenerationRegistry;
}): GenerationLauncher {
  return {
    launch({ entry, generation }) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        [SUPERVISOR_ENV.ipc]: '1',
        [SUPERVISOR_ENV.pid]: String(process.pid),
        [SUPERVISOR_ENV.generation]: String(generation),
      };
      // A birth fingerprint inherited from whatever started this supervisor
      // names that process, not this one; a core comparing it against its
      // parent would conclude its supervisor is gone.
      delete env[INHERITED_SUPERVISOR_BIRTH_ENV];
      const child = fork(entry, [], {
        env,
        // The supervisor's own Node flags are not the core's.
        execArgv: [],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        serialization: 'json',
        windowsHide: true,
        // POSIX: each generation leads its own process group, so stopping or
        // reaping it reaches the processes it started. Not on Windows: there a
        // non-detached child dies with the supervisor, which is the orphan
        // protection the design relies on.
        detached: process.platform !== 'win32',
      });
      options.children.add(child);
      const running = () =>
        child.exitCode === null && child.signalCode === null;
      if (child.pid !== undefined) {
        const pid = child.pid;
        void options.registry.record(pid, generation, running);
        child.on('exit', () => options.registry.remove(pid));
      }
      child.on('exit', () => options.children.delete(child));
      child.on('error', (error) =>
        options.log(`generation ${generation} process error: ${String(error)}`),
      );
      return {
        get pid() {
          return child.pid ?? null;
        },
        send(message, handle) {
          if (!child.connected) return;
          child.send(message, handle as SendHandle | undefined, (error) => {
            if (error)
              options.log(
                `send to generation ${generation} failed: ${String(error)}`,
              );
          });
        },
        kill(signal) {
          if (child.exitCode === null && child.signalCode === null) {
            killTree(child, signal);
          }
        },
        onMessage(listener) {
          child.on('message', (message, handle) => listener(message, handle));
        },
        onExit(listener) {
          child.on('exit', (code, signal) => listener(code, signal));
        },
      };
    },
  };
}

export async function runSupervisor(options: SupervisorOptions): Promise<void> {
  const log =
    options.log ??
    ((message: string) =>
      process.stderr.write(
        `[station-supervisor] ${new Date().toISOString()} ${message}\n`,
      ));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const children = new Set<ChildProcess>();
  const registryPath = join(
    dirname(options.endpoint.tokenPath),
    `supervisor-${options.instance}.generations.json`,
  );
  const registry = new GenerationRegistry(registryPath, log);
  const runDir = dirname(options.endpoint.tokenPath);
  let lock: InstanceLock | null = null;
  const releaseLock = () => {
    if (lock) releaseInstanceLock(lock);
  };
  const subscribers = new Set<(event: SupervisorEvent) => void>();
  let shuttingDown = false;
  const clock = options.clock ?? systemClock;
  const processHooks = options.processHooks ?? true;
  let stopSelfCheck: () => void = () => {};

  const onProcessExit = () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null)
        killTree(child, 'SIGKILL');
    }
    releaseLock();
  };
  if (processHooks) process.on('exit', onProcessExit);

  const manager = new GenerationManager({
    entry: options.entry,
    launcher: createForkLauncher({ log, children, registry }),
    clock,
    handoff: options.handoff,
    restart: options.restart,
    log,
    resolveEntry: createEntryBoundary(options.buildRoot),
    ...(catchesConnections()
      ? {
          catchConnections: {
            spares: CATCH_SPARES,
            createCatcher: (name, handle, now) =>
              createNetCatcher(name, handle, now, log),
          },
        }
      : {}),
    onEvent: (event) => {
      for (const subscriber of [...subscribers]) subscriber(event);
    },
    onGiveUp: () => void shutdown(1),
  });

  const control = new ControlServer({
    mayReplaceStaleSocket: () =>
      lock !== null && stillHolds(lock, runDir, options.instance),
    endpoint: options.endpoint,
    instance: options.instance,
    version: SUPERVISOR_VERSION,
    log,
    handlers: {
      status: () => ({
        supervisor: {
          pid: process.pid,
          version: SUPERVISOR_VERSION,
          instance: options.instance,
          protocol: { ...SUPERVISOR_PROTOCOL },
        },
        ...manager.status(),
      }),
      handoff: (request, onProgress) => manager.handoff(request, onProgress),
      stop: (drainDeadlineMs) => void stopAndExit(drainDeadlineMs),
      subscribe: (listener) => {
        subscribers.add(listener);
        return () => subscribers.delete(listener);
      },
    },
  });

  async function shutdown(code: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    stopSelfCheck();
    log(`shutting down with exit code ${code}`);
    manager.closeListeners();
    await control.close();
    releaseLock();
    exit(code);
  }

  async function stopAndExit(drainDeadlineMs?: number): Promise<void> {
    await manager.stop(drainDeadlineMs);
    await shutdown(0);
  }

  // SIGHUP too: closing the terminal must not leave a core and a held lock.
  for (const signal of processHooks
    ? (['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
    : []) {
    process.on(signal, () => {
      log(`received ${signal}`);
      void stopAndExit();
    });
  }

  // A genuinely unexpected error: say so, drain what is running, exit nonzero.
  let fatal = false;
  const onFatal = (error: unknown) => {
    const text =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    if (fatal || shuttingDown) {
      // Already on the way out: never hang, never exit as if all were well.
      log(
        `fatal ${fatal ? 'again while draining' : 'during shutdown'}: ${text}`,
      );
      process.exit(1);
    }
    fatal = true;
    log(`fatal: ${text}`);
    log('draining the active generation before exiting');
    void manager
      .stop()
      .catch((cause: unknown) => log(`drain failed: ${String(cause)}`))
      .finally(() => void shutdown(1));
  };
  if (processHooks) {
    process.on('uncaughtException', onFatal);
    process.on('unhandledRejection', onFatal);
  }

  // The instance lock comes first (see instance-lock.ts for why it is
  // correct). It is keyed by home and instance alone, never by --control.
  ensurePrivateDir(runDir, process.platform, () => process.getuid?.());
  const testDelay = Number(
    process.env.STATION_SUPERVISOR_TEST_LOCK_DELAY_MS ?? 0,
  );
  const held = await acquireInstanceLock({
    runDir,
    instance: options.instance,
    control: options.endpoint.path,
    description: `instance ${options.instance} in ${resolve(options.home)}`,
    breakLockCommand: breakLockCommandFor(
      resolve(options.home),
      options.instance,
    ),
    log,
    pendingGraceMs: options.lockPendingGraceMs,
    testDelayMs: Number.isFinite(testDelay)
      ? Math.min(Math.max(testDelay, 0), 2_000)
      : 0,
  });
  lock = held;
  try {
    // Test-only: hold the window between winning the epoch and re-checking it.
    const postAcquireDelay = Number(
      process.env.STATION_SUPERVISOR_TEST_POST_ACQUIRE_DELAY_MS ?? 0,
    );
    if (Number.isFinite(postAcquireDelay) && postAcquireDelay > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(postAcquireDelay, 5_000)),
      );
    }
    // Then the socket: only an epoch winner gets here, so only it may replace
    // a stale socket file, and binding still refuses a live listener.
    await control.listen();
    // Still ours? Defense in depth: a later epoch here means step down.
    if (!stillHolds(held, runDir, options.instance)) {
      throw new SupervisorStartError(
        `instance lock epoch ${held.epoch} was superseded before start-up finished; refusing to start`,
      );
    }
    collectOlderEpochs(held, runDir, options.instance);
    for (const leftover of control.sweepLeftovers())
      log(`removed leftover ${leftover}`);
    log(`acquired instance lock epoch ${held.epoch}`);
    control.publishToken();
    // Holding the lock, any generation still on record was orphaned by a
    // supervisor that died; reaping refuses to start if one survives.
    const { kept } = await reapStaleGenerations(registryPath, { log });
    registry.keep(kept);
  } catch (error) {
    await control.close();
    releaseLock();
    throw error;
  }
  // While serving, keep confirming the lock is ours and the socket is in place.
  stopSelfCheck = startSelfCheck({
    clock,
    intervalMs: options.selfCheckIntervalMs ?? 5_000,
    log,
    check: async () => {
      if (shuttingDown) return;
      if (!stillHolds(held, runDir, options.instance)) {
        log(
          `instance lock epoch ${held.epoch} was superseded; draining and exiting`,
        );
        stopSelfCheck();
        await manager.stop();
        await shutdown(1);
        return;
      }
      if (control.socketIntact()) return;
      log('control socket path is missing or replaced; re-binding');
      try {
        await control.rebind();
        log(`control socket re-bound at ${options.endpoint.path}`);
      } catch (error) {
        const text = String(error);
        if (/already listening/.test(text)) {
          // Another process serves this path now. Taking it back would only
          // start a tug of war: step down, naming the conflict.
          log(
            `control socket path ${options.endpoint.path} is now served by another process; refusing to steal it. ${text}. Draining and exiting`,
          );
          stopSelfCheck();
          await manager.stop();
          await shutdown(1);
          return;
        }
        log(`could not re-bind the control socket: ${text}`);
      }
    },
  });
  log(
    `supervisor ${SUPERVISOR_VERSION} (protocol ${SUPERVISOR_PROTOCOL.major}.${SUPERVISOR_PROTOCOL.minor}) instance=${options.instance} control=${options.endpoint.path}`,
  );
  await manager.start();
}
