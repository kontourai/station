/**
 * Wires the generation manager, the control channel, and real child
 * processes into one supervisor process.
 */
import { type ChildProcess, fork, type SendHandle } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import packageJson from '../package.json' with { type: 'json' };
import { ControlServer } from './control-server.ts';
import {
  type GenerationLauncher,
  GenerationManager,
  type GenerationManagerOptions,
} from './generation-manager.ts';
import {
  type ControlEndpoint,
  SUPERVISOR_ENV,
  SUPERVISOR_PROTOCOL,
  type SupervisorEvent,
} from './protocol.ts';

export const SUPERVISOR_VERSION: string = packageJson.version;

export interface SupervisorOptions {
  entry: string;
  endpoint: ControlEndpoint;
  instance: string;
  handoff?: GenerationManagerOptions['handoff'];
  restart?: GenerationManagerOptions['restart'];
  log?: (message: string) => void;
  /** Called with the process exit code once the supervisor has shut down. */
  exit?: (code: number) => void;
}

/** Forks core generations on the Node IPC channel; tracks them for exit cleanup. */
function createForkLauncher(options: {
  log: (message: string) => void;
  children: Set<ChildProcess>;
}): GenerationLauncher {
  return {
    launch({ entry, generation }) {
      const child = fork(entry, [], {
        env: {
          ...process.env,
          [SUPERVISOR_ENV.ipc]: '1',
          [SUPERVISOR_ENV.pid]: String(process.pid),
          [SUPERVISOR_ENV.generation]: String(generation),
        },
        // The supervisor's own Node flags are not the core's.
        execArgv: [],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        serialization: 'json',
        windowsHide: true,
      });
      options.children.add(child);
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
          if (child.exitCode === null && child.signalCode === null)
            child.kill(signal);
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

export function validateEntry(entry: string): string | null {
  if (!isAbsolute(entry)) return 'entry-not-absolute';
  if (!existsSync(entry) || !statSync(entry).isFile()) return 'entry-not-found';
  return null;
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
  const subscribers = new Set<(event: SupervisorEvent) => void>();
  let shuttingDown = false;

  process.on('exit', () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
    }
  });

  const manager = new GenerationManager({
    entry: options.entry,
    launcher: createForkLauncher({ log, children }),
    handoff: options.handoff,
    restart: options.restart,
    log,
    validateEntry,
    onEvent: (event) => {
      for (const subscriber of [...subscribers]) subscriber(event);
    },
    onGiveUp: () => void shutdown(1),
  });

  const control = new ControlServer({
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
    log(`shutting down with exit code ${code}`);
    manager.closeListeners();
    await control.close();
    exit(code);
  }

  async function stopAndExit(drainDeadlineMs?: number): Promise<void> {
    await manager.stop(drainDeadlineMs);
    await shutdown(0);
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      log(`received ${signal}`);
      void stopAndExit();
    });
  }

  await control.listen();
  log(
    `supervisor ${SUPERVISOR_VERSION} (protocol ${SUPERVISOR_PROTOCOL.major}.${SUPERVISOR_PROTOCOL.minor}) instance=${options.instance} control=${options.endpoint.path}`,
  );
  await manager.start();
}
